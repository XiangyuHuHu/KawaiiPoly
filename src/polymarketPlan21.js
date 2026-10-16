export const PLAN21_ID = 'plan21';
export const PLAN21_VERSION = 'plan21_cheap_side_5m_v1';

/**
 * 5 分钟盘中段买落后的一边。只保留回测里扣费后为正的格子：
 * 还剩约 4 分钟且落后方 20–35¢，还剩约 3 分钟且 10–20¢，还剩约 2 分钟且 10–35¢。
 * 还剩 3 分钟、20–35¢ 那一格是亏的，不买。
 */
export const PLAN21_WINDOWS = Object.freeze([
  Object.freeze({ minutes: 4, low: 0.20, high: 0.35 }),
  Object.freeze({ minutes: 3, low: 0.10, high: 0.20 }),
  Object.freeze({ minutes: 2, low: 0.10, high: 0.35 })
]);

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

/** Buys the cheaper side when the live book sits in one of the three windows. */
export function evaluatePlan21({ upBook = null, downBook = null, endMs = null, nowMs = Date.now(), maxSpread = 0.04 } = {}) {
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
  return {
    ok: true,
    outcome: cheapIsUp ? 'Up' : 'Down',
    ask: cheap.ask,
    bid: Number.isFinite(cheap.bid) ? cheap.bid : null,
    minutesLeft,
    windowMinutes: window.minutes,
    low: window.low,
    high: window.high
  };
}
