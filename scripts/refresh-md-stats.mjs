import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PredictionRecorder } from '../src/predictionRecorder.js';

const recordDir = process.argv[2] || 'D:/Obsidian仓库/Kawaii的仓库/投资/虚拟币/比特币猜输赢记录';
const recorder = new PredictionRecorder({ recordDir, fetchQuotes: async () => [], enabled: true });

function buildStatsSection(summary) {
  const phaseLabels = [
    ['tech', '5m 技术'],
    ['polymarket', '5m Polymarket'],
    ['composite', '5m 综合']
  ];
  const rows = [[`总判断次数`, String(summary.total)]];
  for (const [key, prefix] of phaseLabels) {
    for (const phaseKey of ['phase1', 'phase2', 'phase3']) {
      const item = summary.phases[key][phaseKey];
      const total = Number(item.total ?? (item.correct + item.wrong));
      const detail = total ? `正确 ${item.correct} / 错误 ${item.wrong}` : '--';
      rows.push([
        `${prefix} ${item.label} 正确率`,
        `${(item.accuracy * 100).toFixed(2)}% · ${detail}`
      ]);
    }
  }
  return [
    '## 统计',
    '',
    '| 项目 | 数值 |',
    '| --- | ---: |',
    ...rows.map(([label, value]) => `| ${label} | ${value} |`)
  ].join('\n');
}

for (const name of await readdir(recordDir)) {
  if (!name.endsWith('.md')) continue;
  const date = name.replace('.md', '');
  const filePath = join(recordDir, name);
  const summary = await recorder.readDailySummary(new Date(`${date}T12:00:00+08:00`));
  if (!summary.total) continue;
  let markdown = await readFile(filePath, 'utf8');
  markdown = markdown.replace(/## 统计[\s\S]*?(?=## 记录)/, `${buildStatsSection(summary)}\n\n`);
  await writeFile(filePath, markdown, 'utf8');
  console.log(`updated ${name}`);
}
