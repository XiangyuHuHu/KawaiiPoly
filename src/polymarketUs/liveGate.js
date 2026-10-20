/**
 * 尾盘分歧闸门，扫描 evaluateUsSignal 和下单 evaluateUsSignal 共用。
 *
 * 地板仍是 model ≥ 0.88、价格 ≤ 0.95。只有 model − ask > 0.10 才进入闸门：
 * - ESPN 与 Pinnacle 都 ≥ 0.88，且比分/时钟年龄 ≤ 60s：正常仓。
 * - 两个来源都没有：只下 $1。手写 model 没有带上两边概率时走这里。
 * - 只有一边、两边不一致、或比分/时钟不新鲜：跳过。
 *
 * 观察日志里的足球热门（去水 ≥ 0.80、价格 ≤ 0.93、75' 之前）只打纸面标记，不进这个闸门。
 */

import {
  US_LIVE_ENDGAME_DIVERGENCE,
  US_LIVE_ENDGAME_DIVERGENCE_FALLBACK_USD,
  US_LIVE_ENDGAME_DIVERGENCE_MIN_MODEL,
  US_LIVE_ENDGAME_SCORE_MAX_AGE_MS,
  US_LIVE_ENDGAME_V2_MAX_PRICE,
  US_LIVE_ENDGAME_V2_MIN_MODEL,
  liveEndgameV2Enabled,
  US_SOCCER_PAPER_MAX_PRICE,
  US_SOCCER_PAPER_MIN_MODEL,
  US_SOCCER_PAPER_PHASES
} from './constants.js';
import { US_RULES } from './rules.js';

function finite(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}

export function resolveScoreAgeMs({ scoreAgeMs, scoreSampledAt, now = new Date() } = {}) {
  const sampled = Date.parse(scoreSampledAt || '');
  if (Number.isFinite(sampled)) {
    const at = now instanceof Date ? now.getTime() : new Date(now).getTime();
    if (!Number.isFinite(at)) return null;
    return at - sampled;
  }
  return finite(scoreAgeMs);
}

/**
 * @returns {{ action: 'pass'|'skip'|'micro', reason: string, divergence: number|null, sizeUsd?: number }}
 */
export function endgameDivergenceGate({
  modelProb,
  ask,
  espnProb = null,
  pinnacleProb = null,
  scoreAgeMs = null,
  scoreSampledAt = null,
  now = new Date(),
  rules = US_RULES,
  agreeMin = null,
  allowMicro = true
} = {}) {
  const edge = rules?.edge || {};
  if (edge.liveEndgameDivergenceEnabled === false) {
    return { action: 'pass', reason: 'disabled', divergence: null };
  }
  const model = finite(modelProb);
  const price = finite(ask);
  if (model == null || price == null) {
    return { action: 'pass', reason: 'not_applicable', divergence: null };
  }
  const gap = finite(edge.liveEndgameDivergence) ?? US_LIVE_ENDGAME_DIVERGENCE;
  const divergence = round4(model - price);
  if (!(divergence > gap)) {
    return { action: 'pass', reason: 'under_divergence', divergence };
  }
  const agreeFloor = finite(agreeMin) ?? finite(edge.liveEndgameDivergenceMinModel) ?? US_LIVE_ENDGAME_DIVERGENCE_MIN_MODEL;
  const maxAge = finite(edge.liveEndgameScoreMaxAgeMs) ?? US_LIVE_ENDGAME_SCORE_MAX_AGE_MS;
  const rawFallback = finite(edge.liveEndgameDivergenceFallbackUsd);
  const fallback = rawFallback != null && rawFallback > 0
    ? rawFallback
    : US_LIVE_ENDGAME_DIVERGENCE_FALLBACK_USD;
  const espn = finite(espnProb);
  const pinnacle = finite(pinnacleProb);
  if (espn == null && pinnacle == null) {
    if (!allowMicro) return { action: 'skip', reason: 'sources_unavailable', divergence };
    return { action: 'micro', reason: 'sources_unavailable', divergence, sizeUsd: fallback };
  }
  const age = resolveScoreAgeMs({ scoreAgeMs, scoreSampledAt, now });
  const fresh = age != null && age >= 0 && age <= maxAge;
  const espnOk = espn != null && espn + 1e-12 >= agreeFloor;
  const pinOk = pinnacle != null && pinnacle + 1e-12 >= agreeFloor;
  if (espnOk && pinOk && fresh) {
    return { action: 'pass', reason: 'sources_agree', divergence };
  }
  const why = [];
  if (!espnOk) why.push(espn == null ? 'espn_missing' : 'espn_below');
  if (!pinOk) why.push(pinnacle == null ? 'pinnacle_missing' : 'pinnacle_below');
  if (!fresh) why.push(age == null ? 'score_age_missing' : 'score_stale');
  return { action: 'skip', reason: why.join('+'), divergence };
}

/**
 * 足球 75' 之前的去水热门。只用 Pinnacle 去水，不用 ESPN 胜率。
 * would_signal_paper 为 true 时仍然不下单。
 */
export function soccerFavoritePaper({
  sport,
  phase,
  pinnacleProb = null,
  ask = null,
  rules = US_RULES
} = {}) {
  if (sport !== 'soccer') return { would_signal_paper: false, reason: 'not_soccer' };
  const phases = rules?.edge?.soccerPaperPhases || US_SOCCER_PAPER_PHASES;
  if (!phases.includes(phase)) return { would_signal_paper: false, reason: 'phase' };
  const minModel = finite(rules?.edge?.soccerPaperMinModel) ?? US_SOCCER_PAPER_MIN_MODEL;
  const maxPrice = finite(rules?.edge?.soccerPaperMaxPrice) ?? US_SOCCER_PAPER_MAX_PRICE;
  const prob = finite(pinnacleProb);
  const price = finite(ask);
  if (prob == null || !(prob + 1e-12 >= minModel)) {
    return { would_signal_paper: false, reason: 'devig' };
  }
  if (price == null || price - maxPrice > 1e-9) {
    return { would_signal_paper: false, reason: 'price' };
  }
  return { would_signal_paper: true, reason: 'soccer_favorite_paper' };
}

/**
 * 尾盘试单是否过规则。深度、过期 BBO、日帽和现金在发信号和下单时再查。
 * model − ask > 0.10 时两边都要 ≥ 试单地板，且比分/时钟新鲜，否则跳过。
 */
export function endgameV2Rule({
  phase,
  modelProb,
  ask,
  espnProb = null,
  pinnacleProb = null,
  scoreAgeMs = null,
  scoreSampledAt = null,
  now = new Date(),
  rules = US_RULES,
  enabled = liveEndgameV2Enabled()
} = {}) {
  if (!enabled) return { pass: false, action: 'skip', reason: 'disabled', divergence: null };
  const minModel = finite(rules?.edge?.liveEndgameV2MinModel) ?? US_LIVE_ENDGAME_V2_MIN_MODEL;
  const maxPrice = finite(rules?.edge?.liveEndgameV2MaxPrice) ?? US_LIVE_ENDGAME_V2_MAX_PRICE;
  if (phase !== 'endgame') return { pass: false, action: 'skip', reason: 'not_endgame', divergence: null };
  const model = finite(modelProb);
  const price = finite(ask);
  if (model == null) return { pass: false, action: 'skip', reason: 'no_model', divergence: null };
  if (price == null || !(price > 0) || price - maxPrice > 1e-9) {
    return { pass: false, action: 'skip', reason: 'price', divergence: model == null ? null : round4(model - (price ?? 0)) };
  }
  if (model + 1e-12 < minModel) {
    return { pass: false, action: 'skip', reason: 'model_floor', divergence: round4(model - price) };
  }
  const gate = endgameDivergenceGate({
    modelProb: model,
    ask: price,
    espnProb,
    pinnacleProb,
    scoreAgeMs,
    scoreSampledAt,
    now,
    rules,
    agreeMin: minModel,
    allowMicro: false
  });
  return {
    pass: gate.action === 'pass',
    action: gate.action,
    reason: gate.reason,
    divergence: gate.divergence
  };
}
