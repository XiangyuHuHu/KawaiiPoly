/**
 * Polymarket US scan rules. SCAN_SPEC v3.2 (2026-10-15) supersedes the
 * v3/v3.1 "wait for a chat confirmation" and "2–3 orders a day" clauses.
 * Scanners write SIGNAL files. They never place orders.
 */

export const US_SPEC_VERSION = '3.2';

export const US_SITE_ORIGIN = 'https://polymarket.us';
export const US_GATEWAY_ORIGIN = 'https://gateway.polymarket.us/v1';

export const INTL_HOSTS = ['gamma-api.polymarket.com', 'clob.polymarket.com'];

/** Plan2 15m sustained-momentum minimum distance. US momentum uses half. */
export const BTC15_MOMENTUM_ORIGINAL_DISTANCE_BPS = 8;

export const US_RULES = Object.freeze({
  specVersion: US_SPEC_VERSION,
  venue: 'polymarket.us',
  scannerPlacesOrders: false,
  standingAutoOrder: Object.freeze({
    authorized: true,
    perTradeConfirm: false,
    minUsd: 2,
    maxUsd: 5,
    executor: 'grok-bot-browser',
    note: '站立授权：合格 SIGNAL 由 Grok Bot 在 polymarket.us 浏览器下限价单，无需逐笔确认。扫描器只写 SIGNAL，不下单。无 SIGNAL 则静默。成交后用中文播报市场、方向、价格、金额、理由、事件链接和截图。'
  }),
  edge: Object.freeze({
    nonBtcNonLive: 0.03,
    btcMisprice: 0.05,
    btcMispriceRequiresFreshBbo: true,
    bboMaxAgeMs: 15_000,
    momentumDistanceBps: BTC15_MOMENTUM_ORIGINAL_DISTANCE_BPS / 2,
    momentumOriginalDistanceBps: BTC15_MOMENTUM_ORIGINAL_DISTANCE_BPS,
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
  oneSided: Object.freeze({
    appliesTo: ['btc-misprice', 'momentum'],
    cannotHoldBothSides: true
  }),
  schedule: Object.freeze({
    timeZone: 'America/Los_Angeles',
    weekdaySessions: Object.freeze(['08:37', '12:37', '18:37']),
    sessionLengthMinutes: 15,
    mondayLongDated: '08:50',
    weekendFullSuite: true
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

export function isIntlHost(url) {
  const text = String(url || '').toLowerCase();
  return INTL_HOSTS.some((host) => text.includes(host));
}
