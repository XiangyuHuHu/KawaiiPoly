import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PLAN3_LOSS_REASONS,
  applyPlan3SettlementLossAnalysis,
  classifyPlan3LossReason,
  computePlan3LossAnalytics,
  detectPmReversal,
  listPlan3Losses
} from '../src/polymarketPlan3LossAnalytics.js';

test('detectPmReversal finds extreme side flip within lookback', () => {
  const base = Date.parse('2026-07-09T02:20:00.000Z');
  const samples = [
    { ts: base, upPrice: 0.99, downPrice: 0.01 },
    { ts: base + 60_000, upPrice: 0.80, downPrice: 0.20 },
    { ts: base + 120_000, upPrice: 0.05, downPrice: 0.95 }
  ];
  const result = detectPmReversal(samples, {
    lookbackMs: 5 * 60 * 1000,
    extremePrice: 0.95,
    asOfMs: base + 120_000
  });
  assert.equal(result.detected, true);
  assert.equal(result.flipped, true);
  assert.equal(result.fromSide, 'up');
  assert.equal(result.toSide, 'down');
  assert.ok(result.magnitude >= 1.9);
});

test('detectPmReversal ignores non-extreme oscillation', () => {
  const base = Date.now() - 60_000;
  const samples = [
    { ts: base, upPrice: 0.60, downPrice: 0.40 },
    { ts: base + 20_000, upPrice: 0.45, downPrice: 0.55 },
    { ts: base + 40_000, upPrice: 0.70, downPrice: 0.30 }
  ];
  const result = detectPmReversal(samples, { asOfMs: base + 40_000, extremePrice: 0.95 });
  assert.equal(result.flipped, false);
  assert.equal(result.detected, false);
});

test('classifyPlan3LossReason marks flip_into_entry when chasing post-flip side', () => {
  const entryMs = Date.parse('2026-07-09T02:24:32.000Z');
  const samples = [
    { ts: entryMs - 120_000, upPrice: 0.96, downPrice: 0.04 },
    { ts: entryMs - 90_000, upPrice: 0.64, downPrice: 0.35 },
    { ts: entryMs - 40_000, upPrice: 0.07, downPrice: 0.92 },
    { ts: entryMs - 10_000, upPrice: 0.05, downPrice: 0.96 },
    { ts: entryMs, upPrice: 0.06, downPrice: 0.93 },
    { ts: entryMs + 20_000, upPrice: 0.88, downPrice: 0.03 }
  ];
  const classified = classifyPlan3LossReason({
    planId: 'plan3',
    direction: 'down',
    actualDirection: 'up',
    entryPrice: 0.93,
    limitPrice: 0.93,
    pnl: -50,
    won: false,
    createdAtIso: new Date(entryMs).toISOString(),
    filledAtIso: new Date(entryMs).toISOString(),
    settledAtIso: new Date(entryMs + 30_000).toISOString(),
    secondsRemaining: 29
  }, { samples, extremePrice: 0.95 });

  assert.equal(classified.isLoss, true);
  assert.equal(classified.lossReason, PLAN3_LOSS_REASONS.FLIP_INTO_ENTRY);
  assert.equal(classified.pmReversal.anyLargeReversal, true);
  assert.ok(classified.tags.includes(PLAN3_LOSS_REASONS.DIRECTION_WRONG));
});

test('classifyPlan3LossReason marks post_entry_pm_reversal', () => {
  const entryMs = Date.parse('2026-07-09T01:00:00.000Z');
  const samples = [
    { ts: entryMs - 30_000, upPrice: 0.96, downPrice: 0.04 },
    { ts: entryMs, upPrice: 0.97, downPrice: 0.03 },
    { ts: entryMs + 40_000, upPrice: 0.04, downPrice: 0.96 }
  ];
  const classified = classifyPlan3LossReason({
    planId: 'plan3',
    direction: 'up',
    actualDirection: 'down',
    entryPrice: 0.97,
    pnl: -60,
    won: false,
    createdAtIso: new Date(entryMs).toISOString(),
    filledAtIso: new Date(entryMs).toISOString(),
    settledAtIso: new Date(entryMs + 60_000).toISOString()
  }, { samples });

  assert.equal(classified.lossReason, PLAN3_LOSS_REASONS.POST_ENTRY_PM_REVERSAL);
  assert.equal(classified.pmReversal.postEntry.flipped, true);
});

test('classifyPlan3LossReason tags fak_fill_worse and high entry', () => {
  const classified = classifyPlan3LossReason({
    planId: 'plan3',
    direction: 'up',
    actualDirection: 'down',
    entryPrice: 0.99,
    fillPrice: 0.99,
    intendedLimitPrice: 0.96,
    limitPrice: 0.96,
    pnl: -40,
    won: false,
    secondsRemaining: 8,
    createdAtIso: new Date().toISOString()
  }, { samples: [] });

  assert.equal(classified.isLoss, true);
  assert.ok(classified.tags.includes(PLAN3_LOSS_REASONS.FAK_FILL_WORSE));
  assert.ok(classified.tags.includes(PLAN3_LOSS_REASONS.HIGH_ENTRY_NEGATIVE_EV));
  assert.ok(classified.tags.includes(PLAN3_LOSS_REASONS.LATE_ENTRY_EXPENSIVE));
});

test('applyPlan3SettlementLossAnalysis persists fields on order', () => {
  const order = {
    planId: 'plan3',
    entryType: 'settlement_capture',
    direction: 'down',
    actualDirection: 'up',
    entryPrice: 0.99,
    limitPrice: 0.99,
    pnl: -50,
    won: false,
    slotIso: '2026-07-09T02:20:00.000Z',
    timeframe: '5m',
    createdAtIso: '2026-07-09T02:24:55.000Z',
    filledAtIso: '2026-07-09T02:24:55.000Z',
    settledAtIso: '2026-07-09T02:25:16.000Z',
    secondsRemaining: 5,
    distanceFromOpenBps: 12,
    recentReverseBps: 0.5,
    volatilityBpsPerSecond: 0.2,
    strategyVersion: 'plan3_confirm_v2',
    entryConfirmation: { stableMs: 8000, stableSamples: 6 }
  };
  const ok = applyPlan3SettlementLossAnalysis(order, {
    opportunityLog: [
      {
        slotIso: order.slotIso,
        timeframe: '5m',
        recordedAtIso: '2026-07-09T02:23:14.000Z',
        pmUpPrice: 0.36,
        pmDownPrice: 0.63,
        direction: 'up'
      },
      {
        slotIso: order.slotIso,
        timeframe: '5m',
        recordedAtIso: '2026-07-09T02:24:20.000Z',
        pmUpPrice: 0.07,
        pmDownPrice: 0.92,
        direction: 'down',
        tokenPrice: 0.92
      },
      {
        slotIso: order.slotIso,
        timeframe: '5m',
        recordedAtIso: '2026-07-09T02:24:55.000Z',
        direction: 'down',
        tokenPrice: 0.99
      },
      {
        slotIso: order.slotIso,
        timeframe: '5m',
        recordedAtIso: '2026-07-09T02:24:57.000Z',
        pmUpPrice: 0.88,
        pmDownPrice: 0.03,
        direction: 'up'
      }
    ]
  });
  assert.equal(ok, true);
  assert.ok(order.lossAnalysis);
  assert.equal(typeof order.lossReason, 'string');
  assert.equal(typeof order.pmReversal, 'boolean');
  assert.equal(order.lossAnalysis.isLoss, true);
  assert.equal(order.lossAnalysis.strategyVersion, 'plan3_confirm_v2');
  assert.equal(order.lossAnalysis.entryConfirmation.stableMs, 8000);
  assert.equal(order.lossAnalysis.distanceFromOpenBps, 12);
});

test('computePlan3LossAnalytics aggregates reason counts', () => {
  const orders = [
    {
      id: 'a',
      planId: 'plan3',
      settlementStatus: 'settled',
      direction: 'up',
      actualDirection: 'down',
      entryPrice: 0.98,
      pnl: -10,
      won: false,
      settledAtIso: '2026-07-09T01:00:00.000Z',
      createdAtIso: '2026-07-09T00:59:00.000Z'
    },
    {
      id: 'b',
      planId: 'plan3',
      settlementStatus: 'settled',
      direction: 'down',
      actualDirection: 'down',
      entryPrice: 0.95,
      pnl: 2,
      won: true,
      settledAtIso: '2026-07-09T02:00:00.000Z',
      createdAtIso: '2026-07-09T01:59:00.000Z'
    }
  ];
  const analytics = computePlan3LossAnalytics(orders, { backfill: true });
  assert.equal(analytics.settledOrders, 2);
  assert.equal(analytics.losses, 1);
  assert.equal(analytics.wins, 1);
  assert.ok(Object.keys(analytics.reasonCounts).length >= 1);
  const listed = listPlan3Losses(orders, { limit: 5 });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, 'a');
});
