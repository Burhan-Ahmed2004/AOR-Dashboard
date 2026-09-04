/**
 * ALARM ENGINE — consumption-limit evaluation
 * ===========================================
 * Deliberately modelled on control-room alarm practice (ISA-18.2 flavoured) rather
 * than a naive `value > limit` test, because the naive version floods.
 *
 * Guarantees:
 *  · THREE severity tiers only — normal → warning → critical. No fourth tier.
 *  · Data quality is a SEPARATE axis from severity. An offline meter and a meter
 *    reading 0 kW are different facts and never collapse into each other.
 *  · ON-DELAY  — a limit must be exceeded continuously for `onDelayMs` before an
 *    alarm is raised, so a single noisy sample cannot trip it.
 *  · HYSTERESIS + OFF-DELAY — clearing requires falling `deadbandPct` below the
 *    limit for `offDelayMs`, so a value hovering on the threshold cannot chatter.
 *  · ONE EPISODE PER POINT — while an alarm is open, further breaches escalate the
 *    existing episode instead of raising a new one. This is the anti-flood rule.
 *  · RE-ARM — after an episode closes, the same point cannot re-raise at the same
 *    severity for `reArmMs`. A HIGHER severity always bypasses re-arm.
 *  · LATCHED + ACKNOWLEDGED — an alarm persists until acknowledged, and an alarm
 *    that clears before it is acknowledged stays visible (ringback) so nothing
 *    ever disappears silently.
 *  · FULL AUDIT — every episode records raised / acknowledged / cleared times and
 *    the peak value reached.
 */

export const SEVERITY = { NORMAL: 'normal', WARNING: 'warning', CRITICAL: 'critical' };
export const SEV_RANK = { normal: 0, warning: 1, critical: 2 };

/**
 * Data quality — orthogonal to severity.
 * PENDING is deliberately distinct from OFFLINE: at start-up we have not yet
 * heard from a meter, which is not the same as knowing it is unreachable.
 */
export const QUALITY = { GOOD: 'good', PENDING: 'pending', STALE: 'stale', OFFLINE: 'offline', BAD: 'bad' };

export const DEFAULT_CONFIG = {
  onDelayMs: 6000, // breach must persist this long before alarming
  offDelayMs: 12000, // must stay clear this long before de-escalating
  deadbandPct: 0.04, // hysteresis: clear below limit * (1 - deadband)
  staleAfterMs: 15000, // no fresh sample -> reading is stale
  offlineAfterMs: 40000, // no fresh sample -> meter is considered offline
  reArmMs: 90000, // min gap before the same point re-alarms at the same severity
  maxEpisodeLog: 500,
};

export function createAlarmEngine(userConfig = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...userConfig };
  /** @type {Map<string, object>} per-point evaluation state */
  const states = new Map();
  /** @type {Map<string, object>} open + ringback episodes, keyed by episode key */
  const open = new Map();
  /** @type {object[]} closed episodes, newest first */
  const history = [];
  let seq = 0;
  const startedAt = Date.now();

  function stateFor(pointId) {
    let s = states.get(pointId);
    if (!s) {
      s = {
        pointId,
        severity: SEVERITY.NORMAL, // confirmed CONDITION — drives the display
        severityKind: null,
        severityLimitKw: null,
        quality: QUALITY.OFFLINE,
        candidate: null,
        candidateSince: 0,
        clearSince: 0,
        episodeKey: null, // current ANNUNCIATION, if any
        lastClosedAt: 0,
        lastClosedSeverity: SEVERITY.NORMAL,
        suppressedUntil: 0, // re-arm quiet window, surfaced in the point detail
        valueKw: null,
        lastGoodTs: 0,
      };
      states.set(pointId, s);
    }
    return s;
  }

  /**
   * Decide what severity the current value deserves, ignoring timing.
   * Returns { severity, kind, limitKw } — kind is 'high' | 'low' | null.
   */
  function classify(point, valueKw, ctx, expectedKw) {
    const abs = valueKw;

    // --- under-performance limits -----------------------------------------
    // Two modes: absolute (a fixed kW floor) and relative (a ratio of the output
    // expected for this hour). Relative is what generation needs — a fixed floor
    // would flag every solar array at dawn for the crime of the sun being low.
    const windowOpen = point.lowLimitWindow === 'daylight' ? ctx.daylight === true : true;
    if (windowOpen) {
      if (point.lowLimitMode === 'relative') {
        // Below a floor of expected output the ratio stops being meaningful.
        if (expectedKw > 0.5) {
          const alarmAt = expectedKw * (point.lowAlarmRatio ?? 0.35);
          const warnAt = expectedKw * (point.lowWarnRatio ?? 0.6);
          if (abs <= alarmAt) return { severity: SEVERITY.CRITICAL, kind: 'low', limitKw: alarmAt };
          if (abs <= warnAt) return { severity: SEVERITY.WARNING, kind: 'low', limitKw: warnAt };
        }
      } else if (point.lowAlarmKw != null) {
        if (abs <= point.lowAlarmKw) return { severity: SEVERITY.CRITICAL, kind: 'low', limitKw: point.lowAlarmKw };
        if (point.lowWarnKw != null && abs <= point.lowWarnKw)
          return { severity: SEVERITY.WARNING, kind: 'low', limitKw: point.lowWarnKw };
      }
    }

    // --- over-consumption limits -------------------------------------------
    if (point.alarmKw != null && abs >= point.alarmKw)
      return { severity: SEVERITY.CRITICAL, kind: 'high', limitKw: point.alarmKw };
    if (point.warnKw != null && abs >= point.warnKw)
      return { severity: SEVERITY.WARNING, kind: 'high', limitKw: point.warnKw };

    return { severity: SEVERITY.NORMAL, kind: null, limitKw: null };
  }

  /**
   * Hysteresis check against the limit the point is CURRENTLY sitting on
   * (tracked in state, so it works for dynamic limits too).
   * Clearing a HIGH alarm needs value < limit*(1-deadband).
   * Clearing a LOW alarm needs value > limit*(1+deadband).
   */
  function isClearOf(valueKw, kind, limitKw) {
    if (limitKw == null) return true;
    const d = cfg.deadbandPct;
    return kind === 'low' ? valueKw > limitKw * (1 + d) : valueKw < limitKw * (1 - d);
  }

  function openEpisode(point, { severity, kind, limitKw }, valueKw, now) {
    seq += 1;
    const ep = {
      key: `${point.id}#${seq}`,
      pointId: point.id,
      pointName: point.name,
      groupId: point.groupId,
      substationId: point.substationId,
      location: point.location,
      kind, // 'high' | 'low' | 'comms'
      severity, // highest severity reached
      currentSeverity: severity,
      limitKw,
      triggerKw: valueKw,
      valueKw,
      peakKw: valueKw,
      raisedAt: now,
      ackedAt: null,
      ackedBy: null,
      clearedAt: null,
      state: 'active',
      escalations: [],
      unit: 'kW',
    };
    open.set(ep.key, ep);
    return ep;
  }

  function closeEpisode(ep, now) {
    ep.clearedAt = now;
    ep.state = ep.ackedAt ? 'closed' : 'cleared-unacked';
    if (ep.state === 'closed') {
      open.delete(ep.key);
      history.unshift(ep);
      if (history.length > cfg.maxEpisodeLog) history.length = cfg.maxEpisodeLog;
    }
  }

  /**
   * Advance the engine one tick.
   * @param points   monitored point definitions
   * @param readings Map<id, {kW, ts, quality}> — latest sample per point
   * @param now      epoch ms
   * @param ctx      { daylight: boolean }
   */
  function update(points, readings, now, ctx = {}) {
    const events = [];

    for (const point of points) {
      const s = stateFor(point.id);
      const r = readings.get(point.id);

      // --- quality axis -----------------------------------------------------
      let quality = QUALITY.OFFLINE;
      if (r) {
        if (r.quality === 'bad') quality = QUALITY.BAD;
        else {
          const age = now - r.ts;
          if (age > cfg.offlineAfterMs) quality = QUALITY.OFFLINE;
          else if (age > cfg.staleAfterMs) quality = QUALITY.STALE;
          else quality = QUALITY.GOOD;
        }
        if (quality === QUALITY.GOOD) s.lastGoodTs = r.ts;
        s.valueKw = r.kW;
      }
      // Start-up grace: a point we have NEVER received a sample from is
      // "awaiting data", not "comms lost". Without this every dashboard launch
      // opens with a burst of false comms alarms before the first frame lands.
      if (!s.lastGoodTs && !r && now - startedAt < cfg.offlineAfterMs) quality = QUALITY.PENDING;

      const prevQuality = s.quality;
      s.quality = quality;

      const commsFault = quality === QUALITY.OFFLINE || quality === QUALITY.BAD;

      // --- comms episodes: an offline meter is NOT a 0 kW reading -----------
      const commsKey = s.episodeKey && open.get(s.episodeKey)?.kind === 'comms' ? s.episodeKey : null;
      if (commsFault) {
        if (!commsKey && !s.episodeKey) {
          const ep = openEpisode(
            point,
            { severity: SEVERITY.WARNING, kind: 'comms', limitKw: null },
            s.valueKw ?? 0,
            now
          );
          ep.message =
            quality === QUALITY.BAD
              ? 'Meter reporting bad quality — value not trustworthy'
              : 'No data from meter — communications lost';
          s.episodeKey = ep.key;
          s.severity = SEVERITY.WARNING;
          events.push({ type: 'raised', episode: ep });
        }
        if (prevQuality !== quality) events.push({ type: 'quality', pointId: point.id, quality });
        continue; // limits are not evaluated on untrustworthy data
      }
      if (commsKey) {
        const ep = open.get(commsKey);
        closeEpisode(ep, now);
        s.episodeKey = ep.state === 'closed' ? null : ep.key;
        s.severity = SEVERITY.NORMAL;
        events.push({ type: 'cleared', episode: ep });
      }

      const value = s.valueKw ?? 0;
      if (r && r.expectedKw != null) s.expectedKw = r.expectedKw;
      const verdict = classify(point, value, ctx, s.expectedKw ?? 0);

      // =====================================================================
      // STAGE 1 — confirm the physical CONDITION.
      // This is what the point display shows. It is deliberately independent of
      // whether an alarm gets annunciated: a point that is over its limit must
      // read "over limit" even while annunciation is shelved, otherwise the
      // anti-flood machinery would end up hiding a genuine fault.
      // =====================================================================
      if (SEV_RANK[verdict.severity] > SEV_RANK[s.severity]) {
        if (s.candidate !== verdict.severity) {
          s.candidate = verdict.severity;
          s.candidateSince = now;
        }
        if (now - s.candidateSince >= cfg.onDelayMs) {
          s.severity = verdict.severity;
          s.severityKind = verdict.kind;
          s.severityLimitKw = verdict.limitKw;
          s.candidate = null;
          s.clearSince = 0;
        }
      } else if (SEV_RANK[verdict.severity] < SEV_RANK[s.severity]) {
        s.candidate = null;
        const kind = s.severityKind === 'comms' ? 'high' : s.severityKind || verdict.kind || 'high';
        if (isClearOf(value, kind, s.severityLimitKw)) {
          if (!s.clearSince) s.clearSince = now;
          if (now - s.clearSince >= cfg.offDelayMs) {
            s.severity = verdict.severity;
            s.severityKind = verdict.kind;
            s.severityLimitKw = verdict.limitKw;
            s.clearSince = 0;
          }
        } else {
          s.clearSince = 0; // still inside the deadband — not clear yet
        }
      } else {
        s.candidate = null;
        s.clearSince = 0;
      }

      // =====================================================================
      // STAGE 2 — reconcile ANNUNCIATION (episodes) with the confirmed condition.
      // Opening is what the re-arm window gates, never the condition itself.
      // =====================================================================
      const ep = s.episodeKey ? open.get(s.episodeKey) : null;
      const epLive = ep && !ep.clearedAt ? ep : null;

      if (s.severity === SEVERITY.NORMAL) {
        if (epLive) {
          closeEpisode(epLive, now);
          s.lastClosedAt = now;
          s.lastClosedSeverity = epLive.severity;
          s.episodeKey = epLive.state === 'closed' ? null : epLive.key;
          events.push({ type: 'cleared', episode: epLive });
        }
        s.suppressedUntil = 0;
      } else if (epLive) {
        epLive.currentSeverity = s.severity;
        if (SEV_RANK[s.severity] > SEV_RANK[epLive.severity]) {
          // Escalate the OPEN episode — never open a second one for the same point.
          epLive.severity = s.severity;
          epLive.limitKw = s.severityLimitKw;
          epLive.message = describe(point, { severity: s.severity, kind: s.severityKind, limitKw: s.severityLimitKw }, value);
          epLive.escalations.push({ at: now, severity: s.severity, valueKw: value });
          // An acknowledged alarm that gets worse must be acknowledged again.
          epLive.ackedAt = null;
          epLive.state = 'active';
          events.push({ type: 'escalated', episode: epLive });
        }
      } else {
        // Condition confirmed with nothing annunciating it. Open an episode
        // unless the re-arm window is still quieting this point at this level.
        const notWorse = SEV_RANK[s.severity] <= SEV_RANK[s.lastClosedSeverity];
        const withinReArm = now - s.lastClosedAt < cfg.reArmMs;
        if (notWorse && withinReArm && s.lastClosedAt) {
          s.suppressedUntil = s.lastClosedAt + cfg.reArmMs;
        } else {
          const spec = { severity: s.severity, kind: s.severityKind, limitKw: s.severityLimitKw };
          const fresh = openEpisode(point, spec, value, now);
          fresh.message = describe(point, spec, value);
          s.episodeKey = fresh.key;
          s.suppressedUntil = 0;
          events.push({ type: 'raised', episode: fresh });
        }
      }

      // keep the open episode's live figures current
      if (epLive) {
        epLive.valueKw = value;
        if (epLive.kind === 'low') epLive.peakKw = Math.min(epLive.peakKw, value);
        else epLive.peakKw = Math.max(epLive.peakKw, value);
      }

      if (prevQuality !== quality) events.push({ type: 'quality', pointId: point.id, quality });
    }

    return { events, states, active: activeList() };
  }

  function describe(point, { severity, kind, limitKw }, value) {
    const pct = limitKw ? Math.round((value / limitKw - 1) * 100) : 0;
    if (kind === 'low') {
      return `Output ${fmt(value)} kW is below the ${fmt(limitKw)} kW ${
        severity === SEVERITY.CRITICAL ? 'alarm' : 'warning'
      } limit`;
    }
    return `Consumption ${fmt(value)} kW exceeds the ${fmt(limitKw)} kW ${
      severity === SEVERITY.CRITICAL ? 'limit' : 'warning limit'
    } by ${pct}%`;
  }

  function fmt(n) {
    return Number(n).toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 1 : 0 });
  }

  /** Open + ringback episodes, worst first, then newest first. */
  function activeList() {
    return [...open.values()].sort((a, b) => {
      const rank = SEV_RANK[b.severity] - SEV_RANK[a.severity];
      if (rank) return rank;
      const unacked = Number(!!a.ackedAt) - Number(!!b.ackedAt);
      if (unacked) return unacked;
      return b.raisedAt - a.raisedAt;
    });
  }

  function ack(key, by = 'operator', now = Date.now()) {
    const ep = open.get(key);
    if (!ep || ep.ackedAt) return null;
    ep.ackedAt = now;
    ep.ackedBy = by;
    if (ep.clearedAt) {
      ep.state = 'closed';
      open.delete(key);
      history.unshift(ep);
      if (history.length > cfg.maxEpisodeLog) history.length = cfg.maxEpisodeLog;
      const s = states.get(ep.pointId);
      if (s && s.episodeKey === key) {
        s.episodeKey = null;
        s.lastClosedAt = now;
        s.lastClosedSeverity = ep.severity;
      }
    } else {
      ep.state = 'active-acked';
    }
    return ep;
  }

  function ackAll(by = 'operator', now = Date.now()) {
    return [...open.keys()].map((k) => ack(k, by, now)).filter(Boolean);
  }

  return {
    config: cfg,
    update,
    ack,
    ackAll,
    get active() {
      return activeList();
    },
    get history() {
      return history;
    },
    get states() {
      return states;
    },
    severityOf(pointId) {
      return states.get(pointId)?.severity ?? SEVERITY.NORMAL;
    },
    qualityOf(pointId) {
      return states.get(pointId)?.quality ?? QUALITY.OFFLINE;
    },
    /**
     * When a point is over limit but its annunciation is inside the re-arm quiet
     * window, this returns when it will be allowed to raise again (else 0).
     * The point still DISPLAYS its true condition — only the new alarm is held.
     */
    suppressedUntil(pointId) {
      const s = states.get(pointId);
      if (!s || !s.suppressedUntil) return 0;
      return s.suppressedUntil > Date.now() ? s.suppressedUntil : 0;
    },
    counts() {
      let critical = 0,
        warning = 0,
        unacked = 0,
        comms = 0;
      for (const ep of open.values()) {
        if (ep.clearedAt) continue;
        if (ep.severity === SEVERITY.CRITICAL) critical++;
        else warning++;
        if (!ep.ackedAt) unacked++;
        if (ep.kind === 'comms') comms++;
      }
      const ringback = [...open.values()].filter((e) => e.clearedAt && !e.ackedAt).length;
      return { critical, warning, unacked, comms, ringback, total: critical + warning };
    },
  };
}
