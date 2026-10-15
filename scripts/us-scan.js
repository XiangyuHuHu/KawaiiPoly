import { defaultLoadWindow, refreshUsQuote, runUsScan } from '../src/polymarketUs/scan.js';
import { PublicMarketDataClient } from '../packages/kawaii-signal/publicMarketData.js';
import { runUsDigest } from '../src/polymarketUs/digest.js';
import { PolymarketUsGateway } from '../src/polymarketUs/gateway.js';
import { formatModelCounts, loadPublicModelReport } from '../src/polymarketUs/models.js';
import { defaultLedgerRoot, defaultWorkspaceRoot, writeStatus } from '../src/polymarketUs/signals.js';

const command = process.argv[2] || 'scan';
const ledgerRoot = defaultLedgerRoot();
const workspaceRoot = defaultWorkspaceRoot();
const ignoreWindow = process.env.POLYMARKET_US_IGNORE_WINDOW === '1';

if (command === 'settle') {
  const gateway = new PolymarketUsGateway();
  const result = await runUsDigest({
    ledgerRoot,
    lookup: (slug) => gateway.getMarket(slug)
  });
  console.log(`us-settle changed=${result.changed ? 1 : 0}`);
  console.log(result.line);
} else if (command === 'scan') {
  const gateway = new PolymarketUsGateway();
  const marketData = new PublicMarketDataClient();
  const models = await loadPublicModelReport({ ledgerRoot });
  await writeStatus(ledgerRoot, 'model-counts.json', {
    counts: models.counts,
    errors: models.errors,
    catalog: models.catalog
  });
  console.log(`us-scan models ${formatModelCounts(models.counts)} catalog=${models.catalog} errors=${models.errors.length}`);
  const result = await runUsScan({
    ledgerRoot,
    workspaceRoot,
    ignoreWindow,
    loadWindow: (args) => defaultLoadWindow({ gateway, marketData, ...args }),
    refreshQuote: (model) => refreshUsQuote(gateway, model),
    loadModels: async () => models.rows
  });
  const ids = result.signals.map((signal) => signal.id).join(',');
  const session = result.session?.label ? ` session=${result.session.label}` : '';
  console.log(`us-scan signals=${result.published} reason=${result.reason}${session}${ids ? ` id=${ids}` : ''}`);
} else {
  console.error('usage: node scripts/us-scan.js [scan|settle]');
  process.exit(1);
}
