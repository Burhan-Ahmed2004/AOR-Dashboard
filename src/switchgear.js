/**
 * SWITCHGEAR STATE MODEL
 * ======================
 * The register states the switchgear POPULATION but not its state:
 *   - "VCBs HT 11 KV — 8 Nos — (TS Rawat, PNS Hafeez, ARC & OM)"   <- REG
 *   - "No of Feeder — 3 Nos"                                        <- REG
 *   - "No of DBs — 475 Nos"                                         <- REG
 *   - 109 transformers with an exact size mix                       <- REG
 *
 * It records no open/closed position, no trip history and no device tags, so
 * positions here are SIMULATED. The four VCB LOCATIONS are from the document;
 * splitting them into incomer/bus-section pairs is an assumption, because the
 * register names the sites without saying what each breaker does.
 *
 * Replace `DEVICES` with your real switchgear schedule when available.
 */

export const POSITION = {
  CLOSED: 'closed',
  OPEN: 'open',
  STANDBY: 'standby',
  TRIPPED: 'tripped',
};

export const POSITION_META = {
  closed: { label: 'Closed', tone: 'good', icon: 'i-check' },
  open: { label: 'Open', tone: 'muted', icon: 'i-minus' },
  standby: { label: 'Standby', tone: 'info', icon: 'i-clock' },
  tripped: { label: 'Tripped', tone: 'critical', icon: 'i-critical' },
};

/** The four VCB sites are from the register; the roles are assumed. */
const VCB_SITES = [
  ['PNS Hafeez', 'SS-HFZ'],
  ['ARC', 'SS-ARC'],
  ['TS Rawat', 'SS-SAT'],
  ['OM', 'SS-SAT'],
];

function buildDevices() {
  const out = [];
  let n = 0;
  for (const [site, subId] of VCB_SITES) {
    for (const role of ['Incomer', 'Bus section']) {
      n += 1;
      out.push({
        id: `VCB-${String(n).padStart(2, '0')}`,
        kind: 'vcb',
        name: `${site} — ${role}`,
        site,
        substationId: subId,
        ratingKv: 11,
        position: role === 'Bus section' && site === 'OM' ? POSITION.STANDBY : POSITION.CLOSED,
        lastChange: 0,
        operations: 0,
      });
    }
  }
  return out;
}

export function createSwitchgearModel(register, options = {}) {
  const cfg = { operateChance: 0.0016, ...options };
  const devices = buildDevices();

  // Feeders — the register states 3; one per substation.
  const feeders = register.SUBSTATIONS.filter((s) => !s.standalone).map((s, i) => ({
    id: s.feeder || `FDR-0${i + 1}`,
    name: `${s.name} feeder`,
    substationId: s.id,
    position: POSITION.CLOSED,
    capacityKw: s.capacityKw,
  }));

  function update(now, loadBySubstation, engineSeverityOf) {
    for (const d of devices) {
      // A substation in a critical condition may show a protective trip.
      const sev = engineSeverityOf ? engineSeverityOf(d.substationId) : 'normal';
      if (d.position === POSITION.TRIPPED && now - d.lastChange > 45000) {
        d.position = POSITION.CLOSED;
        d.lastChange = now;
        d.operations += 1;
      } else if (
        d.position === POSITION.CLOSED &&
        sev === 'critical' &&
        Math.random() < cfg.operateChance * 6
      ) {
        d.position = POSITION.TRIPPED;
        d.lastChange = now;
        d.operations += 1;
      }
    }
    for (const f of feeders) {
      const load = loadBySubstation?.get(f.substationId) || 0;
      f.loadKw = load;
      f.loadingPct = f.capacityKw ? (load / f.capacityKw) * 100 : 0;
    }
  }

  function counts() {
    const c = { closed: 0, open: 0, standby: 0, tripped: 0 };
    for (const d of devices) c[d.position] += 1;
    return c;
  }

  /**
   * Distribution boards. The register gives a TOTAL of 475 with no tags or
   * locations, so they are only ever summarised — never invented as a list of
   * named boards, which would imply detail the document does not contain.
   */
  function dbSummary() {
    const total = register.SITE.dbCount;
    const subs = register.SUBSTATIONS.filter((s) => !s.standalone);
    const totalKva = subs.reduce((a, s) => a + s.installedKva, 0) || 1;
    let assigned = 0;
    const rows = subs.map((s, i) => {
      const share = i === subs.length - 1 ? total - assigned : Math.round((s.installedKva / totalKva) * total);
      assigned += share;
      return { substation: s.name, count: share, note: 'apportioned by installed kVA (assumed)' };
    });
    return { total, rows };
  }

  return {
    update,
    counts,
    dbSummary,
    get devices() { return devices; },
    get feeders() { return feeders; },
  };
}
