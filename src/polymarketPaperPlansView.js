// 2026-10-18: plan17 and plan19 left the active paper list. Plan18 stays as the
// random control. Plan21 is the small 5m sampler. History tabs can still open
// a retired id directly.
export const ACTIVE_PAPER_PLAN_IDS = Object.freeze([
  'plan14', 'plan15', 'plan16', 'plan18', 'plan20', 'plan21', 'plan22'
]);

export function paperPlanFlags(planId, config = {}) {
  return {
    newEntriesEnabled: ACTIVE_PAPER_PLAN_IDS.includes(planId)
      && config[`${planId}Enabled`] !== false
      && config[`${planId}NewEntriesEnabled`] === true,
    liveTradingEnabled: false
  };
}

export function buildActivePaperPlansView({ symbol = 'BTC-USD', config = {}, statusForPlan }) {
  return {
    symbol,
    generatedAt: new Date().toISOString(),
    plans: Object.fromEntries(ACTIVE_PAPER_PLAN_IDS
      .filter((id) => config[`${id}Enabled`] !== false)
      .map((id) => [id, { ...statusForPlan(id), ...paperPlanFlags(id, config) }]))
  };
}
