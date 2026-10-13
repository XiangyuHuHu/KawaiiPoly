import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateHistoryWinRateGate } from '../src/historyGate.js';

test('evaluateHistoryWinRateGate allows cold start when samples are insufficient', () => {
  const result = evaluateHistoryWinRateGate({
    rawConfidence: 0.62,
    entryPrice: 0.55,
    timeframe: '15m',
    direction: 'up',
    entryType: 'main',
    calibrationTable: {},
    config: {
      historyWinRateGateEnabled: true,
      confidenceMinBucketSamples: 20,
      historyWinRateRequireCalibration: false
    }
  });
  assert.equal(result.allowed, true);
  assert.equal(result.insufficientSamples, true);
});

test('evaluateHistoryWinRateGate blocks negative EV when calibrated win rate is below entry + margin', () => {
  const calibrationTable = {
    '15m|up|main|61-64': {
      timeframe: '15m',
      direction: 'up',
      entryType: 'main',
      confidenceBucket: '61-64',
      sampleCount: 40,
      wins: 20,
      losses: 20,
      actualWinRate: 0.5,
      avgConfidence: 0.62,
      avgEntryPrice: 0.55,
      avgPnl: -1,
      profitFactor: 0.8
    }
  };
  const result = evaluateHistoryWinRateGate({
    rawConfidence: 0.62,
    entryPrice: 0.55,
    timeframe: '15m',
    direction: 'up',
    entryType: 'main',
    calibrationTable,
    config: {
      historyWinRateGateEnabled: true,
      confidenceCalibrationEnabled: true,
      confidenceMinBucketSamples: 20,
      historyWinRateMargin: 0.02
    },
    planLabel: 'Plan2'
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /Plan2 历史校准胜率/);
});

test('evaluateHistoryWinRateGate allows when calibrated win rate clears breakeven + margin', () => {
  const calibrationTable = {
    '15m|up|main|61-64': {
      timeframe: '15m',
      direction: 'up',
      entryType: 'main',
      confidenceBucket: '61-64',
      sampleCount: 40,
      wins: 30,
      losses: 10,
      actualWinRate: 0.75,
      avgConfidence: 0.62,
      avgEntryPrice: 0.55,
      avgPnl: 2,
      profitFactor: 2
    }
  };
  const result = evaluateHistoryWinRateGate({
    rawConfidence: 0.62,
    entryPrice: 0.55,
    timeframe: '15m',
    direction: 'up',
    entryType: 'main',
    calibrationTable,
    config: {
      historyWinRateGateEnabled: true,
      confidenceCalibrationEnabled: true,
      confidenceMinBucketSamples: 20,
      historyWinRateMargin: 0.02
    }
  });
  assert.equal(result.allowed, true);
  assert.equal(result.sampleCount, 40);
});

test('evaluateHistoryWinRateGate soft mode size-scales near-breakeven deficits', () => {
  const calibrationTable = {
    '15m|up|main|61-64': {
      timeframe: '15m',
      direction: 'up',
      entryType: 'main',
      confidenceBucket: '61-64',
      sampleCount: 187,
      wins: 115,
      losses: 72,
      actualWinRate: 0.615,
      avgConfidence: 0.62,
      avgEntryPrice: 0.62,
      avgPnl: -0.2,
      profitFactor: 0.95
    }
  };
  const result = evaluateHistoryWinRateGate({
    rawConfidence: 0.62,
    entryPrice: 0.62,
    timeframe: '15m',
    direction: 'up',
    entryType: 'main',
    calibrationTable,
    config: {
      historyWinRateGateEnabled: true,
      confidenceCalibrationEnabled: true,
      confidenceMinBucketSamples: 20,
      historyWinRateMargin: 0,
      historyWinRateGateMode: 'soft',
      historyWinRateSoftGap: 0.05,
      historyWinRateSoftSizeFloor: 0.35
    },
    planLabel: 'Plan1'
  });
  assert.equal(result.allowed, true);
  assert.equal(result.softReject, true);
  assert.ok(result.sizeScale < 1);
  assert.ok(result.sizeScale >= 0.35);
});
