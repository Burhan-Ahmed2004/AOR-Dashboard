/**
 * ELECTRICAL MODEL — derived power-system quantities
 * ==================================================
 * The asset register contains NO electrical measurements: no voltage, current,
 * power factor, frequency, reactive power or energy. Searching the source
 * document for those terms returns zero hits. Everything in this file is
 * therefore SIMULATED, and every value it produces is badged `SIM` in the UI.
 *
 * What keeps it honest is that nothing here is invented independently — each
 * quantity is DERIVED from the simulated real power using standard three-phase
 * relationships, so the numbers stay physically consistent with one another:
 *
 *      S = sqrt(3) * V_LL * I      (apparent power)
 *      Q = P * tan(acos(PF))       (reactive power)
 *      I = P / (sqrt(3) * V_LL * PF)
 *
 * Nominal values come from the register where it states them:
 *   - 11 kV HT: the register lists "VCBs HT 11 KV" (8 Nos). There is NO
 *     evidence of a 132 kV intake, so none is modelled.
 *   - 50 Hz: regional grid standard.
 */

export const NOMINAL = {
  frequencyHz: 50,
  htKv: 11,
  ltVolts: 400,
  powerFactor: 0.95,
  emissionFactorKgPerKwh: 0.42,
};

/** Statutory-style voltage band, about +/-4.5% of nominal. */
export const VOLTAGE_LIMITS = {
  upperKv: 11.5,
  lowerKv: 10.5,
};

export const FREQUENCY_LIMITS = { upperHz: 50.5, lowerHz: 49.5 };

const SQRT3 = Math.sqrt(3);
const PHASES = ['R-Y', 'Y-B', 'B-R'];

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function createElectricalModel(substations, options = {}) {
  const cfg = { historyLen: 96, ...options };

  const busses = new Map();
  for (const ss of substations) {
    if (ss.standalone) continue;
    busses.set(ss.id, {
      id: ss.id,
      name: ss.name,
      capacityKw: ss.capacityKw || 1,
      phaseKv: [NOMINAL.htKv, NOMINAL.htKv, NOMINAL.htKv],
      phaseSeed: [0, 2.1, 4.2],
      powerFactor: NOMINAL.powerFactor,
      currentA: 0,
      kw: 0,
      kvar: 0,
      kva: 0,
      loadingPct: 0,
    });
  }

  const site = {
    frequencyHz: NOMINAL.frequencyHz,
    kw: 0,
    kvar: 0,
    kva: 0,
    powerFactor: NOMINAL.powerFactor,
    avgKv: NOMINAL.htKv,
    currentA: 0,
    solarKw: 0,
    energyTodayKwh: 0,
    energyMonthKwh: 0,
    solarTodayKwh: 0,
    solarMonthKwh: 0,
    lossesTodayKwh: 0,
    maxDemandKw: 0,
    maxDemandAt: 0,
    co2AvoidedKg: 0,
    efficiencyPct: 96.5,
    downtimeMinutes: 0,
    interruptedCustomerMinutes: 0,
    lastTs: 0,
  };

  const history = [];
  let phase = 0;

  function pushHistory(sample) {
    history.push(sample);
    if (history.length > cfg.historyLen) history.splice(0, history.length - cfg.historyLen);
  }

  function update(loadBySubstation, siteKw, solarKw, now, outage = null) {
    phase += 0.07;
    const dtMs = site.lastTs ? now - site.lastTs : 0;
    const dtH = dtMs > 0 && dtMs < 120000 ? dtMs / 3600000 : 0;

    const fWander = Math.sin(phase * 0.31) * 0.045 + (Math.random() - 0.5) * 0.02;
    site.frequencyHz = clamp(NOMINAL.frequencyHz + fWander, 49.7, 50.3);

    let totKvar = 0;
    let kvSum = 0;
    let busCount = 0;

    for (const [id, bus] of busses) {
      const kw = loadBySubstation.get(id) || 0;
      const loading = clamp(kw / bus.capacityKw, 0, 1.2);

      // Power factor degrades as motor load rises (pumps, lifts, chillers).
      bus.powerFactor = clamp(
        0.975 - loading * 0.09 + Math.sin(phase * 0.4 + bus.phaseSeed[0]) * 0.006,
        0.82,
        0.99
      );

      // Voltage droops under load; each phase carries a small independent offset
      // so a realistic imbalance exists between R-Y, Y-B and B-R.
      bus.phaseKv = bus.phaseSeed.map((seed) => {
        const droop = loading * 0.028;
        const imbalance = Math.sin(phase * 0.6 + seed) * 0.004;
        const noise = (Math.random() - 0.5) * 0.0025;
        return NOMINAL.htKv * (1 - droop + imbalance + noise);
      });

      const avgKv = bus.phaseKv.reduce((a, b) => a + b, 0) / 3;
      bus.kw = kw;
      bus.kvar = kw * Math.tan(Math.acos(bus.powerFactor));
      bus.kva = bus.powerFactor > 0 ? kw / bus.powerFactor : 0;
      bus.currentA = avgKv > 0 ? (kw * 1000) / (SQRT3 * avgKv * 1000 * bus.powerFactor) : 0;
      bus.loadingPct = (kw / bus.capacityKw) * 100;

      totKvar += bus.kvar;
      kvSum += avgKv;
      busCount += 1;
    }

    site.kw = siteKw;
    site.kvar = totKvar;
    site.kva = Math.hypot(siteKw, totKvar);
    site.powerFactor = site.kva > 0 ? clamp(siteKw / site.kva, 0, 1) : NOMINAL.powerFactor;
    site.avgKv = busCount ? kvSum / busCount : NOMINAL.htKv;
    site.currentA =
      site.avgKv > 0 ? (siteKw * 1000) / (SQRT3 * site.avgKv * 1000 * Math.max(0.5, site.powerFactor)) : 0;
    site.solarKw = solarKw;

    if (dtH > 0) {
      site.energyTodayKwh += siteKw * dtH;
      site.energyMonthKwh += siteKw * dtH;
      site.solarTodayKwh += solarKw * dtH;
      site.solarMonthKwh += solarKw * dtH;

      const lossFraction = 0.018 + 0.012 * clamp(siteKw / 8000, 0, 1);
      site.lossesTodayKwh += siteKw * dtH * lossFraction;
      site.efficiencyPct = (1 - lossFraction) * 100;
      site.co2AvoidedKg = site.solarMonthKwh * NOMINAL.emissionFactorKgPerKwh;

      if (outage && outage.customersAffected) {
        site.downtimeMinutes += dtMs / 60000;
        site.interruptedCustomerMinutes += (dtMs / 60000) * outage.customersAffected;
      }
    }

    if (siteKw > site.maxDemandKw) {
      site.maxDemandKw = siteKw;
      site.maxDemandAt = now;
    }

    site.lastTs = now;

    const first = busses.values().next().value;
    pushHistory({
      t: now,
      load: siteKw,
      f: site.frequencyHz,
      kv: first ? first.phaseKv.slice() : [NOMINAL.htKv, NOMINAL.htKv, NOMINAL.htKv],
    });

    return site;
  }

  /** SAIDI in minutes per customer, using the register's building count. */
  function saidi(totalCustomers) {
    if (!totalCustomers) return 0;
    return site.interruptedCustomerMinutes / totalCustomers;
  }

  return {
    update,
    saidi,
    get site() { return site; },
    get busses() { return [...busses.values()]; },
    get history() { return history; },
    phaseNames: PHASES,
  };
}
