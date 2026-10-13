import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const STRATEGY_SOURCES = [
  {
    planId: 'plan1',
    sourceFile: 'PLAN1-STRATEGY.md',
    targetFile: 'Plan1-策略说明.md',
    title: 'Plan1 策略说明',
    tags: ['polymarket', 'plan1', '策略'],
    aliases: ['Plan1策略', 'Plan1 v2'],
    compareLink: '[[../plan2/Plan2-策略说明|Plan2]]',
    impl: 'src/plan1Policy.js + src/polymarketPlan.js'
  },
  {
    planId: 'plan2',
    sourceFile: 'POLYMARKET-PLAN2.md',
    targetFile: 'Plan2-策略说明.md',
    title: 'Plan2 策略说明',
    tags: ['polymarket', 'plan2', '策略'],
    aliases: ['Plan2策略'],
    compareLink: '[[../plan1/Plan1-策略说明|Plan1]]',
    impl: 'src/polymarketPlan2.js'
  },
  {
    planId: 'plan3',
    sourceFile: join('docs', 'PLAN3-STRATEGY.md'),
    targetFile: 'Plan3-策略说明.md',
    title: 'Plan3 策略说明 · Settlement Capture',
    tags: ['polymarket', 'plan3', '策略', 'settlement_capture'],
    aliases: ['Plan3策略', '结算扫盘'],
    compareLink: '[[../plan1/Plan1-策略说明|Plan1]] · [[../plan2/Plan2-策略说明|Plan2]]',
    impl: 'src/polymarketPlan3.js'
  }
];

let lastSyncAtMs = 0;

export async function syncStrategyDocs({
  recordDir,
  config = {},
  repoRoot = process.cwd(),
  throttleHours = 0,
  force = false,
  now = new Date()
} = {}) {
  if (!recordDir) return { skipped: true, reason: 'recordDir missing' };

  const throttleMs = Math.max(0, Number(throttleHours) || 0) * 3600 * 1000;
  if (!force && throttleMs > 0 && now.getTime() - lastSyncAtMs < throttleMs) {
    return { skipped: true, reason: 'throttled' };
  }

  const files = {};
  for (const item of STRATEGY_SOURCES) {
    const sourcePath = join(repoRoot, item.sourceFile);
    const targetDir = join(recordDir, item.planId);
    const targetPath = join(targetDir, item.targetFile);
    await mkdir(targetDir, { recursive: true });

    let body = '';
    try {
      body = await readFile(sourcePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      body = `# ${item.title}\n\n> 源文件缺失：\`${item.sourceFile}\`\n`;
    }

    const updated = now.toISOString().slice(0, 10);
    const frontmatter = [
      '---',
      'tags:',
      ...item.tags.map((tag) => `  - ${tag}`),
      'aliases:',
      ...item.aliases.map((alias) => `  - ${alias}`),
      `updated: ${updated}`,
      `source: robinhood量化/${item.sourceFile.replace(/\\/g, '/')}`,
      '---',
      '',
      `> 📁 本文件与代码仓库 \`${item.sourceFile.replace(/\\/g, '/')}\` 同步。每日记录见同目录 \`YYYY-MM-DD.md\`。对比 ${item.compareLink}。`,
      ''
    ].join('\n');

    const markdown = `${frontmatter}${body.trim()}\n`;
    const sourceStat = await stat(sourcePath).catch(() => null);
    const targetStat = await stat(targetPath).catch(() => null);
    if (!force && sourceStat && targetStat && sourceStat.mtimeMs <= targetStat.mtimeMs) {
      files[item.planId] = { path: targetPath, skipped: true };
      continue;
    }
    await writeFile(targetPath, markdown, 'utf8');
    files[item.planId] = { path: targetPath, updated: true };
  }

  for (const item of STRATEGY_SOURCES) {
    await writeFile(join(recordDir, item.planId, '00-目录.md'), renderPlanIndexMarkdown(item), 'utf8');
  }

  await writeFile(join(recordDir, '00-目录.md'), renderRootIndexMarkdown(config, now), 'utf8');
  lastSyncAtMs = now.getTime();
  return { skipped: false, files, syncedAtIso: now.toISOString() };
}

function renderPlanIndexMarkdown(item) {
  const planUpper = item.planId.toUpperCase();
  return `# ${planUpper} 目录

## 文件命名

| 文件 | 类型 | 说明 |
|------|------|------|
| \`${item.targetFile}\` | 策略 | ${planUpper} 完整规则，与代码 \`${item.sourceFile}\` 同步 |
| \`YYYY-MM-DD.md\` | 记录 | 当日 ${planUpper} 模拟订单与统计（自动导出） |
${item.planId === 'plan3' ? '| `结算扫盘统计.md` | 统计 | settlement_capture 成交率与收益（自动导出） |' : ''}
${item.planId !== 'plan3' ? '| `退出决策统计.md` | 统计 | TP/SL 退出质量（自动导出） |' : ''}

## 相关链接

- 对比策略：${item.compareLink}
- 汇总页：上级目录同日期 \`YYYY-MM-DD.md\`
- 代码仓库：\`robinhood量化/${item.impl}\`

## 阅读顺序

1. [[${item.targetFile.replace('.md', '')}]] — 了解规则
2. 最新 \`YYYY-MM-DD.md\` — 看当日表现
`;
}

function renderRootIndexMarkdown(config, now) {
  const updated = now.toISOString().slice(0, 10);
  return `# 比特币猜输赢记录 · 总目录

Polymarket BTC Up/Down 模拟盘、实盘与策略文档的 Obsidian 仓库。

## 文件夹结构

| 路径 | 用途 | 命名规则 |
|------|------|----------|
| [[plan1/00-目录\\|plan1/]] | Plan1 策略与每日模拟 | 见 plan1 目录说明 |
| [[plan2/00-目录\\|plan2/]] | Plan2 策略与每日模拟 | 见 plan2 目录说明 |
| [[plan3/00-目录\\|plan3/]] | Plan3 结算扫盘与每日模拟 | 见 plan3 目录说明 |
| \`实盘/\` | CLOB 实盘成交记录 | \`YYYY-MM-DD.md\` |
| \`monitor/\` | 每小时自动监测与分析 | \`YYYY-MM-DD/HH.md\` + \`latest.md\` |
| 根目录 | 技术信号 + 全 Plan 汇总 | \`YYYY-MM-DD.md\` |

## 策略 vs 记录

- **策略说明**（\`PlanX-策略说明.md\`）：规则文档，由 \`syncStrategyDocs\` 从代码仓库源文件同步
- **每日记录**（\`YYYY-MM-DD.md\`）：由系统自动导出，勿手改格式

## Plan 分工速查

| | Plan1 | Plan2 | Plan3 |
|---|-------|-------|-------|
| 定位 | 中低价 edge、可 flip | 探针/尾盘/高价延迟 | 最后几秒 settlement capture |
| 入场价 | 0.35–0.70 | 0.48–0.94 | 0.990–0.998 |
| 典型场景 | 窗口中段正 edge | probe→主仓、late_capture | 结果定型后扫 99¢ 票 |

## 状态文件（代码侧）

| 文件 | 内容 |
|------|------|
| \`data/polymarket/plan1-state.json\` | Plan1 模拟 |
| \`data/polymarket/plan2-state.json\` | Plan2 模拟 |
| \`data/polymarket/plan3-state.json\` | Plan3 模拟 |
| \`data/polymarket/live-state.json\` | 实盘 liveControl / liveAuto / liveOrders |

---

*最后更新：${updated}*
`;
}
