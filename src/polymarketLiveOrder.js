import {
  assertPlan2LiveAskAllowed,
  createPolymarketClobClient,
  extractClobFillAmounts,
  extractClobOrderId,
  getClobTokenBuyPrice,
  humanizeClobError,
  isClobBuyFillAwaitingConfirm,
  isClobBuyFillConfirmed,
  isClobOrderFilled,
  normalizeClobBuyAmounts,
  resolvePlan2FakChaseCeiling,
  submitClobBuyOrderWithFallback,
  submitClobSellOrderWithFallback,
  validateLiveOrderSubmission,
  warmConditionalTokenForSell
} from './polymarketLiveClob.js';
import { buildPolymarketReadiness } from './polymarketReadiness.js';
import { repricePlan3LiveDraft } from './polymarketPlan3.js';
import { repricePlan36LiveDraft } from './polymarketPlan3_6.js';
import { evaluatePlan5DirectionRecheck } from './polymarketPlan5.js';
import { isPlan2Family } from './polymarketPlan2Profiles.js';

/**
 * Plan2 family live chase ceiling.
 * Plan2.5 / Plan2.6: live entry-max intercept is ON by default
 * (disable with plan2_*LiveEntryMaxEnabled=false for paper-parity chase only).
 */
export function resolvePlan2LiveEntryMaxPrice(draft = {}, config = {}) {
  const ceiling = resolvePlan2FakChaseCeiling(draft, config);
  return Number.isFinite(ceiling) && ceiling > 0 ? ceiling : NaN;
}

export function repricePlan2LiveDraft(draft, freshPrice, config = {}) {
  const price = assertPlan2LiveAskAllowed(draft, freshPrice, config);
  const configuredMax = resolvePlan2LiveEntryMaxPrice(draft, config);
  const targetUsd = Number(draft?.usd);
  const normalized = normalizeClobBuyAmounts(price, targetUsd, {
    tickSize: '0.01',
    marketOrder: true
  });
  return {
    ...draft,
    intendedLimitPrice: Number(draft?.intendedLimitPrice ?? draft?.limitPrice) || null,
    limitPrice: normalized.limitPrice,
    shares: normalized.shares,
    usd: normalized.usd,
    maxLivePrice: Number.isFinite(configuredMax) && configuredMax > 0
      ? configuredMax
      : null,
    executionPreflightPrice: price,
    executionPreflightAtIso: new Date().toISOString()
  };
}

export function evaluatePlan5LiveAdversePriceMove({
  draft,
  freshPrice,
  config = {}
} = {}) {
  const intendedPrice = Number(draft?.intendedLimitPrice ?? draft?.limitPrice);
  const price = Number(freshPrice);
  if (!Number.isFinite(intendedPrice) || !Number.isFinite(price) || intendedPrice <= 0 || price <= 0) {
    return { allowed: false, severe: false, reason: 'Plan5 缺少可比较的锁定价或最新价。' };
  }
  const dropAbs = Math.max(0, intendedPrice - price);
  const dropPct = intendedPrice > 0 ? dropAbs / intendedPrice : 0;
  const riseAbs = Math.max(0, price - intendedPrice);
  const configuredMaxPriceChaseAbs = Number(config.plan5LiveMaxPriceChaseAbs);
  const maxPriceChaseAbs = Number.isFinite(configuredMaxPriceChaseAbs)
    ? Math.max(0, configuredMaxPriceChaseAbs)
    : 0.03;
  const configuredMaxDropAbs = Number(config.plan5LiveMaxAdversePriceDropAbs);
  const maxAdverseDropAbs = Number.isFinite(configuredMaxDropAbs)
    ? Math.max(0, configuredMaxDropAbs)
    : 0.12;
  const configuredMaxDropPct = Number(config.plan5LiveMaxAdversePriceDropPct);
  const maxAdverseDropPct = Number.isFinite(configuredMaxDropPct)
    ? Math.min(0.95, Math.max(0, configuredMaxDropPct))
    : 0.25;
  const configuredThreshold = Number(config.plan5LiveReversalPriceThreshold);
  const reversalPriceThreshold = Number.isFinite(configuredThreshold)
    ? Math.min(0.99, Math.max(0.01, configuredThreshold))
    : 0.20;
  // 默认关闭 15–20¢ 微探：尾盘崩价时买 UP/DOWN 彩票体感极差，且与硬下限冲突。
  const microProbeEnabled = config.plan5LiveReversalMicroProbeEnabled === true;
  const configuredProbeFloor = Number(config.plan5LiveReversalProbeFloor);
  const reversalProbeFloor = Number.isFinite(configuredProbeFloor)
    ? Math.min(reversalPriceThreshold, Math.max(0.01, configuredProbeFloor))
    : 0.15;
  const configuredProbeScale = Number(config.plan5LiveReversalProbeSizeScale);
  const reversalProbeSizeScale = Number.isFinite(configuredProbeScale)
    ? Math.min(1, Math.max(0.01, configuredProbeScale))
    : 0.20;

  // The optimized lock owns the direction, but not an unlimited entry price.
  // A rising quote does not reverse the direction; it can still destroy the
  // payout. Keep a small execution tolerance and never chase beyond it.
  if (riseAbs > maxPriceChaseAbs + 1e-9) {
    return {
      allowed: false,
      severe: false,
      reversalCandidate: false,
      priceChaseBlocked: true,
      maxPriceChaseAbs,
      intendedPrice,
      freshPrice: price,
      riseAbs,
      dropAbs,
      dropPct,
      reason: `Plan5 决策价 ${(intendedPrice * 100).toFixed(1)}¢，下单前已涨至 ${(price * 100).toFixed(1)}¢，超过允许追价 ${(maxPriceChaseAbs * 100).toFixed(1)}¢；方向保留，但本轮不以恶化赔率追单。`
    };
  }
  const configuredHardMin = Number(config.plan5HardMinEntryPrice);
  const hardMinEntryPrice = Number.isFinite(configuredHardMin)
    ? Math.min(0.49, Math.max(0.05, configuredHardMin))
    : 0.35;
  // 决策价→最新价崩塌过大：即使仍高于硬下限，也不该继续吃原方向（典型：66¢ 锁 UP 却在 26¢ 成交）。
  const dropLimit = Math.max(maxAdverseDropAbs, intendedPrice * maxAdverseDropPct);
  if (dropAbs > dropLimit + 1e-9) {
    return {
      allowed: false,
      severe: true,
      adverseDropBlocked: true,
      maxAdverseDropAbs,
      maxAdverseDropPct,
      dropLimit,
      intendedPrice,
      freshPrice: price,
      riseAbs,
      dropAbs,
      dropPct,
      reason: `Plan5 决策价 ${(intendedPrice * 100).toFixed(1)}¢ 已跌至 ${(price * 100).toFixed(1)}¢（跌 ${(dropAbs * 100).toFixed(1)}¢），超过允许回撤 ${(dropLimit * 100).toFixed(1)}¢；拒绝追崩价票。`
    };
  }
  // Ordinary tickets below the hard floor are rejected. Optional 15–20¢
  // micro-probe band is off by default.
  if (price + 1e-9 < hardMinEntryPrice && price >= reversalPriceThreshold) {
    return {
      allowed: false,
      severe: true,
      hardMinEntryBlocked: true,
      hardMinEntryPrice,
      reversalCandidate: false,
      reversalPriceThreshold,
      intendedPrice,
      freshPrice: price,
      riseAbs,
      dropAbs,
      dropPct,
      reason: `Plan5 锁定方向最新可成交价 ${(price * 100).toFixed(1)}¢ 低于硬下限 ${(hardMinEntryPrice * 100).toFixed(0)}¢，拒绝追低价票。`
    };
  }
  // A selected token falling below 20c is the only post-lock price move that
  // can invalidate the direction itself.
  if (price >= reversalPriceThreshold) {
    return {
      allowed: true,
      severe: false,
      reversalCandidate: false,
      reversalPriceThreshold,
      intendedPrice,
      freshPrice: price,
      riseAbs,
      maxPriceChaseAbs,
      dropAbs,
      dropPct
    };
  }
  if (microProbeEnabled && price >= reversalProbeFloor) {
    return {
      allowed: true,
      severe: false,
      reversalCandidate: true,
      microProbe: true,
      sizeScale: reversalProbeSizeScale,
      reversalProbeFloor,
      reversalPriceThreshold,
      intendedPrice,
      freshPrice: price,
      dropAbs,
      dropPct,
      reason: `Plan5 锁定方向最新可成交价 ${(price * 100).toFixed(1)}¢ 进入 ${(reversalProbeFloor * 100).toFixed(0)}–${(reversalPriceThreshold * 100).toFixed(0)}¢ 历史正收益探索带，保留方向并缩至超小仓×${reversalProbeSizeScale.toFixed(2)}。`
    };
  }
  return {
    allowed: false,
    severe: true,
    reversalCandidate: true,
    reversalPriceThreshold,
    intendedPrice,
    freshPrice: price,
    dropAbs,
    dropPct,
    reversalProbeFloor,
    reason: `Plan5 锁定方向最新可成交价 ${(price * 100).toFixed(1)}¢ 已低于硬拦截线 ${(reversalProbeFloor * 100).toFixed(0)}¢；历史实盘期望为负，本窗口不再买入原方向。`
  };
}

export function repricePlan5LiveDraft(draft, freshPrice, config = {}, now = new Date()) {
  const targetMs = Date.parse(String(draft?.targetTimeIso || ''));
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const minRemainingMs = Math.max(0, Number(config.plan5LiveMinSecondsRemaining) || 5) * 1000;
  if (Number.isFinite(targetMs) && Number.isFinite(nowMs) && targetMs - nowMs < minRemainingMs) {
    const remaining = Math.max(0, (targetMs - nowMs) / 1000);
    throw new Error(`Plan5 距离窗口截止仅剩 ${remaining.toFixed(1)} 秒，放弃迟到单并等待下一窗口。`);
  }
  const price = Number(freshPrice);
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    throw new Error('Plan5 下单前最新对手价不可交易。');
  }
  const targetUsd = Number(draft?.usd);
  const normalized = normalizeClobBuyAmounts(price, targetUsd, {
    tickSize: '0.01',
    marketOrder: true
  });
  return {
    ...draft,
    intendedLimitPrice: Number(draft?.intendedLimitPrice ?? draft?.limitPrice) || null,
    limitPrice: normalized.limitPrice,
    shares: normalized.shares,
    usd: normalized.usd,
    executionPreflightPrice: price,
    executionPreflightAtIso: new Date(nowMs).toISOString()
  };
}

export function resolveEffectiveClobBuyBalance({
  readiness = null,
  knownClobBalanceUsdc = null,
  tradingService = null
} = {}) {
  const freshRaw = readiness?.clob?.collateral?.balanceUsdc;
  const hasFresh = freshRaw !== null
    && freshRaw !== undefined
    && freshRaw !== ''
    && Number.isFinite(Number(freshRaw));
  const fresh = hasFresh ? Math.max(0, Number(freshRaw)) : null;
  const openOrdersCount = Number.isFinite(Number(readiness?.clob?.openOrdersCount))
    ? Number(readiness.clob.openOrdersCount)
    : null;
  const clobOk = readiness?.clob?.ok === true;

  if (fresh > 0) {
    return {
      balanceUsdc: fresh,
      source: 'fresh',
      openOrdersCount,
      clobOk,
      freshZero: false
    };
  }

  const known = Number.isFinite(Number(knownClobBalanceUsdc))
    ? Math.max(0, Number(knownClobBalanceUsdc))
    : null;
  if (known > 0) {
    return {
      balanceUsdc: known,
      source: 'known',
      openOrdersCount,
      clobOk,
      freshZero: fresh === 0
    };
  }

  if (typeof tradingService?.resolveLiveCashBalance === 'function') {
    const resolved = tradingService.resolveLiveCashBalance(fresh);
    if (Number(resolved?.cash) > 0) {
      return {
        balanceUsdc: Number(resolved.cash),
        source: resolved.source || 'cached',
        openOrdersCount,
        clobOk,
        freshZero: fresh === 0
      };
    }
  }

  return {
    balanceUsdc: fresh ?? known ?? 0,
    source: fresh === 0 ? 'fresh-zero' : 'unavailable',
    openOrdersCount,
    clobOk,
    freshZero: fresh === 0
  };
}

export function assertClobBuyBalanceSufficient(requestedUsd, balanceInfo = {}) {
  const usd = Number(requestedUsd) || 0;
  const available = Number(balanceInfo.balanceUsdc) || 0;
  if (!(usd > available)) return;

  const openOrdersCount = Number(balanceInfo.openOrdersCount) || 0;
  if (available <= 0 && openOrdersCount > 0) {
    throw new Error(
      `CLOB 可用余额被 ${openOrdersCount} 笔未成交挂单占用（读数 $0.00），不足以买入 $${usd.toFixed(2)}。`
    );
  }

  if (available <= 0 && (balanceInfo.source === 'fresh-zero' || balanceInfo.source === 'unavailable')) {
    throw new Error(
      `CLOB 余额未知（读数 $0.00），跳过本轮买入 $${usd.toFixed(2)}。`
    );
  }

  throw new Error(`CLOB 可用余额 $${available.toFixed(2)} 不足以买入 $${usd.toFixed(2)}。`);
}

export async function buildLiveOrderPreview({
  planView,
  tradingService,
  config,
  usd = null,
  clobBalanceUsdc = null
}) {
  const plan = planView?.plan;
  if (!plan?.action?.shouldTrade) {
    return {
      ready: false,
      blockedReason: plan?.action?.reason || '当前计划建议跳过。',
      plan,
      draft: null
    };
  }
  const draft = tradingService.buildLiveOrderDraft({
    plan,
    sentiment: planView.polymarket,
    recommendation: planView.recommendation,
    planId: planView.planId,
    usd,
    clobBalanceUsdc
  });
  return {
    ready: true,
    blockedReason: null,
    plan,
    draft,
    limits: {
      liveMaxOrderUsd: Number(config.liveMaxOrderUsd) || 0,
      clobBalanceUsdc: Number(clobBalanceUsdc) || 0
    }
  };
}

export async function submitPolymarketLiveOrder({
  config,
  draft,
  readiness: readinessInput = null,
  knownClobBalanceUsdc = null,
  tradingService = null
}) {
  if (String(draft?.planId).toLowerCase() === 'plan20') throw new Error('Plan20 is paper-only.');
  validateLiveOrderSubmission({ config });

  const readiness = readinessInput || await buildPolymarketReadiness(config);
  if (readiness.clob?.closedOnly === true) {
    throw new Error('账号处于 closed-only 限制，无法提交新买单。');
  }

  const balanceInfo = resolveEffectiveClobBuyBalance({
    readiness,
    knownClobBalanceUsdc,
    tradingService
  });
  const clobBalanceUsdc = balanceInfo.balanceUsdc;
  const liveMaxUsd = Number(config.liveMaxOrderUsd) || Number(config.maxOrderUsd) || 25;
  const client = await createPolymarketClobClient(config);
  let submissionDraft = draft;
  const planId = String(draft?.planId || '').toLowerCase();
  if (planId === 'plan3' || planId === 'plan3_6') {
    const freshPrice = await getClobTokenBuyPrice(client, draft.tokenId, {
      preferOrderBook: planId === 'plan3_6'
    });
    submissionDraft = planId === 'plan3'
      ? repricePlan3LiveDraft(draft, freshPrice, config)
      : repricePlan36LiveDraft(draft, freshPrice, config);
  } else if (isPlan2Family(planId) && config.plan2LivePreflightEnabled !== false) {
    // Plan2/2.5/2.6：只信盘口卖一。空盘时绝不回落 getPrice（否则会卡在陈旧 90¢ FAK）。
    const freshPrice = await getClobTokenBuyPrice(client, draft.tokenId, {
      preferOrderBook: true,
      requireOrderBook: true
    });
    submissionDraft = repricePlan2LiveDraft(draft, freshPrice, config);
  } else if (planId === 'plan5' && config.plan5LivePreflightEnabled !== false) {
    // Re-evaluate both sides immediately before submission. A weak locked side
    // that collapsed after the page locked must become an opposite-side order,
    // not a faster fill of a stale direction.
    repricePlan5LiveDraft(draft, draft.limitPrice, config, new Date());
    // Prefer order-book best ask. getPrice can lag near expiry and still quote
    // ~60–70¢ while the ask has already dumped to junk; FAK then walks into it.
    const [selectedFreshPrice, oppositeFreshPrice] = await Promise.all([
      getClobTokenBuyPrice(client, draft.tokenId, { preferOrderBook: true }),
      draft.oppositeTokenId
        ? getClobTokenBuyPrice(client, draft.oppositeTokenId, { preferOrderBook: true }).catch(() => NaN)
        : Promise.resolve(NaN)
    ]);
    const draftDirection = String(draft.direction || '').toLowerCase();
    const freshUpPrice = draftDirection === 'up' ? selectedFreshPrice : oppositeFreshPrice;
    const freshDownPrice = draftDirection === 'down' ? selectedFreshPrice : oppositeFreshPrice;
    const liveDirectionRecheck = evaluatePlan5DirectionRecheck({
      lock: {
        direction: draftDirection,
        strength: draft.lockStrength,
        pmGap: draft.lockPmGap,
        upProbability: draft.lockUpProbability,
        downProbability: draft.lockDownProbability
      },
      upPrice: freshUpPrice,
      downPrice: freshDownPrice,
      signal: {
        direction: draft.signalDirection,
        technicalDirection: draft.technicalDirection,
        spotDirection: draft.spotDirection
      },
      config
    });
    const flipped = liveDirectionRecheck.flipped === true;
    const effectiveDirection = flipped ? liveDirectionRecheck.direction : draftDirection;
    const effectiveFreshPrice = flipped ? oppositeFreshPrice : selectedFreshPrice;
    const effectiveTokenId = effectiveDirection === 'up' ? draft.upTokenId : draft.downTokenId;
    const workingDraft = flipped
      ? {
          ...draft,
          direction: effectiveDirection,
          outcome: effectiveDirection.toUpperCase(),
          tokenId: effectiveTokenId,
          oppositeTokenId: draft.tokenId,
          intendedLimitPrice: Number(
            effectiveDirection === 'up' ? draft.quotedUpPrice : draft.quotedDownPrice
          ) || effectiveFreshPrice,
          limitPrice: effectiveFreshPrice,
          directionRecheck: liveDirectionRecheck
        }
      : draft;
    if (flipped && !effectiveTokenId) {
      throw new Error('Plan5 方向重判后缺少反方向 token，放弃本次提交。');
    }
    const adverseMove = evaluatePlan5LiveAdversePriceMove({
      draft: workingDraft,
      freshPrice: effectiveFreshPrice,
      config
    });
    if (!adverseMove.allowed) throw new Error(adverseMove.reason);
    const sourceDraft = adverseMove.microProbe
      ? {
          ...workingDraft,
          usd: Math.min(
            Number(workingDraft.usd) || 0,
            Math.max(
              Math.max(0.01, Number(config.plan5LiveMinOrderUsd) || 1),
              (Number(workingDraft.usd) || 0) * adverseMove.sizeScale
            )
          )
        }
      : workingDraft;
    submissionDraft = {
      ...repricePlan5LiveDraft(sourceDraft, effectiveFreshPrice, config, new Date()),
      liveAdversePriceMove: adverseMove,
      liveDirectionRecheck
    };
  }

  const requestedUsd = Number(submissionDraft?.usd) || 0;
  if (requestedUsd > liveMaxUsd) {
    throw new Error(`实盘单笔上限 $${liveMaxUsd.toFixed(2)}，草稿 $${requestedUsd.toFixed(2)} 超限。`);
  }
  assertClobBuyBalanceSufficient(requestedUsd, balanceInfo);

  let buyResult;
  try {
    buyResult = await submitClobBuyOrderWithFallback(client, submissionDraft, config);
  } catch (error) {
    throw new Error(humanizeClobError(error, submissionDraft));
  }
  const { response, clobDraft, orderType, filled, awaitingConfirm, retried, fallback } = buyResult;
  const fillAmounts = extractClobFillAmounts(response, 'BUY');
  const normalizedDraft = {
    ...submissionDraft,
    limitPrice: clobDraft.meta?.price ?? submissionDraft.limitPrice,
    shares: fillAmounts?.shares ?? clobDraft.meta?.size ?? submissionDraft.shares,
    usd: fillAmounts?.usd ?? clobDraft.meta?.usd ?? submissionDraft.usd
  };
  if (fillAmounts) {
    normalizedDraft.limitPrice = fillAmounts.usd / fillAmounts.shares;
  }
  const confirmed = filled !== false && isClobBuyFillConfirmed(response);
  const pendingConfirm = !confirmed && (
    awaitingConfirm === true || isClobBuyFillAwaitingConfirm(response)
  );

  return {
    draft: normalizedDraft,
    clobDraft: clobDraft.meta,
    response: sanitizeClobResponse(response),
    clobOrderId: extractClobOrderId(response),
    clobBalanceUsdc,
    balanceSource: balanceInfo.source,
    filled: confirmed,
    awaitingConfirm: pendingConfirm,
    orderType: String(orderType),
    retried,
    fallback: fallback === true
  };
}

export async function submitLiveOrderFromPlan({
  planView,
  tradingService,
  config,
  usd = null,
  knownClobBalanceUsdc = null,
  readiness: readinessInput = null
}) {
  if ([planView?.planId, planView?.plan?.planId].some(id => String(id).toLowerCase() === 'plan20')) throw new Error('Plan20 is paper-only.');
  validateLiveOrderSubmission({ config });

  const readiness = readinessInput || await buildPolymarketReadiness(config);
  if (readiness.clob?.closedOnly === true) {
    throw new Error('账号处于 closed-only 限制，无法提交新买单。');
  }

  const balanceInfo = resolveEffectiveClobBuyBalance({
    readiness,
    knownClobBalanceUsdc,
    tradingService
  });
  const clobBalanceUsdc = balanceInfo.balanceUsdc;
  const preview = await buildLiveOrderPreview({
    planView,
    tradingService,
    config,
    usd,
    clobBalanceUsdc
  });
  if (!preview.ready || !preview.draft) {
    throw new Error(preview.blockedReason || '当前计划不可提交实盘订单。');
  }

  return submitPolymarketLiveOrder({
    config,
    draft: preview.draft,
    readiness,
    knownClobBalanceUsdc: clobBalanceUsdc,
    tradingService
  });
}

export async function submitPolymarketLiveSellOrder({ config, draft, position = null }) {
  validateLiveOrderSubmission({ config });

  // closed-only blocks new exposure but still permits reducing/closing positions.
  // This function only accepts SELL drafts tied to an existing position.

  const liveMaxUsd = Number(config.liveMaxOrderUsd) || Number(config.maxOrderUsd) || 25;
  const proceedsUsd = Number(draft?.usd) || 0;
  if (proceedsUsd > liveMaxUsd * 2) {
    throw new Error(`卖单预估金额 $${proceedsUsd.toFixed(2)} 异常偏高（上限参考 $${liveMaxUsd.toFixed(2)}）。`);
  }

  const shares = Number(draft?.shares) || 0;
  const positionShares = Number(position?.shares) || shares;
  if (positionShares > 0 && shares > positionShares * 1.01) {
    throw new Error(`卖单份额 ${shares} 超过持仓 ${positionShares}。`);
  }

  const client = await createPolymarketClobClient(config);
  try {
    let sellResult;
    try {
      sellResult = await submitClobSellOrderWithFallback(client, draft, config);
    } catch (error) {
      throw new Error(humanizeClobError(error, draft));
    }
    if (draft.tokenId) {
      warmConditionalTokenForSell(client, draft.tokenId).catch(() => {});
    }
    const fillAmounts = extractClobFillAmounts(sellResult.response, 'SELL');
    const normalizedDraft = sellResult.clobDraft?.meta
      ? {
        ...draft,
        limitPrice: sellResult.clobDraft.meta.price ?? draft.limitPrice,
        shares: fillAmounts?.shares ?? sellResult.clobDraft.meta.size ?? draft.shares,
        usd: fillAmounts?.usd ?? sellResult.clobDraft.meta.usd ?? draft.usd
      }
      : {
        ...draft,
        shares: fillAmounts?.shares ?? draft.shares,
        usd: fillAmounts?.usd ?? draft.usd
      };
    if (fillAmounts) normalizedDraft.limitPrice = fillAmounts.usd / fillAmounts.shares;
    return {
      draft: normalizedDraft,
      clobDraft: sellResult.clobDraft?.meta || sellResult.clobDraft,
      response: sanitizeClobResponse(sellResult.response),
      clobOrderId: extractClobOrderId(sellResult.response),
      filled: sellResult.filled !== false && isClobOrderFilled(sellResult.response),
      orderType: String(sellResult.orderType || 'GTC'),
      retried: sellResult.retried
    };
  } catch (error) {
    throw new Error(humanizeClobError(error, draft));
  }
}

function sanitizeClobResponse(response) {
  if (!response || typeof response !== 'object') return response ?? null;
  return {
    success: response.success ?? null,
    errorMsg: response.errorMsg || response.error || null,
    orderID: response.orderID || response.orderId || response.id || null,
    status: response.status || null,
    takingAmount: response.takingAmount ?? null,
    makingAmount: response.makingAmount ?? null,
    transactionsHashes: response.transactionsHashes || response.transactionHashes || []
  };
}
