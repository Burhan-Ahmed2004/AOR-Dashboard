/**
 * LOAD SIMULATOR — stand-in for the SCADA feed
 * ============================================
 * Shared by the browser (offline demo mode) and the mock server (SSE/REST mode)
 * so both produce the same physics. DELETE THIS FILE once real telemetry is wired;
 * nothing else imports it except `source.js`.
 *
 * It models what real feeder data actually looks like:
 *  · a diurnal demand curve per asset class (residential peaks at night, offices
 *    at midday, street lighting only after dusk, solar only in daylight)
 *  · AR(1) mean-reverting noise, so the trace wanders like a real meter rather
 *    than jittering white-noise style
 *  · occasional load excursions that push a point over its limit (so the alarm
 *    path is genuinely exercised in a demo)
 *  · occasional comms dropouts and sensor faults (so the offline/bad-quality
 *    states are exercised too — an offline meter is never reported as 0 kW,
 *    it is simply absent from the payload)
 */

/** Hourly demand factors, 0-23, relative to the point's rated demand. */
const PROFILES = {
  residential: [0.45, 0.4, 0.38, 0.37, 0.38, 0.45, 0.62, 0.72, 0.7, 0.6, 0.55, 0.55, 0.58, 0.56, 0.54, 0.56, 0.63, 0.75, 0.88, 0.97, 1.0, 0.95, 0.8, 0.6],
  office: [0.2, 0.18, 0.17, 0.17, 0.18, 0.2, 0.28, 0.45, 0.75, 0.92, 0.97, 1.0, 0.9, 0.95, 0.98, 0.94, 0.8, 0.55, 0.38, 0.3, 0.27, 0.25, 0.23, 0.21],
  continuous: [0.72, 0.7, 0.68, 0.68, 0.69, 0.72, 0.78, 0.85, 0.92, 0.96, 0.98, 1.0, 0.97, 0.96, 0.95, 0.93, 0.9, 0.88, 0.86, 0.84, 0.82, 0.79, 0.76, 0.74],
  pumping: [0.35, 0.3, 0.28, 0.3, 0.45, 0.75, 0.95, 1.0, 0.85, 0.6, 0.5, 0.48, 0.5, 0.5, 0.5, 0.55, 0.7, 0.9, 0.98, 0.85, 0.65, 0.5, 0.42, 0.38],
  lighting: [1.0, 1.0, 1.0, 1.0, 1.0, 0.85, 0.25, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.15, 0.7, 1.0, 1.0, 1.0, 1.0, 1.0],
  solar: [0, 0, 0, 0, 0, 0.02, 0.12, 0.3, 0.52, 0.72, 0.88, 0.97, 1.0, 0.97, 0.88, 0.72, 0.5, 0.28, 0.1, 0.01, 0, 0, 0, 0],
};

/**
 * Smoothly interpolate a 24-slot profile at a fractional hour.
 * Exported as `expectedFactor` because it is also the dashboard's model of
 * "typical load for this hour" — the reference every reading is compared against.
 * IN PRODUCTION: replace that use with a trailing same-hour median from your
 * historian. The simulation use stays here.
 */
export function expectedFactor(name, hour) {
  return profileAt(name, hour);
}

function profileAt(name, hour) {
  const p = PROFILES[name] || PROFILES.continuous;
  const h = ((hour % 24) + 24) % 24;
  const i = Math.floor(h);
  const t = h - i;
  const a = p[i];
  const b = p[(i + 1) % 24];
  const ease = t * t * (3 - 2 * t); // smoothstep — no kinks on the hour
  return a + (b - a) * ease;
}

/** Fraction of full sun right now (0-1). Drives solar output and daylight gating. */
export function solarFactor(date = new Date()) {
  return profileAt('solar', date.getHours() + date.getMinutes() / 60);
}

/**
 * Whether irradiance is high enough for a solar performance limit to mean
 * anything. Kept clear of the dawn/dusk shoulders on purpose.
 */
export function isDaylight(date = new Date()) {
  return solarFactor(date) > 0.2;
}

/** Small deterministic PRNG so runs are reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashId(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * NOTE ON THE EVENT RATES BELOW.
 * These are per-point, per-tick probabilities, so the fraction of points in a
 * given state at any moment is roughly  chance x (duration / tickInterval)  —
 * not the chance itself. At a 2 s tick a 0.02 chance of a ~50 s excursion would
 * leave ~40% of points excursing simultaneously, which is nonsense. They are
 * tuned so that, in steady state, roughly:
 *      ~5% of points are in a load excursion   (a handful of live alarms)
 *      ~3% have lost comms                     (exercises the offline state)
 *      <1% report bad quality
 */
export const SIM_DEFAULTS = {
  seed: 20260803,
  noise: 0.05, // AR(1) innovation, fraction of rated
  reversion: 0.18, // pull back toward the profile each tick
  excursionChance: 0.0015, // per point per tick
  excursionMinMs: 25000,
  excursionMaxMs: 75000,
  dropoutChance: 0.0005, // per point per tick
  dropoutMinMs: 45000,
  dropoutMaxMs: 120000,
  badQualityChance: 0.0003, // per point per tick
};

/**
 * @param points  monitored point definitions (need id, ratedKw, role, groupId, alarmKw)
 * @param groups  group definitions (supply the demand `profile`)
 */
export function createSimulator(points, groups, options = {}) {
  const cfg = { ...SIM_DEFAULTS, ...options };
  const rand = mulberry32(cfg.seed);
  const profileByGroup = Object.fromEntries(groups.map((g) => [g.id, g.profile]));

  const state = new Map();
  for (const p of points) {
    // Per-point phase offset so identical asset classes don't move in lockstep.
    const r = mulberry32(hashId(p.id));
    state.set(p.id, {
      value: p.ratedKw * 0.7,
      phase: r() * 2 - 1,
      excursionUntil: 0,
      excursionGain: 1,
      dropoutUntil: 0,
      badUntil: 0,
    });
  }

  /**
   * Produce one sample set.
   * @returns {{ts:number, readings:Array<{id:string,kW:number,ts:number,quality:string}>, daylight:boolean}}
   *          Points in comms dropout are ABSENT from `readings` — they are not
   *          reported as zero. That distinction is the whole point.
   */
  function sample(now = Date.now(), simDate = new Date(now)) {
    const hour = simDate.getHours() + simDate.getMinutes() / 60 + simDate.getSeconds() / 3600;
    const readings = [];

    for (const p of points) {
      const s = state.get(p.id);
      if (!s) continue;

      if (now < s.dropoutUntil) continue; // comms lost — report nothing at all

      // Start a dropout?
      if (rand() < cfg.dropoutChance) {
        s.dropoutUntil = now + cfg.dropoutMinMs + rand() * (cfg.dropoutMaxMs - cfg.dropoutMinMs);
        continue;
      }

      const profile = p.role === 'generation' ? 'solar' : profileByGroup[p.groupId] || 'continuous';
      let target = p.ratedKw * profileAt(profile, hour + s.phase * 0.4);

      // Excursions — deliberately push past the limit so alarms are exercised.
      if (now < s.excursionUntil) {
        target *= s.excursionGain;
      } else if (rand() < cfg.excursionChance) {
        s.excursionUntil = now + cfg.excursionMinMs + rand() * (cfg.excursionMaxMs - cfg.excursionMinMs);
        // Aim somewhere between the warning and well past the alarm limit.
        s.excursionGain = p.role === 'generation' ? 0.25 + rand() * 0.2 : 1.25 + rand() * 0.45;
      }

      // AR(1) mean reversion toward target, with proportional noise.
      const innov = (rand() * 2 - 1) * cfg.noise * Math.max(p.ratedKw, 1);
      s.value += (target - s.value) * cfg.reversion + innov;
      s.value = Math.max(0, s.value);

      let quality = 'good';
      if (now < s.badUntil) quality = 'bad';
      else if (rand() < cfg.badQualityChance) {
        s.badUntil = now + 20000 + rand() * 30000;
        quality = 'bad';
      }

      readings.push({
        id: p.id,
        kW: Math.round(s.value * 100) / 100,
        ts: now,
        quality,
      });
    }

    return { ts: now, readings, daylight: isDaylight(simDate) };
  }

  return { sample, config: cfg };
}
