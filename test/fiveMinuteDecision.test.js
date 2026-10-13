import assert from 'node:assert/strict';
import test from 'node:test';

import {
  adjustLockWithCrossSymbolMajority,
  applyFiveMinuteLockToPlan2Direction,
  buildFifteenMinuteDecisionConfig,
  buildFiveMinuteDecisionConfig,
  buildPlan2FiveMinuteLockGuard,
  computePmGap,
  evaluateDisplayPmLock,
  evaluateFiveMinuteLock,
  evaluateLowWinrateHourGate,
  formatLockStrengthLabel,
  getLockStrength,
  plan2EntryBlockedByFiveMinuteLock,
  resolveFiveMinuteLockHistoricalTrust,
  resolveFiveMinuteSkipReason,
  resolveIntervalPmLockEval,
  resolveLowWinrateHourPolicy,
  resolvePlan2ExitLockThresholds,
  summarizeFiveMinuteBuckets,
  trackPmDirectionStability
} from '../src/fiveMinuteDecision.js';

test('3:1 cross-symbol majority corrects a weak minority lock', () => {
  const result = adjustLockWithCrossSymbolMajority({
    direction: 'up',
    strength: 'weak',
    confidence: 0.63,
    source: 'polymarket',
    lockReason: 'terminal_deadline'
  }, [
    { symbol: 'BTC-USD', direction: 'up', confidence: 0.63 },
    { symbol: 'ETH-USD', direction: 'down', confidence: 0.91 },
    { symbol: 'SOL-USD', direction: 'down', confidence: 0.88 },
    { symbol: 'XRP-USD', direction: 'down', confidence: 0.86 }
  ]);
  assert.equal(result.direction, 'down');
  assert.equal(result.crossSymbol.adjusted, true);
  assert.match(result.source, /cross_symbol_majority/);
});

test('3:1 cross-symbol majority preserves a strong minority lock', () => {
  const result = adjustLockWithCrossSymbolMajority({
    direction: 'up',
    strength: 'strong',
    confidence: 0.86,
    source: 'polymarket'
  }, [
    { direction: 'up', confidence: 0.86 },
    { direction: 'down', confidence: 0.62 },
    { direction: 'down', confidence: 0.65 },
    { direction: 'down', confidence: 0.66 }
  ]);
  assert.equal(result.direction, 'up');
  assert.equal(result.crossSymbol.adjusted, false);
  assert.equal(result.crossSymbol.preservedStrongMinority, true);
});

const config = buildFiveMinuteDecisionConfig({
  FIVE_MINUTE_DECISION_LOCK_MIN_ELAPSED_PCT: '0.08',
  FIVE_MINUTE_DECISION_LOCK_MAX_ELAPSED_PCT: '0.25',
  FIVE_MINUTE_DECISION_MIN_PM_GAP: '0.03',
  FIVE_MINUTE_DECISION_TERMINAL_LOCK_ELAPSED_PCT: '0.90'
});

test('5m production default keeps a near-tie terminal signal as an observation', () => {
  const defaultConfig = buildFiveMinuteDecisionConfig({});
  assert.equal(defaultConfig.terminalLockElapsedPct, 0.36);
  const result = evaluateFiveMinuteLock({
    elapsedInCurrentSlotPct: 0.36,
    polymarket: {
      predictedDirection: 'down',
      upProbability: 0.51,
      downProbability: 0.49,
      qualityScore: 0.1,
      spread: 0.12
    }
  }, { pmDirectionStableSeconds: 0, pmDirectionFlipCount: 20 }, defaultConfig);
  assert.equal(result.shouldLock, false);
  assert.equal(result.reason, 'gap_too_small');
});

test('5m terminal deadline reuses the last valid PM direction during a transient outage', () => {
  const defaultConfig = buildFiveMinuteDecisionConfig({});
  const result = evaluateFiveMinuteLock({
    elapsedInCurrentSlotPct: 0.36,
    techDirection: 'down',
    polymarket: { available: false }
  }, {
    lastPmDirection: 'up',
    polymarketUpProbability: 0.66,
    polymarketDownProbability: 0.34,
    polymarketQualityScore: 0.7,
    pmDirectionStableSeconds: 25
  }, defaultConfig);
  assert.equal(result.shouldLock, true);
  assert.equal(result.direction, 'up');
  assert.equal(result.lockSource, 'polymarket_last_good');
});

test('5m terminal deadline does not promote a technical fallback to a lock', () => {
  const defaultConfig = buildFiveMinuteDecisionConfig({});
  const result = evaluateFiveMinuteLock({
    elapsedInCurrentSlotPct: 0.36,
    techDirection: 'down',
    compositeDirection: 'up',
    polymarket: { available: false }
  }, {}, defaultConfig);
  assert.equal(result.shouldLock, false);
  assert.equal(result.reason, 'pm_unavailable');
});

test('evaluateDisplayPmLock matches dashboard snapshot threshold', () => {
  const config = buildFiveMinuteDecisionConfig();
  const locked = evaluateDisplayPmLock({
    elapsedInCurrentSlotPct: 0.13,
    polymarketPredictedDirection: 'down',
    polymarketUpProbability: 0.34,
    polymarketDownProbability: 0.66,
    polymarketQualityScore: 0.52,
    pmDirectionStableSeconds: 5
  }, config);
  assert.equal(locked.shouldLock, true);
  assert.equal(locked.reason, 'display_threshold');
  assert.equal(locked.lockStrength, 'normal');

  const tooEarly = evaluateDisplayPmLock({
    elapsedInCurrentSlotPct: 0.10,
    polymarketPredictedDirection: 'down',
    polymarketUpProbability: 0.41,
    polymarketDownProbability: 0.59
  }, config);
  assert.equal(tooEarly.shouldLock, false);
  assert.equal(tooEarly.reason, 'before_display_elapsed');
});

test('resolveIntervalPmLockEval falls back to display lock for 15m only', () => {
  const config = buildFifteenMinuteDecisionConfig();
  const update = {
    elapsedInCurrentSlotPct: 0.14,
    polymarket: {
      predictedDirection: 'up',
      upProbability: 0.71,
      downProbability: 0.29,
      qualityScore: 0.48,
      spread: 0.05
    }
  };
  const pending = { pmDirectionStableSeconds: 8, pmDirectionFlipCount: 0 };
  const result = resolveIntervalPmLockEval(update, pending, config);
  assert.equal(result.shouldLock, true);
  assert.equal(result.reason, 'display_threshold');

  const fiveMinuteConfig = buildFiveMinuteDecisionConfig();
  const strictOnly = resolveIntervalPmLockEval(update, pending, fiveMinuteConfig);
  assert.equal(strictOnly.shouldLock, false);
});

test('computePmGap returns absolute probability spread', () => {
  assert.ok(Math.abs(computePmGap(0.51, 0.49) - 0.02) < 1e-9);
  assert.equal(computePmGap(0.62, 0.38), 0.24);
});

test('evaluateFiveMinuteLock rejects tiny PM gap before locking', () => {
  const update = {
    elapsedInCurrentSlotPct: 0.2,
    polymarket: {
      predictedDirection: 'up',
      upProbability: 0.51,
      downProbability: 0.49,
      qualityScore: 0.8,
      spread: 0.02
    }
  };
  const result = evaluateFiveMinuteLock(update, { pmDirectionStableSeconds: 30 }, config);
  assert.equal(result.shouldLock, false);
  assert.equal(result.reason, 'gap_too_small');
});

test('evaluateFiveMinuteLock allows early high-quality lock before default 36s', () => {
  const update = {
    elapsedInCurrentSlotPct: 0.1,
    polymarket: {
      predictedDirection: 'down',
      upProbability: 0.34,
      downProbability: 0.66,
      qualityScore: 0.7,
      spread: 0.03
    }
  };
  const result = evaluateFiveMinuteLock(update, { pmDirectionStableSeconds: 18, pmDirectionFlipCount: 0 }, config);
  assert.equal(result.shouldLock, true);
  assert.equal(result.reason, 'early_quality');
  assert.equal(result.lockStrength, 'normal');
});

test('evaluateFiveMinuteLock refuses late lock when direction keeps flipping', () => {
  const update = {
    elapsedInCurrentSlotPct: 0.25,
    polymarket: {
      predictedDirection: 'up',
      upProbability: 0.70,
      downProbability: 0.30,
      qualityScore: 0.6,
      spread: 0.03
    }
  };
  const result = evaluateFiveMinuteLock(update, { pmDirectionStableSeconds: 5, pmDirectionFlipCount: 3 }, config);
  assert.equal(result.shouldLock, false);
  assert.equal(result.reason, 'unstable_direction');
});

test('evaluateFiveMinuteLock refuses late lock when market quality is too low', () => {
  const update = {
    elapsedInCurrentSlotPct: 0.25,
    polymarket: {
      predictedDirection: 'up',
      upProbability: 0.70,
      downProbability: 0.30,
      qualityScore: 0.30,
      spread: 0.08
    }
  };
  const result = evaluateFiveMinuteLock(update, { pmDirectionStableSeconds: 10, pmDirectionFlipCount: 0 }, config);
  assert.equal(result.shouldLock, false);
  assert.equal(result.reason, 'quality_too_low');
});

test('low-winrate hour policies use Shanghai time without permanently blocking 5m 22:00', () => {
  const strict15m = resolveLowWinrateHourPolicy({
    timeframe: '15m',
    at: '2026-07-15T22:10:00.000Z'
  }, buildFifteenMinuteDecisionConfig());
  assert.equal(strict15m.shanghaiHour, 6);
  assert.equal(strict15m.minPmGap, 0.4);
  assert.equal(strict15m.minConfidence, 0.68);

  const weak5m = resolveLowWinrateHourPolicy({
    timeframe: '5m',
    at: '2026-07-16T05:10:00.000Z'
  }, buildFiveMinuteDecisionConfig());
  assert.equal(weak5m.shanghaiHour, 13);
  assert.equal(weak5m.minPmGap, 0.35);

  const dynamic22 = resolveLowWinrateHourPolicy({
    timeframe: '5m',
    at: '2026-07-16T14:10:00.000Z'
  }, buildFiveMinuteDecisionConfig());
  assert.equal(dynamic22, null);
});

test('low-winrate hour gate requires gap, confidence, and technical alignment', () => {
  const hourConfig = buildFifteenMinuteDecisionConfig();
  const base = {
    timeframe: '15m',
    at: '2026-07-15T22:10:00.000Z',
    pmGap: 0.4,
    confidence: 0.7,
    pmDirection: 'up',
    techDirection: 'up'
  };
  assert.equal(evaluateLowWinrateHourGate(base, hourConfig).allowed, true);
  assert.equal(evaluateLowWinrateHourGate({ ...base, pmGap: 0.39 }, hourConfig).reason, 'low_winrate_hour_gap');
  assert.equal(
    evaluateLowWinrateHourGate({ ...base, confidence: 0.67 }, hourConfig).reason,
    'low_winrate_hour_confidence'
  );
  assert.equal(
    evaluateLowWinrateHourGate({ ...base, techDirection: 'down' }, hourConfig).reason,
    'low_winrate_hour_tech_conflict'
  );
});

test('low-winrate hour gate also applies at the terminal lock deadline', () => {
  const hourConfig = buildFifteenMinuteDecisionConfig();
  const update = {
    timeframe: '15m',
    predictedAtIso: '2026-07-15T22:10:00.000Z',
    elapsedInCurrentSlotPct: 0.95,
    confidence: 0.7,
    compositeConfidence: 0.7,
    techDirection: 'up',
    polymarket: {
      predictedDirection: 'up',
      upProbability: 0.68,
      downProbability: 0.32,
      qualityScore: 0.8,
      spread: 0.02
    }
  };
  const blocked = evaluateFiveMinuteLock(update, {
    pmDirectionStableSeconds: 120,
    pmDirectionFlipCount: 0
  }, hourConfig);
  assert.equal(blocked.shouldLock, false);
  assert.equal(blocked.reason, 'low_winrate_hour_gap');

  const allowed = evaluateFiveMinuteLock({
    ...update,
    polymarket: {
      ...update.polymarket,
      upProbability: 0.71,
      downProbability: 0.29
    }
  }, {
    pmDirectionStableSeconds: 120,
    pmDirectionFlipCount: 0
  }, hourConfig);
  assert.equal(allowed.shouldLock, true);
  assert.equal(allowed.hourPolicy.shanghaiHour, 6);
});

test('evaluateFiveMinuteLock does not emit a weak lock at the hard deadline', () => {
  const update = {
    elapsedInCurrentSlotPct: 0.76,
    polymarket: {
      predictedDirection: 'down',
      upProbability: 0.15,
      downProbability: 0.85,
      qualityScore: 0.30,
      spread: 0.08
    }
  };
  const result = evaluateFiveMinuteLock(update, { pmDirectionStableSeconds: 2, pmDirectionFlipCount: 5 }, config);
  assert.equal(result.shouldLock, false);
  assert.equal(result.reason, 'weak_signal_observation');
});

test('evaluateFiveMinuteLock records but does not lock a weak direction in the final 30 seconds', () => {
  const update = {
    elapsedInCurrentSlotPct: 0.91,
    polymarket: {
      predictedDirection: 'up',
      upProbability: 0.505,
      downProbability: 0.495,
      qualityScore: 0.2,
      spread: 0.12
    }
  };
  const result = evaluateFiveMinuteLock(
    update,
    { pmDirectionStableSeconds: 0, pmDirectionFlipCount: 20 },
    config
  );
  assert.equal(result.shouldLock, false);
  assert.equal(result.reason, 'gap_too_small');
  assert.ok(Math.abs(result.pmGap - 0.01) < 1e-9);
});

test('evaluateFiveMinuteLock preserves evidence-based strength at terminal deadline', () => {
  const update = {
    elapsedInCurrentSlotPct: 0.91,
    polymarket: {
      predictedDirection: 'down',
      upProbability: 0.15,
      downProbability: 0.85,
      qualityScore: 0.7,
      spread: 0.02
    }
  };
  const result = evaluateFiveMinuteLock(
    update,
    { pmDirectionStableSeconds: 30, pmDirectionFlipCount: 0 },
    config
  );
  assert.equal(result.shouldLock, true);
  assert.equal(result.reason, 'terminal_deadline');
  assert.equal(result.lockStrength, 'strong');
});

test('trackPmDirectionStability keeps stable seconds monotonic across ticks', () => {
  const first = trackPmDirectionStability(
    { firstPredictedAtIso: '2026-06-29T10:00:00.000Z' },
    { polymarket: { predictedDirection: 'up' }, predictedAtIso: '2026-06-29T10:00:30.000Z' }
  );
  assert.equal(first.pmDirectionStableSeconds, 30);

  const second = trackPmDirectionStability(
    { ...first, firstPredictedAtIso: '2026-06-29T10:00:00.000Z' },
    { polymarket: { predictedDirection: 'up' }, predictedAtIso: '2026-06-29T10:00:35.000Z' }
  );
  assert.equal(second.pmDirectionStableSeconds, 35);

  const flipped = trackPmDirectionStability(
    { ...second, firstPredictedAtIso: '2026-06-29T10:00:00.000Z' },
    { polymarket: { predictedDirection: 'down' }, predictedAtIso: '2026-06-29T10:00:40.000Z' }
  );
  assert.equal(flipped.pmDirectionStableSeconds, 0);
  assert.equal(flipped.pmDirectionFlipCount, 1);
});

test('getLockStrength maps gap and quality to strong/normal/weak', () => {
  assert.equal(getLockStrength({ pmGap: 0.70, marketQuality: 0.7, directionStableSeconds: 25 }, config), 'strong');
  assert.equal(getLockStrength({ pmGap: 0.40, marketQuality: 0.58, directionStableSeconds: 10 }, config), 'normal');
  assert.equal(getLockStrength({ pmGap: 0.12, marketQuality: 0.5, directionStableSeconds: 10 }, config), 'weak');
});

test('formatLockStrengthLabel renders Chinese strength labels', () => {
  assert.equal(formatLockStrengthLabel('up', 'strong'), 'UP 强锁定');
  assert.equal(formatLockStrengthLabel('down', 'weak'), 'DOWN 弱锁定');
  assert.equal(formatLockStrengthLabel(null, 'strong'), '未确定');
});

test('resolveFiveMinuteSkipReason labels unlocked windows', () => {
  assert.equal(
    resolveFiveMinuteSkipReason(
      {
        lastPmDirection: 'up',
        polymarketUpProbability: 0.505,
        polymarketDownProbability: 0.495,
        pmDirectionFlipCount: 0
      },
      config
    ),
    'gap_too_small'
  );
});

test('summarizeFiveMinuteBuckets groups locked PM records by gap bucket', () => {
  const buckets = summarizeFiveMinuteBuckets([
    {
      decisionLocked: true,
      lockedPolymarketPredictedDirection: 'up',
      lockedPmGap: 0.08,
      polymarketCorrect: true,
      lockElapsedPct: 0.14,
      polymarketQualityScore: 0.62,
      lockStrength: 'normal'
    },
    {
      decisionLocked: true,
      lockedPolymarketPredictedDirection: 'down',
      lockedPmGap: 0.02,
      polymarketCorrect: false,
      lockElapsedPct: 0.16,
      polymarketQualityScore: 0.58,
      lockStrength: 'weak'
    }
  ]);
  assert.equal(buckets.pmGap['6-10%'].total, 1);
  assert.equal(buckets.pmGap['6-10%'].correct, 1);
  assert.equal(buckets.direction.down.total, 1);
});

test('buildPlan2FiveMinuteLockGuard blocks main when lock conflicts', () => {
  const guard = buildPlan2FiveMinuteLockGuard({
    planDirection: 'up',
    fiveMinuteLock: { direction: 'down', strength: 'normal' },
    config: { plan2FiveMinuteLockEnabled: true }
  });
  assert.equal(guard.allowMain, false);
  assert.equal(guard.allowProbe, true);
  assert.equal(guard.allowProbeMain, false);
  assert.equal(plan2EntryBlockedByFiveMinuteLock('standard', guard)?.includes('冲突'), true);
  assert.equal(plan2EntryBlockedByFiveMinuteLock('probe', guard), null);
});

test('buildPlan2FiveMinuteLockGuard scales weak aligned lock', () => {
  const guard = buildPlan2FiveMinuteLockGuard({
    planDirection: 'down',
    fiveMinuteLock: { direction: 'down', strength: 'weak' },
    config: { plan2FiveMinuteLockEnabled: true, plan2FiveMinuteLockWeakScale: 0.5 }
  });
  assert.equal(guard.allowMain, true);
  assert.equal(guard.scale, 0.5);
});

test('buildPlan2FiveMinuteLockGuard does not require lock by default', () => {
  const guard = buildPlan2FiveMinuteLockGuard({
    planDirection: 'up',
    fiveMinuteLock: null,
    config: { plan2FiveMinuteLockEnabled: true }
  });
  assert.equal(guard.allowMain, true);
  assert.equal(guard.allowProbeMain, true);
});

test('buildPlan2FiveMinuteLockGuard downweights weak lock with poor historical accuracy', () => {
  const guard = buildPlan2FiveMinuteLockGuard({
    planDirection: 'up',
    fiveMinuteLock: { direction: 'up', strength: 'weak' },
    fiveMinuteLockStats: {
      weak: { total: 12, correct: 4, wrong: 8, accuracy: 4 / 12 }
    },
    config: {
      plan2FiveMinuteLockEnabled: true,
      plan2FiveMinuteLockWeakScale: 0.5,
      plan2FiveMinuteLockStatsMinSamples: 5,
      plan2FiveMinuteLockMinHistoricalAccuracy: 0.52
    }
  });
  assert.ok(guard.scale < 0.5);
  assert.match(guard.reason, /历史/);
});

test('applyFiveMinuteLockToPlan2Direction boosts aligned strong lock', () => {
  const entry = applyFiveMinuteLockToPlan2Direction(
    { direction: 'up', confidence: 0.62, source: 'tech' },
    {
      fiveMinuteLock: { direction: 'up', strength: 'strong', confidence: 0.68 },
      fiveMinuteLockStats: { strong: { total: 10, correct: 7, wrong: 3, accuracy: 0.7 } },
      config: { plan2FiveMinuteLockEnabled: true }
    }
  );
  assert.equal(entry.lockAligned, true);
  assert.ok(entry.confidence > 0.62);
});

test('applyFiveMinuteLockToPlan2Direction prefers lock over conflicting tech when trusted', () => {
  const entry = applyFiveMinuteLockToPlan2Direction(
    { direction: 'up', confidence: 0.64, source: 'tech' },
    {
      fiveMinuteLock: { direction: 'down', strength: 'strong', confidence: 0.72 },
      fiveMinuteLockStats: { strong: { total: 10, correct: 8, wrong: 2, accuracy: 0.8 } },
      config: { plan2FiveMinuteLockEnabled: true }
    }
  );
  assert.equal(entry.direction, 'down');
  assert.equal(entry.source, 'five_minute_lock_override');
});

test('resolvePlan2ExitLockThresholds lowers hold threshold when lock aligns with position', () => {
  const thresholds = resolvePlan2ExitLockThresholds({
    positionDirection: 'up',
    fiveMinuteLock: { direction: 'up', strength: 'normal', confidence: 0.66 },
    fiveMinuteLockStats: { normal: { total: 8, correct: 6, wrong: 2, accuracy: 0.75 } },
    config: { plan2FiveMinuteLockEnabled: true, plan2ExitHoldConfidence: 0.60 }
  });
  assert.ok(thresholds.holdConfidence < 0.60);
});

test('resolvePlan2ExitLockThresholds accelerates reversal when lock conflicts strongly', () => {
  const thresholds = resolvePlan2ExitLockThresholds({
    positionDirection: 'up',
    fiveMinuteLock: { direction: 'down', strength: 'strong', confidence: 0.70 },
    fiveMinuteLockStats: { strong: { total: 10, correct: 8, wrong: 2, accuracy: 0.8 } },
    config: { plan2FiveMinuteLockEnabled: true, plan2ExitReverseConfidence: 0.56 }
  });
  assert.ok(thresholds.reverseConfidence < 0.56);
});
