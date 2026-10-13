import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAN2_CLASSIC_ID,
  PLAN2_ENHANCED_ID,
  isPlan2Family,
  normalizePlan2FamilyId,
  plan2FamilyLabel,
  evaluatePlan25RecoveryGate,
  resolvePlan2ProfileConfig
} from '../src/polymarketPlan2Profiles.js';
import {
  resolvePlan2PaperMode,
  resolvePlan2EffectiveConfig,
  resolvePlan2DelayedEntry,
  buildPlan2RegimeGuard,
  resolvePlan2EntryTier
} from '../src/polymarketPlan2.js';
import { PLAN_IDS, PolymarketTradingService } from '../src/polymarketTrading.js';

test('PLAN_IDS includes plan2_5 between plan2 and plan3', () => {
  assert.ok(PLAN_IDS.includes('plan2_5'));
  assert.equal(PLAN_IDS.indexOf('plan2_5'), PLAN_IDS.indexOf('plan2') + 1);
});

test('plan2 family helpers normalize ids and labels', () => {
  assert.equal(isPlan2Family('plan2'), true);
  assert.equal(isPlan2Family('plan2_5'), true);
  assert.equal(isPlan2Family('plan3'), false);
  assert.equal(normalizePlan2FamilyId('plan2_5'), PLAN2_ENHANCED_ID);
  assert.equal(normalizePlan2FamilyId('unknown'), PLAN2_CLASSIC_ID);
  assert.equal(plan2FamilyLabel('plan2_5'), 'Plan2.5');
  assert.equal(plan2FamilyLabel('plan2'), 'Plan2');
});

test('classic profile disables enhanced gates and syncs paper entry like main', () => {
  const base = {
    historyWinRateGateEnabled: true,
    lossReasonGateEnabled: true,
    symbolWrSizingEnabled: true,
    plan2PaperRequireAskFillable: true,
    plan2PaperFillSlippageTicks: 1,
    plan2LiveSyncPaperEnabled: true,
    plan2LiveSyncPaperEntryEnabled: false,
    plan2LiveSyncPaperExitEnabled: true
  };
  const classic = resolvePlan2ProfileConfig(base, 'plan2');
  assert.equal(classic.historyWinRateGateEnabled, false);
  assert.equal(classic.lossReasonGateEnabled, false);
  assert.equal(classic.symbolWrSizingEnabled, false);
  assert.equal(classic.plan2PaperRequireAskFillable, false);
  assert.equal(classic.plan2LiveSyncPaperEntryEnabled, true);
  assert.equal(classic.plan2LiveSyncPaperExitEnabled, true);
  assert.equal(resolvePlan2PaperMode(classic, { paperMode: false }), true);
});

test('plan2_5 profile keeps enhanced gates and strict live entry', () => {
  const base = {
    historyWinRateGateEnabled: true,
    lossReasonGateEnabled: true,
    symbolWrSizingEnabled: true,
    plan2PaperRequireAskFillable: true,
    plan2PaperFillSlippageTicks: 1,
    plan2LiveSyncPaperEnabled: true,
    plan2LiveSyncPaperEntryEnabled: false,
    plan2LiveSyncPaperExitEnabled: true
  };
  const enhanced = resolvePlan2ProfileConfig(base, 'plan2_5');
  assert.equal(enhanced.historyWinRateGateEnabled, true);
  assert.equal(enhanced.lossReasonGateEnabled, true);
  assert.equal(enhanced.symbolWrSizingEnabled, true);
  assert.equal(enhanced.plan2PaperRequireAskFillable, true);
  assert.equal(enhanced.plan2LiveSyncPaperEntryEnabled, false);
  // Explicit plan2LiveSyncPaperExitEnabled=true on base still wins for plan2_5.
  assert.equal(enhanced.plan2LiveSyncPaperExitEnabled, true);
  assert.equal(resolvePlan2PaperMode(enhanced, { paperMode: false }), false);
  // Default (no exit sync flags) keeps live hard SL path open.
  const safeDefault = resolvePlan2ProfileConfig({
    historyWinRateGateEnabled: true
  }, 'plan2_5');
  assert.equal(safeDefault.plan2LiveSyncPaperExitEnabled, false);
  assert.equal(safeDefault.plan2_5LiveEntryMaxEnabled, true);
});

test('Plan2.5 live sync paper entry skips high-price delay so live can follow paper', () => {
  const synced = resolvePlan2ProfileConfig({
    plan25LiveSyncPaperEntryEnabled: true,
    plan2PaperRelaxedEnabled: false,
    plan2HighEntryMinPrice: 0.70,
    plan2HighEntryDelayMs: 10000,
    plan2HighEntryDelayMs5m: 4000,
    plan2HighEntryDelayMs15m: 10000
  }, 'plan2_5');
  const liveCfg = resolvePlan2EffectiveConfig(synced, { paperMode: false });
  assert.equal(liveCfg._plan2LiveSyncEntry, true);
  assert.equal(liveCfg.plan2HighEntryDelayMs, 0);
  const delay = resolvePlan2DelayedEntry({
    limitPrice: 0.90,
    confidence: 0.8,
    timeframe: '5m',
    config: liveCfg,
    pendingEntry: null,
    now: new Date('2099-01-01T00:00:00.000Z')
  });
  assert.equal(delay.phase, 'immediate');
});

test('Plan2.5 recovery gate keeps only the profitable live cohort', () => {
  const config = {
    _plan2Profile: 'plan2_5',
    plan25RecoveryGateEnabled: true,
    plan25RecoverySymbols: ['ETH-USD', 'SOL-USD', 'XRP-USD'],
    plan25RecoveryTimeframes: ['15m'],
    plan25RecoveryDirections: ['down'],
    plan25RecoveryEntryTypes: ['sustained_momentum'],
    plan25RecoveryMinPrice: 0.55,
    plan25RecoveryMaxPrice: 0.86,
    plan25RecoveryMinEdge: 0.02
  };
  assert.equal(evaluatePlan25RecoveryGate({
    symbol: 'XRP-USD',
    timeframe: '15m',
    direction: 'down',
    technicalDirection: 'down',
    spotDirection: 'down',
    entryType: 'sustained_momentum',
    entryPrice: 0.72,
    edge: 0.04,
    config
  }).allowed, true);
  assert.equal(evaluatePlan25RecoveryGate({
    symbol: 'BTC-USD',
    timeframe: '15m',
    direction: 'down',
    technicalDirection: 'down',
    spotDirection: 'down',
    entryType: 'sustained_momentum',
    entryPrice: 0.72,
    edge: 0.04,
    config
  }).allowed, false);
  assert.equal(evaluatePlan25RecoveryGate({
    symbol: 'SOL-USD',
    timeframe: '5m',
    direction: 'up',
    technicalDirection: 'down',
    spotDirection: 'down',
    entryType: 'late_capture',
    entryPrice: 0.90,
    edge: 0.01,
    config
  }).allowed, false);
});

test('regime guard hard-blocks abnormal spread > 20%', () => {
  const guard = buildPlan2RegimeGuard({
    directionEntry: { direction: 'up', confidence: 0.72 },
    sentiment: {
      available: true,
      spread: 0.25,
      qualityScore: 0.8,
      upProbability: 0.7,
      downProbability: 0.3,
      directionFlipCount5m: 0
    },
    signal: {
      indicators: {
        currentPrice: 100.5,
        slotStartPrice: 100,
        volatility15mPct: 0.0005
      },
      prediction: { comparisonBasePrice: 100 }
    },
    timeframe: '5m',
    config: {
      plan2RegimeFilterEnabled: true,
      plan2RegimeMaxSpread: 0.06,
      plan2RegimeSkipMainRisk: 3,
      plan2RegimeSkipAllRisk: 4,
      plan2MinMarketQuality: 0.4,
      plan2ProbeMarketQuality: 0.3,
      plan2ChopMaxDistanceBps: 4,
      plan2ChopMaxPmEdge: 0.08
    }
  });
  assert.ok(Number(guard.noTradeRisk) >= 2);
  assert.match(String(guard.reason || ''), /spread|异常/);
});

test('paper relaxed high-price tier rejects when BTC is misaligned', () => {
  const config = resolvePlan2EffectiveConfig({
    plan2PaperRelaxedEnabled: true,
    plan2EntryMinPrice: 0.35,
    plan2PaperEntryMaxPrice: 0.92,
    plan2PaperMinConfidence: 0.52,
    plan2PaperMinEdge: 0,
    plan2TakeProfitOffset: 0.18,
    plan2StopLossOffset: 0.12,
    plan2MinMarketQuality: 0.2,
    plan2PaperMinMarketQuality: 0.2
  }, { paperMode: true });

  const misaligned = resolvePlan2EntryTier({
    limitPrice: 0.86,
    confidence: 0.55,
    timeframe: '5m',
    config,
    marketQuality: 0.8,
    paperMode: true,
    sentiment: {
      available: true,
      upProbability: 0.86,
      downProbability: 0.14,
      upPrice: 0.86,
      downPrice: 0.14,
      qualityScore: 0.8,
      spread: 0.02
    },
    directionEntry: {
      direction: 'up',
      confidence: 0.55,
      distanceBps: -8,
      source: 'test'
    }
  });
  assert.notEqual(misaligned?.tier, 'paper_relaxed');
});

test('live slot loss circuit is per-symbol', async () => {
  const service = new PolymarketTradingService({
    config: {
      plan2LiveSlotLossCircuitEnabled: true,
      plan2LiveSlotLossCircuitMaxLosses: 2
    },
    stateDir: null,
    statePath: null,
    defaultStartingCash: 500
  });
  service.state.liveOrders = [
    closedLoss({ id: 'a', symbol: 'BTC-USD', slotIso: '2026-07-09T10:00:00.000Z' }),
    closedLoss({ id: 'b', symbol: 'BTC-USD', slotIso: '2026-07-09T10:00:00.000Z' }),
    closedLoss({ id: 'c', symbol: 'ETH-USD', slotIso: '2026-07-09T10:00:00.000Z' })
  ];
  const btc = service.checkPlan2LiveSlotLossCircuit({
    timeframe: '5m',
    slotIso: '2026-07-09T10:00:00.000Z',
    symbol: 'BTC-USD',
    planId: 'plan2_5'
  });
  const eth = service.checkPlan2LiveSlotLossCircuit({
    timeframe: '5m',
    slotIso: '2026-07-09T10:00:00.000Z',
    symbol: 'ETH-USD',
    planId: 'plan2_5'
  });
  assert.equal(btc.allowed, false);
  assert.equal(eth.allowed, true);
  assert.match(btc.reason, /BTC-USD|本币熔断|连续亏损/);
});

function closedLoss({ id, symbol, slotIso }) {
  return {
    id,
    planId: 'plan2_5',
    symbol,
    timeframe: '5m',
    slotIso,
    orderSide: 'BUY',
    status: 'submitted',
    positionStatus: 'closed',
    pnl: -1.5,
    closedAtIso: '2026-07-09T10:03:00.000Z',
    createdAtIso: '2026-07-09T10:01:00.000Z'
  };
}
