import 'dotenv/config';
import { buildPolymarketUsConfig, publicUsConfig } from '../src/polymarketUs/config.js';
import { createPolymarketUsSdk } from '../src/polymarketUs/sdk.js';
import { summarizeUsAccount } from '../src/polymarketUs/trading.js';

const config = buildPolymarketUsConfig();
const summary = publicUsConfig(config);

if (!config.credentialsConfigured) {
  console.log(JSON.stringify({
    ...summary,
    ordersPlaced: false,
    account: null,
    note: '本机没有 POLYMARKET_US_ACCESS_KEY / POLYMARKET_US_SECRET_KEY。只读账户检查要在已配置这两把变量的 Grok Bot 上跑。这个命令不会下单。'
  }, null, 2));
  process.exit(0);
}

const sdk = createPolymarketUsSdk(config);
const [balances, openOrders, positions] = await Promise.all([
  sdk.account.balances(),
  sdk.orders.list(),
  sdk.portfolio.positions()
]);
const account = summarizeUsAccount(balances, openOrders, positions);
console.log(JSON.stringify({
  ...summary,
  ordersPlaced: false,
  account,
  note: '只读：account.balances、orders.list、portfolio.positions。现金门控用 buyingPower，不用 currentBalance。'
}, null, 2));
