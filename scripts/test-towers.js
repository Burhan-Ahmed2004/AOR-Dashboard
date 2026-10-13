/**
 * Behavioural tests for the tower monitoring model.
 *
 * Covers the three properties that matter most and are easiest to get wrong:
 * tower isolation, event de-duplication for a continuously active condition,
 * and the register-derived facts staying register-derived.
 *
 *   node scripts/test-towers.js
 */

import {
  createTowerModel, TOWERS, STATE, LIFT_STATE, ALARM_PANEL, TANK_STATE, PUMP_STATE,
} from '../src/towers.js';
import * as register from '../src/register.js';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
};

/** Minimal store stub — the model only needs pointView(). */
const stubStore = {
  pointView(point) {
    return {
      ...point,
      value: point.ratedKw * 0.8,
      expected: point.ratedKw * 0.75,
      energyKwh: 12.5,
      peakKw: point.ratedKw,
      history: [{ t: Date.now(), v: point.ratedKw * 0.8, e: point.ratedKw * 0.75 }],
      lastTs: Date.now(),
      deltaVsExpected: 0.066,
    };
  },
};

// Event probabilities set to zero so only deliberate triggers fire; otherwise
// a random background event could make these assertions flaky.
const quiet = {
  leakChance: 0, fireChance: 0, sensorFaultChance: 0,
  sensorOfflineChance: 0, liftFaultChance: 0,
  pumpFaultChance: 0, levelOfflineChance: 0,
};

console.log('\n  Tower model\n');

// --- 1. register-derived facts -------------------------------------------
const m = createTowerModel(register, stubStore, quiet);
ok('two towers are defined', TOWERS.length === 2);
ok('tower 1 maps to the register name Tower C-6', TOWERS[0].registerName === 'Tower C-6');
ok('tower 2 maps to the register name Tower C-7', TOWERS[1].registerName === 'Tower C-7');

const s1 = m.snapshot('T1');
const s2 = m.snapshot('T2');
ok('T1 lift count comes from the register (VT-TWR-C6 = 4)', s1.lifts.length === register.POINT_BY_ID['VT-TWR-C6'].units, `got ${s1.lifts.length}`);
ok('T2 lift count comes from the register (VT-TWR-C7 = 4)', s2.lifts.length === register.POINT_BY_ID['VT-TWR-C7'].units, `got ${s2.lifts.length}`);
ok('electricity point is flagged as shared between the towers', s1.electricity.shared === true && s1.electricity.sharedPointId === 'ADM-TWR-C6C7');
ok('per-tower share is half of the shared block point', Math.abs(s1.electricity.towerKw * 2 - s1.electricity.blockKw) < 0.001);

// --- 2. sensor ids are tower-scoped --------------------------------------
ok('T1 sensor ids are prefixed T1', s1.leak.sensors.every((x) => x.id.startsWith('T1-')));
ok('T2 sensor ids are prefixed T2', s2.leak.sensors.every((x) => x.id.startsWith('T2-')));
ok('no sensor id appears in both towers',
  !s1.leak.sensors.some((a) => s2.leak.sensors.some((b) => b.id === a.id)));

// --- 3. everything starts normal -----------------------------------------
ok('T1 starts with fire normal', s1.fire.status === STATE.NORMAL);
ok('T1 starts with leak normal', s1.leak.status === STATE.NORMAL);
ok('alarm panel starts inactive', s1.fire.panel.state === ALARM_PANEL.INACTIVE);
ok('no events at start', s1.events.length === 0 && s2.events.length === 0);

// --- 4. TOWER ISOLATION ---------------------------------------------------
let t0 = Date.now();
m.triggerDemo('T1', 'fire', t0);
m.update(t0);
const a1 = m.snapshot('T1'), a2 = m.snapshot('T2');
ok('fire in T1 raises T1 fire status', a1.fire.status === STATE.ALERT);
ok('fire in T1 activates the T1 alarm panel', a1.fire.panel.state === ALARM_PANEL.ACTIVE);
ok('fire in T1 creates exactly one T1 event', a1.events.filter((e) => e.kind === 'fire').length === 1);
ok('ISOLATION: T2 fire status stays normal', a2.fire.status === STATE.NORMAL, a2.fire.status);
ok('ISOLATION: T2 alarm panel stays inactive', a2.fire.panel.state === ALARM_PANEL.INACTIVE);
ok('ISOLATION: T2 has no events', a2.events.length === 0, `got ${a2.events.length}`);
ok('every event carries its own tower id', a1.events.every((e) => e.towerId === 'T1'));

// --- 5. DE-DUPLICATION of a continuously active condition ----------------
// The condition stays active across many ticks; it must not re-raise.
let t = t0;
for (let i = 0; i < 60; i++) { t += 1000; m.update(t); }
const held = m.snapshot('T1', t);
ok('a continuously active fire stays active', held.fire.status === STATE.ALERT);
ok('DE-DUP: 60 ticks of an active fire produce no extra events',
  held.events.filter((e) => e.kind === 'fire').length === 1,
  `got ${held.events.filter((e) => e.kind === 'fire').length}`);

// --- 6. clearing ----------------------------------------------------------
t += 90000;                        // past the demo clear window
m.update(t);
const cleared = m.snapshot('T1', t);
ok('fire clears once the condition ends', cleared.fire.status === STATE.NORMAL, cleared.fire.status);
ok('alarm panel returns to inactive', cleared.fire.panel.state === ALARM_PANEL.INACTIVE);
ok('the event is closed rather than deleted', cleared.events.some((e) => e.kind === 'fire' && e.clearedAt));

// --- 7. leak and lift paths ----------------------------------------------
m.triggerDemo('T2', 'leak', t);
m.update(t);
const leak = m.snapshot('T2', t);
ok('leak raises on T2', leak.leak.status === STATE.ALERT);
ok('leak reports a location and floor', leak.leak.alerting[0].label && leak.leak.alerting[0].floor);
ok('ISOLATION: T1 leak unaffected', m.snapshot('T1', t).leak.status === STATE.NORMAL);

m.triggerDemo('T2', 'lift', t);
m.update(t);
const lifts = m.snapshot('T2', t);
ok('a lift fault is reported', lifts.lifts.some((l) => l.state === LIFT_STATE.FAULT));
ok('faulty lift reduces availability',
  m.summary('T2', t).liftsAvailable < m.summary('T2', t).liftsTotal);

// --- 8. summary severity --------------------------------------------------
ok('summary marks T2 critical while a leak is active', m.summary('T2', t).severity === 'critical');
m.triggerDemo('T2', 'reset', t);
m.update(t);
ok('reset returns T2 to normal', m.summary('T2', t).severity === 'normal', m.summary('T2', t).severity);

// --- 9. water: tanks ------------------------------------------------------
console.log('\n  Water system\n');

const w1 = m.snapshot('T1', t).water;
ok('three tanks are modelled', w1.tanks.length === 3, `got ${w1.tanks.length}`);
ok('every tank reports a percentage and a capacity',
  w1.tanks.every((x) => x.pct >= 0 && x.pct <= 100 && x.capacityL > 0));
ok('tank ids are tower-scoped', w1.tanks.every((x) => x.id.startsWith('T1-')));
ok('no tank id appears in both towers',
  !w1.tanks.some((a) => m.snapshot('T2', t).water.tanks.some((b) => b.id === a.id)));
ok('litres follow from percentage and capacity',
  Math.abs(w1.tanks[0].litres - (w1.tanks[0].pct / 100) * w1.tanks[0].capacityL) < 1);

// --- 10. water: pump control follows tank level ---------------------------
// Drive the roof tank below the start setpoint and the duty transfer pump
// must start; it is control logic, not a coin flip.
m.triggerDemo('T1', 'tanklow', t);
t += 1000; m.update(t);
const low = m.snapshot('T1', t).water;
const roof = low.tanks.find((x) => x.key === 'ROOF');
ok('a low roof tank reads as a critical level', roof.state === TANK_STATE.CRITICAL, roof.state);
ok('a critical tank level raises a critical event',
  m.snapshot('T1', t).events.some((e) => e.kind === 'tank' && e.severity === 'critical' && !e.clearedAt));
ok('the duty transfer pump starts on low level',
  low.pumps.find((p) => p.key === 'TP1').state === PUMP_STATE.RUNNING,
  low.pumps.find((p) => p.key === 'TP1').state);
ok('ISOLATION: T2 tanks are unaffected by a T1 tank alarm',
  m.snapshot('T2', t).water.tanks.every((x) => x.state === TANK_STATE.NORMAL));
ok('ISOLATION: T2 severity stays normal', m.summary('T2', t).severity === 'normal');

// A level sitting in one alarm band must raise one event, not one per tick.
// Recovering into a different band is a different condition and SHOULD raise
// its own event — de-duplication is per condition, not per tank.
const critEvents = () => m.snapshot('T1', t).events.filter((e) => e.kind === 'tank' && e.severity === 'critical');
ok('one critical level event is open', critEvents().length === 1, `got ${critEvents().length}`);
for (let i = 0; i < 8; i++) { t += 1000; m.update(t); }
ok('DE-DUP: 8 ticks of a low tank produce no extra critical events',
  critEvents().length === 1, `got ${critEvents().length}`);
ok('a level recovering out of the critical band closes that event',
  critEvents()[0].clearedAt !== null);
ok('ESCALATION: the recovered level raises its own low-band event',
  m.snapshot('T1', t).events.some((e) => e.kind === 'tank' && e.severity === 'warning' && !e.clearedAt));

// --- 11. water: duty/standby changeover -----------------------------------
m.triggerDemo('T1', 'reset', t);
t += 1000; m.update(t);
m.triggerDemo('T1', 'tanklow', t);
t += 1000; m.update(t);
m.triggerDemo('T1', 'pump', t);
t += 1000; m.update(t);
const chg = m.snapshot('T1', t).water;
ok('a faulted duty pump reports a fault',
  chg.pumps.find((p) => p.key === 'TP1').state === PUMP_STATE.FAULT);
ok('the standby pump takes over when the duty pump faults',
  chg.pumps.find((p) => p.key === 'TP2').state === PUMP_STATE.RUNNING,
  chg.pumps.find((p) => p.key === 'TP2').state);
ok('a pump fault raises an event', chg.pumps.length && m.snapshot('T1', t).events.some((e) => e.kind === 'pump'));

// --- 12. water: an offline transmitter never reads as live ----------------
const offModel = createTowerModel(register, stubStore, { ...quiet, levelOfflineChance: 1 });
let ot = Date.now();
offModel.update(ot);
const offTanks = offModel.snapshot('T1', ot).water.tanks;
ok('an offline level transmitter reports no current value',
  offTanks.every((x) => x.offline && x.pct === null));
ok('the last known level is carried separately, not as a live reading',
  offTanks.every((x) => typeof x.lastKnownPct === 'number'));
ok('an offline transmitter raises an event',
  offModel.snapshot('T1', ot).events.some((e) => e.title === 'Level transmitter offline'));

// --- 13. reset clears the water system too --------------------------------
m.triggerDemo('T1', 'reset', t);
t += 1000; m.update(t);
ok('reset returns every tank to normal',
  m.snapshot('T1', t).water.tanks.every((x) => x.state === TANK_STATE.NORMAL));
ok('reset clears pump faults',
  m.snapshot('T1', t).water.pumps.every((p) => p.state !== PUMP_STATE.FAULT));
ok('reset returns T1 to normal severity', m.summary('T1', t).severity === 'normal',
  m.summary('T1', t).severity);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
