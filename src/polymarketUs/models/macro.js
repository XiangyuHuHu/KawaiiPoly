import { round4, upperBoundFromEffr } from './math.js';

const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12
};

export function kalshiYesMid(market) {
  const bid = Number(market?.yes_bid_dollars);
  const ask = Number(market?.yes_ask_dollars);
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid >= 0 && ask > 0 && ask + 1e-9 >= bid && ask - bid <= 0.5) {
    const mid = (bid + Math.min(ask, 0.999)) / 2;
    if (mid > 0 && mid < 1) return { mid, tight: Math.min(ask, 1) - bid <= 0.04 };
  }
  const last = Number(market?.last_price_dollars);
  if (last > 0 && last < 1) return { mid: last, tight: false };
  return null;
}

function sameStrike(left, right) {
  return Math.abs(Number(left) - Number(right)) < 0.01;
}

export function probAboveStrike(markets, strike) {
  const row = (markets || []).find((market) => sameStrike(market?.floor_strike, strike));
  if (!row) return null;
  const mid = kalshiYesMid(row);
  return mid ? { ...mid, ticker: row.ticker || null } : null;
}

/**
 * 降息：会议后上限 ≤ 当前上限 − 0.25，也就是不再高于 (当前 − 0.25) 那一档。
 * 加息：会议后上限高于当前上限。
 */
export function fedMoveProb({ currentUpper, markets, kind }) {
  const upper = Number(currentUpper);
  if (!Number.isFinite(upper)) return null;
  const strike = kind === 'hike' ? upper : Math.round((upper - 0.25) * 100) / 100;
  const above = probAboveStrike(markets, strike);
  if (!above) return null;
  const prob = kind === 'hike' ? above.mid : 1 - above.mid;
  if (!(prob > 0 && prob < 1)) return null;
  return { prob, tight: above.tight, ticker: above.ticker, strike };
}

export function fedWatchMoveProb(payload, { currentUpper, kind, meetingDate }) {
  const rows = payload?.fedWatch || payload?.meetings || [];
  if (!Array.isArray(rows) || !rows.length) return null;
  const wanted = meetingDate ? String(meetingDate).slice(0, 10) : null;
  const meeting = rows.find((row) => wanted && String(row.meetingDate || row.date || '').startsWith(wanted)) || rows[rows.length - 1];
  const buckets = meeting?.probabilities || meeting?.probs || [];
  if (!Array.isArray(buckets) || !buckets.length) return null;
  let cut = 0;
  let hike = 0;
  let any = 0;
  for (const bucket of buckets) {
    const probability = Number(bucket.probability ?? bucket.prob);
    const label = String(bucket.rate || bucket.label || '');
    const upper = Number(label.split('-').pop());
    if (!Number.isFinite(probability) || !Number.isFinite(upper)) continue;
    const weight = probability > 1 ? probability / 100 : probability;
    any += weight;
    if (upper <= currentUpper - 0.25 + 1e-9) cut += weight;
    if (upper >= currentUpper + 0.25 - 1e-9) hike += weight;
  }
  if (!(any > 0)) return null;
  const prob = (kind === 'hike' ? hike : cut) / any;
  return prob > 0 && prob < 1 ? { prob, tight: false } : null;
}

function blob(market) {
  return [market?.question, market?.slug, market?.description].filter(Boolean).join('\n');
}

export function macroKind(market) {
  const slug = String(market?.slug || '').toLowerCase();
  const lower = blob(market).toLowerCase();
  if (/ethereum|treasury|t-bill/.test(lower)) return null;
  if (/rate hike|increases the upper bound/.test(lower) || (/\bfed\b/.test(lower) && /hike/.test(lower))) {
    return { kind: 'fed-hike' };
  }
  if (/rate cut|decreases the upper bound/.test(lower) || (/\bfed\b/.test(lower) && /cut/.test(lower))) {
    return { kind: 'fed-cut' };
  }
  const party = /-dem\b/.test(slug) ? 'd' : (/-rep\b/.test(slug) ? 'r' : null);
  const chamber = /house|\busho\b/.test(lower) ? 'house' : (/senate|\bussen\b/.test(lower) ? 'senate' : null);
  if (party && chamber) return { kind: `${chamber}-${party}` };
  return null;
}

function monthIn(text) {
  const lower = String(text || '').toLowerCase();
  let found = null;
  for (const [name, value] of Object.entries(MONTHS)) {
    if (new RegExp(`\\b${name}\\b`).test(lower)) found = value;
  }
  return found;
}

export function selectFedMeeting(meetings, market) {
  const text = blob(market);
  const dated = (meetings || []).filter((meeting) => meeting?.markets?.length && meeting.strikeDate);
  if (!dated.length) return null;
  const month = /meeting/i.test(text) ? monthIn(text) : null;
  if (month) {
    const picked = dated.find((meeting) => new Date(meeting.strikeDate).getUTCMonth() + 1 === month);
    if (picked) return picked;
  }
  const end = Date.parse(market?.endDate || '');
  const before = dated
    .filter((meeting) => !Number.isFinite(end) || Date.parse(meeting.strikeDate) <= end)
    .sort((left, right) => Date.parse(left.strikeDate) - Date.parse(right.strikeDate));
  return before.at(-1) || dated[0];
}

function partyProb(book, kind) {
  const side = kind.endsWith('-d') ? 'd' : 'r';
  const row = book?.[side];
  return row ? kalshiYesMid(row) : null;
}

function pushBinary(rows, market, prob, confidence, basis) {
  if (!(prob > 0.02 && prob < 0.98) || !market?.slug) return;
  const shared = {
    sector: 'macro',
    slug: market.slug,
    title: market.question || market.slug,
    question: market.question || '',
    category: market.category || 'macro',
    resolution_risk: 'Low',
    confidence,
    expires_at: market.endDate || null,
    window_id: market.slug
  };
  rows.push({ ...shared, side: 'Yes', model_prob: round4(prob), basis });
  if (prob > 0.12 && prob < 0.88) {
    rows.push({
      ...shared,
      side: 'No',
      model_prob: round4(1 - prob),
      basis: `${basis} 买 No 是互补概率。`
    });
  }
}

export function macroRowsFromBooks({
  markets = [],
  currentUpper = null,
  fedMeetings = [],
  fedWatch = null,
  house = null,
  senate = null
} = {}) {
  const rows = [];
  for (const market of markets) {
    if (market?.active === false || market?.closed === true) continue;
    const kind = macroKind(market);
    if (!kind) continue;
    if (kind.kind === 'fed-cut' || kind.kind === 'fed-hike') {
      const meeting = selectFedMeeting(fedMeetings, market);
      const move = kind.kind === 'fed-hike' ? 'hike' : 'cut';
      const kalshi = meeting ? fedMoveProb({ currentUpper, markets: meeting.markets, kind: move }) : null;
      const watch = fedWatchMoveProb(fedWatch, {
        currentUpper,
        kind: move,
        meetingDate: meeting?.strikeDate
      });
      let prob = kalshi?.prob ?? null;
      let confidence = kalshi?.tight ? 'High' : 'Med';
      let source = kalshi ? `Kalshi ${kalshi.ticker || meeting?.eventTicker}` : '';
      if (watch && kalshi) {
        prob = (kalshi.prob + watch.prob) / 2;
        confidence = Math.abs(kalshi.prob - watch.prob) <= 0.08 ? 'High' : 'Med';
        source = `${source}，并参考 CME FedWatch`;
      } else if (watch && prob == null) {
        prob = watch.prob;
        confidence = 'Med';
        source = 'CME FedWatch';
      }
      if (prob == null) continue;
      const basis = `联邦基金上限当前 ${currentUpper}% ；${meeting?.eventTicker || '会议'} ${move === 'hike' ? '加息' : '降息'}概率来自 ${source}，模型 ${(prob * 100).toFixed(1)}%。`;
      pushBinary(rows, market, prob, confidence, basis);
      continue;
    }
    const book = kind.kind.startsWith('house') ? house : senate;
    const quote = partyProb(book, kind.kind);
    if (!quote) continue;
    const basis = `${kind.kind.startsWith('house') ? '众议院' : '参议院'}控制权对照 Kalshi，模型 ${(quote.mid * 100).toFixed(1)}%。`;
    pushBinary(rows, market, quote.mid, quote.tight ? 'High' : 'Med', basis);
  }
  return rows;
}

export function upperFromEffrPayload(payload) {
  const rows = payload?.refRates || [];
  const effr = rows.find((row) => row?.type === 'EFFR') || rows[0];
  return upperBoundFromEffr(effr?.percentRate);
}
