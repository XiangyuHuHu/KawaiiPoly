import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildConfidenceCalibrationTable,
  getCalibratedConfidence
} from '../src/polymarketCalibration.js';

function settledOrder({
  id,
  symbol = 'SOL-USD',
  timeframe = '5m',
  direction = 'up',
  entryType = 'main',
  confidence = 0.64,
  won = true
}) {
  return {
    id,
    planId: 'plan1',
    symbol,
    timeframe,
    direction,
    entryType,
    confidence,
    limitPrice: 0.6,
    settlementStatus: 'settled',
    won,
    pnl: won ? 1 : -1
  };
}

test('calibration keeps Plan1 and Plan2 entry types isolated', () => {
  const table = buildConfidenceCalibrationTable([
    settledOrder({ id: 'main', entryType: 'main' }),
    settledOrder({ id: 'basket', entryType: 'basket_probe', won: false }),
    settledOrder({ id: 'hedge', entryType: 'opposite_hedge' }),
    settledOrder({ id: 'standard', entryType: 'standard', won: false }),
    settledOrder({ id: 'capture', entryType: 'settlement_capture_90' })
  ]);

  const entryTypes = new Set(Object.values(table).map((bucket) => bucket.entryType));
  assert.deepEqual(entryTypes, new Set([
    'main',
    'basket_probe',
    'opposite_hedge',
    'standard',
    'settlement_capture_90'
  ]));
});

test('Plan1 hierarchy falls back across confidence buckets without mixing entry types', () => {
  const orders = [];
  for (let index = 0; index < 12; index += 1) {
    orders.push(settledOrder({
      id: `main-low-${index}`,
      confidence: 0.62,
      won: index < 3
    }));
  }
  for (let index = 0; index < 12; index += 1) {
    orders.push(settledOrder({
      id: `main-high-${index}`,
      confidence: 0.68,
      won: index < 3
    }));
  }
  for (let index = 0; index < 30; index += 1) {
    orders.push(settledOrder({
      id: `capture-${index}`,
      entryType: 'settlement_capture_90',
      confidence: 0.62,
      won: true
    }));
  }

  const calibrated = getCalibratedConfidence({
    rawConfidence: 0.62,
    planId: 'plan1',
    symbol: 'SOL-USD',
    timeframe: '5m',
    direction: 'up',
    entryType: 'main',
    calibrationTable: buildConfidenceCalibrationTable(orders),
    config: {
      confidenceCalibrationEnabled: true,
      confidenceCalibrationHierarchyEnabled: true,
      confidenceMinBucketSamples: 20
    }
  });

  assert.equal(calibrated.calibrated, true);
  assert.equal(calibrated.bucket.hierarchyLevel, 'symbol_timeframe_entry');
  assert.equal(calibrated.bucket.sampleCount, 24);
  assert.equal(calibrated.calibratedConfidence, 0.25);
});
