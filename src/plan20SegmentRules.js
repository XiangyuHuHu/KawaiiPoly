import { PLAN20_CURATED_RULES } from './plan20CuratedRules.js';
import { PLAN20_MINED_RULES } from './plan20MinedRules.js';

const FEATURE_KEYS = ['plan_id', 'category', 'price', 'direction', 'timeframe', 'resolution', 'symbol', 'hour'];

export function plan20RuleMatch(rule) {
  const source = rule?.match && typeof rule.match === 'object' ? rule.match : rule;
  const match = {};
  for (const key of FEATURE_KEYS) {
    if (source && Object.hasOwn(source, key)) match[key] = source[key];
  }
  return match;
}

// Curated rules win when a mined survivor repeats the same feature match.
export function mergePlan20Rules(curated = [], mined = []) {
  const merged = [];
  const seen = new Set();
  for (const rule of [...curated, ...mined]) {
    if (!rule || typeof rule !== 'object') continue;
    const key = JSON.stringify(plan20RuleMatch(rule));
    if (key === '{}' || seen.has(key)) continue;
    seen.add(key);
    merged.push(rule);
  }
  return merged;
}

function freezeRule(rule) {
  const copy = { ...rule };
  if (copy.match && typeof copy.match === 'object') copy.match = Object.freeze({ ...copy.match });
  if (copy.train && typeof copy.train === 'object') copy.train = Object.freeze({ ...copy.train });
  if (copy.holdout && typeof copy.holdout === 'object') copy.holdout = Object.freeze({ ...copy.holdout });
  return Object.freeze(copy);
}

export const PLAN20_SEGMENT_RULES = Object.freeze(
  mergePlan20Rules(PLAN20_CURATED_RULES, PLAN20_MINED_RULES).map(freezeRule)
);
