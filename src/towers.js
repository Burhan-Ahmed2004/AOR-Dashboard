/**
 * TOWER MODEL — data layer for the per-tower monitoring dashboards
 * ================================================================
 * Deliberately kept free of any DOM access so real IoT sources can replace the
 * demo adapter below without touching a single view file. `tower-view.js`
 * renders whatever this module reports and nothing else.
 *
 * PROVENANCE — three levels, because this feature spans three very different
 * grades of evidence and collapsing them would be dishonest:
 *
 *   REG   stated in the asset register. Tower C-6 and C-7 are real; so are
 *         their 4 + 4 elevators and the combined electrical point feeding them.
 *   SIM   a simulated READING of something the register does record (the
 *         tower block's electrical demand).
 *   DEMO  the equipment itself does not appear in the register at all. No water
 *         leak detector, fire detector or alarm panel is recorded anywhere in
 *         the source document, and no lift reports its live position. Every
 *         such value here is placeholder data for development only.
 *
 * NOTHING in this file is connected to real hardware. The fire section in
 * particular drives no alarm, sounder or notification of any kind.
 */

export const PROVENANCE = { REG: 'reg', SIM: 'sim', DEMO: 'demo' };

/**
 * The two towers. These are NOT invented: the register lists
 *   "Tower C-6 + C-7 | 72 Nos"          (combined electrical load)
 *   "Elevators — Tower C-6 | 4 Nos"
 *   "Elevators — Tower C-7 | 4 Nos"
 * so the tower identities and the lift counts are register facts. Floor counts
 * are NOT stated anywhere and are a demo assumption.
 */
export const TOWERS = [
  {
    id: 'T1',
    name: 'Tower 1',
    registerName: 'Tower C-6',
    liftPointId: 'VT-TWR-C6',
    electricityPointId: 'ADM-TWR-C6C7',
    electricitySubstation: 'SS-NHQ',
    liftSubstation: 'SS-ARC',
    floors: 12,            // DEMO — not in the register
    basements: 1,          // DEMO
  },
  {
    id: 'T2',
    name: 'Tower 2',
    registerName: 'Tower C-7',
    liftPointId: 'VT-TWR-C7',
    electricityPointId: 'ADM-TWR-C6C7',
    electricitySubstation: 'SS-NHQ',
    liftSubstation: 'SS-ARC',
    floors: 12,            // DEMO
    basements: 1,          // DEMO
  },
];

export const TOWER_BY_ID = Object.fromEntries(TOWERS.map((t) => [t.id, t]));

/** Discrete equipment states. Each pairs with an icon and a word in the UI. */
export const STATE = {
  NORMAL: 'normal',
  ALERT: 'alert',
  FAULT: 'fault',
  OFFLINE: 'offline',
};

export const LIFT_STATE = {
  RUNNING: 'running',
  IDLE: 'idle',
  OUT_OF_SERVICE: 'out-of-service',
  FAULT: 'fault',
};

export const ALARM_PANEL = {
  INACTIVE: 'inactive',
  ACTIVE: 'active',
  FAULT: 'fault',
};

/** Water storage level bands. LOW/CRITICAL are level alarms, not sensor faults. */
export const TANK_STATE = {
  NORMAL: 'normal',
  LOW: 'low',
  CRITICAL: 'critical',
  HIGH: 'high',
  OFFLINE: 'offline',
};

export const PUMP_STATE = {
  RUNNING: 'running',
  STOPPED: 'stopped',
  STANDBY: 'standby',
  FAULT: 'fault',
};

/** Sensor positions. DEMO: no detector schedule exists in the register. */
const LEAK_POSITIONS = [
  ['Basement pump room', 'B1'],
  ['Ground floor riser', 'GF'],
  ['Level 3 wet riser', 'L3'],
  ['Level 6 wet riser', 'L6'],
  ['Level 9 wet riser', 'L9'],
  ['Roof tank area', 'Roof'],
];

const FIRE_POSITIONS = [
  ['Basement plant room', 'B1'],
  ['Ground floor lobby', 'GF'],
  ['Level 2 corridor', 'L2'],
  ['Level 5 corridor', 'L5'],
  ['Level 8 corridor', 'L8'],
  ['Level 11 corridor', 'L11'],
  ['Lift machine room', 'Roof'],
];

/**
 * Water storage and pumping. DEMO: the register records no tank, no level
 * transmitter and no water pump, so every figure below is placeholder data.
 *
 * The arrangement is the ordinary high-rise one — mains fills an underground
 * suction tank, transfer pumps lift to a roof tank, the roof tank feeds the
 * building by gravity with a booster set, and a separate reserve is held for
 * firefighting. Modelling it that way means the pump states follow from the
 * tank levels instead of being independent random noise.
 */
const TANK_SPECS = [
  { key: 'UG',   name: 'Underground suction tank', role: 'Suction',  floor: 'B1',
    capacityL: 90000, startPct: 68, lowPct: 30, criticalPct: 18, highPct: 97 },
  { key: 'ROOF', name: 'Roof overhead tank',       role: 'Overhead', floor: 'Roof',
    capacityL: 45000, startPct: 84, lowPct: 25, criticalPct: 15, highPct: 97 },
  { key: 'FIRE', name: 'Fire reserve tank',        role: 'Reserve',  floor: 'B1',
    capacityL: 60000, startPct: 97, lowPct: 90, criticalPct: 80, highPct: 100 },
];

/** Roof-tank level control setpoints (% of capacity). */
const ROOF_PUMP_ON = 42;
const ROOF_PUMP_OFF = 93;
const FIRE_TOPUP_ON = 95;
const FIRE_TOPUP_OFF = 98.5;

const PUMP_SPECS = [
  { key: 'TP1', name: 'Transfer pump 1',  duty: 'Duty',    serves: 'ROOF', floor: 'B1' },
  { key: 'TP2', name: 'Transfer pump 2',  duty: 'Standby', serves: 'ROOF', floor: 'B1' },
  { key: 'BP1', name: 'Booster set',      duty: 'Duty',    serves: 'ROOF', floor: 'B1' },
  { key: 'JP1', name: 'Fire jockey pump', duty: 'Standby', serves: 'FIRE', floor: 'B1' },
];

const DEFAULTS = {
  // Per-sensor, per-tick probabilities. Tuned so a demo shows an event every
  // few minutes rather than constantly, and so the normal state dominates.
  leakChance: 0.00035,
  leakClearMs: 90000,
  fireChance: 0.00018,
  fireClearMs: 75000,
  sensorFaultChance: 0.00012,
  sensorFaultMs: 60000,
  sensorOfflineChance: 0.00010,
  sensorOfflineMs: 45000,
  liftFaultChance: 0.00022,
  liftFaultMs: 70000,
  staleAfterMs: 20000,
  maxEvents: 60,
  // Water. Rates are %-of-capacity per second of demo time, chosen so a full
  // fill/draw cycle is visible to someone watching for a minute or two.
  roofDrawPctPerSec: 0.30,
  roofFillPctPerSec: 1.05,
  ugFillPctPerSec: 0.22,
  fireTopUpPctPerSec: 0.40,
  fireDriftPctPerSec: 0.012,
  pumpFaultChance: 0.00016,
  pumpFaultMs: 65000,
  levelOfflineChance: 0.00008,
  levelOfflineMs: 40000,
  tankHistoryLen: 60,
};

function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length) % arr.length];
}

/** Small deterministic PRNG so a demo run is reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param register  the point register module (for REG-derived facts)
 * @param store     the reading store (for the real simulated electrical load)
 */
export function createTowerModel(register, store, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const rand = mulberry32(options.seed ?? 77003);

  /** @type {Map<string, object>} towerId -> state */
  const towers = new Map();
  let eventSeq = 0;

  for (const t of TOWERS) {
    const liftPoint = register.POINT_BY_ID[t.liftPointId];
    const liftCount = liftPoint ? liftPoint.units : 0; // REG

    towers.set(t.id, {
      def: t,
      // ---- water leak detectors (DEMO) ---------------------------------
      leakSensors: LEAK_POSITIONS.map(([place, floor], i) => ({
        id: `${t.id}-WL-${String(i + 1).padStart(2, '0')}`,
        label: place,
        floor,
        state: STATE.NORMAL,
        since: 0,
        until: 0,
        lastUpdate: Date.now(),
      })),
      // ---- fire detectors (DEMO) ---------------------------------------
      fireSensors: FIRE_POSITIONS.map(([place, floor], i) => ({
        id: `${t.id}-FD-${String(i + 1).padStart(2, '0')}`,
        label: place,
        floor,
        state: STATE.NORMAL,
        since: 0,
        until: 0,
        lastUpdate: Date.now(),
      })),
      alarmPanel: { id: `${t.id}-FACP`, state: ALARM_PANEL.INACTIVE, since: 0, lastUpdate: Date.now() },
      // ---- lifts: COUNT is REG, live status is DEMO ---------------------
      lifts: Array.from({ length: liftCount }, (_, i) => ({
        id: `${t.id}-LIFT-${i + 1}`,
        name: `Lift ${i + 1}`,
        state: LIFT_STATE.IDLE,
        floor: 1,
        target: 1,
        direction: 'stationary',
        since: 0,
        until: 0,
        trips: 0,
        lastUpdate: Date.now(),
      })),
      // ---- water storage + pumping (DEMO) -------------------------------
      tanks: TANK_SPECS.map((spec) => ({
        ...spec,
        id: `${t.id}-TK-${spec.key}`,
        pct: spec.startPct,
        prevPct: spec.startPct,
        state: TANK_STATE.NORMAL,
        trend: 'steady',
        offlineUntil: 0,
        history: [],
        lastUpdate: Date.now(),
      })),
      pumps: PUMP_SPECS.map((spec) => ({
        ...spec,
        id: `${t.id}-P-${spec.key}`,
        state: PUMP_STATE.STOPPED,
        since: Date.now(),
        until: 0,
        runtimeMs: 0,
        starts: 0,
        lastUpdate: Date.now(),
      })),
      transferDemand: false,
      fireTopUp: false,
      events: [],
      lastTick: 0,
      lastWaterTick: 0,
    });
  }

  // -------------------------------------------------------------- events
  function raise(tw, kind, severity, title, detail, sourceId, now = Date.now()) {
    // De-duplication: one open event per source. A continuously active
    // condition must not produce a new entry on every tick.
    const open = tw.events.find((e) => e.sourceId === sourceId && !e.clearedAt);
    if (open) return open;
    eventSeq += 1;
    const ev = {
      id: `${tw.def.id}-E${eventSeq}`,
      towerId: tw.def.id,          // every event is tower-scoped by construction
      towerName: tw.def.name,
      kind,                        // 'fire' | 'leak' | 'lift' | 'sensor'
      severity,                    // 'critical' | 'warning' | 'info'
      title,
      detail,
      sourceId,
      raisedAt: now,
      clearedAt: null,
    };
    tw.events.unshift(ev);
    if (tw.events.length > cfg.maxEvents) tw.events.length = cfg.maxEvents;
    return ev;
  }

  function clear(tw, sourceId, now = Date.now()) {
    const open = tw.events.find((e) => e.sourceId === sourceId && !e.clearedAt);
    if (open) open.clearedAt = now;
  }

  // ------------------------------------------------------- demo sensor tick
  function tickSensor(tw, s, now, chance, clearMs, alertLabel, kind, severity) {
    s.lastUpdate = now;

    if (s.until && now >= s.until) {
      s.state = STATE.NORMAL;
      s.until = 0;
      s.since = 0;
      clear(tw, s.id, now);
      return;
    }
    if (s.state !== STATE.NORMAL) return;

    const r = rand();
    if (r < chance) {
      s.state = STATE.ALERT;
      s.since = now;
      s.until = now + clearMs;
      raise(tw, kind, severity, alertLabel, `${s.label} (${s.floor})`, s.id, now);
    } else if (r < chance + cfg.sensorFaultChance) {
      s.state = STATE.FAULT;
      s.since = now;
      s.until = now + cfg.sensorFaultMs;
      raise(tw, 'sensor', 'warning', 'Sensor fault', `${s.id} — ${s.label}`, s.id, now);
    } else if (r < chance + cfg.sensorFaultChance + cfg.sensorOfflineChance) {
      s.state = STATE.OFFLINE;
      s.since = now;
      s.until = now + cfg.sensorOfflineMs;
      raise(tw, 'sensor', 'warning', 'Sensor offline', `${s.id} — ${s.label}`, s.id, now);
    }
  }

  function tickLift(tw, lift, now) {
    const topFloor = tw.def.floors;
    lift.lastUpdate = now;

    if (lift.until && now >= lift.until) {
      lift.state = LIFT_STATE.IDLE;
      lift.direction = 'stationary';
      lift.until = 0;
      clear(tw, lift.id, now);
    }

    if (lift.state === LIFT_STATE.FAULT || lift.state === LIFT_STATE.OUT_OF_SERVICE) return;

    const r = rand();
    if (r < cfg.liftFaultChance) {
      lift.state = r < cfg.liftFaultChance * 0.4 ? LIFT_STATE.OUT_OF_SERVICE : LIFT_STATE.FAULT;
      lift.direction = 'stationary';
      lift.since = now;
      lift.until = now + cfg.liftFaultMs;
      raise(
        tw,
        'lift',
        'warning',
        lift.state === LIFT_STATE.FAULT ? 'Lift fault' : 'Lift out of service',
        `${lift.name} — floor ${lift.floor}`,
        lift.id,
        now
      );
      return;
    }

    if (lift.state === LIFT_STATE.RUNNING) {
      if (lift.floor === lift.target) {
        lift.state = LIFT_STATE.IDLE;
        lift.direction = 'stationary';
        lift.trips += 1;
      } else {
        const step = lift.target > lift.floor ? 1 : -1;
        lift.floor += step;
        lift.direction = step > 0 ? 'up' : 'down';
      }
      return;
    }

    // idle: occasionally get called somewhere
    if (rand() < 0.22) {
      let target = 1 + Math.floor(rand() * topFloor);
      if (target === lift.floor) target = target === topFloor ? 1 : target + 1;
      lift.target = target;
      lift.state = LIFT_STATE.RUNNING;
      lift.direction = target > lift.floor ? 'up' : 'down';
    }
  }

  // --------------------------------------------------------- water system
  const tankOf = (tw, key) => tw.tanks.find((x) => x.key === key);
  const pumpOf = (tw, key) => tw.pumps.find((x) => x.key === key);

  function setPump(tw, p, next, now) {
    if (p.state === next) return;
    if (next === PUMP_STATE.RUNNING) p.starts += 1;
    p.state = next;
    p.since = now;
  }

  /**
   * One water tick. Pump states are DERIVED from tank levels here rather than
   * randomised, so what the screen shows is at least internally consistent:
   * the transfer pump runs because the roof tank is low, not by coincidence.
   */
  function tickWater(tw, now) {
    const dt = Math.min(Math.max(now - (tw.lastWaterTick || now), 0), 5000) / 1000;
    tw.lastWaterTick = now;

    const roof = tankOf(tw, 'ROOF');
    const ug = tankOf(tw, 'UG');
    const fire = tankOf(tw, 'FIRE');

    // --- pump faults and their recovery ---------------------------------
    for (const p of tw.pumps) {
      p.lastUpdate = now;
      if (p.state === PUMP_STATE.FAULT) {
        if (p.until && now >= p.until) { p.until = 0; setPump(tw, p, PUMP_STATE.STOPPED, now); clear(tw, p.id, now); }
        continue;
      }
      if (rand() < cfg.pumpFaultChance) {
        p.until = now + cfg.pumpFaultMs;
        setPump(tw, p, PUMP_STATE.FAULT, now);
        raise(tw, 'pump', 'warning', 'Pump fault', `${p.name} (${p.duty.toLowerCase()})`, p.id, now);
      }
    }

    // --- level transmitter comms ----------------------------------------
    for (const tk of tw.tanks) {
      if (tk.offlineUntil) {
        if (now >= tk.offlineUntil) { tk.offlineUntil = 0; clear(tw, `${tk.id}-COMMS`, now); }
      } else if (rand() < cfg.levelOfflineChance) {
        tk.offlineUntil = now + cfg.levelOfflineMs;
        raise(tw, 'sensor', 'warning', 'Level transmitter offline',
          `${tk.name} — no level reading`, `${tk.id}-COMMS`, now);
      }
    }

    // --- level control --------------------------------------------------
    // With no level signal the controller holds its last demand rather than
    // guessing a level it cannot see.
    const roofBlind = roof.offlineUntil > 0;
    if (!roofBlind) {
      if (roof.pct <= ROOF_PUMP_ON) tw.transferDemand = true;
      else if (roof.pct >= ROOF_PUMP_OFF) tw.transferDemand = false;
    }

    // Duty/standby changeover: if the duty transfer pump is faulted, the
    // standby takes the duty.
    const tp1 = pumpOf(tw, 'TP1');
    const tp2 = pumpOf(tw, 'TP2');
    const duty = tp1.state === PUMP_STATE.FAULT ? tp2 : tp1;
    const standby = duty === tp1 ? tp2 : tp1;
    if (duty.state !== PUMP_STATE.FAULT) {
      setPump(tw, duty, tw.transferDemand ? PUMP_STATE.RUNNING : PUMP_STATE.STOPPED, now);
    }
    if (standby.state !== PUMP_STATE.FAULT) setPump(tw, standby, PUMP_STATE.STANDBY, now);

    const booster = pumpOf(tw, 'BP1');
    if (booster.state !== PUMP_STATE.FAULT) {
      setPump(tw, booster,
        !roofBlind && roof.pct > roof.criticalPct ? PUMP_STATE.RUNNING : PUMP_STATE.STOPPED, now);
    }
    // Jockey pump tops the fire reserve back up, with a deadband so it does
    // not hunt on and off around a single setpoint.
    const jockey = pumpOf(tw, 'JP1');
    if (!fire.offlineUntil) {
      if (fire.pct < FIRE_TOPUP_ON) tw.fireTopUp = true;
      else if (fire.pct >= FIRE_TOPUP_OFF) tw.fireTopUp = false;
    }
    if (jockey.state !== PUMP_STATE.FAULT) {
      setPump(tw, jockey, tw.fireTopUp ? PUMP_STATE.RUNNING : PUMP_STATE.STANDBY, now);
    }

    // --- move the water -------------------------------------------------
    const transferring = duty.state === PUMP_STATE.RUNNING;
    const delta = {
      ROOF: (transferring ? cfg.roofFillPctPerSec : 0)
          - (booster.state === PUMP_STATE.RUNNING ? cfg.roofDrawPctPerSec : 0),
      UG: (ug.pct < 95 ? cfg.ugFillPctPerSec : 0)
          - (transferring ? cfg.roofFillPctPerSec * (roof.capacityL / ug.capacityL) : 0),
      FIRE: (jockey.state === PUMP_STATE.RUNNING ? cfg.fireTopUpPctPerSec : 0) - cfg.fireDriftPctPerSec,
    };

    for (const p of tw.pumps) if (p.state === PUMP_STATE.RUNNING) p.runtimeMs += dt * 1000;

    const ALARM_BANDS = [TANK_STATE.CRITICAL, TANK_STATE.LOW, TANK_STATE.HIGH];
    for (const tk of tw.tanks) {
      tk.prevPct = tk.pct;
      tk.pct = Math.max(0, Math.min(100, tk.pct + (delta[tk.key] || 0) * dt));
      tk.lastUpdate = now;

      const moved = tk.pct - tk.prevPct;
      if (tk.offlineUntil) {
        tk.state = TANK_STATE.OFFLINE;
        tk.trend = 'unknown';
      } else {
        tk.trend = moved > 0.02 ? 'filling' : moved < -0.02 ? 'draining' : 'steady';
        tk.state = tk.pct <= tk.criticalPct ? TANK_STATE.CRITICAL
          : tk.pct <= tk.lowPct ? TANK_STATE.LOW
          : tk.pct >= tk.highPct ? TANK_STATE.HIGH
          : TANK_STATE.NORMAL;
        tk.history.push({ t: now, v: tk.pct });
        if (tk.history.length > cfg.tankHistoryLen) tk.history.shift();
      }

      // One open event per band, so a level sitting in the low band does not
      // re-raise every tick, but a drop from low to critical still escalates.
      for (const band of ALARM_BANDS) {
        if (band !== tk.state) clear(tw, `${tk.id}-LVL-${band}`, now);
      }
      if (ALARM_BANDS.includes(tk.state)) {
        const word = tk.state === TANK_STATE.CRITICAL ? 'Tank level critically low'
          : tk.state === TANK_STATE.LOW ? 'Tank level low' : 'Tank level high';
        const limit = tk.state === TANK_STATE.HIGH ? `above ${tk.highPct}%`
          : `below ${tk.state === TANK_STATE.CRITICAL ? tk.criticalPct : tk.lowPct}%`;
        raise(tw, 'tank', tk.state === TANK_STATE.CRITICAL ? 'critical' : 'warning', word,
          `${tk.name} — ${tk.pct.toFixed(0)}% (alarm ${limit})`, `${tk.id}-LVL-${tk.state}`, now);
      }
    }
  }

  /** Advance every tower. Call once per render tick. */
  function update(now = Date.now()) {
    for (const tw of towers.values()) {
      for (const s of tw.leakSensors) {
        tickSensor(tw, s, now, cfg.leakChance, cfg.leakClearMs, 'Water leak detected', 'leak', 'critical');
      }
      for (const s of tw.fireSensors) {
        tickSensor(tw, s, now, cfg.fireChance, cfg.fireClearMs, 'FIRE DETECTED', 'fire', 'critical');
      }
      for (const l of tw.lifts) tickLift(tw, l, now);
      tickWater(tw, now);

      // Alarm panel follows its own detectors only — never the other tower's.
      const firing = tw.fireSensors.some((s) => s.state === STATE.ALERT);
      const faulty = tw.fireSensors.some((s) => s.state === STATE.FAULT || s.state === STATE.OFFLINE);
      const next = firing ? ALARM_PANEL.ACTIVE : faulty ? ALARM_PANEL.FAULT : ALARM_PANEL.INACTIVE;
      if (next !== tw.alarmPanel.state) {
        tw.alarmPanel.state = next;
        tw.alarmPanel.since = now;
      }
      tw.alarmPanel.lastUpdate = now;
      tw.lastTick = now;
    }
  }

  /**
   * Manually fire a demo event, so the alert path can be exercised during
   * development and acceptance testing. Exposed to the UI behind a control
   * that is explicitly labelled as demo-only.
   */
  function triggerDemo(towerId, kind, now = Date.now()) {
    const tw = towers.get(towerId);
    if (!tw) return null;
    if (kind === 'fire') {
      const s = pick(rand, tw.fireSensors.filter((x) => x.state === STATE.NORMAL)) || tw.fireSensors[0];
      s.state = STATE.ALERT;
      s.since = now;
      s.until = now + cfg.fireClearMs;
      s.lastUpdate = now;
      return raise(tw, 'fire', 'critical', 'FIRE DETECTED', `${s.label} (${s.floor})`, s.id, now);
    }
    if (kind === 'leak') {
      const s = pick(rand, tw.leakSensors.filter((x) => x.state === STATE.NORMAL)) || tw.leakSensors[0];
      s.state = STATE.ALERT;
      s.since = now;
      s.until = now + cfg.leakClearMs;
      s.lastUpdate = now;
      return raise(tw, 'leak', 'critical', 'Water leak detected', `${s.label} (${s.floor})`, s.id, now);
    }
    if (kind === 'lift') {
      const l = tw.lifts.find((x) => x.state !== LIFT_STATE.FAULT) || tw.lifts[0];
      if (!l) return null;
      l.state = LIFT_STATE.FAULT;
      l.direction = 'stationary';
      l.since = now;
      l.until = now + cfg.liftFaultMs;
      l.lastUpdate = now;
      return raise(tw, 'lift', 'warning', 'Lift fault', `${l.name} — floor ${l.floor}`, l.id, now);
    }
    if (kind === 'tanklow') {
      const tk = tankOf(tw, 'ROOF');
      tk.offlineUntil = 0;
      tk.prevPct = tk.pct;
      tk.pct = tk.criticalPct - 3;
      tk.state = TANK_STATE.CRITICAL;
      tk.trend = 'draining';
      tk.lastUpdate = now;
      tw.transferDemand = true;
      return raise(tw, 'tank', 'critical', 'Tank level critically low',
        `${tk.name} — ${tk.pct.toFixed(0)}% (alarm below ${tk.criticalPct}%)`,
        `${tk.id}-LVL-${TANK_STATE.CRITICAL}`, now);
    }
    if (kind === 'pump') {
      // Fault the running duty transfer pump so the standby changeover shows.
      const p = pumpOf(tw, 'TP1').state === PUMP_STATE.FAULT ? pumpOf(tw, 'TP2') : pumpOf(tw, 'TP1');
      p.state = PUMP_STATE.FAULT;
      p.since = now;
      p.until = now + cfg.pumpFaultMs;
      p.lastUpdate = now;
      return raise(tw, 'pump', 'warning', 'Pump fault', `${p.name} (${p.duty.toLowerCase()})`, p.id, now);
    }
    if (kind === 'reset') {
      for (const s of [...tw.leakSensors, ...tw.fireSensors]) {
        s.state = STATE.NORMAL; s.until = 0; s.since = 0;
        clear(tw, s.id, now);
      }
      for (const l of tw.lifts) {
        if (l.state === LIFT_STATE.FAULT || l.state === LIFT_STATE.OUT_OF_SERVICE) {
          l.state = LIFT_STATE.IDLE; l.until = 0; clear(tw, l.id, now);
        }
      }
      for (const tk of tw.tanks) {
        tk.pct = tk.startPct;
        tk.prevPct = tk.startPct;
        tk.state = TANK_STATE.NORMAL;
        tk.trend = 'steady';
        tk.offlineUntil = 0;
        tk.lastUpdate = now;
        clear(tw, `${tk.id}-COMMS`, now);
        for (const band of [TANK_STATE.CRITICAL, TANK_STATE.LOW, TANK_STATE.HIGH]) {
          clear(tw, `${tk.id}-LVL-${band}`, now);
        }
      }
      for (const p of tw.pumps) {
        if (p.state === PUMP_STATE.FAULT) { p.state = PUMP_STATE.STOPPED; p.until = 0; }
        clear(tw, p.id, now);
      }
      tw.transferDemand = false;
      return null;
    }
    return null;
  }

  /**
   * Electricity for a tower.
   *
   * IMPORTANT: the register records ONE combined point for both towers —
   * "Tower C-6 + C-7, 72 Nos". It does not separate them. That point is
   * therefore reported as explicitly SHARED, with a per-tower figure derived
   * from an assumed even split and labelled as such. This is the one case
   * where a value legitimately appears on both tower dashboards, because the
   * underlying data identifies it as shared.
   */
  function electricity(towerId) {
    const t = TOWER_BY_ID[towerId];
    const point = register.POINT_BY_ID[t.electricityPointId];
    if (!point) return null;
    const v = store.pointView(point, null);
    const liftPoint = register.POINT_BY_ID[t.liftPointId];
    const lv = liftPoint ? store.pointView(liftPoint, null) : null;
    const share = 0.5; // ASSUMED even split of the shared block point

    return {
      shared: true,
      sharedPointId: point.id,
      sharedLabel: point.name,
      units: point.units,
      blockKw: v.value,
      blockRatedKw: point.ratedKw,
      blockTypicalKw: v.expected,
      blockEnergyKwh: v.energyKwh,
      blockPeakKw: v.peakKw,
      towerKw: v.value * share,
      towerTypicalKw: v.expected * share,
      towerEnergyKwh: v.energyKwh * share,
      sharePct: share * 100,
      liftKw: lv ? lv.value : null,
      liftEnergyKwh: lv ? lv.energyKwh : null,
      liftPointId: liftPoint ? liftPoint.id : null,
      history: v.history,
      substation: t.electricitySubstation,
      lastTs: v.lastTs,
      deltaVsTypical: v.deltaVsExpected,
    };
  }

  function snapshot(towerId, now = Date.now()) {
    const tw = towers.get(towerId);
    if (!tw) return null;
    const stale = (s) => now - s.lastUpdate > cfg.staleAfterMs;

    const leakAlert = tw.leakSensors.filter((s) => s.state === STATE.ALERT);
    const fireAlert = tw.fireSensors.filter((s) => s.state === STATE.ALERT);

    return {
      def: tw.def,
      leak: {
        sensors: tw.leakSensors.map((s) => ({ ...s, stale: stale(s) })),
        alerting: leakAlert,
        faulty: tw.leakSensors.filter((s) => s.state === STATE.FAULT),
        offline: tw.leakSensors.filter((s) => s.state === STATE.OFFLINE),
        status: leakAlert.length ? STATE.ALERT
          : tw.leakSensors.some((s) => s.state === STATE.OFFLINE) ? STATE.OFFLINE
          : tw.leakSensors.some((s) => s.state === STATE.FAULT) ? STATE.FAULT
          : STATE.NORMAL,
      },
      fire: {
        sensors: tw.fireSensors.map((s) => ({ ...s, stale: stale(s) })),
        alerting: fireAlert,
        faulty: tw.fireSensors.filter((s) => s.state === STATE.FAULT),
        offline: tw.fireSensors.filter((s) => s.state === STATE.OFFLINE),
        panel: tw.alarmPanel,
        status: fireAlert.length ? STATE.ALERT
          : tw.fireSensors.some((s) => s.state === STATE.OFFLINE) ? STATE.OFFLINE
          : tw.fireSensors.some((s) => s.state === STATE.FAULT) ? STATE.FAULT
          : STATE.NORMAL,
      },
      lifts: tw.lifts.map((l) => ({ ...l, stale: stale(l) })),
      water: water(tw, now, stale),
      electricity: electricity(towerId),
      events: tw.events,
      lastTick: tw.lastTick,
    };
  }

  /**
   * Water storage and pumping for one tower.
   *
   * A tank whose transmitter is offline reports `pct: null`. The last known
   * figure is carried separately as `lastKnownPct` so the UI can say "last
   * known 61%, 40s ago" — it must never pass a stale number off as live.
   */
  function water(tw, now, stale) {
    const tanks = tw.tanks.map((tk) => {
      const offline = tk.offlineUntil > 0;
      return {
        id: tk.id, key: tk.key, name: tk.name, role: tk.role, floor: tk.floor,
        capacityL: tk.capacityL,
        state: tk.state,
        trend: tk.trend,
        offline,
        pct: offline ? null : tk.pct,
        lastKnownPct: tk.pct,
        litres: offline ? null : Math.round((tk.pct / 100) * tk.capacityL),
        lowPct: tk.lowPct,
        criticalPct: tk.criticalPct,
        highPct: tk.highPct,
        history: tk.history,
        lastUpdate: tk.lastUpdate,
        stale: !offline && stale(tk),
      };
    });

    const pumps = tw.pumps.map((p) => ({
      id: p.id, key: p.key, name: p.name, duty: p.duty, floor: p.floor,
      serves: p.serves,
      state: p.state,
      since: p.since,
      runtimeMs: p.runtimeMs,
      starts: p.starts,
      lastUpdate: p.lastUpdate,
      stale: stale(p),
    }));

    const worstTank = tanks.some((t) => t.state === TANK_STATE.CRITICAL) ? TANK_STATE.CRITICAL
      : tanks.some((t) => t.state === TANK_STATE.LOW) ? TANK_STATE.LOW
      : tanks.some((t) => t.state === TANK_STATE.HIGH) ? TANK_STATE.HIGH
      : tanks.some((t) => t.offline) ? TANK_STATE.OFFLINE
      : TANK_STATE.NORMAL;

    const live = tanks.filter((t) => t.pct != null);
    return {
      tanks,
      pumps,
      tankStatus: worstTank,
      pumpsFaulted: pumps.filter((p) => p.state === PUMP_STATE.FAULT),
      pumpsRunning: pumps.filter((p) => p.state === PUMP_STATE.RUNNING),
      minPct: live.length ? Math.min(...live.map((t) => t.pct)) : null,
      totalLitres: live.reduce((a, t) => a + t.litres, 0),
      totalCapacityL: tanks.reduce((a, t) => a + t.capacityL, 0),
    };
  }

  /** Worst condition in a tower, for the selector cards on the main dashboard. */
  function summary(towerId, now = Date.now()) {
    const s = snapshot(towerId, now);
    if (!s) return null;
    const liftBad = s.lifts.filter((l) => l.state === LIFT_STATE.FAULT || l.state === LIFT_STATE.OUT_OF_SERVICE);
    const w = s.water;
    const waterCritical = w.tankStatus === TANK_STATE.CRITICAL;
    const waterWarn = w.tankStatus !== TANK_STATE.NORMAL || w.pumpsFaulted.length > 0;
    const severity = s.fire.status === STATE.ALERT || s.leak.status === STATE.ALERT || waterCritical ? 'critical'
      : (s.fire.status !== STATE.NORMAL || s.leak.status !== STATE.NORMAL || liftBad.length || waterWarn) ? 'warning'
      : 'normal';
    return {
      towerId,
      name: s.def.name,
      registerName: s.def.registerName,
      severity,
      fire: s.fire.status,
      leak: s.leak.status,
      water: w.tankStatus,
      minTankPct: w.minPct,
      pumpsFaulted: w.pumpsFaulted.length,
      liftsTotal: s.lifts.length,
      liftsAvailable: s.lifts.filter((l) => l.state === LIFT_STATE.RUNNING || l.state === LIFT_STATE.IDLE).length,
      kw: s.electricity ? s.electricity.towerKw : null,
      openEvents: s.events.filter((e) => !e.clearedAt).length,
    };
  }

  return {
    update,
    snapshot,
    summary,
    triggerDemo,
    towers: TOWERS,
    get config() { return cfg; },
  };
}
