/**
 * Polymarket US scan rules from SCAN_SPEC v3.2.
 * v3.2 replaces the v3 confirm-before-order flow and the v3.1 live/edge numbers.
 * Scanners write SIGNAL files. They never place orders.
 * The bot may send the limit order without another chat confirmation.
 */

import { US_BBO_MAX_AGE_MS, US_EDGE_BTC_MISPRICE } from './constants.js';

export const US_SPEC_VERSION = '3.2';

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
    btcMispriceRequiresFreshBbo: true,
    // 与 constants.US_BBO_MAX_AGE_MS 同一常量。BTC 错价 BBO 不超过 45 秒。
    bboMaxAgeMs: US_BBO_MAX_AGE_MS,
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
    // 工作日白天半开区间 [start, end)。这段里 BTC 15m/1h 错价和 15m 动量可以扫，不必等到三个全板块窗口。
    weekdayBtcDense: Object.freeze({
      start: '08:00',
      end: '20:00'
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
