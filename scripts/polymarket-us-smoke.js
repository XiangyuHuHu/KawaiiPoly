import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPolymarketUsConfig } from '../src/polymarketUs/config.js';
import { runPolymarketUsCycle } from '../src/polymarketUs/runner.js';

const now = new Date('2026-10-14T15:37:00.000Z');
const dir = await mkdtemp(join(tmpdir(), 'us-smoke-'));
const workspace = await mkdtemp(join(tmpdir(), 'us-smoke-ws-'));
await mkdir(join(dir, 'signals'), { recursive: true });
await writeFile(join(dir, 'signals', 'pending.jsonl'), `${JSON.stringify({
  id: 'smoke-weather',
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
  basis: 'smoke',
  bbo_at: now.toISOString(),
  status: 'pending'
})}\n`);

const config = buildPolymarketUsConfig({
  POLYMARKET_US_LEDGER_DIR: dir,
  POLYMARKET_US_WORKSPACE_DIR: workspace
});
config.ledgerDir = dir;
config.workspaceDir = workspace;

const report = await runPolymarketUsCycle({
  config,
  now,
  fetchImpl: async (url) => {
    const host = new URL(url).hostname;
    if (host === 'clob.polymarket.com' || host === 'gamma-api.polymarket.com' || host === 'data-api.polymarket.com') {
      throw new Error(`smoke 碰到了国际盘主机 ${host}`);
    }
    throw new Error(`dry-run smoke 不应发请求: ${url}`);
  }
});

const order = report.results[0]?.order;
if (report.dryRun !== true || report.placed !== 1 || order?.marketSlug !== 'nyc-high-72') {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}
const ledger = JSON.parse((await readFile(join(dir, 'real-orders.jsonl'), 'utf8')).trim());
console.log(JSON.stringify({
  dryRun: true,
  venue: ledger.venue,
  order: ledger.order_payload,
  ledger: join(dir, 'real-orders.jsonl')
}, null, 2));
