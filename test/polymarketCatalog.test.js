import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PolymarketCatalog,
  isShortWindowCryptoUpDown,
  summarizePredictionEvent
} from '../src/polymarketCatalog.js';
import { buildPerpsBoard } from '../src/polymarketPerpsClient.js';

test('summarizePredictionEvent keeps the highest-volume open market leader', () => {
  const row = summarizePredictionEvent({
    slug: 'lol-t1-vs-g2',
    title: 'LoL: T1 vs G2',
    endDate: '2026-09-28T12:00:00Z',
    volume24hr: 120000,
    liquidity: 80000,
    markets: [
      {
        question: 'Game 1 Winner',
        active: true,
        closed: false,
        volume24hr: 10,
        outcomes: '["T1","G2"]',
        outcomePrices: '["0.42","0.58"]'
      },
      {
        question: 'Series Winner',
        active: true,
        closed: false,
        volume24hr: 90000,
        outcomes: '["T1","G2"]',
        outcomePrices: '["0.81","0.19"]'
      }
    ]
  });
  assert.equal(row.leader.question, 'Series Winner');
  assert.equal(row.leader.outcome, 'T1');
  assert.equal(row.leader.price, 0.81);
  assert.equal(row.url, 'https://polymarket.com/event/lol-t1-vs-g2');
});

test('crypto catalog drops short-window up/down events', async () => {
  const client = {
    async getActiveEventsByTag() {
      return [
        { slug: 'btc-updown-5m-1', title: 'Bitcoin Up or Down', volume24hr: 9, markets: [] },
        { slug: 'btc-above-100k', title: 'Bitcoin above 100k', volume24hr: 4, markets: [] }
      ];
    }
  };
  const catalog = new PolymarketCatalog({ client, cacheMs: 0 });
  const snapshot = await catalog.snapshot({ category: 'crypto' });
  assert.equal(isShortWindowCryptoUpDown({ slug: 'btc-updown-5m-1', title: 'Bitcoin Up or Down' }), true);
  assert.deepEqual(snapshot.boards[0].events.map((event) => event.slug), ['btc-above-100k']);
});

test('finance catalog falls through to the next tag when the first is empty', async () => {
  const seen = [];
  const client = {
    async getActiveEventsByTag({ tag }) {
      seen.push(tag);
      if (tag === 'finance') return [];
      return [{ slug: 'fed-decision', title: 'Fed decision', volume24hr: 50, markets: [] }];
    }
  };
  const catalog = new PolymarketCatalog({ client, cacheMs: 0 });
  const snapshot = await catalog.snapshot({ category: 'finance' });
  assert.deepEqual(seen, ['finance', 'business']);
  assert.equal(snapshot.boards[0].tag, 'business');
  assert.equal(snapshot.boards[0].events[0].slug, 'fed-decision');
});

test('buildPerpsBoard joins instruments to tickers and stays read-only', () => {
  const board = buildPerpsBoard(
    [{
      instrument_id: 1,
      category: 'crypto',
      symbol: 'BTC-PERP',
      base_asset: 'BTC',
      max_leverage: 10,
      funding_interval: '1h',
      close_only: false
    }],
    [{
      instrument_id: 1,
      mark_price: '65012.50',
      index_price: '65000',
      last_price: '65100',
      open_price: '64250',
      open_interest: '125.4',
      volume_24h: '2450000',
      funding_rate: '0.0001'
    }]
  );
  assert.equal(board.tradable, false);
  assert.equal(board.rows[0].symbol, 'BTC-PERP');
  assert.equal(board.rows[0].maxLeverage, 10);
  assert.ok(Math.abs(board.rows[0].change24h - (65100 - 64250) / 64250) < 1e-12);
  assert.equal(board.categories.crypto, 1);
});
