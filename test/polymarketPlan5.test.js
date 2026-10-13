import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAN5_VERSION,
  blendPlan5LearningStat,
  blendPlan5LockStrengthStats,
  blendPlan5WinrateGuidance,
  buildPolymarketPaperPlan5,
  buildPlan5WaitKey,
  evaluatePlan5CurrentMarketAlignment,
  evaluatePlan5ConsensusGate,
  evaluatePlan5EntryTiming,
  evaluatePlan5ExpectedValueGate,
  enforcePlan5StrictExecutionGate,
  evaluatePlan5LockHistoryGate,
  evaluatePlan5WinrateGuidanceGate,
  evaluatePlan5SignalQuality,
  evaluatePlan5StopLoss,
  evaluatePlan5SlotExposureGate,
  normalizePlan5Lock,
  resolvePlan5CashPct,
  resolvePlan5EntryLock
} from '../src/polymarketPlan5.js';
import { createStatsDb } from '../src/statsDb.js';
import { buildDirectionJudgmentId } from '../src/winrateGuidance.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Plan5 dual memory retains long-term evidence and reacts to recent drift', () => {
  const stable = blendPlan5LearningStat(
    { total: 40, correct: 28 },
    { total: 400, correct: 280 },
    {
      plan5HistoryMinSamples: 20,
      plan5LearningRecentWeight: 0.35,
      plan5LearningRecentWeightMin: 0.15,
      plan5LearningRecentWeightMax: 0.70,
      plan5LearningDriftThreshold: 0.05,
      plan5LearningConservativeZ: 0.5
    }
  );
  assert.equal(stable.longTerm.total, 400);
  assert.equal(stable.recent.total, 40);
  assert.ok(stable.accuracy > 0.67);
  assert.ok(stable.accuracy < 0.71);

  const drifting = blendPlan5LearningStat(
    { total: 40, correct: 16 },
    { total: 400, correct: 280 },
    {
      plan5HistoryMinSamples: 20,
      plan5LearningRecentWeight: 0.35,
      plan5LearningRecentWeightMin: 0.15,
      plan5LearningRecentWeightMax: 0.70,
      plan5LearningDriftThreshold: 0.05,
      plan5LearningConservativeZ: 0.5
    }
  );
  assert.ok(drifting.recentWeight > stable.recentWeight);
  assert.ok(drifting.accuracy < stable.accuracy);
  assert.ok(drifting.accuracy > 0.40);
});

test('Plan5 dual-memory helpers expose long and recent sample counts to sizing', () => {
  const stats = blendPlan5LockStrengthStats(
    { strong: { total: 20, correct: 12 } },
    { strong: { total: 200, correct: 150 } },
    { plan5HistoryMinSamples: 20 }
  );
  assert.equal(stats.strong.longTerm.total, 200);
  assert.equal(stats.strong.recent.total, 20);
  assert.ok(stats.strong.accuracy > 0);

  const guidance = blendPlan5WinrateGuidance(
    {
      conditional: { total: 20, correct: 12, wrong: 8, winRate: 0.6 },
      alignsWithHistoricalEdge: true,
      hourRegime: { weak: false }
    },
    {
      conditional: { total: 200, correct: 150, wrong: 50, winRate: 0.75 },
      alignsWithHistoricalEdge: true
    },
    { plan5WinrateGuidanceMinSamples: 8 }
  );
  assert.equal(guidance.learningMemory.longTerm.total, 200);
  assert.equal(guidance.learningMemory.recent.total, 20);
  assert.match(guidance.note, /双记忆/);
});

test('Plan5 v10 requires lock and composite direction consensus', () => {
  const config = {
    plan5ConsensusEnabled: true,
    plan5ConsensusMinConfidence5m: 0.62,
    plan5ConsensusMinConfidence15m: 0.62
  };
  const lock = { direction: 'up', pmGap: 0.55 };
  assert.equal(evaluatePlan5ConsensusGate({
    signal: { direction: 'down', confidence: 0.80 },
    lock,
    timeframe: '5m',
    config,
    now: new Date('2026-07-16T00:00:00.000Z')
  }).allowed, false);
  assert.equal(evaluatePlan5ConsensusGate({
    signal: { direction: 'up', confidence: 0.60 },
    lock,
    timeframe: '5m',
    config,
    now: new Date('2026-07-16T00:00:00.000Z')
  }).allowed, false);
  const allowed = evaluatePlan5ConsensusGate({
    signal: {
      direction: 'up',
      technicalDirection: 'up',
      spotDirection: 'up',
      confidence: 0.68,
      polymarket: { aligned: true }
    },
    lock,
    timeframe: '5m',
    config,
    now: new Date('2026-07-16T00:00:00.000Z')
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.technicalPmAligned, true);
});

test('Plan5 consensus stays a hard reject even when locked-signal sizing-only is on', () => {
  const now = new Date('2026-07-09T02:02:00.000Z');
  const lock = {
    direction: 'up',
    strength: 'normal',
    confidence: 0.72,
    pmGap: 0.55,
    lockedAtIso: '2026-07-09T02:01:00.000Z'
  };
  const blocked = buildPolymarketPaperPlan5({
    signal: {
      symbol: 'BTC-USD',
      direction: 'up',
      technicalDirection: 'down',
      spotDirection: 'down',
      confidence: 0.80,
      schedule: {
        currentSlotIso: '2026-07-09T02:00:00.000Z',
        nextSlotIso: '2026-07-09T02:05:00.000Z',
        secondsToNext: 180,
        slotMinutes: 5
      },
      prediction: { targetTimeIso: '2026-07-09T02:05:00.000Z' }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      market: 'BTC Up or Down',
      upPrice: 0.68,
      downPrice: 0.32,
      upProbability: 0.68,
      downProbability: 0.32,
      qualityScore: 0.75,
      upTokenId: 'up-token',
      downTokenId: 'down-token'
    },
    config: {
      plan5Enabled: true,
      plan5ConsensusEnabled: true,
      plan5ConsensusMinConfidence5m: 0.62,
      plan5ConsensusMinPmGap: 0.50,
      plan5ConsensusRequireTechnicalAlignment: true,
      plan5ConsensusRequireSpotAlignment: true,
      plan5LockedSignalSizingOnlyEnabled: true,
      plan5HistoryGateEnabled: false,
      plan5WeakCashPct: 0.05,
      plan5NormalCashPct: 0.10,
      plan5StrongCashPct: 0.15,
      plan5MinOrderUsd: 10
    },
    timeframe: '5m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    intervalPmLock: lock,
    now
  });
  assert.equal(blocked.action.shouldTrade, false);
  assert.equal(blocked.action.skipReason, 'consensus_not_confirmed');
  assert.notEqual(blocked.action.consensusGate?.sizingOnlyBypass, true);
  assert.match(String(blocked.action.reason || ''), /技术方向|未确认/);
});

test('Plan5 v10 applies stricter quality requirements during fixed weak hours', () => {
  const config = {
    plan5ConsensusEnabled: true,
    plan5ConsensusMinConfidence5m: 0.62,
    plan5ConsensusMinConfidence15m: 0.62,
    plan5ConsensusMinPmGap: 0.30
  };
  const base = {
    signal: { direction: 'up', confidence: 0.7, techDirection: 'up', spotDirection: 'up' },
    lock: { direction: 'up', pmGap: 0.35 },
    timeframe: '15m',
    config,
    now: new Date('2026-07-15T22:10:00.000Z')
  };
  const gapBlocked = evaluatePlan5ConsensusGate(base);
  assert.equal(gapBlocked.allowed, false);
  assert.equal(gapBlocked.hourGate.reason, 'low_winrate_hour_gap');

  const techBlocked = evaluatePlan5ConsensusGate({
    ...base,
    signal: { ...base.signal, techDirection: 'down' },
    lock: { ...base.lock, pmGap: 0.42 }
  });
  assert.equal(techBlocked.allowed, false);
  assert.match(techBlocked.reason, /独立技术方向/);

  const allowed = evaluatePlan5ConsensusGate({
    ...base,
    lock: { ...base.lock, pmGap: 0.42 }
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.hourGate.policy.shanghaiHour, 6);
});

test('Plan5 v13 requires independent technical, spot, and PM-gap confirmation', () => {
  const config = {
    plan5ConsensusEnabled: true,
    plan5ConsensusMinConfidence5m: 0.70,
    plan5ConsensusMinPmGap: 0.50
  };
  const base = {
    signal: {
      direction: 'down',
      technicalDirection: 'down',
      spotDirection: 'down',
      confidence: 0.76
    },
    lock: { direction: 'down', pmGap: 0.55 },
    timeframe: '5m',
    config,
    now: new Date('2026-07-16T00:00:00.000Z')
  };
  assert.equal(evaluatePlan5ConsensusGate(base).allowed, true);
  assert.equal(evaluatePlan5ConsensusGate({
    ...base,
    signal: { ...base.signal, technicalDirection: 'up' }
  }).allowed, false);
  assert.equal(evaluatePlan5ConsensusGate({
    ...base,
    lock: { ...base.lock, pmGap: 0.35 }
  }).allowed, false);
});

test('Plan5 consensus treats missing confirmation as sizing uncertainty and strong-lock conflict as reduced size', () => {
  const config = {
    plan5ConsensusEnabled: true,
    plan5ConsensusMinConfidence5m: 0.62,
    plan5ConsensusMinPmGap5m: 0.30,
    plan5ConsensusRequireTechnicalAlignment: true,
    plan5ConsensusRequireSpotAlignment: true
  };
  const now = new Date('2026-07-16T00:00:00.000Z');
  const missing = evaluatePlan5ConsensusGate({
    signal: { direction: 'up', confidence: 0.72 },
    lock: { direction: 'up', strength: 'normal', pmGap: 0.35 },
    timeframe: '5m',
    config,
    now
  });
  assert.equal(missing.allowed, true);
  assert.equal(missing.technicalMissing, true);
  assert.equal(missing.spotMissing, true);
  assert.equal(missing.sizeScale, 0.765);

  const strongConflict = evaluatePlan5ConsensusGate({
    signal: { direction: 'up', technicalDirection: 'down', spotDirection: 'up', confidence: 0.72 },
    lock: { direction: 'up', strength: 'strong', pmGap: 0.55 },
    timeframe: '5m',
    config,
    now
  });
  assert.equal(strongConflict.allowed, true);
  assert.equal(strongConflict.technicalConflict, true);
  assert.equal(strongConflict.sizeScale, 0.5);
});

test('Plan5 strict execution requires calibrated positive EV after execution cost', () => {
  const config = { plan5EvStrictExecutionEnabled: true };
  const allowed = enforcePlan5StrictExecutionGate({
    allowed: true,
    conservativeWinRate: 0.66,
    requiredWinRate: 0.64,
    expectedRoi: 0.03
  }, { config, quotedEntryPrice: 0.61, executionEntryPrice: 0.62 });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.strictExecution, true);
  assert.equal(allowed.executionEntryPrice, 0.62);

  const shadowOnly = enforcePlan5StrictExecutionGate({
    allowed: true,
    insufficientSamples: true,
    sampleCount: 4
  }, { config, quotedEntryPrice: 0.61, executionEntryPrice: 0.62 });
  assert.equal(shadowOnly.allowed, false);
  assert.equal(shadowOnly.shadowCandidate, true);
});

test('evaluatePlan5WinrateGuidanceGate soft-scales with same-condition samples', () => {
  const db = createStatsDb({
    path: join(tmpdir(), `plan5-wr-guide-${Date.now()}.db`),
    enabled: true
  });
  for (let i = 0; i < 10; i += 1) {
    const target = `2026-07-10T${String(i).padStart(2, '0')}:05:00.000Z`;
    const id = buildDirectionJudgmentId({ timeframe: '5m', targetTimeIso: target, symbol: 'BTC-USD' });
    db.recordDirectionJudgment({
      id,
      symbol: 'BTC-USD',
      timeframe: '5m',
      targetTimeIso: target,
      predictedDirection: 'up',
      predictedAtIso: target,
      lockStrength: 'weak',
      hourBucket: 16,
      volatilityBucket: 'mid',
      sameDirectionAsPrev: true
    });
    db.settleDirectionJudgment({ id, actualDirection: i < 8 ? 'up' : 'down' });
  }

  const cold = evaluatePlan5WinrateGuidanceGate({
    symbol: 'ETH-USD',
    timeframe: '5m',
    direction: 'up',
    lock: { strength: 'weak' },
    statsDb: db,
    config: {},
    now: new Date('2026-07-10T08:00:00.000Z')
  });
  assert.equal(cold.allowed, true);
  assert.equal(cold.insufficientSamples, true);
  assert.equal(cold.sizeScale, 1);

  const hot = evaluatePlan5WinrateGuidanceGate({
    symbol: 'BTC-USD',
    timeframe: '5m',
    direction: 'up',
    lock: { strength: 'weak' },
    sameDirectionAsPrev: true,
    statsDb: db,
    config: {},
    now: new Date('2026-07-10T08:00:00.000Z')
  });
  assert.equal(hot.allowed, true);
  assert.equal(hot.insufficientSamples, false);
  assert.ok(Number(hot.suggestedWeight) >= 1);
  assert.ok(Number(hot.sizeScale) >= 1);
  assert.ok(String(hot.reason || '').includes('同条件') || String(hot.guidance?.note || '').includes('同条件'));
  db.close();
});

test('Plan5 current market alignment rejects stale quotes and lock reversals', () => {
  assert.equal(evaluatePlan5CurrentMarketAlignment({
    lock: { direction: 'up' },
    sentiment: { upPrice: 0.02, downPrice: 0.97 }
  }).allowed, false);
  assert.equal(evaluatePlan5CurrentMarketAlignment({
    lock: { direction: 'up' },
    sentiment: { upPrice: 0.4, downPrice: 0.62 }
  }).allowed, false);
  assert.equal(evaluatePlan5CurrentMarketAlignment({
    lock: { direction: 'up' },
    sentiment: { upPrice: 0.62, downPrice: 0.4 }
  }).allowed, true);
  const desynced = evaluatePlan5CurrentMarketAlignment({
    lock: { direction: 'down' },
    sentiment: { upPrice: 0.505, downPrice: 0.99 },
    config: {
      plan5LockedSignalSizingOnlyEnabled: true,
      plan5LockedSignalMinSizeScale: 0.25
    }
  });
  assert.equal(desynced.allowed, true);
  assert.equal(desynced.quoteDesynced, true);
  assert.equal(desynced.executionQuoteRefreshRequired, true);
  assert.equal(desynced.sizeScale, 0.25);
});

test('Plan5 EV gate rejects a high-price negative expectancy cohort', () => {
  const orders = Array.from({ length: 8 }, (_, index) => ({
    id: `ev-high-${index}`,
    source: 'live',
    planId: 'plan5',
    symbol: 'SOL-USD',
    timeframe: '5m',
    slotIso: `2026-07-10T03:${String(index).padStart(2, '0')}:00.000Z`,
    settledAtIso: `2026-07-10T04:${String(index).padStart(2, '0')}:00.000Z`,
    direction: 'up',
    entryType: 'pm_lock_strength',
    entryPrice: 0.78,
    lockStrength: 'strong',
    won: index < 5
  }));
  const result = evaluatePlan5ExpectedValueGate({
    symbol: 'SOL-USD',
    timeframe: '5m',
    strength: 'strong',
    direction: 'up',
    entryPrice: 0.78,
    orders,
    config: { plan5EvExactMinSamples: 6, plan5EvMargin: 0.02, plan5EvGateMode: 'hard' }
  });
  assert.equal(result.allowed, false);
  assert.equal(result.level, 'symbol_timeframe_direction_price');
  assert.equal(result.sampleCount, 8);
  assert.ok(result.conservativeWinRate < result.requiredWinRate);
});

test('Plan5 EV gate rejects negative EV even when soft mode is configured', () => {
  const orders = Array.from({ length: 8 }, (_, index) => ({
    id: `ev-soft-${index}`,
    source: 'live',
    planId: 'plan5',
    symbol: 'SOL-USD',
    timeframe: '5m',
    slotIso: `2026-07-10T03:${String(index).padStart(2, '0')}:00.000Z`,
    settledAtIso: `2026-07-10T04:${String(index).padStart(2, '0')}:00.000Z`,
    direction: 'up',
    entryType: 'pm_lock_strength',
    entryPrice: 0.78,
    lockStrength: 'strong',
    won: index < 5
  }));
  const result = evaluatePlan5ExpectedValueGate({
    symbol: 'SOL-USD',
    timeframe: '5m',
    strength: 'strong',
    direction: 'up',
    entryPrice: 0.78,
    orders,
    config: {
      plan5EvExactMinSamples: 6,
      plan5EvMargin: 0.02,
      plan5EvGateMode: 'soft',
      plan5EvHardRejectRoi: -0.5
    }
  });
  assert.equal(result.allowed, false);
  assert.ok(result.expectedRoi < 0);
});

test('Plan5 v14 bootstrap uses predecessor EV for sizing but never for veto', () => {
  const orders = Array.from({ length: 8 }, (_, index) => ({
    id: `ev-bootstrap-${index}`,
    source: 'live',
    planId: 'plan5',
    strategyVersion: 'plan5_independent_direction_v13',
    symbol: 'SOL-USD',
    timeframe: '5m',
    direction: 'up',
    slotIso: `2026-07-20T03:${String(index).padStart(2, '0')}:00.000Z`,
    settledAtIso: `2026-07-20T04:${String(index).padStart(2, '0')}:00.000Z`,
    entryPrice: 0.78,
    lockStrength: 'strong',
    won: index < 3
  }));
  const result = evaluatePlan5ExpectedValueGate({
    symbol: 'SOL-USD',
    timeframe: '5m',
    strength: 'strong',
    direction: 'up',
    entryPrice: 0.78,
    orders,
    paperMode: false,
    config: {
      plan5ExpectedValueGateEnabled: true,
      plan5EvStrategyVersionIsolationEnabled: true,
      plan5EvVersionBootstrapMinSamples: 48,
      plan5EvExactMinSamples: 6,
      plan5EvPriceMinSamples: 6,
      plan5EvGateMode: 'hard'
    }
  });
  assert.equal(result.allowed, true);
  assert.equal(result.versionBootstrap, true);
  assert.equal(result.sizingOnlyBootstrap, true);
  assert.equal(result.softReject, true);
  assert.ok(result.expectedRoi < 0);
  assert.ok(result.sizeScale >= 0.25 && result.sizeScale <= 1);
});

test('Plan5 v6 EV uses market price prior and micro-sizes live when samples insufficient', () => {
  const coldLive = evaluatePlan5ExpectedValueGate({
    symbol: 'BTC-USD',
    timeframe: '5m',
    strength: 'normal',
    direction: 'up',
    entryPrice: 0.62,
    orders: [],
    paperMode: false,
    config: { plan5EvExactMinSamples: 6 }
  });
  assert.equal(coldLive.allowed, true);
  assert.equal(coldLive.insufficientSamples, true);
  assert.equal(coldLive.sizingOnlyBypass, true);
  assert.equal(coldLive.sizeScale, 0.25);

  const coldPaper = evaluatePlan5ExpectedValueGate({
    symbol: 'BTC-USD',
    timeframe: '5m',
    strength: 'normal',
    direction: 'up',
    entryPrice: 0.62,
    orders: [],
    paperMode: true,
    config: { plan5EvExactMinSamples: 6 }
  });
  assert.equal(coldPaper.allowed, true);
  assert.equal(coldPaper.insufficientSamples, true);

  const orders = Array.from({ length: 8 }, (_, index) => ({
    id: `ev-prior-${index}`,
    source: 'live',
    planId: 'plan5',
    symbol: 'ETH-USD',
    timeframe: '5m',
    direction: 'down',
    slotIso: `2026-07-10T05:${String(index).padStart(2, '0')}:00.000Z`,
    settledAtIso: `2026-07-10T06:${String(index).padStart(2, '0')}:00.000Z`,
    entryPrice: 0.55,
    lockStrength: 'normal',
    won: index < 4
  }));
  const gated = evaluatePlan5ExpectedValueGate({
    symbol: 'ETH-USD',
    timeframe: '5m',
    strength: 'normal',
    direction: 'down',
    entryPrice: 0.55,
    orders,
    config: { plan5EvExactMinSamples: 6, plan5EvPriorWeight: 6, plan5EvUncertaintyWeight: 0 }
  });
  assert.equal(gated.priorWinRate, 0.55);
  assert.equal(gated.direction, 'down');
});

test('Plan5 v6 separates EV cohorts by direction', () => {
  const upWins = Array.from({ length: 10 }, (_, index) => ({
    id: `up-${index}`,
    source: 'paper',
    planId: 'plan5',
    symbol: 'BTC-USD',
    timeframe: '5m',
    direction: 'up',
    slotIso: `up-${index}`,
    settledAtIso: '2026-07-11T12:00:00.000Z',
    entryPrice: 0.55,
    lockStrength: 'normal',
    won: true
  }));
  const downLosses = Array.from({ length: 2 }, (_, index) => ({
    id: `down-${index}`,
    source: 'paper',
    planId: 'plan5',
    symbol: 'BTC-USD',
    timeframe: '5m',
    direction: 'down',
    slotIso: `down-${index}`,
    settledAtIso: '2026-07-11T12:00:00.000Z',
    entryPrice: 0.55,
    lockStrength: 'normal',
    won: false
  }));
  const downCold = evaluatePlan5ExpectedValueGate({
    symbol: 'BTC-USD',
    timeframe: '5m',
    strength: 'normal',
    direction: 'down',
    entryPrice: 0.55,
    orders: [...upWins, ...downLosses],
    paperMode: false,
    config: { plan5EvExactMinSamples: 6, plan5EvPriceMinSamples: 8 }
  });
  assert.equal(downCold.allowed, true);
  assert.equal(downCold.insufficientSamples, true);
  assert.equal(downCold.sizingOnlyBypass, true);
  assert.equal(downCold.sizeScale, 0.25);
});

test('Plan5 v6 disables next-slot pre-open by default', () => {
  const now = new Date('2026-07-09T01:58:00.000Z');
  const signal = {
    ...SIGNAL,
    schedule: {
      currentSlotIso: '2026-07-09T01:55:00.000Z',
      nextSlotIso: '2026-07-09T02:00:00.000Z',
      secondsToNext: 120,
      slotMinutes: 5
    },
    prediction: { targetTimeIso: '2026-07-09T02:00:00.000Z' }
  };
  const plan = buildPolymarketPaperPlan5({
    signal,
    sentiment: { available: false, reason: 'current window unused for pre-open' },
    config: {
      ...BASE_CONFIG,
      plan5PreOpenEnabled: false
    },
    timeframe: '5m',
    portfolio: PORTFOLIO,
    intervalPmLock: null,
    nextSlotPrediction: {
      predictedDirection: 'up',
      predictedSlotIso: '2026-07-09T02:00:00.000Z',
      lockStrength: 'normal'
    },
    nextSlotPredictionSummary: { overall: { total: 30, correct: 21, accuracy: 0.7 } },
    nextSlotMarketSentiment: {
      available: true,
      upPrice: 0.51,
      downPrice: 0.49,
      upTokenId: 'next-up',
      downTokenId: 'next-down'
    },
    now
  });
  assert.notEqual(plan.action?.entryType, 'pre_open');
  assert.equal(plan.action?.shouldTrade, false);
});

test('Plan5 stop loss requires reversal at 30c and always exits at 20c', () => {
  const config = {
    plan5StopLossEnabled: true,
    plan5ConditionalStopPrice: 0.30,
    plan5EmergencyStopPrice: 0.20
  };
  assert.equal(evaluatePlan5StopLoss({
    positionDirection: 'up', currentPmDirection: 'up', currentPrice: 0.29, config
  }), null);
  const reversal = evaluatePlan5StopLoss({
    positionDirection: 'up', currentPmDirection: 'down', currentPrice: 0.29, config
  });
  assert.equal(reversal.exitStatus, 'plan5-reversal-stop');
  const emergency = evaluatePlan5StopLoss({
    positionDirection: 'up', currentPmDirection: 'up', currentPrice: 0.19, config
  });
  assert.equal(emergency.exitStatus, 'plan5-emergency-stop');
});

test('Plan5 EV gate allows a positive expectancy price cohort without changing size', () => {
  const orders = Array.from({ length: 8 }, (_, index) => ({
    id: `ev-positive-${index}`,
    source: 'live',
    planId: 'plan5',
    symbol: 'BTC-USD',
    timeframe: '5m',
    slotIso: `2026-07-10T03:${String(index).padStart(2, '0')}:00.000Z`,
    settledAtIso: `2026-07-10T04:${String(index).padStart(2, '0')}:00.000Z`,
    direction: 'up',
    entryType: 'pm_lock_strength',
    entryPrice: 0.52,
    lockStrength: 'normal',
    won: index < 6
  }));
  const result = evaluatePlan5ExpectedValueGate({
    symbol: 'BTC-USD',
    timeframe: '5m',
    strength: 'normal',
    direction: 'up',
    entryPrice: 0.52,
    orders,
    config: { plan5EvExactMinSamples: 6, plan5EvMargin: 0.02 },
    now: new Date('2026-07-11T00:00:00.000Z')
  });
  assert.equal(result.allowed, true);
  assert.ok(result.expectedRoi > 0);
  assert.equal(result.sizeScale, 1);
  assert.notEqual(result.softReject, true);
});

test('Plan5 EV gate gives recent live outcomes more weight than paper volume', () => {
  const settledAtIso = '2026-07-11T20:00:00.000Z';
  const liveWins = Array.from({ length: 4 }, (_, index) => ({
    id: `weighted-live-${index}`,
    source: 'live',
    planId: 'plan5',
    symbol: 'BTC-USD',
    timeframe: '5m',
    slotIso: `live-${index}`,
    settledAtIso,
    direction: 'up',
    entryPrice: 0.55,
    lockStrength: 'normal',
    won: true
  }));
  const paperLosses = Array.from({ length: 8 }, (_, index) => ({
    id: `weighted-paper-${index}`,
    source: 'paper',
    planId: 'plan5',
    symbol: 'BTC-USD',
    timeframe: '5m',
    slotIso: `paper-${index}`,
    settledAtIso,
    direction: 'up',
    entryPrice: 0.55,
    lockStrength: 'normal',
    won: false
  }));
  const args = {
    symbol: 'BTC-USD',
    timeframe: '5m',
    strength: 'normal',
    direction: 'up',
    entryPrice: 0.55,
    orders: [...liveWins, ...paperLosses],
    now: new Date(settledAtIso)
  };

  const equalWeight = evaluatePlan5ExpectedValueGate({
    ...args,
    config: {
      plan5EvExactMinSamples: 6,
      plan5EvLiveWeight: 1,
      plan5EvPaperWeight: 1,
      plan5EvPriorWeight: 2,
      plan5EvUncertaintyWeight: 0.1,
      plan5EvMargin: 0,
      plan5EvGateMode: 'hard'
    }
  });
  const liveWeighted = evaluatePlan5ExpectedValueGate({
    ...args,
    config: {
      plan5EvExactMinSamples: 6,
      plan5EvLiveWeight: 3,
      plan5EvPaperWeight: 1,
      plan5EvPriorWeight: 2,
      plan5EvUncertaintyWeight: 0.1,
      plan5EvMargin: 0,
      plan5EvGateMode: 'hard'
    }
  });

  assert.equal(equalWeight.allowed, false);
  assert.equal(liveWeighted.allowed, true);
  assert.equal(liveWeighted.liveSampleCount, 4);
  assert.equal(liveWeighted.paperSampleCount, 8);
  assert.ok(liveWeighted.conservativeWinRate > equalWeight.conservativeWinRate);
});

test('Plan5 live EV ignores optimistic paper outcomes once live calibration is enabled', () => {
  const liveLosses = Array.from({ length: 8 }, (_, index) => ({
    id: `live-loss-${index}`,
    source: 'live',
    planId: 'plan5',
    symbol: 'ETH-USD',
    timeframe: '15m',
    slotIso: `live-loss-${index}`,
    settledAtIso: `2026-07-13T0${index}:00:00.000Z`,
    direction: 'down',
    entryPrice: 0.65,
    lockStrength: 'weak',
    usd: 10,
    pnl: -6,
    won: false
  }));
  const paperWins = Array.from({ length: 40 }, (_, index) => ({
    id: `paper-win-${index}`,
    source: 'paper',
    planId: 'plan5',
    symbol: 'ETH-USD',
    timeframe: '15m',
    slotIso: `paper-win-${index}`,
    settledAtIso: '2026-07-13T12:00:00.000Z',
    direction: 'down',
    entryPrice: 0.65,
    lockStrength: 'weak',
    usd: 10,
    pnl: 5,
    won: true
  }));
  const result = evaluatePlan5ExpectedValueGate({
    symbol: 'ETH-USD',
    timeframe: '15m',
    strength: 'weak',
    direction: 'down',
    entryPrice: 0.65,
    orders: [...paperWins, ...liveLosses],
    paperMode: false,
    now: new Date('2026-07-13T13:00:00.000Z'),
    config: {
      plan5EvLiveOnlyEnabled: true,
      plan5EvRecentLiveEnabled: false,
      plan5EvExactMinSamples: 6,
      plan5EvGateMode: 'hard',
      plan5EvRealizedRoiWeightLive: 1
    }
  });
  assert.equal(result.allowed, false);
  assert.equal(result.calibrationSource, 'live');
  assert.equal(result.liveSampleCount, 8);
  assert.equal(result.paperSampleCount, 0);
  assert.ok(result.expectedRoi < 0);
});

test('Plan5 paper live parity uses live-only calibration and rejects optimistic paper history', () => {
  const liveLosses = Array.from({ length: 6 }, (_, index) => ({
    id: `parity-live-loss-${index}`,
    source: 'live',
    planId: 'plan5',
    symbol: 'BTC-USD',
    timeframe: '5m',
    slotIso: `parity-live-loss-${index}`,
    settledAtIso: `2026-07-13T0${index}:00:00.000Z`,
    direction: 'up',
    entryPrice: 0.60,
    lockStrength: 'weak',
    usd: 10,
    pnl: -10,
    won: false
  }));
  const paperWins = Array.from({ length: 20 }, (_, index) => ({
    id: `parity-paper-win-${index}`,
    source: 'paper',
    planId: 'plan5',
    symbol: 'BTC-USD',
    timeframe: '5m',
    slotIso: `parity-paper-win-${index}`,
    settledAtIso: '2026-07-13T12:00:00.000Z',
    direction: 'up',
    entryPrice: 0.60,
    lockStrength: 'weak',
    usd: 10,
    pnl: 6,
    won: true
  }));
  const result = evaluatePlan5ExpectedValueGate({
    symbol: 'BTC-USD',
    timeframe: '5m',
    strength: 'weak',
    direction: 'up',
    entryPrice: 0.60,
    orders: [...paperWins, ...liveLosses],
    paperMode: true,
    now: new Date('2026-07-13T13:00:00.000Z'),
    config: {
      plan5LiveParityEnabled: true,
      plan5EvLiveOnlyEnabled: true,
      plan5EvExactMinSamples: 6,
      plan5EvGateMode: 'hard'
    }
  });
  assert.equal(result.allowed, false);
  assert.equal(result.calibrationSource, 'live');
  assert.equal(result.liveSampleCount, 6);
  assert.equal(result.paperSampleCount, 0);
});

test('Plan5 paper-only calibration ignores stale live losses', () => {
  const liveLosses = Array.from({ length: 6 }, (_, index) => ({
    id: `paper-only-live-loss-${index}`,
    source: 'live',
    planId: 'plan5',
    symbol: 'BTC-USD',
    timeframe: '5m',
    slotIso: `paper-only-live-loss-${index}`,
    settledAtIso: `2026-07-13T0${index}:00:00.000Z`,
    direction: 'up',
    entryPrice: 0.60,
    lockStrength: 'weak',
    usd: 10,
    pnl: -10,
    won: false
  }));
  const paperWins = Array.from({ length: 6 }, (_, index) => ({
    id: `paper-only-paper-win-${index}`,
    source: 'paper',
    planId: 'plan5',
    symbol: 'BTC-USD',
    timeframe: '5m',
    slotIso: `paper-only-paper-win-${index}`,
    settledAtIso: '2026-07-13T12:00:00.000Z',
    direction: 'up',
    entryPrice: 0.60,
    lockStrength: 'weak',
    usd: 10,
    pnl: 6,
    won: true
  }));
  const result = evaluatePlan5ExpectedValueGate({
    symbol: 'BTC-USD',
    timeframe: '5m',
    strength: 'weak',
    direction: 'up',
    entryPrice: 0.60,
    orders: [...paperWins, ...liveLosses],
    paperMode: true,
    now: new Date('2026-07-13T13:00:00.000Z'),
    config: {
      plan5EvPaperOnlyEnabled: true,
      plan5EvExactMinSamples: 6,
      plan5EvGateMode: 'hard',
      plan5EvMargin: 0
    }
  });
  assert.equal(result.allowed, true);
  assert.equal(result.calibrationSource, 'paper');
  assert.equal(result.liveSampleCount, 0);
  assert.equal(result.paperSampleCount, 6);
});

test('Plan5 exploratory EV veto rejects severe negative cohorts before the formal sample threshold', () => {
  const orders = Array.from({ length: 8 }, (_, index) => ({
    id: `exploratory-loss-${index}`,
    source: 'paper',
    planId: 'plan5',
    symbol: 'SOL-USD',
    timeframe: '15m',
    slotIso: `exploratory-loss-${index}`,
    settledAtIso: '2026-07-15T12:00:00.000Z',
    direction: 'up',
    entryPrice: 0.63,
    lockStrength: 'normal',
    usd: 10,
    pnl: -6,
    won: false
  }));
  const result = evaluatePlan5ExpectedValueGate({
    symbol: 'SOL-USD',
    timeframe: '15m',
    strength: 'normal',
    direction: 'up',
    entryPrice: 0.63,
    orders,
    paperMode: true,
    now: new Date('2026-07-15T13:00:00.000Z'),
    config: {
      plan5EvPaperOnlyEnabled: true,
      plan5EvExactMinSamples: 20,
      plan5EvPriceMinSamples: 20,
      plan5EvTimeframePriceMinSamples: 20,
      plan5EvSymbolTimeframeMinSamples: 20,
      plan5EvExploratoryMinSamples: 8,
      plan5EvExploratoryHardRejectRoi: -0.15,
      plan5EvExploratoryHardRejectGap: 0.12,
      plan5EvGateMode: 'hard',
      plan5EvMargin: 0.02
    }
  });
  assert.equal(result.allowed, false);
  assert.equal(result.provisionalCohort, true);
  assert.equal(result.sampleCount, 8);
  assert.ok(result.expectedRoi < -0.15);
});

test('Plan5 exploratory EV veto still allows mildly uncertain paper sampling', () => {
  const orders = Array.from({ length: 8 }, (_, index) => ({
    id: `exploratory-mixed-${index}`,
    source: 'paper',
    planId: 'plan5',
    symbol: 'ETH-USD',
    timeframe: '5m',
    slotIso: `exploratory-mixed-${index}`,
    settledAtIso: '2026-07-15T12:00:00.000Z',
    direction: 'up',
    entryPrice: 0.60,
    lockStrength: 'normal',
    won: index < 5
  }));
  const result = evaluatePlan5ExpectedValueGate({
    symbol: 'ETH-USD',
    timeframe: '5m',
    strength: 'normal',
    direction: 'up',
    entryPrice: 0.60,
    orders,
    paperMode: true,
    now: new Date('2026-07-15T13:00:00.000Z'),
    config: {
      plan5EvPaperOnlyEnabled: true,
      plan5EvExactMinSamples: 20,
      plan5EvPriceMinSamples: 20,
      plan5EvTimeframePriceMinSamples: 20,
      plan5EvSymbolTimeframeMinSamples: 20,
      plan5EvExploratoryMinSamples: 8,
      plan5EvExploratoryHardRejectRoi: -0.15,
      plan5EvExploratoryHardRejectGap: 0.12,
      plan5EvGateMode: 'hard',
      plan5EvMargin: 0.02
    }
  });
  assert.equal(result.allowed, true);
  assert.equal(result.insufficientSamples, true);
  assert.equal(result.provisionalCohort, true);
});

test('Plan5 paper live parity requires signal samples', () => {
  const result = evaluatePlan5SignalQuality({
    lock: { direction: 'up' },
    sentiment: {},
    timeframe: '5m',
    paperMode: true,
    config: {
      plan5LiveParityEnabled: true,
      plan5SignalQualityRequireSamplesLive: true
    }
  });
  assert.equal(result.allowed, false);
  assert.equal(result.skipReason, 'signal_quality_samples_missing');
});

test('Plan5 live EV rejects a cohort whose recent realized net ROI is negative', () => {
  const oldWins = Array.from({ length: 8 }, (_, index) => ({
    id: `old-win-${index}`,
    source: 'live',
    planId: 'plan5',
    symbol: 'XRP-USD',
    timeframe: '5m',
    slotIso: `old-win-${index}`,
    settledAtIso: `2026-07-12T0${index}:00:00.000Z`,
    direction: 'down',
    entryPrice: 0.55,
    lockStrength: 'weak',
    usd: 10,
    pnl: 8,
    won: true
  }));
  const recentLosses = Array.from({ length: 6 }, (_, index) => ({
    id: `recent-loss-${index}`,
    source: 'live',
    planId: 'plan5',
    symbol: 'XRP-USD',
    timeframe: '5m',
    slotIso: `recent-loss-${index}`,
    settledAtIso: `2026-07-13T0${index}:00:00.000Z`,
    direction: 'down',
    entryPrice: 0.55,
    lockStrength: 'weak',
    usd: 10,
    pnl: -6,
    won: false
  }));
  const result = evaluatePlan5ExpectedValueGate({
    symbol: 'XRP-USD',
    timeframe: '5m',
    strength: 'weak',
    direction: 'down',
    entryPrice: 0.55,
    orders: [...oldWins, ...recentLosses],
    paperMode: false,
    now: new Date('2026-07-13T08:00:00.000Z'),
    config: {
      plan5EvLiveOnlyEnabled: true,
      plan5EvRecentLiveEnabled: true,
      plan5EvRecentLiveMinSamples: 6,
      plan5EvRecentLiveLookbackSamples: 6,
      plan5EvRecentLiveMinRoi: 0.02,
      plan5EvExactMinSamples: 6
    }
  });
  assert.equal(result.allowed, false);
  assert.equal(result.recentLive.ready, true);
  assert.ok(result.recentLive.roi < 0);
});

test('Plan5 rejects a candidate lock when live realized EV is negative', () => {
  const recentLosses = Array.from({ length: 6 }, (_, index) => ({
    id: `sizing-only-loss-${index}`,
    source: 'live',
    planId: 'plan5',
    symbol: 'BTC-USD',
    timeframe: '5m',
    slotIso: `sizing-only-loss-${index}`,
    settledAtIso: `2026-07-13T0${index}:00:00.000Z`,
    direction: 'down',
    entryPrice: 0.62,
    lockStrength: 'normal',
    usd: 10,
    pnl: -6,
    won: false
  }));
  const plan = buildPolymarketPaperPlan5({
    signal: SIGNAL,
    sentiment: { ...SENTIMENT, upPrice: 0.38, downPrice: 0.62 },
    config: {
      ...BASE_CONFIG,
      plan5LockedSignalSizingOnlyEnabled: true,
      plan5LockedSignalMinSizeScale: 0.25,
      plan5SignalQualityEnabled: false,
      plan5EvLiveOnlyEnabled: true,
      plan5EvRecentLiveEnabled: true,
      plan5EvRecentLiveMinSamples: 6,
      plan5EvRecentLiveLookbackSamples: 6,
      plan5EvRecentLiveMinRoi: 0.02,
      plan5EvExactMinSamples: 6
    },
    timeframe: '5m',
    portfolio: { ...PORTFOLIO, cash: 80, equity: 80 },
    intervalPmLock: { direction: 'down', strength: 'normal', confidence: 0.62, pmGap: 0.24 },
    lossReasonOrders: recentLosses,
    paperMode: false,
    now: new Date('2026-07-13T08:00:00.000Z')
  });
  assert.equal(plan.action.shouldTrade, false);
  assert.equal(plan.action.skipReason, 'expected_value_negative');
  assert.notEqual(plan.action.expectedValueGate.sizingOnlyBypass, true);
  assert.ok(plan.action.expectedValueGate.recentLive.roi < 0);
});

test('Plan5 sizes rather than rejects a locked signal when EV is mildly negative', () => {
  const mildNegative = Array.from({ length: 8 }, (_, index) => ({
    id: `mild-negative-${index}`,
    source: 'live',
    planId: 'plan5',
    symbol: 'BTC-USD',
    timeframe: '5m',
    slotIso: `mild-negative-${index}`,
    settledAtIso: `2026-07-13T0${index}:00:00.000Z`,
    direction: 'up',
    entryPrice: 0.78,
    lockStrength: 'normal',
    won: index < 5
  }));
  const plan = buildPolymarketPaperPlan5({
    signal: SIGNAL,
    sentiment: { ...SENTIMENT, upPrice: 0.78, downPrice: 0.22 },
    config: {
      ...BASE_CONFIG,
      plan5LockedSignalSizingOnlyEnabled: true,
      plan5LockedSignalMinSizeScale: 0.25,
      plan5SignalQualityEnabled: false,
      plan5EvLiveOnlyEnabled: true,
      plan5EvRecentLiveEnabled: true,
      plan5EvExactMinSamples: 6,
      plan5EvHardRejectRoi: -0.25,
      plan5EvGateMode: 'hard'
    },
    timeframe: '5m',
    portfolio: { ...PORTFOLIO, cash: 80, equity: 80 },
    intervalPmLock: { direction: 'up', strength: 'normal', confidence: 0.78, pmGap: 0.56 },
    lossReasonOrders: mildNegative,
    paperMode: false,
    now: new Date('2026-07-13T08:00:00.000Z')
  });
  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.expectedValueGate.sizingOnlyBypass, true);
  assert.ok(plan.action.expectedValueGate.expectedRoi > -0.25);
  assert.ok(plan.action.expectedValueGate.sizeScale < 1);
});

test('Plan5 EV rejects conservative probability below price even when realized ROI is positive', () => {
  const orders = Array.from({ length: 8 }, (_, index) => ({
    id: `positive-net-roi-${index}`,
    source: 'live',
    planId: 'plan5',
    symbol: 'XRP-USD',
    timeframe: '5m',
    slotIso: `positive-net-roi-${index}`,
    settledAtIso: `2026-07-13T0${index}:00:00.000Z`,
    direction: 'down',
    entryPrice: 0.60,
    lockStrength: 'normal',
    usd: 10,
    pnl: index < 5 ? 7 : -10,
    won: index < 5
  }));
  const result = evaluatePlan5ExpectedValueGate({
    symbol: 'XRP-USD',
    timeframe: '5m',
    strength: 'normal',
    direction: 'down',
    entryPrice: 0.60,
    orders,
    paperMode: false,
    now: new Date('2026-07-13T08:00:00.000Z'),
    config: {
      plan5EvGateMode: 'hard',
      plan5EvLiveOnlyEnabled: true,
      plan5EvRecentLiveEnabled: true,
      plan5EvRecentLiveMinSamples: 6,
      plan5EvRecentLiveLookbackSamples: 8,
      plan5EvRecentLiveMinRoi: 0.02,
      plan5EvRealizedRoiWeightLive: 1,
      plan5EvMargin: 0.02,
      plan5EvExactMinSamples: 6
    }
  });
  assert.ok(result.conservativeWinRate < result.requiredWinRate);
  assert.ok(result.expectedRoi > 0.02);
  assert.equal(result.realizedEvidenceOverride, false);
  assert.equal(result.allowed, false);
});

test('Plan5 entry timing waits for weak locks to mature', () => {
  const early = evaluatePlan5EntryTiming({
    lock: { direction: 'down', strength: 'weak', lockedAtIso: '2026-07-13T04:17:10.000Z' },
    schedule: { currentSlotIso: '2026-07-13T04:15:00.000Z' },
    timeframe: '15m',
    now: new Date('2026-07-13T04:17:55.000Z'),
    config: {
      plan5EntryTimingEnabled: true,
      plan5WeakMinElapsedPct15m: 0.35,
      plan5MinLockAgeMs15m: 30000
    }
  });
  assert.equal(early.allowed, false);
  assert.equal(early.skipReason, 'entry_timing_too_early');

  const mature = evaluatePlan5EntryTiming({
    lock: { direction: 'down', strength: 'weak', lockedAtIso: '2026-07-13T04:17:10.000Z' },
    schedule: { currentSlotIso: '2026-07-13T04:15:00.000Z' },
    timeframe: '15m',
    now: new Date('2026-07-13T04:20:30.000Z'),
    config: {
      plan5EntryTimingEnabled: true,
      plan5WeakMinElapsedPct15m: 0.35,
      plan5MinLockAgeMs15m: 30000
    }
  });
  assert.equal(mature.allowed, true);
});

test('Plan5 entry timing does not apply recorder lock age to display fallback locks', () => {
  const result = evaluatePlan5EntryTiming({
    lock: { source: 'display', direction: 'up', strength: 'weak', lockedAtIso: null },
    schedule: { currentSlotIso: '2026-07-13T04:15:00.000Z' },
    timeframe: '5m',
    now: new Date('2026-07-13T04:16:20.000Z'),
    config: {
      plan5EntryTimingEnabled: true,
      plan5WeakMinElapsedPct5m: 0.25,
      plan5MinLockAgeMs5m: 15000
    }
  });
  assert.equal(result.allowed, true);
  assert.equal(result.enforceLockAge, false);
});

test('Plan5 entry timing allows lock age confirmation to be disabled explicitly', () => {
  const result = evaluatePlan5EntryTiming({
    lock: { source: 'polymarket', direction: 'up', strength: 'normal', lockedAtIso: '2026-07-13T04:16:19.000Z' },
    schedule: { currentSlotIso: '2026-07-13T04:15:00.000Z' },
    timeframe: '5m',
    now: new Date('2026-07-13T04:16:20.000Z'),
    config: {
      plan5EntryTimingEnabled: true,
      plan5MinElapsedPct5m: 0.25,
      plan5MinLockAgeMs5m: 0
    }
  });
  assert.equal(result.allowed, true);
  assert.equal(result.minLockAgeMs, 0);
});

test('Plan5 signal quality requires a stable leader and rejects pullbacks', () => {
  const now = new Date('2026-07-10T04:00:30.000Z');
  const samples = [0, 5, 10, 15, 20].map((seconds, index) => ({
    ts: Date.parse('2026-07-10T04:00:00.000Z') + seconds * 1000,
    upPrice: 0.58 + index * 0.01,
    downPrice: 0.42 - index * 0.01
  }));
  const stable = evaluatePlan5SignalQuality({
    lock: { direction: 'up' },
    sentiment: { windowTrack: { snapshot: { samples }, up: { pullbackFromPeak: 0.01, btcMaxReverseBps: 2 } } },
    timeframe: '5m',
    now,
    config: { plan5SignalQualityMinSamples: 4, plan5SignalQualityMinStableMs5m: 15000 }
  });
  assert.equal(stable.allowed, true);
  assert.ok(stable.stableMs >= 15000);

  const reversal = evaluatePlan5SignalQuality({
    lock: { direction: 'up' },
    sentiment: {
      windowTrack: {
        snapshot: { samples: [...samples, { ts: now.getTime(), upPrice: 0.45, downPrice: 0.55 }] },
        up: { pullbackFromPeak: 0.18, btcMaxReverseBps: 20 }
      }
    },
    timeframe: '5m',
    now,
    config: { plan5SignalQualityMinSamples: 4 }
  });
  assert.equal(reversal.allowed, false);
  assert.match(reversal.reason, /连续/);
});

test('Plan5 signal quality stable duration is not capped by sample lookback', () => {
  const startMs = Date.parse('2026-07-10T04:00:00.000Z');
  const samples = Array.from({ length: 21 }, (_, index) => ({
    ts: startMs + index * 1000,
    upPrice: 0.60 + index * 0.001,
    downPrice: 0.40 - index * 0.001
  }));
  const quality = evaluatePlan5SignalQuality({
    lock: { direction: 'up' },
    sentiment: {
      windowTrack: {
        snapshot: { samples },
        up: { pullbackFromPeak: 0, btcMaxReverseBps: 2 }
      }
    },
    timeframe: '5m',
    now: new Date(startMs + 20000),
    config: {
      plan5SignalQualityMinSamples: 4,
      plan5SignalQualityLookbackSamples: 8,
      plan5SignalQualityMinStableMs5m: 15000
    }
  });

  assert.equal(quality.allowed, true);
  assert.equal(quality.stableSamples, 21);
  assert.equal(quality.stableMs, 20000);
});
import { PolymarketTradingService } from '../src/polymarketTrading.js';

test('Plan5 current-version stats exclude legacy strategy orders', () => {
  const service = new PolymarketTradingService({ config: BASE_CONFIG });
  service.getBucket('plan5').paperOrders = [
    { settlementStatus: 'settled', strategyVersion: PLAN5_VERSION, won: true, pnl: 4 },
    { settlementStatus: 'settled', strategyVersion: PLAN5_VERSION, won: false, pnl: -2 },
    { settlementStatus: 'settled', strategyVersion: 'plan5_live_parity_v8', won: false, pnl: -10 }
  ];
  assert.deepEqual(service.computeStrategyVersionStats('plan5', PLAN5_VERSION), {
    strategyVersion: PLAN5_VERSION,
    settledOrders: 2,
    wins: 1,
    losses: 1,
    winRate: 0.5,
    realizedPnl: 2
  });
});

const BASE_CONFIG = {
  plan5Enabled: true,
  plan5WeakCashPct: 0.05,
  plan5NormalCashPct: 0.10,
  plan5StrongCashPct: 0.15,
  plan5MinOrderUsd: 10,
  // 默认关历史门控，避免无 stats 时干扰基础仓位用例；门控用例单独打开
  plan5HistoryGateEnabled: false
};

const PORTFOLIO = {
  portfolioInitialized: true,
  startingCash: 500,
  cash: 500,
  equity: 500
};

const SENTIMENT = {
  available: true,
  symbol: 'BTC-USD',
  market: 'BTC Up or Down',
  upPrice: 0.62,
  downPrice: 0.38,
  upProbability: 0.62,
  downProbability: 0.38,
  qualityScore: 0.7,
  upTokenId: 'up-token',
  downTokenId: 'down-token'
};

const SIGNAL = {
  symbol: 'BTC-USD',
  schedule: {
    currentSlotIso: '2026-07-09T02:00:00.000Z',
    nextSlotIso: '2026-07-09T02:05:00.000Z',
    secondsToNext: 180,
    slotMinutes: 5
  },
  prediction: { targetTimeIso: '2026-07-09T02:05:00.000Z' }
};

test('resolvePlan5CashPct maps weak/normal/strong', () => {
  assert.equal(resolvePlan5CashPct('weak', BASE_CONFIG), 0.05);
  assert.equal(resolvePlan5CashPct('normal', BASE_CONFIG), 0.10);
  assert.equal(resolvePlan5CashPct('strong', BASE_CONFIG), 0.15);
  assert.equal(resolvePlan5CashPct('unknown', BASE_CONFIG), null);
  assert.equal(resolvePlan5CashPct(null, BASE_CONFIG), null);
});

test('normalizePlan5Lock rejects unlocked or unknown strength', () => {
  assert.equal(normalizePlan5Lock(null), null);
  assert.equal(normalizePlan5Lock({ direction: 'up' }), null);
  assert.equal(normalizePlan5Lock({ direction: 'up', strength: 'unknown' }), null);
  assert.deepEqual(normalizePlan5Lock({ direction: 'DOWN', strength: 'Strong', pmGap: 0.12 }), {
    source: 'polymarket',
    direction: 'down',
    strength: 'strong',
    pmGap: 0.12,
    confidence: null,
    upProbability: null,
    downProbability: null,
    lockedAtIso: null,
    lockReason: null
  });
});

test('plan5 sizes by lock strength against remaining cash', () => {
  const weak = buildPolymarketPaperPlan5({
    signal: SIGNAL,
    sentiment: SENTIMENT,
    config: BASE_CONFIG,
    timeframe: '5m',
    portfolio: PORTFOLIO,
    intervalPmLock: { direction: 'up', strength: 'weak', confidence: 0.62, pmGap: 0.05 },
    now: new Date('2026-07-09T02:02:00.000Z')
  });
  assert.equal(weak.action.shouldTrade, true);
  assert.equal(weak.action.direction, 'up');
  assert.equal(weak.action.lockStrength, 'weak');
  assert.equal(weak.action.cashPct, 0.05);
  assert.equal(weak.action.usd, 25);
  assert.equal(weak.action.takeProfitPrice, null);
  assert.equal(weak.action.stopLossPrice, 0.3);
  assert.match(weak.action.executionKey, /^plan5_BTC_/);

  const normal = buildPolymarketPaperPlan5({
    signal: SIGNAL,
    sentiment: { ...SENTIMENT, upPrice: 0.38, downPrice: 0.62 },
    config: BASE_CONFIG,
    timeframe: '5m',
    portfolio: PORTFOLIO,
    intervalPmLock: { direction: 'down', strength: 'normal', confidence: 0.7, pmGap: 0.08 },
    now: new Date('2026-07-09T02:02:00.000Z')
  });
  assert.equal(normal.action.usd, 50);
  assert.equal(normal.action.direction, 'down');
  assert.equal(normal.action.cashPct, 0.10);

  const strong = buildPolymarketPaperPlan5({
    signal: SIGNAL,
    sentiment: { ...SENTIMENT, upPrice: 0.35, downPrice: 0.65 },
    config: BASE_CONFIG,
    timeframe: '15m',
    portfolio: { ...PORTFOLIO, cash: 200, equity: 200 },
    intervalPmLock: { direction: 'down', strength: 'strong', confidence: 0.8, pmGap: 0.14 },
    now: new Date('2026-07-09T02:02:00.000Z')
  });
  assert.equal(strong.action.usd, 30);
  assert.equal(strong.action.cashPct, 0.15);
  assert.equal(strong.timeframe, '15m');
});

test('Plan5 can hold to official settlement with stop loss disabled', () => {
  const plan = buildPolymarketPaperPlan5({
    signal: SIGNAL,
    sentiment: SENTIMENT,
    config: { ...BASE_CONFIG, plan5StopLossEnabled: false },
    timeframe: '5m',
    portfolio: PORTFOLIO,
    intervalPmLock: { direction: 'up', strength: 'weak', confidence: 0.62, pmGap: 0.24 },
    now: new Date('2026-07-09T02:02:00.000Z')
  });
  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.stopLossPrice, null);
  assert.match(plan.action.reason, /持有至官方结算/);
});

test('plan5 waits when unlocked early in window (no display lock yet)', () => {
  const earlySignal = {
    ...SIGNAL,
    schedule: {
      ...SIGNAL.schedule,
      secondsToNext: 280 // ~6.7% elapsed < 12% display threshold
    }
  };
  const unlocked = buildPolymarketPaperPlan5({
    signal: earlySignal,
    sentiment: SENTIMENT,
    config: BASE_CONFIG,
    timeframe: '5m',
    portfolio: PORTFOLIO,
    intervalPmLock: null,
    now: new Date('2026-07-09T02:00:20.000Z')
  });
  assert.equal(unlocked.action.shouldTrade, false);
  assert.equal(unlocked.action.waitingForLock, true);
  assert.equal(unlocked.action.observeOnly, true);
  assert.match(unlocked.action.reason, /等待锁定/);
  assert.equal(
    unlocked.key,
    buildPlan5WaitKey(SIGNAL.schedule.currentSlotIso, SIGNAL.schedule.nextSlotIso, '5m')
  );
  assert.equal(unlocked.action.executionKey, undefined);

  const badStrength = buildPolymarketPaperPlan5({
    signal: earlySignal,
    sentiment: SENTIMENT,
    config: BASE_CONFIG,
    timeframe: '5m',
    portfolio: PORTFOLIO,
    intervalPmLock: { direction: 'up', strength: 'unknown' },
    now: new Date('2026-07-09T02:00:20.000Z')
  });
  assert.equal(badStrength.action.shouldTrade, false);
  assert.equal(badStrength.action.waitingForLock, true);
  assert.match(badStrength.action.reason, /等待锁定/);
});

test('plan5 uses display lock when recorder lock is still null mid-window', () => {
  const actionableSentiment = {
    ...SENTIMENT,
    upProbability: 0.66,
    downProbability: 0.34
  };
  const midSignal = {
    ...SIGNAL,
    schedule: {
      ...SIGNAL.schedule,
      secondsToNext: 180 // 40% elapsed >= 12%
    }
  };
  const lock = resolvePlan5EntryLock({
    intervalPmLock: null,
    sentiment: actionableSentiment,
    schedule: midSignal.schedule,
    timeframe: '5m'
  });
  assert.ok(lock);
  assert.equal(lock.direction, 'up');
  assert.ok(['weak', 'normal', 'strong'].includes(lock.strength));

  const plan = buildPolymarketPaperPlan5({
    signal: midSignal,
    sentiment: actionableSentiment,
    config: BASE_CONFIG,
    timeframe: '5m',
    portfolio: PORTFOLIO,
    intervalPmLock: null,
    now: new Date('2026-07-09T02:02:00.000Z')
  });
  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.direction, 'up');
  assert.equal(plan.action.lockStrength, lock.strength);
  assert.equal(plan.action.cashPct, resolvePlan5CashPct(lock.strength, BASE_CONFIG));
  assert.equal(plan.action.usd, round2Expected(500 * plan.action.cashPct));
});

function round2Expected(value) {
  return Math.round(Number(value) * 100) / 100;
}

test('plan5 unlocked skip does not mark key executed; later locked tick can trade', async () => {
  const service = new PolymarketTradingService({
    config: {
      defaultOrderUsd: 5,
      maxOrderUsd: 500,
      ...BASE_CONFIG
    },
    statePath: 'data/test-polymarket-plan5-wait-lock.json'
  });
  await service.configurePortfolio({ cash: 500, planId: 'plan5' });
  await service.setAuto(true, { planId: 'plan5', timeframes: ['5m'] });

  const earlySignal = {
    ...SIGNAL,
    schedule: {
      ...SIGNAL.schedule,
      secondsToNext: 280
    }
  };
  const unlockedPlan = buildPolymarketPaperPlan5({
    signal: earlySignal,
    sentiment: SENTIMENT,
    config: BASE_CONFIG,
    timeframe: '5m',
    portfolio: PORTFOLIO,
    intervalPmLock: null,
    now: new Date('2026-07-09T02:00:20.000Z')
  });
  const waitResult = await service.maybeAutoExecute({
    plan: unlockedPlan,
    sentiment: SENTIMENT,
    recommendation: null,
    planId: 'plan5'
  });
  assert.equal(waitResult.executed, false);
  assert.equal(waitResult.waitingForLock, true);
  assert.equal(service.getBucket('plan5').auto.lastExecutedKeys.length, 0);

  const lockedPlan = buildPolymarketPaperPlan5({
    signal: SIGNAL,
    sentiment: SENTIMENT,
    config: BASE_CONFIG,
    timeframe: '5m',
    portfolio: PORTFOLIO,
    intervalPmLock: { direction: 'up', strength: 'normal', confidence: 0.62, pmGap: 0.08 },
    now: new Date('2026-07-09T02:02:00.000Z')
  });
  assert.equal(lockedPlan.action.shouldTrade, true);
  const tradeResult = await service.maybeAutoExecute({
    plan: lockedPlan,
    sentiment: SENTIMENT,
    recommendation: null,
    planId: 'plan5'
  });
  assert.equal(tradeResult.executed, true);
  assert.equal(tradeResult.order?.direction, 'up');
  assert.ok(service.getBucket('plan5').auto.lastExecutedKeys.includes(lockedPlan.action.executionKey));
});

test('plan5 locked-signal sizing mode raises a small calculated order to the minimum', () => {
  const plan = buildPolymarketPaperPlan5({
    signal: SIGNAL,
    sentiment: SENTIMENT,
    config: BASE_CONFIG,
    timeframe: '5m',
    portfolio: { ...PORTFOLIO, cash: 80, equity: 80 },
    intervalPmLock: { direction: 'up', strength: 'weak', confidence: 0.6, pmGap: 0.04 },
    now: new Date('2026-07-09T02:02:00.000Z')
  });
  // 80 * 10% = 8 < min $10
  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.usd, 10);
  assert.equal(plan.action.sizingOnlyMode, true);
});

test('plan5 live keeps a locked signal at the live minimum when EV is cold and quotes are desynced', () => {
  const plan = buildPolymarketPaperPlan5({
    signal: SIGNAL,
    sentiment: {
      ...SENTIMENT,
      upPrice: 0.505,
      downPrice: 0.99,
      upProbability: 0.505,
      downProbability: 0.99
    },
    config: {
      ...BASE_CONFIG,
      plan5ExpectedValueGateEnabled: true,
      plan5LockedSignalSizingOnlyEnabled: true,
      plan5LockedSignalMinSizeScale: 0.25,
      plan5LiveMinOrderUsd: 1,
      plan5MinOrderUsd: 1
    },
    timeframe: '5m',
    portfolio: { ...PORTFOLIO, cash: 80, equity: 80 },
    intervalPmLock: { direction: 'down', strength: 'weak', confidence: 0.6, pmGap: 0.04 },
    lossReasonOrders: [],
    paperMode: false,
    now: new Date('2026-07-09T02:02:00.000Z')
  });
  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.usd, 1);
  assert.equal(plan.action.expectedValueGate.insufficientSamples, true);
  assert.equal(plan.action.expectedValueGate.sizingOnlyBypass, true);
  assert.equal(plan.action.marketAlignment.quoteDesynced, true);
  assert.equal(plan.action.marketAlignment.executionQuoteRefreshRequired, true);
});

test('plan5 disabled via config', () => {
  const plan = buildPolymarketPaperPlan5({
    signal: SIGNAL,
    sentiment: SENTIMENT,
    config: { ...BASE_CONFIG, plan5Enabled: false },
    timeframe: '5m',
    portfolio: PORTFOLIO,
    intervalPmLock: { direction: 'up', strength: 'strong', confidence: 0.8, pmGap: 0.12 },
    now: new Date('2026-07-09T02:02:00.000Z')
  });
  assert.equal(plan.action.shouldTrade, false);
  assert.match(plan.action.reason, /已禁用/);
});

const HISTORY_GATE_CONFIG = {
  ...BASE_CONFIG,
  plan5HistoryGateEnabled: true,
  plan5HistoryMinSamples: 20,
  plan5HistoryMargin: 0.02,
  plan5HistoryMinAccuracy: 0.55,
  plan5HistoryRequireSamples: false,
  plan5HistorySizeScaleEnabled: true,
  plan5HistoryGateMode: 'hard',
  plan5HistoryHardRejectGap: 0.15,
  plan5AdaptiveSizingEnabled: true
};

test('evaluatePlan5LockHistoryGate skips when WR below breakeven with enough samples', () => {
  const result = evaluatePlan5LockHistoryGate({
    strength: 'weak',
    entryPrice: 0.62,
    lockStrengthStats: {
      weak: { total: 40, correct: 20, wrong: 20, accuracy: 0.5 }
    },
    config: HISTORY_GATE_CONFIG
  });
  // required = 0.62 + 0.02 = 0.64; 0.50 < 0.64
  assert.equal(result.allowed, false);
  assert.equal(result.sampleCount, 40);
  assert.equal(result.winRate, 0.5);
  assert.equal(result.requiredWinRate, 0.64);
  assert.match(result.reason, /历史胜率/);
});

test('evaluatePlan5LockHistoryGate soft mode scales instead of skipping mild underperformance', () => {
  const soft = evaluatePlan5LockHistoryGate({
    strength: 'weak',
    entryPrice: 0.65,
    lockStrengthStats: {
      weak: { total: 40, correct: 26, wrong: 14, accuracy: 0.65 }
    },
    config: {
      ...HISTORY_GATE_CONFIG,
      plan5HistoryGateMode: 'soft',
      plan5HistoryMargin: 0,
      plan5HistoryHardRejectGap: 0.15
    }
  });
  // required=0.65; gap=0 → exactly at breakeven → allowed full
  assert.equal(soft.allowed, true);

  const mild = evaluatePlan5LockHistoryGate({
    strength: 'weak',
    entryPrice: 0.70,
    lockStrengthStats: {
      weak: { total: 40, correct: 26, wrong: 14, accuracy: 0.65 }
    },
    config: {
      ...HISTORY_GATE_CONFIG,
      plan5HistoryGateMode: 'soft',
      plan5HistoryMargin: 0,
      plan5HistoryHardRejectGap: 0.15
    }
  });
  // required=0.70; gap=0.05 < 0.15 → soft scale
  assert.equal(mild.allowed, true);
  assert.equal(mild.softReject, true);
  assert.ok(mild.sizeScale > 0.25 && mild.sizeScale < 1);

  const severe = evaluatePlan5LockHistoryGate({
    strength: 'weak',
    entryPrice: 0.85,
    lockStrengthStats: {
      weak: { total: 40, correct: 26, wrong: 14, accuracy: 0.65 }
    },
    config: {
      ...HISTORY_GATE_CONFIG,
      plan5HistoryGateMode: 'soft',
      plan5HistoryMargin: 0,
      plan5HistoryHardRejectGap: 0.15
    }
  });
  // required=0.85; gap=0.20 >= 0.15 → hard reject even in soft
  assert.equal(severe.allowed, false);
});

test('Plan5 signal quality soft mode scales on pullback instead of hard skip', () => {
  const now = new Date('2026-07-10T04:00:30.000Z');
  const samples = [0, 5, 10, 15, 20].map((seconds, index) => ({
    ts: Date.parse('2026-07-10T04:00:00.000Z') + seconds * 1000,
    upPrice: 0.58 + index * 0.01,
    downPrice: 0.42 - index * 0.01
  }));
  const soft = evaluatePlan5SignalQuality({
    lock: { direction: 'up' },
    sentiment: {
      windowTrack: {
        snapshot: { samples },
        up: { pullbackFromPeak: 0.18, btcMaxReverseBps: 2 }
      }
    },
    timeframe: '5m',
    now,
    config: {
      plan5SignalQualityMinSamples: 4,
      plan5SignalQualityMinStableMs5m: 15000,
      plan5SignalQualityMaxPullback: 0.10,
      plan5SignalQualityMode: 'soft'
    }
  });
  assert.equal(soft.allowed, true);
  assert.equal(soft.softReject, true);
  assert.ok(soft.sizeScale < 1);

  const hard = evaluatePlan5SignalQuality({
    lock: { direction: 'up' },
    sentiment: {
      windowTrack: {
        snapshot: { samples },
        up: { pullbackFromPeak: 0.18, btcMaxReverseBps: 2 }
      }
    },
    timeframe: '5m',
    now,
    config: {
      plan5SignalQualityMinSamples: 4,
      plan5SignalQualityMinStableMs5m: 15000,
      plan5SignalQualityMaxPullback: 0.10,
      plan5SignalQualityMode: 'hard'
    }
  });
  assert.equal(hard.allowed, false);
  assert.match(hard.reason, /回撤/);
});

test('evaluatePlan5LockHistoryGate allows when WR clears breakeven', () => {
  const result = evaluatePlan5LockHistoryGate({
    strength: 'normal',
    entryPrice: 0.62,
    lockStrengthStats: {
      normal: { total: 40, correct: 30, wrong: 10, accuracy: 0.75 }
    },
    config: HISTORY_GATE_CONFIG
  });
  assert.equal(result.allowed, true);
  assert.equal(result.sampleCount, 40);
  assert.equal(result.winRate, 0.75);
  assert.ok(result.sizeScale > 1);
  assert.ok(result.sizeScale <= 1.25);
});

test('evaluatePlan5LockHistoryGate scales size by edge over required WR', () => {
  const barely = evaluatePlan5LockHistoryGate({
    strength: 'strong',
    entryPrice: 0.62,
    lockStrengthStats: {
      strong: { total: 30, correct: 20, wrong: 10, accuracy: 0.65 }
    },
    config: HISTORY_GATE_CONFIG
  });
  // required 0.64; edge 0.01 → scale ≈ 0.74
  assert.equal(barely.allowed, true);
  assert.ok(barely.sizeScale < 1);
  assert.ok(barely.sizeScale >= 0.7);

  const strongEdge = evaluatePlan5LockHistoryGate({
    strength: 'strong',
    entryPrice: 0.55,
    lockStrengthStats: {
      strong: { total: 50, correct: 40, wrong: 10, accuracy: 0.8 }
    },
    config: HISTORY_GATE_CONFIG
  });
  // required 0.57; edge 0.23 → clamp 1.25
  assert.equal(strongEdge.allowed, true);
  assert.equal(strongEdge.sizeScale, 1.25);

  const noScale = evaluatePlan5LockHistoryGate({
    strength: 'strong',
    entryPrice: 0.55,
    lockStrengthStats: {
      strong: { total: 50, correct: 40, wrong: 10, accuracy: 0.8 }
    },
    config: { ...HISTORY_GATE_CONFIG, plan5HistorySizeScaleEnabled: false }
  });
  assert.equal(noScale.sizeScale, 1);
});

test('evaluatePlan5LockHistoryGate allows cold start; requireSamples blocks', () => {
  const cold = evaluatePlan5LockHistoryGate({
    strength: 'weak',
    entryPrice: 0.62,
    lockStrengthStats: {
      weak: { total: 5, correct: 2, wrong: 3, accuracy: 0.4 }
    },
    config: HISTORY_GATE_CONFIG
  });
  assert.equal(cold.allowed, true);
  assert.equal(cold.insufficientSamples, true);
  assert.equal(cold.sizeScale, 1);

  const missing = evaluatePlan5LockHistoryGate({
    strength: 'weak',
    entryPrice: 0.62,
    lockStrengthStats: null,
    config: HISTORY_GATE_CONFIG
  });
  assert.equal(missing.allowed, true);
  assert.equal(missing.insufficientSamples, true);

  const required = evaluatePlan5LockHistoryGate({
    strength: 'weak',
    entryPrice: 0.62,
    lockStrengthStats: {
      weak: { total: 5, correct: 2, wrong: 3, accuracy: 0.4 }
    },
    config: { ...HISTORY_GATE_CONFIG, plan5HistoryRequireSamples: true }
  });
  assert.equal(required.allowed, false);
  assert.equal(required.insufficientSamples, true);
  assert.match(required.reason, /样本不足/);
});

test('plan5 entry path only scales history underperformance and never rejects a locked signal', () => {
  const softScaled = buildPolymarketPaperPlan5({
    signal: SIGNAL,
    sentiment: { ...SENTIMENT, upPrice: 0.70, downPrice: 0.30 },
    config: {
      ...HISTORY_GATE_CONFIG,
      plan5HistoryGateMode: 'soft',
      plan5HistoryMargin: 0,
      plan5HistoryHardRejectGap: 0.15,
      plan5AdaptiveSizingEnabled: false
    },
    timeframe: '5m',
    portfolio: PORTFOLIO,
    intervalPmLock: { direction: 'up', strength: 'weak', confidence: 0.70, pmGap: 0.05 },
    lockStrengthStats: {
      weak: { total: 40, correct: 26, wrong: 14, accuracy: 0.65 }
    },
    now: new Date('2026-07-09T02:02:00.000Z')
  });
  assert.equal(softScaled.action.shouldTrade, true);
  assert.equal(softScaled.action.historyWinRateGate.softReject, true);
  assert.ok(softScaled.action.cashPct < BASE_CONFIG.plan5WeakCashPct);

  const skipped = buildPolymarketPaperPlan5({
    signal: SIGNAL,
    sentiment: SENTIMENT,
    config: HISTORY_GATE_CONFIG,
    timeframe: '5m',
    portfolio: PORTFOLIO,
    intervalPmLock: { direction: 'up', strength: 'weak', confidence: 0.62, pmGap: 0.05 },
    lockStrengthStats: {
      weak: { total: 40, correct: 18, wrong: 22, accuracy: 0.45 }
    },
    now: new Date('2026-07-09T02:02:00.000Z')
  });
  assert.equal(skipped.action.shouldTrade, true);
  assert.equal(skipped.action.historyWinRateGate.softReject, true);
  assert.equal(skipped.action.historyWinRateGate.sizingOnlyBypass, true);
  assert.ok(skipped.action.cashPct < BASE_CONFIG.plan5WeakCashPct);

  const scaled = buildPolymarketPaperPlan5({
    signal: SIGNAL,
    sentiment: SENTIMENT,
    config: HISTORY_GATE_CONFIG,
    timeframe: '5m',
    portfolio: PORTFOLIO,
    intervalPmLock: { direction: 'up', strength: 'normal', confidence: 0.62, pmGap: 0.08 },
    lockStrengthStats: {
      normal: { total: 40, correct: 32, wrong: 8, accuracy: 0.8 }
    },
    now: new Date('2026-07-09T02:02:00.000Z')
  });
  assert.equal(scaled.action.shouldTrade, true);
  assert.ok(scaled.action.historySizeScale > 1);
  assert.ok(scaled.action.cashPct > BASE_CONFIG.plan5NormalCashPct);
  assert.equal(
    scaled.action.usd,
    round2Expected(500 * scaled.action.cashPct)
  );
  assert.equal(scaled.action.historyWinRateGate.passed, true);
  assert.equal(scaled.action.historyWinRateGate.winRate, 0.8);
});

test('plan5 same-direction boost increases cash pct when continuity WR is higher', () => {
  const base = buildPolymarketPaperPlan5({
    signal: SIGNAL,
    sentiment: SENTIMENT,
    config: {
      ...BASE_CONFIG,
      symbolWrSizingEnabled: false,
      plan5AdaptiveSizingEnabled: true,
      plan5SameDirBoostEnabled: true,
      plan5SameDirBoost: 1.25,
      plan5SameDirBoostMax: 1.35,
      plan5SameDirMinSamples: 15,
      plan5SameDirMinEdge: 0.03
    },
    timeframe: '5m',
    portfolio: PORTFOLIO,
    intervalPmLock: { direction: 'up', strength: 'weak', confidence: 0.62, pmGap: 0.05 },
    nextSlotPrediction: { predictedDirection: 'up', sameDirectionAsPrev: true, predictedSlotIso: SIGNAL.schedule.currentSlotIso },
    incomingNextSlotPrediction: { predictedDirection: 'up', sameDirectionAsPrev: true, predictedSlotIso: SIGNAL.schedule.currentSlotIso },
    nextSlotPredictionSummary: {
      same: { total: 20, correct: 16, accuracy: 0.8 },
      flip: { total: 20, correct: 10, accuracy: 0.5 },
      overall: { total: 40, correct: 26, accuracy: 0.65 }
    },
    now: new Date('2026-07-09T02:02:00.000Z')
  });
  assert.equal(base.action.shouldTrade, true);
  assert.equal(base.action.sameDirectionBoost.applied, true);
  assert.equal(base.action.cashPct, 0.0625);
  assert.equal(base.action.usd, 31.25);
});

test('plan5 pre-open buys next window when accuracy gate passes and market exists', () => {
  const now = new Date('2026-07-09T01:58:00.000Z'); // before 02:00 next window start
  const signal = {
    ...SIGNAL,
    schedule: {
      currentSlotIso: '2026-07-09T01:55:00.000Z',
      nextSlotIso: '2026-07-09T02:00:00.000Z',
      secondsToNext: 120,
      slotMinutes: 5
    },
    prediction: { targetTimeIso: '2026-07-09T02:00:00.000Z' }
  };
  const plan = buildPolymarketPaperPlan5({
    signal,
    sentiment: { available: false, reason: 'current window unused for pre-open' },
    config: {
      ...BASE_CONFIG,
      plan5PreOpenEnabled: true,
      plan5PreOpenMinAccuracy: 0.65,
      plan5PreOpenMinSamples: 20,
      plan5PreOpenSizeFraction: 0.4,
      plan5SameDirBoostEnabled: false,
      symbolWrSizingEnabled: false
    },
    timeframe: '5m',
    portfolio: PORTFOLIO,
    intervalPmLock: null,
    nextSlotPrediction: {
      predictedDirection: 'up',
      predictedSlotIso: '2026-07-09T02:00:00.000Z',
      lockStrength: 'normal',
      sameDirectionAsPrev: false
    },
    nextSlotPredictionSummary: {
      overall: { total: 30, correct: 21, accuracy: 0.7 }
    },
    nextSlotMarketSentiment: {
      available: true,
      upPrice: 0.51,
      downPrice: 0.49,
      upTokenId: 'next-up',
      downTokenId: 'next-down'
    },
    now
  });
  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.entryType, 'pre_open');
  assert.equal(plan.action.preOpen, true);
  assert.equal(plan.action.direction, 'up');
  assert.equal(plan.action.cashPct, 0.04); // 0.10 * 0.4
  assert.equal(plan.action.usd, 20);
  assert.equal(plan.slotIso, '2026-07-09T02:00:00.000Z');
  assert.equal(plan.targetTimeIso, '2026-07-09T02:05:00.000Z');
});

test('plan5 pre-open skips when next market missing or accuracy low', () => {
  const now = new Date('2026-07-09T01:58:00.000Z');
  const signal = {
    ...SIGNAL,
    schedule: {
      currentSlotIso: '2026-07-09T01:55:00.000Z',
      nextSlotIso: '2026-07-09T02:00:00.000Z',
      secondsToNext: 120,
      slotMinutes: 5,
      elapsedInCurrentSlotPct: 0.05
    },
    prediction: { targetTimeIso: '2026-07-09T02:00:00.000Z' }
  };
  // 当前窗未锁定（早期 + 无 recorder lock），才会走开盘前分支
  const unlockedSentiment = {
    ...SENTIMENT,
    upPrice: 0.51,
    downPrice: 0.49,
    upProbability: 0.51,
    downProbability: 0.49
  };
  const lowAcc = buildPolymarketPaperPlan5({
    signal,
    sentiment: unlockedSentiment,
    config: { ...BASE_CONFIG, plan5PreOpenEnabled: true, plan5PreOpenMinAccuracy: 0.65, plan5PreOpenMinSamples: 20 },
    timeframe: '5m',
    portfolio: PORTFOLIO,
    intervalPmLock: null,
    nextSlotPrediction: {
      predictedDirection: 'up',
      predictedSlotIso: '2026-07-09T02:00:00.000Z',
      lockStrength: 'normal'
    },
    nextSlotPredictionSummary: { overall: { total: 30, correct: 15, accuracy: 0.5 } },
    nextSlotMarketSentiment: { available: true, upPrice: 0.5, downPrice: 0.5 },
    now
  });
  assert.equal(lowAcc.action.shouldTrade, false);
  assert.match(lowAcc.action.reason, /准确率|样本不足|开盘前/);

  const noMarket = buildPolymarketPaperPlan5({
    signal,
    sentiment: unlockedSentiment,
    config: { ...BASE_CONFIG, plan5PreOpenEnabled: true, plan5PreOpenMinAccuracy: 0.65, plan5PreOpenMinSamples: 20 },
    timeframe: '5m',
    portfolio: PORTFOLIO,
    intervalPmLock: null,
    nextSlotPrediction: {
      predictedDirection: 'up',
      predictedSlotIso: '2026-07-09T02:00:00.000Z',
      lockStrength: 'normal'
    },
    nextSlotPredictionSummary: { overall: { total: 30, correct: 21, accuracy: 0.7 } },
    nextSlotMarketSentiment: { available: false, reason: 'market not listed yet' },
    now
  });
  assert.equal(noMarket.action.shouldTrade, false);
  assert.equal(noMarket.action.preOpenMarketMissing, true);
});

test('plan5 after open adds to pre-open when lock agrees; holds on conflict', () => {
  const preOpenOrder = {
    id: 'pre1',
    symbol: 'BTC-USD',
    timeframe: '5m',
    slotIso: '2026-07-09T02:00:00.000Z',
    targetTimeIso: '2026-07-09T02:05:00.000Z',
    direction: 'up',
    entryType: 'pre_open',
    usd: 10,
    settlementStatus: 'open'
  };
  const add = buildPolymarketPaperPlan5({
    signal: SIGNAL,
    sentiment: SENTIMENT,
    config: { ...BASE_CONFIG, symbolWrSizingEnabled: false, plan5SameDirBoostEnabled: false, plan5PreOpenEnabled: true },
    timeframe: '5m',
    portfolio: { ...PORTFOLIO, cash: 490 },
    intervalPmLock: { direction: 'up', strength: 'weak', confidence: 0.62, pmGap: 0.05 },
    openPlan5Orders: [preOpenOrder],
    now: new Date('2026-07-09T02:02:00.000Z')
  });
  assert.equal(add.action.shouldTrade, true);
  assert.equal(add.action.entryType, 'pm_lock_add');
  assert.ok(add.action.usd > 0);
  assert.equal(add.action.relatedPreOpenOrderId, 'pre1');

  const conflict = buildPolymarketPaperPlan5({
    signal: SIGNAL,
    sentiment: { ...SENTIMENT, upPrice: 0.35, downPrice: 0.65 },
    config: { ...BASE_CONFIG, symbolWrSizingEnabled: false, plan5SameDirBoostEnabled: false },
    timeframe: '5m',
    portfolio: { ...PORTFOLIO, cash: 490 },
    intervalPmLock: { direction: 'down', strength: 'weak', confidence: 0.65, pmGap: 0.05 },
    openPlan5Orders: [preOpenOrder],
    now: new Date('2026-07-09T02:02:00.000Z')
  });
  assert.equal(conflict.action.shouldTrade, false);
  assert.equal(conflict.action.holdPreOpen, true);
  assert.match(conflict.action.reason, /冲突/);
});

test('evaluatePlan5SlotExposureGate blocks third symbol in same slot', () => {
  const open = [
    { symbol: 'ETH-USD', timeframe: '5m', slotIso: '2026-07-09T02:00:00.000Z', direction: 'up', usd: 40, settlementStatus: 'open' },
    { symbol: 'SOL-USD', timeframe: '5m', slotIso: '2026-07-09T02:00:00.000Z', direction: 'up', usd: 50, settlementStatus: 'open' }
  ];
  const blocked = evaluatePlan5SlotExposureGate({
    symbol: 'XRP-USD',
    timeframe: '5m',
    slotIso: '2026-07-09T02:00:00.000Z',
    direction: 'up',
    usd: 30,
    openPlan5Orders: open,
    portfolio: PORTFOLIO,
    config: { plan5SlotMaxSymbols: 2, plan5SlotMaxExposurePct: 0.8 }
  });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /同窗已开/);

  const allowedSame = evaluatePlan5SlotExposureGate({
    symbol: 'ETH-USD',
    timeframe: '5m',
    slotIso: '2026-07-09T02:00:00.000Z',
    direction: 'up',
    usd: 10,
    openPlan5Orders: open,
    portfolio: PORTFOLIO,
    config: { plan5SlotMaxSymbols: 2, plan5SlotMaxExposurePct: 0.8 }
  });
  assert.equal(allowedSame.allowed, true);
});

test('Plan5 below reference entry price only reduces size in sizing-only mode', () => {
  const plan = buildPolymarketPaperPlan5({
    signal: SIGNAL,
    sentiment: { ...SENTIMENT, upPrice: 0.53, downPrice: 0.47, upProbability: 0.53, downProbability: 0.47 },
    config: {
      ...BASE_CONFIG,
      plan5LockedSignalSizingOnlyEnabled: true,
      plan5LockedSignalMinSizeScale: 0.25,
      plan5MinEntryPrice: 0.58,
      plan5HardMinEntryPrice: 0.35,
      plan5MaxEntryPrice: 0.82
    },
    timeframe: '5m',
    portfolio: PORTFOLIO,
    intervalPmLock: { direction: 'up', strength: 'weak', confidence: 0.53, pmGap: 0.06 },
    now: new Date('2026-07-09T02:02:00.000Z')
  });
  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.entryPriceGate.sizingOnlyBypass, true);
});

test('Plan5 hard-rejects collapsed lottery tickets even in sizing-only mode', () => {
  const plan = buildPolymarketPaperPlan5({
    signal: SIGNAL,
    sentiment: { ...SENTIMENT, upPrice: 0.26, downPrice: 0.74, upProbability: 0.26, downProbability: 0.74 },
    config: {
      ...BASE_CONFIG,
      plan5LockedSignalSizingOnlyEnabled: true,
      plan5LockedSignalMinSizeScale: 0.25,
      plan5RequireCurrentPmAlignment: true,
      plan5MinEntryPrice: 0.50,
      plan5HardMinEntryPrice: 0.35,
      plan5DirectionRecheckEnabled: false,
      plan5DirectionRecheckCollapsePrice: 0.54,
      plan5MaxEntryPrice: 0.82
    },
    timeframe: '5m',
    portfolio: PORTFOLIO,
    intervalPmLock: {
      direction: 'up',
      strength: 'weak',
      confidence: 0.62,
      pmGap: 0.24,
      upProbability: 0.62,
      downProbability: 0.38
    },
    now: new Date('2026-07-09T02:02:00.000Z')
  });
  assert.equal(plan.action.shouldTrade, false);
  assert.ok(
    plan.action.skipReason === 'entry_price_too_low'
      || plan.action.skipReason === 'collapsed_against_pm_leader'
      || plan.action.skipReason === 'market_alignment'
  );
});

test('Plan5 above reference entry price only reduces size in sizing-only mode', () => {
  const plan = buildPolymarketPaperPlan5({
    signal: SIGNAL,
    sentiment: { ...SENTIMENT, upPrice: 0.90, downPrice: 0.10, upProbability: 0.90, downProbability: 0.10 },
    config: {
      ...BASE_CONFIG,
      plan5LockedSignalSizingOnlyEnabled: true,
      plan5LockedSignalMinSizeScale: 0.25,
      plan5MinEntryPrice: 0.50,
      plan5MaxEntryPrice: 0.80
    },
    timeframe: '5m',
    portfolio: PORTFOLIO,
    intervalPmLock: { direction: 'up', strength: 'normal', confidence: 0.70, pmGap: 0.40 },
    now: new Date('2026-07-09T02:02:00.000Z')
  });
  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.entryPriceGate.sizingOnlyBypass, true);
});

test('Plan5 paper fill skips without writing usd=0 when book ask exceeds limit', async () => {
  const service = new PolymarketTradingService({
    config: {
      defaultOrderUsd: 10,
      maxOrderUsd: 500,
      plan5PaperRequireAskFillable: true,
      plan5PaperFillSlippageTicks: 1,
      plan5PaperFillTickSize: 0.01
    },
    statePath: 'data/test-polymarket-plan5-paper-unfilled.json'
  });
  await service.configurePortfolio({ cash: 500, planId: 'plan5' });
  await assert.rejects(
    () => service.createPaperOrder({
      symbol: 'BTC-USD',
      direction: 'up',
      usd: 10,
      planId: 'plan5',
      sentiment: {
        available: true,
        symbol: 'BTC-USD',
        market: 'BTC Up or Down',
        upPrice: 0.62,
        downPrice: 0.38,
        upBestAsk: 0.66,
        downBestAsk: 0.35,
        upTokenId: 'up-token',
        downTokenId: 'down-token',
        timeframe: '5m',
        targetTimeIso: '2099-01-01T00:05:00.000Z',
        schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
      },
      plan: {
        key: 'plan5-paper-unfilled',
        timeframe: '5m',
        slotIso: '2099-01-01T00:00:00.000Z',
        action: { limitPrice: 0.62, lockStrength: 'normal' }
      }
    }, 'plan5'),
    /ask .*高于限价|未成交（跳过/
  );
  assert.equal(service.getBucket('plan5').paperOrders.length, 0);
  assert.equal(service.getBucket('plan5').portfolio.cash, 500);
});

test('Plan5 paper fill applies slippage ticks when ask is fillable', async () => {
  const service = new PolymarketTradingService({
    config: {
      defaultOrderUsd: 10,
      maxOrderUsd: 500,
      plan5PaperRequireAskFillable: true,
      plan5PaperFillSlippageTicks: 2,
      plan5PaperFillTickSize: 0.01
    },
    statePath: 'data/test-polymarket-plan5-paper-slip.json'
  });
  await service.configurePortfolio({ cash: 500, planId: 'plan5' });
  const order = await service.createPaperOrder({
    symbol: 'BTC-USD',
    direction: 'up',
    usd: 10,
    planId: 'plan5',
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      market: 'BTC Up or Down',
      upPrice: 0.62,
      downPrice: 0.38,
      upBestAsk: 0.61,
      downBestAsk: 0.39,
      upTokenId: 'up-token',
      downTokenId: 'down-token',
      timeframe: '5m',
      targetTimeIso: '2099-01-01T00:05:00.000Z',
      schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
    },
    plan: {
      key: 'plan5-paper-slip',
      timeframe: '5m',
      slotIso: '2099-01-01T00:00:00.000Z',
      action: { limitPrice: 0.62, lockStrength: 'normal' }
    }
  }, 'plan5');
  assert.equal(order.status, 'paper-filled');
  assert.equal(order.exitStatus, null);
  assert.equal(order.limitPrice, 0.64);
  assert.equal(order.entryPrice, 0.64);
  assert.equal(order.intendedLimitPrice, 0.62);
  assert.equal(order.rawBestAsk, 0.61);
  assert.equal(order.fillSlippageTicks, 2);
  assert.ok(service.getBucket('plan5').portfolio.cash < 500);
});

test('Plan5 shadow candidates deduplicate by window and settle with hypothetical ROI', async () => {
  const service = new PolymarketTradingService({
    config: {
      ...BASE_CONFIG,
      plan5ShadowEnabled: true,
      plan5ShadowHypotheticalUsd: 5,
      plan5EvExecutionPriceBufferAbs: 0.01
    },
    statePath: join(tmpdir(), `plan5-shadow-${Date.now()}.json`)
  });
  const plan = {
    symbol: 'BTC-USD',
    timeframe: '5m',
    slotIso: '2026-07-09T02:00:00.000Z',
    targetTimeIso: '2026-07-09T02:05:00.000Z',
    intervalPmLock: { direction: 'up', strength: 'normal', pmGap: 0.35 },
    action: {
      shouldTrade: false,
      skipReason: 'expected_value_negative',
      direction: 'up',
      limitPrice: 0.60,
      lockStrength: 'normal',
      lockPmGap: 0.35
    }
  };
  const sentiment = { market: 'BTC Up or Down', marketSlug: 'btc-updown-test', conditionId: 'condition-test' };

  service.recordPlan5Opportunity(plan, 'plan5', sentiment);
  service.recordPlan5Opportunity(plan, 'plan5', sentiment);
  assert.equal(service.getBucket('plan5').plan5ShadowObservations.length, 1);
  assert.equal(service.getBucket('plan5').plan5ShadowObservations[0].entryPrice, 0.61);

  await service.settleOpenOrders('plan5', async () => ({
    actualDirection: 'up',
    priceSource: 'polymarket-official',
    officialOutcome: 'up'
  }));
  const observation = service.getBucket('plan5').plan5ShadowObservations[0];
  assert.equal(observation.settlementStatus, 'settled');
  assert.equal(observation.won, true);
  assert.ok(observation.hypotheticalPnl > 0);
  assert.equal(service.computePlan5ShadowAnalytics().overall.settled, 1);
});

test('Plan5 build blocks third same-slot symbol via slot exposure gate', () => {
  const open = [
    { symbol: 'ETH-USD', timeframe: '5m', slotIso: '2026-07-09T02:00:00.000Z', direction: 'up', usd: 40, settlementStatus: 'open' },
    { symbol: 'SOL-USD', timeframe: '5m', slotIso: '2026-07-09T02:00:00.000Z', direction: 'up', usd: 50, settlementStatus: 'open' }
  ];
  const plan = buildPolymarketPaperPlan5({
    signal: SIGNAL,
    sentiment: SENTIMENT,
    config: {
      ...BASE_CONFIG,
      symbolWrSizingEnabled: false,
      plan5SameDirBoostEnabled: false,
      plan5SlotMaxSymbols: 2,
      plan5SlotMaxExposurePct: 0.9
    },
    timeframe: '5m',
    portfolio: PORTFOLIO,
    intervalPmLock: { direction: 'up', strength: 'weak', confidence: 0.62, pmGap: 0.05 },
    openPlan5Orders: open,
    now: new Date('2026-07-09T02:02:00.000Z')
  });
  assert.equal(plan.action.shouldTrade, false);
  assert.match(plan.action.reason, /同窗已开|敞口/);
});
