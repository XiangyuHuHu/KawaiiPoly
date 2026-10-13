import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderPlan3LossMarkdown } from './polymarketPlan3LossAnalytics.js';

const EARLY_EXIT_STATUSES = new Set([
  'model-stop-loss',
  'model-take-profit',
  'take-profit',
  'stop-loss',
  'time-stop',
  'direction-reversal-stop',
  'direction-flip',
  'dynamic-take-profit',
  'trailing-take-profit',
  'plan5-reversal-stop',
  'plan5-emergency-stop'
]);

export const EXIT_STATUS_LABELS = {
  'model-stop-loss': '模型止损',
  'model-take-profit': '模型止盈',
  'take-profit': '止盈',
  'stop-loss': '止损',
  'time-stop': '时间止损',
  'direction-reversal-stop': '反转止损',
  'direction-flip': '反向翻转',
  'dynamic-take-profit': '动态止盈',
  'trailing-take-profit': '回撤止盈',
  'plan5-reversal-stop': 'Plan5 反转止损',
  'plan5-emergency-stop': 'Plan5 紧急止损'
};

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function normalizeDirection(value) {
  const dir = String(value || '').toLowerCase();
  return dir === 'up' || dir === 'down' ? dir : null;
}

function directionLabel(direction) {
  return direction === 'up' ? '涨' : '跌';
}

export function isEarlyExitStatus(exitStatus) {
  return EARLY_EXIT_STATUSES.has(String(exitStatus || '').toLowerCase());
}

export function classifyExitDecision({ direction, exitStatus, actualDirection }) {
  const dir = normalizeDirection(direction);
  const actual = normalizeDirection(actualDirection);
  const status = String(exitStatus || '').toLowerCase();

  if (!isEarlyExitStatus(status)) {
    return {
      evaluable: false,
      holdWouldWin: null,
      exitDecisionCorrect: null,
      label: null,
      explanation: '非提前退出，不参与评估'
    };
  }

  if (!dir) {
    return {
      evaluable: false,
      holdWouldWin: null,
      exitDecisionCorrect: null,
      label: null,
      explanation: '押注方向无效'
    };
  }

  if (!actual) {
    return {
      evaluable: false,
      holdWouldWin: null,
      exitDecisionCorrect: null,
      label: null,
      explanation: '窗口到期结果待回填'
    };
  }

  const holdWouldWin = dir === actual;
  const exitDecisionCorrect = dir !== actual;
  const exitLabel = EXIT_STATUS_LABELS[status] || '提前退出';
  const explanation = exitDecisionCorrect
    ? `${exitLabel}正确：到期方向为${directionLabel(actual)}，持有至到期将亏损`
    : `${exitLabel}错误：到期方向为${directionLabel(actual)}，持有至到期将盈利`;

  return {
    evaluable: true,
    holdWouldWin,
    exitDecisionCorrect,
    label: exitDecisionCorrect ? 'correct' : 'wrong',
    explanation
  };
}

export function computeCounterfactualHoldPnl(order, actualDirection) {
  const dir = normalizeDirection(order?.direction);
  const actual = normalizeDirection(actualDirection);
  const usd = Number(order?.usd) || 0;
  const shares = Number(order?.shares) || 0;
  if (!dir || !actual || !Number.isFinite(usd) || !Number.isFinite(shares)) return null;
  const holdWouldWin = dir === actual;
  const payout = holdWouldWin ? round2(shares) : 0;
  return round2(payout - usd);
}

export function applyExitDecisionEvaluation(order, outcome) {
  if (!outcome?.actualDirection) return false;

  const classification = classifyExitDecision({
    direction: order.direction,
    exitStatus: order.exitStatus,
    actualDirection: outcome.actualDirection
  });

  order.actualDirection = outcome.actualDirection;
  order.actualClose = Number(outcome.actualClose) || order.actualClose || null;
  order.startPrice = Number(outcome.startPrice ?? order.startPrice) || order.startPrice || null;
  order.holdWouldWin = classification.holdWouldWin;
  order.exitDecisionCorrect = classification.exitDecisionCorrect;

  if (isEarlyExitStatus(order.exitStatus)) {
    order.counterfactualHoldPnl = computeCounterfactualHoldPnl(order, outcome.actualDirection);
    const realizedPnl = Number(order.pnl);
    order.exitVsHoldPnlDelta = Number.isFinite(realizedPnl) && Number.isFinite(order.counterfactualHoldPnl)
      ? round2(realizedPnl - order.counterfactualHoldPnl)
      : null;
  } else {
    order.counterfactualHoldPnl = null;
    order.exitVsHoldPnlDelta = null;
  }

  order.exitDecisionEvaluatedAtIso = new Date().toISOString();
  if (outcome.priceSource === 'polymarket-official') {
    order.counterfactualOutcomeSource = 'polymarket-official';
    order.officialOutcome = outcome.officialOutcome || outcome.actualDirection;
    order.officialOutcomePrices = outcome.outcomePrices || null;
  }
  return true;
}

function summarizeExitBucket(orders = []) {
  const evaluable = orders.filter((order) => order.exitDecisionCorrect === true || order.exitDecisionCorrect === false);
  const correct = evaluable.filter((order) => order.exitDecisionCorrect === true).length;
  const wrong = evaluable.filter((order) => order.exitDecisionCorrect === false).length;
  return {
    count: orders.length,
    evaluable: evaluable.length,
    correct,
    wrong,
    accuracy: evaluable.length ? correct / evaluable.length : null
  };
}

function pickRecentEvaluableOrder(order) {
  const classification = classifyExitDecision({
    direction: order.direction,
    exitStatus: order.exitStatus,
    actualDirection: order.actualDirection
  });
  return {
    id: order.id,
    planId: order.planId || null,
    timeframe: order.timeframe || '15m',
    direction: order.direction || null,
    exitStatus: order.exitStatus || null,
    actualDirection: order.actualDirection || null,
    pnl: Number.isFinite(Number(order.pnl)) ? Number(order.pnl) : null,
    counterfactualHoldPnl: Number.isFinite(Number(order.counterfactualHoldPnl))
      ? Number(order.counterfactualHoldPnl)
      : null,
    exitVsHoldPnlDelta: Number.isFinite(Number(order.exitVsHoldPnlDelta))
      ? Number(order.exitVsHoldPnlDelta)
      : null,
    exitDecisionCorrect: order.exitDecisionCorrect ?? null,
    holdWouldWin: order.holdWouldWin ?? null,
    label: classification.label,
    explanation: classification.explanation,
    settledAtIso: order.settledAtIso || order.closedAtIso || null,
    exitDecisionEvaluatedAtIso: order.exitDecisionEvaluatedAtIso || null
  };
}

export function computeExitDecisionAnalytics(orders = []) {
  const earlyExits = (orders || []).filter((order) => isEarlyExitStatus(order.exitStatus));
  const evaluableOrders = earlyExits.filter((order) => (
    order.exitDecisionCorrect === true || order.exitDecisionCorrect === false
  ));
  const pending = earlyExits.length - evaluableOrders.length;
  const correct = evaluableOrders.filter((order) => order.exitDecisionCorrect === true).length;
  const wrong = evaluableOrders.filter((order) => order.exitDecisionCorrect === false).length;

  const byExitStatus = {};
  for (const order of earlyExits) {
    const key = String(order.exitStatus || '').toLowerCase();
    if (!byExitStatus[key]) byExitStatus[key] = [];
    byExitStatus[key].push(order);
  }

  const byTimeframe = {};
  for (const tf of ['5m', '15m']) {
    byTimeframe[tf] = summarizeExitBucket(evaluableOrders.filter((order) => (order.timeframe || '15m') === tf));
  }

  const byPlanId = {};
  const planIds = new Set(['plan1', 'plan2']);
  for (const order of earlyExits) planIds.add(order.planId || 'plan1');
  for (const planId of planIds) {
    byPlanId[planId] = summarizeExitBucket(evaluableOrders.filter((order) => (order.planId || 'plan1') === planId));
  }

  const recentEvaluable = evaluableOrders
    .slice()
    .sort((left, right) => {
      const leftMs = Date.parse(left.exitDecisionEvaluatedAtIso || left.settledAtIso || left.closedAtIso || 0);
      const rightMs = Date.parse(right.exitDecisionEvaluatedAtIso || right.settledAtIso || right.closedAtIso || 0);
      return rightMs - leftMs;
    })
    .slice(0, 20)
    .map(pickRecentEvaluableOrder);

  return {
    total: earlyExits.length,
    evaluable: evaluableOrders.length,
    pending,
    correct,
    wrong,
    accuracy: evaluableOrders.length ? correct / evaluableOrders.length : null,
    byExitStatus: Object.fromEntries(
      Object.entries(byExitStatus).map(([key, bucketOrders]) => [key, summarizeExitBucket(bucketOrders)])
    ),
    byTimeframe,
    byPlanId,
    recentEvaluable
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

function formatShanghaiLocal(iso) {
  if (!iso) return '--';
  return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function exitStatusLabel(status) {
  return EXIT_STATUS_LABELS[String(status || '').toLowerCase()] || status || '--';
}

function decisionLabel(correct) {
  if (correct === true) return '正确';
  if (correct === false) return '错误';
  return '待评估';
}

function renderExitStatusTable(byExitStatus = {}) {
  const keys = Object.keys(byExitStatus);
  if (!keys.length) return '_暂无提前退出数据_';
  const rows = keys.map((key) => {
    const b = byExitStatus[key];
    return `| ${exitStatusLabel(key)} | ${b.count} | ${b.evaluable} | ${b.correct} | ${b.wrong} | ${pct(b.accuracy)} |`;
  });
  return [
    '| 退出类型 | 笔数 | 可评估 | 正确 | 错误 | 正确率 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...rows
  ].join('\n');
}

function renderTimeframeTable(byTimeframe = {}) {
  const keys = ['5m', '15m'].filter((key) => byTimeframe[key]?.count > 0);
  if (!keys.length) return '_暂无数据_';
  const rows = keys.map((key) => {
    const b = byTimeframe[key];
    return `| ${key} | ${b.count} | ${b.evaluable} | ${b.correct} | ${b.wrong} | ${pct(b.accuracy)} |`;
  });
  return [
    '| 周期 | 笔数 | 可评估 | 正确 | 错误 | 正确率 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...rows
  ].join('\n');
}

function renderRecentExitTable(recentEvaluable = []) {
  if (!recentEvaluable.length) return '_暂无最近记录_';
  const rows = recentEvaluable.map((order) => {
    const ts = formatShanghaiLocal(order.settledAtIso || order.exitDecisionEvaluatedAtIso);
    return `| ${ts} | ${order.timeframe || '--'} | ${directionLabel(order.direction)} | ${exitStatusLabel(order.exitStatus)} | ${directionLabel(order.actualDirection)} | ${decisionLabel(order.exitDecisionCorrect)} | ${money(order.pnl)} | ${money(order.counterfactualHoldPnl)} | ${money(order.exitVsHoldPnlDelta)} |`;
  });
  return [
    '| 时间 | 周期 | 押注 | 退出 | 到期 | 判定 | 实盈 | 持有PnL | 差额 |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows
  ].join('\n');
}

export function deriveExitDecisionConclusions(analytics) {
  const lines = [];
  if (!analytics?.evaluable) {
    lines.push('暂无足够提前退出样本。');
    return lines;
  }
  lines.push(`累计 ${analytics.evaluable} 笔可评估，决策正确率 ${pct(analytics.accuracy)}。`);
  const tp = analytics.byExitStatus?.['take-profit'];
  const sl = analytics.byExitStatus?.['stop-loss'];
  if (tp?.evaluable >= 5) {
    if (Number(tp.accuracy) < 0.35) {
      lines.push(`止盈决策偏早（正确率 ${pct(tp.accuracy)}），多数情况下持有至到期本可赢。`);
    } else if (Number(tp.accuracy) >= 0.55) {
      lines.push(`止盈决策质量较好（正确率 ${pct(tp.accuracy)}）。`);
    }
  }
  if (sl?.evaluable >= 5) {
    if (Number(sl.accuracy) >= 0.55) {
      lines.push(`止损决策有效（正确率 ${pct(sl.accuracy)}），多数止损躲开了到期亏损。`);
    } else if (Number(sl.accuracy) < 0.4) {
      lines.push(`止损偏敏感（正确率 ${pct(sl.accuracy)}），存在「止损后方向仍对」的情况。`);
    }
  }
  if (analytics.pending > 0) {
    lines.push(`${analytics.pending} 笔提前退出待窗口到期回填。`);
  }
  return lines.slice(0, 6);
}

export function renderExitDecisionMarkdown(analytics, {
  title = '退出决策质量统计',
  scope = 'all',
  generatedAtIso = new Date().toISOString()
} = {}) {
  const updatedAt = formatShanghaiLocal(generatedAtIso);
  const conclusions = deriveExitDecisionConclusions(analytics);
  const scopeTag = scope === 'live' ? 'live' : scope;

  const lines = [
    '---',
    'tags:',
    '  - exit-decision',
    `  - ${scopeTag}`,
    '  - polymarket',
    '---',
    '',
    `# ${title}`,
    '',
    `> 更新时间：${updatedAt}`,
    '>',
    '> **判定规则**：提前退出后，若窗口到期方向与押注相反 → 退出**正确**（持有会亏）；若到期方向与押注相同 → 退出**错误**（持有会赢）。',
    '',
    '## 结论摘要',
    '',
    ...conclusions.map((line) => `- ${line}`),
    '',
    '## 总览',
    '',
    '| 指标 | 值 |',
    '| --- | ---: |',
    `| 提前退出笔数 | ${analytics.total} |`,
    `| 可评估 | ${analytics.evaluable} |`,
    `| 待回填 | ${analytics.pending} |`,
    `| 决策正确 | ${analytics.correct} |`,
    `| 决策错误 | ${analytics.wrong} |`,
    `| 正确率 | ${pct(analytics.accuracy)} |`,
    '',
    '## 按退出类型',
    '',
    renderExitStatusTable(analytics.byExitStatus),
    '',
    '## 按周期',
    '',
    renderTimeframeTable(analytics.byTimeframe),
    '',
    '## 最近 20 笔',
    '',
    renderRecentExitTable(analytics.recentEvaluable),
    '',
    '---',
    '',
    '*由 exitDecisionAnalytics 自动生成*',
    ''
  ];
  return lines.join('\n');
}

export async function writeExitDecisionReports({
  polymarketTrading,
  recordDir,
  now = new Date()
} = {}) {
  if (!polymarketTrading || !recordDir) {
    throw new Error('polymarketTrading and recordDir are required.');
  }

  const generatedAtIso = now.toISOString();

  const scopes = [
    {
      scope: 'plan1',
      dir: join(recordDir, 'plan1'),
      file: '退出决策统计.md',
      title: 'Plan1 退出决策质量统计（模拟）',
      analytics: polymarketTrading.computeExitDecisionAnalytics({ planId: 'plan1', includeLive: false })
    },
    {
      scope: 'plan2',
      dir: join(recordDir, 'plan2'),
      file: '退出决策统计.md',
      title: 'Plan2 退出决策质量统计（模拟）',
      analytics: polymarketTrading.computeExitDecisionAnalytics({ planId: 'plan2', includeLive: false })
    },
    {
      scope: 'live',
      dir: join(recordDir, 'live'),
      file: '退出决策统计.md',
      title: '实盘退出决策质量统计',
      analytics: polymarketTrading.computeExitDecisionAnalytics({ source: 'live' })
    }
  ];

  await mkdir(join(recordDir, 'monitor', 'exit-decisions'), { recursive: true });

  const files = {};
  for (const item of scopes) {
    await mkdir(item.dir, { recursive: true });
    const markdown = renderExitDecisionMarkdown(item.analytics, {
      title: item.title,
      scope: item.scope,
      generatedAtIso
    });
    const target = join(item.dir, item.file);
    await writeFile(target, markdown, 'utf8');
    files[item.scope] = target;
  }

  const summaryMarkdown = [
    '---',
    'tags:',
    '  - exit-decision',
    '  - monitor',
    '---',
    '',
    '# 退出决策统计汇总',
    '',
    `> 更新时间：${formatShanghaiLocal(generatedAtIso)}`,
    '',
    '| 范围 | 可评估 | 正确率 | 止盈正确率 | 止损正确率 |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...scopes.map(({ scope, analytics }) => {
      const tp = analytics.byExitStatus?.['take-profit'];
      const sl = analytics.byExitStatus?.['stop-loss'];
      const label = scope === 'live' ? '实盘' : scope.toUpperCase();
      return `| ${label} | ${analytics.evaluable} | ${pct(analytics.accuracy)} | ${pct(tp?.accuracy)} | ${pct(sl?.accuracy)} |`;
    }),
    '',
    '## 分文档',
    '',
    '- [[plan1/退出决策统计]]',
    '- [[plan2/退出决策统计]]',
    '- [[live/退出决策统计]]',
    '- [[plan3/结算扫盘统计]]（Plan3 无 TP/SL，见 settlement_capture 指标）',
    '- [[plan3/亏损原因统计]]（Plan3 结算亏损归因 / 反转检测）',
    '',
    '---',
    '',
    '*由 exitDecisionAnalytics 自动生成*',
    ''
  ].join('\n');

  const summaryFile = join(recordDir, 'monitor', 'exit-decisions', 'latest.md');
  await writeFile(summaryFile, summaryMarkdown, 'utf8');
  files.summary = summaryFile;

  return { files, generatedAtIso, scopes: Object.fromEntries(scopes.map((s) => [s.scope, s.analytics])) };
}

export function renderPlan3SettlementMarkdown(analytics = {}, { generatedAtIso = new Date().toISOString() } = {}) {
  const skipCounts = analytics.skipReasonCounts || {};
  const skipLines = Object.entries(skipCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([reason, count]) => `| ${reason} | ${count} |`)
    .join('\n');

  return [
    '---',
    'tags:',
    '  - polymarket',
    '  - plan3',
    '  - settlement_capture',
    '---',
    '',
    '# Plan3 结算扫盘统计（模拟）',
    '',
    `> 更新时间：${formatShanghaiLocal(generatedAtIso)}`,
    '',
    '| 指标 | 数值 |',
    '| --- | ---: |',
    `| 提交订单 | ${analytics.submittedOrders ?? 0} |`,
    `| 成交订单 | ${analytics.filledOrders ?? 0} |`,
    `| 成交率 | ${pct(analytics.fillRate)} |`,
    `| 已结算 | ${analytics.settledOrders ?? 0} |`,
    `| 结算胜率 | ${pct(analytics.winRateSettled)} |`,
    `| 平均买入价 | ${pct(analytics.avgEntryPrice)} |`,
    `| 平均 gross edge | ${pct(analytics.avgGrossEdge)} |`,
    `| 每次提交平均利润 | $${Number(analytics.profitPerSubmittedOrder || 0).toFixed(2)} |`,
    `| 每次成交平均利润 | $${Number(analytics.profitPerFilledOrder || 0).toFixed(2)} |`,
    `| 累计 PnL | $${Number(analytics.totalPnl || 0).toFixed(2)} |`,
    `| 错误结算次数 | ${analytics.wrongSettlementCount ?? 0} |`,
    `| 观察记录 | ${analytics.opportunitiesLogged ?? 0} |`,
    '',
    '## 跳过原因 Top',
    '',
    '| skipReason | 次数 |',
    '| --- | ---: |',
    skipLines || '| -- | 0 |',
    '',
    '---',
    '',
    '*由 computePlan3Analytics 自动生成*',
    ''
  ].join('\n');
}

export async function writePlan3SettlementReports({
  polymarketTrading,
  recordDir,
  now = new Date()
} = {}) {
  if (!polymarketTrading || !recordDir) {
    return null;
  }

  const analytics = polymarketTrading.computePlan3Analytics('plan3');
  const dir = join(recordDir, 'plan3');
  await mkdir(dir, { recursive: true });
  const target = join(dir, '结算扫盘统计.md');
  const markdown = renderPlan3SettlementMarkdown(analytics, { generatedAtIso: now.toISOString() });
  await writeFile(target, markdown, 'utf8');

  const lossFiles = {};
  try {
    const lossReport = await writePlan3LossReports({ polymarketTrading, recordDir, now });
    Object.assign(lossFiles, lossReport?.files || {});
  } catch {
    // 亏损归因报告失败不阻断结算扫盘统计
  }

  return { file: target, analytics, lossFiles };
}

export async function writePlan3LossReports({
  polymarketTrading,
  recordDir,
  now = new Date()
} = {}) {
  if (!polymarketTrading || !recordDir) {
    return null;
  }

  const generatedAtIso = now.toISOString();
  const dir = join(recordDir, 'plan3');
  await mkdir(dir, { recursive: true });

  const scopes = [
    { scope: 'all', file: '亏损原因统计.md', title: 'Plan3 亏损原因统计（纸面+实盘）', source: 'all' },
    { scope: 'live', file: '亏损原因统计-实盘.md', title: 'Plan3 实盘亏损原因统计', source: 'live' },
    { scope: 'paper', file: '亏损原因统计-模拟.md', title: 'Plan3 模拟亏损原因统计', source: 'paper' }
  ];

  const files = {};
  const analyticsByScope = {};
  for (const item of scopes) {
    const analytics = polymarketTrading.computePlan3LossAnalytics({ source: item.source, limit: 40 });
    analyticsByScope[item.scope] = analytics;
    const markdown = renderPlan3LossMarkdown(analytics, {
      title: item.title,
      generatedAtIso,
      scope: item.scope
    });
    const target = join(dir, item.file);
    await writeFile(target, markdown, 'utf8');
    files[item.scope] = target;
  }

  return { files, analyticsByScope, generatedAtIso };
}
