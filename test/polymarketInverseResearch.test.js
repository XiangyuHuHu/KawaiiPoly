import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyInverseObservation,
  createInverseAccount,
  evaluateInverseEntry,
  settleInverseTrade,
  summarizeInverseAccount
} from '../src/polymarketInverseResearch.js';
import { PolymarketTradingService } from '../src/polymarketTrading.js';

test('the opposite fill uses the other ask and never invents 1 minus primary', () => {
  const valid = evaluateInverseEntry({
    primaryOutcome: 'Down',
    primaryAsk: 0.26,
    oppositeAsk: 0.74,
    oppositeBid: 0.72,
    cash: 10,
    feeRate: 0.07
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.outcome, 'Up');
  assert.equal(valid.ask, 0.74);
  assert.equal(valid.usd, 2);
  assert.ok(valid.shares < valid.grossShares);
  assert.equal(valid.shares > 1, true);

  const missing = evaluateInverseEntry({
    primaryOutcome: 'Down', primaryAsk: 0.26, oppositeAsk: null, cash: 10
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing_opposite_ask');
  assert.equal('ask' in missing, false);

  const gap = evaluateInverseEntry({
    primaryOutcome: 'Down', primaryAsk: 0.26, oppositeAsk: 0.5, oppositeBid: 0.48, cash: 10
  });
  assert.equal(gap.reason, 'complement_gap');

  const wide = evaluateInverseEntry({
    primaryOutcome: 'Up', primaryAsk: 0.27, oppositeAsk: 0.74, oppositeBid: 0.6, cash: 10
  });
  assert.equal(wide.reason, 'wide_spread');
});

test('invalid quotes are recorded and a valid opposite stays in its own ten dollar book', () => {
  const account = createInverseAccount(Date.parse('2026-10-16T02:00:00Z'));
  const skipped = applyInverseObservation(account, {
    primaryOrder: { id: 'primary-1', outcome: 'Down', marketSlug: 'btc-updown-5m-1' },
    primaryAsk: 0.26,
    oppositeAsk: null
  });
  assert.equal(skipped.filled, false);
  assert.equal(account.cash, 10);
  assert.equal(account.invalidCount, 1);
  assert.equal(account.open.length, 0);

  const filled = applyInverseObservation(account, {
    primaryOrder: {
      id: 'primary-2', outcome: 'Down', marketSlug: 'btc-updown-5m-2',
      symbol: 'BTC', targetTimeIso: '2026-10-16T02:05:00.000Z'
    },
    primaryAsk: 0.26,
    oppositeAsk: 0.74,
    oppositeBid: 0.72,
    oppositeTokenId: 'up-token',
    feeRate: 0
  });
  assert.equal(filled.filled, true);
  assert.equal(filled.order.outcome, 'Up');
  assert.equal(filled.order.usd, 2);
  assert.equal(filled.order.paperOnly, true);
  assert.equal(account.cash, 8);
  assert.equal(account.liveOrdersEnabled, false);

  const settled = settleInverseTrade(account, { marketSlug: 'btc-updown-5m-2', officialOutcome: 'Down' });
  assert.equal(settled.won, false);
  assert.equal(settled.pnl, -2);
  assert.equal(account.cash, 8);
  assert.equal(account.losses, 1);
  const summary = summarizeInverseAccount(account);
  assert.equal(summary.started, true);
  assert.equal(summary.trades, 1);
  assert.equal(summary.realizedPnl, -2);
  assert.equal(summary.liveOrdersEnabled, false);
});

test('Plan21 inverse cash is separate, settles with the official label, and cannot go live', async () => {
  const service = new PolymarketTradingService({
    config: { paperTakerFeeEnabled: false, plan21Enabled: true, plan21InverseEnabled: true }
  });
  service.persist = async () => {};
  service.getBucket('plan21').portfolio = { startingCash: 500, cash: 500, portfolioInitialized: true };
  const order = await service.createPlan21PaperOrder({
    symbol: 'BTC', outcome: 'Down', ask: 0.26, usd: 5,
    marketSlug: 'btc-updown-5m-9', tokenId: 'down', title: 'Bitcoin Up or Down',
    endDate: '2026-10-16T02:05:00.000Z', windowMinutes: 4,
    recordInverse: true, oppositeAsk: 0.74, oppositeBid: 0.72, oppositeTokenId: 'up'
  });
  const bucket = service.getBucket('plan21');
  assert.equal(bucket.portfolio.cash, 495);
  assert.equal(bucket.inverseResearch.cash, 8);
  assert.equal(bucket.inverseResearch.open[0].outcome, 'Up');
  assert.equal(bucket.inverseResearch.open[0].primaryOrderId, order.id);
  assert.equal(service.statusForPlan('plan21').inverseResearch.started, true);
  assert.equal(service.statusForPlan('plan21').inverseResearch.open, 1);

  order.targetTimeIso = new Date(Date.now() - 60_000).toISOString();
  const settled = await service.settleOpenOrders('plan21', async () => ({
    officialOutcome: 'Up', priceSource: 'polymarket-official'
  }));
  assert.equal(settled[0].won, false);
  assert.equal(bucket.inverseResearch.open.length, 0);
  assert.equal(bucket.inverseResearch.wins, 1);
  assert.ok(bucket.inverseResearch.cash > 8);
  assert.equal(bucket.portfolio.cash, 495);

  await assert.rejects(() => service.setLiveAutoPlan('plan21', true), /禁止实盘/);
  assert.equal(bucket.inverseResearch.liveOrdersEnabled, false);
});
