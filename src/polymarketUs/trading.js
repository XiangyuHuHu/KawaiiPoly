import { createUsAuthHeaders } from './auth.js';
import { US_API_BASE, US_ORDER_PATHS } from './constants.js';
import { usRequest } from './http.js';
import { contractsForUsd, normalizeOutcomeSide, readNumber, tradingSlug } from './shape.js';

export function buildUsLimitBuyOrder({ slug, side, limitPrice, quantity } = {}) {
  const outcome = normalizeOutcomeSide(side);
  if (!outcome) throw new Error(`无法识别美国盘方向：${side}`);
  const marketSlug = tradingSlug(slug);
  if (!marketSlug) throw new Error('缺少美国盘 market slug。');
  const price = Number(limitPrice);
  const qty = Number(quantity);
  if (!(price > 0 && price < 1)) throw new Error('美国盘限价必须在 (0, 1)。');
  if (!(qty > 0)) throw new Error('美国盘合约数量必须大于 0。');
  return {
    marketSlug,
    intent: outcome === 'yes' ? 'ORDER_INTENT_BUY_LONG' : 'ORDER_INTENT_BUY_SHORT',
    type: 'ORDER_TYPE_LIMIT',
    price: { value: price.toFixed(2), currency: 'USD' },
    quantity: qty,
    tif: 'TIME_IN_FORCE_GOOD_TILL_CANCEL',
    manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC'
  };
}

export function sizeUsLimitBuy({ side, slug, limitPrice, sizeUsd }) {
  const quantity = contractsForUsd(sizeUsd, limitPrice);
  return buildUsLimitBuyOrder({ slug, side, limitPrice, quantity });
}

export function usdBuyingPower(payload) {
  const rows = payload?.balances || payload?.data?.balances || [];
  const usd = rows.find((row) => String(row?.currency || 'USD').toUpperCase() === 'USD') || rows[0];
  if (!usd) return null;
  return readNumber(usd.buyingPower, usd.currentBalance);
}

export class PolymarketUsTradingClient {
  constructor({
    apiBaseUrl = US_API_BASE,
    accessKey = '',
    secretKey = '',
    requestTimeoutMs = 12000,
    fetchImpl,
    now = () => Date.now()
  } = {}) {
    this.apiBaseUrl = apiBaseUrl;
    this.accessKey = accessKey;
    this.secretKey = secretKey;
    this.requestTimeoutMs = requestTimeoutMs;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.line = 'polymarket_us';
  }

  async request(method, path, { query, body } = {}) {
    const headers = createUsAuthHeaders({
      accessKey: this.accessKey,
      secretKey: this.secretKey,
      method,
      path: new URL(path, `${this.apiBaseUrl.replace(/\/$/, '')}/`).pathname,
      timestamp: this.now()
    });
    const { data } = await usRequest({
      baseUrl: this.apiBaseUrl,
      method,
      path,
      query,
      body,
      headers,
      timeoutMs: this.requestTimeoutMs,
      fetchImpl: this.fetchImpl,
      label: '美国盘交易'
    });
    return data;
  }

  createOrder(body) {
    return this.request('POST', US_ORDER_PATHS.create, { body });
  }

  previewOrder(body) {
    return this.request('POST', US_ORDER_PATHS.preview, { body });
  }

  listOpenOrders(query) {
    return this.request('GET', US_ORDER_PATHS.open, { query });
  }

  getOrder(orderId) {
    return this.request('GET', `${US_ORDER_PATHS.order}/${encodeURIComponent(orderId)}`);
  }

  cancelOrder(orderId, body = {}) {
    return this.request('POST', `${US_ORDER_PATHS.order}/${encodeURIComponent(orderId)}/cancel`, { body });
  }

  cancelAllOpenOrders(body = {}) {
    return this.request('POST', US_ORDER_PATHS.cancelAll, { body });
  }

  closePosition(body) {
    return this.request('POST', '/v1/order/close-position', { body });
  }

  getPositions(query) {
    return this.request('GET', US_ORDER_PATHS.positions, { query });
  }

  getActivities(query) {
    return this.request('GET', US_ORDER_PATHS.activities, { query });
  }

  getBalances() {
    return this.request('GET', US_ORDER_PATHS.balances);
  }
}
