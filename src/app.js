/**
 * APP — wiring
 * ============
 *   source -> store (smooth + roll up) -> electrical model -> alarm engine -> ui
 *
 * The render loop is deliberately DECOUPLED from the data rate: readings are
 * folded in whenever they arrive, but the screen repaints on a fixed 1 s tick.
 * A fast feed cannot thrash the DOM, and — more importantly — a feed that STOPS
 * still repaints, so staleness, offline meters and a dead backend surface on
 * their own instead of the UI silently freezing on the last value.
 */

import * as register from './register.js';
import { createStore } from './store.js';
import { createAlarmEngine } from './limits.js';
import { createSource } from './source.js';
import { createUi } from './ui.js';
import { createOverview } from './overview.js';
import { createElectricalModel } from './electrical.js';
import { createSwitchgearModel } from './switchgear.js';
import { createPages } from './pages.js';
import { isDaylight } from './simulator.js';
import { dateTime } from './format.js';

const RENDER_MS = 1000;
const SSE_FALLBACK_MS = 6000;

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
const electrical = createElectricalModel(register.SUBSTATIONS);
const switchgear = createSwitchgearModel(register);

/**
 * Pick a data source by ASKING whether a SCADA backend is there, rather than
 * assuming one because we happen to be served over http. On static hosting
 * there is no /api, and guessing `sse` would park the dashboard on a
 * "Feed lost" banner — a false alarm on first paint is exactly what this
 * dashboard exists to avoid.
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

const ctx = {
  points: allPoints,
  groups: register.GROUPS,
  substations: register.SUBSTATIONS,
  store,
  engine,
  electrical,
  switchgear,
  source,
  register,
};

const ui = createUi(ctx);
const overview = createOverview(ctx);
const pages = createPages(ctx);

ui.mountStatic();
overview.mount();
pages.mount();

// ---------------------------------------------------------------------- nav
const VIEWS = {
  overview: 'view-overview',
  flow: 'view-flow',
  load: 'view-load',
  voltage: 'view-voltage',
  energy: 'view-energy',
  solar: 'view-solar',
  transformers: 'view-transformers',
  breakers: 'view-breakers',
  alarms: 'view-alarms',
  reports: 'view-reports',
  forecast: 'view-forecast',
  settings: 'view-settings',
};
const SOON = {}; // every nav destination is now a real page

let currentView = 'overview';

function setView(name) {
  const target = VIEWS[name];
  for (const id of Object.values(VIEWS)) {
    const n = document.getElementById(id);
    if (n) n.hidden = true;
  }
  const soonView = document.getElementById('view-soon');
  if (target) {
    soonView.hidden = true;
    document.getElementById(target).hidden = false;
  } else {
    const [title, text] = SOON[name] || ['Not yet built', ''];
    document.getElementById('soonTitle').textContent = title;
    document.getElementById('soonText').textContent = text;
    soonView.hidden = false;
  }
  for (const btn of document.querySelectorAll('#navList button')) {
    if (btn.dataset.view === name) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  currentView = name;
  try { localStorage.setItem('pld-view', name); } catch {}
  render();
}

for (const btn of document.querySelectorAll('#navList button')) {
  btn.addEventListener('click', () => setView(btn.dataset.view));
}
document.getElementById('bellBtn').addEventListener('click', () => setView('alarms'));

// ------------------------------------------------------------------ feed
let lastDaylight = isDaylight();

source.onData((payload) => {
  store.ingest(payload);
  if (payload.daylight != null) lastDaylight = payload.daylight;
});

source.onStatus((status) => {
  ui.renderConnection(status);
  const sel = document.getElementById('sourceMode');
  if (sel) sel.value = status.mode;
  const pill = document.getElementById('livePill');
  if (pill) pill.style.opacity = status.state === 'live' ? '1' : '.4';
});

function render() {
  const now = Date.now();
  const loadBySub = new Map(
    register.SUBSTATIONS.map((s) => [s.id, store.substationRollup(s.id).loadKw])
  );
  electrical.update(loadBySub, store.site.loadKw, store.site.generationKw, now);
  engine.update(monitored, store.readingsForEngine(), now, { daylight: lastDaylight });
  switchgear.update(now, loadBySub, substationSeverity);

  document.getElementById('clockNow').textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
  document.getElementById('dateNow').textContent = new Date().toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });

  ui.update();
  // Only the page on screen is rendered; the others are not in the DOM flow.
  if (currentView === 'overview') overview.update();
  else if (pages.has(currentView)) pages.update(currentView);
  ui.renderConnection(source.status);
}

setInterval(render, RENDER_MS);

// Restore the operator's last view.
try {
  const saved = localStorage.getItem('pld-view');
  if (saved && (VIEWS[saved] || SOON[saved])) setView(saved);
} catch {}

source.start();

detectSource().then((mode) => {
  if (mode === 'sse') {
    source.setMode('sse');
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

/** Worst alarm severity among the points fed by a substation. */
function substationSeverity(subId) {
  let worst = 'normal';
  for (const p of monitored) {
    if (p.substationId !== subId) continue;
    const sev = engine.severityOf(p.id);
    if (sev === 'critical') return 'critical';
    if (sev === 'warning') worst = 'warning';
  }
  return worst;
}

window.__power = { register, store, engine, electrical, switchgear, source, ui, overview, pages, setView };
