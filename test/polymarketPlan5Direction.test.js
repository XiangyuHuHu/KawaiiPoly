import test from 'node:test';
import assert from 'node:assert/strict';
import { PredictionRecorder } from '../src/predictionRecorder.js';
import {
  buildPlan5ContinuityEvidence,
  buildPlan5DirectionDecision,
  buildPlan5PriceCalibration,
  buildPlan5StrengthDirection,
  selectPlan5PriceAwareDirection
} from '../src/polymarketPlan5Direction.js';
import {
  evaluatePlan5LiveAdversePriceMove,
  repricePlan5LiveDraft
} from '../src/polymarketLiveOrder.js';
import {
  evaluatePlan5DirectionRecheck,
  resolvePlan5EntryLock
} from '../src/polymarketPlan5.js';

test('Plan5 flips a collapsed weak locked side instead of treating it as a discount', () => {
  const result = evaluatePlan5DirectionRecheck({
    lock: {
      direction: 'down',
      strength: 'weak',
      pmGap: 0.13,
      upProbability: 0.435,
      downProbability: 0.565
    },
    upPrice: 0.52,
    downPrice: 0.47,
    signal: { technicalDirection: 'up' },
    config: { plan5DirectionRecheckCollapsePrice: 0.55 }
  });
  assert.equal(result.flipped, true);
  assert.equal(result.direction, 'up');
  assert.equal(result.flipReason, 'collapsed_locked_side');
});

test('Plan5 flips a normal lock after a material probability collapse', () => {
  const result = evaluatePlan5DirectionRecheck({
    lock: {
      direction: 'down',
      strength: 'normal',
      pmGap: 0.30,
      upProbability: 0.35,
      downProbability: 0.65
    },
    upPrice: 0.53,
    downPrice: 0.46,
    config: {
      plan5DirectionRecheckCollapsePrice: 0.55,
      plan5DirectionRecheckMinDropAbs: 0.04
    }
  });
  assert.equal(result.flipped, true);
  assert.equal(result.priceDropAbs, 0.19);
  assert.equal(result.direction, 'up');
});

test('Plan5 does not flip a near-even weak lock while its side still leads', () => {
  const result = evaluatePlan5DirectionRecheck({
    lock: {
      direction: 'up',
      strength: 'weak',
      pmGap: 0.0304,
      upProbability: 0.5152,
      downProbability: 0.4848
    },
    upPrice: 0.51,
    downPrice: 0.48,
    signal: { direction: 'up' },
    config: {
      plan5DirectionRecheckCollapsePrice: 0.54,
      plan5DirectionRecheckMinDropAbs: 0.04
    }
  });
  assert.equal(result.flipped, false);
  assert.equal(result.direction, 'up');
});

test('Plan5 execution keeps the displayed lock when post-lock overrides are disabled', () => {
  const recorder = new PredictionRecorder({
    recordDir: 'unused',
    fetchQuotes: async () => [],
    statsDb: { getDirectionJudgments: () => [], getLossReasonOrders: () => [] },
    plan5Config: {
      plan5LockDirectionOptimizationEnabled: false,
      plan5CrossSymbolMajorityEnabled: false
    }
  });
  const targetTimeIso = '2026-07-22T06:55:00.000Z';
  for (const [symbol, direction] of [
    ['BTC-USD', 'up'],
    ['ETH-USD', 'down'],
    ['SOL-USD', 'down'],
    ['XRP-USD', 'down']
  ]) {
    recorder.pending.set(`5m_${targetTimeIso}_${symbol}`, {
      decisionLocked: true,
      lockedPolymarketPredictedDirection: direction,
      lockedPolymarketUpProbability: direction === 'up' ? 0.54 : 0.46,
      lockedPolymarketDownProbability: direction === 'down' ? 0.54 : 0.46,
      lockedPmGap: 0.08,
      lockStrength: 'weak',
      decisionLockedAtIso: '2026-07-22T06:50:50.000Z'
    });
  }
  const lock = recorder.getLockedFiveMinuteDecision('BTC-USD', targetTimeIso);
  assert.equal(lock.direction, 'up');
  assert.doesNotMatch(lock.source, /cross_symbol_majority/);

  const recheck = evaluatePlan5DirectionRecheck({
    lock,
    upPrice: 0.10,
    downPrice: 0.90,
    config: { plan5DirectionRecheckEnabled: false }
  });
  assert.equal(recheck.direction, 'up');
  assert.equal(recheck.flipped, false);
  assert.equal(recheck.skipped, true);
});

test('Plan5 cannot create an order direction before the displayed lock exists', () => {
  const sentiment = {
    available: true,
    upPrice: 0.54,
    downPrice: 0.46,
    upProbability: 0.54,
    downProbability: 0.46,
    qualityScore: 0.9
  };
  const schedule = { elapsedInCurrentSlotPct: 0.40 };
  const missing = resolvePlan5EntryLock({
    intervalPmLock: null,
    sentiment,
    schedule,
    timeframe: '5m',
    config: { plan5RequireDisplayedLock: true }
  });
  assert.equal(missing, null);

  const displayed = resolvePlan5EntryLock({
    intervalPmLock: {
      source: 'polymarket',
      direction: 'up',
      strength: 'weak',
      pmGap: 0.08,
      confidence: 0.54,
      upProbability: 0.54,
      downProbability: 0.46,
      lockedAtIso: '2026-07-22T07:10:46.926Z'
    },
    sentiment,
    schedule,
    timeframe: '5m',
    config: { plan5RequireDisplayedLock: true }
  });
  assert.equal(displayed.direction, 'up');
  assert.equal(displayed.lockedAtIso, '2026-07-22T07:10:46.926Z');
});

test('Plan5 preserves a strong lock and a non-collapsed weak lock', () => {
  const strong = evaluatePlan5DirectionRecheck({
    lock: { direction: 'down', strength: 'strong', pmGap: 0.60, downProbability: 0.80 },
    upPrice: 0.69,
    downPrice: 0.31
  });
  assert.equal(strong.flipped, false);
  assert.equal(strong.direction, 'down');

  const stableWeak = evaluatePlan5DirectionRecheck({
    lock: { direction: 'down', strength: 'weak', pmGap: 0.13, downProbability: 0.565 },
    upPrice: 0.45,
    downPrice: 0.55,
    signal: { technicalDirection: 'down', spotDirection: 'down' }
  });
  assert.equal(stableWeak.flipped, false);
  assert.equal(stableWeak.direction, 'down');
});

test('Plan5 flips a weak lock when technical and spot directions both reverse', () => {
  const result = evaluatePlan5DirectionRecheck({
    lock: { direction: 'down', strength: 'weak', pmGap: 0.13, downProbability: 0.565 },
    upPrice: 0.36,
    downPrice: 0.64,
    signal: { direction: 'up', technicalDirection: 'up', spotDirection: 'up' }
  });
  assert.equal(result.flipped, true);
  assert.equal(result.direction, 'up');
  assert.equal(result.flipReason, 'technical_spot_reversal');
});

test('Plan5 preserves a collapsed side when technical and spot independently confirm the lock', () => {
  const result = evaluatePlan5DirectionRecheck({
    lock: { direction: 'up', strength: 'weak', pmGap: 0.27, upProbability: 0.635 },
    upPrice: 0.48,
    downPrice: 0.52,
    signal: { direction: 'up', technicalDirection: 'up', spotDirection: 'up' },
    config: { plan5DirectionRecheckCollapsePrice: 0.54 }
  });
  assert.equal(result.flipped, false);
  assert.equal(result.direction, 'up');
  assert.equal(result.originalSupport, 3);
});

test('price-aware lock compares payoff rather than preferring a high displayed win rate', () => {
  const selection = selectPlan5PriceAwareDirection({
    upProbability: 0.80,
    downProbability: 0.20,
    upPrice: 0.90,
    downPrice: 0.10,
    config: { plan5DirectionMinProbabilityEdge: 0, plan5DirectionMinExpectedRoi: 0 }
  });
  assert.equal(selection.direction, 'down');
  assert.equal(selection.allowed, true);
  assert.equal(selection.expectedRoi, 1);
});

test('20-cent winners remain eligible when their own data shows positive expectancy', () => {
  const orders = Array.from({ length: 12 }, (_, index) => ({
    planId: 'plan5',
    strategyVersion: 'plan5_independent_direction_v13',
    timeframe: '5m',
    symbol: 'BTC-USD',
    direction: 'down',
    entryPrice: 0.22,
    usd: 5,
    won: index < 6,
    pnl: index < 6 ? 17.72 : -5,
    settledAtIso: new Date(Date.UTC(2026, 6, 20, 0, index)).toISOString()
  }));
  const calibration = buildPlan5PriceCalibration({
    orders,
    direction: 'down',
    price: 0.22,
    timeframe: '5m',
    symbol: 'BTC-USD',
    baseProbability: 0.30,
    config: {
      plan5PriceCalibrationMinSamples: 8,
      plan5PriceCalibrationWeight: 0.6,
      plan5PriceCalibrationRecentSamples: 20
    }
  });
  assert.equal(calibration.bucket, '0.20-0.30');
  assert.equal(calibration.sampleCount, 12);
  assert.ok(calibration.realizedRoi > 0);
  assert.ok(calibration.probability > 0.30);
});

test('weak historical DOWN results lower confidence but never reverse the PM lock', () => {
  const targetTimeIso = '2026-07-21T04:00:00.000Z';
  const judgments = Array.from({ length: 30 }, (_, index) => ({
    targetTimeIso: new Date(Date.parse(targetTimeIso) - (index + 1) * 300_000).toISOString(),
    evaluatedAtIso: new Date(Date.parse(targetTimeIso) - index * 300_000).toISOString(),
    predictedDirection: 'down',
    lockStrength: 'weak',
    correct: index < 6,
    actualDirection: index < 6 ? 'down' : 'up'
  }));
  const decision = buildPlan5DirectionDecision({
    lock: { direction: 'down', strength: 'weak', confidence: 0.70 },
    sentiment: { upPrice: 0.45, downPrice: 0.55 },
    symbol: 'BTC-USD',
    timeframe: '5m',
    targetTimeIso,
    statsDb: { getDirectionJudgments: () => judgments },
    orders: [],
    config: {
      plan5DirectionMinSamples: 12,
      plan5DirectionRecentSamples: 30,
      plan5ContinuityEnabled: false,
      plan5PriceCalibrationEnabled: false,
      plan5DirectionMinProbabilityEdge: 0,
      plan5DirectionMinExpectedRoi: 0
    },
    now: new Date('2026-07-21T03:56:00.000Z')
  });
  assert.equal(decision.direction, 'down');
  assert.equal(decision.reversed, false);
  assert.ok(decision.probability < 0.70);
  assert.ok(decision.historyWeight <= 0.25);
});

test('recent settled rounds produce a measurable continuation/reversal input', () => {
  const directions = ['up', 'up', 'down', 'down', 'up', 'up', 'up', 'down', 'down', 'down', 'up', 'up', 'up'];
  const rows = directions.map((actualDirection, index) => ({
    targetTimeIso: new Date(Date.UTC(2026, 6, 20, 0, index * 5)).toISOString(),
    evaluatedAtIso: new Date(Date.UTC(2026, 6, 20, 0, index * 5 + 1)).toISOString(),
    actualDirection
  }));
  const evidence = buildPlan5ContinuityEvidence(rows, {
    targetTimeIso: '2026-07-21T00:00:00.000Z',
    minSamples: 3,
    maxStreak: 4
  });
  assert.equal(evidence.available, true);
  assert.equal(evidence.currentDirection, 'up');
  assert.equal(evidence.streak, 3);
  assert.ok(evidence.sampleCount > 0);
  assert.ok(evidence.continuationRate > 0 && evidence.continuationRate < 1);
});

test('PredictionRecorder blocks a direction with negative calibrated EV', () => {
  const targetTimeIso = '2026-07-21T04:00:00.000Z';
  const judgments = Array.from({ length: 24 }, (_, index) => ({
    targetTimeIso: new Date(Date.parse(targetTimeIso) - (index + 1) * 300_000).toISOString(),
    evaluatedAtIso: new Date(Date.parse(targetTimeIso) - index * 300_000).toISOString(),
    predictedDirection: 'down',
    lockStrength: 'weak',
    correct: index < 4,
    actualDirection: index < 4 ? 'down' : 'up'
  }));
  const statsDb = {
    getDirectionJudgments: () => judgments,
    getLossReasonOrders: () => []
  };
  const recorder = new PredictionRecorder({
    recordDir: 'unused',
    fetchQuotes: async () => [],
    statsDb,
    plan5Config: {
      plan5LockDirectionOptimizationEnabled: true,
      plan5DirectionMinSamples: 8,
      plan5ContinuityEnabled: false,
      plan5PriceCalibrationEnabled: false,
      plan5DirectionMinProbabilityEdge: 0,
      plan5DirectionMinExpectedRoi: 0
    }
  });
  recorder.pending.set(`5m_${targetTimeIso}_BTC-USD`, {
    decisionLocked: true,
    lockedPolymarketPredictedDirection: 'down',
    lockedPolymarketUpProbability: 0.30,
    lockedPolymarketDownProbability: 0.70,
    lockedPmGap: 0.40,
    lockStrength: 'weak',
    decisionLockedAtIso: '2026-07-21T03:56:00.000Z',
    predictedAtIso: '2026-07-21T03:56:00.000Z'
  });
  const first = recorder.getLockedFiveMinuteDecision('BTC-USD', targetTimeIso);
  assert.equal(first.direction, 'down');
  assert.equal(first.optimization.reversed, false);
  assert.equal(first.optimizationBlocked, true);
  assert.equal(first.optimization.allowed, false);
  assert.ok(first.optimization.probability < 0.70);

  judgments.splice(0, judgments.length);
  const second = recorder.getLockedFiveMinuteDecision('BTC-USD', targetTimeIso);
  assert.equal(second.direction, 'down');
  assert.notEqual(second, first);
  assert.equal(second.optimizationBlocked, undefined);
  assert.equal(second.optimization.allowed, true);
  assert.equal(second.optimization.reversed, false);
});

test('an orderable PM threshold is blocked when its ordinary EV estimate is negative', () => {
  const targetTimeIso = '2026-07-21T04:00:00.000Z';
  const recorder = new PredictionRecorder({
    recordDir: 'unused',
    fetchQuotes: async () => [],
    statsDb: {
      getDirectionJudgments: () => [],
      getLossReasonOrders: () => []
    },
    plan5Config: {
      plan5LockDirectionOptimizationEnabled: true,
      plan5ContinuityEnabled: false,
      plan5PriceCalibrationEnabled: false,
      plan5DirectionMinProbabilityEdge: 0.005,
      plan5DirectionMinExpectedRoi: 0.01
    }
  });
  recorder.pending.set(`5m_${targetTimeIso}_BTC-USD`, {
    decisionLocked: true,
    lockedPolymarketPredictedDirection: 'down',
    lockedPolymarketUpProbability: 0.01,
    lockedPolymarketDownProbability: 0.99,
    lockedPmGap: 0.98,
    lockStrength: 'strong',
    decisionLockedAtIso: '2026-07-21T03:59:00.000Z',
    predictedAtIso: '2026-07-21T03:59:00.000Z'
  });
  const raw = recorder.getLockedFiveMinuteDecision('BTC-USD', targetTimeIso);
  assert.equal(raw.optimizationBlocked, true);
  assert.equal(raw.optimization.allowed, false);
  const finalLock = resolvePlan5EntryLock({
    intervalPmLock: raw,
    sentiment: {
      available: true,
      upPrice: 0.01,
      downPrice: 0.99,
      upProbability: 0.01,
      downProbability: 0.99
    },
    schedule: { elapsedInCurrentSlotPct: 0.80 },
    timeframe: '5m'
  });
  assert.equal(finalLock, null);
});

test('live move strength can reverse the PM starting direction without skipping the window', () => {
  const strength = buildPlan5StrengthDirection({
    lockDirection: 'down',
    marketState: {
      startPrice: 100,
      currentPrice: 100.15,
      elapsedPct: 0.5,
      previousClosedCandleMovePct: 0.0005,
      recentClosedCandleMovesPct: [-0.0002, 0.0003, 0.0005]
    }
  });
  assert.equal(strength.available, true);
  assert.equal(strength.direction, 'up');
  assert.equal(strength.reversed, true);
  assert.ok(strength.currentMoveBps > 14);
});

test('PredictionRecorder publishes the strength-corrected side as Plan5 final lock', () => {
  const targetTimeIso = '2026-07-21T04:00:00.000Z';
  const recorder = new PredictionRecorder({
    recordDir: 'unused',
    fetchQuotes: async () => [],
    statsDb: { getDirectionJudgments: () => [], getLossReasonOrders: () => [] },
    plan5Config: {
      plan5LockDirectionOptimizationEnabled: true,
      plan5ContinuityEnabled: false,
      plan5PriceCalibrationEnabled: false
    }
  });
  recorder.pending.set(`5m_${targetTimeIso}_BTC-USD`, {
    decisionLocked: true,
    lockedPolymarketPredictedDirection: 'down',
    lockedPolymarketUpProbability: 0.30,
    lockedPolymarketDownProbability: 0.70,
    lockedPmGap: 0.40,
    lockStrength: 'weak',
    decisionLockedAtIso: '2026-07-21T03:56:00.000Z',
    predictedAtIso: '2026-07-21T03:56:00.000Z',
    lockedStartPrice: 100,
    lockedCurrentPrice: 100.15,
    lockElapsedPct: 0.5,
    lockedPreviousClosedCandleMovePct: 0.0005,
    lockedRecentClosedCandleMovesPct: [-0.0002, 0.0003, 0.0005]
  });
  const finalLock = recorder.getLockedFiveMinuteDecision('BTC-USD', targetTimeIso);
  assert.equal(finalLock.direction, 'up');
  assert.equal(finalLock.optimization.reversed, true);
  assert.equal(finalLock.optimization.directionModel, 'pm_spot_strength_v14');
  assert.match(finalLock.lockReason, /pm_spot_strength_v14/);
});

test('large recent cumulative move reduces continuation score instead of extending forever', () => {
  const common = {
    lockDirection: 'up',
    marketState: {
      startPrice: 100,
      currentPrice: 100.01,
      elapsedPct: 0.5,
      previousClosedCandleMovePct: 0.0008
    }
  };
  const neutral = buildPlan5StrengthDirection({
    ...common,
    marketState: { ...common.marketState, recentClosedCandleMovesPct: [0, 0, 0] }
  });
  const extended = buildPlan5StrengthDirection({
    ...common,
    marketState: { ...common.marketState, recentClosedCandleMovesPct: [0.0008, 0.0008, 0.0008] }
  });
  assert.ok(extended.score < neutral.score);
});

test('Plan5 live preflight reprices without changing the locked side and rejects expired windows', () => {
  const draft = {
    planId: 'plan5',
    direction: 'up',
    tokenId: 'up-token',
    targetTimeIso: '2026-07-21T04:00:00.000Z',
    limitPrice: 0.60,
    usd: 5,
    shares: 8.33
  };
  const repriced = repricePlan5LiveDraft(
    draft,
    0.64,
    { plan5LiveMinSecondsRemaining: 10 },
    new Date('2026-07-21T03:59:30.000Z')
  );
  assert.equal(repriced.direction, 'up');
  assert.equal(repriced.tokenId, 'up-token');
  assert.equal(repriced.intendedLimitPrice, 0.60);
  assert.equal(repriced.executionPreflightPrice, 0.64);
  const repricedHigher = repricePlan5LiveDraft(
    { ...draft, maxLivePrice: 0.70 },
    0.91,
    { plan5LiveMinSecondsRemaining: 10 },
    new Date('2026-07-21T03:59:30.000Z')
  );
  assert.equal(repricedHigher.direction, 'up');
  assert.equal(repricedHigher.executionPreflightPrice, 0.91);
  assert.throws(
    () => repricePlan5LiveDraft(
      draft,
      0.01,
      { plan5LiveMinSecondsRemaining: 10 },
      new Date('2026-07-21T04:00:01.000Z')
    ),
    /迟到单/
  );
});

test('Plan5 marks the locked side as a reversal candidate only below 20c', () => {
  const orders = Array.from({ length: 33 }, (_, index) => ({
    planId: 'plan5',
    strategyVersion: 'plan5_independent_direction_v13',
    timeframe: '5m',
    symbol: index < 4 ? 'ETH-USD' : 'BTC-USD',
    direction: 'down',
    entryPrice: 0.0543,
    usd: 5,
    won: false,
    pnl: -5,
    settledAtIso: new Date(Date.UTC(2026, 6, 20, 0, index)).toISOString()
  }));
  const result = evaluatePlan5LiveAdversePriceMove({
    draft: {
      planId: 'plan5',
      symbol: 'ETH-USD',
      timeframe: '5m',
      direction: 'down',
      limitPrice: 0.27,
      confidence: 0.3982
    },
    freshPrice: 0.0543,
    orders,
    config: {
      plan5LiveMaxAdversePriceDropAbs: 1,
      plan5LiveMaxAdversePriceDropPct: 1,
      plan5LiveAdverseMoveMinPriceSamples: 8,
      plan5PriceCalibrationMinSamples: 8,
      plan5PriceCalibrationRecentSamples: 20
    }
  });
  assert.equal(result.severe, true);
  assert.equal(result.allowed, false);
  assert.equal(result.reversalCandidate, true);
  assert.equal(result.reversalPriceThreshold, 0.20);
  assert.match(result.reason, /低于硬拦截线/);
});

test('Plan5 sub-20c reversal check is independent of historical price-band ROI', () => {
  const orders = Array.from({ length: 12 }, (_, index) => ({
    planId: 'plan5',
    strategyVersion: 'plan5_independent_direction_v13',
    timeframe: '5m',
    symbol: 'ETH-USD',
    direction: 'down',
    entryPrice: 0.12,
    usd: 5,
    won: index < 4,
    pnl: index < 4 ? 36.67 : -5,
    settledAtIso: new Date(Date.UTC(2026, 6, 20, 0, index)).toISOString()
  }));
  const result = evaluatePlan5LiveAdversePriceMove({
    draft: {
      planId: 'plan5',
      symbol: 'ETH-USD',
      timeframe: '5m',
      direction: 'down',
      limitPrice: 0.24,
      confidence: 0.40
    },
    freshPrice: 0.12,
    orders,
    config: {
      plan5LiveMaxAdversePriceDropAbs: 1,
      plan5LiveMaxAdversePriceDropPct: 1,
      plan5LiveAdverseMoveMinPriceSamples: 8,
      plan5PriceCalibrationMinSamples: 8,
      plan5PriceCalibrationRecentSamples: 20
    }
  });
  assert.equal(result.severe, true);
  assert.equal(result.allowed, false);
  assert.equal(result.reversalCandidate, true);
});

test('Plan5 allows only a micro probe in the historically positive 15-20c band', () => {
  const result = evaluatePlan5LiveAdversePriceMove({
    draft: { limitPrice: 0.42 },
    freshPrice: 0.17,
    config: {
      plan5LiveReversalPriceThreshold: 0.20,
      plan5LiveReversalProbeFloor: 0.15,
      plan5LiveReversalProbeSizeScale: 0.20,
      plan5LiveReversalMicroProbeEnabled: true,
      plan5LiveMaxAdversePriceDropAbs: 1,
      plan5LiveMaxAdversePriceDropPct: 1
    }
  });
  assert.equal(result.allowed, true);
  assert.equal(result.microProbe, true);
  assert.equal(result.reversalCandidate, true);
  assert.equal(result.sizeScale, 0.20);
});

test('Plan5 still blocks a reversal quote below the 15c probe floor', () => {
  const result = evaluatePlan5LiveAdversePriceMove({
    draft: { limitPrice: 0.42 },
    freshPrice: 0.14,
    config: {
      plan5LiveReversalPriceThreshold: 0.20,
      plan5LiveReversalProbeFloor: 0.15,
      plan5LiveMaxAdversePriceDropAbs: 1,
      plan5LiveMaxAdversePriceDropPct: 1
    }
  });
  assert.equal(result.allowed, false);
  assert.equal(result.severe, true);
  assert.equal(result.reversalCandidate, true);
});

test('Plan5 ignores mild post-lock drops that remain above the hard min entry', () => {
  const result = evaluatePlan5LiveAdversePriceMove({
    draft: { limitPrice: 0.60 },
    freshPrice: 0.42,
    orders: [],
    config: {
      plan5LiveReversalPriceThreshold: 0.20,
      plan5HardMinEntryPrice: 0.35,
      plan5LiveMaxAdversePriceDropAbs: 0.20,
      plan5LiveMaxAdversePriceDropPct: 0.40
    }
  });
  assert.equal(result.allowed, true);
  assert.equal(result.severe, false);
  assert.equal(result.reversalCandidate, false);
});

test('Plan5 hard-blocks collapsed tickets between hard min and the 20c reversal line', () => {
  const result = evaluatePlan5LiveAdversePriceMove({
    draft: { limitPrice: 0.66 },
    freshPrice: 0.26,
    orders: [],
    config: {
      plan5LiveReversalPriceThreshold: 0.20,
      plan5HardMinEntryPrice: 0.35,
      plan5LiveMaxAdversePriceDropAbs: 1,
      plan5LiveMaxAdversePriceDropPct: 1
    }
  });
  assert.equal(result.allowed, false);
  assert.equal(result.severe, true);
  assert.equal(result.hardMinEntryBlocked, true);
  assert.match(result.reason, /硬下限/);
});

test('Plan5 rejects large adverse drop from decision price before fill', () => {
  const result = evaluatePlan5LiveAdversePriceMove({
    draft: { limitPrice: 0.66, intendedLimitPrice: 0.66 },
    freshPrice: 0.26,
    config: {
      plan5HardMinEntryPrice: 0.20,
      plan5LiveMaxAdversePriceDropAbs: 0.12,
      plan5LiveMaxAdversePriceDropPct: 0.25
    }
  });
  assert.equal(result.allowed, false);
  assert.equal(result.adverseDropBlocked, true);
  assert.match(result.reason, /超过允许回撤/);
});

test('Plan5 keeps the direction and does not block a post-lock price increase', () => {
  const allowed = evaluatePlan5LiveAdversePriceMove({
    draft: { limitPrice: 0.69 },
    freshPrice: 0.78,
    config: { plan5LiveMaxPriceChaseAbs: 1 }
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.priceChaseBlocked, undefined);
  assert.equal(allowed.reversalCandidate, false);

  const tolerated = evaluatePlan5LiveAdversePriceMove({
    draft: { limitPrice: 0.69 },
    freshPrice: 0.71,
    config: { plan5LiveMaxPriceChaseAbs: 0.02 }
  });
  assert.equal(tolerated.allowed, true);
  assert.equal(tolerated.reversalCandidate, false);
});
