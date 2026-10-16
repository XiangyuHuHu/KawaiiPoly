const pmStatus = document.querySelector('#pmStatus');
const pmPlan14Equity = document.querySelector('#pmPlan14Equity');
const pmPlan14Return = document.querySelector('#pmPlan14Return');
const pmPlan14Auto = document.querySelector('#pmPlan14Auto');
const pmPlan15Equity = document.querySelector('#pmPlan15Equity');
const pmPlan15Return = document.querySelector('#pmPlan15Return');
const pmPlan16Equity = document.querySelector('#pmPlan16Equity');
const pmPlan16Return = document.querySelector('#pmPlan16Return');
const pmPlan17Equity = document.querySelector('#pmPlan17Equity');
const pmPlan17Return = document.querySelector('#pmPlan17Return');
const pmPlan18Equity = document.querySelector('#pmPlan18Equity');
const pmPlan18Return = document.querySelector('#pmPlan18Return');
const pmPlan19Equity = document.querySelector('#pmPlan19Equity');
const pmPlan19Return = document.querySelector('#pmPlan19Return');
const pmPlan21Equity = document.querySelector('#pmPlan21Equity');
const pmPlan21Return = document.querySelector('#pmPlan21Return');
const pmRefreshAll = document.querySelector('#pmRefreshAll');
const columns = [...document.querySelectorAll('.pm-dual-column')];

const PAPER_PLAN_IDS = ['plan14', 'plan15', 'plan16', 'plan17', 'plan18', 'plan19', 'plan21'];
const EVENT_PAPER_PLANS = new Set(['plan15', 'plan16', 'plan17', 'plan18', 'plan19', 'plan21']);
const PLAN_IDS = [...PAPER_PLAN_IDS];
const INDEPENDENT_PLANS = new Set();
const PAPER_SYMBOLS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD'];
const MULTI_SYMBOL_PLANS = new Set(['plan14']);
const PLAN_SWITCH_HINTS = {
  plan14: 'Plan14 v11 · 已停新仓（回测盘口比模型准）· 旧单持有到官方结算 · 仅模拟',
  plan15: 'Plan15 · 市场扩展事件 · 领先结果 40–70¢ · 2 天内官方结算 · 与 Plan14 分开记账 · 仅模拟',
  plan16: 'Plan16 · 机场温度 · 已停新仓（回测盘口比预报准）· 旧单持有到官方结算 · 仅模拟',
  plan17: 'Plan17 · BTC/ETH 价格档位 · Deribit 隐含波动率定价 · 扣费后高出 10¢ 才买 · 半凯利定仓 · 持有到官方结算 · 仅模拟',
  plan18: 'Plan18 · 随机对照组 · 梅花易数起卦定四币 5m/15m/1h 涨跌 · Plan17 要明显好过它才算有效 · 仅模拟',
  plan19: 'Plan19 · 随机对照组 · 小六壬起卦定四币 5m/15m/1h 涨跌 · 与 Plan18 同盘同时对比 · 仅模拟',
  plan21: 'Plan21 · BTC/ETH 5 分钟买落后方 · 只做回测里扣费后为正的三格 · 3 分钟且 20–35¢ 不买 · 每笔 $5 · 仅模拟'
};
const state = {
  latestStatus: null,
  plansView: { plan14: null, plan15: null, plan16: null, plan17: null, plan18: null, plan19: null, plan21: null },
  orders: { plan14: [], plan15: [], plan16: [], plan17: [], plan18: [], plan19: [], plan21: [] },
  plan3Opportunities: [],
  plan3Analytics: null,
  plan36Analytics: null,
  activePlan: 'plan14',
  activeTimeframe: { plan14: '5m' },
  activeSymbol: { plan14: 'BTC-USD' },
  enabledSymbols: {
    plan14: [...PAPER_SYMBOLS]
  }
};

let paperPlanRefreshBusy = false;
let paperOrdersRefreshBusy = false;
let paperPlanRefreshPending = false;
let paperOrdersRefreshPending = false;
let paperStatusRefreshBusy = false;
pmRefreshAll?.addEventListener('click', refreshAll);

document.querySelectorAll('[data-plan-tab]').forEach((tab) => {
  tab.addEventListener('click', () => setActivePlan(tab.dataset.planTab));
});

for (const column of columns) {
  const planId = column.dataset.plan;
  column.querySelector('.pm-portfolio-form')?.addEventListener('submit', (e) => configurePortfolio(e, planId));
  column.querySelector('[data-action="reset-portfolio"]')?.addEventListener('click', () => resetPortfolio(planId));
  column.querySelector('[data-action="auto-start"]')?.addEventListener('click', () => startAuto(planId));
  column.querySelector('[data-action="auto-stop"]')?.addEventListener('click', () => stopAuto(planId));
  column.querySelector('[data-action="reset-orders"]')?.addEventListener('click', () => resetOrders(planId));
  column.querySelector('[data-action="execute-plan"]')?.addEventListener('click', () => executePlan(planId));
  column.querySelectorAll('.pm-timeframe-tabs .pm-tab').forEach((tab) => {
    tab.addEventListener('click', () => setTimeframe(planId, tab.dataset.timeframe));
  });
  column.querySelectorAll('.pm-symbol-tabs .pm-tab').forEach((tab) => {
    tab.addEventListener('click', () => togglePaperSymbol(planId, tab.dataset.symbol));
  });
}

function setActivePlan(planId) {
  if (!PLAN_IDS.includes(planId)) return;
  state.activePlan = planId;
  document.querySelectorAll('[data-plan-tab]').forEach((tab) => {
    const active = tab.dataset.planTab === planId;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  columns.forEach((column) => {
    column.classList.toggle('is-active', column.dataset.plan === planId);
  });
  const hint = document.querySelector('[data-role="plan-switcher-hint"]');
  if (hint) hint.textContent = PLAN_SWITCH_HINTS[planId] || '';
  if (location.hash !== `#${planId}`) {
    history.replaceState(null, '', `#${planId}`);
  }
  if (EVENT_PAPER_PLANS.has(planId)) {
    renderOrders(planId, state.orders[planId] || []);
    refreshOrders().catch(() => {});
    return;
  }
  if (INDEPENDENT_PLANS.has(planId)) return;
  renderPlanPanel(planId);
  renderOrders(planId, state.orders[planId] || []);
  refreshActivePlan().catch(() => {});
  refreshOrders().catch(() => {});
}

function selectedPaperSymbols(planId) {
  if (!MULTI_SYMBOL_PLANS.has(planId)) return ['BTC-USD'];
  const symbols = state.enabledSymbols[planId] || [];
  return symbols.length ? symbols : ['BTC-USD'];
}

function syncPaperSymbolButtons(planId) {
  const column = getColumn(planId);
  if (!column) return;
  const enabled = new Set(selectedPaperSymbols(planId));
  const viewSymbol = state.activeSymbol[planId] || 'BTC-USD';
  column.querySelectorAll('.pm-symbol-tabs .pm-tab').forEach((tab) => {
    const symbol = tab.dataset.symbol;
    const on = enabled.has(symbol);
    tab.classList.toggle('active', on);
    tab.classList.toggle('pm-symbol-viewing', symbol === viewSymbol);
    tab.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

async function togglePaperSymbol(planId, symbol) {
  if (!MULTI_SYMBOL_PLANS.has(planId)) return;
  if (!PAPER_SYMBOLS.includes(symbol)) return;
  const current = selectedPaperSymbols(planId);
  const on = current.includes(symbol);

  // 已开启但非当前查看：只切换预览币种，不关闭
  if (on && state.activeSymbol[planId] !== symbol) {
    state.activeSymbol[planId] = symbol;
    syncPaperSymbolButtons(planId);
    try {
      const view = await getJson(`/api/polymarket/paper-plans?symbol=${symbol}&plan=${planId}`);
      state.plansView[planId] = view;
      renderPlanPanel(planId);
    } catch {
      // 保留旧视图
    }
    return;
  }

  let next;
  if (on) {
    if (current.length <= 1) return;
    next = current.filter((item) => item !== symbol);
    state.activeSymbol[planId] = next[0];
  } else {
    next = [...current, symbol];
    state.activeSymbol[planId] = symbol;
  }
  state.enabledSymbols[planId] = next;
  syncPaperSymbolButtons(planId);

  const auto = state.latestStatus?.plans?.[planId]?.auto;
  if (auto?.enabled) {
    try {
      await postJson('/api/polymarket/auto/start', {
        strategy: planId,
        timeframes: planId === 'plan14' ? ['5m'] : ['5m', '15m'],
        planId,
        symbols: next
      });
      await refreshStatus();
    } catch {
      // 下一轮轮询会纠正
    }
  }

  try {
    const view = await getJson(`/api/polymarket/paper-plans?symbol=${state.activeSymbol[planId]}&plan=${planId}`);
    state.plansView[planId] = view;
    renderPlanPanel(planId);
  } catch {
    // 保留旧视图
  }
}

const hashPlan = String(location.hash || '').replace(/^#/, '');
if (PLAN_IDS.includes(hashPlan)) state.activePlan = hashPlan;

await refreshAll();
setActivePlan(state.activePlan || 'plan14');
window.addEventListener('hashchange', () => {
  const next = String(location.hash || '').replace(/^#/, '');
  if (PLAN_IDS.includes(next) && next !== state.activePlan) setActivePlan(next);
});
// 降频：仅当前 tab 高频刷新 plans；其余与 orders/status 错峰，隐藏页暂停
let paperPollTick = 0;
setInterval(() => {
  if (document.visibilityState === 'hidden') return;
  paperPollTick += 1;
  // 每 10s：active plan plans（独立引擎由各自脚本轮询）
  if (!INDEPENDENT_PLANS.has(state.activePlan)) refreshActivePlan().catch(() => {});
  // 每 20s：orders
  if (paperPollTick % 2 === 0 && !INDEPENDENT_PLANS.has(state.activePlan)) {
    refreshOrders().catch(() => {});
  }
  // 每 30s：status
  if (paperPollTick % 3 === 0) {
    refreshStatus().catch(() => {});
  }
}, 10000);

async function refreshActivePlan() {
  if (document.visibilityState === 'hidden') return;
  if (EVENT_PAPER_PLANS.has(state.activePlan || 'plan14')) return;
  if (paperPlanRefreshBusy) {
    paperPlanRefreshPending = true;
    return;
  }
  paperPlanRefreshBusy = true;
  paperPlanRefreshPending = false;
  const planId = state.activePlan || 'plan1';
  if (!PAPER_PLAN_IDS.includes(planId) || INDEPENDENT_PLANS.has(planId)) {
    paperPlanRefreshBusy = false;
    return;
  }
  const symbol = state.activeSymbol[planId] || 'BTC-USD';
  try {
    const view = await getJson(`/api/polymarket/paper-plans?symbol=${symbol}&plan=${planId}`);
    state.plansView[planId] = view;
    const auto = state.latestStatus?.plans?.[planId]?.auto ?? view.auto;
    if (MULTI_SYMBOL_PLANS.has(planId) && auto?.symbols?.length) {
      state.enabledSymbols[planId] = [...auto.symbols];
      if (!state.enabledSymbols[planId].length) {
        state.enabledSymbols[planId] = ['BTC-USD'];
      }
    }
    syncPaperSymbolButtons(planId);
    renderPlanPanel(planId);
    renderColumnSummary(planId, {
      portfolio: view.portfolio,
      stats: view.stats,
      currentVersionStats: view.currentVersionStats,
      currentSizing: view.currentSizing
    });
    renderAutoStatus(
      planId,
      auto,
      view.portfolio ?? state.latestStatus?.plans?.[planId]?.portfolio,
      view
    );
  } catch {
    // 保留旧视图
  } finally {
    paperPlanRefreshBusy = false;
    if (paperPlanRefreshPending || state.activePlan !== planId) {
      paperPlanRefreshPending = false;
      queueMicrotask(() => refreshActivePlan().catch(() => {}));
    }
  }
}

async function refreshAll() {
  await Promise.all([refreshStatus(), refreshActivePlan(), refreshOrders()]);
}

async function refreshStatus() {
  if (paperStatusRefreshBusy || document.visibilityState === 'hidden') return;
  paperStatusRefreshBusy = true;
  try {
  state.latestStatus = await getJson('/api/polymarket/status', { timeoutMs: 15000 });
  if (pmStatus) {
    pmStatus.textContent = state.latestStatus.liveTradingEnabled
      ? 'Polymarket 实盘开关已打开'
      : 'Polymarket 模拟盘';
  }
  renderComparison(state.latestStatus);
  for (const planId of PAPER_PLAN_IDS) {
    renderColumnSummary(planId, state.latestStatus.plans?.[planId]);
    renderAutoStatus(
      planId,
      state.latestStatus.plans?.[planId]?.auto,
      state.latestStatus.plans?.[planId]?.portfolio,
      state.plansView[planId]
    );
  }
  } finally {
    paperStatusRefreshBusy = false;
  }
}

async function refreshAllPlans() {
  const views = await Promise.all(
    PAPER_PLAN_IDS.map((planId) => {
      const symbol = state.activeSymbol[planId] || 'BTC-USD';
      return getJson(`/api/polymarket/paper-plans?symbol=${symbol}&plan=${planId}`);
    })
  );
  PAPER_PLAN_IDS.forEach((planId, index) => {
    state.plansView[planId] = views[index];
    const auto = state.latestStatus?.plans?.[planId]?.auto ?? views[index].auto;
    if (MULTI_SYMBOL_PLANS.has(planId) && auto?.symbols?.length) {
      state.enabledSymbols[planId] = [...auto.symbols];
      if (!state.enabledSymbols[planId].length) {
        state.enabledSymbols[planId] = ['BTC-USD'];
      }
    }
    syncPaperSymbolButtons(planId);
    renderPlanPanel(planId);
    renderColumnSummary(planId, {
      portfolio: views[index].portfolio,
      stats: views[index].stats,
      currentVersionStats: views[index].currentVersionStats,
      currentSizing: views[index].currentSizing
    });
    renderAutoStatus(
      planId,
      auto,
      views[index].portfolio ?? state.latestStatus?.plans?.[planId]?.portfolio,
      views[index]
    );
  });
}

async function refreshOrders() {
  if (document.visibilityState === 'hidden') return;
  if (paperOrdersRefreshBusy) {
    paperOrdersRefreshPending = true;
    return;
  }
  paperOrdersRefreshBusy = true;
  paperOrdersRefreshPending = false;
  const planId = state.activePlan || 'plan1';
  if (INDEPENDENT_PLANS.has(planId) || !PAPER_PLAN_IDS.includes(planId)) {
    paperOrdersRefreshBusy = false;
    return;
  }
  try {
    const result = await getJson(`/api/polymarket/paper-orders?plan=${planId}&limit=40`, { timeoutMs: 15000 });
    state.orders[planId] = result.orders || [];
    if (planId === 'plan3') {
      state.plan3Opportunities = result.plan3Opportunities || [];
      state.plan3Analytics = result.plan3Analytics || null;
      renderPlan3Observations(planId);
    }
    if (planId === 'plan3_6') {
      state.plan36Analytics = result.plan36Analytics || null;
      renderPlan36Observations();
    }
    renderOrders(planId, state.orders[planId]);
    renderColumnSummary(planId, {
      portfolio: result.portfolio,
      stats: result.stats,
      currentVersionStats: result.currentVersionStats,
      currentSizing: state.latestStatus?.plans?.[planId]?.currentSizing
    });
  } finally {
    paperOrdersRefreshBusy = false;
    if (paperOrdersRefreshPending || state.activePlan !== planId) {
      paperOrdersRefreshPending = false;
      queueMicrotask(() => refreshOrders().catch(() => {}));
    }
  }
}

async function refreshAllOrders() {
  const results = await Promise.all(
    PAPER_PLAN_IDS.map((planId) => getJson(`/api/polymarket/paper-orders?plan=${planId}&limit=40`))
  );
  PAPER_PLAN_IDS.forEach((planId, index) => {
    state.orders[planId] = results[index].orders || [];
    if (planId === 'plan3') {
      state.plan3Opportunities = results[index].plan3Opportunities || [];
      state.plan3Analytics = results[index].plan3Analytics || null;
      renderPlan3Observations(planId);
    }
    if (planId === 'plan3_6') {
      state.plan36Analytics = results[index].plan36Analytics || null;
      renderPlan36Observations();
    }
    renderOrders(planId, state.orders[planId]);
    renderColumnSummary(planId, {
      portfolio: results[index].portfolio,
      stats: results[index].stats,
      currentVersionStats: results[index].currentVersionStats,
      currentSizing: state.latestStatus?.plans?.[planId]?.currentSizing
    });
  });
}

async function refreshPlanAfterReset(planId) {
  state.orders[planId] = [];
  renderOrders(planId, []);
  try {
    await refreshStatus();
  } catch {
    // status 刷新失败不阻断重置成功提示
  }
  try {
    const orders = await getJson(`/api/polymarket/paper-orders?plan=${planId}&limit=40`);
    state.orders[planId] = orders.orders || [];
    renderOrders(planId, state.orders[planId]);
    renderColumnSummary(planId, {
      portfolio: orders.portfolio,
      stats: orders.stats,
      currentVersionStats: orders.currentVersionStats,
      currentSizing: state.latestStatus?.plans?.[planId]?.currentSizing
    });
    if (planId === 'plan3') {
      state.plan3Opportunities = orders.plan3Opportunities || [];
      state.plan3Analytics = orders.plan3Analytics || null;
      renderPlan3Observations(planId);
    }
    if (planId === 'plan3_6') {
      state.plan36Analytics = orders.plan36Analytics || null;
      renderPlan36Observations();
    }
  } catch {
    // ignore
  }
}

function renderComparison(status = {}) {
  const plan14 = status.plans?.plan14 || {};
  renderPlanSummary(pmPlan14Equity, pmPlan14Return, plan14);
  renderPlanSummary(pmPlan15Equity, pmPlan15Return, status.plans?.plan15 || {});
  renderPlanSummary(pmPlan16Equity, pmPlan16Return, status.plans?.plan16 || {});
  renderPlanSummary(pmPlan17Equity, pmPlan17Return, status.plans?.plan17 || {});
  renderPlanSummary(pmPlan18Equity, pmPlan18Return, status.plans?.plan18 || {});
  renderPlanSummary(pmPlan19Equity, pmPlan19Return, status.plans?.plan19 || {});
  renderPlanSummary(pmPlan21Equity, pmPlan21Return, status.plans?.plan21 || {});
  if (pmPlan14Auto) pmPlan14Auto.textContent = plan14.auto?.enabled ? '运行中' : '已停止';
  const versionEl = document.querySelector('#pmPlan14VersionPnl');
  if (versionEl) {
    const stats = plan14.currentVersionStats;
    versionEl.textContent = stats ? `$${formatNumber(stats.realizedPnl)}（${stats.settledOrders} 笔）` : '--';
  }
  const controlEl = document.querySelector('#pmPlan14ExitControl');
  if (controlEl) {
    const c = plan14.exitControlComparison;
    controlEl.textContent = c?.matched
      ? `近期同单退出对照 ${c.matched} 笔：新规则 $${formatNumber(c.actualPnl)} / 原 v8 $${formatNumber(c.controlPnl)} / 差额 $${formatNumber(c.delta)}（相同入场与金额，非独立账户）`
      : `旧版退出同单对照：等待结算（${c?.tracked || 0} 笔已记录）`;
  }
  const profitEl = document.querySelector('#pmPlan14ProfitExperiment');
  if (profitEl) {
    const e = plan14.profitExperiment, b = e?.lanes?.baseline, c = e?.lanes?.candidate;
    profitEl.textContent = b && c
      ? `独立入场实验（各 $${e.startingCash} / 每笔 $${e.fixedOrderUsd}，均持有到官方结算）：v9 $${formatNumber(b.realizedPnl)}（已结 ${b.settled} / 待结 ${b.pending}） · v10 候选 $${formatNumber(c.realizedPnl)}（已结 ${c.settled} / 待结 ${c.pending}） · 净利润差 $${formatNumber(e.delta)} · 入场多付 1¢ 时差额 $${formatNumber(e.stressDelta)}。独立本金，不计入主仓；未验证，不自动替换。`
      : '盈利优化实验：v9 入场 / v10 双边估值候选，各自 $500 本金、每笔 $10，均持有到官方结算；等待首次新报价，不混入主仓收益。';
  }
}

function renderPlanSummary(equityEl, returnEl, planStatus = {}) {
  const portfolio = planStatus.portfolio || {};
  const stats = planStatus.stats || {};
  const initialized = portfolio.portfolioInitialized;
  const equity = Number(stats.equity ?? portfolio.equity) || 0;
  const totalReturn = Number(stats.totalReturn ?? portfolio.totalReturn);
  if (equityEl) equityEl.textContent = initialized ? `$${formatNumber(equity)}` : '未设置';
  if (returnEl) {
    returnEl.textContent = initialized && Number.isFinite(totalReturn)
      ? `${totalReturn >= 0 ? '+' : ''}${(totalReturn * 100).toFixed(2)}%`
      : '--';
    returnEl.className = totalReturn >= 0 ? 'pos' : totalReturn < 0 ? 'neg' : '';
  }
}

function getColumn(planId) {
  return document.querySelector(`.pm-dual-column[data-plan="${planId}"]`);
}

function renderColumnSummary(planId, planStatus = {}) {
  const column = getColumn(planId);
  if (!column) return;
  const portfolio = planStatus.portfolio || {};
  const stats = planStatus.stats || {};
  const sizing = planStatus.currentSizing || state.latestStatus?.plans?.[planId]?.currentSizing || {};
  const initialized = portfolio.portfolioInitialized;
  const startingCash = Number(stats.startingCash ?? portfolio.startingCash) || 0;
  const equity = Number(stats.equity ?? portfolio.equity) || 0;
  const totalReturn = Number(stats.totalReturn ?? portfolio.totalReturn);
  const winRate = Number(stats.winRate);

  setField(column, 'starting', initialized ? `$${formatNumber(startingCash)}` : '未设置');
  setField(column, 'equity', initialized ? `$${formatNumber(equity)}` : '--', equity > startingCash ? 'pos' : equity < startingCash ? 'neg' : '');
  setField(column, 'return', initialized && Number.isFinite(totalReturn)
    ? `${totalReturn >= 0 ? '+' : ''}${(totalReturn * 100).toFixed(2)}%`
    : '--', totalReturn >= 0 ? 'pos' : totalReturn < 0 ? 'neg' : '');
  setField(column, 'winRate', stats.settledOrders
    ? `${(winRate * 100).toFixed(1)}% (${stats.wins}/${stats.settledOrders})`
    : initialized ? '暂无结算' : '--');

  const currentVersionStats = planStatus.currentVersionStats;
  if (planId === 'plan5' && currentVersionStats) {
    const lifetimeLabel = stats.settledOrders
      ? `${(winRate * 100).toFixed(1)}% (${stats.wins}/${stats.settledOrders})`
      : '暂无';
    const verMatch = String(currentVersionStats.strategyVersion || '').match(/_v(\d+)\b/i);
    const verLabel = verMatch ? `v${verMatch[1]}` : 'v15';
    const currentLabel = currentVersionStats.settledOrders
      ? `${verLabel} ${(Number(currentVersionStats.winRate) * 100).toFixed(1)}% (${currentVersionStats.wins}/${currentVersionStats.settledOrders})`
      : `${verLabel} 待样本`;
    setField(column, 'winRate', `${currentLabel} · 总 ${lifetimeLabel}`);
  }

  const symbolWrEl = column.querySelector('[data-field="symbolWinRates"]');
  if (symbolWrEl) {
    const bySymbol = stats.bySymbol || {};
    const parts = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD']
      .map((sym) => {
        const row = bySymbol[sym];
        if (!row || !row.total) return null;
        const short = sym.replace('-USD', '');
        return `${short} ${(Number(row.winRate) * 100).toFixed(0)}%(${row.wins}/${row.total})`;
      })
      .filter(Boolean);
    symbolWrEl.textContent = parts.length ? parts.join(' · ') : (initialized ? '分币：暂无' : '--');
  }

  const cashInput = column.querySelector('.pm-portfolio-form input[name="cash"]');
  if (cashInput && initialized && !cashInput.matches(':focus')) {
    cashInput.value = startingCash;
  } else if (cashInput && !initialized && state.latestStatus?.defaultStartingCash) {
    cashInput.value = state.latestStatus.defaultStartingCash;
  }
}

function setField(column, field, text, className = '') {
  const el = column.querySelector(`[data-field="${field}"]`);
  if (!el) return;
  el.textContent = text;
  el.className = className;
}

function planSkipHint(planId, plansView = null) {
  const view = plansView || state.plansView[planId];
  if (!view?.plans) return '';
  for (const timeframe of (planId === 'plan3_6' ? ['5m', '15m', '1h', '1d'] : ['5m', '15m'])) {
    const action = view.plans[timeframe]?.plan?.action;
    if (action?.shouldTrade) {
      return `${timeframe} 满足条件，等待下单`;
    }
  }
  const tf = state.activeTimeframe[planId];
  const action = view.plans[tf]?.plan?.action;
  const reason = action?.reason || action?.skipReason || '';
  if (!reason) return '';
  // 多币种：当前币种在观望时写明，避免误以为“整盘没记录”
  if (MULTI_SYMBOL_PLANS.has(planId)) {
    const sym = (state.activeSymbol[planId] || 'BTC-USD').replace(/-USD$/, '');
    return `${sym} ${tf || ''}：${reason}`.replace(/\s+/g, ' ').trim();
  }
  if (planId === 'plan3' || planId === 'plan3_6') {
    return reason;
  }
  return reason;
}

function autoCheckLabel(planId = 'plan1') {
  if (planId === 'plan3') {
    const ms = Number(state.latestStatus?.plan3Rules?.fastLoopMs ?? state.latestStatus?.plans?.plan3?.auto?.intervalMs) || 1000;
    const sec = ms >= 1000 ? ms / 1000 : ms;
    return `尾盘每 ${sec} 秒检查`;
  }
  if (planId === 'plan3_6') {
    const ms = Number(state.latestStatus?.plan3_6Rules?.fastLoopMs) || 2000;
    const sec = ms >= 1000 ? ms / 1000 : ms;
    return `低价侧每 ${sec} 秒检查`;
  }
  if (planId === 'plan15') return '约每分钟扫事件盘';
  if (planId === 'plan16') return '约每分钟对照天气预报';
  if (planId === 'plan17') return '约每 2 分钟对照期权波动率';
  if (planId === 'plan18' || planId === 'plan19') return '每根 5m/15m/1h K 线开盘时起卦';
  if (planId === 'plan21') return '约每 15 秒看 BTC/ETH 5 分钟落后方';
  if (planId === 'plan5') {
    const ms = Number(state.latestStatus?.autoLoopIntervalMs) || 10000;
    const sec = ms >= 1000 ? ms / 1000 : ms;
    return `锁定强度每 ${sec} 秒检查`;
  }
  const ms = Number(state.latestStatus?.autoLoopIntervalMs) || 10000;
  const sec = ms >= 1000 ? ms / 1000 : ms;
  return `每 ${sec} 秒检查`;
}

function renderAutoStatus(planId, auto = {}, portfolio = {}, plansView = null) {
  const column = getColumn(planId);
  if (!column) return;
  const statusEl = column.querySelector('[data-role="auto-status"]');
  const textEl = column.querySelector('[data-role="auto-text"]');
  const detailEl = column.querySelector('[data-role="auto-detail"]');
  const startBtn = column.querySelector('[data-action="auto-start"]');
  const stopBtn = column.querySelector('[data-action="auto-stop"]');
  const initialized = Boolean(portfolio?.portfolioInitialized);
  const running = Boolean(auto?.enabled);
  const label = planId === 'plan5' ? 'Plan5'
    : planId === 'plan3_6' ? 'Plan3.6'
      : planId === 'plan3' ? 'Plan3'
        : planId === 'plan2_6' ? 'Plan2.6'
          : planId === 'plan11' ? 'Plan11'
          : planId === 'plan12' ? 'Plan12'
          : planId === 'plan13' ? 'Plan13'
          : planId === 'plan14' ? 'Plan14'
          : planId === 'plan15' ? 'Plan15'
          : planId === 'plan16' ? 'Plan16'
          : planId === 'plan17' ? 'Plan17'
          : planId === 'plan18' ? 'Plan18'
          : planId === 'plan19' ? 'Plan19'
          : planId === 'plan21' ? 'Plan21'
          : planId === 'plan2_5' ? 'Plan2.5'
            : planId === 'plan2' ? 'Plan2'
              : 'Plan1';
  const skipHint = planSkipHint(planId, plansView);
  statusEl?.classList.toggle('running', running && initialized);
  statusEl?.classList.toggle('stopped', !running || !initialized);
  statusEl?.classList.toggle('blocked', !initialized);
  statusEl?.classList.toggle('waiting', running && initialized && skipHint && !skipHint.includes('满足条件'));
  if (textEl) {
    if (!initialized) textEl.textContent = '未就绪';
    else if (running && skipHint && !skipHint.includes('满足条件')) textEl.textContent = '运行中 · 等待条件';
    else textEl.textContent = running ? '已启动' : '未启动';
  }
  if (detailEl) {
    if (!initialized) {
      detailEl.textContent = '请先点击「保存本金」，再启动自动模拟';
    } else if (planId === 'plan15' && running) {
      detailEl.textContent = auto.lastReason
        ? `Plan15 约每分钟扫描 · ${auto.lastReason}`
        : 'Plan15 约每分钟扫描体育、电竞、天气、政治、宏观和加密事件';
    } else if (planId === 'plan16' && running) {
      detailEl.textContent = auto.lastReason
        ? `Plan16 约每分钟对照预报 · ${auto.lastReason}`
        : 'Plan16 约每分钟用集合预报对照机场温度盘';
    } else if (planId === 'plan17' && running) {
      detailEl.textContent = auto.lastReason
        ? `Plan17 约每 2 分钟对照期权波动率 · ${auto.lastReason}`
        : 'Plan17 约每 2 分钟用 Deribit 隐含波动率给 BTC/ETH 价格档位定价';
    } else if ((planId === 'plan18' || planId === 'plan19') && running) {
      const method = planId === 'plan19' ? '小六壬' : '梅花易数';
      detailEl.textContent = auto.lastReason
        ? `${label} 开盘起卦 · ${auto.lastReason}`
        : `${label} 每根 5m/15m/1h K 线开盘时按${method}起卦，吉买涨、凶买跌`;
    } else if (planId === 'plan21' && running) {
      detailEl.textContent = auto.lastReason
        ? `Plan21 约每 15 秒 · ${auto.lastReason}`
        : 'Plan21 约每 15 秒看 BTC/ETH 5 分钟落后方，只在三个正收益窗口按卖一买入';
    } else if (running) {
      const tfLabel = (auto.timeframes || ['5m', '15m']).join(' + ');
      const symbolLabel = MULTI_SYMBOL_PLANS.has(planId)
        ? ` · ${(auto.symbols?.length ? auto.symbols : selectedPaperSymbols(planId)).map((s) => s.replace('-USD', '')).join('/')}`
        : planId === 'plan3' ? ' · BTC' : '';
      detailEl.textContent = skipHint
        ? `${label} ${autoCheckLabel(planId)} · ${skipHint}`
        : `${label} 运行中 · ${tfLabel}${symbolLabel} · ${autoCheckLabel(planId)}`;
    } else {
      detailEl.textContent = planId === 'plan15'
        ? '点击启动后，约每分钟扫描 2 天内结算的事件'
        : planId === 'plan16'
        ? '已停新仓：回测显示盘口比天气预报准，旧单照常结算'
        : planId === 'plan17'
        ? '点击启动后，约每 2 分钟用期权隐含波动率对照 BTC/ETH 价格档位'
        : planId === 'plan18'
        ? '点击启动后，每根 5m/15m/1h K 线开盘时按梅花易数起卦下单'
        : planId === 'plan19'
        ? '点击启动后，每根 5m/15m/1h K 线开盘时按小六壬起卦下单'
        : planId === 'plan21'
        ? '点击启动后，约每 15 秒在三个窗口买 BTC/ETH 5 分钟落后方'
        : planId === 'plan14'
        ? '点击启动四币 5m 自动模拟（15m 已暂停新开仓）'
        : planId === 'plan5'
          ? '点击启动 5m + 15m PM 锁定强度模拟（可多选币种）'
          : planId === 'plan3_6'
            ? '点击启动 5m + 15m + 1h + 1d：模型确认热门侧固定 $5（可多选 BTC/ETH/SOL/XRP）'
            : planId === 'plan3'
              ? '点击启动 5m + 15m 尾盘扫盘（仅 BTC）'
              : '点击启动 5m + 15m 自动模拟（可多选 BTC/ETH/SOL/XRP）';
    }
  }
  if (MULTI_SYMBOL_PLANS.has(planId) && auto?.symbols?.length) {
    state.enabledSymbols[planId] = [...auto.symbols];
    if (!state.enabledSymbols[planId].length) {
      state.enabledSymbols[planId] = ['BTC-USD'];
    }
    syncPaperSymbolButtons(planId);
  }
  if (startBtn) {
    startBtn.disabled = running || !initialized;
    startBtn.classList.toggle('is-active', running && initialized);
  }
  if (stopBtn) stopBtn.disabled = !running;
}

function setTimeframe(planId, timeframe) {
  const allowed = planId === 'plan3_6'
    ? new Set(['5m', '15m', '1h', '1d'])
    : new Set(['5m', '15m']);
  state.activeTimeframe[planId] = allowed.has(timeframe) ? timeframe : '5m';
  const column = getColumn(planId);
  column?.querySelectorAll('.pm-timeframe-tabs .pm-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.timeframe === state.activeTimeframe[planId]);
  });
  renderPlanPanel(planId);
}

function renderPlanPanel(planId) {
  const column = getColumn(planId);
  const container = column?.querySelector('[data-role="recommendation"]');
  if (!container) return;
  const timeframe = state.activeTimeframe[planId];
  const data = state.plansView[planId]?.plans?.[timeframe];
  if (!data) {
    container.innerHTML = planId === 'plan5'
        ? '<div class="accuracy-empty">等待 5m/15m PM 锁定。</div>'
        : '<div class="accuracy-empty">等待首次计划。</div>';
    return;
  }
  const view = state.plansView[planId] || {};
  container.innerHTML = planId === 'plan5'
      ? renderPlan5Html(data, timeframe, view.plan5Rules)
      : planId === 'plan3_6'
        ? renderSimpleSettlementPlanHtml(data, timeframe, view.plan3_6Rules, 'Plan3.6')
        : planId === 'plan3'
          ? renderPlan3Html(data, timeframe, view.plan3Rules)
          : planId === 'plan12'
            ? renderSimpleSettlementPlanHtml(data, timeframe, view.plan12Rules, 'Plan12')
          : planId === 'plan14'
            ? renderSimpleSettlementPlanHtml(data, timeframe, view.plan14Rules, 'Plan14')
          : renderPlanHtml(
            data,
            timeframe,
            planId,
            planId === 'plan13' ? { ...view.plan2Rules, ...view.plan13Rules } : view.plan2Rules,
            view.plan1Rules,
            view.plan11Rules
          );
}

function renderSimpleSettlementPlanHtml(data, timeframe, rules = {}, title = 'Plan') {
  const plan = data.plan || {};
  const action = plan.action || {};
  const poly = data.polymarket || {};
  const directionTone = action.direction === 'down' ? 'down' : action.shouldTrade ? 'up' : 'pending';
  const directionText = action.shouldTrade
    ? (action.label || (action.direction === 'up' ? `${title} UP` : `${title} DOWN`))
    : '观望';
  const up = Number(poly.upPrice ?? action.pmUpPrice);
  const down = Number(poly.downPrice ?? action.pmDownPrice);
  const sizeLine = `固定 $${Number(rules.orderUsd ?? action.fixedOrderUsd ?? action.usd ?? 5).toFixed(2)}`;
  return `
    <div class="risk-sim-recommend ${directionTone}">
      <div class="risk-sim-recommend-main">
        <strong>${directionText}</strong>
        <span>${action.reason || action.skipReason || `${title} 等待条件`}</span>
      </div>
      <div class="risk-sim-meta">
        <span>${timeframe}</span>
        <span>剩余 ${action.secondsRemaining ?? plan.secondsRemaining ?? '--'}s</span>
        <span>UP ${Number.isFinite(up) ? `${(up * 100).toFixed(1)}¢` : '--'}</span>
        <span>DOWN ${Number.isFinite(down) ? `${(down * 100).toFixed(1)}¢` : '--'}</span>
        <span>${sizeLine}</span>
        ${action.shouldTrade ? `<span>$${Number(action.usd || 0).toFixed(2)}</span>` : ''}
        <span>持有至结算</span>
      </div>
    </div>
  `;
}

function renderPlan5Html(data, timeframe, plan5Rules = {}) {
  const plan = data.plan || {};
  const action = plan.action || {};
  const poly = data.polymarket || {};
  const lock = plan.intervalPmLock || {};
  const directionTone = action.direction === 'down' ? 'down' : action.shouldTrade ? 'up' : 'pending';
  const directionText = action.shouldTrade
    ? (action.label || (action.direction === 'up' ? '锁定 UP' : '锁定 DOWN'))
    : '等待锁定';
  const weak = Number(plan5Rules?.weakCashPct ?? 0.10);
  const normal = Number(plan5Rules?.normalCashPct ?? 0.20);
  const strong = Number(plan5Rules?.strongCashPct ?? 0.30);
  const minUsd = Number(plan5Rules?.minOrderUsd ?? 1);
  const strength = action.lockStrength || lock.strength || '--';
  const cashPct = Number(action.cashPct);

  return `
    <div class="risk-sim-recommend ${directionTone}">
      <span>${escapeHtml(plan.symbol || poly.symbol || 'BTC-USD')} · ${escapeHtml(timeframe)} · pm_lock_strength</span>
      <strong>${escapeHtml(directionText)}</strong>
      <em>${pct(action.limitPrice)} / $${formatNumber(action.usd)}</em>
    </div>
    <div class="pm-plan-layout pm-plan-layout-4">
      <div class="pm-strategy-card">
        <strong>锁定强度</strong><span>${escapeHtml(String(strength))}</span>
      </div>
      <div class="pm-strategy-card ${action.direction === 'down' ? 'down' : 'up'}">
        <strong>仓位比例</strong><span>${Number.isFinite(cashPct) ? `${(cashPct * 100).toFixed(0)}%` : '--'}</span>
      </div>
      <div class="pm-strategy-card">
        <strong>弱/普/强</strong><span>${(weak * 100).toFixed(0)}/${(normal * 100).toFixed(0)}/${(strong * 100).toFixed(0)}%</span>
      </div>
      <div class="pm-strategy-card">
        <strong>最小单</strong><span>$${formatNumber(minUsd)}</span>
      </div>
    </div>
    <div class="pm-market-grid pm-market-grid-compact">
      <span>原因</span><b>${escapeHtml(action.reason || '--')}</b>
      <span>市场</span><b>${escapeHtml(poly.market || '--')}</b>
      <span>PM UP/DN</span><b>${pct(poly.upProbability ?? poly.upPrice)} / ${pct(poly.downProbability ?? poly.downPrice)}</b>
      <span>锁定 gap</span><b>${Number.isFinite(Number(lock.pmGap ?? action.lockPmGap)) ? Number(lock.pmGap ?? action.lockPmGap).toFixed(3) : '--'}</b>
      <span>限价</span><b>${pct(action.limitPrice)}</b>
      <span>金额</span><b>$${formatNumber(action.usd)}</b>
      <span>退出</span><b>持有至结算 redeem</b>
      <span>说明</span><b>下轮预测仅统计，不覆盖本窗独立锁定</b>
    </div>`;
}


function renderPlan3Html(data, timeframe, plan3Rules = {}) {
  const plan = data.plan || {};
  const action = plan.action || {};
  const poly = data.polymarket || {};
  const directionTone = action.direction === 'down' ? 'down' : action.shouldTrade ? 'up' : 'pending';
  const directionText = action.shouldTrade
    ? action.direction === 'up' ? '扫盘 UP' : '扫盘 DOWN'
    : '跳过';
  const secondsRemaining = Number.isFinite(Number(action.secondsRemaining))
    ? `${action.secondsRemaining}s`
    : (Number.isFinite(Number(plan.secondsRemaining)) ? `${plan.secondsRemaining}s` : '--');
  const windowLabel = plan3Rules?.secondsWindow5m && timeframe === '5m'
    ? `${plan3Rules.secondsWindow5m}${plan3Rules.paperRelaxedEnabled ? ' · 模拟放宽' : ''}`
    : `${plan3Rules?.secondsWindow15m || '尾盘窗口'}${plan3Rules?.paperRelaxedEnabled ? ' · 模拟放宽' : ''}`;

  return `
    <div class="risk-sim-recommend ${directionTone}">
      <span>${escapeHtml(timeframe)} · settlement_capture · ${escapeHtml(windowLabel)}</span>
      <strong>${escapeHtml(directionText)}</strong>
      <em>${pct(action.limitPrice ?? action.tokenPrice)} / $${formatNumber(action.usd)}</em>
    </div>
    <div class="pm-plan-layout pm-plan-layout-4">
      <div class="pm-strategy-card ${action.direction === 'down' ? 'down' : 'up'}">
        <strong>类型</strong><span>结算扫盘</span>
      </div>
      <div class="pm-strategy-card">
        <strong>剩余</strong><span>${escapeHtml(secondsRemaining)}</span>
      </div>
      <div class="pm-strategy-card">
        <strong>距开盘</strong><span>${formatBps(action.distanceFromOpenBps ?? plan.distanceFromOpenBps)}</span>
      </div>
      <div class="pm-strategy-card down">
        <strong>反向波动</strong><span>${formatBps(action.recentReverseBps ?? plan.recentReverseBps)}</span>
      </div>
    </div>
    <div class="pm-market-grid pm-market-grid-compact">
      <span>原因</span><b>${escapeHtml(action.reason || action.skipReason || '--')}</b>
      <span>PM UP/DN</span><b>${pct(poly.upProbability ?? poly.upPrice)} / ${pct(poly.downProbability ?? poly.downPrice)}</b>
      <span>限价</span><b>${pct(action.limitPrice)}</b>
      <span>Token</span><b>${pct(action.tokenPrice ?? plan.tokenPrice)}</b>
      <span>价差</span><b>${pct(action.spread ?? plan.spread)}</b>
      <span>金额</span><b>$${formatNumber(action.usd)}</b>
      <span>退出</span><b>持有至结算 redeem</b>
    </div>`;
}

function formatBps(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.abs(n).toFixed(1)} bps` : '--';
}

function renderPlanHtml(data, timeframe, planId, plan2Rules, plan1Rules, plan11Rules) {
  const plan = data.plan || {};
  const action = plan.action || {};
  const poly = data.polymarket || {};
  const signal = data.signal || {};
  const isPlan2 = planId === 'plan2' || planId === 'plan2_5' || planId === 'plan2_6' || planId === 'plan13';
  const isPlan11 = planId === 'plan11';
  const directionTone = action.direction === 'down' ? 'down' : action.shouldTrade ? 'up' : 'pending';
  const directionText = action.shouldTrade
    ? action.direction === 'up' ? '买 UP / 看涨' : '买 DOWN / 看跌'
    : '跳过';

  const strategyCards = isPlan2
    ? renderPlan2Cards(plan, plan2Rules)
    : isPlan11
      ? `<div class="pm-plan-layout">
        ${renderStrategyCard('PM 热门', { direction: action.direction, confidence: action.pHat })}
        ${renderStrategyCard('现货确认', { direction: action.spotDirection, confidence: action.pHat })}
        ${renderStrategyCard('技术', { direction: action.techDirection || signal?.technicalDirection, confidence: action.pHat })}
      </div>`
    : `<div class="pm-plan-layout">
        ${renderStrategyCard('技术', plan.strategies?.tech)}
        ${renderStrategyCard('PM', plan.strategies?.polymarket)}
        ${renderStrategyCard('综合', plan.strategies?.composite)}
      </div>`;

  const exitRule = plan.exitRule
    ? `<span>退出</span><b>${isPlan11
      ? (plan11Rules?.stopLossEnabled
        ? `硬 SL ${offsetLabel(plan.exitRule.stopLossOffset ?? plan11Rules?.stopLossOffset ?? 0.10, '-')} · 无止盈`
        : '持有至官方结算 · 无止盈 / 无硬止损')
      : isPlan2
      ? renderDynamicExitSummary(plan.exitRule, plan2Rules, action, { slOffset: 0.12 })
      : renderDynamicExitSummary(plan.exitRule, plan1Rules, action, { slOffset: 0.15 })}</b>`
    : '';

  return `
    <div class="risk-sim-recommend ${directionTone}">
      <span>${escapeHtml(timeframe)} · ${escapeHtml(plan.window?.label || '本窗口')}</span>
      <strong>${escapeHtml(directionText)}</strong>
      <em>${pct(action.confidence)} / $${formatNumber(action.usd)}</em>
    </div>
    ${strategyCards}
    <div class="pm-market-grid pm-market-grid-compact">
      <span>原因</span><b>${escapeHtml(action.reason || '--')}</b>
      <span>PM UP/DN</span><b>${pct(poly.upProbability ?? poly.upPrice)} / ${pct(poly.downProbability ?? poly.downPrice)}</b>
      <span>限价</span><b>${pct(action.limitPrice)}</b>
      <span>分层</span><b>${escapeHtml(formatEntryTier(action))}</b>
      <span>金额</span><b>$${formatNumber(action.usd)}</b>
      ${exitRule}
    </div>`;
}

function offsetLabel(offset, sign = '+') {
  const n = Number(offset);
  if (!Number.isFinite(n)) return '--';
  const pp = (n * 100).toFixed(0);
  return sign === '+' ? `+${pp}%` : `-${pp}%`;
}

function renderDynamicExitSummary(exitRule, globalRules, action, defaults = {}) {
  const tpOffset = Number(
    exitRule?.takeProfitOffset ?? globalRules?.takeProfitOffset ?? defaults.tpOffset ?? 0.18
  );
  const slOffset = Number(
    exitRule?.stopLossOffset ?? globalRules?.stopLossOffset ?? defaults.slOffset ?? 0.12
  );
  const trailingOn = (exitRule?.trailingTakeProfitEnabled ?? globalRules?.trailingTakeProfitEnabled) === true;
  const tpEnabled = (exitRule?.takeProfitEnabled ?? globalRules?.takeProfitEnabled) !== false;
  const trailOffset = Number(
    exitRule?.trailingTakeProfitOffset ?? globalRules?.trailingTakeProfitOffset ?? 0.10
  );
  const entry = Number(action?.limitPrice);
  const tp = Number(action?.takeProfitPrice ?? exitRule?.takeProfitPrice);
  const sl = Number(action?.stopLossPrice ?? exitRule?.stopLossPrice);
  const tpPart = trailingOn
    ? `回撤止盈 最高点 ${offsetLabel(trailOffset).replace('+', '-')}`
    : (tpEnabled ? `TP 入场价 ${offsetLabel(tpOffset)}` : '不止盈');
  const base = `${tpPart} · SL 入场价 ${offsetLabel(slOffset, '-')}`;
  if (!Number.isFinite(entry)) return base;
  const tpPrice = Number.isFinite(tp) ? tp : Math.min(0.99, entry + tpOffset);
  const slPrice = Number.isFinite(sl) ? sl : Math.max(0.01, entry - slOffset);
  if (trailingOn) {
    return `${base}（本轮 SL ${pct(slPrice)} @ ${pct(entry)}）`;
  }
  if (!tpEnabled) {
    return `${base}（本轮 SL ${pct(slPrice)} @ ${pct(entry)}）`;
  }
  return `${base}（本轮 TP ${pct(tpPrice)} / SL ${pct(slPrice)} @ ${pct(entry)}）`;
}

function renderPlan2Cards(plan, plan2Rules) {
  const rules = { ...plan.exitRule, ...plan2Rules };
  const entryMin = rules.entryMinPrice ?? 0.35;
  const entryMax = rules.entryMaxPrice ?? 0.58;
  const minConf = rules.minConfidence ?? 0.63;
  const tpOffset = rules.takeProfitOffset ?? 0.18;
  const slOffset = rules.stopLossOffset ?? 0.12;
  const trailOffset = rules.trailingTakeProfitOffset ?? 0.10;
  const trailingOn = rules.trailingTakeProfitEnabled === true;
  const tpEnabled = rules.takeProfitEnabled !== false;
  const entry = plan.directionEntry;
  const action = plan.action || {};
  const tpNow = trailingOn
    ? `最高点回撤 ${offsetLabel(trailOffset).replace('+', '')}`
    : !tpEnabled
      ? '关闭（硬止损 / 到期）'
    : action.takeProfitPrice
      ? `≥ ${pct(action.takeProfitPrice)}（${offsetLabel(tpOffset)}）`
      : `入场价 ${offsetLabel(tpOffset)}`;
  const slNow = action.stopLossPrice
    ? `≤ ${pct(action.stopLossPrice)}（${offsetLabel(slOffset, '-')}）`
    : `入场价 ${offsetLabel(slOffset, '-')}`;
  return `
    <div class="pm-plan-layout pm-plan-layout-4">
      <div class="pm-strategy-card ${entry?.direction === 'down' ? 'down' : 'up'}">
        <strong>方向</strong><span>${entry?.direction === 'up' ? '涨' : entry?.direction === 'down' ? '跌' : '待定'}</span>
      </div>
      <div class="pm-strategy-card">
        <strong>入场</strong><span>${pct(entryMin)}–${pct(entryMax)} · 置信度 ≥ ${pct(minConf)}</span>
      </div>
      <div class="pm-strategy-card up">
        <strong>止盈</strong><span>${tpNow}</span>
      </div>
      <div class="pm-strategy-card down">
        <strong>止损</strong><span>${slNow}</span>
      </div>
    </div>`;
}

function formatOrderExitLabel(order) {
  const entry = Number(order.limitPrice ?? order.entryPrice);
  const exit = Number(order.exitPrice);
  switch (order.exitStatus) {
    case 'model-stop-loss':
      return `${order.exitTrigger === 'net-loss-risk' ? '风险止损' : order.exitTrigger === 'expected-value' ? '价值退出（亏损）' : '模型止损'} @ ${pct(exit)}`;
    case 'model-take-profit':
      return `${order.exitTrigger === 'expected-value' ? '价值退出（盈利）' : '模型止盈'} @ ${pct(exit)}`;
    case 'take-profit':
    case 'trailing-take-profit': {
      if (order.exitStatus === 'trailing-take-profit' && Number.isFinite(Number(order.peakPrice)) && Number.isFinite(exit)) {
        return `回撤止盈 最高 ${pct(order.peakPrice)} → ${pct(exit)}`;
      }
      if (Number.isFinite(entry) && Number.isFinite(exit)) {
        const delta = ((exit - entry) * 100).toFixed(0);
        return `止盈 ${Number(delta) >= 0 ? '+' : ''}${delta}% @ ${pct(exit)}`;
      }
      return `止盈 @ ${pct(exit)}`;
    }
    case 'stop-loss': {
      if (Number.isFinite(entry) && Number.isFinite(exit)) {
        const delta = ((exit - entry) * 100).toFixed(0);
        return `止损 ${delta}% @ ${pct(exit)}`;
      }
      return `止损 @ ${pct(exit)}`;
    }
    case 'time-stop':
      return `时间止损 @ ${pct(exit)}`;
    case 'direction-flip':
      return '方向翻转';
    case 'expiry':
      return '到期';
    default:
      if (order.settlementStatus === 'open') {
        const peak = Number(order.peakPrice);
        const trail = Number(order.trailStopPrice);
        if (Number.isFinite(peak) && Number.isFinite(trail)) {
          return `持仓 最高 ${pct(peak)} / 回撤线 ${pct(trail)}`;
        }
        return '持仓';
      }
      return '--';
  }
}

function renderStrategyCard(title, item) {
  if (!item) return `<div class="pm-strategy-card"><strong>${escapeHtml(title)}</strong><span>--</span></div>`;
  return `
    <div class="pm-strategy-card ${item.direction === 'down' ? 'down' : 'up'}">
      <strong>${escapeHtml(title)}</strong>
      <span>${item.direction === 'up' ? '涨' : '跌'}</span>
      <small>${pct(item.confidence)}</small>
    </div>`;
}

function renderPlan3Observations(planId) {
  const column = getColumn(planId);
  const container = column?.querySelector('[data-role="observations"]');
  if (!container) return;
  const analytics = state.plan3Analytics;
  const rows = state.plan3Opportunities || [];
  const plan3Rules = state.plansView?.plan3?.plan3Rules || state.latestStatus?.plan3Rules || {};
  const skipCounts = analytics?.skipReasonCounts || {};
  const tailEvals = (skipCounts.not_effectively_settled || 0)
    + (skipCounts.price_out_of_range || 0)
    + (skipCounts.spread_too_wide || 0)
    + (analytics?.submittedOrders || 0);
  const bandSummary = analytics?.byPriceBand
    ? Object.entries(analytics.byPriceBand)
      .map(([band, stats]) => `${band}: ${(stats.winRate * 100).toFixed(0)}% (${stats.wins}/${stats.orders})`)
      .join(' · ')
    : null;
  const summary = analytics
    ? `已记录 ${analytics.opportunitiesLogged || 0} 次检查 · 进入尾盘窗口 ${tailEvals} 次 · 提交订单 ${analytics.submittedOrders || 0} 笔${bandSummary ? ` · 分档胜率 ${bandSummary}` : ''}`
    : '等待 Plan3 自动循环记录…';
  if (!rows.length) {
    const paperHint = plan3Rules?.paperWideBandEnabled !== false
      ? `宽档测试 ${plan3Rules?.paperWidePriceBand || '90–99.8¢'}，剩余 ${plan3Rules?.paperWideSecondsWindow5m || '3–120s'}，90–95¢ 允许 8% spread · 首单满足即买`
      : plan3Rules?.paperRelaxedEnabled
        ? `模拟放宽：尾盘内距开盘 ≥${plan3Rules?.paperMinDirectionalBps ?? 0.5} bps`
        : '需 BTC 在窗口最后几秒距开盘 ≥22/30 bps，且 winning token 在 99.0–99.8¢';
    container.innerHTML = `<div class="accuracy-empty">${escapeHtml(summary)}。尚未出现尾盘评估记录（${escapeHtml(paperHint)}）。</div>`;
    return;
  }
  container.innerHTML = `
    <div class="accuracy-empty" style="margin-bottom:8px">${escapeHtml(summary)}</div>
    <table>
      <thead><tr><th>时间</th><th>周期</th><th>剩余</th><th>原因</th><th>距开盘</th><th>Token</th></tr></thead>
      <tbody>${rows.map(renderPlan3ObservationRow).join('')}</tbody>
    </table>`;
}

function renderPlan36Observations() {
  const container = getColumn('plan3_6')?.querySelector('[data-role="observations"]');
  if (!container) return;
  const analytics = state.plan36Analytics;
  if (!analytics) {
    container.innerHTML = '<div class="accuracy-empty">等待 Plan3.6 v6 前向样本。</div>';
    return;
  }
  const labels = {
    primary_5m_favorite_confirmed: '主策略 · 5m 模型确认热门侧',
    shadow_15m_favorite_confirmed: '纸面 · 15m 模型确认热门侧',
    paper_1h_favorite_confirmed: '纸面 · 1h 模型确认热门侧',
    paper_1d_favorite_confirmed: '纸面 · 1d 模型确认热门侧',
    rejected: '观察但未启用'
  };
  const laneRows = Object.entries(analytics.byLane || {}).map(([lane, item]) => {
    const pnl = Number(item.pnl) || 0;
    return `<tr>
      <td>${escapeHtml(labels[lane] || lane)}</td>
      <td>${item.settled || 0}</td>
      <td>${item.open || 0}</td>
      <td>${item.settled ? pct(item.winRate) : '--'}</td>
      <td class="${pnl >= 0 ? 'pos' : 'neg'}">${item.settled ? pct(item.roi) : '--'}</td>
      <td class="${pnl >= 0 ? 'pos' : 'neg'}">${pnl >= 0 ? '+' : ''}$${formatNumber(pnl)}</td>
    </tr>`;
  }).join('');
  const recent = (analytics.recentSettled || []).slice(0, 10);
  const legacy = analytics.legacyPaperOrders || {};
  const recentRows = recent.map((item) => {
    const pnl = Number(item.hypotheticalPnl) || 0;
    return `<tr>
      <td>${formatTime(item.settledAtIso || item.recordedAtIso)}</td>
      <td>${escapeHtml(formatOrderSymbol(item))}</td>
      <td>${escapeHtml(item.timeframe || '--')}</td>
      <td>${escapeHtml(item.direction?.toUpperCase() || '--')} ${pct(item.tokenPrice)}</td>
      <td>${item.won ? '赢' : '输'}</td>
      <td class="${pnl >= 0 ? 'pos' : 'neg'}">${pnl >= 0 ? '+' : ''}$${formatNumber(pnl)}</td>
    </tr>`;
  }).join('');
  container.innerHTML = `
    <div class="panel-head compact pm-orders-head"><h3>v6 前向实验</h3></div>
    <div class="accuracy-empty">原始候选 ${analytics.candidates?.total || 0} · 合格样本 ${analytics.observations?.total || 0} · 已结算 ${analytics.observations?.settled || 0} · 待结算 ${analytics.observations?.open || 0}。5m/15m/1h/1d 均需模型同向、置信度与点差门槛；模拟盘可纸面成交，实盘仅 5m 预留且默认关闭。旧版基线 ${legacy.settled || 0} 笔，ROI ${legacy.settled ? pct(legacy.roi) : '--'}。</div>
    <table>
      <thead><tr><th>通道</th><th>已结算</th><th>待结算</th><th>胜率</th><th>ROI</th><th>PnL</th></tr></thead>
      <tbody>${laneRows}</tbody>
    </table>
    ${recentRows ? `<div class="panel-head compact pm-orders-head"><h3>最近官方结算候选</h3></div>
      <table><thead><tr><th>时间</th><th>币种</th><th>周期</th><th>候选</th><th>结果</th><th>假设 PnL</th></tr></thead><tbody>${recentRows}</tbody></table>` : ''}`;
}

function renderPlan3ObservationRow(item) {
  const reason = item.skipReason || (item.shouldTrade ? 'trigger' : '--');
  return `
    <tr>
      <td>${formatTime(item.recordedAtIso)}</td>
      <td>${escapeHtml(item.timeframe || '--')}</td>
      <td>${Number.isFinite(Number(item.secondsRemaining)) ? `${item.secondsRemaining}s` : '--'}</td>
      <td>${escapeHtml(formatPlan3SkipReason(reason, item))}</td>
      <td>${formatBps(item.distanceFromOpenBps)}</td>
      <td>${formatPlan3TokenCell(item)}</td>
    </tr>`;
}

function formatPlan3TokenCell(item = {}) {
  const up = item.pmUpPrice;
  const down = item.pmDownPrice;
  if (Number.isFinite(Number(up)) || Number.isFinite(Number(down))) {
    return `UP ${pct(up)} · DOWN ${pct(down)}`;
  }
  const dir = item.direction === 'down' ? 'DOWN' : item.direction === 'up' ? 'UP' : null;
  if (dir && Number.isFinite(Number(item.tokenPrice))) {
    return `${dir} ${pct(item.tokenPrice)}`;
  }
  return pct(item.tokenPrice);
}

function formatPlan3SkipReason(reason, item = {}) {
  const map = {
    not_effectively_settled: '结果未定型',
    price_out_of_range: '价格不在区间',
    spread_too_wide: '价差过大',
    market_quality_low: '盘口质量低',
    order_too_small_or_min_too_large: '金额过小',
    already_submitted_this_slot: '本窗口已提交',
    opposite_direction_exposure_conflict: '反向仓位冲突',
    daily_loss_limit_reached: '日损上限',
    stop_after_one_loss: '当日已停'
  };
  const base = map[reason] || reason;
  if (reason === 'not_effectively_settled') {
    if (item.settlementSkipDetail) return `${base}（${item.settlementSkipDetail}）`;
    if (Number.isFinite(Number(item.settlementThresholdBps)) && Number.isFinite(Number(item.distanceFromOpenBps))) {
      const absDistance = Math.abs(Number(item.distanceFromOpenBps));
      return `${base}（距开盘 ${absDistance.toFixed(1)}bps < 门槛 ${Number(item.settlementThresholdBps)}bps）`;
    }
  }
  if (reason === 'price_out_of_range' && Number.isFinite(Number(item.minPrice))) {
    const price = Number(item.tokenPrice);
    const minPct = (Number(item.minPrice) * 100).toFixed(0);
    const maxPct = (Number(item.maxPrice) * 100).toFixed(1);
    const pricePct = Number.isFinite(price) ? (price * 100).toFixed(1) : '--';
    return `${base}（${pricePct}% 不在 ${minPct}–${maxPct}%）`;
  }
  if (reason === 'spread_too_wide' && Number.isFinite(Number(item.spread))) {
    const spreadPct = (Number(item.spread) * 100).toFixed(1);
    const maxPct = Number.isFinite(Number(item.maxSpread)) ? (Number(item.maxSpread) * 100).toFixed(1) : '--';
    const tokenPct = Number.isFinite(Number(item.tokenPrice)) ? (Number(item.tokenPrice) * 100).toFixed(1) : '--';
    return `${base}（${tokenPct}% token，价差 ${spreadPct}% > 上限 ${maxPct}%）`;
  }
  return base;
}

function formatOrderSymbol(order) {
  if (['plan15', 'plan16', 'plan17', 'plan18', 'plan19', 'plan21'].includes(String(order?.planId || ''))) {
    const title = String(order.market || order.symbol || '—');
    return title.length > 48 ? `${title.slice(0, 46)}…` : title;
  }
  const raw = order?.symbol || order?.plan?.symbol || '';
  if (!raw) return '—';
  return String(raw).toUpperCase().replace(/-USD$/, '') || '—';
}

function renderOrders(planId, orders = []) {
  const column = getColumn(planId);
  const container = column?.querySelector('[data-role="orders"]');
  if (!container) return;
  const shown = orders.slice(0, 40);
  container.innerHTML = orders.length
    ? `<table>
        <thead><tr><th>时间</th><th>币种</th><th>周期</th><th>方向</th><th>限价</th><th>金额</th><th>PnL</th><th>退出</th><th>持有到期对照</th></tr></thead>
        <tbody>${shown.map((order) => renderOrderRow(order, planId)).join('')}</tbody>
      </table>
      <div class="accuracy-empty" style="margin-top:6px">显示最近 ${shown.length} / ${orders.length} 笔（轮询拉取上限 40）</div>`
    : '<div class="accuracy-empty">暂无记录。</div>';
}

function renderOrderRow(order, fallbackPlanId = null) {
  const pnlText = order.settlementStatus === 'settled'
    ? `${order.pnl >= 0 ? '+' : ''}$${formatNumber(order.pnl)}`
    : '--';
  const pid = String(order.planId || fallbackPlanId || '').toLowerCase();
  const simpleSettlement = ['plan3', 'plan3_6', 'plan5', 'plan11', 'plan12', 'plan14', 'plan15', 'plan16', 'plan17', 'plan18', 'plan19', 'plan21'].includes(pid);
  const modelExit = ['model-stop-loss', 'model-take-profit'].includes(order.exitStatus);
  const exitText = modelExit ? formatOrderExitLabel(order) : simpleSettlement
    ? (order.fillStatus === 'expired' || order.exitStatus === 'expired-unfilled'
      ? '未成交过期'
      : order.settlementStatus === 'settled' ? '结算赎回'
        : order.settlementStatus === 'open' ? '待结算' : '--')
    : formatOrderExitLabel(order);
  return `
    <tr>
      <td>${formatTime(order.createdAtIso)}</td>
      <td>${escapeHtml(formatOrderSymbol(order))}</td>
      <td>${escapeHtml(order.timeframe || '--')}</td>
      <td>${escapeHtml(order.outcome)}</td>
      <td>${pct(order.limitPrice)}${order.priceBand ? ` <small>(${escapeHtml(order.priceBand)})</small>` : ''}</td>
      <td>$${formatNumber(order.usd)}</td>
      <td class="${order.pnl >= 0 ? 'pos' : order.pnl < 0 ? 'neg' : ''}">${pnlText}</td>
      <td title="${escapeHtml(order.exitReason || '')}">${escapeHtml(exitText)}</td>
      <td>${modelExit
        ? order.counterfactualHoldPnl != null && Number.isFinite(Number(order.counterfactualHoldPnl))
          ? `${escapeHtml(String(order.actualDirection || '').toUpperCase())} · $${formatNumber(order.counterfactualHoldPnl)}`
          : '待官方结果'
        : '—'}</td>
    </tr>`;
}

function setOrderResult(planId, html) {
  const el = getColumn(planId)?.querySelector('[data-role="order-result"]');
  if (el) el.innerHTML = html;
}

async function configurePortfolio(event, planId) {
  event.preventDefault();
  const form = event.currentTarget;
  const cash = Number(new FormData(form).get('cash'));
  try {
    await postJson('/api/polymarket/portfolio/configure', { cash, planId });
    setOrderResult(planId, `已设置本金 $${formatNumber(cash)}，现在可以启动自动模拟。`);
    await refreshAll();
  } catch (error) {
    setOrderResult(planId, escapeHtml(error.message));
  }
}

async function resetPortfolio(planId) {
  const column = getColumn(planId);
  const btn = column?.querySelector('[data-action="reset-portfolio"]');
  if (btn) btn.disabled = true;
  setOrderResult(planId, '正在重置账户…');
  try {
    // 先停自动，避免重置时 tick 抢写状态导致卡住
    try {
      await postJson('/api/polymarket/auto/stop', { planId }, { timeoutMs: 15000 });
    } catch {
      // ignore
    }
    await postJson('/api/polymarket/portfolio/reset', { planId }, { timeoutMs: 30000 });
    setOrderResult(planId, `账户已重置，请重新设置本金后启动自动模拟（${PLAN_SWITCH_HINTS[planId] || planId}）`);
    await refreshPlanAfterReset(planId);
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    setOrderResult(
      planId,
      escapeHtml(timedOut
        ? '重置超时：服务可能正忙于写盘，请稍后重试；若持续失败请重建/重启容器'
        : (error.message || String(error)))
    );
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function executePlan(planId) {
  try {
    const result = await postJson('/api/polymarket/paper-plan/execute', {
      symbol: state.activeSymbol[planId] || 'BTC-USD',
      timeframe: state.activeTimeframe[planId],
      planId
    });
    setOrderResult(planId, renderOrderSummary(result.order));
    await refreshAll();
  } catch (error) {
    setOrderResult(planId, escapeHtml(error.message));
  }
}

async function startAuto(planId) {
  const column = getColumn(planId);
  const startBtn = column?.querySelector('[data-action="auto-start"]');
  if (startBtn) startBtn.disabled = true;
  setOrderResult(planId, '正在启动自动模拟…');
  try {
    const payload = {
      strategy: planId,
      timeframes: ['plan14', 'plan15', 'plan16', 'plan17', 'plan18', 'plan19', 'plan21'].includes(planId) ? ['5m'] : planId === 'plan3_6' ? ['5m', '15m', '1h', '1d'] : ['5m', '15m'],
      planId
    };
    if (MULTI_SYMBOL_PLANS.has(planId)) {
      payload.symbols = selectedPaperSymbols(planId);
    }
    const result = await postJson('/api/polymarket/auto/start', payload, { timeoutMs: 20000 });
    const executed = (result.tick?.ticks || []).filter((t) => t.executed && t.planId === planId);
    if (executed.length) {
      setOrderResult(planId, executed.map((t) => renderOrderSummary(t.order, t.timeframe)).join(''));
    } else {
      setOrderResult(planId, result.auto?.enabled
        ? (result.deferredTick ? '自动模拟已启动（首轮检查后台进行中）' : '自动模拟已启动')
        : '启动失败，请查看计划条件');
    }
    await refreshAll();
  } catch (error) {
    setOrderResult(planId, escapeHtml(error.message));
  } finally {
    if (startBtn) startBtn.disabled = false;
  }
}

async function stopAuto(planId) {
  try {
    await postJson('/api/polymarket/auto/stop', { planId });
    setOrderResult(planId, '自动模拟已停止');
    await refreshStatus();
  } catch (error) {
    setOrderResult(planId, escapeHtml(error.message));
  }
}

async function resetOrders(planId) {
  const column = getColumn(planId);
  const btn = column?.querySelector('[data-action="reset-orders"]');
  if (btn) btn.disabled = true;
  setOrderResult(planId, '正在清空订单…');
  try {
    await postJson('/api/polymarket/paper-orders/reset', { planId }, { timeoutMs: 90000 });
    setOrderResult(planId, '订单已清空');
    await refreshPlanAfterReset(planId);
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    setOrderResult(
      planId,
      escapeHtml(timedOut
        ? '清空超时：服务可能正忙于写盘，请稍后重试'
        : (error.message || String(error)))
    );
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderOrderSummary(order, timeframe = order.timeframe) {
  return `
    <div class="opt-metrics">
      <span>币种</span><b>${escapeHtml(formatOrderSymbol(order))}</b>
      <span>周期</span><b>${escapeHtml(timeframe || '--')}</b>
      <span>方向</span><b>${escapeHtml(order.outcome)}</b>
      <span>限价</span><b>${pct(order.limitPrice)}</b>
      <span>金额</span><b>$${formatNumber(order.usd)}</b>
    </div>`;
}

async function getJson(path, { timeoutMs = 60000 } = {}) {
  const response = await fetch(path, {
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(timeoutMs)
      : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

async function postJson(path, payload, { timeoutMs = 60000 } = {}) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(timeoutMs)
      : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function pct(value) {
  if (value == null || value === '') return '--';
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '--';
}

function formatEntryTier(action = {}) {
  if (action.shouldTrade && Number.isFinite(Number(action.sizeMultiplier))) {
    const tier = action.entryTier || (action.sizeMultiplier >= 1 ? 'strong' : action.sizeMultiplier >= 0.5 ? 'medium' : 'weak');
    return `${tier} ×${Number(action.sizeMultiplier).toFixed(2)}`;
  }
  if (action.reason && /tier/i.test(action.reason)) {
    return action.reason.split('。')[0];
  }
  return action.shouldTrade ? '—' : '未达 tier';
}

function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  return n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 8 : 2 });
}

function formatTime(value) {
  if (!value) return '--';
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

function shortAddress(address = '') {
  const text = String(address || '');
  return text.length > 10 ? `${text.slice(0, 6)}...${text.slice(-4)}` : text;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}
