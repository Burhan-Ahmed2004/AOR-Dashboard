/**
 * POINT REGISTER — AOR / GE(N) Maint Isld
 * =======================================
 * Derived from "AOR - GE (N) Maint Isld.docx" (maintenance load responsibility register).
 *
 * This file is the single source of truth for *what is monitored*. It is shared
 * verbatim by the browser dashboard and the mock SCADA server so both agree on the
 * tag list. Replace it with an export from your real SCADA point database when
 * telemetry is connected — nothing else in the app needs to change.
 *
 * PROVENANCE — every field is tagged so nothing invented is mistaken for measured:
 *   src: 'doc'     value is stated in the register document
 *   src: 'assumed' value is an engineering estimate (unit kW ratings, feeder
 *                  allocation, circuit splits). These MUST be replaced with real
 *                  nameplate / metering data before operational use.
 *
 * TAG ID SCHEME  <CLASS>-<AREA/INDEX>
 *   SS-*    substation incomer metering
 *   OFF-*   officer accommodation      ORQ-*  other ranks quarters
 *   ADM-*   command & admin            MED-*  medical & welfare
 *   TW-*    tube wells                 WFP-*  water filtration plants
 *   OHWT-*  overhead water tanks       UGWT-* underground water tanks
 *   MP-*    motor pump sets            RB-*   reedbeds
 *   SL-*    street/flood light circuits SOL-* solar systems (generation)
 *   VT-*    vertical transport         OS-*   outstations
 */

export const SITE = {
  name: 'AOR · GE(N) Maint Isld',
  areaAcres: 360, // doc
  buildingsTotal: 2157, // doc — "G Total"
  dbCount: 475, // doc — No of DBs
  feederCount: 3, // doc
  htLineKm: 38, // doc
  ltLineKm: 108, // doc
  vcbCount: 8, // doc — VCBs HT 11 KV @ TS Rawat, PNS Hafeez, ARC & OM
};

/**
 * Transformer fleet — doc states 109 total (NRC + NHQ) with this exact size mix.
 * The per-substation ALLOCATION below is `assumed`; the totals it sums to are `doc`.
 *   1250 kVA x 1  ·  630 kVA x 1  ·  200 kVA x 73  ·  100 kVA x 20  ·  50 kVA x 1
 *   = 96 units @ 18,530 kVA, + 13 satellite stations = 109 units.
 */
export const TRANSFORMER_FLEET = {
  src: 'doc',
  mix: { 1250: 1, 630: 1, 200: 73, 100: 20, 50: 1 },
  satelliteStations: 13,
  get unitCount() {
    return Object.values(this.mix).reduce((a, b) => a + b, 0) + this.satelliteStations;
  },
  get installedKva() {
    return Object.entries(this.mix).reduce((a, [kva, n]) => a + Number(kva) * n, 0);
  },
};

export const POWER_FACTOR = 0.9; // assumed — used to convert transformer kVA to kW

export const SUBSTATIONS = [
  {
    id: 'SS-HFZ',
    incomerTag: 'SS-HFZ-INC',
    name: 'PNS Hafeez',
    feeder: 'FDR-01',
    hasVcb: true, // doc
    transformers: { src: 'assumed', mix: { 1250: 1, 630: 1, 200: 55, 100: 9 } },
  },
  {
    id: 'SS-ARC',
    incomerTag: 'SS-ARC-INC',
    name: 'ARC',
    feeder: 'FDR-02',
    hasVcb: true, // doc
    transformers: { src: 'assumed', mix: { 200: 13, 100: 6 } },
  },
  {
    id: 'SS-NHQ',
    incomerTag: 'SS-NHQ-INC',
    name: 'NHQ',
    feeder: 'FDR-03',
    hasVcb: false,
    transformers: { src: 'assumed', mix: { 200: 5, 100: 5, 50: 1 } },
  },
  {
    id: 'SS-SAT',
    incomerTag: null,
    name: 'Satellite stations',
    feeder: null,
    hasVcb: false,
    standalone: true, // outstations, not on the 3 complex feeders
    transformers: { src: 'doc', satellite: 13 },
  },
];

for (const ss of SUBSTATIONS) {
  const mix = ss.transformers.mix || {};
  ss.transformerCount = Object.values(mix).reduce((a, b) => a + b, 0) + (ss.transformers.satellite || 0);
  ss.installedKva = Object.entries(mix).reduce((a, [kva, n]) => a + Number(kva) * n, 0);
  // The register gives kVA ratings for the 96 complex transformers only — the 13
  // satellite stations have no stated rating, so their capacity is unknown rather
  // than zero. Null keeps "unknown" out of any utilisation arithmetic.
  ss.capacityKw = ss.installedKva ? Math.round(ss.installedKva * POWER_FACTOR) : null;
}

/**
 * Load groups — deliberately the document's own taxonomy, not a new one.
 * `profile` drives the demand shape (see simulator.js).
 * `headroom` sets the default consumption limit as a multiple of rated demand.
 */
export const GROUPS = [
  { id: 'officer-accn', name: 'Officer Accommodation', zone: 'Residential Zone I', profile: 'residential', headroom: 1.3, icon: 'home' },
  { id: 'ranks-accn', name: 'Other Ranks Quarters', zone: 'Residential Zone II', profile: 'residential', headroom: 1.3, icon: 'building' },
  { id: 'command-admin', name: 'Command & Admin', zone: 'Institutional', profile: 'office', headroom: 1.25, icon: 'landmark' },
  { id: 'medical-welfare', name: 'Medical & Welfare', zone: 'Institutional', profile: 'continuous', headroom: 1.2, icon: 'health' },
  { id: 'water-utilities', name: 'Water & Utilities Plant', zone: 'Infrastructure', profile: 'pumping', headroom: 1.35, icon: 'water' },
  { id: 'street-lighting', name: 'Street & Area Lighting', zone: 'Infrastructure', profile: 'lighting', headroom: 1.15, icon: 'light' },
  { id: 'vertical-transport', name: 'Vertical Transport', zone: 'Infrastructure', profile: 'office', headroom: 1.4, icon: 'lift' },
  { id: 'outstations', name: 'Outstation Facilities', zone: 'Off-complex', profile: 'residential', headroom: 1.3, icon: 'pin' },
  // Generation, not load. Kept as its own group so it is never netted off inside
  // a load group's total (which would show street lighting as negative kW at noon).
  { id: 'solar-generation', name: 'Solar Generation', zone: 'Infrastructure', profile: 'solar', headroom: 1.25, icon: 'sun', generation: true },
];

// ---------------------------------------------------------------------------
// Point definitions. `n` = physical units the tag aggregates, `kw` = est. unit demand.
// ---------------------------------------------------------------------------

const DEFS = [
  // --- Officer Accommodation (doc: building schedule ser 1-8) ------------------
  ['OFF-BNG-A', "Bungalow 'A' type", 'Residential Zone I', 'officer-accn', 'SS-HFZ', 2, 9],
  ['OFF-BNG-B', "Bungalow 'B' type", 'Residential Zone I', 'officer-accn', 'SS-HFZ', 34, 7.5],
  ['OFF-BNG-C', "Bungalow 'C' type", 'Residential Zone I', 'officer-accn', 'SS-HFZ', 41, 6],
  ['OFF-BNG-D', "Bungalow 'D' type", 'Residential Zone I', 'officer-accn', 'SS-HFZ', 86, 5],
  ['OFF-BNG-F', "Bungalow 'F' type", 'Residential Zone I', 'officer-accn', 'SS-HFZ', 25, 4.5],
  ['OFF-FLT-C', "'C' type Flats", 'Residential Zone I', 'officer-accn', 'SS-HFZ', 30, 3.5],
  ['OFF-FLT-D', "'D' type Flats", 'Residential Zone I', 'officer-accn', 'SS-HFZ', 40, 3],
  ['OFF-FLT-E', "'E' type Flats", 'Residential Zone I', 'officer-accn', 'SS-HFZ', 8, 2.5],

  // --- Other Ranks Quarters (doc ser 9-20) ------------------------------------
  ['ORQ-PNCM', 'Accn at PNCM', 'Residential Zone II', 'ranks-accn', 'SS-HFZ', 1, 3],
  ['ORQ-MOQ', 'MOQ Flats', 'Residential Zone II', 'ranks-accn', 'SS-HFZ', 224, 2.2],
  ['ORQ-CPO', 'CPOs Qtrs', 'Residential Zone II', 'ranks-accn', 'SS-HFZ', 138, 2.4],
  ['ORQ-POC', 'POC Qtrs + Flats', 'Residential Zone II', 'ranks-accn', 'SS-HFZ', 192, 2.2],
  ['ORQ-MES', 'MES Flats', 'Residential Zone II', 'ranks-accn', 'SS-HFZ', 28, 2.2],
  ['ORQ-A', 'A Type Qtrs', 'Residential Zone II', 'ranks-accn', 'SS-HFZ', 228, 2.0],
  ['ORQ-B', 'B Type Qtrs', 'Residential Zone II', 'ranks-accn', 'SS-HFZ', 300, 1.8],
  ['ORQ-C', 'C Type Qtrs', 'Residential Zone II', 'ranks-accn', 'SS-HFZ', 156, 1.6],
  ['ORQ-D', 'D Type Qtrs', 'Residential Zone II', 'ranks-accn', 'SS-HFZ', 108, 1.5],
  ['ORQ-E', 'E Type Qtrs', 'Residential Zone II', 'ranks-accn', 'SS-HFZ', 84, 1.4],
  ['ORQ-POS', 'POS Qtrs', 'Residential Zone II', 'ranks-accn', 'SS-HFZ', 216, 1.6],
  ['ORQ-POB', 'POB Qtrs', 'Residential Zone II', 'ranks-accn', 'SS-HFZ', 56, 1.5],

  // --- Command & Admin (doc ser 21-27, 34) ------------------------------------
  ['ADM-NHQ', 'NHQ Buildings', 'Institutional', 'command-admin', 'SS-NHQ', 9, 14],
  ['ADM-COMNOR', 'HQ COMNOR Offices', 'Institutional', 'command-admin', 'SS-NHQ', 3, 10],
  ['ADM-MES', 'MES Offices', 'Institutional', 'command-admin', 'SS-NHQ', 10, 8],
  ['ADM-ZAFAR', 'PNS Zafar Offices / Barracks', 'Institutional', 'command-admin', 'SS-NHQ', 34, 6],
  ['ADM-NICICT', 'NI / CICT Det', 'Institutional', 'command-admin', 'SS-NHQ', 1, 7],
  ['ADM-NPU', 'HQ NPU', 'Institutional', 'command-admin', 'SS-NHQ', 8, 9],
  ['ADM-CNALAO', 'CNA / LAO Offices', 'Institutional', 'command-admin', 'SS-NHQ', 1, 6],
  ['ADM-TWR-C6C7', 'Tower C-6 + C-7', 'Institutional', 'command-admin', 'SS-NHQ', 72, 3],

  // --- Medical & Welfare (doc ser 28-33) --------------------------------------
  ['MED-HOSP', 'PNS Hafeez Hospital', 'Institutional', 'medical-welfare', 'SS-HFZ', 7, 45],
  ['MED-AFNS', 'AFNS Mess', 'Institutional', 'medical-welfare', 'SS-HFZ', 2, 12],
  ['MED-GYM', 'PN Gym', 'Institutional', 'medical-welfare', 'SS-HFZ', 2, 8],
  ['MED-MSQ', 'Ameer Hamza / Ibrahim / Jamali Mosques', 'Institutional', 'medical-welfare', 'SS-HFZ', 3, 4],
  ['MED-BRK-MES', 'MES Single Men Barracks', 'Institutional', 'medical-welfare', 'SS-HFZ', 2, 10],
  ['MED-FPBT', '1st FP Bt (Brk Off)', 'Institutional', 'medical-welfare', 'SS-HFZ', 6, 9],

  // --- Water filtration plants (doc: E&M NRC schedule — real locations) -------
  ['WFP-01', 'Filter Plant — Ameer Hamza Mosque', 'Infrastructure', 'water-utilities', 'SS-ARC', 1, 20],
  ['WFP-02', 'Filter Plant — Zafar Colony', 'Infrastructure', 'water-utilities', 'SS-ARC', 1, 20],
  ['WFP-03', 'Filter Plant — CPO MR-III', 'Infrastructure', 'water-utilities', 'SS-ARC', 1, 20],
  ['WFP-04', 'Filter Plant — Officer MR-III', 'Infrastructure', 'water-utilities', 'SS-ARC', 1, 20],

  // --- Overhead water tanks (doc: real locations + capacities) ----------------
  ['OHWT-01', 'OHWT No.1 — Ameer Hamza Mosque', 'Infrastructure', 'water-utilities', 'SS-ARC', 1, 3],
  ['OHWT-02', 'OHWT No.2 — Opposite Ibrahim Masjid', 'Infrastructure', 'water-utilities', 'SS-ARC', 1, 3],
  ['OHWT-03', 'OHWT No.3 — MR-III Officer', 'Infrastructure', 'water-utilities', 'SS-ARC', 1, 3],

  // --- Underground water tanks (doc: 42 Nos in 6 documented sets) -------------
  ['UGWT-G1', 'UGWT No.1,2&3 (100,000 gln)', 'Infrastructure', 'water-utilities', 'SS-ARC', 3, 2],
  ['UGWT-G2', 'UGWT — PNS Zafar + COMNOR (50,000 gln)', 'Infrastructure', 'water-utilities', 'SS-ARC', 2, 2],
  ['UGWT-G3', 'UGWT — ARC & PNS Hafeez (40,000 gln)', 'Infrastructure', 'water-utilities', 'SS-ARC', 3, 2],
  ['UGWT-G4', 'UGWT — AFNS Mess + PO/CPO MR-III (30,000 gln)', 'Infrastructure', 'water-utilities', 'SS-ARC', 2, 2],
  ['UGWT-G5', 'UGWT — MOQs & 1st FP Bn (20,000 gln)', 'Infrastructure', 'water-utilities', 'SS-ARC', 16, 2],
  ['UGWT-G6', 'UGWT — PNCM, Navy House & Guest House (10,000 gln)', 'Infrastructure', 'water-utilities', 'SS-ARC', 16, 2],

  // --- Motor pump sets (doc: 84 Nos total; the area split is assumed) ---------
  ['MP-Z1', 'Pump sets — Zone I', 'Infrastructure', 'water-utilities', 'SS-ARC', 18, 4],
  ['MP-Z2', 'Pump sets — Zone II', 'Infrastructure', 'water-utilities', 'SS-ARC', 24, 4],
  ['MP-MR3', 'Pump sets — MR-III', 'Infrastructure', 'water-utilities', 'SS-ARC', 14, 4],
  ['MP-ARC', 'Pump sets — ARC / PNS Hafeez', 'Infrastructure', 'water-utilities', 'SS-ARC', 12, 4],
  ['MP-NHQ', 'Pump sets — NHQ / COMNOR', 'Infrastructure', 'water-utilities', 'SS-ARC', 10, 4],
  ['MP-MOQ', 'Pump sets — MOQ / 1st FP Bn', 'Infrastructure', 'water-utilities', 'SS-ARC', 6, 4],

  // --- Reedbeds (doc: 4 Nos) --------------------------------------------------
  ['RB-GRP', 'Reedbeds (transfer pumps)', 'Infrastructure', 'water-utilities', 'SS-ARC', 4, 2],

  // --- Street / flood lighting (doc: 980 Nos; circuit split is assumed) -------
  ['SL-CKT-01', 'Lighting circuit — Zone I main roads', 'Infrastructure', 'street-lighting', 'SS-ARC', 140, 0.25],
  ['SL-CKT-02', 'Lighting circuit — Zone II main roads', 'Infrastructure', 'street-lighting', 'SS-ARC', 160, 0.25],
  ['SL-CKT-03', 'Lighting circuit — MR-III / Ashraf Colony', 'Infrastructure', 'street-lighting', 'SS-ARC', 120, 0.25],
  ['SL-CKT-04', 'Lighting circuit — NHQ / COMNOR precinct', 'Infrastructure', 'street-lighting', 'SS-ARC', 110, 0.25],
  ['SL-CKT-05', 'Lighting circuit — PNS Hafeez / hospital', 'Infrastructure', 'street-lighting', 'SS-ARC', 95, 0.25],
  ['SL-CKT-06', 'Lighting circuit — ARC / Zafar Colony', 'Infrastructure', 'street-lighting', 'SS-ARC', 130, 0.25],
  ['SL-CKT-07', 'Lighting circuit — perimeter flood lighting', 'Infrastructure', 'street-lighting', 'SS-ARC', 125, 0.25],
  ['SL-CKT-08', 'Lighting circuit — parade / sports flood lighting', 'Infrastructure', 'street-lighting', 'SS-ARC', 100, 0.25],

  // --- Vertical transport (doc: 15 passenger elevators + 5 lifts) -------------
  ['VT-TWR-C6', 'Elevators — Tower C-6', 'Infrastructure', 'vertical-transport', 'SS-ARC', 4, 7],
  ['VT-TWR-C7', 'Elevators — Tower C-7', 'Infrastructure', 'vertical-transport', 'SS-ARC', 4, 7],
  ['VT-NHQ', 'Elevators — NHQ buildings', 'Infrastructure', 'vertical-transport', 'SS-ARC', 4, 7],
  ['VT-HOSP', 'Elevators — PNS Hafeez Hospital', 'Infrastructure', 'vertical-transport', 'SS-ARC', 3, 7],
  ['VT-LIFT-MISC', 'Service lifts — MES / COMNOR / Zafar', 'Infrastructure', 'vertical-transport', 'SS-ARC', 5, 6],

  // --- Outstations (doc: 16 named off-complex facilities) ---------------------
  ['OS-01', 'CNS Hutt Murree', 'Off-complex', 'outstations', 'SS-SAT', 1, 7],
  ['OS-02', 'PNS Survival School Murree', 'Off-complex', 'outstations', 'SS-SAT', 1, 9],
  ['OS-03', 'Transmission Station (TS) Rawat', 'Off-complex', 'outstations', 'SS-SAT', 1, 11],
  ['OS-04', 'PNR & SC Rawalpindi', 'Off-complex', 'outstations', 'SS-SAT', 1, 6],
  ['OS-05', 'PNR & SC Peshawar', 'Off-complex', 'outstations', 'SS-SAT', 1, 6],
  ['OS-06', 'PNR & SC Swat', 'Off-complex', 'outstations', 'SS-SAT', 1, 5],
  ['OS-07', 'PNR / House Miandam', 'Off-complex', 'outstations', 'SS-SAT', 1, 4],
  ['OS-08', 'PNR & SC D I Khan', 'Off-complex', 'outstations', 'SS-SAT', 1, 5],
  ['OS-09', 'PNR & SC Abbottabad', 'Off-complex', 'outstations', 'SS-SAT', 1, 6],
  ['OS-10', 'PN ARC Gilgit', 'Off-complex', 'outstations', 'SS-SAT', 1, 8],
  ['OS-11', 'PNR & SC Muzafarabad', 'Off-complex', 'outstations', 'SS-SAT', 1, 6],
  ['OS-12', 'PNR & SC Kharian', 'Off-complex', 'outstations', 'SS-SAT', 1, 6],
  ['OS-13', 'PNR & SC Chitral', 'Off-complex', 'outstations', 'SS-SAT', 1, 5],
  ['OS-14', 'BOQs Kuldana', 'Off-complex', 'outstations', 'SS-SAT', 1, 7],
  ['OS-15', 'PNR / House Kalam', 'Off-complex', 'outstations', 'SS-SAT', 1, 4],
  ['OS-16', 'BOQ Lasdana AJK', 'Off-complex', 'outstations', 'SS-SAT', 1, 5],
];

/**
 * Tube wells — the document names 11 with locations and states "14 (12 Ops)".
 * The 11 named are modelled as in-service. TW-02/06/12 complete the count of 14
 * but have no entry in the register, so they are flagged `unlisted` and are NOT
 * monitored. NOTE: this leaves one operational tube well unaccounted for
 * (12 stated operational vs 11 listed) — see DATA_GAPS below.
 */
const TUBE_WELLS = [
  ['TW-01', 'Tube Well No.1', 'Overhead Tank No.2, front of Ibrahim Masjid', 'in-service'],
  ['TW-02', 'Tube Well No.2', 'Not listed in register', 'unlisted'],
  ['TW-03', 'Tube Well No.3', 'Bahria University', 'in-service'],
  ['TW-04', 'Tube Well No.4', 'HQ COMNOR', 'in-service'],
  ['TW-05', 'Tube Well No.5', 'Overhead Tank No.1, Ashraf Colony', 'in-service'],
  ['TW-06', 'Tube Well No.6', 'Not listed in register', 'unlisted'],
  ['TW-07', 'Tube Well No.7', '1st FP', 'in-service'],
  ['TW-08', 'Tube Well No.8', 'Street 6, C Type Bungalows Zone-II', 'in-service'],
  ['TW-09', 'Tube Well No.9', 'MR-III Officer area', 'in-service'],
  ['TW-10', 'Tube Well No.10', 'Yellow Flats, Ashraf Colony', 'in-service'],
  ['TW-11', 'Tube Well No.11', 'Overhead Tank No.2, front of Ibrahim Masjid', 'in-service'],
  ['TW-12', 'Tube Well No.12', 'Not listed in register', 'unlisted'],
  ['TW-13', 'Tube Well No.13', 'Street 10, D Type Bungalows', 'in-service'],
  ['TW-14', 'Tube Well No.14', 'Street 4, back of PNCM', 'in-service'],
];

/** Solar systems — doc states 13 Nos. Modelled as generation (negative net load). */
const SOLAR_COUNT = 13;
const SOLAR_KWP = 5; // assumed

function buildPoints() {
  const out = [];
  const groupById = Object.fromEntries(GROUPS.map((g) => [g.id, g]));

  const add = (p) => {
    const g = groupById[p.groupId];
    const headroom = p.headroom ?? g.headroom;
    const ratedKw = round1(p.units * p.unitKw);
    // Consumption limits. alarmKw is "the limit". warnKw sits partway between
    // rated demand and the limit — derived from the gap rather than as a flat
    // percentage of the limit, so a group with tight headroom (lighting, 1.15)
    // cannot end up with a warning limit BELOW its own rated demand.
    const alarmKw = p.alarmKw ?? round1(ratedKw * headroom);
    const warnKw = p.warnKw ?? round1(ratedKw + (alarmKw - ratedKw) * 0.55);
    out.push({
      role: 'load',
      service: 'in-service',
      location: p.location ?? p.zone,
      unitKwSrc: 'assumed',
      unitsSrc: 'doc',
      ...p,
      ratedKw,
      warnKw,
      alarmKw,
      monitored: (p.service ?? 'in-service') === 'in-service',
    });
  };

  for (const [id, name, zone, groupId, substationId, units, unitKw] of DEFS) {
    add({ id, name, zone, groupId, substationId, units, unitKw });
  }

  for (const [id, name, location, service] of TUBE_WELLS) {
    add({
      id,
      name,
      location,
      zone: 'Infrastructure',
      groupId: 'water-utilities',
      substationId: 'SS-ARC',
      units: 1,
      unitKw: 15,
      service,
      locationSrc: 'doc',
    });
  }

  for (let i = 1; i <= SOLAR_COUNT; i++) {
    const id = `SOL-${String(i).padStart(2, '0')}`;
    out.push({
      id,
      name: `Solar system ${String(i).padStart(2, '0')}`,
      location: 'Rooftop array (location not in register)',
      zone: 'Infrastructure',
      groupId: 'solar-generation',
      substationId: 'SS-ARC',
      role: 'generation',
      service: 'in-service',
      monitored: true,
      units: 1,
      unitKw: SOLAR_KWP,
      unitsSrc: 'doc',
      unitKwSrc: 'assumed',
      ratedKw: SOLAR_KWP,
      /**
       * For generation the meaningful fault is UNDER-performance, and it must be
       * judged RELATIVE to the irradiance available right now — a fixed kW floor
       * would alarm every array at dawn and dusk purely because the sun is low.
       * These are performance ratios against expected output for the hour.
       */
      lowLimitMode: 'relative',
      lowWarnRatio: 0.6,
      lowAlarmRatio: 0.35,
      lowLimitWindow: 'daylight', // only evaluated when irradiance is meaningful
      warnKw: round1(SOLAR_KWP * 1.15),
      alarmKw: round1(SOLAR_KWP * 1.25),
    });
  }

  return out;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

export const POINTS = buildPoints();
export const POINT_BY_ID = Object.fromEntries(POINTS.map((p) => [p.id, p]));
export const MONITORED_POINTS = POINTS.filter((p) => p.monitored);

/** Rated (baseline) demand per substation, from the points fed by it. */
export function ratedBySubstation() {
  const acc = {};
  for (const ss of SUBSTATIONS) acc[ss.id] = 0;
  for (const p of MONITORED_POINTS) {
    if (p.role === 'generation') continue;
    acc[p.substationId] = (acc[p.substationId] || 0) + p.ratedKw;
  }
  return acc;
}

export const SITE_RATED_KW = round1(
  MONITORED_POINTS.filter((p) => p.role !== 'generation').reduce((a, p) => a + p.ratedKw, 0)
);

export const SITE_GENERATION_KWP = round1(
  MONITORED_POINTS.filter((p) => p.role === 'generation').reduce((a, p) => a + p.ratedKw, 0)
);

/**
 * Discrepancies found while reconciling the register. Surfaced in the UI rather
 * than silently patched — these are questions for the facility team, not bugs.
 */
export const DATA_GAPS = [
  {
    id: 'gap-tubewells',
    severity: 'warning',
    text: 'Register states 14 tube wells (12 operational) but lists only 11 with locations. One operational tube well is unaccounted for; TW-02/06/12 have no register entry and are unmonitored.',
  },
  {
    id: 'gap-transformer-split',
    severity: 'info',
    text: `Transformer count (${TRANSFORMER_FLEET.unitCount}) and installed capacity (${TRANSFORMER_FLEET.installedKva.toLocaleString('en-US')} kVA) are from the register, but the per-substation allocation is an assumption. Replace with the real single-line diagram.`,
  },
  {
    id: 'gap-unit-ratings',
    severity: 'warning',
    text: 'No metered consumption exists in the source register. All unit kW ratings — and therefore every limit — are engineering estimates. Replace with nameplate/metered data before operational use.',
  },
  {
    id: 'gap-feeder-allocation',
    severity: 'info',
    text: 'Which loads sit on which of the 3 feeders is not stated in the register. Feeder allocation here is assumed and should be corrected from the site SLD.',
  },
  {
    id: 'gap-circuit-split',
    severity: 'info',
    text: 'Street lighting (980 Nos), motor pumps (84 Nos) and vertical transport (20 Nos) are given as totals only. They are split into circuits/areas here so they can be metered separately; the split is assumed.',
  },
];
