/**
 * Polymarket US scan rules from SCAN_SPEC v3 / v3.1.
 * Scanners write SIGNAL files. They never place orders.
 * A human must confirm in chat before the bot sends a limit order.
 */

export const US_SPEC_VERSION = '3.1';

export const US_SITE_ORIGIN = 'https://polymarket.us';
export const US_GATEWAY_ORIGIN = 'https://gateway.polymarket.us/v1';

export const INTL_HOSTS = ['gamma-api.polymarket.com', 'clob.polymarket.com'];

export const US_RULES = Object.freeze({
  specVersion: US_SPEC_VERSION,
  venue: 'polymarket.us',
  account: 'polymarket.us',
  scannerPlacesOrders: false,
  standingAutoOrder: Object.freeze({
    authorized: false,
    perTradeConfirm: true,
    minUsd: 2,
    maxUsd: 5,
    dailyMaxOrders: 3,
    executor: 'grok-bot-browser',
    note: '扫描器不下单。建议 $2–5 限价单。只有用户在对话里明确确认后，bot 才在 polymarket.us 下单，每天最多 3 笔。无 SIGNAL 则静默。'
  }),
  edge: Object.freeze({
    minEdge: 0.10,
    nonBtcNonLive: 0.10,
    btcMisprice: 0.10,
    btcMispriceRequiresFreshBbo: true,
    bboMaxAgeMs: 15_000,
    momentumRequiresSameWay: true,
    liveInGame: 0.10,
    liveInGameMinPrice: 0.15,
    liveInGameMaxPrice: 0.85,
    liveEndgameMinModel: 0.93,
    liveEndgameMinEdge: 0.04,
    liveEndgameMaxPrice: 0.95,
    standardMinPrice: 0.15,
    standardMaxPrice: 0.85,
    minLiquidityUsd: 2000,
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
    live: 3,
    momentum: 3,
    'btc-misprice': 3,
    pregame: 3,
    weather: 3,
    macro: 3,
    crypto: 3,
    master: 3
  }),
  orderFlow: Object.freeze({
    perTradeConfirm: true,
    suggestedMinUsd: 2,
    suggestedMaxUsd: 5,
    dailyMaxOrders: 3
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
