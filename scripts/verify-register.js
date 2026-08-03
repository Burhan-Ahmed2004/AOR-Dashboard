/**
 * Register reconciliation check.
 * Asserts that the point register still adds up to the totals the source document
 * states. Run it after ANY edit to src/register.js — if a count drifts, this
 * catches it instead of the number quietly becoming wrong on a wall display.
 *
 *   node scripts/verify-register.js
 */

import {
  POINTS,
  MONITORED_POINTS,
  SUBSTATIONS,
  TRANSFORMER_FLEET,
  SITE,
  SITE_RATED_KW,
  ratedBySubstation,
} from '../src/register.js';

let failures = 0;
const results = [];

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  results.push({ ok, label, actual, expected });
}

const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
const unitsIn = (pred) => sum(POINTS.filter(pred), (p) => p.units);

// --- counts stated in the document -----------------------------------------
const buildingGroups = ['officer-accn', 'ranks-accn', 'command-admin', 'medical-welfare'];
check('Buildings (doc G Total)', unitsIn((p) => buildingGroups.includes(p.groupId)), SITE.buildingsTotal);
check('Tube wells', unitsIn((p) => p.id.startsWith('TW-')), 14);
check('Tube wells operational/monitored', MONITORED_POINTS.filter((p) => p.id.startsWith('TW-')).length, 11);
check('Water filtration plants', unitsIn((p) => p.id.startsWith('WFP-')), 4);
check('Overhead water tanks', unitsIn((p) => p.id.startsWith('OHWT-')), 3);
check('Underground water tanks', unitsIn((p) => p.id.startsWith('UGWT-')), 42);
check('Motor pumps', unitsIn((p) => p.id.startsWith('MP-')), 84);
check('Reedbeds', unitsIn((p) => p.id.startsWith('RB-')), 4);
check('Street / flood lights', unitsIn((p) => p.id.startsWith('SL-')), 980);
check('Solar systems', unitsIn((p) => p.id.startsWith('SOL-')), 13);
check('Vertical transport (15 elevators + 5 lifts)', unitsIn((p) => p.id.startsWith('VT-')), 20);
check('Outstation facilities', unitsIn((p) => p.id.startsWith('OS-')), 16);

// --- transformer fleet reconciliation ---------------------------------------
check('Transformer units (incl. satellite)', TRANSFORMER_FLEET.unitCount, 109);
check('Installed capacity kVA', TRANSFORMER_FLEET.installedKva, 18530);

const allocated = SUBSTATIONS.reduce(
  (acc, s) => {
    const mix = s.transformers.mix || {};
    for (const [kva, n] of Object.entries(mix)) acc.mix[kva] = (acc.mix[kva] || 0) + n;
    acc.count += Object.values(mix).reduce((a, b) => a + b, 0) + (s.transformers.satellite || 0);
    acc.kva += Object.entries(mix).reduce((a, [k, n]) => a + Number(k) * n, 0);
    return acc;
  },
  { mix: {}, count: 0, kva: 0 }
);
check('Allocated transformer units == fleet', allocated.count, TRANSFORMER_FLEET.unitCount);
check('Allocated kVA == fleet kVA', allocated.kva, TRANSFORMER_FLEET.installedKva);
for (const [kva, n] of Object.entries(TRANSFORMER_FLEET.mix))
  check(`  ${kva} kVA units allocated`, allocated.mix[kva] || 0, n);

// --- limits sanity -----------------------------------------------------------
const badLimits = MONITORED_POINTS.filter((p) => {
  if (p.lowLimitMode === 'relative')
    return !(p.lowAlarmRatio > 0 && p.lowAlarmRatio < p.lowWarnRatio && p.lowWarnRatio < 1);
  if (p.role === 'generation') return !(p.lowAlarmKw < p.lowWarnKw && p.lowWarnKw < p.ratedKw);
  return !(p.ratedKw <= p.warnKw && p.warnKw < p.alarmKw);
});
check('Points with a coherent limit ladder', badLimits.length, 0);
if (badLimits.length) for (const p of badLimits.slice(0, 5)) console.log('   offender:', p.id, p.ratedKw, p.warnKw, p.alarmKw);

const dupes = POINTS.map((p) => p.id).filter((id, i, a) => a.indexOf(id) !== i);
check('Duplicate tag ids', dupes.length, 0);

// --- report ------------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
console.log('\n  Register reconciliation — AOR / GE(N) Maint Isld\n');
for (const r of results)
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${pad(r.label, 42)} ${pad(r.actual, 8)} expected ${r.expected}`);

const bySub = ratedBySubstation();
console.log('\n  Rated demand vs installed capacity');
for (const s of SUBSTATIONS) {
  const load = bySub[s.id] || 0;
  const util = s.capacityKw ? ((load / s.capacityKw) * 100).toFixed(0) + '%' : '—';
  const cap = s.capacityKw ? s.capacityKw.toLocaleString('en-US') + ' kW' : 'not in register';
  console.log(`    ${pad(s.name, 22)} ${pad(load.toFixed(0) + ' kW', 12)} of ${pad(cap, 16)} (${util})  ${s.transformerCount} tx`);
}
console.log(`\n  Site rated demand ${SITE_RATED_KW.toFixed(0)} kW across ${MONITORED_POINTS.length} monitored points`);
console.log(`  ${POINTS.length - MONITORED_POINTS.length} register entries are not instrumented\n`);

if (failures) {
  console.error(`  ${failures} check(s) FAILED\n`);
  process.exit(1);
}
console.log('  All checks passed.\n');
