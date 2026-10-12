/**
 * TOWER DASHBOARD VIEW
 * ====================
 * ONE renderer serving BOTH towers. The tower id is a parameter, never a
 * duplicated component, so Tower 1 and Tower 2 cannot drift apart.
 *
 * Every value it draws comes from `towers.js`. This file reads no sensor and
 * invents no reading; swapping the demo adapter for real IoT data changes
 * nothing here.
 *
 * Status is never colour alone: each state ships an icon, a word and a colour.
 */

import * as F from './format.js';
import { createTrendChart } from './charts.js';
import { STATE, LIFT_STATE, ALARM_PANEL, TOWER_BY_ID } from './towers.js';

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

const DIR_ICON = { up: 'i-up', down: 'i-down', stationary: 'i-minus' };

function badge(meta, extra = '') {
  return `<span class="tstat tstat--${meta.tone}">${icon(meta.icon, 12)}${meta.word}${extra}</span>`;
}

function prov(kind) {
  const label = { reg: 'reg', sim: 'sim', demo: 'demo data' }[kind] || kind;
  return `<span class="prov prov--${kind}">${label}</span>`;
}

export function createTowerView(ctx) {
  const { towerModel } = ctx;
  let elecChart = null;
  let mounted = false;
  let currentTower = 'T1';

  function mount() {
    if (mounted) return;
    mounted = true;
    elecChart = createTrendChart($('twElecChart'), { height: 180, label: 'Block demand' });

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

  // ------------------------------------------------------------ A. water leak
  function renderLeak(s) {
    const m = STATE_META[s.leak.status];
    const alerting = s.leak.alerting;

    setHtml(
      $('twLeakBanner'),
      alerting.length
        ? `<div class="tbanner tbanner--crit" role="alert">
             ${icon('i-critical', 20)}
             <div><b>Water leak detected — ${F.escapeHtml(s.def.name)}</b>
             <div class="tbanner-sub">${alerting.map((a) => `${F.escapeHtml(a.label)} (${F.escapeHtml(a.floor)})`).join(' &middot; ')}
             &mdash; detected ${F.since(alerting[0].since)}</div></div>
           </div>`
        : ''
    );

    setHtml(
      $('twLeakStatus'),
      `<div class="tbig tbig--${m.tone}">${m.word === 'Alert' ? 'Leakage Detected' : m.word === 'Normal' ? 'Normal' : m.word}</div>
       <div class="tbig-sub">${s.leak.sensors.length} detectors &middot;
       ${s.leak.offline.length} offline &middot; ${s.leak.faulty.length} fault</div>`
    );

    setHtml(
      $('twLeakSensors'),
      s.leak.sensors
        .map((sn) => {
          const sm = STATE_META[sn.state];
          return `<tr><td class="tag">${F.escapeHtml(sn.id)}</td>
            <td>${F.escapeHtml(sn.label)}</td>
            <td>${F.escapeHtml(sn.floor)}</td>
            <td>${badge(sm)}${sn.stale ? ` <span class="tstat tstat--off">${icon('i-clock', 12)}Stale</span>` : ''}</td>
            <td class="num">${F.since(sn.lastUpdate)}</td></tr>`;
        })
        .join('')
    );
  }

  // ------------------------------------------------------------- B. fire
  function renderFire(s) {
    const m = STATE_META[s.fire.status];
    const alerting = s.fire.alerting;
    const panel = s.fire.panel;
    const panelMeta =
      panel.state === ALARM_PANEL.ACTIVE ? { tone: 'crit', word: 'ACTIVE', icon: 'i-critical' }
      : panel.state === ALARM_PANEL.FAULT ? { tone: 'warn', word: 'Fault', icon: 'i-warn' }
      : { tone: 'idle', word: 'Inactive', icon: 'i-minus' };

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

    setHtml(
      $('twFireStatus'),
      `<div class="tbig tbig--${m.tone}">${s.fire.status === STATE.ALERT ? 'FIRE DETECTED' : m.word === 'Normal' ? 'Normal' : m.word}</div>
       <div class="tbig-sub">${s.fire.sensors.length} detectors &middot;
       ${s.fire.offline.length} offline &middot; ${s.fire.faulty.length} fault</div>`
    );

    setHtml(
      $('twFirePanel'),
      `<div class="tkv"><span>Alarm panel</span><span>${badge(panelMeta)}</span></div>
       <div class="tkv"><span>Panel ID</span><span class="tag">${F.escapeHtml(panel.id)}</span></div>
       <div class="tkv"><span>State since</span><span>${panel.since ? F.clockTime(panel.since) : '&mdash;'}</span></div>
       <div class="tkv"><span>Last update</span><span>${F.since(panel.lastUpdate)}</span></div>`
    );

    setHtml(
      $('twFireSensors'),
      s.fire.sensors
        .map((sn) => {
          const sm = STATE_META[sn.state];
          const word = sn.state === STATE.ALERT ? 'Fire detected' : sm.word;
          return `<tr><td class="tag">${F.escapeHtml(sn.id)}</td>
            <td>${F.escapeHtml(sn.label)}</td>
            <td>${F.escapeHtml(sn.floor)}</td>
            <td><span class="tstat tstat--${sm.tone}">${icon(sm.icon, 12)}${word}</span></td>
            <td class="num">${sn.state === STATE.ALERT ? F.clockTime(sn.since) : F.since(sn.lastUpdate)}</td></tr>`;
        })
        .join('')
    );
  }

  // ------------------------------------------------------ C. electricity
  function renderElectricity(s) {
    const e = s.electricity;
    if (!e) {
      setHtml($('twElecStats'), '<div class="tbig-sub">No electrical point mapped to this tower.</div>');
      return;
    }
    const dir = e.deltaVsTypical > 0.03 ? 'i-up' : e.deltaVsTypical < -0.03 ? 'i-down' : 'i-minus';

    setHtml(
      $('twElecStats'),
      [
        [`${F.kw(e.towerKw)}`, `Tower share of demand ${prov('sim')}`, `${e.sharePct}% of the shared block point`],
        [`${F.kw(e.blockKw)}`, `Block demand (C-6 + C-7) ${prov('sim')}`, `shared point ${e.sharedPointId}`],
        [`${F.kwh(e.towerEnergyKwh)}`, `Tower share of energy ${prov('sim')}`, 'accumulated this session'],
        [`${F.kw(e.liftKw ?? 0)}`, `Lift supply ${prov('sim')}`, `point ${e.liftPointId || '—'}`],
      ]
        .map(
          ([v, l, sub]) =>
            `<div class="tstat-card"><div class="tstat-v">${v}</div>
             <div class="tstat-l">${l}</div><div class="tstat-s">${sub}</div></div>`
        )
        .join('')
    );

    setHtml(
      $('twElecMeta'),
      `<div class="tkv"><span>vs typical for this hour</span><span>${icon(dir, 12)} ${F.signedPct(e.deltaVsTypical, 1)}</span></div>
       <div class="tkv"><span>Block rated demand</span><span>${F.kw(e.blockRatedKw)}</span></div>
       <div class="tkv"><span>Block session peak</span><span>${F.kw(e.blockPeakKw)}</span></div>
       <div class="tkv"><span>Block session energy</span><span>${F.kwh(e.blockEnergyKwh)}</span></div>
       <div class="tkv"><span>Fed from</span><span>${F.escapeHtml(e.substation)}</span></div>
       <div class="tkv"><span>Last reading</span><span>${F.since(e.lastTs)}</span></div>`
    );

    if (elecChart && e.history && e.history.length > 1) elecChart.update(e.history, []);
  }

  // ------------------------------------------------------------- D. lifts
  function renderLifts(s) {
    const avail = s.lifts.filter((l) => l.state === LIFT_STATE.RUNNING || l.state === LIFT_STATE.IDLE).length;
    setHtml(
      $('twLiftSummary'),
      `<div class="tbig tbig--${avail === s.lifts.length ? 'ok' : avail === 0 ? 'crit' : 'warn'}">${avail} / ${s.lifts.length} available</div>
       <div class="tbig-sub">Lift count is from the asset register ${prov('reg')}; live position and state are ${prov('demo')}</div>`
    );

    setHtml(
      $('twLifts'),
      s.lifts.length
        ? s.lifts
            .map((l) => {
              const lm = LIFT_META[l.state];
              return `<div class="lift lift--${lm.tone}">
                <div class="lift-top"><span class="lift-name">${F.escapeHtml(l.name)}</span>${badge(lm)}</div>
                <div class="lift-floor">${l.state === LIFT_STATE.OUT_OF_SERVICE ? '&mdash;' : l.floor}
                  <span class="lift-floor-l">floor</span>
                  <span class="lift-dir">${icon(DIR_ICON[l.direction] || 'i-minus', 13)}${l.direction}</span></div>
                <div class="lift-meta"><span class="tag">${F.escapeHtml(l.id)}</span>
                  <span>${l.trips} trips &middot; updated ${F.since(l.lastUpdate)}</span></div>
              </div>`;
            })
            .join('')
        : '<div class="tempty">No lifts recorded for this tower in the register.</div>'
    );
  }

  // ------------------------------------------------------------- events
  function renderEvents(s) {
    const open = s.events.filter((e) => !e.clearedAt);
    setHtml($('twEventCount'), open.length ? `${open.length} active` : 'none active');
    setHtml(
      $('twEvents'),
      s.events.length
        ? s.events
            .slice(0, 12)
            .map(
              (e) => `<div class="tevent tevent--${e.severity}${e.clearedAt ? ' tevent--cleared' : ''}">
          <span class="tevent-sev">${e.severity === 'critical' ? 'CRITICAL' : e.severity === 'warning' ? 'WARNING' : 'INFO'}</span>
          <div class="tevent-main"><b>${F.escapeHtml(e.title)}</b> &mdash; ${F.escapeHtml(e.detail)}
            <div class="tevent-sub">${F.escapeHtml(e.towerName)} &middot; raised ${F.clockTime(e.raisedAt)}
            ${e.clearedAt ? `&middot; cleared ${F.clockTime(e.clearedAt)}` : '&middot; ongoing'}</div></div>
        </div>`
            )
            .join('')
        : `<div class="tempty">${icon('i-check', 15)}No events recorded for this tower.</div>`
    );
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

    renderLeak(s);
    renderFire(s);
    renderElectricity(s);
    renderLifts(s);
    renderEvents(s);
  }

  return { mount, render, setTower, get currentTower() { return currentTower; } };
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
      return `<button type="button" class="tcard tcard--${sev}${t.id === activeId ? ' is-active' : ''}" data-tower="${t.id}">
        <div class="tcard-top">
          <div><div class="tcard-name">${F.escapeHtml(t.name)}</div>
            <div class="tcard-reg">${F.escapeHtml(t.registerName)}</div></div>
          <span class="tstat tstat--${sev === 'critical' ? 'crit' : sev === 'warning' ? 'warn' : 'ok'}">${icon(ic, 12)}${word}</span>
        </div>
        <div class="tcard-grid">
          <div><span class="tcard-k">Fire</span><span class="tcard-v tcard-v--${s.fire === 'alert' ? 'crit' : s.fire === 'normal' ? 'ok' : 'warn'}">${
            s.fire === 'alert' ? 'DETECTED' : s.fire === 'normal' ? 'Normal' : s.fire === 'offline' ? 'Offline' : 'Fault'}</span></div>
          <div><span class="tcard-k">Water leak</span><span class="tcard-v tcard-v--${s.leak === 'alert' ? 'crit' : s.leak === 'normal' ? 'ok' : 'warn'}">${
            s.leak === 'alert' ? 'LEAK' : s.leak === 'normal' ? 'Normal' : s.leak === 'offline' ? 'Offline' : 'Fault'}</span></div>
          <div><span class="tcard-k">Lifts</span><span class="tcard-v">${s.liftsAvailable} / ${s.liftsTotal}</span></div>
          <div><span class="tcard-k">Demand</span><span class="tcard-v">${F.kw(s.kw ?? 0)}</span></div>
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
