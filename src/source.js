/**
 * DATA SOURCE — the one seam between the dashboard and your SCADA system
 * ======================================================================
 * Everything above this layer consumes a single normalised shape:
 *
 *     { ts: <epoch ms>, readings: [ { id, kW, ts, quality } ], daylight?: bool }
 *
 *   id       must match a tag id in register.js
 *   kW       instantaneous demand. Generation points report POSITIVE output.
 *   ts       when the SAMPLE was taken at the meter (not when it arrived).
 *            Staleness is measured from this, so do not substitute arrival time.
 *   quality  'good' | 'bad'  — omit a point entirely if comms are lost; do NOT
 *            send 0 kW for an unreachable meter.
 *
 * To go live, either point `sse`/`poll` at your own endpoint, or add a mode here
 * (OPC-UA / Modbus / MQTT gateway). No other file changes.
 *
 * Connection health is tracked independently of message content by a watchdog,
 * so a backend that dies quietly still surfaces as `down` instead of the UI
 * silently freezing on the last good value.
 */

import { createSimulator, isDaylight } from './simulator.js';

export const CONN = {
  CONNECTING: 'connecting',
  LIVE: 'live',
  DEGRADED: 'degraded',
  DOWN: 'down',
  PAUSED: 'paused',
};

const DEFAULTS = {
  mode: 'sim', // 'sim' | 'sse' | 'poll'
  intervalMs: 2000, // sim tick / poll period
  healthyMs: 8000, // no message for longer than this -> degraded
  downMs: 25000, // ... or longer than this -> down
  streamUrl: '/api/stream',
  readingsUrl: '/api/readings',
  maxBackoffMs: 15000,
};

export function createSource(points, groups, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const dataHandlers = new Set();
  const statusHandlers = new Set();

  let mode = cfg.mode;
  let running = false;
  let timer = null;
  let watchdog = null;
  let es = null;
  let backoff = 1000;
  let inFlight = false;

  const status = {
    mode,
    state: CONN.CONNECTING,
    lastMessageAt: 0,
    lastError: null,
    messageCount: 0,
    latencyMs: null,
  };

  const sim = createSimulator(points, groups, cfg.sim || {});

  function emitStatus(patch = {}) {
    Object.assign(status, patch, { mode });
    for (const h of statusHandlers) h({ ...status });
  }

  function emitData(payload) {
    const now = Date.now();
    status.lastMessageAt = now;
    status.messageCount += 1;
    status.lastError = null;
    if (payload.ts) status.latencyMs = Math.max(0, now - payload.ts);
    if (status.state !== CONN.LIVE) emitStatus({ state: CONN.LIVE });
    for (const h of dataHandlers) h(payload);
  }

  // --- watchdog: health is judged by silence, not by errors -------------------
  function startWatchdog() {
    stopWatchdog();
    watchdog = setInterval(() => {
      if (!running) return;
      const age = Date.now() - status.lastMessageAt;
      if (!status.lastMessageAt) return;
      if (age > cfg.downMs && status.state !== CONN.DOWN) emitStatus({ state: CONN.DOWN });
      else if (age > cfg.healthyMs && age <= cfg.downMs && status.state !== CONN.DEGRADED)
        emitStatus({ state: CONN.DEGRADED });
    }, 1000);
  }
  function stopWatchdog() {
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
  }

  // --- simulator mode --------------------------------------------------------
  function startSim() {
    const tick = () => {
      if (!running) return;
      emitData(sim.sample(Date.now()));
    };
    tick();
    timer = setInterval(tick, cfg.intervalMs);
  }

  // --- polling mode ----------------------------------------------------------
  function startPoll() {
    const tick = async () => {
      if (!running || inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(cfg.readingsUrl, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        emitData(normalise(body));
      } catch (err) {
        emitStatus({ lastError: String(err.message || err) });
      } finally {
        inFlight = false;
      }
    };
    tick();
    timer = setInterval(tick, cfg.intervalMs);
  }

  // --- SSE mode --------------------------------------------------------------
  function startSse() {
    try {
      es = new EventSource(cfg.streamUrl);
    } catch (err) {
      emitStatus({ state: CONN.DOWN, lastError: String(err.message || err) });
      return scheduleReconnect();
    }
    es.onopen = () => {
      backoff = 1000;
      emitStatus({ state: CONN.CONNECTING, lastError: null });
    };
    es.onmessage = (evt) => {
      try {
        emitData(normalise(JSON.parse(evt.data)));
      } catch (err) {
        emitStatus({ lastError: `bad frame: ${err.message}` });
      }
    };
    es.onerror = () => {
      // EventSource auto-retries, but we surface the gap immediately rather than
      // letting the UI sit on stale values pretending everything is fine.
      emitStatus({ state: CONN.DOWN, lastError: 'stream disconnected' });
    };
  }

  function scheduleReconnect() {
    if (!running) return;
    setTimeout(() => {
      if (!running) return;
      startSse();
    }, backoff);
    backoff = Math.min(cfg.maxBackoffMs, backoff * 2);
  }

  function normalise(body) {
    const readings = (body.readings || body.points || [])
      .map((r) => ({
        id: r.id ?? r.tag ?? r.pointId,
        kW: Number(r.kW ?? r.kw ?? r.value ?? 0),
        ts: Number(r.ts ?? r.timestamp ?? body.ts ?? Date.now()),
        quality: r.quality ?? 'good',
      }))
      .filter((r) => r.id && Number.isFinite(r.kW));
    return {
      ts: Number(body.ts ?? Date.now()),
      readings,
      daylight: body.daylight ?? isDaylight(),
    };
  }

  function stopTransport() {
    if (timer) clearInterval(timer);
    timer = null;
    if (es) {
      es.close();
      es = null;
    }
  }

  function start() {
    if (running) return;
    running = true;
    status.lastMessageAt = 0;
    emitStatus({ state: CONN.CONNECTING });
    startWatchdog();
    if (mode === 'sse') startSse();
    else if (mode === 'poll') startPoll();
    else startSim();
  }

  function stop() {
    running = false;
    stopTransport();
    stopWatchdog();
    emitStatus({ state: CONN.PAUSED });
  }

  function setMode(next) {
    if (next === mode) return;
    const wasRunning = running;
    stop();
    mode = next;
    if (wasRunning) start();
    else emitStatus({});
  }

  return {
    start,
    stop,
    setMode,
    get mode() {
      return mode;
    },
    get running() {
      return running;
    },
    get status() {
      return { ...status };
    },
    onData(fn) {
      dataHandlers.add(fn);
      return () => dataHandlers.delete(fn);
    },
    onStatus(fn) {
      statusHandlers.add(fn);
      return () => statusHandlers.delete(fn);
    },
  };
}
