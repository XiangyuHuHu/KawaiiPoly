import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateLossReasonGate, aggregateLossReasonBucket } from '../src/lossReasonGate.js';
import { LOSS_REASONS } from '../src/lossReasonTaxonomy.js';

function makeOrders({ total, avoidableLosses, otherLosses = 0, reason = LOSS_REASONS.HIGH_ENTRY_NEGATIVE_EV }) {
  const orders = [];
  for (let i = 0; i < avoidableLosses; i += 1) {
    orders.push({
      planId: 'plan2',
      timeframe: '5m',
      entryType: 'probe',
      won: false,
      pnl: -5,
      lossReason: reason
    });
  }
  for (let i = 0; i < otherLosses; i += 1) {
    orders.push({
      planId: 'plan2',
      timeframe: '5m',
      entryType: 'probe',
      won: false,
      pnl: -5,
      lossReason: LOSS_REASONS.UNKNOWN
    });
  }
  const wins = Math.max(0, total - avoidableLosses - otherLosses);
  for (let i = 0; i < wins; i += 1) {
    orders.push({
      planId: 'plan2',
      timeframe: '5m',
      entryType: 'probe',
      won: true,
      pnl: 3,
      lossReason: null
    });
  }
  return orders;
}

test('evaluateLossReasonGate allows cold start when samples are insufficient', () => {
  const result = evaluateLossReasonGate({
    planId: 'plan2',
    timeframe: '5m',
    entryType: 'probe',
    orders: makeOrders({ total: 5, avoidableLosses: 4 }),
    config: { lossReasonGateMinSamples: 12, lossReasonGateMaxLossRate: 0.55 }
  });
  assert.equal(result.allowed, true);
  assert.equal(result.insufficientSamples, true);
});

test('evaluateLossReasonGate skips when avoidable loss rate is high with enough samples', () => {
  const result = evaluateLossReasonGate({
    planId: 'plan2',
    timeframe: '5m',
    entryType: 'probe',
    orders: makeOrders({ total: 20, avoidableLosses: 14 }),
    config: { lossReasonGateMinSamples: 12, lossReasonGateMaxLossRate: 0.55 }
  });
  assert.equal(result.allowed, false);
  assert.ok(String(result.reason || '').includes('下单前可识别亏损'));
  assert.ok(result.lossRate >= 0.55);
});

test('evaluateLossReasonGate allows when avoidable loss rate is below threshold', () => {
  const result = evaluateLossReasonGate({
    planId: 'plan2',
    timeframe: '5m',
    entryType: 'probe',
    orders: makeOrders({ total: 20, avoidableLosses: 4, otherLosses: 2 }),
    config: { lossReasonGateMinSamples: 12, lossReasonGateMaxLossRate: 0.55 }
  });
  assert.equal(result.allowed, true);
  assert.ok(result.lossRate < 0.55);
});

test('evaluateLossReasonGate does not treat expiry settlement outcome as entry-actionable', () => {
  const result = evaluateLossReasonGate({
    planId: 'plan5',
    timeframe: '5m',
    entryType: 'pm_lock_strength',
    orders: makeOrders({
      total: 20,
      avoidableLosses: 14,
      reason: LOSS_REASONS.EXPIRY_SETTLEMENT_LOSS
    }).map((o) => ({ ...o, planId: 'plan5', entryType: 'pm_lock_strength' })),
    config: { lossReasonGateMinSamples: 12, lossReasonGateMaxLossRate: 0.55 }
  });
  assert.equal(result.allowed, true);
  assert.equal(result.lossRate, 0);
});

test('aggregateLossReasonBucket filters by symbol when provided', () => {
  const orders = [
    ...makeOrders({ total: 10, avoidableLosses: 8 }).map((o) => ({ ...o, symbol: 'BTC-USD' })),
    ...makeOrders({ total: 10, avoidableLosses: 1 }).map((o) => ({ ...o, symbol: 'ETH-USD' }))
  ];
  const btc = aggregateLossReasonBucket(orders, {
    planId: 'plan2',
    timeframe: '5m',
    entryType: 'probe',
    symbol: 'BTC-USD'
  });
  const eth = aggregateLossReasonBucket(orders, {
    planId: 'plan2',
    timeframe: '5m',
    entryType: 'probe',
    symbol: 'ETH-USD'
  });
  assert.equal(btc.total, 10);
  assert.equal(btc.avoidableLosses, 8);
  assert.equal(eth.total, 10);
  assert.equal(eth.avoidableLosses, 1);
  assert.ok(String(btc.featureKey).includes('BTC-USD'));
});

test('aggregateLossReasonBucket filters by lockStrength for plan5', () => {
  const orders = [
    { planId: 'plan5', won: false, lossReason: LOSS_REASONS.LOCK_STRENGTH_MISJUDGE, lockStrength: 'weak' },
    { planId: 'plan5', won: false, lossReason: LOSS_REASONS.LOCK_STRENGTH_MISJUDGE, lockStrength: 'strong' },
    { planId: 'plan5', won: true, lossReason: null, lockStrength: 'weak' }
  ];
  const weak = aggregateLossReasonBucket(orders, {
    planId: 'plan5',
    lockStrength: 'weak',
    reasons: [LOSS_REASONS.LOCK_STRENGTH_MISJUDGE]
  });
  assert.equal(weak.total, 2);
  assert.equal(weak.avoidableLosses, 1);
});

test('Plan5 loss gate weights live outcomes above paper volume', () => {
  const settledAtIso = '2026-07-11T20:00:00.000Z';
  const orders = [
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `live-win-${index}`,
      source: 'live',
      planId: 'plan5',
      symbol: 'BTC-USD',
      timeframe: '5m',
      entryType: 'pm_lock_strength',
      lockStrength: 'normal',
      settledAtIso,
      won: true
    })),
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `paper-loss-${index}`,
      source: 'paper',
      planId: 'plan5',
      symbol: 'BTC-USD',
      timeframe: '5m',
      entryType: 'pm_lock_strength',
      lockStrength: 'normal',
      settledAtIso,
      won: false,
      lossReason: LOSS_REASONS.HIGH_ENTRY_NEGATIVE_EV
    }))
  ];
  const base = {
    planId: 'plan5',
    timeframe: '5m',
    entryType: 'pm_lock_strength',
    lockStrength: 'normal',
    symbol: 'BTC-USD',
    orders,
    now: new Date(settledAtIso),
    config: { lossReasonGateMinSamples: 12, lossReasonGateMaxLossRate: 0.55 }
  };

  assert.equal(evaluateLossReasonGate(base).allowed, false);
  const weighted = evaluateLossReasonGate({
    ...base,
    sourceWeights: { live: 3, paper: 1 },
    recencyHalfLifeDays: 7
  });
  assert.equal(weighted.allowed, true);
  assert.equal(weighted.sampleCount, 12);
  assert.equal(weighted.lossRate, 0.4);
});
