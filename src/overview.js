/**
 * OVERVIEW SCREEN
 * ===============
 * The electrical situational-awareness screen: KPI strip, load trend, power
 * distribution, category breakdown, energy, single-line diagram and voltage
 * profile.
 *
 * PROVENANCE. The asset register contains no metering of any kind, so every
 * live electrical READING here is simulated (see electrical.js) and is badged
 * `SIM` in the markup. What comes from the register — substation count,
 * transformer fleet and capacity, asset counts, topology — is badged `REG`.
 * Keeping those two apart is the whole point of the badging.
 */

import * as F from './format.js';
import { SEVERITY } from './limits.js';
import { createTrendChart, renderBars } from './charts.js';
import { renderDonut, renderGauge, createMultiLineChart, renderSldFull } from './charts-power.js';
import { VOLTAGE_LIMITS, FREQUENCY_LIMITS, NOMINAL } from './electrical.js';

const $ = (id) => document.getElementById(id);

function icon(id, size = 14) {
  return `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#${id}"/></svg>`;
}

/** Megawatts, the unit an electrical overview is read in. */
function mw(kwValue, decimals = 2) {
  if (!Number.isFinite(kwValue)) return '—';
  return (kwValue / 1000).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

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

export function createOverview(ctx) {
  const { store, engine, electrical, register, groups, substations, points } = ctx;

  let loadChart = null;
  let voltChart = null;

  function mount() {
    loadChart = createTrendChart($('loadChart'), { height: 186, label: 'Net demand' });
    voltChart = createMultiLineChart($('voltProfile'), { height: 172, unit: 'kV', decimals: 2 });

    // Data gaps appear on both the overview rail and the settings page.
    const gapsHtml = register.DATA_GAPS.map(
      (g) =>
        `<li class="gap-item" data-sev="${g.severity}">${icon(
          g.severity === 'warning' ? 'i-warn' : 'i-info',
          13
        )}<span>${F.escapeHtml(g.text)}</span></li>`
    ).join('');
    setHtml($('gapList'), gapsHtml);
    setHtml($('gapList2'), gapsHtml);

    setHtml(
      $('footNote'),
      `Point register derived from <b>AOR - GE (N) Maint Isld.docx</b>: ` +
        `${register.SITE.buildingsTotal.toLocaleString('en-US')} buildings, ${register.SITE.dbCount} DBs, ` +
        `${register.TRANSFORMER_FLEET.unitCount} transformers (${register.TRANSFORMER_FLEET.installedKva.toLocaleString(
          'en-US'
        )} kVA installed), ${register.SITE.htLineKm} km HT / ${register.SITE.ltLineKm} km LT cable, ` +
        `${register.SITE.vcbCount} VCBs at 11 kV, 3 feeders, 3 substations. ` +
        `<br><br><b>The register contains no metered consumption, voltage, current, power factor, frequency or energy.</b> ` +
        `Every live reading on this dashboard is therefore simulated and badged SIM; ` +
        `unit kW ratings, limits and feeder allocation are engineering estimates. ` +
        `There is no evidence of diesel generators or a 132 kV intake in the register, so neither is modelled. ` +
        `Replace src/register.js and point src/source.js at your SCADA gateway to run on real telemetry.`
    );

    renderTransformerViews();
  }

  /** Transformers page — entirely register-derived, no simulation. */
  function renderTransformerViews() {
    const fleet = register.TRANSFORMER_FLEET;
    const rows = Object.entries(fleet.mix)
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .map(([kva, n]) => ({
        label: `${Number(kva).toLocaleString('en-US')} kVA`,
        value: Number(kva) * n,
        display: `${n} unit${n > 1 ? 's' : ''} · ${(Number(kva) * n).toLocaleString('en-US')} kVA`,
      }));
    rows.push({
      label: 'Satellite stations',
      value: 0,
      display: `${fleet.satelliteStations} units · rating not in register`,
    });
    renderBars($('txFleet'), rows, { unit: 'kVA' });

    renderBars(
      $('txBySub'),
      substations
        .filter((s) => !s.standalone)
        .map((s) => ({
          label: `${s.name} (${s.transformerCount} tx)`,
          value: s.installedKva,
          display: `${s.installedKva.toLocaleString('en-US')} kVA · ${s.capacityKw.toLocaleString('en-US')} kW`,
        })),
      { unit: 'kVA' }
    );
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

  function groupSeverity(groupId) {
    let worst = SEVERITY.NORMAL;
    for (const p of points) {
      if (p.groupId !== groupId) continue;
      const s = engine.severityOf(p.id);
      if (s === SEVERITY.CRITICAL) return SEVERITY.CRITICAL;
      if (s === SEVERITY.WARNING) worst = SEVERITY.WARNING;
    }
    return worst;
  }

  function update() {
    const site = store.site;
    const e = electrical.site;

    // ---------------------------------------------------------------- KPIs
    setHtml($('kpiP'), `${mw(e.kw)}<small>MW</small>`);
    setHtml(
      $('kpiPSub'),
      `<span class="ok">${icon('i-check', 11)}</span>${F.kw(e.kw)} &middot; ${(e.currentA || 0).toFixed(0)} A`
    );

    setHtml($('kpiQ'), `${mw(e.kvar)}<small>MVAR</small>`);
    setHtml($('kpiQSub'), `${mw(e.kva)} MVA apparent`);

    const pfLagging = e.powerFactor < 0.999;
    setHtml($('kpiPF'), e.powerFactor.toFixed(3));
    const pfOk = e.powerFactor >= 0.9;
    setHtml(
      $('kpiPFSub'),
      `<span class="${pfOk ? 'ok' : 'warn'}">${icon(pfOk ? 'i-check' : 'i-warn', 11)}</span>${
        pfLagging ? 'Lagging' : 'Unity'
      }${pfOk ? '' : ' — below 0.90'}`
    );

    const fOk = e.frequencyHz >= FREQUENCY_LIMITS.lowerHz && e.frequencyHz <= FREQUENCY_LIMITS.upperHz;
    setHtml($('kpiF'), `${e.frequencyHz.toFixed(2)}<small>Hz</small>`);
    setHtml(
      $('kpiFSub'),
      `<span class="${fOk ? 'ok' : 'warn'}">${icon(fOk ? 'i-check' : 'i-warn', 11)}</span>${
        fOk ? 'Normal' : 'Out of band'
      } &middot; ${NOMINAL.frequencyHz} Hz nominal`
    );

    const vOk = e.avgKv >= VOLTAGE_LIMITS.lowerKv && e.avgKv <= VOLTAGE_LIMITS.upperKv;
    setHtml($('kpiV'), `${e.avgKv.toFixed(2)}<small>kV</small>`);
    setHtml(
      $('kpiVSub'),
      `<span class="${vOk ? 'ok' : 'warn'}">${icon(vOk ? 'i-check' : 'i-warn', 11)}</span>${
        vOk ? 'Normal' : 'Out of band'
      } &middot; 11 kV nominal`
    );

    setHtml($('kpiE'), `${F.kwh(e.energyTodayKwh).replace(/ (kWh|MWh)$/, '')}<small>${e.energyTodayKwh >= 1000 ? 'MWh' : 'kWh'}</small>`);
    setHtml($('kpiESub'), `solar ${F.kwh(e.solarTodayKwh)} generated`);

    // ------------------------------------------------------------ load trend
    if (site.history.length) loadChart.update(site.history, []);
    setText($('loadSub'), `${site.history.length} samples · updated ${F.clockTime(site.lastTs)}`);

    // --------------------------------------------------- power distribution
    const segs = substations
      .filter((s) => !s.standalone)
      .map((s) => ({ label: s.name, value: Math.max(0, store.substationRollup(s.id).loadKw) }));
    segs.push({ label: `Solar (${register.POINTS.filter((p) => p.role === 'generation').length} systems)`, value: site.generationKw });
    renderDonut($('donutDist'), segs, { centreValue: mw(e.kw), centreLabel: 'MW TOTAL' });

    // ------------------------------------------------------ load by category
    renderBars(
      $('catBars'),
      groups
        .map((g) => {
          const r = store.groupRollup(g.id);
          return { label: g.name, value: Math.abs(r.loadKw), severity: groupSeverity(g.id) };
        })
        .sort((a, b) => b.value - a.value)
        .slice(0, 6)
    );

    // ------------------------------------------------------------ energy gauge
    // No daily target exists in the register, so the reference is derived:
    // what this site would consume over the elapsed period at its rated demand.
    const elapsedH = Math.max(0.0001, (Date.now() - site.startedAt) / 3_600_000);
    const budgetKwh = register.SITE_RATED_KW * elapsedH * 0.85;
    renderGauge($('gaugeEnergy'), {
      value: Number(F.kwh(e.energyTodayKwh).replace(/[^\d.]/g, '')) || 0,
      max: Math.max(1, e.energyTodayKwh >= 1000 ? budgetKwh / 1000 : budgetKwh),
      unit: e.energyTodayKwh >= 1000 ? 'MWh CONSUMED' : 'kWh CONSUMED',
      caption: `Expected ${F.kwh(budgetKwh)} for ${F.duration(Date.now() - site.startedAt)} elapsed`,
      target: e.energyTodayKwh >= 1000 ? budgetKwh / 1000 : budgetKwh,
      targetLabel: F.kwh(budgetKwh),
    });

    // ---------------------------------------------------------- energy summary
    setHtml(
      $('energySummary'),
      [
        ['i-chart', 'Consumed (session)', F.kwh(e.energyTodayKwh)],
        ['i-sun', 'Solar generated', F.kwh(e.solarTodayKwh)],
        ['i-plug', 'Net import', F.kwh(e.energyTodayKwh - e.solarTodayKwh)],
        ['i-warn', 'Distribution losses', F.kwh(e.lossesTodayKwh)],
      ]
        .map(
          ([ic, k, v]) =>
            `<div class="sumrow"><span class="k">${icon(ic, 13)}${k}</span><span class="v">${v}</span></div>`
        )
        .join('')
    );

    // ------------------------------------------------------------------- SLD
    renderSldFull($('sldFull'), {
      substations,
      busses: electrical.busses,
      solarKw: site.generationKw,
      solarCount: register.POINTS.filter((p) => p.role === 'generation').length,
      fleet: register.TRANSFORMER_FLEET,
      severityOf: substationSeverity,
    });

    // -------------------------------------------------------- voltage profile
    const hist = electrical.history;
    if (hist.length > 1) {
      voltChart.update(
        electrical.phaseNames.map((name, i) => ({ label: name, values: hist.map((h) => h.kv[i]) })),
        hist.map((h) => h.t),
        [
          { value: VOLTAGE_LIMITS.upperKv, label: `${VOLTAGE_LIMITS.upperKv} kV`, kind: 'upper' },
          { value: VOLTAGE_LIMITS.lowerKv, label: `${VOLTAGE_LIMITS.lowerKv} kV`, kind: 'lower' },
        ]
      );
    }

    // -------------------------------------------------------- bottom metrics
    const connectedKw = register.SUBSTATIONS.reduce((a, s) => a + (s.capacityKw || 0), 0);
    setHtml(
      $('bottomMetrics'),
      [
        ['i-leaf', 'CO&#8322; avoided', `${(e.co2AvoidedKg / 1000).toFixed(3)} t`, 'sim', '--cat-3'],
        ['i-warn', 'Distribution losses', F.kwh(e.lossesTodayKwh), 'sim', '--st-warning'],
        ['i-shield', 'System efficiency', `${e.efficiencyPct.toFixed(1)}%`, 'sim', '--cat-3'],
        ['i-plug', 'Connected capacity', `${mw(connectedKw, 1)} MW`, 'reg', '--cat-1'],
        ['i-peak', 'Max demand', `${mw(e.maxDemandKw)} MW`, 'sim', '--cat-2'],
        ['i-target', 'Peak current', `${(e.currentA || 0).toFixed(0)} A`, 'sim', '--cat-5'],
      ]
        .map(
          ([ic, label, value, prov, chip]) =>
            `<div class="metric"><span class="metric-ico" style="--chip:var(${chip})">${icon(ic, 16)}</span>` +
            `<div class="metric-body"><div class="metric-v" title="${value}">${value}</div>` +
            `<div class="metric-l" title="${label.replace(/&#8322;/g, "2")}">${label}` +
            `<span class="prov prov--${prov}">${prov}</span></div></div></div>`
        )
        .join('')
    );
  }

  return { mount, update };
}
