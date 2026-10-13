import { parseJsonArray } from './polymarketClient.js';
import { polymarketCryptoTakerFee } from './polymarketMarketUtils.js';
import { stationFromDescription } from './plan16Stations.js';

export const PLAN16_ID = 'plan16';
export const PLAN16_VERSION = 'plan16_ensemble_temp_v1';

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
};

export const PLAN16_DEFAULTS = Object.freeze({
  minAsk: 0.08,
  maxAsk: 0.80,
  maxSpread: 0.06,
  minEdge: 0.08,
  minMembers: 20,
  maxDays: 2,
  highCutoffHour: 15,
  lowCutoffHour: 8,
  feeRate: 0.07
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function list(value) {
  return parseJsonArray(value);
}

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}

export function parsePlan16Question(question = '', year = null) {
  const text = String(question || '').trim().replace(/\?$/, '');
  const match = text.match(/^Will the (highest|lowest) temperature in (.+?) be (.+) on ([A-Za-z]+) (\d{1,2})$/);
  if (!match) return null;
  const kind = match[1].toLowerCase() === 'highest' ? 'high' : 'low';
  const place = match[2].trim();
  const spec = match[3].trim();
  const month = MONTHS[match[4].toLowerCase()];
  const day = Number(match[5]);
  const y = Number(year);
  if (!month || !(day >= 1 && day <= 31) || !Number.isFinite(y)) return null;
  const below = spec.match(/^(\d+)°([CF]) or below$/i);
  const above = spec.match(/^(\d+)°([CF]) or (?:higher|above)$/i);
  const between = spec.match(/^between (\d+)-(\d+)°([CF])$/i);
  const exact = spec.match(/^(\d+)°([CF])$/i);
  let bucket = null;
  if (below) bucket = { kind: 'below', low: Number(below[1]), high: Number(below[1]), unit: below[2].toUpperCase() };
  else if (above) bucket = { kind: 'above', low: Number(above[1]), high: Number(above[1]), unit: above[2].toUpperCase() };
  else if (between) bucket = { kind: 'between', low: Number(between[1]), high: Number(between[2]), unit: between[3].toUpperCase() };
  else if (exact) bucket = { kind: 'exact', low: Number(exact[1]), high: Number(exact[1]), unit: exact[2].toUpperCase() };
  if (!bucket || bucket.high < bucket.low) return null;
  const date = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { kind, place, bucket, date };
}

export function temperatureInBucket(temp, bucket) {
  const rounded = Math.round(Number(temp));
  if (!Number.isFinite(rounded) || !bucket) return false;
  if (bucket.kind === 'below') return rounded <= bucket.low;
  if (bucket.kind === 'above') return rounded >= bucket.low;
  if (bucket.kind === 'between') return rounded >= bucket.low && rounded <= bucket.high;
  return rounded === bucket.low;
}

export function ensembleYesProbability(values, bucket) {
  const rows = (values || []).filter((value) => Number.isFinite(Number(value)));
  if (!rows.length) return null;
  const hits = rows.filter((value) => temperatureInBucket(value, bucket)).length;
  return hits / rows.length;
}

function localClock(nowMs, offsetSeconds) {
  const shifted = new Date(nowMs + (Number(offsetSeconds) || 0) * 1000);
  return {
    date: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours()
  };
}

function dayDistance(fromDate, toDate) {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

function netCost(ask, feeRate) {
  const fee = polymarketCryptoTakerFee(1, ask, feeRate);
  const netShare = 1 - fee / ask;
  return netShare > 0 ? ask / netShare : null;
}

function quoteOk(book, { minAsk, maxAsk, maxSpread }) {
  const bid = finite(book?.bestBid ?? book?.bid);
  const ask = finite(book?.bestAsk ?? book?.ask);
  if (bid == null || ask == null || !(ask > bid)) return null;
  if (ask - bid > maxSpread + 1e-9) return { reject: 'wide_spread', bid, ask };
  if (ask + 1e-9 < minAsk || ask - 1e-9 > maxAsk) return { reject: 'price_out_of_range', bid, ask };
  return { bid, ask, spread: ask - bid };
}

/**
 * One city-day gets at most one buy. The probability is the share of ensemble
 * members whose rounded daily high or low falls in the contract bucket.
 * A buy requires that probability to clear the fee-inclusive ask by minEdge.
 * After the local afternoon (high) or morning (low), the airport reading is
 * no longer a forecast, so the market is skipped.
 */
export function evaluatePlan16Row({
  market = null,
  event = null,
  forecast = null,
  yesBook = null,
  noBook = null,
  nowMs = Date.now(),
  ...options
} = {}) {
  const cfg = { ...PLAN16_DEFAULTS, ...options };
  if (!market || market.closed === true || market.active === false) return { ok: false, reason: 'not_open' };
  const year = Number(String(market.endDate || event?.endDate || '').slice(0, 4));
  const parsed = parsePlan16Question(market.question || '', year);
  if (!parsed) return { ok: false, reason: 'unparsed' };
  const station = stationFromDescription(market.description || event?.description || '');
  if (!station) return { ok: false, reason: 'unknown_station' };
  const endMs = Date.parse(market.endDate || event?.endDate || '');
  if (!Number.isFinite(endMs) || endMs <= nowMs) return { ok: false, reason: 'horizon' };
  if (!forecast?.days) return { ok: false, reason: 'missing_forecast' };
  const clock = localClock(nowMs, forecast.offsetSeconds);
  const ahead = dayDistance(clock.date, parsed.date);
  if (ahead == null || ahead < 0 || ahead > cfg.maxDays) return { ok: false, reason: 'horizon' };
  const cutoff = parsed.kind === 'high' ? cfg.highCutoffHour : cfg.lowCutoffHour;
  if (ahead === 0 && clock.hour >= cutoff) return { ok: false, reason: 'observation_started' };
  const series = forecast.days[parsed.date]?.[parsed.kind === 'high' ? 'max' : 'min'] || [];
  if (series.length < cfg.minMembers) return { ok: false, reason: 'thin_ensemble' };
  const pYes = ensembleYesProbability(series, parsed.bucket);
  if (pYes == null) return { ok: false, reason: 'thin_ensemble' };
  const outcomes = list(market.outcomes).map(String);
  const tokenIds = list(market.clobTokenIds).map(String);
  const yesIndex = outcomes.findIndex((name) => name.toLowerCase() === 'yes');
  const noIndex = outcomes.findIndex((name) => name.toLowerCase() === 'no');
  if (yesIndex < 0 || noIndex < 0 || !tokenIds[yesIndex] || !tokenIds[noIndex]) {
    return { ok: false, reason: 'missing_outcomes' };
  }
  const sides = [
    { outcome: outcomes[yesIndex], tokenId: tokenIds[yesIndex], p: pYes, book: yesBook },
    { outcome: outcomes[noIndex], tokenId: tokenIds[noIndex], p: 1 - pYes, book: noBook }
  ].map((side) => {
    const quote = quoteOk(side.book, cfg);
    if (!quote || quote.reject) {
      return { ...side, ok: false, reason: quote?.reject || 'incomplete_book' };
    }
    const cost = netCost(quote.ask, cfg.feeRate);
    const edge = Number.isFinite(cost) ? side.p - cost : -1;
    return { ...side, ok: edge + 1e-9 >= cfg.minEdge, reason: edge + 1e-9 >= cfg.minEdge ? null : 'edge_below_threshold', ...quote, cost: round4(cost), edge: round4(edge), p: round4(side.p) };
  }).filter((side) => side.ok).sort((a, b) => b.edge - a.edge);
  const selected = sides[0];
  if (!selected) return { ok: false, reason: 'edge_below_threshold', pYes: round4(pYes) };
  return {
    ok: true,
    groupKey: `${station.icao}|${parsed.date}|${parsed.kind}`,
    city: station.name,
    icao: station.icao,
    date: parsed.date,
    kind: parsed.kind,
    bucket: parsed.bucket,
    pYes: round4(pYes),
    members: series.length,
    edge: selected.edge,
    ask: selected.ask,
    bid: selected.bid,
    spread: round4(selected.spread),
    outcome: selected.outcome,
    tokenId: selected.tokenId,
    p: selected.p,
    marketSlug: String(market.slug || ''),
    conditionId: market.conditionId || null,
    title: market.question || event?.title || market.slug,
    endDate: new Date(endMs).toISOString()
  };
}

export function selectPlan16Buys({ rows = [], openGroupKeys = new Set(), nowMs = Date.now(), ...options } = {}) {
  const best = new Map();
  for (const row of rows) {
    const decision = evaluatePlan16Row({ ...row, nowMs, ...options });
    if (!decision.ok || !decision.marketSlug || openGroupKeys.has(decision.groupKey)) continue;
    const previous = best.get(decision.groupKey);
    if (!previous || decision.edge > previous.edge) best.set(decision.groupKey, decision);
  }
  return [...best.values()].sort((a, b) => b.edge - a.edge);
}
