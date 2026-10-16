import { polymarketCryptoTakerFee } from './polymarketMarketUtils.js';

/** Paper-only paired book. It never submits an order. */
export const INVERSE_RESEARCH_ID = 'paired_inverse_paper';
export const INVERSE_STARTING_CASH = 10;
export const INVERSE_MAX_DEBIT = 2;
export const INVERSE_COMPLEMENT_MIN = 0.96;
export const INVERSE_COMPLEMENT_MAX = 1.12;
export const INVERSE_MAX_SPREAD = 0.06;

const round2 = (value) => Math.round(Number(value) * 100) / 100;
const round4 = (value) => Math.round(Number(value) * 1e4) / 1e4;

export function oppositeOutcome(outcome) {
  const name = String(outcome || '').trim().toLowerCase();
  if (name === 'up') return 'Down';
  if (name === 'down') return 'Up';
  return null;
}

/**
 * Buy the other outcome at its own ask. A missing or non-complementary quote
 * is a recorded skip. The price is never synthesized as 1 − primary.
 */
export function evaluateInverseEntry({
  primaryOutcome,
  primaryAsk,
  oppositeAsk,
  oppositeBid = null,
  cash,
  maxDebit = INVERSE_MAX_DEBIT,
  maxSpread = INVERSE_MAX_SPREAD,
  complementMin = INVERSE_COMPLEMENT_MIN,
  complementMax = INVERSE_COMPLEMENT_MAX,
  feeRate = 0.07,
  minShares = 1
} = {}) {
  const outcome = oppositeOutcome(primaryOutcome);
  if (!outcome) return { ok: false, reason: 'unsupported_outcome' };
  const ask = Number(oppositeAsk);
  const primary = Number(primaryAsk);
  if (!(ask > 0 && ask < 1)) return { ok: false, reason: 'missing_opposite_ask', outcome };
  if (!(primary > 0 && primary < 1)) return { ok: false, reason: 'missing_primary_ask', outcome };
  const bid = oppositeBid == null || oppositeBid === '' ? NaN : Number(oppositeBid);
  if (Number.isFinite(bid) && bid > 0 && ask - bid > maxSpread + 1e-9) {
    return { ok: false, reason: 'wide_spread', outcome, ask };
  }
  const sum = primary + ask;
  if (sum < complementMin - 1e-9 || sum > complementMax + 1e-9) {
    return { ok: false, reason: 'complement_gap', outcome, ask, sum };
  }
  const available = Number(cash);
  const budget = Math.min(Number(maxDebit), available);
  if (!(budget > 0)) return { ok: false, reason: 'insufficient_cash', outcome, ask };
  const grossShares = budget / ask;
  if (grossShares + 1e-9 < minShares) return { ok: false, reason: 'below_min_shares', outcome, ask };
  const feeUsd = feeRate > 0 ? polymarketCryptoTakerFee(grossShares, ask, feeRate) : 0;
  const shares = grossShares - feeUsd / ask;
  if (!(shares > 0)) return { ok: false, reason: 'fee_consumes_shares', outcome, ask };
  return {
    ok: true,
    outcome,
    ask,
    bid: Number.isFinite(bid) ? bid : null,
    usd: round2(budget),
    grossShares: round4(grossShares),
    shares: round4(shares),
    feeUsd: round4(feeUsd),
    sum
  };
}

export function createInverseAccount(nowMs = Date.now()) {
  return {
    id: INVERSE_RESEARCH_ID,
    paperOnly: true,
    liveOrdersEnabled: false,
    pairedPlanId: 'plan21',
    startingCash: INVERSE_STARTING_CASH,
    cash: INVERSE_STARTING_CASH,
    maxDebit: INVERSE_MAX_DEBIT,
    realizedPnl: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
    invalidCount: 0,
    open: [],
    settled: [],
    invalid: [],
    startedAtIso: new Date(nowMs).toISOString()
  };
}

function rememberInvalid(account, row) {
  account.invalidCount = (Number(account.invalidCount) || 0) + 1;
  account.invalid = [row, ...(account.invalid || [])].slice(0, 40);
}

export function applyInverseObservation(account, {
  primaryOrder,
  primaryAsk,
  oppositeAsk,
  oppositeBid = null,
  oppositeTokenId = null,
  feeRate = 0.07,
  nowIso = new Date().toISOString()
} = {}) {
  if (!account || account.paperOnly !== true || account.liveOrdersEnabled !== false) {
    return { filled: false, reason: 'ledger_closed' };
  }
  const decision = evaluateInverseEntry({
    primaryOutcome: primaryOrder?.outcome,
    primaryAsk,
    oppositeAsk,
    oppositeBid,
    cash: account.cash,
    maxDebit: account.maxDebit,
    feeRate
  });
  const skip = {
    atIso: nowIso,
    marketSlug: primaryOrder?.marketSlug || null,
    primaryOrderId: primaryOrder?.id || null,
    primaryOutcome: primaryOrder?.outcome || null,
    primaryAsk: Number(primaryAsk),
    oppositeAsk: Number(oppositeAsk) > 0 ? Number(oppositeAsk) : null,
    reason: decision.reason || 'rejected'
  };
  if (!decision.ok) {
    rememberInvalid(account, skip);
    return { filled: false, ...decision };
  }
  if ((account.open || []).some((order) => order.marketSlug && order.marketSlug === primaryOrder?.marketSlug)) {
    rememberInvalid(account, { ...skip, reason: 'already_open' });
    return { filled: false, reason: 'already_open' };
  }
  const order = {
    id: `pm-plan21-inverse-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    pairedPlanId: 'plan21',
    primaryOrderId: primaryOrder?.id || null,
    symbol: primaryOrder?.symbol || null,
    timeframe: '5m',
    market: primaryOrder?.market || primaryOrder?.marketSlug || null,
    marketSlug: primaryOrder?.marketSlug || null,
    conditionId: primaryOrder?.conditionId || null,
    tokenId: oppositeTokenId || null,
    outcome: decision.outcome,
    direction: decision.outcome.toLowerCase(),
    entryPrice: decision.ask,
    limitPrice: decision.ask,
    usd: decision.usd,
    shares: decision.shares,
    grossShares: decision.grossShares,
    paperEntryFeeUsd: decision.feeUsd,
    primaryAsk: Number(primaryAsk),
    targetTimeIso: primaryOrder?.targetTimeIso || null,
    openedAtIso: nowIso,
    settlementStatus: 'open',
    mode: 'paper',
    paperOnly: true
  };
  account.cash = round2(account.cash - decision.usd);
  account.open = [order, ...(account.open || [])];
  return { filled: true, order };
}

export function settleInverseTrade(account, {
  marketSlug,
  officialOutcome = null,
  voided = false,
  outcomes = null,
  outcomePrices = null,
  nowIso = new Date().toISOString()
} = {}) {
  if (!account) return null;
  const order = (account.open || []).find((item) => item.marketSlug === marketSlug && item.settlementStatus === 'open');
  if (!order) return null;
  let won = null;
  let payout = 0;
  if (voided) {
    const index = (outcomes || []).findIndex((name) => String(name).toLowerCase() === String(order.outcome).toLowerCase());
    const perShare = index >= 0 ? Number(outcomePrices?.[index]) : NaN;
    if (!Number.isFinite(perShare)) return null;
    payout = round2((Number(order.shares) || 0) * perShare);
    order.voidSettlement = true;
  } else {
    const label = String(officialOutcome || '').trim();
    if (!label) return null;
    won = label.toLowerCase() === String(order.outcome).trim().toLowerCase();
    payout = won ? round2(Number(order.shares) || 0) : 0;
  }
  const pnl = round2(payout - Number(order.usd));
  order.settlementStatus = 'settled';
  order.won = won;
  order.pnl = pnl;
  order.payoutUsd = payout;
  order.officialOutcome = voided ? '作废' : officialOutcome;
  order.settledAtIso = nowIso;
  account.open = account.open.filter((item) => item !== order);
  account.settled = [order, ...(account.settled || [])].slice(0, 40);
  account.cash = round2(account.cash + payout);
  account.realizedPnl = round2((Number(account.realizedPnl) || 0) + pnl);
  if (won === true) account.wins = (Number(account.wins) || 0) + 1;
  else if (won === false) account.losses = (Number(account.losses) || 0) + 1;
  else account.pushes = (Number(account.pushes) || 0) + 1;
  return order;
}

export function summarizeInverseAccount(account) {
  const dormant = {
    started: false,
    paperOnly: true,
    liveOrdersEnabled: false,
    pairedPlanId: 'plan21',
    startingCash: INVERSE_STARTING_CASH,
    maxDebit: INVERSE_MAX_DEBIT,
    cash: null,
    openExposure: 0,
    realizedPnl: 0,
    roi: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
    winRate: 0,
    trades: 0,
    open: 0,
    invalid: 0
  };
  if (!account || account.id !== INVERSE_RESEARCH_ID) return dormant;
  const wins = Number(account.wins) || 0;
  const losses = Number(account.losses) || 0;
  const pushes = Number(account.pushes) || 0;
  const decided = wins + losses;
  const realized = Number(account.realizedPnl) || 0;
  const starting = Number(account.startingCash) || INVERSE_STARTING_CASH;
  return {
    started: true,
    paperOnly: true,
    liveOrdersEnabled: false,
    pairedPlanId: 'plan21',
    startingCash: starting,
    maxDebit: Number(account.maxDebit) || INVERSE_MAX_DEBIT,
    cash: round2(account.cash),
    openExposure: round2((account.open || []).reduce((sum, order) => sum + (Number(order.usd) || 0), 0)),
    realizedPnl: round2(realized),
    roi: starting > 0 ? round2((realized / starting) * 100) : 0,
    wins,
    losses,
    pushes,
    winRate: decided ? round2((wins / decided) * 100) : 0,
    trades: wins + losses + pushes,
    open: (account.open || []).length,
    invalid: Number(account.invalidCount) || 0
  };
}
