import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collapseSettledOrdersByWindow,
  computeSettledStreaks,
  computeStreakSizingScale,
  isStreakSizingEnabled,
  resolveEntrySizeScale,
  resolveStreakSizingConfig
} from '../src/streakSizing.js';
import { PolymarketTradingService } from '../src/polymarketTrading.js';

const defaultStreakConfig = {
  streakSizingEnabled: true,
  streakSizingWinStepPct: 0.12,
  streakSizingWinMaxLevels: 4,
  streakSizingWinCap: 1.5,
  streakSizingLossStepPct: 0.22,
  streakSizingLossMaxLevels: 4,
  streakSizingLossFloor: 0.4,
  streakSizingBelowMinMode: 'clamp'
};

test('computeSettledStreaks counts wins and losses; skips zero pnl', () => {
  const wins = computeSettledStreaks([
    { pnl: 1 }, { pnl: 2 }, { pnl: 0 }, { pnl: 3 }, { pnl: -1 }
  ]);
  assert.equal(wins.winStreak, 3);
  assert.equal(wins.lossStreak, 0);

  const losses = computeSettledStreaks([
    { pnl: -1 }, { pnl: 0 }, { pnl: -2 }, { pnl: 5 }
  ]);
  assert.equal(losses.lossStreak, 2);
  assert.equal(losses.winStreak, 0);
});

test('Plan5 basket outcomes count once per window for win/loss streaks', () => {
  const collapsed = collapseSettledOrdersByWindow([
    { id: 'btc-new', timeframe: '5m', slotIso: '2026-01-01T00:05:00.000Z', symbol: 'BTC-USD', pnl: -4, usd: 6, settledAtIso: '2026-01-01T00:10:02.000Z' },
    { id: 'eth-new', timeframe: '5m', slotIso: '2026-01-01T00:05:00.000Z', symbol: 'ETH-USD', pnl: 1, usd: 4, settledAtIso: '2026-01-01T00:10:01.000Z' },
    { id: 'btc-old', timeframe: '5m', slotIso: '2026-01-01T00:00:00.000Z', symbol: 'BTC-USD', pnl: -2, usd: 7, settledAtIso: '2026-01-01T00:05:02.000Z' },
    { id: 'sol-old', timeframe: '5m', slotIso: '2026-01-01T00:00:00.000Z', symbol: 'SOL-USD', pnl: -1, usd: 3, settledAtIso: '2026-01-01T00:05:01.000Z' },
    { id: 'prior-win', timeframe: '5m', slotIso: '2025-12-31T23:55:00.000Z', symbol: 'BTC-USD', pnl: 2, usd: 5, settledAtIso: '2026-01-01T00:00:01.000Z' }
  ]);
  assert.equal(collapsed.length, 3);
  assert.equal(collapsed[0].pnl, -3);
  assert.equal(collapsed[0].usd, 10);
  assert.equal(collapsed[0].basketOrderCount, 2);
  const streak = computeSettledStreaks(collapsed);
  assert.equal(streak.lossStreak, 2);
  assert.equal(streak.winStreak, 0);
});

test('computeStreakSizingScale amplifies wins and shrinks losses with caps/floors', () => {
  const win1 = computeStreakSizingScale({ winStreak: 1, lossStreak: 0, config: defaultStreakConfig });
  assert.equal(win1.mode, 'win');
  assert.ok(Math.abs(win1.scale - 1.12) < 1e-9);

  const win4 = computeStreakSizingScale({ winStreak: 4, lossStreak: 0, config: defaultStreakConfig });
  assert.equal(win4.scale, 1.5); // 1.12^4≈1.57 capped

  const win10 = computeStreakSizingScale({ winStreak: 10, lossStreak: 0, config: defaultStreakConfig });
  assert.equal(win10.levels, 4);
  assert.equal(win10.scale, 1.5);

  const loss1 = computeStreakSizingScale({ winStreak: 0, lossStreak: 1, config: defaultStreakConfig });
  assert.ok(Math.abs(loss1.scale - 0.78) < 1e-9);

  const loss4 = computeStreakSizingScale({ winStreak: 0, lossStreak: 4, config: defaultStreakConfig });
  assert.equal(loss4.scale, 0.4); // 0.78^4≈0.37 floored

  const loss10 = computeStreakSizingScale({ winStreak: 0, lossStreak: 10, config: defaultStreakConfig });
  assert.equal(loss10.levels, 4);
  assert.equal(loss10.scale, 0.4);
});

test('plan override can disable streak sizing while global stays on', () => {
  const cfg = {
    ...defaultStreakConfig,
    plan3StreakSizingEnabled: 'false',
    plan2StreakSizingEnabled: 'true'
  };
  assert.equal(isStreakSizingEnabled(cfg, 'plan3'), false);
  assert.equal(isStreakSizingEnabled(cfg, 'plan2'), true);
  assert.equal(resolveStreakSizingConfig(cfg, 'plan4').enabled, true);
});

test('resolveEntrySizeScale keeps loss cooldown block and recovery cap', () => {
  const cooled = resolveEntrySizeScale({
    planId: 'plan2',
    config: defaultStreakConfig,
    winStreak: 0,
    lossStreak: 5,
    lossStreakScale: 0,
    lossRecoveryMode: 'cooldown',
    appliesGlobalLossRecovery: true
  });
  assert.equal(cooled.blocked, true);
  assert.equal(cooled.sizeScale, 0);

  const recovering = resolveEntrySizeScale({
    planId: 'plan2',
    config: defaultStreakConfig,
    winStreak: 0,
    lossStreak: 5,
    lossStreakScale: 0.25,
    lossRecoveryMode: 'recovery',
    appliesGlobalLossRecovery: true
  });
  // streak floor 0.4, but recovery cap 0.25 wins
  assert.equal(recovering.blocked, false);
  assert.equal(recovering.sizeScale, 0.25);

  const winDuringNormal = resolveEntrySizeScale({
    planId: 'plan2',
    config: defaultStreakConfig,
    winStreak: 2,
    lossStreak: 0,
    lossStreakScale: 1,
    lossRecoveryMode: 'normal',
    appliesGlobalLossRecovery: true
  });
  assert.ok(Math.abs(winDuringNormal.sizeScale - (1.12 ** 2)) < 1e-6);
});

test('resolveEntrySizeScale falls back to legacy lossStreakScale when streak off', () => {
  const legacy = resolveEntrySizeScale({
    planId: 'plan2',
    config: { ...defaultStreakConfig, streakSizingEnabled: false },
    winStreak: 0,
    lossStreak: 2,
    lossStreakScale: 0.7,
    lossRecoveryMode: 'reduced',
    appliesGlobalLossRecovery: true
  });
  assert.equal(legacy.sizeScale, 0.7);
});

function liveSentiment() {
  return {
    available: true,
    timeframe: '5m',
    upTokenId: 'up-token',
    downTokenId: 'down-token',
    upPrice: 0.5,
    downPrice: 0.5
  };
}

test('buildLiveOrderDraft win streak amplifies next order size', async () => {
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      liveMaxOrderUsd: 500,
      maxOrderEquityPct: 0.5,
      maxTotalOpenExposurePct: 1,
      maxTimeframeOpenExposurePct: 1,
      minOrderUsd: 1,
      liveMinSharesBuffer: 5,
      ...defaultStreakConfig,
      // 关闭严重连亏闸门干扰
      plan1ApplyLossStreakRecovery: false
    },
    statePath: 'data/test-streak-sizing-win-live.json'
  });
  await service.load();
  service.state.liveOrders = [
    { id: 'w2', planId: 'plan2', orderSide: 'BUY', positionStatus: 'closed', status: 'submitted', closedAtIso: '2026-01-01T00:02:00.000Z', pnl: 2 },
    { id: 'w1', planId: 'plan2', orderSide: 'BUY', positionStatus: 'closed', status: 'submitted', closedAtIso: '2026-01-01T00:01:00.000Z', pnl: 1 }
  ];

  const risk = service.liveLossRiskSnapshot(Date.parse('2026-01-01T00:10:00.000Z'), 'plan2');
  assert.equal(risk.winStreak, 2);
  assert.ok(Math.abs(risk.streakSizingScale - (1.12 ** 2)) < 1e-6);

  const draft = service.buildLiveOrderDraft({
    plan: {
      action: { shouldTrade: true, direction: 'up', usd: 10, confidence: 0.7, edge: 0.1 },
      timeframe: '5m',
      slotIso: '2026-01-01T00:00:00.000Z'
    },
    sentiment: liveSentiment(),
    planId: 'plan2',
    clobBalanceUsdc: 200
  });
  assert.ok(Math.abs(draft.usd - round2(10 * (1.12 ** 2))) < 0.02);
  assert.equal(draft.liveRisk.winStreak, 2);
  assert.equal(draft.liveRisk.streakSizingMode, 'win');
});

test('buildLiveOrderDraft loss streak shrinks next order size', async () => {
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      liveMaxOrderUsd: 500,
      maxOrderEquityPct: 0.5,
      maxTotalOpenExposurePct: 1,
      maxTimeframeOpenExposurePct: 1,
      minOrderUsd: 1,
      liveMinSharesBuffer: 5,
      ...defaultStreakConfig,
      plan5ApplyLossStreakScale: false
    },
    statePath: 'data/test-streak-sizing-loss-live.json'
  });
  await service.load();
  service.state.liveOrders = [
    { id: 'l2', planId: 'plan5', orderSide: 'BUY', positionStatus: 'closed', status: 'submitted', closedAtIso: '2026-01-01T00:02:00.000Z', pnl: -2 },
    { id: 'l1', planId: 'plan5', orderSide: 'BUY', positionStatus: 'closed', status: 'submitted', closedAtIso: '2026-01-01T00:01:00.000Z', pnl: -1 }
  ];

  const draft = service.buildLiveOrderDraft({
    plan: {
      action: { shouldTrade: true, direction: 'up', usd: 10, confidence: 0.7, edge: 0.1, cashPct: 0.15 },
      timeframe: '5m',
      slotIso: '2026-01-01T00:00:00.000Z'
    },
    sentiment: liveSentiment(),
    planId: 'plan5',
    clobBalanceUsdc: 200
  });
  const expected = 10 * (0.78 ** 2);
  assert.ok(Math.abs(draft.usd - round2(expected)) < 0.05);
  assert.equal(draft.liveRisk.lossStreak, 2);
  assert.equal(draft.liveRisk.streakSizingMode, 'loss');
});

test('buildLiveOrderDraft streak floor clamps to min order; skip mode throws', async () => {
  const baseConfig = {
    liveTradingEnabled: true,
    liveMaxOrderUsd: 500,
    maxOrderEquityPct: 0.5,
    maxTotalOpenExposurePct: 1,
    maxTimeframeOpenExposurePct: 1,
    minOrderUsd: 5,
    plan2LiveMinOrderUsd5m: 5,
    liveMinSharesBuffer: 5,
    ...defaultStreakConfig,
    streakSizingLossFloor: 0.4,
    plan1ApplyLossStreakRecovery: true
  };

  const clampService = new PolymarketTradingService({
    config: { ...baseConfig, streakSizingBelowMinMode: 'clamp' },
    statePath: 'data/test-streak-sizing-clamp.json'
  });
  await clampService.load();
  clampService.state.liveOrders = Array.from({ length: 4 }, (_, i) => ({
    id: `loss-${i}`,
    planId: 'plan2',
    orderSide: 'BUY',
    positionStatus: 'closed',
    status: 'submitted',
    closedAtIso: `2026-01-01T00:0${i}:00.000Z`,
    pnl: -1
  }));
  const clamped = clampService.buildLiveOrderDraft({
    plan: {
      action: { shouldTrade: true, direction: 'up', usd: 8, confidence: 0.8, edge: 0.12 },
      timeframe: '5m',
      slotIso: '2026-01-01T01:00:00.000Z'
    },
    sentiment: liveSentiment(),
    planId: 'plan2',
    clobBalanceUsdc: 100
  });
  // 8 * 0.4 = 3.2；Plan2 入场底是 CLOB 5 份物理最小，不再抬到自设 $5。
  assert.equal(clamped.usd, 3.2);

  const skipService = new PolymarketTradingService({
    config: { ...baseConfig, streakSizingBelowMinMode: 'skip' },
    statePath: 'data/test-streak-sizing-skip.json'
  });
  await skipService.load();
  skipService.state.liveOrders = clampService.state.liveOrders;
  // 4 × 0.4 = 1.6 < CLOB 5 份物理底 $2.50 → skip
  assert.throws(() => skipService.buildLiveOrderDraft({
    plan: {
      action: { shouldTrade: true, direction: 'up', usd: 4, confidence: 0.8, edge: 0.12 },
      timeframe: '5m',
      slotIso: '2026-01-01T01:00:00.000Z'
    },
    sentiment: liveSentiment(),
    planId: 'plan2',
    clobBalanceUsdc: 100
  }), /低于 CLOB 最小/);
});

test('buildLiveOrderDraft does not bypass daily loss protection', async () => {
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      liveMaxOrderUsd: 500,
      maxOrderEquityPct: 0.5,
      maxTotalOpenExposurePct: 1,
      maxTimeframeOpenExposurePct: 1,
      minOrderUsd: 1,
      dailyMaxLossUsd: 5,
      globalDailyLossLimitPct: 0.01,
      ...defaultStreakConfig
    },
    statePath: 'data/test-streak-sizing-daily-loss.json'
  });
  await service.load();
  service.state.liveAuto = {
    ...(service.state.liveAuto || {}),
    riskControls: { globalDailyLossProtectionEnabled: true }
  };
  const todayIso = new Date().toISOString();
  service.state.liveOrders = [
    {
      id: 'day-loss',
      planId: 'plan2',
      orderSide: 'BUY',
      positionStatus: 'closed',
      status: 'submitted',
      closedAtIso: todayIso,
      settledAtIso: todayIso,
      createdAtIso: todayIso,
      pnl: -10
    }
  ];
  assert.throws(() => service.buildLiveOrderDraft({
    plan: {
      action: { shouldTrade: true, direction: 'up', usd: 10, confidence: 0.9, edge: 0.2 },
      timeframe: '5m',
      slotIso: '2026-01-01T00:00:00.000Z'
    },
    sentiment: liveSentiment(),
    planId: 'plan2',
    clobBalanceUsdc: 100
  }), /日亏损保护/);
});

test('paper buildOrderDraft applies plan-local streak scale', async () => {
  const service = new PolymarketTradingService({
    config: {
      defaultOrderUsd: 10,
      maxOrderUsd: 500,
      minOrderUsd: 1,
      ...defaultStreakConfig
    },
    statePath: 'data/test-streak-sizing-paper.json',
    defaultStartingCash: 500
  });
  await service.load();
  const bucket = service.getBucket('plan3');
  bucket.portfolio = { cash: 500, portfolioInitialized: true };
  bucket.paperOrders = [
    {
      id: 'p-w1',
      orderSide: 'BUY',
      settlementStatus: 'settled',
      settledAtIso: '2026-01-01T00:02:00.000Z',
      pnl: 1.5
    },
    {
      id: 'p-w0',
      orderSide: 'BUY',
      settlementStatus: 'settled',
      settledAtIso: '2026-01-01T00:01:00.000Z',
      pnl: 1
    }
  ];

  const draft = service.buildOrderDraft({
    symbol: 'BTC-USD',
    direction: 'up',
    usd: 10,
    planId: 'plan3',
    sentiment: liveSentiment()
  });
  assert.ok(Math.abs(draft.usd - round2(10 * (1.12 ** 2))) < 0.02);
  assert.equal(draft.winStreak, 2);
  assert.equal(draft.streakSizingMode, 'win');
});

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}
