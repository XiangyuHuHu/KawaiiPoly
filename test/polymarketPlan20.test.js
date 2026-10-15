import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PLAN20_SEGMENT_RULES, PLAN20_DEFAULTS, matchesPlan20Rule, evaluatePlan20Candidate, plan20Stake } from '../src/polymarketPlan20.js';
import { PolymarketTradingService } from '../src/polymarketTrading.js';
import { submitPolymarketLiveOrder, submitLiveOrderFromPlan } from '../src/polymarketLiveOrder.js';

test('Plan20 generated rules match the report and empty rules are a no-op', () => {
  const report = JSON.parse(readFileSync(new URL('../reports/plan20-segments.json', import.meta.url)));
  assert.deepEqual(PLAN20_SEGMENT_RULES, report.rules);
  assert.equal(PLAN20_DEFAULTS.startingCash, 500);
  assert.equal(evaluatePlan20Candidate({ features: { price: '.20-.35' } }).reason, 'no_surviving_segments');
  assert.equal(evaluatePlan20Candidate({ mode: 'live' }).reason, 'paper_only');
});
test('Plan20 requires every rule feature, rejects unknown or unavailable information', () => {
  assert.equal(matchesPlan20Rule({ symbol: 'BTC', direction: 'up' }, { symbol: 'BTC', direction: 'up' }), true);
  for (const rule of [{}, { symbol: 'ETH' }, { settled_at_iso: 'x' }, { hour: '4-8' }]) assert.equal(matchesPlan20Rule({ symbol: 'BTC' }, rule), false);
  assert.equal(matchesPlan20Rule({ symbol: 'unknown' }, { symbol: 'unknown' }), false);
});
test('Plan20 $2 sizing honors cash floor, exposure, trade cap and max open', () => {
  assert.equal(plan20Stake({ cash: 500 }), 2);
  assert.equal(plan20Stake({ cash: 11.25 }), 1.25);
  assert.equal(plan20Stake({ cash: 10.99 }), 0);
  assert.equal(plan20Stake({ cash: 500, exposure: 150 }), 0);
  assert.equal(plan20Stake({ cash: 500, exposure: 148.5 }), 1.5);
  assert.equal(plan20Stake({ cash: 500, openCount: 40 }), 0);
  assert.equal(plan20Stake({ cash: 500, orderUsd: 100 }), 25);
  assert.equal(plan20Stake({ cash: NaN }), 0);
});
test('Plan20 service cannot route through generic entry or live APIs even with live flags', async () => {
  const service = new PolymarketTradingService({ config: { liveTradingEnabled: true, plan20LiveEnabled: true } });
  service.persist = async () => {};
  assert.equal(await service.createPaperOrder({}, 'plan20'), null);
  assert.equal(await service.createPlan20PaperOrder({ mode: 'live' }), null);
  assert.deepEqual(await service.runPlan20PaperScan(), { bought: 0, reason: 'no_surviving_segments' });
  assert.equal(service.getBucket('plan20').paperOrders.length, 0);
  await assert.rejects(service.setAuto(true, { planId: 'plan20' }), /no surviving segments/);
  await assert.rejects(service.setLiveAutoPlan('plan20', true), /paper-only/);
  for (const input of [{ planId: 'plan20' }, { draft: { planId: 'plan20' } }, { planView: { planId: 'plan20' } }]) await assert.rejects(service.createLiveOrder(input), /paper-only/);
  await assert.rejects(submitPolymarketLiveOrder({ config: {}, draft: { planId: 'plan20' } }), /paper-only/);
  await assert.rejects(submitLiveOrderFromPlan({ config: {}, planView: { planId: 'plan20' } }), /paper-only/);
});
