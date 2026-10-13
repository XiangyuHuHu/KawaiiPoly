import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyOrderLossReason, applySettlementLossAnalysis } from '../src/lossReasonClassifier.js';
import { LOSS_REASONS } from '../src/lossReasonTaxonomy.js';

test('classifyOrderLossReason maps stop-loss exits', () => {
  const soft = classifyOrderLossReason({
    planId: 'plan2',
    pnl: -5,
    won: false,
    exitStatus: 'dynamic-stop-loss',
    direction: 'up',
    entryPrice: 0.55
  });
  assert.equal(soft.lossReason, LOSS_REASONS.SOFT_STOP_LOSS);

  const hard = classifyOrderLossReason({
    planId: 'plan1',
    pnl: -8,
    won: false,
    exitStatus: 'hard-stop-loss',
    direction: 'down',
    entryPrice: 0.5
  });
  assert.equal(hard.lossReason, LOSS_REASONS.HARD_STOP_LOSS);

  const reversal = classifyOrderLossReason({
    planId: 'plan2',
    pnl: -3,
    won: false,
    exitStatus: 'direction-reversal-stop',
    direction: 'up',
    entryPrice: 0.6
  });
  assert.equal(reversal.lossReason, LOSS_REASONS.REVERSAL_STOP_LOSS);
});

test('classifyOrderLossReason tags cross_follow and plan5 lock misjudge', () => {
  const cross = classifyOrderLossReason({
    planId: 'plan2',
    entryType: 'cross_follow',
    pnl: -10,
    won: false,
    exitStatus: 'expiry',
    direction: 'up',
    actualDirection: 'down',
    entryPrice: 0.62
  });
  assert.equal(cross.lossReason, LOSS_REASONS.CROSS_FOLLOW_FAILED);

  const lock = classifyOrderLossReason({
    planId: 'plan5',
    entryType: 'pm_lock_strength',
    lockStrength: 'strong',
    lockPmGap: 0.11,
    strategyVersion: 'plan5_ev_v2',
    signalQuality: { stableMs: 20000, pullbackFromPeak: 0.03, reverseBps: 5 },
    expectedValueGate: { level: 'symbol_timeframe_price', sampleCount: 12, conservativeWinRate: 0.69, expectedRoi: -0.014 },
    signalDirection: 'up',
    technicalDirection: 'down',
    spotDirection: 'down',
    directionRecheck: { flipped: false, originalDirection: 'up', direction: 'up' },
    consensusGate: { allowed: true, softReject: true, sizeScale: 0.5 },
    pnl: -20,
    won: false,
    exitStatus: 'expiry',
    direction: 'up',
    actualDirection: 'down',
    entryPrice: 0.7
  });
  assert.equal(lock.lossReason, LOSS_REASONS.LOCK_STRENGTH_MISJUDGE);
  assert.equal(lock.detail.strategyVersion, 'plan5_ev_v2');
  assert.equal(lock.detail.lockPmGap, 0.11);
  assert.equal(lock.detail.expectedValueGate.sampleCount, 12);
  assert.ok(lock.detail.judgmentErrors.includes('entry_expected_value_non_positive'));
  assert.ok(lock.detail.judgmentErrors.includes('pm_leader_pullback_already_visible'));
  assert.ok(lock.detail.judgmentErrors.includes('underlying_reversal_already_visible'));
  assert.equal(lock.detail.decisionTrace.technicalDirection, 'down');
  assert.equal(lock.detail.decisionTrace.consensusGate.softReject, true);
});

test('classifyOrderLossReason uses short-window and expiry settlement', () => {
  const short = classifyOrderLossReason({
    planId: 'plan1',
    pnl: -4,
    won: false,
    exitStatus: 'expiry',
    direction: 'up',
    actualDirection: 'down',
    entryPrice: 0.55,
    createdAtIso: '2026-07-09T10:00:00.000Z',
    settledAtIso: '2026-07-09T10:01:00.000Z'
  }, { shortHoldMs: 90_000 });
  assert.equal(short.lossReason, LOSS_REASONS.SHORT_WINDOW_REVERSAL);

  const expiry = classifyOrderLossReason({
    planId: 'plan1',
    pnl: -4,
    won: false,
    exitStatus: 'expiry',
    direction: 'up',
    actualDirection: 'down',
    entryPrice: 0.55,
    createdAtIso: '2026-07-09T10:00:00.000Z',
    settledAtIso: '2026-07-09T10:12:00.000Z'
  });
  assert.equal(expiry.lossReason, LOSS_REASONS.EXPIRY_SETTLEMENT_LOSS);
});

test('classifyOrderLossReason leaves wins with null lossReason', () => {
  const win = classifyOrderLossReason({
    planId: 'plan2',
    pnl: 5,
    won: true,
    exitStatus: 'take-profit',
    direction: 'up',
    entryPrice: 0.55
  });
  assert.equal(win.isWin, true);
  assert.equal(win.lossReason, null);
});

test('applySettlementLossAnalysis writes order fields for plan1', () => {
  const order = {
    planId: 'plan1',
    pnl: -6,
    won: false,
    exitStatus: 'stop-loss',
    direction: 'up',
    entryPrice: 0.58,
    limitPrice: 0.58
  };
  assert.equal(applySettlementLossAnalysis(order), true);
  assert.equal(order.lossReason, LOSS_REASONS.STOP_LOSS);
  assert.ok(order.lossAnalysis);
  assert.equal(order.lossAnalysis.detail.planId, 'plan1');
});
