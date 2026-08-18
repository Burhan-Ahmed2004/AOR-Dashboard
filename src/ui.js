/**
 * UI — rendering and surgical updates
 * ===================================
 * The DOM is built ONCE and thereafter only the cells whose value actually
 * changed are written. Nothing is re-created on a tick, so the table never
 * flickers, scroll position and keyboard focus survive updates, and the UI
 * stays cheap enough to be trusted as "live".
 *
 * Status is always icon + word + colour, never colour alone.
 */

import * as F from './format.js';
import { SEVERITY, QUALITY } from './limits.js';
import { createTrendChart, sparklineSvg, renderBars } from './charts.js';

const SEV_META = {
  [SEVERITY.NORMAL]: { icon: 'i-check', label: 'Normal', rank: 0 },
  [SEVERITY.WARNING]: { icon: 'i-warn', label: 'Warning', rank: 2 },
  [SEVERITY.CRITICAL]: { icon: 'i-critical', label: 'Over limit', rank: 3 },
};
const QUAL_META = {
  [QUALITY.OFFLINE]: { icon: 'i-offline', label: 'Offline', cls: 'offline', rank: 2.5 },
  [QUALITY.BAD]: { icon: 'i-offline', label: 'Bad data', cls: 'bad', rank: 2.5 },
  [QUALITY.PENDING]: { icon: 'i-clock', label: 'Awaiting data', cls: 'stale', rank: 0.5 },
  [QUALITY.STALE]: { icon: 'i-clock', label: 'Stale', cls: 'stale', rank: 1 },
};

function icon(id, size = 14) {
  return `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#${id}"/></svg>`;
}

/** A badge whose meaning survives colour loss: icon + word, ink text. */
function statusBadge(severity, quality, monitored = true) {
  if (!monitored) return `<span class="badge badge--unmonitored">${icon('i-minus')}Not monitored</span>`;
  const q = QUAL_META[quality];
  if (q && quality !== QUALITY.STALE) return `<span class="badge badge--${q.cls}">${icon(q.icon)}${q.label}</span>`;
  const s = SEV_META[severity] || SEV_META[SEVERITY.NORMAL];
  const stale = quality === QUALITY.STALE ? ` <span class="badge badge--stale">${icon('i-clock')}Stale</span>` : '';
  return `<span class="badge badge--${severity}">${icon(s.icon)}${s.label}</span>${stale}`;
}

function statusRank(severity, quality) {
  const q = QUAL_META[quality];
  return Math.max(SEV_META[severity]?.rank ?? 0, q?.rank ?? 0);
}

/** Write only if the value actually changed. */
function setText(node, value) {
  if (!node) return;
  const s = String(value);
  if (node.__v === s) return;
  node.__v = s;
  node.textContent = s;
}
function setHtml(node, value) {
  if (!node) return;
  if (node.__h === value) return;
  node.__h = value;
  node.innerHTML = value;
}
function setAttr(node, name, value) {
  if (!node) return;
  const k = `__a_${name}`;
  const s = String(value);
  if (node[k] === s) return;
  node[k] = s;
  node.setAttribute(name, s);
}
function setStyle(node, prop, value) {
  if (!node) return;
  const k = `__s_${prop}`;
  if (node[k] === value) return;
  node[k] = value;
  node.style[prop] = value;
}

const $ = (id) => document.getElementById(id);

export function createUi(ctx) {
  const { points, groups, substations, store, engine, source, register } = ctx;
  const groupById = Object.fromEntries(groups.map((g) => [g.id, g]));
  const subById = Object.fromEntries(substations.map((s) => [s.id, s]));

  const state = {
    view: 'ops',
    query: '',
    group: '',
    substation: '',
    onlyProblems: false,
    sortKey: 'severity',
    sortDir: 'desc',
    selected: null,
  };

  const rowRefs = new Map();
  const gcardRefs = new Map();
  const alarmRefs = new Map();
  let siteChart = null;
  let drawerChart = null;
  let tableBusy = false; // pointer or focus is inside the point table

  // ------------------------------------------------------------------ static
  function mountStatic() {
    const instrumented = points.filter((p) => p.monitored).length;
    setText(
      $('pointCount'),
      instrumented === points.length
        ? `${points.length} monitored points`
        : `${instrumented} monitored of ${points.length} register points`
    );

    // filter selects
    const gf = $('groupFilter');
    for (const g of groups) gf.insertAdjacentHTML('beforeend', `<option value="${g.id}">${F.escapeHtml(g.name)}</option>`);
    const sf = $('subFilter');
    for (const s of substations)
      sf.insertAdjacentHTML('beforeend', `<option value="${s.id}">${F.escapeHtml(s.name)}</option>`);

    // group cards
    const grid = $('groupGrid');
    grid.innerHTML = groups
      .map(
        (g) => `<button class="gcard" data-group="${g.id}" type="button">
        <div class="gcard-top">
          <span class="gcard-icon" style="--chip:var(--cat-1)">${icon(`i-${g.icon}`, 16)}</span>
          <span><span class="gcard-name">${F.escapeHtml(g.name)}</span><br><span class="gcard-zone">${F.escapeHtml(g.zone)}</span></span>
        </div>
        <div class="gcard-value" data-f="value">—</div>
        <div class="gcard-row"><span data-f="badge"></span><span class="gcard-meta" data-f="meta"></span></div>
        <div class="meter" data-f="meter"><i style="width:0%"></i></div>
      </button>`
      )
      .join('');
    for (const btn of grid.querySelectorAll('.gcard')) {
      const id = btn.dataset.group;
      gcardRefs.set(id, {
        root: btn,
        value: btn.querySelector('[data-f="value"]'),
        badge: btn.querySelector('[data-f="badge"]'),
        meta: btn.querySelector('[data-f="meta"]'),
        meter: btn.querySelector('[data-f="meter"]'),
        fill: btn.querySelector('[data-f="meter"] > i'),
      });
      btn.addEventListener('click', () => {
        const selecting = state.group !== id;
        state.group = selecting ? id : '';
        $('groupFilter').value = state.group;
        applyFilters();
        // Only travel on select — scrolling away when you deselect is jarring.
        if (selecting) scrollToPoints();
      });
    }

    // point table rows — built once, updated in place
    const body = $('pointBody');
    body.innerHTML = points
      .map(
        (p) => `<tr data-id="${p.id}" tabindex="0">
        <td class="tag">${F.escapeHtml(p.id)}</td>
        <td class="name-cell"><div class="name-main">${F.escapeHtml(p.name)}</div>
          <div class="name-sub">${F.escapeHtml(p.location || '')}${p.units > 1 ? ` · ${p.units} units` : ''}</div></td>
        <td class="num" data-f="value">—</td>
        <td class="num" data-f="expected">—</td>
        <td class="num" data-f="delta">—</td>
        <td class="num" data-f="limit">—</td>
        <td class="num" data-f="pct">—</td>
        <td data-f="spark"></td>
        <td data-f="status"></td>
        <td class="num" data-f="age">—</td>
      </tr>`
      )
      .join('');
    for (const tr of body.querySelectorAll('tr')) {
      const id = tr.dataset.id;
      rowRefs.set(id, {
        tr,
        value: tr.querySelector('[data-f="value"]'),
        expected: tr.querySelector('[data-f="expected"]'),
        delta: tr.querySelector('[data-f="delta"]'),
        limit: tr.querySelector('[data-f="limit"]'),
        pct: tr.querySelector('[data-f="pct"]'),
        spark: tr.querySelector('[data-f="spark"]'),
        status: tr.querySelector('[data-f="status"]'),
        age: tr.querySelector('[data-f="age"]'),
        visible: true,
      });
      tr.addEventListener('click', () => openDrawer(id));
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openDrawer(id);
        }
      });
    }

    wireControls();
    applyFilters();
  }

  /**
   * Bring the "Monitored points" section to the top of the viewport — the
   * SECTION, not the <table> inside it, so its heading and the filter row stay
   * on screen. The offset clears the sticky topbar, whose height changes when it
   * wraps on a narrow window, so it is measured rather than hard-coded.
   */
  function scrollToPoints() {
    const section = $('pointsSection');
    if (!section) return;
    const bar = document.querySelector('.topbar');
    const banner = $('connBanner');
    const offset =
      (bar ? bar.offsetHeight : 0) + (banner && !banner.hidden ? banner.offsetHeight : 0) + 10;
    const top = section.getBoundingClientRect().top + window.scrollY - offset;
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  }

  // ---------------------------------------------------------------- controls
  function wireControls() {
    $('q').addEventListener('input', (e) => {
      state.query = e.target.value.trim().toLowerCase();
      applyFilters();
    });
    $('groupFilter').addEventListener('change', (e) => {
      state.group = e.target.value;
      applyFilters();
    });
    $('subFilter').addEventListener('change', (e) => {
      state.substation = e.target.value;
      applyFilters();
    });
    $('onlyProblems').addEventListener('click', (e) => {
      state.onlyProblems = !state.onlyProblems;
      e.currentTarget.setAttribute('aria-pressed', String(state.onlyProblems));
      applyFilters();
    });

    for (const th of document.querySelectorAll('#pointTable th[data-sort]')) {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        else {
          state.sortKey = key;
          state.sortDir = key === 'id' || key === 'name' ? 'asc' : 'desc';
        }
        for (const o of document.querySelectorAll('#pointTable th[data-sort]')) o.removeAttribute('aria-sort');
        th.setAttribute('aria-sort', state.sortDir === 'asc' ? 'ascending' : 'descending');
        sortRows();
      });
    }

    for (const id of ['ackAll', 'ackAll2']) {
      const btn = $(id);
      if (btn) btn.addEventListener('click', () => { engine.ackAll('operator'); renderAlarms(); });
    }

    $('themeBtn').addEventListener('click', () => {
      const cur = document.documentElement.dataset.theme;
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      $('themeBtn').innerHTML = `<svg width="16" height="16"><use href="#${next === 'dark' ? 'i-sun' : 'i-moon'}"/></svg>`;
      try { localStorage.setItem('pld-theme', next); } catch {}
    });
    $('densityBtn').addEventListener('click', () => {
      const next = document.documentElement.dataset.density === 'wall' ? 'comfortable' : 'wall';
      document.documentElement.dataset.density = next;
      try { localStorage.setItem('pld-density', next); } catch {}
    });

    $('sourceMode').addEventListener('change', (e) => source.setMode(e.target.value));
    $('playPause').addEventListener('click', () => {
      if (source.running) source.stop();
      else source.start();
      updatePlayPause();
    });

    $('scrim').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('drawer').hidden) closeDrawer();
    });

    $('csvPoints').addEventListener('click', exportPointsCsv);
    $('csvAlarms').addEventListener('click', exportAlarmsCsv);

    const tbl = $('pointTable');
    tbl.addEventListener('pointerenter', () => { tableBusy = true; });
    tbl.addEventListener('pointerleave', () => { tableBusy = false; });
    tbl.addEventListener('focusin', () => { tableBusy = true; });
    tbl.addEventListener('focusout', () => { tableBusy = false; });
  }

  function updatePlayPause() {
    const running = source.running;
    $('playPause').innerHTML = `<svg width="16" height="16"><use href="#${running ? 'i-pause' : 'i-play'}"/></svg>`;
    $('playPause').setAttribute('aria-label', running ? 'Pause feed' : 'Resume feed');
  }

  // ----------------------------------------------------------------- filters
  function matches(view) {
    if (state.group && view.groupId !== state.group) return false;
    if (state.substation && view.substationId !== state.substation) return false;
    if (state.onlyProblems) {
      const bad = view.severity !== SEVERITY.NORMAL || view.quality === QUALITY.OFFLINE || view.quality === QUALITY.BAD;
      if (!bad) return false;
    }
    if (state.query) {
      const hay = `${view.id} ${view.name} ${view.location || ''}`.toLowerCase();
      if (!hay.includes(state.query)) return false;
    }
    return true;
  }

  function applyFilters() {
    let shown = 0;
    for (const p of points) {
      const ref = rowRefs.get(p.id);
      const view = store.pointView(p, engine);
      const ok = matches(view);
      if (ref.visible !== ok) {
        ref.visible = ok;
        ref.tr.style.display = ok ? '' : 'none';
      }
      if (ok) shown++;
    }
    setText($('resultCount'), `${shown} of ${points.length} points`);
    for (const [id, ref] of gcardRefs)
      ref.root.style.outline = state.group === id ? '2px solid var(--series-1)' : '';
    sortRows();
  }

  function sortRows() {
    const key = state.sortKey;
    const dir = state.sortDir === 'asc' ? 1 : -1;
    const views = points.map((p) => store.pointView(p, engine));
    const val = (v) => {
      switch (key) {
        case 'id': return v.id;
        case 'name': return v.name;
        case 'value': return v.value;
        case 'expected': return v.expected;
        case 'delta': return v.deltaVsExpected;
        case 'limit': return v.limitKw ?? 0;
        case 'pct': return v.pctOfLimit;
        case 'age': return v.ageMs;
        case 'severity':
        default: return statusRank(v.severity, v.quality) * 1000 + Math.min(999, v.pctOfLimit);
      }
    };
    views.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      const c = typeof x === 'string' ? x.localeCompare(y) : (x ?? 0) - (y ?? 0);
      return c * dir;
    });
    const body = $('pointBody');
    const frag = document.createDocumentFragment();
    for (const v of views) frag.append(rowRefs.get(v.id).tr);
    body.append(frag);
  }

  // --------------------------------------------------------------- main tick
  // --------------------------------------------------------------- main tick
  function update() {
    updateGroupCards();
    updateRows();
    // Keep the "needs attention" filter and the severity sort honest as
    // conditions change - but never reshuffle rows out from under a hand or a
    // keyboard focus that is currently in the table.
    if (!tableBusy && (state.onlyProblems || state.sortKey === 'severity')) applyFilters();
    renderAlarms();
    renderManagement();
    if (state.selected) updateDrawer();
  }

  function substationSeverity(subId) {
    let worst = SEVERITY.NORMAL;
    for (const p of points) {
      if (p.substationId !== subId) continue;
      const s = engine.severityOf(p.id);
      if (s === SEVERITY.CRITICAL) return SEVERITY.CRITICAL;
      if (s === SEVERITY.WARNING) worst = SEVERITY.WARNING;
    }
    const r = store.substationRollup(subId);
    const cap = subById[subId]?.capacityKw;
    if (cap && r.loadKw / cap > 0.9) return SEVERITY.CRITICAL;
    if (cap && r.loadKw / cap > 0.8 && worst === SEVERITY.NORMAL) return SEVERITY.WARNING;
    return worst;
  }

  function groupSeverity(groupId) {
    let worst = SEVERITY.NORMAL;
    let offline = 0;
    for (const p of points) {
      if (p.groupId !== groupId) continue;
      const s = engine.severityOf(p.id);
      const q = engine.qualityOf(p.id);
      if (q === QUALITY.OFFLINE || q === QUALITY.BAD) offline++;
      if (s === SEVERITY.CRITICAL) worst = SEVERITY.CRITICAL;
      else if (s === SEVERITY.WARNING && worst === SEVERITY.NORMAL) worst = SEVERITY.WARNING;
    }
    return { worst, offline };
  }

  function updateGroupCards() {
    for (const g of groups) {
      const ref = gcardRefs.get(g.id);
      const r = store.groupRollup(g.id);
      const { worst, offline } = groupSeverity(g.id);
      setText(ref.value, F.kw(r.loadKw));
      // Severity and comms are shown side by side, never one instead of the
      // other — a group holding a critical alarm must not read as merely
      // "Offline" because one of its meters also happens to be unreachable.
      setHtml(
        ref.badge,
        statusBadge(worst, QUALITY.GOOD) +
          (offline ? ` <span class="badge badge--offline">${icon('i-offline')}${offline} offline</span>` : '')
      );
      const vs = r.expectedKw ? r.loadKw / r.expectedKw - 1 : 0;
      setText(ref.meta, `${F.signedPct(vs)} vs typical · ${r.points} pts`);
      const pct = r.ratedKw ? Math.min(100, (Math.abs(r.loadKw) / r.ratedKw) * 100) : 0;
      setAttr(ref.meter, 'class', `meter${worst === SEVERITY.NORMAL ? (offline ? ' meter--offline' : '') : ` meter--${worst}`}`);
      setStyle(ref.fill, 'width', `${pct}%`);
    }
  }

  function updateRows() {
    const now = Date.now();
    for (const p of points) {
      const ref = rowRefs.get(p.id);
      if (!ref.visible) continue;
      const v = store.pointView(p, engine);
      const reporting = v.monitored && (v.quality === QUALITY.GOOD || v.quality === QUALITY.STALE);

      setText(ref.value, reporting ? F.kw(v.value) : '—');
      setText(ref.expected, F.kw(v.expected));
      setText(ref.delta, reporting ? F.signedPct(v.deltaVsExpected) : '—');
      setText(ref.limit, v.monitored ? `${v.limitDirection === 'low' ? 'min ' : ''}${F.kw(v.limitKw)}` : '—');
      setText(ref.pct, reporting && v.limitKw ? F.pct(v.pctOfLimit) : '—');
      setHtml(ref.status, statusBadge(v.severity, v.quality, v.monitored));
      setText(ref.age, v.monitored ? F.since(v.lastTs, now) : '—');
      setAttr(ref.tr, 'data-sev', v.severity);
      setAttr(ref.tr, 'data-q', v.quality);
      const hist = v.history.slice(-24).map((h) => h.v);
      setHtml(ref.spark, reporting ? sparklineSvg(hist, { expected: v.expected }) : '');
    }
  }

  // ------------------------------------------------------------------ alarms
  // Two containers show alarms: the overview panel and the Alarms & Events
  // page. Each keeps its OWN keyed node map so reconciliation preserves
  // keyboard focus on the Ack buttons instead of rebuilding on every tick.
  const alarmRefSets = new Map();

  function sevTag(ep) {
    if (ep.kind === 'comms') return `<span class="sevtag sevtag--comms">${icon('i-offline', 11)}Comms</span>`;
    if (ep.severity === SEVERITY.CRITICAL)
      return `<span class="sevtag sevtag--critical">${icon('i-critical', 11)}Critical</span>`;
    return `<span class="sevtag sevtag--warning">${icon('i-warn', 11)}Warning</span>`;
  }

  function renderAlarmsInto(containerId) {
    const list = $(containerId);
    if (!list) return;
    let refs = alarmRefSets.get(containerId);
    if (!refs) { refs = new Map(); alarmRefSets.set(containerId, refs); }
    const active = engine.active;

    if (!active.length) {
      if (!list.__empty) {
        list.innerHTML = `<div class="empty">${icon('i-check', 15)}No points over limit. All monitored locations are within their consumption limits.</div>`;
        list.__empty = true;
        refs.clear();
      }
      return;
    }
    if (list.__empty) { list.innerHTML = ''; list.__empty = false; }

    const seen = new Set();
    let prev = null;
    for (const ep of active) {
      seen.add(ep.key);
      let ref = refs.get(ep.key);
      if (!ref) {
        const node = document.createElement('div');
        node.innerHTML =
          '<span data-f="sev"></span>' +
          '<div class="alarm-main"><div class="alarm-msg" data-f="msg"></div>' +
          '<div class="alarm-loc" data-f="loc"></div></div>' +
          '<div class="alarm-right"><span class="alarm-age" data-f="age"></span><span data-f="ack"></span></div>';
        ref = {
          node,
          sev: node.querySelector('[data-f="sev"]'),
          msg: node.querySelector('[data-f="msg"]'),
          loc: node.querySelector('[data-f="loc"]'),
          age: node.querySelector('[data-f="age"]'),
          ack: node.querySelector('[data-f="ack"]'),
        };
        refs.set(ep.key, ref);
      }
      const kindCls = ep.kind === 'comms' ? 'comms' : ep.severity;
      setAttr(ref.node, 'class', `alarm alarm--${kindCls}${ep.clearedAt ? ' alarm--cleared' : ''}`);
      setHtml(ref.sev, sevTag(ep));
      setText(ref.msg, `${ep.pointId} — ${ep.message || ''}`);
      const sub = subById[ep.substationId];
      const bits = [ep.pointName];
      if (ep.location && ep.location !== ep.pointName) bits.push(ep.location);
      if (sub) bits.push(sub.name);
      if (ep.clearedAt) bits.push('cleared — acknowledge to close');
      if (ep.escalations.length) bits.push(`escalated ${ep.escalations.length}x`);
      setText(ref.loc, bits.join(' · '));
      setText(ref.age, F.since(ep.raisedAt));

      if (ep.ackedAt) {
        setHtml(ref.ack, `<span class="acked-mark">${icon('i-check', 11)}Acked</span>`);
        ref.ack.__btn = false;
      } else if (!ref.ack.__btn) {
        ref.ack.innerHTML = '';
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ack-btn';
        b.textContent = 'Ack';
        b.setAttribute('aria-label', `Acknowledge alarm on ${ep.pointId}`);
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          engine.ack(ep.key, 'operator');
          renderAlarms();
        });
        ref.ack.append(b);
        ref.ack.__btn = true;
      }

      const after = prev ? prev.nextSibling : list.firstChild;
      if (ref.node !== after) list.insertBefore(ref.node, after);
      prev = ref.node;
    }
    for (const [key, ref] of refs) {
      if (!seen.has(key)) { ref.node.remove(); refs.delete(key); }
    }
  }

  function renderAlarms() {
    const active = engine.active;
    const unacked = active.filter((a) => !a.ackedAt).length;
    for (const b of ['ackAll', 'ackAll2']) {
      const btn = $(b);
      if (btn) btn.disabled = unacked === 0;
    }
    renderAlarmsInto('alarmList');
    renderAlarmsInto('alarmList2');

    // Nav badge + top-bar bell reflect what still needs an operator.
    for (const id of ['navAlarmCount', 'bellCount']) {
      const n = $(id);
      if (!n) continue;
      n.hidden = unacked === 0;
      setText(n, unacked);
    }
  }

  // ------------------------------------------------------------------ drawer
  function openDrawer(id) {
    state.selected = id;
    const p = points.find((x) => x.id === id);
    if (!p) return;
    const d = $('drawer');
    d.hidden = false;
    $('scrim').hidden = false;
    d.innerHTML = `
      <div class="drawer-head">
        <div>
          <h2 id="drawerTitle">${F.escapeHtml(p.name)}</h2>
          <div class="card-sub"><span class="tag">${F.escapeHtml(p.id)}</span> · ${F.escapeHtml(p.location || '')}</div>
        </div>
        <button class="icon-btn" id="drawerClose" aria-label="Close">${icon('i-x', 16)}</button>
      </div>
      <div id="drawerStatus" style="margin:10px 0"></div>
      <div id="drawerChart"></div>
      <div class="legend">
        <span><i></i>Measured</span>
        <span><i class="k-typical"></i>Typical</span>
        <span><i class="k-warn"></i>Warning limit</span>
        <span><i class="k-alarm"></i>Alarm limit</span>
      </div>
      <dl class="kv" id="drawerKv"></dl>
      <div class="card-title" style="margin-top:14px">Recent alarm episodes</div>
      <div id="drawerAlarms" class="alarm-list" style="margin-top:8px"></div>`;
    $('drawerClose').addEventListener('click', closeDrawer);
    drawerChart = createTrendChart($('drawerChart'), { height: 190, label: 'Measured' });
    $('drawerClose').focus();
    updateDrawer();
  }

  function closeDrawer() {
    state.selected = null;
    $('drawer').hidden = true;
    $('scrim').hidden = true;
    if (drawerChart) drawerChart.destroy();
    drawerChart = null;
  }

  function updateDrawer() {
    const p = points.find((x) => x.id === state.selected);
    if (!p || $('drawer').hidden) return;
    const v = store.pointView(p, engine);
    const g = groupById[p.groupId];
    const sub = subById[p.substationId];
    const gen = v.role === 'generation';

    const shelvedUntil = engine.suppressedUntil(p.id);
    setHtml(
      $('drawerStatus'),
      `${statusBadge(v.severity, v.quality, v.monitored)} <span class="note">last sample ${F.since(v.lastTs)} · ${F.dateTime(
        v.lastTs
      )}</span>` +
        (shelvedUntil
          ? `<div class="note" style="margin-top:6px">${icon('i-clock', 12)} This point is over limit but a new alarm is held until ${F.clockTime(
              shelvedUntil
            )} (re-arm window, to prevent repeat annunciation). The condition above is current.</div>`
          : '')
    );

    if (drawerChart) {
      const refs = [];
      if (v.monitored) {
        refs.push({ value: v.warnLimitKw, label: 'warn', kind: 'warn' });
        refs.push({ value: v.limitKw, label: gen ? 'min' : 'limit', kind: 'alarm' });
        if (!gen) refs.push({ value: p.ratedKw, label: 'rated', kind: 'rated' });
      }
      drawerChart.update(v.history, refs.filter((r) => Number.isFinite(r.value)));
    }

    const rows = [
      ['Now', v.monitored ? F.kw(v.value) : 'not monitored'],
      ['Unsmoothed sample', v.raw != null ? F.kw(v.raw) : '—'],
      ['Typical for this hour', F.kw(v.expected)],
      ['vs typical', F.signedPct(v.deltaVsExpected, 1)],
      [gen ? 'Rated output' : 'Rated demand', `${F.kw(p.ratedKw)} <span class="assumed">estimate</span>`],
      [
        gen ? 'Warning limit (min output)' : 'Warning limit',
        `${F.kw(v.warnLimitKw)}${p.lowLimitMode === 'relative' ? ` <span class="assumed">${Math.round((p.lowWarnRatio ?? 0.6) * 100)}% of expected</span>` : ''}`,
      ],
      [
        gen ? 'Alarm limit (min output)' : 'Consumption limit',
        `${F.kw(v.limitKw)}${p.lowLimitMode === 'relative' ? ` <span class="assumed">${Math.round((p.lowAlarmRatio ?? 0.35) * 100)}% of expected</span>` : ''}`,
      ],
      ['% of limit', v.monitored ? F.pct(v.pctOfLimit, 1) : '—'],
      ['Session peak', `${F.kw(v.peakKw)} at ${F.clockTime(v.peakAt)}`],
      ['Session energy', F.kwh(v.energyKwh)],
      ['Units on this tag', `${p.units} × ${F.kw(p.unitKw)} <span class="assumed">unit kW estimated</span>`],
      ['Group', `${F.escapeHtml(g?.name || '')} · ${F.escapeHtml(p.zone)}`],
      ['Fed from', `${F.escapeHtml(sub?.name || '')} <span class="assumed">allocation assumed</span>`],
      ['Service state', F.escapeHtml(p.service)],
      ['Samples received', String(v.samples)],
    ];
    setHtml($('drawerKv'), rows.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join(''));

    const eps = [...engine.active, ...engine.history].filter((e) => e.pointId === p.id).slice(0, 8);
    setHtml(
      $('drawerAlarms'),
      eps.length
        ? eps
            .map(
              (ep) => `<div class="alarm alarm--${ep.kind === 'comms' ? 'comms' : ep.severity}${ep.clearedAt ? ' alarm--cleared' : ''}">
        <div class="alarm-top">${
          ep.kind === 'comms'
            ? `<span class="badge badge--offline">${icon('i-offline')}Comms lost</span>`
            : statusBadge(ep.severity, QUALITY.GOOD)
        }</div><div></div>
        <div class="alarm-msg">${F.escapeHtml(ep.message || '')}</div>
        <div class="alarm-meta">raised ${F.dateTime(ep.raisedAt)}${ep.ackedAt ? ` · acked ${F.clockTime(ep.ackedAt)}` : ''}${
                ep.clearedAt ? ` · cleared ${F.clockTime(ep.clearedAt)} · lasted ${F.duration(ep.clearedAt - ep.raisedAt)}` : ' · ongoing'
              }</div></div>`
            )
            .join('')
        : `<div class="empty">${icon('i-check', 15)}No alarm episodes recorded for this point.</div>`
    );
  }

  // -------------------------------------------------------------- management
  function renderManagement() {
    const site = store.site;
    const runFor = Date.now() - site.startedAt;
    const avg = site.energyKwh && runFor > 0 ? (site.energyKwh / (runFor / 3_600_000)) : 0;
    const rows = [
      ['Monitoring since', F.dateTime(site.startedAt)],
      ['Elapsed', F.duration(runFor)],
      ['Net demand now', F.kw(site.netKw)],
      ['Average demand', F.kw(avg)],
      ['Peak demand', `${F.kw(site.peakKw)} at ${F.clockTime(site.peakAt)}`],
      ['Load factor', avg && site.peakKw ? F.pct((avg / site.peakKw) * 100, 1) : '—'],
      ['Energy consumed', F.kwh(site.energyKwh)],
      ['Points reporting', `${site.reporting} of ${points.length}`],
      ['Open alarms', String(engine.counts().total)],
      ['Episodes logged', String(engine.history.length + engine.active.length)],
    ];
    setHtml($('mgmtSummary'), rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join(''));

    renderBars(
      $('mgmtGroupBars'),
      groups
        .map((g) => ({ label: g.name, value: store.groupRollup(g.id).loadKw, severity: groupSeverity(g.id).worst }))
        .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    );

    const energyRows = groups
      .map((g) => {
        // A generation group reports the energy it PRODUCED, as a positive
        // number. Generation sitting inside a load group still nets off.
        const sign = (p) => (g.generation ? 1 : p.role === 'generation' ? -1 : 1);
        const kwh = points
          .filter((p) => p.groupId === g.id)
          .reduce((a, p) => a + (store.rawState(p.id)?.energyKwh || 0) * sign(p), 0);
        return { label: g.generation ? `${g.name} (produced)` : g.name, value: kwh, display: F.kwh(kwh) };
      })
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    renderBars($('mgmtEnergyBars'), energyRows, { unit: 'kWh' });

    renderBars(
      $('mgmtSubBars'),
      substations
        .filter((s) => !s.standalone)
        .map((s) => {
          const r = store.substationRollup(s.id);
          const pct = s.capacityKw ? (r.loadKw / s.capacityKw) * 100 : 0;
          return {
            label: `${s.name} (${s.transformerCount} tx)`,
            value: pct,
            display: `${F.pct(pct, 1)} of ${s.capacityKw.toLocaleString('en-US')} kW`,
            severity: pct > 90 ? 'critical' : pct > 80 ? 'warning' : 'none',
          };
        }),
      { max: 100, unit: '%' }
    );

    const all = [...engine.active, ...engine.history];
    setHtml(
      $('alarmLogBody'),
      all.length
        ? all
            .map(
              (ep) => `<tr>
        <td class="tag">${F.escapeHtml(ep.pointId)}</td>
        <td>${F.escapeHtml(ep.pointName)}</td>
        <td>${ep.kind === 'comms' ? 'Comms' : ep.kind === 'low' ? 'Under-output' : 'Over limit'}</td>
        <td>${statusBadge(ep.severity, QUALITY.GOOD)}</td>
        <td class="num">${ep.kind === 'comms' ? '—' : F.kw(ep.peakKw)}</td>
        <td class="num">${ep.limitKw ? F.kw(ep.limitKw) : '—'}</td>
        <td class="num">${F.dateTime(ep.raisedAt)}</td>
        <td class="num">${ep.ackedAt ? F.dateTime(ep.ackedAt) : '—'}</td>
        <td class="num">${ep.clearedAt ? F.dateTime(ep.clearedAt) : 'ongoing'}</td>
        <td class="num">${F.duration((ep.clearedAt || Date.now()) - ep.raisedAt)}</td>
      </tr>`
            )
            .join('')
        : `<tr><td colspan="10"><div class="empty">${icon('i-check', 15)}No alarm episodes recorded yet.</div></td></tr>`
    );
  }

  // ---------------------------------------------------------------- CSV export
  function download(name, text) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function exportPointsCsv() {
    const head = [
      'tag_id','name','location','group','zone','substation','units','unit_kw_estimated','rated_kw_estimated',
      'warn_limit_kw','alarm_limit_kw','value_kw','typical_kw','pct_of_limit','severity','quality',
      'session_peak_kw','session_energy_kwh','last_sample_iso',
    ];
    const lines = [head.join(',')];
    for (const p of points) {
      const v = store.pointView(p, engine);
      lines.push(
        [
          p.id, p.name, p.location || '', groupById[p.groupId]?.name || '', p.zone, subById[p.substationId]?.name || '',
          p.units, p.unitKw, p.ratedKw, p.warnKw, p.alarmKw,
          v.value?.toFixed(2) ?? '', v.expected?.toFixed(2) ?? '', v.pctOfLimit?.toFixed(1) ?? '',
          v.severity, v.quality, v.peakKw.toFixed(2), v.energyKwh.toFixed(3),
          v.lastTs ? new Date(v.lastTs).toISOString() : '',
        ].map(F.csvCell).join(',')
      );
    }
    download(`aor-points-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`, lines.join('\n'));
  }

  function exportAlarmsCsv() {
    const head = ['tag_id','name','type','severity','limit_kw','trigger_kw','peak_kw','raised_iso','acked_iso','cleared_iso','duration_s','state','message'];
    const lines = [head.join(',')];
    for (const ep of [...engine.active, ...engine.history]) {
      lines.push(
        [
          ep.pointId, ep.pointName, ep.kind, ep.severity, ep.limitKw ?? '', ep.triggerKw?.toFixed(2) ?? '',
          ep.peakKw?.toFixed(2) ?? '', new Date(ep.raisedAt).toISOString(),
          ep.ackedAt ? new Date(ep.ackedAt).toISOString() : '',
          ep.clearedAt ? new Date(ep.clearedAt).toISOString() : '',
          Math.round(((ep.clearedAt || Date.now()) - ep.raisedAt) / 1000), ep.state, ep.message || '',
        ].map(F.csvCell).join(',')
      );
    }
    download(`aor-alarms-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`, lines.join('\n'));
  }

  // ------------------------------------------------------------ feed health
  function renderConnection(status) {
    const el = $('conn');
    setAttr(el, 'data-state', status.state);
    const labels = {
      connecting: 'Connecting…',
      live: 'Live',
      degraded: 'Feed delayed',
      down: 'Feed lost',
      paused: 'Paused',
    };
    setText($('connText'), `${labels[status.state]} · ${status.mode.toUpperCase()}`);
    setText($('connAge'), status.lastMessageAt ? F.since(status.lastMessageAt) : '');

    const banner = $('connBanner');
    if (status.state === 'down' || status.state === 'degraded') {
      banner.hidden = false;
      banner.className = `banner banner--${status.state}`;
      setHtml(
        banner,
        `${icon(status.state === 'down' ? 'i-critical' : 'i-warn', 18)}<span>${
          status.state === 'down'
            ? `<b>Feed lost.</b> No data received for ${F.since(status.lastMessageAt)}. Values below are the last known readings and are NOT current.`
            : `<b>Feed delayed.</b> Last update ${F.since(status.lastMessageAt)}. Readings may be behind.`
        }${status.lastError ? ` (${F.escapeHtml(status.lastError)})` : ''}</span>`
      );
      for (const v of document.querySelectorAll('.view')) v.classList.toggle('stale-veil', status.state === 'down');
    } else {
      banner.hidden = true;
      for (const v of document.querySelectorAll('.view')) v.classList.remove('stale-veil');
    }
    updatePlayPause();
  }

  return { mountStatic, update, renderConnection, renderAlarms, renderManagement, openDrawer };
}
