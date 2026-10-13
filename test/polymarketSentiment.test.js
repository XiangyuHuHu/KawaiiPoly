import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPolymarketSentiment,
  estimateOrderBookSpread,
  resolvePolymarketSpread
} from '../src/polymarketSentiment.js';

test('estimateOrderBookSpread finds best prices in an unsorted book', () => {
  const spread = estimateOrderBookSpread({
    bids: [{ price: '0.20' }, { price: '0.48' }, { price: '0.30' }],
    asks: [{ price: '0.80' }, { price: '0.52' }, { price: '0.60' }]
  });
  assert.ok(Math.abs(spread - 0.04) < 1e-9);
});

test('resolvePolymarketSpread prefers the direct spread endpoint', () => {
  const spread = resolvePolymarketSpread({
    upSpread: 0.02,
    downSpread: 0.04,
    upBook: { bids: [['0.1', '1']], asks: [['0.9', '1']] },
    downBook: { bids: [['0.1', '1']], asks: [['0.9', '1']] }
  });
  assert.ok(Math.abs(spread - 0.03) < 1e-9);
});

test('resolvePolymarketSpread falls back to order books when API spread is absent', () => {
  const spread = resolvePolymarketSpread({
    upBook: { bids: [['0.48', '1']], asks: [['0.52', '1']] },
    downBook: { bids: [['0.47', '1']], asks: [['0.53', '1']] }
  });
  assert.ok(Math.abs(spread - 0.05) < 1e-9);
});

test('lightweight sentiment uses Gamma prices without fan-out to CLOB endpoints', async () => {
  const targetTimeIso = '2026-07-21T16:05:00.000Z';
  const forbiddenCalls = [];
  const client = {
    async getMarketBySlug() {
      return {
        active: true,
        closed: false,
        question: 'Bitcoin Up or Down',
        slug: 'bitcoin-updown-5m-test',
        conditionId: 'condition-1',
        outcomes: JSON.stringify(['Up', 'Down']),
        clobTokenIds: JSON.stringify(['up-token', 'down-token']),
        outcomePrices: JSON.stringify(['0.70', '0.30']),
        endDate: targetTimeIso,
        liquidity: 50_000,
        volume24hr: 250_000
      };
    },
    async searchCryptoMarkets() { forbiddenCalls.push('search'); return []; },
    async getOrderBook() { forbiddenCalls.push('book'); return null; },
    async getTokenPrice() { forbiddenCalls.push('price'); return NaN; },
    async getTokenSpread() { forbiddenCalls.push('spread'); return NaN; },
    async getRecentTrades() { forbiddenCalls.push('trades'); return []; }
  };

  const sentiment = await buildPolymarketSentiment({
    symbol: 'BTC-USD',
    targetTimeIso,
    timeframe: '5m',
    client,
    now: new Date('2026-07-21T16:02:00.000Z'),
    lightweight: true
  });

  assert.equal(sentiment.available, true);
  assert.equal(sentiment.upProbability, 0.7);
  assert.equal(sentiment.downProbability, 0.3);
  assert.equal(sentiment.upTokenId, 'up-token');
  assert.deepEqual(forbiddenCalls, []);
});
