export const ACTIVE_PAPER_PLAN_IDS = Object.freeze([
  'plan14', 'plan14b', 'plan15', 'plan16', 'plan16b', 'plan17', 'plan18', 'plan19', 'plan20', 'plan22',
  'plan2_6', 'plan2_6b', 'plan3_6', 'plan3_6b'
]);

function paperAbControlRunning(planId, config = {}) {
  if (config.paperAbContrastsEnabled === false) return false;
  if (planId === 'plan2_6') return config.plan2_6bEnabled !== false && config.plan2_6bNewEntriesEnabled !== false;
  if (planId === 'plan3_6') return config.plan3_6bEnabled !== false && config.plan3_6bNewEntriesEnabled !== false;
  return false;
}

export function paperPlanFlags(planId, config = {}) {
  const abControl = paperAbControlRunning(planId, config);
  return {
    newEntriesEnabled: ACTIVE_PAPER_PLAN_IDS.includes(planId)
      && (config[`${planId}Enabled`] !== false || abControl)
      && (config[`${planId}NewEntriesEnabled`] === true || abControl),
    liveTradingEnabled: false
  };
}

export function buildActivePaperPlansView({ symbol = 'BTC-USD', config = {}, statusForPlan }) {
  return {
    symbol,
    generatedAt: new Date().toISOString(),
    plans: Object.fromEntries(ACTIVE_PAPER_PLAN_IDS
      .filter((id) => config[`${id}Enabled`] !== false || paperAbControlRunning(id, config))
      .map((id) => [id, { ...statusForPlan(id), ...paperPlanFlags(id, config) }]))
  };
}
