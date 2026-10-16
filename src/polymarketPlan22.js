import { polymarketCryptoTakerFee } from './polymarketMarketUtils.js';

export const PLAN22_ID = 'plan22';
export const PLAN22_VERSION = 'plan22_15m_kline_composite_v1';

/**
 * 15 分钟综合判断，和 hourlyMonitor「15m 综合 10-15m 阶段准确率」用的是同一套阶段权重
 * （predictionRecorder COMPOSITE_TECH_WEIGHTS / 前一根 K 线反转修正）。
 *
 * 准确率不等于可交易优势：按中间价买综合方向，扣掉 crypto taker fee 之后是负的。
 * Plan1 曾按这个方向在 15m 开仓并亏损。Plan22 只在下面同时成立时买，并持有到官方结算：
 * - 仅 15m，阶段在 5–12 分钟（phase2，以及 phase3 的前两分钟）
 * - Binance 现货相对本根开盘价的方向与综合方向一致，且距离够、报价够新
 * - 综合概率高于该侧卖一，扣费后期望仍为正（相对 PM mid 的错价）
 */
export const PLAN22_PHASE_TECH_WEIGHTS = Object.freeze({
  phase1: 0.05,
  phase2: 0.35,
  phase3: 0.5
});

const PREVIOUS_MOVE_REVERSAL_MIN = 0.003;
const PREVIOUS_MOVE_REVERSAL_MAX = 0.005;
const PREVIOUS_MOVE_REVERSAL_BOOSTS = Object.freeze({
  phase1: 0.04,
  phase2: 0.03,
  phase3: 0.02
});

export const PLAN22_DEFAULTS = Object.freeze({
  minElapsedPct: 5 / 15,
  maxElapsedPct: 12 / 15,
  minPrice: 0.42,
  maxPrice: 0.72,
  maxSpread: 0.04,
  minSpotDistanceBps: 8,
  maxSpotAgeMs: 15_000,
  minEdgeAfterFee: 0.02,
  takerFeeRate: 0.07,
  orderUsd: 5,
  startingCash: 500,
  windowMs: 900_000
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

export function plan22InputsFromSignal(signal, spotQuoteMs = Date.now()) {
  if (!signal || signal.direction === 'wait') return null;
  const techUp = Number(signal.probabilities?.up ?? signal.technicalProbabilities?.up);
  const techDown = Number(signal.probabilities?.down ?? signal.technicalProbabilities?.down);
  const slotOpen = Number(signal.indicators?.slotStartPrice ?? signal.prediction?.comparisonBasePrice);
  const spot = Number(signal.indicators?.currentPrice);
  if (!(techUp >= 0) || !(techDown >= 0) || !(slotOpen > 0) || !(spot > 0)) return null;
  return {
    techUp,
    techDown,
    previousMovePct: Number(signal.indicators?.previousClosedCandleMovePct),
    slotOpen,
    spot,
    spotQuoteMs: Number(spotQuoteMs) || Date.now()
  };
}

export function plan22Phase(elapsedPct) {
  const elapsed = Number(elapsedPct);
  if (!Number.isFinite(elapsed)) return null;
  if (elapsed < 5 / 15) return 'phase1';
  if (elapsed < 10 / 15) return 'phase2';
  return 'phase3';
}

function bookSide(book) {
  const ask = finite(book?.bestAsk ?? book?.ask);
  const bid = book?.bestBid == null && book?.bid == null ? null : finite(book?.bestBid ?? book?.bid);
  return { ask, bid };
}

function midOf(side) {
  if (side.ask == null) return null;
  if (side.bid == null) return side.ask;
  return (side.ask + side.bid) / 2;
}

/** 与 predictionRecorder.buildCompositePhaseEntry 同一公式。 */
export function plan22Composite({
  techUp,
  techDown,
  pmUp,
  pmDown,
  phase,
  qualityScore = 1,
  previousMovePct = null
} = {}) {
  const techWeightBase = PLAN22_PHASE_TECH_WEIGHTS[phase];
  if (techWeightBase == null) return null;
  const tUp = Number(techUp) || 0;
  const tDown = Number(techDown) || 0;
  const pUp = Number(pmUp) || 0;
  const pDown = Number(pmDown) || 0;
  const techSum = Math.max(tUp + tDown, 0.000001);
  const polySum = Math.max(pUp + pDown, 0.000001);
  const quality = clamp(qualityScore, 0.15, 1, 1);
  const techWeight = phase === 'phase1'
    ? techWeightBase
    : techWeightBase + (1 - techWeightBase) * (1 - quality);
  const polyWeight = 1 - techWeight;
  const blendedUp = (tUp / techSum) * techWeight + (pUp / polySum) * polyWeight;
  const blendedDown = (tDown / techSum) * techWeight + (pDown / polySum) * polyWeight;
  const adjusted = applyPreviousMoveReversal({
    upProbability: blendedUp,
    downProbability: blendedDown,
    previousMovePct,
    phase
  });
  const direction = adjusted.upProbability >= adjusted.downProbability ? 'up' : 'down';
  return {
    direction,
    upProbability: adjusted.upProbability,
    downProbability: adjusted.downProbability,
    confidence: Math.max(adjusted.upProbability, adjusted.downProbability),
    techWeight,
    polymarketWeight: polyWeight,
    qualityScore: quality,
    previousMoveAdjustment: adjusted.adjustment
  };
}

function applyPreviousMoveReversal({ upProbability, downProbability, previousMovePct, phase }) {
  const move = Number(previousMovePct);
  if (!Number.isFinite(move)) return { upProbability, downProbability, adjustment: 0 };
  const absMove = Math.abs(move);
  if (absMove < PREVIOUS_MOVE_REVERSAL_MIN || absMove >= PREVIOUS_MOVE_REVERSAL_MAX) {
    return { upProbability, downProbability, adjustment: 0 };
  }
  const boost = PREVIOUS_MOVE_REVERSAL_BOOSTS[phase] ?? 0.02;
  const up = Math.max(0.02, Math.min(0.98, move < 0 ? upProbability + boost : upProbability - boost));
  return {
    upProbability: up,
    downProbability: 1 - up,
    adjustment: move < 0 ? boost : -boost
  };
}

function skip(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

/**
 * 报告用对照，不占现金。用市场 slug 做稳定散列，同一盘每次得到同一侧。
 * 这不是 Plan18/19 的卦象。
 */
export function plan22ControlOutcome(marketSlug) {
  let hash = 2166136261;
  const text = String(marketSlug || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2 === 0 ? 'Up' : 'Down';
}

export function plan22PaperShares(usd, ask, feeRate = PLAN22_DEFAULTS.takerFeeRate) {
  const stake = Number(usd);
  const price = Number(ask);
  if (!(stake > 0) || !(price > 0 && price < 1)) return null;
  const gross = stake / price;
  const feeUsd = polymarketCryptoTakerFee(gross, price, feeRate);
  return {
    grossShares: round4(gross),
    shares: round4(gross - feeUsd / price),
    feeUsd: round4(feeUsd),
    feePerShare: round4(polymarketCryptoTakerFee(1, price, feeRate))
  };
}

export function plan22ControlPnl({ usd, ask, outcome, officialOutcome, feeRate }) {
  const priced = plan22PaperShares(usd, ask, feeRate);
  if (!priced || !outcome || !officialOutcome) return null;
  const won = String(officialOutcome).trim().toLowerCase() === String(outcome).trim().toLowerCase();
  const payout = won ? priced.shares : 0;
  return {
    won,
    pnl: round2(payout - Number(usd)),
    shares: priced.shares,
    hypothetical: true
  };
}

/**
 * @returns {{ok:true, outcome:'Up'|'Down', direction:'up'|'down', ask:number, ...} | {ok:false, reason:string}}
 */
export function evaluatePlan22({
  startMs = null,
  endMs = null,
  nowMs = Date.now(),
  spot = null,
  slotOpen = null,
  spotQuoteMs = null,
  techUp = null,
  techDown = null,
  previousMovePct = null,
  upBook = null,
  downBook = null,
  marketSlug = '',
  randomControl = false,
  minElapsedPct = PLAN22_DEFAULTS.minElapsedPct,
  maxElapsedPct = PLAN22_DEFAULTS.maxElapsedPct,
  minPrice = PLAN22_DEFAULTS.minPrice,
  maxPrice = PLAN22_DEFAULTS.maxPrice,
  maxSpread = PLAN22_DEFAULTS.maxSpread,
  minSpotDistanceBps = PLAN22_DEFAULTS.minSpotDistanceBps,
  maxSpotAgeMs = PLAN22_DEFAULTS.maxSpotAgeMs,
  minEdgeAfterFee = PLAN22_DEFAULTS.minEdgeAfterFee,
  feeRate = PLAN22_DEFAULTS.takerFeeRate
} = {}) {
  const start = Number(startMs);
  const end = Number(endMs);
  const now = Number(nowMs);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return skip('missing_window');
  const windowMs = end - start;
  if (Math.abs(windowMs - PLAN22_DEFAULTS.windowMs) > 30_000) return skip('not_15m', { windowMs });
  const elapsedPct = (now - start) / windowMs;
  const phase = plan22Phase(elapsedPct);
  if (elapsedPct < minElapsedPct - 1e-9 || elapsedPct > maxElapsedPct + 1e-9) {
    return skip('outside_phase', { phase, elapsedPct });
  }
  const quoteMs = Number(spotQuoteMs);
  if (!Number.isFinite(quoteMs) || quoteMs <= 0 || quoteMs > now) return skip('spot_age');
  if (now - quoteMs > maxSpotAgeMs) return skip('spot_age', { spotAgeMs: now - quoteMs });
  const spotPx = Number(spot);
  const openPx = Number(slotOpen);
  if (!(spotPx > 0) || !(openPx > 0)) return skip('missing_spot');
  const distanceBps = ((spotPx - openPx) / openPx) * 10_000;
  if (!Number.isFinite(distanceBps) || Math.abs(distanceBps) + 1e-9 < minSpotDistanceBps) {
    return skip('spot_lock', { distanceBps });
  }
  const spotDirection = distanceBps >= 0 ? 'up' : 'down';
  const up = bookSide(upBook);
  const down = bookSide(downBook);
  if (!(up.ask > 0 && up.ask < 1) || !(down.ask > 0 && down.ask < 1)) return skip('incomplete_book');
  const upMid = midOf(up);
  const downMid = midOf(down);
  const quality = clamp(1 - Math.max(0, (up.ask - (up.bid ?? up.ask)) + (down.ask - (down.bid ?? down.ask))) / 0.16, 0.15, 1, 0.6);
  const composite = plan22Composite({
    techUp,
    techDown: techDown == null ? 1 - Number(techUp) : techDown,
    pmUp: upMid,
    pmDown: downMid,
    phase,
    qualityScore: quality,
    previousMovePct
  });
  if (!composite) return skip('no_composite');
  if (composite.direction !== spotDirection) return skip('spot_disagrees', { phase, direction: composite.direction, spotDirection });
  const side = composite.direction === 'up' ? up : down;
  const other = composite.direction === 'up' ? down : up;
  const spread = side.bid == null ? 0 : side.ask - side.bid;
  if (spread > maxSpread + 1e-9) return skip('wide_spread', { spread });
  if (side.ask < minPrice - 1e-9 || side.ask > maxPrice + 1e-9) return skip('price_out_of_range', { ask: side.ask });
  const feePerShare = polymarketCryptoTakerFee(1, side.ask, feeRate);
  const mid = composite.direction === 'up' ? upMid : downMid;
  const pHat = composite.confidence;
  const edgeAfterFee = pHat - side.ask - feePerShare;
  if (!(pHat > mid + 1e-9)) return skip('no_mispricing', { pHat, mid, phase });
  if (edgeAfterFee + 1e-12 < minEdgeAfterFee) return skip('edge_after_fee', { edgeAfterFee, pHat, ask: side.ask, feePerShare });
  const outcome = composite.direction === 'up' ? 'Up' : 'Down';
  const controlOutcome = randomControl ? plan22ControlOutcome(marketSlug) : null;
  const controlBook = controlOutcome === 'Up' ? up : controlOutcome === 'Down' ? down : null;
  return {
    ok: true,
    outcome,
    direction: composite.direction,
    ask: side.ask,
    bid: side.bid,
    mid,
    otherAsk: other.ask,
    phase,
    elapsedPct: round4(elapsedPct),
    pHat: round4(pHat),
    techWeight: round4(composite.techWeight),
    feePerShare: round4(feePerShare),
    edgeAfterFee: round4(edgeAfterFee),
    distanceBps: round4(distanceBps),
    spotAgeMs: now - quoteMs,
    spread: round4(spread),
    feeRate,
    control: controlBook ? {
      outcome: controlOutcome,
      ask: controlBook.ask,
      sameAsSignal: controlOutcome === outcome,
      hypothetical: true
    } : null
  };
}

/** 固定样本上的扣费结算。随机对照只记在报告里，不进现金。 */
export function backtestPlan22(rows, { usd = PLAN22_DEFAULTS.orderUsd, ...options } = {}) {
  const taken = [];
  const skipped = {};
  for (const row of rows) {
    const decision = evaluatePlan22({ ...options, ...row });
    if (!decision.ok) {
      skipped[decision.reason] = (skipped[decision.reason] || 0) + 1;
      continue;
    }
    const official = row.actual === 'down' ? 'Down' : 'Up';
    const won = official.toLowerCase() === decision.outcome.toLowerCase();
    const priced = plan22PaperShares(usd, decision.ask, decision.feeRate);
    const pnl = round2((won ? priced.shares : 0) - usd);
    const control = decision.control
      ? plan22ControlPnl({
        usd,
        ask: decision.control.ask,
        outcome: decision.control.outcome,
        officialOutcome: official,
        feeRate: decision.feeRate
      })
      : null;
    taken.push({
      phase: decision.phase,
      outcome: decision.outcome,
      ask: decision.ask,
      pHat: decision.pHat,
      edgeAfterFee: decision.edgeAfterFee,
      won,
      pnl,
      controlPnl: control?.pnl ?? null,
      controlWon: control?.won ?? null
    });
  }
  const pnl = round2(taken.reduce((sum, row) => sum + row.pnl, 0));
  const controlRows = taken.filter((row) => row.controlPnl != null);
  return {
    samples: rows.length,
    trades: taken.length,
    wins: taken.filter((row) => row.won).length,
    pnl,
    skipped,
    control: controlRows.length ? {
      trades: controlRows.length,
      wins: controlRows.filter((row) => row.controlWon).length,
      pnl: round2(controlRows.reduce((sum, row) => sum + row.controlPnl, 0))
    } : null,
    tradesDetail: taken
  };
}

/**
 * 短样本：现货已经锁方向、PM 卖一还没跟上时，扣费后应为正；
 * 早段、卖一已跟上、价差宽、现货旧、现货反向，都不下单。
 */
export function plan22SmokeRows({ randomControl = true } = {}) {
  const start = Date.parse('2026-10-16T02:00:00Z');
  const end = start + 900_000;
  const base = {
    startMs: start,
    endMs: end,
    spot: 100.12,
    slotOpen: 100,
    spotQuoteMs: start + 8 * 60_000,
    techUp: 0.74,
    techDown: 0.26,
    previousMovePct: 0.001,
    upBook: { bestBid: 0.46, bestAsk: 0.48 },
    downBook: { bestBid: 0.52, bestAsk: 0.54 },
    marketSlug: 'btc-updown-15m-smoke',
    randomControl
  };
  const rows = [];
  for (let index = 0; index < 30; index += 1) {
    rows.push({
      ...base,
      nowMs: start + 8 * 60_000,
      marketSlug: `btc-updown-15m-edge-${index}`,
      actual: index < 21 ? 'up' : 'down'
    });
  }
  rows.push({ ...base, nowMs: start + 60_000, marketSlug: 'too-early', actual: 'up' });
  rows.push({
    ...base,
    nowMs: start + 8 * 60_000,
    upBook: { bestBid: 0.68, bestAsk: 0.70 },
    downBook: { bestBid: 0.30, bestAsk: 0.32 },
    marketSlug: 'already-priced',
    actual: 'up'
  });
  rows.push({
    ...base,
    nowMs: start + 8 * 60_000,
    upBook: { bestBid: 0.30, bestAsk: 0.48 },
    marketSlug: 'wide',
    actual: 'up'
  });
  rows.push({
    ...base,
    nowMs: start + 8 * 60_000,
    spotQuoteMs: start,
    marketSlug: 'stale',
    actual: 'up'
  });
  rows.push({
    ...base,
    nowMs: start + 8 * 60_000,
    spot: 99.8,
    marketSlug: 'spot-down',
    actual: 'down'
  });
  return rows;
}
