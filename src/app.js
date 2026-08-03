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

// Served over http -> talk to the mock SCADA server for real; opened as a file
// -> fall back to the in-browser simulator.
const servedOverHttp = location.protocol === 'http:' || location.protocol === 'https:';
const initialMode = servedOverHttp ? 'sse' : 'sim';

const source = createSource(monitored, register.GROUPS, {
  mode: initialMode,
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
document.getElementById('sourceMode').value = initialMode;

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

source.start();

// If the SCADA endpoint never answers, drop to the simulator rather than showing
// an empty dashboard — and say so, instead of pretending the data is real.
if (initialMode === 'sse') {
  setTimeout(() => {
    if (source.status.messageCount === 0 && source.mode === 'sse') {
      console.warn('[power-monitor] no SSE data — falling back to the in-browser simulator');
      source.setMode('sim');
    }
  }, SSE_FALLBACK_MS);
}

// Expose for console poking / integration testing.
window.__power = { register, store, engine, source, ui };
