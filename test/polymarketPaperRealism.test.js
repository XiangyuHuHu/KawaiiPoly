import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PolymarketTradingService,
  applyPaperEntryTakerFee,
  resolvePaperExecutableEntryPrice
} from '../src/polymarketTrading.js';

const SLOT = '2099-01-01T00:00:00.000Z';

function makeService(overrides = {}) {
  return new PolymarketTradingService({
    config: {
      paperLiveParityEnabled: false,
      maxOrderUsd: 500,
      paperExecutableAskFillEnabled: true,
      paperMaxAskQuoteGap: 0.05,
      paperTakerFeeEnabled: true,
      paperTakerFeeRate: 0.07,
      ...overrides
    },
    statePath: join(tmpdir(), `pm-paper-realism-${Date.now()}-${Math.random()}.json`)
  });
}

function sentiment(extra = {}) {
  return {
    available: true,
    symbol: 'BTC-USD',
    timeframe: '5m',
    upTokenId: 'up-token',
    downTokenId: 'down-token',
    upPrice: 0.70,
    downPrice: 0.30,
    upBestAsk: 0.72,
    downBestAsk: 0.31,
    schedule: { currentSlotIso: SLOT },
    ...extra
  };
}

async function openOrder(service, sentimentOverrides = {}) {
  await service.configurePortfolio({ planId: 'plan1', cash: 500 });
  return service.createPaperOrder({
    planId: 'plan1',
    symbol: 'BTC-USD',
    direction: 'up',
    usd: 10,
    sentiment: sentiment(sentimentOverrides),
    plan: {
      timeframe: '5m',
      slotIso: SLOT,
      targetTimeIso: '2099-01-01T00:05:00.000Z',
      action: { shouldTrade: true, direction: 'up', limitPrice: 0.70 }
    }
  }, 'plan1');
}

test('paper entry fills at book best ask and pays taker fee in shares', async () => {
  const order = await openOrder(makeService());
  assert.equal(order.limitPrice, 0.72);
  assert.equal(order.paperQuotePrice, 0.70);
  assert.equal(order.usd, 10);
  assert.equal(order.grossShares, 13.8889);
  assert.equal(order.paperEntryFeeUsd, 0.196);
  assert.equal(order.shares, 13.6167);
});

test('paper entry is rejected when best ask is far above the quote', async () => {
  await assert.rejects(
    () => openOrder(makeService(), { upBestAsk: 0.80 }),
    /按 FAK 视为未成交/
  );
});

test('paper early exit deducts taker fee from proceeds', async () => {
  const service = makeService();
  const order = await openOrder(service);
  await service.closePaperOrderEarly(order, async () => 0.80, { exitStatus: 'take-profit', planId: 'plan1' });
  assert.equal(order.paperExitFeeUsd, 0.1525);
  assert.equal(order.payoutUsd, 10.74);
  assert.equal(order.pnl, 0.74);
});

test('disabled realism flags keep legacy quote fill and fee-free PnL', async () => {
  const service = makeService({ paperExecutableAskFillEnabled: false, paperTakerFeeEnabled: false });
  const order = await openOrder(service);
  assert.equal(order.limitPrice, 0.70);
  assert.equal(order.shares, 14.2857);
  assert.equal(order.paperEntryFeeUsd, undefined);
  await service.closePaperOrderEarly(order, async () => 0.80, { exitStatus: 'take-profit', planId: 'plan1' });
  assert.equal(order.payoutUsd, 11.43);
});

test('executable price falls back to quote when the book has no ask', () => {
  const price = resolvePaperExecutableEntryPrice({
    direction: 'down',
    sentiment: { downBestAsk: NaN },
    quotePrice: 0.31,
    config: { paperExecutableAskFillEnabled: true, paperMaxAskQuoteGap: 0.05 }
  });
  assert.equal(price, 0.31);
});

test('executable ask far below the quote is rejected as a stale book', () => {
  assert.throws(
    () => resolvePaperExecutableEntryPrice({
      direction: 'up',
      sentiment: { upBestAsk: 0.09 },
      quotePrice: 0.615,
      config: { paperExecutableAskFillEnabled: true, paperMaxAskQuoteGap: 0.05 }
    }),
    /快照不一致/
  );
});

test('entry fee helper is a no-op when fees are not explicitly enabled', () => {
  const draft = { shares: 10, limitPrice: 0.5 };
  assert.equal(applyPaperEntryTakerFee(draft, {}), draft);
});
