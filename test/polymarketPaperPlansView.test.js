import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVE_PAPER_PLAN_IDS, buildActivePaperPlansView } from '../src/polymarketPaperPlansView.js';

test('default paper plans list includes all active plans with safe flags', () => {
  const view = buildActivePaperPlansView({
    config: { plan15NewEntriesEnabled: true, liveTradingEnabled: true },
    statusForPlan: (planId) => ({ planId, portfolio: { cash: 500 } })
  });
  assert.deepEqual(Object.keys(view.plans), ACTIVE_PAPER_PLAN_IDS);
  assert.equal(view.plans.plan15.newEntriesEnabled, true);
  assert.equal(view.plans.plan14.newEntriesEnabled, false);
  for (const plan of Object.values(view.plans)) {
    assert.equal(plan.liveTradingEnabled, false);
    assert.equal(typeof plan.newEntriesEnabled, 'boolean');
  }
  assert.equal(view.plans.plan11, undefined);
});

test('explicitly disabled paper plans are omitted', () => {
  const view = buildActivePaperPlansView({
    config: { plan16Enabled: false }, statusForPlan: (planId) => ({ planId })
  });
  assert.equal(view.plans.plan16, undefined);
  assert.equal(Object.keys(view.plans).length, ACTIVE_PAPER_PLAN_IDS.length - 1);
});
