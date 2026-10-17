import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { getConfig } from '../src/config.js';
import { PLAN20_CURATED_RULES } from '../src/plan20CuratedRules.js';
import { PLAN20_MINED_RULES } from '../src/plan20MinedRules.js';
import { ACTIVE_PAPER_PLAN_IDS } from '../src/polymarketPaperPlansView.js';
import { PolymarketTradingService } from '../src/polymarketTrading.js';

function withEnv(pairs, fn) {
  const previous = new Map(Object.keys(pairs).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(pairs)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('2026-10-18 paper defaults stay paper-only and retire 17 and 19', () => {
  const pm = getConfig().polymarket;
  assert.equal(getConfig().liveTradingEnabled, false);
  assert.equal(pm.liveTradingEnabled, false);
  assert.equal(pm.liveAutoEnabled, false);
  assert.equal(pm.plan14NewEntriesEnabled, false);
  assert.equal(pm.plan14OldRuleExpansion, false);
  assert.deepEqual(pm.plan14Timeframes, ['5m']);
  assert.deepEqual(pm.plan14Symbols, ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD']);
  assert.equal(pm.plan15PausedCategories.includes('weather'), true);
  assert.equal(pm.plan15TightMinPrice, 0.55);
  assert.equal(pm.plan15TightMaxPrice, 0.70);
  assert.equal(pm.plan16BlockLowTail, true);
  assert.equal(pm.plan16LowTailMax, 0.30);
  assert.equal(pm.plan16OldRuleExpansion, false);
  assert.equal(pm.plan16MinAsk, 0.08);
  assert.equal(pm.plan16OrderUsd, 5);
  assert.equal(pm.plan16SampleOnly, true);
  assert.equal(pm.plan17Enabled, false);
  assert.equal(pm.plan17NewEntriesEnabled, false);
  assert.equal(pm.plan18Enabled, true);
  assert.equal(pm.plan19Enabled, false);
  assert.equal(pm.plan19NewEntriesEnabled, false);
  assert.equal(pm.plan20Enabled, false);
  assert.equal(pm.plan21OrderUsd, 5);
  assert.equal(pm.plan21MaxEntryPrice, 0.30);
  assert.equal(pm.plan21ReevalWindows, 100);
  assert.equal(pm.plan21AutoStopAtReeval, false);
  assert.deepEqual(pm.plan21Symbols, ['BTC', 'ETH']);
  assert.equal(pm.plan22Enabled, false);
  assert.equal(pm.plan22MaxSpotClockSkewMs, 5000);
  assert.equal(ACTIVE_PAPER_PLAN_IDS.includes('plan17'), false);
  assert.equal(ACTIVE_PAPER_PLAN_IDS.includes('plan19'), false);
  assert.equal(ACTIVE_PAPER_PLAN_IDS.includes('plan18'), true);
  assert.equal(ACTIVE_PAPER_PLAN_IDS.includes('plan21'), true);
  assert.equal(PLAN20_MINED_RULES.length, 0);
  assert.equal(PLAN20_CURATED_RULES[0].match.price, '.20-.35');
  assert.equal(PLAN20_CURATED_RULES[0].match.hour, '12-16');
});

test('paper size and Plan14 symbols cannot be expanded from env', () => {
  const pm = withEnv({
    POLYMARKET_PLAN14_SYMBOLS: 'BTC-USD,DOGE-USD',
    POLYMARKET_PLAN16_ORDER_USD: '40',
    POLYMARKET_PLAN16_MAX_OPEN: '80',
    POLYMARKET_PLAN16_LOW_TAIL_MAX: '0.10',
    POLYMARKET_PLAN21_ORDER_USD: '25',
    POLYMARKET_PLAN21_MAX_ENTRY_PRICE: '0.45',
    POLYMARKET_PLAN21_AUTO_STOP_AT_REEVAL: 'true',
    POLYMARKET_LIVE_TRADING_ENABLED: 'false',
    ENABLE_LIVE_TRADING: 'false'
  }, () => getConfig().polymarket);
  assert.deepEqual(pm.plan14Symbols, ['BTC-USD']);
  assert.equal(pm.plan16OrderUsd, 5);
  assert.equal(pm.plan16MaxOpen, 30);
  assert.equal(pm.plan16LowTailMax, 0.30);
  assert.equal(pm.plan21OrderUsd, 5);
  assert.equal(pm.plan21MaxEntryPrice, 0.30);
  assert.equal(pm.plan21AutoStopAtReeval, false);
  assert.equal(pm.liveTradingEnabled, false);
});

test('Plan16 rejects a 30c fill and Plan21 keeps the small cap', async () => {
  const service = new PolymarketTradingService({
    config: {
      paperTakerFeeEnabled: true,
      paperTakerFeeRate: 0.07,
      plan16BlockLowTail: true,
      plan16LowTailMax: 0.30,
      plan21Enabled: true,
      plan21MaxEntryPrice: 0.30,
      liveTradingEnabled: true
    }
  });
  service.persist = async () => {};
  service.getBucket('plan16').portfolio = { startingCash: 500, cash: 500, portfolioInitialized: true };
  service.getBucket('plan21').portfolio = { startingCash: 500, cash: 500, portfolioInitialized: true };
  await assert.rejects(
    () => service.createPlan16PaperOrder({
      marketSlug: 'tail', groupKey: 'icao|day|high', usd: 5, ask: 0.30, outcome: 'Yes'
    }),
    /尾部/
  );
  await assert.rejects(
    () => service.createPlan21PaperOrder({
      symbol: 'BTC', outcome: 'Down', ask: 0.31, usd: 5, marketSlug: 'too-rich'
    }),
    /30¢/
  );
  const order = await service.createPlan21PaperOrder({
    symbol: 'ETH', outcome: 'Down', ask: 0.26, usd: 20,
    marketSlug: 'eth-updown-5m-1', tokenId: 't', title: 'Ethereum Up or Down',
    endDate: '2026-10-16T02:05:00.000Z', windowMinutes: 4
  });
  assert.equal(order.usd, 5);
  assert.equal(order.mode, 'paper');
  assert.equal(order.plan21Entry.maxEntryPrice, 0.30);
  assert.equal(service.getBucket('plan21').portfolio.cash < 500, true);
});

test('compose keeps live off and applies the retired-plan flags', () => {
  const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  assert.match(compose, /POLYMARKET_LIVE_TRADING_ENABLED: \$\{POLYMARKET_LIVE_TRADING_ENABLED:-false\}/);
  assert.doesNotMatch(compose, /POLYMARKET_LIVE_TRADING_ENABLED: "true"/);
  assert.match(compose, /POLYMARKET_PLAN17_ENABLED: "false"/);
  assert.match(compose, /POLYMARKET_PLAN19_ENABLED: "false"/);
  assert.match(compose, /POLYMARKET_PLAN18_ENABLED: "true"/);
  assert.match(compose, /POLYMARKET_PLAN16_BLOCK_LOW_TAIL: "true"/);
  assert.match(compose, /POLYMARKET_PLAN21_MAX_ENTRY_PRICE: 0\.30/);
  assert.match(compose, /POLYMARKET_PLAN14_NEW_ENTRIES_ENABLED: "false"/);
});
