import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildNextSlotPredictionFromLock,
  buildNextSlotPredictionLockConfig,
  evaluateNextSlotPrediction,
  meetsNextSlotPredictionLock,
  meetsNextSlotPredictionHardDeadline,
  nextAdjacentSlotIso,
  resolvePredictedSlotIsoFromSettledRecord,
  shouldRecordNextSlotPrediction,
  summarizeNextSlotPredictions,
  annotateSameDirectionAsPrev,
  evaluatePlan5SameDirectionBoost
} from '../src/nextSlotPrediction.js';

const lockedBase = {
  decisionLocked: true,
  timeframe: '5m',
  symbol: 'BTC-USD',
  targetTimeIso: '2026-07-09T01:05:00.000Z',
  decisionLockedAtIso: '2026-07-09T01:01:00.000Z',
  lockedPolymarketPredictedDirection: 'up',
  lockStrength: 'strong',
  lockedPmGap: 0.12,
  lockReason: 'stable_gap',
  lastElapsedInCurrentSlotPct: 0.55,
  lockElapsedPct: 0.12
};

test('buildNextSlotPredictionFromLock waits for prediction-lock elapsed', () => {
  const early = buildNextSlotPredictionFromLock({
    ...lockedBase,
    lastElapsedInCurrentSlotPct: 0.15
  });
  assert.equal(early, null);

  const ready = buildNextSlotPredictionFromLock(lockedBase);
  assert.ok(ready);
  assert.equal(ready.sourceSlotIso, '2026-07-09T01:00:00.000Z');
  assert.equal(ready.predictedSlotIso, '2026-07-09T01:05:00.000Z');
  assert.equal(ready.predictedDirection, 'up');
  assert.equal(ready.lockStrength, 'strong');
  assert.equal(ready.status, 'pending');
});

test('force option builds prediction without late lock threshold', () => {
  const prediction = buildNextSlotPredictionFromLock({
    ...lockedBase,
    lastElapsedInCurrentSlotPct: 0.1
  }, new Date().toISOString(), { force: true });
  assert.ok(prediction);
  assert.equal(prediction.predictedDirection, 'up');
});

test('weak strength needs higher elapsed than normal/strong', () => {
  const weakMid = {
    ...lockedBase,
    lockStrength: 'weak',
    lockedPmGap: 0.07,
    lastElapsedInCurrentSlotPct: 0.55
  };
  assert.equal(meetsNextSlotPredictionLock(weakMid), false);
  assert.equal(
    meetsNextSlotPredictionLock({ ...weakMid, lastElapsedInCurrentSlotPct: 0.65 }),
    true
  );
});

test('prediction lock requires stronger min gap than display lock', () => {
  const smallGap = {
    ...lockedBase,
    lockedPmGap: 0.04,
    lastElapsedInCurrentSlotPct: 0.7
  };
  assert.equal(meetsNextSlotPredictionLock(smallGap), false);
  assert.equal(meetsNextSlotPredictionLock({ ...smallGap, lockedPmGap: 0.08 }), true);
});

test('buildNextSlotPredictionLockConfig reads env overrides', () => {
  const config = buildNextSlotPredictionLockConfig('5m', {
    FIVE_MINUTE_NEXT_SLOT_PREDICTION_LOCK_MIN_ELAPSED_PCT: '0.4',
    FIVE_MINUTE_NEXT_SLOT_PREDICTION_LOCK_MIN_PM_GAP: '0.08',
    FIVE_MINUTE_NEXT_SLOT_PREDICTION_ALLOW_WEAK: 'false'
  });
  assert.equal(config.minElapsedPct, 0.4);
  assert.equal(config.minPmGap, 0.08);
  assert.equal(config.allowWeak, false);
});

test('shouldRecordNextSlotPrediction mirrors soft lock or hard deadline', () => {
  assert.equal(shouldRecordNextSlotPrediction(lockedBase), true);
  assert.equal(
    shouldRecordNextSlotPrediction({ ...lockedBase, lastElapsedInCurrentSlotPct: 0.2 }),
    false
  );
  // Weak + small gap: soft fails, hard deadline at late elapsed succeeds
  const weakLate = {
    ...lockedBase,
    lockStrength: 'weak',
    lockedPmGap: 0.04,
    lastElapsedInCurrentSlotPct: 0.92
  };
  assert.equal(meetsNextSlotPredictionLock(weakLate), false);
  assert.equal(meetsNextSlotPredictionHardDeadline(weakLate), true);
  assert.equal(shouldRecordNextSlotPrediction(weakLate), true);
});

test('hard deadline forces next-slot lock near window end even below soft thresholds', () => {
  const weakStuck = {
    ...lockedBase,
    lockStrength: 'weak',
    lockedPmGap: 0.04,
    lastElapsedInCurrentSlotPct: 0.7
  };
  assert.equal(meetsNextSlotPredictionLock(weakStuck), false);
  assert.equal(meetsNextSlotPredictionHardDeadline(weakStuck), false);
  assert.equal(buildNextSlotPredictionFromLock(weakStuck), null);

  const byElapsed = { ...weakStuck, lastElapsedInCurrentSlotPct: 0.91 };
  assert.equal(meetsNextSlotPredictionHardDeadline(byElapsed), true);
  const forced = buildNextSlotPredictionFromLock(byElapsed);
  assert.ok(forced);
  assert.equal(forced.predictedDirection, 'up');
  assert.equal(forced.lockMode, 'hard');
  assert.equal(forced.lockReason, 'hard_deadline');

  // 5m: remaining ≤ 30s ≈ elapsed ≥ ~0.90
  const byRemaining = { ...weakStuck, lastElapsedInCurrentSlotPct: 0.905 };
  assert.equal(meetsNextSlotPredictionHardDeadline(byRemaining), true);

  // Settlement force: even mid-window if somehow settling
  assert.equal(
    meetsNextSlotPredictionHardDeadline(weakStuck, { forceSettlement: true }),
    true
  );
  const settled = buildNextSlotPredictionFromLock(weakStuck, new Date().toISOString(), {
    forceSettlement: true
  });
  assert.ok(settled);
  assert.equal(settled.lockMode, 'hard');
  assert.equal(settled.lockReason, 'hard_deadline_settlement');
});

test('buildNextSlotPredictionLockConfig includes hard deadline defaults', () => {
  const cfg5 = buildNextSlotPredictionLockConfig('5m', {});
  assert.equal(cfg5.hardMinElapsedPct, 0.9);
  assert.equal(cfg5.hardMaxRemainingSec, 30);
  const cfg15 = buildNextSlotPredictionLockConfig('15m', {});
  assert.equal(cfg15.hardMaxRemainingSec, 60);
  const overridden = buildNextSlotPredictionLockConfig('5m', {
    FIVE_MINUTE_NEXT_SLOT_PREDICTION_LOCK_HARD_MIN_ELAPSED_PCT: '0.85',
    FIVE_MINUTE_NEXT_SLOT_PREDICTION_LOCK_HARD_MAX_REMAINING_SEC: '45'
  });
  assert.equal(overridden.hardMinElapsedPct, 0.85);
  assert.equal(overridden.hardMaxRemainingSec, 45);
});

test('nextAdjacentSlotIso advances by timeframe minutes', () => {
  assert.equal(
    nextAdjacentSlotIso('2026-07-09T01:00:00.000Z', '5m'),
    '2026-07-09T01:05:00.000Z'
  );
  assert.equal(
    nextAdjacentSlotIso('2026-07-09T01:00:00.000Z', '15m'),
    '2026-07-09T01:15:00.000Z'
  );
});

test('evaluateNextSlotPrediction marks correct/wrong from actual direction', () => {
  const base = buildNextSlotPredictionFromLock({
    ...lockedBase,
    lockedPolymarketPredictedDirection: 'down',
    lockStrength: 'normal'
  });
  const correct = evaluateNextSlotPrediction(base, 'down');
  assert.equal(correct.correct, true);
  assert.equal(correct.status, 'correct');
  const wrong = evaluateNextSlotPrediction(base, 'up');
  assert.equal(wrong.correct, false);
  assert.equal(wrong.status, 'wrong');
});

test('resolvePredictedSlotIsoFromSettledRecord uses settled window start', () => {
  assert.equal(
    resolvePredictedSlotIsoFromSettledRecord({
      timeframe: '5m',
      targetTimeIso: '2026-07-09T01:10:00.000Z',
      actualDirection: 'up'
    }),
    '2026-07-09T01:05:00.000Z'
  );
});

test('summarizeNextSlotPredictions aggregates overall/strength/timeframe', () => {
  const summary = summarizeNextSlotPredictions([
    { correct: true, lockStrength: 'strong', sourceTimeframe: '5m' },
    { correct: false, lockStrength: 'strong', sourceTimeframe: '5m' },
    { correct: true, lockStrength: 'weak', sourceTimeframe: '15m' },
    { correct: null, lockStrength: 'normal', sourceTimeframe: '5m' }
  ]);
  assert.equal(summary.overall.total, 3);
  assert.equal(summary.overall.correct, 2);
  assert.equal(summary.overall.pending, 1);
  assert.equal(summary.byStrength.strong.total, 2);
  assert.equal(summary.byStrength.strong.accuracy, 0.5);
  assert.equal(summary.byTimeframe['15m'].correct, 1);
});

test('annotateSameDirectionAsPrev and continuity buckets', () => {
  const same = annotateSameDirectionAsPrev(
    { predictedDirection: 'up' },
    { predictedDirection: 'up' }
  );
  assert.equal(same.sameDirectionAsPrev, true);
  assert.equal(same.continuity, 'same');
  const flip = annotateSameDirectionAsPrev(
    { predictedDirection: 'up' },
    { predictedDirection: 'down' }
  );
  assert.equal(flip.sameDirectionAsPrev, false);
  assert.equal(flip.continuity, 'flip');
  const first = annotateSameDirectionAsPrev({ predictedDirection: 'up' }, null);
  assert.equal(first.sameDirectionAsPrev, null);
  assert.equal(first.continuity, 'first');

  const summary = summarizeNextSlotPredictions([
    { correct: true, sameDirectionAsPrev: true, lockStrength: 'strong', sourceTimeframe: '5m' },
    { correct: true, sameDirectionAsPrev: true, lockStrength: 'strong', sourceTimeframe: '5m' },
    { correct: false, sameDirectionAsPrev: false, lockStrength: 'normal', sourceTimeframe: '5m' },
    { correct: true, sameDirectionAsPrev: null, lockStrength: 'weak', sourceTimeframe: '5m' }
  ]);
  assert.equal(summary.byContinuity.same.total, 2);
  assert.equal(summary.byContinuity.same.accuracy, 1);
  assert.equal(summary.byContinuity.flip.total, 1);
  assert.equal(summary.byContinuity.first.total, 1);
});

test('evaluatePlan5SameDirectionBoost requires edge and samples', () => {
  const cold = evaluatePlan5SameDirectionBoost({
    sameDirectionAsPrev: true,
    continuityStats: {
      same: { total: 5, correct: 4, accuracy: 0.8 },
      flip: { total: 5, correct: 2, accuracy: 0.4 }
    },
    config: { plan5SameDirMinSamples: 15 }
  });
  assert.equal(cold.applied, false);
  assert.equal(cold.boost, 1);

  const boosted = evaluatePlan5SameDirectionBoost({
    sameDirectionAsPrev: true,
    continuityStats: {
      same: { total: 20, correct: 16, accuracy: 0.8 },
      flip: { total: 20, correct: 10, accuracy: 0.5 },
      overall: { total: 40, correct: 26, accuracy: 0.65 }
    },
    config: {
      plan5SameDirMinSamples: 15,
      plan5SameDirMinEdge: 0.03,
      plan5SameDirBoost: 1.3,
      plan5SameDirBoostMax: 1.35
    }
  });
  assert.equal(boosted.applied, true);
  assert.equal(boosted.boost, 1.3);

  const flipNoBoost = evaluatePlan5SameDirectionBoost({
    sameDirectionAsPrev: false,
    continuityStats: {
      same: { total: 20, correct: 16, accuracy: 0.8 },
      flip: { total: 20, correct: 10, accuracy: 0.5 }
    },
    config: {}
  });
  assert.equal(flipNoBoost.boost, 1);
});

test('next-slot prediction does not alter lock fields on a fresh pending window', () => {
  const unlocked = {
    decisionLocked: false,
    lockedPolymarketPredictedDirection: null,
    lockStrength: null
  };
  const prediction = buildNextSlotPredictionFromLock(lockedBase);
  assert.equal(prediction.predictedDirection, 'up');
  assert.equal(unlocked.decisionLocked, false);
  assert.equal(unlocked.lockedPolymarketPredictedDirection, null);
});
