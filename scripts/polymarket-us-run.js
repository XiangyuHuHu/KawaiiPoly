import 'dotenv/config';
import { runPolymarketUsCycle } from '../src/polymarketUs/index.js';

const report = await runPolymarketUsCycle();
const lines = report.results.map((row) => `${row.action}\t${row.code}\t${row.signal_id || ''}\t${row.reason}`);
console.log([
  `line=polymarket_us spec=${report.specVersion} dryRun=${report.dryRun} blocked=${report.liveBlockedReason || 'none'}`,
  `placed=${report.placed} skipped=${report.skipped} deferred=${report.deferred}`,
  ...lines
].join('\n'));
if (!report.dryRun && report.placed > 0) {
  console.log('实盘订单已提交到 api.polymarket.us。播报请读 real-orders.jsonl / us-health.json，不要再用浏览器逐笔下单。');
}
