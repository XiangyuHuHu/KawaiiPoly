/**
 * SCAN_SPEC v3.2（2026-10-15）里必须执行的数字。
 * 扫描器可以改文案；下单以这里的常量为准。
 */

export const US_SPEC_VERSION = 'v3.2';
export const US_LINE_ID = 'polymarket_us';

export const US_GATEWAY_BASE = 'https://gateway.polymarket.us';
export const US_API_BASE = 'https://api.polymarket.us';

/** 美国版入场价只认 gateway，不认 gamma-api。 */
export const US_MARKET_PATHS = Object.freeze({
  list: '/v1/markets',
  bySlug: '/v1/market/slug',
  bbo: '/v1/markets',
  book: '/v1/markets',
  settlement: '/v1/markets'
});

export const US_ORDER_PATHS = Object.freeze({
  create: '/v1/orders',
  open: '/v1/orders/open',
  preview: '/v1/order/preview',
  cancelAll: '/v1/orders/open/cancel',
  order: '/v1/order',
  positions: '/v1/portfolio/positions',
  activities: '/v1/portfolio/activities',
  balances: '/v1/account/balances'
});

/** BTC 短线结算源。不要改成国际版 Chainlink/Gamma。 */
export const US_BTC_SHORT_RESOLUTION = 'CF Benchmarks BRTI（窗口起止各 60 秒均价，两位小数）';

export const US_CASH_RESERVE_USD = 15;
export const US_SIZE_DEFAULT_USD = 2;
export const US_SIZE_WINRATE_70_USD = 3;
export const US_SIZE_WINRATE_80_USD = 5;
export const US_WINRATE_70 = 0.7;
export const US_WINRATE_80 = 0.8;
export const US_WINRATE_SAMPLES_70 = 5;
export const US_WINRATE_SAMPLES_80 = 10;
export const US_WINRATE_FLOOR = 0.45;
export const US_LOSS_STREAK = 3;
/** 胜率偏低或连亏时，在板块门槛上再加的 edge。 */
export const US_CLEANER_EDGE_BONUS = 0.02;

export const US_EDGE_STANDARD = 0.03;
export const US_EDGE_BTC_MISPRICE = 0.05;
export const US_EDGE_LIVE_INPLAY = 0.04;
export const US_MODEL_PROB_CAP = 0.9;
export const US_LIVE_ENDGAME_MIN_MODEL = 0.88;
export const US_LIVE_ENDGAME_MAX_PRICE = 0.95;
export const US_PRICE_MIN = 0.15;
export const US_PRICE_MAX = 0.85;
export const US_LIVE_INPLAY_MAX_PRICE = 0.95;
/** BTC 15m 动量买入价帽。触发阈值为扫描器原动量阈值的一半，由信号侧门控。 */
export const US_MOMENTUM_MAX_PRICE = 0.88;
export const US_MOMENTUM_TRIGGER_SCALE = 0.5;
export const US_MAX_SPREAD = 0.03;
export const US_BBO_MAX_AGE_MS = 30_000;

/** 真实下单日帽（太平洋自然日）。dry-run 不计入。 */
export const US_DAILY_CAPS = Object.freeze({
  live: 10,
  momentum: 15,
  btc_misprice: 8,
  pregame: 6,
  weather: 4,
  macro: 3,
  crypto: 4,
  master: 4
});

/** 周一到周五 PT 三个全板块下单窗。半开区间 [start, start+window)。
 *  BTC 15m/1h 错价和 15m 动量在白天另有密集窗，时钟在 US_RULES.schedule.weekdayBtcDense。
 */
export const US_WEEKDAY_WINDOWS = Object.freeze([
  Object.freeze({ id: 'wd-0837', hour: 8, minute: 37 }),
  Object.freeze({ id: 'wd-1237', hour: 12, minute: 37 }),
  Object.freeze({ id: 'wd-1837', hour: 18, minute: 37 })
]);

/** 周一额外的偏长期单窗口，只放 master / long_horizon。 */
export const US_MONDAY_LONG_WINDOW = Object.freeze({
  id: 'mon-0850',
  hour: 8,
  minute: 50,
  sectors: Object.freeze(['master'])
});

export const US_SCHEDULE_WINDOW_MINUTES = 15;

export const US_SECTORS = Object.freeze(Object.keys(US_DAILY_CAPS));

export const US_COUNTED_FILL_STATUSES = Object.freeze(['submitted', 'filled', 'partial']);
