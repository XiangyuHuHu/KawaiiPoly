import {
  US_GATEWAY_OBSERVE_GAP_MS,
  US_GATEWAY_RATE_LIMIT_BACKOFF_MS,
  US_GATEWAY_TRADE_GAP_MS
} from '../src/polymarketUs/constants.js';
import { configureGatewayLimiter } from '../src/polymarketUs/gatewayLimit.js';
import { defaultLoadWindow, refreshUsQuote, runUsScan } from '../src/polymarketUs/scan.js';
import { runLiveObservations, settleLiveObservations } from '../src/polymarketUs/liveObserve.js';
import { PublicMarketDataClient } from '../packages/kawaii-signal/publicMarketData.js';
import { runUsDigest } from '../src/polymarketUs/digest.js';
import { PolymarketUsGateway } from '../src/polymarketUs/gateway.js';
import { formatModelCounts, loadPublicModelReport } from '../src/polymarketUs/models.js';
import { defaultLedgerRoot, defaultWorkspaceRoot, writeStatus } from '../src/polymarketUs/signals.js';

configureGatewayLimiter({
  tradeGapMs: US_GATEWAY_TRADE_GAP_MS,
  observeGapMs: US_GATEWAY_OBSERVE_GAP_MS,
  backoffMs: US_GATEWAY_RATE_LIMIT_BACKOFF_MS
});

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
  let observations = { settled: 0, pending: 0, errors: [] };
  try {
    observations = await settleLiveObservations({
      ledgerRoot,
      lookup: (slug) => gateway.getMarket(slug)
    });
  } catch (error) {
    observations = { settled: 0, pending: 0, errors: [String(error?.message || error).slice(0, 160)] };
  }
  console.log(`us-settle live-obs settled=${observations.settled} pending=${observations.pending} errors=${observations.errors?.length || 0}`);
} else if (command === 'live-observe') {
  const gateway = new PolymarketUsGateway();
  const result = await runLiveObservations({ ledgerRoot, gateway });
  console.log(`us-live-observe appended=${result.appended} dup=${result.skippedDup || 0} markets=${result.markets || 0} errors=${result.errors?.length || 0}`);
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
    loadModels: async () => models.rows,
    observeLive: (args) => runLiveObservations({ ...args, gateway })
  });
  const ids = result.signals.map((signal) => (
    signal.order_kind === 'exploratory' ? `${signal.id}:exploratory` : signal.id
  )).join(',');
  const session = result.session?.label ? ` session=${result.session.label}` : '';
  for (const event of result.brakeEvents || []) {
    if (event.event === 'pause') {
      console.log(`sector-brake sector=${event.sector} until=${event.pausedUntil} wins=${event.wins} pnl=${event.pnlUsd}`);
    }
  }
  const observed = result.liveObservations || {};
  console.log(`us-scan signals=${result.published} reason=${result.reason}${session}${ids ? ` id=${ids}` : ''} live-obs=${observed.appended ?? 0} live-obs-errors=${observed.errors?.length || (observed.error ? 1 : 0)}`);
} else {
  console.error('usage: node scripts/us-scan.js [scan|settle|live-observe]');
  process.exit(1);
}
