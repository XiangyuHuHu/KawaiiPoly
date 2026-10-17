export const PLAN21_ID = 'plan21';
export const PLAN21_VERSION = 'plan21_cheap_side_5m_v1';

/** Paper stake stays small. Config cannot raise a fill above this. */
export const PLAN21_MAX_PAPER_ORDER_USD = 5;
/** 2026-10-18: entry ask must be at or below 30¢. The old 35¢ cell edge is closed. */
export const PLAN21_MAX_ENTRY_PRICE = 0.30;
/**
 * Keep sampling until about this many distinct 5m windows, then a person re-reads the book.
 * The gate is a note only. It does not stop new paper entries.
 */
export const PLAN21_REEVAL_WINDOWS = 100;

/**
 * 5 分钟盘中段买落后的一边。格子仍是回测里扣费后为正的三格，
 * 但入场价另有硬顶：卖一必须 ≤0.30。还剩 3 分钟、20–35¢ 那一格本来就是亏的，不买。
 * 还剩约 4 分钟且落后方 20–30¢，还剩约 3 分钟且 10–20¢，还剩约 2 分钟且 10–30¢。
 */
export const PLAN21_WINDOWS = Object.freeze([
  Object.freeze({ minutes: 4, low: 0.20, high: 0.35 }),
  Object.freeze({ minutes: 3, low: 0.10, high: 0.20 }),
  Object.freeze({ minutes: 2, low: 0.10, high: 0.35 })
]);

export function plan21EntryCap(maxEntryPrice = PLAN21_MAX_ENTRY_PRICE) {
  const cap = Number(maxEntryPrice);
  if (!Number.isFinite(cap) || cap <= 0) return PLAN21_MAX_ENTRY_PRICE;
  return Math.min(PLAN21_MAX_ENTRY_PRICE, cap);
}

export function plan21PaperOrderUsd(value, cap = PLAN21_MAX_PAPER_ORDER_USD) {
  const n = Number(value);
  const usd = Number.isFinite(n) && n > 0 ? n : PLAN21_MAX_PAPER_ORDER_USD;
  const ceiling = Number(cap);
  const max = Number.isFinite(ceiling) && ceiling > 0 ? Math.min(PLAN21_MAX_PAPER_ORDER_USD, ceiling) : PLAN21_MAX_PAPER_ORDER_USD;
  return Math.min(max, Math.max(1, usd));
}

export function plan21WindowKey(order) {
  return String(order?.targetTimeIso || order?.endDate || order?.plan21Entry?.endDate || order?.slotIso || '');
}

/**
 * Distinct 5m windows already on the paper book. `autoStop` is always false:
 * crossing the gate only asks for a re-read. It does not cancel the sampler.
 */
export function plan21ReevalStatus(orders = [], gate = PLAN21_REEVAL_WINDOWS) {
  const keys = new Set();
  for (const order of orders || []) {
    const key = plan21WindowKey(order);
    if (key) keys.add(key);
  }
  const windows = keys.size;
  const limit = Number(gate) > 0 ? Number(gate) : PLAN21_REEVAL_WINDOWS;
  const due = windows >= limit;
  return {
    windows,
    gate: limit,
    due,
    autoStop: false,
    note: due
      ? `Plan21 已覆盖 ${windows} 个窗口，到达约 ${limit} 窗口复评线；继续纸面，不自动停止。`
      : `Plan21 已覆盖 ${windows}/${limit} 个窗口。`
  };
}

export function plan21Window(minutesLeft) {
  const left = Number(minutesLeft);
  if (!Number.isFinite(left)) return null;
  return PLAN21_WINDOWS.find((window) => Math.abs(left - window.minutes) <= 0.5) || null;
}

function sideQuote(book) {
  const ask = Number(book?.bestAsk ?? book?.ask);
  const bid = book?.bestBid == null && book?.bid == null ? NaN : Number(book?.bestBid ?? book?.bid);
  return { ask, bid };
}

/** Buys the cheaper side when the live book sits in one of the three windows and at or below the entry cap. */
export function evaluatePlan21({
  upBook = null,
  downBook = null,
  endMs = null,
  nowMs = Date.now(),
  maxSpread = 0.04,
  maxEntryPrice = PLAN21_MAX_ENTRY_PRICE
} = {}) {
  const end = Number(endMs);
  if (!Number.isFinite(end)) return { ok: false, reason: 'missing_end' };
  const minutesLeft = (end - nowMs) / 60_000;
  const window = plan21Window(minutesLeft);
  if (!window) return { ok: false, reason: 'outside_window', minutesLeft };
  const up = sideQuote(upBook);
  const down = sideQuote(downBook);
  if (!(up.ask > 0 && up.ask < 1) || !(down.ask > 0 && down.ask < 1)) return { ok: false, reason: 'incomplete_book' };
  const cheapIsUp = up.ask <= down.ask;
  const cheap = cheapIsUp ? up : down;
  const other = cheapIsUp ? down : up;
  if (other.ask - cheap.ask < 0.02) return { ok: false, reason: 'no_leader' };
  if (Number.isFinite(cheap.bid) && cheap.ask - cheap.bid > maxSpread + 1e-9) return { ok: false, reason: 'wide_spread' };
  if (cheap.ask < window.low - 1e-9 || cheap.ask >= window.high - 1e-9) return { ok: false, reason: 'price_out_of_range' };
  const cap = plan21EntryCap(maxEntryPrice);
  if (cheap.ask > cap + 1e-9) return { ok: false, reason: 'price_out_of_range', maxEntryPrice: cap };
  return {
    ok: true,
    outcome: cheapIsUp ? 'Up' : 'Down',
    ask: cheap.ask,
    bid: Number.isFinite(cheap.bid) ? cheap.bid : null,
    minutesLeft,
    windowMinutes: window.minutes,
    low: window.low,
    high: window.high,
    maxEntryPrice: cap
  };
}
