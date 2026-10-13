import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyFiveMinutePathExperiment,
  classifyFiveMinutePathSamples,
  evaluateFiveMinutePathExperiment
} from '../src/polymarketWindowTrack.js';

function sample(elapsedPct, price, upPrice, downPrice, seconds) {
  return {
    elapsedPct,
    btcPrice: price,
    upPrice,
    downPrice,
    ts: Date.parse('2026-07-14T12:00:00.000Z') + seconds * 1000
  };
}

const upThenDown = [
  sample(0.02, 100.00, 0.50, 0.50, 0),
  sample(0.10, 100.07, 0.60, 0.40, 24),
  sample(0.20, 100.10, 0.68, 0.32, 54),
  sample(0.30, 100.10, 0.66, 0.34, 84),
  sample(0.42, 100.11, 0.63, 0.37, 120),
  sample(0.56, 100.09, 0.58, 0.42, 162),
  sample(0.62, 100.07, 0.53, 0.47, 180),
  sample(0.72, 100.02, 0.47, 0.53, 210),
  sample(0.82, 99.96, 0.42, 0.58, 240)
];

test('classifies early up, middle plateau, and late down as a confirmed reversal', () => {
  const result = classifyFiveMinutePathSamples(upThenDown);

  assert.equal(result.pattern, 'reversal_down_confirmed');
  assert.equal(result.actionable, true);
  assert.equal(result.impulseDirection, 'up');
  assert.equal(result.reversalDirection, 'down');
  assert.equal(result.crossedStart, true);
  assert.ok(result.retracementRatio > 1);
});

test('plateau blocks chasing the early impulse', () => {
  const path = classifyFiveMinutePathSamples(upThenDown.slice(0, 6), {
    fiveMinutePathMinSamples: 6
  });
  assert.equal(path.pattern, 'plateau_after_up');

  const evaluation = evaluateFiveMinutePathExperiment({ path, direction: 'up' });
  assert.equal(evaluation.active, true);
  assert.equal(evaluation.allowed, false);
  assert.equal(evaluation.reason, 'plateau_blocks_impulse_chase');
});

test('confirmed reversal permits only the aligned candidate', () => {
  const path = classifyFiveMinutePathSamples(upThenDown);

  assert.equal(evaluateFiveMinutePathExperiment({ path, direction: 'down' }).allowed, true);
  assert.equal(evaluateFiveMinutePathExperiment({ path, direction: 'up' }).allowed, false);
});

test('simulation experiment blocks a conflicting order and records the candidate direction', () => {
  const path = classifyFiveMinutePathSamples(upThenDown);
  const candidate = { shouldTrade: true, direction: 'up', strategy: 'test', usd: 5 };
  const result = applyFiveMinutePathExperiment(candidate, path, { enabled: true });

  assert.equal(result.action.shouldTrade, false);
  assert.equal(result.action.direction, null);
  assert.equal(result.action.candidateDirection, 'up');
  assert.equal(result.action.trajectoryPattern, 'reversal_down_confirmed');
  assert.equal(result.evaluation.applied, true);
});

test('disabled experiment leaves a live candidate unchanged', () => {
  const path = classifyFiveMinutePathSamples(upThenDown);
  const candidate = { shouldTrade: true, direction: 'up', strategy: 'test', usd: 5 };
  const result = applyFiveMinutePathExperiment(candidate, path, { enabled: false });

  assert.equal(result.action, candidate);
  assert.equal(result.action.shouldTrade, true);
  assert.equal(result.evaluation.enabled, false);
  assert.equal(result.evaluation.applied, false);
});

test('does not infer a full-window path when sampling starts too late', () => {
  const result = classifyFiveMinutePathSamples(upThenDown.map((row) => ({
    ...row,
    elapsedPct: row.elapsedPct + 0.2
  })));

  assert.equal(result.pattern, 'insufficient_data');
  assert.equal(result.actionable, false);
});
