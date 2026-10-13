/**
 * Plan14 v11 — same v8/v9 pricing, no new sub-40c entries (paper only).
 *
 * The market midpoint anchors an experimental spot estimate:
 *   logit(p̂_up) = (marketWeight · logit(pm_up) + modelWeight · logit(spot_up)) / sum(weights)
 * The normalized estimate cannot exceed both inputs simply because they agree.
 * Entries retain v8's two-sided fee-inclusive edge / model-vs-mid gates.
 *
 * History cannot validate this: window_locks prices were sometimes stale in July,
 * which fabricates spot-vs-PM edge. Every entry is therefore re-priced on a freshly
 * fetched CLOB book and filled at that ask, so paper P&L is the honest test.
 *
 * v9 sub-40c orders still hold to official settlement. v11 does not open new
 * ones: 219 settled cheap entries won 27% and lost about $168. Other entries
 * keep the existing value/high-price exits. The spot blend weights are unchanged;
 * raising them already lost faster on the separate v10 ledger.
 */

import { buildWindowPlanKey, windowElapsedPct } from './polymarketPlan.js';
import { polymarketCryptoTakerFee } from './polymarketMarketUtils.js';
import { getSlotSchedule, timeframeToSlotMinutes } from './polymarketSchedule.js';

export const PLAN14_ID = 'plan14';
export const PLAN14_V3_VERSION = 'plan14_5m_confirmed_stop_v3';
export const PLAN14_PREVIOUS_VERSION = 'plan14_5m_risk_guard_v4';
export const PLAN14_V5_VERSION = 'plan14_fee_return_value_v5';
export const PLAN14_V6_VERSION = 'plan14_model_vs_mid_v6';
export const PLAN14_V7_VERSION = 'plan14_other_side_v7';
export const PLAN14_V8_VERSION = 'plan14_two_sided_v8';
export const PLAN14_V9_VERSION = 'plan14_cheap_hold_v9';
export const PLAN14_VERSION = 'plan14_midband_v11';
export const PLAN14_PROFIT_EXPERIMENT_VERSION = 'plan14_probability_two_sided_v10_candidate';

export const PLAN14_DEFAULTS = Object.freeze({
  minElapsedPct: 0.10,
  maxElapsedPct: 0.85,
  minExecPrice: 0.40,
  maxExecPrice: 0.90,
  marketWeight: 1.0,
  modelWeight5m: 0.23,
  modelWeight15m: 0.16,
  minEdgeAfterCost: 0.01,
  minExpectedRoi: 0,
  minModelOverMid: 0.01,
  valueExitMargin: 0.01,
  prescreenSlack: 0.02,
  maxSpotAgeSeconds: 10,
  maxAskMidGap: 0.05,
  maxBookSpread: 0.05,
  minVolatility: 0.0002,
  maxVolatility: 0.04,
  takerFeeRate: 0.07,
  kellyFraction: 0.25,
  maxOrderPct: 0.03,
  minShares: 5,
  paperMinOrderUsd: 1,
  takeProfitMargin: 0.01,
  stopLossMargin: 0,
  stopConfirmSamples: 3,
  stopConfirmMs: 10000,
  riskStopLossPct: 0.25,
  maxSameDirectionEntriesPerSlot: 4
});

function finite(value, fallback = NaN) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function logit(p) {
  const q = clamp(p, 0.005, 0.995);
  return Math.log(q / (1 - q));
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function timestampMs(value) {
  if (value == null || value === '') return NaN;
  const number = Number(value);
  if (Number.isFinite(number)) return number < 1e12 ? number * 1000 : number;
  return Date.parse(value);
}

export function resolvePlan14Config(config = {}) {
  const num = (key, fallback) => {
    const value = finite(config?.[key], NaN);
    return Number.isFinite(value) ? value : fallback;
  };
  const d = PLAN14_DEFAULTS;
  return {
    minElapsedPct: num('plan14MinElapsedPct', d.minElapsedPct),
    maxElapsedPct: num('plan14MaxElapsedPct', d.maxElapsedPct),
    minExecPrice: num('plan14MinExecPrice', d.minExecPrice),
    maxExecPrice: num('plan14MaxExecPrice', d.maxExecPrice),
    marketWeight: num('plan14MarketWeight', d.marketWeight),
    modelWeight5m: num('plan14ModelWeight5m', d.modelWeight5m),
    modelWeight15m: num('plan14ModelWeight15m', d.modelWeight15m),
    minEdgeAfterCost: num('plan14MinEdgeAfterCost', d.minEdgeAfterCost),
    minExpectedRoi: Math.max(0, num('plan14MinExpectedRoi', d.minExpectedRoi)),
    minModelOverMid: Math.max(0, num('plan14MinModelOverMid', d.minModelOverMid)),
    valueExitMargin: Math.max(0, num('plan14ValueExitMargin', d.valueExitMargin)),
    prescreenSlack: Math.max(0, num('plan14PrescreenSlack', d.prescreenSlack)),
    maxSpotAgeSeconds: Math.max(1, num('plan14MaxSpotAgeSeconds', d.maxSpotAgeSeconds)),
    maxAskMidGap: Math.max(0, num('plan14MaxAskMidGap', d.maxAskMidGap)),
    maxBookSpread: Math.max(0, num('plan14MaxBookSpread', d.maxBookSpread)),
    minVolatility: Math.max(1e-6, num('plan14MinVolatility', d.minVolatility)),
    maxVolatility: Math.max(1e-6, num('plan14MaxVolatility', d.maxVolatility)),
    takerFeeRate: Math.max(0, num('plan14TakerFeeRate', d.takerFeeRate)),
    kellyFraction: clamp(num('plan14KellyFraction', d.kellyFraction), 0, 1),
    maxOrderPct: clamp(num('plan14MaxOrderPct', d.maxOrderPct), 0, 1),
    minShares: Math.max(1, num('plan14MinShares', d.minShares)),
    paperMinOrderUsd: Math.max(0, num('plan14PaperMinOrderUsd', d.paperMinOrderUsd)),
    takeProfitMargin: Math.max(0, num('plan14TakeProfitMargin', d.takeProfitMargin)),
    stopLossMargin: Math.max(0, num('plan14StopLossMargin', d.stopLossMargin)),
    stopConfirmSamples: Math.max(3, Math.ceil(num('plan14StopConfirmSamples', d.stopConfirmSamples))),
    stopConfirmMs: Math.max(10000, num('plan14StopConfirmMs', d.stopConfirmMs)),
    riskStopLossPct: clamp(num('plan14RiskStopLossPct', d.riskStopLossPct), 0.05, 0.95),
    maxSameDirectionEntriesPerSlot: Math.max(1, Math.floor(num('plan14MaxSameDirectionEntriesPerSlot', d.maxSameDirectionEntriesPerSlot)))
  };
}

/** Driftless Brownian P(close ≥ open); volatility is the per-window σ of log returns. */
export function estimatePlan14SpotUp({ spot, open, volatility, secondsRemaining, slotSeconds, config = {} } = {}) {
  const cfg = resolvePlan14Config(config);
  const s = finite(spot, NaN);
  const s0 = finite(open, NaN);
  const vol = finite(volatility, NaN);
  const remaining = finite(secondsRemaining, NaN);
  const slot = finite(slotSeconds, NaN);
  if (!(s > 0 && s0 > 0 && vol > 0 && remaining > 0 && slot > 0)) return null;
  const sigma = clamp(vol, cfg.minVolatility, cfg.maxVolatility) * Math.sqrt(clamp(remaining / slot, 1 / slot, 1));
  const z = clamp(Math.log(s / s0) / sigma, -8, 8);
  return clamp(normalCdf(z), 0.005, 0.995);
}

export function normalCdf(value) {
  const x = finite(value, 0);
  const abs = Math.abs(x);
  const t = 1 / (1 + 0.2316419 * abs);
  const density = 0.3989422804014327 * Math.exp(-0.5 * abs * abs);
  const tail = density * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - tail : tail;
}

export function blendPlan14Up({ marketUp, spotUp, timeframe = '5m', config = {}, legacy = false } = {}) {
  const cfg = resolvePlan14Config(config);
  const pm = finite(marketUp, NaN);
  if (!(pm > 0 && pm < 1)) return null;
  const model = finite(spotUp, NaN);
  if (!(model > 0 && model < 1)) return pm;
  const modelWeight = timeframe === '15m' ? cfg.modelWeight15m : cfg.modelWeight5m;
  if (legacy) return sigmoid(cfg.marketWeight * logit(pm) + modelWeight * logit(model));
  const marketWeight = Math.max(0, cfg.marketWeight);
  const spotWeight = Math.max(0, modelWeight);
  const total = marketWeight + spotWeight;
  // Agreement is not independent evidence: 80% + 80% must remain 80%, not 85%.
  return total > 0 ? sigmoid((marketWeight * logit(pm) + spotWeight * logit(model)) / total) : pm;
}

function spotInputs(signal, { now, secondsRemaining, slotSeconds, config }) {
  const cfg = resolvePlan14Config(config);
  const quoteMs = timestampMs(signal?.indicators?.currentQuoteTime);
  const ageMs = now.getTime() - quoteMs;
  if (!Number.isFinite(quoteMs) || ageMs < -2000 || ageMs > cfg.maxSpotAgeSeconds * 1000) {
    return { ok: false, reason: 'Plan14：Binance 现货报价过期，不用旧价估值。', skipReason: 'stale_spot_quote' };
  }
  const spotUp = estimatePlan14SpotUp({
    spot: signal?.indicators?.currentPrice,
    open: signal?.prediction?.comparisonBasePrice ?? signal?.indicators?.slotStartPrice,
    volatility: signal?.indicators?.volatility15mPct,
    secondsRemaining,
    slotSeconds,
    config
  });
  if (spotUp == null) return { ok: false, reason: 'Plan14：现货/开盘价/波动率不完整。', skipReason: 'missing_spot_inputs' };
  return { ok: true, spotUp, spotAgeMs: ageMs, inputs: {
    spot: signal?.indicators?.currentPrice,
    open: signal?.prediction?.comparisonBasePrice ?? signal?.indicators?.slotStartPrice,
    volatility: signal?.indicators?.volatility15mPct,
    quoteTimeMs: quoteMs, secondsRemaining, slotSeconds
  } };
}

/** book: { up: { bid, ask }, down: { bid, ask } } from a fresh CLOB fetch; omitted ⇒ prescreen on cached quotes. */
function marketQuotes(sentiment, book) {
  if (book) {
    const upBid = finite(book.up?.bid, NaN);
    const upAsk = finite(book.up?.ask, NaN);
    const downBid = finite(book.down?.bid, NaN);
    const downAsk = finite(book.down?.ask, NaN);
    const upMid = upBid > 0 && upAsk > upBid ? (upBid + upAsk) / 2 : NaN;
    const downMid = downBid > 0 && downAsk > downBid ? (downBid + downAsk) / 2 : NaN;
    const marketUp = Number.isFinite(upMid) && Number.isFinite(downMid)
      ? (upMid + (1 - downMid)) / 2
      : (Number.isFinite(upMid) ? upMid : 1 - downMid);
    return {
      fresh: true,
      marketUp,
      up: { ask: upAsk, bid: upBid, spread: upAsk - upBid },
      down: { ask: downAsk, bid: downBid, spread: downAsk - downBid }
    };
  }
  const upPrice = finite(sentiment?.upPrice ?? sentiment?.upProbability, NaN);
  const downPrice = finite(sentiment?.downPrice ?? sentiment?.downProbability, NaN);
  const marketUp = upPrice > 0 && downPrice > 0 ? upPrice / (upPrice + downPrice) : upPrice;
  return {
    fresh: false,
    marketUp,
    up: { ask: finite(sentiment?.upBestAsk, NaN), bid: NaN, spread: finite(sentiment?.upSpread, NaN) },
    down: { ask: finite(sentiment?.downBestAsk, NaN), bid: NaN, spread: finite(sentiment?.downSpread, NaN) }
  };
}

export function evaluatePlan14Entry({
  signal,
  sentiment,
  timeframe = '5m',
  book = null,
  now = new Date(),
  config = {},
  policyVersion = PLAN14_VERSION
} = {}) {
  const cfg = resolvePlan14Config(config);
  const experiment = policyVersion === PLAN14_PROFIT_EXPERIMENT_VERSION;
  const cheapEntries = [PLAN14_V9_VERSION, PLAN14_V8_VERSION, PLAN14_V7_VERSION, PLAN14_V6_VERSION].includes(policyVersion);
  const legacy = ![PLAN14_VERSION, PLAN14_V9_VERSION, PLAN14_V8_VERSION, PLAN14_V7_VERSION, PLAN14_V6_VERSION, PLAN14_PROFIT_EXPERIMENT_VERSION].includes(policyVersion);
  if (timeframe !== '5m') {
    return { allowed: false, prescreen: false, reason: 'Plan14：15m 暂停新开仓，仅验证 5m。', skipReason: 'timeframe_paused' };
  }
  if (!sentiment?.available) return { allowed: false, prescreen: false, reason: 'Plan14：Polymarket 盘口不可用。', skipReason: 'market_unavailable' };
  const slotMinutes = timeframeToSlotMinutes(timeframe);
  const slotSeconds = slotMinutes * 60;
  const schedule = signal?.schedule || getSlotSchedule(now, slotMinutes);
  const targetMs = Date.parse(signal?.prediction?.targetTimeIso || schedule.nextSlotIso);
  const secondsRemaining = Number.isFinite(targetMs)
    ? (targetMs - now.getTime()) / 1000
    : finite(schedule.secondsToNext, NaN);
  const elapsedPct = Number.isFinite(secondsRemaining)
    ? clamp(1 - secondsRemaining / slotSeconds, 0, 1)
    : windowElapsedPct(schedule);
  if (elapsedPct + 1e-9 < cfg.minElapsedPct || elapsedPct > cfg.maxElapsedPct + 1e-9) {
    return {
      allowed: false,
      prescreen: false,
      elapsedPct,
      reason: `Plan14：窗口进度 ${(elapsedPct * 100).toFixed(0)}% 不在 ${(cfg.minElapsedPct * 100).toFixed(0)}–${(cfg.maxElapsedPct * 100).toFixed(0)}% 入场区间。`,
      skipReason: 'outside_entry_window'
    };
  }
  const spot = spotInputs(signal, { now, secondsRemaining, slotSeconds, config });
  if (!spot.ok) return { allowed: false, prescreen: false, elapsedPct, reason: spot.reason, skipReason: spot.skipReason };

  const quotes = marketQuotes(sentiment, book);
  if (!(quotes.marketUp > 0 && quotes.marketUp < 1)) {
    return { allowed: false, prescreen: false, elapsedPct, reason: 'Plan14：盘口中间价无效。', skipReason: 'invalid_mid' };
  }
  const rawUp = blendPlan14Up({ marketUp: quotes.marketUp, spotUp: spot.spotUp, timeframe,
    config: experiment ? { ...config, plan14ModelWeight5m: 0.40 } : config, legacy });
  // Exploratory temperature transform, not independent evidence or proven calibration.
  const pUp = experiment ? sigmoid(logit(rawUp) / 0.85) : rawUp;
  const candidates = [
    { direction: 'up', p: pUp, mid: quotes.marketUp, ...quotes.up },
    { direction: 'down', p: 1 - pUp, mid: 1 - quotes.marketUp, ...quotes.down }
  ].map((c) => {
    const ask = c.ask > 0 && c.ask < 1 ? c.ask : NaN;
    const feePerShare = Number.isFinite(ask) ? polymarketCryptoTakerFee(1, ask, cfg.takerFeeRate) : NaN;
    // The paper engine pays buy fees in shares; use cost per NET payout share.
    const netShareFraction = Number.isFinite(ask) ? 1 - feePerShare / ask : NaN;
    const cost = legacy ? ask + feePerShare : ask / netShareFraction;
    return {
      direction: c.direction,
      p: round4(c.p),
      mid: round4(c.mid),
      ask: round4(ask),
      bid: Number.isFinite(c.bid) ? round4(c.bid) : null,
      spread: Number.isFinite(c.spread) ? round4(c.spread) : null,
      feePerShare: round4(feePerShare),
      cost: round4(cost),
      expectedRoi: Number.isFinite(cost) && cost > 0 ? round4(c.p / cost - 1) : -1,
      edge: Number.isFinite(cost) ? round4(c.p - cost) : -1,
      modelOverMid: Number.isFinite(c.mid) ? round4(c.p - c.mid) : -1
    };
  });
  const valid = candidates.filter(c => c.ask >= cfg.minExecPrice && c.ask <= cfg.maxExecPrice
    && (!quotes.fresh || (c.bid > 0 && c.ask > c.bid && c.spread <= cfg.maxBookSpread + 1e-9))
    && (cfg.maxAskMidGap <= 0 || Math.abs(c.ask - c.mid) <= cfg.maxAskMidGap + 1e-9));
  const best = [...(valid.length ? valid : candidates)].sort((a, b) => b.edge - a.edge)[0];
  const model = {
    marketUp: round4(quotes.marketUp),
    spotUp: round4(spot.spotUp),
    blendedUp: round4(pUp),
    ...(experiment ? { rawBlendedUp: round4(rawUp), modelWeight: 0.40, temperature: 0.85 } : {}),
    spotAgeMs: Math.round(spot.spotAgeMs),
    freshBook: quotes.fresh,
    policyVersion,
    inputs: spot.inputs,
    bookTimeMs: book ? { up: book.up?.bookTimeMs, down: book.down?.bookTimeMs } : null
  };
  const base = { elapsedPct, model, candidates, selected: best };
  const reject = (reason, skipReason) => ({ ...base, allowed: false, prescreen: false, reason, skipReason });
  const otherOf = (side) => candidates.find((candidate) => candidate.direction !== side?.direction);
  const sideOk = (side, { slack = 0, allowCheap = false } = {}) => {
    if (!side || !(side.ask > 0 && side.ask < 1) || side.ask > cfg.maxExecPrice + 1e-9) return false;
    if (!allowCheap && side.ask + 1e-9 < cfg.minExecPrice) return false;
    if (cfg.maxAskMidGap > 0 && Math.abs(side.ask - side.mid) > cfg.maxAskMidGap + 1e-9) return false;
    if (quotes.fresh && (!(side.bid > 0 && side.ask > side.bid) || side.spread > cfg.maxBookSpread + 1e-9)) return false;
    const edgeOk = side.edge + 1e-9 >= cfg.minEdgeAfterCost - slack && (slack > 0 || side.edge > 0);
    const modelOkSide = legacy || side.modelOverMid + 1e-9 >= cfg.minModelOverMid - slack;
    const roiOkSide = legacy || !(cfg.minExpectedRoi > 0) || side.expectedRoi + 1e-9 >= cfg.minExpectedRoi - slack;
    return edgeOk && modelOkSide && roiOkSide;
  };

  if (quotes.fresh && !legacy && [book.up?.bookTimeMs, book.down?.bookTimeMs].some(t =>
    !Number.isFinite(t) || now.getTime() - t < -2000 || now.getTime() - t > cfg.maxSpotAgeSeconds * 1000)) {
    return reject('Plan14：实时盘口已过期，重新获取后判断。', 'stale_book');
  }

  if (experiment) {
    const slack = quotes.fresh ? 0 : cfg.prescreenSlack;
    const eligible = candidates.filter(side => side.ask > 0 && side.ask <= cfg.maxExecPrice + 1e-9
      && (!quotes.fresh || (side.bid > 0 && side.ask > side.bid && side.spread <= cfg.maxBookSpread + 1e-9))
      && (cfg.maxAskMidGap <= 0 || Math.abs(side.ask - side.mid) <= cfg.maxAskMidGap + 1e-9)
      && side.edge + 1e-9 >= cfg.minEdgeAfterCost - slack && (slack > 0 || side.edge > 0))
      .sort((a, b) => b.edge - a.edge);
    const selected = eligible[0] || best;
    return { ...base, selected, allowed: quotes.fresh && eligible.length > 0, prescreen: eligible.length > 0,
      skipReason: eligible.length ? (quotes.fresh ? null : 'awaiting_fresh_book') : 'edge_below_threshold',
      reason: `Plan14 v10 候选：双边独立比较扣费优势；现货权重 0.40 / 温度 0.85；仅独立模拟实验，不改变 v9 主仓` };
  }

  if (!Number.isFinite(best.ask)) return reject('Plan14：缺少可执行卖一。', 'missing_ask');
  if (best.ask + 1e-9 < cfg.minExecPrice || best.ask > cfg.maxExecPrice + 1e-9) {
    return reject(`Plan14：最优侧卖一 ${(best.ask * 100).toFixed(1)}¢ 不在 ${(cfg.minExecPrice * 100).toFixed(0)}–${(cfg.maxExecPrice * 100).toFixed(0)}¢。`, 'price_out_of_range');
  }
  if (cfg.maxAskMidGap > 0 && Math.abs(best.ask - best.mid) > cfg.maxAskMidGap + 1e-9) {
    return reject(`Plan14：${best.direction.toUpperCase()} 卖一 ${(best.ask * 100).toFixed(1)}¢ 与中间价 ${(best.mid * 100).toFixed(1)}¢ 偏离过大，盘口不一致。`, 'inconsistent_book');
  }
  if (quotes.fresh && (!(best.bid > 0 && best.ask > best.bid) || best.spread > cfg.maxBookSpread + 1e-9)) {
    return reject(`Plan14：${best.direction.toUpperCase()} 点差 ${(best.spread * 100).toFixed(1)}¢ 过宽。`, 'wide_spread');
  }
  const summary = `市场 UP ${(model.marketUp * 100).toFixed(1)}% · 现货模型 ${(model.spotUp * 100).toFixed(1)}% → 估计 ${(model.blendedUp * 100).toFixed(1)}%`;
  const edgeOk = best.edge + 1e-9 >= cfg.minEdgeAfterCost;
  const roiOk = legacy || !(cfg.minExpectedRoi > 0) || best.expectedRoi + 1e-9 >= cfg.minExpectedRoi;
  const modelOk = legacy || best.modelOverMid + 1e-9 >= cfg.minModelOverMid;
  const edgeText = `edge ${(best.edge * 100).toFixed(1)}pp`;
  const midText = legacy ? '' : ` · 高于中间价 ${(best.modelOverMid * 100).toFixed(1)}pp`;
  if (!quotes.fresh) {
    const primaryModelWeak = !legacy && best.modelOverMid + 1e-9 < cfg.minModelOverMid;
    const prescreen = sideOk(best, { slack: cfg.prescreenSlack })
      || (primaryModelWeak && sideOk(otherOf(best), { slack: cfg.prescreenSlack, allowCheap: cheapEntries }));
    return {
      ...base,
      allowed: false,
      prescreen,
      reason: prescreen
        ? `Plan14 预筛通过（${summary}，${edgeText}${midText}），待实时盘口确认。`
        : `Plan14：${summary}，${edgeText}${midText} 不够。`,
      skipReason: prescreen ? 'awaiting_fresh_book' : 'edge_below_threshold'
    };
  }
  if (!modelOk) {
    const fallback = otherOf(best);
    const spotUp = model.spotUp;
    const spotFavors = (direction) => direction === 'up' ? spotUp > 0.5 : spotUp < 0.5;
    const cheapNeedsSpot = fallback && fallback.ask + 1e-9 < cfg.minExecPrice;
    if (!legacy && sideOk(fallback, { allowCheap: cheapEntries }) && (!cheapNeedsSpot || spotFavors(fallback.direction))) {
      const edgeTextFallback = `edge ${(fallback.edge * 100).toFixed(1)}pp`;
      const midTextFallback = ` · 高于中间价 ${(fallback.modelOverMid * 100).toFixed(1)}pp`;
      const spotText = cheapNeedsSpot ? ` · 现货模型也看${fallback.direction === 'up' ? '涨' : '跌'}` : '';
      return {
        ...base,
        selected: fallback,
        allowed: true,
        prescreen: true,
        reason: `Plan14 ${timeframe}：区间内 ${best.direction.toUpperCase()} 没有高于中间价，改买 ${fallback.direction.toUpperCase()} 卖一 ${(fallback.ask * 100).toFixed(1)}¢ · ${summary} · ${edgeTextFallback}${midTextFallback}${spotText}`
      };
    }
    if (!legacy && cheapNeedsSpot && sideOk(fallback, { allowCheap: true }) && !spotFavors(fallback.direction)) {
      return reject(`Plan14：${summary}，${(fallback.ask * 100).toFixed(0)}¢ 这一侧现货模型不赞成；反方向 ${best.direction.toUpperCase()} 也没有高于中间价，两边都不买。`, 'spot_disagrees');
    }
    return reject(`Plan14：${summary}，修正概率没有高于${best.direction === 'up' ? 'UP' : 'DOWN'} 中间价 ${(best.modelOverMid * 100).toFixed(1)}pp，另一边扣费后也没有 1¢ 优势。`, 'model_not_above_mid');
  }
  if (!edgeOk || !roiOk || best.edge <= 0) {
    return reject(`Plan14：${summary}，${edgeText}${midText} 不够（扣费后需要 ≥ ${(cfg.minEdgeAfterCost * 100).toFixed(0)}pp）。`, 'edge_below_threshold');
  }
  return {
    ...base,
    allowed: true,
    prescreen: true,
    reason: `Plan14 ${timeframe}：买 ${best.direction.toUpperCase()} 实时卖一 ${(best.ask * 100).toFixed(1)}¢ · ${summary} · ${edgeText}${midText}`
  };
}

function isPlan14ValuePolicy(version) {
  return version === PLAN14_VERSION || version === PLAN14_V9_VERSION || version === PLAN14_V8_VERSION || version === PLAN14_V7_VERSION || version === PLAN14_V6_VERSION || version === PLAN14_V5_VERSION;
}
export function computePlan14OrderUsd({ cash, candidate, config = {} } = {}) {
  const cfg = resolvePlan14Config(config);
  const available = Math.max(0, finite(cash, 0));
  const cost = finite(candidate?.cost, NaN);
  const p = finite(candidate?.p, NaN);
  const ask = finite(candidate?.ask, NaN);
  if (!(available > 0) || !(cost > 0 && cost < 1) || !Number.isFinite(p) || p <= cost || !(ask > 0)) return 0;
  const kelly = Math.max(0, (p - cost) / (1 - cost));
  const pct = Math.min(cfg.maxOrderPct, kelly * cfg.kellyFraction);
  const floorUsd = Math.max(cfg.paperMinOrderUsd, Math.ceil(cfg.minShares * ask * 100 - 1e-6) / 100);
  const usd = Math.max(floorUsd, available * pct);
  // The exchange minimum must not silently override the per-order risk budget.
  return usd > available * cfg.maxOrderPct + 1e-9 ? 0 : round2(usd);
}

/** Filled entries still consume the window budget after a stop; no loss-chasing re-entry. */
export function evaluatePlan14Exposure({ orders = [], slotIso, timeframe = '5m', direction, config = {} } = {}) {
  const slotMs = Date.parse(slotIso);
  if (!Number.isFinite(slotMs) || !['up', 'down'].includes(direction)) {
    return { allowed: false, reason: 'Plan14：缺少有效窗口或方向，无法检查同向仓位。' };
  }
  const matching = orders.filter(order => order.timeframe === timeframe
    && Date.parse(order.slotIso || order.plan?.slotIso) === slotMs
    && order.direction === direction && Number(order.usd) > 0 && Number(order.shares) > 0
    && ['open', 'settled'].includes(order.settlementStatus));
  const limit = resolvePlan14Config(config).maxSameDirectionEntriesPerSlot;
  return { allowed: matching.length < limit, count: matching.length, limit,
    reason: matching.length >= limit ? `Plan14：本窗口 ${direction.toUpperCase()} 已成交 ${matching.length} 笔，同向最多 ${limit} 笔（跨币种，平仓后不重开）。` : null };
}

/** Rank the current scan, not historical winners; the entry guard remains authoritative. */
export function rankPlan14Views(views = []) {
  const score = item => item?.view?.plan?.action?.shouldTrade === true
    ? finite(item.view.plan.action.expectedProfitUsd ?? item.view.plan.action.edge, -Infinity) : -Infinity;
  return [...views].sort((a, b) => {
    const left = score(a), right = score(b);
    return left === right ? String(a.symbol).localeCompare(String(b.symbol)) : right - left;
  });
}

/**
 * inputs: { bid, ask } of the held token plus the current window's spot snapshot
 * { spot, open, volatility, quoteTimeMs }. Without a fresh spot the model falls back
 * to the market mid, which never exceeds bid − fee, so the position is simply held.
 */
export function evaluatePlan14Exit({ order, inputs = {}, nowMs = Date.now(), config = {}, exitTakerFeeRate = null } = {}) {
  const cfg = resolvePlan14Config(config);
  const entryPrice = Number(order?.limitPrice);
  // Deliberately independent of the current quote: no cheap-entry stop OR take-profit.
  // Official settlement still owns the terminal payout, including a total loss.
  if (order?.strategyVersion === PLAN14_V9_VERSION && entryPrice > 0 && entryPrice < 0.40) {
    return { exit: false, reason: 'cheap_hold_to_settlement', exitTrigger: 'cheap-hold',
      exitReason: 'Plan14 v9：低于 40¢ 的入场仓位持有到官方结算，不因途中价格止损或止盈；到期判断错误会亏损全部本金' };
  }
  const bid = finite(inputs.bid, NaN);
  if (!(bid > 0 && bid < 1)) return { exit: false, reason: 'no_bid' };
  const valuePolicy = isPlan14ValuePolicy(order?.strategyVersion);
  if (valuePolicy || order?.strategyVersion === PLAN14_PREVIOUS_VERSION) {
    const bookMs = inputs.bookTimeMs;
    if (!Number.isFinite(bookMs) || nowMs - bookMs < -2000 || nowMs - bookMs > cfg.maxSpotAgeSeconds * 1000) {
      return { exit: false, reason: 'stale_book' };
    }
    const shares = finite(order.shares, 0);
    const invested = finite(order.usd, 0);
    const feeRate = exitTakerFeeRate ?? cfg.takerFeeRate;
    const netProceeds = shares * bid - polymarketCryptoTakerFee(shares, bid, feeRate);
    const netLossPct = invested > 0 && shares > 0 ? 1 - netProceeds / invested : null;
    // Risk exits depend on the executable bid, not on spot availability or book spread.
    // Legacy sub-40c orders keep their stop. V9 cheap orders returned above.
    // High-price and middle-band rules intentionally remain unchanged.
    const entryPx = finite(order?.limitPrice, NaN);
    if (valuePolicy && entryPx > 0 && entryPx < 0.40 && netLossPct != null && netLossPct + 1e-9 >= cfg.riskStopLossPct) {
      return { exit: true, exitStatus: 'model-stop-loss', exitTrigger: 'cheap-side-risk',
        emergency: true, netLossPct: round4(netLossPct), netProceeds: round4(netProceeds),
        exitReason: `Plan14 低价止损：买入 ${(entryPx * 100).toFixed(0)}¢ 低于 40¢，按买一扣费净亏损 ${(netLossPct * 100).toFixed(1)}% ≥ ${(cfg.riskStopLossPct * 100).toFixed(0)}%，不再拿到结算` };
    }
    if (valuePolicy && entryPx >= 0.80 && netLossPct != null && netLossPct + 1e-9 >= 0.24) {
      return { exit: true, exitStatus: 'model-stop-loss', exitTrigger: 'high-price-risk',
        emergency: true, netLossPct: round4(netLossPct), netProceeds: round4(netProceeds),
        exitReason: `Plan14 高价止损：买入 ${(entryPx * 100).toFixed(0)}¢，结算赢面只剩约 ${((1 - entryPx) * 100).toFixed(0)}¢，按买一扣费净亏损 ${(netLossPct * 100).toFixed(1)}% ≥ 24%，立即卖出` };
    }
    if (!valuePolicy && netLossPct != null && netLossPct + 1e-9 >= cfg.riskStopLossPct) {
      return { exit: true, exitStatus: 'model-stop-loss', exitTrigger: 'net-loss-risk',
        emergency: true, netLossPct: round4(netLossPct), netProceeds: round4(netProceeds),
        exitReason: `Plan14 风险止损：按买一扣费净亏损 ${(netLossPct * 100).toFixed(1)}% ≥ ${(cfg.riskStopLossPct * 100).toFixed(0)}% 触发线，不等待模型确认（非保证成交上限）` };
    }
  }
  const ask = finite(inputs.ask, NaN);
  if (!(ask > bid && ask < 1) || ask - bid > cfg.maxBookSpread + 1e-9) {
    return { exit: false, reason: 'invalid_or_wide_book' };
  }
  const heldMid = ask > bid && ask < 1 ? (bid + ask) / 2 : bid;
  const heldUp = order?.direction === 'up';
  const marketUp = heldUp ? heldMid : 1 - heldMid;
  const timeframe = order?.timeframe === '15m' ? '15m' : '5m';
  const slotSeconds = timeframeToSlotMinutes(timeframe) * 60;
  const secondsRemaining = (Date.parse(order?.targetTimeIso) - nowMs) / 1000;
  const quoteAgeMs = nowMs - finite(inputs.quoteTimeMs, NaN);
  const spotFresh = Number.isFinite(quoteAgeMs) && quoteAgeMs >= -2000 && quoteAgeMs <= cfg.maxSpotAgeSeconds * 1000;
  const spotUp = spotFresh
    ? estimatePlan14SpotUp({ spot: inputs.spot, open: inputs.open, volatility: inputs.volatility, secondsRemaining, slotSeconds, config })
    : null;
  const pUp = blendPlan14Up({ marketUp, spotUp, timeframe, config, legacy: !valuePolicy });
  if (pUp == null) return { exit: false, reason: 'invalid_mid' };
  const holdValue = heldUp ? pUp : 1 - pUp;
  const sellValue = bid - polymarketCryptoTakerFee(1, bid, valuePolicy ? (exitTakerFeeRate ?? cfg.takerFeeRate) : cfg.takerFeeRate);
  const entryCost = finite(order?.limitPrice, NaN);
  const inLoss = Number.isFinite(entryCost) && bid < entryCost;
  const margin = valuePolicy ? cfg.valueExitMargin : inLoss ? cfg.stopLossMargin : cfg.takeProfitMargin;
  const exit = spotUp != null && sellValue > holdValue + margin + 1e-9;
  const exitStatus = exit ? (inLoss ? 'model-stop-loss' : 'model-take-profit') : null;
  return {
    exit,
    exitStatus,
    exitTrigger: valuePolicy ? 'expected-value' : 'model',
    holdValue: round4(holdValue),
    sellValue: round4(sellValue),
    spotUp: spotUp == null ? null : round4(spotUp),
    marketUp: round4(marketUp),
    exitReason: exit
      ? `Plan14 ${inLoss ? '模型止损' : '模型止盈'}：卖出净值 ${(sellValue * 100).toFixed(1)}¢ > 持有价值 ${(holdValue * 100).toFixed(1)}¢${margin > 0 ? ` + ${(margin * 100).toFixed(0)}¢` : ''}（市场 ${(marketUp * 100).toFixed(1)}% / 现货 ${(spotUp * 100).toFixed(1)}%）`
      : null
  };
}

/** Repeated cached quotes cannot advance confirmation. Broken/stale observations reset it. */
export function confirmPlan14Stop(order, decision, inputs, nowMs, config = {}) {
  if (decision.exit && decision.emergency === true) return { confirmed: true, state: null };
  if (isPlan14ValuePolicy(order.strategyVersion)) {
    if (!decision.exit) return { confirmed: false, state: null };
    const cfg = resolvePlan14Config(config);
    const quoteMs = inputs?.quoteTimeMs, bookMs = inputs?.bookTimeMs;
    if ([quoteMs, bookMs].some(t => !Number.isFinite(t) || nowMs - t < -2000 || nowMs - t > cfg.maxSpotAgeSeconds * 1000)) {
      return { confirmed: false, state: null };
    }
    const previous = order.plan14StopConfirmation;
    const reset = !previous || nowMs - previous.lastAtMs > 15000
      || quoteMs < previous.lastQuoteMs || bookMs < previous.lastBookMs;
    if (!reset && (quoteMs === previous.lastQuoteMs || bookMs === previous.lastBookMs)) {
      return { confirmed: false, state: previous };
    }
    const state = { count: reset ? 1 : previous.count + 1,
      firstAtMs: reset ? nowMs : previous.firstAtMs, lastAtMs: nowMs,
      firstQuoteMs: reset ? quoteMs : previous.firstQuoteMs, lastQuoteMs: quoteMs, lastBookMs: bookMs };
    return { confirmed: state.count >= 2, state };
  }
  if (order.timeframe !== '5m') return { confirmed: decision.exit === true, state: null };
  if (!decision.exit || decision.exitStatus !== 'model-stop-loss') {
    return { confirmed: decision.exit === true, state: null };
  }
  const cfg = resolvePlan14Config(config);
  const quoteMs = inputs?.quoteTimeMs;
  if (!Number.isFinite(quoteMs) || nowMs - quoteMs < -2000 || nowMs - quoteMs > cfg.maxSpotAgeSeconds * 1000) {
    return { confirmed: false, state: null };
  }
  const previous = order.plan14StopConfirmation;
  const maxGapMs = Math.max(15000, cfg.stopConfirmMs * 2);
  const reset = !previous || nowMs - previous.lastAtMs > maxGapMs || quoteMs < previous.lastQuoteMs;
  if (!reset && quoteMs === previous.lastQuoteMs) return { confirmed: false, state: previous };
  const state = {
    count: reset ? 1 : previous.count + 1,
    firstAtMs: reset ? nowMs : previous.firstAtMs,
    lastAtMs: nowMs,
    firstQuoteMs: reset ? quoteMs : previous.firstQuoteMs,
    lastQuoteMs: quoteMs
  };
  return {
    confirmed: state.count >= cfg.stopConfirmSamples
      && nowMs - state.firstAtMs >= cfg.stopConfirmMs
      && quoteMs - state.firstQuoteMs >= cfg.stopConfirmMs,
    state
  };
}

export function buildPlan14RulesSnapshot(config = {}) {
  const cfg = resolvePlan14Config(config);
  return {
    version: PLAN14_VERSION,
    ...cfg,
    liveEnabled: false,
    entryTimeframes: ['5m'],
    fixedLossExitEnabled: true,
    cheapEntryStopBelow: null,
    cheapEntryHoldBelow: 0.40,
    cheapEntryHoldToSettlementEnabled: false,
    newCheapEntriesEnabled: false,
    exitControlVersion: PLAN14_V8_VERSION,
    highEntryStopAt: 0.80,
    highEntryStopLossPct: 0.24,
    valueExitConfirmSamples: 2,
    legacyRiskStopVersion: PLAN14_PREVIOUS_VERSION,
    entry: 'v11 keeps the v8/v9 blend and fee gates, and does not open a new position below 40c',
    exit: 'existing v9 sub-40c orders still hold to official settlement; v11 and other prices keep value exits and the 80c+ risk stop',
    exposure: 'four symbols can qualify independently; each symbol can enter only once per window; no post-stop re-entry',
    sizing: 'fractional Kelly on fee-inclusive edge'
  };
}

function skip(reason, skipReason = 'skip') {
  return {
    shouldTrade: false,
    strategy: null,
    direction: null,
    label: '跳过',
    confidence: 0,
    usd: 0,
    limitPrice: null,
    reason,
    skipReason
  };
}

export function summarizePlan14Skill(orders = []) {
  const scored = [];
  for (const order of orders || []) {
    if (order?.strategyVersion !== PLAN14_VERSION) continue;
    const outcomeUp = order.actualDirection === 'up' ? 1 : order.actualDirection === 'down' ? 0 : null;
    if (outcomeUp == null) continue;
    const gate = order.expectedValueGate || {};
    const marketUp = finite(gate.marketUp, NaN);
    const modelUp = finite(gate.blendedUp, NaN);
    if (!(marketUp > 0 && marketUp < 1 && modelUp > 0 && modelUp < 1)) continue;
    scored.push({ market: (marketUp - outcomeUp) ** 2, model: (modelUp - outcomeUp) ** 2 });
  }
  if (!scored.length) return { n: 0, text: '本版前向对照还没有结算样本' };
  const market = scored.reduce((sum, row) => sum + row.market, 0) / scored.length;
  const model = scored.reduce((sum, row) => sum + row.model, 0) / scored.length;
  return {
    n: scored.length,
    marketBrier: market,
    modelBrier: model,
    text: `本版 ${scored.length} 笔：修正概率误差 ${model.toFixed(3)}，中间价误差 ${market.toFixed(3)}${model < market ? '，修正更准' : '，中间价更准'}`
  };
}

export function buildPolymarketPaperPlan14({
  signal,
  sentiment,
  config = {},
  timeframe = '5m',
  portfolio = null,
  plan14Book = null,
  plan14Orders = [],
  now = new Date()
} = {}) {
  const slotMinutes = timeframeToSlotMinutes(timeframe);
  const schedule = signal?.schedule || getSlotSchedule(now, slotMinutes);
  const elapsedPct = windowElapsedPct(schedule);
  const symbol = signal?.symbol || sentiment?.symbol || 'BTC-USD';
  const slotIso = schedule.currentSlotIso || null;
  const targetTimeIso = signal?.prediction?.targetTimeIso || schedule.nextSlotIso || null;
  const window = { key: 'window', label: timeframe === '5m' ? '5分钟窗口' : '15分钟窗口' };
  const decision = evaluatePlan14Entry({ signal, sentiment, timeframe, book: plan14Book, now, config });
  const skill = summarizePlan14Skill(plan14Orders);
  if (decision.reason && skill.text) decision.reason = `${decision.reason}。${skill.text}`;

  let action = skip(decision.reason, decision.skipReason);
  if (decision.allowed) {
    if (!portfolio?.portfolioInitialized) {
      action = skip('Plan14 请先设置模拟本金。', 'portfolio_not_ready');
    } else {
      const selected = decision.selected;
      const usd = computePlan14OrderUsd({ cash: portfolio.cash, candidate: selected, config });
      if (!(usd > 0)) {
        action = skip('Plan14 现金或单笔风险预算不足以买入最小可成交份数。', 'insufficient_cash');
      } else {
        action = {
          shouldTrade: true,
          strategyVersion: PLAN14_VERSION,
          strategy: 'market_anchored_fair_value',
          entryType: 'market_anchored_fair_value',
          direction: selected.direction,
          label: selected.direction === 'up' ? '买 UP / 看涨' : '买 DOWN / 看跌',
          confidence: selected.p,
          edgeConfidence: selected.edge,
          calibratedConfidence: null,
          confidenceCalibrated: false,
          pHat: selected.p,
          edge: selected.edge,
          expectedRoi: selected.expectedRoi,
          expectedProfitUsd: round4(usd * selected.expectedRoi),
          executionKey: `${slotIso || 'unknown'}_${symbol}_${timeframe}_plan14`,
          entryElapsedPct: round4(elapsedPct),
          usd,
          sizing: {
            usd,
            paperSizing: true,
            method: 'fractional_kelly_fee_inclusive_edge',
            availableCash: Number(portfolio.cash) || 0
          },
          limitPrice: selected.ask,
          takeProfitPrice: null,
          stopLossPrice: null,
          holdToSettlement: false,
          plan14Model: decision.model,
          expectedValueGate: {
            passed: true,
            status: 'paper_forward_only',
            pHat: selected.p,
            executableAsk: selected.ask,
            feePerShare: selected.feePerShare,
            edge: selected.edge,
            expectedRoi: selected.expectedRoi,
            expectedProfitUsd: round4(usd * selected.expectedRoi),
            ...decision.model
          },
          reason: `${decision.reason}；模拟 $${usd.toFixed(2)}。`
        };
      }
    }
  }

  return {
    key: buildWindowPlanKey(slotIso, timeframe, symbol),
    planId: PLAN14_ID,
    algorithm: PLAN14_ID,
    strategyVersion: PLAN14_VERSION,
    symbol,
    timeframe,
    slotMinutes,
    generatedAtIso: now.toISOString(),
    targetTimeIso,
    slotIso,
    window,
    phase: window,
    elapsedPct: round4(elapsedPct),
    exitRule: {
      takeProfitOffset: null,
      stopLossOffset: null,
      takeProfitPrice: null,
      stopLossPrice: null,
      holdToSettlement: false,
      modelExit: true
    },
    decision,
    comparison: plan14Book ? evaluatePlan14Entry({ signal, sentiment, timeframe, book: plan14Book,
      now, config, policyVersion: PLAN14_PREVIOUS_VERSION }) : null,
    action,
    profitExperiment: plan14Book ? {
      asks: { up: plan14Book.up?.asks || [], down: plan14Book.down?.asks || [] },
      baseline: decision,
      candidate: evaluatePlan14Entry({ signal, sentiment, timeframe, book: plan14Book, now, config,
        policyVersion: PLAN14_PROFIT_EXPERIMENT_VERSION })
    } : null
  };
}
