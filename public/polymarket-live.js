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
const pmLiveControlMode = document.querySelector('#pmLiveControlMode');
const pmLiveAutoMode = document.querySelector('#pmLiveAutoMode');
const pmLiveAutoPlan = document.querySelector('#pmLiveAutoPlan');
const pmLiveStartBalance = document.querySelector('#pmLiveStartBalance');
const pmLiveCurrentBalance = document.querySelector('#pmLiveCurrentBalance');
const pmLiveReturn = document.querySelector('#pmLiveReturn');
const pmLiveControl = document.querySelector('#pmLiveControl');
const pmLiveControlText = document.querySelector('#pmLiveControlText');
const pmLiveControlDetail = document.querySelector('#pmLiveControlDetail');
const pmLiveControlStart = document.querySelector('#pmLiveControlStart');
const pmLiveControlStop = document.querySelector('#pmLiveControlStop');
const pmLiveAutoForm = document.querySelector('#pmLiveAutoForm');
const pmLiveAutoStatus = document.querySelector('#pmLiveAutoStatus');
const pmLiveAutoText = document.querySelector('#pmLiveAutoText');
const pmLiveAutoDetail = document.querySelector('#pmLiveAutoDetail');
const pmLiveAutoStopAll = document.querySelector('#pmLiveAutoStopAll');
document.querySelector('.pm-live-plan-toggle[data-plan-id="plan2"]')?.remove();
const pmLiveAutoPlanButtons = document.querySelectorAll('.pm-live-plan-toggle:not(.pm-live-symbol-toggle)');
const pmLiveSymbolButtons = document.querySelectorAll('.pm-live-symbol-toggle');
const pmPlan3DailyLossLimitToggle = document.querySelector('#pmPlan3DailyLossLimitToggle');
const pmPlan3DailyLossLimitDetail = document.querySelector('#pmPlan3DailyLossLimitDetail');
const pmReadiness = document.querySelector('#pmReadiness');
const pmDepositWallet = document.querySelector('#pmDepositWallet');
const pmLiveOrders = document.querySelector('#pmLiveOrders');
const pmReadinessRefresh = document.querySelector('#pmReadinessRefresh');
const pmDepositWalletRefresh = document.querySelector('#pmDepositWalletRefresh');
const pmLiveOrdersRefresh = document.querySelector('#pmLiveOrdersRefresh');
const pmLivePlanPreview = document.querySelector('#pmLivePlanPreview');

pmReadinessRefresh?.addEventListener('click', refreshReadiness);
pmDepositWalletRefresh?.addEventListener('click', refreshDepositWallet);
pmLiveOrdersRefresh?.addEventListener('click', refreshLiveOrders);
pmLiveControlStart?.addEventListener('click', startLiveControl);
pmLiveControlStop?.addEventListener('click', stopLiveControl);
pmLiveAutoStopAll?.addEventListener('click', stopAllLiveAuto);
pmPlan3DailyLossLimitToggle?.addEventListener('click', togglePlan3DailyLossLimit);
for (const button of pmLiveAutoPlanButtons) {
  button.addEventListener('click', () => toggleLiveAutoPlan(button.dataset.planId));
}
for (const button of pmLiveSymbolButtons) {
  button.addEventListener('click', () => toggleLiveSymbol(button));
}
pmLiveAutoForm?.querySelector('[name="timeframes"]')?.addEventListener('change', onLiveAutoTimeframesChange);


let latestLiveStatus = null;
let latestLiveAuto = null;
/** 按 plan 隔离：某个 plan 启停失败/慢，不堵死其它 plan 与币种点击 */
const liveAutoToggleBusyPlans = new Set();
/** 仅抑制轮询回写，绝不拦截币种点击 */
let liveSymbolSyncGuard = false;
let liveSymbolWriteSeq = 0;
let liveRiskToggleBusy = false;
let liveOrdersRefreshBusy = false;
let livePlanPreviewBusy = false;
let livePageRefreshBusy = false;
let livePlanPreviewLastRunAtMs = 0;
let liveStopAllBusy = false;
const LIVE_PLAN_BUSY_SAFETY_MS = 20000;

const LIVE_PLAN_LABELS = {
  plan1: 'Plan1',
  plan2: 'Plan2',
  plan2_5: 'Plan2.5',
  plan2_6: 'Plan2.6',
  plan11: 'Plan11',
  plan12: 'Plan12',
  plan13: 'Plan13',
  plan3: 'Plan3',
  plan3_6: 'Plan3.6',
  plan4: 'Plan4',
  plan5: 'Plan5',
  plan8: 'Plan8',
  plan9: 'Plan9'
};
function isLiveAutoToggleBusy() {
  return liveStopAllBusy || liveAutoToggleBusyPlans.size > 0;
}

function isLiveInteractiveBusy() {
  // 交互中跳过轮询回写；币种用 syncGuard（不挡点击），Plan 用 per-plan busy
  return isLiveAutoToggleBusy() || liveSymbolSyncGuard;
}

await refreshAll().catch((error) => {
  if (pmLiveAutoDetail) pmLiveAutoDetail.textContent = `首屏状态加载失败：${error.message}`;
});
setInterval(refreshLivePage, 15000);

async function refreshAll() {
  await Promise.all([refreshStatus(), refreshReadiness(), refreshDepositWallet(), refreshLiveOrders()]);
}

async function refreshLivePage() {
  // 轮询绝不能挡住 Plan/币种点击：交互中直接跳过整页刷新
  if (livePageRefreshBusy || isLiveInteractiveBusy() || document.visibilityState === 'hidden') return;
  livePageRefreshBusy = true;
  try {
    await Promise.all([refreshReadiness(), refreshLiveControl(), refreshLiveAuto(), refreshLiveOrders()]);
  } finally {
    livePageRefreshBusy = false;
  }
}

async function refreshStatus() {
  latestLiveStatus = await getJson('/api/polymarket/status');
  pmStatus.textContent = latestLiveStatus.liveTradingEnabled ? 'Polymarket 实盘下单开关已打开' : 'Polymarket 实盘下单开关关闭';
  pmLiveMode.textContent = latestLiveStatus.liveTradingEnabled ? '实盘允许' : '实盘关闭';
  pmConfigured.textContent = latestLiveStatus.configured ? '已配置' : '未配置';
  renderLiveControl(latestLiveStatus.liveControl || {});
  // 交互中不要用 status 回写覆盖正在切换的 Plan/币种按钮
  if (!isLiveInteractiveBusy()) {
    renderLiveAuto(latestLiveStatus.liveAuto || {}, {
      liveTradingEnabled: latestLiveStatus.liveTradingEnabled,
      configured: latestLiveStatus.configured,
      plan4: latestLiveStatus.plan4,
      plan8: latestLiveStatus.plan8,
      plan9: latestLiveStatus.plan9
    });
  }
}

async function refreshLiveControl() {
  try {
    const data = await getJson('/api/polymarket/live-control');
    renderLiveControl(data.control || {});
  } catch (error) {
    pmLiveControlDetail.textContent = `实盘监控状态读取失败：${error.message}`;
  }
}

async function refreshLiveAuto() {
  if (isLiveInteractiveBusy()) return;
  try {
    const data = await getJson('/api/polymarket/live-auto');
    latestLiveAuto = data;
    renderLiveAuto(data.auto || {}, data);
  } catch (error) {
    pmLiveAutoDetail.textContent = `自动实盘状态读取失败：${error.message}`;
  }
}

async function startLiveControl() {
  pmLiveControlStart.disabled = true;
  try {
    const data = await postJson('/api/polymarket/live-control/start', {});
    renderLiveControl(data.control || {});
    await refreshLiveOrders();
  } catch (error) {
    pmLiveControlDetail.textContent = `开启失败：${error.message}`;
  } finally {
    pmLiveControlStart.disabled = false;
  }
}

async function stopLiveControl() {
  pmLiveControlStop.disabled = true;
  try {
    const data = await postJson('/api/polymarket/live-control/stop', {});
    renderLiveControl(data.control || {});
    await refreshLiveOrders();
  } catch (error) {
    pmLiveControlDetail.textContent = `停止失败：${error.message}`;
  } finally {
    pmLiveControlStop.disabled = false;
  }
}

function liveAutoFormValues() {
  const form = pmLiveAutoForm;
  if (!form) return { timeframes: ['5m', '15m'], symbols: ['BTC-USD'] };
  const data = new FormData(form);
  const tf = data.get('timeframes') || 'both';
  const timeframes = tf === 'both' ? ['5m', '15m'] : [tf];
  return { timeframes, symbols: selectedLiveSymbols() };
}

function selectedLiveSymbols() {
  const symbols = [...pmLiveSymbolButtons]
    .filter((button) => button.classList.contains('active'))
    .map((button) => button.dataset.symbol)
    .filter(Boolean);
  return symbols.length ? symbols : ['BTC-USD'];
}

function paintLiveSymbolSummary(symbols) {
  const list = symbols?.length ? symbols : selectedLiveSymbols();
  const symbolLabel = list.map(shortSymbol).join('/');
  const auto = latestLiveAuto?.auto || {};
  const enabledPlans = auto.enabledPlans || [];
  if (pmLiveAutoPlan && enabledPlans.length) {
    const planLabel = enabledPlans.map((id) => LIVE_PLAN_LABELS[id] || id).join(' + ') || '--';
    pmLiveAutoPlan.textContent = `${planLabel} · ${symbolLabel} · ${formatLiveAutoTimeframes(auto, enabledPlans)}`;
  }
  return symbolLabel;
}

async function persistLiveAutoSymbols(symbols, { seq = null } = {}) {
  // 优先单一写入口；失败时对已启用 plan 用 allSettled 补写，单个失败不回滚其它 plan / 本地选型
  try {
    const data = await postJson('/api/polymarket/live-auto/symbols', { symbols }, { timeoutMs: 12000 });
    if (seq != null && seq !== liveSymbolWriteSeq) return { ok: true, stale: true, auto: data.auto || null };
    latestLiveAuto = { ...(latestLiveAuto || {}), auto: data.auto || {} };
    if (latestLiveAuto.auto) latestLiveAuto.auto.symbols = symbols;
    return { ok: true, stale: false, auto: latestLiveAuto.auto };
  } catch (symbolsError) {
    const enabledPlans = (latestLiveAuto?.auto?.enabledPlans || []).filter(Boolean);
    if (!enabledPlans.length) throw symbolsError;
    const values = { ...liveAutoFormValues(), symbols };
    const settled = await Promise.allSettled(
      enabledPlans.map((planId) => postJson('/api/polymarket/live-auto/start', { planId, ...values }, { timeoutMs: 12000 }))
    );
    if (seq != null && seq !== liveSymbolWriteSeq) return { ok: true, stale: true, auto: null };
    const rejected = settled.filter((item) => item.status === 'rejected');
    const fulfilled = settled.filter((item) => item.status === 'fulfilled');
    if (fulfilled.length) {
      const last = fulfilled[fulfilled.length - 1].value;
      latestLiveAuto = { ...(latestLiveAuto || {}), auto: last.auto || latestLiveAuto?.auto || {} };
      if (latestLiveAuto.auto) latestLiveAuto.auto.symbols = symbols;
    }
    if (rejected.length === settled.length) {
      throw rejected[0].reason instanceof Error ? rejected[0].reason : symbolsError;
    }
    if (rejected.length && pmLiveAutoDetail) {
      const msg = rejected[0].reason?.message || String(rejected[0].reason || 'unknown');
      pmLiveAutoDetail.textContent = `币种已写入；部分 plan 同步失败（未回滚）：${msg}`;
    }
    return { ok: true, stale: false, auto: latestLiveAuto?.auto || null, partial: rejected.length > 0 };
  }
}

async function toggleLiveSymbol(button) {
  if (!button) return;
  const wasActive = button.classList.contains('active');
  // 至少保留一个币种
  if (wasActive && selectedLiveSymbols().length <= 1) return;
  // 本地即时：先改 UI，绝不因 busy/写请求挡住其它币种点击
  button.classList.toggle('active', !wasActive);
  button.setAttribute('aria-pressed', String(!wasActive));
  const symbols = selectedLiveSymbols();
  liveSymbolSyncGuard = true;
  const seq = ++liveSymbolWriteSeq;
  if (!latestLiveAuto) latestLiveAuto = { auto: {} };
  if (!latestLiveAuto.auto) latestLiveAuto.auto = {};
  latestLiveAuto.auto.symbols = symbols;
  const symbolLabel = paintLiveSymbolSummary(symbols);
  if (pmLiveAutoDetail) pmLiveAutoDetail.textContent = `币种已选：${symbolLabel}`;
  try {
    const result = await persistLiveAutoSymbols(symbols, { seq });
    if (result.stale) return;
    if (!result.partial && pmLiveAutoDetail) {
      pmLiveAutoDetail.textContent = `币种已更新：${paintLiveSymbolSummary(symbols)}`;
    }
  } catch (error) {
    if (seq !== liveSymbolWriteSeq) return;
    // 仅在仍是最新一次点击时回滚该按钮；其它已选币种保留
    button.classList.toggle('active', wasActive);
    button.setAttribute('aria-pressed', String(wasActive));
    const rolled = selectedLiveSymbols();
    if (latestLiveAuto?.auto) latestLiveAuto.auto.symbols = rolled;
    paintLiveSymbolSummary(rolled);
    if (pmLiveAutoDetail) pmLiveAutoDetail.textContent = `币种更新失败：${error.message}`;
  } finally {
    if (seq === liveSymbolWriteSeq) liveSymbolSyncGuard = false;
  }
}

function syncLiveSymbolButtons(auto = {}) {
  if (liveSymbolSyncGuard) return;
  const symbols = auto.symbols?.length ? auto.symbols : null;
  if (!symbols) return;
  for (const button of pmLiveSymbolButtons) {
    const active = symbols.includes(button.dataset.symbol);
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

function shortSymbol(symbol) {
  return String(symbol || '').replace('-USD', '') || '--';
}

async function toggleLiveAutoPlan(planId) {
  if (!planId || liveStopAllBusy || liveAutoToggleBusyPlans.has(planId)) return;
  const auto = latestLiveAuto?.auto || {};
  const enabledPlans = auto.enabledPlans || [];
  const running = enabledPlans.includes(planId);
  const optimisticPlans = running
    ? enabledPlans.filter((id) => id !== planId)
    : [...enabledPlans.filter((id) => id !== planId), planId];
  liveAutoToggleBusyPlans.add(planId);
  // 乐观 UI：立刻反映启停，避免“点了没反应”
  if (!latestLiveAuto) latestLiveAuto = { auto: {} };
  latestLiveAuto.auto = {
    ...(latestLiveAuto.auto || auto),
    enabled: optimisticPlans.length > 0,
    enabledPlans: optimisticPlans
  };
  setLiveAutoPlanButtonsBusy(true, planId);
  renderLiveAutoPlanButtons(latestLiveAuto.auto, {
    liveTradingEnabled: latestLiveAuto.liveTradingEnabled ?? latestLiveStatus?.liveTradingEnabled ?? true,
    configured: latestLiveAuto.configured ?? latestLiveStatus?.configured
  });
  const busySafety = setTimeout(() => {
    if (!liveAutoToggleBusyPlans.has(planId)) return;
    liveAutoToggleBusyPlans.delete(planId);
    setLiveAutoPlanButtonsBusy(false);
    renderLiveAutoPlanButtons(latestLiveAuto?.auto || {}, latestLiveAuto || latestLiveStatus || {});
    if (pmLiveAutoDetail) {
      pmLiveAutoDetail.textContent = `${LIVE_PLAN_LABELS[planId] || planId} 启停超时，已解锁按钮（请刷新状态后重试）`;
    }
  }, LIVE_PLAN_BUSY_SAFETY_MS);
  try {
    const values = liveAutoFormValues();
    const data = running
      ? await postJson('/api/polymarket/live-auto/stop', { planId }, { timeoutMs: 12000 })
      : await postJson('/api/polymarket/live-auto/start', { planId, ...values }, { timeoutMs: 12000 });
    latestLiveAuto = { ...(latestLiveAuto || {}), auto: data.auto || {} };
    renderLiveAuto(data.auto || {}, latestLiveAuto || {});
    if (!running) {
      if (data.deferredTick) {
        pmLiveAutoDetail.textContent = `${LIVE_PLAN_LABELS[planId] || planId} 已启动（首轮检查后台进行中）`;
      } else if (data.tick) {
        renderLiveAutoTickPreview(data.tick);
      }
    }
    // 启停秒回：订单/status 后台刷，不 await，避免堵死点击
    void refreshLiveOrders().catch(() => {});
    void refreshStatus().catch(() => {});
  } catch (error) {
    latestLiveAuto.auto = {
      ...(latestLiveAuto.auto || auto),
      enabled: enabledPlans.length > 0,
      enabledPlans
    };
    pmLiveAutoDetail.textContent = `${running ? '停止' : '启动'} ${LIVE_PLAN_LABELS[planId] || planId} 失败：${error.message}`;
  } finally {
    clearTimeout(busySafety);
    liveAutoToggleBusyPlans.delete(planId);
    setLiveAutoPlanButtonsBusy(false);
    renderLiveAutoPlanButtons(latestLiveAuto?.auto || {}, latestLiveAuto || latestLiveStatus || {});
  }
}

async function stopAllLiveAuto() {
  if (liveStopAllBusy || isLiveAutoToggleBusy()) return;
  liveStopAllBusy = true;
  pmLiveAutoStopAll.disabled = true;
  try {
    const data = await postJson('/api/polymarket/live-auto/stop', {}, { timeoutMs: 15000 });
    latestLiveAuto = { ...(latestLiveAuto || {}), auto: data.auto || {} };
    renderLiveAuto(data.auto || {}, latestLiveAuto || {});
    pmLivePlanPreview.innerHTML = '<div class="accuracy-empty">全部自动实盘已停止。</div>';
    void refreshStatus().catch(() => {});
  } catch (error) {
    pmLiveAutoDetail.textContent = `全部停止失败：${error.message}`;
  } finally {
    liveStopAllBusy = false;
    pmLiveAutoStopAll.disabled = false;
    renderLiveAutoPlanButtons(latestLiveAuto?.auto || {}, latestLiveAuto || latestLiveStatus || {});
  }
}

async function togglePlan3DailyLossLimit() {
  if (liveRiskToggleBusy) return;
  const controls = latestLiveAuto?.auto?.riskControls || latestLiveStatus?.liveAuto?.riskControls || {};
  const enabled = controls.globalDailyLossProtectionEnabled
    ?? (controls.plan3DailyLossLimitEnabled !== false);
  liveRiskToggleBusy = true;
  if (pmPlan3DailyLossLimitToggle) pmPlan3DailyLossLimitToggle.disabled = true;
  try {
    const data = await postJson('/api/polymarket/live-auto/risk-controls', {
      globalDailyLossProtectionEnabled: !enabled
    });
    latestLiveAuto = { ...(latestLiveAuto || {}), auto: data.auto || {} };
    renderLiveAuto(data.auto || {}, latestLiveAuto || {});
    await Promise.all([refreshStatus(), refreshLiveOrders()]);
  } catch (error) {
    pmLiveAutoDetail.textContent = `全策略日亏损保护切换失败：${error.message}`;
  } finally {
    liveRiskToggleBusy = false;
    if (pmPlan3DailyLossLimitToggle) pmPlan3DailyLossLimitToggle.disabled = false;
  }
}

async function onLiveAutoTimeframesChange() {
  const auto = latestLiveAuto?.auto || {};
  if (!auto.enabled) return;
  const values = liveAutoFormValues();
  try {
    const data = await postJson('/api/polymarket/live-auto/timeframes', { timeframes: values.timeframes });
    latestLiveAuto = { ...(latestLiveAuto || {}), auto: data.auto || {} };
    renderLiveAuto(data.auto || {}, latestLiveAuto || {});
    pmLiveAutoDetail.textContent = `周期已更新：${formatLiveAutoTimeframes(data.auto || {}, data.auto?.enabledPlans || [])}`;
  } catch (error) {
    pmLiveAutoDetail.textContent = `周期更新失败：${error.message}`;
  }
}

function setLiveAutoPlanButtonsBusy(_busy, _activePlanId = null) {
  // 按 plan 隔离：只禁用正在启停的 plan，其它 plan / 币种保持可点
  for (const button of pmLiveAutoPlanButtons) {
    const planId = button.dataset.planId;
    const toggling = liveAutoToggleBusyPlans.has(planId) || liveStopAllBusy;
    button.disabled = toggling;
  }
  if (pmLiveAutoStopAll) {
    const running = (latestLiveAuto?.auto?.enabledPlans || []).length > 0;
    pmLiveAutoStopAll.disabled = liveStopAllBusy || isLiveAutoToggleBusy() || !running;
  }
}

function renderLiveControl(control = {}) {
  const running = Boolean(control.enabled);
  const currentBalance = Number(control.currentBalanceUsdc) || 0;
  const stats = control.stats || {};
  const investedUsd = Number(stats.investedUsd) || 0;
  const pnl = Number(control.pnlUsdc ?? stats.realizedPnl) || 0;
  const totalReturn = Number(control.totalReturn ?? stats.totalReturn) || 0;
  const settledTrades = Number(stats.settledTrades) || 0;
  const winRate = Number(stats.winRate) || 0;

  pmLiveControl?.classList.toggle('running', running);
  pmLiveControl?.classList.toggle('stopped', !running);
  pmLiveControlText.textContent = running ? '实盘监控已开启' : '实盘监控未开启';
  pmLiveControlDetail.textContent = running
    ? `交易PnL ${formatSignedUsd(pnl)}，收益率 ${formatSignedPercent(totalReturn)}，已结 ${settledTrades} 单，胜率 ${formatPercent(winRate)}。CLOB余额 ${money(currentBalance)}，充值/提现不计入收益率。`
    : '开启后按真实成交记录统计收益率；充值和提现不会计入交易收益。';
  pmLiveControlMode.textContent = running ? '已开启' : '未开启';
  pmLiveControlMode.className = running ? 'pos' : '';
  pmLiveStartBalance.textContent = investedUsd ? money(investedUsd) : '--';
  pmLiveCurrentBalance.textContent = formatSignedUsd(pnl);
  pmLiveCurrentBalance.className = pnl >= 0 ? 'pos' : 'neg';
  pmLiveReturn.textContent = investedUsd ? formatSignedPercent(totalReturn) : '--';
  pmLiveReturn.className = totalReturn >= 0 ? 'pos' : 'neg';
  pmLiveControlStart.disabled = running;
  pmLiveControlStop.disabled = !running;
}
function renderLiveAuto(auto = {}, meta = {}) {
  const coreEnabledPlans = auto.enabledPlans || [];
  const enabledPlans = [...coreEnabledPlans];
  if (meta.plan4?.live?.enabled && !enabledPlans.includes('plan4')) enabledPlans.push('plan4');
  if (meta.plan8?.live?.enabled && !enabledPlans.includes('plan8')) enabledPlans.push('plan8');
  if (meta.plan9?.live?.enabled && !enabledPlans.includes('plan9')) enabledPlans.push('plan9');
  const running = enabledPlans.length > 0;
  const tfLabel = formatLiveAutoTimeframes(auto, enabledPlans);
  const planLabel = enabledPlans.map((planId) => LIVE_PLAN_LABELS[planId] || planId).join(' + ');
  const symbolLabel = (auto.symbols?.length ? auto.symbols : ['BTC-USD']).map(shortSymbol).join('/');
  const independentOnly = !coreEnabledPlans.length
    && enabledPlans.length
    && enabledPlans.every((id) => id === 'plan4' || id === 'plan8' || id === 'plan9');

  pmLiveAutoStatus?.classList.toggle('running', running);
  pmLiveAutoStatus?.classList.toggle('stopped', !running);
  pmLiveAutoText.textContent = running ? '运行中' : '已停止';
  pmLiveAutoMode.textContent = running ? '运行中' : '已停止';
  pmLiveAutoMode.className = running ? 'pos' : '';
  pmLiveAutoPlan.textContent = running ? `${planLabel} · ${symbolLabel} · ${tfLabel}` : '--';
  renderPlan3DailyLossLimitControl(auto);
  syncLiveSymbolButtons(auto);

  if (running) {
    if (independentOnly) {
      const parts = enabledPlans.map((planId) => {
        const snap = meta[planId] || {};
        const live = snap.live || {};
        const lastRun = snap.lastTickAtIso ? formatTime(snap.lastTickAtIso) : '--';
        const label = LIVE_PLAN_LABELS[planId] || planId;
        return live.armed
          ? `${label} 运行中 · 上次扫描 ${lastRun} · 已提交 ${Number(live.realOrdersSubmitted || 0)} 笔`
          : `${label} 等待门槛 · ${live.reason || '等待下一轮扫描'}`;
      });
      pmLiveAutoDetail.textContent = parts.join('；');
    } else {
      const lastRun = auto.lastRunAtIso ? formatTime(auto.lastRunAtIso) : '--';
      const action = auto.lastAction || '等待';
      const reason = auto.lastReason || '等待首次检查';
      pmLiveAutoDetail.textContent = `上次检查 ${lastRun} · ${action} · ${reason}`;
    }
    syncLiveAutoForm(auto);
    renderLiveAutoPlanButtons(auto, meta);
    if (!isLiveInteractiveBusy()) {
      refreshLivePlanPreview(auto);
    }
  } else if (!meta.liveTradingEnabled) {
    pmLiveAutoDetail.textContent = '后端实盘开关关闭，需设置 POLYMARKET_LIVE_TRADING_ENABLED=true。';
    renderLiveAutoPlanButtons(auto, meta);
  } else if (meta.ready === false) {
    pmLiveAutoDetail.textContent = '实盘 API 未就绪，请先完成凭证与余额检查。';
    renderLiveAutoPlanButtons(auto, meta);
  } else {
    pmLiveAutoDetail.textContent = '点击 Plan 按钮启动对应策略，可同时启动多个 Plan；币种按钮可多选。';
    renderLiveAutoPlanButtons(auto, meta);
  }

  if (pmLiveAutoStopAll) {
    pmLiveAutoStopAll.disabled = !running || isLiveAutoToggleBusy();
  }
  if (pmLiveAutoForm) {
    const tfSelect = pmLiveAutoForm.querySelector('[name="timeframes"]');
    if (tfSelect) tfSelect.disabled = !meta.liveTradingEnabled;
  }
  // 币种与 Plan 启停互不阻塞；仅当整批 symbol 写请求进行中时保持当前禁用态由 toggle 自己管
  if (!liveSymbolSyncGuard) {
    for (const button of pmLiveSymbolButtons) {
      button.disabled = false;
    }
  }
}

function renderPlan3DailyLossLimitControl(auto = {}) {
  const controls = auto.riskControls || {};
  const enabled = controls.globalDailyLossProtectionEnabled
    ?? (controls.plan3DailyLossLimitEnabled !== false);
  if (pmPlan3DailyLossLimitToggle) {
    pmPlan3DailyLossLimitToggle.textContent = enabled ? '保护开启' : '保护关闭';
    pmPlan3DailyLossLimitToggle.classList.toggle('danger', !enabled);
    pmPlan3DailyLossLimitToggle.disabled = liveRiskToggleBusy;
  }
  if (pmPlan3DailyLossLimitDetail) {
    pmPlan3DailyLossLimitDetail.textContent = enabled
      ? '达到当天整体实盘亏损上限后停止所有 Plan 新开仓；平仓和止损继续运行。'
      : '已关闭：所有 Plan 忽略整体日亏损上限，其他风控仍生效。';
    pmPlan3DailyLossLimitDetail.className = enabled ? '' : 'neg';
  }
}

function renderLiveAutoPlanButtons(auto = {}, meta = {}) {
  const enabledPlans = auto.enabledPlans || [];
  const plans = auto.plans || {};
  for (const button of pmLiveAutoPlanButtons) {
    const planId = button.dataset.planId;
    if (planId === 'plan4' || planId === 'plan8' || planId === 'plan9') {
      const snapshot = meta[planId] || latestLiveAuto?.[planId] || latestLiveStatus?.[planId] || {};
      const live = snapshot.live || {};
      const active = live.enabled === true;
      const toggling = liveAutoToggleBusyPlans.has(planId);
      const stateEl = button.querySelector('.pm-live-plan-toggle-state');
      const label = LIVE_PLAN_LABELS[planId] || planId;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.disabled = !meta.liveTradingEnabled || liveStopAllBusy || toggling;
      button.title = live.lastError || live.reason || `${label} 独立实盘执行器`;
      if (stateEl) {
        stateEl.textContent = toggling
          ? (active ? '停止中...' : '启动中...')
          : active && live.armed
            ? `运行中 · ${Number(live.realOrdersSubmitted || 0)} 笔`
            : active
              ? `已开启 · 等待门槛 ${Number(live.confirmedSamples || 0)}/${Number(live.requiredSamples || 0)}`
              : '点击启动';
      }
      continue;
    }
    const active = enabledPlans.includes(planId);
    const planRun = plans[planId] || {};
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    // 仅禁用「本 plan 正在启停」或全部停止中；其它 plan 可并行点
    button.disabled = !meta.liveTradingEnabled
      || liveStopAllBusy
      || liveAutoToggleBusyPlans.has(planId);
    const stateEl = button.querySelector('.pm-live-plan-toggle-state');
    if (stateEl) {
      if (liveAutoToggleBusyPlans.has(planId)) {
        stateEl.textContent = active ? '停止中…' : '启动中…';
      } else if (active && planRun.lastAction) {
        stateEl.textContent = `${planRun.lastAction}${planRun.lastReason ? ` · ${planRun.lastReason}` : ''}`;
      } else {
        stateEl.textContent = active ? '运行中' : '点击启动';
      }
    }
  }
}

function syncLiveAutoForm(auto = {}) {
  if (!pmLiveAutoForm) return;
  const tfSelect = pmLiveAutoForm.querySelector('[name="timeframes"]');
  if (tfSelect && auto.timeframes) {
    const tfs = auto.timeframes;
    if (tfs.length === 2) tfSelect.value = 'both';
    else if (tfs.includes('5m')) tfSelect.value = '5m';
    else tfSelect.value = '15m';
  }
  syncLiveSymbolButtons(auto);
}

function resolveLivePlanRun(auto = {}, planId) {
  return auto.planRuns?.[planId] || auto.plans?.[planId] || {};
}

function formatLivePreviewFetchError(error) {
  const name = error?.name || '';
  const message = String(error?.message || '');
  if (name === 'TimeoutError' || name === 'AbortError' || /timed out|aborted/i.test(message)) {
    return '预览超时（策略仍在后台跑，以下为最近实盘动作）';
  }
  return message || '预览失败';
}

function renderLivePlanRunStatusCard(auto = {}, planId) {
  const run = resolveLivePlanRun(auto, planId);
  const label = LIVE_PLAN_LABELS[planId] || planId;
  const action = run.lastAction || auto.lastAction || '等待';
  const reason = run.lastReason || auto.lastReason || '等待首次检查';
  const lastRun = run.lastRunAtIso || auto.lastRunAtIso;
  const blocked = !['submitted', 'pending', 'filled', 'started'].includes(String(action));
  return `
    <div class="pm-readiness-summary ${blocked ? 'blocked' : 'ready'}">
      <strong>${escapeHtml(label)} · 最近动作 ${escapeHtml(action)}</strong>
      <span>${escapeHtml(reason)}${lastRun ? ` · ${escapeHtml(formatTime(lastRun))}` : ''}</span>
    </div>`;
}

async function refreshLivePlanPreview(auto = {}) {
  if (!pmLivePlanPreview || !auto.enabled || livePlanPreviewBusy || isLiveInteractiveBusy()) return;
  if (Date.now() - livePlanPreviewLastRunAtMs < 45_000) return;
  livePlanPreviewLastRunAtMs = Date.now();
  const enabledPlans = auto.enabledPlans || [];
  if (!enabledPlans.length) {
    pmLivePlanPreview.innerHTML = '<div class="accuracy-empty">暂无运行中的 Plan。</div>';
    return;
  }
  // 先展示 planRuns，避免 heavy live-plan 超时被误读成「没信号」
  pmLivePlanPreview.innerHTML = enabledPlans.map((planId) => renderLivePlanRunStatusCard(auto, planId)).join('');
  livePlanPreviewBusy = true;
  const symbols = auto.symbols?.length ? auto.symbols : ['BTC-USD'];
  const timeframeBase = (auto.timeframes || ['15m']).find((item) => item === '5m' || item === '15m') || '15m';
  const jobs = [];
  for (const planId of enabledPlans) {
    // Plan1 预览含 basket/行情，易拖垮连接池；状态卡已够用
    if (planId === 'plan1') continue;
    const timeframe = timeframeBase;
    const planSymbols = symbols.slice(0, 1);
    for (const symbol of planSymbols) {
      jobs.push({ planId, timeframe, symbol });
    }
  }
  try {
    if (!jobs.length) return;
    const previews = [];
    const concurrency = 1;
    for (let i = 0; i < jobs.length; i += concurrency) {
      if (isLiveInteractiveBusy()) break;
      const batch = jobs.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map(async ({ planId, timeframe, symbol }) => {
        try {
          const params = new URLSearchParams({ symbol, plan: planId, timeframe });
          const data = await getJson(`/api/polymarket/live-plan?${params.toString()}`, {
            retries: 0,
            timeoutMs: 20000
          });
          return { planId, symbol, data, error: null };
        } catch (error) {
          return { planId, symbol, data: null, error };
        }
      }));
      previews.push(...batchResults);
    }
    if (!previews.length) return;
    const statusCards = enabledPlans.map((planId) => renderLivePlanRunStatusCard(auto, planId)).join('');
    const detailCards = previews.map(({ planId, symbol, data, error }) => {
      if (error) {
        return `<div class="pm-readiness-summary blocked"><strong>${escapeHtml(LIVE_PLAN_LABELS[planId] || planId)} · ${escapeHtml(shortSymbol(symbol))}</strong><span>${escapeHtml(formatLivePreviewFetchError(error))}</span></div>`;
      }
      return renderLivePlanPreviewBlock(data, auto, planId, symbol);
    }).join('');
    pmLivePlanPreview.innerHTML = `${statusCards}${detailCards}`;
  } finally {
    livePlanPreviewBusy = false;
  }
}

function renderLiveAutoTickPreview(tick = {}) {
  if (!pmLivePlanPreview) return;
  const ticks = tick.ticks || [];
  if (!ticks.length) {
    pmLivePlanPreview.innerHTML = '<div class="accuracy-empty">本次检查无窗口需要处理。</div>';
    return;
  }
  pmLivePlanPreview.innerHTML = ticks.map(renderTickRow).join('');
}

function renderTickRow(tick = {}) {
  const action = tick.plan?.action || {};
  const status = tick.executed ? '已提交' : tick.scheduled ? '已调度' : '跳过';
  const reason = tick.reason || tick.record?.error || action.reason || '--';
  const planLabel = LIVE_PLAN_LABELS[tick.planId] || tick.planId || '--';
  const symbolLabel = tick.symbol ? ` · ${shortSymbol(tick.symbol)}` : '';
  return `
    <div class="pm-readiness-summary ${tick.executed ? 'ready' : 'blocked'}">
      <strong>${escapeHtml(planLabel)}${escapeHtml(symbolLabel)} · ${escapeHtml(tick.timeframe || '--')} · ${status}</strong>
      <span>${escapeHtml(reason)}</span>
    </div>`;
}

function renderLivePlanPreviewBlock(data = {}, auto = {}, planId = auto.planId, symbol = null) {
  const preview = data.preview || {};
  const draft = preview.draft;
  const action = preview.plan?.action || data.planView?.plan?.action || {};
  const planRun = resolveLivePlanRun(auto, planId);
  const headLabel = `${LIVE_PLAN_LABELS[planId] || planId}${symbol ? ` · ${shortSymbol(symbol)}` : ''}`;
  const autoLine = planRun.lastAction
    ? `<div class="pm-market-grid"><span>${escapeHtml(headLabel)} 最近动作</span><b>${escapeHtml(planRun.lastAction)}</b><span>说明</span><b>${escapeHtml(planRun.lastReason || '--')}</b></div>`
    : '';
  if (!preview.ready || !draft) {
    return `
      ${autoLine}
      <div class="pm-readiness-summary blocked">
        <strong>${escapeHtml(headLabel)} · 当前窗口不可下单</strong>
        <span>${escapeHtml(preview.blockedReason || action.reason || '计划未就绪')}</span>
      </div>
      <div class="pm-market-grid">
        <span>方向</span><b>${action.shouldTrade ? escapeHtml(action.label || action.direction || '--') : '跳过'}</b>
      </div>`;
  }
  return `
    ${autoLine}
    <div class="pm-readiness-summary ready">
      <strong>${escapeHtml(headLabel)} · 下一单草稿预览</strong>
      <span>单笔上限 ${money(data.liveMaxOrderUsd || draft.liveMaxOrderUsd)} · CLOB 余额 ${money(data.clobBalanceUsdc || 0)}</span>
    </div>
    <div class="pm-market-grid">
      <span>市场</span><b>${escapeHtml(draft.market || draft.marketSlug || '--')}</b>
      <span>方向</span><b>${escapeHtml(draft.outcome || draft.direction || '--')}</b>
      <span>限价</span><b>${pct(draft.limitPrice)}</b>
      <span>金额 USD</span><b>${money(draft.usd)}</b>
      <span>窗口</span><b>${escapeHtml(draft.timeframe || '--')} · ${formatTime(draft.slotIso)}</b>
    </div>`;
}

function renderLivePlanPreview(data = {}, auto = {}) {
  pmLivePlanPreview.innerHTML = renderLivePlanPreviewBlock(data, auto, data.planId || auto.planId);
}

async function refreshReadiness() {
  if (!pmReadiness) return;
  pmReadiness.innerHTML = '<div class="accuracy-empty">检查中...</div>';
  try {
    const data = await getJson('/api/polymarket/readiness');
    renderLiveSummary(data);
    renderReadiness(data);
  } catch (error) {
    pmReadiness.innerHTML = `<div class="accuracy-empty">检查失败：${escapeHtml(error.message)}</div>`;
  }
}

function renderLiveSummary(data) {
  const clob = data.clob || {};
  const collateral = clob.collateral || {};
  pmLiveBalance.textContent = money(collateral.balanceUsdc || 0);
  pmLiveAllowance.textContent = Number(collateral.allowanceUsdc || 0) > 0 ? '已授权' : '$0';
  pmLiveOpenOrders.textContent = clob.openOrdersCount ?? '--';
  pmLiveClosedOnly.textContent = clob.closedOnly === false ? '未限制' : clob.closedOnly === true ? 'Closed-only' : '--';
  pmLiveFunder.textContent = shortAddress(data.funderAddress);
  pmLiveSigner.textContent = shortAddress(data.signerAddress);
  pmLiveSignatureType.textContent = String(data.signatureType ?? data.currentSignatureType ?? '3 / POLY_1271');
  pmLiveBalance.className = Number(collateral.balanceUsdc || 0) > 0 ? 'pos' : '';
  pmLiveAllowance.className = Number(collateral.allowanceUsdc || 0) > 0 ? 'pos' : 'neg';
  pmLiveClosedOnly.className = clob.closedOnly === false ? 'pos' : clob.closedOnly === true ? 'neg' : '';
}

function renderReadiness(data) {
  const clob = data.clob || {};
  const collateral = clob.collateral || {};
  const profile = data.profile || {};
  const sellApproval = data.conditionalTokenApprovals || {};
  pmReadiness.innerHTML = `
    <div class="pm-readiness-summary ${data.ready ? 'ready' : 'blocked'}">
      <strong>${data.ready ? '实盘 API 已就绪' : '暂不满足实盘条件'}</strong>
      <span>${data.liveTradingEnabled ? '实盘下单开关已开启' : '实盘下单开关关闭'}</span>
    </div>
    <div class="pm-market-grid">
      <span>Signer 钱包</span><b>${shortAddress(data.signerAddress)}</b>
      <span>Profile/Funder</span><b>${shortAddress(data.funderAddress)}</b>
      <span>Profile</span><b>${escapeHtml(profile.pseudonym || profile.name || '--')}</b>
      <span>CLOB 余额</span><b>${money(collateral.balanceUsdc || 0)}</b>
      <span>CLOB 授权</span><b>${Number(collateral.allowanceUsdc || 0) > 0 ? '已授权' : '$0'}</b>
      <span>卖出授权</span><b class="${sellApproval.ready ? 'pos' : 'neg'}">${sellApproval.ready ? '已授权' : '未授权'}</b>
      <span>Open orders</span><b>${clob.openOrdersCount ?? '--'}</b>
      <span>Closed-only</span><b>${clob.closedOnly === false ? '否' : clob.closedOnly === true ? '是' : '--'}</b>
    </div>
    <div class="pm-check-list">
      ${(data.checks || []).map(renderReadinessCheck).join('')}
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
  const clobCollateral = data.clob?.collateral || {};
  pmDepositWallet.innerHTML = `
    <div class="pm-readiness-summary ${data.readyForDepositWallet ? 'ready' : 'blocked'}">
      <strong>${data.readyForDepositWallet ? 'Deposit wallet 已可用于 CLOB' : 'Deposit wallet 还没就绪'}</strong>
      <span>signatureType ${data.currentSignatureType ?? '--'} / 推荐 3</span>
    </div>
    <div class="pm-market-grid">
      <span>Owner signer</span><b>${shortAddress(data.signerAddress)}</b>
      <span>当前 Funder</span><b>${shortAddress(data.currentFunderAddress)}</b>
      <span>Deposit wallet</span><b>${shortAddress(data.configuredDepositWalletAddress)}</b>
      <span>CLOB buying power</span><b>${money(clobCollateral.balanceUsdc || 0)}</b>
      <span>CLOB 授权</span><b>${Number(clobCollateral.allowanceUsdc || 0) > 0 ? '已授权' : '$0'}</b>
      <span>Relayer</span><b>${data.relayerConfigured && data.builderCredentialsConfigured ? '已配置' : '未完整配置'}</b>
      <span>SDK</span><b>${data.sdk?.relayerClient && data.sdk?.clobClientV2 ? '已安装' : '缺 v2/relayer'}</b>
    </div>
    <div class="pm-check-list">
      ${(data.checks || []).map(renderReadinessCheck).join('')}
    </div>
  `;
}

async function refreshLiveOrders() {
  if (!pmLiveOrders || liveOrdersRefreshBusy) return;
  liveOrdersRefreshBusy = true;
  try {
    const data = await getJson('/api/polymarket/live-orders?limit=300&active=1');
    const orders = data.orders || [];
    // API stats are lifetime totals scoped to enabled plans; the 35-row table
    // limit below never affects these figures.
    const stats = data.stats || {};
    const enabledPlans = data.enabledPlans || [];
    const statsHtml = renderLiveOrderStats(stats, enabledPlans);
    pmLiveOrders.innerHTML = orders.length
      ? `
      ${statsHtml}
      ${renderLiveOrdersByPlan(orders, enabledPlans)}
    `
      : `${statsHtml}<div class="accuracy-empty">暂无实盘操作记录。</div>`;
  } catch (error) {
    if (!pmLiveOrders.querySelector('.pm-live-plan-orders')) {
      pmLiveOrders.innerHTML = `<div class="accuracy-empty">实盘记录加载失败：${escapeHtml(error.message)}</div>`;
    }
  } finally {
    liveOrdersRefreshBusy = false;
  }
}

function formatLiveAutoTimeframes(auto = {}, enabledPlans = []) {
  if (enabledPlans.length && enabledPlans.every((id) => id === 'plan4' || id === 'plan8' || id === 'plan9')) {
    return enabledPlans.map((id) => `${LIVE_PLAN_LABELS[id] || id} 固定周期`).join(' + ');
  }
  const tfs = auto.timeframes || ['5m', '15m'];
  return tfs.filter((item) => item === '5m' || item === '15m').join(' + ') || '5m + 15m';
}

function isDustExitStatus(exitStatus) {
  const status = String(exitStatus || '').toLowerCase();
  return status === 'dust-undersized-fill'
    || status === 'dust-unsellable'
    || status.startsWith('dust-');
}

function isDustClosedLiveOrder(order) {
  if (!order || String(order.orderSide || '').toUpperCase() === 'SELL') return false;
  return isDustExitStatus(order.exitStatus);
}

/** Hide synthetic local dust flatten rows — not real CLOB sells / 平仓. */
function isSyntheticDustSellOrder(order) {
  if (!order || String(order.orderSide || '').toUpperCase() !== 'SELL') return false;
  if (order.clobOrderId) return false;
  if (isDustExitStatus(order.exitStatus)) return true;
  const text = `${order.exitReason || ''} ${order.note || ''}`;
  return /灰尘仓|成交过小|dust-undersized|dust-unsellable|无法后续止损卖出|无法 CLOB 卖出|invalid maker amount/i.test(text);
}

/** Hide failed mid-window exit attempts that never hit CLOB (look like fake 止损卖出). */
function isBlockedExitAttemptSell(order) {
  if (!order || String(order.orderSide || '').toUpperCase() !== 'SELL') return false;
  if (String(order.status || '').toLowerCase() !== 'blocked') return false;
  if (order.clobOrderId) return false;
  return /exit blocked/i.test(`${order.note || ''} ${order.error || ''}`);
}

/** 敞口已满 / 余额撑不起最小单：历史「买入拦截」无操作价值，隐藏。 */
function isNoisyStructuralBlockedBuy(order) {
  if (!order || String(order.orderSide || '').toUpperCase() !== 'BUY') return false;
  if (String(order.status || '').toLowerCase() !== 'blocked') return false;
  if (order.clobOrderId) return false;
  const text = `${order.error || ''} ${order.note || ''}`;
  return /余额\/敞口不够最小单|敞口余量|低于 CLOB 最小|不足以满足 CLOB|风控可下单额度不足|按本金风控后.*低于 CLOB|结构性资金不足/.test(text);
}

function shouldHideLiveOrderRow(order) {
  return isSyntheticDustSellOrder(order) || isBlockedExitAttemptSell(order) || isNoisyStructuralBlockedBuy(order);
}

function renderLiveOrdersByPlan(orders = [], enabledPlans = []) {
  const enabled = new Set(enabledPlans);
  return ['plan9', 'plan8', 'plan5', 'plan4', 'plan3_6', 'plan3', 'plan13', 'plan12', 'plan11', 'plan2_6', 'plan2_5', 'plan2', 'plan1']
    .filter((planId) => enabled.has(planId))
    .map((planId) => {
      const planOrders = orders
        .filter((order) => resolveLiveOrderPlanId(order) === planId)
        .filter((order) => !shouldHideLiveOrderRow(order));
      if (!planOrders.length) return '';
      const stopLossByBuyId = indexFilledStopLossSells(planOrders);
      return `
        <section class="pm-live-plan-orders">
          <div class="pm-live-plan-orders-head">
            <strong>${escapeHtml(formatLivePlanLabel(planId))} 实盘记录</strong>
            <span>当前显示 ${Math.min(planOrders.length, 35)} 条；上方统计为全部历史</span>
          </div>
          <table>
            <thead><tr><th>时间</th><th>买卖</th><th>币种</th><th>周期</th><th>方向</th><th>限价</th><th>金额</th><th>结果</th><th>PnL</th><th>收益率</th><th>退出</th><th>状态</th><th>市场</th></tr></thead>
            <tbody>${planOrders.slice(0, 35).map((order) => renderLiveOrderRow(order, stopLossByBuyId)).join('')}</tbody>
          </table>
        </section>`;
    })
    .join('');
}

function renderLiveOrderStats(stats = {}, enabledPlans = []) {
  const pnl = Number(stats.realizedPnl) || 0;
  const invested = Number(stats.investedUsd) || 0;
  const totalReturn = Number(stats.totalReturn) || 0;
  const settled = Number(stats.settledTrades) || 0;
  const wins = Number(stats.wins) || 0;
  const losses = Number(stats.losses) || 0;
  const expiredUnfilled = Number(stats.expiredUnfilled) || 0;
  const byPlan = stats.byPlan || {};
  const enabled = new Set(enabledPlans);
  const planRows = ['plan1', 'plan2', 'plan2_5', 'plan2_6', 'plan11', 'plan12', 'plan13', 'plan3', 'plan3_6', 'plan4', 'plan5', 'plan8', 'plan9']
    .filter((planId) => enabled.has(planId))
    .map((planId) => {
      // 已合并策略的历史记录继续计入当前策略统计。
      const statsForPlan = planId === 'plan3'
        ? mergeLegacyPlanStats(byPlan.plan3, byPlan.plan3_5)
        : byPlan[planId];
      return renderLivePlanStatsChip(planId, statsForPlan);
    })
    .join('');
  return `
    <div class="pm-live-stats-strip">
      <strong>开启 Plan 历史总计</strong>
      <span>已结 ${settled} 单</span>
      <span>胜 ${wins} / 负 ${losses}</span>
      <span>未成交过期 ${expiredUnfilled}</span>
      <span>已结投入 ${money(invested)}</span>
      <strong class="${pnl >= 0 ? 'pos' : 'neg'}">总 PnL ${formatSignedUsd(pnl)}</strong>
      <strong class="${totalReturn >= 0 ? 'pos' : 'neg'}">收益率 ${invested ? formatSignedPercent(totalReturn) : '--'}</strong>
    </div>
    ${planRows ? `<div class="pm-live-stats-by-plan">${planRows}</div>` : ''}`;
}

function renderLivePlanStatsChip(planId, planStats = {}) {
  const settled = Number(planStats.settledTrades) || 0;
  const orderCount = Number(planStats.orderCount) || 0;
  if (!settled && !orderCount) {
    return `<span class="pm-live-plan-stat ${planId} muted">${formatLivePlanLabel(planId)} · 暂无</span>`;
  }
  const pnl = Number(planStats.realizedPnl) || 0;
  const wins = Number(planStats.wins) || 0;
  const losses = Number(planStats.losses) || 0;
  const invested = Number(planStats.investedUsd) || 0;
  const ret = Number(planStats.totalReturn) || 0;
  return `
    <span class="pm-live-plan-stat ${planId}">
      <b>${formatLivePlanLabel(planId)}</b>
      <span>已结 ${settled} · 胜 ${wins}/${losses}</span>
      <strong class="${pnl >= 0 ? 'pos' : 'neg'}">总 PnL ${formatSignedUsd(pnl)}</strong>
      <span class="${ret >= 0 ? 'pos' : 'neg'}">${invested ? formatSignedPercent(ret) : '--'}</span>
    </span>`;
}

function formatLivePlanLabel(planId) {
  const id = String(planId || '').toLowerCase();
  return LIVE_PLAN_LABELS[id] || id || '--';
}

function resolveLiveOrderPlanId(order = {}) {
  const id = String(order.planId || '').toLowerCase();
  if (id === 'plan3_5') return 'plan3';
  if (id === 'plan1' || id === 'plan2' || id === 'plan2_5' || id === 'plan2_6' || id === 'plan11' || id === 'plan12' || id === 'plan13' || id === 'plan3' || id === 'plan3_6' || id === 'plan4' || id === 'plan5' || id === 'plan8' || id === 'plan9') return id;
  const entry = String(order.entryType || '').toLowerCase();
  if (entry === 'pm_spot_edge') return 'plan11';
  if (entry === 'spot_fair_value_residual') return 'plan12';
  if (entry === 'walk_forward_lock_band') return 'plan12';
  if (entry.includes('plan4') || entry.includes('prob-arb') || entry.includes('prob_arb')) return 'plan4';
  if (entry.includes('plan9') || entry.includes('lock-edge')) return 'plan9';
  if (entry === 'pm_lock_strength' || entry === 'pm_lock_add' || entry === 'pre_open') return 'plan5';
  // Historical wallet-follow orders keep plan4 attribution.
  if (entry === 'wallet_follow' || entry === 'wallet_follow_add') return 'plan4';
  if (entry === 'last_minute_99') return 'plan3';
  if (entry === 'cheap_side_20c' || entry === 'cheap_side_10_20c' || entry === 'cheap_side_5_10c') return 'plan3_6';
  if (entry === 'settlement_capture' || entry === 'settlement_capture_early') return 'plan3';
  if (entry === 'settlement_capture_90') return 'plan2';
  if (/^(probe|main|late_capture|late|sustained|reversal|ultra_late|settlement_capture_90|cross_follow)/.test(entry)) return 'plan2';
  return 'plan1';
}

function mergeLegacyPlanStats(primary = {}, legacy = {}) {
  const a = primary || {};
  const b = legacy || {};
  const settledTrades = (Number(a.settledTrades) || 0) + (Number(b.settledTrades) || 0);
  const orderCount = (Number(a.orderCount) || 0) + (Number(b.orderCount) || 0);
  const wins = (Number(a.wins) || 0) + (Number(b.wins) || 0);
  const losses = (Number(a.losses) || 0) + (Number(b.losses) || 0);
  const realizedPnl = (Number(a.realizedPnl) || 0) + (Number(b.realizedPnl) || 0);
  const investedUsd = (Number(a.investedUsd) || 0) + (Number(b.investedUsd) || 0);
  return {
    settledTrades,
    orderCount,
    wins,
    losses,
    realizedPnl,
    investedUsd,
    totalReturn: investedUsd > 0 ? realizedPnl / investedUsd : 0
  };
}
function formatLiveOrderReason(order) {
  const parts = [];
  if (order.error) parts.push(order.error);
  if (order.note) parts.push(order.note);
  if (order.exitReason) parts.push(order.exitReason);
  if (order.lastExitError) parts.push(`最近卖出失败：${order.lastExitError}`);
  const raw = parts.length ? parts.join(' · ') : '--';
  if (raw === '--') return raw;
  const rawMatch = String(raw).match(/balance:\s*(\d+),\s*order amount:\s*(\d+)/i);
  if (rawMatch) {
    const balanceShares = Number(rawMatch[1]) / 1e6;
    const orderShares = Number(rawMatch[2]) / 1e6;
    return `条件 token 余额 ${balanceShares.toFixed(2)} 份，无法卖出 ${orderShares.toFixed(2)} 份（CLOB raw: ${rawMatch[2]}，÷1e6=份数）。买单可能尚未成交。`;
  }
  if (/not enough balance\s*\/\s*allowance|CLOB 卖单校验失败|缓存未同步/i.test(raw)) {
    return 'CLOB 卖单缓存未同步（买单刚成交），系统将稍后按 99% 份额重试。';
  }
  if (/no orders found to match/i.test(raw)) {
    return 'FAK 即时成交失败：当前价位暂无对手盘。';
  }
  if (/条件 token 余额|买单可能尚未成交/i.test(raw)) return raw;
  return raw;
}

function renderLiveOrderRow(order, stopLossByBuyId = new Map()) {
  const isSell = String(order.orderSide || '').toUpperCase() === 'SELL';
  const relatedStopSell = isSell ? null : relatedStopSellForBuy(order, stopLossByBuyId);
  const result = liveOrderResult(order);
  const pnl = liveOrderPnl(order);
  const orderReturn = liveOrderReturn(order);
  const exitText = formatLiveOrderExitLabel(order, relatedStopSell);
  const statusText = renderLiveSettlementStatus(order);
  const reason = formatLiveOrderReason(order);
  const isDust = isDustClosedLiveOrder(order);
  const isBlockedBuy = !isSell && order.status === 'blocked';
  const isUnconfirmedBuy = !isSell && (
    order.fillUnconfirmed === true
    || order.positionStatus === 'pending'
    || order.status === 'pending'
  );
  const side = isDust
    ? '灰尘仓'
    : (isSell
      ? '卖出/平仓'
      : (isBlockedBuy ? '买入拦截' : (isUnconfirmedBuy ? '买入待确认' : '买入/开仓')));
  const sideClass = isDust || isBlockedBuy || isUnconfirmedBuy ? 'warn' : (isSell ? 'sell' : 'buy');
  return `
    <tr class="live-order-row ${isDust ? 'dust-side' : (isSell ? 'sell-side' : 'buy-side')}" title="${escapeHtml(reason)}">
      <td>${formatTime(order.createdAtIso)}</td>
      <td><span class="pill ${sideClass}">${side}</span></td>
      <td>${escapeHtml(shortSymbol(order.symbol || 'BTC-USD'))}</td>
      <td>${escapeHtml(order.timeframe || '--')}</td>
      <td>${escapeHtml(order.outcome || order.direction || '--')}</td>
      <td>${order.limitPrice ? pct(order.limitPrice) : '--'}</td>
      <td>${order.usd ? money(order.usd) : '--'}</td>
      <td class="${result.className}">${result.label}</td>
      <td class="${pnl.className}">${pnl.label}</td>
      <td class="${orderReturn.className}">${orderReturn.label}</td>
      <td>${escapeHtml(exitText)}</td>
      <td>${escapeHtml(statusText)}</td>
      <td>${escapeHtml(order.market || order.marketSlug || '--')}</td>
    </tr>
  `;
}

function isImmediateNoFill(order) {
  const reason = `${order?.error || ''} ${order?.note || ''}`;
  return /FAK|no orders found to match|暂无对手盘|未成交/i.test(reason);
}

function renderLiveSettlementStatus(order) {
  if (order.status === 'blocked') {
    if (isImmediateNoFill(order)) return '未成交 · 当前价无对手盘，稍后重试';
    const detail = formatLiveOrderReason(order);
    if (detail && detail !== '--') {
      const short = detail.length > 48 ? `${detail.slice(0, 45)}…` : detail;
      return `拦截 · ${short}`;
    }
    return '拦截';
  }
  if (isExpiredUnfilled(order)) return '未成交过期';
  if (isDustClosedLiveOrder(order)) {
    return order.exitStatus === 'dust-undersized-fill'
      ? '灰尘仓 · 成交过小已本地关闭'
      : '灰尘仓 · 无法卖出已本地关闭';
  }
  if (order.fillUnconfirmed === true || order.status === 'pending' || order.positionStatus === 'pending') {
    return order.fillUnconfirmed === true ? '未确认 · 等待 CLOB/链上核实' : '待成交';
  }
  if (order.positionStatus === 'open') {
    if (order.dustHolding === true || order.dustTopUpPending === true) {
      const shares = Number(order.remainingShares ?? order.shares);
      const minimum = Number(order.dustSellMinShares) || 5;
      return Number.isFinite(shares)
        ? `持仓 · 已买入 ${shares.toFixed(4)} 份（低于 ${minimum} 份自动卖出门槛）`
        : `持仓 · 已买入（低于 ${minimum} 份自动卖出门槛）`;
    }
    return order.fillConfirmed === false ? '持仓（未确认）' : '持仓';
  }
  if (order.positionStatus === 'closed') return '已结算';
  const clob = String(order.clobStatus || order.clobResponse?.status || '').toLowerCase();
  const hashes = order.clobResponse?.transactionsHashes || order.clobResponse?.transactionHashes || [];
  if ((clob === 'matched' || clob === 'filled') && Array.isArray(hashes) && hashes.length > 0) return '已成交';
  if (clob === 'matched' || clob === 'filled') return '未确认 · matched 无交易哈希';
  return order.status || '--';
}

function isFilledStopLossSell(order) {
  if (String(order?.orderSide || '').toUpperCase() !== 'SELL') return false;
  if (String(order?.status || '').toLowerCase() === 'blocked') return false;
  const status = String(order?.exitStatus || '');
  return status === 'stop-loss' || status === 'dynamic-stop-loss' || status === 'hard-stop-loss';
}

function stopLossMatchKey(order) {
  return [
    String(order?.planId || ''),
    String(order?.symbol || ''),
    String(order?.timeframe || ''),
    String(order?.direction || order?.outcome || '').toLowerCase(),
    String(order?.marketSlug || order?.market || '')
  ].join('|');
}

function indexFilledStopLossSells(orders = []) {
  const byBuyId = new Map();
  const byKey = new Map();
  for (const order of orders) {
    if (!isFilledStopLossSell(order)) continue;
    if (order.relatedBuyOrderId) {
      const prev = byBuyId.get(order.relatedBuyOrderId);
      if (!prev || Date.parse(order.createdAtIso || 0) >= Date.parse(prev.createdAtIso || 0)) {
        byBuyId.set(order.relatedBuyOrderId, order);
      }
    }
    const key = stopLossMatchKey(order);
    const prev = byKey.get(key);
    if (!prev || Date.parse(order.createdAtIso || 0) >= Date.parse(prev.createdAtIso || 0)) {
      byKey.set(key, order);
    }
  }
  return { byBuyId, byKey };
}

function relatedStopSellForBuy(buy, index) {
  if (!buy || !index) return null;
  if (String(buy.orderSide || 'BUY').toUpperCase() === 'SELL') return null;
  if (String(buy.status || '').toLowerCase() === 'blocked') return null;
  return index.byBuyId?.get(buy.id)
    || index.byKey?.get(stopLossMatchKey(buy))
    || null;
}

function parseStopLossLinePct(reason) {
  const match = String(reason || '').match(/<=\s*SL\s+([\d.]+)%/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function formatStopLossFillLabel(order, slLineFallback = null) {
  const fill = Number(order?.exitPrice ?? order?.limitPrice);
  const slPrice = Number(order?.stopLossPrice);
  const fromReason = parseStopLossLinePct(order?.exitReason);
  const fallback = Number(slLineFallback);
  let linePct = Number.isFinite(slPrice) && slPrice > 0 && slPrice < 1
    ? slPrice * 100
    : fromReason;
  if (!Number.isFinite(linePct) && Number.isFinite(fallback) && fallback > 0) {
    linePct = fallback <= 1 ? fallback * 100 : fallback;
  }
  const fillTxt = Number.isFinite(fill) ? pct(fill) : '--';
  if (Number.isFinite(linePct)) {
    return `止损卖出 ${fillTxt}（线 ${linePct.toFixed(0)}%）`;
  }
  return `止损卖出 ${fillTxt}`;
}

function formatLiveOrderExitLabel(order, relatedStopSell = null) {
  if (relatedStopSell) {
    return formatStopLossFillLabel(relatedStopSell, order?.stopLossPrice);
  }
  const entry = Number(order.entryPrice ?? order.limitPrice);
  const exit = Number(order.exitPrice);
  const status = String(order.exitStatus || '');
  if (!status) {
    if (order.positionStatus === 'open') {
      const peak = Number(order.peakPrice);
      const trail = Number(order.trailStopPrice);
      if (Number.isFinite(peak) && Number.isFinite(trail)) {
        return `持仓 最高 ${pct(peak)} / 回撤线 ${pct(trail)}`;
      }
      return '持仓';
    }
    return '--';
  }
  if (isDustExitStatus(status)) {
    if (status === 'dust-undersized-fill') return '灰尘仓（成交过小）';
    if (status === 'dust-topup-merged') return '灰尘加仓已合并';
    if (status === 'dust-topup-pending') return '灰尘待加仓';
    return '灰尘仓（本地结清，非止损）';
  }
  if (status === 'take-profit' || status === 'dynamic-take-profit' || status === 'trailing-take-profit') {
    if (status === 'trailing-take-profit' && Number.isFinite(Number(order.peakPrice)) && Number.isFinite(exit)) {
      return `回撤止盈 最高 ${pct(order.peakPrice)} → ${pct(exit)}`;
    }
    if (Number.isFinite(entry) && Number.isFinite(exit)) {
      const delta = ((exit - entry) * 100).toFixed(0);
      return `止盈 ${Number(delta) >= 0 ? '+' : ''}${delta}% @ ${pct(exit)}`;
    }
    return `止盈 @ ${pct(exit)}`;
  }
  if (status === 'stop-loss' || status === 'dynamic-stop-loss' || status === 'hard-stop-loss') {
    const reason = String(order.exitReason || '');
    if (/灰尘仓/.test(reason)) {
      return Number.isFinite(exit)
        ? `止损成交（余灰尘本地结清）@ ${pct(exit)}`
        : '止损成交（余灰尘本地结清）';
    }
    return formatStopLossFillLabel(order, order.stopLossPrice);
  }
  if (status === 'direction-reversal-stop') return '反转止损';
  if (status === 'time-stop') return `时间止损 @ ${pct(exit)}`;
  if (status === 'manual-exit') return '手动平仓';
  if (status === 'expiry') return '到期';
  if (status === 'expired-unfilled') return '未成交';
  return liveExitLabel(status) || '--';
}

function isExpiredUnfilled(order) {
  return order?.status === 'expired' && order?.exitStatus === 'expired-unfilled';
}

function liveOrderResult(order) {
  if (order.status === 'blocked' && isImmediateNoFill(order)) return { label: '未成交', className: 'warn' };
  if (isExpiredUnfilled(order)) return { label: '未成交', className: 'warn' };
  if (isDustClosedLiveOrder(order)) return { label: '灰尘仓', className: 'warn' };
  if (order.status === 'blocked') return { label: '拦截', className: 'warn' };
  if (order.fillUnconfirmed === true || order.positionStatus === 'pending') {
    return { label: '未确认', className: 'warn' };
  }
  if (order.positionStatus === 'open' || order.positionStatus === 'pending') {
    return { label: '待结算', className: '' };
  }
  const pnl = Number(order.pnl);
  if (!Number.isFinite(pnl)) return { label: '--', className: '' };
  if (pnl > 0) return { label: '赢', className: 'pos' };
  if (pnl < 0) return { label: '输', className: 'neg' };
  return { label: '平', className: 'warn' };
}

function liveExitLabel(exitStatus) {
  const status = String(exitStatus || '');
  if (!status) return '';
  if (isDustExitStatus(status)) {
    if (status === 'dust-undersized-fill') return '灰尘仓（成交过小）';
    if (status === 'dust-topup-merged') return '灰尘加仓已合并';
    return '灰尘仓';
  }
  if (status === 'expiry') return '到期';
  if (status === 'take-profit' || status === 'dynamic-take-profit' || status === 'trailing-take-profit') return status === 'trailing-take-profit' ? '回撤止盈' : '止盈';
  if (status === 'stop-loss' || status === 'dynamic-stop-loss' || status === 'hard-stop-loss') return '止损';
  if (status === 'direction-reversal-stop') return '反转止损';
  if (status === 'time-stop') return '时间止损';
  if (status === 'manual-exit') return '手动';
  return status;
}

function liveOrderPnl(order) {
  if (isExpiredUnfilled(order) || isDustClosedLiveOrder(order)) return { label: '--', className: '' };
  const pnl = Number(order.pnl);
  if (!Number.isFinite(pnl)) return { label: '--', className: '' };
  return { label: formatSignedUsd(pnl), className: pnl >= 0 ? 'pos' : 'neg' };
}

function liveOrderCostBasis(order) {
  const usd = Number(order.usd);
  const pnl = Number(order.pnl);
  const isSell = String(order?.orderSide || '').toUpperCase() === 'SELL';
  if (isSell && Number.isFinite(usd) && Number.isFinite(pnl)) {
    const cost = usd - pnl;
    if (cost > 0) return cost;
  }
  return usd;
}

function liveOrderReturn(order) {
  if (isExpiredUnfilled(order) || isDustClosedLiveOrder(order)) return { label: '--', className: '' };
  const pnl = Number(order.pnl);
  const usd = liveOrderCostBasis(order);
  if (!Number.isFinite(pnl) || !Number.isFinite(usd) || usd <= 0) return { label: '--', className: '' };
  const value = pnl / usd;
  return { label: formatSignedPercent(value), className: value >= 0 ? 'pos' : 'neg' };
}
function shortId(value) {
  const text = String(value || '');
  if (!text || text === '--') return '--';
  if (text.length <= 14) return text;
  return `${text.slice(0, 8)}…${text.slice(-4)}`;
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

async function getJson(url, { retries = 1, timeoutMs = 15000 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
          ? AbortSignal.timeout(timeoutMs)
          : undefined
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || response.statusText);
      return data;
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !(error instanceof TypeError)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw lastError;
}

async function postJson(url, payload, { timeoutMs = 15000 } = {}) {
  const response = await fetch(url, {
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

function formatNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '--';
  return numeric.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function money(value) {
  return `$${formatNumber(value)}`;
}

function formatSignedUsd(value) {
  const numeric = Number(value) || 0;
  return `${numeric >= 0 ? '+' : '-'}$${formatNumber(Math.abs(numeric))}`;
}

function formatSignedPercent(value) {
  const numeric = Number(value) || 0;
  return `${numeric >= 0 ? '+' : ''}${(numeric * 100).toFixed(2)}%`;
}

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '--';
  return `${(numeric * 100).toFixed(1)}%`;
}

function formatTime(value) {
  if (!value) return '--';
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
}

function pct(value) {
  return `${(Number(value || 0) * 100).toFixed(2)}%`;
}

function shortAddress(value) {
  if (!value) return '--';
  const text = String(value);
  return text.length > 14 ? `${text.slice(0, 6)}...${text.slice(-4)}` : text;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
