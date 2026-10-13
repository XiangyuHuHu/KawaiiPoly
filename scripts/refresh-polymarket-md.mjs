import { PredictionRecorder } from '../src/predictionRecorder.js';
import { PolymarketTradingService } from '../src/polymarketTrading.js';
import { getConfig } from '../src/config.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = getConfig();
const recordDir = process.argv[2] || 'D:/Obsidian仓库/Kawaii的仓库/投资/虚拟币/比特币猜输赢记录';
const dateArg = process.argv[3];

const trading = new PolymarketTradingService({
  config: config.polymarket,
  stateDir: join(root, 'data', 'polymarket'),
  statePath: join(root, 'data', 'polymarket-paper-state.json'),
  defaultStartingCash: config.polymarket.defaultStartingCash
});
await trading.load();

const recorder = new PredictionRecorder({
  recordDir,
  fetchQuotes: async () => [],
  enabled: true,
  readPolymarketPaperSummary: async (date) => trading.dailyOrderSummary(date)
});

const dates = dateArg
  ? [dateArg]
  : [new Date().toISOString().slice(0, 10)];

for (const day of dates) {
  await recorder.refreshDailyMarkdown(new Date(`${day}T12:00:00+08:00`));
  const summary = await trading.dailyOrderSummary(new Date(`${day}T12:00:00+08:00`));
  const plan3 = (summary.orders || []).filter((o) => o.planId === 'plan3').length;
  console.log(`${day}: refreshed · plan3 settled orders ${plan3}`);
}
