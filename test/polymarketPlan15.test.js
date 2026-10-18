import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveNamedMarketOutcome, resolveOfficialMarketOutcome } from '../src/polymarketClient.js';
import { evaluatePlan15Candidate } from '../src/polymarketPlan15.js';

const now = Date.parse('2026-10-05T00:00:00Z');

function market(overrides = {}) {
  return {
    slug: 'lakers-win',
    question: 'Will the Lakers win?',
    closed: false,
    active: true,
    acceptingOrders: true,
    endDate: '2026-10-06T18:00:00Z',
    volume24hr: 25000,
    outcomes: '["Lakers","Celtics"]',
    outcomePrices: '["0.56","0.44"]',
    clobTokenIds: '["token-lakers","token-celtics"]',
    ...overrides
  };
}

test('plan15 buys the leading outcome inside 40-70c with a tight book', () => {
  const decision = evaluatePlan15Candidate({
    market: market(),
    event: { title: 'Lakers vs Celtics', volume24hr: 25000 },
    categoryId: 'sports',
    now,
    book: { bestBid: 0.54, bestAsk: 0.57 }
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.outcome, 'Lakers');
  assert.equal(decision.tokenId, 'token-lakers');
  assert.equal(decision.ask, 0.57);
});

test('plan15 skips favorites above 70c and markets that end after 2 days', () => {
  const expensive = evaluatePlan15Candidate({
    market: market({ outcomePrices: '["0.88","0.12"]' }),
    categoryId: 'sports',
    now,
    book: { bestBid: 0.86, bestAsk: 0.88 }
  });
  assert.equal(expensive.ok, false);
  assert.equal(expensive.reason, 'price_out_of_range');

  const threeDays = evaluatePlan15Candidate({
    market: market({ endDate: '2026-10-08T00:00:00Z' }),
    categoryId: 'sports',
    now
  });
  assert.equal(threeDays.ok, false);
  assert.equal(threeDays.reason, 'horizon');

  const distant = evaluatePlan15Candidate({
    market: market({ endDate: '2028-11-01T00:00:00Z', outcomePrices: '["0.52","0.48"]' }),
    categoryId: 'politics',
    now
  });
  assert.equal(distant.ok, false);
  assert.equal(distant.reason, 'horizon');
});

test('plan15 keeps sports in the wide band, tightens esports and macro, and pauses weather', () => {
  const sports = evaluatePlan15Candidate({
    market: market({ outcomePrices: '["0.46","0.54"]' }),
    categoryId: 'sports',
    now,
    book: { bestBid: 0.44, bestAsk: 0.46 }
  });
  assert.equal(sports.ok, true);

  const weather = evaluatePlan15Candidate({
    market: market(),
    categoryId: 'weather',
    now,
    book: { bestBid: 0.60, bestAsk: 0.62 }
  });
  assert.equal(weather.reason, 'category_paused');

  const cheapEsports = evaluatePlan15Candidate({
    market: market({ outcomePrices: '["0.52","0.48"]' }),
    categoryId: 'esports',
    now,
    book: { bestBid: 0.50, bestAsk: 0.52 }
  });
  assert.equal(cheapEsports.reason, 'price_out_of_range');

  const esports = evaluatePlan15Candidate({
    market: market({ outcomePrices: '["0.62","0.38"]' }),
    categoryId: 'esports',
    now,
    book: { bestBid: 0.60, bestAsk: 0.62 }
  });
  assert.equal(esports.ok, true);
  assert.equal(esports.ask, 0.62);

  const macro = evaluatePlan15Candidate({
    market: market({ outcomePrices: '["0.50","0.50"]' }),
    categoryId: 'macro',
    now
  });
  assert.equal(macro.reason, 'price_out_of_range');

  const loosened = evaluatePlan15Candidate({
    market: market({ outcomePrices: '["0.52","0.48"]' }),
    categoryId: 'finance',
    now,
    tightMinPrice: 0.40,
    tightMaxPrice: 0.90,
    book: { bestBid: 0.50, bestAsk: 0.52 }
  });
  assert.equal(loosened.reason, 'price_out_of_range');
});

test('plan15 skips a wide book and short-window crypto up/down', () => {
  const wide = evaluatePlan15Candidate({
    market: market(),
    categoryId: 'sports',
    now,
    book: { bestBid: 0.40, bestAsk: 0.57 }
  });
  assert.equal(wide.ok, false);
  assert.equal(wide.reason, 'wide_spread');

  const crypto = evaluatePlan15Candidate({
    market: market({ slug: 'btc-updown-5m-1', question: 'Bitcoin Up or Down' }),
    event: { slug: 'btc-updown-5m-1', title: 'Bitcoin Up or Down' },
    categoryId: 'crypto',
    now
  });
  assert.equal(crypto.ok, false);
  assert.equal(crypto.reason, 'short_window_crypto');
});

test('named settlement keeps a team label that is not up or down', () => {
  const payload = [{
    slug: 'lakers-win',
    closed: true,
    outcomes: '["Lakers","Celtics"]',
    outcomePrices: '["1","0"]'
  }];
  const named = resolveNamedMarketOutcome(payload, 'lakers-win');
  assert.equal(named.officialOutcome, 'Lakers');
  assert.equal(named.actualDirection, null);
  assert.equal(named.priceSource, 'polymarket-official');
  assert.equal(resolveOfficialMarketOutcome(payload, 'lakers-win'), null);
});

test('a cancelled market that resolved 50/50 is reported as void with per-share payouts', () => {
  const payload = [{
    slug: 'cs2-cancelled-game4',
    closed: true,
    umaResolutionStatus: 'resolved',
    outcomes: '["Vitality","MOUZ"]',
    outcomePrices: '["0.5","0.5"]'
  }];
  const named = resolveNamedMarketOutcome(payload, 'cs2-cancelled-game4');
  assert.equal(named.void, true);
  assert.equal(named.officialOutcome, null);
  assert.deepEqual(named.outcomePrices, [0.5, 0.5]);
  assert.deepEqual(named.outcomes, ['Vitality', 'MOUZ']);
  assert.equal(named.priceSource, 'polymarket-official');
  // Still-open 50/50 books (not closed) are not void.
  assert.equal(resolveNamedMarketOutcome([{ ...payload[0], closed: false, umaResolutionStatus: 'proposed' }], 'cs2-cancelled-game4'), null);
});
