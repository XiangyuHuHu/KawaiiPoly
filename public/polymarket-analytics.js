const statusEl = document.querySelector('#pmAnalyticsStatus');
const hintEl = document.querySelector('#pmAnalyticsHint');
const lookbackEl = document.querySelector('#pmAnalyticsLookback');
const refreshBtn = document.querySelector('#pmAnalyticsRefresh');

const overviewEl = document.querySelector('#pmAnalyticsOverview');
const bySymbolBody = document.querySelector('#pmAnalyticsBySymbol tbody');
const lossBody = document.querySelector('#pmAnalyticsLossReasons tbody');
const exitsBody = document.querySelector('#pmAnalyticsExits tbody');
const gateTopBody = document.querySelector('#pmAnalyticsGateTop tbody');
const calibrationBody = document.querySelector('#pmAnalyticsCalibration tbody');
const reversalStrip = document.querySelector('#pmAnalyticsReversalStrip');
const exitStrip = document.querySelector('#pmAnalyticsExitStrip');
const gateStrip = document.querySelector('#pmAnalyticsGateStrip');
const planSpecificEl = document.querySelector('#pmAnalyticsPlanSpecific');

const PLAN14_SYMBOLS = [
  ['BTC-USD', 'BTC'],
  ['ETH-USD', 'ETH'],
  ['SOL-USD', 'SOL'],
  ['XRP-USD', 'XRP']
];
const PLAN15_SYMBOLS = [
  ['体育', '体育'],
  ['电竞', '电竞'],
  ['天气', '天气'],
  ['政治选举', '政治'],
  ['宏观金融', '宏观'],
  ['加密事件', '加密']
];
const symbolTabsEl = document.querySelector('#pmAnalyticsSymbols');

const state = {
  source: 'paper',
  planId: 'current',
  symbol: 'all',
  lookbackDays: 30,
  dashboard: null
};
let analyticsRefreshController = null;

async function getJson(url, { signal = null } = {}) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }
  return response.json();
}

function pct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  return `${(n * 100).toFixed(1)}%`;
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  const abs = Math.abs(n).toFixed(2);
  return n >= 0 ? `$${abs}` : `-$${abs}`;
}

function pnlClass(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return '';
  return n > 0 ? 'pos' : 'neg';
}

function barCell(ratio, maxRatio = 1) {
  const r = Number(ratio);
  if (!Number.isFinite(r) || r <= 0) {
    return '<td class="analytics-bar-cell"><span class="analytics-bar"><i style="width:0%"></i></span></td>';
  }
  const width = Math.max(2, Math.min(100, (r / (maxRatio || 1)) * 100));
  return `<td class="analytics-bar-cell"><span class="analytics-bar"><i style="width:${width.toFixed(1)}%"></i></span></td>`;
}

function setStrip(el, items) {
  if (!el) return;
  el.innerHTML = items.map(([label, value, cls = '']) => (
    `<div><span>${label}</span><strong class="${cls}">${value}</strong></div>`
  )).join('');
}

function symbolsForPlan(planId) {
  if (planId === 'plan14') return PLAN14_SYMBOLS;
  if (planId === 'plan15') return PLAN15_SYMBOLS;
  return [...PLAN14_SYMBOLS, ...PLAN15_SYMBOLS];
}

function renderSymbolTabs() {
  if (!symbolTabsEl) return;
  const symbols = symbolsForPlan(state.planId);
  if (!symbols.some(([id]) => id === state.symbol)) state.symbol = 'all';
  symbolTabsEl.innerHTML = [
    ['all', '全部'],
    ...symbols
  ].map(([id, label]) => `
    <button type="button" class="pm-tab${id === state.symbol ? ' active' : ''}" data-symbol-tab="${id}" role="tab" aria-selected="${id === state.symbol ? 'true' : 'false'}">${label}</button>
  `).join('');
}

function syncTabs(attr, value) {
  document.querySelectorAll(`[${attr}]`).forEach((btn) => {
    const active = btn.getAttribute(attr) === value;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function emptyMessageFor(dashboard, fallback) {
  if (dashboard?.emptyMessage) return dashboard.emptyMessage;
  if (state.source === 'live') return '暂无实盘结算样本';
  if (state.source === 'paper') return '暂无模拟结算样本';
  return fallback || '暂无样本';
}

function updateHint() {
  const sourceLabel = { paper: '模拟', live: '实盘', all: '合并' }[state.source] || state.source;
  const planLabel = state.planId === 'current'
    ? 'Plan14 + Plan15 + Plan16 + Plan17 + Plan18 + Plan19 + Plan21 + Plan22'
    : ['plan14', 'plan15', 'plan16', 'plan17', 'plan18', 'plan19', 'plan21', 'plan22'].includes(state.planId)
      ? `Plan${state.planId.slice(4)}`
      : state.planId.toUpperCase();
  const symbolLabel = state.symbol === 'all' ? '全部' : state.symbol.replace('-USD', '');
  if (hintEl) {
    hintEl.textContent = `${sourceLabel} · ${planLabel} · ${symbolLabel} · ${state.lookbackDays} 天`;
  }
}

function renderOverview(dashboard) {
  const o = dashboard?.overview || {};
  const gate = dashboard?.historyGate || {};
  const sample = dashboard?.sampleCount ?? o.total ?? 0;
  const sourceMix = state.source === 'live'
    ? `0 / ${o.liveOrders ?? sample}`
    : state.source === 'paper'
      ? `${o.paperOrders ?? sample} / 0`
      : `${o.paperOrders ?? 0} / ${o.liveOrders ?? 0}`;
  setStrip(overviewEl, [
    ['样本', String(sample)],
    ['胜率', sample ? pct(o.winRate) : '--'],
    ['胜 / 负', sample ? `${o.wins ?? 0} / ${o.losses ?? 0}` : '--'],
    ['总 PnL', sample ? money(o.totalPnl) : '--', sample ? pnlClass(o.totalPnl) : ''],
    ['模拟 / 实盘', sourceMix],
    ['入场前已有风险证据', sample ? `${gate.riskEvidenceLosses ?? gate.actionableLosses ?? 0} (${pct(gate.riskEvidenceLossShare ?? gate.actionableLossShare)})` : '--']
  ]);
}

function renderBySymbol(bySymbol = {}, dashboard = null) {
  const rows = Object.entries(bySymbol).sort((a, b) => (b[1].total || 0) - (a[1].total || 0));
  const maxTotal = Math.max(1, ...rows.map(([, b]) => b.total || 0));
  if (!rows.length) {
    bySymbolBody.innerHTML = `<tr><td colspan="7" class="muted">${emptyMessageFor(dashboard, '暂无分币种样本')}</td></tr>`;
    return;
  }
  bySymbolBody.innerHTML = rows.map(([symbol, b]) => `
    <tr>
      <td>${symbol.replace('-USD', '')}</td>
      <td>${b.total}</td>
      <td>${b.wins}</td>
      <td>${b.losses}</td>
      <td>${pct(b.winRate)}</td>
      <td class="${pnlClass(b.totalPnl)}">${money(b.totalPnl)}</td>
      ${barCell(b.total, maxTotal)}
    </tr>
  `).join('');
}

function renderLossReasons(dashboard) {
  const loss = dashboard?.lossReasons || {};
  const rev = dashboard?.reversals || {};
  const empty = !dashboard?.sampleCount;
  setStrip(reversalStrip, [
    ['反转族亏损', empty ? '--' : `${loss.reversalLosses ?? 0} (${pct(loss.reversalLossShare)})`],
    ['入场后反转', empty ? '--' : String(rev.postEntryPmReversal ?? 0)],
    ['短窗反转', empty ? '--' : String(rev.shortWindowReversal ?? 0)],
    ['PM 反转标记', empty ? '--' : `${rev.pmReversalFlagged ?? 0} / 亏损 ${pct(rev.pmReversalShareOfLosses)}`]
  ]);

  const ranked = loss.ranked || [];
  const maxCount = Math.max(1, ...ranked.map((row) => row.count || 0));
  const lossTotal = Math.max(1, loss.losses || 0);
  if (!ranked.length) {
    const msg = empty
      ? emptyMessageFor(dashboard, '暂无亏损归因')
      : '暂无亏损归因（可能全胜或尚未写入 loss_reason）';
    lossBody.innerHTML = `<tr><td colspan="6" class="muted">${msg}</td></tr>`;
    return;
  }
  lossBody.innerHTML = ranked.map((row) => `
    <tr>
      <td>${row.label || row.reason}</td>
      <td>${row.count}</td>
      <td>${pct(row.count / lossTotal)}</td>
      <td class="${pnlClass(row.totalPnl)}">${money(row.totalPnl)}</td>
      <td>${row.actionableAtEntry ? '入场前可见' : row.retrospectiveOnly ? '事后回溯' : '描述性'}</td>
      ${barCell(row.count, maxCount)}
    </tr>
  `).join('');
}

function renderExits(exits = {}, dashboard = null) {
  const family = exits.byFamily || {};
  const empty = !dashboard?.sampleCount;
  setStrip(exitStrip, [
    ['止盈笔数', empty ? '--' : String(family['take-profit']?.total ?? 0)],
    ['止损笔数', empty ? '--' : String(family['stop-loss']?.total ?? 0)],
    ['到期笔数', empty ? '--' : String(family.expiry?.total ?? 0)],
    ['TP 占比(提前退)', empty ? '--' : pct(exits.takeProfitHitRate)],
    ['到期胜率', empty ? '--' : pct(exits.expiryWinRate)]
  ]);

  const rows = Object.entries(exits.byStatus || {}).sort((a, b) => (b[1].total || 0) - (a[1].total || 0));
  const maxTotal = Math.max(1, ...rows.map(([, b]) => b.total || 0));
  if (!rows.length) {
    exitsBody.innerHTML = `<tr><td colspan="7" class="muted">${emptyMessageFor(dashboard, '暂无退出分布')}</td></tr>`;
    return;
  }
  exitsBody.innerHTML = rows.map(([status, b]) => `
    <tr>
      <td>${status}</td>
      <td>${b.total}</td>
      <td>${b.wins}</td>
      <td>${b.losses}</td>
      <td>${pct(b.winRate)}</td>
      <td class="${pnlClass(b.totalPnl)}">${money(b.totalPnl)}</td>
      ${barCell(b.total, maxTotal)}
    </tr>
  `).join('');
}

function renderHistoryGate(gate = {}, dashboard = null) {
  const empty = !dashboard?.sampleCount;
  const diagnostics = dashboard?.judgmentDiagnostics || {};
  const coverage = diagnostics.coverage || {};
  const coverageText = (value) => empty
    ? '--'
    : `${value ?? 0} / ${coverage.samples ?? gate.samples ?? 0}`;
  setStrip(gateStrip, [
    ['样本数', empty ? '--' : String(gate.samples ?? 0)],
    ['方向结果覆盖', coverageText(coverage.actualDirection)],
    ['估值快照覆盖', coverageText(coverage.expectedValueSnapshot)],
    ['信号质量覆盖', coverageText(coverage.signalQualitySnapshot)],
    ['完整判断链覆盖', coverageText(coverage.decisionTrace)]
  ]);
  const rows = diagnostics.rows || [];
  if (!rows.length) {
    gateTopBody.innerHTML = `<tr><td colspan="9" class="muted">${emptyMessageFor(dashboard, '暂无可用于判断链回溯的快照')}</td></tr>`;
    return;
  }
  gateTopBody.innerHTML = rows.map((row) => `
    <tr>
      <td>${row.module || '—'}</td>
      <td title="${row.description || ''}">${row.label || row.key}</td>
      <td>${row.actionableAtEntry ? '入场前可见' : '事后回溯'}</td>
      <td>${row.total ?? 0}</td>
      <td>${row.wins ?? 0} / ${row.losses ?? 0}</td>
      <td>${row.winRate == null ? '—' : pct(row.winRate)}</td>
      <td>${row.breakEvenWinRate == null ? '—' : pct(row.breakEvenWinRate)}</td>
      <td class="${pnlClass(row.priceAdjustedEdge)}">${row.priceAdjustedEdge == null ? '—' : pct(row.priceAdjustedEdge)}</td>
      <td class="${pnlClass(row.totalPnl)}">${money(row.totalPnl)}</td>
    </tr>
  `).join('');
}

function renderBucketTable(title, buckets) {
  const rows = Object.entries(buckets || {});
  if (!rows.length) return `<p class="muted">${title}：暂无数据</p>`;
  const body = rows.map(([key, b]) => {
    const total = b.total ?? b.sampleCount ?? 0;
    const wins = b.wins ?? b.correct ?? 0;
    const winRate = b.winRate ?? b.accuracy ?? (total ? wins / total : 0);
    const pnl = b.totalPnl;
    return `<tr>
      <td>${key}</td>
      <td>${total}</td>
      <td>${wins}</td>
      <td>${pct(winRate)}</td>
      <td class="${pnlClass(pnl)}">${pnl == null ? '—' : money(pnl)}</td>
    </tr>`;
  }).join('');
  return `
    <h3 class="analytics-subhead">${title}</h3>
    <div class="analytics-table-wrap">
      <table class="pm-orders analytics-table">
        <thead><tr><th>桶</th><th>样本</th><th>胜/对</th><th>胜率</th><th>PnL</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function renderDecisionBucketTable(title, buckets) {
  const rows = Object.entries(buckets || {});
  if (!rows.length) return `<p class="muted">${title}：暂无数据</p>`;
  const body = rows.map(([key, b]) => `
    <tr>
      <td>${key}</td>
      <td>${b.total ?? 0}</td>
      <td>${b.wins ?? 0} / ${b.losses ?? 0}</td>
      <td>${b.winRate == null ? '—' : pct(b.winRate)}</td>
      <td>${b.breakEvenWinRate == null ? '—' : pct(b.breakEvenWinRate)}</td>
      <td class="${pnlClass(b.priceAdjustedEdge)}">${b.priceAdjustedEdge == null ? '—' : pct(b.priceAdjustedEdge)}</td>
      <td class="${pnlClass(b.avgWinPnl)}">${money(b.avgWinPnl)}</td>
      <td class="${pnlClass(b.avgLossPnl)}">${money(b.avgLossPnl)}</td>
      <td class="${pnlClass(b.totalPnl)}">${money(b.totalPnl)}</td>
    </tr>
  `).join('');
  return `
    <h3 class="analytics-subhead">${title}</h3>
    <p class="muted">盈亏平衡按实际投入加权买入价计算；价格优势 = 实际胜率 − 盈亏平衡胜率。</p>
    <div class="analytics-table-wrap">
      <table class="pm-orders analytics-table">
        <thead><tr><th>桶</th><th>样本</th><th>胜 / 负</th><th>胜率</th><th>盈亏平衡</th><th>价格优势</th><th>平均赢</th><th>平均亏</th><th>PnL</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function renderOpenLine(open) {
  if (!open) return '';
  const parts = Object.entries(open.by || {}).map(([key, count]) => `${key.replace('-USD', '')} ${count}`);
  return `<p class="muted">未结算 ${open.open ?? 0} 笔 · 占用 ${money(open.openUsd)}${parts.length ? ` · ${parts.join(' · ')}` : ''}。未结算不计入下面的胜率。</p>`;
}

function renderPlanSpecific(dashboard) {
  const planId = state.planId;
  const specific = dashboard?.planSpecific || {};
  const parts = [];

  if ((planId === 'current' || planId === 'plan14') && specific.plan14) {
    parts.push('<div class="analytics-plan-block"><h3 class="analytics-subhead">Plan14 · 5 分钟涨跌</h3>');
    parts.push(renderOpenLine(specific.plan14.open));
    parts.push(renderBucketTable('买入价', specific.plan14.byPrice));
    parts.push(renderBucketTable('策略版本', specific.plan14.byVersion));
    parts.push('</div>');
  }

  if ((planId === 'current' || planId === 'plan15') && specific.plan15) {
    parts.push('<div class="analytics-plan-block"><h3 class="analytics-subhead">Plan15 · 事件盘</h3>');
    parts.push(renderOpenLine(specific.plan15.open));
    parts.push(renderBucketTable('类别', specific.plan15.byCategory));
    parts.push(renderBucketTable('买入价', specific.plan15.byPrice));
    parts.push('</div>');
  }

  if ((planId === 'current' || planId === 'plan16') && specific.plan16) {
    parts.push('<div class="analytics-plan-block"><h3 class="analytics-subhead">Plan16 · 天气预报</h3>');
    parts.push(renderOpenLine(specific.plan16.open));
    parts.push(renderBucketTable('城市', specific.plan16.byCity));
    parts.push(renderBucketTable('买入价', specific.plan16.byPrice));
    parts.push('</div>');
  }

  if ((planId === 'current' || planId === 'plan17') && specific.plan17) {
    parts.push('<div class="analytics-plan-block"><h3 class="analytics-subhead">Plan17 · 价格档位</h3>');
    parts.push(renderOpenLine(specific.plan17.open));
    parts.push(renderBucketTable('币种 · 盘口类型 · 方向', specific.plan17.byFamily));
    parts.push(renderBucketTable('买入价', specific.plan17.byPrice));
    parts.push('</div>');
  }

  for (const [id, title] of [['plan18', 'Plan18 · 梅花易数对照'], ['plan19', 'Plan19 · 小六壬对照']]) {
    if (!((planId === 'current' || planId === id) && specific[id])) continue;
    parts.push(`<div class="analytics-plan-block"><h3 class="analytics-subhead">${title}</h3>`);
    parts.push(renderOpenLine(specific[id].open));
    parts.push(renderBucketTable('币种 · 周期', specific[id].byTimeframe));
    parts.push(renderBucketTable('周期 · 方向', specific[id].byDirection));
    parts.push(renderBucketTable('梅花体用 · 方向', specific[id].byRelation));
    parts.push(renderBucketTable('小六壬 · 方向', specific[id].byLiuren));
    parts.push(renderBucketTable('两种卦法', specific[id].byAgreement));
    parts.push('</div>');
  }

  if ((planId === 'current' || planId === 'plan21') && specific.plan21) {
    parts.push('<div class="analytics-plan-block"><h3 class="analytics-subhead">Plan21 · 5 分钟落后方</h3>');
    parts.push(renderOpenLine(specific.plan21.open));
    parts.push(renderBucketTable('窗口', specific.plan21.byWindow));
    parts.push(renderBucketTable('买入价', specific.plan21.byPrice));
    parts.push('</div>');
  }

  if ((planId === 'current' || planId === 'plan22') && specific.plan22) {
    const control = specific.plan22.randomControl;
    parts.push('<div class="analytics-plan-block"><h3 class="analytics-subhead">Plan22 · 15 分钟 K 线综合</h3>');
    parts.push(renderOpenLine(specific.plan22.open));
    parts.push(renderBucketTable('阶段', specific.plan22.byPhase));
    parts.push(renderBucketTable('买入价', specific.plan22.byPrice));
    if (control?.total) {
      parts.push(`<p class="muted">随机对照（不占现金）${control.total} 笔 · 胜 ${control.wins} · 假设盈亏 $${control.totalPnl}</p>`);
    }
    parts.push('</div>');
  }


  if ((!planId || planId === 'all' || planId === 'plan3') && specific.plan3) {
    const band = specific.plan3.bandStats || {};
    const loss = specific.plan3.lossAnalytics || {};
    parts.push('<div class="analytics-plan-block"><h3 class="analytics-subhead">Plan3 · 价位带 / 亏损分析</h3>');
    parts.push(renderBucketTable('价位带胜率', Object.fromEntries(
      Object.entries(band).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, v])
    )));
    if (loss && (loss.settledOrders || loss.reasonCounts)) {
      parts.push(`<p class="muted">结算 ${loss.settledOrders ?? 0} · 胜率 ${pct(loss.winRate)} · 反转亏损占比 ${pct(loss.reversalLossShare)}</p>`);
      if (loss.reasonCounts) {
        parts.push(renderBucketTable('Plan3 亏损原因', Object.fromEntries(
          Object.entries(loss.reasonCounts).map(([k, v]) => [k, { total: v, wins: 0, winRate: 0, totalPnl: null }])
        )));
      }
    }
    parts.push('</div>');
  }

  if ((!planId || planId === 'all' || planId === 'plan5') && specific.plan5) {
    parts.push('<div class="analytics-plan-block"><h3 class="analytics-subhead">Plan5 · 锁定强度 / 下一窗预测</h3>');
    parts.push(renderDecisionBucketTable('订单按锁定强度', specific.plan5.lockStrengthOrders));
    if (specific.plan5.lockStrengthStats) {
      parts.push(renderBucketTable('窗口锁定 PM 正确率', specific.plan5.lockStrengthStats));
    }
    const next = specific.plan5.nextSlot;
    if (next) {
      parts.push(`<p class="muted">下一窗预测总体：样本 ${next.overall?.total ?? 0} · 准确率 ${pct(next.overall?.accuracy)} · pending ${next.overall?.pending ?? 0}</p>`);
      parts.push(renderBucketTable('按锁定强度', next.byStrength));
      parts.push(renderBucketTable('连续同向 / 翻转', next.byContinuity));
    } else {
      parts.push('<p class="muted">下一窗预测：暂无 next-slot 数据（字段预留）。</p>');
    }
    parts.push('</div>');
  }

  if ((!planId || planId === 'all' || planId === 'plan2' || planId === 'plan2_5') && (specific.plan2 || specific.plan2_5)) {
    const cross = (specific[planId === 'plan2_5' ? 'plan2_5' : 'plan2'] || specific.plan2 || specific.plan2_5).crossFollow || {};
    parts.push('<div class="analytics-plan-block"><h3 class="analytics-subhead">Plan2 · 跨币跟随</h3>');
    parts.push(`<section class="summary-strip embedded-summary">
      <div><span>跨币相关笔数</span><strong>${cross.total ?? 0}</strong></div>
      <div><span>胜率</span><strong>${pct(cross.winRate)}</strong></div>
      <div><span>对齐笔数</span><strong>${cross.aligned ?? 0}</strong></div>
      <div><span>跟随失败</span><strong>${cross.failed ?? 0} (${pct(cross.failedShareOfCross)})</strong></div>
      <div><span>PnL</span><strong class="${pnlClass(cross.totalPnl)}">${money(cross.totalPnl)}</strong></div>
    </section>`);
    parts.push('</div>');
  }

  if (!parts.length) {
    planSpecificEl.innerHTML = `<p class="muted">${emptyMessageFor(dashboard, '当前 Plan 无特有模块（或样本为空）。')}</p>`;
    return;
  }
  planSpecificEl.innerHTML = parts.join('');
}

function renderCalibration(calibration = {}, dashboard = null) {
  const byConf = Object.values(calibration.byConfidenceBucket || {})
    .sort((a, b) => String(a.confidenceBucket).localeCompare(String(b.confidenceBucket)));
  const maxCount = Math.max(1, ...byConf.map((b) => b.sampleCount || 0));
  if (!byConf.length) {
    calibrationBody.innerHTML = `<tr><td colspan="5" class="muted">${emptyMessageFor(dashboard, '暂无置信度样本（需订单带 confidence）')}</td></tr>`;
    return;
  }
  calibrationBody.innerHTML = byConf.map((b) => `
    <tr>
      <td>${b.confidenceBucket}</td>
      <td>${b.sampleCount}</td>
      <td>${pct(b.winRate)}</td>
      <td class="${pnlClass(b.avgPnl)}">${money(b.avgPnl)}</td>
      ${barCell(b.sampleCount, maxCount)}
    </tr>
  `).join('');
}

function renderDashboard(dashboard) {
  state.dashboard = dashboard;
  renderOverview(dashboard);
  renderBySymbol(dashboard?.bySymbol, dashboard);
  renderLossReasons(dashboard);
  renderExits(dashboard?.exits, dashboard);
  renderHistoryGate(dashboard?.historyGate, dashboard);
  renderPlanSpecific(dashboard);
  renderCalibration(dashboard?.calibration, dashboard);

  // 顶部空态提示：避免「全 0」看起来像坏了
  let banner = document.querySelector('#pmAnalyticsEmptyBanner');
  if (!banner && overviewEl?.parentElement) {
    banner = document.createElement('p');
    banner.id = 'pmAnalyticsEmptyBanner';
    banner.className = 'analytics-empty';
    overviewEl.parentElement.insertBefore(banner, overviewEl.nextSibling);
  }
  if (banner) {
    if (dashboard?.empty) {
      banner.hidden = false;
      banner.textContent = emptyMessageFor(dashboard);
    } else {
      banner.hidden = true;
      banner.textContent = '';
    }
  }
}

async function refresh() {
  analyticsRefreshController?.abort();
  const controller = new AbortController();
  analyticsRefreshController = controller;
  updateHint();
  renderSymbolTabs();
  syncTabs('data-source-tab', state.source);
  syncTabs('data-plan-tab', state.planId);
  syncTabs('data-symbol-tab', state.symbol);
  if (statusEl) statusEl.textContent = '加载分析数据中...';

  const params = new URLSearchParams({
    source: state.source,
    plan: state.planId,
    symbol: state.symbol,
    lookbackDays: String(state.lookbackDays)
  });

  try {
    const payload = await getJson(`/api/polymarket/analytics?${params.toString()}`, {
      signal: controller.signal
    });
    const dashboard = payload.dashboard || payload;
    renderDashboard(dashboard);
    if (statusEl) {
      const n = dashboard?.sampleCount ?? 0;
      if (n === 0) {
        statusEl.textContent = emptyMessageFor(dashboard);
      } else {
        const sourceLabel = { paper: '模拟', live: '实盘', all: '合并' }[state.source] || state.source;
        statusEl.textContent = `已加载 ${n} 笔 · ${sourceLabel} · ${state.planId} · ${state.lookbackDays}d`;
      }
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
    if (statusEl) statusEl.textContent = `加载失败：${error.message || error}`;
  } finally {
    if (analyticsRefreshController === controller) analyticsRefreshController = null;
  }
}

document.querySelectorAll('[data-source-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.source = btn.getAttribute('data-source-tab');
    refresh();
  });
});

document.querySelectorAll('[data-plan-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.planId = btn.getAttribute('data-plan-tab');
    refresh();
  });
});

symbolTabsEl?.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-symbol-tab]');
  if (!btn) return;
  state.symbol = btn.getAttribute('data-symbol-tab');
  refresh();
});

lookbackEl?.addEventListener('change', () => {
  state.lookbackDays = Number(lookbackEl.value) || 30;
  refresh();
});

refreshBtn?.addEventListener('click', () => refresh());

await refresh();
setInterval(() => {
  if (document.visibilityState !== 'hidden') refresh();
}, 60_000);
