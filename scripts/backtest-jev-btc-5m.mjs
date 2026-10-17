/**
 * Paper backtest only. Reads local Plan14 research JSONL and public outcome
 * sources. Does not place orders, does not change live-trading flags, and
 * does not import the live order client.
 *
 *   node scripts/backtest-jev-btc-5m.mjs --date 2026-10-16
 */
import { resolve } from 'node:path';
import { PolymarketClient } from '../src/polymarketClient.js';
import { PublicMarketDataClient } from '../src/publicMarketData.js';
import {
  DATA_ASSUMPTIONS, JEV_DEFAULTS, PACIFIC_TIME_ZONE,
  chooseOutcome, cohortReport, filterCalendarDay, indexOfficialOutcomes,
  listResearchFiles, loadResearchDirectory, lookupArchivedOutcome, quotesFromOpportunityFiles,
  schemaCoverage
} from '../src/jevBtc5mBacktest.js';

const args = parseArgs(process.argv.slice(2));
const options = {
  ...JEV_DEFAULTS,
  minEdge: args.minEdge,
  feeRate: args.feeRate,
  modelWeight: args.modelWeight,
  stake: args.stake,
  startingCash: args.startingCash,
  minAsk: args.minAsk,
  maxAsk: args.maxAsk,
  maxSpread: args.maxSpread,
  minRemainingSeconds: args.minRemaining,
  maxRemainingSeconds: args.maxRemaining,
  bucketWidth: args.bucket,
  seed: args.seed
};

const dir = resolve(args.dir);
const loaded = loadResearchDirectory(dir, args.date);
if (!loaded.opportunityFiles.length) {
  const present = listResearchFiles(dir);
  console.error(`没有找到 ${args.date} 前后的 opportunities JSONL。`);
  console.error(`目录: ${dir}`);
  console.error(present.length ? `现有文件: ${present.join(', ')}` : '目录里没有 jsonl（data/ 被 gitignore，云端检出通常不含这份磁带）。');
  console.error('在有研究快照的机器上，从仓库根目录运行: node scripts/backtest-jev-btc-5m.mjs --date 2026-10-16');
  process.exit(1);
}

const { quotes, rejected } = quotesFromOpportunityFiles(loaded.opportunityFiles);
const archived = indexOfficialOutcomes(loaded.outcomeRows);
const pacificQuotes = filterCalendarDay(quotes, args.date, PACIFIC_TIME_ZONE);
const utcQuotes = filterCalendarDay(quotes, args.date, 'UTC');
const resolved = await resolveOutcomes(uniqueSlots([...pacificQuotes, ...utcQuotes]), archived, {
  fetchOfficial: args.fetchOfficial,
  allowSpotFallback: args.spotFallback
});

const outcomeFor = (quote) => resolved.byKey.get(quote.marketSlug || String(quote.targetMs)) || null;
const report = {
  date: args.date,
  paperOnly: true,
  directory: dir,
  files: loaded.opportunityFiles.map((file) => ({ name: file.name, rows: file.rows.length })),
  missingFiles: loaded.missing,
  partialLines: loaded.partial,
  rejected,
  loadedSchema: schemaCoverage(quotes),
  officialConflicts: archived.conflicts,
  outcomeStats: resolved.stats,
  rule: {
    minEdge: options.minEdge,
    feeRate: options.feeRate,
    modelWeight: options.modelWeight,
    stake: options.stake,
    startingCash: options.startingCash,
    minAsk: options.minAsk,
    maxAsk: options.maxAsk,
    maxSpread: options.maxSpread,
    minRemainingSeconds: options.minRemainingSeconds,
    maxRemainingSeconds: options.maxRemainingSeconds,
    bucketWidth: options.bucketWidth,
    seed: options.seed,
    entry: 'first quote in the slot with fee-adjusted edge at or above the threshold'
  },
  assumptions: DATA_ASSUMPTIONS,
  pacific: cohortReport(pacificQuotes, outcomeFor, options),
  utc: cohortReport(utcQuotes, outcomeFor, options)
};
report.cohortsDiffer = report.pacific.summary.trades !== report.utc.summary.trades
  || report.pacific.summary.netPnl !== report.utc.summary.netPnl
  || report.pacific.quotes !== report.utc.quotes;

if (args.json) {
  const { trades: pacificTrades, ...pacific } = report.pacific;
  const { trades: utcTrades, ...utc } = report.utc;
  console.log(JSON.stringify({ ...report, pacific, utc, tradeCounts: { pacific: pacificTrades.length, utc: utcTrades.length } }, null, 2));
} else {
  console.log(formatReport(report));
}

function uniqueSlots(quotes) {
  const slots = new Map();
  for (const quote of quotes) {
    const key = quote.marketSlug || String(quote.targetMs);
    if (!slots.has(key)) slots.set(key, quote);
  }
  return [...slots.values()];
}

async function resolveOutcomes(slots, archivedIndex, { fetchOfficial, allowSpotFallback }) {
  const client = fetchOfficial ? new PolymarketClient() : null;
  const spot = allowSpotFallback ? new PublicMarketDataClient() : null;
  const byKey = new Map();
  const stats = {
    archiveOfficial: 0,
    fetchedOfficial: 0,
    binanceSpot: 0,
    missing: 0,
    disagreements: 0,
    conflicts: 0,
    archiveConflicts: archivedIndex.conflicts,
    fetchErrors: 0
  };
  const pending = [];
  for (const quote of slots) {
    const archivedOutcome = lookupArchivedOutcome(archivedIndex, quote);
    if (archivedOutcome?.conflict) {
      stats.conflicts += 1;
      continue;
    }
    if (archivedOutcome?.actualDirection) {
      byKey.set(quote.marketSlug || String(quote.targetMs), archivedOutcome);
      stats.archiveOfficial += 1;
      continue;
    }
    pending.push(quote);
  }
  await mapPool(pending, 4, async (quote) => {
    const key = quote.marketSlug || String(quote.targetMs);
    let official = null;
    if (client && quote.marketSlug) {
      try {
        const value = await client.getResolvedMarketOutcome(quote.marketSlug);
        if (value?.priceSource === 'polymarket-official' && ['up', 'down'].includes(value.actualDirection)) {
          official = { actualDirection: value.actualDirection, source: 'fetched-polymarket-official' };
        }
      } catch {
        stats.fetchErrors += 1;
      }
    }
    let spotOutcome = null;
    if (!official && spot) {
      try {
        const value = await spot.getWindowPrices('BTC-USD', '5m', quote.targetTimeIso);
        if (['up', 'down'].includes(value?.actualDirection)) {
          spotOutcome = { actualDirection: value.actualDirection, source: 'binance-5m' };
        }
      } catch {
        stats.fetchErrors += 1;
      }
    }
    const chosen = chooseOutcome(official, spotOutcome);
    if (chosen.disagreement) stats.disagreements += 1;
    if (!chosen.outcome) {
      stats.missing += 1;
      return;
    }
    if (chosen.outcome.source === 'fetched-polymarket-official') stats.fetchedOfficial += 1;
    else if (chosen.outcome.source === 'binance-5m') stats.binanceSpot += 1;
    byKey.set(key, chosen.outcome);
  });
  return { byKey, stats };
}

async function mapPool(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

function formatReport(report) {
  const lines = [];
  lines.push('Jev 风格 BTC 5 分钟纸面回测（只读研究，不下单）');
  lines.push(`报告日: ${report.date}`);
  lines.push(`目录: ${report.directory}`);
  lines.push(`机会文件: ${report.files.map((file) => `${file.name} (${file.rows} 行)`).join(', ') || '无'}`);
  if (report.missingFiles.length) lines.push(`未找到（跨日补齐用）: ${report.missingFiles.join(', ')}`);
  if (report.partialLines) lines.push(`忽略了 ${report.partialLines} 条写到一半的末行`);
  lines.push(`规则: 现货相对开盘、剩余时间的正态概率，与盘口中间价按权重 ${report.rule.modelWeight} 混合；扣费后优势 ≥ ${(report.rule.minEdge * 100).toFixed(2)}pp 才买优势更大的一侧；按卖一成交，持有到 $1/$0。每窗只取第一次达标的报价。名义 $${report.rule.stake}，费率参数 ${report.rule.feeRate}。`);
  lines.push('数据假设:');
  for (const item of report.assumptions) lines.push(`  - ${item}`);
  lines.push(formatSchema('已加载 BTC-USD 5m 字段覆盖', report.loadedSchema));
  if (Object.keys(report.rejected).length) {
    lines.push(`未纳入的行: ${Object.entries(report.rejected).map(([reason, count]) => `${reason} ${count}`).join(', ')}`);
  }
  lines.push(formatCohort(`美国太平洋时间 ${report.date}（按报价时间）`, report.pacific, report.rule.bucketWidth));
  lines.push(formatCohort(`UTC ${report.date}（按报价时间）`, report.utc, report.rule.bucketWidth));
  lines.push(report.cohortsDiffer
    ? '太平洋时间与 UTC 的样本不同，因为两个日历日不是同一段时间。'
    : '太平洋时间与 UTC 这两段样本的报价数和净损益相同。');
  lines.push(`结果来源（两个日历日共用同一张结算表）: 官方归档 ${report.outcomeStats.archiveOfficial}，官方补拉 ${report.outcomeStats.fetchedOfficial}，Binance 现货 ${report.outcomeStats.binanceSpot}，缺失 ${report.outcomeStats.missing}，窗口冲突 ${report.outcomeStats.conflicts}，归档冲突 ${report.outcomeStats.archiveConflicts}，拉取失败 ${report.outcomeStats.fetchErrors}`);
  return lines.join('\n');
}

function formatSchema(title, schema) {
  return [
    title,
    `  行 ${schema.rows}，窗口 ${schema.slots}`,
    `  inputs.spot ${schema.spot}，open ${schema.open}，volatility ${schema.volatility}，logged spotUp ${schema.loggedSpotUp}`,
    `  双边 ask ${schema.bothAsks}，可计算 marketUp ${schema.marketUp}，freshBook ${schema.freshBook}`,
    `  盘口时间 ${schema.bookTime}，现货时间 ${schema.spotTime}`
  ].join('\n');
}

function formatCohort(title, cohort, bucketWidth) {
  const summary = cohort.summary;
  const baseline = cohort.baseline;
  const win = summary.winRate == null ? 'n/a' : `${(summary.winRate * 100).toFixed(2)}% (${summary.wins}/${summary.settled})`;
  const baseWin = baseline.winRate == null ? 'n/a' : `${(baseline.winRate * 100).toFixed(2)}% (${baseline.wins}/${baseline.settled})`;
  const lines = [
    '',
    title,
    `  报价 ${cohort.quotes}，窗口 ${cohort.slots}，成交 ${summary.trades}，已结算 ${summary.settled}，缺结果 ${summary.unsettled}`,
    `  胜率 ${win}`,
    `  毛损益 ${money(summary.grossPnl)}，净损益 ${money(summary.netPnl)}，费用拖累 ${money(summary.feeDrag)}，投入 ${money(summary.invested)}`,
    `  最大回撤 ${money(summary.maxDrawdown)}（现金加未结算成本；亏损在结算时进入回撤），期末现金 ${money(summary.endingCash)}`,
    `  同卖一档随机对照: 净损益 ${money(baseline.netPnl)}，胜率 ${baseWin}，最大回撤 ${money(baseline.maxDrawdown)}，被迫同侧 ${baseline.forcedSameSide}/${baseline.settled}`
  ];
  if (cohort.buckets.length) {
    lines.push('  卖一档位  策略笔数  策略净利  对照笔数  对照净利');
    for (const row of cohort.buckets) {
      const upper = Math.round((row.bucket + bucketWidth) * 100);
      const lower = Math.round(row.bucket * 100);
      lines.push(`  ${String(lower).padStart(2, ' ')}–${String(upper).padStart(2, ' ')}¢  ${String(row.strategyTrades).padStart(6)}  ${money(row.strategyNet).padStart(8)}  ${String(row.baselineTrades).padStart(6)}  ${money(row.baselineNet).padStart(8)}`);
    }
  }
  const skipText = Object.entries(cohort.skips).map(([reason, count]) => `${reason} ${count}`).join(', ');
  if (skipText) lines.push(`  未成交报价（每窗在第一次成交前）: ${skipText}`);
  return lines.join('\n');
}

function money(value) {
  const number = Number(value) || 0;
  const body = Math.abs(number).toFixed(2);
  return number < 0 ? `-$${body}` : `$${body}`;
}

function parseArgs(argv) {
  const out = {
    date: '2026-10-16',
    dir: 'data/polymarket/plan14-research',
    minEdge: JEV_DEFAULTS.minEdge,
    feeRate: JEV_DEFAULTS.feeRate,
    modelWeight: JEV_DEFAULTS.modelWeight,
    stake: JEV_DEFAULTS.stake,
    startingCash: JEV_DEFAULTS.startingCash,
    minAsk: JEV_DEFAULTS.minAsk,
    maxAsk: JEV_DEFAULTS.maxAsk,
    maxSpread: JEV_DEFAULTS.maxSpread,
    minRemaining: JEV_DEFAULTS.minRemainingSeconds,
    maxRemaining: JEV_DEFAULTS.maxRemainingSeconds,
    bucket: JEV_DEFAULTS.bucketWidth,
    seed: JEV_DEFAULTS.seed,
    fetchOfficial: true,
    spotFallback: true,
    json: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value == null || value.startsWith('--')) throw new Error(`Missing value for ${token}`);
      i += 1;
      return value;
    };
    if (token === '--json') out.json = true;
    else if (token === '--no-fetch') out.fetchOfficial = false;
    else if (token === '--no-spot-fallback') out.spotFallback = false;
    else if (token === '--date') out.date = next();
    else if (token === '--dir') out.dir = next();
    else if (token === '--min-edge') out.minEdge = number(next(), token);
    else if (token === '--fee-rate') out.feeRate = number(next(), token);
    else if (token === '--model-weight') out.modelWeight = number(next(), token);
    else if (token === '--stake') out.stake = number(next(), token);
    else if (token === '--starting-cash') out.startingCash = number(next(), token);
    else if (token === '--min-ask') out.minAsk = number(next(), token);
    else if (token === '--max-ask') out.maxAsk = number(next(), token);
    else if (token === '--max-spread') out.maxSpread = number(next(), token);
    else if (token === '--min-remaining') out.minRemaining = number(next(), token);
    else if (token === '--max-remaining') out.maxRemaining = number(next(), token);
    else if (token === '--bucket') out.bucket = number(next(), token);
    else if (token === '--seed') out.seed = Number(next());
    else throw new Error(`Unknown argument ${token}`);
  }
  return out;
}

function number(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} must be a number`);
  return parsed;
}
