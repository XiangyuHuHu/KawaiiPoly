import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertPlan1LiveEntryPriceAllowed,
  resolvePlan1MaxEntryPrice
} from '../src/plan1Policy.js';

const CFG = {
  plan1MaxEntryPrice: 0.64,
  plan1MaxEntryPrice5m: 0.64,
  plan1MaxEntryPrice15m: 0.64
};

test('resolvePlan1MaxEntryPrice respects unified 0.64 cap', () => {
  assert.equal(resolvePlan1MaxEntryPrice('5m', CFG), 0.64);
  assert.equal(resolvePlan1MaxEntryPrice('15m', CFG), 0.64);
});

test('assertPlan1LiveEntryPriceAllowed allows at or below max', () => {
  assert.equal(assertPlan1LiveEntryPriceAllowed(0.64, '5m', CFG), 0.64);
  assert.equal(assertPlan1LiveEntryPriceAllowed(0.55, '15m', CFG), 0.55);
});

test('assertPlan1LiveEntryPriceAllowed rejects FAK chase above max', () => {
  assert.throws(
    () => assertPlan1LiveEntryPriceAllowed(0.75, '15m', CFG),
    /超过上限 64%/
  );
  assert.throws(
    () => assertPlan1LiveEntryPriceAllowed(0.97, '5m', CFG),
    /超过上限 64%/
  );
});
