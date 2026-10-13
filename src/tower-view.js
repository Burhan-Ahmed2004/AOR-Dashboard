/**
 * TOWER DASHBOARD VIEW
 * ====================
 * ONE renderer serving BOTH towers. The tower id is a parameter, never a
 * duplicated component, so Tower 1 and Tower 2 cannot drift apart.
 *
 * Laid out as a control-room wall board: four quadrants that fill one screen
 * without scrolling, read in the order
 *
 *     1 Electricity   2 Lifts
 *     3 Fire          4 Water (tanks + pumps)
 *
 * Below the wall breakpoint the same four panels stack in that same order and
 * the page scrolls normally, so phones and tablets stay usable.
 *
 * Every value drawn here comes from `towers.js`. This file reads no sensor and
 * invents no reading; swapping the demo adapter for real IoT data changes
 * nothing in this file.
 *
 * Status is never colour alone: each state ships an icon, a word and a colour.
 */

import * as F from './format.js';
import { createTrendChart, sparklineSvg } from './charts.js';
import { STATE, LIFT_STATE, ALARM_PANEL, TANK_STATE, PUMP_STATE, TOWER_BY_ID } from './towers.js';

const $ = (id) => document.getElementById(id);
const icon = (id, size = 14) => `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#${id}"/></svg>`;

function setHtml(node, html) {
  if (!node) return;
  if (node.__h === html) return;
  node.__h = html;
  node.innerHTML = html;
}

/** state -> {tone, word, icon}. The word is what survives a greyscale print. */
const STATE_META = {
  [STATE.NORMAL]:  { tone: 'ok',   word: 'Normal',       icon: 'i-check' },
  [STATE.ALERT]:   { tone: 'crit', word: 'Alert',        icon: 'i-critical' },
  [STATE.FAULT]:   { tone: 'warn', word: 'Sensor fault', icon: 'i-warn' },
  [STATE.OFFLINE]: { tone: 'off',  word: 'Offline',      icon: 'i-offline' },
};

const LIFT_META = {
  [LIFT_STATE.RUNNING]:        { tone: 'ok',   word: 'Running',        icon: 'i-check' },
  [LIFT_STATE.IDLE]:           { tone: 'idle', word: 'Idle',           icon: 'i-minus' },
  [LIFT_STATE.OUT_OF_SERVICE]: { tone: 'warn', word: 'Out of service', icon: 'i-warn' },
  [LIFT_STATE.FAULT]:          { tone: 'crit', word: 'Fault',          icon: 'i-critical' },
};

const TANK_META = {
  [TANK_STATE.NORMAL]:   { tone: 'ok',   word: 'Normal',       icon: 'i-check' },
  [TANK_STATE.LOW]:      { tone: 'warn', word: 'Low level',    icon: 'i-warn' },
  [TANK_STATE.CRITICAL]: { tone: 'crit', word: 'Critical low', icon: 'i-critical' },
  [TANK_STATE.HIGH]:     { tone: 'warn', word: 'High level',   icon: 'i-warn' },
  [TANK_STATE.OFFLINE]:  { tone: 'off',  word: 'No signal',    icon: 'i-offline' },
};

const PUMP_META = {
  [PUMP_STATE.RUNNING]: { tone: 'ok',   word: 'Running', icon: 'i-check' },
  [PUMP_STATE.STOPPED]: { tone: 'idle', word: 'Stopped', icon: 'i-minus' },
  [PUMP_STATE.STANDBY]: { tone: 'idle', word: 'Standby', icon: 'i-minus' },
  [PUMP_STATE.FAULT]:   { tone: 'crit', word: 'Fault',   icon: 'i-critical' },
};

const DIR_ICON = { up: 'i-up', down: 'i-down', stationary: 'i-minus' };
const TREND_WORD = { filling: 'Filling', draining: 'Draining', steady: 'Steady', unknown: 'Unknown' };
const TREND_ICON = { filling: 'i-up', draining: 'i-down', steady: 'i-minus', unknown: 'i-offline' };

function badge(meta, extra = '') {
  return `<span class="tstat tstat--${meta.tone}">${icon(meta.icon, 12)}${meta.word}${extra}</span>`;
}

function prov(kind) {
  const label = { reg: 'reg', sim: 'sim', demo: 'demo data' }[kind] || kind;
  return `<span class="prov prov--${kind}">${label}</span>`;
}

/**
 * Floor label -> a number, so detectors and lift cars can be placed on the
 * same vertical scale. "B1" is below ground, "GF" is zero, "Roof" is the top.
 */
function floorIndex(label, def) {
  if (label === 'Roof') return def.floors + 1;
  if (label === 'GF') return 0;
  const b = /^B(\d+)$/.exec(label);
  if (b) return -Number(b[1]);
  const l = /^L?(\d+)$/.exec(label);
  return l ? Number(l[1]) : 0;
}

/** Position on a 0..100 scale running from the lowest basement to the roof. */
function floorPct(label, def) {
  const lo = -def.basements;
  const hi = def.floors + 1;
  const v = floorIndex(label, def);
  return Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
}

export function createTowerView(ctx) {
  const { towerModel } = ctx;
  let elecChart = null;
  let mounted = false;
  let currentTower = 'T1';

  function mount() {
    if (mounted) return;
    mounted = true;
    elecChart = createTrendChart($('twElecChart'), { height: 150, padLeft: 44, padRight: 54, label: 'Block demand' });

    // Demo controls — deliberately cordoned off and labelled.
    for (const btn of document.querySelectorAll('#twDemoControls button')) {
      btn.addEventListener('click', () => {
        towerModel.triggerDemo(currentTower, btn.dataset.demo);
        render(currentTower);
      });
    }
  }

  function setTower(id) {
    currentTower = TOWER_BY_ID[id] ? id : 'T1';
    return currentTower;
  }

  // ================================================== 1. ELECTRICITY
  function renderElectricity(s) {
    const e = s.electricity;
    if (!e) {
      setHtml($('twElecStats'), '<div class="tbig-sub">No electrical point mapped to this tower.</div>');
      return;
    }
    const dir = e.deltaVsTypical > 0.03 ? 'i-up' : e.deltaVsTypical < -0.03 ? 'i-down' : 'i-minus';
    const loadPct = e.blockRatedKw ? Math.max(0, Math.min(100, (e.blockKw / e.blockRatedKw) * 100)) : 0;
    const loadTone = loadPct >= 90 ? 'crit' : loadPct >= 75 ? 'warn' : 'ok';

    setHtml(
      $('twElecStats'),
      [
        [F.kw(e.towerKw), `Tower share ${prov('sim')}`, `${e.sharePct}% of the shared block`],
        [F.kw(e.blockKw), `Block C-6 + C-7 ${prov('sim')}`, F.escapeHtml(e.sharedPointId)],
        [F.kwh(e.towerEnergyKwh), `Tower energy ${prov('sim')}`, 'this session'],
        [F.kw(e.liftKw ?? 0), `Lift supply ${prov('sim')}`, F.escapeHtml(e.liftPointId || '—')],
      ]
        .map(
          ([v, l, sub]) =>
            `<div class="tstat-card"><div class="tstat-v">${v}</div>
             <div class="tstat-l">${l}</div><div class="tstat-s">${sub}</div></div>`
        )
        .join('')
    );

    // Graphical loading bar against the block's rated demand.
    setHtml(
      $('twElecLoad'),
      `<div class="loadbar-head"><span>Block loading vs rated ${F.kw(e.blockRatedKw)}</span>
         <span class="loadbar-pct loadbar-pct--${loadTone}">${F.pct(loadPct, 0)}</span></div>
       <div class="loadbar" role="img" aria-label="Block loading ${F.pct(loadPct, 0)} of rated demand">
         <div class="loadbar-fill loadbar-fill--${loadTone}" style="width:${loadPct.toFixed(1)}%"></div>
         <span class="loadbar-tick" style="left:75%"></span>
         <span class="loadbar-tick loadbar-tick--hi" style="left:90%"></span>
       </div>`
    );

    setHtml(
      $('twElecMeta'),
      `<div class="tkv"><span>vs typical this hour</span><span>${icon(dir, 12)} ${F.signedPct(e.deltaVsTypical, 1)}</span></div>
       <div class="tkv"><span>Session peak</span><span>${F.kw(e.blockPeakKw)}</span></div>
       <div class="tkv"><span>Block energy</span><span>${F.kwh(e.blockEnergyKwh)}</span></div>
       <div class="tkv"><span>Fed from</span><span>${F.escapeHtml(e.substation)}</span></div>
       <div class="tkv"><span>Last reading</span><span>${F.since(e.lastTs)}</span></div>`
    );

    if (elecChart && e.history && e.history.length > 1) elecChart.update(e.history, []);
  }

  // ========================================================= 2. LIFTS
  function renderLifts(s) {
    const avail = s.lifts.filter((l) => l.state === LIFT_STATE.RUNNING || l.state === LIFT_STATE.IDLE).length;
    const tone = avail === s.lifts.length ? 'ok' : avail === 0 ? 'crit' : 'warn';

    setHtml(
      $('twLiftSummary'),
      `<div class="tmini"><span class="tmini-v tmini-v--${tone}">${avail} / ${s.lifts.length}</span>
        <span class="tmini-l">lifts available</span></div>
       <div class="tbig-sub">Count from the register ${prov('reg')} &middot; live position ${prov('demo')}</div>`
    );

    // Shaft diagram: each lift is a vertical track with the car drawn at its
    // floor. The number and the state word carry the same information.
    setHtml(
      $('twLifts'),
      s.lifts.length
        ? s.lifts
            .map((l) => {
              const lm = LIFT_META[l.state];
              const out = l.state === LIFT_STATE.OUT_OF_SERVICE;
              const pos = out ? 0 : floorPct(String(l.floor), s.def);
              const label = out ? 'out of service' : `floor ${l.floor}, ${l.direction}`;
              return `<div class="shaft shaft--${lm.tone}">
                <div class="shaft-floor">${out ? '&mdash;' : l.floor}</div>
                <div class="shaft-track" role="img" aria-label="${F.escapeHtml(l.name)} ${label}">
                  <div class="shaft-car shaft-car--${lm.tone}" style="bottom:${pos.toFixed(1)}%">
                    ${out ? '' : icon(DIR_ICON[l.direction] || 'i-minus', 11)}
                  </div>
                </div>
                <div class="shaft-name">${F.escapeHtml(l.name)}</div>
                ${badge(lm)}
                <div class="shaft-meta">${l.trips} trips &middot; ${F.since(l.lastUpdate)}</div>
              </div>`;
            })
            .join('')
        : '<div class="tempty">No lifts recorded for this tower in the register.</div>'
    );
  }

  // ================================================= 3. FIRE DETECTION
  function renderFire(s) {
    const alerting = s.fire.alerting;
    const panel = s.fire.panel;
    const counts = {
      alert: alerting.length,
      fault: s.fire.faulty.length,
      offline: s.fire.offline.length,
    };
    counts.normal = s.fire.sensors.length - counts.alert - counts.fault - counts.offline;

    setHtml(
      $('twFireBanner'),
      alerting.length
        ? `<div class="tbanner tbanner--fire" role="alert">
             ${icon('i-critical', 22)}
             <div><b>FIRE DETECTED — ${F.escapeHtml(s.def.name)} (${F.escapeHtml(s.def.registerName)})</b>
             <div class="tbanner-sub">${alerting.map((a) => `${F.escapeHtml(a.label)} (${F.escapeHtml(a.floor)})`).join(' &middot; ')}
             &mdash; detected ${F.since(alerting[0].since)} at ${F.clockTime(alerting[0].since)}</div>
             <div class="tbanner-note">Demo data. No alarm, sounder or notification is connected to any hardware.</div></div>
           </div>`
        : ''
    );

    // Annunciator — the four lamps a real fire panel carries. Each lamp is lit
    // or dark AND labelled, so the state reads without colour.
    const lamps = [
      ['alarm', 'Alarm', panel.state === ALARM_PANEL.ACTIVE],
      ['fault', 'Fault', panel.state === ALARM_PANEL.FAULT],
      ['super', 'Supervisory', counts.offline > 0],
      ['norm', 'Normal', panel.state === ALARM_PANEL.INACTIVE && counts.offline === 0],
    ];
    setHtml(
      $('twFirePanel'),
      `<div class="annun" role="img" aria-label="Fire alarm panel ${
        panel.state === ALARM_PANEL.ACTIVE ? 'in alarm' : panel.state === ALARM_PANEL.FAULT ? 'in fault' : 'normal'}">
        ${lamps
          .map(
            ([k, w, on]) => `<div class="lamp lamp--${k}${on ? ' is-on' : ''}">
              <span class="lamp-led"></span><span class="lamp-w">${w}</span></div>`
          )
          .join('')}
      </div>
      <div class="annun-meta">
        <span class="tag">${F.escapeHtml(panel.id)}</span>
        <span>${panel.since ? `since ${F.clockTime(panel.since)}` : 'no change logged'}</span>
        <span>updated ${F.since(panel.lastUpdate)}</span>
      </div>`
    );

    // Detector tally as a segmented bar — the whole estate at one glance.
    const total = s.fire.sensors.length || 1;
    const seg = (n, cls, word) =>
      n ? `<span class="tallybar-seg tallybar-seg--${cls}" style="width:${(n / total) * 100}%"
            title="${n} ${word}"></span>` : '';
    setHtml(
      $('twFireTally'),
      `<div class="tallybar" role="img" aria-label="${counts.normal} normal, ${counts.alert} in alarm, ${counts.fault} fault, ${counts.offline} offline">
         ${seg(counts.alert, 'crit', 'in alarm')}${seg(counts.fault, 'warn', 'fault')}${seg(counts.offline, 'off', 'offline')}${seg(counts.normal, 'ok', 'normal')}
       </div>
       <div class="tally-keys">
         <span class="tally-k"><i class="tally-d tally-d--ok"></i>${counts.normal} normal</span>
         <span class="tally-k${counts.alert ? ' is-hot' : ''}"><i class="tally-d tally-d--crit"></i>${counts.alert} fire</span>
         <span class="tally-k"><i class="tally-d tally-d--warn"></i>${counts.fault} fault</span>
         <span class="tally-k"><i class="tally-d tally-d--off"></i>${counts.offline} offline</span>
       </div>`
    );

    // Zone elevation — detectors drawn where they sit in the building, roof at
    // the top, basement at the bottom.
    const zones = [...s.fire.sensors].sort(
      (a, b) => floorIndex(b.floor, s.def) - floorIndex(a.floor, s.def)
    );
    setHtml(
      $('twFireZones'),
      zones
        .map((sn) => {
          const sm = STATE_META[sn.state];
          const word = sn.state === STATE.ALERT ? 'Fire detected' : sm.word;
          const when = sn.state === STATE.ALERT ? F.clockTime(sn.since) : F.since(sn.lastUpdate);
          return `<div class="zone zone--${sm.tone}">
            <span class="zone-led zone-led--${sm.tone}"></span>
            <span class="zone-fl">${F.escapeHtml(sn.floor)}</span>
            <span class="zone-nm">${F.escapeHtml(sn.label)}</span>
            <span class="zone-st">${word}</span>
            <span class="zone-tm">${when}</span>
          </div>`;
        })
        .join('')
    );
  }

  // ======================================== 4. WATER — TANKS AND PUMPS
  function renderWater(s) {
    const w = s.water;

    setHtml(
      $('twLeakBanner'),
      s.leak.alerting.length
        ? `<div class="tbanner tbanner--crit" role="alert">
             ${icon('i-critical', 20)}
             <div><b>Water leak detected — ${F.escapeHtml(s.def.name)}</b>
             <div class="tbanner-sub">${s.leak.alerting.map((a) => `${F.escapeHtml(a.label)} (${F.escapeHtml(a.floor)})`).join(' &middot; ')}
             &mdash; detected ${F.since(s.leak.alerting[0].since)}</div></div>
           </div>`
        : ''
    );

    // --- tanks: a filled glass per tank, with the alarm levels marked -----
    setHtml(
      $('twTanks'),
      w.tanks
        .map((t) => {
          const m = TANK_META[t.state];
          const pct = t.pct;
          const live = pct != null;
          const fillTone = t.state === TANK_STATE.CRITICAL ? 'crit'
            : t.state === TANK_STATE.LOW || t.state === TANK_STATE.HIGH ? 'warn' : 'ok';
          const aria = live
            ? `${t.name}, ${Math.round(pct)} percent full, ${m.word}`
            : `${t.name}, level transmitter offline, no current reading`;
          const spark = t.history.length > 2
            ? sparklineSvg(t.history.map((h) => h.v), { w: 70, h: 20 })
            : '';
          return `<div class="tank tank--${m.tone}">
            <div class="tank-glass${live ? '' : ' tank-glass--blind'}" role="img" aria-label="${F.escapeHtml(aria)}">
              ${live ? `<div class="tank-fill tank-fill--${fillTone}" style="height:${pct.toFixed(1)}%"></div>` : ''}
              <span class="tank-mark tank-mark--low" style="bottom:${t.lowPct}%"></span>
              <span class="tank-mark tank-mark--crit" style="bottom:${t.criticalPct}%"></span>
              <span class="tank-pct">${live ? `${Math.round(pct)}<small>%</small>` : '<small>no<br>data</small>'}</span>
            </div>
            <div class="tank-info">
              <div class="tank-name">${F.escapeHtml(t.name)}</div>
              <div class="tank-role">${F.escapeHtml(t.role)} &middot; ${F.escapeHtml(t.floor)}
                &middot; ${(t.capacityL / 1000).toFixed(0)}k L</div>
              ${badge(m)}
              <div class="tank-kv">${
                live
                  ? `${icon(TREND_ICON[t.trend], 11)} ${TREND_WORD[t.trend]} &middot;
                     ${(t.litres / 1000).toFixed(1)}k L &middot; ${F.since(t.lastUpdate)}`
                  : `Last known ${Math.round(t.lastKnownPct)}% &middot; ${F.since(t.lastUpdate)}
                     <span class="tank-blindnote">not a live reading</span>`
              }</div>
              ${live ? `<div class="tank-spark">${spark}</div>` : ''}
            </div>
          </div>`;
        })
        .join('')
    );

    // --- pumps -----------------------------------------------------------
    setHtml(
      $('twPumps'),
      w.pumps
        .map((p) => {
          const m = PUMP_META[p.state];
          const running = p.state === PUMP_STATE.RUNNING;
          return `<div class="pump pump--${m.tone}">
            <span class="pump-led pump-led--${m.tone}${running ? ' is-running' : ''}"
              role="img" aria-label="${F.escapeHtml(p.name)} ${m.word}"></span>
            <div class="pump-txt">
              <div class="pump-name">${F.escapeHtml(p.name)}</div>
              <div class="pump-sub">${F.escapeHtml(p.duty)} &middot; ${m.word}
                &middot; ${F.duration(p.runtimeMs)} run</div>
            </div>
          </div>`;
        })
        .join('')
    );

    // --- leak detection, kept as a compact strip -------------------------
    const lm = STATE_META[s.leak.status];
    const leakWord = s.leak.status === STATE.ALERT ? 'LEAK DETECTED' : lm.word;
    setHtml(
      $('twLeakStrip'),
      `<div class="leakstrip leakstrip--${lm.tone}">
         <span class="leakstrip-l">Leak detection</span>
         ${badge({ ...lm, word: leakWord })}
         <span class="leakstrip-dots" role="img" aria-label="${s.leak.sensors.length} leak detectors">
           ${s.leak.sensors
             .map((sn) => {
               const sm = STATE_META[sn.state];
               return `<i class="leakdot leakdot--${sm.tone}" title="${F.escapeHtml(sn.id)} — ${F.escapeHtml(sn.label)} (${F.escapeHtml(sn.floor)}): ${sm.word}"></i>`;
             })
             .join('')}
         </span>
         <span class="leakstrip-r">${s.leak.sensors.length} detectors &middot;
           ${s.leak.offline.length} offline &middot; ${s.leak.faulty.length} fault</span>
       </div>
       ${
         s.leak.alerting.length
           ? `<div class="leakstrip-at">${s.leak.alerting
               .map((a) => `${F.escapeHtml(a.label)} (${F.escapeHtml(a.floor)})`)
               .join(' &middot; ')}</div>`
           : ''
       }`
    );
  }

  // ---------------------------------------------------------- events bar
  function renderEvents(s) {
    const open = s.events.filter((e) => !e.clearedAt);
    setHtml($('twEventCount'), open.length ? `${open.length} active` : 'none active');
    setHtml(
      $('twEvents'),
      s.events.length
        ? s.events
            .slice(0, 10)
            .map(
              (e) => `<div class="tevent tevent--${e.severity}${e.clearedAt ? ' tevent--cleared' : ''}">
          <span class="tevent-sev">${e.severity === 'critical' ? 'CRIT' : e.severity === 'warning' ? 'WARN' : 'INFO'}</span>
          <div class="tevent-main"><b>${F.escapeHtml(e.title)}</b> &mdash; ${F.escapeHtml(e.detail)}
            <div class="tevent-sub">${F.escapeHtml(e.towerName)} &middot; ${F.clockTime(e.raisedAt)}
            ${e.clearedAt ? `&middot; cleared ${F.clockTime(e.clearedAt)}` : '&middot; ongoing'}</div></div>
        </div>`
            )
            .join('')
        : `<div class="tempty">${icon('i-check', 15)}No events recorded for this tower.</div>`
    );
  }

  /** Fit the trend chart to whatever height its panel actually has. */
  function fitChart() {
    const box = $('twElecChart');
    if (!elecChart || !box) return;
    const h = box.clientHeight;
    if (h > 60) elecChart.setHeight(h);
  }

  /** Render the whole tower dashboard for one tower. */
  function render(towerId) {
    setTower(towerId);
    const s = towerModel.snapshot(currentTower);
    if (!s) return;

    setHtml($('twTitle'), `${F.escapeHtml(s.def.name)}`);
    setHtml(
      $('twSubtitle'),
      `${F.escapeHtml(s.def.registerName)} &middot; ${s.def.floors} floors + ${s.def.basements} basement ${prov('demo')}`
    );

    // tower switcher inside the view
    setHtml(
      $('twSwitch'),
      towerModel.towers
        .map((t) => {
          const sum = towerModel.summary(t.id);
          return `<button type="button" class="twtab${t.id === currentTower ? ' is-active' : ''}"
            data-tower="${t.id}" aria-current="${t.id === currentTower ? 'page' : 'false'}">
            <span class="twtab-dot twtab-dot--${sum.severity}"></span>${F.escapeHtml(t.name)}
            <span class="twtab-sub">${F.escapeHtml(t.registerName)}</span></button>`;
        })
        .join('')
    );

    renderElectricity(s);
    renderLifts(s);
    renderFire(s);
    renderWater(s);
    renderEvents(s);
    fitChart();
  }

  return { mount, render, setTower, fitChart, get currentTower() { return currentTower; } };
}

/**
 * The two tower cards shown at the top of the main dashboard.
 * Rendered separately because they belong to the Overview, not the tower view.
 */
export function renderTowerSelector(container, towerModel, onSelect, activeId = null) {
  if (!container) return;
  if (!container.__wired) {
    container.addEventListener('click', (e) => {
      const card = e.target.closest('[data-tower]');
      if (card) onSelect(card.dataset.tower);
    });
    container.__wired = true;
  }
  const html = towerModel.towers
    .map((t) => {
      const s = towerModel.summary(t.id);
      const sev = s.severity;
      const word = sev === 'critical' ? 'Attention required' : sev === 'warning' ? 'Check' : 'All normal';
      const ic = sev === 'critical' ? 'i-critical' : sev === 'warning' ? 'i-warn' : 'i-check';
      const waterTone = s.water === TANK_STATE.CRITICAL ? 'crit'
        : s.water === TANK_STATE.NORMAL ? 'ok' : 'warn';
      const waterWord = s.water === TANK_STATE.CRITICAL ? 'LOW'
        : s.water === TANK_STATE.OFFLINE ? 'No signal'
        : s.minTankPct != null ? `${Math.round(s.minTankPct)}% min` : '—';
      return `<button type="button" class="tcard tcard--${sev}${t.id === activeId ? ' is-active' : ''}" data-tower="${t.id}">
        <div class="tcard-top">
          <div><div class="tcard-name">${F.escapeHtml(t.name)}</div>
            <div class="tcard-reg">${F.escapeHtml(t.registerName)}</div></div>
          <span class="tstat tstat--${sev === 'critical' ? 'crit' : sev === 'warning' ? 'warn' : 'ok'}">${icon(ic, 12)}${word}</span>
        </div>
        <div class="tcard-grid">
          <div><span class="tcard-k">Demand</span><span class="tcard-v">${F.kw(s.kw ?? 0)}</span></div>
          <div><span class="tcard-k">Lifts</span><span class="tcard-v">${s.liftsAvailable} / ${s.liftsTotal}</span></div>
          <div><span class="tcard-k">Fire</span><span class="tcard-v tcard-v--${s.fire === 'alert' ? 'crit' : s.fire === 'normal' ? 'ok' : 'warn'}">${
            s.fire === 'alert' ? 'DETECTED' : s.fire === 'normal' ? 'Normal' : s.fire === 'offline' ? 'Offline' : 'Fault'}</span></div>
          <div><span class="tcard-k">Water</span><span class="tcard-v tcard-v--${
            s.leak === 'alert' ? 'crit' : waterTone}">${s.leak === 'alert' ? 'LEAK' : waterWord}</span></div>
        </div>
        <div class="tcard-go">Open ${F.escapeHtml(t.name)} dashboard &rarr;</div>
      </button>`;
    })
    .join('');
  if (container.__h !== html) {
    container.__h = html;
    container.innerHTML = html;
  }
}
