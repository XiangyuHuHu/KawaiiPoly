import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeExitDecisionReports } from './polymarketExitAnalytics.js';

const HOUR_MS = 60 * 60 * 1000;

export function buildHourlyMonitorSnapshot({
  polymarketTrading,
  readiness = null,
  predictionSummary = null,
  now = new Date()
} = {}) {
  if (!polymarketTrading) {
    throw new Error('polymarketTrading is required');
  }

  const plan1Stats = polymarketTrading.computeStats('plan1');
  const plan2Stats = polymarketTrading.computeStats('plan2');
  const plan3Stats = polymarketTrading.computeStats('plan3');
  const plan1Analytics = polymarketTrading.computePlan1Analytics();
  const plan3Analytics = polymarketTrading.computePlan3Analytics?.('plan3') || null;
  const liveStats = polymarketTrading.computeLiveStats();
  const liveControl = polymarketTrading.state?.liveControl || {};
  const liveAuto = polymarketTrading.liveAutoStatus?.() || polymarketTrading.state?.liveAuto || {};
  const paperAuto = {
    plan1: polymarketTrading.status('plan1')?.auto || {},
    plan2: polymarketTrading.status('plan2')?.auto || {},
    plan3: polymarketTrading.status('plan3')?.auto || {}
  };

  const liveOrders = polymarketTrading.listLiveOrders?.() || [];
  const openLive = liveOrders.filter((o) => (
    o.orderSide !== 'SELL' && o.positionStatus === 'open'
  ));
  const hourLive = filterLastHour(liveOrders, now);
  const hourPaper = collectHourPaperOrders(polymarketTrading, now);

  const exitDecisions = {
    plan1: polymarketTrading.computeExitDecisionAnalytics?.({ planId: 'plan1', includeLive: false }) || null,
    plan2: polymarketTrading.computeExitDecisionAnalytics?.({ planId: 'plan2', includeLive: false }) || null,
    live: polymarketTrading.computeExitDecisionAnalytics?.({ source: 'live' }) || null
  };

  return {
    generatedAtIso: now.toISOString(),
    shanghai: formatShanghaiHour(now),
    paper: {
      plan1: summarizePlanStats(plan1Stats),
      plan2: summarizePlanStats(plan2Stats),
      plan3: summarizePlanStats(plan3Stats),
      comparison: {
        leader: [plan1Stats, plan2Stats, plan3Stats]
          .map((stats, index) => ({ planId: ['plan1', 'plan2', 'plan3'][index], totalReturn: stats.totalReturn }))
          .sort((a, b) => b.totalReturn - a.totalReturn)[0]?.planId || null,
        plan1Return: plan1Stats.totalReturn,
        plan2Return: plan2Stats.totalReturn,
        plan3Return: plan3Stats.totalReturn
      },
      plan1Analytics: compactPlan1Analytics(plan1Analytics),
      plan3Analytics,
      lastHour: summarizeHourOrders(hourPaper, 'paper')
    },
    live: {
      control: {
        enabled: Boolean(liveControl.enabled),
        balanceUsdc: round2(liveControl.currentBalanceUsdc),
        pnlUsdc: round2(liveControl.pnlUsdc),
        totalReturn: round4(liveControl.totalReturn),
        stats: liveControl.stats || liveStats
      },
      auto: {
        enabled: Boolean(liveAuto.enabled),
        enabledPlans: liveAuto.enabledPlans || (liveAuto.planId ? [liveAuto.planId] : []),
        planId: liveAuto.planId || null,
        lastRunAtIso: liveAuto.lastRunAtIso || null,
        lastAction: liveAuto.lastAction || null,
        lastReason: liveAuto.lastReason || null,
        lastError: liveAuto.lastError || null
      },
      stats: liveStats,
      openPositions: openLive.length,
      lastHour: summarizeHourOrders(hourLive, 'live')
    },
    readiness: readiness ? {
      ready: Boolean(readiness.ready),
      balanceUsdc: round2(readiness.clob?.collateral?.balanceUsdc),
      openOrders: readiness.clob?.openOrdersCount ?? null,
      closedOnly: readiness.clob?.closedOnly === true,
      sellApproval: readiness.conditionalTokenApprovals?.detail || null,
      proxyWalletNote: readiness.conditionalTokenApprovals?.proxyWalletNote || null
    } : null,
    signals: predictionSummary ? {
      totalToday: predictionSummary.total ?? 0,
      compositePhase3Accuracy: predictionSummary.phases?.composite?.phase3?.accuracy ?? null
    } : null,
    exitDecisions,
    conclusions: []
  };
}

export function deriveMonitorConclusions(snapshot) {
  const lines = [];
  const { paper, live, readiness } = snapshot;

  if (readiness && !readiness.ready) {
    lines.push('实盘 readiness 未通过，自动下单可能被拦截，优先检查 CLOB 余额与授权。');
  } else if (readiness?.ready) {
    lines.push('实盘 API 就绪，自动循环可正常运行。');
  }

  if (live.auto?.enabled) {
    const planLabel = (live.auto.enabledPlans || []).join(' + ') || live.auto.planId || '--';
    if (live.auto.lastError) {
      lines.push(`实盘自动最近报错：${live.auto.lastError}`);
    } else if (live.auto.lastAction === 'skipped' && live.auto.lastReason) {
      lines.push(`实盘自动最近跳过：${live.auto.lastReason}`);
    } else {
      lines.push(`实盘自动运行中（${planLabel}），最近动作：${live.auto.lastAction || '--'}。`);
    }
  } else {
    lines.push('实盘自动未开启。');
  }

  if (live.openPositions > 0) {
    lines.push(`当前有 ${live.openPositions} 笔实盘未平仓，需关注 TP/SL 与授权。`);
  }

  const p1 = paper.plan1;
  const p2 = paper.plan2;
  if (p1.winRate >= 0.5 && p1.totalReturn < 0) {
    lines.push(`Plan1 胜率 ${pct(p1.winRate)} 但总收益 ${pct(p1.totalReturn)}，赔率/出场结构可能仍有问题。`);
  }
  if (p2.winRate >= 0.5 && p2.totalReturn < 0) {
    lines.push(`Plan2 胜率 ${pct(p2.winRate)} 但总收益 ${pct(p2.totalReturn)}，建议看 exit reason 分桶。`);
  }

  const tf5 = paper.plan1Analytics?.byTimeframe?.['5m'];
  const tf15 = paper.plan1Analytics?.byTimeframe?.['15m'];
  if (tf5 && tf15 && tf5.totalPnl < 0 && tf15.totalPnl > 0) {
    lines.push(`Plan1 5m 累计 PnL ${money(tf5.totalPnl)} vs 15m ${money(tf15.totalPnl)}，5m 仍是主要拖累。`);
  }

  const worstExit = findWorstExitBucket(paper.plan1Analytics?.byExitReason);
  if (worstExit) {
    lines.push(`Plan1 亏损最多出场：${worstExit.key}（${worstExit.count} 笔，PnL ${money(worstExit.totalPnl)}）。`);
  }

  if (paper.lastHour.count > 0) {
    lines.push(`过去 1h 模拟：${paper.lastHour.count} 笔，胜率 ${pct(paper.lastHour.winRate)}，PnL ${money(paper.lastHour.pnl)}。`);
  }
  if (live.lastHour.count > 0) {
    lines.push(`过去 1h 实盘：${live.lastHour.count} 笔，胜率 ${pct(live.lastHour.winRate)}，PnL ${money(live.lastHour.pnl)}。`);
  }

  for (const [key, analytics] of Object.entries(snapshot.exitDecisions || {})) {
    if (!analytics?.evaluable) continue;
    const label = key === 'live' ? '实盘' : key.toUpperCase();
    const tp = analytics.byExitStatus?.['take-profit'];
    const sl = analytics.byExitStatus?.['stop-loss'];
    if (tp?.evaluable >= 3 && Number(tp.accuracy) < 0.35) {
      lines.push(`${label} 止盈决策偏早（正确率 ${pct(tp.accuracy)}）。`);
    }
    if (sl?.evaluable >= 3 && Number(sl.accuracy) >= 0.55) {
      lines.push(`${label} 止损决策有效（正确率 ${pct(sl.accuracy)}）。`);
    }
  }

  const p3 = paper.plan3;
  if (p3 && p3.settledOrders > 0) {
    lines.push(`Plan3 结算扫盘：${p3.settledOrders} 笔 settled，胜率 ${pct(p3.winRate)}，累计 ${pct(p3.totalReturn)}。`);
    const fillRate = paper.plan3Analytics?.fillRate;
    if (fillRate != null && fillRate < 0.5) {
      lines.push(`Plan3 成交率 ${pct(fillRate)} 偏低，检查时间窗/确定性门槛或 opportunity log。`);
    }
  }

  if (paper.comparison.leader === 'plan2' && p1.totalReturn < p2.totalReturn) {
    lines.push(`当前累计领先：Plan2（${pct(p2.totalReturn)} vs Plan1 ${pct(p1.totalReturn)}）。`);
  } else if (paper.comparison.leader === 'plan1') {
    lines.push(`当前累计领先：Plan1（${pct(p1.totalReturn)} vs Plan2 ${pct(p2.totalReturn)}）。`);
  } else if (paper.comparison.leader === 'plan3' && p3) {
    lines.push(`当前累计领先：Plan3（${pct(p3.totalReturn)}）。`);
  }

  return lines.slice(0, 12);
}

export function renderHourlyMonitorMarkdown(snapshot) {
  const { shanghai, paper, live, readiness, signals, exitDecisions, conclusions } = snapshot;
  const lines = [
    '---',
    'tags:',
    '  - monitor',
    '  - hourly',
    '  - polymarket',
    `hour: ${shanghai.hourLabel}`,
    '---',
    '',
    `# 小时监测 ${shanghai.hourLabel}`,
    '',
    `> 生成时间：${shanghai.isoLocal}`,
    '',
    '## 结论摘要',
    '',
    ...conclusions.map((line) => `- ${line}`),
    '',
    '## 模拟盘总览',
    '',
    '| 计划 | 净值 | 累计收益 | 胜率 | 未平仓 | 今日 PnL |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    `| Plan1 | ${money(paper.plan1.equity)} | ${pct(paper.plan1.totalReturn)} | ${pct(paper.plan1.winRate)} | ${paper.plan1.openOrders} | ${money(paper.plan1.dailyPnl)} |`,
    `| Plan2 | ${money(paper.plan2.equity)} | ${pct(paper.plan2.totalReturn)} | ${pct(paper.plan2.winRate)} | ${paper.plan2.openOrders} | ${money(paper.plan2.dailyPnl)} |`,
    `| Plan3 | ${money(paper.plan3.equity)} | ${pct(paper.plan3.totalReturn)} | ${pct(paper.plan3.winRate)} | ${paper.plan3.openOrders} | ${money(paper.plan3.dailyPnl)} |`,
    '',
    '## Plan3 结算扫盘（累计）',
    '',
    '| 指标 | 数值 |',
    '| --- | ---: |',
    `| 提交 | ${paper.plan3Analytics?.submittedOrders ?? '--'} |`,
    `| 成交 | ${paper.plan3Analytics?.filledOrders ?? '--'} |`,
    `| 成交率 | ${pct(paper.plan3Analytics?.fillRate)} |`,
    `| 已结算 | ${paper.plan3Analytics?.settledOrders ?? paper.plan3.settledOrders ?? '--'} |`,
    `| 结算胜率 | ${pct(paper.plan3Analytics?.winRateSettled ?? paper.plan3.winRate)} |`,
    `| 平均 gross edge | ${pct(paper.plan3Analytics?.avgGrossEdge)} |`,
    '',
    '详见：[[plan3/结算扫盘统计|Plan3 结算扫盘统计]] · [[plan3/Plan3-策略说明|Plan3 策略说明]]',
    '',
    '## 过去 1 小时',
    '',
    '| 类型 | 笔数 | 胜率 | PnL | 买额 |',
    '| --- | ---: | ---: | ---: | ---: |',
    `| 模拟 | ${paper.lastHour.count} | ${pct(paper.lastHour.winRate)} | ${money(paper.lastHour.pnl)} | ${money(paper.lastHour.invested)} |`,
    `| 实盘 | ${live.lastHour.count} | ${pct(live.lastHour.winRate)} | ${money(live.lastHour.pnl)} | ${money(live.lastHour.invested)} |`,
    '',
    '## Plan1 分桶（累计 settled）',
    '',
    '### 按周期',
    '',
    renderBucketTable(paper.plan1Analytics?.byTimeframe, ['count', 'winRate', 'totalPnl', 'avgWinPct', 'avgLossPct']),
    '',
    '### 按出场原因',
    '',
    renderBucketTable(paper.plan1Analytics?.byExitReason, ['count', 'winRate', 'totalPnl']),
    '',
    '### 按入场价',
    '',
    renderBucketTable(paper.plan1Analytics?.byEntryPriceBucket, ['count', 'winRate', 'totalPnl']),
    '',
    '## 实盘状态',
    '',
    '| 项目 | 值 |',
    '| --- | --- |',
    `| 监控开关 | ${live.control.enabled ? '开' : '关'} |`,
    `| CLOB 余额 | ${money(live.control.balanceUsdc)} |`,
    `| 实盘累计 PnL | ${money(live.control.pnlUsdc)} |`,
    `| 实盘胜率 | ${pct(live.stats?.winRate)} |`,
    `| 未平仓 | ${live.openPositions} |`,
    `| 自动实盘 | ${live.auto.enabled ? `${(live.auto.enabledPlans || [live.auto.planId]).filter(Boolean).join(' + ') || '--'} · ${live.auto.lastAction || '--'}` : '关'} |`,
    `| 最近原因 | ${live.auto.lastReason || '--'} |`,
    '',
    '## 退出决策质量（累计）',
    '',
    '| 范围 | 可评估 | 正确率 | 止盈正确率 | 止损正确率 |',
    '| --- | ---: | ---: | ---: | ---: |',
    `| Plan1 模拟 | ${exitDecisions?.plan1?.evaluable ?? '--'} | ${pct(exitDecisions?.plan1?.accuracy)} | ${pct(exitDecisions?.plan1?.byExitStatus?.['take-profit']?.accuracy)} | ${pct(exitDecisions?.plan1?.byExitStatus?.['stop-loss']?.accuracy)} |`,
    `| Plan2 模拟 | ${exitDecisions?.plan2?.evaluable ?? '--'} | ${pct(exitDecisions?.plan2?.accuracy)} | ${pct(exitDecisions?.plan2?.byExitStatus?.['take-profit']?.accuracy)} | ${pct(exitDecisions?.plan2?.byExitStatus?.['stop-loss']?.accuracy)} |`,
    `| 实盘 | ${exitDecisions?.live?.evaluable ?? '--'} | ${pct(exitDecisions?.live?.accuracy)} | ${pct(exitDecisions?.live?.byExitStatus?.['take-profit']?.accuracy)} | ${pct(exitDecisions?.live?.byExitStatus?.['stop-loss']?.accuracy)} |`,
    '',
    '详见：[[monitor/exit-decisions/latest|退出决策汇总]] · [[plan1/退出决策统计]] · [[plan2/退出决策统计]] · [[live/退出决策统计]] · [[plan3/结算扫盘统计]]',
    ''
  ];

  if (readiness) {
    lines.push(
      '## Readiness',
      '',
      '| 项目 | 值 |',
      '| --- | --- |',
      `| ready | ${readiness.ready ? '是' : '否'} |`,
      `| 余额 | ${money(readiness.balanceUsdc)} |`,
      `| 挂单 | ${readiness.openOrders ?? '--'} |`,
      `| 卖出授权 | ${readiness.sellApproval || '--'} |`,
      ''
    );
    if (readiness.proxyWalletNote) {
      lines.push(`> ${readiness.proxyWalletNote}`, '');
    }
  }

  if (signals?.totalToday) {
    lines.push(
      '## 技术信号（今日）',
      '',
      `- 总判断：${signals.totalToday}`,
      `- 15m 综合 10-15m 阶段准确率：${signals.compositePhase3Accuracy != null ? pct(signals.compositePhase3Accuracy) : '--'}`,
      ''
    );
  }

  lines.push('---', '', '*由 hourlyMonitor 自动生成*', '');
  return lines.join('\n');
}

export async function writeHourlyMonitorReport(snapshot, recordDir) {
  const dir = join(recordDir, 'monitor', snapshot.shanghai.date);
  await mkdir(dir, { recursive: true });
  const markdown = renderHourlyMonitorMarkdown(snapshot);
  const hourFile = join(dir, `${snapshot.shanghai.hour}.md`);
  const latestFile = join(recordDir, 'monitor', 'latest.md');
  await writeFile(hourFile, markdown, 'utf8');
  await writeFile(latestFile, markdown, 'utf8');
  return { hourFile, latestFile, markdown };
}

export async function runHourlyMonitor({
  polymarketTrading,
  buildReadiness,
  predictionRecorder,
  recordDir,
  now = new Date()
} = {}) {
  const readiness = typeof buildReadiness === 'function'
    ? await buildReadiness()
    : null;
  let predictionSummary = null;
  if (predictionRecorder?.readDailySummary) {
    try {
      predictionSummary = await predictionRecorder.readDailySummary(now);
    } catch {
      predictionSummary = null;
    }
  }

  const snapshot = buildHourlyMonitorSnapshot({
    polymarketTrading,
    readiness,
    predictionSummary,
    now
  });
  snapshot.conclusions = deriveMonitorConclusions(snapshot);

  const files = recordDir
    ? await writeHourlyMonitorReport(snapshot, recordDir)
    : { hourFile: null, latestFile: null, markdown: renderHourlyMonitorMarkdown(snapshot) };

  let exitDecisionFiles = null;
  if (recordDir && polymarketTrading?.computeExitDecisionAnalytics) {
    try {
      exitDecisionFiles = await writeExitDecisionReports({ polymarketTrading, recordDir, now });
    } catch (error) {
      exitDecisionFiles = { error: error.message };
    }
  }

  return { snapshot, ...files, exitDecisionFiles };
}

function collectHourPaperOrders(polymarketTrading, now) {
  const orders = [];
  for (const planId of ['plan1', 'plan2', 'plan3']) {
    for (const order of polymarketTrading.getBucket(planId).paperOrders || []) {
      if (order.settlementStatus !== 'settled') continue;
      const ts = order.settledAtIso || order.createdAtIso;
      if (!inLastHour(ts, now)) continue;
      orders.push({ ...order, planId });
    }
  }
  return orders;
}

function filterLastHour(orders, now) {
  return (orders || []).filter((order) => {
    const ts = order.closedAtIso || order.filledAtIso || order.createdAtIso;
    return inLastHour(ts, now);
  });
}

function summarizeHourOrders(orders, kind) {
  const settled = (orders || []).filter((o) => {
    if (kind === 'paper') return o.settlementStatus === 'settled' || o.won != null;
    return o.orderSide !== 'SELL' && Number.isFinite(Number(o.pnl));
  });
  const wins = settled.filter((o) => Number(o.pnl) > 0 || o.won === true);
  const pnl = settled.reduce((s, o) => s + (Number(o.pnl) || 0), 0);
  const invested = settled.reduce((s, o) => s + (Number(o.usd) || 0), 0);
  return {
    count: settled.length,
    wins: wins.length,
    winRate: settled.length ? wins.length / settled.length : 0,
    pnl: round2(pnl),
    invested: round2(invested)
  };
}

function summarizePlanStats(stats) {
  return {
    equity: round2(stats.equity),
    totalReturn: round4(stats.totalReturn),
    winRate: round4(stats.winRate),
    openOrders: stats.openOrders || 0,
    settledOrders: stats.settledOrders || 0,
    realizedPnl: round2(stats.realizedPnl),
    dailyPnl: round2(stats.dailyRealizedPnl)
  };
}

function compactPlan1Analytics(analytics) {
  if (!analytics) return null;
  return {
    overall: analytics.overall,
    byTimeframe: analytics.byTimeframe,
    byExitReason: analytics.byExitReason,
    byEntryPriceBucket: analytics.byEntryPriceBucket
  };
}

function findWorstExitBucket(byExitReason = {}) {
  let worst = null;
  for (const [key, bucket] of Object.entries(byExitReason)) {
    const pnl = Number(bucket?.totalPnl) || 0;
    if (pnl >= 0) continue;
    if (!worst || pnl < worst.totalPnl) {
      worst = { key, count: bucket.count, totalPnl: pnl };
    }
  }
  return worst;
}

function renderBucketTable(buckets = {}, columns) {
  const keys = Object.keys(buckets);
  if (!keys.length) return '_暂无数据_';
  const header = ['分桶', ...columns];
  const rows = keys.map((key) => {
    const b = buckets[key];
    return `| ${key} | ${columns.map((col) => formatCell(col, b[col])).join(' | ')} |`;
  });
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows
  ].join('\n');
}

function formatCell(col, value) {
  if (col === 'winRate') return pct(value);
  if (col.includes('Pct') || col.includes('Return')) return pct(value);
  if (col.includes('Pnl') || col === 'totalPnl') return money(value);
  return value ?? '--';
}

function inLastHour(iso, now) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t >= now.getTime() - HOUR_MS;
}

function formatShanghaiHour(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  const dateStr = `${get('year')}-${get('month')}-${get('day')}`;
  const hour = get('hour');
  return {
    date: dateStr,
    hour,
    hourLabel: `${dateStr} ${hour}:00`,
    isoLocal: new Date(date).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  };
}

function pct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  return `${(n * 100).toFixed(1)}%`;
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  return n >= 0 ? `$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}
