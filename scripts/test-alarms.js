/** Headless behavioural test of the alarm engine + store, with time fast-forwarded. */
import { createAlarmEngine, SEVERITY, QUALITY } from '../src/limits.js';
import { createStore } from '../src/store.js';
import { POINT_BY_ID, GROUPS, SUBSTATIONS, POINTS } from '../src/register.js';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
};

const P = POINT_BY_ID['TW-01'];               // 15 kW rated, warn/alarm derived
const pts = [P];
console.log(`\n  Point ${P.id}: rated ${P.ratedKw} kW · warn ${P.warnKw} kW · alarm ${P.alarmKw} kW\n`);

const engine = createAlarmEngine({ onDelayMs: 6000, offDelayMs: 12000, deadbandPct: 0.04, staleAfterMs: 15000, offlineAfterMs: 40000, reArmMs: 90000 });
let t = 1_700_000_000_000;
const step = 2000;
const feed = (kW, ticks = 1, quality = 'good') => {
  for (let i = 0; i < ticks; i++) {
    t += step;
    const m = new Map([[P.id, { kW, ts: t, quality }]]);
    engine.update(pts, m, t, { daylight: true });
  }
};
const silence = (ticks) => { for (let i = 0; i < ticks; i++) { t += step; engine.update(pts, new Map(), t, { daylight: true }); } };

// 1. normal load raises nothing
feed(12, 10);
ok('normal load raises no alarm', engine.active.length === 0);

// 2. a SINGLE spike over the limit must not trip (on-delay)
feed(30, 1);
ok('single over-limit sample does not alarm (on-delay)', engine.active.length === 0);
feed(12, 5);

// 3. sustained breach raises exactly one critical episode
feed(30, 8);
ok('sustained breach raises an alarm', engine.active.length === 1, JSON.stringify(engine.active.map(e=>e.severity)));
ok('alarm is critical', engine.active[0]?.severity === SEVERITY.CRITICAL);

// 4. anti-flood — 60 more ticks over limit must NOT add episodes
feed(32, 60);
ok('no alarm flooding: still exactly 1 episode after 60 more breaching ticks', engine.active.length === 1, `got ${engine.active.length}`);
ok('peak tracked', engine.active[0].peakKw >= 30);

// 5. hysteresis — sitting just under the limit must NOT clear it
const justUnder = P.alarmKw * 0.99;
feed(justUnder, 15);
ok('value inside the deadband does not clear the alarm', engine.active.length === 1 && !engine.active[0].clearedAt);

// 6. acknowledge
const key = engine.active[0].key;
engine.ack(key, 'tester');
ok('acknowledged alarm stays open until cleared', engine.active.length === 1 && !!engine.active[0].ackedAt);

// 7. clearing well below the limit, after off-delay
feed(11, 12);
const afterClear = engine.active;
ok('alarm clears once value is clear of the deadband', afterClear.length === 0, `still ${afterClear.length} open`);
ok('cleared episode is in the history log', engine.history.length === 1);
ok('history records raised/acked/cleared', !!(engine.history[0].raisedAt && engine.history[0].ackedAt && engine.history[0].clearedAt));

// 8. re-arm blocks an immediate same-severity re-raise
feed(31, 10);
ok('re-arm window suppresses an immediate re-alarm', engine.active.length === 0, `got ${engine.active.length}`);

// 9. ... but the alarm does return after the re-arm window
t += 95_000;
feed(31, 8);
ok('alarm returns after the re-arm window elapses', engine.active.length === 1);
engine.ackAll('tester');
feed(11, 12);
t += 95_000;

// 10. ringback — an alarm that clears BEFORE being acked stays visible
feed(31, 8);
ok('new episode raised', engine.active.length === 1);
feed(11, 12);
ok('cleared-but-unacked episode remains visible (ringback)', engine.active.length === 1 && !!engine.active[0].clearedAt, `active=${engine.active.length}`);
ok('ringback episode is marked cleared-unacked', engine.active[0]?.state === 'cleared-unacked');
engine.ack(engine.active[0].key, 'tester');
ok('acking a ringback closes it', engine.active.length === 0);

// 11. offline is a distinct state, not a zero reading
silence(25); // 50s of silence > offlineAfterMs
const commsEp = engine.active.find((e) => e.kind === 'comms');
ok('loss of comms raises a comms alarm', !!commsEp);
ok('comms alarm is distinguishable from an over-limit alarm', commsEp?.kind === 'comms' && commsEp?.severity === SEVERITY.WARNING);
ok('point quality reports offline', engine.qualityOf(P.id) === QUALITY.OFFLINE);

// 12. comms restore clears it
feed(12, 3);
ok('comms alarm clears when data returns', !engine.active.some((e) => e.kind === 'comms' && !e.clearedAt));

// 13. bad quality is separate from offline
feed(12, 3, 'bad');
ok('bad quality is detected', engine.qualityOf(P.id) === QUALITY.BAD);

// 14. start-up grace: never-heard-from is "awaiting data", not "comms lost"
const fresh = createAlarmEngine({ offlineAfterMs: 40000 });
let ft = Date.now();
for (let i = 0; i < 3; i++) { ft += 1000; fresh.update(pts, new Map(), ft, { daylight: true }); }
ok('a point never yet heard from raises no comms alarm at start-up', fresh.active.length === 0, `got ${fresh.active.length}`);
ok('...and reports quality "pending", not "offline"', fresh.qualityOf(P.id) === QUALITY.PENDING, fresh.qualityOf(P.id));
ft += 45000;
fresh.update(pts, new Map(), ft, { daylight: true });
ok('...but does alarm once the start-up grace has elapsed', fresh.active.some((e) => e.kind === 'comms'));

// 15. store: smoothing + offline points are not counted as zero
const store = createStore(POINTS, GROUPS, SUBSTATIONS, { smoothingTauMs: 6000 });
let ts = 1_700_000_000_000;
for (let i = 0; i < 10; i++) {
  ts += 2000;
  store.ingest({ ts, readings: POINTS.filter(p => p.monitored).map(p => ({ id: p.id, kW: p.ratedKw * 0.8, ts, quality: 'good' })), daylight: true });
}
const siteFull = store.site.netKw;
ok('store rolls up the whole site', siteFull > 0);
ts += 2000;
store.ingest({ ts, readings: POINTS.filter(p => p.monitored && p.id !== 'TW-01').map(p => ({ id: p.id, kW: p.ratedKw * 0.8, ts, quality: 'good' })), daylight: true });
ok('a point missing from the payload is counted offline, not zero', store.site.offline === 1, `offline=${store.site.offline}`);
ok('unmonitored register entries are excluded from the offline count', store.site.reporting === POINTS.filter(p=>p.monitored).length - 1);

const spiky = createStore([POINT_BY_ID['TW-01']], GROUPS, SUBSTATIONS, { smoothingTauMs: 6000 });
let ts2 = 1_700_000_000_000;
for (const v of [15, 15, 15, 60, 15, 15]) { ts2 += 2000; spiky.ingest({ ts: ts2, readings: [{ id: 'TW-01', kW: v, ts: ts2, quality: 'good' }], daylight: true }); }
const sv = spiky.pointView(POINT_BY_ID['TW-01'], null);
ok('a single 60 kW spike is smoothed well below raw', sv.value < 40 && sv.value > 15, `smoothed=${sv.value.toFixed(1)}`);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
