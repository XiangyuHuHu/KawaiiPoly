import { backtestPlan22, plan22SmokeRows } from '../src/polymarketPlan22.js';

const report = backtestPlan22(plan22SmokeRows());
const { tradesDetail, ...summary } = report;
console.log(JSON.stringify(summary, null, 2));
if (!(summary.trades === 30 && summary.pnl > 0 && summary.control.pnl < summary.pnl)) {
  console.error('Plan22 smoke backtest did not show an after-fee edge against its random control.');
  process.exit(1);
}
