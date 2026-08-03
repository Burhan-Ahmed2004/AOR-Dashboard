/**
 * STORE — reading history, smoothing and roll-ups
 * ===============================================
 * Raw sensor jitter charted directly reads as "the plant is unstable" even when
 * it isn't, so every value is passed through an EMA before it is displayed or
 * limit-checked. The raw sample is kept alongside it and shown in the point
 * detail, so the filtering is visible rather than hidden.
 *
 * Every figure the UI shows carries a reference to compare against:
 *   · expectedKw — typical demand for this hour (see expectedFactor)
 *   · ratedKw    — the point's rated demand
 *   · alarmKw    — the consumption limit
 */

import { expectedFactor } from './simulator.js';
import { SEVERITY, QUALITY } from './limits.js';

export const POINT_HISTORY = 90;
export const SITE_HISTORY = 240;

/** Exponential moving average. tau is the smoothing time-constant in ms. */
function ema(prev, next, dtMs, tauMs) {
  if (prev == null) return next;
  if (!(dtMs > 0)) return prev;
  const a = 1 - Math.exp(-dtMs / tauMs);
  return prev + a * (next - prev);
}

function push(buf, sample, cap) {
  buf.push(sample);
  if (buf.length > cap) buf.splice(0, buf.length - cap);
}

export function createStore(points, groups, substations, options = {}) {
  const cfg = { smoothingTauMs: 6000, ...options };
  const profileByGroup = Object.fromEntries(groups.map((g) => [g.id, g.profile]));
  const groupById = Object.fromEntries(groups.map((g) => [g.id, g]));

  /** @type {Map<string, object>} */
  const pointState = new Map();
  for (const p of points) {
    pointState.set(p.id, {
      id: p.id,
      raw: null,
      value: null, // smoothed — this is what the UI and the alarm engine use
      lastTs: 0,
      lastArrivedAt: 0,
      quality: QUALITY.OFFLINE,
      history: [], // {t, v, e} smoothed value + expected
      peakKw: 0,
      peakAt: 0,
      energyKwh: 0,
      samples: 0,
    });
  }

  const site = {
    loadKw: 0,
    generationKw: 0,
    netKw: 0,
    expectedKw: 0,
    peakKw: 0,
    peakAt: 0,
    energyKwh: 0,
    history: [], // {t, v, e}
    startedAt: Date.now(),
    lastTs: 0,
    reporting: 0,
    offline: 0,
  };

  const groupRoll = new Map();
  const subRoll = new Map();

  function expectedFor(point, date) {
    const hour = date.getHours() + date.getMinutes() / 60;
    const profile = point.role === 'generation' ? 'solar' : profileByGroup[point.groupId] || 'continuous';
    return point.ratedKw * expectedFactor(profile, hour);
  }

  /**
   * Fold one payload in.
   * @returns Map<id, {kW, ts, quality}> — the smoothed readings the alarm engine
   *          should evaluate (smoothed, so a single spike cannot trip a limit).
   */
  function ingest(payload, now = Date.now()) {
    const date = new Date(payload.ts || now);
    const byId = new Map();

    for (const r of payload.readings) {
      const s = pointState.get(r.id);
      if (!s) continue; // unknown tag — ignored, surfaced via unknownTags()
      const dt = s.lastTs ? r.ts - s.lastTs : 0;
      s.raw = r.kW;
      s.value = ema(s.value, r.kW, dt || cfg.smoothingTauMs, cfg.smoothingTauMs);
      s.lastTs = r.ts;
      s.lastArrivedAt = now;
      s.quality = r.quality === 'bad' ? QUALITY.BAD : QUALITY.GOOD;
      s.samples += 1;
      if (dt > 0 && dt < 60000) s.energyKwh += (s.value * dt) / 3_600_000;
      if (s.value > s.peakKw) {
        s.peakKw = s.value;
        s.peakAt = r.ts;
      }
      byId.set(r.id, { kW: s.value, raw: r.kW, ts: r.ts, quality: r.quality });
    }

    // Roll up. Points absent from the payload keep their last value but are
    // counted as not-reporting; they are NOT treated as zero.
    let load = 0,
      gen = 0,
      expected = 0,
      reporting = 0,
      offline = 0;
    for (const g of groups) groupRoll.set(g.id, { loadKw: 0, expectedKw: 0, ratedKw: 0, points: 0, reporting: 0 });
    for (const ss of substations) subRoll.set(ss.id, { loadKw: 0, expectedKw: 0, ratedKw: 0, points: 0, reporting: 0 });

    for (const p of points) {
      // Points with no meter (in the register but not instrumented) are excluded
      // from roll-ups and from the offline count — "not monitored" is not a fault.
      if (p.monitored === false) continue;

      const s = pointState.get(p.id);
      const fresh = byId.has(p.id);
      const v = s.value ?? 0;
      const e = expectedFor(p, date);

      if (fresh) reporting += 1;
      else offline += 1;

      s.expectedKw = e;

      const gr = groupRoll.get(p.groupId);
      const sr = subRoll.get(p.substationId);
      const signed = p.role === 'generation' ? -v : v;
      if (gr) {
        // A generation GROUP totals its output as a positive number (that is the
        // figure an operator wants). Generation inside a LOAD group still nets off.
        const genGroup = groupById[p.groupId]?.generation === true;
        gr.loadKw += genGroup ? v : signed;
        gr.expectedKw += genGroup ? e : p.role === 'generation' ? -e : e;
        gr.ratedKw += genGroup || p.role !== 'generation' ? p.ratedKw : 0;
        gr.generation = genGroup;
        gr.points += 1;
        if (fresh) gr.reporting += 1;
      }
      if (sr) {
        sr.loadKw += signed;
        sr.expectedKw += p.role === 'generation' ? -e : e;
        sr.ratedKw += p.role === 'generation' ? 0 : p.ratedKw;
        sr.points += 1;
        if (fresh) sr.reporting += 1;
      }

      if (p.role === 'generation') gen += v;
      else load += v;
      expected += p.role === 'generation' ? -e : e;

      if (fresh) push(s.history, { t: s.lastTs, v, e, raw: s.raw }, POINT_HISTORY);
    }

    const dtSite = site.lastTs ? (payload.ts || now) - site.lastTs : 0;
    site.loadKw = load;
    site.generationKw = gen;
    site.netKw = load - gen;
    site.expectedKw = expected;
    site.reporting = reporting;
    site.offline = offline;
    site.lastTs = payload.ts || now;
    if (dtSite > 0 && dtSite < 60000) site.energyKwh += (site.netKw * dtSite) / 3_600_000;
    if (site.netKw > site.peakKw) {
      site.peakKw = site.netKw;
      site.peakAt = site.lastTs;
    }
    push(site.history, { t: site.lastTs, v: site.netKw, e: site.expectedKw }, SITE_HISTORY);

    return byId;
  }

  /**
   * Readings map shaped for the alarm engine (smoothed values, original ts).
   * `expectedKw` rides along so the engine can evaluate ratio-based limits
   * without needing to know anything about demand profiles.
   */
  function readingsForEngine() {
    const m = new Map();
    for (const [id, s] of pointState) {
      if (!s.lastTs) continue;
      m.set(id, {
        kW: s.value ?? 0,
        ts: s.lastTs,
        quality: s.quality === QUALITY.BAD ? 'bad' : 'good',
        expectedKw: s.expectedKw ?? 0,
      });
    }
    return m;
  }

  /** The limit a point is actually judged against right now (may be dynamic). */
  function effectiveLimits(point, expected) {
    if (point.lowLimitMode === 'relative') {
      return {
        limitKw: expected * (point.lowAlarmRatio ?? 0.35),
        warnLimitKw: expected * (point.lowWarnRatio ?? 0.6),
        direction: 'low',
      };
    }
    if (point.role === 'generation' || point.lowAlarmKw != null)
      return { limitKw: point.lowAlarmKw, warnLimitKw: point.lowWarnKw, direction: 'low' };
    return { limitKw: point.alarmKw, warnLimitKw: point.warnKw, direction: 'high' };
  }

  function pointView(point, engine) {
    const s = pointState.get(point.id);
    const severity = engine ? engine.severityOf(point.id) : SEVERITY.NORMAL;
    const quality = engine ? engine.qualityOf(point.id) : s.quality;
    const value = s.value ?? 0;
    const expected = expectedFor(point, new Date(s.lastTs || Date.now()));
    const { limitKw, warnLimitKw, direction } = effectiveLimits(point, expected);
    return {
      ...point,
      raw: s.raw,
      value,
      expected,
      limitKw,
      warnLimitKw,
      limitDirection: direction,
      deltaVsExpected: expected > 0 ? value / expected - 1 : 0,
      pctOfLimit: limitKw ? (value / limitKw) * 100 : 0,
      severity,
      quality,
      lastTs: s.lastTs,
      ageMs: s.lastTs ? Date.now() - s.lastTs : Infinity,
      history: s.history,
      peakKw: s.peakKw,
      peakAt: s.peakAt,
      energyKwh: s.energyKwh,
      samples: s.samples,
    };
  }

  return {
    ingest,
    readingsForEngine,
    pointView,
    get site() {
      return site;
    },
    groupRollup(id) {
      return groupRoll.get(id) || { loadKw: 0, expectedKw: 0, ratedKw: 0, points: 0, reporting: 0 };
    },
    substationRollup(id) {
      return subRoll.get(id) || { loadKw: 0, expectedKw: 0, ratedKw: 0, points: 0, reporting: 0 };
    },
    rawState(id) {
      return pointState.get(id);
    },
    reset() {
      for (const s of pointState.values()) {
        s.history.length = 0;
        s.peakKw = 0;
        s.energyKwh = 0;
        s.samples = 0;
      }
      site.history.length = 0;
      site.peakKw = 0;
      site.energyKwh = 0;
      site.startedAt = Date.now();
    },
  };
}
