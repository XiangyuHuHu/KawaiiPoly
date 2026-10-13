import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluatePlan17Row,
  parsePlan17Market,
  plan17Probability,
  plan17KellyStake,
  selectPlan17Buys
} from '../src/polymarketPlan17.js';

const END = '2026-10-11T04:00:00Z';
const NOW = Date.parse('2026-10-10T16:00:00Z');
const HIT_EVENT = { slug: 'what-price-will-bitcoin-hit-on-october-10-2026', endDate: END };
const ABOVE_EVENT = { slug: 'bitcoin-above-on-october-11-2026', endDate: '2026-10-11T16:00:00Z' };

function market({ question = 'Will Bitcoin reach $86,000 on October 10?', slug = 'btc-reach-86k', endDate = END } = {}) {
  return {
    question,
    slug,
    endDate,
    active: true,
    closed: false,
    outcomes: '["Yes","No"]',
    clobTokenIds: `["${slug}-yes","${slug}-no"]`
  };
}

const book = (bid, ask) => ({ bestBid: bid, bestAsk: ask });

test('touch probability is about twice the close-above probability and 1 once crossed', () => {
  const sigma = 0.45; const tau = 12 / (365 * 24);
  const above = plan17Probability('above', 84000, 86000, sigma, tau);
  const touch = plan17Probability('up', 84000, 86000, sigma, tau);
  assert.ok(touch > above * 1.8 && touch < above * 2.1, `${touch} vs ${above}`);
  assert.equal(plan17Probability('up', 86500, 86000, sigma, tau), 1);
  assert.equal(plan17Probability('down', 81000, 82000, sigma, tau), 1);
  const down = plan17Probability('down', 84000, 82000, sigma, tau);
  assert.ok(down > 0 && down < 1);
});

test('parses hit-daily and above families, ignores other events', () => {
  const up = parsePlan17Market({ event: HIT_EVENT, market: market() });
  assert.equal(up.family, 'hitDaily');
  assert.equal(up.type, 'up');
  assert.equal(up.strike, 86000);
  assert.equal(up.windowStartMs, Date.parse(END) - 86_400_000);
  const down = parsePlan17Market({ event: HIT_EVENT, market: market({ question: 'Will Bitcoin dip to $80,000 on October 10?' }) });
  assert.equal(down.type, 'down');
  const above = parsePlan17Market({ event: ABOVE_EVENT, market: market({ question: 'Will the price of Bitcoin be above $84,000 on October 11?', endDate: ABOVE_EVENT.endDate }) });
  assert.equal(above.family, 'above');
  assert.equal(above.type, 'above');
  assert.equal(parsePlan17Market({ event: { slug: 'what-price-will-bitcoin-hit-in-october-2026' }, market: market() }), null);
});

test('buys Yes when the market underprices the touch after fees', () => {
  const data = { spot: 84000, iv: 45, high: 84500, low: 83000 };
  const p = plan17Probability('up', 84000, 86000, 0.45 * 1.05, 12 / (365 * 24));
  const decision = evaluatePlan17Row({ event: HIT_EVENT, market: market(), data, yesBook: book(0.04, 0.05), noBook: book(0.95, 0.96), nowMs: NOW });
  assert.ok(p > 0.15 && p < 0.25, `model ${p}`);
  assert.equal(decision.ok, true);
  assert.equal(decision.outcome, 'Yes');
  assert.equal(decision.family, 'hitDaily');
  assert.ok(decision.edge >= 0.10);
});

test('skips touched barriers, fair prices, wide books and the last 30 minutes', () => {
  const data = { spot: 84000, iv: 45, high: 86100, low: 83000 };
  assert.equal(evaluatePlan17Row({ event: HIT_EVENT, market: market(), data, yesBook: book(0.08, 0.09), noBook: book(0.91, 0.92), nowMs: NOW }).reason, 'already_touched');
  const fresh = { ...data, high: 84500 };
  const p = plan17Probability('up', 84000, 86000, 0.45 * 1.05, 12 / (365 * 24));
  const fairAsk = Math.round(p * 100) / 100;
  assert.equal(evaluatePlan17Row({ event: HIT_EVENT, market: market(), data: fresh, yesBook: book(fairAsk - 0.01, fairAsk), noBook: book(1 - fairAsk - 0.01, 1 - fairAsk + 0.01), nowMs: NOW }).ok, false);
  assert.equal(evaluatePlan17Row({ event: HIT_EVENT, market: market(), data: fresh, yesBook: book(0.01, 0.09), noBook: book(0.80, 0.99), nowMs: NOW }).ok, false);
  assert.equal(evaluatePlan17Row({ event: HIT_EVENT, market: market(), data: fresh, yesBook: book(0.08, 0.09), noBook: book(0.91, 0.92), nowMs: Date.parse(END) - 20 * 60_000 }).reason, 'too_close');
});

test('kelly stake matches p − q at even money and shrinks to half Kelly', () => {
  // 图里：60% − 40% = 20%。50¢ 买入时净赔率正好是 1。
  const even = plan17KellyStake({ p: 0.6, cost: 0.5, equity: 1000, fraction: 1, maxFraction: 1, minUsd: 1 });
  assert.equal(even.fullKelly, 0.2);
  assert.equal(even.usd, 200);
  const half = plan17KellyStake({ p: 0.6, cost: 0.5, equity: 500, fraction: 0.5, maxFraction: 0.08, minUsd: 1 });
  assert.equal(half.appliedFraction, 0.08);
  assert.equal(half.usd, 40);
  // 便宜合约：p=0.20、成本 0.08，f* = 0.12/0.92，半凯利不被 8% 上限截断。
  const cheap = plan17KellyStake({ p: 0.2, cost: 0.08, equity: 500, fraction: 0.5, maxFraction: 0.08, minUsd: 1 });
  assert.equal(cheap.fullKelly, Math.round((0.12 / 0.92) * 1e4) / 1e4);
  assert.equal(cheap.usd, Math.round(500 * (0.12 / 0.92) * 0.5 * 100) / 100);
  assert.equal(plan17KellyStake({ p: 0.4, cost: 0.5, equity: 500 }).usd, 0);
  assert.equal(plan17KellyStake({ p: 0.51, cost: 0.5, equity: 20, fraction: 0.5, maxFraction: 0.08, minUsd: 1 }).reason, 'below_min');
  assert.equal(plan17KellyStake({ p: 0.6, cost: 0.5, equity: 1000, cash: 15, fraction: 1, maxFraction: 1, minUsd: 1 }).usd, 15);
});

test('caps buys per event and skips held markets', () => {
  const data = { spot: 84000, iv: 45, high: 84100, low: 83900 };
  const rows = [86000, 86500, 87000, 87500, 88000].map((strike) => ({
    event: HIT_EVENT,
    market: market({ question: `Will Bitcoin reach $${strike.toLocaleString('en-US')} on October 10?`, slug: `reach-${strike}` }),
    data,
    yesBook: book(0.005, 0.03),
    noBook: book(0.96, 0.97)
  }));
  const picks = selectPlan17Buys({ rows, nowMs: NOW, maxPerEvent: 2, minAsk: 0.01, heldSlugs: new Set(['reach-86000']) });
  assert.ok(picks.length <= 2);
  assert.ok(picks.every((pick) => pick.marketSlug !== 'reach-86000'));
  const capped = selectPlan17Buys({ rows, nowMs: NOW, maxPerEvent: 2, minAsk: 0.01, heldPerEvent: new Map([[HIT_EVENT.slug, 2]]) });
  assert.equal(capped.length, 0);
});
