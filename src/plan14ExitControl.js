// Same-entry / same-stake exit control only, NOT a second funded account.
import { PLAN14_VERSION, PLAN14_V9_VERSION, PLAN14_V8_VERSION, evaluatePlan14Exit, confirmPlan14Stop } from './polymarketPlan14.js';
import { polymarketCryptoTakerFee } from './polymarketMarketUtils.js';
const round2 = n => Math.round(n * 100) / 100;

export function observePlan14ExitControl(order, inputs, nowMs, config = {}, exitTakerFeeRate = 0.07) {
  const target = Date.parse(order.targetTimeIso);
  if (![PLAN14_VERSION, PLAN14_V9_VERSION].includes(order.strategyVersion) || !Number.isFinite(nowMs)
    || !Number.isFinite(target) || nowMs >= target) return null;
  const control = order.plan14ExitControl ||= { version: PLAN14_V8_VERSION, status: 'open',
    firstObservedAtIso: new Date(nowMs).toISOString(), confirmation: null };
  if (control.status === 'exited') return control;
  const previous = { ...order, strategyVersion: PLAN14_V8_VERSION, plan14StopConfirmation: control.confirmation };
  const decision = evaluatePlan14Exit({ order: previous, inputs, nowMs, config, exitTakerFeeRate });
  const confirmation = confirmPlan14Stop(previous, decision, inputs, nowMs, config);
  control.confirmation = confirmation.state;
  control.lastObservedAtIso = new Date(nowMs).toISOString();
  control.lastDecision = { ...decision, confirmed: confirmation.confirmed };
  if (decision.exit && confirmation.confirmed) {
    const bid = Number(inputs.bid), shares = Number(order.shares);
    const proceeds = round2(shares * bid - polymarketCryptoTakerFee(shares, bid, exitTakerFeeRate));
    Object.assign(control, { status: 'exited', exitStatus: decision.exitStatus,
      exitTrigger: decision.exitTrigger, exitPrice: bid, exitedAtIso: new Date(nowMs).toISOString(),
      payoutUsd: proceeds, pnl: round2(proceeds - Number(order.usd)), confirmation: null });
  }
  return control;
}

export function summarizePlan14ExitControl(orders = []) {
  const rows = orders.filter(o => [PLAN14_VERSION, PLAN14_V9_VERSION].includes(o.strategyVersion) && o.plan14ExitControl);
  let matched = 0, actualPnl = 0, controlPnl = 0, invested = 0;
  for (const o of rows) {
    if (o.settlementStatus !== 'settled' || !Number.isFinite(o.pnl)) continue;
    const c = o.plan14ExitControl;
    let pnl = c.status === 'exited' && Number.isFinite(c.pnl) ? c.pnl : null;
    if (pnl == null && ['up', 'down'].includes(o.actualDirection)
      && (o.settlementPriceSource === 'polymarket-official' || o.counterfactualOutcomeSource === 'polymarket-official')) {
      pnl = round2((o.actualDirection === o.direction ? round2(Number(o.shares)) : 0) - Number(o.usd));
    }
    if (pnl == null) continue;
    matched++; actualPnl += o.pnl; controlPnl += pnl; invested += Number(o.usd);
  }
  return { version: PLAN14_V8_VERSION, tracked: rows.length, matched, pending: rows.length - matched,
    actualPnl: round2(actualPnl), controlPnl: round2(controlPnl),
    delta: round2(actualPnl - controlPnl), invested: round2(invested),
    note: 'Retained orders only, same entries/stakes and shared observed quotes; not an independently funded portfolio or a compounding comparison. Daily archives preserve longer history.' };
}
