/**
 * Paper-only A/B contrasts. Controls stay on their original plan ids.
 * Treatment arms are separate ledgers: plan14b, plan16b, plan2_6b, plan3_6b.
 *
 * Live trading is not a knob here. paperContrastLiveTradingEnabled() is always
 * false, and the trading service refuses to put these ids on the live scheduler.
 *
 * How to read a comparison (held-out / future paper fills only):
 * - Pair by plan family: plan14 vs plan14b, plan16 vs plan16b, plan2_6 vs plan2_6b,
 *   plan3_6 vs plan3_6b. Same clock, separate cash. Do not mix ledgers.
 * - Score fee- and slippage-aware net ROI: settled pnl / cost, after the paper
 *   taker fee (shares reduced) and the executable ask (plan3.6 already adds its
 *   paper slippage ticks before the edge check).
 * - Also report max drawdown on each ledger's equity curve. A higher ROI with a
 *   deeper drawdown is not a win.
 * - Slice by ask bucket (for example 8–20¢, 20–40¢, 40–80¢, 80¢+) and compare
 *   each arm to the same bucket's baseline, not to the other arm's different mix.
 *   plan16b exists specifically so sub-20¢ tail fills stop dominating the treatment.
 * - Do not declare a winner from a handful of fills. These arms change one knob each.
 *
 * Turn the contrasts on locally (paper server; do not set LIVE flags):
 * - Default: POLYMARKET_PAPER_AB_CONTRASTS is on, and each *b new-entries flag is on.
 * - Stop all four: POLYMARKET_PAPER_AB_CONTRASTS=false
 * - Stop one arm: POLYMARKET_PLAN14B_ENABLED=false (same pattern for PLAN16B,
 *   PLAN2_6B, PLAN3_6B).
 * - plan14 / plan16 controls still obey their own new-entries flags
 *   (POLYMARKET_PLAN14_NEW_ENTRIES_ENABLED / POLYMARKET_PLAN16_NEW_ENTRIES_ENABLED).
 *   Leave those unset and the control ledger does not open new paper trades.
 * - plan2_6 and plan3_6 controls are retired on the main loop. While plan2_6b /
 *   plan3_6b entries are on, the paper A/B loop also runs the original rule into
 *   the control ledger. That path never calls the live executor.
 */

import { getCalibratedConfidence } from './polymarketCalibration.js';
import { resolvePlan14Config } from './polymarketPlan14.js';

export const PAPER_AB_CONTRAST_IDS = Object.freeze(['plan14b', 'plan16b', 'plan2_6b', 'plan3_6b']);

export const PLAN14B_ID = 'plan14b';
export const PLAN14B_VERSION = 'plan14b_half_model_weight_5m';
export const PLAN14B_MODEL_WEIGHT_SCALE = 0.5;

export const PLAN16B_ID = 'plan16b';
export const PLAN16B_VERSION = 'plan16b_min_ask_0_20';
export const PLAN16B_MIN_ASK = 0.20;

export const PLAN2_6B_ID = 'plan2_6b';
export const PLAN2_6B_VERSION = 'plan2_6b_entry_max_0_80';
export const PLAN2_6B_ENTRY_MAX = 0.80;

export const PLAN3_6B_ID = 'plan3_6b';
export const PLAN3_6B_VERSION = 'plan3_6b_calibrated_edge';
export const PLAN3_6B_CONFIDENCE_SHRINK = 0.5;

export const PAPER_AB_COMPARISON_GUIDE = [
  'Compare each control ledger with its b arm on future paper fills only.',
  'Use fee- and slippage-aware net ROI (settled pnl / cost) and max drawdown.',
  'Bucket by ask and compare against the same ask bucket, not a different mix of cheap tails.',
  'Live trading stays off.'
].join(' ');

function finite(value, fallback = NaN) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}

export function paperContrastLiveTradingEnabled() {
  return false;
}

export function isPaperContrastPlan(planId) {
  return PAPER_AB_CONTRAST_IDS.includes(String(planId || ''));
}

/**
 * Halve the current 5m spot weight. 15m weight is unchanged because Plan14
 * does not open 15m trades. Does not mutate the control config.
 */
export function contrastPlan14Config(config = {}) {
  const controlWeight = resolvePlan14Config(config).modelWeight5m;
  return {
    ...config,
    plan14ModelWeight5m: controlWeight * PLAN14B_MODEL_WEIGHT_SCALE
  };
}

/** Raise the ask floor. Default treatment is 0.20; control default stays 0.08. */
export function contrastPlan16Options(options = {}, config = {}) {
  const configured = finite(config.plan16bMinAsk ?? options.plan16bMinAsk, PLAN16B_MIN_ASK);
  const minAsk = configured > 0 && configured < 1 ? configured : PLAN16B_MIN_ASK;
  return { ...options, minAsk };
}

/**
 * Cap chase entries at 0.80. Hard max is pulled down with the chase ceiling so
 * evaluatePlan26EntryPolicy rejects 0.85 even when the control hard max is 0.92.
 */
export function contrastPlan26Config(config = {}) {
  const cap = finite(config.plan2_6bEntryMaxPrice, PLAN2_6B_ENTRY_MAX);
  const entryMax = cap > 0 && cap < 1 ? cap : PLAN2_6B_ENTRY_MAX;
  return {
    ...config,
    plan2_6LiveEnabled: false,
    plan2_6EntryMaxPrice: entryMax,
    plan2_6PaperEntryMaxPrice: entryMax,
    plan2_6SustainedMomentumMaxPrice: entryMax,
    plan2_6SustainedMomentumMaxPrice5m: entryMax,
    plan2_6SustainedMomentumMaxPrice15m: entryMax,
    plan2_6PaperSustainedMomentumMaxPrice5m: entryMax,
    plan2_6PaperSustainedMomentumMaxPrice15m: entryMax,
    plan2_6EntryHardMaxPrice: entryMax
  };
}

/** Paper overlay: calibrate confidence before the edge filter. Live stays off. */
export function contrastPlan36Config(config = {}) {
  return {
    ...config,
    plan3_6Enabled: true,
    plan3_6LiveEnabled: false,
    plan3_6CalibrateConfidence: config.plan3_6bCalibrateConfidence !== false,
    plan3_6bConfidenceShrink: finite(config.plan3_6bConfidenceShrink, PLAN3_6B_CONFIDENCE_SHRINK)
  };
}

export function paperAbPlan36ControlConfig(config = {}) {
  return {
    ...config,
    plan3_6Enabled: true,
    plan3_6LiveEnabled: false,
    plan3_6CalibrateConfidence: false
  };
}

/**
 * Model confidence is a score, not a settled win rate.
 * Prefer the empirical bucket win rate once it has enough samples.
 * Otherwise shrink toward 1/2. Edge is probability minus the executable price
 * (plan3.6 has already added paper slippage ticks to that price).
 */
export function calibratePlan36Confidence({
  rawConfidence,
  entryPrice,
  calibrationTable = null,
  symbol = null,
  timeframe = '5m',
  direction = null,
  config = {}
} = {}) {
  const raw = finite(rawConfidence, NaN);
  const price = finite(entryPrice, NaN);
  if (!Number.isFinite(raw)) {
    return {
      probability: null,
      edge: null,
      calibrated: false,
      source: 'missing',
      rawConfidence: null
    };
  }
  const empirical = getCalibratedConfidence({
    rawConfidence: raw,
    planId: 'plan3_6',
    symbol,
    timeframe,
    direction,
    entryType: 'main',
    calibrationTable: calibrationTable || {},
    config: {
      ...config,
      confidenceCalibrationEnabled: true
    }
  });
  let probability;
  let source;
  let calibrated;
  if (empirical.calibrated === true && Number.isFinite(empirical.calibratedConfidence)) {
    probability = empirical.calibratedConfidence;
    source = 'empirical_win_rate';
    calibrated = true;
  } else {
    const shrink = finite(config.plan3_6bConfidenceShrink, PLAN3_6B_CONFIDENCE_SHRINK);
    const k = Math.min(1, Math.max(0, shrink));
    probability = 0.5 + (raw - 0.5) * k;
    source = 'shrink_toward_half';
    calibrated = false;
  }
  probability = round4(Math.min(0.995, Math.max(0.005, probability)));
  const edge = Number.isFinite(price) ? round4(probability - price) : null;
  return {
    probability,
    edge,
    calibrated,
    source,
    rawConfidence: round4(raw),
    confidenceBucket: empirical.confidenceBucket || null,
    empirical
  };
}

const CONTRASTS = {
  plan14b: {
    planId: PLAN14B_ID,
    controlPlanId: 'plan14',
    version: PLAN14B_VERSION,
    applyConfig: contrastPlan14Config
  },
  plan16b: {
    planId: PLAN16B_ID,
    controlPlanId: 'plan16',
    version: PLAN16B_VERSION,
    applyConfig: (config) => config
  },
  plan2_6b: {
    planId: PLAN2_6B_ID,
    controlPlanId: 'plan2_6',
    version: PLAN2_6B_VERSION,
    applyConfig: contrastPlan26Config
  },
  plan3_6b: {
    planId: PLAN3_6B_ID,
    controlPlanId: 'plan3_6',
    version: PLAN3_6B_VERSION,
    applyConfig: contrastPlan36Config
  }
};

export function paperContrastById(planId) {
  return CONTRASTS[String(planId || '')] || null;
}

export function paperContrastEntriesEnabled(config = {}, planId) {
  if (!paperContrastById(planId)) return false;
  if (config.paperAbContrastsEnabled === false) return false;
  if (config[`${planId}Enabled`] === false) return false;
  if (config[`${planId}NewEntriesEnabled`] === false) return false;
  return true;
}

export function applyPaperContrastConfig(planId, config = {}) {
  const spec = paperContrastById(planId);
  return spec ? spec.applyConfig(config) : { ...config };
}

export function stampPaperContrastPlan(plan, spec) {
  if (!plan || !spec) return plan;
  const action = plan.action ? {
    ...plan.action,
    strategyVersion: spec.version,
    paperAbArm: 'treatment',
    paperAbControlPlanId: spec.controlPlanId,
    paperAbPlanId: spec.planId
  } : plan.action;
  return {
    ...plan,
    planId: spec.planId,
    algorithm: spec.planId,
    strategyVersion: spec.version,
    paperAbArm: 'treatment',
    paperAbControlPlanId: spec.controlPlanId,
    action
  };
}
