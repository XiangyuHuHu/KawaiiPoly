import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPolymarketUsConfig } from '../src/polymarketUs/config.js';
import { cacheAgeMsFrom, normalizeUsBook, PolymarketUsGateway } from '../src/polymarketUs/gateway.js';
import { runPolymarketUsCycle, tradeObservationTime } from '../src/polymarketUs/runner.js';

const NOW = new Date('2026-10-14T15:37:00.000Z');

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'us-ledger-'));
  const workspace = await mkdtemp(join(tmpdir(), 'us-workspace-'));
  await mkdir(join(dir, 'signals'), { recursive: true });
  const signal = {
    id: 'sig-weather-1',
    sector: 'weather',
    slug: 'nyc-high-72',
    side: 'Yes',
    limit_price: 0.4,
    model_prob: 0.5,
    ask: 0.4,
    spread_cents: 1,
    liquidity_usd: 80,
    confidence: 'High',
    resolution_risk: 'Low',
    basis: 'ensemble',
    bbo_at: NOW.toISOString(),
    status: 'pending',
    title: 'NYC high 72'
  };
  await writeFile(join(dir, 'signals', 'pending.jsonl'), `${JSON.stringify(signal)}\n`);
  const config = buildPolymarketUsConfig({
    POLYMARKET_US_LEDGER_DIR: dir,
    POLYMARKET_US_WORKSPACE_DIR: workspace
  });
  config.ledgerDir = dir;
  config.workspaceDir = workspace;
  return { dir, workspace, config, signal };
}

test('dry-run turns a pending SIGNAL into an order payload and does not call fetch', async () => {
  const { dir, config } = await fixture();
  let fetched = 0;
  const report = await runPolymarketUsCycle({
    config,
    now: NOW,
    fetchQuotes: false,
    fetchImpl: async () => {
      fetched += 1;
      throw new Error('dry-run should not hit the network');
    }
  });
  assert.equal(fetched, 0);
  assert.equal(report.dryRun, true);
  assert.equal(report.placed, 1);
  assert.equal(report.results[0].order.marketSlug, 'nyc-high-72');
  assert.equal(report.results[0].order.intent, 'ORDER_INTENT_BUY_LONG');
  assert.equal(report.results[0].fill_status, 'dry_run');
  const ledger = await readFile(join(dir, 'real-orders.jsonl'), 'utf8');
  const row = JSON.parse(ledger.trim());
  assert.equal(row.venue, 'polymarket_us');
  assert.equal(row.spec, 'v3.6');
  assert.equal(row.dry_run, true);
  assert.equal(row.amount_usd, 2);
  assert.equal(row.order_kind, 'normal');
  assert.equal(row.shares, 5);
  assert.equal(row.url, 'https://polymarket.us/event/nyc-high-72');
  const pending = JSON.parse((await readFile(join(dir, 'signals', 'pending.jsonl'), 'utf8')).trim());
  assert.equal(pending.status, 'pending');
  const health = JSON.parse(await readFile(join(dir, 'us-health.json'), 'utf8'));
  assert.equal(health.secretKeyConfigured, false);
  assert.equal(Object.hasOwn(health, 'secretKey'), false);
  assert.equal(Object.hasOwn(health, 'accessKey'), false);
});

test('a second dry-run does not append another order', async () => {
  const { config } = await fixture();
  await runPolymarketUsCycle({ config, now: NOW, fetchQuotes: false });
  const again = await runPolymarketUsCycle({ config, now: NOW, fetchQuotes: false });
  assert.equal(again.results[0].code, 'already_dry_run');
  assert.equal(again.placed, 0);
});

test('live mode submits the US order and marks the signal filled', async () => {
  const { dir, config } = await fixture();
  config.dryRun = false;
  config.credentialsConfigured = true;
  config.liveBlockedReason = null;
  const calls = [];
  const trading = {
    async getBalances() {
      return { balances: [{ currency: 'USD', buyingPower: 40, currentBalance: 40 }] };
    },
    async getPositions() {
      return { positions: {} };
    },
    async listOpenOrders() {
      return { orders: [] };
    },
    async createOrder(body) {
      calls.push(body);
      return { id: 'ord-live-1', executions: [{ type: 'EXECUTION_TYPE_FILL' }] };
    }
  };
  const report = await runPolymarketUsCycle({
    config,
    now: NOW,
    trading,
    fetchQuotes: false
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'ORDER_TYPE_LIMIT');
  assert.equal(calls[0].manualOrderIndicator, 'MANUAL_ORDER_INDICATOR_AUTOMATIC');
  assert.equal(report.results[0].fill_status, 'filled');
  const pending = JSON.parse((await readFile(join(dir, 'signals', 'pending.jsonl'), 'utf8')).trim());
  assert.equal(pending.status, 'filled');
  const row = JSON.parse((await readFile(join(dir, 'real-orders.jsonl'), 'utf8')).trim());
  assert.equal(row.dry_run, false);
  assert.equal(row.order_id, 'ord-live-1');
  assert.equal(row.fill_status, 'filled');
});

test('momentum dry-run is copied to momentum-trial.jsonl', async () => {
  const { dir, config } = await fixture();
  await writeFile(join(dir, 'signals', 'pending.jsonl'), `${JSON.stringify({
    id: 'sig-mom-ok',
    sector: 'momentum',
    slug: 'btc-15m-up',
    side: 'Up',
    limit_price: 0.55,
    ask: 0.55,
    model_prob: 0.7,
    mos: true,
    same_way: true,
    distance_bps: 6,
    spread_cents: 1,
    liquidity_usd: 40,
    bbo_at: NOW.toISOString(),
    confidence: 'High',
    resolution_risk: 'Low',
    status: 'pending'
  })}\n`);
  const report = await runPolymarketUsCycle({ config, now: NOW, fetchQuotes: false });
  assert.equal(report.placed, 1);
  assert.equal(report.results[0].order.price.value, '0.55');
  const trial = JSON.parse((await readFile(join(dir, 'momentum-trial.jsonl'), 'utf8')).trim());
  assert.equal(trial.signal_id, 'sig-mom-ok');
  assert.equal(trial.resolution_source.includes('BRTI'), true);
});

test('opposite BTC window is skipped', async () => {
  const { dir, workspace, config } = await fixture();
  await writeFile(join(dir, 'real-orders.jsonl'), `${JSON.stringify({
    signal_id: 'sig-up',
    slug: 'btc-15m-window',
    window_id: 'btc-15m-window',
    side: 'Up',
    sector: 'btc_misprice',
    fill_status: 'submitted',
    dry_run: false,
    time_pt: '2026-10-14T08:37:00 PT'
  })}\n`);
  await mkdir(join(workspace, 'btc15-mom-demo'), { recursive: true });
  await writeFile(join(workspace, 'btc15-mom-demo', 'signal.json'), JSON.stringify({
    id: 'sig-mom',
    slug: 'btc-15m-window',
    side: 'Down',
    limit_price: 0.55,
    ask: 0.55,
    model_prob: 0.7,
    mos: true,
    same_way: true,
    distance_bps: 6,
    spread_cents: 1,
    liquidity_usd: 40,
    bbo_at: NOW.toISOString(),
    confidence: 'High',
    resolution_risk: 'Low'
  }));
  await writeFile(join(dir, 'signals', 'pending.jsonl'), '');
  const report = await runPolymarketUsCycle({ config, now: NOW, fetchQuotes: false });
  assert.equal(report.results[0].code, 'one_sided');
  assert.equal(report.placed, 0);
});

function freshSample(ageMs) {
  return new Date(Date.now() - ageMs).toISOString().replace(
    /(\.\d{3})Z$/,
    (_, millis) => `${millis}865572469Z`
  );
}

function normalizedBbo(overrides = {}) {
  return {
    bestBid: 0.41,
    bestAsk: 0.42,
    longQuote: 0.42,
    shortQuote: 0.59,
    yesAsk: 0.42,
    noAsk: 0.59,
    spread: 0.01,
    askShares: 140000,
    bidShares: 230000,
    sampledAt: freshSample(4_000),
    observedAt: freshSample(4_000),
    ...overrides
  };
}

test('trade refreshes BBO before the 45s gate and ignores a stale scan timestamp', async () => {
  const { dir, config } = await fixture();
  const calls = [];
  await writeFile(join(dir, 'signals', 'pending.jsonl'), `${JSON.stringify({
    id: 'sig-btc-stale-scan',
    sector: 'btc_misprice',
    slug: 'cpc-btc-updown-15m-demo',
    side: 'Up',
    limit_price: 0.5,
    ask: 0.5,
    model_prob: 0.7,
    spread_cents: 1,
    gates: { spread_cents: 1, liquidity_usd: null, depth_usd: 40 },
    bbo_at: new Date(Date.now() - 120_000).toISOString(),
    confidence: 'High',
    resolution_risk: 'Low',
    status: 'pending'
  })}\n`);
  const gateway = {
    async getBbo(slug) {
      calls.push(['bbo', slug]);
      return normalizedBbo({
        bestBid: 0.49,
        bestAsk: 0.5,
        longQuote: 0.5,
        shortQuote: 0.51,
        yesAsk: 0.5,
        noAsk: 0.51,
        spread: 0.01
      });
    },
    async getBook(slug) {
      calls.push(['book', slug]);
      const error = new Error('market not found');
      error.status = 404;
      throw error;
    }
  };
  const report = await runPolymarketUsCycle({ config, now: NOW, gateway });
  assert.deepEqual(calls, [
    ['bbo', 'cpc-btc-updown-15m-demo'],
    ['book', 'cpc-btc-updown-15m-demo']
  ]);
  assert.equal(report.placed, 1);
  assert.equal(report.results[0].code, 'pass');
  const row = JSON.parse((await readFile(join(dir, 'real-orders.jsonl'), 'utf8')).trim());
  assert.equal(row.model_p, 0.7);
  assert.equal(row.market_p, 0.495);
  assert.equal(row.p_used, 0.6078);
  assert.equal(row.entry, 0.5);
});

test('decision age uses the BBO cache Age, not the last trade or book transactTime', () => {
  const decided = new Date('2026-10-16T15:12:57.735Z');
  const book = normalizeUsBook({
    marketData: {
      transactTime: '2026-10-16T15:12:32.594158856Z',
      stats: { lastPriceSample: { ts: '2026-10-16T15:12:32.594158856Z' } },
      bids: [],
      offers: []
    }
  });
  assert.equal(book.transactTime, '2026-10-16T15:12:32.594158856Z');
  assert.equal(tradeObservationTime(book, decided), decided.toISOString());
  assert.equal(tradeObservationTime({ cacheAgeMs: 11_000 }, decided), '2026-10-16T15:12:46.735Z');
  assert.equal(tradeObservationTime({ cacheAgeMs: 46_000 }, decided), '2026-10-16T15:12:11.735Z');
  assert.equal(tradeObservationTime(null, decided), decided.toISOString());
  assert.equal(cacheAgeMsFrom({ get: (name) => (name === 'age' ? '11' : null) }), 11_000);
  assert.equal(cacheAgeMsFrom(undefined), 0);
});

test('an old last trade does not stale a book snapshotted at the decision', async () => {
  const { dir, config } = await fixture();
  await writeFile(join(dir, 'signals', 'pending.jsonl'), `${JSON.stringify({
    id: 'btc_misprice:cpc-btc-updown-1h-2026-10-16-0700z:down',
    sector: 'btc_misprice',
    slug: 'cpc-btc-updown-1h-2026-10-16-0700z',
    side: 'Down',
    limit_price: 0.5,
    ask: 0.5,
    model_prob: 0.7,
    gates: { spread_cents: 1, depth_usd: 40 },
    bbo_at: new Date(Date.now() - 120_000).toISOString(),
    confidence: 'High',
    resolution_risk: 'Low',
    status: 'pending'
  })}\n`);
  const gateway = {
    async getBbo() {
      return normalizedBbo({
        bestBid: 0.49,
        bestAsk: 0.5,
        longQuote: 0.5,
        shortQuote: 0.5,
        yesAsk: 0.5,
        noAsk: 0.5,
        spread: 0.01,
        sampledAt: freshSample(120_000),
        observedAt: freshSample(120_000)
      });
    },
    async getBook() {
      return {
        asks: [{ price: 0.5, shares: 100 }],
        bids: [{ price: 0.49, shares: 200 }],
        transactTime: freshSample(3_000)
      };
    }
  };
  const report = await runPolymarketUsCycle({ config, now: NOW, gateway });
  assert.equal(report.results[0].code, 'pass');
  assert.equal(report.placed, 1);
});

test('a 15m book 404 with an old last trade still places on the BBO just received', async () => {
  const { dir, config } = await fixture();
  await writeFile(join(dir, 'signals', 'pending.jsonl'), `${JSON.stringify({
    id: 'btc_misprice:cpc-btc-updown-15m-2026-10-16-1430z:down',
    sector: 'btc_misprice',
    slug: 'cpc-btc-updown-15m-2026-10-16-1430z',
    side: 'Down',
    limit_price: 0.5,
    ask: 0.5,
    model_prob: 0.7,
    gates: { spread_cents: 1, depth_usd: 40 },
    bbo_at: new Date(Date.now() - 120_000).toISOString(),
    confidence: 'High',
    resolution_risk: 'Low',
    status: 'pending'
  })}\n`);
  const gateway = new PolymarketUsGateway({
    fetchImpl: async (url) => {
      if (String(url).endsWith('/book')) {
        return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
      }
      return new Response(JSON.stringify({
        marketData: {
          marketSlug: 'cpc-btc-updown-15m-2026-10-16-1430z',
          bestBid: { value: '0.4900', currency: 'USD' },
          bestAsk: { value: '0.5000', currency: 'USD' },
          longQuote: { value: '0.5000' },
          shortQuote: { value: '0.5000' },
          askShares: '200',
          bidShares: '200',
          lastPriceSample: { ts: freshSample(120_000) }
        }
      }), { status: 200, headers: { age: '11' } });
    }
  });
  const report = await runPolymarketUsCycle({ config, now: NOW, gateway });
  assert.equal(report.results[0].code, 'pass');
  assert.equal(report.placed, 1);
});

test('an old book transactTime does not stale a BBO received within 45s', async () => {
  const { dir, config } = await fixture();
  await writeFile(join(dir, 'signals', 'pending.jsonl'), `${JSON.stringify({
    id: 'btc_misprice:cpc-btc-updown-15m-2026-10-16-1500z:up',
    sector: 'btc_misprice',
    slug: 'cpc-btc-updown-15m-2026-10-16-1500z',
    side: 'Up',
    limit_price: 0.5,
    ask: 0.5,
    model_prob: 0.7,
    gates: { spread_cents: 1, depth_usd: 40 },
    bbo_at: new Date(Date.now() - 120_000).toISOString(),
    confidence: 'High',
    resolution_risk: 'Low',
    status: 'pending'
  })}\n`);
  const gateway = {
    async getBbo() {
      return normalizedBbo({
        bestBid: 0.49,
        bestAsk: 0.5,
        yesAsk: 0.5,
        spread: 0.01,
        sampledAt: freshSample(120_000),
        observedAt: freshSample(120_000),
        cacheAgeMs: 11_000
      });
    },
    async getBook() {
      return {
        asks: [{ price: 0.5, shares: 100 }],
        bids: [{ price: 0.49, shares: 100 }],
        transactTime: freshSample(120_000),
        cacheAgeMs: 24_000
      };
    }
  };
  const report = await runPolymarketUsCycle({ config, now: NOW, gateway });
  assert.equal(report.results[0].code, 'pass');
  assert.equal(report.placed, 1);
});

test('a cached BBO slightly over 45s still places when the ask has not moved', async () => {
  const { dir, config } = await fixture();
  await writeFile(join(dir, 'signals', 'pending.jsonl'), `${JSON.stringify({
    id: 'sig-btc-quiet-age',
    sector: 'btc_misprice',
    slug: 'cpc-btc-updown-15m-old',
    side: 'Up',
    limit_price: 0.5,
    ask: 0.5,
    market_p: 0.495,
    model_prob: 0.7,
    gates: { spread_cents: 1, depth_usd: 40 },
    bbo_at: new Date(Date.now() - 5_000).toISOString(),
    confidence: 'High',
    resolution_risk: 'Low',
    status: 'pending'
  })}\n`);
  const gateway = {
    async getBbo() {
      return normalizedBbo({
        bestBid: 0.49,
        bestAsk: 0.5,
        yesAsk: 0.5,
        spread: 0.01,
        sampledAt: freshSample(1_000),
        observedAt: freshSample(1_000),
        cacheAgeMs: 46_000
      });
    },
    async getBook() {
      return {
        asks: [{ price: 0.5, shares: 100 }],
        bids: [{ price: 0.49, shares: 100 }],
        transactTime: freshSample(1_000)
      };
    }
  };
  const report = await runPolymarketUsCycle({ config, now: NOW, gateway });
  assert.equal(report.results[0].code, 'pass');
  assert.equal(report.results[0].order_kind, 'normal');
  assert.equal(report.placed, 1);
});

test('a cached BBO over 45s is stale when the ask moved, and absurd age stays stale', async () => {
  const { dir, config } = await fixture();
  const pending = (id) => `${JSON.stringify({
    id,
    sector: 'btc_misprice',
    slug: 'cpc-btc-updown-15m-old',
    side: 'Up',
    limit_price: 0.5,
    ask: 0.5,
    market_p: 0.495,
    model_prob: 0.7,
    gates: { spread_cents: 1, depth_usd: 40 },
    bbo_at: new Date(Date.now() - 5_000).toISOString(),
    confidence: 'High',
    resolution_risk: 'Low',
    status: 'pending'
  })}\n`;
  await writeFile(join(dir, 'signals', 'pending.jsonl'), pending('sig-btc-moved'));
  const moved = await runPolymarketUsCycle({
    config,
    now: NOW,
    gateway: {
      async getBbo() {
        return normalizedBbo({
          bestBid: 0.39,
          bestAsk: 0.4,
          yesAsk: 0.4,
          spread: 0.01,
          cacheAgeMs: 46_000
        });
      },
      async getBook() {
        return { asks: [{ price: 0.4, shares: 100 }], bids: [{ price: 0.39, shares: 100 }] };
      }
    }
  });
  assert.equal(moved.results[0].code, 'stale_bbo');
  assert.equal(moved.placed, 0);

  await writeFile(join(dir, 'signals', 'pending.jsonl'), pending('sig-btc-absurd'));
  const absurd = await runPolymarketUsCycle({
    config,
    now: NOW,
    gateway: {
      async getBbo() {
        return normalizedBbo({
          bestBid: 0.49,
          bestAsk: 0.5,
          yesAsk: 0.5,
          spread: 0.01,
          cacheAgeMs: 301_000
        });
      },
      async getBook() {
        return { asks: [{ price: 0.5, shares: 100 }], bids: [{ price: 0.49, shares: 100 }] };
      }
    }
  });
  assert.equal(absurd.results[0].code, 'stale_bbo');
  assert.equal(absurd.placed, 0);
});

test('a BBO response with no Age header still places', async () => {
  const { dir, config } = await fixture();
  await writeFile(join(dir, 'signals', 'pending.jsonl'), `${JSON.stringify({
    id: 'sig-btc-no-age',
    sector: 'btc_misprice',
    slug: 'cpc-btc-updown-15m-old',
    side: 'Up',
    limit_price: 0.5,
    ask: 0.5,
    model_prob: 0.7,
    gates: { spread_cents: 1, depth_usd: 40 },
    confidence: 'High',
    resolution_risk: 'Low',
    status: 'pending'
  })}\n`);
  const report = await runPolymarketUsCycle({
    config,
    now: NOW,
    gateway: {
      async getBbo() {
        return normalizedBbo({
          bestBid: 0.49,
          bestAsk: 0.5,
          yesAsk: 0.5,
          spread: 0.01
        });
      },
      async getBook() {
        return { asks: [{ price: 0.5, shares: 100 }], bids: [{ price: 0.49, shares: 100 }] };
      }
    }
  });
  assert.equal(report.results[0].code, 'pass');
  assert.equal(report.placed, 1);
});

test('a coin-flip BTC edge is skipped instead of a $1 exploratory order', async () => {
  const { dir, config } = await fixture();
  await writeFile(join(dir, 'signals', 'pending.jsonl'), `${JSON.stringify({
    id: 'btc_misprice:cpc-btc-updown-15m-2026-10-16-1515z:up',
    sector: 'btc_misprice',
    slug: 'cpc-btc-updown-15m-2026-10-16-1515z',
    side: 'Up',
    limit_price: 0.5,
    ask: 0.5,
    bid: 0.5,
    model_prob: 0.53,
    spread_cents: 1,
    gates: { spread_cents: 1, depth_usd: 40 },
    bbo_at: NOW.toISOString(),
    confidence: 'High',
    resolution_risk: 'Low',
    status: 'pending'
  })}\n`);
  const report = await runPolymarketUsCycle({ config, now: NOW, fetchQuotes: false });
  assert.equal(report.results[0].code, 'model_floor');
  assert.equal(report.results[0].action, 'skip');
  assert.equal(report.placed, 0);
  await assert.rejects(readFile(join(dir, 'real-orders.jsonl'), 'utf8'));
  const health = JSON.parse(await readFile(join(dir, 'us-health.json'), 'utf8'));
  assert.equal(health.results[0].code, 'model_floor');
  assert.equal(health.placed, 0);
});

test('macro yes and no use book depth when liquidity_usd is null', async () => {
  const { dir, config } = await fixture();
  const calls = [];
  const rows = [
    {
      id: 'macro:ewc-usse-ia-2026-11-03-dem:up',
      sector: 'macro',
      slug: 'ewc-usse-ia-2026-11-03-dem',
      side: 'Up',
      limit_price: 0.42,
      ask: 0.42,
      model_prob: 0.48,
      liquidity_usd: null,
      gates: { spread_cents: 1, liquidity_usd: null, depth_usd: null },
      confidence: 'High',
      resolution_risk: 'Low',
      status: 'pending'
    },
    {
      id: 'macro:ewc-usse-mi-2026-11-03-dem:down',
      sector: 'macro',
      slug: 'ewc-usse-mi-2026-11-03-dem',
      side: 'Down',
      limit_price: 0.32,
      ask: 0.32,
      model_prob: 0.4,
      liquidity_usd: null,
      gates: { spread_cents: 1, liquidity_usd: null },
      confidence: 'High',
      resolution_risk: 'Low',
      status: 'pending'
    }
  ];
  await writeFile(join(dir, 'signals', 'pending.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const gateway = {
    async getBbo(slug) {
      calls.push(slug);
      if (slug.includes('-mi-')) {
        return normalizedBbo({
          bestBid: 0.68,
          bestAsk: 0.69,
          longQuote: 0.69,
          shortQuote: 0.32,
          yesAsk: 0.69,
          noAsk: 0.32,
          spread: 0.01,
          askShares: 0,
          bidShares: 0
        });
      }
      return normalizedBbo({ askShares: 0, bidShares: 0 });
    },
    async getBook(slug) {
      if (slug.includes('-mi-')) {
        return { bids: [{ price: 0.68, shares: 82798 }], asks: [{ price: 0.69, shares: 1000 }] };
      }
      return {
        asks: [{ price: 0.42, shares: 14000, size: 14000 }],
        bids: [{ price: 0.41, shares: 15086 }]
      };
    }
  };
  const report = await runPolymarketUsCycle({ config, now: NOW, gateway });
  assert.equal(calls.length, 2);
  assert.equal(report.placed, 2);
  assert.deepEqual(report.results.map((row) => row.code), ['pass', 'pass']);
});

test('an empty book with no BBO size still skips on depth', async () => {
  const { dir, config } = await fixture();
  await writeFile(join(dir, 'signals', 'pending.jsonl'), `${JSON.stringify({
    id: 'sig-macro-empty',
    sector: 'macro',
    slug: 'ewc-empty',
    side: 'Up',
    limit_price: 0.42,
    ask: 0.42,
    model_prob: 0.5,
    liquidity_usd: null,
    gates: { spread_cents: 1, liquidity_usd: null, depth_usd: 80 },
    confidence: 'High',
    resolution_risk: 'Low',
    status: 'pending'
  })}\n`);
  const gateway = {
    async getBbo() {
      return normalizedBbo({ askShares: 0, bidShares: 0 });
    },
    async getBook() {
      return { asks: [], bids: [] };
    }
  };
  const report = await runPolymarketUsCycle({ config, now: NOW, gateway });
  assert.equal(report.results[0].code, 'depth');
  assert.match(report.results[0].reason, /深度 0/);
});

test('a higher fresh ask is still price_ran_away', async () => {
  const { dir, config } = await fixture();
  await writeFile(join(dir, 'signals', 'pending.jsonl'), `${JSON.stringify({
    id: 'sig-ran',
    sector: 'macro',
    slug: 'ewc-ran',
    side: 'Yes',
    limit_price: 0.4,
    ask: 0.4,
    model_prob: 0.5,
    gates: { spread_cents: 1, depth_usd: 80 },
    confidence: 'High',
    resolution_risk: 'Low',
    status: 'pending'
  })}\n`);
  const gateway = {
    async getBbo() {
      return normalizedBbo({ bestBid: 0.54, bestAsk: 0.55, yesAsk: 0.55, spread: 0.01 });
    },
    async getBook() {
      return { asks: [{ price: 0.55, shares: 100 }], bids: [] };
    }
  };
  const report = await runPolymarketUsCycle({ config, now: NOW, gateway });
  assert.equal(report.results[0].code, 'price_ran_away');
  assert.equal(report.placed, 0);
});

test('fetchQuotes false places from gates.depth_usd when liquidity_usd is null', async () => {
  const { dir, config } = await fixture();
  await writeFile(join(dir, 'signals', 'pending.jsonl'), `${JSON.stringify({
    id: 'sig-offline-depth',
    sector: 'macro',
    slug: 'ewc-offline',
    side: 'Yes',
    limit_price: 0.42,
    ask: 0.42,
    model_prob: 0.48,
    liquidity_usd: null,
    gates: { spread_cents: 1, liquidity_usd: null, depth_usd: 80 },
    confidence: 'High',
    resolution_risk: 'Low',
    status: 'pending'
  })}\n`);
  let fetched = 0;
  const gateway = {
    async getBbo() {
      fetched += 1;
      throw new Error('should not fetch');
    },
    async getBook() {
      fetched += 1;
      throw new Error('should not fetch');
    }
  };
  const report = await runPolymarketUsCycle({ config, now: NOW, gateway, fetchQuotes: false });
  assert.equal(fetched, 0);
  assert.equal(report.placed, 1);
});
