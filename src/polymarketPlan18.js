export const PLAN18_ID = 'plan18';
export const PLAN18_VERSION = 'plan18_meihua_updown_v2';
export const PLAN19_ID = 'plan19';
export const PLAN19_VERSION = 'plan19_liuren_updown_v1';

/** Both plans share the casting code; they differ only in which oracle decides the side. */
export const DIVINATION_PLANS = Object.freeze({
  plan18: Object.freeze({ id: PLAN18_ID, method: 'meihua', version: PLAN18_VERSION, label: '梅花易数' }),
  plan19: Object.freeze({ id: PLAN19_ID, method: 'liuren', version: PLAN19_VERSION, label: '小六壬' })
});
export const DIVINATION_PLAN_IDS = Object.freeze(Object.keys(DIVINATION_PLANS));

/** Castings use Beijing civil time for the lunar date and 时辰. */
export const PLAN18_TIME_ZONE = 'Asia/Shanghai';

export const PLAN18_DEFAULTS = Object.freeze({
  maxAsk: 0.65,
  maxSpread: 0.03,
  entryWindowMinutes: { '5m': 1, '15m': 3, '1h': 10 },
  feeRate: 0.07,
  method: 'meihua'
});

export const PLAN18_TIMEFRAMES = Object.freeze({ '5m': 300, '15m': 900, '1h': 3600 });
export const PLAN18_SHORT_PREFIX = Object.freeze({ BTC: 'btc', ETH: 'eth', SOL: 'sol', XRP: 'xrp' });
const SHORT_SYMBOL = { btc: 'BTC', eth: 'ETH', sol: 'SOL', xrp: 'XRP' };
const HOURLY_SYMBOL = { bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', xrp: 'XRP' };

const TRIGRAMS = ['坤', '乾', '兑', '离', '震', '巽', '坎', '艮', '坤'];
const ELEMENT = { 乾: '金', 兑: '金', 离: '火', 震: '木', 巽: '木', 坎: '水', 艮: '土', 坤: '土' };
const GENERATES = { 木: '火', 火: '土', 土: '金', 金: '水', 水: '木' };
const CONTROLS = { 木: '土', 土: '水', 水: '火', 火: '金', 金: '木' };
const BRANCHES = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
const LIU_REN = ['大安', '留连', '速喜', '赤口', '小吉', '空亡'];
const LIU_REN_GOOD = new Set(['大安', '速喜', '小吉']);
const CN_DIGITS = { 正: 1, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 冬: 11, 腊: 12 };

const lunarFormat = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
  timeZone: PLAN18_TIME_ZONE, year: 'numeric', month: 'numeric', day: 'numeric'
});
const hourFormat = new Intl.DateTimeFormat('en-US', { timeZone: PLAN18_TIME_ZONE, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });

function parseLunarMonth(text) {
  const raw = String(text || '').replace('闰', '').replace('月', '');
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === '冬') return 11;
  if (raw === '腊') return 12;
  if (raw.startsWith('十')) return 10 + (CN_DIGITS[raw.slice(1)] || 0);
  return CN_DIGITS[raw] || null;
}

/** 子时 starts at 23:00 and already counts as the next lunar day. */
export function plan18Clock(ms) {
  const time = Object.fromEntries(hourFormat.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const hour = Number(time.hour);
  const minute = Number(time.minute);
  const shichen = Math.floor((hour + 1) / 2) % 12 + 1;
  const parts = Object.fromEntries(lunarFormat.formatToParts(new Date(hour === 23 ? ms + 3_600_000 : ms)).map((p) => [p.type, p.value]));
  const year = Number(parts.relatedYear);
  const yearBranch = ((year - 4) % 12 + 12) % 12 + 1;
  return {
    year,
    yearBranch,
    yearBranchName: BRANCHES[yearBranch - 1],
    month: parseLunarMonth(parts.month),
    leapMonth: String(parts.month || '').startsWith('闰'),
    day: Number(parts.day),
    shichen,
    shichenName: BRANCHES[shichen - 1],
    minute
  };
}

function relationOf(ti, yong) {
  const t = ELEMENT[ti]; const y = ELEMENT[yong];
  if (t === y) return { relation: '比和', good: true };
  if (GENERATES[y] === t) return { relation: '用生体', good: true };
  if (CONTROLS[t] === y) return { relation: '体克用', good: true };
  if (GENERATES[t] === y) return { relation: '体生用', good: false };
  return { relation: '用克体', good: false };
}

/** 梅花易数时间起卦：上卦(年+月+日)%8，下卦再加时与分，动爻总数%6。整点分为 0，即传统年月日时卦。 */
export function meihuaCast(clock) {
  const base = clock.yearBranch + clock.month + clock.day;
  const total = base + clock.shichen + (Number(clock.minute) || 0);
  const upper = TRIGRAMS[base % 8 || 8];
  const lower = TRIGRAMS[total % 8 || 8];
  const moving = total % 6 || 6;
  const ti = moving <= 3 ? upper : lower;
  const yong = moving <= 3 ? lower : upper;
  const { relation, good } = relationOf(ti, yong);
  return { upper, lower, moving, ti, yong, tiElement: ELEMENT[ti], yongElement: ELEMENT[yong], relation, good };
}

/** 小六壬：大安起正月，顺数月、日、时。 */
export function xiaoLiuRenCast(clock) {
  const name = LIU_REN[(clock.month - 1 + clock.day - 1 + clock.shichen - 1) % 6];
  return { name, good: LIU_REN_GOOD.has(name) };
}

export function plan18Divine(ms, method = 'meihua') {
  const clock = plan18Clock(ms);
  const meihua = meihuaCast(clock);
  const liuren = xiaoLiuRenCast(clock);
  const good = method === 'liuren' ? liuren.good : meihua.good;
  return {
    clock,
    method: method === 'liuren' ? 'liuren' : 'meihua',
    meihua,
    liuren,
    call: good ? 'Up' : 'Down',
    agree: meihua.good === liuren.good,
    text: `${clock.yearBranchName}年${clock.leapMonth ? '闰' : ''}${clock.month}月${clock.day}日${clock.shichenName}时${clock.minute ? `${clock.minute}分` : ''} · `
      + `上${meihua.upper}下${meihua.lower} 动${meihua.moving} · 体${meihua.ti}${meihua.tiElement} 用${meihua.yong}${meihua.yongElement} ${meihua.relation} · 小六壬${liuren.name}`
  };
}

export function plan18ShortSlug(symbol, timeframe, nowMs = Date.now()) {
  const prefix = PLAN18_SHORT_PREFIX[symbol];
  const seconds = PLAN18_TIMEFRAMES[timeframe];
  if (!prefix || !seconds || timeframe === '1h') return null;
  return `${prefix}-updown-${timeframe}-${Math.floor(nowMs / 1000 / seconds) * seconds}`;
}

export function parsePlan18Event(event = null) {
  const slug = String(event?.slug || '');
  const hourly = slug.match(/^(bitcoin|ethereum|solana|xrp)-up-or-down-[a-z]+-\d{1,2}-\d{4}-\d{1,2}(am|pm)-et$/);
  const short = slug.match(/^(btc|eth|sol|xrp)-updown-(5m|15m)-\d+$/);
  if (!hourly && !short) return null;
  const market = event.markets?.[0];
  const startMs = Date.parse(market?.eventStartTime || event?.startTime || '');
  const endMs = Date.parse(market?.endDate || event?.endDate || '');
  if (!market || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return {
    symbol: hourly ? HOURLY_SYMBOL[hourly[1]] : SHORT_SYMBOL[short[1]],
    timeframe: hourly ? '1h' : short[2],
    market,
    startMs,
    endMs
  };
}

function entryWindowMinutesFor(timeframe, setting) {
  if (setting && typeof setting === 'object') return Number(setting[timeframe]) || PLAN18_DEFAULTS.entryWindowMinutes[timeframe];
  return Number(setting) || PLAN18_DEFAULTS.entryWindowMinutes[timeframe];
}

/** Buys the divined side right after the candle opens. */
export function evaluatePlan18Event({ event = null, upBook = null, downBook = null, nowMs = Date.now(), ...options } = {}) {
  const cfg = { ...PLAN18_DEFAULTS, ...options };
  const parsed = parsePlan18Event(event);
  if (!parsed) return { ok: false, reason: 'unparsed' };
  if (parsed.market.closed) return { ok: false, reason: 'closed' };
  if (nowMs < parsed.startMs) return { ok: false, reason: 'not_started' };
  if (nowMs > parsed.startMs + entryWindowMinutesFor(parsed.timeframe, cfg.entryWindowMinutes) * 60_000) {
    return { ok: false, reason: 'entry_window_passed' };
  }
  const divination = plan18Divine(parsed.startMs, cfg.method);
  const outcomes = JSON.parse(parsed.market.outcomes || '[]').map(String);
  const tokens = JSON.parse(parsed.market.clobTokenIds || '[]').map(String);
  const index = outcomes.findIndex((name) => name.toLowerCase() === divination.call.toLowerCase());
  if (index < 0 || !tokens[index]) return { ok: false, reason: 'missing_outcomes' };
  const book = divination.call === 'Up' ? upBook : downBook;
  const ask = Number(book?.bestAsk ?? book?.ask);
  const bid = book?.bestBid == null && book?.bid == null ? NaN : Number(book?.bestBid ?? book?.bid);
  if (!(ask > 0 && ask < 1)) return { ok: false, reason: 'incomplete_book' };
  if (ask > cfg.maxAsk + 1e-9) return { ok: false, reason: 'price_out_of_range' };
  if (Number.isFinite(bid) && ask - bid > cfg.maxSpread + 1e-9) return { ok: false, reason: 'wide_spread' };
  return {
    ok: true,
    symbol: parsed.symbol,
    timeframe: parsed.timeframe,
    outcome: outcomes[index],
    tokenId: tokens[index],
    ask,
    bid: Number.isFinite(bid) ? bid : null,
    marketSlug: String(parsed.market.slug || event.slug),
    conditionId: parsed.market.conditionId || null,
    title: parsed.market.question || event.title || event.slug,
    startIso: new Date(parsed.startMs).toISOString(),
    endDate: new Date(parsed.endMs).toISOString(),
    divination
  };
}
