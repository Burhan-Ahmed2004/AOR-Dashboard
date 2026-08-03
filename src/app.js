/**
 * APP — wiring
 * ============
 *   source  →  store (smooth + roll up)  →  alarm engine (limits)  →  ui
 *
 * The render loop is deliberately DECOUPLED from the data rate: readings are
 * folded in whenever they arrive, but the screen repaints on a fixed 1 s tick.
 * That means a fast feed cannot thrash the DOM, and — more importantly — a feed
 * that STOPS still repaints, so staleness, offline meters and a dead backend
 * surface on their own instead of the UI silently freezing on the last value.
 */

import * as register from './register.js';
import { createStore } from './store.js';
import { createAlarmEngine } from './limits.js';
import { createSource } from './source.js';
import { createUi } from './ui.js';
import { isDaylight } from './simulator.js';

const RENDER_MS = 1000;
const SSE_FALLBACK_MS = 6000;

// Restore operator preferences before first paint.
try {
  const t = localStorage.getItem('pld-theme');
  if (t) document.documentElement.dataset.theme = t;
  const d = localStorage.getItem('pld-density');
  if (d) document.documentElement.dataset.density = d;
} catch {}

const allPoints = register.POINTS;
const monitored = register.MONITORED_POINTS;

const store = createStore(allPoints, register.GROUPS, register.SUBSTATIONS, { smoothingTauMs: 6000 });
const engine = createAlarmEngine({
  onDelayMs: 6000,
  offDelayMs: 12000,
  deadbandPct: 0.04,
  staleAfterMs: 15000,
  offlineAfterMs: 40000,
  reArmMs: 90000,
});

/**
 * Pick a data source by ASKING whether a SCADA backend is there, rather than
 * assuming one because we happen to be served over http. On static hosting
 * (Vercel, GitHub Pages, any plain web server) there is no /api, and guessing
 * `sse` would park the dashboard on a "Feed lost" banner for several seconds
 * before falling back — a false alarm on first paint is exactly what this
 * dashboard is supposed to avoid.
 */
const servedOverHttp = location.protocol === 'http:' || location.protocol === 'https:';

async function detectSource() {
  if (!servedOverHttp) return 'sim';
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch('./api/health', { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (res.ok) return 'sse';
  } catch {
    /* no backend here — static hosting */
  }
  return 'sim';
}

const source = createSource(monitored, register.GROUPS, {
  mode: 'sim',
  intervalMs: 2000,
  streamUrl: './api/stream',
  readingsUrl: './api/readings',
});

const ui = createUi({
  points: allPoints,
  groups: register.GROUPS,
  substations: register.SUBSTATIONS,
  store,
  engine,
  source,
  register,
});

ui.mountStatic();

let lastDaylight = isDaylight();

source.onData((payload) => {
  store.ingest(payload);
  if (payload.daylight != null) lastDaylight = payload.daylight;
});

source.onStatus((status) => {
  ui.renderConnection(status);
  document.getElementById('sourceMode').value = status.mode;
});

// Fixed-rate render + evaluate loop.
setInterval(() => {
  engine.update(monitored, store.readingsForEngine(), Date.now(), { daylight: lastDaylight });
  ui.update();
  ui.renderConnection(source.status);
}, RENDER_MS);

// Start on the simulator immediately so the dashboard is populated on first
// paint, then switch to the live feed if the probe finds one.
source.start();

detectSource().then((mode) => {
  if (mode === 'sse') {
    source.setMode('sse');
    // The backend answered /api/health but may still fail to stream. Fall back
    // rather than leaving the dashboard empty — and say so, instead of
    // pretending the data is real.
    setTimeout(() => {
      if (source.status.messageCount === 0 && source.mode === 'sse') {
        console.warn('[power-monitor] SCADA endpoint answered but sent no data — using the in-browser simulator');
        source.setMode('sim');
      }
    }, SSE_FALLBACK_MS);
  } else {
    console.info('[power-monitor] no SCADA backend at ./api — running the in-browser simulator');
  }
});

// Expose for console poking / integration testing.
window.__power = { register, store, engine, source, ui };
