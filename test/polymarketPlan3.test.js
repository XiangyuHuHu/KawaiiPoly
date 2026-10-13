import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyPlan3LiveMinOrder,
  buildPlan3SlotKey,
  buildPolymarketPaperPlan3,
  calculatePlan3OrderUsd,
  choosePlan3LimitPrice,
  computePlan3Analytics,
  computeRecentReverseBps,
  resolvePlan3FinalOrderUsd,
  computeVolatilityBpsPerSecond,
  describePlan3SettlementSkip,
  isEffectivelySettled,
  isInPlan3TimeWindow,
  isPlan3PaperTrading,
  isPlan3SlotSubmissionLocked,
  isPlan3WideBandRuntimeEnabled,
  passesPlan3RiskChecks,
  resolvePlan3CaptureTier,
  resolvePlan3EarlySecondsWindow,
  resolvePlan3EntrySpread,
  resolvePlan3MaxSpreadForEntry,
  resolvePlan3RuntimeConfig,
  resolvePlan3SecondsWindow,
  resolvePlan3WinningTokenPrice,
  repricePlan3LiveDraft,
  estimatePlan3ExpectedFillPrice,
  evaluatePlan3EntryConfirmation,
  evaluatePlan3BandStatsGate,
  evaluatePlan3QuoteCoherence
} from '../src/polymarketPlan3.js';

test('Plan3 quote coherence rejects stale crossed binary quotes', () => {
  assert.equal(evaluatePlan3QuoteCoherence({ upPrice: 0.99, downPrice: 0.615 }).allowed, false);
  assert.equal(evaluatePlan3QuoteCoherence({ upPrice: 0.52, downPrice: 0.50 }).allowed, true);
});

test('Plan3 entry confirmation requires PM/underlying alignment and stable leadership', () => {
  const now = new Date('2026-07-10T06:00:20.000Z');
  const samples = [0, 3, 6, 9, 12].map((sec, index) => ({
    ts: Date.parse('2026-07-10T06:00:00.000Z') + sec * 1000,
    upPrice: 0.91 + index * 0.01,
    downPrice: 0.08 - index * 0.01
  }));
  const stable = evaluatePlan3EntryConfirmation({
    direction: 'up',
    tradeDirection: 'up',
    samples,
    timeframe: '5m',
    now,
    config: { plan3EntryConfirmationEnabled: true, plan3ConfirmationMinSamples: 4, plan3ConfirmationMinStableMs5m: 6000 }
  });
  assert.equal(stable.allowed, true);
  assert.ok(stable.stableMs >= 6000);

  const conflict = evaluatePlan3EntryConfirmation({
    direction: 'down',
    tradeDirection: 'up',
    samples,
    timeframe: '5m',
    now,
    config: { plan3EntryConfirmationEnabled: true, plan3RequirePmTechAlignment: true }
  });
  assert.equal(conflict.allowed, false);
  assert.match(conflict.reason, /不一致/);
});

test('Plan3 dynamic settlement uses a volatility floor', () => {
  assert.equal(isEffectivelySettled({
    timeframe: '5m',
    secondsRemaining: 60,
    distanceFromOpenBps: 5,
    recentReverseBps: 0,
    volatilityBpsPerSecond: 0,
    config: {
      plan3PaperMode: true,
      plan3PaperWideBand: true,
      plan3MinSecondsRemaining5m: 12,
      plan3MaxSecondsRemaining5m: 60,
      plan3PaperMinDirectionalBps: 0.5,
      plan3DynamicSettlementEnabled: true,
      plan3PaperDynamicSettlementEnabled: true,
      plan3DynamicMinVolatilityBpsPerSecond: 0.05,
      plan3DynamicSafetyMultiplier: 2
    }
  }), false);
});

test('Plan3 paperMode stays independent when live mode is enabled', () => {
  const config = {
    ...baseConfig,
    plan3LiveEnabled: true,
    liveTradingEnabled: true,
    plan3PaperRelaxedEnabled: true,
    plan3PaperWideBandEnabled: true,
    plan3PaperWideMinPrice: 0.93,
    plan3PaperWideMaxPrice: 0.95,
    plan3PaperWideMinSecondsRemaining5m: 12,
    plan3PaperWideMaxSecondsRemaining5m: 60,
    plan3Paper15mEnabled: false,
    plan3PaperUsePmLeadingPrice: false,
    plan3PaperBandStatsGateEnabled: false,
    plan3PaperDynamicSettlementEnabled: false,
    plan3EntryConfirmationEnabled: false,
    plan3PaperMinOrderUsd: 10,
    plan3PaperMaxOrderPct: 0.05,
    plan3ProbSizingEnabled: false
  };
  const args = {
    signal: {
      symbol: 'BTC-USD',
      schedule: {
        currentSlotIso: '2026-07-10T06:00:00.000Z',
        nextSlotIso: '2026-07-10T06:05:00.000Z',
        secondsToNext: 30
      },
      prediction: { comparisonBasePrice: 100000 },
      indicators: { currentPrice: 100100, slotStartPrice: 100000 }
    },
    sentiment: {
      available: true,
      upPrice: 0.94,
      downPrice: 0.05,
      qualityScore: 0.8,
      upTokenId: 'up',
      downTokenId: 'down'
    },
    config,
    portfolio: { portfolioInitialized: true, startingCash: 500, equity: 500, cash: 100 },
    plan3BandStats: { '93-95': { total: 100, wins: 80, winRate: 0.8 } },
    paperMode: true,
    now: new Date('2026-07-10T06:04:30.000Z')
  };
  const paper = buildPolymarketPaperPlan3({ ...args, timeframe: '5m' });
  assert.equal(paper.action.shouldTrade, true);
  assert.equal(paper.action.paperMode, true);
  assert.equal(paper.action.strategyVersion, 'plan3_execution_v4');
  assert.equal(paper.action.usd, 10);

  const eth = buildPolymarketPaperPlan3({
    ...args,
    signal: { ...args.signal, symbol: 'ETH-USD' },
    sentiment: { ...args.sentiment, symbol: 'ETH-USD' },
    timeframe: '5m'
  });
  assert.equal(eth.symbol, 'ETH-USD');
  assert.match(eth.action.executionKey, /_ETH_5m_plan3_/);
  assert.notEqual(eth.action.executionKey, paper.action.executionKey);

  const disabled15m = buildPolymarketPaperPlan3({ ...args, timeframe: '15m' });
  assert.equal(disabled15m.action.shouldTrade, false);
  assert.equal(disabled15m.action.skipReason, 'paper_timeframe_not_validated');
});

const baseConfig = {
  plan3Enabled: true,
  plan3PaperFillEnabled: true,
  plan3MinSecondsRemaining5m: 3,
  plan3MaxSecondsRemaining5m: 10,
  plan3MinSecondsRemaining15m: 5,
  plan3MaxSecondsRemaining15m: 20,
  plan3MinDistanceBps5m: 22,
  plan3MinDistanceBps15m: 30,
  plan3MaxReverseBps: 2,
  plan3ReverseLookbackSeconds: 3,
  plan3MinPrice: 0.990,
  plan3MaxPrice: 0.998,
  plan3MinMarketQuality: 0.65,
  plan3MaxSpread: 0.01,
  plan3PriceMode: 'balanced',
  plan3PriceBalanced: 0.995,
  plan3OrderPct: 0.003,
  plan3ProbSizingEnabled: true,
  plan3ProbSizingReferenceOrderUsd: 100,
  plan3ProbSizingReferenceEquity: 500,
  plan3ProbSizingReferencePrice: 0.99,
  plan3MaxOrderPct: 0.25,
  plan3MaxSlotExposurePct: 0.25,
  plan3EarlyCaptureEnabled: true,
  plan3EarlyMinPrice: 0.90,
  plan3EarlyMaxPrice: 0.989,
  plan3EarlyMinSecondsRemaining5m: 46,
  plan3EarlyMaxSecondsRemaining5m: 120,
  plan3EarlyMinDistanceBps5m: 18,
  plan3EarlyMinDirectionalBps: 8,
  plan3PaperWideBandEnabled: true,
  plan3PaperWideMinPrice: 0.93,
  plan3PaperWideMaxPrice: 0.998,
  plan3PaperUsePmLeadingPrice: true,
  plan3DailyLossLimitPct: 0.01,
  plan3StopAfterOneLoss: false,
  plan3OrderTtlMs5m: 3000,
  plan3OrderTtlMs15m: 5000,
  defaultStartingCash: 600,
  liveMinSharesBuffer: 6
};

test('resolvePlan3SecondsWindow returns timeframe-specific bounds', () => {
  assert.deepEqual(resolvePlan3SecondsWindow('5m', baseConfig), { min: 3, max: 10 });
  assert.deepEqual(resolvePlan3SecondsWindow('15m', baseConfig), { min: 5, max: 20 });
});

test('Plan3 live wide runtime uses live execution bounds instead of paper bounds', () => {
  const runtime = resolvePlan3RuntimeConfig({
    ...baseConfig,
    plan3LiveEnabled: true,
    plan3LiveWideBandEnabled: true,
    plan3LiveWideMinPrice: 0.94,
    plan3LiveWideMaxPrice: 0.985,
    plan3LiveWideMinSecondsRemaining5m: 20,
    plan3LiveWideMaxSecondsRemaining5m: 90,
    plan3PaperWideMinSecondsRemaining5m: 5,
    plan3PaperWideMaxSecondsRemaining5m: 240
  });
  assert.equal(runtime.plan3PaperMode, true);
  assert.deepEqual(resolvePlan3SecondsWindow('5m', runtime), { min: 20, max: 90 });
  assert.equal(runtime.plan3MinPrice, 0.94);
  assert.equal(runtime.plan3MaxPrice, 0.985);
});

test('Plan3 live preflight reprices at executable ask and enforces EV cap', () => {
  const draft = {
    planId: 'plan3',
    limitPrice: 0.97,
    usd: 10,
    shares: 10.3093,
    maxLivePrice: 0.99
  };
  const repriced = repricePlan3LiveDraft(draft, 0.985, {});
  assert.equal(repriced.limitPrice, 0.985);
  assert.equal(repriced.executionPreflightPrice, 0.985);
  assert.equal(repriced.intendedLimitPrice, 0.97);
  assert.throws(() => repricePlan3LiveDraft(draft, 0.995, {}), /positive-EV cap/);
});

test('isInPlan3TimeWindow gates last-second execution window', () => {
  assert.equal(isInPlan3TimeWindow('5m', 7, baseConfig), true);
  assert.equal(isInPlan3TimeWindow('5m', 2, baseConfig), false);
  assert.equal(isInPlan3TimeWindow('5m', 30, baseConfig), false);
  assert.equal(isInPlan3TimeWindow('15m', 12, baseConfig), true);
  assert.equal(isInPlan3TimeWindow('15m', 4, baseConfig), false);
});

test('computeRecentReverseBps measures pullback from peak for UP direction', () => {
  const now = new Date('2026-07-01T10:09:57.000Z');
  const samples = [
    { ts: now.getTime() - 2500, btcPrice: 100030 },
    { ts: now.getTime() - 1500, btcPrice: 100050 },
    { ts: now.getTime() - 500, btcPrice: 100040 }
  ];
  const reverse = computeRecentReverseBps({
    direction: 'up',
    samples,
    lookbackSeconds: 3,
    now
  });
  assert.ok(reverse > 0);
  assert.ok(reverse < 2);
});

test('isEffectivelySettled enforces distance, reverse move, and time window', () => {
  assert.equal(isEffectivelySettled({
    timeframe: '5m',
    secondsRemaining: 7,
    distanceFromOpenBps: 25,
    recentReverseBps: 1,
    config: baseConfig
  }), true);

  assert.equal(isEffectivelySettled({
    timeframe: '5m',
    secondsRemaining: 7,
    distanceFromOpenBps: 10,
    recentReverseBps: 1,
    config: baseConfig
  }), false);

  assert.equal(isEffectivelySettled({
    timeframe: '5m',
    secondsRemaining: 7,
    distanceFromOpenBps: 25,
    recentReverseBps: 3,
    config: baseConfig
  }), false);
});

test('choosePlan3LimitPrice respects mode and clamps to ask', () => {
  const conservative = choosePlan3LimitPrice({
    tokenPrice: 0.996,
    config: { ...baseConfig, plan3PriceMode: 'conservative', plan3PriceConservative: 0.992 }
  });
  assert.equal(conservative, 0.992);

  const balanced = choosePlan3LimitPrice({
    tokenPrice: 0.993,
    config: baseConfig
  });
  assert.equal(balanced, 0.993);
});

test('applyPlan3LiveMinOrder bumps to CLOB minimum when within equity cap', () => {
  assert.equal(applyPlan3LiveMinOrder({
    calculatedUsd: 1.8,
    clobMinUsd: 2.5,
    equity: 600,
    config: baseConfig
  }), 2.5);

  assert.equal(applyPlan3LiveMinOrder({
    calculatedUsd: 1.8,
    clobMinUsd: 5.97,
    equity: 600,
    config: baseConfig
  }), 0);
});

test('calculatePlan3OrderUsd uses 10% of remaining cash with $50 minimum', () => {
  const cashConfig = {
    plan3ProbSizingEnabled: false,
    plan3MinOrderUsd: 50,
    plan3MaxOrderPct: 0.10
  };

  assert.equal(calculatePlan3OrderUsd({
    equity: 1000,
    cash: 800,
    config: cashConfig,
    paperMode: true
  }), 80);

  assert.equal(calculatePlan3OrderUsd({
    equity: 200,
    cash: 180,
    config: cashConfig,
    paperMode: true
  }), 50);

  assert.equal(calculatePlan3OrderUsd({
    equity: 40,
    cash: 40,
    config: cashConfig,
    paperMode: true
  }), 0);
});

test('isPlan3SlotSubmissionLocked ignores blocked and expired entries', () => {
  assert.equal(isPlan3SlotSubmissionLocked({ fillStatus: 'blocked' }), false);
  assert.equal(isPlan3SlotSubmissionLocked({ fillStatus: 'expired' }), false);
  assert.equal(isPlan3SlotSubmissionLocked({ fillStatus: 'filled' }), true);
  assert.equal(isPlan3SlotSubmissionLocked({ fillStatus: 'submitted' }), true);
});

test('buildPolymarketPaperPlan3 allows retry when prior slot entry was blocked only', () => {
  const now = new Date('2026-07-01T10:09:57.000Z');
  const slotOpenPrice = 100000;
  const referencePrice = 100230;
  const submitKey = buildPlan3SlotKey('2026-07-01T10:05:00.000Z', '5m', 'up', 'BTC-USD');

  const plan = buildPolymarketPaperPlan3({
    signal: {
      schedule: {
        currentSlotIso: '2026-07-01T10:05:00.000Z',
        nextSlotIso: '2026-07-01T10:10:00.000Z',
        secondsToNext: 3
      },
      prediction: { comparisonBasePrice: slotOpenPrice },
      indicators: { currentPrice: referencePrice, slotStartPrice: slotOpenPrice }
    },
    sentiment: {
      available: true,
      upPrice: 0.994,
      downPrice: 0.006,
      spread: 0.004,
      qualityScore: 0.8
    },
    config: { ...baseConfig, plan3LiveEnabled: false, plan3PaperRelaxedEnabled: true },
    timeframe: '5m',
    portfolio: { portfolioInitialized: true, equity: 500, startingCash: 500, cash: 500 },
    openExposureOrders: [],
    plan3Daily: {},
    alreadySubmittedKeys: new Set(),
    now
  });

  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.executionKey, submitKey);
  assert.equal(submitKey.endsWith('_up'), true);

  const blockedRetry = buildPolymarketPaperPlan3({
    signal: {
      schedule: {
        currentSlotIso: '2026-07-01T10:05:00.000Z',
        nextSlotIso: '2026-07-01T10:10:00.000Z',
        secondsToNext: 3
      },
      prediction: { comparisonBasePrice: slotOpenPrice },
      indicators: { currentPrice: referencePrice, slotStartPrice: slotOpenPrice }
    },
    sentiment: {
      available: true,
      upPrice: 0.994,
      downPrice: 0.006,
      spread: 0.004,
      qualityScore: 0.8
    },
    config: { ...baseConfig, plan3LiveEnabled: false, plan3PaperRelaxedEnabled: true },
    timeframe: '5m',
    portfolio: { portfolioInitialized: true, equity: 500, startingCash: 500, cash: 500 },
    openExposureOrders: [],
    plan3Daily: {},
    alreadySubmittedKeys: new Set(),
    now
  });
  assert.equal(blockedRetry.action.shouldTrade, true);

  const filledSkip = buildPolymarketPaperPlan3({
    signal: {
      schedule: {
        currentSlotIso: '2026-07-01T10:05:00.000Z',
        nextSlotIso: '2026-07-01T10:10:00.000Z',
        secondsToNext: 3
      },
      prediction: { comparisonBasePrice: slotOpenPrice },
      indicators: { currentPrice: referencePrice, slotStartPrice: slotOpenPrice }
    },
    sentiment: {
      available: true,
      upPrice: 0.994,
      downPrice: 0.006,
      spread: 0.004,
      qualityScore: 0.8
    },
    config: { ...baseConfig, plan3LiveEnabled: false, plan3PaperRelaxedEnabled: true },
    timeframe: '5m',
    portfolio: { portfolioInitialized: true, equity: 500, startingCash: 500, cash: 500 },
    openExposureOrders: [],
    plan3Daily: {},
    alreadySubmittedKeys: new Set([submitKey]),
    now
  });
  assert.equal(filledSkip.action.skipReason, 'already_submitted_this_slot');
});

test('calculatePlan3OrderUsd scales with token probability on reference equity', () => {
  const at99 = calculatePlan3OrderUsd({
    equity: 500,
    tokenPrice: 0.99,
    config: baseConfig,
    paperMode: true
  });
  assert.equal(at99, 100);

  const at90 = calculatePlan3OrderUsd({
    equity: 500,
    tokenPrice: 0.90,
    config: baseConfig,
    paperMode: true
  });
  assert.equal(at90, 90.91);
});

test('calculatePlan3OrderUsd paper mode ignores CLOB minimum on small principal', () => {
  const usd = calculatePlan3OrderUsd({
    equity: 500,
    tokenPrice: 0.995,
    clobMinUsd: 5.97,
    config: baseConfig,
    paperMode: true
  });
  assert.equal(usd, 100.51);
});

test('calculatePlan3OrderUsd defaults to 100 reference sizing instead of tiny max cap', () => {
  const usd = calculatePlan3OrderUsd({
    equity: 600,
    tokenPrice: 0.99,
    config: {
      plan3ProbSizingEnabled: true,
      plan3ProbSizingReferenceOrderUsd: 100,
      plan3ProbSizingReferenceEquity: 500,
      plan3ProbSizingReferencePrice: 0.99,
      plan3MaxOrderPct: 0.10
    },
    paperMode: true
  });

  assert.equal(usd, 60);
});

test('resolvePlan3FinalOrderUsd keeps cash-pct sizing, caps only prob sizing', () => {
  assert.equal(resolvePlan3FinalOrderUsd(146.5, {
    plan3LiveEnabled: true,
    plan3ProbSizingEnabled: false
  }), 146.5);
  assert.equal(resolvePlan3FinalOrderUsd(146.5, {
    plan3LiveEnabled: true,
    plan3ProbSizingEnabled: true,
    plan3LiveMaxOrderUsd: 100
  }), 100);
});

test('resolvePlan3EntrySpread uses the trading side spread before global market spread', () => {
  assert.equal(resolvePlan3EntrySpread({
    direction: 'down',
    sentiment: {
      spread: 0.495,
      upSpread: 0.495,
      downSpread: 0.01,
      upPrice: 0.02,
      downPrice: 0.97
    }
  }), 0.01);
});

test('passesPlan3RiskChecks blocks daily loss and isolates paper exposure by plan', () => {
  const blockedDaily = passesPlan3RiskChecks({
    equity: 600,
    slotIso: '2026-07-01T10:05:00.000Z',
    direction: 'up',
    newOrderUsd: 2,
    openExposureOrders: [],
    plan3Daily: { stopped: true, stopReason: 'stop_after_one_loss' },
    config: { ...baseConfig, plan3LiveEnabled: true, plan3StopAfterOneLoss: true }
  });
  assert.equal(blockedDaily.allowed, false);
  assert.equal(blockedDaily.reason, 'stop_after_one_loss');

  const resumedAfterLoss = passesPlan3RiskChecks({
    equity: 600,
    slotIso: '2026-07-01T10:05:00.000Z',
    direction: 'up',
    newOrderUsd: 2,
    openExposureOrders: [],
    plan3Daily: { stopped: true, stopReason: 'stop_after_one_loss', lossCount: 1 },
    config: baseConfig
  });
  assert.equal(resumedAfterLoss.allowed, true);

  const blockedOpposite = passesPlan3RiskChecks({
    equity: 600,
    slotIso: '2026-07-01T10:05:00.000Z',
    direction: 'up',
    newOrderUsd: 2,
    openExposureOrders: [{
      slotIso: '2026-07-01T10:05:00.000Z',
      direction: 'down',
      planId: 'plan2',
      settlementStatus: 'open',
      usd: 10
    }],
    plan3Daily: {},
    config: baseConfig
  });
  assert.equal(blockedOpposite.allowed, true);

  const blockedOwnOpposite = passesPlan3RiskChecks({
    equity: 600,
    slotIso: '2026-07-01T10:05:00.000Z',
    direction: 'up',
    newOrderUsd: 2,
    openExposureOrders: [{
      slotIso: '2026-07-01T10:05:00.000Z',
      direction: 'down',
      planId: 'plan3',
      settlementStatus: 'open',
      usd: 10
    }],
    plan3Daily: {},
    config: baseConfig
  });
  assert.equal(blockedOwnOpposite.allowed, false);
  assert.equal(blockedOwnOpposite.reason, 'opposite_direction_exposure_conflict');

  const blockedLiveCrossPlan = passesPlan3RiskChecks({
    equity: 600,
    slotIso: '2026-07-01T10:05:00.000Z',
    direction: 'up',
    newOrderUsd: 2,
    openExposureOrders: [{
      slotIso: '2026-07-01T10:05:00.000Z',
      direction: 'down',
      planId: 'plan2',
      settlementStatus: 'open',
      usd: 10
    }],
    plan3Daily: {},
    config: { ...baseConfig, plan3LiveEnabled: true }
  });
  assert.equal(blockedLiveCrossPlan.allowed, false);
  assert.equal(blockedLiveCrossPlan.reason, 'opposite_direction_exposure_conflict');
});

test('passesPlan3RiskChecks ignores daily stop flags in paper mode', () => {
  const paperStopped = passesPlan3RiskChecks({
    equity: 600,
    slotIso: '2026-07-01T10:05:00.000Z',
    direction: 'up',
    newOrderUsd: 2,
    openExposureOrders: [],
    plan3Daily: {
      stopped: true,
      stopReason: 'stop_after_one_loss',
      lossCount: 3,
      realizedPnl: -200
    },
    config: {
      ...baseConfig,
      plan3LiveEnabled: false,
      plan3StopAfterOneLoss: true,
      plan3DailyLossLimitEnabled: true
    }
  });

  assert.equal(paperStopped.allowed, true);
});

test('resolvePlan3CaptureTier picks early band before late settlement window', () => {
  const splitConfig = { ...baseConfig, plan3PaperWideBandEnabled: false };
  const early = resolvePlan3CaptureTier({
    timeframe: '5m',
    secondsRemaining: 80,
    tokenPrice: 0.93,
    config: { ...splitConfig, plan3PaperWideBand: false }
  });
  assert.equal(early?.tier, 'early');
  assert.equal(early?.entryType, 'settlement_capture_early');

  const late = resolvePlan3CaptureTier({
    timeframe: '5m',
    secondsRemaining: 8,
    tokenPrice: 0.994,
    config: { ...splitConfig, plan3PaperWideBand: false }
  });
  assert.equal(late?.tier, 'late');
  assert.equal(late?.entryType, 'settlement_capture');
});

test('buildPolymarketPaperPlan3 wide band buys at 93c as soon as window opens', () => {
  const now = new Date('2026-07-01T10:08:40.000Z');
  const slotOpenPrice = 100000;
  const referencePrice = 100200;

  const plan = buildPolymarketPaperPlan3({
    signal: {
      schedule: {
        currentSlotIso: '2026-07-01T10:05:00.000Z',
        nextSlotIso: '2026-07-01T10:10:00.000Z',
        secondsToNext: 80
      },
      prediction: { comparisonBasePrice: slotOpenPrice },
      indicators: { currentPrice: referencePrice, slotStartPrice: slotOpenPrice }
    },
    sentiment: {
      available: true,
      upPrice: 0.93,
      downPrice: 0.07,
      spread: 0.02,
      qualityScore: 0.8
    },
    config: { ...baseConfig, plan3LiveEnabled: false, plan3PaperRelaxedEnabled: true },
    timeframe: '5m',
    portfolio: { portfolioInitialized: true, equity: 500, startingCash: 500 },
    openExposureOrders: [],
    plan3Daily: {},
    alreadySubmittedKeys: new Set(),
    now
  });

  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.captureTier, 'wide');
  assert.equal(plan.action.priceBand, '93-95');
  assert.equal(plan.action.limitPrice, 0.93);
  assert.ok(plan.action.usd >= 85);
});

test('resolvePlan3RuntimeConfig keeps live wide band above paper test floor', () => {
  const runtime = resolvePlan3RuntimeConfig({
    ...baseConfig,
    plan3LiveEnabled: true,
    plan3LiveWideBandEnabled: true,
    plan3LiveWideMinPrice: 0.93,
    plan3PaperWideMinPrice: 0.96
  });
  assert.equal(runtime.plan3PaperWideBand, true);
  assert.equal(runtime.plan3MinPrice, 0.93);
  assert.equal(runtime.plan3MaxSecondsRemaining5m, 120);
  assert.equal(runtime.plan3PaperMinDirectionalBps, 0.5);
});

test('isPlan3WideBandRuntimeEnabled defaults live to wide band', () => {
  assert.equal(isPlan3WideBandRuntimeEnabled({ plan3LiveEnabled: true }), true);
  assert.equal(isPlan3WideBandRuntimeEnabled({ plan3LiveEnabled: true, plan3LiveWideBandEnabled: false }), false);
  assert.equal(isPlan3WideBandRuntimeEnabled({ plan3LiveEnabled: false, plan3PaperRelaxedEnabled: true }), true);
});

test('buildPolymarketPaperPlan3 live wide band buys at 93c', () => {
  const now = new Date('2026-07-01T10:08:40.000Z');
  const slotOpenPrice = 100000;
  const referencePrice = 100200;

  const plan = buildPolymarketPaperPlan3({
    signal: {
      schedule: {
        currentSlotIso: '2026-07-01T10:05:00.000Z',
        nextSlotIso: '2026-07-01T10:10:00.000Z',
        secondsToNext: 80
      },
      prediction: { comparisonBasePrice: slotOpenPrice },
      indicators: { currentPrice: referencePrice, slotStartPrice: slotOpenPrice }
    },
    sentiment: {
      available: true,
      upPrice: 0.93,
      downPrice: 0.07,
      spread: 0.02,
      qualityScore: 0.8
    },
    config: {
      ...baseConfig,
      plan3LiveEnabled: true,
      plan3LiveWideBandEnabled: true,
      plan3LiveMaxOrderUsd: 100,
      liveTradingEnabled: true
    },
    timeframe: '5m',
    portfolio: { portfolioInitialized: true, equity: 500, startingCash: 500 },
    openExposureOrders: [],
    plan3Daily: {},
    alreadySubmittedKeys: new Set(),
    now
  });

  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.captureTier, 'wide');
  assert.equal(plan.action.limitPrice, 0.93);
  assert.equal(plan.action.paperDirectFill, false);
  assert.ok(plan.action.usd >= 85);
  assert.ok(plan.action.usd <= 100);
});

test('buildPolymarketPaperPlan3 wide band uses PM leading price when directional side is out of band', () => {
  const now = new Date('2026-07-06T07:19:55.000Z');
  const slotOpenPrice = 100000;
  const referencePrice = 100063;

  const plan = buildPolymarketPaperPlan3({
    signal: {
      schedule: {
        currentSlotIso: '2026-07-06T07:15:00.000Z',
        nextSlotIso: '2026-07-06T07:20:00.000Z',
        secondsToNext: 6
      },
      prediction: { comparisonBasePrice: slotOpenPrice },
      indicators: { currentPrice: referencePrice, slotStartPrice: slotOpenPrice }
    },
    sentiment: {
      available: true,
      upPrice: 0.01,
      downPrice: 0.98,
      spread: 0.02,
      qualityScore: 0.8
    },
    config: { ...baseConfig, plan3LiveEnabled: false, plan3PaperRelaxedEnabled: true, plan3PaperUsePmLeadingPrice: true },
    timeframe: '5m',
    portfolio: { portfolioInitialized: true, equity: 500, startingCash: 500 },
    openExposureOrders: [],
    plan3Daily: {},
    alreadySubmittedKeys: new Set(),
    now
  });

  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.direction, 'down');
  assert.equal(plan.action.priceSource, 'pm_leading');
  assert.equal(plan.action.tokenPrice, 0.98);
});

test('resolvePlan3RuntimeConfig live enabled matches paper wide band rules by default', () => {
  const runtime = resolvePlan3RuntimeConfig({
    ...baseConfig,
    plan3LiveEnabled: true
  });
  assert.equal(runtime.plan3PaperWideBand, true);
  assert.equal(runtime.plan3MinPrice, 0.93);
  assert.equal(runtime.plan3MaxSecondsRemaining5m, 120);
  assert.equal(runtime.plan3PaperMinDirectionalBps, 0.5);
  assert.equal(runtime.plan3PaperUsePmLeadingPrice, true);
});

test('buildPolymarketPaperPlan3 split mode rejects conflicting leading side as out of range', () => {
  const now = new Date('2026-07-06T07:19:55.000Z');
  const slotOpenPrice = 100000;
  const referencePrice = 100120;

  const plan = buildPolymarketPaperPlan3({
    signal: {
      schedule: {
        currentSlotIso: '2026-07-06T07:15:00.000Z',
        nextSlotIso: '2026-07-06T07:20:00.000Z',
        secondsToNext: 5
      },
      prediction: { comparisonBasePrice: slotOpenPrice },
      indicators: { currentPrice: referencePrice, slotStartPrice: slotOpenPrice }
    },
    sentiment: {
      available: true,
      upPrice: 0.04,
      downPrice: 0.96,
      spread: 0.10,
      qualityScore: 0.8
    },
    config: {
      ...baseConfig,
      plan3LiveEnabled: false,
      plan3PaperRelaxedEnabled: true,
      plan3PaperWideBandEnabled: false
    },
    timeframe: '5m',
    portfolio: { portfolioInitialized: true, equity: 500, startingCash: 500 },
    openExposureOrders: [],
    plan3Daily: {},
    alreadySubmittedKeys: new Set(),
    now
  });

  assert.equal(plan.action.shouldTrade, false);
  assert.equal(plan.action.skipReason, 'price_out_of_range');
});

test('buildPolymarketPaperPlan3 paper wide band does not trade 90-92c opposing-side prices', () => {
  const now = new Date('2026-07-06T07:19:55.000Z');
  const slotOpenPrice = 100000;
  const referencePrice = 100120;

  const plan = buildPolymarketPaperPlan3({
    signal: {
      schedule: {
        currentSlotIso: '2026-07-06T07:15:00.000Z',
        nextSlotIso: '2026-07-06T07:20:00.000Z',
        secondsToNext: 5
      },
      prediction: { comparisonBasePrice: slotOpenPrice },
      indicators: { currentPrice: referencePrice, slotStartPrice: slotOpenPrice }
    },
    sentiment: {
      available: true,
      upPrice: 0.04,
      downPrice: 0.90,
      spread: 0.02,
      qualityScore: 0.8
    },
    config: { ...baseConfig, plan3LiveEnabled: false, plan3PaperRelaxedEnabled: true },
    timeframe: '5m',
    portfolio: { portfolioInitialized: true, equity: 500, startingCash: 500 },
    openExposureOrders: [],
    plan3Daily: {},
    alreadySubmittedKeys: new Set(),
    now
  });

  assert.equal(plan.planId, 'plan3');
  assert.equal(plan.action.shouldTrade, false);
  assert.equal(plan.action.skipReason, 'price_out_of_range');
  assert.equal(plan.action.tokenPrice, 0.04);
});

test('resolvePlan3MaxSpreadForEntry relaxes spread below 99c in wide band', () => {
  const cfg = { plan3PaperWideBand: true, plan3PaperMaxSpread: 0.03, plan3PaperWideMaxSpread: 0.08 };
  assert.equal(resolvePlan3MaxSpreadForEntry({ tokenPrice: 0.97, config: cfg }), 0.06);
  assert.equal(resolvePlan3MaxSpreadForEntry({ tokenPrice: 0.93, config: cfg }), 0.08);
  assert.equal(resolvePlan3MaxSpreadForEntry({ tokenPrice: 0.995, config: cfg }), 0.03);
});

test('resolvePlan3RuntimeConfig relaxes paper thresholds', () => {
  const runtime = resolvePlan3RuntimeConfig({
    ...baseConfig,
    plan3LiveEnabled: false,
    plan3PaperRelaxedEnabled: true,
    plan3MaxSecondsRemaining5m: 10,
    plan3MinDistanceBps5m: 22
  });
  assert.equal(runtime.plan3PaperMode, true);
  assert.equal(runtime.plan3MaxSecondsRemaining5m, 120);
  assert.equal(runtime.plan3MinDistanceBps5m, 2);
  assert.equal(runtime.plan3PaperMinDirectionalBps, 0.5);
  assert.equal(runtime.plan3PaperWideBand, true);
  assert.equal(runtime.plan3MinPrice, 0.93);
});

test('resolvePlan3RuntimeConfig legacy split mode keeps paper min price', () => {
  const runtime = resolvePlan3RuntimeConfig({
    ...baseConfig,
    plan3PaperWideBandEnabled: false,
    plan3LiveEnabled: false,
    plan3PaperRelaxedEnabled: true
  });
  assert.equal(runtime.plan3PaperWideBand, false);
  assert.equal(runtime.plan3MinPrice, 0.85);
});

test('isEffectivelySettled paper mode accepts small directional distance', () => {
  const runtime = resolvePlan3RuntimeConfig({ ...baseConfig, plan3LiveEnabled: false });
  assert.equal(isEffectivelySettled({
    timeframe: '5m',
    secondsRemaining: 7,
    distanceFromOpenBps: 0.9,
    recentReverseBps: 0,
    config: runtime
  }), true);

  assert.equal(isEffectivelySettled({
    timeframe: '5m',
    secondsRemaining: 7,
    distanceFromOpenBps: 0.2,
    recentReverseBps: 0,
    config: runtime
  }), false);
});

test('describePlan3SettlementSkip explains distance threshold', () => {
  const runtime = resolvePlan3RuntimeConfig({ ...baseConfig, plan3LiveEnabled: false });
  assert.equal(
    describePlan3SettlementSkip({
      timeframe: '5m',
      distanceFromOpenBps: 0.9,
      recentReverseBps: 0,
      config: runtime
    }),
    null
  );
  assert.match(
    describePlan3SettlementSkip({
      timeframe: '5m',
      distanceFromOpenBps: 0.2,
      recentReverseBps: 0,
      config: runtime
    }),
    /距开盘 0\.2bps < 门槛 0\.5bps/
  );
});

test('resolvePlan3WinningTokenPrice never substitutes the opposing leading side outside wide band', () => {
  const runtime = resolvePlan3RuntimeConfig({
    ...baseConfig,
    plan3LiveEnabled: false,
    plan3PaperWideBandEnabled: false
  });
  const resolved = resolvePlan3WinningTokenPrice({
    direction: 'down',
    sentiment: { upPrice: 0.992, downPrice: 0.008 },
    config: runtime
  });
  assert.equal(resolved.priceSource, 'directional');
  assert.equal(resolved.tokenPrice, 0.008);
  assert.equal(resolved.tokenDirection, 'down');
});

test('resolvePlan3WinningTokenPrice uses PM leading side inside wide band', () => {
  const runtime = resolvePlan3RuntimeConfig({ ...baseConfig, plan3LiveEnabled: false });
  const resolved = resolvePlan3WinningTokenPrice({
    direction: 'up',
    sentiment: { upPrice: 0.01, downPrice: 0.98 },
    config: runtime
  });
  assert.equal(resolved.priceSource, 'pm_leading');
  assert.equal(resolved.tokenPrice, 0.98);
  assert.equal(resolved.tokenDirection, 'down');
});

test('buildPolymarketPaperPlan3 paper mode trades with 0.9 bps distance', () => {
  const now = new Date('2026-07-01T10:09:57.000Z');
  const slotOpenPrice = 100000;
  const referencePrice = 100009;

  const plan = buildPolymarketPaperPlan3({
    signal: {
      schedule: {
        currentSlotIso: '2026-07-01T10:05:00.000Z',
        nextSlotIso: '2026-07-01T10:10:00.000Z',
        secondsToNext: 3
      },
      prediction: { comparisonBasePrice: slotOpenPrice },
      indicators: { currentPrice: referencePrice, slotStartPrice: slotOpenPrice }
    },
    sentiment: {
      available: true,
      upPrice: 0.994,
      downPrice: 0.006,
      spread: 0.004,
      qualityScore: 0.8
    },
    config: { ...baseConfig, plan3LiveEnabled: false, plan3PaperRelaxedEnabled: true },
    timeframe: '5m',
    portfolio: { portfolioInitialized: true, equity: 500, startingCash: 500 },
    openExposureOrders: [],
    plan3Daily: {},
    alreadySubmittedKeys: new Set(),
    now
  });

  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.direction, 'up');
  assert.ok((plan.action.usd ?? plan.orderUsd) >= 99);
});

test('isPlan3PaperTrading is false when live enabled', () => {
  assert.equal(isPlan3PaperTrading({ plan3LiveEnabled: true }), false);
  assert.equal(isPlan3PaperTrading({ plan3LiveEnabled: false }), true);
});

test('buildPolymarketPaperPlan3 paper mode marks fillable without direct fill', () => {
  const now = new Date('2026-07-01T10:09:57.000Z');
  const slotOpenPrice = 100000;
  const referencePrice = 100230;

  const plan = buildPolymarketPaperPlan3({
    signal: {
      schedule: {
        currentSlotIso: '2026-07-01T10:05:00.000Z',
        nextSlotIso: '2026-07-01T10:10:00.000Z',
        secondsToNext: 3
      },
      prediction: { comparisonBasePrice: slotOpenPrice },
      indicators: { currentPrice: referencePrice, slotStartPrice: slotOpenPrice }
    },
    sentiment: {
      available: true,
      upPrice: 0.994,
      downPrice: 0.006,
      spread: 0.004,
      qualityScore: 0.8
    },
    config: baseConfig,
    timeframe: '5m',
    portfolio: { portfolioInitialized: true, equity: 500, startingCash: 500 },
    openExposureOrders: [],
    plan3Daily: {},
    alreadySubmittedKeys: new Set(),
    now
  });

  assert.equal(plan.planId, 'plan3');
  assert.equal(plan.action.entryType, 'settlement_capture');
  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.direction, 'up');
  assert.ok(plan.action.limitPrice >= 0.99);
  assert.ok(plan.action.limitPrice <= 0.998);
  assert.equal(plan.action.paperDirectFill, false);
  assert.equal(plan.action.paperFillable, true);
  assert.ok(Number(plan.action.expectedFillPrice) >= Number(plan.action.limitPrice));
});

test('estimatePlan3ExpectedFillPrice simulates FAK bump and blocks ask above limit', () => {
  const blocked = estimatePlan3ExpectedFillPrice({
    tokenPrice: 0.96,
    limitPrice: 0.95,
    config: { plan3PaperDirectFill: false, plan3PaperSimulateFakBump: true, plan3LiveFakBumpSteps: 4 },
    live: false
  });
  assert.equal(blocked.fillable, false);

  const filled = estimatePlan3ExpectedFillPrice({
    tokenPrice: 0.94,
    limitPrice: 0.94,
    config: {
      plan3PaperDirectFill: false,
      plan3PaperSimulateFakBump: true,
      plan3LiveFakBumpSteps: 4,
      plan3BandStatsFillBumpSteps: 2,
      plan3FillTickSize: 0.01
    },
    live: false
  });
  assert.equal(filled.fillable, true);
  assert.equal(filled.expectedFillPrice, 0.96);
  assert.equal(filled.bumpSteps, 2);
});

test('evaluatePlan3BandStatsGate uses effective fill price for breakeven', () => {
  const config = { plan3BandStatsGateEnabled: true, plan3BandStatsMinSamples: 30, plan3BandStatsMargin: 0.005 };
  const bandStats = { '93-95': { total: 60, wins: 57, losses: 3, winRate: 57 / 60 } };
  // token 0.93 时 WR 足够；按预期成交 0.96 则不够
  const atToken = evaluatePlan3BandStatsGate({ tokenPrice: 0.93, bandStats, config });
  assert.equal(atToken.allowed, true);
  const atFill = evaluatePlan3BandStatsGate({
    tokenPrice: 0.93,
    effectiveFillPrice: 0.96,
    bandStats,
    config
  });
  assert.equal(atFill.allowed, false);
  assert.match(atFill.reason, /按成交价/);
});

test('buildPolymarketPaperPlan3 skips outside time window', () => {
  const plan = buildPolymarketPaperPlan3({
    signal: {
      schedule: {
        currentSlotIso: '2026-07-01T10:05:00.000Z',
        nextSlotIso: '2026-07-01T10:10:00.000Z',
        secondsToNext: 200
      },
      prediction: { comparisonBasePrice: 100000 },
      indicators: { currentPrice: 100030 }
    },
    sentiment: {
      available: true,
      upPrice: 0.994,
      downPrice: 0.006,
      spread: 0.004,
      qualityScore: 0.8
    },
    config: baseConfig,
    timeframe: '5m',
    portfolio: { portfolioInitialized: true, equity: 600 },
    now: new Date('2026-07-01T10:09:15.000Z')
  });

  assert.equal(plan.action.skipReason, 'not_in_time_window');
});

test('buildPlan3SlotKey encodes slot timeframe and optional direction', () => {
  assert.equal(
    buildPlan3SlotKey('2026-07-01T10:05:00.000Z', '5m', 'up'),
    '2026-07-01T10:05:00.000Z_5m_plan3_up'
  );
});

test('computePlan3Analytics tracks fill rate and skip reasons', () => {
  const analytics = computePlan3Analytics(
    [
      {
        planId: 'plan3',
        fillStatus: 'filled',
        settlementStatus: 'settled',
        limitPrice: 0.995,
        pnl: 0.03
      },
      {
        planId: 'plan3',
        fillStatus: 'expired',
        settlementStatus: 'pending',
        limitPrice: 0.995,
        pnl: 0
      }
    ],
    [
      { skipReason: 'not_in_time_window' },
      { skipReason: 'not_in_time_window' },
      { skipReason: 'price_out_of_range' }
    ]
  );

  assert.equal(analytics.submittedOrders, 2);
  assert.equal(analytics.settledOrders, 1);
  assert.equal(analytics.skipReasonCounts.not_in_time_window, 2);
  assert.equal(analytics.skipReasonCounts.price_out_of_range, 1);
  assert.ok(analytics.avgGrossEdge > 0);
});

test('computePlan3Analytics separates execution v4 forward results from legacy history', () => {
  const analytics = computePlan3Analytics([
    {
      planId: 'plan3',
      strategyVersion: 'plan3_confirm_v2',
      fillStatus: 'filled',
      settlementStatus: 'settled',
      usd: 10,
      pnl: -10,
      limitPrice: 0.97
    },
    {
      planId: 'plan3',
      strategyVersion: 'plan3_execution_v4',
      fillStatus: 'filled',
      settlementStatus: 'settled',
      usd: 10,
      pnl: 0.2,
      limitPrice: 0.97
    }
  ], []);
  assert.equal(analytics.forward.settledOrders, 1);
  assert.equal(analytics.forward.totalPnl, 0.2);
  assert.equal(analytics.forward.roi, 0.02);
  assert.equal(analytics.byStrategyVersion.plan3_confirm_v2.totalPnl, -10);
});

test('computeVolatilityBpsPerSecond returns non-negative volatility estimate', () => {
  const now = new Date('2026-07-01T10:09:57.000Z');
  const samples = [
    { ts: now.getTime() - 2000, btcPrice: 100000 },
    { ts: now.getTime() - 1000, btcPrice: 100010 },
    { ts: now.getTime(), btcPrice: 100005 }
  ];
  const vol = computeVolatilityBpsPerSecond(samples, 3, now);
  assert.ok(vol >= 0);
});
