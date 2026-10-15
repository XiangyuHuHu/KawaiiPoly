import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { getConfig } from '../src/config.js';
import { paperPlanFlags } from '../src/polymarketPaperPlansView.js';
import {
  PLAN20_BOOK_PRESCREEN,
  PLAN20_DEFAULTS,
  PLAN20_SEGMENT_RULES,
  evaluatePlan20Candidate,
  matchesPlan20Rule,
  plan20BookAsk,
  plan20EntryFeatures,
  plan20ExecutableQuotes,
  plan20QuotesFromGamma,
  plan20Stake,
  selectPlan20PaperEntries
} from '../src/polymarketPlan20.js';
import { mergePlan20Rules } from '../src/plan20SegmentRules.js';
import { PolymarketTradingService } from '../src/polymarketTrading.js';
import { submitPolymarketLiveOrder, submitLiveOrderFromPlan } from '../src/polymarketLiveOrder.js';

const at = (hour) => Date.UTC(2026, 9, 16, hour, 30);

function quote(price, slug, extra = {}) {
  return { marketSlug: slug, tokenId: slug, outcome: 'Yes', entryPrice: price, title: slug, ...extra };
}

function paperService(config = {}) {
  const service = new PolymarketTradingService({
    config: { plan20Enabled: true, liveTradingEnabled: true, plan20LiveEnabled: true, ...config }
  });
  service.persist = async () => {};
  return service;
}

test('Plan20 curated rule matches the report shortlist and stays paper-only', () => {
  const report = JSON.parse(readFileSync(new URL('../reports/plan20-segments.json', import.meta.url)));
  assert.equal(PLAN20_SEGMENT_RULES.length, 1);
  const [rule] = PLAN20_SEGMENT_RULES;
  assert.ok(report.shortlist.some((item) => JSON.stringify(item.rule) === JSON.stringify(rule.match) && item.holdout.n === 26 && item.holdout.roi === 0.52));
  assert.deepEqual(rule.match, { price: '.20-.35', hour: '12-16' });
  assert.equal(rule.status, 'candidate');
  assert.match(rule.note, /candidate, holdout n=26, ROI \+52%, not validated/);
  assert.equal(rule.stakeUsd, 2);
  assert.equal(PLAN20_DEFAULTS.startingCash, 500);
  assert.equal(PLAN20_DEFAULTS.orderUsd, 2);
  assert.equal(PLAN20_DEFAULTS.maxOpen, 40);
  assert.equal(PLAN20_DEFAULTS.cashFloor, 10);
  assert.equal(PLAN20_DEFAULTS.maxTradePct, 0.05);
  assert.equal(PLAN20_DEFAULTS.maxExposurePct, 0.30);
  assert.equal(evaluatePlan20Candidate({ features: { price: '.20-.35' } }).reason, 'no_matching_segment');
  assert.equal(evaluatePlan20Candidate({ mode: 'live' }).reason, 'paper_only');
});

test('Plan20 requires every rule feature, rejects unknown or unavailable information', () => {
  assert.equal(matchesPlan20Rule({ symbol: 'BTC', direction: 'up' }, { symbol: 'BTC', direction: 'up' }), true);
  assert.equal(matchesPlan20Rule(
    { price: '.20-.35', hour: '12-16' },
    PLAN20_SEGMENT_RULES[0]
  ), true);
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

test('Plan20 candidate rule matches price .20-.35 and UTC hour 12-16 only', () => {
  const ok = (price, hour) => evaluatePlan20Candidate({
    features: plan20EntryFeatures({ entryPrice: price, entryTimeMs: at(hour) })
  }).ok;
  assert.equal(ok(.20, 12), true);
  assert.equal(ok(.3499, 15), true);
  assert.equal(ok(.35, 13), false);
  assert.equal(ok(.1999, 13), false);
  assert.equal(ok(.25, 11), false);
  assert.equal(ok(.25, 16), false);
  assert.equal(evaluatePlan20Candidate({ features: plan20EntryFeatures({}) }).ok, false);
  assert.equal(evaluatePlan20Candidate({
    mode: 'live',
    features: plan20EntryFeatures({ entryPrice: .25, entryTimeMs: at(13) })
  }).reason, 'paper_only');
});

test('Plan20 discovery uses Gamma events and fills from the book ask', () => {
  assert.equal(plan20BookAsk({ bestAsk: 0.27 }), 0.27);
  assert.equal(plan20BookAsk({ bestAsk: 0 }), null);
  assert.equal(plan20BookAsk(null), null);
  const quotes = plan20QuotesFromGamma([{
    categoryId: 'politics',
    event: { title: 'Election' },
    market: {
      slug: 'election-2026',
      question: 'Will it happen?',
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.22","0.78"]',
      clobTokenIds: '["yes-token","no-token"]',
      conditionId: '0xabc',
      active: true
    }
  }, {
    market: { slug: 'closed-market', outcomes: ['Yes'], outcomePrices: [0.25], clobTokenIds: ['closed'], closed: true }
  }]);
  assert.deepEqual(quotes.map((item) => item.tokenId), ['yes-token', 'no-token']);
  const books = new Map([['yes-token', { bestAsk: 0.28 }], ['no-token', { bestAsk: 0.8 }]]);
  const executable = plan20ExecutableQuotes(quotes, books);
  assert.deepEqual(executable.map((item) => [item.tokenId, item.entryPrice]), [['yes-token', 0.28]]);
  assert.equal(PLAN20_BOOK_PRESCREEN.min, 0.15);
  const selected = selectPlan20PaperEntries({
    markets: executable,
    nowMs: at(13),
    cash: 500,
    exposure: 0,
    openCount: 0
  });
  assert.equal(selected.bought, 1);
  assert.equal(selected.entries[0].usd, 2);
  assert.equal(selected.entries[0].mode, 'paper');
  assert.equal(selectPlan20PaperEntries({ markets: executable, nowMs: at(16), cash: 500 }).bought, 0);
  assert.equal(selectPlan20PaperEntries({ markets: executable, nowMs: at(13), cash: 500, mode: 'live' }).reason, 'paper_only');
});

test('miner keeps curated candidates and writes mined rules separately', () => {
  const script = readFileSync(new URL('../scripts/mine-settled-segments.mjs', import.meta.url), 'utf8');
  const curated = readFileSync(new URL('../src/plan20CuratedRules.js', import.meta.url), 'utf8');
  assert.match(curated, /price_20_35_hour_12_16_utc/);
  assert.match(script, /src\/plan20MinedRules\.js/);
  assert.doesNotMatch(script, /writeFileSync\(\s*['"]src\/plan20SegmentRules\.js['"]/);
  assert.doesNotMatch(script, /writeFileSync\(\s*['"]src\/plan20CuratedRules\.js['"]/);
  const merged = mergePlan20Rules(
    [{ id: 'curated', match: { price: '.20-.35', hour: '12-16' }, status: 'candidate' }],
    [{ price: '.20-.35', hour: '12-16' }, { match: { price: '.80+', hour: '0-4' }, status: 'mined' }]
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'curated');
  assert.equal(merged[0].status, 'candidate');
  assert.deepEqual(merged[1].match, { price: '.80+', hour: '0-4' });
});

test('POLYMARKET_PLAN20_ENABLED defaults off and initializes the paper book when on', async () => {
  const previous = process.env.POLYMARKET_PLAN20_ENABLED;
  delete process.env.POLYMARKET_PLAN20_ENABLED;
  assert.equal(getConfig().polymarket.plan20Enabled, false);
  assert.equal(getConfig().polymarket.plan20NewEntriesEnabled, false);
  assert.equal(getConfig().polymarket.plan20StartingCash, 500);
  assert.equal(getConfig().polymarket.plan20OrderUsd, 2);
  assert.equal(paperPlanFlags('plan20', getConfig().polymarket).newEntriesEnabled, false);
  assert.equal(paperPlanFlags('plan20', getConfig().polymarket).liveTradingEnabled, false);
  process.env.POLYMARKET_PLAN20_ENABLED = 'true';
  const enabled = getConfig().polymarket;
  assert.equal(enabled.plan20Enabled, true);
  assert.equal(enabled.plan20NewEntriesEnabled, true);
  assert.equal(paperPlanFlags('plan20', enabled).newEntriesEnabled, true);
  assert.equal(paperPlanFlags('plan20', enabled).liveTradingEnabled, false);
  if (previous == null) delete process.env.POLYMARKET_PLAN20_ENABLED;
  else process.env.POLYMARKET_PLAN20_ENABLED = previous;

  const off = paperService({ plan20Enabled: false });
  assert.deepEqual(await off.ensurePlan20PaperRunning(), { started: false, reason: 'disabled' });
  assert.equal(off.getBucket('plan20').portfolio.portfolioInitialized, false);
  await assert.rejects(off.setAuto(true, { planId: 'plan20' }), /POLYMARKET_PLAN20_ENABLED=false/);

  const service = paperService();
  const started = await service.ensurePlan20PaperRunning();
  assert.equal(started.started, true);
  assert.equal(started.auto, true);
  assert.equal(service.getBucket('plan20').portfolio.startingCash, 500);
  assert.equal(service.getBucket('plan20').portfolio.cash, 500);
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /plan20Enabled === true/);
  assert.match(server, /ensurePlan20PaperRunning/);
  assert.match(server, /getActiveEventsByTag/);
  assert.match(server, /plan20ExecutableQuotes/);
  assert.match(server, /plan20Enabled !== true/);
});

test('Plan20 paper adapter buys $2 inside the rule and respects caps', async () => {
  const service = paperService();
  await service.ensurePlan20PaperRunning();
  const bought = await service.runPlan20PaperScan({
    nowMs: at(13),
    markets: [quote(0.20, 'band-low'), quote(0.3499, 'band-high'), quote(0.35, 'band-edge'), quote(0.19, 'cheap'), quote(0.25, 'band-low')]
  });
  assert.equal(bought.bought, 2);
  assert.equal(bought.reason, 'matched');
  const orders = service.getBucket('plan20').paperOrders;
  assert.equal(orders.length, 2);
  assert.deepEqual(orders.map((order) => order.usd), [2, 2]);
  assert.ok(orders.every((order) => order.mode === 'paper' && order.planId === 'plan20' && order.status === 'paper-filled'));
  assert.equal(service.getBucket('plan20').portfolio.cash, 496);
  assert.equal(orders[0].plan20RuleId, 'price_20_35_hour_12_16_utc');
  assert.deepEqual(orders[0].plan20Features, { price: '.20-.35', hour: '12-16' });

  const late = await service.runPlan20PaperScan({ nowMs: at(16), markets: [quote(0.25, 'late')] });
  assert.equal(late.bought, 0);
  assert.equal(late.reason, 'no_matching_segment');
  const spoofed = await service.createPlan20PaperOrder({
    mode: 'paper',
    entryPrice: 0.9,
    entryTimeMs: at(13),
    marketSlug: 'spoof',
    tokenId: 'spoof',
    features: plan20EntryFeatures({ entryPrice: 0.25, entryTimeMs: at(13) })
  });
  assert.equal(spoofed, null);

  const sized = paperService({ plan20OrderUsd: 100 });
  await sized.ensurePlan20PaperRunning();
  const capped = await sized.runPlan20PaperScan({
    nowMs: at(14),
    markets: Array.from({ length: 10 }, (_, index) => quote(0.3, `cap-${index}`))
  });
  const capOrders = sized.getBucket('plan20').paperOrders;
  assert.equal(capped.bought, 6);
  assert.ok(capOrders.every((order) => order.usd === 25 && order.mode === 'paper'));
  const exposure = capOrders.reduce((sum, order) => sum + order.usd, 0);
  assert.equal(exposure, 150);
  assert.equal(sized.getBucket('plan20').portfolio.cash, 350);

  const crowded = paperService();
  await crowded.ensurePlan20PaperRunning();
  const filled = await crowded.runPlan20PaperScan({
    nowMs: at(12),
    markets: Array.from({ length: 45 }, (_, index) => quote(0.22, `open-${index}`))
  });
  assert.equal(filled.bought, 40);
  assert.equal(crowded.getBucket('plan20').portfolio.cash, 420);
  const overflow = await crowded.runPlan20PaperScan({ nowMs: at(12), markets: [quote(0.22, 'overflow')] });
  assert.deepEqual(overflow, { bought: 0, reason: 'capped' });

  const floored = paperService();
  await floored.ensurePlan20PaperRunning();
  const floorBucket = floored.getBucket('plan20');
  floorBucket.portfolio.cash = 10.5;
  const floor = await floored.runPlan20PaperScan({ nowMs: at(12), markets: [quote(0.22, 'floor')] });
  assert.equal(floor.bought, 0);
  assert.equal(floor.reason, 'capped');
  assert.equal(floorBucket.portfolio.cash, 10.5);
  await floored.ensurePlan20PaperRunning();
  assert.equal(floorBucket.portfolio.cash, 10.5);
  assert.equal(floorBucket.portfolio.startingCash, 500);
});

test('Plan20 service cannot route through generic entry or live APIs even with live flags', async () => {
  const service = new PolymarketTradingService({ config: { liveTradingEnabled: true, plan20LiveEnabled: true } });
  service.persist = async () => {};
  assert.equal(await service.createPaperOrder({}, 'plan20'), null);
  assert.equal(await service.createPlan20PaperOrder({
    mode: 'live',
    entryPrice: 0.25,
    entryTimeMs: at(13),
    marketSlug: 'live-try',
    tokenId: 'live-try'
  }), null);
  assert.deepEqual(await service.runPlan20PaperScan({
    mode: 'live',
    nowMs: at(13),
    markets: [quote(0.25, 'live-scan')]
  }), { bought: 0, reason: 'paper_only' });
  assert.deepEqual(await service.runPlan20PaperScan(), { bought: 0, reason: 'disabled' });
  assert.equal(service.getBucket('plan20').paperOrders.length, 0);
  await assert.rejects(service.setAuto(true, { planId: 'plan20' }), /POLYMARKET_PLAN20_ENABLED=false/);
  await assert.rejects(service.setLiveAutoPlan('plan20', true), /paper-only/);
  for (const input of [{ planId: 'plan20' }, { draft: { planId: 'plan20' } }, { planView: { planId: 'plan20' } }]) {
    await assert.rejects(service.createLiveOrder(input), /paper-only/);
  }
  await assert.rejects(submitPolymarketLiveOrder({ config: {}, draft: { planId: 'plan20' } }), /paper-only/);
  await assert.rejects(submitLiveOrderFromPlan({ config: {}, planView: { planId: 'plan20' } }), /paper-only/);

  const enabled = paperService();
  await enabled.ensurePlan20PaperRunning();
  const order = await enabled.createPlan20PaperOrder({
    entryPrice: 0.25,
    entryTimeMs: at(13),
    marketSlug: 'paper-only',
    tokenId: 'paper-only',
    outcome: 'Yes'
  });
  assert.equal(order.mode, 'paper');
  assert.equal(order.usd, 2);
  await assert.rejects(enabled.setLiveAutoPlan('plan20', true), /paper-only/);
  await assert.rejects(enabled.createLiveOrder({ planId: 'plan20' }), /paper-only/);
  assert.equal(enabled.getBucket('plan20').paperOrders.every((item) => item.mode === 'paper'), true);
});
