export const ACTIVE_PAPER_PLAN_IDS = Object.freeze(['plan14', 'plan15', 'plan16', 'plan17', 'plan18', 'plan19']);

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
