/** 公开模型用的纯函数。不访问网络。 */

export function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function normalCdf(x) {
  const z = Number(x);
  if (!Number.isFinite(z)) return null;
  if (z < -8) return 0;
  if (z > 8) return 1;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-0.5 * z * z);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

export function yearsBetween(now, end) {
  const ms = new Date(end).getTime() - new Date(now).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms / (365.25 * 24 * 60 * 60 * 1000);
}

/**
 * r = q = 0 时，S 在到期前触及更高障碍的风险中性概率。
 * 对数漂移 ν = -σ²/2。现货已经不低于障碍时视为几乎必然。
 */
export function gbmTouchProb({ spot, barrier, sigma, years }) {
  if (!(spot > 0) || !(barrier > 0) || !(sigma > 0) || !(years > 0)) return null;
  if (spot >= barrier) return 0.99;
  const b = Math.log(barrier / spot);
  const nu = -0.5 * sigma * sigma;
  const s = sigma * Math.sqrt(years);
  const first = normalCdf((-b + nu * years) / s);
  const weight = Math.exp((2 * nu * b) / (sigma * sigma));
  const second = weight * normalCdf((-b - nu * years) / s);
  if (first == null || !Number.isFinite(second)) return null;
  return clamp(first + second, 0, 0.99);
}

/** 远期测度下 P(S_T > strike)，r = 0，d2。 */
export function lognormalAboveProb({ forward, strike, sigma, years }) {
  if (!(forward > 0) || !(strike > 0) || !(sigma > 0) || !(years > 0)) return null;
  const s = sigma * Math.sqrt(years);
  const d2 = (Math.log(forward / strike) - 0.5 * sigma * sigma * years) / s;
  return normalCdf(d2);
}

export function americanToImplied(price) {
  const n = Number(price);
  if (!Number.isFinite(n) || n === 0) return null;
  if (n < 0) return (-n) / ((-n) + 100);
  return 100 / (n + 100);
}

export function devig(probs) {
  if (!Array.isArray(probs) || !probs.length) return null;
  if (probs.some((prob) => !(prob > 0 && prob < 1))) return null;
  const sum = probs.reduce((total, prob) => total + prob, 0);
  if (!(sum > 0)) return null;
  return probs.map((prob) => prob / sum);
}

export function upperBoundFromEffr(effr) {
  const rate = Number(effr);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const snapped = Math.ceil((rate - 1e-6) / 0.25) * 0.25;
  return Math.round(snapped * 100) / 100;
}

export function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function yesQuote(market) {
  const outcomes = parseJsonArray(market?.outcomes);
  const prices = parseJsonArray(market?.outcomePrices);
  if (!outcomes || !prices) return null;
  const yesIndex = outcomes.findIndex((outcome) => String(outcome).toLowerCase() === 'yes');
  const noIndex = outcomes.findIndex((outcome) => String(outcome).toLowerCase() === 'no');
  if (yesIndex < 0) return null;
  const yes = Number(prices[yesIndex]);
  const no = noIndex >= 0 ? Number(prices[noIndex]) : null;
  if (!(yes > 0 && yes < 1)) return null;
  if (no > 0 && no < 1 && yes + no > 1.02) {
    const yesBid = 1 - no;
    if (yesBid > 0 && yesBid < yes) return { ask: yes, mid: (yes + yesBid) / 2 };
  }
  return { ask: yes, mid: yes };
}

const TEAM_NOISE = /[^a-z0-9]+/g;

export function teamTokens(name) {
  const norm = String(name || '').toLowerCase().replace(TEAM_NOISE, ' ').trim();
  const parts = norm.split(' ').filter(Boolean);
  return { norm, last: parts.at(-1) || '' };
}

export function teamsMatch(leftName, rightName) {
  const left = teamTokens(leftName);
  const right = teamTokens(rightName);
  if (!left.norm || !right.norm) return false;
  if (left.norm === right.norm) return true;
  if (left.norm.includes(right.norm) || right.norm.includes(left.norm)) return true;
  return left.last.length >= 4 && left.last === right.last;
}
