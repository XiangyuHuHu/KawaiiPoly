const pmStatus = document.querySelector('#pmStatus');
const pmLiveMode = document.querySelector('#pmLiveMode');
const pmConfigured = document.querySelector('#pmConfigured');
const pmLiveBalance = document.querySelector('#pmLiveBalance');
const pmLiveAllowance = document.querySelector('#pmLiveAllowance');
const pmLiveOpenOrders = document.querySelector('#pmLiveOpenOrders');
const pmLiveClosedOnly = document.querySelector('#pmLiveClosedOnly');
const pmLiveFunder = document.querySelector('#pmLiveFunder');
const pmLiveSigner = document.querySelector('#pmLiveSigner');
const pmLiveSignatureType = document.querySelector('#pmLiveSignatureType');
const pmStartingCash = document.querySelector('#pmStartingCash');
const pmEquity = document.querySelector('#pmEquity');
const pmCash = document.querySelector('#pmCash');
const pmRealizedPnl = document.querySelector('#pmRealizedPnl');
const pmTotalReturn = document.querySelector('#pmTotalReturn');
const pmPortfolioStarting = document.querySelector('#pmPortfolioStarting');
const pmPortfolioEquity = document.querySelector('#pmPortfolioEquity');
const pmPortfolioCash = document.querySelector('#pmPortfolioCash');
const pmPortfolioPnl = document.querySelector('#pmPortfolioPnl');
const pmPortfolioReturn = document.querySelector('#pmPortfolioReturn');
const pmPortfolioOpenExposure = document.querySelector('#pmPortfolioOpenExposure');
const pmOrder15m = document.querySelector('#pmOrder15m');
const pmOrder5m = document.querySelector('#pmOrder5m');
const pmWinRate = document.querySelector('#pmWinRate');
const pmDailyPnl = document.querySelector('#pmDailyPnl');
const pmPaperRisk = document.querySelector('#pmPaperRisk');
const pmAutoMode = document.querySelector('#pmAutoMode');
const pmAutoStatus = document.querySelector('#pmAutoStatus');
const pmAutoStatusText = document.querySelector('#pmAutoStatusText');
const pmAutoStatusDetail = document.querySelector('#pmAutoStatusDetail');
const pmRecommendation = document.querySelector('#pmRecommendation');
const pmRefresh = document.querySelector('#pmRefresh');
const pmExecutePlan = document.querySelector('#pmExecutePlan');
const pmAutoStart = document.querySelector('#pmAutoStart');
const pmAutoStop = document.querySelector('#pmAutoStop');
const pmResetOrders = document.querySelector('#pmResetOrders');
const pmResetPortfolio = document.querySelector('#pmResetPortfolio');
const pmPortfolioForm = document.querySelector('#pmPortfolioForm');
const pmStartingCashInput = document.querySelector('#pmStartingCashInput');
const pmPaperForm = document.querySelector('#pmPaperForm');
const pmTimeframeSelect = document.querySelector('#pmTimeframeSelect');
const pmOrderResult = document.querySelector('#pmOrderResult');
const pmPaperOrders = document.querySelector('#pmPaperOrders');
const pmReadiness = document.querySelector('#pmReadiness');
const pmReadinessRefresh = document.querySelector('#pmReadinessRefresh');
const pmDepositWallet = document.querySelector('#pmDepositWallet');
const pmDepositWalletRefresh = document.querySelector('#pmDepositWalletRefresh');
const pmTabs = [...document.querySelectorAll('.pm-tab[data-timeframe]')];
const pmAlgoTabs = [...document.querySelectorAll('.pm-tab[data-plan]')];
const pmCompareLeader = document.querySelector('#pmCompareLeader');
const pmPlan1Equity = document.querySelector('#pmPlan1Equity');
const pmPlan1Return = document.querySelector('#pmPlan1Return');
const pmPlan1Auto = document.querySelector('#pmPlan1Auto');
const pmPlan2Equity = document.querySelector('#pmPlan2Equity');
const pmPlan2Return = document.querySelector('#pmPlan2Return');
const pmPlan2Auto = document.querySelector('#pmPlan2Auto');
const pmPortfolioTitle = document.querySelector('#pmPortfolioTitle');
const pmStartingCashLabel = document.querySelector('#pmStartingCashLabel');
const pmAutoTitle = document.querySelector('#pmAutoTitle');
const pmPlanPanelTitle = document.querySelector('#pmPlanPanelTitle');
const pmPlanPanelDesc = document.querySelector('#pmPlanPanelDesc');
const pmOrdersTitle = document.querySelector('#pmOrdersTitle');

let latestPlansView = null;
let latestStatus = null;
let activeTimeframe = '5m';
let activePlanId = 'plan1';

pmRefresh?.addEventListener('click', refreshAll);
pmExecutePlan?.addEventListener('click', executeCurrentPlan);
pmAutoStart?.addEventListener('click', startAuto);
pmAutoStop?.addEventListener('click', stopAuto);
pmResetOrders?.addEventListener('click', resetOrders);
pmResetPortfolio?.addEventListener('click', resetPortfolio);
pmPortfolioForm?.addEventListener('submit', configurePortfolio);
pmPaperForm?.addEventListener('submit', createManualPaperOrder);
pmReadinessRefresh?.addEventListener('click', refreshReadiness);
pmDepositWalletRefresh?.addEventListener('click', refreshDepositWallet);
pmTabs.forEach((tab) => tab.addEventListener('click', () => setActiveTimeframe(tab.dataset.timeframe)));
pmAlgoTabs.forEach((tab) => tab.addEventListener('click', () => setActivePlan(tab.dataset.plan)));

await refreshAll();
updatePlanLabels();
refreshReadiness().catch(() => {});
refreshDepositWallet().catch(() => {});
setInterval(visibleSingleFlight(refreshPlans), 10000);
setInterval(visibleSingleFlight(refreshPaperOrders), 15000);
setInterval(visibleSingleFlight(refreshStatus), 15000);

function visibleSingleFlight(fn) {
  let running = false;
  return async () => {
    if (running || document.visibilityState === 'hidden') return;
    running = true;
    try {
      await fn();
    } finally {
      running = false;
    }
  };
}

async function refreshAll() {
  await Promise.all([refreshStatus(), refreshPlans(), refreshPaperOrders()]);
}

async function refreshStatus() {
  latestStatus = await getJson('/api/polymarket/status');
  renderComparison(latestStatus);
  const planStatus = latestStatus.plans?.[activePlanId] || {};
  renderPortfolio(planStatus.portfolio, planStatus.stats);
  renderSizing(planStatus.currentSizing, latestStatus.sizing);
  if (pmStatus) pmStatus.textContent = latestStatus.liveTradingEnabled ? 'Polymarket 实盘开关已打开' : 'Polymarket 模拟模式 · 双策略对比';
  if (pmLiveMode) pmLiveMode.textContent = latestStatus.liveTradingEnabled ? '实盘开启' : '实盘关闭';
  if (pmConfigured) pmConfigured.textContent = latestStatus.configured ? '已配置' : '未配置';
  renderAutoStatus(planStatus.auto);
  if (!planStatus.portfolio?.portfolioInitialized) {
    if (pmStartingCashInput) pmStartingCashInput.value = latestStatus.defaultStartingCash || 500;
  }
}

function renderComparison(status = {}) {
  if (!pmCompareLeader) return;
  const plan1 = status.plans?.plan1 || {};
  const plan2 = status.plans?.plan2 || {};
  const cmp = status.comparison || {};
  renderPlanSummary(pmPlan1Equity, pmPlan1Return, plan1);
  renderPlanSummary(pmPlan2Equity, pmPlan2Return, plan2);
  if (pmPlan1Auto) pmPlan1Auto.textContent = plan1.auto?.enabled ? '运行中' : '已停止';
  if (pmPlan2Auto) pmPlan2Auto.textContent = plan2.auto?.enabled ? '运行中' : '已停止';
  if (cmp.leader === 'plan1') pmCompareLeader.textContent = 'Plan1 领先';
  else if (cmp.leader === 'plan2') pmCompareLeader.textContent = 'Plan2 领先';
  else pmCompareLeader.textContent = '持平或未初始化';
  pmCompareLeader.className = cmp.leader === 'plan1' ? 'pos' : cmp.leader === 'plan2' ? 'neg' : '';
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

function setActivePlan(planId) {
  activePlanId = planId === 'plan2' ? 'plan2' : 'plan1';
  pmAlgoTabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.plan === activePlanId));
  updatePlanLabels();
  if (latestStatus) {
    const planStatus = latestStatus.plans?.[activePlanId] || {};
    renderPortfolio(planStatus.portfolio, planStatus.stats);
    renderSizing(planStatus.currentSizing, latestStatus.sizing);
    renderAutoStatus(planStatus.auto);
  }
  renderActivePlan();
  refreshPaperOrders().catch(() => {});
}

function updatePlanLabels() {
  const isPlan2 = activePlanId === 'plan2';
  const label = isPlan2 ? 'Plan2' : 'Plan1';
  if (pmPortfolioTitle) pmPortfolioTitle.textContent = `${label} 模拟本金`;
  if (pmStartingCashLabel) pmStartingCashLabel.textContent = `${label} 初始本金 (USD)`;
  if (pmAutoTitle) pmAutoTitle.textContent = `${label} 自动模拟`;
  if (pmOrdersTitle) pmOrdersTitle.textContent = `${label} 最近模拟订单`;
  if (pmPlanPanelTitle) {
    pmPlanPanelTitle.textContent = isPlan2
      ? 'Plan2 · 定方向 / 动态 TP/SL'
      : 'Plan1 · 5 分钟 / 15 分钟模拟计划';
  }
  if (pmPlanPanelDesc) {
    pmPlanPanelDesc.textContent = isPlan2
      ? 'Plan2：定方向买入；动态止盈止损。'
      : 'Plan1：综合技术 + Polymarket 判断；TP 入场价 +18%、SL 入场价 -15%；低置信度或盘口质量差会跳过。';
  }
}

async function refreshReadiness() {
  if (!pmReadiness) return;
  pmReadiness.innerHTML = '<div class="accuracy-empty">检查中...</div>';
  try {
    const data = await getJson('/api/polymarket/readiness');
    renderReadiness(data);
  } catch (error) {
    pmReadiness.innerHTML = `<div class="accuracy-empty">检查失败：${escapeHtml(error.message)}</div>`;
  }
}

function renderReadiness(data) {
  const clob = data.clob || {};
  const collateral = clob.collateral || {};
  const profile = data.profile || {};
  renderLiveSummary(data);
  pmReadiness.innerHTML = `
    <div class="pm-readiness-summary ${data.ready ? 'ready' : 'blocked'}">
      <strong>${data.ready ? '可以进入实盘前测试' : '暂不满足实盘条件'}</strong>
      <span>${data.liveTradingEnabled ? '实盘开关已开启' : '实盘开关关闭'}</span>
    </div>
    <div class="pm-market-grid">
      <span>Signer 钱包</span><b>${shortAddress(data.signerAddress)}</b>
      <span>Profile/Funder</span><b>${shortAddress(data.funderAddress)}</b>
      <span>Profile</span><b>${escapeHtml(profile.pseudonym || profile.name || '--')}</b>
      <span>CLOB 余额</span><b>$${formatNumber(collateral.balanceUsdc || 0)}</b>
      <span>CLOB 授权</span><b>$${formatNumber(collateral.allowanceUsdc || 0)}</b>
      <span>Open orders</span><b>${clob.openOrdersCount ?? '--'}</b>
      <span>Closed-only</span><b>${clob.closedOnly === false ? '否' : clob.closedOnly === true ? '是' : '--'}</b>
    </div>
    <div class="pm-check-list">
      ${(data.checks || []).map(renderReadinessCheck).join('')}
    </div>
  `;
}

function renderLiveSummary(data) {
  const clob = data.clob || {};
  const collateral = clob.collateral || {};
  if (pmLiveBalance) pmLiveBalance.textContent = `$${formatNumber(collateral.balanceUsdc || 0)}`;
  if (pmLiveAllowance) pmLiveAllowance.textContent = Number(collateral.allowanceUsdc || 0) > 0 ? '已授权' : '$0';
  if (pmLiveOpenOrders) pmLiveOpenOrders.textContent = clob.openOrdersCount ?? '--';
  if (pmLiveClosedOnly) pmLiveClosedOnly.textContent = clob.closedOnly === false ? '未限制' : clob.closedOnly === true ? 'Closed-only' : '--';
  if (pmLiveFunder) pmLiveFunder.textContent = shortAddress(data.funderAddress);
  if (pmLiveSigner) pmLiveSigner.textContent = shortAddress(data.signerAddress);
  if (pmLiveSignatureType) pmLiveSignatureType.textContent = '3 / POLY_1271';
  if (pmLiveBalance) pmLiveBalance.className = Number(collateral.balanceUsdc || 0) > 0 ? 'pos' : '';
  if (pmLiveAllowance) pmLiveAllowance.className = Number(collateral.allowanceUsdc || 0) > 0 ? 'pos' : 'neg';
  if (pmLiveClosedOnly) pmLiveClosedOnly.className = clob.closedOnly === false ? 'pos' : clob.closedOnly === true ? 'neg' : '';
}

function renderReadinessCheck(check) {
  return `
    <div class="pm-check ${check.ok ? 'pass' : 'fail'}">
      <span>${check.ok ? '通过' : '未通过'}</span>
      <strong>${escapeHtml(check.label)}</strong>
      <em>${escapeHtml(check.detail || '')}</em>
    </div>
  `;
}

async function refreshDepositWallet() {
  if (!pmDepositWallet) return;
  pmDepositWallet.innerHTML = '<div class="accuracy-empty">检查中...</div>';
  try {
    const data = await getJson('/api/polymarket/deposit-wallet/status');
    renderDepositWallet(data);
  } catch (error) {
    pmDepositWallet.innerHTML = `<div class="accuracy-empty">检查失败：${escapeHtml(error.message)}</div>`;
  }
}

function renderDepositWallet(data) {
  const depositWallet = data.wallets?.depositWallet || {};
  const signerWallet = data.wallets?.signer || {};
  const funderWallet = data.wallets?.currentFunder || {};
  const clobCollateral = data.clob?.collateral || {};
  const sdk = data.sdk || {};
  pmDepositWallet.innerHTML = `
    <div class="pm-readiness-summary ${data.readyForDepositWallet ? 'ready' : 'blocked'}">
      <strong>${data.readyForDepositWallet ? 'Deposit wallet 基础条件已满足' : 'Deposit wallet 还没就绪'}</strong>
      <span>当前 signatureType ${data.currentSignatureType ?? '--'} / 推荐 3</span>
    </div>
    <div class="pm-market-grid">
      <span>Owner signer</span><b>${shortAddress(data.signerAddress)}</b>
      <span>当前 Funder</span><b>${shortAddress(data.currentFunderAddress)}</b>
      <span>Deposit wallet</span><b>${shortAddress(data.configuredDepositWalletAddress)}</b>
      <span>Deposit 已部署</span><b>${depositWallet.deployed ? '是' : depositWallet.address ? '否' : '--'}</b>
      <span>Deposit pUSD</span><b>$${formatNumber(depositWallet.pusdBalance || 0)}</b>
      <span>Deposit 最大授权</span><b>$${formatNumber(depositWallet.maxAllowance || 0)}</b>
      <span>CLOB buying power</span><b>$${formatNumber(clobCollateral.balanceUsdc || 0)}</b>
      <span>CLOB 授权</span><b>$${formatNumber(clobCollateral.allowanceUsdc || 0)}</b>
      <span>Signer pUSD</span><b>$${formatNumber(signerWallet.pusdBalance || 0)}</b>
      <span>Funder pUSD</span><b>$${formatNumber(funderWallet.pusdBalance || 0)}</b>
      <span>Relayer</span><b>${data.relayerConfigured && data.builderCredentialsConfigured ? '已配置' : '未完整配置'}</b>
      <span>SDK</span><b>${sdk.relayerClient && sdk.clobClientV2 ? '已安装' : '缺 v2/relayer'}</b>
    </div>
    ${renderAllowanceRows(depositWallet.allowances || [])}
    <div class="pm-check-list">
      ${(data.checks || []).map(renderReadinessCheck).join('')}
    </div>
    <div class="deposit-next-steps">
      <strong>下一步</strong>
      ${(data.nextSteps || []).map((step) => `<span>${escapeHtml(step)}</span>`).join('')}
    </div>
  `;
}

function renderAllowanceRows(allowances) {
  if (!allowances.length) return '';
  return `
    <div class="pm-allowance-grid">
      ${allowances
        .map(
          (item) => `
            <div>
              <span>${escapeHtml(item.label)}</span>
              <strong>$${formatNumber(item.usdc || 0)}</strong>
            </div>
          `
        )
        .join('')}
    </div>
  `;
}

function renderSizing(currentSizing = {}, sizing = {}) {
  if (!pmOrder15m || !pmOrder5m) return;
  const initialized = Number(currentSizing?.equity) > 0 || currentSizing?.['15m']?.usd > 0;
  pmOrder15m.textContent = initialized ? `$${formatNumber(currentSizing['15m']?.usd)}` : '--';
  pmOrder5m.textContent = initialized ? `$${formatNumber(currentSizing['5m']?.usd)}` : '--';
  if (sizing?.summary) {
    pmOrder15m.title = sizing.summary;
    pmOrder5m.title = sizing.summary;
  }
}

async function refreshPlans() {
  latestPlansView = await getJson(`/api/polymarket/paper-plans?symbol=BTC-USD&plan=${activePlanId}`);
  if (latestPlansView.portfolio && latestPlansView.stats) {
    renderPortfolio(latestPlansView.portfolio, latestPlansView.stats);
  }
  renderActivePlan();
  const planStatus = latestStatus?.plans?.[activePlanId];
  if (planStatus) renderAutoStatus(planStatus.auto);
}

function renderAutoStatus(auto = {}) {
  if (!pmAutoStatus) return;
  const running = Boolean(auto?.enabled);
  const timeframes = (auto?.timeframes || ['5m', '15m']).join(' + ');
  const planLabel = activePlanId === 'plan2' ? 'Plan2' : 'Plan1';
  pmAutoStatus.classList.toggle('running', running);
  pmAutoStatus.classList.toggle('stopped', !running);
  pmAutoStatusText.textContent = running ? '已启动' : '未启动';
  pmAutoStatusDetail.textContent = running
    ? `${planLabel} 自动模拟运行中 · 监控 ${timeframes} · 每 ${(Number(latestStatus?.autoLoopIntervalMs) || 10000) / 1000} 秒检查一次`
    : `点击启动 ${planLabel} 的 5m + 15m 自动模拟`;
  if (pmAutoMode) pmAutoMode.textContent = running ? '已启动' : '已停止';
  if (pmAutoStart) {
    pmAutoStart.disabled = running;
    pmAutoStart.classList.toggle('is-active', running);
  }
  if (pmAutoStop) pmAutoStop.disabled = !running;
}

function setActiveTimeframe(timeframe) {
  activeTimeframe = timeframe === '15m' ? '15m' : '5m';
  pmTabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.timeframe === activeTimeframe));
  pmTimeframeSelect.value = activeTimeframe;
  renderActivePlan();
}

function renderActivePlan() {
  const data = latestPlansView?.plans?.[activeTimeframe];
  if (!pmRecommendation) return;
  if (!data) {
    pmRecommendation.innerHTML = '<div class="accuracy-empty">等待首次计划。</div>';
    return;
  }
  renderPlan(data, activeTimeframe);
}

function renderPlan(data, timeframe) {
  const plan = data.plan || {};
  const action = plan.action || {};
  const poly = data.polymarket || {};
  const signal = data.signal || {};
  const isPlan2 = plan.planId === 'plan2' || activePlanId === 'plan2';
  const directionTone = action.direction === 'down' ? 'down' : action.shouldTrade ? 'up' : 'pending';
  const directionText = action.shouldTrade
    ? action.direction === 'up' ? '买 UP / 看涨' : '买 DOWN / 看跌'
    : '跳过';

  const strategyCards = isPlan2
    ? renderPlan2Cards(plan, poly, signal)
    : `
    <div class="pm-plan-layout">
      ${renderStrategyCard('技术判断', plan.strategies?.tech)}
      ${renderStrategyCard('Polymarket 判断', plan.strategies?.polymarket)}
      ${renderStrategyCard('综合判断', plan.strategies?.composite)}
    </div>`;

  const globalRules = isPlan2 ? latestPlansView?.plan2Rules : latestPlansView?.plan1Rules;
  const exitRuleHtml = plan.exitRule
    ? `<span>退出规则</span><b>${renderDynamicExitSummary(
      plan.exitRule,
      globalRules,
      action,
      isPlan2 ? { slOffset: 0.12 } : { slOffset: 0.15 }
    )}</b>`
    : '';

  if (!pmRecommendation) return;
  pmRecommendation.innerHTML = `
    <div class="risk-sim-recommend ${directionTone}">
      <span>${escapeHtml(timeframe)} · ${escapeHtml(plan.window?.label || plan.phase?.label || '本窗口')}</span>
      <strong>${escapeHtml(directionText)}</strong>
      <em>${pct(action.confidence)} / $${formatNumber(action.usd)}</em>
    </div>

    ${strategyCards}

    <div class="pm-market-grid">
      <span>计划原因</span><b>${escapeHtml(action.reason || '--')}</b>
      <span>目标窗口</span><b>${formatTime(plan.targetTimeIso)}</b>
      <span>开始价</span><b>${money(action.startPrice || signal.prediction?.comparisonBasePrice)}</b>
      <span>预估截止价</span><b>${money(action.estimatedClose || signal.prediction?.estimatedClose)}</b>
      <span>PM UP / DOWN</span><b>${pct(poly.upProbability ?? poly.upPrice)} / ${pct(poly.downProbability ?? poly.downPrice)}</b>
      <span>盘口质量</span><b>${escapeHtml(poly.qualityLabel || '--')} ${pct(poly.qualityScore)}</b>
      <span>计划限价</span><b>${pct(action.limitPrice)}</b>
      <span>模拟金额</span><b>$${formatNumber(action.usd)}</b>
      ${exitRuleHtml}
    </div>
  `;
}

function renderPlan2Cards(plan, poly, signal) {
  const rules = { ...plan.exitRule, ...latestPlansView?.plan2Rules };
  const entry = plan.directionEntry;
  const action = plan.action || {};
  const entryMin = rules.entryMinPrice ?? 0.35;
  const entryMax = rules.entryMaxPrice ?? 0.58;
  const minConf = rules.minConfidence ?? 0.63;
  const tpOffset = rules.takeProfitOffset ?? 0.18;
  const slOffset = rules.stopLossOffset ?? 0.12;
  const trailOffset = rules.trailingTakeProfitOffset ?? 0.10;
  const trailingOn = rules.trailingTakeProfitEnabled === true;
  const tpNow = trailingOn
    ? `最高点回撤 ${offsetLabel(trailOffset).replace('+', '')}`
    : action.takeProfitPrice
      ? `≥ ${pct(action.takeProfitPrice)}（${offsetLabel(tpOffset)}）`
      : `入场价 ${offsetLabel(tpOffset)}`;
  const slNow = action.stopLossPrice
    ? `≤ ${pct(action.stopLossPrice)}（${offsetLabel(slOffset, '-')}）`
    : `入场价 ${offsetLabel(slOffset, '-')}`;
  return `
    <div class="pm-plan-layout">
      <div class="pm-strategy-card ${entry?.direction === 'down' ? 'down' : 'up'}">
        <strong>开盘方向</strong>
        <span>${entry?.direction === 'up' ? '上涨' : entry?.direction === 'down' ? '下跌' : '待定'}</span>
        <em>来源 ${escapeHtml(entry?.source || '--')}</em>
        <small>置信度 ${pct(entry?.confidence)}</small>
      </div>
      <div class="pm-strategy-card">
        <strong>入场条件</strong>
        <span>${pct(entryMin)}–${pct(entryMax)} · 置信度 ≥ ${pct(minConf)}</span>
        <em>edge 过滤 + 窗口进度限制</em>
      </div>
      <div class="pm-strategy-card up">
        <strong>止盈条件</strong>
        <span>${tpNow}</span>
        <em>${trailingOn ? '涨了不卖，回撤才卖' : '未止盈则到期结算'}</em>
      </div>
      <div class="pm-strategy-card down">
        <strong>止损条件</strong>
        <span>${slNow}</span>
        <em>未止损则到期结算</em>
      </div>
    </div>`;
}

function renderStrategyCard(title, item) {
  if (!item) {
    return `
      <div class="pm-strategy-card">
        <strong>${escapeHtml(title)}</strong>
        <span>暂无数据</span>
      </div>
    `;
  }
  const cls = item.direction === 'down' ? 'down' : 'up';
  return `
    <div class="pm-strategy-card ${cls}">
      <strong>${escapeHtml(title)}</strong>
      <span>${item.direction === 'up' ? '上涨' : '下跌'}</span>
      <em>UP ${pct(item.upProbability)} / DOWN ${pct(item.downProbability)}</em>
      <small>置信度 ${pct(item.confidence)}</small>
    </div>
  `;
}

function renderPortfolio(portfolio = {}, stats = {}) {
  if (!pmStartingCash) return;
  const initialized = portfolio.portfolioInitialized;
  const startingCash = Number(stats.startingCash ?? portfolio.startingCash) || 0;
  const equity = Number(stats.equity ?? portfolio.equity) || 0;
  const cash = Number(stats.cash ?? portfolio.cash) || 0;
  const realizedPnl = Number(stats.realizedPnl ?? portfolio.realizedPnl) || 0;
  const openExposure = Number(stats.openExposureUsd ?? portfolio.openExposureUsd) || 0;
  const totalReturn = Number(stats.totalReturn ?? portfolio.totalReturn);
  const dailyPnl = Number(stats.dailyRealizedPnl) || 0;

  const startingText = initialized ? `$${formatNumber(startingCash)}` : '未设置';
  const equityText = initialized ? `$${formatNumber(equity)}` : '--';
  const cashText = initialized ? `$${formatNumber(cash)}` : '--';
  const pnlText = initialized
    ? `${realizedPnl >= 0 ? '+' : ''}$${formatNumber(realizedPnl)}`
    : '--';
  const returnText = initialized && Number.isFinite(totalReturn)
    ? `${totalReturn >= 0 ? '+' : ''}${(totalReturn * 100).toFixed(2)}%`
    : '--';
  const exposureText = initialized ? `$${formatNumber(openExposure)}` : '--';

  pmStartingCash.textContent = startingText;
  pmEquity.textContent = equityText;
  pmCash.textContent = cashText;
  pmRealizedPnl.textContent = pnlText;
  pmTotalReturn.textContent = returnText;
  pmDailyPnl.textContent = initialized ? `${dailyPnl >= 0 ? '+' : ''}$${formatNumber(dailyPnl)}` : '--';
  pmPaperRisk.textContent = initialized ? '无亏损保护' : '--';

  pmPortfolioStarting.textContent = startingText;
  pmPortfolioEquity.textContent = equityText;
  pmPortfolioCash.textContent = cashText;
  pmPortfolioPnl.textContent = pnlText;
  pmPortfolioReturn.textContent = returnText;
  pmPortfolioOpenExposure.textContent = exposureText;

  pmEquity.className = equity > startingCash ? 'pos' : equity < startingCash ? 'neg' : '';
  pmPortfolioEquity.className = pmEquity.className;
  pmRealizedPnl.className = realizedPnl >= 0 ? 'pos' : realizedPnl < 0 ? 'neg' : '';
  pmPortfolioPnl.className = pmRealizedPnl.className;
  pmTotalReturn.className = totalReturn >= 0 ? 'pos' : totalReturn < 0 ? 'neg' : '';
  pmPortfolioReturn.className = pmTotalReturn.className;
  pmDailyPnl.className = dailyPnl >= 0 ? 'pos' : dailyPnl < 0 ? 'neg' : '';
  pmPaperRisk.className = initialized ? 'pos' : '';

  const winRate = Number(stats.winRate);
  pmWinRate.textContent = stats.settledOrders
    ? `${(winRate * 100).toFixed(1)}% (${stats.wins}/${stats.settledOrders})`
    : initialized ? '暂无结算' : '--';
  if (initialized && !pmStartingCashInput.matches(':focus')) {
    pmStartingCashInput.value = startingCash;
  }
}

async function configurePortfolio(event) {
  event.preventDefault();
  const cash = Number(new FormData(pmPortfolioForm).get('cash'));
  try {
    const result = await postJson('/api/polymarket/portfolio/configure', { cash, planId: activePlanId });
    renderPortfolio(result.portfolio, result.stats);
    await refreshStatus();
    if (pmOrderResult) pmOrderResult.textContent = `已设置 ${activePlanId.toUpperCase()} 初始本金 $${formatNumber(cash)}。`;
  } catch (error) {
    pmOrderResult.textContent = error.message;
  }
}

async function resetPortfolio() {
  try {
    const result = await postJson('/api/polymarket/portfolio/reset', { planId: activePlanId });
    renderPortfolio(result.portfolio, result.stats);
    await refreshStatus();
    if (pmOrderResult) pmOrderResult.textContent = `${activePlanId.toUpperCase()} 账户已重置，请重新设置本金。`;
  } catch (error) {
    pmOrderResult.textContent = error.message;
  }
}

async function executeCurrentPlan() {
  try {
    const result = await postJson('/api/polymarket/paper-plan/execute', {
      symbol: 'BTC-USD',
      timeframe: activeTimeframe,
      planId: activePlanId
    });
    if (pmOrderResult) pmOrderResult.innerHTML = renderOrderSummary(result.order);
    renderPortfolio(result.portfolio, result.stats);
    await refreshPaperOrders();
    await refreshPlans();
    await refreshStatus();
  } catch (error) {
    pmOrderResult.textContent = error.message;
  }
}

async function startAuto() {
  try {
    const result = await postJson('/api/polymarket/auto/start', {
      strategy: activePlanId,
      timeframes: ['5m', '15m'],
      planId: activePlanId
    });
    if (pmAutoMode) pmAutoMode.textContent = result.auto?.enabled ? '已启动' : '已停止';
    renderAutoStatus(result.auto);
    const executedTicks = (result.tick?.ticks || []).filter((item) => item.executed && item.planId === activePlanId);
    if (pmOrderResult) {
      if (executedTicks.length) {
        pmOrderResult.innerHTML = executedTicks.map((item) => renderOrderSummary(item.order, item.timeframe)).join('');
      } else if (result.auto?.enabled) {
        pmOrderResult.textContent = `${activePlanId.toUpperCase()} 自动模拟已启动，正在监控 BTC 5m 与 15m…`;
      } else {
        pmOrderResult.textContent = `自动模拟未成功启动：${result.tick?.ticks?.map((item) => `${item.planId} ${item.timeframe} ${item.reason || '等待'}`).join(' · ') || '未知原因'}`;
      }
    }
    await refreshStatus();
    await refreshPaperOrders();
  } catch (error) {
    pmOrderResult.textContent = error.message;
  }
}

async function stopAuto() {
  const result = await postJson('/api/polymarket/auto/stop', { planId: activePlanId });
  renderAutoStatus(result.auto);
  await refreshStatus();
  if (pmOrderResult) pmOrderResult.textContent = `${activePlanId.toUpperCase()} 自动模拟已停止。`;
}

async function resetOrders() {
  const result = await postJson('/api/polymarket/paper-orders/reset', { planId: activePlanId });
  renderPortfolio(result.portfolio, result.stats);
  if (pmOrderResult) pmOrderResult.textContent = `${activePlanId.toUpperCase()} 模拟订单已清空，未结算本金已退回。`;
  await refreshPaperOrders();
  await refreshStatus();
}

async function createManualPaperOrder(event) {
  event.preventDefault();
  const form = new FormData(pmPaperForm);
  const timeframe = form.get('timeframe') || activeTimeframe;
  const manualUsd = Number(form.get('usd'));
  try {
    const result = await postJson('/api/polymarket/paper-order', {
      symbol: 'BTC-USD',
      timeframe,
      planId: activePlanId,
      direction: form.get('direction') || latestPlansView?.plans?.[timeframe]?.recommendation?.direction,
      usd: Number.isFinite(manualUsd) && manualUsd > 0 ? manualUsd : undefined
    });
    if (pmOrderResult) pmOrderResult.innerHTML = renderOrderSummary(result.order, timeframe);
    renderPortfolio(result.portfolio, result.stats);
    await refreshPaperOrders();
    await refreshStatus();
  } catch (error) {
    pmOrderResult.textContent = error.message;
  }
}

async function refreshPaperOrders() {
  const data = await getJson(`/api/polymarket/paper-orders?plan=${activePlanId}&limit=40`);
  renderPortfolio(data.portfolio, data.stats);
  if (latestStatus) {
    const planStatus = latestStatus.plans?.[activePlanId] || {};
    renderSizing(planStatus.currentSizing, latestStatus.sizing);
  }
  const orders = data.orders || [];
  if (!pmPaperOrders) return;
  pmPaperOrders.innerHTML = orders.length
    ? `
      <table>
        <thead><tr><th>时间</th><th>周期</th><th>窗口</th><th>方向</th><th>限价</th><th>金额</th><th>结果</th><th>PnL</th><th>退出</th><th>状态</th></tr></thead>
        <tbody>${orders.slice(0, 30).map(renderOrderRow).join('')}</tbody>
      </table>
    `
    : '<div class="accuracy-empty">暂无模拟订单。</div>';
}

function renderOrderSummary(order, timeframe = order.timeframe) {
  return `
    <div class="opt-metrics">
      <span>订单</span><b>${escapeHtml(order.id)}</b>
      <span>周期</span><b>${escapeHtml(timeframe || '--')}</b>
      <span>阶段</span><b>${escapeHtml(order.plan?.phaseLabel || '手动')}</b>
      <span>方向</span><b>${escapeHtml(order.outcome)}</b>
      <span>限价</span><b>${pct(order.limitPrice)}</b>
      <span>金额</span><b>$${formatNumber(order.usd)}</b>
      <span>份额</span><b>${formatNumber(order.shares)}</b>
      ${order.settlementStatus === 'settled'
        ? `<span>盈亏</span><b class="${order.pnl >= 0 ? 'pos' : 'neg'}">${order.pnl >= 0 ? '+' : ''}$${formatNumber(order.pnl)}</b>`
        : ''}
    </div>
  `;
}

function renderOrderRow(order) {
  const resultText = order.settlementStatus === 'settled'
    ? order.won ? '赢' : '输'
    : '待结算';
  const pnlText = order.settlementStatus === 'settled'
    ? `${order.pnl >= 0 ? '+' : ''}$${formatNumber(order.pnl)}`
    : '--';
  const exitText = formatOrderExitLabel(order);
  return `
    <tr>
      <td>${formatTime(order.createdAtIso)}</td>
      <td>${escapeHtml(order.timeframe || '--')}</td>
      <td>${escapeHtml(order.plan?.phaseLabel || '手动')}</td>
      <td>${escapeHtml(order.outcome)}</td>
      <td>${pct(order.limitPrice)}</td>
      <td>$${formatNumber(order.usd)}</td>
      <td class="${order.won ? 'pos' : order.settlementStatus === 'settled' ? 'neg' : ''}">${resultText}</td>
      <td class="${order.pnl >= 0 ? 'pos' : order.pnl < 0 ? 'neg' : ''}">${pnlText}</td>
      <td>${escapeHtml(exitText)}</td>
      <td>${escapeHtml(order.settlementStatus || order.status)}</td>
    </tr>
  `;
}

async function getJson(path) {
  const response = await fetch(path);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

async function postJson(path, payload) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
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
  const trailOffset = Number(
    exitRule?.trailingTakeProfitOffset ?? globalRules?.trailingTakeProfitOffset ?? 0.10
  );
  const entry = Number(action?.limitPrice);
  const tp = Number(action?.takeProfitPrice ?? exitRule?.takeProfitPrice);
  const sl = Number(action?.stopLossPrice ?? exitRule?.stopLossPrice);
  const tpPart = trailingOn
    ? `回撤止盈 最高点 ${offsetLabel(trailOffset).replace('+', '-')}`
    : `TP 入场价 ${offsetLabel(tpOffset)}`;
  const base = `${tpPart} · SL 入场价 ${offsetLabel(slOffset, '-')}`;
  if (!Number.isFinite(entry)) return base;
  const tpPrice = Number.isFinite(tp) ? tp : Math.min(0.99, entry + tpOffset);
  const slPrice = Number.isFinite(sl) ? sl : Math.max(0.01, entry - slOffset);
  if (trailingOn) {
    return `${base}（本轮 SL ${pct(slPrice)} @ ${pct(entry)}）`;
  }
  return `${base}（本轮 TP ${pct(tpPrice)} / SL ${pct(slPrice)} @ ${pct(entry)}）`;
}

function formatOrderExitLabel(order) {
  const entry = Number(order.limitPrice ?? order.entryPrice);
  const exit = Number(order.exitPrice);
  switch (order.exitStatus) {
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

function pct(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(2)}%` : '--';
}

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  return `$${formatNumber(number)}`;
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  return number.toLocaleString('en-US', { maximumFractionDigits: number < 1 ? 8 : 2 });
}

function formatTime(value) {
  if (!value) return '--';
  return new Date(value).toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function shortAddress(value) {
  if (!value) return '--';
  const text = String(value);
  return text.length > 14 ? `${text.slice(0, 6)}...${text.slice(-4)}` : text;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));
}
