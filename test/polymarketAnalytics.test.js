import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPolymarketAnalyticsDashboard,
  filterAnalyticsOrders,
  summarizePaperLiveParity,
  summarizeProfitability,
  summarizeExits,
  summarizeJudgmentDiagnostics,
  summarizeLossReasons,
  summarizeReversals
} from '../src/polymarketAnalytics.js';
import { LOSS_REASONS } from '../src/lossReasonTaxonomy.js';

function order(partial) {
  return {
    id: partial.id || `o-${Math.random().toString(36).slice(2, 8)}`,
    planId: 'plan1',
    source: 'paper',
    symbol: 'BTC-USD',
    settlementStatus: 'settled',
    settledAtIso: new Date().toISOString(),
    ...partial
  };
}

test('filterAnalyticsOrders respects source / plan / symbol', () => {
  const orders = [
    order({ id: '1', source: 'paper', planId: 'plan1', symbol: 'BTC-USD', won: true, pnl: 1 }),
    order({ id: '2', source: 'live', planId: 'plan2', symbol: 'ETH-USD', won: false, pnl: -1 }),
    order({ id: '3', source: 'paper', planId: 'plan5', symbol: 'SOL-USD', won: true, pnl: 2 })
  ];
  assert.equal(filterAnalyticsOrders(orders, { source: 'paper' }).length, 2);
  assert.equal(filterAnalyticsOrders(orders, { planId: 'plan2' }).length, 1);
  assert.equal(filterAnalyticsOrders(orders, { symbol: 'ETH-USD' }).length, 1);
});

test('summarizeLossReasons aggregates taxonomy and avoidable share', () => {
  const orders = [
    order({ won: true, pnl: 2 }),
    order({ won: false, pnl: -1, lossReason: LOSS_REASONS.POST_ENTRY_PM_REVERSAL }),
    order({ won: false, pnl: -2, lossReason: LOSS_REASONS.HIGH_ENTRY_NEGATIVE_EV }),
    order({ won: false, pnl: -0.5, lossReason: LOSS_REASONS.SOFT_STOP_LOSS })
  ];
  const summary = summarizeLossReasons(orders);
  assert.equal(summary.wins, 1);
  assert.equal(summary.losses, 3);
  assert.equal(summary.byReason[LOSS_REASONS.POST_ENTRY_PM_REVERSAL].count, 1);
  assert.equal(summary.actionableLosses, 1);
  assert.equal(summary.retrospectiveLosses, 2);
  assert.equal(summary.byReason[LOSS_REASONS.SOFT_STOP_LOSS].retrospectiveOnly, true);
  assert.ok(summary.reversalLosses >= 1);
});

test('judgment diagnostics separates hindsight from entry-observable cohorts', () => {
  const orders = [
    order({
      won: false,
      pnl: -5,
      usd: 10,
      direction: 'up',
      entryPrice: 0.72,
      lockStrength: 'strong',
      technicalDirection: 'down',
      expectedValueGate: { conservativeWinRate: 0.68, expectedRoi: -0.04 },
      lossAnalysis: { detail: { actualDirection: 'down' } }
    }),
    order({
      won: true,
      pnl: 2,
      usd: 10,
      direction: 'up',
      entryPrice: 0.7,
      lockStrength: 'strong',
      expectedValueGate: { conservativeWinRate: 0.68, expectedRoi: -0.02 },
      lossAnalysis: { detail: { actualDirection: 'up' } }
    })
  ];
  const audit = summarizeJudgmentDiagnostics(orders);
  const direction = audit.rows.find((row) => row.key === 'direction_model_wrong');
  const valuation = audit.rows.find((row) => row.key === 'negative_ev_snapshot');
  const technical = audit.rows.find((row) => row.key === 'technical_direction_disagreed');
  assert.equal(direction.actionableAtEntry, false);
  assert.equal(direction.total, 1);
  assert.equal(valuation.actionableAtEntry, true);
  assert.equal(valuation.total, 2);
  assert.equal(valuation.totalPnl, -3);
  assert.equal(technical.total, 1);
  assert.equal(technical.actionableAtEntry, true);
  assert.equal(audit.coverage.expectedValueSnapshot, 2);
  assert.equal(audit.coverage.decisionTrace, 1);
  assert.equal(audit.riskEvidenceLosses, 1);
  assert.equal(audit.riskEvidenceLossShare, 1);
});

test('summarizeReversals and exits classify families', () => {
  const orders = [
    order({
      won: false,
      pnl: -1,
      lossReason: LOSS_REASONS.POST_ENTRY_PM_REVERSAL,
      pmReversal: true,
      exitStatus: 'stop-loss'
    }),
    order({ won: true, pnl: 1, exitStatus: 'take-profit' }),
    order({ won: true, pnl: 0.2, exitStatus: 'expiry' }),
    order({
      won: false,
      pnl: -0.8,
      lossReason: LOSS_REASONS.SHORT_WINDOW_REVERSAL,
      exitStatus: 'soft-stop-loss'
    })
  ];
  const rev = summarizeReversals(orders);
  assert.equal(rev.postEntryPmReversal, 1);
  assert.equal(rev.shortWindowReversal, 1);
  assert.equal(rev.pmReversalFlagged, 1);

  const exits = summarizeExits(orders);
  assert.equal(exits.byFamily['take-profit'].total, 1);
  assert.equal(exits.byFamily['stop-loss'].total, 2);
  assert.equal(exits.byFamily.expiry.total, 1);
  assert.ok(exits.takeProfitHitRate != null);
});

test('profitability reports price edge and paper/live matched parity', () => {
  const orders = [
    order({ id: 'p', source: 'paper', slotIso: '2026-01-01T00:00:00Z', direction: 'up', entryType: 'probe', entryPrice: 0.6, usd: 10, won: true, pnl: 2 }),
    order({ id: 'l', source: 'live', slotIso: '2026-01-01T00:00:00Z', direction: 'up', entryType: 'probe', entryPrice: 0.62, usd: 10, won: true, pnl: 1 })
  ];
  const profitability = summarizeProfitability(orders);
  assert.equal(profitability.samples, 2);
  assert.equal(profitability.roi, 0.15);
  assert.equal(profitability.binaryPriceEdge, 0.39);

  const parity = summarizePaperLiveParity(orders);
  assert.equal(parity.matchedPairs, 1);
  assert.equal(parity.outcomeAgreement, 1);
  assert.equal(parity.avgLivePriceDelta, 0.02);
});

test('buildPolymarketAnalyticsDashboard returns plan-specific sections', () => {
  const orders = [
    order({
      planId: 'plan5',
      won: true,
      pnl: 1,
      lockStrength: 'strong',
      confidence: 0.62,
      entryPrice: 0.55,
      exitStatus: 'expiry'
    }),
    order({
      planId: 'plan5',
      won: false,
      pnl: -1,
      lockStrength: 'weak',
      lossReason: LOSS_REASONS.LOCK_STRENGTH_MISJUDGE,
      confidence: 0.58,
      entryPrice: 0.6,
      exitStatus: 'expiry'
    }),
    order({
      planId: 'plan2',
      won: false,
      pnl: -1.5,
      entryType: 'cross_follow',
      crossSymbolAligned: true,
      lossReason: LOSS_REASONS.CROSS_FOLLOW_FAILED,
      symbol: 'ETH-USD',
      exitStatus: 'stop-loss'
    })
  ];

  const dash = buildPolymarketAnalyticsDashboard({
    orders,
    planId: null,
    source: 'paper',
    lookbackDays: 30,
    plan3BandStats: { '0.95-0.97': { total: 2, wins: 1, losses: 1, winRate: 0.5, totalPnl: 0 } },
    plan3LossAnalytics: { settledOrders: 2, winRate: 0.5, reasonCounts: { high_entry: 1 } },
    nextSlotPredictions: [
      { correct: true, lockStrength: 'strong', sourceTimeframe: '5m', sameDirectionAsPrev: true },
      { correct: false, lockStrength: 'weak', sourceTimeframe: '5m', sameDirectionAsPrev: false }
    ]
  });

  assert.equal(dash.sampleCount, 3);
  assert.ok(dash.bySymbol['BTC-USD'] || dash.bySymbol['ETH-USD']);
  assert.ok(dash.planSpecific.plan5.lockStrengthOrders.strong.total >= 1);
  assert.ok(dash.planSpecific.plan5.lockStrengthOrders.strong.breakEvenWinRate != null);
  assert.equal(dash.planSpecific.plan5.nextSlot.overall.total, 2);
  assert.equal(dash.planSpecific.plan2.crossFollow.failed, 1);
  assert.ok(dash.historyGate.samples >= 1);
  assert.ok(dash.judgmentDiagnostics.coverage.samples >= 1);
  assert.ok(dash.calibration.bucketCount >= 0);
});

test('current plans split Plan14 price bands and Plan15 categories', () => {
  const dash = buildPolymarketAnalyticsDashboard({
    orders: [
      order({ id: 'a', planId: 'plan14', won: true, pnl: 0.9, limitPrice: 0.88, strategyVersion: 'plan14_two_sided_v8' }),
      order({ id: 'b', planId: 'plan15', symbol: '体育', won: false, pnl: -5, limitPrice: 0.54, strategyVersion: 'plan15_event_midband_v2' }),
      order({ id: 'c', planId: 'plan15', symbol: '电竞', won: true, pnl: 4, limitPrice: 0.62, strategyVersion: 'plan15_event_midband_v2' })
    ],
    planId: 'current',
    source: 'paper',
    lookbackDays: 30,
    positionInventory: {
      plan15: { open: 2, openUsd: 10, by: { 体育: 1, 电竞: 1 } }
    }
  });
  assert.equal(dash.sampleCount, 3);
  assert.equal(dash.planSpecific.plan14.byPrice['80–90¢'].wins, 1);
  assert.equal(dash.planSpecific.plan15.byCategory['体育'].losses, 1);
  assert.equal(dash.planSpecific.plan15.byCategory['电竞'].wins, 1);
  assert.equal(dash.planSpecific.plan15.byPrice['50–60¢'].total, 1);
  assert.equal(dash.planSpecific.plan15.open.open, 2);
  assert.equal(dash.bySymbol['体育'].total, 1);
});

test('empty live dashboard exposes explicit emptyMessage', () => {
  const dash = buildPolymarketAnalyticsDashboard({
    orders: [
      order({ id: 'p1', source: 'paper', won: true, pnl: 1 })
    ],
    source: 'live',
    lookbackDays: 30
  });
  assert.equal(dash.sampleCount, 0);
  assert.equal(dash.empty, true);
  assert.match(dash.emptyMessage, /暂无实盘结算样本/);
});
