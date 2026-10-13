import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAN11_ID,
  PLAN11_VERSION,
  estimatePlan11WinProbability,
  computePlan11EdgeAfterFee,
  evaluatePlan11Entry,
  buildPolymarketPaperPlan11,
  assertPlan11LiveEntryPriceAllowed,
  computePlan11ExitPrices,
  buildPlan11RulesSnapshot
} from '../src/polymarketPlan11.js';
import { PLAN_IDS, PolymarketTradingService } from '../src/polymarketTrading.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function sentiment({ up = 0.72, down = 0.28, quality = 0.62 } = {}) {
  return {
    available: true,
    upPrice: up,
    downPrice: down,
    upProbability: up,
    downProbability: down,
    qualityScore: quality
  };
}

function signal({
  direction = 'up',
  start = 100,
  current = 100.08,
  timeframe = '5m',
  technicalDirection = 'up'
} = {}) {
  return {
    symbol: 'BTC-USD',
    timeframe,
    direction: technicalDirection,
    technicalDirection,
    prediction: {
      comparisonBasePrice: start,
      estimatedClose: current,
      targetTimeIso: '2026-08-26T02:05:00.000Z'
    },
    indicators: {
      currentPrice: current,
      slotStartPrice: start
    },
    schedule: {
      slotMinutes: timeframe === '5m' ? 5 : 15,
      currentSlotIso: '2026-08-26T02:00:00.000Z',
      nextSlotIso: '2026-08-26T02:05:00.000Z',
      secondsToNext: timeframe === '5m' ? 210 : 630
    }
  };
}

test('PLAN_IDS includes plan11 after plan2_6', () => {
  assert.ok(PLAN_IDS.includes(PLAN11_ID));
  assert.equal(PLAN_IDS.indexOf(PLAN11_ID), PLAN_IDS.indexOf('plan2_6') + 1);
});

test('p-hat rises with PM gap and spot confirmation, 15m tech adds a small boost', () => {
  const weak = estimatePlan11WinProbability({ gap: 0.28, spotAgreed: true, timeframe: '5m' });
  const strong = estimatePlan11WinProbability({ gap: 0.60, spotAgreed: true, timeframe: '5m' });
  const noSpot = estimatePlan11WinProbability({ gap: 0.60, spotAgreed: false, timeframe: '5m' });
  const withTech = estimatePlan11WinProbability({
    gap: 0.40,
    spotAgreed: true,
    techAgreed: true,
    timeframe: '15m'
  });
  const noTech = estimatePlan11WinProbability({
    gap: 0.40,
    spotAgreed: true,
    techAgreed: false,
    timeframe: '15m'
  });
  assert.ok(strong > weak);
  assert.ok(strong > noSpot);
  assert.ok(withTech > noTech);
  assert.ok(strong <= 0.88);
  assert.ok(weak >= 0.52);
});

test('fee-aware edge is positive in the historical momentum band and negative at 96c', () => {
  const momentum = computePlan11EdgeAfterFee({ pHat: 0.84, entryPrice: 0.80 });
  const settlementFavorite = computePlan11EdgeAfterFee({ pHat: 0.88, entryPrice: 0.96 });
  assert.ok(momentum > 0.02, `momentum edge ${momentum}`);
  assert.ok(settlementFavorite < 0, `96c edge ${settlementFavorite}`);
});

test('Plan11 takes 5m PM favorite when Binance spot agrees and edge clears the fee hurdle', () => {
  const decision = evaluatePlan11Entry({
    signal: signal({ current: 100.08 }),
    sentiment: sentiment({ up: 0.74, down: 0.26 }),
    timeframe: '5m',
    elapsedPct: 0.30
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.pm.direction, 'up');
  assert.ok(decision.edge >= 0.012);
});

test('Plan11 5m does not require technical EMA/RSI agreement', () => {
  const decision = evaluatePlan11Entry({
    signal: signal({ current: 100.08, technicalDirection: 'down' }),
    sentiment: sentiment({ up: 0.74, down: 0.26 }),
    timeframe: '5m',
    elapsedPct: 0.30
  });
  assert.equal(decision.allowed, true);
});

test('Plan11 15m is disabled', () => {
  const decision = evaluatePlan11Entry({
    signal: signal({ current: 100.12, technicalDirection: 'up', timeframe: '15m' }),
    sentiment: sentiment({ up: 0.74, down: 0.26 }),
    timeframe: '15m',
    elapsedPct: 0.30
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /只跑 5m/);
});

test('Plan11 skips cheap-side lottery and 96c settlement favorites', () => {
  const cheap = evaluatePlan11Entry({
    signal: signal({ current: 100.08 }),
    sentiment: sentiment({ up: 0.55, down: 0.45 }),
    timeframe: '5m',
    elapsedPct: 0.30,
    config: { plan11MinGap: 0.02 }
  });
  const rich = evaluatePlan11Entry({
    signal: signal({ current: 100.2 }),
    sentiment: sentiment({ up: 0.96, down: 0.04 }),
    timeframe: '5m',
    elapsedPct: 0.30
  });
  assert.equal(cheap.allowed, false);
  assert.match(cheap.reason, /廉价侧/);
  assert.equal(rich.allowed, false);
  assert.match(rich.reason, /热门/);
});

test('Plan11 skips when spot disagrees with PM', () => {
  const decision = evaluatePlan11Entry({
    signal: signal({ current: 99.9 }),
    sentiment: sentiment({ up: 0.74, down: 0.26 }),
    timeframe: '5m',
    elapsedPct: 0.30
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /冲突/);
});

test('Plan11 skips early window and late chase', () => {
  const early = evaluatePlan11Entry({
    signal: signal(),
    sentiment: sentiment(),
    timeframe: '5m',
    elapsedPct: 0.05
  });
  const late = evaluatePlan11Entry({
    signal: signal(),
    sentiment: sentiment(),
    timeframe: '5m',
    elapsedPct: 0.80
  });
  assert.equal(early.allowed, false);
  assert.equal(late.allowed, false);
});

test('builder sizes a paper order and holds to settlement by default', () => {
  const plan = buildPolymarketPaperPlan11({
    signal: signal({ current: 100.08 }),
    sentiment: sentiment({ up: 0.74, down: 0.26 }),
    timeframe: '5m',
    portfolio: { portfolioInitialized: true, cash: 500, startingCash: 500 },
    paperMode: true,
    now: new Date('2026-08-26T02:01:30.000Z')
  });
  assert.equal(plan.planId, PLAN11_ID);
  assert.equal(plan.strategyVersion, PLAN11_VERSION);
  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.entryType, 'pm_spot_edge');
  assert.equal(plan.action.takeProfitPrice, null);
  assert.equal(plan.action.holdToSettlement, true);
  assert.equal(plan.action.stopLossPrice, null);
  assert.ok(plan.action.usd >= 1);
  assert.equal(plan.exitRule.liveStopLossOnly, false);
  assert.equal(plan.exitRule.holdToSettlement, true);
});

test('live paperMode uses the $5 live floor and $5 cap', () => {
  const plan = buildPolymarketPaperPlan11({
    signal: signal({ current: 100.08 }),
    sentiment: sentiment({ up: 0.74, down: 0.26 }),
    timeframe: '5m',
    portfolio: { portfolioInitialized: true, cash: 80, startingCash: 80 },
    paperMode: false,
    config: { plan11LiveOrderPct: 0.05, plan11LiveMinOrderUsd: 5, plan11LiveMaxOrderUsd: 5 },
    now: new Date('2026-08-26T02:01:30.000Z')
  });
  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.holdToSettlement, true);
  assert.equal(plan.action.usd, 5);
});

test('live entry price assert rejects the Plan3 96c band', () => {
  assert.equal(assertPlan11LiveEntryPriceAllowed(0.74, {}), 0.74);
  assert.throws(() => assertPlan11LiveEntryPriceAllowed(0.80, {}), /上限/);
  assert.throws(() => assertPlan11LiveEntryPriceAllowed(0.96, {}), /上限/);
  assert.throws(() => assertPlan11LiveEntryPriceAllowed(0.40, {}), /下限/);
  assert.throws(() => assertPlan11LiveEntryPriceAllowed(0.65, {}), /下限/);
});

test('exit prices stay empty unless stop-loss is explicitly enabled', () => {
  const off = computePlan11ExitPrices(0.74, { plan11StopLossOffset: 0.10, stopLossAbsoluteFloor: 0.50 });
  assert.equal(off.takeProfitPrice, null);
  assert.equal(off.stopLossPrice, null);
  const on = computePlan11ExitPrices(0.74, {
    plan11StopLossEnabled: true,
    plan11StopLossOffset: 0.10,
    stopLossAbsoluteFloor: 0.50
  });
  assert.equal(on.takeProfitPrice, null);
  assert.equal(on.stopLossPrice, 0.64);
  const rules = buildPlan11RulesSnapshot({});
  assert.equal(rules.paperHoldToSettlement, true);
  assert.equal(rules.liveStopLossOnly, false);
  assert.equal(rules.stopLossEnabled, false);
});

test('Plan11 live stays off unless LIVE_ENABLED', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan11-live-'));
  try {
    const service = new PolymarketTradingService({
      config: {
        plan11Enabled: true,
        plan11LiveEnabled: false
      },
      statePath: join(root, 'state.json')
    });
    assert.deepEqual(
      service.resolveLiveAutoEnabledPlans({ enabledPlans: ['plan1', 'plan11'] }),
      ['plan1']
    );
    await assert.rejects(
      () => service.setLiveAutoPlan('plan11', true),
      /POLYMARKET_PLAN11_LIVE_ENABLED=true/
    );
    const rules = buildPlan11RulesSnapshot(service.config);
    assert.equal(rules.liveStopLossOnly, false);
    assert.equal(rules.paperHoldToSettlement, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Plan11 live can join enabledPlans when LIVE_ENABLED', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan11-live-on-'));
  try {
    const service = new PolymarketTradingService({
      config: {
        plan11Enabled: true,
        plan11LiveEnabled: true
      },
      statePath: join(root, 'state.json')
    });
    assert.deepEqual(
      service.resolveLiveAutoEnabledPlans({ enabledPlans: ['plan1', 'plan11'] }),
      ['plan1', 'plan11']
    );
    const started = await service.setLiveAutoPlan('plan11', true, {
      timeframes: ['5m', '15m'],
      symbols: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD']
    });
    assert.ok(started.enabledPlans.includes('plan11'));
    assert.deepEqual(started.timeframes, ['5m', '15m']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Plan11 paper hard SL closes when price hits stop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan11-paper-sl-'));
  try {
    const service = new PolymarketTradingService({
      config: {
        plan11StopLossEnabled: true,
        plan11StopLossOffset: 0.10,
        defaultOrderUsd: 5,
        maxOrderUsd: 500
      },
      statePath: join(root, 'state.json')
    });
    await service.configurePortfolio({ cash: 500, planId: 'plan11' });
    await service.createPaperOrder({
      symbol: 'BTC-USD',
      direction: 'up',
      usd: 5,
      planId: 'plan11',
      sentiment: {
        available: true,
        timeframe: '5m',
        upTokenId: 'p11-up',
        downTokenId: 'p11-down',
        upPrice: 0.74,
        downPrice: 0.26,
        targetTimeIso: '2099-01-01T00:05:00.000Z',
        schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
      },
      plan: {
        planId: 'plan11',
        stopLossPrice: 0.64,
        slotIso: '2099-01-01T00:00:00.000Z',
        timeframe: '5m'
      }
    }, 'plan11');
    const held = await service.processPlan11PaperExits(async () => 0.70);
    assert.equal(held.length, 0);
    const closed = await service.processPlan11PaperExits(async () => 0.60);
    assert.equal(closed.length, 1);
    assert.equal(closed[0].exitStatus, 'stop-loss');
    assert.equal(closed[0].settlementStatus, 'settled');
    assert.ok(closed[0].pnl < 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Plan11 paper holds through a dip when hard SL is off', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan11-paper-hold-'));
  try {
    const service = new PolymarketTradingService({
      config: { plan11StopLossOffset: 0.10, defaultOrderUsd: 5, maxOrderUsd: 500 },
      statePath: join(root, 'state.json')
    });
    await service.configurePortfolio({ cash: 500, planId: 'plan11' });
    await service.createPaperOrder({
      symbol: 'BTC-USD',
      direction: 'up',
      usd: 5,
      planId: 'plan11',
      sentiment: {
        available: true,
        timeframe: '5m',
        upTokenId: 'p11-up',
        downTokenId: 'p11-down',
        upPrice: 0.74,
        downPrice: 0.26,
        targetTimeIso: '2099-01-01T00:05:00.000Z',
        schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
      },
      plan: {
        planId: 'plan11',
        stopLossPrice: 0.64,
        slotIso: '2099-01-01T00:00:00.000Z',
        timeframe: '5m'
      }
    }, 'plan11');
    const closed = await service.processPlan11PaperExits(async () => 0.40);
    assert.equal(closed.length, 0);
    assert.equal(service.evaluateLiveExitTrigger({
      planId: 'plan11',
      entryPrice: 0.74,
      stopLossPrice: 0.64,
      limitPrice: 0.74
    }, 0.40), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Plan11 live draft can open a third coin when paper would', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan11-live-multi-'));
  try {
    const service = new PolymarketTradingService({
      config: {
        liveTradingEnabled: true,
        liveMaxOrderUsd: 500,
        maxOrderEquityPct: 0.08,
        maxTotalOpenExposurePct: 0.25,
        maxTimeframeOpenExposurePct: 0.12,
        minOrderUsd: 5,
        plan11LiveMinOrderUsd: 5,
        plan11MaxOpenLivePositions: 4,
        plan11ApplyLossStreakRecovery: false,
        streakSizingEnabled: false
      },
      statePath: join(root, 'state.json')
    });
    await service.load();
    const far = '2099-01-01T00:05:00.000Z';
    service.state.liveOrders = [
      {
        id: 'p11-btc',
        planId: 'plan11',
        orderSide: 'BUY',
        positionStatus: 'open',
        status: 'submitted',
        usd: 5,
        timeframe: '5m',
        symbol: 'BTC-USD',
        targetTimeIso: far,
        slotIso: '2099-01-01T00:00:00.000Z'
      },
      {
        id: 'p11-eth',
        planId: 'plan11',
        orderSide: 'BUY',
        positionStatus: 'open',
        status: 'submitted',
        usd: 5,
        timeframe: '5m',
        symbol: 'ETH-USD',
        targetTimeIso: far,
        slotIso: '2099-01-01T00:00:00.000Z'
      }
    ];
    const draft = service.buildLiveOrderDraft({
      plan: {
        action: { shouldTrade: true, direction: 'up', usd: 5, confidence: 0.7, edge: 0.04 },
        timeframe: '5m',
        slotIso: '2099-01-01T00:00:00.000Z',
        symbol: 'SOL-USD'
      },
      sentiment: {
        available: true,
        timeframe: '5m',
        symbol: 'SOL-USD',
        upTokenId: 'up-token',
        downTokenId: 'down-token',
        upPrice: 0.72,
        downPrice: 0.28
      },
      planId: 'plan11',
      clobBalanceUsdc: 50
    });
    assert.ok(draft.usd >= 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
