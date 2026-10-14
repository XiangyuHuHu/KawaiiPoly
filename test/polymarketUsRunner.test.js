import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPolymarketUsConfig } from '../src/polymarketUs/config.js';
import { runPolymarketUsCycle } from '../src/polymarketUs/runner.js';

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
  assert.equal(row.spec, 'v3.2');
  assert.equal(row.dry_run, true);
  assert.equal(row.amount_usd, 2);
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
