import {
  AssetType,
  ClobClient,
  CONDITIONAL_TOKEN_DECIMALS,
  OrderType,
  Side,
  Chain
} from '@polymarket/clob-client-v2';
import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import axios from 'axios';
import { assertPlan1LiveEntryPriceAllowed, resolvePlan1MaxEntryPrice } from './plan1Policy.js';
import { isPlan2Family } from './polymarketPlan2Profiles.js';

const ROUNDING_CONFIG = {
  '0.1': { price: 1, size: 2, amount: 3 },
  '0.01': { price: 2, size: 2, amount: 4 },
  '0.005': { price: 3, size: 2, amount: 5 },
  '0.0025': { price: 4, size: 2, amount: 6 },
  '0.001': { price: 3, size: 2, amount: 5 },
  '0.0001': { price: 4, size: 2, amount: 6 }
};

function clobDecimalPlaces(num) {
  if (Number.isInteger(num)) return 0;
  const arr = num.toString().split('.');
  return arr.length <= 1 ? 0 : arr[1].length;
}

function clobRoundNormal(num, decimals) {
  if (clobDecimalPlaces(num) <= decimals) return num;
  return Math.round((num + Number.EPSILON) * 10 ** decimals) / 10 ** decimals;
}

function clobRoundDown(num, decimals) {
  if (clobDecimalPlaces(num) <= decimals) return num;
  return Math.floor(num * 10 ** decimals) / 10 ** decimals;
}

function clobRoundUp(num, decimals) {
  if (clobDecimalPlaces(num) <= decimals) return num;
  return Math.ceil(num * 10 ** decimals) / 10 ** decimals;
}

export function normalizePrivateKey(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('缺少 POLYMARKET_PRIVATE_KEY。');
  const key = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('POLYMARKET_PRIVATE_KEY 必须是 32 字节 hex。');
  }
  return key;
}

export function validateLiveOrderSubmission({ config }) {
  if (!config?.liveTradingEnabled) {
    throw new Error('Polymarket 实盘下单开关未开启（POLYMARKET_LIVE_TRADING_ENABLED=false）。');
  }
  if (!config?.configured) {
    throw new Error('Polymarket CLOB 凭证未配置。');
  }
}

export async function createPolymarketClobClient(config) {
  // clob-client-v2 uses the shared axios instance without a timeout, so a
  // half-open GET/POST can otherwise freeze an entire live plan indefinitely.
  axios.defaults.timeout = Math.max(
    1000,
    Number(config?.clobRequestTimeoutMs ?? config?.requestTimeoutMs) || 15000
  );
  const account = privateKeyToAccount(normalizePrivateKey(config.privateKey));
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(config.polygonRpcUrl || 'https://polygon-rpc.com')
  });
  return new ClobClient({
    host: config.clobBaseUrl,
    chain: Chain.POLYGON,
    signer: walletClient,
    creds: {
      key: config.apiKey,
      secret: config.apiSecret,
      passphrase: config.apiPassphrase
    },
    signatureType: Number(config.signatureType ?? 3),
    funderAddress: config.funderAddress || undefined,
    throwOnError: true
  });
}

function roundConfigForTick(tickSize = '0.01') {
  return ROUNDING_CONFIG[tickSize] || ROUNDING_CONFIG['0.01'];
}

function adjustDerivedAmount(value, roundConfig) {
  let amount = value;
  if (clobDecimalPlaces(amount) > roundConfig.amount) {
    amount = clobRoundUp(amount, roundConfig.amount + 4);
    if (clobDecimalPlaces(amount) > roundConfig.amount) {
      amount = clobRoundDown(amount, roundConfig.amount);
    }
  }
  return amount;
}

function normalizeMarketBuyAmounts(price, targetUsd, roundConfig) {
  const rawPrice = clobRoundDown(Number(price), roundConfig.price);
  const budget = round2(Number(targetUsd));
  if (!Number.isFinite(rawPrice) || rawPrice <= 0 || rawPrice >= 1) {
    throw new Error('Polymarket 买入价格无效。');
  }
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error('买入金额无效。');
  }

  const rawMakerAmt = clobRoundDown(budget, roundConfig.size);
  let rawTakerAmt = rawMakerAmt / rawPrice;
  rawTakerAmt = adjustDerivedAmount(rawTakerAmt, roundConfig);
  if (rawMakerAmt < 0.5 || rawTakerAmt <= 0) {
    throw new Error(`买入金额 $${rawMakerAmt.toFixed(2)} 低于 CLOB 最小 $0.50。`);
  }
  return {
    limitPrice: rawPrice,
    shares: rawTakerAmt,
    usd: rawMakerAmt
  };
}

function normalizeLimitBuyAmounts(price, targetUsd, roundConfig) {
  const rawPrice = clobRoundNormal(Number(price), roundConfig.price);
  const budget = round2(Number(targetUsd));
  if (!Number.isFinite(rawPrice) || rawPrice <= 0 || rawPrice >= 1) {
    throw new Error('Polymarket 买入价格无效。');
  }
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error('买入金额无效。');
  }

  const step = 10 ** -roundConfig.size;
  let rawTakerAmt = clobRoundDown(budget / rawPrice, roundConfig.size);
  while (rawTakerAmt >= step) {
    const taker = clobRoundDown(rawTakerAmt, roundConfig.size);
    let rawMakerAmt = taker * rawPrice;
    rawMakerAmt = adjustDerivedAmount(rawMakerAmt, roundConfig);
    if (rawMakerAmt <= budget + 0.0001 && rawMakerAmt >= 0.5) {
      return {
        limitPrice: rawPrice,
        shares: taker,
        usd: round2(rawMakerAmt)
      };
    }
    rawTakerAmt = clobRoundDown(rawTakerAmt - step, roundConfig.size);
  }
  throw new Error(`买入金额 $${budget.toFixed(2)} 低于 CLOB 最小 $0.50。`);
}

export function normalizeClobBuyAmounts(price, targetUsd, options = {}) {
  const roundConfig = roundConfigForTick(options.tickSize);
  const marketOrder = options.marketOrder === true;
  return marketOrder
    ? normalizeMarketBuyAmounts(price, targetUsd, roundConfig)
    : normalizeLimitBuyAmounts(price, targetUsd, roundConfig);
}

export function isMarketBuyOrderType(orderType) {
  return orderType === OrderType.FAK || orderType === OrderType.FOK;
}

export const CLOB_SELL_LIQUIDATE_FACTOR = 1;

export function normalizeClobSellAmounts(price, shares, options = {}) {
  const p = round4(Number(price));
  const factor = Number(options.liquidateFactor ?? CLOB_SELL_LIQUIDATE_FACTOR) || CLOB_SELL_LIQUIDATE_FACTOR;
  let size = Math.floor(Number(shares) * factor * 10000) / 10000;
  if (!Number.isFinite(p) || p <= 0 || p >= 1) {
    throw new Error('Polymarket 卖出价格无效。');
  }
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error('卖出份额无效。');
  }
  let usd = round2(size * p);
  return { limitPrice: p, shares: size, usd };
}

export async function buildClobBuyDraft(orderDraft, client, {
  orderType = OrderType.GTC,
  marketMeta = null
} = {}) {
  const tokenId = String(orderDraft.tokenId || '');
  if (!tokenId) throw new Error('缺少 CLOB tokenId。');

  const hasCachedMarketMeta = Boolean(marketMeta?.tickSize)
    && typeof marketMeta?.negRisk === 'boolean';
  const [tickSize, negRisk] = hasCachedMarketMeta
    ? [marketMeta.tickSize, marketMeta.negRisk]
    : await Promise.all([
      client.getTickSize(tokenId),
      client.getNegRisk(tokenId)
    ]);
  const marketOrder = isMarketBuyOrderType(orderType);
  const normalized = normalizeClobBuyAmounts(
    orderDraft.limitPrice,
    orderDraft.usd ?? Number(orderDraft.limitPrice) * Number(orderDraft.shares),
    { tickSize, marketOrder }
  );
  const price = normalized.limitPrice;
  if (!Number.isFinite(normalized.shares) || normalized.shares <= 0) {
    throw new Error('份额 size 无效。');
  }

  const userOrder = marketOrder
    ? {
      tokenID: tokenId,
      price,
      side: Side.BUY,
      amount: normalized.usd
    }
    : {
      tokenID: tokenId,
      price,
      side: Side.BUY,
      size: normalized.shares
    };

  return {
    userOrder,
    isMarketOrder: marketOrder,
    createOptions: {
      tickSize,
      negRisk
    },
    meta: {
      tokenId,
      price,
      size: normalized.shares,
      usd: normalized.usd,
      tickSize,
      negRisk,
      marketOrder,
      // Version is diagnostic metadata only. Fetching it adds another network
      // round trip to every 5m live order and can consume the whole entry window.
      clobVersion: 2
    }
  };
}

async function readClobBestAsk(client, tokenId) {
  const book = await client.getOrderBook?.(String(tokenId)).catch(() => null);
  const asks = Array.isArray(book?.asks) ? book.asks : [];
  return asks
    .map((ask) => Number(ask?.price ?? ask))
    .filter((value) => Number.isFinite(value) && value > 0 && value < 1)
    .sort((left, right) => left - right)[0];
}

export async function getClobTokenBuyPrice(client, tokenId, {
  preferOrderBook = false,
  requireOrderBook = false
} = {}) {
  let price = NaN;
  if (preferOrderBook || requireOrderBook) {
    // Plan3.6 / Plan2 favorite entries: book best-ask is the truth. getPrice can
    // lag and still quote ~80–90¢ while asks are empty or already dumped.
    price = await readClobBestAsk(client, tokenId);
  }
  if (requireOrderBook) {
    if (!Number.isFinite(price) || price <= 0 || price >= 1) {
      // Do NOT fall back to getPrice: stale mid/last at 90¢ + empty asks → FAK no-match loop.
      throw new Error('当前限价未吃到卖盘：盘口暂无对手盘，稍后重试。');
    }
    return price;
  }
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    try {
      const result = await client.getPrice(String(tokenId), 'BUY');
      price = Number(result?.price ?? result);
    } catch {
      // Fall through to the order book. Some short-lived markets briefly omit getPrice.
    }
  }
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    price = await readClobBestAsk(client, tokenId);
  }
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    throw new Error('CLOB 最新买入盘口无效。');
  }
  return price;
}

/** Plan2 family live ceiling used by FAK chase (2.5/2.6 default ON for wallet safety). */
export function resolvePlan2FakChaseCeiling(draft = {}, config = {}) {
  const planId = String(draft?.planId || '').toLowerCase();
  // Plan2.5 / Plan2.6: live entry-max ON unless explicitly disabled (paper-parity chase opt-out).
  if (planId === 'plan2_5' && config?.plan2_5LiveEntryMaxEnabled === false) {
    return null;
  }
  if (planId === 'plan2_6' && config?.plan2_6LiveEntryMaxEnabled === false) {
    return null;
  }
  const draftMax = Number(draft?.maxLivePrice);
  if (Number.isFinite(draftMax) && draftMax > 0) return draftMax;
  if (planId === 'plan2_6') {
    const max = Number(config?.plan2_6EntryMaxPrice ?? config?.plan2_6EntryHardMaxPrice);
    return Number.isFinite(max) && max > 0 ? max : 0.90;
  }
  if (planId === 'plan13') {
    const max = Number(config?.plan13EntryMaxPrice ?? config?.plan13EntryHardMaxPrice);
    return Number.isFinite(max) && max > 0 ? max : 0.92;
  }
  if (planId === 'plan2_5') {
    const max = Number(config?.plan2_5EntryMaxPrice ?? config?.plan2_5EntryHardMaxPrice);
    if (Number.isFinite(max) && max > 0) return max;
    return 0.88;
  }
  const shared = Number(config?.plan2EntryMaxPrice);
  return Number.isFinite(shared) && shared > 0 ? shared : null;
}

/**
 * Reject collapsed favorites (e.g. signal 90¢ → book 34¢) while still allowing
 * small ask refreshes / upward chase within the strategy ceiling.
 */
export function assertPlan2LiveAskAllowed(draft = {}, bookAsk, config = {}) {
  const price = Number(bookAsk);
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    throw new Error('当前限价未吃到卖盘：盘口暂无对手盘，稍后重试。');
  }
  const planId = String(draft?.planId || '').toLowerCase();
  const planLabel = planId === 'plan13'
    ? 'Plan13'
    : (planId === 'plan2_6' ? 'Plan2.6' : (planId === 'plan2_5' ? 'Plan2.5' : 'Plan2'));
  const ceiling = resolvePlan2FakChaseCeiling(draft, config);
  if (Number.isFinite(ceiling) && ceiling > 0 && price > ceiling + 1e-9) {
    throw new Error(
      `${planLabel} 盘口卖一 ${(price * 100).toFixed(2)}¢ 超过入场上限 ${(ceiling * 100).toFixed(2)}¢，放弃追价。`
    );
  }
  const intended = Number(draft?.intendedLimitPrice ?? draft?.limitPrice);
  if (!Number.isFinite(intended) || intended <= 0) return price;
  const dropAbs = Math.max(0, intended - price);
  const configuredMaxDropAbs = Number(config?.plan2LiveMaxAdversePriceDropAbs);
  const maxAdverseDropAbs = Number.isFinite(configuredMaxDropAbs)
    ? Math.max(0, configuredMaxDropAbs)
    : 0.15;
  const configuredMaxDropPct = Number(config?.plan2LiveMaxAdversePriceDropPct);
  const maxAdverseDropPct = Number.isFinite(configuredMaxDropPct)
    ? Math.min(0.95, Math.max(0, configuredMaxDropPct))
    : 0.30;
  const dropLimit = Math.max(maxAdverseDropAbs, intended * maxAdverseDropPct);
  if (dropAbs > dropLimit + 1e-9) {
    throw new Error(
      `${planLabel} 决策价 ${(intended * 100).toFixed(1)}¢ 已跌至盘口 ${(price * 100).toFixed(1)}¢（跌 ${(dropAbs * 100).toFixed(1)}¢），超过允许回撤 ${(dropLimit * 100).toFixed(1)}¢；拒绝追崩价票。`
    );
  }
  return price;
}

export function resolveLiveBuyOrderType(config = {}) {
  const raw = String(config.liveBuyOrderType || process.env.POLYMARKET_LIVE_BUY_ORDER_TYPE || 'FAK').toUpperCase();
  if (raw === 'GTC') return OrderType.GTC;
  if (raw === 'FOK') return OrderType.FOK;
  if (raw === 'GTD') return OrderType.GTD;
  return OrderType.FAK;
}

export function extractClobTransactionHashes(response) {
  const hashes = response?.transactionsHashes || response?.transactionHashes || [];
  return Array.isArray(hashes) ? hashes.filter(Boolean) : [];
}

export function hasClobTransactionHashes(response) {
  return extractClobTransactionHashes(response).length > 0;
}

export function isClobOrderFilled(response) {
  const status = String(response?.status || '').toLowerCase();
  if (status === 'matched' || status === 'filled' || status.endsWith('_matched') || status.endsWith('_filled')) {
    return true;
  }
  return hasClobTransactionHashes(response);
}

/**
 * Strong buy-fill confirmation for live accounting/UI.
 * CLOB can return status=matched (+ even making/taking amounts) during timeouts
 * without a funder-wallet trade. Require a tx hash before treating as filled;
 * otherwise keep the order pending for getOrder sync.
 */
export function isClobBuyFillConfirmed(response) {
  return isClobOrderFilled(response) && hasClobTransactionHashes(response);
}

export function isClobBuyFillAwaitingConfirm(response) {
  return isClobOrderFilled(response) && !isClobBuyFillConfirmed(response);
}

export function isClobOrderTerminal(response) {
  const status = String(response?.status || '').toLowerCase();
  return /(^|_)(matched|filled|cancelled|canceled|expired|closed)(_|$)|market_resolved|resolved/.test(status);
}

function normalizeOpenOrderShares(value, referenceShares = null) {
  let shares = Number(value);
  if (!Number.isFinite(shares) || shares < 0) return 0;
  const reference = Number(referenceShares);
  // Some REST schemas expose fixed-math 1e6 integers while the JS SDK normally
  // returns decimal share strings. Use the known local order size to distinguish.
  if (Number.isFinite(reference) && reference > 0 && shares > reference * 1000) {
    shares /= 1e6;
  }
  return shares;
}

export function extractClobOpenOrderProgress(response, referenceShares = null) {
  const originalShares = normalizeOpenOrderShares(
    response?.original_size ?? response?.originalSize,
    referenceShares
  ) || Math.max(0, Number(referenceShares) || 0);
  let matchedShares = normalizeOpenOrderShares(
    response?.size_matched ?? response?.sizeMatched,
    originalShares || referenceShares
  );
  if (matchedShares <= 0 && isClobOrderFilled(response)) {
    matchedShares = originalShares;
  }
  matchedShares = Math.min(originalShares || matchedShares, matchedShares);
  return {
    originalShares,
    matchedShares,
    remainingShares: Math.max(0, originalShares - matchedShares),
    price: Number(response?.price) || null,
    terminal: isClobOrderTerminal(response),
    filled: originalShares > 0 && matchedShares >= originalShares - 0.0001
  };
}

export function extractClobFillAmounts(response, side = 'BUY') {
  const makingAmount = Number(response?.makingAmount);
  const takingAmount = Number(response?.takingAmount);
  if (
    !Number.isFinite(makingAmount)
    || makingAmount <= 0
    || !Number.isFinite(takingAmount)
    || takingAmount <= 0
  ) {
    return null;
  }
  const normalizedSide = String(side || 'BUY').toUpperCase();
  return normalizedSide === 'SELL'
    ? { shares: makingAmount, usd: takingAmount }
    : { shares: takingAmount, usd: makingAmount };
}

export function conditionalBalanceToShares(rawBalance) {
  const raw = Number(rawBalance);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw / 10 ** CONDITIONAL_TOKEN_DECIMALS;
}

export async function getConditionalTokenBalance(client, tokenId) {
  await client.updateBalanceAllowance({
    asset_type: AssetType.CONDITIONAL,
    token_id: String(tokenId)
  });
  const result = await client.getBalanceAllowance({
    asset_type: AssetType.CONDITIONAL,
    token_id: String(tokenId)
  });
  return conditionalBalanceToShares(result?.balance);
}

export function sanitizeClobErrorText(text, { code = null } = {}) {
  const raw = String(text || '');
  const looksSecret = /POLY_API_KEY|POLY_PASSPHRASE|POLY_SIGNATURE|POLY_ADDRESS|private[_-]?key|api[_-]?secret|passphrase/i.test(raw)
    || /"config"\s*:\s*\{/.test(raw)
    || /"headers"\s*:\s*\{/.test(raw);
  const looksDump = raw.length > 400 && (/AggregateError|AxiosError|"stack"\s*:/.test(raw));
  if (looksSecret || looksDump) {
    if (/ETIMEDOUT|timeout/i.test(raw) || code === 'ETIMEDOUT') {
      return 'CLOB 网络超时，请稍后重试。';
    }
    if (/ECONNRESET|ENOTFOUND|ECONNREFUSED|network/i.test(raw)) {
      return 'CLOB 网络错误，请稍后重试。';
    }
    return 'CLOB 请求失败（错误详情已脱敏）。';
  }
  return raw;
}

export function humanizeClobError(error, context = {}) {
  const code = error?.code || error?.cause?.code || null;
  // Empty Axios message is falsy — avoid String(errorObject) dumping huge stacks/secrets.
  const rawMessage = error?.message != null && String(error.message).trim() !== ''
    ? String(error.message)
    : (typeof error === 'string' ? error : (code ? `CLOB error ${code}` : 'CLOB 请求失败'));
  const msg = sanitizeClobErrorText(rawMessage, { code });
  const rawMatch = msg.match(/balance:\s*(\d+),\s*order amount:\s*(\d+)/i);
  if (rawMatch) {
    const balanceShares = conditionalBalanceToShares(rawMatch[1]);
    const orderShares = conditionalBalanceToShares(rawMatch[2]);
    const need = Number(context.shares) || orderShares;
    return `条件 token 余额 ${balanceShares.toFixed(2)} 份，无法卖出 ${need.toFixed(2)} 份（CLOB 原始单位 balance=${rawMatch[1]}, amount=${rawMatch[2]}，÷1e6=份数）。买单可能尚未成交。`;
  }
  if (/invalid amounts.*2 decimals/i.test(msg)) {
    return 'FAK 买单 USDC 金额须为 2 位小数（已改用 market 下单 API 对齐精度）。';
  }
  if (/invalid maker amount/i.test(msg)) {
    const shares = Number(context.shares);
    const hint = Number.isFinite(shares) && shares > 0
      ? `（持仓约 ${shares.toFixed(4)} 份，低于 CLOB 可卖最小量）`
      : '（份额过小或金额精度无效）';
    return `CLOB 拒绝：invalid maker amount${hint}。过小仓位无法市价卖出，将按灰尘仓处理以免死循环。`;
  }
  if (/no orders found to match|当前限价未吃到卖盘|盘口暂无对手盘/i.test(msg)) {
    return 'FAK 即时成交失败：当前价位暂无对手盘，系统会在下一轮继续重试。';
  }
  if (/post-only mode/i.test(msg)) {
    return '账户处于 post-only 限制：只能挂 maker 单，FAK/吃单会被拒。请在 Polymarket 关闭 post-only / 安全模式后再开实盘。';
  }
  if (/order manager not ready/i.test(msg)) {
    return 'CLOB order manager 未就绪，本轮跳过，下一 tick 自动重试。';
  }
  if (/not enough balance\s*\/\s*allowance/i.test(msg)) {
    return 'CLOB 卖单校验失败（余额/授权缓存未同步，常见于买单刚成交）。系统会按可用份额继续重试。';
  }
  if (/ETIMEDOUT|timeout/i.test(msg) || code === 'ETIMEDOUT') {
    return 'CLOB 网络超时，请稍后重试。';
  }
  return sanitizeClobErrorText(msg, { code });
}

export function formatClobErrorMessage(error, context = {}) {
  return humanizeClobError(error, context);
}

export function isFakNoMatchError(error) {
  return /no orders found to match/i.test(String(error?.message || error || ''));
}

export function isInvalidAmountsError(error) {
  return /invalid amounts/i.test(String(error?.message || error || ''));
}

export function isInvalidMakerAmountError(error) {
  return /invalid maker amount/i.test(String(error?.message || error || ''));
}

/** CLOB 卖单通常需要约 ≥5 份；更小基本卖不出。 */
export function isUnsellableDustShares(shares, minShares = 5) {
  const size = Number(shares);
  const floor = Math.max(1, Number(minShares) || 5);
  return !Number.isFinite(size) || size <= 0 || size < floor;
}

function bumpPrice(price, tickSize, steps = 1) {
  const tick = Number(tickSize) || 0.01;
  return round4(Math.min(0.99, Number(price) + tick * steps));
}

export async function submitClobBuyOrder(client, clobDraft, orderType = OrderType.FAK) {
  if (clobDraft.isMarketOrder) {
    return client.createAndPostMarketOrder(
      clobDraft.userOrder,
      clobDraft.createOptions,
      orderType
    );
  }
  return client.createAndPostOrder(
    clobDraft.userOrder,
    clobDraft.createOptions,
    orderType
  );
}

export function resolveLiveBuyFakBumpSteps(planId, config = {}, draft = null) {
  const id = String(planId || '').toLowerCase();
  const timeframe = String(draft?.timeframe || '').toLowerCase();
  if (id === 'plan5') {
    // The executable ask can move between direction lock and submission. Retry
    // progressively more marketable FAK prices inside the same request.
    // Default 8：网页能吃到但实盘 FAK 无对手盘时，同请求内多档追 ask。
    const configured = Number(config?.plan5LiveFakBumpSteps);
    return Math.max(0, Math.min(12, Number.isFinite(configured) ? configured : 8));
  }
  if (id === 'plan2' || id === 'plan2_5' || id === 'plan2_6' || id === 'plan13') {
    // Plan2/2.5/2.6 激进成交：同请求内多档追 ask；5m 默认 10，其它默认 8。
    const configured5m = Number(config?.plan2LiveFakBumpSteps5m);
    const configured = Number(config?.plan2LiveFakBumpSteps);
    if (timeframe === '5m') {
      return Math.max(
        0,
        Math.min(12, Number.isFinite(configured5m) ? configured5m : (Number.isFinite(configured) ? configured : 10))
      );
    }
    return Math.max(0, Math.min(12, Number.isFinite(configured) ? configured : 8));
  }
  if (id === 'plan3_6') {
    // Favorite 75–92¢：无对手盘时需刷新 ask 并多档追价（默认对齐 Plan5）
    return Math.max(1, Math.min(12, Number(
      config?.plan3_6LiveFakBumpSteps ?? config?.plan3LiveFakBumpSteps
    ) || 8));
  }
  if (id === 'plan3') {
    return Math.max(1, Math.min(10, Number(config?.plan3LiveFakBumpSteps) || 4));
  }
  // Plan1 等策略保留多档 bump；Plan5 已在上方走专用即时路径。
  return Math.max(1, Math.min(10, Number(config?.liveFakBumpSteps) || 6));
}

function resolvePlan36FakPriceBounds(draft, config = {}) {
  const favoriteMin = Number(config?.plan3_6FavoriteMinPrice ?? 0.75);
  const liveMin = Number(config?.plan3_6LiveMinPrice ?? favoriteMin);
  const floor = Math.max(
    0.50,
    Number.isFinite(Number(draft?.minLivePrice)) ? Number(draft.minLivePrice) : 0,
    Number.isFinite(favoriteMin) ? favoriteMin : 0.75,
    Number.isFinite(liveMin) ? liveMin : 0
  );
  const favoriteMax = Number(config?.plan3_6FavoriteMaxPrice ?? 0.85);
  const configuredMax = Number(draft?.maxLivePrice);
  const ceiling = Math.min(
    0.99,
    Math.max(
      floor,
      Number.isFinite(configuredMax) ? configuredMax : (Number.isFinite(favoriteMax) ? favoriteMax : 0.85)
    )
  );
  return { floor, ceiling };
}

function resolvePlan5FakPriceFloor(draft, config = {}) {
  const hardMin = Number(config?.plan5HardMinEntryPrice);
  const softMin = Number(config?.plan5MinEntryPrice);
  return Math.max(
    0.35,
    Number.isFinite(Number(draft?.minLivePrice)) ? Number(draft.minLivePrice) : 0,
    Number.isFinite(hardMin) ? Math.min(0.49, Math.max(0.05, hardMin)) : 0.35,
    // Live FAK must not walk into sub-50¢ junk when the soft floor is enabled.
    Number.isFinite(softMin) && softMin > 0 ? Math.min(0.70, softMin) : 0
  );
}

function assertPlan5AskNotJunk(draft, bookAsk, config = {}) {
  const price = Number(bookAsk);
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    throw new Error('Plan5 下单前盘口卖一无效，拒绝提交以免 FAK 吃进崩价票。');
  }
  const floor = resolvePlan5FakPriceFloor(draft, config);
  if (price + 1e-9 < floor) {
    throw new Error(
      `Plan5 拒绝崩价票：盘口卖一 ${(price * 100).toFixed(2)}¢ 低于硬下限 ${(floor * 100).toFixed(0)}¢。`
    );
  }
  const intended = Number(draft?.intendedLimitPrice ?? draft?.limitPrice);
  if (!Number.isFinite(intended) || intended <= 0) return price;
  const dropAbs = Math.max(0, intended - price);
  const configuredMaxDropAbs = Number(config?.plan5LiveMaxAdversePriceDropAbs);
  const maxAdverseDropAbs = Number.isFinite(configuredMaxDropAbs)
    ? Math.max(0, configuredMaxDropAbs)
    : 0.12;
  const configuredMaxDropPct = Number(config?.plan5LiveMaxAdversePriceDropPct);
  const maxAdverseDropPct = Number.isFinite(configuredMaxDropPct)
    ? Math.min(0.95, Math.max(0, configuredMaxDropPct))
    : 0.25;
  const dropLimit = Math.max(maxAdverseDropAbs, intended * maxAdverseDropPct);
  if (dropAbs > dropLimit + 1e-9) {
    throw new Error(
      `Plan5 拒绝崩价票：决策价 ${(intended * 100).toFixed(1)}¢ 已跌至盘口 ${(price * 100).toFixed(1)}¢（跌 ${(dropAbs * 100).toFixed(1)}¢），超过允许回撤 ${(dropLimit * 100).toFixed(1)}¢。`
    );
  }
  return price;
}

export async function submitClobBuyOrderWithFallback(client, draft, config) {
  const primaryType = resolveLiveBuyOrderType(config);
  let workingDraft = draft;
  const planId = String(draft?.planId || '').toLowerCase();
  // Plan3.6: never submit a FAK ceiling that can walk into junk asks.
  if (planId === 'plan3_6') {
    const { floor, ceiling } = resolvePlan36FakPriceBounds(draft, config);
    const bookAsk = await getClobTokenBuyPrice(client, draft.tokenId, { preferOrderBook: true }).catch(() => NaN);
    if (Number.isFinite(bookAsk) && bookAsk + 1e-9 < floor) {
      throw new Error(
        `Plan3.6 拒绝廉价侧/崩价票：盘口卖一 ${(bookAsk * 100).toFixed(2)}¢ 低于热门侧硬下限 ${(floor * 100).toFixed(0)}¢。`
      );
    }
    const limit = Number(draft?.limitPrice);
    if (Number.isFinite(limit) && limit + 1e-9 < floor) {
      throw new Error(
        `Plan3.6 限价 ${(limit * 100).toFixed(2)}¢ 低于热门侧硬下限 ${(floor * 100).toFixed(0)}¢，禁止买入廉价侧。`
      );
    }
    if (Number.isFinite(bookAsk)) {
      workingDraft = {
        ...draft,
        limitPrice: round4(Math.min(ceiling, Math.max(limit || bookAsk, bookAsk))),
        maxLivePrice: ceiling,
        minLivePrice: floor
      };
    } else {
      workingDraft = { ...draft, maxLivePrice: ceiling, minLivePrice: floor };
    }
  }
  // Plan5: same class of bug — FAK limit is a ceiling. Stale getPrice ~69¢ +
  // collapsed book ask ~23¢ → full junk fill. Gate on book ask at submit time.
  if (planId === 'plan5') {
    const bookAsk = await getClobTokenBuyPrice(client, draft.tokenId, { preferOrderBook: true }).catch(() => NaN);
    assertPlan5AskNotJunk(draft, bookAsk, config);
    const floor = resolvePlan5FakPriceFloor(draft, config);
    workingDraft = {
      ...draft,
      minLivePrice: Math.max(floor, Number(draft?.minLivePrice) || 0)
    };
  }
  // Plan2/2.5/2.6: cancel+requote at live book ask. Never sit on a stale signal
  // limit (e.g. 90¢) when asks are empty or have already moved.
  if (planId === 'plan2' || planId === 'plan2_5' || planId === 'plan2_6' || planId === 'plan13') {
    const bookAsk = await getClobTokenBuyPrice(client, draft.tokenId, {
      preferOrderBook: true,
      requireOrderBook: true
    });
    assertPlan2LiveAskAllowed(draft, bookAsk, config);
    const ceiling = resolvePlan2FakChaseCeiling(draft, config);
    const executable = Number.isFinite(ceiling) && ceiling > 0
      ? round4(Math.min(ceiling, bookAsk))
      : round4(bookAsk);
    workingDraft = {
      ...draft,
      intendedLimitPrice: Number(draft?.intendedLimitPrice ?? draft?.limitPrice) || null,
      limitPrice: executable,
      maxLivePrice: Number.isFinite(ceiling) && ceiling > 0 ? ceiling : undefined,
      executionPreflightPrice: bookAsk,
      executionPreflightAtIso: new Date().toISOString()
    };
    if (!(Number.isFinite(ceiling) && ceiling > 0)) {
      delete workingDraft.maxLivePrice;
    }
  }
  // Plan1: 决策侧已有 max entry，但 FAK 成交/追价可能吃到 70–97¢；提交前按盘口再硬卡一次。
  if (planId === 'plan1') {
    const ceiling = resolvePlan1MaxEntryPrice(draft?.timeframe || '15m', config);
    assertPlan1LiveEntryPriceAllowed(draft?.limitPrice, draft?.timeframe || '15m', config);
    const bookAsk = await getClobTokenBuyPrice(client, draft.tokenId, {
      preferOrderBook: true
    }).catch(() => NaN);
    if (Number.isFinite(bookAsk)) {
      assertPlan1LiveEntryPriceAllowed(bookAsk, draft?.timeframe || '15m', config);
      const intended = Number(draft?.intendedLimitPrice ?? draft?.limitPrice);
      const executable = round4(Math.min(
        Number.isFinite(ceiling) && ceiling > 0 ? ceiling : bookAsk,
        Math.max(Number.isFinite(intended) ? intended : bookAsk, bookAsk)
      ));
      assertPlan1LiveEntryPriceAllowed(executable, draft?.timeframe || '15m', config);
      workingDraft = {
        ...draft,
        intendedLimitPrice: Number.isFinite(intended) ? intended : null,
        limitPrice: executable,
        maxLivePrice: Number.isFinite(ceiling) && ceiling > 0 ? ceiling : undefined,
        executionPreflightPrice: bookAsk,
        executionPreflightAtIso: new Date().toISOString()
      };
    } else {
      workingDraft = {
        ...draft,
        maxLivePrice: Number.isFinite(ceiling) && ceiling > 0 ? ceiling : undefined
      };
    }
    if (!(Number.isFinite(Number(workingDraft.maxLivePrice)) && Number(workingDraft.maxLivePrice) > 0)) {
      delete workingDraft.maxLivePrice;
    }
  }
  let clobDraft = await buildClobBuyDraft(workingDraft, client, { orderType: primaryType });
  const timeframe = String(workingDraft?.timeframe || draft?.timeframe || '').toLowerCase();
  const plan2ImmediateOnly5m = (planId === 'plan2' || planId === 'plan2_5' || planId === 'plan2_6' || planId === 'plan13')
    && timeframe === '5m'
    && config?.plan2LiveImmediateOnly5m !== false;
  const immediateOnly = planId === 'plan8'
    || (planId === 'plan5' && config?.plan5LiveImmediateOnly !== false)
    || ((planId === 'plan3' || planId === 'plan3_6') && config?.plan3LiveImmediateOnly !== false)
    || plan2ImmediateOnly5m;
  const maxFakBumpSteps = resolveLiveBuyFakBumpSteps(planId, config, workingDraft);
  try {
    const response = await submitClobBuyOrder(client, clobDraft, primaryType);
    return {
      response,
      clobDraft,
      orderType: primaryType,
      filled: isClobBuyFillConfirmed(response),
      awaitingConfirm: isClobBuyFillAwaitingConfirm(response),
      retried: null,
      fallback: false
    };
  } catch (error) {
    if (isInvalidAmountsError(error) && !clobDraft.isMarketOrder) {
      clobDraft = await buildClobBuyDraft(workingDraft, client, { orderType: OrderType.FAK });
      const response = await submitClobBuyOrder(client, clobDraft, primaryType);
      return {
        response,
        clobDraft,
        orderType: primaryType,
        filled: isClobBuyFillConfirmed(response),
        awaitingConfirm: isClobBuyFillAwaitingConfirm(response),
        retried: 'market-order',
        fallback: false
      };
    }
    if (!isFakNoMatchError(error) || primaryType !== OrderType.FAK) {
      throw error;
    }
    const tickSize = clobDraft.meta?.tickSize || clobDraft.createOptions?.tickSize || '0.01';
    // Number(null) === 0 — must require > 0 or Plan2.5 (no ceiling) aborts every bump.
    const configuredMaxPrice = Number(workingDraft?.maxLivePrice);
    const plan36Bounds = planId === 'plan3_6' ? resolvePlan36FakPriceBounds(workingDraft, config) : null;
    const plan5Floor = planId === 'plan5' ? resolvePlan5FakPriceFloor(workingDraft, config) : null;
    const plan2EntryMax = isPlan2Family(planId)
      ? resolvePlan2FakChaseCeiling(workingDraft, config)
      : null;
    const plan1EntryMax = planId === 'plan1'
      ? resolvePlan1MaxEntryPrice(workingDraft?.timeframe || draft?.timeframe || '15m', config)
      : null;
    const maxBumpPrice = Number.isFinite(configuredMaxPrice) && configuredMaxPrice > 0
      ? configuredMaxPrice
      : planId === 'plan3_6'
        // BUGFIX: 旧逻辑误用 cheap-side plan3_6MaxPrice(20¢)，热门侧 75–92¢ 的 bump 全被掐死
        ? plan36Bounds.ceiling
        : planId === 'plan8'
          ? (Number(config?.plan8MaxPrice) || 0.80)
          : Number.isFinite(plan2EntryMax) && plan2EntryMax > 0
            ? plan2EntryMax
            : Number.isFinite(plan1EntryMax) && plan1EntryMax > 0
              ? plan1EntryMax
              : null;
    const minBumpPrice = planId === 'plan3_6'
      ? plan36Bounds.floor
      : planId === 'plan5'
        ? plan5Floor
        : null;
    let lastFakError = error;
    let bumpedDraft = workingDraft;
    let bumpedClobDraft = clobDraft;
    // Plan5 / Plan3.6 / Plan2：每次 bump 前刷新 ask。盘口在 FAK 拒单后常已跳价。
    const refreshAskPlans = planId === 'plan5'
      || planId === 'plan3_6'
      || planId === 'plan1'
      || planId === 'plan2'
      || planId === 'plan2_5'
      || planId === 'plan2_6'
      || planId === 'plan13';
    const plan2Family = isPlan2Family(planId);
    for (let step = 1; step <= maxFakBumpSteps; step += 1) {
      const freshPrice = await getClobTokenBuyPrice(client, workingDraft.tokenId, {
        preferOrderBook: refreshAskPlans,
        requireOrderBook: plan2Family
      }).catch((askError) => {
        // Plan2: empty book mid-chase → stop blind-bumping a stale 90¢ ceiling.
        if (plan2Family) {
          lastFakError = askError;
          return NaN;
        }
        return NaN;
      });
      if (plan2Family && !Number.isFinite(freshPrice)) {
        throw lastFakError;
      }
      if (planId === 'plan3_6' && Number.isFinite(freshPrice) && Number.isFinite(minBumpPrice)
        && freshPrice + 1e-9 < minBumpPrice) {
        throw new Error(
          `Plan3.6 FAK 重试中盘口已崩至 ${(freshPrice * 100).toFixed(2)}¢，低于热门侧硬下限 ${(minBumpPrice * 100).toFixed(0)}¢；停止追价。`
        );
      }
      if (planId === 'plan5' && Number.isFinite(freshPrice)) {
        assertPlan5AskNotJunk(workingDraft, freshPrice, config);
      }
      if (planId === 'plan1' && Number.isFinite(freshPrice)) {
        assertPlan1LiveEntryPriceAllowed(
          freshPrice,
          workingDraft?.timeframe || draft?.timeframe || '15m',
          config
        );
      }
      if (plan2Family && Number.isFinite(freshPrice)) {
        assertPlan2LiveAskAllowed(workingDraft, freshPrice, config);
      }
      const blindBump = bumpPrice(clobDraft.userOrder.price, tickSize, step);
      const askChaseTicks = refreshAskPlans
        ? Math.max(2, Math.min(4, step + 1))
        : 0;
      const executableFreshPrice = refreshAskPlans && Number.isFinite(freshPrice)
        ? bumpPrice(freshPrice, tickSize, askChaseTicks)
        : freshPrice;
      const nextPrice = Number.isFinite(freshPrice)
        ? round4(Math.max(blindBump, executableFreshPrice))
        : blindBump;
      if (Number.isFinite(maxBumpPrice) && nextPrice > maxBumpPrice + 1e-9) {
        break;
      }
      if (Number.isFinite(minBumpPrice) && nextPrice + 1e-9 < minBumpPrice) {
        throw new Error(
          planId === 'plan5'
            ? `Plan5 追价 ${(nextPrice * 100).toFixed(2)}¢ 低于硬下限 ${(minBumpPrice * 100).toFixed(0)}¢；禁止吃崩价票。`
            : `Plan3.6 追价 ${(nextPrice * 100).toFixed(2)}¢ 低于热门侧硬下限 ${(minBumpPrice * 100).toFixed(0)}¢；禁止买廉价侧。`
        );
      }
      bumpedDraft = {
        ...workingDraft,
        limitPrice: nextPrice
      };
      bumpedClobDraft = await buildClobBuyDraft(bumpedDraft, client, {
        orderType: OrderType.FAK,
        marketMeta: clobDraft.meta
      });
      try {
        const response = await submitClobBuyOrder(client, bumpedClobDraft, OrderType.FAK);
        return {
          response,
          clobDraft: bumpedClobDraft,
          orderType: OrderType.FAK,
          filled: isClobBuyFillConfirmed(response),
          awaitingConfirm: isClobBuyFillAwaitingConfirm(response),
          retried: step === 1 ? 'fak-price-bump' : `fak-price-bump-${step}`,
          fallback: false
        };
      } catch (error2) {
        if (!isFakNoMatchError(error2)) throw error2;
        lastFakError = error2;
      }
    }
    if (immediateOnly) {
      throw lastFakError;
    }
    const gtcDraft = await buildClobBuyDraft(bumpedDraft, client, { orderType: OrderType.GTC });
    const response = await submitClobBuyOrder(client, gtcDraft, OrderType.GTC);
    return {
      response,
      clobDraft: gtcDraft,
      orderType: OrderType.GTC,
      filled: isClobBuyFillConfirmed(response),
      awaitingConfirm: isClobBuyFillAwaitingConfirm(response),
      retried: 'gtc-fallback',
      fallback: true
    };
  }
}

export async function syncConditionalTokenAllowance(client, tokenId) {
  await client.updateBalanceAllowance({
    asset_type: AssetType.CONDITIONAL,
    token_id: String(tokenId)
  });
  return client.getBalanceAllowance({
    asset_type: AssetType.CONDITIONAL,
    token_id: String(tokenId)
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchConditionalTokenState(client, tokenId, {
  retries = 4,
  delayMs = 2500
} = {}) {
  let last = { balance: '0', allowance: '0' };
  for (let attempt = 0; attempt < retries; attempt++) {
    last = await syncConditionalTokenAllowance(client, tokenId);
    const shares = conditionalBalanceToShares(last?.balance);
    if (shares > 0) break;
    if (attempt < retries - 1) await sleep(delayMs);
  }
  return {
    raw: last,
    shares: conditionalBalanceToShares(last?.balance),
    allowanceShares: conditionalBalanceToShares(last?.allowance)
  };
}

export async function warmConditionalTokenForSell(client, tokenId, {
  expectedShares = null,
  retries = 6,
  delayMs = 3000
} = {}) {
  const state = await fetchConditionalTokenState(client, tokenId, { retries, delayMs });
  const need = Number(expectedShares);
  if (Number.isFinite(need) && need > 0 && state.shares + 1e-6 < need * 0.90) {
    return { ...state, ready: false, reason: 'balance-below-expected' };
  }
  return {
    ...state,
    ready: state.shares > 0,
    reason: state.shares > 0 ? 'balance-ready' : 'balance-zero'
  };
}

export async function ensureConditionalSellReady(client, tokenId, minShares, options = {}) {
  const strictAllowance = options.strictAllowance === true;
  const state = await fetchConditionalTokenState(client, tokenId, options);
  const rawBalance = String(state.raw?.balance || '0');
  const shares = state.shares;
  const allowanceShares = state.allowanceShares;
  const need = round4(Number(minShares) || 0);
  if (!Number.isFinite(shares) || shares <= 0) {
    const rawAmount = Math.round(need * 10 ** CONDITIONAL_TOKEN_DECIMALS);
    throw new Error(
      `条件 token 余额 0 份，无法卖出 ${need.toFixed(2)} 份（CLOB raw: balance=0, amount=${rawAmount}，÷1e6=份数）。买单可能尚未到账，系统将稍后重试。`
    );
  }
  if (need > 0 && shares + 1e-6 < need * 0.90) {
    const rawAmount = Math.round(need * 10 ** CONDITIONAL_TOKEN_DECIMALS);
    throw new Error(
      `条件 token 余额 ${shares.toFixed(2)} 份，不足卖出 ${need.toFixed(2)} 份（CLOB raw: balance=${rawBalance}, amount=${rawAmount}）。`
    );
  }
  // Magic/proxy 钱包在 CLOB 里 allowance 常显示 0，但 balance 足够时仍可能成交。
  if (strictAllowance && need > 0 && allowanceShares + 1e-6 < need * 0.99) {
    throw new Error(
      `条件 token 授权 ${allowanceShares.toFixed(2)} 份不足，无法卖出 ${need.toFixed(2)} 份。`
    );
  }
  return shares;
}

export function isSellRetryableError(error) {
  const msg = String(error?.message || error || '');
  return /授权|allowance|balance|余额|not enough balance|条件 token|缓存未同步|买单可能尚未/i.test(msg);
}

export function isSellLiquidityError(error) {
  const msg = String(error?.message || error || '');
  return /no orders found to match|FAK 即时成交失败|暂无对手盘/i.test(msg);
}

export async function submitClobSellOrderWithFallback(client, draft, config = {}) {
  const tokenId = String(draft?.tokenId || '');
  if (!tokenId) throw new Error('缺少 CLOB tokenId。');

  const preferGtcTakeProfit = draft?.preferGtcTakeProfit === true;
  const retryDelays = preferGtcTakeProfit
    ? (Array.isArray(config.liveSellRetryDelaysMsTakeProfit) ? config.liveSellRetryDelaysMsTakeProfit : [0, 5000, 12000])
    : (Array.isArray(config.liveSellRetryDelaysMs5mStop) ? config.liveSellRetryDelaysMs5mStop : [0, 1500, 3500]);
  const liquidateFactors = Array.isArray(config.sellLiquidateFactors)
    ? config.sellLiquidateFactors
    : [CLOB_SELL_LIQUIDATE_FACTOR, 0.999, 0.99];
  const orderTypes = preferGtcTakeProfit
    ? [OrderType.GTC, OrderType.GTC, OrderType.FAK]
    : [OrderType.FAK, OrderType.FAK, OrderType.FAK];

  let lastError = null;
  for (let i = 0; i < retryDelays.length; i++) {
    if (retryDelays[i] > 0) await sleep(retryDelays[i]);
    try {
      const availableShares = await ensureConditionalSellReady(client, tokenId, 0, {
        retries: i === 0 ? 2 : 4,
        delayMs: 2500
      });
      const factor = liquidateFactors[Math.min(i, liquidateFactors.length - 1)];
      const requestedShares = Number(draft.shares) || 0;
      const effectiveShares = Math.min(requestedShares, availableShares);
      if (!Number.isFinite(effectiveShares) || effectiveShares <= 0) {
        throw new Error(`条件 token 余额 ${Number(availableShares || 0).toFixed(2)} 份，不足卖出。`);
      }
      const clobDraft = await buildClobSellDraft(
        { ...draft, shares: effectiveShares },
        client,
        { liquidateFactor: factor }
      );
      const orderType = orderTypes[Math.min(i, orderTypes.length - 1)];
      const response = await submitClobSellOrder(client, clobDraft, orderType);
      const filled = isClobOrderFilled(response);
      if (orderType === OrderType.GTC && !filled) {
        return {
          response,
          clobDraft,
          orderType,
          filled: false,
          retried: i > 0 ? `sell-retry-${i}` : null,
          liquidateFactor: factor
        };
      }
      return {
        response,
        clobDraft,
        orderType,
        filled,
        retried: i > 0 ? `sell-retry-${i}` : null,
        liquidateFactor: factor
      };
    } catch (error) {
      lastError = error;
      const retryable = isSellRetryableError(error) || isSellLiquidityError(error);
      if (!retryable || i >= retryDelays.length - 1) {
        throw error;
      }
      if (isSellRetryableError(error)) {
        await syncConditionalTokenAllowance(client, tokenId);
      }
    }
  }
  throw lastError || new Error('卖单重试失败。');
}

export async function buildClobSellDraft(orderDraft, client, options = {}) {
  const tokenId = String(orderDraft.tokenId || '');
  const normalized = normalizeClobSellAmounts(
    orderDraft.limitPrice,
    orderDraft.shares,
    { liquidateFactor: options.liquidateFactor }
  );
  const price = normalized.limitPrice;
  const size = normalized.shares;
  if (!tokenId) throw new Error('缺少 CLOB tokenId。');
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error('卖单份额 size 无效。');
  }

  const [tickSize, negRisk] = await Promise.all([
    client.getTickSize(tokenId),
    client.getNegRisk(tokenId)
  ]);

  return {
    userOrder: {
      tokenID: tokenId,
      price,
      side: Side.SELL,
      size
    },
    createOptions: {
      tickSize,
      negRisk
    },
    meta: {
      tokenId,
      price,
      size,
      usd: normalized.usd,
      tickSize,
      negRisk,
      clobVersion: 2
    }
  };
}

export async function submitClobSellOrder(client, clobDraft, orderType = OrderType.GTC) {
  return client.createAndPostOrder(
    clobDraft.userOrder,
    clobDraft.createOptions,
    orderType
  );
}

export function extractClobOrderId(response) {
  if (!response) return null;
  return response.orderID || response.orderId || response.id || null;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function round4(value) {
  return Math.round(Number(value) * 10000) / 10000;
}
