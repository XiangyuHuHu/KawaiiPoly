import { parseJsonArray } from './polymarketClient.js';
import { polymarketCryptoTakerFee } from './polymarketMarketUtils.js';

export const PLAN17_ID = 'plan17';
export const PLAN17_VERSION = 'plan17_dvol_ladder_v1';

const YEAR_MS = 365 * 86_400_000;

export const PLAN17_COINS = Object.freeze({
  bitcoin: { symbol: 'BTC', binance: 'BTCUSDT', dvol: 'BTC' },
  ethereum: { symbol: 'ETH', binance: 'ETHUSDT', dvol: 'ETH' }
});

/**
 * Vol scales were fitted on 2026-08-12..09-16 and checked on 09-17..10-11
 * (data/analysis/p17-crypto-ladder). Only hitDaily held up in both halves;
 * "above" runs alongside as a control.
 */
export const PLAN17_DEFAULTS = Object.freeze({
  volScale: Object.freeze({ hitDaily: 1.05, above: 0.85 }),
  families: Object.freeze(['hitDaily', 'above']),
  maxIvAgeMs: 300_000,
  minEdge: 0.10,
  minAsk: 0.03,
  maxAsk: 0.95,
  maxSpread: 0.05,
  minMinutesLeft: 30,
  maxHoursLeft: Object.freeze({ hitDaily: 24, above: 72 }),
  maxPerEvent: 4,
  feeRate: 0.07
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function plan17IvSkipReason(data, nowMs, maxIvAgeMs = PLAN17_DEFAULTS.maxIvAgeMs) {
  if (data?.ivSkipReason) return data.ivSkipReason;
  if (!(Number.isFinite(data?.iv) && data.iv > 0)) return 'iv_missing';
  const timestamp = data?.ivTimestampMs;
  if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > nowMs) return 'iv_timestamp_invalid';
  const maxAge = Number.isFinite(maxIvAgeMs) && maxIvAgeMs >= 0 ? maxIvAgeMs : PLAN17_DEFAULTS.maxIvAgeMs;
  return nowMs - timestamp > maxAge ? 'iv_stale' : null;
}

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}

export function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

/**
 * Driftless lognormal price. "above": P(S_T > K). "up"/"down": probability the
 * path touches K before expiry (reflection principle with -σ²/2 log drift).
 */
export function plan17Probability(type, spot, strike, sigma, tauYears) {
  const S = Number(spot); const K = Number(strike);
  const v = Number(sigma) * Math.sqrt(Math.max(0, Number(tauYears)));
  if (!(S > 0 && K > 0 && v > 0)) return null;
  if (type === 'above') return normalCdf((Math.log(S / K) - v * v / 2) / v);
  if (type === 'up') {
    if (S >= K) return 1;
    const b = Math.log(K / S);
    return Math.min(1, normalCdf((-b - v * v / 2) / v) + (S / K) * normalCdf((-b + v * v / 2) / v));
  }
  if (type === 'down') {
    if (S <= K) return 1;
    const b = Math.log(S / K);
    return Math.min(1, normalCdf((-b + v * v / 2) / v) + (S / K) * normalCdf((-b - v * v / 2) / v));
  }
  return null;
}

export function parsePlan17Market({ event = null, market = null } = {}) {
  const eventSlug = String(event?.slug || '');
  let family = null; let coin = null;
  let match = eventSlug.match(/^(bitcoin|ethereum)-above-on-[a-z]+-\d{1,2}-\d{4}$/);
  if (match) { family = 'above'; coin = match[1]; }
  match = eventSlug.match(/^what-price-will-(bitcoin|ethereum)-hit-on-[a-z]+-\d{1,2}-\d{4}$/);
  if (match) { family = 'hitDaily'; coin = match[1]; }
  if (!family || !market) return null;
  const question = String(market.question || '');
  const strikeMatch = question.match(/\$([\d,]+(?:\.\d+)?)/);
  if (!strikeMatch) return null;
  const strike = Number(strikeMatch[1].replace(/,/g, ''));
  let type = null;
  if (family === 'above') type = 'above';
  else if (/\bdip\b|\bbelow\b|\bfall\b/i.test(question)) type = 'down';
  else if (/\breach\b|\bhit\b|\babove\b/i.test(question)) type = 'up';
  const endMs = Date.parse(market.endDate || event?.endDate || '');
  if (!type || !(strike > 0) || !Number.isFinite(endMs)) return null;
  return {
    family,
    coin,
    type,
    strike,
    endMs,
    windowStartMs: family === 'hitDaily' ? endMs - 86_400_000 : null,
    eventSlug
  };
}

function netCost(ask, feeRate) {
  const fee = polymarketCryptoTakerFee(1, ask, feeRate);
  const netShare = 1 - fee / ask;
  return netShare > 0 ? ask / netShare : null;
}

function quoteOk(book, { minAsk, maxAsk, maxSpread }) {
  const bid = finite(book?.bestBid ?? book?.bid);
  const ask = finite(book?.bestAsk ?? book?.ask);
  if (ask == null) return null;
  if (bid != null && ask - bid > maxSpread + 1e-9) return { reject: 'wide_spread', bid, ask };
  if (ask + 1e-9 < minAsk || ask - 1e-9 > maxAsk) return { reject: 'price_out_of_range', bid, ask };
  return { bid, ask, spread: bid != null ? ask - bid : null };
}

/**
 * market data: { spot, iv (DVOL, percent), ivTimestampMs, high, low } where high/low are the
 * Binance 1m extremes since the hit window opened.
 */
export function evaluatePlan17Row({
  event = null,
  market = null,
  data = null,
  yesBook = null,
  noBook = null,
  nowMs = Date.now(),
  ...options
} = {}) {
  const cfg = { ...PLAN17_DEFAULTS, ...options };
  if (!market || market.closed === true || market.active === false) return { ok: false, reason: 'not_open' };
  const parsed = parsePlan17Market({ event, market });
  if (!parsed) return { ok: false, reason: 'unparsed' };
  if (!cfg.families.includes(parsed.family)) return { ok: false, reason: 'family_off' };
  const minutesLeft = (parsed.endMs - nowMs) / 60_000;
  if (minutesLeft < cfg.minMinutesLeft) return { ok: false, reason: 'too_close' };
  if (minutesLeft / 60 > (cfg.maxHoursLeft?.[parsed.family] ?? 24)) return { ok: false, reason: 'too_far' };
  const ivReason = plan17IvSkipReason(data, nowMs, cfg.maxIvAgeMs);
  if (ivReason) return { ok: false, reason: ivReason };
  const spot = finite(data?.spot); const iv = finite(data?.iv);
  if (!(spot > 0) || !(iv > 0)) return { ok: false, reason: 'missing_market_data' };
  if (parsed.type === 'up' && finite(data?.high) != null && data.high >= parsed.strike) return { ok: false, reason: 'already_touched' };
  if (parsed.type === 'down' && finite(data?.low) != null && data.low <= parsed.strike) return { ok: false, reason: 'already_touched' };
  const scale = Number(cfg.volScale?.[parsed.family]) || 1;
  const pYesRaw = plan17Probability(parsed.type, spot, parsed.strike, (iv / 100) * scale, (parsed.endMs - nowMs) / YEAR_MS);
  if (pYesRaw == null) return { ok: false, reason: 'model_failed' };
  const pYes = Math.min(0.995, Math.max(0.005, pYesRaw));
  const outcomes = parseJsonArray(market.outcomes).map(String);
  const tokenIds = parseJsonArray(market.clobTokenIds).map(String);
  const yesIndex = outcomes.findIndex((name) => name.toLowerCase() === 'yes');
  const noIndex = outcomes.findIndex((name) => name.toLowerCase() === 'no');
  if (yesIndex < 0 || noIndex < 0 || !tokenIds[yesIndex] || !tokenIds[noIndex]) return { ok: false, reason: 'missing_outcomes' };
  const sides = [
    { outcome: outcomes[yesIndex], tokenId: tokenIds[yesIndex], p: pYes, book: yesBook },
    { outcome: outcomes[noIndex], tokenId: tokenIds[noIndex], p: 1 - pYes, book: noBook }
  ].map((side) => {
    const quote = quoteOk(side.book, cfg);
    if (!quote || quote.reject) return { ...side, ok: false };
    const cost = netCost(quote.ask, cfg.feeRate);
    const edge = Number.isFinite(cost) ? side.p - cost : -1;
    return { ...side, ...quote, cost: round4(cost), edge: round4(edge), ok: edge + 1e-9 >= cfg.minEdge };
  }).filter((side) => side.ok).sort((a, b) => b.edge - a.edge);
  const selected = sides[0];
  if (!selected) return { ok: false, reason: 'edge_below_threshold', pYes: round4(pYes) };
  return {
    ok: true,
    family: parsed.family,
    coin: parsed.coin,
    symbol: PLAN17_COINS[parsed.coin]?.symbol || parsed.coin,
    type: parsed.type,
    strike: parsed.strike,
    eventSlug: parsed.eventSlug,
    pYes: round4(pYes),
    p: round4(selected.p),
    edge: selected.edge,
    cost: selected.cost,
    ask: selected.ask,
    bid: selected.bid,
    spread: selected.spread == null ? null : round4(selected.spread),
    outcome: selected.outcome,
    tokenId: selected.tokenId,
    spot,
    iv,
    ivTimestampMs: data.ivTimestampMs,
    volScale: scale,
    marketSlug: String(market.slug || ''),
    conditionId: market.conditionId || null,
    title: market.question || market.slug,
    endDate: new Date(parsed.endMs).toISOString()
  };
}

/**
 * 二元合约的凯利比例。花 c 美元买到 1 美元兑付时，净赔率 b=(1-c)/c，
 * f* = (p-c)/(1-c)。c=0.5 时 b=1，退回图里的 f=p-q。
 * fraction 是分数凯利：p 来自模型而不是已知胜率，满仓凯利会把估计误差放大成大亏。
 * 返回的 usd 已套上单笔上限、现金和最小下单额。
 */
export function plan17KellyStake({
  p,
  cost,
  equity,
  cash = equity,
  fraction = 0.5,
  maxFraction = 0.08,
  minUsd = 1
} = {}) {
  const probability = Number(p);
  const price = Number(cost);
  const bankroll = Number(equity);
  if (!(probability > price) || !(price > 0 && price < 1) || !(bankroll > 0)) {
    return { usd: 0, fullKelly: 0, appliedFraction: 0 };
  }
  const fullKelly = (probability - price) / (1 - price);
  const scaled = fullKelly * (Number(fraction) > 0 ? Number(fraction) : 0.5);
  const appliedFraction = Math.min(Math.max(0, Number(maxFraction) || 0), scaled);
  let usd = appliedFraction * bankroll;
  if (Number.isFinite(Number(cash))) usd = Math.min(usd, Math.max(0, Number(cash)));
  usd = Math.round(usd * 100) / 100;
  const full = round4(fullKelly);
  const applied = round4(appliedFraction);
  if (!(usd + 1e-9 >= Math.max(0.01, Number(minUsd) || 1))) {
    return { usd: 0, fullKelly: full, appliedFraction: applied, reason: 'below_min' };
  }
  return { usd, fullKelly: full, appliedFraction: applied };
}

export function selectPlan17Buys({ rows = [], heldSlugs = new Set(), heldPerEvent = new Map(), nowMs = Date.now(), ...options } = {}) {
  const cfg = { ...PLAN17_DEFAULTS, ...options };
  const picks = [];
  for (const row of rows) {
    const decision = evaluatePlan17Row({ ...row, nowMs, ...options });
    if (!decision.ok || !decision.marketSlug || heldSlugs.has(decision.marketSlug)) continue;
    picks.push(decision);
  }
  picks.sort((a, b) => b.edge - a.edge);
  const perEvent = new Map(heldPerEvent);
  const out = [];
  for (const pick of picks) {
    const used = perEvent.get(pick.eventSlug) || 0;
    if (used >= cfg.maxPerEvent) continue;
    perEvent.set(pick.eventSlug, used + 1);
    out.push(pick);
  }
  return out;
}
