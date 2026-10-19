/**
 * SCAN_SPEC v3.4（2026-10-19）里必须执行的数字。
 * v3.3 的 BTC 错价、日帽、现金保留、仓位不变。v3.4 只加 Live 观察日志和尾盘分歧闸门。
 * 扫描器可以改文案；下单以这里的常量为准。
 */

export const US_SPEC_VERSION = 'v3.4';
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
/** 冷板块 edge 不用加 0.02。SCAN_SPEC v3.2 把门槛乘 1.5，见 rules.js cleanerEdgeFloor。 */

export const US_EDGE_STANDARD = 0.03;
/**
 * BTC 15m / 1h 错价最低 edge（4pp）。扫描 rules.edge.btcMisprice 与下单重检共用这一常量。
 * 不把下限抬到 6pp 或 8pp：已结算里 edge ≥ 15pp 的错价是 0 胜 5 负，抬下限会留下更差的那一截。
 */
export const US_EDGE_BTC_MISPRICE = 0.04;
/**
 * BTC 错价 edge 上限（15pp）。模型停在硬币附近、卖价却便宜很多时，quoted edge 是逆向选择，不是优势。
 * 有记录的 edge ≥ 0.15 全部亏损；三笔错价赢单的 edge 在 0.109–0.146。
 */
export const US_BTC_MISPRICE_MAX_EDGE = 0.15;
/**
 * 买入方向的模型概率下限。已结算错价的 model_p 落在 0.4828–0.5361，没有一笔 ≥ 0.55。
 * 0.56 在这团硬币概率之上，模型公式本身可以到 0.90。
 */
export const US_BTC_MISPRICE_MIN_MODEL = 0.56;
/**
 * 试探单 $1 只留给 Live 盘中 edge [2pp, 4pp) 和动量距离 [2, 4) bps。
 * BTC 错价不再试探：板块胜率约 20%，2–4pp 比已经在亏的正式单更弱。
 * 4pp 起仍是错价正常仓。低于 2pp 的 Live 继续跳过。冷板块正式门槛仍是 4pp×1.5，4pp–6pp 不是试探带。
 */
export const US_EXPLORATORY_SIZE_USD = 1;
export const US_EXPLORATORY_MIN_EDGE = 0.02;
export const US_EXPLORATORY_MAX_EDGE = US_EDGE_BTC_MISPRICE;
/** 动量距离试探带 [2, 4) bps。4 bps 起仍是正常仓。低于 2 bps 继续跳过。 */
export const US_EXPLORATORY_MIN_DISTANCE_BPS = 2;
/**
 * BTC 错价把模型概率向该方向的盘口中间价收缩后再要求 4pp，并不得超过 15pp。
 * p_used = 0.55 * model + 0.45 * market_mid。
 * v3.2 的 0.7 是事先放宽、不是用结算拟合的。结算里市场比 ~0.50 的模型更准，所以把权重从 0.7 收到 0.55。
 */
export const US_BTC_MISPRICE_MODEL_WEIGHT = 0.55;
/** BTC 错价买入价 0.35–0.65。0.25–0.35 的便宜边在结算里几乎全亏。 */
export const US_BTC_MISPRICE_MIN_PRICE = 0.35;
export const US_BTC_MISPRICE_MAX_PRICE = 0.65;
/** 某板块最近 10 笔已结算胜率低于 35% 且已实现盈亏为负时，停开新单 24 小时。 */
export const US_SECTOR_BRAKE_TRADES = 10;
export const US_SECTOR_BRAKE_WIN_RATE = 0.35;
export const US_SECTOR_BRAKE_MS = 24 * 60 * 60 * 1000;
export const US_EDGE_LIVE_INPLAY = 0.04;
export const US_MODEL_PROB_CAP = 0.9;
export const US_LIVE_ENDGAME_MIN_MODEL = 0.88;
export const US_LIVE_ENDGAME_MAX_PRICE = 0.95;
/**
 * 尾盘 model − ask 大于这个数时，当作分歧而不是 edge。
 * 两边模型都 ≥ US_LIVE_ENDGAME_DIVERGENCE_MIN_MODEL，且比分/时钟不超过 US_LIVE_ENDGAME_SCORE_MAX_AGE_MS，才按正常仓。
 * 两个来源都没有：只下 US_LIVE_ENDGAME_DIVERGENCE_FALLBACK_USD。其余情况跳过。
 * 关掉闸门：把 US_LIVE_ENDGAME_DIVERGENCE_ENABLED 改成 false。地板 0.88 和价格帽 0.95 不动。
 */
export const US_LIVE_ENDGAME_DIVERGENCE = 0.10;
export const US_LIVE_ENDGAME_DIVERGENCE_MIN_MODEL = 0.88;
export const US_LIVE_ENDGAME_SCORE_MAX_AGE_MS = 60_000;
export const US_LIVE_ENDGAME_DIVERGENCE_FALLBACK_USD = 1;
export const US_LIVE_ENDGAME_DIVERGENCE_ENABLED = true;
/** 足球早/中/晚盘（75' 之前）Pinnacle 去水热门。只写观察日志，不下单。 */
export const US_SOCCER_PAPER_MIN_MODEL = 0.80;
export const US_SOCCER_PAPER_MAX_PRICE = 0.93;
export const US_SOCCER_PAPER_PHASES = Object.freeze(['early', 'mid', 'late']);
/**
 * 观察日志仍写每一场 Live 胜负盘的 Yes 和 No，含无模型与低于此值的一侧。
 * 这条只给 rule_pass.observe_band 和事后 ROI 网格用，不改变尾盘下单地板 0.88。
 */
export const US_LIVE_OBSERVE_MIN_MODEL = 0.60;
/** us:live-analyze 默认门槛。价格帽仍是 0.90 / 0.93 / 0.95 / 0.99。 */
export const US_LIVE_ANALYZE_THRESHOLDS = Object.freeze([
  0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.88, 0.90, 0.92, 0.95
]);
export const US_LIVE_ANALYZE_CAPS = Object.freeze([0.90, 0.93, 0.95, 0.99]);
export const US_PRICE_MIN = 0.15;
export const US_PRICE_MAX = 0.85;
export const US_LIVE_INPLAY_MAX_PRICE = 0.95;
/** BTC 15m 动量买入价帽。触发阈值为扫描器原动量阈值的一半，由信号侧门控。 */
export const US_MOMENTUM_MAX_PRICE = 0.88;
export const US_MOMENTUM_TRIGGER_SCALE = 0.5;
export const US_MAX_SPREAD = 0.03;
/**
 * BTC 错价 BBO 时钟新鲜窗口 30 秒（30000 ms）。
 * 这个窗口内不看价格波动。rules.edge.bboMaxAgeMs、config 默认值、扫描 emit 与下单 recheck 都引用这一常量。
 * v3.2 是 45 秒。10 月 17 日多笔亏损是 API 已判 stale_bbo 之后的浏览器补单，这里只收紧代码路径，不恢复浏览器补单。
 */
export const US_BBO_MAX_AGE_MS = 30_000;
/**
 * 超过 30 秒、不超过 3 分钟：卖价和中间价相对信号的波动在 US_BBO_QUIET_MOVE 以内仍算新鲜。
 * 超过 3 分钟，即使报价没动也是过期。小幅波动不算过期。v3.2 的安静窗口是 5 分钟。
 */
export const US_BBO_ABSURD_AGE_MS = 3 * 60 * 1000;
/** 2¢。超过 30 秒后，卖价或中间价的变动大于这个幅度才算报价变了。 */
export const US_BBO_QUIET_MOVE = 0.02;
/** 采样时间比现在超前超过 2 秒，不当作刚收到的报价。 */
export const US_BBO_FUTURE_TOLERANCE_MS = 2_000;

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

/** 周一到周五 PT 三个仍作标记的全板块钟点。半开区间 [start, start+window)。
 *  非 BTC 不再受这三个钟点限制：US_RULES.schedule.fullSuiteEveryLoop 让全板块每天每轮可下单。
 *  BTC 15m/1h 错价和 15m 动量在工作日 24/7 另有密集窗（2026-10-15），时钟在 weekdayBtcDense。
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
