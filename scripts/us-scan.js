import { defaultLoadWindow, refreshUsQuote, runUsScan } from '../src/polymarketUs/scan.js';
import { PublicMarketDataClient } from '../packages/kawaii-signal/publicMarketData.js';
import { runUsDigest } from '../src/polymarketUs/digest.js';
import { PolymarketUsGateway } from '../src/polymarketUs/gateway.js';
import { defaultLedgerRoot, defaultWorkspaceRoot } from '../src/polymarketUs/signals.js';

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
  const result = await runUsScan({
    ledgerRoot,
    workspaceRoot,
    ignoreWindow,
    loadWindow: (args) => defaultLoadWindow({ gateway, marketData, ...args }),
    refreshQuote: (model) => refreshUsQuote(gateway, model)
  });
  const ids = result.signals.map((signal) => signal.id).join(',');
  console.log(`us-scan signals=${result.published} reason=${result.reason}${ids ? ` id=${ids}` : ''}`);
} else {
  console.error('usage: node scripts/us-scan.js [scan|settle]');
  process.exit(1);
}
