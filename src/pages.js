/**
 * DETAIL PAGES
 * ============
 * Power Flow · Voltage & Frequency · Energy Analytics · Solar · Switchgear ·
 * Forecasting.
 *
 * Each page is built the same way as the overview: the STRUCTURE comes from the
 * asset register (badged REG) and the READINGS are simulated (badged SIM),
 * because the register contains no metering. Swapping in real telemetry means
 * changing `src/source.js` only — none of these pages talk to the feed directly,
 * they read the store, the electrical model and the alarm engine.
 */

import * as F from './format.js';
import { SEVERITY, QUALITY } from './limits.js';
import { renderBars, createTrendChart } from './charts.js';
import { renderDonut, renderGauge, createMultiLineChart } from './charts-power.js';
import { renderPowerFlow, renderStatusGrid, createBandChart, renderDurationCurve } from './charts-pages.js';
import { VOLTAGE_LIMITS, FREQUENCY_LIMITS, NOMINAL } from './electrical.js';
import { POSITION_META } from './switchgear.js';
import { expectedFactor } from './simulator.js';

const $ = (id) => document.getElementById(id);
const icon = (id, size = 14) => `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#${id}"/></svg>`;
const mw = (v, d = 2) =>
  Number.isFinite(v) ? (v / 1000).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';

function setHtml(node, html) {
  if (!node) return;
  if (node.__h === html) return;
  node.__h = html;
  node.innerHTML = html;
}

/** Small stat strip used at the top of most pages. */
function statStrip(items) {
  return items
    .map(
      (s) =>
        `<div class="pstat"><div class="pstat-v">${s.value}</div>` +
        `<div class="pstat-l">${s.label}${s.prov ? `<span class="prov prov--${s.prov}">${s.prov}</span>` : ''}</div>` +
        (s.sub ? `<div class="pstat-s">${s.sub}</div>` : '') +
        `</div>`
    )
    .join('');
}

export function createPages(ctx) {
  const { store, engine, electrical, switchgear, register, groups, substations, points } = ctx;
  const subById = Object.fromEntries(substations.map((s) => [s.id, s]));

  let voltCharts = [];
  let freqChart = null;
  let solarChart = null;
  let forecastChart = null;
  let mounted = false;

  function mount() {
    if (mounted) return;
    mounted = true;
    freqChart = createMultiLineChart($('vfFreqChart'), { height: 168, unit: 'Hz', decimals: 2 });
    for (const s of substations.filter((x) => !x.standalone)) {
      const host = $(`vfChart-${s.id}`);
      if (host) voltCharts.push({ id: s.id, chart: createMultiLineChart(host, { height: 150, unit: 'kV', decimals: 2 }) });
    }
    solarChart = createTrendChart($('solarChart'), { height: 190, label: 'Solar output', showExpected: true });
    forecastChart = createBandChart($('forecastChart'), { height: 250, label: 'Demand' });
  }

  function substationSeverity(subId) {
    let worst = SEVERITY.NORMAL;
    for (const p of points) {
      if (p.substationId !== subId) continue;
      const s = engine.severityOf(p.id);
      if (s === SEVERITY.CRITICAL) return SEVERITY.CRITICAL;
      if (s === SEVERITY.WARNING) worst = SEVERITY.WARNING;
    }
    return worst;
  }

  // =========================================================== POWER FLOW ===
  function renderFlow() {
    const site = store.site;
    const e = electrical.site;

    const sources = [
      { label: '11 kV Grid', value: Math.max(0, site.loadKw - site.generationKw) },
      { label: 'Solar', value: site.generationKw },
    ];

    // Lay the load groups out first so each substation can link to its own.
    const activeGroups = groups
      .filter((g) => !g.generation)
      .map((g) => ({ ...g, value: Math.abs(store.groupRollup(g.id).loadKw) }))
      .sort((a, b) => b.value - a.value);
    const top = 78;
    const gap = 30;
    activeGroups.forEach((g, i) => { g.y = top + i * gap; });

    const subs = substations
      .filter((s) => !s.standalone)
      .map((s) => {
        const r = store.substationRollup(s.id);
        return {
          id: s.id,
          label: s.name,
          value: Math.max(0, r.loadKw),
          loadingPct: s.capacityKw ? (r.loadKw / s.capacityKw) * 100 : 0,
          severity: substationSeverity(s.id),
          groups: activeGroups.filter((g) => points.some((p) => p.groupId === g.id && p.substationId === s.id)),
        };
      });

    renderPowerFlow($('flowDiagram'), {
      sources,
      substations: subs,
      groups: activeGroups.map((g) => ({ label: g.name, value: g.value, y: g.y })),
      lossKw: (e.kw * (100 - e.efficiencyPct)) / 100,
    });

    setHtml(
      $('flowStats'),
      statStrip([
        { value: `${mw(e.kw)} MW`, label: 'Total demand', prov: 'sim' },
        { value: `${mw(site.generationKw, 3)} MW`, label: 'Solar contribution', prov: 'sim' },
        { value: F.kw((e.kw * (100 - e.efficiencyPct)) / 100), label: 'Estimated losses', prov: 'sim' },
        { value: `${e.efficiencyPct.toFixed(1)}%`, label: 'Delivery efficiency', prov: 'sim' },
      ])
    );

    renderBars(
      $('flowFeeders'),
      switchgear.feeders.map((f) => ({
        label: `${f.name}`,
        value: f.loadingPct || 0,
        display: `${F.kw(f.loadKw || 0)} · ${F.pct(f.loadingPct || 0, 1)} of ${(f.capacityKw || 0).toLocaleString('en-US')} kW`,
        severity: (f.loadingPct || 0) > 90 ? 'critical' : (f.loadingPct || 0) > 80 ? 'warning' : 'none',
      })),
      { max: 100, unit: '%' }
    );
  }

  // ================================================== VOLTAGE & FREQUENCY ===
  function renderVoltage() {
    const e = electrical.site;
    const hist = electrical.history;

    const fOk = e.frequencyHz >= FREQUENCY_LIMITS.lowerHz && e.frequencyHz <= FREQUENCY_LIMITS.upperHz;
    const vOk = e.avgKv >= VOLTAGE_LIMITS.lowerKv && e.avgKv <= VOLTAGE_LIMITS.upperKv;

    // Worst phase imbalance across the busses: max deviation from the mean,
    // as a percentage of the mean. This is the figure that actually damages
    // motors, so it gets its own headline.
    let worstImb = 0;
    for (const b of electrical.busses) {
      const avg = b.phaseKv.reduce((a, v) => a + v, 0) / 3;
      const imb = (Math.max(...b.phaseKv.map((v) => Math.abs(v - avg))) / avg) * 100;
      worstImb = Math.max(worstImb, imb);
    }

    setHtml(
      $('vfStats'),
      statStrip([
        { value: `${e.frequencyHz.toFixed(2)} Hz`, label: 'System frequency', prov: 'sim', sub: fOk ? 'Within 49.5–50.5 Hz' : 'Outside statutory band' },
        { value: `${e.avgKv.toFixed(2)} kV`, label: 'Average L-L voltage', prov: 'sim', sub: vOk ? 'Within 10.5–11.5 kV' : 'Outside statutory band' },
        { value: `${worstImb.toFixed(2)}%`, label: 'Worst phase imbalance', prov: 'sim', sub: worstImb < 2 ? 'Below 2% guideline' : 'Above 2% guideline' },
        { value: `${(e.currentA || 0).toFixed(0)} A`, label: 'Line current', prov: 'sim', sub: '11 kV, 3-phase' },
      ])
    );

    if (hist.length > 1) {
      freqChart.update(
        [{ label: 'Frequency', values: hist.map((h) => h.f) }],
        hist.map((h) => h.t),
        [
          { value: FREQUENCY_LIMITS.upperHz, label: '50.5', kind: 'upper' },
          { value: FREQUENCY_LIMITS.lowerHz, label: '49.5', kind: 'lower' },
          { value: NOMINAL.frequencyHz, label: '50.0', kind: 'typical' },
        ]
      );
    }

    for (const { id, chart } of voltCharts) {
      const bus = electrical.busses.find((b) => b.id === id);
      if (!bus || hist.length < 2) continue;
      // Per-bus history is not retained separately; the profile shape is shared,
      // offset per bus by its current phase reading.
      chart.update(
        electrical.phaseNames.map((name, i) => ({
          label: name,
          values: hist.map((h) => h.kv[i] * (bus.phaseKv[i] / (h.kv[i] || bus.phaseKv[i]))),
        })),
        hist.map((h) => h.t),
        [
          { value: VOLTAGE_LIMITS.upperKv, label: '11.5', kind: 'upper' },
          { value: VOLTAGE_LIMITS.lowerKv, label: '10.5', kind: 'lower' },
        ]
      );
    }

    setHtml(
      $('vfTable'),
      `<table class="dt"><caption>Per-substation electrical measurements. All values simulated.</caption>
        <thead><tr><th scope="col">Substation</th><th class="num" scope="col">R-Y</th><th class="num" scope="col">Y-B</th>
        <th class="num" scope="col">B-R</th><th class="num" scope="col">Imbalance</th><th class="num" scope="col">Current</th>
        <th class="num" scope="col">PF</th><th class="num" scope="col">kVAr</th><th scope="col">Status</th></tr></thead><tbody>` +
        electrical.busses
          .map((b) => {
            const avg = b.phaseKv.reduce((a, v) => a + v, 0) / 3;
            const imb = (Math.max(...b.phaseKv.map((v) => Math.abs(v - avg))) / avg) * 100;
            const ok = avg >= VOLTAGE_LIMITS.lowerKv && avg <= VOLTAGE_LIMITS.upperKv && imb < 2;
            return `<tr><td><b>${F.escapeHtml(b.name)}</b></td>` +
              b.phaseKv.map((v) => `<td class="num">${v.toFixed(3)} kV</td>`).join('') +
              `<td class="num">${imb.toFixed(2)}%</td><td class="num">${b.currentA.toFixed(0)} A</td>` +
              `<td class="num">${b.powerFactor.toFixed(3)}</td><td class="num">${F.kw(b.kvar).replace(' kW', '')} kVAr</td>` +
              `<td><span class="badge badge--${ok ? 'normal' : 'warning'}">${icon(ok ? 'i-check' : 'i-warn')}${ok ? 'Normal' : 'Check'}</span></td></tr>`;
          })
          .join('') +
        `</tbody></table>`
    );
  }

  // ====================================================== ENERGY ANALYTICS ===
  function renderEnergy() {
    const site = store.site;
    const e = electrical.site;
    const elapsedMs = Date.now() - site.startedAt;
    const elapsedH = Math.max(0.0001, elapsedMs / 3_600_000);
    const avgKw = e.energyTodayKwh / elapsedH;
    const loadFactor = e.maxDemandKw > 0 ? (avgKw / e.maxDemandKw) * 100 : 0;

    setHtml(
      $('eaStats'),
      statStrip([
        { value: F.kwh(e.energyTodayKwh), label: 'Energy consumed', prov: 'sim', sub: `over ${F.duration(elapsedMs)}` },
        { value: F.kw(avgKw), label: 'Average demand', prov: 'sim' },
        { value: F.kw(e.maxDemandKw), label: 'Peak demand', prov: 'sim', sub: F.clockTime(e.maxDemandAt) },
        { value: `${loadFactor.toFixed(1)}%`, label: 'Load factor', prov: 'sim', sub: 'average ÷ peak' },
      ])
    );

    // Energy split: what was imported vs self-generated.
    renderDonut($('eaMix'), [
      { label: 'Grid import', value: Math.max(0, e.energyTodayKwh - e.solarTodayKwh) },
      { label: 'Solar generated', value: e.solarTodayKwh },
      { label: 'Distribution losses', value: e.lossesTodayKwh },
    ], { centreValue: F.kwh(e.energyTodayKwh).replace(/ .*/, ''), centreLabel: e.energyTodayKwh >= 1000 ? 'MWh' : 'kWh' });

    renderBars(
      $('eaByGroup'),
      groups
        .map((g) => {
          const sign = (p) => (g.generation ? 1 : p.role === 'generation' ? -1 : 1);
          const kwh = points
            .filter((p) => p.groupId === g.id)
            .reduce((a, p) => a + (store.rawState(p.id)?.energyKwh || 0) * sign(p), 0);
          return { label: g.generation ? `${g.name} (produced)` : g.name, value: kwh, display: F.kwh(kwh) };
        })
        .sort((a, b) => Math.abs(b.value) - Math.abs(a.value)),
      { unit: 'kWh' }
    );

    renderDurationCurve($('eaDuration'), site.history.map((h) => h.v), {
      height: 190,
      refs: [
        { value: e.maxDemandKw, kind: 'alarm' },
        { value: avgKw, kind: 'typical' },
      ],
    });

    setHtml(
      $('eaTop'),
      `<table class="dt"><caption>Highest-consuming locations this session.</caption>
        <thead><tr><th scope="col">Tag</th><th scope="col">Location</th><th class="num" scope="col">Energy</th>
        <th class="num" scope="col">Share</th><th class="num" scope="col">Now</th></tr></thead><tbody>` +
        points
          .filter((p) => p.monitored && p.role !== 'generation')
          .map((p) => ({ p, kwh: store.rawState(p.id)?.energyKwh || 0 }))
          .sort((a, b) => b.kwh - a.kwh)
          .slice(0, 10)
          .map(
            ({ p, kwh }) =>
              `<tr><td class="tag">${F.escapeHtml(p.id)}</td><td>${F.escapeHtml(p.name)}</td>` +
              `<td class="num">${F.kwh(kwh)}</td>` +
              `<td class="num">${F.pct(e.energyTodayKwh ? (kwh / e.energyTodayKwh) * 100 : 0, 1)}</td>` +
              `<td class="num">${F.kw(store.pointView(p, engine).value)}</td></tr>`
          )
          .join('') +
        `</tbody></table>`
    );
  }

  // ================================================================ SOLAR ===
  function renderSolar() {
    const solarPoints = points.filter((p) => p.role === 'generation');
    const e = electrical.site;
    const site = store.site;
    const views = solarPoints.map((p) => store.pointView(p, engine));
    const installedKw = solarPoints.reduce((a, p) => a + p.ratedKw, 0);
    const output = site.generationKw;
    const expected = views.reduce((a, v) => a + v.expected, 0);
    const pr = expected > 0.5 ? (output / expected) * 100 : null;

    setHtml(
      $('solStats'),
      statStrip([
        { value: F.kw(output), label: 'Current output', prov: 'sim', sub: `${solarPoints.length} arrays` },
        { value: `${installedKw.toFixed(0)} kWp`, label: 'Installed capacity', prov: 'sim', sub: 'register states 13 systems, no rating' },
        { value: pr == null ? '—' : `${pr.toFixed(0)}%`, label: 'Performance ratio', prov: 'sim', sub: pr == null ? 'outside daylight' : 'output ÷ expected' },
        { value: F.kwh(e.solarTodayKwh), label: 'Generated this session', prov: 'sim', sub: `${(e.co2AvoidedKg / 1000).toFixed(3)} t CO₂ avoided` },
      ])
    );

    renderGauge($('solGauge'), {
      value: Number(output.toFixed(1)),
      max: Math.max(1, installedKw),
      unit: 'kW OUTPUT',
      caption: `of ${installedKw.toFixed(0)} kWp installed`,
      target: expected,
      targetLabel: F.kw(expected),
    });

    const hist = solarPoints.length ? store.rawState(solarPoints[0].id)?.history || [] : [];
    if (hist.length > 1) {
      // Scale one array's shape up to the fleet so the trend reads in site terms.
      const factor = solarPoints.length;
      solarChart.update(hist.map((h) => ({ t: h.t, v: h.v * factor, e: h.e * factor })), []);
    }

    setHtml(
      $('solArrays'),
      `<table class="dt"><caption>Per-array output against expected for the current sun angle.</caption>
        <thead><tr><th scope="col">Tag</th><th scope="col">Array</th><th class="num" scope="col">Output</th>
        <th class="num" scope="col">Expected</th><th class="num" scope="col">Ratio</th>
        <th class="num" scope="col">Session</th><th scope="col">Status</th></tr></thead><tbody>` +
        views
          .map((v) => {
            const ratio = v.expected > 0.2 ? (v.value / v.expected) * 100 : null;
            const q = v.quality;
            const bad = q === QUALITY.OFFLINE || q === QUALITY.BAD;
            const sev = v.severity;
            const badge = bad
              ? `<span class="badge badge--offline">${icon('i-offline')}Offline</span>`
              : sev === SEVERITY.CRITICAL
              ? `<span class="badge badge--critical">${icon('i-critical')}Under-output</span>`
              : sev === SEVERITY.WARNING
              ? `<span class="badge badge--warning">${icon('i-warn')}Low</span>`
              : `<span class="badge badge--normal">${icon('i-check')}Normal</span>`;
            return `<tr><td class="tag">${F.escapeHtml(v.id)}</td><td>${F.escapeHtml(v.name)}</td>` +
              `<td class="num">${bad ? '—' : F.kw(v.value)}</td><td class="num">${F.kw(v.expected)}</td>` +
              `<td class="num">${ratio == null ? '—' : F.pct(ratio, 0)}</td>` +
              `<td class="num">${F.kwh(v.energyKwh)}</td><td>${badge}</td></tr>`;
          })
          .join('') +
        `</tbody></table>`
    );
  }

  // =========================================================== SWITCHGEAR ===
  function renderSwitchgear() {
    const c = switchgear.counts();
    setHtml(
      $('sgStats'),
      statStrip([
        { value: String(register.SITE.vcbCount), label: 'VCBs at 11 kV', prov: 'reg', sub: 'TS Rawat · PNS Hafeez · ARC · OM' },
        { value: String(c.closed), label: 'Closed', prov: 'sim', sub: `${c.standby} standby · ${c.tripped} tripped` },
        { value: String(register.SITE.feederCount), label: 'Feeders', prov: 'reg' },
        { value: register.SITE.dbCount.toLocaleString('en-US'), label: 'Distribution boards', prov: 'reg', sub: 'total only — no tags in register' },
      ])
    );

    renderStatusGrid(
      $('sgBreakers'),
      switchgear.devices.map((d) => {
        const m = POSITION_META[d.position];
        return {
          id: d.id,
          name: d.name,
          state: m.label,
          tone: m.tone,
          icon: icon(m.icon, 11),
          meta: `${d.ratingKv} kV · ${d.operations} operation${d.operations === 1 ? '' : 's'} this session`,
        };
      })
    );

    renderBars(
      $('sgFeeders'),
      switchgear.feeders.map((f) => ({
        label: f.name,
        value: f.loadingPct || 0,
        display: `${F.kw(f.loadKw || 0)} · ${F.pct(f.loadingPct || 0, 1)}`,
        severity: (f.loadingPct || 0) > 90 ? 'critical' : (f.loadingPct || 0) > 80 ? 'warning' : 'none',
      })),
      { max: 100, unit: '%' }
    );

    const db = switchgear.dbSummary();
    setHtml(
      $('sgDbs'),
      `<table class="dt"><caption>The register gives a total of ${db.total} boards with no tags or locations, so they are summarised rather than listed.</caption>
        <thead><tr><th scope="col">Substation</th><th class="num" scope="col">Boards</th><th scope="col">Basis</th></tr></thead><tbody>` +
        db.rows
          .map(
            (r) =>
              `<tr><td>${F.escapeHtml(r.substation)}</td><td class="num">${r.count}</td>` +
              `<td class="note">${F.escapeHtml(r.note)}</td></tr>`
          )
          .join('') +
        `<tr><td><b>Total</b></td><td class="num"><b>${db.total}</b></td><td class="note">stated in register</td></tr>` +
        `</tbody></table>`
    );
  }

  // ========================================================== FORECASTING ===
  function renderForecast() {
    const site = store.site;
    const e = electrical.site;
    const now = new Date();
    const hourNow = now.getHours() + now.getMinutes() / 60;

    // Profile-based forecast. Each group's rated demand is shaped by its own
    // diurnal curve, summed across the site. This is honest about its method:
    // it is a MODEL of typical behaviour, not a trained prediction, because no
    // historical consumption exists to train on.
    const ratedByProfile = {};
    for (const g of groups) {
      if (g.generation) continue;
      const rated = points
        .filter((p) => p.groupId === g.id && p.monitored && p.role !== 'generation')
        .reduce((a, p) => a + p.ratedKw, 0);
      ratedByProfile[g.profile] = (ratedByProfile[g.profile] || 0) + rated;
    }

    const pts = [];
    let peak = { v: -Infinity, h: 0 };
    for (let k = 0; k <= 24; k++) {
      const h = hourNow - 2 + k;
      let v = 0;
      for (const [profile, rated] of Object.entries(ratedByProfile)) v += rated * expectedFactor(profile, h);
      // Widen the band with horizon: near-term is better constrained.
      const horizon = Math.max(0, k - 2) / 22;
      const spread = 0.06 + horizon * 0.14;
      const label = `${String(Math.floor(((h % 24) + 24) % 24)).padStart(2, '0')}:00`;
      pts.push({ label, v, lo: v * (1 - spread), hi: v * (1 + spread) });
      if (k >= 2 && v > peak.v) peak = { v, h: Math.round(((h % 24) + 24) % 24) % 24 };
    }
    // Anchor the near past to what actually happened.
    const nowIdx = 2;
    if (site.history.length) pts[nowIdx].v = site.netKw;

    const capacity = substations.filter((s) => !s.standalone).reduce((a, s) => a + (s.capacityKw || 0), 0);
    forecastChart.update(
      pts,
      // Only the reference that sits near the data — firm capacity is 2.4x peak
      // demand and would flatten the curve. Headroom is in the stat strip.
      [{ value: register.SITE_RATED_KW, label: 'rated demand', kind: 'rated' }],
      nowIdx
    );

    const headroom = capacity > 0 ? ((capacity - peak.v) / capacity) * 100 : 0;
    setHtml(
      $('fcStats'),
      statStrip([
        { value: F.kw(peak.v), label: 'Forecast peak (24 h)', prov: 'sim', sub: `around ${String(peak.h).padStart(2, '0')}:00` },
        { value: F.kw(site.netKw), label: 'Demand now', prov: 'sim' },
        { value: `${headroom.toFixed(0)}%`, label: 'Headroom at peak', prov: 'sim', sub: `against ${capacity.toLocaleString('en-US')} kW firm capacity` },
        { value: F.kwh(pts.slice(2).reduce((a, p) => a + p.v, 0)), label: 'Forecast energy (24 h)', prov: 'sim' },
      ])
    );

    setHtml(
      $('fcTable'),
      `<table class="dt"><caption>Six-hourly forecast points with their confidence range.</caption>
        <thead><tr><th scope="col">Hour</th><th class="num" scope="col">Forecast</th>
        <th class="num" scope="col">Range</th><th class="num" scope="col">% of capacity</th></tr></thead><tbody>` +
        pts
          .filter((_, i) => i >= 2 && (i - 2) % 4 === 0)
          .map(
            (p) =>
              `<tr><td>${p.label}</td><td class="num">${F.kw(p.v)}</td>` +
              `<td class="num">${F.kw(p.lo)} – ${F.kw(p.hi)}</td>` +
              `<td class="num">${F.pct(capacity ? (p.v / capacity) * 100 : 0, 1)}</td></tr>`
          )
          .join('') +
        `</tbody></table>`
    );
  }

  const RENDERERS = {
    flow: renderFlow,
    voltage: renderVoltage,
    energy: renderEnergy,
    solar: renderSolar,
    breakers: renderSwitchgear,
    forecast: renderForecast,
  };

  return {
    mount,
    /** Render only the page currently on screen — the rest are not in the DOM flow. */
    update(view) {
      const fn = RENDERERS[view];
      if (fn) fn();
    },
    has(view) {
      return Boolean(RENDERERS[view]);
    },
  };
}
