/**
 * Polymarket US scan rules from SCAN_SPEC v3.3.
 * v3.2 replaced the v3 confirm-before-order flow. v3.3 tightens BTC misprice
 * after the 2026-10-15..17 settlements. Scanners write SIGNAL files and never place orders.
 * The bot may send the limit order without another chat confirmation.
 */

import {
  US_BBO_ABSURD_AGE_MS,
  US_BBO_FUTURE_TOLERANCE_MS,
  US_BBO_MAX_AGE_MS,
  US_BBO_QUIET_MOVE,
  US_BTC_MISPRICE_MAX_EDGE,
  US_BTC_MISPRICE_MAX_PRICE,
  US_BTC_MISPRICE_MIN_MODEL,
  US_BTC_MISPRICE_MIN_PRICE,
  US_BTC_MISPRICE_MODEL_WEIGHT,
  US_EDGE_BTC_MISPRICE,
  US_EXPLORATORY_MAX_EDGE,
  US_EXPLORATORY_MIN_DISTANCE_BPS,
  US_EXPLORATORY_MIN_EDGE,
  US_EXPLORATORY_SIZE_USD
} from './constants.js';

export const US_SPEC_VERSION = '3.3';

export const US_SITE_ORIGIN = 'https://polymarket.us';
export const US_GATEWAY_ORIGIN = 'https://gateway.polymarket.us/v1';

export const INTL_HOSTS = ['gamma-api.polymarket.com', 'clob.polymarket.com'];

export const US_RULES = Object.freeze({
  specVersion: US_SPEC_VERSION,
  venue: 'polymarket.us',
  account: 'polymarket.us',
  scannerPlacesOrders: false,
  standingAutoOrder: Object.freeze({
    authorized: true,
    perTradeConfirm: false,
    minUsd: 2,
    maxUsd: 5,
    executor: 'grok-bot-browser',
    note: '扫描器不下单。站立授权：合格 SIGNAL 由 bot 在 polymarket.us 直接下限价单，无需逐笔确认，金额约 $2–5。无 SIGNAL 则静默。'
  }),
  edge: Object.freeze({
    nonBtcNonLive: 0.03,
    // 与 constants.US_EDGE_BTC_MISPRICE 同一常量。只覆盖 BTC 15m / 1h 错价。
    btcMisprice: US_EDGE_BTC_MISPRICE,
    btcMispriceMaxEdge: US_BTC_MISPRICE_MAX_EDGE,
    btcMispriceMinModel: US_BTC_MISPRICE_MIN_MODEL,
    // BTC 错价不打试探单。Live 盘中仍用下面的 [2pp, 4pp)。
    btcMispriceExploratory: false,
    exploratorySizeUsd: US_EXPLORATORY_SIZE_USD,
    exploratoryMinEdge: US_EXPLORATORY_MIN_EDGE,
    exploratoryMaxEdge: US_EXPLORATORY_MAX_EDGE,
    exploratoryMinDistanceBps: US_EXPLORATORY_MIN_DISTANCE_BPS,
    btcMispriceModelWeight: US_BTC_MISPRICE_MODEL_WEIGHT,
    btcMispriceMinPrice: US_BTC_MISPRICE_MIN_PRICE,
    btcMispriceMaxPrice: US_BTC_MISPRICE_MAX_PRICE,
    btcMispriceRequiresFreshBbo: true,
    // 与 constants.US_BBO_MAX_AGE_MS 同一常量。30 秒内不看波动。
    bboMaxAgeMs: US_BBO_MAX_AGE_MS,
    // 超过 3 分钟一律过期。30 秒到 3 分钟之间，波动不超过 2¢ 仍新鲜。
    bboAbsurdAgeMs: US_BBO_ABSURD_AGE_MS,
    bboQuietMove: US_BBO_QUIET_MOVE,
    bboFutureToleranceMs: US_BBO_FUTURE_TOLERANCE_MS,
    // Plan2 15m momentum distance is 8 bps. v3.2 uses half of that trigger.
    momentumOriginalDistanceBps: 8,
    momentumDistanceBps: 4,
    momentumPriceCap: 0.88,
    momentumRequiresSameWay: true,
    momentumRequiresMos: true,
    liveInGame: 0.04,
    liveInGameMinPrice: 0.15,
    liveInGameMaxPrice: 0.95,
    liveEndgameMinModel: 0.88,
    liveEndgameMaxPrice: 0.95,
    standardMinPrice: 0.15,
    standardMaxPrice: 0.85,
    maxSpreadCents: 3,
    modelProbCap: 0.90,
    weakEdgeMultiplier: 1.5
  }),
  // SCAN_SPEC v3.2 只跳过 confidence=Low。0.50 以下（含模型没形成时的 0）才是 Low。
  // 先前 Med 从 0.56 起，会把已经满足 5 个百分点错价、但区间置信度落在 0.50–0.56 的 15m 单全部挡掉。
  confidence: Object.freeze({
    highMin: 0.62,
    medMin: 0.50
  }),
  size: Object.freeze({
    defaultUsd: 2,
    tier70Usd: 3,
    tier70MinWinRate: 0.70,
    tier70MinSamples: 5,
    tier80Usd: 5,
    tier80MinWinRate: 0.80,
    tier80MinSamples: 10,
    weakWinRate: 0.45,
    lossStreak: 3,
    cashReserveUsd: 15
  }),
  dailyCaps: Object.freeze({
    live: 10,
    momentum: 15,
    'btc-misprice': 8,
    pregame: 6,
    weather: 4,
    macro: 3,
    crypto: 4,
    master: 4
  }),
  orderFlow: Object.freeze({
    perTradeConfirm: false,
    standingAutoOrder: true,
    suggestedMinUsd: 2,
    suggestedMaxUsd: 5
  }),
  oneSided: Object.freeze({
    appliesTo: ['btc-misprice', 'momentum'],
    cannotHoldBothSides: true
  }),
  schedule: Object.freeze({
    timeZone: 'America/Los_Angeles',
    weekdaySessions: Object.freeze(['08:37', '12:37', '18:37']),
    sessionLengthMinutes: 15,
    mondayLongDated: '08:50',
    weekendFullSuite: true,
    // 全板块（赛前、天气、宏观、加密、master，外加 BTC 短线）每天每轮都扫。
    // 三个命名窗口仍用于标记 08:37 / 12:37 / 18:37，不再作为非 BTC 的开关。
    fullSuiteEveryLoop: true,
    // 工作日半开区间 [start, end)。BTC 15m/1h 错价和 15m 动量按 2026-10-15 起工作日 24/7。
    // parseClock('24:00') = 1440，minuteOfDay < 1440 覆盖全天每一分钟。周末本身已是 fullSuite。
    weekdayBtcDense: Object.freeze({
      start: '00:00',
      end: '24:00'
    })
  }),
  categories: Object.freeze([
    'sports',
    'esports',
    'crypto',
    'economics',
    'weather',
    'politics',
    'technology',
    'culture'
  ]),
  weatherCities: Object.freeze(['New York', 'Los Angeles', 'Chicago', 'Miami', 'San Francisco']),
  signals: Object.freeze({
    directory: '/workspace/polymarket-ledger/signals',
    pendingJsonl: 'pending.jsonl',
    sectorFile: '{sector}-{timestamp}.json',
    candidatesJsonl: 'candidates.jsonl',
    btc15Compat: '/workspace/btc15-*/signal.json',
    btc15MomentumCompat: '/workspace/btc15-mom-*/signal.json',
    statuses: Object.freeze(['pending', 'filled', 'expired', 'skipped'])
  })
});

export const US_SECTORS = Object.freeze(Object.keys(US_RULES.dailyCaps));

/**
 * SCAN_SPEC v3.2 `edge.weakEdgeMultiplier`（1.5）。
 * 冷板块（胜率 < size.weakWinRate，或连亏 ≥ size.lossStreak）把该板块 edge 门槛乘 1.5。
 * 不用曾经的 +0.02。尾盘没有 edge 门槛，不乘这个系数，模型地板仍是 0.88。
 * 扫描 minEdgeFor 与下单 evaluateUsSignal 都调用这里。
 */
/**
 * 正常仓：edge 达到正式门槛（含冷板块 ×1.5）。
 * 试探仓：只给仍允许的板块（Live 盘中），edge 在 [2pp, 4pp)。
 * BTC 错价调用方必须传 eligible=false。其余情况跳过。4pp 本身是正常仓，不是试探。
 */
export function exploratoryOrderKind({ edge, fullMinEdge, eligible }) {
  if (edge == null || !Number.isFinite(edge)) return 'skip';
  if (fullMinEdge != null && edge + 1e-12 >= fullMinEdge) return 'normal';
  if (!eligible) return 'skip';
  if (edge + 1e-12 >= US_EXPLORATORY_MIN_EDGE && edge < US_EXPLORATORY_MAX_EDGE - 1e-12) return 'exploratory';
  return 'skip';
}

/**
 * 动量距离。正常仓达到所需 bps（冷板块 8）。试探仓只在 [2, 4) bps。
 */
export function exploratoryDistanceKind({ distance, needed, eligible }) {
  if (distance == null || !Number.isFinite(distance)) return 'skip';
  if (needed != null && distance + 1e-9 >= needed) return 'normal';
  if (!eligible) return 'skip';
  const usual = US_RULES.edge.momentumDistanceBps;
  if (distance + 1e-9 >= US_EXPLORATORY_MIN_DISTANCE_BPS && distance < usual - 1e-9) return 'exploratory';
  return 'skip';
}

function finitePrice(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * BTC 错价在价格带之后共用的模型 / edge 判定。
 * 扫描 evaluateUsSignal 和下单 evaluateUsSignal 都走这里，避免门槛再分叉。
 * 返回 reason：model_floor、edge_cap、edge，或 null（可以下正常仓）。
 */
export function classifyBtcMisprice({ modelProb, pricedEdge, fullMinEdge } = {}) {
  if (modelProb == null || !(Number(modelProb) + 1e-12 >= US_BTC_MISPRICE_MIN_MODEL)) {
    return { orderKind: 'skip', reason: 'model_floor' };
  }
  if (pricedEdge == null || !Number.isFinite(Number(pricedEdge))) {
    return { orderKind: 'skip', reason: 'edge' };
  }
  if (Number(pricedEdge) - US_BTC_MISPRICE_MAX_EDGE > 1e-12) {
    return { orderKind: 'skip', reason: 'edge_cap' };
  }
  const orderKind = exploratoryOrderKind({
    edge: Number(pricedEdge),
    fullMinEdge,
    eligible: false
  });
  if (orderKind === 'skip') return { orderKind: 'skip', reason: 'edge' };
  return { orderKind, reason: null };
}

/**
 * 扫描 emit 和下单 recheck 共用。
 * 30 秒内直接新鲜。30 秒到 3 分钟：卖价和中间价的变动都不超过 2¢ 仍新鲜。
 * 超过 3 分钟、报价变动超过 2¢、没有年龄、或采样超前超过 2 秒，算过期。
 * 没有缓存 Age 的调用方应先把年龄写成 0，再进来。
 */
export function bboIsFresh({
  ageMs,
  referenceAsk,
  currentAsk,
  referenceMid,
  currentMid,
  maxAgeMs = US_BBO_MAX_AGE_MS,
  absurdAgeMs = US_BBO_ABSURD_AGE_MS,
  quietMove = US_BBO_QUIET_MOVE,
  futureToleranceMs = US_BBO_FUTURE_TOLERANCE_MS
} = {}) {
  if (ageMs == null || !Number.isFinite(Number(ageMs))) return { ok: false, reason: 'missing' };
  const age = Number(ageMs);
  const future = Number.isFinite(Number(futureToleranceMs)) ? Number(futureToleranceMs) : US_BBO_FUTURE_TOLERANCE_MS;
  if (age < -future) return { ok: false, reason: 'future' };
  const clock = Number.isFinite(Number(maxAgeMs)) ? Number(maxAgeMs) : US_BBO_MAX_AGE_MS;
  if (age <= clock) return { ok: true, reason: 'clock' };
  const absurd = Number.isFinite(Number(absurdAgeMs)) ? Number(absurdAgeMs) : US_BBO_ABSURD_AGE_MS;
  if (age > absurd) return { ok: false, reason: 'absurd' };
  const band = Number.isFinite(Number(quietMove)) ? Number(quietMove) : US_BBO_QUIET_MOVE;
  const moves = [
    finitePrice(referenceAsk) != null && finitePrice(currentAsk) != null
      ? Math.abs(finitePrice(currentAsk) - finitePrice(referenceAsk))
      : null,
    finitePrice(referenceMid) != null && finitePrice(currentMid) != null
      ? Math.abs(finitePrice(currentMid) - finitePrice(referenceMid))
      : null
  ].filter((value) => value != null);
  if (moves.length === 0) return { ok: false, reason: 'uncompared' };
  if (Math.max(...moves) <= band + 1e-9) return { ok: true, reason: 'quiet' };
  return { ok: false, reason: 'moved' };
}

export function cleanerEdgeFloor(baseEdge, cold, rules = US_RULES) {
  const base = Number(baseEdge);
  if (!Number.isFinite(base)) return null;
  if (!cold) return base;
  const multiplier = Number(rules?.edge?.weakEdgeMultiplier);
  const factor = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1.5;
  return Math.round(base * factor * 1e4) / 1e4;
}

export function isIntlHost(url) {
  const text = String(url || '').toLowerCase();
  return INTL_HOSTS.some((host) => text.includes(host));
}
