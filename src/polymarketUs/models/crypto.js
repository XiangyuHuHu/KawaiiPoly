import { gbmTouchProb, lognormalAboveProb, round4, yearsBetween } from './math.js';

const MONTHS = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11
};

export function parseDeribitInstrument(name) {
  const match = String(name || '').match(/^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-([CP])$/);
  if (!match || MONTHS[match[2]] == null) return null;
  const expiryMs = Date.UTC(2000 + Number(match[3]), MONTHS[match[2]], Number(match[1]), 8, 0, 0);
  return { expiryMs, strike: Number(match[4]), kind: match[5], name };
}

function commaNumber(text) {
  const value = Number(String(text || '').replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

function roundStrike(value) {
  if (!Number.isFinite(value)) return null;
  if (value >= 1000 && Math.abs(value - Math.round(value)) > 0 && Math.abs(value % 1000) > 500) {
    return Math.ceil(value / 1000) * 1000;
  }
  return Math.round(value);
}

export function parseUsBtcMarket(market) {
  const description = String(market?.description || '');
  const question = String(market?.question || '');
  const slug = String(market?.slug || '');
  const blob = `${question}\n${description}\n${slug}`;
  if (!/\bbitcoin\b|\bbtc\b/i.test(blob)) return null;
  if (/\bethereum\b|\beth-usd\b/i.test(blob) && !/\bbitcoin\b|\bbtc\b/i.test(blob)) return null;
  if (/updown|15m|1h/i.test(slug)) return null;
  const between = description.match(/between\s+([\d,]+)\s+to\s+([\d,.]+)/i);
  if (between) {
    const low = commaNumber(between[1]);
    const high = roundStrike(commaNumber(between[2]));
    if (!(low > 0) || !(high > low)) return null;
    return { kind: 'range', low, high, end: market.endDate || null };
  }
  const touch = /at any point/i.test(description);
  const above = description.match(/(?:above|or above)\s*\$?([\d,]+(?:\.\d+)?)/i);
  if (!above) return null;
  const strike = roundStrike(commaNumber(above[1]));
  if (!(strike > 0)) return null;
  return { kind: touch ? 'touch' : 'above', strike, end: market.endDate || null };
}

export function selectOptionChain(summaries, targetMs) {
  const calls = [];
  for (const row of summaries || []) {
    const parsed = parseDeribitInstrument(row?.instrument_name);
    if (!parsed || parsed.kind !== 'C') continue;
    const iv = Number(row.mark_iv);
    const forward = Number(row.underlying_price);
    if (!(iv > 0) || !(forward > 0)) continue;
    calls.push({ ...parsed, iv: iv / 100, forward });
  }
  if (!calls.length) return null;
  const expiries = [...new Set(calls.map((row) => row.expiryMs))].sort((left, right) => left - right);
  const before = expiries.filter((expiry) => !Number.isFinite(targetMs) || expiry <= targetMs);
  const expiryMs = before.at(-1) || expiries[0];
  const chain = calls.filter((row) => row.expiryMs === expiryMs);
  return { expiryMs, forward: chain[0].forward, chain };
}

export function ivNearStrike(chain, strike) {
  if (!chain?.length) return null;
  return chain.reduce((best, row) => {
    if (!best) return row;
    return Math.abs(row.strike - strike) < Math.abs(best.strike - strike) ? row : best;
  }, null);
}

export function btcModelProb({ contract, chain, now }) {
  if (!contract || !chain) return null;
  const years = yearsBetween(now, chain.expiryMs);
  if (!(years > 0)) return null;
  const anchor = contract.kind === 'range' ? (contract.low + contract.high) / 2 : contract.strike;
  const option = ivNearStrike(chain.chain, anchor);
  if (!option) return null;
  const sigma = option.iv;
  const forward = chain.forward;
  if (contract.kind === 'range') {
    const upper = lognormalAboveProb({ forward, strike: contract.low, sigma, years });
    const lower = lognormalAboveProb({ forward, strike: contract.high, sigma, years });
    if (upper == null || lower == null) return null;
    return { prob: Math.min(0.99, Math.max(0, upper - lower)), sigma, forward, years };
  }
  if (contract.kind === 'touch') {
    const prob = gbmTouchProb({ spot: forward, barrier: contract.strike, sigma, years });
    return prob == null ? null : { prob, sigma, forward, years };
  }
  const prob = lognormalAboveProb({ forward, strike: contract.strike, sigma, years });
  return prob == null ? null : { prob, sigma, forward, years };
}

export function cryptoRowsFromChain({ markets = [], summaries = [], now = new Date() } = {}) {
  const grouped = new Map();
  const pending = [];
  for (const market of markets) {
    if (market?.category && market.category !== 'crypto') continue;
    if (market?.closed === true || market?.active === false) continue;
    const contract = parseUsBtcMarket(market);
    if (!contract || !market?.slug) continue;
    const targetMs = Date.parse(contract.end || '') || Date.parse(market.endDate || '');
    pending.push({ market, contract, targetMs });
  }
  const rows = [];
  for (const item of pending) {
    const key = Number.isFinite(item.targetMs) ? String(item.targetMs) : 'none';
    if (!grouped.has(key)) grouped.set(key, selectOptionChain(summaries, item.targetMs));
    const chain = grouped.get(key);
    const model = btcModelProb({ contract: item.contract, chain, now });
    if (!model || !(model.prob > 0.02 && model.prob < 0.98)) continue;
    const kindLabel = item.contract.kind === 'touch' ? '触及' : (item.contract.kind === 'range' ? '区间' : '到期高于');
    const level = item.contract.kind === 'range'
      ? `${item.contract.low}–${item.contract.high}`
      : String(item.contract.strike);
    const basis = `Deribit BTC 期权远期 ${model.forward.toFixed(0)}、IV ${(model.sigma * 100).toFixed(1)}%，${kindLabel} ${level} 的模型 ${(model.prob * 100).toFixed(1)}%。`;
    const resolution = /BRTI|CF Benchmarks/i.test(item.market.description || '') ? 'Low' : 'Med';
    rows.push({
      sector: 'crypto',
      slug: item.market.slug,
      side: 'Yes',
      model_prob: round4(model.prob),
      title: item.market.question || item.market.slug,
      question: item.market.question || '',
      category: 'crypto',
      resolution_risk: resolution,
      confidence: item.contract.kind === 'touch' ? 'Med' : 'High',
      basis,
      expires_at: item.market.endDate || null,
      window_id: item.market.slug,
      _distance: Math.abs(model.prob - 0.5)
    });
  }
  rows.sort((left, right) => left._distance - right._distance);
  return rows.slice(0, 16).map(({ _distance, ...row }) => row);
}
