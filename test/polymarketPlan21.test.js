import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePlan21, plan21Window, PLAN21_VERSION } from '../src/polymarketPlan21.js';
import { PolymarketTradingService } from '../src/polymarketTrading.js';

const end = Date.parse('2026-10-16T02:05:00Z');

test('only the three profitable 5m windows are active', () => {
  assert.deepEqual(plan21Window(4), { minutes: 4, low: 0.20, high: 0.35 });
  assert.equal(plan21Window(3).high, 0.20);
  assert.equal(plan21Window(2).high, 0.35);
  assert.equal(plan21Window(4.5), plan21Window(4));
  assert.equal(plan21Window(1.4), null);
  assert.equal(plan21Window(0.5), null);
});

test('buys the cheaper side inside the window and skips the losing 3-minute 20-35c cell', () => {
  const books = { upBook: { bestBid: 0.24, bestAsk: 0.26 }, downBook: { bestBid: 0.72, bestAsk: 0.74 } };
  const hit = evaluatePlan21({ ...books, endMs: end, nowMs: end - 4 * 60_000 });
  assert.equal(hit.ok, true);
  assert.equal(hit.outcome, 'Up');
  assert.equal(hit.windowMinutes, 4);
  const losingCell = { upBook: { bestBid: 0.24, bestAsk: 0.26 }, downBook: { bestBid: 0.72, bestAsk: 0.74 } };
  assert.equal(evaluatePlan21({ ...losingCell, endMs: end, nowMs: end - 3 * 60_000 }).reason, 'price_out_of_range');
  const early = evaluatePlan21({ ...books, endMs: end, nowMs: end - 3 * 60_000 + 1000, upBook: { bestBid: 0.14, bestAsk: 0.16 }, downBook: { bestBid: 0.82, bestAsk: 0.84 } });
  assert.equal(early.ok, true);
  assert.equal(early.windowMinutes, 3);
  assert.equal(evaluatePlan21({ ...books, endMs: end, nowMs: end - 4 * 60_000, upBook: { bestBid: 0.10, bestAsk: 0.20 } }).reason, 'wide_spread');
});

test('Plan21 paper orders stay in their own book, one per market, and live is rejected', async () => {
  const s = new PolymarketTradingService({
    config: { paperTakerFeeEnabled: true, paperTakerFeeRate: 0.07, plan21Enabled: true }
  });
  s.persist = async () => {};
  s.getBucket('plan21').portfolio = { startingCash: 500, cash: 500, portfolioInitialized: true };
  const order = await s.createPlan21PaperOrder({
    symbol: 'BTC', outcome: 'Down', ask: 0.26, usd: 5,
    marketSlug: 'btc-updown-5m-1', tokenId: 't', title: 'Bitcoin Up or Down',
    endDate: '2026-10-16T02:05:00.000Z', windowMinutes: 4, minutesLeft: 4.1, low: 0.2, high: 0.35
  });
  assert.equal(order.planId, 'plan21');
  assert.equal(order.strategyVersion, PLAN21_VERSION);
  assert.equal(order.timeframe, '5m');
  assert.equal(order.plan21Entry.windowMinutes, 4);
  assert.equal(s.getBucket('plan21').paperOrders.length, 1);
  assert.equal(s.getBucket('plan18').paperOrders.length, 0);
  assert.ok(s.getBucket('plan21').portfolio.cash < 500);
  assert.equal(await s.createPlan21PaperOrder({
    symbol: 'BTC', outcome: 'Down', ask: 0.16, usd: 5, marketSlug: 'btc-updown-5m-1', windowMinutes: 2
  }), null);
  await assert.rejects(
    () => s.setLiveAutoPlan('plan21', true),
    /禁止实盘/
  );
  const past = new Date(Date.now() - 60_000).toISOString();
  order.targetTimeIso = past;
  const settled = await s.settleOpenOrders('plan21', async () => ({
    officialOutcome: 'Down', priceSource: 'polymarket-official'
  }));
  assert.equal(settled.length, 1);
  assert.equal(settled[0].won, true);
});
