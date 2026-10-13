/** 5m/15m PM 早期方向锁定与分桶统计（非完整交易信号）。 */

export const FIVE_MINUTE_DECISION_LOCK_ELAPSED_PCT = 0.12;
export const FIFTEEN_MINUTE_DECISION_LOCK_ELAPSED_PCT = 0.12;

export const INTERVAL_SLOT_SECONDS = {
  '5m': 300,
  '15m': 900
};

const LOW_WINRATE_HOUR_DEFAULTS = {
  '5m': [
    { hour: 13, minPmGap: 0.35, minConfidence: 0.66, requireTechAlignment: true, level: 'elevated' }
  ],
  '15m': [
    { hour: 6, minPmGap: 0.40, minConfidence: 0.68, requireTechAlignment: true, level: 'strict' },
    { hour: 20, minPmGap: 0.30, minConfidence: 0.65, requireTechAlignment: true, level: 'elevated' }
  ]
};

function readIntervalDecisionEnv(env, timeframe, key, fallback) {
  const prefix = timeframe === '15m' ? 'FIFTEEN_MINUTE_DECISION' : 'FIVE_MINUTE_DECISION';
  const sharedPrefix = 'INTERVAL_PM_DECISION';
  const value = env[`${prefix}_${key}`] ?? env[`${sharedPrefix}_${key}`];
  return value ?? fallback;
}

export function buildIntervalDecisionConfig(timeframe = '5m', env = process.env) {
  const recordPrefix = timeframe === '15m' ? 'FIFTEEN_MINUTE' : 'FIVE_MINUTE';
  // 5m must finish choosing a direction before the token price becomes a
  // near-settlement 90c quote. 0.36 = 108s, leaving one poll/fetch cycle to
  // persist the lock inside the first two minutes.
  const terminalLockElapsedPct = timeframe === '15m' ? (14 / 15) : 0.36;
  const actionableMinPmGap = timeframe === '15m' ? 0.40 : 0.30;
  const hourPolicies = timeframe === '15m'
    ? [
        {
          hour: Number(readIntervalDecisionEnv(env, timeframe, 'LOW_WINRATE_PRIMARY_HOUR', 6)),
          minPmGap: Number(readIntervalDecisionEnv(env, timeframe, 'LOW_WINRATE_PRIMARY_MIN_PM_GAP', 0.40)),
          minConfidence: Number(readIntervalDecisionEnv(env, timeframe, 'LOW_WINRATE_PRIMARY_MIN_CONFIDENCE', 0.68)),
          requireTechAlignment: true,
          level: 'strict'
        },
        {
          hour: Number(readIntervalDecisionEnv(env, timeframe, 'LOW_WINRATE_SECONDARY_HOUR', 20)),
          minPmGap: Number(readIntervalDecisionEnv(env, timeframe, 'LOW_WINRATE_SECONDARY_MIN_PM_GAP', 0.30)),
          minConfidence: Number(readIntervalDecisionEnv(env, timeframe, 'LOW_WINRATE_SECONDARY_MIN_CONFIDENCE', 0.65)),
          requireTechAlignment: true,
          level: 'elevated'
        }
      ]
    : [
        {
          hour: Number(readIntervalDecisionEnv(env, timeframe, 'LOW_WINRATE_PRIMARY_HOUR', 13)),
          minPmGap: Number(readIntervalDecisionEnv(env, timeframe, 'LOW_WINRATE_PRIMARY_MIN_PM_GAP', 0.35)),
          minConfidence: Number(readIntervalDecisionEnv(env, timeframe, 'LOW_WINRATE_PRIMARY_MIN_CONFIDENCE', 0.66)),
          requireTechAlignment: true,
          level: 'elevated'
        }
      ];
  return {
    timeframe,
    slotSeconds: INTERVAL_SLOT_SECONDS[timeframe] || INTERVAL_SLOT_SECONDS['5m'],
    minElapsedPct: Number(readIntervalDecisionEnv(env, timeframe, 'LOCK_MIN_ELAPSED_PCT', 0.08)),
    defaultElapsedPct: Number(readIntervalDecisionEnv(env, timeframe, 'LOCK_DEFAULT_ELAPSED_PCT', 0.12)),
    maxElapsedPct: Number(readIntervalDecisionEnv(env, timeframe, 'LOCK_MAX_ELAPSED_PCT', 0.25)),
    minPmGap: Number(readIntervalDecisionEnv(env, timeframe, 'MIN_PM_GAP', 0.03)),
    // Strength is a calibrated confidence tier, not merely "a lock happened".
    // For a two-sided market, gap 0.60 ~= 80/20 and gap 0.30 ~= 65/35.
    strongPmGap: Number(readIntervalDecisionEnv(env, timeframe, 'STRONG_PM_GAP', 0.60)),
    normalPmGap: Number(readIntervalDecisionEnv(env, timeframe, 'NORMAL_PM_GAP', 0.30)),
    // Observations below this gap are useful for calibration, but are not
    // actionable locks. Recent settled data shows those weak locks dilute the
    // headline win rate materially.
    actionableMinPmGap: Number(
      readIntervalDecisionEnv(env, timeframe, 'ACTIONABLE_MIN_PM_GAP', actionableMinPmGap)
    ),
    minMarketQuality: Number(readIntervalDecisionEnv(env, timeframe, 'MIN_MARKET_QUALITY', 0.45)),
    minStableSeconds: Number(readIntervalDecisionEnv(env, timeframe, 'MIN_STABLE_SECONDS', 15)),
    hardLockElapsedPct: Number(readIntervalDecisionEnv(env, timeframe, 'HARD_LOCK_ELAPSED_PCT', 0.75)),
    hardLockMinPmGap: Number(readIntervalDecisionEnv(env, timeframe, 'HARD_LOCK_MIN_PM_GAP', 0.06)),
    lowWinrateHourGuardEnabled: readIntervalDecisionEnv(
      env, timeframe, 'LOW_WINRATE_HOUR_GUARD_ENABLED', 'true'
    ) !== 'false',
    lowWinrateHourPolicies: hourPolicies,
    // Final deadline for making an actionable decision. It must still pass the
    // evidence gate below; the deadline no longer turns weak observations into locks.
    terminalLockElapsedPct: Number(
      readIntervalDecisionEnv(env, timeframe, 'TERMINAL_LOCK_ELAPSED_PCT', terminalLockElapsedPct)
    ),
    recordUnlockedWindows: env[`${recordPrefix}_RECORD_UNLOCKED_WINDOWS`] !== 'false',
    recordTechAndComposite: env[`${recordPrefix}_RECORD_TECH_AND_COMPOSITE`] !== 'false',
    earlyLockQuality: 0.65,
    earlyLockSpread: 0.04,
    earlyLockGap: 0.06,
    midLockElapsedPct: 0.15,
    midLockQuality: 0.5,
    midLockStableSeconds: 20,
    midLockMaxFlips: 1,
    lateLockMaxFlips: 2
  };
}

export function buildFiveMinuteDecisionConfig(env = process.env) {
  return buildIntervalDecisionConfig('5m', env);
}

export function buildFifteenMinuteDecisionConfig(env = process.env) {
  return buildIntervalDecisionConfig('15m', env);
}

export function computePmGap(upProbability, downProbability) {
  const up = Number(upProbability);
  const down = Number(downProbability);
  if (!Number.isFinite(up) || !Number.isFinite(down)) return 0;
  return Math.abs(up - down);
}

/**
 * Four crypto contracts ultimately share the same broad 5m market move far more
 * often than their independent PM snapshots suggest. Historical 3:1 windows show
 * weak/normal minority locks underperforming, while strong or >=80% minority locks
 * are roughly neutral and should retain their own evidence.
 */
export function adjustLockWithCrossSymbolMajority(lock, peerLocks = [], {
  minPeers = 4,
  preserveConfidence = 0.80
} = {}) {
  if (!lock || (lock.direction !== 'up' && lock.direction !== 'down')) return lock;
  const valid = (peerLocks || []).filter((item) => (
    item && (item.direction === 'up' || item.direction === 'down')
  ));
  if (valid.length < minPeers) return lock;
  const upCount = valid.filter((item) => item.direction === 'up').length;
  const downCount = valid.filter((item) => item.direction === 'down').length;
  if (!((upCount === 3 && downCount === 1) || (upCount === 1 && downCount === 3))) return lock;

  const majorityDirection = upCount > downCount ? 'up' : 'down';
  const isMinority = lock.direction !== majorityDirection;
  const context = {
    pattern: '3:1',
    majorityDirection,
    majorityCount: 3,
    minorityDirection: majorityDirection === 'up' ? 'down' : 'up'
  };
  if (!isMinority) return { ...lock, crossSymbol: { ...context, adjusted: false } };

  const confidence = Number(lock.confidence);
  const preserve = lock.strength === 'strong'
    || (Number.isFinite(confidence) && confidence >= preserveConfidence);
  if (preserve) {
    return {
      ...lock,
      crossSymbol: { ...context, adjusted: false, preservedStrongMinority: true }
    };
  }

  const majorityPeers = valid.filter((item) => item.direction === majorityDirection);
  const majorityConfidences = majorityPeers
    .map((item) => Number(item.confidence))
    .filter(Number.isFinite);
  const majorityConfidence = majorityConfidences.length
    ? majorityConfidences.reduce((sum, value) => sum + value, 0) / majorityConfidences.length
    : confidence;
  const resolvedConfidence = Number.isFinite(majorityConfidence)
    ? majorityConfidence
    : (Number.isFinite(confidence) ? confidence : 0.5);
  return {
    ...lock,
    direction: majorityDirection,
    confidence: resolvedConfidence,
    upProbability: majorityDirection === 'up' ? resolvedConfidence : 1 - resolvedConfidence,
    downProbability: majorityDirection === 'down' ? resolvedConfidence : 1 - resolvedConfidence,
    source: `${lock.source || 'polymarket'}+cross_symbol_majority`,
    lockReason: `${lock.lockReason || 'pm_lock'}+cross_symbol_3v1`,
    crossSymbol: { ...context, adjusted: true }
  };
}

export function resolveShanghaiHour(isoOrDate = new Date()) {
  const ms = isoOrDate instanceof Date ? isoOrDate.getTime() : Date.parse(isoOrDate);
  if (!Number.isFinite(ms)) return null;
  return (new Date(ms).getUTCHours() + 8) % 24;
}

export function resolveLowWinrateHourPolicy({
  timeframe = '5m',
  at = new Date()
} = {}, config = {}) {
  if (config.lowWinrateHourGuardEnabled === false) return null;
  const hour = resolveShanghaiHour(at);
  if (hour == null) return null;
  const defaults = LOW_WINRATE_HOUR_DEFAULTS[timeframe] || [];
  const policies = Array.isArray(config.lowWinrateHourPolicies)
    ? config.lowWinrateHourPolicies
    : defaults;
  const policy = policies.find((item) => Number(item?.hour) === hour);
  if (!policy) return null;
  return {
    timeframe,
    shanghaiHour: hour,
    minPmGap: Number(policy.minPmGap),
    minConfidence: Number(policy.minConfidence),
    requireTechAlignment: policy.requireTechAlignment !== false,
    level: policy.level || 'elevated'
  };
}

export function evaluateLowWinrateHourGate({
  timeframe = '5m',
  at = new Date(),
  pmGap = null,
  confidence = null,
  pmDirection = null,
  techDirection = null
} = {}, config = {}) {
  const policy = resolveLowWinrateHourPolicy({ timeframe, at }, config);
  if (!policy) return { allowed: true, active: false, policy: null };

  const gap = Number(pmGap);
  if (!Number.isFinite(gap) || gap < policy.minPmGap) {
    return { allowed: false, active: true, reason: 'low_winrate_hour_gap', policy };
  }
  const compositeConfidence = Number(confidence);
  if (!Number.isFinite(compositeConfidence) || compositeConfidence < policy.minConfidence) {
    return { allowed: false, active: true, reason: 'low_winrate_hour_confidence', policy };
  }
  if (
    policy.requireTechAlignment
    && (!['up', 'down'].includes(techDirection) || techDirection !== pmDirection)
  ) {
    return { allowed: false, active: true, reason: 'low_winrate_hour_tech_conflict', policy };
  }
  return { allowed: true, active: true, reason: null, policy };
}

function resolveRecordTimeframe(record) {
  if (record?.timeframe === '5m' || record?.timeframe === '15m') return record.timeframe;
  const id = String(record?.id || '');
  if (id.startsWith('5m_')) return '5m';
  if (id.startsWith('15m_')) return '15m';
  return '15m';
}

export function hasExplicitPmLockMetadata(record) {
  if (!record) return false;
  if (record.decisionLocked === false) return false;
  if (record.decisionLocked === true) return true;
  const lockedDir = record.lockedPolymarketPredictedDirection;
  if (lockedDir !== 'up' && lockedDir !== 'down') return false;
  const hasStrength = Boolean(record.lockStrength && !['--', 'unknown'].includes(String(record.lockStrength)));
  const hasGap = Number.isFinite(Number(record.lockedPmGap));
  return hasStrength || hasGap;
}

export function resolveLockedPolymarketDirection(record) {
  if (!record) return null;
  if (record.decisionLocked === false) return null;
  const locked = record.lockedPolymarketPredictedDirection;
  if (locked === 'up' || locked === 'down') {
    return hasExplicitPmLockMetadata(record) ? locked : null;
  }
  if (record.decisionLocked === true) {
    const direction = record.polymarketPredictedDirection;
    if (direction === 'up' || direction === 'down') return direction;
  }
  return null;
}

export function isExplicitPmLockRecord(record) {
  const timeframe = resolveRecordTimeframe(record);
  if (timeframe !== '5m' && timeframe !== '15m') return false;
  if (!hasExplicitPmLockMetadata(record)) return false;
  if (!resolveLockedPolymarketDirection(record)) return false;
  return record.polymarketCorrect != null;
}

export function isRepairableFifteenMinuteLegacyLock(record) {
  if (resolveRecordTimeframe(record) !== '15m') return false;
  const hasStrength = Boolean(record.lockStrength && !['--', 'unknown'].includes(String(record.lockStrength)));
  const hasGap = Number.isFinite(Number(record.lockedPmGap));
  const hasLockedAt = Boolean(record.decisionLockedAtIso);
  if (hasStrength || hasGap || hasLockedAt) return false;
  if (!hasExplicitPmLockMetadata(record)) return true;
  return record.decisionLocked === true;
}

export function getLockStrength({ pmGap, marketQuality, directionStableSeconds }, config = buildFiveMinuteDecisionConfig()) {
  const gap = Number(pmGap);
  const quality = Number(marketQuality);
  const stableSeconds = Number(directionStableSeconds);
  const strongGap = Number.isFinite(Number(config.strongPmGap)) ? Number(config.strongPmGap) : 0.60;
  const normalGap = Number.isFinite(Number(config.normalPmGap)) ? Number(config.normalPmGap) : 0.30;
  const minStableSeconds = Math.max(0, Number(config.minStableSeconds) || 15);
  if (gap >= strongGap && quality >= 0.55 && stableSeconds >= minStableSeconds) {
    return 'strong';
  }
  if (gap >= normalGap && quality >= 0.45) {
    return 'normal';
  }
  return 'weak';
}

export function formatLockStrengthLabel(direction, strength) {
  if (direction !== 'up' && direction !== 'down') return '未确定';
  const dir = direction === 'up' ? 'UP' : 'DOWN';
  if (strength === 'strong') return `${dir} 强锁定`;
  if (strength === 'normal') return `${dir} 普通锁定`;
  if (strength === 'weak') return `${dir} 弱锁定`;
  return dir;
}

export function trackPmDirectionStability(existing = {}, update = {}) {
  const pmDir = update.polymarket?.predictedDirection;
  if (pmDir !== 'up' && pmDir !== 'down') {
    return {
      pmDirectionFlipCount: existing.pmDirectionFlipCount ?? 0,
      pmDirectionStableSeconds: existing.pmDirectionStableSeconds ?? 0,
      lastPmDirection: existing.lastPmDirection ?? null,
      lastPmDirectionChangeAtIso: existing.lastPmDirectionChangeAtIso ?? null
    };
  }

  const nowIso = update.predictedAtIso || new Date().toISOString();
  const prev = existing.lastPmDirection;
  if (!prev || prev === pmDir) {
    const sinceIso = existing.lastPmDirectionChangeAtIso || existing.firstPredictedAtIso || nowIso;
    const stableSeconds = Math.max(0, (Date.parse(nowIso) - Date.parse(sinceIso)) / 1000);
    return {
      pmDirectionFlipCount: existing.pmDirectionFlipCount ?? 0,
      pmDirectionStableSeconds: stableSeconds,
      lastPmDirection: pmDir,
      // 锚定到稳定起点（sinceIso），避免首个 tick 之后稳定秒数回跳、推迟 early lock。
      lastPmDirectionChangeAtIso: sinceIso
    };
  }

  return {
    pmDirectionFlipCount: (existing.pmDirectionFlipCount ?? 0) + 1,
    pmDirectionStableSeconds: 0,
    lastPmDirection: pmDir,
    lastPmDirectionChangeAtIso: nowIso
  };
}

export function evaluateFiveMinuteLock(update, pending = {}, config = buildFiveMinuteDecisionConfig()) {
  const elapsedPct = Number(update.elapsedInCurrentSlotPct);
  if (!Number.isFinite(elapsedPct) || elapsedPct < config.minElapsedPct) {
    return { shouldLock: false, reason: 'before_min_elapsed', pmGap: 0 };
  }

  const terminalLockElapsedPct = Number(config.terminalLockElapsedPct);
  const livePm = update.polymarket;
  const rememberedDirection = pending.lastPmDirection || pending.polymarketPredictedDirection;
  const pm = livePm?.predictedDirection
    ? livePm
    : ((rememberedDirection === 'up' || rememberedDirection === 'down')
      ? {
        predictedDirection: rememberedDirection,
        upProbability: pending.latestPolymarketUpProbability ?? pending.polymarketUpProbability,
        downProbability: pending.latestPolymarketDownProbability ?? pending.polymarketDownProbability,
        qualityScore: pending.polymarketQualityScore,
        spread: pending.polymarketSpread
      }
      : null);
  if (!pm?.predictedDirection) {
    if (Number.isFinite(terminalLockElapsedPct) && elapsedPct >= terminalLockElapsedPct) {
      const fallbackDirection = update.techDirection
        || update.compositeDirection
        || update.predictedDirection;
      const allowTechnicalFallback = (config.timeframe || update.timeframe || '5m') === '15m';
      if (allowTechnicalFallback && (fallbackDirection === 'up' || fallbackDirection === 'down')) {
        return {
          shouldLock: true,
          reason: 'terminal_technical_fallback',
          pmGap: 0,
          lockStrength: 'weak',
          direction: fallbackDirection,
          lockSource: 'technical_fallback'
        };
      }
    }
    return { shouldLock: false, reason: 'pm_unavailable', pmGap: 0 };
  }

  const pmGap = computePmGap(pm.upProbability, pm.downProbability);
  const hourGate = evaluateLowWinrateHourGate({
    timeframe: config.timeframe || update.timeframe || '5m',
    at: update.predictedAtIso || new Date(),
    pmGap,
    confidence: update.compositeConfidence ?? update.confidence,
    pmDirection: pm.predictedDirection,
    techDirection: update.techDirection
  }, config);
  if (!hourGate.allowed) {
    return {
      shouldLock: false,
      reason: hourGate.reason,
      pmGap,
      hourPolicy: hourGate.policy
    };
  }
  if (pmGap < config.minPmGap) {
    return { shouldLock: false, reason: 'gap_too_small', pmGap };
  }
  const actionableMinPmGap = Number(config.actionableMinPmGap ?? config.normalPmGap ?? 0.30);
  if (!Number.isFinite(pmGap) || pmGap < actionableMinPmGap) {
    return {
      shouldLock: false,
      reason: 'weak_signal_observation',
      pmGap,
      observationStrength: 'weak',
      hourPolicy: hourGate.policy
    };
  }
  if (Number.isFinite(terminalLockElapsedPct) && elapsedPct >= terminalLockElapsedPct) {
    const marketQuality = Number(pm.qualityScore);
    const directionStableSeconds = Number(pending.pmDirectionStableSeconds ?? 0);
    const strength = getLockStrength({ pmGap, marketQuality, directionStableSeconds }, config);
    if (strength === 'weak') {
      return {
        shouldLock: false,
        reason: 'weak_signal_observation',
        pmGap,
        observationStrength: strength,
        hourPolicy: hourGate.policy
      };
    }
    return {
      shouldLock: true,
      reason: 'terminal_deadline',
      pmGap,
      lockStrength: strength,
      direction: pm.predictedDirection,
      lockSource: livePm?.predictedDirection ? 'polymarket' : 'polymarket_last_good',
      hourPolicy: hourGate.policy
    };
  }
  const marketQuality = Number(pm.qualityScore);
  const spread = Number(pm.spread);
  const directionStableSeconds = Number(pending.pmDirectionStableSeconds ?? 0);
  const directionFlipCount = Number(pending.pmDirectionFlipCount ?? 0);
  const strengthInput = { pmGap, marketQuality, directionStableSeconds };

  if (
    marketQuality >= config.earlyLockQuality
    && Number.isFinite(spread)
    && spread <= config.earlyLockSpread
    && directionStableSeconds >= config.minStableSeconds
    && pmGap >= config.earlyLockGap
  ) {
    return {
      shouldLock: true,
      reason: 'early_quality',
      pmGap,
      lockStrength: getLockStrength(strengthInput, config),
      hourPolicy: hourGate.policy
    };
  }

  if (
    elapsedPct >= config.midLockElapsedPct
    && marketQuality >= config.midLockQuality
    && directionStableSeconds >= config.midLockStableSeconds
    && directionFlipCount <= config.midLockMaxFlips
  ) {
    return {
      shouldLock: true,
      reason: 'mid_stable',
      pmGap,
      lockStrength: getLockStrength(strengthInput, config),
      hourPolicy: hourGate.policy
    };
  }

  if (elapsedPct >= config.maxElapsedPct) {
    const hardDeadline = elapsedPct >= Number(config.hardLockElapsedPct ?? 0.75)
      && pmGap >= Number(config.hardLockMinPmGap ?? 0.06);
    if (directionFlipCount > config.lateLockMaxFlips && !hardDeadline) {
      return { shouldLock: false, reason: 'unstable_direction', pmGap };
    }
    if (Number.isFinite(marketQuality) && marketQuality < config.minMarketQuality && !hardDeadline) {
      return { shouldLock: false, reason: 'quality_too_low', pmGap };
    }
    const lockStrength = getLockStrength(strengthInput, config);
    if (lockStrength === 'weak') {
      return {
        shouldLock: false,
        reason: 'weak_signal_observation',
        pmGap,
        observationStrength: lockStrength,
        hourPolicy: hourGate.policy
      };
    }
    return {
      shouldLock: true,
      reason: hardDeadline ? 'hard_deadline' : 'late_timeout',
      pmGap,
      lockStrength,
      hourPolicy: hourGate.policy
    };
  }

  return { shouldLock: false, reason: 'waiting', pmGap };
}

export function inferIntervalLockElapsedPct(record = {}, slotSeconds = INTERVAL_SLOT_SECONDS['15m']) {
  const existing = record.elapsedInCurrentSlotPct ?? record.lastElapsedInCurrentSlotPct ?? record.lockElapsedPct;
  if (Number.isFinite(Number(existing))) return Number(existing);
  const predictedAt = Date.parse(record.predictedAtIso || record.finalPredictedAtIso);
  const targetAt = Date.parse(record.targetTimeIso);
  const windowSeconds = Number(slotSeconds);
  if (!Number.isFinite(predictedAt) || !Number.isFinite(targetAt) || !Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    return null;
  }
  const slotStart = targetAt - windowSeconds * 1000;
  const elapsed = (predictedAt - slotStart) / (windowSeconds * 1000);
  return Number.isFinite(elapsed) ? Math.max(0, Math.min(1, elapsed)) : null;
}

export function isBackfillEligibleFifteenMinuteLock(record = {}) {
  const id = String(record?.id || '');
  if (id.startsWith('15m_')) return true;
  if (record?.timeframe === '15m' && record?.skipReason && record.skipReason !== 'legacy_no_pm_lock') return true;
  return false;
}

/** Converts a dashboard snapshot into an actionable lock after evidence gates pass. */
export function evaluateDisplayPmLock(source = {}, config = buildFiveMinuteDecisionConfig()) {
  const elapsedPct = Number(
    source.elapsedInCurrentSlotPct ?? source.lastElapsedInCurrentSlotPct ?? source.lockElapsedPct
  );
  const pmDir = source.polymarket?.predictedDirection
    ?? source.lastPmDirection
    ?? source.polymarketPredictedDirection;
  if (pmDir !== 'up' && pmDir !== 'down') {
    return { shouldLock: false, reason: 'pm_unavailable', pmGap: 0 };
  }

  const up = source.polymarket?.upProbability ?? source.polymarketUpProbability;
  const down = source.polymarket?.downProbability ?? source.polymarketDownProbability;
  const pmGap = computePmGap(up, down);
  if (pmGap < config.minPmGap) {
    return { shouldLock: false, reason: 'gap_too_small', pmGap };
  }

  const minElapsed = Number(config.defaultElapsedPct ?? 0.12);
  if (!Number.isFinite(elapsedPct) || elapsedPct < minElapsed) {
    return { shouldLock: false, reason: 'before_display_elapsed', pmGap };
  }

  const strengthInput = {
    pmGap,
    marketQuality: Number(source.polymarket?.qualityScore ?? source.polymarketQualityScore),
    directionStableSeconds: Number(source.pmDirectionStableSeconds ?? 0)
  };
  const hourGate = evaluateLowWinrateHourGate({
    timeframe: config.timeframe || source.timeframe || '5m',
    at: source.predictedAtIso || source.finalPredictedAtIso || new Date(),
    pmGap,
    confidence: source.lastCompositeConfidence
      ?? source.compositeConfidence
      ?? source.confidence,
    pmDirection: pmDir,
    techDirection: source.lastTechDirection
      ?? source.techDirection
  }, config);
  if (!hourGate.allowed) {
    return {
      shouldLock: false,
      reason: hourGate.reason,
      pmGap,
      hourPolicy: hourGate.policy
    };
  }
  const actionableMinPmGap = Number(config.actionableMinPmGap ?? config.normalPmGap ?? 0.30);
  const lockStrength = getLockStrength(strengthInput, config);
  if (pmGap < actionableMinPmGap || lockStrength === 'weak') {
    return {
      shouldLock: false,
      reason: 'weak_signal_observation',
      pmGap,
      observationStrength: lockStrength,
      hourPolicy: hourGate.policy
    };
  }
  return {
    shouldLock: true,
    reason: 'display_threshold',
    pmGap,
    lockStrength,
    hourPolicy: hourGate.policy
  };
}

export function resolveIntervalPmLockEval(update, pending = {}, config = buildFiveMinuteDecisionConfig()) {
  const strict = evaluateFiveMinuteLock(update, pending, config);
  if (strict.shouldLock) return strict;
  if (config.timeframe !== '15m') return strict;
  const displaySource = {
    ...pending,
    elapsedInCurrentSlotPct: update.elapsedInCurrentSlotPct,
    polymarket: update.polymarket,
    polymarketPredictedDirection: update.polymarket?.predictedDirection ?? pending.polymarketPredictedDirection,
    polymarketUpProbability: update.polymarket?.upProbability ?? pending.polymarketUpProbability,
    polymarketDownProbability: update.polymarket?.downProbability ?? pending.polymarketDownProbability,
    polymarketQualityScore: update.polymarket?.qualityScore ?? pending.polymarketQualityScore
  };
  return evaluateDisplayPmLock(displaySource, config);
}

export function resolveFiveMinuteSkipReason(pending, config = buildFiveMinuteDecisionConfig()) {
  if (pending?.decisionLocked) return null;
  const pmDir = pending?.lastPmDirection || pending?.polymarketPredictedDirection;
  const up = pending?.polymarketUpProbability;
  const down = pending?.polymarketDownProbability;
  const pmGap = computePmGap(up, down);
  const quality = Number(pending?.polymarketQualityScore);
  const flipCount = Number(pending?.pmDirectionFlipCount ?? 0);
  const hourGate = evaluateLowWinrateHourGate({
    timeframe: config.timeframe || pending?.timeframe || '5m',
    at: pending?.predictedAtIso || pending?.finalPredictedAtIso || new Date(),
    pmGap,
    confidence: pending?.lastCompositeConfidence
      ?? pending?.compositeConfidence
      ?? pending?.confidence,
    pmDirection: pmDir,
    techDirection: pending?.lastTechDirection
      ?? pending?.techDirection
  }, config);

  if (!pmDir) return 'pm_unavailable';
  if (!hourGate.allowed) return hourGate.reason;
  if (pmGap < config.minPmGap) return 'gap_too_small';
  if (pmGap < Number(config.actionableMinPmGap ?? config.normalPmGap ?? 0.30)) {
    return 'weak_signal_observation';
  }
  if (Number.isFinite(quality) && quality < config.minMarketQuality) return 'quality_too_low';
  if (flipCount > config.lateLockMaxFlips) return 'unstable_direction';
  return 'no_lock_timeout';
}

const LOCK_PRICE_BUCKETS = [
  { key: '50-53', min: 0.5, max: 0.53 },
  { key: '53-56', min: 0.53, max: 0.56 },
  { key: '56-60', min: 0.56, max: 0.6 },
  { key: '60-65', min: 0.6, max: 0.65 },
  { key: '65+', min: 0.65, max: 1.01 }
];

const LOCK_TIME_BUCKETS = [
  { key: '24-36s', min: 24, max: 36 },
  { key: '36-45s', min: 36, max: 45 },
  { key: '45-60s', min: 45, max: 60 },
  { key: '60s+', min: 60, max: Infinity }
];

const PM_GAP_BUCKETS = [
  { key: '0-3%', min: 0, max: 0.03 },
  { key: '3-6%', min: 0.03, max: 0.06 },
  { key: '6-10%', min: 0.06, max: 0.1 },
  { key: '10%+', min: 0.1, max: 1.01 }
];

const QUALITY_BUCKETS = [
  { key: '<50%', min: 0, max: 0.5 },
  { key: '50-60%', min: 0.5, max: 0.6 },
  { key: '60-70%', min: 0.6, max: 0.7 },
  { key: '70%+', min: 0.7, max: 1.01 }
];

function pickBucket(value, buckets) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return buckets.find((bucket) => numeric >= bucket.min && numeric < bucket.max)?.key || buckets.at(-1)?.key || null;
}

function lockedPmPrice(record) {
  const direction = record.lockedPolymarketPredictedDirection || record.polymarketPredictedDirection;
  if (direction === 'up') return Number(record.lockedPolymarketUpProbability ?? record.polymarketUpProbability);
  if (direction === 'down') return Number(record.lockedPolymarketDownProbability ?? record.polymarketDownProbability);
  return null;
}

function lockSeconds(record, slotSeconds = INTERVAL_SLOT_SECONDS['5m']) {
  const elapsedPct = Number(record.lockElapsedPct);
  if (Number.isFinite(elapsedPct)) return elapsedPct * slotSeconds;
  return null;
}

function summarizeBucketGroup(records, pickKey, pickCorrect) {
  const groups = new Map();
  for (const record of records) {
    const key = pickKey(record);
    if (!key) continue;
    const correct = pickCorrect(record);
    if (correct == null) continue;
    const entry = groups.get(key) || { total: 0, correct: 0, wrong: 0 };
    entry.total += 1;
    if (correct) entry.correct += 1;
    else entry.wrong += 1;
    groups.set(key, entry);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, stats]) => [key, { ...stats, accuracy: stats.total ? stats.correct / stats.total : 0 }])
  );
}

export function summarizeIntervalPmBuckets(records = [], slotSeconds = INTERVAL_SLOT_SECONDS['5m']) {
  const locked = records.filter((record) => isExplicitPmLockRecord(record));
  const basePick = (record) => record.polymarketCorrect;
  const lockTimeBuckets = slotSeconds >= 900
    ? [
      { key: '72-108s', min: 72, max: 108 },
      { key: '108-135s', min: 108, max: 135 },
      { key: '135-180s', min: 135, max: 180 },
      { key: '180s+', min: 180, max: Infinity }
    ]
    : LOCK_TIME_BUCKETS;

  return {
    lockPrice: summarizeBucketGroup(locked, (record) => pickBucket(lockedPmPrice(record), LOCK_PRICE_BUCKETS), basePick),
    lockTime: summarizeBucketGroup(locked, (record) => pickBucket(lockSeconds(record, slotSeconds), lockTimeBuckets), basePick),
    pmGap: summarizeBucketGroup(
      locked,
      (record) => pickBucket(Number(record.lockedPmGap ?? computePmGap(record.polymarketUpProbability, record.polymarketDownProbability)), PM_GAP_BUCKETS),
      basePick
    ),
    direction: summarizeBucketGroup(
      locked,
      (record) => record.lockedPolymarketPredictedDirection || record.polymarketPredictedDirection || null,
      basePick
    ),
    quality: summarizeBucketGroup(
      locked,
      (record) => pickBucket(Number(record.polymarketQualityScore), QUALITY_BUCKETS),
      basePick
    ),
    strength: summarizeBucketGroup(locked, (record) => record.lockStrength || 'unknown', basePick)
  };
}

export function summarizeFiveMinuteBuckets(records = []) {
  return summarizeIntervalPmBuckets(records, INTERVAL_SLOT_SECONDS['5m']);
}

export function summarizeFiveMinuteAlignment(records = []) {
  const locked = records.filter(
    (record) => record.decisionLocked
      && record.polymarketCorrect != null
      && record.lockedTechDirection
      && record.lockedPolymarketPredictedDirection
  );
  const aligned = locked.filter((record) => record.lockedTechDirection === record.lockedPolymarketPredictedDirection);
  const conflict = locked.filter((record) => record.lockedTechDirection !== record.lockedPolymarketPredictedDirection);
  const summarize = (items) => ({
    total: items.length,
    correct: items.filter((record) => record.polymarketCorrect).length,
    wrong: items.filter((record) => !record.polymarketCorrect).length,
    accuracy: items.length ? items.filter((record) => record.polymarketCorrect).length / items.length : 0
  });
  return {
    aligned: summarize(aligned),
    conflict: summarize(conflict)
  };
}

export function summarizeFiveMinuteSkipped(records = []) {
  const skipped = records.filter((record) => !record.decisionLocked);
  const groups = new Map();
  for (const record of skipped) {
    const reason = record.skipReason || 'unknown';
    groups.set(reason, (groups.get(reason) || 0) + 1);
  }
  return {
    total: skipped.length,
    byReason: Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)))
  };
}

export function renderIntervalPmExtraCell(record) {
  const timeframe = record?.timeframe === '5m' || String(record?.id || '').startsWith('5m_') ? '5m' : '15m';
  const parts = [
    ['tf', timeframe],
    ['locked', record.decisionLocked ? record.lockedPolymarketPredictedDirection || '--' : 'none'],
    ['strength', record.lockStrength || '--'],
    ['gap', Number.isFinite(Number(record.lockedPmGap)) ? pctText(record.lockedPmGap) : '--'],
    ['lockedAt', record.decisionLockedAtIso || '--'],
    ['tech', record.lockedTechDirection || record.lastTechDirection || '--'],
    ['composite', record.lockedCompositeDirection || record.lastCompositeDirection || '--'],
    ['pmOk', record.polymarketCorrect == null ? '--' : record.polymarketCorrect ? 1 : 0],
    ['techOk', record.techCorrect == null ? '--' : record.techCorrect ? 1 : 0],
    ['compOk', record.compositeCorrect == null ? '--' : record.compositeCorrect ? 1 : 0],
    ['skip', record.skipReason || '--'],
    ['open', Number.isFinite(Number(record.slotOpenPrice)) ? roundPrice(record.slotOpenPrice) : '--'],
    ['close', Number.isFinite(Number(record.slotClosePrice ?? record.actualPrice)) ? roundPrice(record.slotClosePrice ?? record.actualPrice) : '--'],
    ['src', record.priceSource || '--']
  ];
  return parts.map(([key, value]) => `${key}=${value}`).join(';');
}

export function renderFiveMinuteExtraCell(record) {
  return renderIntervalPmExtraCell(record);
}

export function parseIntervalPmExtraCell(value) {
  if (!value || value === '--') return {};
  const parsed = {};
  const normalized = String(value).replace(/\\;/g, '\u0001');
  for (const part of normalized.split(';')) {
    const [key, raw] = part.split('=');
    if (!key) continue;
    parsed[key] = raw;
  }
  const timeframe = parsed.tf === '5m' || parsed.tf === '15m' ? parsed.tf : null;
  const lockedDirection = parsed.locked === 'up' || parsed.locked === 'down' ? parsed.locked : null;
  return {
    timeframe,
    // 只有明确锁到方向才算 locked；缺失/截断的 extra cell 不再被误判为已锁定。
    decisionLocked: Boolean(lockedDirection),
    lockedPolymarketPredictedDirection: lockedDirection,
    lockStrength: parsed.strength === '--' ? null : parsed.strength,
    lockedPmGap: parsed.gap === '--' ? null : pctFromText(parsed.gap),
    decisionLockedAtIso: parsed.lockedAt === '--' ? null : parsed.lockedAt,
    lockedTechDirection: parsed.tech === 'up' || parsed.tech === 'down' ? parsed.tech : null,
    lockedCompositeDirection: parsed.composite === 'up' || parsed.composite === 'down' ? parsed.composite : null,
    polymarketCorrect: triBool(parsed.pmOk),
    techCorrect: triBool(parsed.techOk),
    compositeCorrect: triBool(parsed.compOk),
    skipReason: parsed.skip === '--' ? null : parsed.skip,
    slotOpenPrice: parsed.open === '--' ? null : Number(parsed.open),
    slotClosePrice: parsed.close === '--' ? null : Number(parsed.close),
    priceSource: parsed.src === '--' ? null : parsed.src
  };
}

export function parseFiveMinuteExtraCell(value) {
  return parseIntervalPmExtraCell(value);
}

function triBool(value) {
  if (value === '1') return true;
  if (value === '0') return false;
  return null;
}

function pctText(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function pctFromText(value) {
  if (!value || value === '--') return null;
  return Number(String(value).replace('%', '')) / 100;
}

function roundPrice(value) {
  return Math.round(Number(value) * 100) / 100;
}

const PLAN2_MAIN_ENTRY_TYPES = new Set([
  'main',
  'standard',
  'sustained_momentum',
  'late_capture',
  'ultra_late_capture',
  'settlement_capture_90'
]);

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}

function clampNumber(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function resolveFiveMinuteLockStrengthStat(strengthStats = {}, strength = 'weak') {
  return strengthStats?.[strength] || { total: 0, correct: 0, wrong: 0, accuracy: 0 };
}

export function resolveFiveMinuteLockHistoricalTrust({ strength, strengthStats = null, config = {} } = {}) {
  const stats = resolveFiveMinuteLockStrengthStat(strengthStats, strength);
  const minSamples = Number(config.plan2FiveMinuteLockStatsMinSamples) || 5;
  const minAccuracy = Number(config.plan2FiveMinuteLockMinHistoricalAccuracy) || 0.52;
  if (!stats.total || stats.total < minSamples) {
    return {
      weight: 1,
      accuracy: stats.accuracy,
      samples: stats.total,
      sufficient: false,
      trusted: null
    };
  }
  const trusted = stats.accuracy >= minAccuracy;
  const weight = trusted
    ? clampNumber(stats.accuracy / 0.65, 0.75, 1.25, 1)
    : clampNumber((stats.accuracy / minAccuracy) * 0.65, 0.35, 0.8, 0.5);
  return { weight, accuracy: stats.accuracy, samples: stats.total, sufficient: true, trusted };
}

export function applyFiveMinuteLockToPlan2Direction(directionEntry, {
  fiveMinuteLock = null,
  fiveMinuteLockStats = null,
  config = {}
} = {}) {
  const enabled = config.plan2FiveMinuteLockEnabled !== false;
  if (!enabled || !directionEntry?.direction || !fiveMinuteLock?.direction) {
    return directionEntry;
  }

  const lockDir = fiveMinuteLock.direction;
  const strength = fiveMinuteLock.strength || 'weak';
  const trust = resolveFiveMinuteLockHistoricalTrust({ strength, strengthStats: fiveMinuteLockStats, config });
  const boostStrong = Number(config.plan2FiveMinuteLockDirectionBoostStrong) || 0.06;
  const boostNormal = Number(config.plan2FiveMinuteLockDirectionBoostNormal) || 0.04;
  const boostWeak = Number(config.plan2FiveMinuteLockDirectionBoostWeak) || 0.02;
  const baseBoost = strength === 'strong' ? boostStrong : strength === 'normal' ? boostNormal : boostWeak;
  const lockConf = Number(fiveMinuteLock.confidence) || 0.55;
  const meta = {
    lockStrength: strength,
    lockHistoricalAccuracy: trust.accuracy,
    lockTrustWeight: trust.weight,
    lockHistoricalSamples: trust.samples
  };

  if (directionEntry.direction === lockDir) {
    const boost = baseBoost * trust.weight;
    return {
      ...directionEntry,
      confidence: round4(Math.min(0.99, Number(directionEntry.confidence) + boost)),
      lockAligned: true,
      ...meta,
      source: directionEntry.source?.includes('lock')
        ? directionEntry.source
        : `${directionEntry.source || 'unknown'}_lock_align`
    };
  }

  const minWeight = Number(config.plan2FiveMinuteLockConflictPreferMinWeight) || 0.7;
  let preferLock = false;
  if (strength === 'strong') {
    preferLock = !trust.sufficient || (trust.trusted !== false && trust.weight >= minWeight);
  } else if (strength === 'normal') {
    preferLock = trust.sufficient && trust.trusted === true && trust.weight >= minWeight;
  }
  if (preferLock) {
    return {
      ...directionEntry,
      direction: lockDir,
      confidence: round4(Math.max(lockConf, Number(directionEntry.confidence) * 0.92)),
      source: 'five_minute_lock_override',
      lockConflictResolved: true,
      priorDirection: directionEntry.direction,
      ...meta
    };
  }

  const penalty = baseBoost * 0.5 * (trust.trusted === false ? 1.5 : 1);
  return {
    ...directionEntry,
    confidence: round4(Math.max(0.45, Number(directionEntry.confidence) - penalty)),
    lockConflict: true,
    ...meta
  };
}

export function resolvePlan2ExitLockThresholds({
  positionDirection,
  fiveMinuteLock = null,
  fiveMinuteLockStats = null,
  config = {},
  isProbe = false
} = {}) {
  const reverseConfidence = Number(config.plan2ExitReverseConfidence) || 0.56;
  const holdConfidence = isProbe
    ? (Number(config.plan2ExitHoldConfidenceProbe) || 0.54)
    : (Number(config.plan2ExitHoldConfidence) || 0.60);
  const weakConfidence = Number(config.plan2ExitWeakConfidence) || 0.58;

  if (config.plan2FiveMinuteLockEnabled === false || !fiveMinuteLock?.direction || !positionDirection) {
    return { reverseConfidence, holdConfidence, weakConfidence, lockNote: '', effectiveConfidence: null };
  }

  const aligned = positionDirection === fiveMinuteLock.direction;
  const strength = fiveMinuteLock.strength || 'weak';
  const trust = resolveFiveMinuteLockHistoricalTrust({ strength, strengthStats: fiveMinuteLockStats, config });
  const trustFactor = trust.sufficient ? trust.weight : 1;
  const lockConfidence = Number(fiveMinuteLock.confidence) || null;
  const alignedHoldDelta = Number(config.plan2ExitLockAlignedHoldDelta) || -0.04;
  const conflictReverseDelta = strength === 'strong'
    ? (Number(config.plan2ExitLockStrongConflictReverseDelta) || -0.08)
    : (Number(config.plan2ExitLockConflictReverseDelta) || -0.06);

  if (aligned) {
    const delta = alignedHoldDelta * trustFactor;
    return {
      reverseConfidence,
      holdConfidence: Math.max(0.48, holdConfidence + delta),
      weakConfidence,
      lockNote: `5m锁同向${strength}${trust.sufficient ? ` ${Math.round(trust.accuracy * 100)}%胜率` : ''}`,
      effectiveConfidence: lockConfidence
    };
  }

  if (trust.trusted !== false || strength === 'strong') {
    const delta = conflictReverseDelta * (trust.trusted === false ? 0.6 : trustFactor);
    return {
      reverseConfidence: Math.max(0.44, reverseConfidence + delta),
      holdConfidence,
      weakConfidence: Math.max(0.52, weakConfidence - 0.02 * trustFactor),
      lockNote: `5m锁冲突${strength}，加速反转止损`,
      effectiveConfidence: lockConfidence
    };
  }

  return {
    reverseConfidence,
    holdConfidence,
    weakConfidence,
    lockNote: '5m弱锁历史不准，降权',
    effectiveConfidence: lockConfidence
  };
}

export function buildPlan2FiveMinuteLockGuard({
  planDirection,
  fiveMinuteLock = null,
  fiveMinuteLockStats = null,
  config = {}
} = {}) {
  const enabled = config.plan2FiveMinuteLockEnabled !== false;
  if (!enabled) {
    return {
      enabled: false,
      allowMain: true,
      allowProbe: true,
      allowProbeMain: true,
      scale: 1,
      aligned: null,
      reason: ''
    };
  }

  const lock = fiveMinuteLock;
  const weakScale = Number(config.plan2FiveMinuteLockWeakScale);
  const scaleForStrength = (strength) => (
    strength === 'weak'
      ? (Number.isFinite(weakScale) && weakScale > 0 ? weakScale : 0.5)
      : 1
  );

  if (!lock?.direction) {
    const requireLock = config.plan2FiveMinuteLockRequireLock === true;
    if (!requireLock) {
      return {
        enabled: true,
        allowMain: true,
        allowProbe: true,
        allowProbeMain: true,
        scale: 1,
        aligned: null,
        reason: ''
      };
    }
    return {
      enabled: true,
      allowMain: false,
      allowProbe: true,
      allowProbeMain: false,
      scale: 1,
      aligned: null,
      reason: '5m PM 尚未锁定，禁止 main / probe→main'
    };
  }

  if (lock.skipReason === 'unstable_direction') {
    return {
      enabled: true,
      allowMain: false,
      allowProbe: config.plan2FiveMinuteLockAllowProbeOnUnstable !== false,
      allowProbeMain: false,
      scale: scaleForStrength(lock.strength),
      aligned: planDirection === lock.direction,
      reason: '5m PM 方向不稳定，禁止 main'
    };
  }

  const trust = resolveFiveMinuteLockHistoricalTrust({
    strength: lock.strength,
    strengthStats: fiveMinuteLockStats,
    config
  });
  const historyScale = trust.trusted === false ? Math.max(0.5, trust.weight) : 1;
  const accuracyNote = trust.sufficient
    ? `，${lock.strength}锁历史 ${Math.round(trust.accuracy * 100)}%（${trust.samples}窗）`
    : '';

  const aligned = planDirection === lock.direction;
  const scale = scaleForStrength(lock.strength) * historyScale;
  if (aligned) {
    const weakNote = lock.strength === 'weak' ? `，弱锁定降仓 ×${scale.toFixed(2)}` : '';
    return {
      enabled: true,
      allowMain: true,
      allowProbe: true,
      allowProbeMain: true,
      scale,
      aligned: true,
      lockHistoricalAccuracy: trust.accuracy,
      lockTrustWeight: trust.weight,
      reason: `5m PM 锁定同向 ${lock.direction.toUpperCase()}${weakNote}${accuracyNote}`
    };
  }

  return {
    enabled: true,
    allowMain: false,
    allowProbe: config.plan2FiveMinuteLockAllowProbeOnConflict !== false,
    allowProbeMain: false,
    scale,
    aligned: false,
    lockHistoricalAccuracy: trust.accuracy,
    lockTrustWeight: trust.weight,
    reason: `Plan2 ${String(planDirection || '').toUpperCase()} 与 5m PM 锁定 ${lock.direction.toUpperCase()} 冲突，仅 probe${accuracyNote}`
  };
}

const PLAN2_SETTLEMENT_ENTRY_TYPES = new Set([
  'settlement_capture_90',
  'late_capture',
  'ultra_late_capture'
]);

export function plan2EntryBlockedByFiveMinuteLock(entryType, lockGuard) {
  if (!lockGuard?.enabled) return null;
  if (PLAN2_SETTLEMENT_ENTRY_TYPES.has(entryType)) return null;
  if (entryType === 'probe') {
    return lockGuard.allowProbe ? null : lockGuard.reason;
  }
  if (entryType === 'main') {
    return lockGuard.allowProbeMain ? null : lockGuard.reason;
  }
  if (PLAN2_MAIN_ENTRY_TYPES.has(entryType)) {
    return lockGuard.allowMain ? null : lockGuard.reason;
  }
  return null;
}
