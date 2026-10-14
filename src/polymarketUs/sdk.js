import { PolymarketUS } from 'polymarket-us';
import { US_API_BASE, US_GATEWAY_BASE } from './constants.js';
import { PolymarketUsTradingClient } from './trading.js';

export const US_SDK_PACKAGE = 'polymarket-us@0.1.1';

/**
 * polymarket-us@0.1.1 只认 { keyId, secretKey }。
 * keyId 来自 POLYMARKET_US_ACCESS_KEY（UUID），secretKey 来自 POLYMARKET_US_SECRET_KEY。
 * 不读国际盘的 POLYMARKET_API_KEY，也不接受 apiKey。
 */
export function polymarketUsSdkOptions(config = {}) {
  return {
    keyId: String(config.accessKey || config.keyId || '').trim(),
    secretKey: String(config.secretKey || '').trim(),
    gatewayBaseUrl: config.gatewayBaseUrl || US_GATEWAY_BASE,
    apiBaseUrl: config.apiBaseUrl || US_API_BASE,
    timeout: Number(config.requestTimeoutMs || config.timeout || 12000)
  };
}

export function createPolymarketUsSdk(config = {}) {
  const options = polymarketUsSdkOptions(config);
  if (!options.keyId || !options.secretKey) {
    throw new Error('美国盘 SDK 需要 POLYMARKET_US_ACCESS_KEY（keyId）和 POLYMARKET_US_SECRET_KEY（secretKey）。');
  }
  return new PolymarketUS(options);
}

function openOrderQuery(query) {
  if (!query) return undefined;
  if (Array.isArray(query.slugs)) return { slugs: query.slugs };
  if (query.marketSlug) return { slugs: [query.marketSlug] };
  return query;
}

/** 实盘传输层。方法名与手写客户端一致，内部走官方 SDK。 */
export class PolymarketUsSdkTradingClient {
  constructor(sdk) {
    if (!sdk?.orders || !sdk?.account || !sdk?.portfolio) {
      throw new Error('PolymarketUsSdkTradingClient 需要 polymarket-us@0.1.1 的 PolymarketUS 实例。');
    }
    this.sdk = sdk;
    this.line = 'polymarket_us';
    this.transport = US_SDK_PACKAGE;
  }

  createOrder(body) {
    return this.sdk.orders.create(body);
  }

  previewOrder(body) {
    return this.sdk.orders.preview(body);
  }

  listOpenOrders(query) {
    return this.sdk.orders.list(openOrderQuery(query));
  }

  getOrder(orderId) {
    return this.sdk.orders.retrieve(orderId);
  }

  cancelOrder(orderId, body = {}) {
    return this.sdk.orders.cancel(orderId, body);
  }

  cancelAllOpenOrders(body = {}) {
    return this.sdk.orders.cancelAll(body);
  }

  closePosition(body) {
    return this.sdk.orders.closePosition(body);
  }

  getPositions(query) {
    return this.sdk.portfolio.positions(query);
  }

  getActivities(query) {
    return this.sdk.portfolio.activities(query);
  }

  getBalances() {
    return this.sdk.account.balances();
  }
}

export function createUsTradingClient(config = {}, { fetchImpl, sdk } = {}) {
  if (sdk) return new PolymarketUsSdkTradingClient(sdk);
  const raw = new PolymarketUsTradingClient({
    apiBaseUrl: config.apiBaseUrl,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    requestTimeoutMs: config.requestTimeoutMs,
    fetchImpl
  });
  if (fetchImpl || config.dryRun || !config.credentialsConfigured) return raw;
  return new PolymarketUsSdkTradingClient(createPolymarketUsSdk(config));
}
