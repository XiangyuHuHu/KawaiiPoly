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

export function usdBalanceRow(payload) {
  const rows = payload?.balances
    || payload?.data?.balances
    || (payload && (payload.buyingPower != null || payload.currentBalance != null) ? [payload] : []);
  return rows.find((row) => String(row?.currency || 'USD').toUpperCase() === 'USD') || rows[0] || null;
}

/** 下单现金用 buyingPower。currentBalance 含未结算资金，不能拿来开仓。 */
export function usdBuyingPower(payload) {
  const usd = usdBalanceRow(payload);
  if (!usd) return null;
  return readNumber(usd.buyingPower, usd.currentBalance);
}

export function positionMap(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  if (payload.positions && typeof payload.positions === 'object' && !Array.isArray(payload.positions)) {
    return payload.positions;
  }
  const looksLikePosition = Object.values(payload).some((row) => row && typeof row === 'object' && (
    'netPosition' in row || 'netPositionDecimal' in row
  ));
  return looksLikePosition ? payload : {};
}

export function openOrderList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.orders)) return payload.orders;
  return [];
}

export function windowsFromPositions(payload) {
  return Object.entries(positionMap(payload)).flatMap(([slug, position]) => {
    const net = Number(position?.netPositionDecimal ?? position?.netPosition ?? 0);
    if (!Number.isFinite(net) || net === 0) return [];
    return [{ slug, windowId: slug, side: net > 0 ? 'yes' : 'no' }];
  });
}

export function windowsFromOpenOrders(payload) {
  return openOrderList(payload).flatMap((order) => {
    const intent = String(order?.intent || '');
    const side = intent === 'ORDER_INTENT_BUY_LONG' ? 'yes'
      : intent === 'ORDER_INTENT_BUY_SHORT' ? 'no'
        : null;
    const slug = order?.marketSlug || order?.slug;
    if (!side || !slug) return [];
    return [{ slug, windowId: slug, side }];
  });
}

export function summarizeUsAccount(balances, openOrders, positions) {
  const row = usdBalanceRow(balances);
  const map = positionMap(positions);
  return {
    currency: row?.currency || 'USD',
    buyingPower: row ? readNumber(row.buyingPower) : null,
    currentBalance: row ? readNumber(row.currentBalance) : null,
    openOrderCount: openOrderList(openOrders).length,
    positionSlugs: Object.keys(map)
  };
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
