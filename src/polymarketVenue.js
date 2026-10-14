/**
 * Polymarket 两条互不结算的线。
 * - intl：polymarket.com，Gamma + CLOB（@polymarket/clob-client）
 * - us：polymarket.us，gateway 公开行情 + api.polymarket.us 交易
 * 美国版战绩不得回填 gamma-api / data-api。
 */

export const POLYMARKET_LINES = Object.freeze({
  intl: Object.freeze({
    id: 'polymarket_intl',
    marketDataHosts: Object.freeze(['gamma-api.polymarket.com', 'clob.polymarket.com', 'data-api.polymarket.com']),
    tradingHost: 'clob.polymarket.com',
    settlementHost: 'gamma-api.polymarket.com',
    client: 'src/polymarketClient.js'
  }),
  us: Object.freeze({
    id: 'polymarket_us',
    marketDataHosts: Object.freeze(['gateway.polymarket.us']),
    tradingHost: 'api.polymarket.us',
    settlementHost: 'api.polymarket.us',
    client: 'src/polymarketUs/'
  })
});

const INTL_HOSTS = new Set([
  'clob.polymarket.com',
  'gamma-api.polymarket.com',
  'data-api.polymarket.com',
  'polymarket.com',
  'www.polymarket.com'
]);

const US_HOSTS = new Set([
  'gateway.polymarket.us',
  'api.polymarket.us',
  'polymarket.us',
  'www.polymarket.us'
]);

export function hostnameOf(urlString) {
  return new URL(urlString).hostname;
}

export function assertIntlLineUrl(urlString, label = '国际盘客户端') {
  const host = hostnameOf(urlString);
  if (US_HOSTS.has(host) || host.endsWith('.polymarket.us')) {
    throw new Error(`${label} 不能指向美国盘主机 ${host}。美国盘请用 src/polymarketUs。`);
  }
  return host;
}

export function assertUsLineUrl(urlString, label = '美国盘客户端') {
  const host = hostnameOf(urlString);
  if (INTL_HOSTS.has(host)) {
    throw new Error(`${label} 不能指向国际盘主机 ${host}。国际盘结算不能作为 polymarket.us 的成交来源。`);
  }
  return host;
}
