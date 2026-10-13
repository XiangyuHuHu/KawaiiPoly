import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from './src/config.js';
import { buildActivePaperPlansView, paperPlanFlags } from './src/polymarketPaperPlansView.js';
import { buildIntervalSignal, blendWithPolymarketSentiment, getIntervalSchedule } from './src/intervalSignal.js';
import { createMockMarket, generateMockPriceSeries } from './src/mockMarket.js';
import { PredictionRecorder } from './src/predictionRecorder.js';
import { buildFiveMinuteDecisionConfig, buildFifteenMinuteDecisionConfig } from './src/fiveMinuteDecision.js';
import { PublicMarketDataClient } from './src/publicMarketData.js';
import { PolymarketClient } from './src/polymarketClient.js';
import { PolymarketCatalog, PREDICTION_CATEGORIES } from './src/polymarketCatalog.js';
import { PolymarketPerpsClient } from './src/polymarketPerpsClient.js';
import { buildPolymarketSentiment, recordPolymarketWindowSnapshot } from './src/polymarketSentiment.js';
import { buildPolymarketPaperPlan } from './src/polymarketPlan.js';
import { buildPolymarketPaperPlan2, resolvePlan2PaperMode, isPlan2Family } from './src/polymarketPlan2.js';
import { PLAN_IDS } from './src/polymarketTrading.js';
import { buildPolymarketPaperPlan3 } from './src/polymarketPlan3.js';
import { buildPolymarketPaperPlan3_6, PLAN3_6_LIVE_TIMEFRAMES } from './src/polymarketPlan3_6.js';
import { buildPolymarketPaperPlan11 } from './src/polymarketPlan11.js';
import { buildPolymarketPaperPlan14, evaluatePlan14Entry, rankPlan14Views, PLAN14_PREVIOUS_VERSION, PLAN14_PROFIT_EXPERIMENT_VERSION } from './src/polymarketPlan14.js';
import { evaluatePlan15Candidate } from './src/polymarketPlan15.js';
import { parsePlan16Question, selectPlan16Buys, ensembleYesProbability } from './src/polymarketPlan16.js';
import { stationFromDescription } from './src/plan16Stations.js';
import { fetchPlan16Ensemble } from './src/plan16Forecast.js';
import { PLAN17_COINS, parsePlan17Market, plan17IvSkipReason, plan17KellyStake, selectPlan17Buys } from './src/polymarketPlan17.js';
import { fetchPlan17Dvol, fetchPlan17Spot } from './src/plan17MarketData.js';
import { evaluatePlan18Event, plan18ShortSlug } from './src/polymarketPlan18.js';
import {
  blendPlan5LockStrengthStats,
  buildPolymarketPaperPlan5
} from './src/polymarketPlan5.js';
import { normalizeOrderBook } from './src/polymarketMarketUtils.js';
import { buildCurrentWindowTrackAnalysis, listActiveWindowTracks } from './src/polymarketWindowTrack.js';
import { windowElapsedPct } from './src/polymarketPlan.js';
import { buildDepositWalletStatus, buildPolymarketReadiness } from './src/polymarketReadiness.js';
import { PolymarketTradingService } from './src/polymarketTrading.js';
import {
  buildLiveOrderPreview,
  submitPolymarketLiveOrder,
  submitPolymarketLiveSellOrder
} from './src/polymarketLiveOrder.js';
import { buildPolymarketIntervalSignal } from './src/polymarketSignal.js';
import { getSlotSchedule, timeframeToCandleInterval, timeframeToSlotMinutes } from './src/polymarketSchedule.js';
import { resolveMarketSignalCachePolicy, shouldReuseCachedMarketSignal } from './src/marketSignalCachePolicy.js';
import { computePolymarketOrderUsd } from './src/polymarketSizing.js';
import { runHourlyMonitor } from './src/hourlyMonitor.js';
import { writeExitDecisionReports, writePlan3SettlementReports } from './src/polymarketExitAnalytics.js';
import { syncStrategyDocs } from './src/polymarketStrategyDocs.js';
import { mergeSentimentTarget, resolveChainlinkSlotTarget, resolvePolymarketWindowPrices } from './src/chainlinkPrice.js';
import { createStatsDb } from './src/statsDb.js';
import {
  applyGuidanceToSignal,
  buildJudgmentGuidance,
  extractJudgmentFromSignal
} from './src/winrateGuidance.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(__dirname, 'public');
const config = getConfig();
const publicMarket = new PublicMarketDataClient({ baseUrls: config.market.binanceBaseUrls });
const polymarketClient = new PolymarketClient(config.polymarket);
const polymarketCatalog = new PolymarketCatalog({ client: polymarketClient });
const polymarketPerps = new PolymarketPerpsClient();
const statsDb = createStatsDb({
  enabled: config.statsDb.enabled,
  path: isAbsolute(config.statsDb.path) ? config.statsDb.path : join(__dirname, config.statsDb.path)
});
if (statsDb.enabled) {
  const counts = statsDb.counts();
  console.log(`Stats DB ready at ${statsDb.path} (locks=${counts.windowLocks}, orders=${counts.settledOrders})`);
} else {
  console.log(`Stats DB disabled (${statsDb.reason}); lock/calibration stats fall back to markdown/state only.`);
}
const polymarketTrading = new PolymarketTradingService({
  config: config.polymarket,
  stateDir: join(__dirname, 'data', 'polymarket'),
  statePath: join(__dirname, 'data', 'polymarket-paper-state.json'),
  defaultStartingCash: config.polymarket.defaultStartingCash,
  statsDb
});
await polymarketTrading.load();
await polymarketTrading.applyLiveAutoEnvDefault();
try {
  await syncStrategyDocs({
    recordDir: config.predictionRecords.recordDir,
    config: config.polymarket,
    repoRoot: __dirname
  });
} catch (error) {
  console.error(`Polymarket strategy docs sync failed: ${error.message}`);
}
const predictionRecorder = new PredictionRecorder({
  ...config.predictionRecords,
  statsDb,
  plan5Config: config.polymarket,
  fiveMinuteConfig: buildFiveMinuteDecisionConfig(),
  fifteenMinuteConfig: buildFifteenMinuteDecisionConfig(),
  fetchQuotes: async (symbols) => fetchMarketQuotes(symbols, { allowMockFallback: false }),
  fetchClosePrice: async (symbol, targetTimeIso) => publicMarket.getClosedCandleClose(symbol, '15m', targetTimeIso),
  fetchWindowPrices: async (symbol, targetTimeIso, interval = '5m') => publicMarket.getWindowPrices(symbol, interval, targetTimeIso),
  readPolymarketPaperSummary: async (date) => polymarketTrading.dailyOrderSummary(date)
});
let predictionRecordLoopRunning = false;
// Per-plan locks: one slow plan must not block other plans' start/stop or ticks.
const polymarketPaperPlanLoopsRunning = new Set();
const polymarketLivePlanLoopsRunning = new Set();
const polymarketPaperPlanLoopStages = new Map();
const polymarketLivePlanLoopStages = new Map();
const polymarketLiveViewInflightMap = new Map();
const polymarketLiveExecutionInflightMap = new Map();
const POLYMARKET_PAPER_CORE_PLAN_IDS = ['plan14'];
const POLYMARKET_LIVE_CORE_PLAN_IDS = [];
const RETIRED_PAPER_PLAN_IDS = [
  'plan1', 'plan2', 'plan2_5', 'plan2_6', 'plan3', 'plan3_5', 'plan3_6',
  'plan5', 'plan11', 'plan12', 'plan13'
];
const POLYMARKET_RESETTABLE_CORE_PLAN_IDS = ['plan14'];
let polymarketPaperCoreRoundRobinIndex = 0;
let polymarketLiveCoreRoundRobinIndex = 0;
let polymarketSettlementLoopRunning = false;
const polymarketSettlementPhaseInflightMap = new Map();
const polymarketSimplePlanFastLoopsRunning = new Set();
let hourlyMonitorLoopRunning = false;
let polymarketReadinessCache = {
  at: 0,
  payload: null,
  inflight: null,
  retryAfterAt: 0
};
let polymarketMaintenanceLastRunAtMs = 0;
let polymarketReportsLastRunAtMs = 0;
let lastHourlyMonitor = null;

const POLYMARKET_MAINTENANCE_INTERVAL_MS = 30_000;
const POLYMARKET_REPORT_INTERVAL_MS = 15 * 60_000;


const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url);
      return;
    }

    await serveStatic(response, url.pathname);
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
});

server.listen(config.port, () => {
  console.log(`Kawaii_poly running at http://localhost:${config.port}`);
});

if (config.predictionRecords.enabled) {
  setTimeout(runPredictionRecordLoop, 1000);
  setInterval(runPredictionRecordLoop, config.predictionRecords.pollIntervalMs);
}

if (config.polymarket.enabled) {
  setTimeout(runPolymarketAutoLoop, 2000);
  setInterval(
    runPolymarketAutoLoop,
    Math.max(1000, Math.floor(config.polymarket.autoLoopIntervalMs / POLYMARKET_PAPER_CORE_PLAN_IDS.length))
  );
  if (POLYMARKET_LIVE_CORE_PLAN_IDS.length) {
    setTimeout(runPolymarketLiveAutoLoop, 2500);
    setInterval(
      runPolymarketLiveAutoLoop,
      Math.max(1000, Math.floor(config.polymarket.autoLoopIntervalMs / POLYMARKET_LIVE_CORE_PLAN_IDS.length))
    );
  }
  setTimeout(runPolymarketSettlementLoop, 3000);
  setInterval(runPolymarketSettlementLoop, config.polymarket.settlementLoopIntervalMs);
  setTimeout(() => stopRetiredPaperAndLivePlans().catch((error) => {
    console.error(`Retired plan shutdown failed: ${error.message}`);
  }), 2200);
  if (config.polymarket.plan14Enabled !== false) {
    setTimeout(() => ensurePlan14PaperRunning().catch((error) => {
      console.error(`Plan14 paper ensure failed: ${error.message}`);
    }), 2900);
  }
  if (config.polymarket.plan15Enabled !== false) {
    setTimeout(() => ensurePlan15PaperRunning()
      .then(() => runPlan15PaperScan())
      .catch((error) => {
        console.error(`Plan15 paper ensure failed: ${error.message}`);
      }), 4200);
    setInterval(() => {
      runPlan15PaperScan().catch((error) => {
        console.error(`Plan15 paper scan failed: ${error.message}`);
      });
    }, Math.max(15_000, Number(config.polymarket.plan15LoopMs) || 60_000));
  }
  if (config.polymarket.plan16Enabled !== false) {
    setTimeout(() => ensurePlan16PaperRunning()
      .then(() => runPlan16PaperScan())
      .catch((error) => {
        console.error(`Plan16 paper ensure failed: ${error.message}`);
      }), 5200);
    setInterval(() => {
      runPlan16PaperScan().catch((error) => {
        console.error(`Plan16 paper scan failed: ${error.message}`);
      });
    }, Math.max(15_000, Number(config.polymarket.plan16LoopMs) || 60_000));
  }
  if (config.polymarket.plan17Enabled !== false) {
    setTimeout(() => ensurePlan17PaperRunning()
      .then(() => runPlan17PaperScan())
      .catch((error) => {
        console.error(`Plan17 paper ensure failed: ${error.message}`);
      }), 6200);
    setInterval(() => {
      runPlan17PaperScan().catch((error) => {
        console.error(`Plan17 paper scan failed: ${error.message}`);
      });
    }, Math.max(30_000, Number(config.polymarket.plan17LoopMs) || 120_000));
  }
  for (const [index, planId] of ['plan18', 'plan19'].entries()) {
    if (config.polymarket[`${planId}Enabled`] === false) continue;
    setTimeout(() => ensurePlan18PaperRunning(planId)
      .then(() => runPlan18PaperScan(planId))
      .catch((error) => {
        console.error(`${planId} paper ensure failed: ${error.message}`);
      }), 7200 + index * 800);
    setInterval(() => {
      runPlan18PaperScan(planId).catch((error) => {
        console.error(`${planId} paper scan failed: ${error.message}`);
      });
    }, Math.max(10_000, Number(config.polymarket[`${planId}LoopMs`]) || 20_000));
  }
}

if (config.hourlyMonitor.enabled) {
  setTimeout(runHourlyMonitorLoop, 15000);
  setInterval(runHourlyMonitorLoop, config.hourlyMonitor.intervalMs);
}

function compactAutoForApi(auto = {}) {
  const { lastExecutedKeys = [], ...rest } = auto || {};
  return {
    ...rest,
    lastExecutedCount: Array.isArray(lastExecutedKeys) ? lastExecutedKeys.length : 0
  };
}

function compactLiveAutoForApi(auto = {}) {
  const { lastExecutedKeys = [], ...rest } = auto || {};
  return {
    ...rest,
    lastExecutedCount: Array.isArray(lastExecutedKeys) ? lastExecutedKeys.length : 0
  };
}

function compactPolymarketStatusForApi(status = {}) {
  return {
    ...status,
    liveAuto: compactLiveAutoForApi(status.liveAuto),
    plans: Object.fromEntries(Object.entries(status.plans || {}).map(([planId, plan]) => [
      planId,
      {
        ...plan,
        auto: compactAutoForApi(plan.auto),
        recentOpportunities: undefined
      }
    ]))
  };
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/status') {
    sendJson(response, 200, {
      marketSource: resolveMarketSource(),
      mode: describeMode(),
      predictionRecords: {
        enabled: config.predictionRecords.enabled,
        recordDir: config.predictionRecords.recordDir,
        pollIntervalMs: config.predictionRecords.pollIntervalMs,
        symbols: config.predictionRecords.symbols
      },
      polymarket: {
        enabled: config.polymarket.enabled,
        blendEnabled: config.polymarket.blendEnabled,
        timeframe: config.polymarket.timeframe
      }
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/crypto/interval-signal') {
    // 与预测记录/锁定判断同一币种源（BTC/ETH/SOL/XRP），避免页面与记录币种不一致。
    const symbols = splitList(url.searchParams.get('symbols')) || config.predictionRecords.symbols;
    sendJson(response, 200, await buildCryptoIntervalSignals(symbols));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/crypto/winrate') {
    const symbols = splitList(url.searchParams.get('symbols')) || config.predictionRecords.symbols;
    const lookbackDays = Number(url.searchParams.get('lookbackDays') || 14);
    const mode = String(url.searchParams.get('mode') || 'summary').toLowerCase() === 'full'
      ? 'full'
      : 'summary';
    sendJson(response, 200, await buildWinratePagePayload(symbols, { lookbackDays, mode }));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/crypto/prediction-records/today') {
    sendJson(response, 200, await predictionRecorder.readDailySummary(new Date()));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/crypto/next-slot-predictions') {
    const lookbackDays = Number(url.searchParams.get('lookbackDays') || 14);
    sendJson(response, 200, predictionRecorder.getNextSlotPredictionSummary({ lookbackDays }));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/crypto/strategy-risk') {
    sendJson(response, 200, await predictionRecorder.readStrategyRiskSummary());
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/crypto/polymarket-sentiment') {
    const symbol = (url.searchParams.get('symbol') || 'BTC-USD').toUpperCase();
    const schedule = getIntervalScheduleForServer(new Date());
    const sentiment = await buildPolymarketSentiment({
      symbol,
      targetTimeIso: schedule.nextSlotIso,
      client: polymarketClient
    });
    sendJson(response, 200, await attachPolymarketTarget(sentiment, {
      symbol,
      timeframe: '15m',
      schedule,
      now: new Date()
    }));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/polymarket/catalog') {
    try {
      sendJson(response, 200, await polymarketCatalog.snapshot({
        category: url.searchParams.get('category') || ''
      }));
    } catch (error) {
      sendJson(response, 200, {
        updatedAtIso: new Date().toISOString(),
        categories: polymarketCatalog.categories(),
        boards: [],
        error: error?.message || String(error)
      });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/polymarket/perps') {
    try {
      sendJson(response, 200, await polymarketPerps.snapshot());
    } catch (error) {
      sendJson(response, 200, {
        ok: false,
        tradable: false,
        updatedAtIso: new Date().toISOString(),
        count: 0,
        categories: {},
        rows: [],
        error: error?.message || String(error),
        reason: '永续公开行情暂时读不到。下单本来就未接入。'
      });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/polymarket/status') {
    const status = compactPolymarketStatusForApi(polymarketTrading.status());
    sendJson(response, 200, status);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/polymarket/readiness') {
    sendJson(response, 200, await getPolymarketReadiness());
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/polymarket/window-track') {
    const timeframe = url.searchParams.get('timeframe') || '5m';
    const symbol = url.searchParams.get('symbol') || 'BTC-USD';
    const now = new Date();
    const analysis = buildCurrentWindowTrackAnalysis(config.polymarket, now, symbol);
    sendJson(response, 200, {
      generatedAtIso: now.toISOString(),
      symbol,
      requestedTimeframe: timeframe,
      activeTracks: listActiveWindowTracks(),
      analysis
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/polymarket/deposit-wallet/status') {
    sendJson(response, 200, await buildDepositWalletStatus(config.polymarket));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/polymarket/portfolio') {
    const planId = normalizePaperPlanId(url.searchParams.get('plan'));
    sendJson(response, 200, {
      planId,
      portfolio: polymarketTrading.snapshotPortfolio(planId),
      stats: polymarketTrading.computeStats(planId)
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/polymarket/portfolio/configure') {
    const body = await readJsonBody(request);
    const planId = normalizePaperPlanId(body.planId || body.plan);
    const portfolio = await polymarketTrading.configurePortfolio({ ...body, planId });
    sendJson(response, 200, {
      planId,
      portfolio,
      stats: polymarketTrading.computeStats(planId)
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/polymarket/portfolio/reset') {
    const body = await readJsonBody(request);
    const planId = normalizePaperPlanId(body.planId || body.plan);
    const portfolio = await polymarketTrading.resetPortfolio(planId);
    sendJson(response, 200, {
      planId,
      portfolio,
      stats: polymarketTrading.computeStats(planId)
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/polymarket/recommendation') {
    const symbol = (url.searchParams.get('symbol') || 'BTC-USD').toUpperCase();
    const timeframe = normalizePolymarketTimeframe(url.searchParams.get('timeframe'));
    sendJson(response, 200, await buildPolymarketRecommendation(symbol, timeframe, 'plan1', { includeRisk: true }));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/polymarket/paper-plan') {
    const symbol = (url.searchParams.get('symbol') || 'BTC-USD').toUpperCase();
    const timeframe = normalizePolymarketTimeframe(url.searchParams.get('timeframe'));
    const planId = normalizePaperPlanId(url.searchParams.get('plan') || url.searchParams.get('planId'));
    sendJson(response, 200, await buildPolymarketPaperPlanView(symbol, timeframe, planId));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/polymarket/paper-plans') {
    const symbol = (url.searchParams.get('symbol') || 'BTC-USD').toUpperCase();
    const requestedPlan = url.searchParams.get('plan') || url.searchParams.get('planId');
    if (!requestedPlan) {
      sendJson(response, 200, buildActivePaperPlansView({
        symbol,
        config: config.polymarket,
        statusForPlan: (id) => polymarketTrading.status(id)
      }));
    } else {
      const planId = normalizePaperPlanId(requestedPlan);
      const view = await buildPolymarketPaperPlansView(symbol, planId);
      sendJson(response, 200, { ...view, ...paperPlanFlags(planId, config.polymarket) });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/polymarket/paper-compare') {
    sendJson(response, 200, await buildPolymarketPaperCompareView('BTC-USD'));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/polymarket/plan1-analytics') {
    sendJson(response, 200, polymarketTrading.computePlan1Analytics());
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/polymarket/exit-analytics') {
    const planParam = url.searchParams.get('plan') || 'all';
    const includeLive = url.searchParams.get('live') !== 'false';
    const shouldBackfill = url.searchParams.get('backfill') === 'true';
    let backfill = null;
    if (shouldBackfill) {
      backfill = await polymarketTrading.backfillEarlyExitOutcomes(resolvePolymarketSettlementOutcome);
    }
    const analytics = polymarketTrading.computeExitDecisionAnalytics({
      planId: planParam === 'all' ? null : normalizePaperPlanId(planParam),
      includeLive,
      source: planParam === 'live' ? 'live' : (includeLive ? null : 'paper')
    });
    let markdownFiles = null;
    if (url.searchParams.get('writeMd') === 'true' && config.hourlyMonitor.recordDir) {
      markdownFiles = await writeExitDecisionReports({
        polymarketTrading,
        recordDir: config.hourlyMonitor.recordDir
      });
    }
    sendJson(response, 200, {
      plan: planParam,
      includeLive,
      analytics,
      backfill,
      markdownFiles
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/monitor/hourly/latest') {
    sendJson(response, 200, {
      enabled: config.hourlyMonitor.enabled,
      intervalMs: config.hourlyMonitor.intervalMs,
      recordDir: config.hourlyMonitor.recordDir,
      last: lastHourlyMonitor
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/monitor/hourly/run') {
    const result = await runHourlyMonitorLoop({ force: true });
    sendJson(response, 200, result);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/polymarket/plan3-analytics') {
    const planId = normalizePaperPlanId(url.searchParams.get('plan') || 'plan3');
    const bucket = polymarketTrading.getBucket(planId);
    sendJson(response, 200, {
      planId,
      analytics: polymarketTrading.computePlan3Analytics(planId),
      recentOpportunities: (bucket.plan3OpportunityLog || [])
        .filter((item) => item.skipReason && item.skipReason !== 'not_in_time_window')
        .slice(0, 30)
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/polymarket/plan5-opportunities') {
    const bucket = polymarketTrading.getBucket('plan5');
    sendJson(response, 200, {
      planId: 'plan5',
      summary: polymarketTrading.summarizePlan5Opportunities('plan5'),
      recentOpportunities: (bucket.plan5OpportunityLog || []).slice(0, 80),
      rules: polymarketTrading.buildPlan5RulesSnapshot()
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/polymarket/plan3-loss-analytics') {
    const source = String(url.searchParams.get('source') || 'all').toLowerCase();
    const limit = Number(url.searchParams.get('limit') || 30);
    const normalizedSource = ['live', 'paper', 'all'].includes(source) ? source : 'all';
    sendJson(response, 200, {
      source: normalizedSource,
      analytics: polymarketTrading.computePlan3LossAnalytics({
        source: normalizedSource,
        limit: Number.isFinite(limit) ? limit : 30
      })
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/polymarket/loss-reason-stats') {
    const planId = String(url.searchParams.get('plan') || 'all').toLowerCase();
    const source = String(url.searchParams.get('source') || 'all').toLowerCase();
    const lookbackDays = Number(url.searchParams.get('lookbackDays') || config.polymarket?.lossReasonGateLookbackDays || 14);
    const normalizedSource = ['live', 'paper', 'all'].includes(source) ? source : 'all';
    const normalizedPlan = PLAN_IDS.includes(planId) ? planId : null;
    sendJson(response, 200, {
      planId: normalizedPlan || 'all',
      source: normalizedSource,
      lookbackDays: Number.isFinite(lookbackDays) ? lookbackDays : 14,
      stats: polymarketTrading.getLossReasonStats({
        planId: normalizedPlan,
        lookbackDays: Number.isFinite(lookbackDays) ? lookbackDays : 14,
        source: normalizedSource
      })
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/polymarket/analytics') {
    const planParam = String(url.searchParams.get('plan') || 'all').toLowerCase();
    const source = String(url.searchParams.get('source') || 'paper').toLowerCase();
    const symbolRaw = String(url.searchParams.get('symbol') || 'all');
    const symbolParam = symbolRaw.toUpperCase();
    const lookbackDays = Number(
      url.searchParams.get('lookbackDays')
      || config.polymarket?.analyticsLookbackDays
      || config.polymarket?.lossReasonGateLookbackDays
      || 30
    );
    const normalizedSource = ['live', 'paper', 'all'].includes(source) ? source : 'paper';
    const categorySymbols = ['体育', '电竞', '天气', '政治选举', '宏观金融', '加密事件'];
    const currentPlanIds = ['plan14', 'plan15', 'plan16', 'plan17', 'plan18', 'plan19'];
    const normalizedPlan = PLAN_IDS.includes(planParam) ? planParam : null;
    const planIds = planParam === 'current'
      ? currentPlanIds
      : (normalizedPlan ? [normalizedPlan] : null);
    const normalizedSymbol = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD'].includes(symbolParam)
      ? symbolParam
      : (categorySymbols.includes(symbolRaw) ? symbolRaw : null);
    sendJson(response, 200, {
      planId: planParam === 'current' ? 'current' : (normalizedPlan || 'all'),
      source: normalizedSource,
      symbol: normalizedSymbol || 'all',
      lookbackDays: Number.isFinite(lookbackDays) ? lookbackDays : 30,
      dashboard: polymarketTrading.computeAnalyticsDashboard({
        planId: normalizedPlan,
        planIds,
        source: normalizedSource,
        symbol: normalizedSymbol,
        lookbackDays: Number.isFinite(lookbackDays) ? lookbackDays : 30
      })
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/polymarket/paper-orders') {
    const planId = normalizePaperPlanId(url.searchParams.get('plan'));
    const bucket = polymarketTrading.getBucket(planId);
    const full = url.searchParams.get('full') === '1' || url.searchParams.get('full') === 'true';
    const limitRaw = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(300, Math.floor(limitRaw))
      : (full ? null : 50);
    const payload = {
      planId,
      orders: polymarketTrading.listPaperOrders(planId, {
        limit,
        summary: !full
      }),
      portfolio: polymarketTrading.snapshotPortfolio(planId),
      stats: polymarketTrading.computeStats(planId)
    };
    if (planId === 'plan5') {
      payload.currentVersionStats = polymarketTrading.statusForPlan(planId).currentVersionStats;
    }
    if (planId === 'plan3') {
      payload.plan3Analytics = polymarketTrading.computePlan3Analytics(planId);
      payload.plan3Opportunities = (bucket.plan3OpportunityLog || [])
        .filter((item) => item.skipReason && item.skipReason !== 'not_in_time_window')
        .slice(0, 20);
    }
    if (planId === 'plan3_6') {
      payload.plan36Analytics = polymarketTrading.computePlan36Analytics();
    }
    sendJson(response, 200, payload);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/polymarket/live-orders') {
    const planParam = String(url.searchParams.get('plan') || 'all').toLowerCase();
    const planId = planParam === 'all' ? null : normalizePaperPlanId(planParam);
    const full = url.searchParams.get('full') === '1' || url.searchParams.get('full') === 'true';
    const activeOnly = url.searchParams.get('active') === '1' || url.searchParams.get('active') === 'true';
    const enabledPlans = activeOnly
      ? polymarketTrading.liveAutoStatus().enabledPlans || []
      : [];
    const activePlanIds = new Set(enabledPlans);
    const limitRaw = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(300, Math.floor(limitRaw))
      : 300;
    let orders = planId || full
      ? polymarketTrading.listLiveOrders(planId, { limit, summary: !full })
      : PLAN_IDS
        .flatMap((id) => polymarketTrading.listLiveOrders(id, { limit: 35, summary: true }))
        .sort((left, right) => String(right.createdAtIso || '').localeCompare(String(left.createdAtIso || '')))
        .slice(0, limit);
    if (activeOnly) {
      orders = orders
        .filter((order) => activePlanIds.has(String(order.planId || '').toLowerCase()))
        .slice(0, limit);
    }
    const retainedStats = polymarketTrading.computeLiveStats(planId, {
      planIds: activeOnly ? [...activePlanIds] : null
    });
    const lifetimeStats = activeOnly && typeof statsDb?.getLifetimeLiveStats === 'function'
      ? statsDb.getLifetimeLiveStats({ planIds: [...activePlanIds] })
      : null;
    const stats = lifetimeStats?.available
      ? {
        ...lifetimeStats,
        // Unfilled attempts are not settled trades and are intentionally not
        // written to the lifetime DB. Keep their retained-window count labeled.
        expiredUnfilled: retainedStats.expiredUnfilled,
        expiredUnfilledScope: 'retained'
      }
      : retainedStats;

    sendJson(response, 200, {
      planId,
      activeOnly,
      enabledPlans,
      orders,
      stats
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/polymarket/live-control') {
    const readiness = await getPolymarketReadiness();
    const balance = resolveReadinessBalanceUsdc(readiness);
    const control = await polymarketTrading.updateLiveControlBalance(balance);
    sendJson(response, 200, {
      control,
      liveTradingEnabled: config.polymarket.liveTradingEnabled,
      configured: config.polymarket.configured,
      ready: readiness.ready,
      balanceUsdc: balance
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/polymarket/live-control/start') {
    const readiness = await getPolymarketReadiness();
    const balance = resolveReadinessBalanceUsdc(readiness);
    const control = await polymarketTrading.setLiveControl(true, { currentBalanceUsdc: balance });
    const record = await polymarketTrading.recordLiveOrder({
      status: 'live-control-started',
      note: `Live monitor started with CLOB balance $${balance.toFixed(2)}. Real order submission remains separately gated.`
    });
    sendJson(response, 200, {
      control,
      record,
      liveTradingEnabled: config.polymarket.liveTradingEnabled,
      configured: config.polymarket.configured,
      ready: readiness.ready,
      balanceUsdc: balance
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/polymarket/live-control/stop') {
    const readiness = await getPolymarketReadiness();
    const balance = resolveReadinessBalanceUsdc(readiness);
    const control = await polymarketTrading.setLiveControl(false, { currentBalanceUsdc: balance });
    const record = await polymarketTrading.recordLiveOrder({
      status: 'live-control-stopped',
      note: `Live monitor stopped with CLOB balance $${balance.toFixed(2)}.`
    });
    sendJson(response, 200, {
      control,
      record,
      liveTradingEnabled: config.polymarket.liveTradingEnabled,
      configured: config.polymarket.configured,
      ready: readiness.ready,
      balanceUsdc: balance
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/polymarket/live-auto') {
    // 启停轮询热路径：不要每次打 readiness（链上/CLOB 很慢），余额用 liveControl 缓存
    const control = polymarketTrading.liveControlStatus() || {};
    sendJson(response, 200, {
      auto: compactLiveAutoForApi(polymarketTrading.liveAutoStatus()),
      liveTradingEnabled: config.polymarket.liveTradingEnabled,
      configured: config.polymarket.configured,
      ready: Boolean(config.polymarket.liveTradingEnabled && config.polymarket.configured),
      closedOnly: null,
      balanceUsdc: Number(control.currentBalanceUsdc) || 0,
      liveMaxOrderUsd: config.polymarket.liveMaxOrderUsd
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/polymarket/live-auto/start') {
    const body = await readJsonBody(request);
    const planId = normalizePaperPlanId(body.planId || body.plan || 'plan14');
    if (!POLYMARKET_LIVE_CORE_PLAN_IDS.length) {
      sendJson(response, 400, { error: '当前没有已批准的实盘策略。Plan14 仅模拟盘验证。' });
      return;
    }
    if (!POLYMARKET_LIVE_CORE_PLAN_IDS.includes(planId)) {
      sendJson(response, 400, { error: `${planId} 已下线，实盘只允许 ${POLYMARKET_LIVE_CORE_PLAN_IDS.join(', ')}。` });
      return;
    }
    const timeframes = body.timeframes || null;
    const symbols = Array.isArray(body.symbols) && body.symbols.length ? body.symbols : null;
    if (!config.polymarket.liveTradingEnabled) {
      sendJson(response, 400, { error: '实盘下单开关未开启（POLYMARKET_LIVE_TRADING_ENABLED=false）。' });
      return;
    }
    try {
      const auto = await polymarketTrading.setLiveAuto(true, { planId, timeframes, symbols });
      // 与模拟盘一致：启动必须秒回，首轮 tick（含 readiness + 多币种扫描）放后台
      sendJson(response, 200, { auto, tick: null, deferredTick: true });
      // 只调度刚启动的那一个 plan，避免顺带串行扫其它已启用 plan。
      scheduleIsolatedLivePlanTick(planId);
    } catch (error) {
      sendJson(response, 400, { error: error.message || String(error) });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/polymarket/live-auto/stop') {
    const body = await readJsonBody(request);
    const planId = body.planId ? normalizePaperPlanId(body.planId || body.plan) : null;
    const auto = await polymarketTrading.setLiveAuto(false, { planId });
    sendJson(response, 200, { auto });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/polymarket/live-auto/risk-controls') {
    const body = await readJsonBody(request);
    const auto = await polymarketTrading.setLiveRiskControls({
      ...(Object.hasOwn(body, 'globalDailyLossProtectionEnabled')
        ? { globalDailyLossProtectionEnabled: body.globalDailyLossProtectionEnabled }
        : {}),
      ...(Object.hasOwn(body, 'plan3DailyLossLimitEnabled')
        ? { plan3DailyLossLimitEnabled: body.plan3DailyLossLimitEnabled }
        : {})
    });
    sendJson(response, 200, {
      auto,
      globalDailyLoss: polymarketTrading.globalLiveDailyLossSnapshot()
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/polymarket/live-auto/symbols') {
    const body = await readJsonBody(request);
    const symbols = Array.isArray(body.symbols) && body.symbols.length ? body.symbols : null;
    if (!symbols) {
      sendJson(response, 400, { error: 'symbols 必填且至少包含一个币种。' });
      return;
    }
    const auto = await polymarketTrading.setLiveAutoSymbols(symbols);
    sendJson(response, 200, { auto });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/polymarket/live-auto/timeframes') {
    const body = await readJsonBody(request);
    const auto = await polymarketTrading.setLiveAutoTimeframes(body.timeframes || ['5m', '15m']);
    sendJson(response, 200, { auto });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/polymarket/paper-order') {
    const body = await readJsonBody(request);
    const symbol = (body.symbol || 'BTC-USD').toUpperCase();
    const timeframe = normalizePolymarketTimeframe(body.timeframe);
    const planId = normalizePaperPlanId(body.planId || body.plan);
    const recommendation = await buildPolymarketRecommendation(symbol, timeframe, planId, { includeRisk: true });
    const order = await polymarketTrading.createPaperOrder({
      symbol: recommendation.symbol,
      direction: body.direction || recommendation.recommendation.direction,
      usd: Number(body.usd || recommendation.recommendation.suggestedUsd),
      sentiment: recommendation.polymarket,
      recommendation: recommendation.recommendation,
      planId,
      plan: {
        timeframe,
        targetTimeIso: recommendation.polymarket?.targetTimeIso,
        slotIso: recommendation.polymarket?.schedule?.currentSlotIso,
        action: {
          startPrice: recommendation.signal?.prediction?.comparisonBasePrice
        }
      }
    }, planId);
    sendJson(response, 200, {
      planId,
      order,
      recommendation,
      portfolio: polymarketTrading.snapshotPortfolio(planId),
      stats: polymarketTrading.computeStats(planId)
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/polymarket/paper-plan/execute') {
    const body = await readJsonBody(request);
    const symbol = (body.symbol || 'BTC-USD').toUpperCase();
    const planId = normalizePaperPlanId(body.planId || body.plan);
    const timeframe = normalizePolymarketTimeframe(body.timeframe);
    const view = await buildPolymarketPaperPlanView(symbol, timeframe, planId);
    const order = await polymarketTrading.createPaperOrderFromPlan({
      plan: view.plan,
      sentiment: view.polymarket,
      recommendation: view.recommendation,
      planId
    });
    sendJson(response, 200, {
      planId,
      order,
      plan: view.plan,
      portfolio: polymarketTrading.snapshotPortfolio(planId),
      stats: polymarketTrading.computeStats(planId)
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/polymarket/auto/start') {
    const body = await readJsonBody(request);
    let planId = normalizePaperPlanId(body.planId || body.plan);
    const auto = await polymarketTrading.setAuto(true, { ...body, planId });
    // 启动接口必须秒回：首轮 tick 交给后台，避免前端「点了没反应」
    sendJson(response, 200, { planId: auto.planId || planId, auto, tick: null, deferredTick: true });
    scheduleIsolatedPaperPlanTick(auto.planId || planId);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/polymarket/auto/stop') {
    const body = await readJsonBody(request);
    let planId = normalizePaperPlanId(body.planId || body.plan);
    const auto = await polymarketTrading.setAuto(false, { planId });
    sendJson(response, 200, { planId: auto.planId || planId, auto });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/polymarket/paper-orders/reset') {
    const body = await readJsonBody(request);
    const planId = normalizePaperPlanId(body.planId || body.plan);
    await polymarketTrading.resetPaperOrders(planId);
    sendJson(response, 200, {
      planId,
      orders: [],
      portfolio: polymarketTrading.snapshotPortfolio(planId),
      stats: polymarketTrading.computeStats(planId)
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/polymarket/paper/reset-all') {
    // One atomic operator action for a clean research restart. Live history is
    // intentionally retained; every live switch is forced off before paper reset.
    await polymarketTrading.setLiveAuto(false, { planId: null });

    for (const planId of POLYMARKET_RESETTABLE_CORE_PLAN_IDS) {
      await polymarketTrading.resetPortfolio(planId);
      await polymarketTrading.configurePortfolio({
        planId,
        cash: Number(config.polymarket.defaultStartingCash) || 500
      });
    }
    const databaseReset = typeof statsDb?.resetPaperData === 'function'
      ? statsDb.resetPaperData()
      : { settledOrders: 0, plan7MarketSamples: 0 };

    for (const planId of POLYMARKET_RESETTABLE_CORE_PLAN_IDS) {
      await polymarketTrading.setAuto(true, { planId });
      scheduleIsolatedPaperPlanTick(planId);
    }

    sendJson(response, 200, {
      ok: true,
      liveEnabled: false,
      paperLiveParityEnabled: config.polymarket.paperLiveParityEnabled !== false,
      databaseReset,
      corePlans: Object.fromEntries(POLYMARKET_RESETTABLE_CORE_PLAN_IDS.map((planId) => [
        planId,
        polymarketTrading.statusForPlan(planId)?.auto?.enabled === true
      ]))
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/polymarket/live-plan') {
    const symbol = (url.searchParams.get('symbol') || 'BTC-USD').toUpperCase();
    const timeframe = normalizePolymarketTimeframe(url.searchParams.get('timeframe'));
    const planId = normalizePaperPlanId(url.searchParams.get('plan'));
    const usd = url.searchParams.has('usd') ? Number(url.searchParams.get('usd')) : null;
    const readiness = await getPolymarketReadiness();
    const clobBalanceUsdc = resolveReadinessBalanceUsdc(readiness);
    const livePortfolio = polymarketTrading.livePortfolioSnapshot({ clobBalanceUsdc });
    const planView = await buildPolymarketPaperPlanView(symbol, timeframe, planId, {
      portfolioOverride: livePortfolio,
      pendingDelayedEntrySource: 'live',
      cacheMaxAgeMs: 5000
    });
    const preview = await buildLiveOrderPreview({
      planView,
      tradingService: polymarketTrading,
      config: config.polymarket,
      usd,
      clobBalanceUsdc
    });
    sendJson(response, 200, {
      symbol,
      timeframe,
      planId,
      generatedAt: new Date().toISOString(),
      liveTradingEnabled: config.polymarket.liveTradingEnabled,
      configured: config.polymarket.configured,
      ready: readiness.ready,
      liveMaxOrderUsd: config.polymarket.liveMaxOrderUsd,
      clobBalanceUsdc,
      livePortfolio,
      planView: {
        planId: planView.planId,
        plan: planView.plan,
        polymarket: planView.polymarket,
        signal: planView.signal
      },
      preview
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/polymarket/live-order') {
    const body = await readJsonBody(request);
    const symbol = (body.symbol || 'BTC-USD').toUpperCase();
    const timeframe = normalizePolymarketTimeframe(body.timeframe);
    const planId = normalizePaperPlanId(body.planId || body.plan);
    const readiness = await getPolymarketReadiness();
    const clobBalanceUsdc = resolveReadinessBalanceUsdc(readiness);
    const planView = await buildPolymarketPaperPlanView(symbol, timeframe, planId, {
      portfolioOverride: polymarketTrading.livePortfolioSnapshot({ clobBalanceUsdc }),
      pendingDelayedEntrySource: 'live'
    });
    try {
      const result = await polymarketTrading.createLiveOrder({
        planView,
        usd: body.usd != null ? Number(body.usd) : null
      });
      const draft = result.draft || {};
      const record = await polymarketTrading.recordLiveOrder({
        status: 'submitted',
        orderSide: 'BUY',
        positionStatus: 'open',
        symbol: draft.symbol || symbol,
        timeframe: draft.timeframe || timeframe,
        planId: draft.planId || planId,
        planKey: draft.planKey || planView.plan?.key || null,
        slotIso: draft.slotIso || planView.plan?.slotIso || null,
        direction: draft.direction,
        outcome: draft.outcome,
        usd: draft.usd,
        shares: draft.shares,
        limitPrice: draft.limitPrice,
        entryPrice: draft.limitPrice,
        tokenId: draft.tokenId,
        market: draft.market,
        marketSlug: draft.marketSlug,
        targetTimeIso: draft.targetTimeIso || planView.plan?.targetTimeIso || null,
        takeProfitPrice: planView.plan?.action?.takeProfitPrice ?? null,
        stopLossPrice: planView.plan?.action?.stopLossPrice ?? null,
        clobOrderId: result.clobOrderId,
        clobStatus: result.response?.status,
        clobSuccess: result.response?.success,
        clobResponse: result.response,
        note: `Live CLOB buy submitted for ${timeframe} ${planId}.`
      });
      sendJson(response, 200, { ok: true, result, record });
    } catch (error) {
      const action = planView.plan?.action || {};
      const record = await polymarketTrading.recordLiveOrder({
        status: 'blocked',
        symbol,
        timeframe,
        planId,
        planKey: planView.plan?.key || null,
        slotIso: planView.plan?.slotIso || null,
        direction: action.direction,
        outcome: action.direction === 'up' ? 'UP' : action.direction === 'down' ? 'DOWN' : null,
        usd: body.usd != null ? Number(body.usd) : action.usd,
        limitPrice: action.limitPrice,
        error: error.message,
        note: 'Live order was blocked before or during CLOB submission.'
      });
      sendJson(response, 400, { ok: false, error: error.message, record, plan: planView.plan });
    }
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

async function serveStatic(response, pathname) {
  const aliased = pathname === '/winrate' || pathname === '/winrate/'
    ? '/winrate.html'
    : pathname;
  const safePath = aliased === '/' ? '/index.html' : aliased;
  const normalized = normalize(safePath).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(publicDir, normalized);
  let body;
  try {
    body = await readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    throw error;
  }
  response.writeHead(200, { 'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream' });
  response.end(body);
}

function requireCredentials() {
  throw new Error('Robinhood trading is not part of Kawaii_poly.');
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function validateOrder(order) {
  const allowedSides = new Set(['buy', 'sell']);
  const allowedTypes = new Set(['market', 'limit', 'stop_loss', 'stop_limit']);

  if (!order.symbol || !allowedSides.has(order.side) || !allowedTypes.has(order.type)) {
    throw new Error('Order requires symbol, side buy/sell, and a supported type.');
  }

  return order;
}

function splitList(value) {
  if (!value) return null;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function splitUpper(value) {
  const list = splitList(value);
  return list ? list.map((item) => item.toUpperCase()) : null;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  // 紧凑 JSON：paper-orders 等接口可达数 MB，pretty-print 会拖慢序列化与浏览器解析
  response.end(JSON.stringify(payload));
}

function resolveMarketSource() {
  if (config.market.source === 'mock') return 'mock';
  return 'binance';
}

function parsePaperSetup(body = {}) {
  const symbolSet = new Set([
    ...config.paper.symbols,
    ...Object.keys(body.holdingsUsd || {})
  ]);
  const holdingsUsd = {};

  for (const symbol of symbolSet) {
    if (body.holdingsUsd && body.holdingsUsd[symbol] !== undefined) {
      holdingsUsd[symbol] = Math.max(0, Number(body.holdingsUsd[symbol]) || 0);
    } else {
      holdingsUsd[symbol] = Math.max(0, Number(config.paper.initialHoldingsUsd[symbol]) || 0);
    }
  }

  return {
    cash: Math.max(0, Number(body.cash ?? config.paper.startingCash) || 0),
    holdingsUsd
  };
}

function resolvePaperSymbols(setup) {
  const active = Object.keys(setup.holdingsUsd || {}).filter((symbol) => setup.holdingsUsd[symbol] > 0);
  return active.length > 0 ? active : [...config.paper.symbols];
}

function describeMode() {
  const source = resolveMarketSource();
  if (source === 'robinhood') return 'robinhood-live';
  if (source === 'mock') return 'mock-market-data';
  return 'binance-public';
}

async function fetchMarketQuotes(symbols, { allowMockFallback = true } = {}) {
  const source = resolveMarketSource();
  if (source === 'mock') {
    return createMockMarket(symbols).results;
  }

  try {
    const data = await publicMarket.getQuotes(symbols);
    return data.results;
  } catch (error) {
    if (!allowMockFallback) {
      throw error;
    }
    console.error(`Binance quote fetch failed, falling back to mock: ${error.message}`);
    return createMockMarket(symbols).results;
  }
}

async function fetchMarketView(symbols) {
  const source = resolveMarketSource();
  if (source === 'mock') {
    return createMockMarket(symbols);
  }

  try {
    return await publicMarket.getMarketView(
      symbols,
      config.market.klineInterval,
      config.market.sparklineLimit
    );
  } catch (error) {
    console.error(`Binance market view failed: ${error.message}`);
    throw error;
  }
}

async function applyPaperSetup(body = {}) {
  if (paperEngine.state.running) {
    await paperEngine.stop();
  }
  const setup = parsePaperSetup(body);
  const symbols = resolvePaperSymbols(setup);
  paperEngine.symbols = symbols;
  for (const symbol of symbols) {
    if (!paperEngine.state.priceHistory[symbol]) paperEngine.state.priceHistory[symbol] = [];
  }
  paperEngine.state.initialPortfolio = {
    cash: setup.cash,
    holdingsUsd: { ...setup.holdingsUsd }
  };
  await warmPaperHistory();
  const quotes = await fetchMarketQuotes(symbols);
  paperEngine.setupPortfolio(setup, quotes);
  await paperEngine.persist();
}

async function fetchStockQuotes(symbols) {
  try {
    const data = await stockMarket.getQuotes(symbols);
    return data.results;
  } catch (error) {
    console.error(`Yahoo quote fetch failed, falling back to mock: ${error.message}`);
    return createMockStockMarket(symbols).results;
  }
}

async function fetchStockDecisionHistory(symbols) {
  try {
    return await stockMarket.getHistoricalCloses(symbols, config.stock.candleRange, '1d');
  } catch (error) {
    console.error(`Stock decision history failed, falling back to mock: ${error.message}`);
    return generateMockCloses(symbols, 260);
  }
}

function parseHoldingsParam(raw) {
  if (!raw) return {};
  const holdings = {};
  for (const part of String(raw).split(',')) {
    const [symbol, qty] = part.split(':');
    const key = String(symbol || '').trim().toUpperCase();
    const shares = Number(qty);
    if (key && Number.isFinite(shares) && shares > 0) holdings[key] = shares;
  }
  return holdings;
}

function normalizeHoldingsMap(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const holdings = {};
  for (const [symbol, value] of Object.entries(raw)) {
    const key = String(symbol || '').trim().toUpperCase();
    const shares = Number(value?.quantity ?? value?.shares ?? value);
    if (key && Number.isFinite(shares) && shares > 0) holdings[key] = shares;
  }
  return holdings;
}

async function fetchStockMarketView(symbols) {
  try {
    return await stockMarket.getMarketView(symbols, '1mo', '1d');
  } catch (error) {
    console.error(`Yahoo market view failed, falling back to mock: ${error.message}`);
    return createMockStockMarket(symbols);
  }
}

async function fetchStockCandles(symbol, range) {
  try {
    const data = await stockMarket.getCandles(symbol, range);
    return { ...data, source: 'yahoo', range };
  } catch (error) {
    const closes = generateMockCloses([symbol], 260)[symbol];
    return {
      symbol,
      range,
      source: 'mock',
      sourceError: error.message,
      closes,
      candles: closes.map((close, index) => ({ time: index, open: close, high: close, low: close, close, volume: 0 }))
    };
  }
}

async function resolveStockPaperSymbols(body = {}) {
  if (Array.isArray(body.symbols) && body.symbols.length) {
    return body.symbols.map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean);
  }
  if (body.useKawaiiList !== false) {
    const watchlist = await readStockWatchlistDir(config.stock.watchlistDir);
    if (watchlist.symbols.length) return watchlist.symbols;
  }
  const provided = Object.keys(body.holdingsUsd || {});
  return provided.length ? provided.map((symbol) => symbol.toUpperCase()) : [...config.stock.symbols];
}

async function parseStockPaperSetup(body = {}) {
  // 优先使用前端自选清单(body.holdingsUsd 的 key);为空时回退到服务端默认标的
  const symbols = await resolveStockPaperSymbols(body);
  const holdingsUsd = {};
  for (const symbol of symbols) {
    const value = body.holdingsUsd?.[symbol];
    holdingsUsd[symbol.toUpperCase()] = Math.max(0, Number(value) || 0);
  }
  return {
    cash: Math.max(0, Number(body.cash ?? config.stock.paper.startingCash) || 0),
    holdingsUsd
  };
}

async function applyStockPaperSetup(body = {}) {
  if (stockPaperEngine.state.running) {
    await stockPaperEngine.stop();
  }
  const setup = await parseStockPaperSetup(body);
  const symbols = Object.keys(setup.holdingsUsd).length ? Object.keys(setup.holdingsUsd) : [...config.stock.symbols];
  stockPaperEngine.symbols = symbols;
  for (const symbol of symbols) {
    if (!stockPaperEngine.state.priceHistory[symbol]) stockPaperEngine.state.priceHistory[symbol] = [];
  }
  stockPaperEngine.state.initialPortfolio = { cash: setup.cash, holdingsUsd: { ...setup.holdingsUsd } };
  await warmStockPaperHistory();
  const quotes = await fetchStockQuotes(symbols);
  stockPaperEngine.setupPortfolio(setup, quotes);
  await stockPaperEngine.persist();
}

async function applyOptionsPaperSetup(body = {}) {
  if (optionsPaperEngine.state.running) {
    await optionsPaperEngine.stop();
  }
  const symbols = Array.isArray(body.symbols) && body.symbols.length
    ? body.symbols.map((s) => String(s).toUpperCase())
    : [...config.stock.symbols];
  optionsPaperEngine.symbols = symbols;
  optionsPaperEngine.model = optionsPaperModel;
  optionsPaperEngine.configure({
    cash: body.cash ?? config.stock.accountEquityUsd,
    optionStrategy: body.optionStrategy,
    dteDays: body.dteDays,
    positionFraction: body.positionFraction,
    model: optionsPaperModel
  });
  await warmOptionsPaperHistory();
  await optionsPaperEngine.persist();
}

async function warmOptionsPaperHistory() {
  const symbols = optionsPaperEngine.symbols?.length ? optionsPaperEngine.symbols : config.stock.symbols;
  const needsWarmup = symbols.some((symbol) => !optionsPaperEngine.state.priceHistory[symbol]?.length);
  if (!needsWarmup) return;
  try {
    const history = await stockMarket.getHistoricalCloses(symbols, config.stock.candleRange, '1d');
    const filled = {};
    for (const symbol of symbols) {
      filled[symbol] = history[symbol]?.length ? history[symbol] : generateMockCloses([symbol], 260)[symbol];
    }
    optionsPaperEngine.seedHistory(filled);
  } catch (error) {
    console.error(`Options warmup failed, using mock: ${error.message}`);
    optionsPaperEngine.seedHistory(generateMockCloses(symbols, 260));
  }
}

async function warmStockPaperHistory() {
  const symbols = stockPaperEngine.symbols?.length ? stockPaperEngine.symbols : config.stock.symbols;
  const needsWarmup = symbols.some((symbol) => !stockPaperEngine.state.priceHistory[symbol]?.length);
  if (!needsWarmup) return;
  try {
    const history = await stockMarket.getHistoricalCloses(symbols, config.stock.candleRange, '1d');
    const filled = {};
    for (const symbol of symbols) {
      filled[symbol] = history[symbol]?.length ? history[symbol] : generateMockCloses([symbol], 260)[symbol];
    }
    stockPaperEngine.seedHistory(filled);
  } catch (error) {
    console.error(`Yahoo history warmup failed, using mock: ${error.message}`);
    stockPaperEngine.seedHistory(generateMockCloses(symbols, 260));
  }
}

async function warmPaperHistory() {
  const symbols = paperEngine.symbols?.length ? paperEngine.symbols : config.paper.symbols;
  const needsWarmup = symbols.some((symbol) => !paperEngine.state.priceHistory[symbol]?.length);
  if (!needsWarmup) return;

  const source = resolveMarketSource();
  if (source === 'mock') {
    paperEngine.seedHistory(generateMockPriceSeries(symbols));
    return;
  }

  if (source === 'binance') {
    try {
      const history = await publicMarket.getHistoricalCloses(
        symbols,
        config.market.klineInterval,
        config.market.klineLimit
      );
      paperEngine.seedHistory(history);
      return;
    } catch (error) {
      console.error(`Binance history warmup failed, falling back to mock: ${error.message}`);
    }
  }

  paperEngine.seedHistory(generateMockPriceSeries(symbols));
}

async function fetchDecisionHistory(symbols) {
  if (resolveMarketSource() === 'mock') {
    return generateMockPriceSeries(symbols, config.market.klineLimit);
  }

  try {
    return await publicMarket.getHistoricalCloses(
      symbols,
      config.market.klineInterval,
      config.market.klineLimit
    );
  } catch (error) {
    console.error(`Decision history fetch failed, falling back to mock: ${error.message}`);
    return generateMockPriceSeries(symbols, config.market.klineLimit);
  }
}

// 短缓存 + 同 key 去重：避免预测轮询 / 胜率页 / 加密台同时串行打爆 Polymarket 把整站拖死
const INTERVAL_SIGNALS_CACHE_MS = 8000;
const intervalSignalsCacheMap = new Map(); // key -> { at, payload }
const intervalSignalsInflightMap = new Map(); // key -> Promise
const polymarketSentimentLastGoodMap = new Map(); // symbol|timeframe|target -> sentiment
const WINRATE_LOCK_CACHE_MS = 60000;
let winrateLockCache = { key: '', at: 0, payload: null, inflight: null };
const WINRATE_PAGE_CACHE_MS = 12000;
let winratePageCache = { key: '', at: 0, payload: null, inflight: null };

function sliceIntervalSignalsPayload(payload, symbols) {
  if (!payload || !Array.isArray(symbols) || !symbols.length) return payload;
  const want = new Set(symbols);
  return {
    ...payload,
    signals: (payload.signals || []).filter((item) => want.has(item.symbol)),
    signals5m: (payload.signals5m || []).filter((item) => want.has(item.symbol))
  };
}

function intervalPayloadCoversSymbols(payload, symbols) {
  if (!payload || !Array.isArray(symbols) || !symbols.length) return false;
  const have = new Set((payload.signals || []).map((item) => item.symbol));
  return symbols.every((symbol) => have.has(symbol));
}

function pruneIntervalSignalsCache(nowMs = Date.now()) {
  for (const [cacheKey, entry] of intervalSignalsCacheMap) {
    if (!entry || (nowMs - entry.at) >= 120_000) {
      intervalSignalsCacheMap.delete(cacheKey);
    }
  }
}

async function buildCryptoIntervalSignals(symbols, { lookbackDays = 14 } = {}) {
  const list = Array.isArray(symbols) && symbols.length ? symbols : config.predictionRecords.symbols;
  const key = `${list.join(',')}|${lookbackDays}`;
  const nowMs = Date.now();
  const exact = intervalSignalsCacheMap.get(key);
  if (exact && (nowMs - exact.at) < INTERVAL_SIGNALS_CACHE_MS) {
    return exact.payload;
  }
  const current5mSlotIso = getSlotSchedule(new Date(nowMs), 5).currentSlotIso;
  const exact5mSlotIso = exact?.payload?.schedule5m?.currentSlotIso;
  // Same-window stale-while-revalidate: the dashboard should never wait on a
  // slow Polymarket request when a usable snapshot already exists. The fresh
  // build still runs in the background and records the updated judgment.
  if (exact && exact5mSlotIso === current5mSlotIso && (nowMs - exact.at) < 60_000) {
    if (!intervalSignalsInflightMap.has(key)) {
      const refresh = withDeadline(
        buildCryptoIntervalSignalsFresh(list, { lookbackDays }),
        7_000,
        `Crypto interval signals background refresh (${key})`
      )
        .then((payload) => {
          intervalSignalsCacheMap.set(key, { at: Date.now(), payload });
          intervalSignalsInflightMap.delete(key);
          pruneIntervalSignalsCache();
          return payload;
        })
        .catch((error) => {
          intervalSignalsInflightMap.delete(key);
          console.error(`Crypto interval background refresh failed: ${error?.message || error}`);
          return exact.payload;
        });
      intervalSignalsInflightMap.set(key, refresh);
    }
    return {
      ...exact.payload,
      staleWhileRevalidate: true,
      staleAgeMs: nowMs - exact.at
    };
  }
  // 胜率页常只拉单币：若预测轮询已有更全的热缓存，直接切片，避免再打一轮 PM/K 线
  for (const [cacheKey, entry] of intervalSignalsCacheMap) {
    if (!cacheKey.endsWith(`|${lookbackDays}`)) continue;
    if (!entry || (nowMs - entry.at) >= INTERVAL_SIGNALS_CACHE_MS) continue;
    if (intervalPayloadCoversSymbols(entry.payload, list)) {
      return sliceIntervalSignalsPayload(entry.payload, list);
    }
  }
  const existingInflight = intervalSignalsInflightMap.get(key);
  if (existingInflight) return existingInflight;

  const inflight = withDeadline(
    buildCryptoIntervalSignalsFresh(list, { lookbackDays }),
    7_000,
    `Crypto interval signals (${key})`
  )
    .then((payload) => {
      intervalSignalsCacheMap.set(key, { at: Date.now(), payload });
      intervalSignalsInflightMap.delete(key);
      pruneIntervalSignalsCache();
      return payload;
    })
    .catch((error) => {
      intervalSignalsInflightMap.delete(key);
      throw error;
    });
  intervalSignalsInflightMap.set(key, inflight);
  return inflight;
}

async function loadPolymarketSentimentPairLegacy(symbol, schedule, schedule5m, now) {
  try {
    // 胜率/预测轮询不挂 Chainlink RTDS（易超时/栈溢出）；标的价由 K 线/报价提供
    const [sentiment15m, sentiment5m] = await withDeadline(
      Promise.all([
        buildPolymarketSentiment({
          symbol,
          targetTimeIso: schedule.nextSlotIso,
          client: polymarketClient,
          now
        }),
        buildPolymarketSentiment({
          symbol,
          targetTimeIso: schedule5m.nextSlotIso,
          timeframe: '5m',
          client: polymarketClient,
          now
        })
      ]),
      3_500,
      `${symbol} Polymarket sentiment pair`
    );
    return { symbol, sentiment15m, sentiment5m, error: null };
  } catch (error) {
    return {
      symbol,
      sentiment15m: { available: false, symbol, reason: error.message },
      sentiment5m: { available: false, symbol, timeframe: '5m', reason: error.message },
      error: error.message
    };
  }
}

function prunePolymarketSentimentLastGood(nowMs = Date.now()) {
  for (const [key, entry] of polymarketSentimentLastGoodMap) {
    const targetMs = Date.parse(entry?.targetTimeIso);
    if (!Number.isFinite(targetMs) || nowMs - targetMs > 15 * 60_000) {
      polymarketSentimentLastGoodMap.delete(key);
    }
  }
}

async function loadPolymarketSentimentOne({ symbol, timeframe, targetTimeIso, now, timeoutMs }) {
  const normalizedTimeframe = timeframe === '5m' ? '5m' : '15m';
  const cacheKey = `${symbol}|${normalizedTimeframe}|${targetTimeIso}`;
  let failure = null;
  try {
    const sentiment = await withDeadline(
      buildPolymarketSentiment({
        symbol,
        targetTimeIso,
        ...(normalizedTimeframe === '5m' ? { timeframe: '5m' } : {}),
        client: polymarketClient,
        now
      }),
      timeoutMs,
      `${symbol} ${normalizedTimeframe} Polymarket sentiment`
    );
    if (sentiment?.available) {
      const cached = { ...sentiment, targetTimeIso, reusedLastGood: false };
      polymarketSentimentLastGoodMap.set(cacheKey, cached);
      prunePolymarketSentimentLastGood();
      return { sentiment: cached, error: null };
    }
    failure = sentiment?.reason || `${symbol} ${normalizedTimeframe} Polymarket unavailable`;
  } catch (error) {
    failure = error?.message || String(error);
  }

  const lastGood = polymarketSentimentLastGoodMap.get(cacheKey);
  if (lastGood) {
    return {
      sentiment: { ...lastGood, reusedLastGood: true, refreshError: failure },
      error: failure
    };
  }
  return {
    sentiment: {
      available: false,
      symbol,
      timeframe: normalizedTimeframe,
      targetTimeIso,
      reason: failure
    },
    error: failure
  };
}

async function loadPolymarketSentimentPair(symbol, schedule, schedule5m, now) {
  // Isolate timeframes so a slow 15m request can never erase a valid 5m result.
  const [result15m, result5m] = await Promise.all([
    loadPolymarketSentimentOne({
      symbol,
      timeframe: '15m',
      targetTimeIso: schedule.nextSlotIso,
      now,
      timeoutMs: 4_000
    }),
    loadPolymarketSentimentOne({
      symbol,
      timeframe: '5m',
      targetTimeIso: schedule5m.nextSlotIso,
      now,
      timeoutMs: 5_500
    })
  ]);
  return {
    symbol,
    sentiment15m: result15m.sentiment,
    sentiment5m: result5m.sentiment,
    errors: { '15m': result15m.error, '5m': result5m.error },
    error: result5m.error || result15m.error || null
  };
}

async function buildCryptoIntervalSignalsFresh(symbols, { lookbackDays = 14 } = {}) {
  const now = new Date();
  const schedule = getIntervalScheduleForServer(now);
  const schedule5m = getSlotSchedule(now, 5);
  const signals = [];
  const signals5m = [];
  let source = resolveMarketSource();
  let sourceError = null;
  let quotesBySymbol = {};
  let polymarketError = null;
  const polymarketBySymbol = {};
  const polymarket5mBySymbol = {};
  // 三类外部数据同时启动；每一类都有自己的截止时间，不能互相串行放大延迟。
  const candlesBySymbol = new Map(symbols.map((symbol) => [
    symbol,
    (source === 'mock'
      ? Promise.resolve([
        mockCandlesFromCloses(generateMockPriceSeries([symbol], 80)[symbol]),
        mockCandlesFromCloses(generateMockPriceSeries([symbol], 80)[symbol], 5)
      ])
      : withDeadline(
        Promise.all([
          publicMarket.getCandles(symbol, '15m', 96),
          publicMarket.getCandles(symbol, '5m', 80)
        ]),
        8_000,
        `${symbol} candle pair`
      ))
      .then((candles) => ({ ok: true, candles }))
      .catch((error) => ({ ok: false, error: error?.message || String(error) }))
  ]));

  const [pmResults, quotesResult] = await Promise.all([
    config.polymarket.enabled
      ? Promise.all(symbols.map((symbol) => loadPolymarketSentimentPair(symbol, schedule, schedule5m, now)))
      : Promise.resolve([]),
    withDeadline(
      fetchMarketQuotes(symbols, { allowMockFallback: source === 'mock' }),
      8_000,
      'Crypto market quotes'
    )
      .then((quotes) => ({ ok: true, quotes }))
      .catch((error) => ({ ok: false, error: error.message }))
  ]);

  for (const row of pmResults) {
    polymarketBySymbol[row.symbol] = row.sentiment15m;
    polymarket5mBySymbol[row.symbol] = row.sentiment5m;
    if (row.error) polymarketError = row.error;
  }
  if (quotesResult.ok) {
    quotesBySymbol = Object.fromEntries(quotesResult.quotes.map((quote) => [quote.symbol, quote]));
  } else {
    sourceError = quotesResult.error;
  }

  const perSymbol = await Promise.all(symbols.map(async (symbol) => {
    try {
      const quotePx = quotePrice(quotesBySymbol[symbol]);

      const candleResult = await candlesBySymbol.get(symbol);
      if (!candleResult?.ok) {
        throw new Error(candleResult?.error || `${symbol} candles unavailable`);
      }
      const [candles15m, candles5m] = candleResult.candles;
      const candlePx = Number(
        candles5m?.[candles5m.length - 1]?.close
        ?? candles15m?.[candles15m.length - 1]?.close
      );
      const currentPrice = (Number.isFinite(quotePx) && quotePx > 0)
        ? quotePx
        : ((Number.isFinite(candlePx) && candlePx > 0) ? candlePx : null);
      if (source !== 'mock' && (!Number.isFinite(currentPrice) || currentPrice <= 0)) {
        throw new Error(`Live quote unavailable for ${symbol}`);
      }

      let signal = buildIntervalSignal({
        symbol,
        candles: candles15m,
        currentPrice,
        currentQuoteTime: quotesBySymbol[symbol]?.timestamp,
        now
      });
      const techDirection15m = signal.direction;
      const techConfidence15m = signal.confidence;
      const sentiment = polymarketBySymbol[symbol];
      if (config.polymarket.enabled && config.polymarket.blendEnabled && sentiment) {
        signal = blendWithPolymarketSentiment(signal, sentiment);
      } else if (sentiment) {
        signal = { ...signal, polymarket: sentiment };
      }
      signal = {
        ...signal,
        currentPrice,
        techDirection: techDirection15m,
        techConfidence: techConfidence15m,
        compositeDirection: signal.direction,
        compositeConfidence: signal.confidence
      };

      let signal5m = buildPolymarketIntervalSignal({
        symbol,
        candles: candles5m,
        currentPrice,
        currentQuoteTime: quotesBySymbol[symbol]?.timestamp,
        timeframe: '5m',
        now
      });
      const techDirection = signal5m.direction;
      const techConfidence = signal5m.confidence;
      const sentiment5m = polymarket5mBySymbol[symbol];
      if (config.polymarket.enabled && config.polymarket.blendEnabled && sentiment5m?.available) {
        signal5m = blendWithPolymarketSentiment(signal5m, sentiment5m);
      } else if (sentiment5m) {
        signal5m = { ...signal5m, polymarket: sentiment5m };
      }
      signal5m = {
        ...signal5m,
        currentPrice,
        techDirection,
        techConfidence,
        compositeDirection: signal5m.direction,
        compositeConfidence: signal5m.confidence
      };
      return { symbol, signal, signal5m, error: null };
    } catch (error) {
      return {
        symbol,
        signal: buildUnavailableIntervalSignal(symbol, now, error.message),
        signal5m: buildUnavailablePolymarketSignal(symbol, '5m', now, error.message),
        error: error.message
      };
    }
  }));

  for (const row of perSymbol) {
    signals.push(row.signal);
    signals5m.push(row.signal5m);
    if (row.error) sourceError = row.error;
  }

  const generatedAt = now.toISOString();
  predictionRecorder.track(signals, generatedAt);
  predictionRecorder.track(signals5m, generatedAt);
  const enrichedSignals = signals.map((signal) => {
    const lockedDecision = predictionRecorder.getLockedFifteenMinuteDecision(
      signal.symbol,
      signal.prediction?.targetTimeIso
    );
    const nextSlotPrediction = predictionRecorder.getActiveNextSlotPrediction({
      currentSlotIso: signal.schedule?.currentSlotIso,
      timeframe: '15m',
      symbol: signal.symbol
    });
    let next = signal;
    if (lockedDecision) next = { ...next, lockedDecision };
    if (nextSlotPrediction) next = { ...next, nextSlotPrediction };
    return attachWinrateGuidance(next, { timeframe: '15m', source, generatedAt, lookbackDays });
  });
  const enrichedSignals5m = signals5m.map((signal) => {
    const lockedDecision = predictionRecorder.getLockedFiveMinuteDecision(
      signal.symbol,
      signal.prediction?.targetTimeIso
    );
    const nextSlotPrediction = predictionRecorder.getActiveNextSlotPrediction({
      currentSlotIso: signal.schedule?.currentSlotIso,
      timeframe: '5m',
      symbol: signal.symbol
    });
    let next = signal;
    if (lockedDecision) next = { ...next, lockedDecision };
    if (nextSlotPrediction) next = { ...next, nextSlotPrediction };
    return attachWinrateGuidance(next, { timeframe: '5m', source, generatedAt, lookbackDays });
  });

  return {
    source,
    sourceError,
    polymarketError,
    polymarketEnabled: config.polymarket.enabled,
    polymarketBlendEnabled: config.polymarket.blendEnabled,
    generatedAt,
    intervalMinutes: 15,
    checkpoints: ['00', '15', '30', '45'],
    signals: enrichedSignals,
    signals5m: enrichedSignals5m,
    schedule5m: {
      currentSlotIso: schedule5m.currentSlotIso,
      nextSlotIso: schedule5m.nextSlotIso,
      secondsToNext: schedule5m.secondsToNext
    },
    fiveMinuteDecisionLockElapsedPct: predictionRecorder.fiveMinuteConfig.defaultElapsedPct,
    fiveMinuteDecisionConfig: {
      minElapsedPct: predictionRecorder.fiveMinuteConfig.minElapsedPct,
      defaultElapsedPct: predictionRecorder.fiveMinuteConfig.defaultElapsedPct,
      maxElapsedPct: predictionRecorder.fiveMinuteConfig.maxElapsedPct,
      minPmGap: predictionRecorder.fiveMinuteConfig.minPmGap,
      strongPmGap: predictionRecorder.fiveMinuteConfig.strongPmGap,
      normalPmGap: predictionRecorder.fiveMinuteConfig.normalPmGap,
      lowWinrateHourGuardEnabled: predictionRecorder.fiveMinuteConfig.lowWinrateHourGuardEnabled,
      lowWinrateHourPolicies: predictionRecorder.fiveMinuteConfig.lowWinrateHourPolicies,
      hardLockElapsedPct: predictionRecorder.fiveMinuteConfig.hardLockElapsedPct,
      hardLockMinPmGap: predictionRecorder.fiveMinuteConfig.hardLockMinPmGap
    },
    fifteenMinuteDecisionLockElapsedPct: predictionRecorder.fifteenMinuteConfig.defaultElapsedPct,
    fifteenMinuteDecisionConfig: {
      minElapsedPct: predictionRecorder.fifteenMinuteConfig.minElapsedPct,
      defaultElapsedPct: predictionRecorder.fifteenMinuteConfig.defaultElapsedPct,
      maxElapsedPct: predictionRecorder.fifteenMinuteConfig.maxElapsedPct,
      minPmGap: predictionRecorder.fifteenMinuteConfig.minPmGap,
      strongPmGap: predictionRecorder.fifteenMinuteConfig.strongPmGap,
      normalPmGap: predictionRecorder.fifteenMinuteConfig.normalPmGap,
      lowWinrateHourGuardEnabled: predictionRecorder.fifteenMinuteConfig.lowWinrateHourGuardEnabled,
      lowWinrateHourPolicies: predictionRecorder.fifteenMinuteConfig.lowWinrateHourPolicies,
      hardLockElapsedPct: predictionRecorder.fifteenMinuteConfig.hardLockElapsedPct,
      hardLockMinPmGap: predictionRecorder.fifteenMinuteConfig.hardLockMinPmGap
    },
    nextSlotPredictionLockConfig: {
      '5m': predictionRecorder.nextSlotPredictionLockConfig5m,
      '15m': predictionRecorder.nextSlotPredictionLockConfig15m
    }
  };
}

function attachWinrateGuidance(signal, { timeframe = '15m', source = null, generatedAt = null, lookbackDays = 14 } = {}) {
  const judgment = extractJudgmentFromSignal(signal, { timeframe, source, generatedAt });
  if (!judgment) {
    return {
      ...signal,
      winrateGuidance: {
        sampleInsufficient: true,
        note: '样本不足：当前窗口尚无可用方向判断。',
        suggestedWeight: 1,
        alignsWithHistoricalEdge: null,
        preferredDirection: null,
        overall: { total: 0, correct: 0, wrong: 0, winRate: 0, sampleInsufficient: true },
        conditional: { total: 0, correct: 0, wrong: 0, winRate: 0, sampleInsufficient: true },
        slices: {}
      }
    };
  }

  try {
    statsDb?.recordDirectionJudgment(judgment);
  } catch (error) {
    console.error(`Direction judgment record failed: ${error.message}`);
  }

  const guidance = buildJudgmentGuidance({
    judgment,
    statsDb,
    lookbackDays
  });
  return applyGuidanceToSignal({ ...signal, directionJudgment: judgment }, guidance);
}

function normalizeLockWinStats(summary = {}) {
  const polymarket = summary.polymarket || summary || {};
  const total = Number(polymarket.total) || 0;
  const correct = Number(polymarket.correct ?? polymarket.wins) || 0;
  const wrong = Number(polymarket.wrong ?? polymarket.losses) || Math.max(0, total - correct);
  const winRate = total > 0
    ? (Number.isFinite(Number(polymarket.winRate)) ? Number(polymarket.winRate) : correct / total)
    : 0;
  return {
    total,
    correct,
    wrong,
    winRate,
    sampleInsufficient: total < 8,
    buckets: summary.buckets || null
  };
}

async function readWinrateLockSummaryCached(lookbackDays = 14) {
  const key = String(lookbackDays);
  const nowMs = Date.now();
  if (
    winrateLockCache.payload
    && winrateLockCache.key === key
    && (nowMs - winrateLockCache.at) < WINRATE_LOCK_CACHE_MS
  ) {
    return winrateLockCache.payload;
  }
  if (winrateLockCache.inflight && winrateLockCache.key === key) {
    return winrateLockCache.inflight;
  }
  const inflight = predictionRecorder.readIntervalPmLockSummary({
    lookbackDays,
    preferSqlite: true
  })
    .then((payload) => {
      winrateLockCache = { key, at: Date.now(), payload, inflight: null };
      return payload;
    })
    .catch((error) => {
      if (winrateLockCache.key === key) {
        winrateLockCache = { ...winrateLockCache, inflight: null };
      }
      throw error;
    });
  winrateLockCache = { ...winrateLockCache, key, inflight };
  return inflight;
}

function slimWinrateSignal(signal) {
  if (!signal) return null;
  const locked = signal.lockedDecision || null;
  const pm = signal.polymarket || null;
  return {
    symbol: signal.symbol,
    direction: signal.direction,
    confidence: signal.confidence,
    confidenceBeforeGuidance: signal.confidenceBeforeGuidance,
    guidanceWeight: signal.guidanceWeight,
    currentPrice: signal.currentPrice ?? signal.price ?? null,
    schedule: signal.schedule || null,
    prediction: signal.prediction?.targetTimeIso
      ? { targetTimeIso: signal.prediction.targetTimeIso }
      : null,
    lockedDecision: locked
      ? {
        direction: locked.direction,
        strength: locked.strength || locked.lockStrength || null,
        lockStrength: locked.lockStrength || locked.strength || null,
        confidence: locked.confidence,
        source: locked.source || null,
        pmGap: locked.pmGap ?? locked.lockGap ?? null,
        upProbability: locked.upProbability ?? locked.upProb ?? null,
        downProbability: locked.downProbability ?? locked.downProb ?? null,
        lockedAtIso: locked.lockedAtIso || null
      }
      : null,
    polymarket: pm
      ? {
        available: Boolean(pm.available),
        reason: pm.reason || pm.refreshError || null,
        reusedLastGood: Boolean(pm.reusedLastGood),
        fetchedAtIso: pm.fetchedAtIso || null,
        underlyingPrice: pm.underlyingPrice ?? null,
        price: pm.price ?? null,
        upProbability: pm.upProbability ?? pm.upPrice ?? null,
        downProbability: pm.downProbability ?? pm.downPrice ?? null,
        qualityScore: pm.qualityScore ?? null,
        spread: pm.spread ?? null
      }
      : null,
    indicators: {
      currentPrice: signal.indicators?.currentPrice ?? signal.currentPrice ?? null,
      close: signal.indicators?.close ?? null
    }
  };
}

function slimWinrateJudgment(judgment) {
  if (!judgment) return null;
  return {
    id: judgment.id,
    symbol: judgment.symbol,
    timeframe: judgment.timeframe,
    predictedDirection: judgment.predictedDirection,
    confidence: judgment.confidence,
    lockStrength: judgment.lockStrength,
    price: judgment.price,
    source: judgment.source,
    hourBucket: judgment.hourBucket,
    status: judgment.status
  };
}

function slimWinrateGuidance(guidance) {
  if (!guidance) return null;
  return {
    sampleInsufficient: Boolean(guidance.sampleInsufficient),
    suggestedWeight: guidance.suggestedWeight,
    alignsWithHistoricalEdge: guidance.alignsWithHistoricalEdge,
    preferredDirection: guidance.preferredDirection,
    note: guidance.note,
    conditional: guidance.conditional || null,
    overall: guidance.overall || null,
    hourRegime: guidance.hourRegime || null
  };
}

async function buildWinratePagePayload(symbols, { lookbackDays = 14, mode = 'summary' } = {}) {
  const summaryMode = mode !== 'full';
  const list = Array.isArray(symbols) && symbols.length ? symbols : config.predictionRecords.symbols;
  const cacheKey = `${list.join(',')}|${lookbackDays}|${summaryMode ? 'summary' : 'full'}`;
  const nowMs = Date.now();
  const secondsToNext5m = 300 - (Math.floor(nowMs / 1000) % 300);
  const pageCacheMs = secondsToNext5m <= 60 ? 4000 : WINRATE_PAGE_CACHE_MS;
  if (
    winratePageCache.payload
    && winratePageCache.key === cacheKey
    && (nowMs - winratePageCache.at) < pageCacheMs
  ) {
    return {
      ...winratePageCache.payload,
      refreshing: false,
      cacheAgeMs: nowMs - winratePageCache.at
    };
  }
  if (winratePageCache.inflight && winratePageCache.key === cacheKey) {
    if (winratePageCache.payload) {
      return {
        ...winratePageCache.payload,
        refreshing: true,
        cacheAgeMs: nowMs - winratePageCache.at
      };
    }
    return winratePageCache.inflight;
  }

  const cachedFallback = winratePageCache.key === cacheKey
    ? winratePageCache.payload
    : null;
  const inflight = withDeadline(
    buildWinratePagePayloadFresh(list, { lookbackDays, summaryMode }),
    15_000,
    `Winrate page payload (${cacheKey})`
  )
    .then((payload) => {
      winratePageCache = { key: cacheKey, at: Date.now(), payload, inflight: null };
      return payload;
    })
    .catch((error) => {
      if (winratePageCache.key === cacheKey) {
        winratePageCache = { ...winratePageCache, inflight: null };
      }
      console.error(
        `Winrate page refresh failed; ${cachedFallback ? 'using cached payload' : 'no cached payload available'}:`,
        error?.message || error
      );
      if (cachedFallback) return cachedFallback;
      throw error;
    });
  winratePageCache = { ...winratePageCache, key: cacheKey, inflight };
  if (cachedFallback) {
    return {
      ...cachedFallback,
      refreshing: true,
      cacheAgeMs: nowMs - winratePageCache.at
    };
  }
  return inflight;
}

async function buildWinratePagePayloadFresh(symbols, { lookbackDays = 14, summaryMode = true } = {}) {
  const [interval, lockSummary] = await Promise.all([
    buildCryptoIntervalSignals(symbols, { lookbackDays }),
    withDeadline(
      readWinrateLockSummaryCached(lookbackDays),
      5_000,
      'Winrate lock summary'
    ).catch(() => null)
  ]);
  const lock5m = normalizeLockWinStats(lockSummary?.fiveMinute || {});
  const lock15m = normalizeLockWinStats(lockSummary?.fifteenMinute || {});
  const bySymbol = {};
  for (const symbol of symbols) {
    const signal15m = (interval.signals || []).find((item) => item.symbol === symbol) || null;
    const signal5m = (interval.signals5m || []).find((item) => item.symbol === symbol) || null;
    // 历史锁定胜率优先 SQLite window_locks（与旧台同源入库）；同条件仍用 direction_judgments
    const stats15m = lock15m.total
      ? lock15m
      : (statsDb?.getConditionalWinRates({ lookbackDays, timeframe: '15m', symbol })
        || { total: 0, correct: 0, wrong: 0, winRate: 0, sampleInsufficient: true });
    const stats5m = lock5m.total
      ? lock5m
      : (statsDb?.getConditionalWinRates({ lookbackDays, timeframe: '5m', symbol })
        || { total: 0, correct: 0, wrong: 0, winRate: 0, sampleInsufficient: true });
    bySymbol[symbol] = {
      symbol,
      '15m': {
        signal: summaryMode ? slimWinrateSignal(signal15m) : signal15m,
        stats: stats15m,
        guidance: summaryMode ? slimWinrateGuidance(signal15m?.winrateGuidance) : (signal15m?.winrateGuidance || null),
        judgment: summaryMode ? slimWinrateJudgment(signal15m?.directionJudgment) : (signal15m?.directionJudgment || null),
        locked: Boolean(signal15m?.lockedDecision?.direction)
      },
      '5m': {
        signal: summaryMode ? slimWinrateSignal(signal5m) : signal5m,
        stats: stats5m,
        guidance: summaryMode ? slimWinrateGuidance(signal5m?.winrateGuidance) : (signal5m?.winrateGuidance || null),
        judgment: summaryMode ? slimWinrateJudgment(signal5m?.directionJudgment) : (signal5m?.directionJudgment || null),
        locked: Boolean(signal5m?.lockedDecision?.direction)
      }
    };
  }

  const dbCounts = statsDb?.counts?.() || {};
  const base = {
    source: interval.source,
    sourceError: interval.sourceError,
    polymarketEnabled: interval.polymarketEnabled,
    generatedAt: interval.generatedAt,
    schedule5m: interval.schedule5m,
    lookbackDays,
    symbols,
    bySymbol,
    lockSummary: {
      lookbackDays: lockSummary?.lookbackDays ?? lookbackDays,
      fiveMinute: lock5m,
      fifteenMinute: lock15m,
      // summary 模式省略 nextSlot 明细，减小 JSON
      nextSlotPrediction: summaryMode ? null : (lockSummary?.nextSlotPrediction || null),
      source: lockSummary?.source || 'sqlite'
    },
    db: {
      enabled: Boolean(statsDb?.enabled),
      directionJudgments: dbCounts.directionJudgments || 0,
      windowLocks: dbCounts.windowLocks || 0,
      nextSlotPredictions: dbCounts.nextSlotPredictions || 0
    },
    mode: summaryMode ? 'summary' : 'full'
  };
  if (!summaryMode) {
    return {
      ...interval,
      ...base
    };
  }
  return base;
}

async function buildPolymarketRecommendation(symbol = 'BTC-USD', timeframe = '15m', planId = 'plan1', options = {}) {
  const id = normalizePaperPlanId(planId);
  const signal = id === 'plan5'
    ? await buildPlan5PolymarketOnlySignal(symbol, timeframe, new Date(), {
        preferLastGood: options.pendingDelayedEntrySource === 'live'
      })
    : await buildPolymarketMarketSignal(symbol, timeframe);
  if (id === 'plan5' && signal?.prediction) {
    // Plan5's lock is PM-native. Record this lightweight snapshot directly so
    // Binance/K-line availability cannot prevent the final lock from forming.
    predictionRecorder.track([signal], new Date().toISOString());
  }
  // paper-plans / live tick 高频调用：默认跳过全量 MD 策略风险扫描
  const includeRisk = options.includeRisk === true;
  const risk = includeRisk
    ? await predictionRecorder.readStrategyRiskSummary({ preferSqlite: true })
    : (predictionRecorder._strategyRiskCache?.payload || {
      preferredKey: null,
      strategies: [],
      recordCount: 0,
      generatedAtIso: new Date().toISOString(),
      skipped: true
    });
  const preferred = risk.strategies?.find((item) => item.key === risk.preferredKey) || risk.strategies?.[0] || null;
  const direction = signal?.direction === 'down' ? 'down' : 'up';
  const confidence = Number(signal?.confidence) || 0;
  const stats = polymarketTrading.computeStats(id);
  const portfolio = polymarketTrading.snapshotPortfolio(id);
  const sizing = computePolymarketOrderUsd({
    equity: stats.equity || portfolio.startingCash || config.polymarket.defaultStartingCash,
    cash: portfolio.cash,
    timeframe,
    config: config.polymarket
  });
  const suggestedUsd = sizing.usd;
  const schedule = signal?.schedule || getSlotSchedule(new Date(), timeframe === '5m' ? 5 : 15);
  // Plan5 has already performed a bounded PM lookup above. Repeating the same
  // request here without that deadline turned one transient timeout into a
  // minute-long gap between an existing lock and its live order attempt.
  const sentiment = id === 'plan5'
    ? signal?.polymarket
    : signal?.polymarket?.available
      ? signal.polymarket
      : await attachPolymarketTarget(await buildPolymarketSentiment({
        symbol,
        targetTimeIso: schedule.nextSlotIso,
        timeframe,
        client: polymarketClient
      }), {
        symbol,
        timeframe,
        schedule,
        now: new Date()
      });
  let draft = null;
  let draftError = null;
  try {
    draft = polymarketTrading.buildOrderDraft({
      symbol,
      direction,
      usd: suggestedUsd,
      sentiment,
      recommendation: { direction, confidence, strategy: preferred?.label || null }
    });
  } catch (error) {
    draftError = error.message;
  }
  return {
    symbol,
    timeframe,
    planId: id,
    source: 'binance-public',
    generatedAt: new Date().toISOString(),
    signal,
    polymarket: sentiment,
    risk,
    recommendation: {
      direction,
      label: direction === 'up' ? '买 UP / 看涨' : '买 DOWN / 看跌',
      confidence,
      strategy: preferred?.label || null,
      winRate: preferred?.winRate || 0,
      sizing,
      suggestedUsd,
      draft,
      draftError
    }
  };
}

async function attachPolymarketTarget(sentiment, { symbol = 'BTC-USD', timeframe = '15m', schedule, now = new Date() } = {}) {
  if (!sentiment?.available || sentiment.targetPrice) return sentiment;
  try {
    const target = await resolveChainlinkSlotTarget({
      symbol,
      timeframe,
      slotIso: schedule?.currentSlotIso,
      now
    });
    return mergeSentimentTarget(sentiment, target);
  } catch (error) {
    return {
      ...sentiment,
      targetPriceError: error.message
    };
  }
}

async function resolvePolymarketSettlementOutcome(order) {
  // The contract resolves from Polymarket's official outcome. Local exchange
  // candles can use a different open/close source and must not settle paper PnL.
  if (order?.marketSlug) {
    return withDeadline(
      polymarketClient.getResolvedMarketOutcome(order.marketSlug),
      Math.max(5_000, Number(config.polymarket.requestTimeoutMs) || 12_000),
      `Official outcome ${order.marketSlug}`
    );
  }
  const timeframe = order.timeframe || '15m';
  const chainlink = await resolvePolymarketWindowPrices({
    symbol: order.symbol,
    timeframe,
    slotIso: order.slotIso,
    targetTimeIso: order.targetTimeIso
  });
  if (chainlink?.actualDirection) return chainlink;

  const interval = timeframeToCandleInterval(timeframe);
  const outcome = await publicMarket.getWindowPrices(order.symbol, interval, order.targetTimeIso);
  return {
    actualClose: outcome.actualClose,
    actualDirection: outcome.actualDirection,
    startPrice: outcome.startPrice,
    priceSource: 'binance'
  };
}

function resolveFiveMinuteLockForPlan(symbol, now = new Date()) {
  const schedule5m = getSlotSchedule(now, 5);
  return predictionRecorder.getLockedFiveMinuteDecision(symbol, schedule5m.nextSlotIso);
}

function resolveIntervalPmLockForPlan(symbol, timeframe = '5m', now = new Date()) {
  const slotMinutes = timeframe === '5m' ? 5 : 15;
  const schedule = getSlotSchedule(now, slotMinutes);
  if (timeframe === '5m') {
    return predictionRecorder.getLockedFiveMinuteDecision(symbol, schedule.nextSlotIso);
  }
  return predictionRecorder.getLockedFifteenMinuteDecision(symbol, schedule.nextSlotIso);
}

function plan1ScanSymbols() {
  const symbols = Array.isArray(config.polymarket.plan1Symbols)
    ? config.polymarket.plan1Symbols
    : ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD'];
  return [...new Set(symbols.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean))];
}

function plan2ScanSymbols() {
  const symbols = Array.isArray(config.polymarket.plan2Symbols)
    ? config.polymarket.plan2Symbols
    : ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD'];
  return orderSymbolsLeaderFirst(
    [...new Set(symbols.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean))]
  );
}

function plan5ScanSymbols(selected = null) {
  const symbols = Array.isArray(selected) && selected.length
    ? selected
    : ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD'];
  return orderSymbolsLeaderFirst(
    [...new Set(symbols.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean))]
  );
}

/** BTC 优先评估，便于跨币跟随：先算 BTC，再把 leader 上下文传给 ETH/SOL/XRP。 */
function orderSymbolsLeaderFirst(symbols = []) {
  const list = [...symbols];
  const idx = list.indexOf('BTC-USD');
  if (idx > 0) {
    list.splice(idx, 1);
    list.unshift('BTC-USD');
  }
  return list;
}

function extractCrossSymbolLeader(view, symbol = 'BTC-USD') {
  const action = view?.plan?.action;
  if (!action) return null;
  return {
    symbol,
    shouldTrade: action.shouldTrade === true,
    direction: action.direction || null,
    confidence: Number(action.confidence) || null,
    limitPrice: Number(action.limitPrice) || null,
    entryType: action.entryType || null
  };
}

function resolvePaperAutoSymbols(planId, auto = {}) {
  if (planId === 'plan3' || planId === 'plan3_5' || planId === 'plan3_6') {
    const selected = Array.isArray(auto.symbols) && auto.symbols.length ? auto.symbols : ['BTC-USD'];
    return orderSymbolsLeaderFirst(selected);
  }
  if (planId === 'plan1') {
    const allowed = new Set(plan1ScanSymbols());
    const selected = Array.isArray(auto.symbols) && auto.symbols.length
      ? auto.symbols.filter((symbol) => allowed.has(String(symbol || '').toUpperCase()))
      : [];
    return orderSymbolsLeaderFirst(selected.length ? selected : [...allowed]);
  }
  if (planId === 'plan11') {
    const selected = Array.isArray(auto.symbols) && auto.symbols.length ? auto.symbols : null;
    return selected ? orderSymbolsLeaderFirst(selected) : plan2ScanSymbols();
  }
  if (planId === 'plan12' || planId === 'plan14') {
    const configured = planId === 'plan14' ? config.polymarket.plan14Symbols : config.polymarket.plan12Symbols;
    const allowed = Array.isArray(configured)
      ? configured
      : ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD'];
    const selected = Array.isArray(auto.symbols) && auto.symbols.length
      ? auto.symbols.filter((symbol) => allowed.includes(String(symbol || '').toUpperCase()))
      : [];
    return orderSymbolsLeaderFirst(selected.length ? selected : allowed);
  }
  if (isPlan2Family(planId)) {
    const selected = Array.isArray(auto.symbols) && auto.symbols.length ? auto.symbols : null;
    return selected ? orderSymbolsLeaderFirst(selected) : plan2ScanSymbols();
  }
  if (planId === 'plan5') {
    return plan5ScanSymbols(auto.symbols);
  }
  return ['BTC-USD'];
}

async function buildPlan1BasketSentiments({ primarySymbol, timeframe, schedule, now, primarySentiment }) {
  const symbols = plan1ScanSymbols();
  return Promise.all(symbols.map(async (basketSymbol) => {
    if (basketSymbol === primarySymbol && primarySentiment) {
      return { ...primarySentiment, symbol: basketSymbol };
    }
    try {
      const sentiment = await attachPolymarketTarget(await buildPolymarketSentiment({
        symbol: basketSymbol,
        targetTimeIso: schedule.nextSlotIso,
        timeframe,
        client: polymarketClient,
        btcPrice: null,
        elapsedPct: windowElapsedPct(schedule),
        now
      }), {
        symbol: basketSymbol,
        timeframe,
        schedule,
        now
      });
      return { ...sentiment, symbol: basketSymbol };
    } catch (error) {
      return { available: false, symbol: basketSymbol, timeframe, reason: error.message };
    }
  }));
}

function compactWindowTrackForPlan(track = null) {
  if (!track) return track;
  const { snapshot, ...analysis } = track;
  if (!snapshot) return analysis;
  const samples = Array.isArray(snapshot.samples)
    ? snapshot.samples.slice(-32).map((sample) => ({
      ts: sample.ts,
      upPrice: sample.upPrice,
      downPrice: sample.downPrice,
      btcPrice: sample.btcPrice ?? null,
      elapsedPct: sample.elapsedPct ?? null
    }))
    : [];
  return {
    ...analysis,
    snapshot: {
      slotIso: snapshot.slotIso,
      timeframe: snapshot.timeframe,
      symbol: snapshot.symbol,
      marketKey: snapshot.marketKey,
      sampleCount: snapshot.sampleCount,
      firstSampleAtMs: snapshot.firstSampleAtMs,
      lastSampleAtMs: snapshot.lastSampleAtMs,
      samples
    }
  };
}

const polymarketPlanViewCache = new Map();
const polymarketPlanViewInflight = new Map();

function resolvePolymarketPlanViewStaleMs(planId) {
  const id = normalizePaperPlanId(planId);
  if (id === 'plan5') {
    return Math.max(15_000, Number(config.polymarket.plan5ViewStaleReplaceMs) || 15_000);
  }
  // Plan1 live used to keep a hung 30s+ view for up to 120s while every later
  // tick hard-rejected with "previous view is still pending". Replace shortly
  // after the live view deadline so the next loop can rebuild.
  const liveViewTimeoutMs = Math.max(10_000, Number(config.polymarket.livePlanViewTimeoutMs) || 30_000);
  const configured = Number(config.polymarket.planViewStaleReplaceMs);
  const fallback = liveViewTimeoutMs + 5_000;
  return Math.max(liveViewTimeoutMs, Number.isFinite(configured) ? configured : fallback);
}

function polymarketPlanViewCacheKey(symbol, timeframe, planId, options = {}) {
  const source = options.pendingDelayedEntrySource === 'live' ? 'live' : 'paper';
  // Only callers that need a fresh execution decision per slot provide a
  // revision. Paper/dashboard refreshes must not accumulate one uncancellable
  // timed-out network task for every new 5m window.
  const slotRevision = options.cacheKeySuffix || 'shared';
  return `${source}:${normalizePaperPlanId(planId)}:${String(symbol).toUpperCase()}:${timeframe}:${slotRevision}`;
}

function prunePolymarketPlanViewCache(nowMs = Date.now()) {
  for (const [key, entry] of polymarketPlanViewCache) {
    if (!entry || nowMs - entry.at > 60_000) polymarketPlanViewCache.delete(key);
  }
}

function cachedPlanViewMatchesCurrentSlot(entry, timeframe) {
  if (!entry || timeframe === 'follow') return Boolean(entry); // legacy cache key; follow timeframe retired
  const expectedSlotIso = getSlotSchedule(new Date(), timeframe === '5m' ? 5 : 15).currentSlotIso;
  const cachedSlotIso = entry.payload?.plan?.slotIso
    || entry.payload?.signal?.schedule?.currentSlotIso
    || null;
  return cachedSlotIso === expectedSlotIso;
}

async function buildPolymarketPaperPlanView(symbol = 'BTC-USD', timeframe = '15m', planId = 'plan1', options = {}) {
  const key = polymarketPlanViewCacheKey(symbol, timeframe, planId, options);
  const maxAgeMs = Math.max(0, Number(options.cacheMaxAgeMs) || 0);
  const staleAfterMs = resolvePolymarketPlanViewStaleMs(planId);
  const existing = polymarketPlanViewInflight.get(key);
  if (existing && Date.now() - existing.startedAtMs >= staleAfterMs) {
    // A Promise timeout does not cancel its underlying network/DB work. Replacing
    // it here used to pile up duplicate 30-180s view builds until the dashboard
    // process consumed >1GB and even static HTML waited seconds. Keep one task per
    // plan/symbol/timeframe and let callers use the last good cache or time out.
    if (!existing.staleReported) {
      existing.staleReported = true;
      console.error(
        `Polymarket ${normalizePaperPlanId(planId)} ${symbol} ${timeframe} view is still pending after ${Date.now() - existing.startedAtMs}ms; duplicate build suppressed`
      );
    }
  }
  const cached = polymarketPlanViewCache.get(key);
  if (
    maxAgeMs > 0
    && cached
    && cachedPlanViewMatchesCurrentSlot(cached, timeframe)
    && (
      Date.now() - cached.at < maxAgeMs
      || polymarketPlanViewInflight.has(key)
    )
  ) return cached.payload;
  const active = polymarketPlanViewInflight.get(key);
  if (active) return active.promise;

  const startedAtMs = Date.now();
  let inflight;
  inflight = buildPolymarketPaperPlanViewFresh(symbol, timeframe, planId, options)
    .then((payload) => {
      // A stale request may eventually finish after its replacement. Do not let
      // that old payload overwrite the current slot cache or remove the new task.
      if (polymarketPlanViewInflight.get(key)?.promise === inflight) {
        polymarketPlanViewCache.set(key, { at: Date.now(), payload });
        polymarketPlanViewInflight.delete(key);
        prunePolymarketPlanViewCache();
      }
      return payload;
    })
    .catch((error) => {
      if (polymarketPlanViewInflight.get(key)?.promise === inflight) {
        polymarketPlanViewInflight.delete(key);
      }
      throw error;
    });
  polymarketPlanViewInflight.set(key, { promise: inflight, startedAtMs });
  return inflight;
}

async function buildPolymarketPaperPlanViewFresh(symbol = 'BTC-USD', timeframe = '15m', planId = 'plan1', options = {}) {
  const id = normalizePaperPlanId(planId);
  const recommendation = await buildPolymarketRecommendation(symbol, timeframe, id, options);
  const stats = polymarketTrading.computeStats(id);
  const timeframeStats = polymarketTrading.computeStats(id, timeframe);
  const lookbackDays = Number(config.polymarket?.symbolWrLookbackDays) || 30;
  const simpleSettlementPlan = id === 'plan3_5' || id === 'plan3_6';
  const symbolWinRates = !simpleSettlementPlan && typeof polymarketTrading.getSymbolWinRates === 'function'
    ? polymarketTrading.getSymbolWinRates(id, { lookbackDays })
    : (stats.bySymbol || {});
  const portfolio = options.portfolioOverride
    ? { ...options.portfolioOverride, symbolWinRates: options.portfolioOverride.symbolWinRates || symbolWinRates }
    : {
      ...polymarketTrading.snapshotPortfolio(id),
      equity: stats.equity,
      symbolWinRates
    };
  const tradingStats = {
    ...timeframeStats,
    bySymbol: timeframeStats.bySymbol || symbolWinRates
  };
  const generatedAt = new Date(recommendation.generatedAt || Date.now());
  const schedule = recommendation.signal?.schedule || getSlotSchedule(generatedAt, timeframe === '5m' ? 5 : 15);
  const elapsedPct = windowElapsedPct(schedule);
  const fiveMinuteLock = isPlan2Family(id)
    ? resolveFiveMinuteLockForPlan(symbol, generatedAt)
    : null;
  const fiveMinuteLockStats = isPlan2Family(id)
    ? await predictionRecorder.getFiveMinuteLockStrengthStats({
      lookbackDays: config.polymarket.plan2FiveMinuteLockStatsLookbackDays,
      symbol
    })
    : null;
  const intervalPmLock = id === 'plan5'
    ? resolveIntervalPmLockForPlan(symbol, timeframe, generatedAt)
    : null;
  let plan5LockStrengthStats = null;
  if (id === 'plan5') {
    const recentDays = Number(config.polymarket.plan5HistoryLookbackDays) || 14;
    const longTermDays = Math.max(
      recentDays,
      Number(config.polymarket.plan5LongTermLookbackDays) || 3650
    );
    const [recentStats, longTermStats] = await Promise.all([
      predictionRecorder.getLockStrengthStats({
        timeframe,
        lookbackDays: recentDays,
        symbol,
        preferSqlite: true
      }),
      predictionRecorder.getLockStrengthStats({
        timeframe,
        lookbackDays: longTermDays,
        symbol,
        preferSqlite: true
      })
    ]);
    plan5LockStrengthStats = blendPlan5LockStrengthStats(
      recentStats,
      longTermStats,
      config.polymarket
    );
  }
  let plan5NextSlotPrediction = null;
  let plan5IncomingNextSlotPrediction = null;
  let plan5NextSlotSummary = null;
  let plan5NextSlotMarketSentiment = null;
  let plan5OpenOrders = null;
  if (id === 'plan5') {
    plan5NextSlotPrediction = predictionRecorder.getActiveNextSlotPrediction({
      currentSlotIso: schedule.currentSlotIso,
      timeframe,
      symbol
    });
    plan5IncomingNextSlotPrediction = predictionRecorder.getIncomingNextSlotPrediction({
      currentSlotIso: schedule.currentSlotIso,
      timeframe,
      symbol
    });
    plan5NextSlotSummary = predictionRecorder.getNextSlotPredictionSummary({
      lookbackDays: Number(config.polymarket.plan5HistoryLookbackDays) || 14,
      symbol,
      timeframe
    });
    if (options.pendingDelayedEntrySource === 'live') {
      plan5OpenOrders = (polymarketTrading.state.liveOrders || []).filter((order) => {
        if (polymarketTrading.normalizePlanId(order.planId || 'plan1') !== 'plan5') return false;
        if (order.orderSide === 'SELL') return false;
        if (order.positionStatus === 'open' || order.positionStatus === 'pending') return true;
        const status = String(order.status || '').toLowerCase();
        const exitStatus = String(order.exitStatus || '').toLowerCase();
        return status === 'blocked' || status === 'pending' || exitStatus === 'expired-unfilled';
      });
    } else {
      plan5OpenOrders = (polymarketTrading.getBucket('plan5').paperOrders || [])
        .filter((order) => order.settlementStatus === 'open' || order.settlementStatus === 'pending');
    }
    // 开盘前：尝试解析下一窗市场（slug 可指向未来 slot；不可交易则 plan 内说明）
    if (config.polymarket.plan5PreOpenEnabled !== false && schedule.nextSlotIso) {
      try {
        plan5NextSlotMarketSentiment = await attachPolymarketTarget(await buildPolymarketSentiment({
          symbol,
          targetTimeIso: schedule.nextSlotIso,
          timeframe,
          client: polymarketClient,
          btcPrice: null,
          elapsedPct: 0,
          now: generatedAt
        }), {
          symbol,
          timeframe,
          schedule: {
            ...schedule,
            currentSlotIso: schedule.nextSlotIso,
            nextSlotIso: new Date(Date.parse(schedule.nextSlotIso) + (timeframe === '15m' ? 15 : 5) * 60_000).toISOString()
          },
          now: generatedAt
        });
      } catch (error) {
        plan5NextSlotMarketSentiment = {
          available: false,
          symbol,
          timeframe,
          reason: error.message || '下一窗市场查找失败'
        };
      }
    }
  }
  const sentiment = recommendation.polymarket?.available
    ? {
        ...recommendation.polymarket,
        windowTrack: compactWindowTrackForPlan(
          buildCurrentWindowTrackAnalysis(
            config.polymarket,
            new Date(recommendation.generatedAt || Date.now()),
            symbol
          )[timeframe]
        )
      }
    : recommendation.polymarket;
  const basketSentiments = id === 'plan1'
    ? await buildPlan1BasketSentiments({
      primarySymbol: symbol,
      timeframe,
      schedule,
      now: generatedAt,
      primarySentiment: sentiment
    })
    : undefined;
  if (recommendation.polymarket?.available) {
    recordPolymarketWindowSnapshot({
      schedule,
      timeframe,
      symbol,
      marketKey: recommendation.polymarket.marketSlug || recommendation.polymarket.conditionId,
      upPrice: recommendation.polymarket.upPrice,
      downPrice: recommendation.polymarket.downPrice,
      btcPrice: recommendation.signal?.indicators?.currentPrice ?? null,
      elapsedPct,
      now: new Date(recommendation.generatedAt || Date.now())
    });
  }
  // Must include planId: schedule writes `..._plan2_delay_plan2_5` / `_plan2_6`.
  // Bare `..._plan2_delay` never matches, so 2.5/2.6 delayed entries looked "missing".
  const delayedEntryKey = polymarketTrading.buildPlan2DelayedEntryKey(
    schedule.currentSlotIso,
    timeframe,
    symbol,
    isPlan2Family(id) ? id : null
  );
  let pendingDelayedEntry = null;
  if (isPlan2Family(id)) {
    if (options.pendingDelayedEntrySource === 'live') {
      pendingDelayedEntry = polymarketTrading.getLivePendingDelayedEntry(delayedEntryKey);
    } else {
      pendingDelayedEntry = polymarketTrading.getPendingDelayedEntry(id, delayedEntryKey);
    }
  }
  const planBuilder = id === 'plan14'
    ? buildPolymarketPaperPlan14
    : id === 'plan11'
      ? buildPolymarketPaperPlan11
    : id === 'plan5'
    ? buildPolymarketPaperPlan5
    : id === 'plan3_6'
      ? buildPolymarketPaperPlan3_6
        : id === 'plan3'
          ? buildPolymarketPaperPlan3
          : (isPlan2Family(id) ? buildPolymarketPaperPlan2 : buildPolymarketPaperPlan);
  const usesHistoricalDecisionInputs = !simpleSettlementPlan;
  const calibrationTable = usesHistoricalDecisionInputs
    ? polymarketTrading.computeConfidenceCalibrationTable()
    : null;
  const isLivePlanView = options.pendingDelayedEntrySource === 'live';
  const openExposureOrders = [];
  if (isLivePlanView) {
    for (const order of polymarketTrading.getOpenLivePositions()) {
      // Normalize so Plan1 hedge/exposure helpers that check settlementStatus work for live too.
      openExposureOrders.push({
        ...order,
        planId: order.planId || 'plan1',
        source: 'live',
        settlementStatus: order.settlementStatus || 'open'
      });
    }
  } else {
    for (const pid of PLAN_IDS) {
      for (const order of polymarketTrading.getBucket(pid).paperOrders || []) {
        if (order.settlementStatus === 'open' || order.settlementStatus === 'pending') {
          openExposureOrders.push({ ...order, planId: order.planId || pid, source: 'paper' });
        }
      }
    }
  }
  const plan3Bucket = polymarketTrading.getBucket('plan3');
  const planPortfolio = (id === 'plan3' || id === 'plan3_5' || id === 'plan3_6') && !options.portfolioOverride
    ? {
      ...polymarketTrading.snapshotPortfolio(id),
      equity: stats.equity
    }
    : portfolio;
  const plan3SubmittedKeys = id === 'plan3'
    ? (isLivePlanView ? new Set() : polymarketTrading.getPlan3SubmittedKeys('plan3'))
    : undefined;
  const planConfig = id === 'plan3'
    ? {
      ...config.polymarket,
      plan3DailyLossLimitEnabled: false
    }
    : config.polymarket;
  const paperUsesProductionRules = config.polymarket.paperLiveParityEnabled !== false;
  const plan14Inputs = id === 'plan14' && !isLivePlanView
    ? await resolvePlan14EntryInputs({ signal: recommendation.signal, sentiment, timeframe })
    : null;
  const plan = planBuilder({
    signal: plan14Inputs?.signal || recommendation.signal,
    recommendation,
    sentiment,
    config: planConfig,
    risk: recommendation.risk,
    tradingStats,
    timeframe,
    portfolio: planPortfolio,
    pendingDelayedEntry,
    calibrationTable,
    fiveMinuteLock,
    fiveMinuteLockStats,
    intervalPmLock,
    lockStrengthStats: id === 'plan5' ? plan5LockStrengthStats : undefined,
    nextSlotPrediction: id === 'plan5' ? plan5NextSlotPrediction : undefined,
    incomingNextSlotPrediction: id === 'plan5' ? plan5IncomingNextSlotPrediction : undefined,
    nextSlotPredictionSummary: id === 'plan5' ? plan5NextSlotSummary : undefined,
    nextSlotMarketSentiment: id === 'plan5' ? plan5NextSlotMarketSentiment : undefined,
    openPlan5Orders: id === 'plan5' ? plan5OpenOrders : undefined,
    statsDb: id === 'plan5' ? statsDb : undefined,
    plan14Book: plan14Inputs?.book || undefined,
    plan14Orders: id === 'plan14' ? (polymarketTrading.getBucket('plan14').paperOrders || []) : undefined,
    lossReasonOrders: usesHistoricalDecisionInputs
      ? polymarketTrading.getLossReasonOrders({
        planId: id,
        lookbackDays: Number(config.polymarket?.lossReasonGateLookbackDays) || 14,
        // A strategy must not change its judgment merely because the order
        // transport is paper or live. Use the same combined evidence set.
        source: paperUsesProductionRules ? 'all' : (isLivePlanView ? 'live' : 'paper')
      })
      : undefined,
    basketSentiments,
    crossSymbolLeader: isPlan2Family(id) ? options.crossSymbolLeader || null : undefined,
    openExposureOrders: id === 'plan3' || id === 'plan1' ? openExposureOrders : undefined,
    plan3Daily: id === 'plan3' ? plan3Bucket.plan3Daily : undefined,
    alreadySubmittedKeys: plan3SubmittedKeys,
    plan3BandStats: id === 'plan3'
      ? polymarketTrading.getPlan3BandStats(paperUsesProductionRules
        ? { source: 'all' }
        : { preferLive: isLivePlanView })
      : undefined,
    // Plan3.5/3.6/Plan12 用 paperMode 区分「纸面可跑 / 实盘需 LIVE_ENABLED」。
    // 全局 paperLiveParity 不能把这些纸面 tick 也打成 paperMode=false，否则会误跳 live_disabled。
    // Plan11 跟 Plan1 一样走生产入场规则（仓位、$5 下限、硬 SL），避免模拟仓和实盘各跑一套。
    paperMode: (id === 'plan12' || id === 'plan14')
      ? !isLivePlanView
      : (id === 'plan3_5' || id === 'plan3_6')
      ? !isLivePlanView
      : (paperUsesProductionRules
        ? false
        : (isPlan2Family(id)
          ? resolvePlan2PaperMode(planConfig, { paperMode: !isLivePlanView })
          : !isLivePlanView)),
    paperExperiment: (id === 'plan3_5' || id === 'plan3_6')
      ? !isLivePlanView
      : (paperUsesProductionRules ? false : !isLivePlanView),
    planId: isPlan2Family(id) ? id : undefined,
    now: generatedAt
  });
  const planStatus = polymarketTrading.statusForPlan(id);
  // 开盘前单：执行时必须用下一窗市场的 token/价格，而不是当前窗
  const execSentiment = id === 'plan5' && plan?.action?.preOpen && plan5NextSlotMarketSentiment?.available
    ? plan5NextSlotMarketSentiment
    : sentiment;
  return {
    ...recommendation,
    planId: id,
    polymarket: execSentiment,
    plan,
    auto: compactAutoForApi(planStatus.auto),
    portfolio,
    stats: polymarketTrading.computeStats(id),
    currentSizing: planStatus.currentSizing
  };
}

async function buildPolymarketPaperPlansView(symbol = 'BTC-USD', planId = 'plan1') {
  const id = normalizePaperPlanId(planId);
  const status = polymarketTrading.status();
  if (id === 'plan3_6') {
    const [fiveMinute, fifteenMinute, oneHour, oneDay] = await Promise.all([
      buildPolymarketPaperPlanView(symbol, '5m', id, { cacheMaxAgeMs: 20_000 }),
      buildPolymarketPaperPlanView(symbol, '15m', id, { cacheMaxAgeMs: 20_000 }),
      buildPolymarketPaperPlanView(symbol, '1h', id, { cacheMaxAgeMs: 30_000 }),
      buildPolymarketPaperPlanView(symbol, '1d', id, { cacheMaxAgeMs: 60_000 })
    ]);
    return {
      symbol,
      planId: id,
      generatedAt: new Date().toISOString(),
      plans: {
        '5m': fiveMinute,
        '15m': fifteenMinute,
        '1h': oneHour,
        '1d': oneDay
      },
      auto: compactAutoForApi(status.plans[id].auto),
      portfolio: polymarketTrading.snapshotPortfolio(id),
      stats: polymarketTrading.computeStats(id),
      currentSizing: status.plans[id].currentSizing,
      comparison: status.comparison,
      plan2Rules: status.plan2Rules,
      plan1Rules: status.plan1Rules,
      plan11Rules: status.plan11Rules,
      plan12Rules: status.plan12Rules,
      plan13Rules: status.plan13Rules,
      plan14Rules: status.plan14Rules,
      plan2_6Rules: status.plan2_6Rules,
      plan3Rules: status.plan3Rules,
      plan3_5Rules: status.plan3_5Rules,
      plan3_6Rules: status.plan3_6Rules,
      plan5Rules: status.plan5Rules
    };
  }
  const [fiveMinute, fifteenMinute] = await Promise.all([
    buildPolymarketPaperPlanView(symbol, '5m', id, { cacheMaxAgeMs: 20_000 }),
    buildPolymarketPaperPlanView(symbol, '15m', id, { cacheMaxAgeMs: 20_000 })
  ]);
  return {
    symbol,
    planId: id,
    generatedAt: new Date().toISOString(),
    plans: {
      '5m': fiveMinute,
      '15m': fifteenMinute
    },
    auto: compactAutoForApi(status.plans[id].auto),
    portfolio: polymarketTrading.snapshotPortfolio(id),
    stats: polymarketTrading.computeStats(id),
    currentSizing: status.plans[id].currentSizing,
    comparison: status.comparison,
    plan2Rules: status.plan2Rules,
    plan1Rules: status.plan1Rules,
    plan11Rules: status.plan11Rules,
    plan12Rules: status.plan12Rules,
    plan13Rules: status.plan13Rules,
    plan14Rules: status.plan14Rules,
    plan2_6Rules: status.plan2_6Rules,
    plan3Rules: status.plan3Rules,
    plan3_5Rules: status.plan3_5Rules,
    plan3_6Rules: status.plan3_6Rules,
    plan5Rules: status.plan5Rules
  };
}

async function buildPolymarketPaperCompareView(symbol = 'BTC-USD') {
  const status = polymarketTrading.status();
  const [plan1Plans, plan2Plans] = await Promise.all([
    buildPolymarketPaperPlansView(symbol, 'plan1'),
    buildPolymarketPaperPlansView(symbol, 'plan2')
  ]);
  return {
    symbol,
    generatedAt: new Date().toISOString(),
    comparison: status.comparison,
    plan2Rules: status.plan2Rules,
    plan1: {
      ...status.plans.plan1,
      plans: plan1Plans.plans
    },
    plan2: {
      ...status.plans.plan2,
      plans: plan2Plans.plans
    }
  };
}

const polymarketMarketSignalCache = new Map();
const polymarketMarketSignalInflight = new Map();

async function buildPlan5PolymarketOnlySignal(
  symbol,
  timeframe = '5m',
  now = new Date(),
  { preferLastGood = false } = {}
) {
  const slotMinutes = timeframeToSlotMinutes(timeframe);
  const schedule = getSlotSchedule(now, slotMinutes);
  let sentiment;
  const normalizedTimeframe = timeframe === '5m' ? '5m' : '15m';
  const lastGoodKey = `${symbol}|${normalizedTimeframe}|${schedule.nextSlotIso}`;
  const lastGood = preferLastGood ? polymarketSentimentLastGoodMap.get(lastGoodKey) : null;
  if (lastGood?.available) {
    // The lock page already resolved this exact market, including its token IDs.
    // Reuse it for view construction; executeLiveOrder refreshes the selected
    // token's executable price immediately before placing the FAK order.
    sentiment = {
      ...lastGood,
      reusedLastGood: true,
      reusedForLiveExecution: true
    };
  } else try {
    sentiment = await withDeadline(buildPolymarketSentiment({
      symbol,
      targetTimeIso: schedule.nextSlotIso,
      timeframe,
      client: polymarketClient,
      btcPrice: null,
      elapsedPct: windowElapsedPct(schedule),
      now,
      lightweight: true
    }), 7_000, `${symbol} ${timeframe} Plan5 PM signal`);
  } catch (error) {
    return buildUnavailablePolymarketSignal(symbol, timeframe, now, error.message);
  }
  if (!sentiment?.available) {
    return {
      ...buildUnavailablePolymarketSignal(
        symbol,
        timeframe,
        now,
        sentiment?.reason || 'Polymarket market unavailable'
      ),
      polymarket: sentiment
    };
  }
  const upProbability = Number(sentiment.upProbability ?? sentiment.upPrice);
  const downProbability = Number(sentiment.downProbability ?? sentiment.downPrice);
  const direction = upProbability >= downProbability ? 'up' : 'down';
  const confidence = Math.max(upProbability, downProbability);
  return {
    symbol,
    timeframe,
    direction,
    label: direction === 'up' ? 'UP' : 'DOWN',
    confidence,
    probabilities: { up: upProbability, down: downProbability },
    reason: 'Plan5 Polymarket-only lock signal',
    schedule,
    prediction: {
      targetTimeIso: schedule.nextSlotIso,
      comparisonBasePrice: Number(sentiment.targetPrice) || 0,
      estimatedClose: Number(sentiment.targetPrice) || 0,
      estimatedMovePct: 0,
      upProbability,
      downProbability
    },
    indicators: {
      elapsedInCurrentSlotPct: windowElapsedPct(schedule),
      currentPrice: null
    },
    techDirection: null,
    techConfidence: null,
    compositeDirection: direction,
    compositeConfidence: confidence,
    polymarket: sentiment
  };
}

function readSharedIntervalMarketSignal(symbol, timeframe, now = new Date()) {
  const listKey = timeframe === '5m' ? 'signals5m' : 'signals';
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const expectedSlotIso = getSlotSchedule(now, timeframeToSlotMinutes(timeframe)).currentSlotIso;
  let newest = null;
  for (const entry of intervalSignalsCacheMap.values()) {
    if (!entry?.payload || nowMs - entry.at > 15_000) continue;
    const signal = (entry.payload[listKey] || []).find((item) => item.symbol === symbol);
    if (!signal || signal.schedule?.currentSlotIso !== expectedSlotIso) continue;
    if (!newest || entry.at > newest.at) newest = { at: entry.at, signal };
  }
  return newest?.signal || null;
}

function marketSignalCacheMatchesSlot(entry, timeframe, now = new Date()) {
  if (!entry?.payload) return false;
  const slotMinutes = timeframeToSlotMinutes(timeframe);
  const expected = getSlotSchedule(now, slotMinutes).currentSlotIso;
  return entry.payload.schedule?.currentSlotIso === expected;
}

/**
 * Shared market-signal builder.
 * Plan1 paper/auto and UI reuse the 4s / intervalCaches to avoid hammering Binance+PM.
 * Plan4/Plan9 trading ticks pass { bypassCache: true } so Plan1 traffic cannot starve
 * their slot-local freshness (TTL constants are unchanged; only reuse is skipped).
 */
async function buildPolymarketMarketSignal(symbol, timeframe = '15m', now = new Date(), options = {}) {
  const normalizedSymbol = String(symbol || 'BTC-USD').toUpperCase();
  const key = `${normalizedSymbol}:${timeframe}`;
  const { bypassCache, maxAgeMs } = resolveMarketSignalCachePolicy(options);
  // The prediction/win-rate poller already refreshes all four symbols together.
  // Reuse that exact snapshot so paper, live and the lock page cannot each start
  // their own K-line/quote/Polymarket request for the same tick.
  if (!bypassCache) {
    const sharedSignal = readSharedIntervalMarketSignal(normalizedSymbol, timeframe, now);
    if (sharedSignal) return sharedSignal;
  }
  const cached = polymarketMarketSignalCache.get(key);
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  if (shouldReuseCachedMarketSignal(cached, {
    nowMs,
    maxAgeMs,
    bypassCache,
    slotMatches: marketSignalCacheMatchesSlot(cached, timeframe, now)
  })) {
    return cached.payload;
  }
  const active = polymarketMarketSignalInflight.get(key);
  if (active) {
    try {
      return await withDeadline(active, 8_000, `${key} shared market signal`);
    } catch (error) {
      if (cached && marketSignalCacheMatchesSlot(cached, timeframe, now) && nowMs - cached.at < 15_000) {
        return { ...cached.payload, staleMarketSignal: true, marketSignalRefreshError: error.message };
      }
      throw error;
    }
  }

  let task;
  task = buildPolymarketMarketSignalFresh(normalizedSymbol, timeframe, now)
    .then((payload) => {
      polymarketMarketSignalCache.set(key, { at: Date.now(), payload });
      return payload;
    })
    .finally(() => {
      if (polymarketMarketSignalInflight.get(key) === task) {
        polymarketMarketSignalInflight.delete(key);
      }
    });
  polymarketMarketSignalInflight.set(key, task);
  try {
    return await withDeadline(task, 8_000, `${key} market signal refresh`);
  } catch (error) {
    if (polymarketMarketSignalInflight.get(key) === task) {
      polymarketMarketSignalInflight.delete(key);
    }
    if (cached && marketSignalCacheMatchesSlot(cached, timeframe, now) && nowMs - cached.at < 15_000) {
      return { ...cached.payload, staleMarketSignal: true, marketSignalRefreshError: error.message };
    }
    throw error;
  }
}

async function buildPolymarketMarketSignalFresh(symbol, timeframe = '15m', now = new Date()) {
  const slotMinutes = timeframeToSlotMinutes(timeframe);
  const schedule = getSlotSchedule(now, slotMinutes);
  const candleInterval = timeframeToCandleInterval(timeframe);
  const candleLimit = timeframe === '5m' ? 80 : (timeframe === '1h' || timeframe === '1d' ? 90 : 60);
  // These sources are independent. Serial waits made one decision take the sum
  // of every network delay and caused live scans to miss their own windows.
  const candlesPromise = withDeadline(
    publicMarket.getCandles(symbol, candleInterval, candleLimit),
    6_000,
    `${symbol} ${timeframe} candles`
  );
  const quotesPromise = withDeadline(
    fetchMarketQuotes([symbol], { allowMockFallback: false }),
    6_000,
    `${symbol} quote`
  );
  const sentimentPromise = withDeadline(attachPolymarketTarget(buildPolymarketSentiment({
    symbol,
    targetTimeIso: schedule.nextSlotIso,
    timeframe,
    client: polymarketClient,
    btcPrice: null,
    elapsedPct: windowElapsedPct(schedule),
    now
  }), {
    symbol,
    timeframe,
    schedule,
    now
  }), 7_000, `${symbol} ${timeframe} Polymarket sentiment`).then(
    (sentiment) => ({ sentiment, error: null }),
    (error) => ({ sentiment: null, error })
  );
  let candles;
  let quotes;
  try {
    [candles, quotes] = await Promise.all([candlesPromise, quotesPromise]);
  } catch (error) {
    return buildUnavailablePolymarketSignal(symbol, timeframe, now, error.message);
  }
  const quote = quotes.find((item) => item.symbol === symbol);
  const currentPrice = quotePrice(quote);
  const currentQuoteTime = quote?.timestamp || null;

  const signal = buildPolymarketIntervalSignal({
    symbol,
    candles,
    currentPrice,
    currentQuoteTime,
    timeframe,
    now
  });

  try {
    const sentimentResult = await sentimentPromise;
    if (sentimentResult.error) throw sentimentResult.error;
    const sentiment = sentimentResult.sentiment;
    if (config.polymarket.blendEnabled && sentiment.available) {
      return blendWithPolymarketSentiment(signal, sentiment);
    }
    return { ...signal, polymarket: sentiment };
  } catch (error) {
    return { ...signal, polymarket: { available: false, symbol, timeframe, reason: error.message } };
  }
}

function buildUnavailablePolymarketSignal(symbol, timeframe, now, reason) {
  return {
    symbol,
    timeframe,
    direction: 'wait',
    label: '等待',
    confidence: 0,
    probabilities: { up: 0, down: 0 },
    reason: `真实行情源不可用，本轮暂停判断：${reason}`,
    schedule: getSlotSchedule(now, timeframeToSlotMinutes(timeframe)),
    prediction: null,
    indicators: null
  };
}

async function runPolymarketLiveAutoTickForPlans(planIds = [], { tickContext = null } = {}) {
  const auto = polymarketTrading.liveAutoStatus();
  if (!auto.enabled) {
    return { generatedAtIso: new Date().toISOString(), ticks: [], executed: false, auto };
  }
  const wanted = new Set((planIds || []).map((id) => normalizePaperPlanId(id)));
  const enabledPlans = (auto.enabledPlans?.length ? auto.enabledPlans : [auto.planId].filter(Boolean))
    .map((planId) => normalizePaperPlanId(planId))
    .filter((planId) => wanted.has(planId));
  // Run each plan independently so one slow plan cannot block the others.
  const settled = await Promise.allSettled(
    enabledPlans.map((planId) => runPolymarketLiveAutoTickForSinglePlan(planId, auto, tickContext))
  );
  const allTicks = [];
  let balanceUsdc = 0;
  let ready = false;
  let closedOnly = false;
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      allTicks.push(...(result.value.ticks || []));
      if (Number.isFinite(result.value.balanceUsdc)) balanceUsdc = result.value.balanceUsdc;
      ready = ready || result.value.ready === true;
      closedOnly = closedOnly || result.value.closedOnly === true;
    } else {
      console.error(`Polymarket live plan tick failed: ${result.reason?.message || result.reason}`);
    }
  }
  return {
    generatedAtIso: new Date().toISOString(),
    ticks: allTicks,
    executed: allTicks.some((item) => item.executed),
    auto: polymarketTrading.liveAutoStatus(),
    balanceUsdc,
    ready,
    closedOnly
  };
}

function throwIfLivePlanTickCancelled(planId, tickContext) {
  if (!tickContext?.cancelled) return;
  throw new Error(
    `Plan ${planId} tick cancelled by watchdog at ${tickContext.cancelledStage || 'unknown stage'}`
  );
}

function throwIfPaperPlanTickCancelled(planId, tickContext) {
  if (!tickContext?.cancelled) return;
  throw new Error(
    `Paper plan ${planId} tick cancelled by watchdog at ${tickContext.cancelledStage || 'unknown stage'}`
  );
}

function setPaperPlanTickStage(planId, stage, tickContext = null) {
  polymarketPaperPlanLoopStages.set(normalizePaperPlanId(planId), {
    stage,
    tickId: tickContext?.tickId || null,
    atIso: new Date().toISOString()
  });
}

function setLivePlanTickStage(planId, stage) {
  polymarketLivePlanLoopStages.set(normalizePaperPlanId(planId), {
    stage,
    atIso: new Date().toISOString()
  });
}

function getOrStartTrackedTask(map, key, factory, { replaceAfterMs = Infinity, onReplace = null } = {}) {
  const existing = map.get(key);
  if (existing) {
    const ageMs = Math.max(0, Date.now() - existing.startedAtMs);
    if (Number.isFinite(replaceAfterMs) && ageMs >= replaceAfterMs) {
      // Abandon hung work so the next caller can start a fresh task. The old
      // promise may still finish in the background; cleanup only deletes if it
      // still owns the map slot.
      if (!existing.staleReported) {
        existing.staleReported = true;
        onReplace?.({ key, ageMs, existing });
      }
      if (map.get(key)?.promise === existing.promise) map.delete(key);
    } else {
      return {
        ...existing,
        started: false,
        ageMs
      };
    }
  }
  const startedAtMs = Date.now();
  const promise = Promise.resolve().then(factory);
  const entry = { promise, startedAtMs };
  map.set(key, entry);
  const cleanup = () => {
    if (map.get(key)?.promise === promise) map.delete(key);
  };
  // Attach both handlers immediately so a detached timed-out task cannot become
  // an unhandled rejection while it winds down in the background.
  promise.then(cleanup, cleanup);
  return { ...entry, started: true, ageMs: 0 };
}

async function runPolymarketLiveAutoTickForSinglePlan(planId, autoSnapshot = null, tickContext = null) {
  const auto = autoSnapshot || polymarketTrading.liveAutoStatus();
  setLivePlanTickStage(planId, 'readiness');
  const readiness = await getPolymarketReadiness();
  throwIfLivePlanTickCancelled(planId, tickContext);
  const balance = resolveReadinessBalanceUsdc(readiness);
  if (hasReadinessBalance(readiness)) {
    await polymarketTrading.updateLiveControlBalance(balance);
  }
  const closedOnly = readiness.clob?.closedOnly === true;
  const timeframes = auto.timeframes || ['5m', '15m'];
  const symbols = auto.symbols?.length ? auto.symbols : ['BTC-USD'];
  // Plan5 与纸面一致：只跑 5m，避免 live-auto 全局 timeframes 把 15m 也带进实盘。
  const loopTimeframes = planId === 'plan13'
    ? timeframes.filter((timeframe) => timeframe === '15m')
    : (planId === 'plan5' || planId === 'plan11')
    ? timeframes.filter((timeframe) => timeframe === '5m')
    : timeframes;
  // Plan1 币种以 plan1Symbols 为准（与配置收紧一致），再与 UI 勾选取交集。
  const loopSymbols = orderSymbolsLeaderFirst(
    planId === 'plan1'
      ? (() => {
        const allowed = new Set(plan1ScanSymbols());
        const selected = (symbols || []).filter((symbol) => allowed.has(String(symbol || '').toUpperCase()));
        return selected.length ? selected : [...allowed];
      })()
      : planId === 'plan5'
        ? plan5ScanSymbols(symbols)
        : symbols
  );
  const allTicks = [];
  const viewTimeoutMs = planId === 'plan5'
    ? Math.max(5_000, Number(config.polymarket.plan5LiveViewTimeoutMs) || 25_000)
    : Math.max(10_000, Number(config.polymarket.livePlanViewTimeoutMs) || 30_000);
  const liveViewOptions = {
    portfolioOverride: polymarketTrading.livePortfolioSnapshot({ clobBalanceUsdc: balance }),
    pendingDelayedEntrySource: 'live',
    cacheMaxAgeMs: planId === 'plan5'
      ? Math.max(500, Number(config.polymarket.plan5LiveViewCacheMaxAgeMs) || 3_000)
      : (isPlan2Family(planId) || planId === 'plan11')
        ? Math.max(0, Number(config.polymarket.plan2LiveViewCacheMaxAgeMs) || 1_500)
        : 30_000
  };
  for (const timeframe of loopTimeframes) {
    let crossSymbolLeader = null;
    let independentViews = null;
    if (planId === 'plan1' || planId === 'plan5' || planId === 'plan11' || planId === 'plan13') {
      setLivePlanTickStage(planId, `views:${timeframe}`);
      const viewStaleReplaceMs = resolvePolymarketPlanViewStaleMs(planId);
      const settledViews = await Promise.allSettled(
        loopSymbols.map((symbol) => {
          const viewNow = new Date();
          const viewSchedule = getSlotSchedule(viewNow, timeframe === '5m' ? 5 : 15);
          const activeLock = planId === 'plan5'
            ? resolveIntervalPmLockForPlan(symbol, timeframe, viewNow)
            : null;
          const viewRevision = `${viewSchedule.currentSlotIso}:${activeLock?.lockedAtIso || 'prelock'}`;
          const viewKey = `${planId}:${timeframe}:${symbol}:${viewRevision}`;
          const symbolViewOptions = {
            ...liveViewOptions,
            cacheKeySuffix: viewRevision
          };
          const task = getOrStartTrackedTask(
            polymarketLiveViewInflightMap,
            viewKey,
            () => buildPolymarketPaperPlanView(
              symbol,
              timeframe,
              planId,
              symbolViewOptions
            ),
            {
              // Replace at the live view deadline so a single hung symbol cannot
              // block every subsequent Plan1 live tick for minutes.
              replaceAfterMs: Math.min(viewStaleReplaceMs, viewTimeoutMs),
              onReplace: ({ ageMs }) => console.error(
                `Polymarket ${planId} ${symbol} ${timeframe} replaced stale live view after ${ageMs}ms`
              )
            }
          );
          return withDeadline(
            task.promise,
            viewTimeoutMs,
            `${planId} ${symbol} ${timeframe} live view`
          ).then(
            (view) => ({ symbol, view }),
            (error) => {
              // Caller deadline expired: drop ownership so the next tick can rebuild
              // even if the abandoned promise is still draining network work.
              const current = polymarketLiveViewInflightMap.get(viewKey);
              if (current?.promise === task.promise) polymarketLiveViewInflightMap.delete(viewKey);
              throw error;
            }
          );
        })
      );
      throwIfLivePlanTickCancelled(planId, tickContext);
      independentViews = new Map();
      for (const result of settledViews) {
        if (result.status === 'fulfilled') {
          independentViews.set(result.value.symbol, result.value.view);
        } else {
          console.error(`Polymarket ${planId} live view failed: ${result.reason?.message || result.reason}`);
        }
      }
    }
    // Start every Plan5 symbol execution before awaiting any one of them. A slow
    // BTC CLOB call used to hold ETH/SOL/XRP behind it for 30-120 seconds even
    // though the four decisions and markets are independent.
    const prestartedIndependentExecutions = new Map();
    if ((planId === 'plan5' || planId === 'plan11') && independentViews) {
      for (const symbol of loopSymbols) {
        const view = independentViews.get(symbol);
        if (!view) continue;
        const executionKey = [
          planId,
          timeframe,
          symbol,
          view.plan?.slotIso || view.polymarket?.schedule?.currentSlotIso || 'current'
        ].join(':');
        const executionTimeoutMs = planId === 'plan11'
          ? Math.max(5_000, Number(config.polymarket.liveOrderExecutionTimeoutMs) || 15_000)
          : Math.max(
            5_000,
            Number(config.polymarket.plan5LiveOrderExecutionTimeoutMs) || 8_000
          );
        prestartedIndependentExecutions.set(symbol, {
          executionKey,
          executionTimeoutMs,
          executionTask: getOrStartTrackedTask(
            polymarketLiveExecutionInflightMap,
            executionKey,
            () => polymarketTrading.maybeLiveAutoExecute({
              planView: view,
              clobBalanceUsdc: balance,
              closedOnly,
              readinessReady: readiness.ready,
              resolveCurrentPrice: async (order) => resolvePlan2OrderPrice(order)
            }),
            {
              replaceAfterMs: executionTimeoutMs,
              onReplace: ({ ageMs }) => console.error(
                `Polymarket ${planId} ${symbol} ${timeframe} replaced stale live execution after ${ageMs}ms`
              )
            }
          )
        });
      }
    }
    for (const symbol of loopSymbols) {
      try {
        throwIfLivePlanTickCancelled(planId, tickContext);
        const view = independentViews
          ? independentViews.get(symbol)
          : await withDeadline(
            buildPolymarketPaperPlanView(symbol, timeframe, planId, {
              ...liveViewOptions,
              crossSymbolLeader: isPlan2Family(planId) && symbol !== 'BTC-USD' ? crossSymbolLeader : null
            }),
            viewTimeoutMs,
            `${planId} ${symbol} ${timeframe} live view`
          );
        if (!view) continue;
        if (isPlan2Family(planId) && symbol === 'BTC-USD') {
          crossSymbolLeader = extractCrossSymbolLeader(view, symbol);
        }
        setLivePlanTickStage(planId, `execute:${timeframe}:${symbol}`);
        const executionKey = [
          planId,
          timeframe,
          symbol,
          view.plan?.slotIso || view.polymarket?.schedule?.currentSlotIso || 'current'
        ].join(':');
        const executionTimeoutMs = planId === 'plan5' || planId === 'plan11'
          ? Math.max(5_000, Number(
            planId === 'plan5'
              ? config.polymarket.plan5LiveOrderExecutionTimeoutMs
              : config.polymarket.liveOrderExecutionTimeoutMs
          ) || (planId === 'plan5' ? 8_000 : 15_000))
          : Math.max(10_000, Number(config.polymarket.liveOrderExecutionTimeoutMs) || 30_000);
        const prestarted = prestartedIndependentExecutions.get(symbol);
        const executionTask = prestarted?.executionTask || getOrStartTrackedTask(
          polymarketLiveExecutionInflightMap,
          executionKey,
          () => polymarketTrading.maybeLiveAutoExecute({
            planView: view,
            clobBalanceUsdc: balance,
            closedOnly,
            readinessReady: readiness.ready,
            resolveCurrentPrice: async (order) => resolvePlan2OrderPrice(order)
          }),
          {
            replaceAfterMs: executionTimeoutMs,
            onReplace: ({ ageMs }) => console.error(
              `Polymarket ${planId} ${symbol} ${timeframe} replaced stale live execution after ${ageMs}ms`
            )
          }
        );
        let result;
        if (executionTask.started) {
          try {
            result = await withDeadline(
              executionTask.promise,
              executionTimeoutMs,
              `${planId} ${symbol} ${timeframe} live execution`
            );
          } catch (error) {
            // 与 view 路径一致：deadline 到期立刻释放 inflight，避免后续 tick 被跳过。
            const current = polymarketLiveExecutionInflightMap.get(executionKey);
            if (current?.promise === executionTask.promise) {
              polymarketLiveExecutionInflightMap.delete(executionKey);
            }
            throw error;
          }
        } else {
          result = {
            executed: false,
            reason: `${symbol} ${timeframe} 上一笔执行仍在后台结束，本轮跳过以避免重复下单。`
          };
        }
        throwIfLivePlanTickCancelled(planId, tickContext);
        // When Plan1/Plan5/Plan11 live is enabled, this live-built view is the canonical decision.
        // Always feed the exact same view to the paper control so direction and entry
        // timing cannot drift between two independently refreshed market snapshots.
        if (planId === 'plan1' || planId === 'plan5' || planId === 'plan11' || planId === 'plan13') {
          const shadow = await polymarketTrading.maybeAutoExecute({
            plan: view.plan,
            sentiment: view.polymarket,
            recommendation: view.recommendation,
            planId,
            resolveCurrentPrice: async (order) => resolvePlan2OrderPrice(order)
          });
          if (shadow?.order) {
            const shadowMetadata = {
              shadowLiveOrderId: result.record?.id || null,
              shadowKind: 'live-signal-control',
              shadowLiveExecuted: result.executed === true,
              shadowLiveReason: result.reason || null
            };
            Object.assign(shadow.order, shadowMetadata);
            // createPaperOrderFromPlan stores a slim copy, so update that persisted
            // record as well instead of only mutating the returned full order.
            const storedShadow = (polymarketTrading.getBucket(planId).paperOrders || [])
              .find((order) => order.id === shadow.order.id);
            if (storedShadow) Object.assign(storedShadow, shadowMetadata);
            await polymarketTrading.persist(planId);
          }
        }
        allTicks.push({
          planId,
          symbol,
          timeframe: view.plan?.timeframe || timeframe,
          generatedAtIso: new Date().toISOString(),
          plan: view.plan,
          ...result
        });
      } catch (error) {
        // 单币种失败不中断同 plan 其它币种（例如 ETH 行情/市场拉取失败不应堵死 BTC/SOL/XRP）
        console.error(`Polymarket live ${planId} ${symbol} ${timeframe} tick failed: ${error.message}`);
        allTicks.push({
          planId,
          symbol,
          timeframe,
          generatedAtIso: new Date().toISOString(),
          executed: false,
          reason: error.message,
          error: error.message
        });
        try {
          await polymarketTrading.updateLiveAutoRun({
            lastAction: 'error',
            lastReason: `${symbol} ${timeframe}: ${error.message}`,
            lastError: error.message
          }, planId);
        } catch {
          // ignore secondary persist errors
        }
      }
    }
  }
  setLivePlanTickStage(planId, 'complete');
  return {
    ticks: allTicks,
    balanceUsdc: balance,
    ready: readiness.ready,
    closedOnly
  };
}

async function runPolymarketLiveAutoTick() {
  const auto = polymarketTrading.liveAutoStatus();
  // plan3_5/plan3_6 有独立快循环，避免被多币种主 tick 饿死。
  const planIds = (auto.enabledPlans?.length ? auto.enabledPlans : [auto.planId].filter(Boolean))
    .map((planId) => normalizePaperPlanId(planId))
    .filter((planId) => !['plan3_5', 'plan3_6'].includes(planId));
  return runPolymarketLiveAutoTickForPlans(planIds);
}

function logPolymarketLiveAutoTicks(ticks = []) {
  for (const tick of ticks || []) {
    if (!tick.executed) continue;
    const record = tick.record || {};
    console.log(`Polymarket live auto ${tick.planId} ${tick.timeframe}: ${record.outcome || '--'} $${record.usd} (${record.clobOrderId || 'no id'})`);
  }
}

async function runPolymarketLiveAutoLoop() {
  if (!polymarketTrading.liveAutoStatus().enabled) return;
  if (!config.polymarket.liveTradingEnabled) return;
  const auto = polymarketTrading.liveAutoStatus();
  const enabledCore = POLYMARKET_LIVE_CORE_PLAN_IDS.filter((id) => (
    (auto.enabledPlans || []).map(normalizePaperPlanId).includes(id)
  ));
  if (!enabledCore.length) return;
  const planId = enabledCore[polymarketLiveCoreRoundRobinIndex % enabledCore.length];
  polymarketLiveCoreRoundRobinIndex += 1;
  scheduleIsolatedLivePlanTick(planId);
}

function scheduleIsolatedLivePlanTick(planId) {
  const id = normalizePaperPlanId(planId);
  if (polymarketLivePlanLoopsRunning.has(id)) return;
  polymarketLivePlanLoopsRunning.add(id);
  const tickContext = {
    cancelled: false,
    cancelledStage: null,
    startedAtIso: new Date().toISOString()
  };
  // 防止单次 tick 因磁盘/网络挂起永久占锁，导致 enabled 却数小时不跑。
  const lockTimeoutMs = Math.max(
    30_000,
    id === 'plan5'
      ? Number(config.polymarket?.plan5LiveTickTimeoutMs) || 90_000
      : Number(config.polymarket?.livePlanTickLockTimeoutMs) || 180_000
  );
  let settled = false;
  const releaseLock = (reason = null) => {
    if (settled) return;
    settled = true;
    polymarketLivePlanLoopsRunning.delete(id);
    if (reason) {
      console.error(`Polymarket live ${id} auto tick lock released: ${reason}`);
    }
  };
  const lockTimer = setTimeout(() => {
    const stage = polymarketLivePlanLoopStages.get(id)?.stage || 'unknown';
    tickContext.cancelled = true;
    tickContext.cancelledStage = stage;
    releaseLock(`watchdog exceeded ${lockTimeoutMs}ms at ${stage}; old tick cancelled`);
    polymarketTrading.updateLiveAutoRun({
      lastAction: 'error',
      lastReason: `${id} 单轮超过 ${Math.ceil(lockTimeoutMs / 1000)} 秒，已在 ${stage} 阶段终止并进入下一轮。`,
      lastError: `tick watchdog timeout at ${stage}`
    }, id).catch(() => {});
  }, lockTimeoutMs);
  setImmediate(() => {
    runPolymarketLiveAutoTickForPlans([id], { tickContext })
      .then(async (result) => {
        logPolymarketLiveAutoTicks(result.ticks);
        if (result.ticks?.some((tick) => tick.executed)) {
          await predictionRecorder.refreshDailyMarkdown(new Date());
        }
      })
      .catch(async (error) => {
        console.error(`Polymarket live ${id} auto tick failed: ${error.message}`);
        try {
          await polymarketTrading.updateLiveAutoRun({
            lastAction: 'error',
            lastReason: error.message,
            lastError: error.message
          }, id);
        } catch {
          // ignore secondary persist errors
        }
      })
      .finally(() => {
        clearTimeout(lockTimer);
        releaseLock();
        if (polymarketLivePlanLoopStages.get(id)?.stage === 'complete' || !tickContext.cancelled) {
          polymarketLivePlanLoopStages.delete(id);
        }
      });
  });
}

async function runHourlyMonitorLoop({ force = false } = {}) {
  if (!config.hourlyMonitor.enabled) {
    return { skipped: true, reason: 'hourly monitor disabled' };
  }
  if (hourlyMonitorLoopRunning && !force) return lastHourlyMonitor;
  hourlyMonitorLoopRunning = true;
  try {
    const result = await runHourlyMonitor({
      polymarketTrading,
      buildReadiness: () => getPolymarketReadiness(),
      predictionRecorder,
      recordDir: config.hourlyMonitor.recordDir
    });
    lastHourlyMonitor = {
      generatedAtIso: result.snapshot.generatedAtIso,
      hourLabel: result.snapshot.shanghai.hourLabel,
      conclusions: result.snapshot.conclusions,
      hourFile: result.hourFile,
      latestFile: result.latestFile,
      paper: result.snapshot.paper,
      live: result.snapshot.live,
      readiness: result.snapshot.readiness
    };
    console.log(`Hourly monitor ${result.snapshot.shanghai.hourLabel}: ${result.snapshot.conclusions[0] || 'ok'}`);
    return lastHourlyMonitor;
  } catch (error) {
    console.error(`Hourly monitor failed: ${error.message}`);
    lastHourlyMonitor = {
      generatedAtIso: new Date().toISOString(),
      error: error.message
    };
    return lastHourlyMonitor;
  } finally {
    hourlyMonitorLoopRunning = false;
  }
}

async function runPolymarketAutoTick(planId = null, { tickContext = null } = {}) {
  // 高频计划由各自专用循环负责，避免同一计划被两套循环重复扫描和落盘。
  const planIds = planId
    ? [normalizePaperPlanId(planId)]
    : PLAN_IDS.filter((id) => !['plan3', 'plan3_5', 'plan3_6'].includes(id));
  return runPolymarketAutoTickForPlans(planIds, { tickContext });
}

async function runPolymarketAutoTickForPlans(planIds = [], { tickContext = null } = {}) {
  const settled = await Promise.allSettled(
    (planIds || []).map((rawId) => runPolymarketAutoTickForSinglePlan(rawId, { tickContext }))
  );
  const allTicks = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      allTicks.push(...(result.value || []));
    } else {
      console.error(`Polymarket paper plan tick failed: ${result.reason?.message || result.reason}`);
    }
  }
  const status = polymarketTrading.status();
  if (allTicks.some((item) => item.executed)) {
    void predictionRecorder.refreshDailyMarkdown(new Date()).catch((error) => {
      console.error(`Polymarket markdown sync after auto tick failed: ${error.message}`);
    });
  }
  return {
    generatedAtIso: new Date().toISOString(),
    ticks: allTicks,
    executed: allTicks.some((item) => item.executed),
    plans: status.plans,
    comparison: status.comparison
  };
}

async function runPolymarketAutoTickForSinglePlan(rawId, { tickContext = null } = {}) {
  const id = normalizePaperPlanId(rawId);
  if (['plan15', 'plan16', 'plan17', 'plan18', 'plan19'].includes(id)) return [];
  if (id === 'plan14' && config.polymarket.plan14NewEntriesEnabled !== true) return [];
  const bucket = polymarketTrading.status(id);
  if (!bucket.auto.enabled) return [];
  // Plan1/Plan5/Plan11 live owns the canonical decision while enabled. The live
  // loop writes the paired paper control from the same plan view, so this
  // independent paper loop must not consume the window first with a separately
  // refreshed snapshot.
  if (
    (id === 'plan1' || id === 'plan5' || id === 'plan11' || id === 'plan13')
    && polymarketTrading.liveAutoStatus().enabledPlans.includes(id)
  ) {
    return [];
  }
  const configuredTimeframes = bucket.auto.timeframes || ['5m', '15m'];
  const timeframes = (
    (id === 'plan3' && config.polymarket.plan3Paper15mEnabled !== true)
    || id === 'plan5'
  )
    ? configuredTimeframes.filter((timeframe) => timeframe === '5m')
    : configuredTimeframes;
  const symbols = resolvePaperAutoSymbols(id, bucket.auto);
  const allTicks = [];
  for (const timeframe of timeframes) {
    let crossSymbolLeader = null;
    const views = [];
    if (id === 'plan1' || id === 'plan5' || id === 'plan13' || id === 'plan14') {
      setPaperPlanTickStage(id, `views:${timeframe}`, tickContext);
      const viewTimeoutMs = id === 'plan5'
        ? Math.max(5_000, Number(config.polymarket.plan5LiveViewTimeoutMs) || 25_000)
        : Math.max(10_000, Number(config.polymarket.livePlanViewTimeoutMs) || 30_000);
      const settledViews = await Promise.allSettled(symbols.map((symbol) => withDeadline(
        buildPolymarketPaperPlanView(symbol, timeframe, id),
        viewTimeoutMs,
        `${id} ${symbol} ${timeframe} paper view`
      ).then((view) => ({ symbol, view }))));
      throwIfPaperPlanTickCancelled(id, tickContext);
      for (const result of settledViews) {
        if (result.status === 'fulfilled') {
          views.push(result.value);
        } else {
          console.error(`Polymarket ${id} paper view failed: ${result.reason?.message || result.reason}`);
        }
      }
    } else {
      const viewTimeoutMs = Math.max(10_000, Number(config.polymarket.livePlanViewTimeoutMs) || 30_000);
      for (const symbol of symbols) {
        setPaperPlanTickStage(id, `view:${timeframe}:${symbol}`, tickContext);
        throwIfPaperPlanTickCancelled(id, tickContext);
        let view;
        try {
          view = await withDeadline(
            buildPolymarketPaperPlanView(symbol, timeframe, id, {
              crossSymbolLeader: isPlan2Family(id) && symbol !== 'BTC-USD' ? crossSymbolLeader : null
            }),
            viewTimeoutMs,
            `${id} ${symbol} ${timeframe} paper view`
          );
        } catch (error) {
          console.error(`Polymarket ${id} paper view failed: ${error.message}`);
          continue;
        }
        throwIfPaperPlanTickCancelled(id, tickContext);
        if (isPlan2Family(id) && symbol === 'BTC-USD') {
          crossSymbolLeader = extractCrossSymbolLeader(view, symbol);
        }
        views.push({ symbol, view });
      }
    }
    const executionViews = id === 'plan14' ? rankPlan14Views(views) : views;
    for (const { symbol, view } of executionViews) {
      throwIfPaperPlanTickCancelled(id, tickContext);
      setPaperPlanTickStage(id, `execute:${timeframe}:${symbol}`, tickContext);
      if (id === 'plan14') await polymarketTrading.recordPlan14Opportunity(view.plan, view.polymarket);
      const result = await polymarketTrading.maybeAutoExecute({
        plan: view.plan,
        sentiment: view.polymarket,
        recommendation: view.recommendation,
        planId: id,
        resolveCurrentPrice: async (order) => resolvePlan2OrderPrice(order)
      });
      throwIfPaperPlanTickCancelled(id, tickContext);
      // Plan2.5 入场同步：模拟盘已同窗下单时，立刻用同一决策视图驱动实盘，
      // 避免实盘独立慢扫/缓存错失尾盘与 90¢ 结算窗。
      let liveFollow = null;
      if (
        result?.executed
        && isPlan2Family(id)
        && view?.plan?.action?.shouldTrade
        && polymarketTrading.isPlan2EntrySyncedToPaperFor(id)
        && config.polymarket.liveTradingEnabled === true
        && polymarketTrading.liveAutoStatus().enabledPlans?.includes(id)
      ) {
        try {
          const readiness = await getPolymarketReadiness();
          const balance = resolveReadinessBalanceUsdc(readiness);
          const followTimeoutMs = Math.max(
            5_000,
            Number(config.polymarket.liveOrderExecutionTimeoutMs) || 15_000
          );
          liveFollow = await withDeadline(
            polymarketTrading.maybeLiveAutoExecute({
              planView: { ...view, planId: id },
              clobBalanceUsdc: balance,
              closedOnly: readiness.clob?.closedOnly === true,
              readinessReady: readiness.ready === true,
              resolveCurrentPrice: async (order) => resolvePlan2OrderPrice(order)
            }),
            followTimeoutMs,
            `${id} ${symbol} ${timeframe} paper-sync live follow`
          );
        } catch (error) {
          console.error(`Polymarket ${id} paper-sync live follow failed: ${error.message}`);
          liveFollow = { executed: false, reason: error.message, error: error.message };
        }
      }
      allTicks.push({
        planId: id,
        symbol,
        timeframe,
        generatedAtIso: new Date().toISOString(),
        plan: view.plan,
        ...result,
        ...(liveFollow ? { liveFollow } : {})
      });
    }
  }
  return allTicks;
}

// The shared poller's spot can be ~20s old; a fair-value model priced on it would just
// re-discover its own staleness. A single ticker request is cheap next to a CLOB book.
function plan14QuoteMs(value) {
  if (value == null || value === '') return NaN;
  const number = Number(value);
  if (Number.isFinite(number)) return number < 1e12 ? number * 1000 : number;
  return Date.parse(value);
}

async function withFreshPlan14Spot(signal, symbol) {
  const quoteMs = plan14QuoteMs(signal?.indicators?.currentQuoteTime);
  if (Number.isFinite(quoteMs) && Date.now() - quoteMs < 3_000) return signal;
  try {
    const quotes = await withDeadline(fetchMarketQuotes([symbol], { allowMockFallback: false }), 3_000, `${symbol} plan14 quote`);
    const quote = quotes.find((item) => item.symbol === symbol);
    const price = quotePrice(quote);
    if (!(price > 0) || !quote?.timestamp) return signal;
    return { ...signal, indicators: { ...signal.indicators, currentPrice: price, currentQuoteTime: quote.timestamp } };
  } catch {
    return signal;
  }
}

async function fetchPlan14Book(tokenId) {
  const book = normalizeOrderBook(await polymarketClient.getOrderBook(tokenId));
  return { bid: book.bestBid, ask: book.bestAsk, asks: book.asks, bookTimeMs: Date.now() };
}

/** Prescreen on cached quotes, then confirm on fresh spot + both CLOB books (only those cost traffic). */
async function resolvePlan14EntryInputs({ signal, sentiment, timeframe }) {
  if (!sentiment?.available || !sentiment.upTokenId || !sentiment.downTokenId || !signal) return { signal, book: null };
  const symbol = signal.symbol || sentiment.symbol;
  const freshSignal = await withFreshPlan14Spot(signal, symbol);
  const prescreen = evaluatePlan14Entry({ signal: freshSignal, sentiment, timeframe, config: config.polymarket });
  const baseline = evaluatePlan14Entry({ signal: freshSignal, sentiment, timeframe, config: config.polymarket,
    policyVersion: PLAN14_PREVIOUS_VERSION });
  const candidate = config.polymarket.plan14ProfitExperimentEnabled !== false
    ? evaluatePlan14Entry({ signal: freshSignal, sentiment, timeframe, config: config.polymarket,
      policyVersion: PLAN14_PROFIT_EXPERIMENT_VERSION }) : null;
  if (!prescreen.prescreen && !baseline.prescreen && !candidate?.prescreen) return { signal: freshSignal, book: null };
  try {
    const [up, down] = await Promise.all([
      withDeadline(fetchPlan14Book(sentiment.upTokenId), 3_000, `${symbol} plan14 up book`),
      withDeadline(fetchPlan14Book(sentiment.downTokenId), 3_000, `${symbol} plan14 down book`)
    ]);
    return { signal: await withFreshPlan14Spot(freshSignal, symbol), book: { up, down } };
  } catch {
    return { signal: freshSignal, book: null };
  }
}

async function resolvePlan14ExitInputs(order) {
  if (!order?.tokenId) throw new Error('missing tokenId');
  const [book, marketSignal] = await Promise.all([
    fetchPlan14Book(order.tokenId),
    buildPolymarketMarketSignal(order.symbol || 'BTC-USD', order.timeframe || '5m').catch(() => null)
  ]);
  const sameWindow = Number.isFinite(Date.parse(order.targetTimeIso))
    && Date.parse(marketSignal?.prediction?.targetTimeIso) === Date.parse(order.targetTimeIso);
  const signal = sameWindow ? await withFreshPlan14Spot(marketSignal, order.symbol || 'BTC-USD') : null;
  return {
    bid: book.bid,
    ask: book.ask,
    bookTimeMs: book.bookTimeMs,
    spot: signal?.indicators?.currentPrice,
    open: signal?.prediction?.comparisonBasePrice ?? signal?.indicators?.slotStartPrice,
    volatility: signal?.indicators?.volatility15mPct,
    quoteTimeMs: plan14QuoteMs(signal?.indicators?.currentQuoteTime)
  };
}

async function resolvePlan2OrderPrice(order) {
  if (order?.tokenId) {
    const sellPrice = await polymarketClient.getTokenPrice(order.tokenId, 'SELL').catch(() => NaN);
    if (Number.isFinite(sellPrice) && sellPrice > 0 && sellPrice < 1) return sellPrice;
  }
  const timeframe = order.timeframe || '15m';
  const sentiment = await buildPolymarketSentiment({
    symbol: order.symbol || 'BTC-USD',
    targetTimeIso: order.targetTimeIso,
    timeframe,
    client: polymarketClient
  });
  if (!sentiment?.available) throw new Error(sentiment?.reason || 'sentiment unavailable');
  return order.direction === 'up' ? Number(sentiment.upPrice) : Number(sentiment.downPrice);
}

function createLivePlanViewResolver() {
  const cache = new Map();
  return async (order) => {
    const timeframe = order.timeframe || '15m';
    const planId = normalizePaperPlanId(order.planId || 'plan2');
    const key = `${order.symbol || 'BTC-USD'}:${timeframe}:${planId}`;
    if (!cache.has(key)) {
      cache.set(key, buildPolymarketPaperPlanView(order.symbol || 'BTC-USD', timeframe, planId, {
        pendingDelayedEntrySource: 'live'
      }));
    }
    return cache.get(key);
  };
}

async function runTrackedSettlementPhase(key, factory, {
  timeoutMs = 45_000,
  fallback = null
} = {}) {
  // 与 live view 一致：超时后必须让出 inflight，否则一次卡住的官方结算
  // 会让后续循环永远拿到 fallback，僵尸仓占满 Plan1 开仓上限一下午。
  const task = getOrStartTrackedTask(
    polymarketSettlementPhaseInflightMap,
    key,
    factory,
    {
      replaceAfterMs: timeoutMs,
      onReplace: ({ ageMs }) => console.error(
        `Polymarket settlement phase ${key} replaced stale task after ${ageMs}ms`
      )
    }
  );
  if (!task.started) return fallback;
  try {
    return await withDeadline(task.promise, timeoutMs, `Settlement phase ${key}`);
  } catch (error) {
    // Caller deadline expired: drop ownership so the next loop can retry.
    const current = polymarketSettlementPhaseInflightMap.get(key);
    if (current?.promise === task.promise) {
      polymarketSettlementPhaseInflightMap.delete(key);
    }
    console.error(`Polymarket settlement phase ${key} failed: ${error.message}`);
    return fallback;
  }
}

async function runPolymarketSettlementLoop() {
  if (polymarketSettlementLoopRunning) return;
  polymarketSettlementLoopRunning = true;
  try {
    const loopStartedAtMs = Date.now();
    const maintenanceDue = loopStartedAtMs - polymarketMaintenanceLastRunAtMs >= POLYMARKET_MAINTENANCE_INTERVAL_MS;
    let liveStateChanged = false;
    if (config.polymarket.liveTradingEnabled) {
      // 到期结算与官方核验只依赖公开市场结果，必须先执行，不能被账户
      // readiness / 授权 / 余额接口失败挡在后面。
      const liveExpired = await runTrackedSettlementPhase(
        'live-expiry',
        () => polymarketTrading.settleExpiredLivePositions(resolvePolymarketSettlementOutcome),
        { timeoutMs: 45_000, fallback: [] }
      );
      if (liveExpired.length) {
        console.log(`Polymarket live expired settled ${liveExpired.length} position(s).`);
      }
      const officialReconciliation = maintenanceDue
        ? await runTrackedSettlementPhase(
          'live-official-reconciliation',
          () => polymarketTrading.reconcileLiveOfficialSettlements(
            resolvePolymarketSettlementOutcome,
            { limit: 25 }
          ),
          { timeoutMs: 45_000, fallback: { corrected: [] } }
        )
        : { corrected: [] };
      if (officialReconciliation.corrected.length) {
        console.log(`Polymarket corrected ${officialReconciliation.corrected.length} live settlement(s) from official outcomes.`);
      }

      const readiness = await getPolymarketReadiness();
      const closedOnly = readiness.clob?.closedOnly === true;
      const liveExitOpts = { closedOnly, readinessReady: readiness.ready };
      const synced = await polymarketTrading.syncLivePendingBuys();
      if (synced.length) {
        console.log(`Polymarket live synced ${synced.length} pending buy fill(s).`);
      }
      const syncedSells = await polymarketTrading.syncLivePendingSells();
      if (syncedSells.length) {
        console.log(`Polymarket live synced ${syncedSells.length} pending sell record(s).`);
      }
      const syncedPlan1TakeProfits = await polymarketTrading.syncLivePlan1TakeProfitOrders();
      if (syncedPlan1TakeProfits.length) {
        console.log(`Polymarket live synced ${syncedPlan1TakeProfits.length} Plan1 take-profit order(s).`);
      }
      const currentPlanResolver = createLivePlanViewResolver();
      const livePlan2Exits = await runTrackedSettlementPhase(
        'live-plan2-exits',
        () => polymarketTrading.processLivePlan2Exits(resolvePlan2OrderPrice, {
          ...liveExitOpts,
          resolveCurrentPlanView: currentPlanResolver
        }),
        { timeoutMs: 20_000, fallback: [] }
      );
      if (livePlan2Exits.length) {
        const byPlan = livePlan2Exits.reduce((acc, order) => {
          const id = normalizePaperPlanId(order.planId || 'plan2');
          acc[id] = (acc[id] || 0) + 1;
          return acc;
        }, {});
        const summary = Object.entries(byPlan)
          .map(([planId, count]) => `${planId} ${count}`)
          .join(', ');
        console.log(`Polymarket live exit closed ${livePlan2Exits.length} position(s): ${summary}.`);
      }
      const livePlan1Exits = await polymarketTrading.processLivePlan1Exits(resolvePlan2OrderPrice, null, liveExitOpts);
      if (livePlan1Exits.length) {
        console.log(`Polymarket live plan1 exit closed ${livePlan1Exits.length} position(s).`);
      }
      const livePlan5Stops = await polymarketTrading.processLivePlan5StopLosses(resolvePlan2OrderPrice, {
        ...liveExitOpts,
        resolveCurrentPlanView: currentPlanResolver
      });
      if (livePlan5Stops.length) {
        console.log(`Polymarket live plan5 stop closed ${livePlan5Stops.length} position(s).`);
      }
      liveStateChanged = Boolean(
        synced.length
        || syncedSells.length
        || syncedPlan1TakeProfits.length
        || livePlan2Exits.length
        || livePlan1Exits.length
        || livePlan5Stops.length
        || liveExpired.length
        || officialReconciliation.corrected.length
      );
      if (liveStateChanged) {
        await predictionRecorder.refreshDailyMarkdown(new Date());
      }
    }
    const takeProfits = await polymarketTrading.processPlan2TakeProfits(resolvePlan2OrderPrice, {
      resolveCurrentPlanView: createLivePlanViewResolver()
    });
    if (takeProfits.length) {
      console.log(`Polymarket plan2 exit closed ${takeProfits.length} order(s).`);
    }
    const plan1Exits = await polymarketTrading.processPlan1Exits(resolvePlan2OrderPrice);
    if (plan1Exits.length) {
      console.log(`Polymarket plan1 exit closed ${plan1Exits.length} order(s).`);
    }
    const plan11Exits = await polymarketTrading.processPlan11PaperExits(resolvePlan2OrderPrice);
    if (plan11Exits.length) {
      console.log(`Polymarket plan11 paper stop closed ${plan11Exits.length} order(s).`);
    }
    const plan14Exits = await polymarketTrading.processPlan14PaperExits(resolvePlan14ExitInputs);
    if (plan14Exits.length) {
      console.log(`Polymarket plan14 paper model exit closed ${plan14Exits.length} order(s).`);
    }
    const plan5Stops = await polymarketTrading.processPlan5StopLosses(resolvePlan2OrderPrice, {
      resolveCurrentPlanView: createLivePlanViewResolver()
    });
    if (plan5Stops.length) {
      console.log(`Polymarket plan5 paper stop closed ${plan5Stops.length} order(s).`);
    }
    const plan3Expired = await polymarketTrading.processPlan3PendingOrders('plan3');
    if (plan3Expired.length) {
      console.log(`Polymarket plan3 expired ${plan3Expired.length} unfilled order(s).`);
    }
    const settledAll = [];
    for (const planId of PLAN_IDS) {
      const resolver = ['plan15', 'plan16', 'plan17', 'plan18', 'plan19'].includes(planId)
        ? resolvePlan15SettlementOutcome
        : resolvePolymarketSettlementOutcome;
      const settled = await polymarketTrading.settleOpenOrders(planId, resolver);
      settledAll.push(...settled);
    }
    if (settledAll.length) {
      console.log(`Polymarket settled ${settledAll.length} paper order(s).`);
      const settledDates = new Set(settledAll.map((order) => order.targetTimeIso || order.settledAtIso).filter(Boolean));
      for (const date of settledDates) {
        await predictionRecorder.refreshDailyMarkdown(new Date(date));
      }
    }
    let backfilled = { updated: 0 };
    let paperOfficialCorrections = [];
    if (maintenanceDue) {
      backfilled = await polymarketTrading.backfillEarlyExitOutcomes(resolvePolymarketSettlementOutcome);
      const reconciliationResults = await Promise.all(PLAN_IDS.map((planId) => (
        polymarketTrading.reconcilePaperOfficialSettlements(
          resolvePolymarketSettlementOutcome,
          { planId, limit: 10 }
        )
      )));
      paperOfficialCorrections = reconciliationResults.flatMap((result) => result.corrected || []);
      polymarketMaintenanceLastRunAtMs = Date.now();
    }
    if (backfilled.updated) {
      console.log(`Polymarket backfilled ${backfilled.updated} early-exit outcome(s).`);
    }
    if (paperOfficialCorrections.length) {
      console.log(`Polymarket corrected ${paperOfficialCorrections.length} paper settlement(s) from official outcomes.`);
    }
    const stateChanged = Boolean(
      liveStateChanged
      || takeProfits.length
      || plan1Exits.length
      || plan5Stops.length
      || plan3Expired.length
      || settledAll.length
      || backfilled.updated
      || paperOfficialCorrections.length
    );
    const reportsDue = Date.now() - polymarketReportsLastRunAtMs >= POLYMARKET_REPORT_INTERVAL_MS;
    if (config.hourlyMonitor.recordDir && (stateChanged || reportsDue)) {
      try {
        const exitDocs = await writeExitDecisionReports({
          polymarketTrading,
          recordDir: config.hourlyMonitor.recordDir
        });
        await writePlan3SettlementReports({
          polymarketTrading,
          recordDir: config.hourlyMonitor.recordDir
        });
        try {
          await syncStrategyDocs({
            recordDir: config.hourlyMonitor.recordDir,
            config: config.polymarket,
            repoRoot: __dirname,
            throttleHours: 24
          });
        } catch (syncError) {
          console.error(`Polymarket strategy docs sync failed: ${syncError.message}`);
        }
        if (backfilled.updated || settledAll.length) {
          console.log('Polymarket exit-decision markdown refreshed.');
        }
        polymarketReportsLastRunAtMs = Date.now();
      } catch (error) {
        console.error(`Polymarket exit-decision markdown failed: ${error.message}`);
      }
    }
  } catch (error) {
    console.error(`Polymarket settlement loop failed: ${error.message}`);
  } finally {
    polymarketSettlementLoopRunning = false;
  }
}

function normalizePaperPlanId(value) {
  if (value === 'plan2') return 'plan2_5';
  if (PLAN_IDS.includes(value)) return value;
  return 'plan11';
}

async function runPolymarketSimplePlanFastLoop(planId) {
  const id = normalizePaperPlanId(planId);
  const enabledKey = id === 'plan3_5' ? 'plan3_5Enabled' : id === 'plan3_6' ? 'plan3_6Enabled' : null;
  if (enabledKey && config.polymarket[enabledKey] === false) return;
  const paperOn = polymarketTrading.status(id)?.auto?.enabled === true;
  const liveAuto = polymarketTrading.liveAutoStatus();
  const liveOn = liveAuto?.enabled === true
    && liveAuto.enabledPlans?.includes(id) === true
    && config.polymarket.liveTradingEnabled === true;
  if (!paperOn && !liveOn) return;

  const lanes = [];
  if (paperOn) lanes.push(runPolymarketSimplePlanPaperLane(id));
  if (liveOn) lanes.push(runPolymarketSimplePlanLiveLane(id, liveAuto));
  await Promise.allSettled(lanes);
}

async function runPolymarketSimplePlanPaperLane(id) {
  const lockKey = `${id}:paper`;
  if (polymarketSimplePlanFastLoopsRunning.has(lockKey)) return;
  polymarketSimplePlanFastLoopsRunning.add(lockKey);
  try {
    await runPolymarketAutoTick(id);
  } catch (error) {
    console.error(`Polymarket ${id} paper fast tick failed: ${error.message}`);
  } finally {
    polymarketSimplePlanFastLoopsRunning.delete(lockKey);
  }
}

async function runPolymarketSimplePlanLiveLane(id, liveAuto) {
  const lockKey = `${id}:live`;
  if (polymarketSimplePlanFastLoopsRunning.has(lockKey) || polymarketLivePlanLoopsRunning.has(id)) return;
  polymarketSimplePlanFastLoopsRunning.add(lockKey);
  polymarketLivePlanLoopsRunning.add(id);
  try {
    const readiness = await getPolymarketReadiness();
    const balance = resolveReadinessBalanceUsdc(readiness);
    if (hasReadinessBalance(readiness)) {
      await polymarketTrading.updateLiveControlBalance(balance);
    }
    const closedOnly = readiness.clob?.closedOnly === true;
    const configuredTimeframes = liveAuto.timeframes || ['5m', '15m'];
    const timeframes = id === 'plan3_6'
      ? [...PLAN3_6_LIVE_TIMEFRAMES]
      : id === 'plan3'
        ? configuredTimeframes.filter((timeframe) => {
          const is5m = timeframe === '5m';
          const secondsRemaining = Number(getSlotSchedule(new Date(), is5m ? 5 : 15).secondsToNext);
          const minSeconds = Number(is5m
            ? config.polymarket.plan3LiveWideMinSecondsRemaining5m
            : config.polymarket.plan3LiveWideMinSecondsRemaining15m) || (is5m ? 20 : 30);
          const maxSeconds = Number(is5m
            ? config.polymarket.plan3LiveWideMaxSecondsRemaining5m
            : config.polymarket.plan3LiveWideMaxSecondsRemaining15m) || (is5m ? 120 : 180);
          return secondsRemaining >= minSeconds && secondsRemaining <= maxSeconds;
        })
        : configuredTimeframes;
    if (!timeframes.length) return;
    const symbols = liveAuto.symbols?.length ? liveAuto.symbols : ['BTC-USD'];
    for (const timeframe of timeframes) {
      const orderedSymbols = orderSymbolsLeaderFirst(symbols);
      const viewResults = id === 'plan3'
        ? await Promise.allSettled(orderedSymbols.map((symbol) => buildPolymarketPaperPlanView(symbol, timeframe, id, {
          portfolioOverride: polymarketTrading.livePortfolioSnapshot({ clobBalanceUsdc: balance }),
          pendingDelayedEntrySource: 'live'
        }).then((view) => ({ symbol, view }))))
        : [];
      const views = id === 'plan3'
        ? viewResults.flatMap((result) => {
          if (result.status === 'fulfilled') return [result.value];
          console.error(`Polymarket ${id} live ${timeframe} view failed: ${result.reason?.message || result.reason}`);
          return [];
        })
        : [];
      if (id !== 'plan3') {
        let crossSymbolLeader = null;
        for (const symbol of orderedSymbols) {
          const view = await buildPolymarketPaperPlanView(symbol, timeframe, id, {
            portfolioOverride: polymarketTrading.livePortfolioSnapshot({ clobBalanceUsdc: balance }),
            pendingDelayedEntrySource: 'live',
            crossSymbolLeader: isPlan2Family(id) && symbol !== 'BTC-USD' ? crossSymbolLeader : null
          });
          if (isPlan2Family(id) && symbol === 'BTC-USD') {
            crossSymbolLeader = extractCrossSymbolLeader(view, symbol);
          }
          views.push({ symbol, view });
        }
      }
      // Fetch time-sensitive Plan3 views concurrently, but submit serially to preserve risk-state ordering.
      for (const { view } of views) {
        await polymarketTrading.maybeLiveAutoExecute({
          planView: view,
          clobBalanceUsdc: balance,
          closedOnly,
          readinessReady: readiness.ready,
          resolveCurrentPrice: async (order) => resolvePlan2OrderPrice(order)
        });
      }
    }
  } catch (error) {
    console.error(`Polymarket ${id} live fast tick failed: ${error.message}`);
  } finally {
    polymarketSimplePlanFastLoopsRunning.delete(lockKey);
    polymarketLivePlanLoopsRunning.delete(id);
  }
}

function normalizePolymarketTimeframe(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === '5m') return '5m';
  if (normalized === '1h' || normalized === 'hourly' || normalized === '60m') return '1h';
  if (normalized === '1d' || normalized === 'daily' || normalized === '24h') return '1d';
  return '15m';
}

function anyPolymarketAutoEnabled() {
  return anyPolymarketCoreAutoEnabled();
}

function buildUnavailableIntervalSignal(symbol, now, reason) {
  return {
    symbol,
    direction: 'wait',
    label: '\u7b49\u5f85',
    confidence: 0,
    probabilities: { up: 0, down: 0 },
    score: 0,
    modelScore: 0,
    reason: `\u771f\u5b9e\u884c\u60c5\u6e90\u4e0d\u53ef\u7528\uff0c\u672c\u8f6e\u6682\u505c\u5224\u65ad\uff1a${reason}`,
    schedule: getIntervalScheduleForServer(now),
    prediction: null,
    indicators: null
  };
}

function getIntervalScheduleForServer(now) {
  const current = new Date(now);
  current.setSeconds(0, 0);
  const slotMinute = Math.floor(current.getMinutes() / 15) * 15;
  const slot = new Date(current);
  slot.setMinutes(slotMinute, 0, 0);
  const next = new Date(slot);
  next.setMinutes(slot.getMinutes() + 15, 0, 0);
  return {
    slotMinutes: 15,
    currentSlotIso: slot.toISOString(),
    nextSlotIso: next.toISOString(),
    secondsToNext: Math.max(0, Math.floor((next.getTime() - now.getTime()) / 1000)),
    isDecisionMinute: current.getMinutes() % 15 === 0
  };
}

async function runPredictionRecordLoop() {
  if (predictionRecordLoopRunning) return;
  predictionRecordLoopRunning = true;
  try {
    await buildCryptoIntervalSignals(config.predictionRecords.symbols);
  } catch (error) {
    console.error(`Prediction record loop failed: ${error.message}`);
  } finally {
    predictionRecordLoopRunning = false;
  }
}

function anyPolymarketCoreAutoEnabled() {
  const status = polymarketTrading.status();
  return Boolean(
    status.plans?.plan1?.auto?.enabled
    || status.plans?.plan2?.auto?.enabled
    || status.plans?.plan2_5?.auto?.enabled
    || status.plans?.plan2_6?.auto?.enabled
    || status.plans?.plan11?.auto?.enabled
    || status.plans?.plan12?.auto?.enabled
    || status.plans?.plan13?.auto?.enabled
    || status.plans?.plan14?.auto?.enabled
    || status.plans?.plan5?.auto?.enabled
  );
}

async function stopRetiredPaperAndLivePlans() {
  for (const planId of RETIRED_PAPER_PLAN_IDS) {
    try {
      if (polymarketTrading.statusForPlan(planId)?.auto?.enabled) {
        await polymarketTrading.setAuto(false, { planId });
        console.log(`Retired paper plan ${planId} auto stopped`);
      }
    } catch (error) {
      console.error(`Stop retired paper ${planId} failed: ${error.message}`);
    }
  }
  const live = polymarketTrading.liveAutoStatus() || {};
  for (const planId of live.enabledPlans || []) {
    const id = normalizePaperPlanId(planId);
    if (POLYMARKET_LIVE_CORE_PLAN_IDS.includes(id)) continue;
    try {
      await polymarketTrading.setLiveAuto(false, { planId: id });
      console.log(`Retired live plan ${id} auto stopped`);
    } catch (error) {
      console.error(`Stop retired live ${id} failed: ${error.message}`);
    }
  }
}

async function ensurePlan14PaperRunning() {
  if (config.polymarket.plan14Enabled === false) return;
  if (config.polymarket.plan14NewEntriesEnabled !== true) {
    if (polymarketTrading.statusForPlan('plan14')?.auto?.enabled) {
      await polymarketTrading.setAuto(false, { planId: 'plan14' });
      console.log('Plan14 new entries disabled; paper auto stopped. Open orders still settle.');
    }
    return;
  }
  const planId = 'plan14';
  const desiredTimeframes = ['5m'];
  const desiredSymbols = Array.isArray(config.polymarket.plan14Symbols)
    ? config.polymarket.plan14Symbols
    : ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD'];
  if (!polymarketTrading.statusForPlan(planId)?.portfolio?.portfolioInitialized) {
    await polymarketTrading.configurePortfolio({
      planId,
      cash: Number(config.polymarket.defaultStartingCash) || 500
    });
  }
  const currentAuto = polymarketTrading.statusForPlan(planId)?.auto || {};
  const autoMatches = currentAuto.enabled === true
    && desiredTimeframes.every((timeframe) => currentAuto.timeframes?.includes(timeframe))
    && currentAuto.timeframes?.length === desiredTimeframes.length
    && desiredSymbols.every((symbol) => currentAuto.symbols?.includes(symbol))
    && currentAuto.symbols?.length === desiredSymbols.length;
  if (!autoMatches) {
    await polymarketTrading.setAuto(true, {
      planId,
      timeframes: desiredTimeframes,
      symbols: desiredSymbols
    });
  }
  scheduleIsolatedPaperPlanTick(planId);
}

async function ensurePlan15PaperRunning() {
  if (config.polymarket.plan15Enabled === false) return;
  if (config.polymarket.plan15NewEntriesEnabled !== true) {
    if (polymarketTrading.statusForPlan('plan15')?.auto?.enabled) {
      await polymarketTrading.setAuto(false, { planId: 'plan15' });
      console.log('Plan15 new entries disabled; paper auto stopped. Open orders still settle.');
    }
    return;
  }
  const planId = 'plan15';
  if (!polymarketTrading.statusForPlan(planId)?.portfolio?.portfolioInitialized) {
    await polymarketTrading.configurePortfolio({
      planId,
      cash: Number(config.polymarket.plan15StartingCash) || 500
    });
  }
  if (polymarketTrading.statusForPlan(planId)?.auto?.enabled !== true) {
    await polymarketTrading.setAuto(true, { planId, timeframes: ['5m'] });
  }
}

let plan15ScanRunning = false;

async function resolvePlan15SettlementOutcome(order) {
  return polymarketClient.getNamedMarketOutcome(order?.marketSlug);
}

async function runPlan15PaperScan() {
  if (plan15ScanRunning || config.polymarket.plan15Enabled === false) return { bought: 0 };
  if (config.polymarket.plan15NewEntriesEnabled !== true) return { bought: 0 };
  const status = polymarketTrading.statusForPlan('plan15');
  if (status?.auto?.enabled !== true || status?.portfolio?.portfolioInitialized !== true) {
    return { bought: 0 };
  }
  plan15ScanRunning = true;
  const bought = [];
  const skips = [];
  try {
    const pm = config.polymarket;
    const orderUsd = Math.max(1, Number(pm.plan15OrderUsd) || 5);
    const maxOpen = Number(pm.plan15MaxOpen);
    const maxNew = Number(pm.plan15MaxNewPerScan);
    const bucket = polymarketTrading.getBucket('plan15');
    const seen = new Set((bucket.paperOrders || []).map((order) => order.marketSlug).filter(Boolean));
    let openCount = (bucket.paperOrders || []).filter((order) => order.settlementStatus === 'open').length;
    const cash = Number(bucket.portfolio?.cash) || 0;
    if ((maxOpen > 0 && openCount >= maxOpen) || cash + 0.005 < orderUsd) {
      await polymarketTrading.notePlan15Scan({
        reason: maxOpen > 0 && openCount >= maxOpen ? '未结算订单已满' : '现金不足',
        bought: 0
      });
      return { bought: 0 };
    }
    const gates = {
      now: Date.now(),
      minPrice: Number(pm.plan15MinPrice) || 0.40,
      maxPrice: Number(pm.plan15MaxPrice) || 0.70,
      maxSpread: Number(pm.plan15MaxSpread) || 0.05,
      maxDays: Number(pm.plan15MaxDays) || 2,
      minVolume24hr: Number(pm.plan15MinVolume24hr) || 1000
    };
    const candidates = [];
    for (const category of PREDICTION_CATEGORIES) {
      let events = [];
      try {
        const tags = [category.tag, ...(category.fallbackTags || [])];
        for (const tag of tags) {
          events = await polymarketClient.getActiveEventsByTag({ tag, limit: 40 });
          if (events.length) break;
        }
      } catch (error) {
        skips.push(`${category.id}: ${error.message}`);
        continue;
      }
      for (const event of events) {
        const markets = Array.isArray(event?.markets) ? event.markets : [];
        for (const market of markets) {
          const prescreen = evaluatePlan15Candidate({ market, event, categoryId: category.id, ...gates });
          if (!prescreen.ok || seen.has(prescreen.marketSlug)) continue;
          candidates.push({ category, event, market, prescreen });
          seen.add(prescreen.marketSlug);
        }
      }
    }
    const grouped = new Map(PREDICTION_CATEGORIES.map((category) => [category.id, []]));
    for (const item of candidates) grouped.get(item.category.id)?.push(item);
    const ordered = [];
    let rotating = true;
    while (rotating) {
      rotating = false;
      for (const category of PREDICTION_CATEGORIES) {
        const queue = grouped.get(category.id);
        if (!queue?.length) continue;
        ordered.push(queue.shift());
        rotating = true;
      }
    }
    const books = ordered.length
      ? await polymarketClient.getOrderBooks(candidates.map((item) => item.prescreen.tokenId)).catch((error) => {
        skips.push(`books: ${error.message}`);
        return [];
      })
      : [];
    const bookByToken = new Map();
    for (const raw of books) {
      const tokenId = String(raw?.asset_id || raw?.assetId || raw?.token_id || raw?.tokenId || '');
      if (tokenId) bookByToken.set(tokenId, normalizeOrderBook(raw));
    }
    const boughtByCategory = {};
    for (const item of ordered) {
      if (maxNew > 0 && bought.length >= maxNew) break;
      if (maxOpen > 0 && openCount >= maxOpen) break;
      if ((Number(polymarketTrading.getBucket('plan15').portfolio?.cash) || 0) + 0.005 < orderUsd) break;
      const book = bookByToken.get(String(item.prescreen.tokenId));
      if (!book) {
        skips.push('missing_book');
        continue;
      }
      const decision = evaluatePlan15Candidate({
        market: item.market,
        event: item.event,
        categoryId: item.category.id,
        book,
        ...gates
      });
      if (!decision.ok) continue;
      const title = item.market.question || item.event?.title || decision.marketSlug;
      let order;
      try {
        order = await polymarketTrading.createPlan15PaperOrder({
          categoryId: item.category.id,
          categoryLabel: item.category.label,
          title,
          marketSlug: decision.marketSlug,
          conditionId: decision.conditionId,
          tokenId: decision.tokenId,
          outcome: decision.outcome,
          ask: decision.ask,
          usd: orderUsd,
          endDate: decision.endDate
        });
      } catch (error) {
        if (/现金不足|敞口上限|未结算订单已满/.test(error.message || '')) break;
        skips.push(error.message);
        continue;
      }
      if (!order) continue;
      openCount += 1;
      bought.push(order);
      boughtByCategory[item.category.label] = (boughtByCategory[item.category.label] || 0) + 1;
      console.log(`Polymarket plan15 ${item.category.id} paper order: ${order.outcome} $${order.usd} at ${order.limitPrice} ${title}`);
    }
    const categoryText = Object.entries(boughtByCategory).map(([label, count]) => `${label} ${count}`).join(' · ');
    const reason = bought.length
      ? `本轮买入 ${bought.length} 笔${categoryText ? ` · ${categoryText}` : ''}`
      : `本轮没有 40–70¢ 且 2 天内结算的窄价差事件（${skips.slice(0, 3).join(', ') || '无候选'}）`;
    await polymarketTrading.notePlan15Scan({ reason, bought: bought.length });
    return { bought: bought.length };
  } finally {
    plan15ScanRunning = false;
  }
}

async function ensurePlan16PaperRunning() {
  if (config.polymarket.plan16Enabled === false) return;
  if (config.polymarket.plan16NewEntriesEnabled !== true) {
    if (polymarketTrading.statusForPlan('plan16')?.auto?.enabled) {
      await polymarketTrading.setAuto(false, { planId: 'plan16' });
      console.log('Plan16 new entries disabled; paper auto stopped. Open orders still settle.');
    }
    return;
  }
  const planId = 'plan16';
  if (!polymarketTrading.statusForPlan(planId)?.portfolio?.portfolioInitialized) {
    await polymarketTrading.configurePortfolio({
      planId,
      cash: Number(config.polymarket.plan16StartingCash) || 500
    });
  }
  if (polymarketTrading.statusForPlan(planId)?.auto?.enabled !== true) {
    await polymarketTrading.setAuto(true, { planId, timeframes: ['5m'] });
  }
}

let plan16ScanRunning = false;

function asJsonList(value) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || '[]'); } catch { return []; }
}

function gammaYesPrice(market) {
  const yes = Number(asJsonList(market?.outcomePrices)[0]);
  return Number.isFinite(yes) ? yes : null;
}

async function runPlan16PaperScan() {
  if (plan16ScanRunning || config.polymarket.plan16Enabled === false) return { bought: 0 };
  if (config.polymarket.plan16NewEntriesEnabled !== true) return { bought: 0 };
  const status = polymarketTrading.statusForPlan('plan16');
  if (status?.auto?.enabled !== true || status?.portfolio?.portfolioInitialized !== true) {
    return { bought: 0 };
  }
  plan16ScanRunning = true;
  const bought = [];
  try {
    const pm = config.polymarket;
    const orderUsd = Math.max(1, Number(pm.plan16OrderUsd) || 5);
    const maxOpen = Number(pm.plan16MaxOpen) || 30;
    const maxNew = Number(pm.plan16MaxNewPerScan) || 8;
    const minEdge = Number(pm.plan16MinEdge) || 0.08;
    const bucket = polymarketTrading.getBucket('plan16');
    const openCount = (bucket.paperOrders || []).filter((order) => order.settlementStatus === 'open').length;
    const cash = Number(bucket.portfolio?.cash) || 0;
    if (openCount >= maxOpen || cash + 0.005 < orderUsd) {
      await polymarketTrading.notePlan16Scan({
        reason: openCount >= maxOpen ? '未结算订单已满' : '现金不足',
        bought: 0
      });
      return { bought: 0 };
    }
    const openGroupKeys = new Set((bucket.paperOrders || []).map((order) => order.plan16GroupKey).filter(Boolean));
    const seen = new Set((bucket.paperOrders || []).map((order) => order.marketSlug).filter(Boolean));
    const events = await polymarketClient.getActiveWeatherEvents({ limit: 80 }).catch(() => []);
    const parsed = [];
    for (const event of events) {
      for (const market of event?.markets || []) {
        const slug = String(market?.slug || '');
        if (!slug || seen.has(slug)) continue;
        const yes = gammaYesPrice(market);
        if (yes == null || yes < 0.05 || yes > 0.95) continue;
        const year = Number(String(market.endDate || event.endDate || '').slice(0, 4));
        const question = parsePlan16Question(market.question || '', year);
        const station = stationFromDescription(market.description || '');
        if (!question || !station) continue;
        parsed.push({ event, market, question, station });
      }
    }
    const groups = new Map();
    for (const row of parsed) {
      const key = `${row.station.icao}|${row.question.bucket.unit}`;
      if (!groups.has(key)) groups.set(key, { station: row.station, unit: row.question.bucket.unit, rows: [] });
      groups.get(key).rows.push(row);
    }
    const forecasts = new Map();
    const groupList = [...groups.values()];
    for (let index = 0; index < groupList.length; index += 4) {
      await Promise.all(groupList.slice(index, index + 4).map(async (group) => {
        try {
          const forecast = await fetchPlan16Ensemble({
            latitude: group.station.latitude,
            longitude: group.station.longitude,
            unit: group.unit
          });
          forecasts.set(`${group.station.icao}|${group.unit}`, forecast);
        } catch (error) {
          console.error(`Plan16 forecast ${group.station.icao} failed: ${error.message}`);
        }
      }));
    }
    const interesting = [];
    const minMembers = Number(pm.plan16MinMembers) || 20;
    for (const group of groupList) {
      const forecast = forecasts.get(`${group.station.icao}|${group.unit}`);
      if (!forecast) continue;
      for (const row of group.rows) {
        const series = forecast.days?.[row.question.date]?.[row.question.kind === 'high' ? 'max' : 'min'] || [];
        if (series.length < minMembers) continue;
        const pYes = ensembleYesProbability(series, row.question.bucket);
        const gamma = gammaYesPrice(row.market);
        if (pYes == null || gamma == null || Math.abs(pYes - gamma) + 1e-9 < minEdge) continue;
        interesting.push({ ...row, forecast, gap: Math.abs(pYes - gamma) });
      }
    }
    interesting.sort((left, right) => right.gap - left.gap);
    const shortlist = interesting.slice(0, 40);
    const tokenIds = [];
    for (const row of shortlist) {
      const outcomes = asJsonList(row.market.outcomes);
      const tokens = asJsonList(row.market.clobTokenIds);
      const yesIndex = outcomes.findIndex((name) => String(name).toLowerCase() === 'yes');
      const noIndex = outcomes.findIndex((name) => String(name).toLowerCase() === 'no');
      row.yesToken = tokens[yesIndex];
      row.noToken = tokens[noIndex];
      if (row.yesToken) tokenIds.push(String(row.yesToken));
      if (row.noToken) tokenIds.push(String(row.noToken));
    }
    const books = tokenIds.length
      ? await polymarketClient.getOrderBooks(tokenIds).catch((error) => {
        console.error(`Plan16 books failed: ${error.message}`);
        return [];
      })
      : [];
    const bookByToken = new Map();
    for (const raw of books) {
      const tokenId = String(raw?.asset_id || raw?.assetId || raw?.token_id || raw?.tokenId || '');
      if (tokenId) bookByToken.set(tokenId, normalizeOrderBook(raw));
    }
    const gates = {
      minAsk: Number(pm.plan16MinAsk) || 0.08,
      maxAsk: Number(pm.plan16MaxAsk) || 0.80,
      maxSpread: Number(pm.plan16MaxSpread) || 0.06,
      minEdge,
      minMembers,
      maxDays: Number(pm.plan16MaxDays) || 2,
      feeRate: Number(pm.plan16FeeRate) || 0.07
    };
    const picks = selectPlan16Buys({
      rows: shortlist.map((row) => ({
        market: row.market,
        event: row.event,
        forecast: row.forecast,
        yesBook: bookByToken.get(String(row.yesToken)),
        noBook: bookByToken.get(String(row.noToken))
      })),
      openGroupKeys,
      nowMs: Date.now(),
      ...gates
    });
    for (const pick of picks) {
      if (bought.length >= maxNew) break;
      if ((Number(polymarketTrading.getBucket('plan16').portfolio?.cash) || 0) + 0.005 < orderUsd) break;
      let order;
      try {
        order = await polymarketTrading.createPlan16PaperOrder({ ...pick, usd: orderUsd });
      } catch (error) {
        if (/现金不足|未结算订单已满/.test(error.message || '')) break;
        continue;
      }
      if (!order) continue;
      bought.push(order);
      openGroupKeys.add(pick.groupKey);
      console.log(`Polymarket plan16 paper order: ${order.outcome} $${order.usd} at ${order.limitPrice} ${pick.title}`);
    }
    const reason = bought.length
      ? `本轮买入 ${bought.length} 笔 · ${bought.map((order) => order.symbol).join(' · ')}`
      : `本轮没有扣费后仍高出 ${(minEdge * 100).toFixed(0)}¢ 的温度盘（可解析 ${parsed.length} · 价差够大 ${interesting.length}）`;
    await polymarketTrading.notePlan16Scan({ reason, bought: bought.length });
    return { bought: bought.length };
  } finally {
    plan16ScanRunning = false;
  }
}

async function ensurePlan17PaperRunning() {
  if (config.polymarket.plan17Enabled === false) return;
  if (config.polymarket.plan17NewEntriesEnabled !== true) {
    if (polymarketTrading.statusForPlan('plan17')?.auto?.enabled) {
      await polymarketTrading.setAuto(false, { planId: 'plan17' });
      console.log('Plan17 new entries disabled; paper auto stopped. Open orders still settle.');
    }
    return;
  }
  const planId = 'plan17';
  if (!polymarketTrading.statusForPlan(planId)?.portfolio?.portfolioInitialized) {
    await polymarketTrading.configurePortfolio({
      planId,
      cash: Number(config.polymarket.plan17StartingCash) || 500
    });
  }
  if (polymarketTrading.statusForPlan(planId)?.auto?.enabled !== true) {
    await polymarketTrading.setAuto(true, { planId, timeframes: ['5m'] });
  }
}

const PLAN17_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
let plan17ScanRunning = false;

function plan17EventSlugs(nowMs = Date.now()) {
  const slugs = [];
  for (let day = 0; day <= 3; day += 1) {
    // Event dates are US Eastern; a fixed UTC-4/5 shift only needs to land on the right calendar day.
    const et = new Date(nowMs - 4 * 3_600_000 + day * 86_400_000);
    const tail = `${PLAN17_MONTHS[et.getUTCMonth()]}-${et.getUTCDate()}-${et.getUTCFullYear()}`;
    for (const coin of Object.keys(PLAN17_COINS)) {
      slugs.push(`${coin}-above-on-${tail}`, `what-price-will-${coin}-hit-on-${tail}`);
    }
  }
  return slugs;
}

async function runPlan17PaperScan() {
  if (plan17ScanRunning || config.polymarket.plan17Enabled === false) return { bought: 0 };
  if (config.polymarket.plan17NewEntriesEnabled !== true) return { bought: 0 };
  const status = polymarketTrading.statusForPlan('plan17');
  if (status?.auto?.enabled !== true || status?.portfolio?.portfolioInitialized !== true) return { bought: 0 };
  plan17ScanRunning = true;
  const bought = [];
  try {
    const pm = config.polymarket;
    const kellyEnabled = pm.plan17KellyEnabled !== false;
    const orderUsd = Math.max(1, Number(pm.plan17OrderUsd) || 5);
    const minStake = kellyEnabled ? Math.max(1, Number(pm.plan17KellyMinUsd) || 1) : orderUsd;
    const maxOpen = Number(pm.plan17MaxOpen) || 40;
    const maxNew = Number(pm.plan17MaxNewPerScan) || 6;
    const minEdge = Number(pm.plan17MinEdge) || 0.10;
    const bucket = polymarketTrading.getBucket('plan17');
    const openOrders = (bucket.paperOrders || []).filter((order) => order.settlementStatus === 'open');
    const cash = Number(bucket.portfolio?.cash) || 0;
    if (openOrders.length >= maxOpen || cash + 0.005 < minStake) {
      await polymarketTrading.notePlan17Scan({ reason: openOrders.length >= maxOpen ? '未结算订单已满' : '现金不足', bought: 0 });
      return { bought: 0 };
    }
    const nowMs = Date.now();
    const events = (await Promise.all(plan17EventSlugs(nowMs).map((slug) => polymarketClient
      .gammaRequest('/events', { slug })
      .then((rows) => (Array.isArray(rows) ? rows[0] : null))
      .catch(() => null)))).filter((event) => event && !event.closed);
    const rows = [];
    for (const event of events) {
      for (const market of event.markets || []) {
        if (market.closed) continue;
        const parsed = parsePlan17Market({ event, market });
        if (parsed) rows.push({ event, market, parsed });
      }
    }
    const dataByCoin = {};
    for (const coin of [...new Set(rows.map((row) => row.parsed.coin))]) {
      const meta = PLAN17_COINS[coin];
      const starts = rows.filter((row) => row.parsed.coin === coin && Number.isFinite(row.parsed.windowStartMs)).map((row) => row.parsed.windowStartMs);
      try {
        const [iv, spot] = await Promise.all([
          fetchPlan17Dvol(meta.dvol, nowMs, { maxIvAgeMs: pm.plan17MaxIvAgeMs }),
          fetchPlan17Spot(meta.binance, starts.length ? Math.min(...starts) : null, nowMs)
        ]);
        dataByCoin[coin] = { ...iv, ...spot };
      } catch (error) {
        dataByCoin[coin] = { ivSkipReason: error.reason || 'missing_market_data' };
        console.error(`Plan17 market data ${coin} failed: ${error.message}`);
      }
    }
    const tokenIds = rows.flatMap((row) => asJsonList(row.market.clobTokenIds).map(String));
    const books = tokenIds.length
      ? await polymarketClient.getOrderBooks(tokenIds).catch((error) => {
        console.error(`Plan17 books failed: ${error.message}`);
        return [];
      })
      : [];
    const bookByToken = new Map();
    for (const raw of books) {
      const tokenId = String(raw?.asset_id || raw?.assetId || raw?.token_id || raw?.tokenId || '');
      if (tokenId) bookByToken.set(tokenId, normalizeOrderBook(raw));
    }
    const heldSlugs = new Set((bucket.paperOrders || []).map((order) => order.marketSlug).filter(Boolean));
    const heldPerEvent = new Map();
    for (const order of openOrders) {
      if (order.plan17EventSlug) heldPerEvent.set(order.plan17EventSlug, (heldPerEvent.get(order.plan17EventSlug) || 0) + 1);
    }
    const entryNowMs = Date.now();
    for (const data of Object.values(dataByCoin)) {
      const reason = plan17IvSkipReason(data, entryNowMs, pm.plan17MaxIvAgeMs);
      if (reason) data.ivSkipReason = reason;
    }
    const picks = selectPlan17Buys({
      rows: rows.map((row) => {
        const outcomes = asJsonList(row.market.outcomes).map((name) => String(name).toLowerCase());
        const tokens = asJsonList(row.market.clobTokenIds).map(String);
        return {
          event: row.event,
          market: row.market,
          data: dataByCoin[row.parsed.coin],
          yesBook: bookByToken.get(tokens[outcomes.indexOf('yes')]),
          noBook: bookByToken.get(tokens[outcomes.indexOf('no')])
        };
      }),
      heldSlugs,
      heldPerEvent,
      nowMs: entryNowMs,
      maxIvAgeMs: pm.plan17MaxIvAgeMs,
      minEdge,
      minAsk: Number(pm.plan17MinAsk) || 0.03,
      maxAsk: Number(pm.plan17MaxAsk) || 0.95,
      maxSpread: Number(pm.plan17MaxSpread) || 0.05,
      maxPerEvent: Number(pm.plan17MaxPerEvent) || 4,
      families: Array.isArray(pm.plan17Families) && pm.plan17Families.length ? pm.plan17Families : ['hitDaily', 'above'],
      feeRate: Number(pm.plan17FeeRate) || 0.07
    });
    const equity = cash + openOrders.reduce((sum, order) => sum + (Number(order.usd) || 0), 0);
    let cashLeft = cash;
    let scanSpent = 0;
    const scanCap = kellyEnabled ? equity * (Number(pm.plan17KellyScanCap) || 0.25) : Infinity;
    for (const pick of picks) {
      if (bought.length >= maxNew) break;
      const ivReason = plan17IvSkipReason(pick, Date.now(), pm.plan17MaxIvAgeMs);
      if (ivReason) {
        dataByCoin[pick.coin].ivSkipReason = ivReason;
        continue;
      }
      let usd = orderUsd;
      let kelly = null;
      if (kellyEnabled) {
        kelly = plan17KellyStake({
          p: pick.p,
          cost: pick.cost,
          equity,
          cash: Math.min(cashLeft, Math.max(0, scanCap - scanSpent)),
          fraction: Number(pm.plan17KellyFraction) || 0.5,
          maxFraction: Number(pm.plan17KellyMaxFraction) || 0.08,
          minUsd: minStake
        });
        if (!(kelly.usd > 0)) continue;
        usd = kelly.usd;
      }
      let order;
      try {
        order = await polymarketTrading.createPlan17PaperOrder({
          ...pick,
          usd,
          kellyFull: kelly?.fullKelly ?? null,
          kellyFraction: kelly?.appliedFraction ?? null
        });
      } catch (error) {
        if (/现金不足|未结算订单已满/.test(error.message || '')) break;
        continue;
      }
      if (!order) continue;
      cashLeft = Math.max(0, cashLeft - Number(order.usd) || 0);
      scanSpent += Number(order.usd) || 0;
      bought.push(order);
      const kellyText = kelly ? ` · 半凯利 ${(kelly.appliedFraction * 100).toFixed(1)}%（满仓 ${(kelly.fullKelly * 100).toFixed(1)}%）` : '';
      console.log(`Polymarket plan17 paper order: ${order.outcome} $${order.usd} at ${order.limitPrice} ${pick.title} (model ${pick.p}, edge ${pick.edge}${kellyText})`);
    }
    const coinsText = Object.entries(dataByCoin).map(([coin, data]) => data.ivSkipReason ? `${PLAN17_COINS[coin].symbol}: ${data.ivSkipReason}` : `${PLAN17_COINS[coin].symbol} ${Math.round(data.spot)} · IV ${data.iv}`).join(' · ');
    const reason = bought.length
      ? `本轮买入 ${bought.length} 笔 · ${bought.map((order) => `${order.symbol} ${order.outcome} $${order.usd}`).join(' · ')}`
      : `本轮没有扣费后高出 ${(minEdge * 100).toFixed(0)}¢ 的档位（可解析 ${rows.length} · ${coinsText || '行情缺失'}）`;
    const skips = Object.entries(dataByCoin).filter(([, data]) => data.ivSkipReason)
      .map(([coin, data]) => `${PLAN17_COINS[coin].symbol}: ${data.ivSkipReason}`).join(' · ');
    await polymarketTrading.notePlan17Scan({ reason: bought.length && skips ? `${reason} · ${skips}` : reason, bought: bought.length });
    return { bought: bought.length };
  } finally {
    plan17ScanRunning = false;
  }
}

/** Plan18（梅花）与 Plan19（小六壬）共用同一套扫描；配置按 `${planId}Xxx` 读取。 */
function divinationConfig(planId, key) {
  return config.polymarket[`${planId}${key}`];
}

async function ensurePlan18PaperRunning(planId = 'plan18') {
  const label = planId === 'plan19' ? 'Plan19' : 'Plan18';
  if (divinationConfig(planId, 'Enabled') === false) return;
  if (divinationConfig(planId, 'NewEntriesEnabled') !== true) {
    if (polymarketTrading.statusForPlan(planId)?.auto?.enabled) {
      await polymarketTrading.setAuto(false, { planId });
      console.log(`${label} new entries disabled; paper auto stopped. Open orders still settle.`);
    }
    return;
  }
  if (!polymarketTrading.statusForPlan(planId)?.portfolio?.portfolioInitialized) {
    await polymarketTrading.configurePortfolio({
      planId,
      cash: Number(divinationConfig(planId, 'StartingCash')) || 500
    });
  }
  if (polymarketTrading.statusForPlan(planId)?.auto?.enabled !== true) {
    await polymarketTrading.setAuto(true, { planId, timeframes: ['5m'] });
  }
}

const plan18EtHour = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23'
});
const divinationScanRunning = new Set();
const divinationArchiveAtMs = new Map();

const PLAN18_HOURLY_COIN = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'xrp' };

function plan18EventSlugs(nowMs = Date.now(), planId = 'plan18') {
  const configured = divinationConfig(planId, 'Symbols');
  const symbols = configured?.length ? configured : ['BTC', 'ETH'];
  const configuredTimeframes = divinationConfig(planId, 'Timeframes');
  const timeframes = configuredTimeframes?.length ? configuredTimeframes : ['1h'];
  const parts = Object.fromEntries(plan18EtHour.formatToParts(new Date(nowMs)).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour);
  const label = hour === 0 ? '12am' : hour < 12 ? `${hour}am` : hour === 12 ? '12pm' : `${hour - 12}pm`;
  const tail = `${PLAN17_MONTHS[Number(parts.month) - 1]}-${Number(parts.day)}-${parts.year}-${label}-et`;
  const slugs = [];
  for (const timeframe of timeframes) {
    for (const symbol of symbols) {
      slugs.push(timeframe === '1h'
        ? `${PLAN18_HOURLY_COIN[symbol]}-up-or-down-${tail}`
        : plan18ShortSlug(symbol, timeframe, nowMs));
    }
  }
  return slugs.filter(Boolean);
}

async function runPlan18PaperScan(planId = 'plan18') {
  if (divinationScanRunning.has(planId) || divinationConfig(planId, 'Enabled') === false) return { bought: 0 };
  if (divinationConfig(planId, 'NewEntriesEnabled') !== true) return { bought: 0 };
  const status = polymarketTrading.statusForPlan(planId);
  if (status?.auto?.enabled !== true || status?.portfolio?.portfolioInitialized !== true) return { bought: 0 };
  divinationScanRunning.add(planId);
  const bought = [];
  try {
    const nowMs = Date.now();
    // 每小时归档一次超过保留期的已结算订单，控制状态文件大小。
    if (nowMs - (divinationArchiveAtMs.get(planId) || 0) > 3_600_000) {
      divinationArchiveAtMs.set(planId, nowMs);
      const archived = await polymarketTrading.archiveDivinationSettledOrders(planId, {
        retentionDays: Number(divinationConfig(planId, 'RetentionDays')) || 35
      }).catch((error) => {
        console.warn(`${planId} archive failed: ${error.message}`);
        return { archived: 0 };
      });
      if (archived.archived) console.log(`${planId} archived ${archived.archived} settled order(s).`);
    }
    const byTimeframe = divinationConfig(planId, 'OrderUsdByTimeframe');
    const orderUsdFor = (timeframe) => Math.max(1, Number(byTimeframe?.[timeframe]) || Number(divinationConfig(planId, 'OrderUsd')) || 5);
    const bucket = polymarketTrading.getBucket(planId);
    const topUpUsd = Number(divinationConfig(planId, 'AutoTopUpUsd')) || 0;
    const minCash = Number(divinationConfig(planId, 'MinCashUsd')) || 0;
    if (topUpUsd > 0 && (Number(bucket.portfolio?.cash) || 0) < minCash) {
      const result = await polymarketTrading.topUpDivinationCash(planId, topUpUsd);
      if (result) console.log(`${planId} cash below $${minCash}; topped up $${result.usd} (cash ${result.cash}, startingCash ${result.startingCash}).`);
    }
    if ((Number(bucket.portfolio?.cash) || 0) + 0.005 < 1) {
      if (bucket.auto?.lastReason !== '现金不足') await polymarketTrading.notePlan18Scan({ planId, reason: '现金不足', bought: 0 });
      return { bought: 0 };
    }
    const held = new Set((bucket.paperOrders || []).map((order) => order.marketSlug).filter(Boolean));
    const slugs = plan18EventSlugs(nowMs, planId).filter((slug) => !held.has(slug));
    if (!slugs.length) return { bought: 0 };
    const method = planId === 'plan19' ? 'liuren' : 'meihua';
    const events = (await Promise.all(slugs.map((slug) => polymarketClient
      .gammaRequest('/events', { slug })
      .then((rows) => (Array.isArray(rows) ? rows[0] : null))
      .catch(() => null)))).filter(Boolean);
    const tokenIds = events.flatMap((event) => asJsonList(event.markets?.[0]?.clobTokenIds).map(String));
    const books = tokenIds.length ? await polymarketClient.getOrderBooks(tokenIds).catch(() => []) : [];
    const bookByToken = new Map();
    for (const raw of books) {
      const tokenId = String(raw?.asset_id || raw?.assetId || raw?.token_id || raw?.tokenId || '');
      if (tokenId) bookByToken.set(tokenId, normalizeOrderBook(raw));
    }
    const skips = [];
    for (const event of events) {
      const market = event.markets?.[0];
      const outcomes = asJsonList(market?.outcomes).map((name) => String(name).toLowerCase());
      const tokens = asJsonList(market?.clobTokenIds).map(String);
      const decision = evaluatePlan18Event({
        event,
        upBook: bookByToken.get(tokens[outcomes.indexOf('up')]),
        downBook: bookByToken.get(tokens[outcomes.indexOf('down')]),
        maxAsk: Number(divinationConfig(planId, 'MaxAsk')) || 0.65,
        maxSpread: Number(divinationConfig(planId, 'MaxSpread')) || 0.03,
        entryWindowMinutes: divinationConfig(planId, 'EntryWindowMinutes'),
        feeRate: 0.07,
        method
      });
      if (!decision.ok) {
        if (decision.reason !== 'entry_window_passed' && decision.reason !== 'not_started') skips.push(`${event.slug} ${decision.reason}`);
        continue;
      }
      let order;
      try {
        order = await polymarketTrading.createPlan18PaperOrder({ ...decision, planId, usd: orderUsdFor(decision.timeframe) }, { persist: false });
      } catch (error) {
        if (/现金不足/.test(error.message || '')) continue;
        skips.push(error.message);
        continue;
      }
      if (!order) continue;
      bought.push(order);
      console.log(`Polymarket ${planId} paper order: ${order.symbol} ${order.timeframe} ${order.outcome} $${order.usd} at ${order.limitPrice} · ${decision.divination.text}`);
    }
    if (bought.length || skips.length) {
      const reason = bought.length
        ? `本轮按卦买入 ${bought.length} 笔 · ${bought.map((order) => `${order.symbol} ${order.timeframe} ${order.outcome}`).join(' · ')} · ${bought[0].plan18Divination?.text || ''}`
        : `本轮未下单（${skips.join('，')}）`;
      // 一轮只落盘一次（含上面 persist:false 的订单）。
      await polymarketTrading.notePlan18Scan({ planId, reason, bought: bought.length });
    }
    return { bought: bought.length };
  } finally {
    divinationScanRunning.delete(planId);
  }
}

function anyPolymarketLiveCoreAutoEnabled() {
  const auto = polymarketTrading.liveAutoStatus();
  if (!auto?.enabled) return false;
  return (auto.enabledPlans || []).some((planId) => {
    const id = normalizePaperPlanId(planId);
    return !['plan3_5', 'plan3_6'].includes(id);
  });
}

function hasReadinessBalance(readiness) {
  const raw = readiness?.clob?.collateral?.balanceUsdc;
  // 仅把 >0 当作可信刷新；瞬时 $0 不写入 liveControl，避免误拦
  return raw !== null
    && raw !== undefined
    && raw !== ''
    && Number.isFinite(Number(raw))
    && Number(raw) > 0;
}

function withDeadline(promise, timeoutMs, label = 'Operation') {
  const deadlineMs = Math.max(1000, Number(timeoutMs) || 20_000);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} exceeded ${deadlineMs}ms`));
    }, deadlineMs);

    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function getPolymarketReadiness({ maxAgeMs = 5000 } = {}) {
  const now = Date.now();
  if (
    polymarketReadinessCache.payload
    && (
      now - polymarketReadinessCache.at < maxAgeMs
      || now < Number(polymarketReadinessCache.retryAfterAt || 0)
    )
  ) {
    return polymarketReadinessCache.payload;
  }
  if (polymarketReadinessCache.inflight) {
    return polymarketReadinessCache.inflight;
  }

  const refreshTimeoutMs = Math.max(
    1000,
    Number(config.polymarket.readinessRefreshTimeoutMs) || 20_000
  );
  const inflight = withDeadline(
    buildPolymarketReadiness(config.polymarket),
    refreshTimeoutMs,
    'Polymarket readiness refresh'
  )
    .then((payload) => {
      const nextBal = Number(payload?.clob?.collateral?.balanceUsdc);
      const prev = polymarketReadinessCache.payload;
      const prevBal = Number(prev?.clob?.collateral?.balanceUsdc);
      // 新读数为 0 而缓存仍为正：保留正余额缓存，缩短“假 $0”污染窗口
      const keepPrevPositive = Number.isFinite(nextBal)
        && nextBal <= 0
        && Number.isFinite(prevBal)
        && prevBal > 0
        && prev?.clob?.ok === true;
      const stored = keepPrevPositive ? prev : payload;
      polymarketReadinessCache = {
        at: Date.now(),
        payload: stored,
        inflight: null,
        retryAfterAt: 0
      };
      return keepPrevPositive
        ? {
          ...payload,
          clob: {
            ...(payload.clob || {}),
            collateral: {
              ...(payload.clob?.collateral || {}),
              balanceUsdc: prevBal,
              reportedBalanceUsdc: nextBal,
              balanceFallback: 'cached-positive'
            },
            openOrdersCount: payload.clob?.openOrdersCount ?? prev.clob?.openOrdersCount ?? null
          }
        }
        : payload;
    })
    .catch((error) => {
      const stale = polymarketReadinessCache.payload;
      const unavailable = {
        generatedAtIso: new Date().toISOString(),
        configured: Boolean(config.polymarket.configured),
        liveTradingEnabled: Boolean(config.polymarket.liveTradingEnabled),
        ready: false,
        clob: {
          ok: false,
          closedOnly: null,
          collateral: { balanceUsdc: null }
        },
        error: error?.message || String(error),
        fallback: 'readiness-unavailable'
      };
      const fallback = stale || unavailable;
      polymarketReadinessCache = {
        ...polymarketReadinessCache,
        at: stale ? polymarketReadinessCache.at : Date.now(),
        payload: fallback,
        inflight: null,
        // 避免底层请求迟迟不退出时，Plan1/Plan5 每几秒再堆一个相同刷新。
        retryAfterAt: Date.now() + 15_000
      };
      console.error(
        `Polymarket readiness refresh failed; ${stale ? 'using cached snapshot' : 'no cached snapshot available'}:`,
        error?.message || error
      );
      return fallback;
    });
  polymarketReadinessCache = { ...polymarketReadinessCache, inflight };
  return inflight;
}

function resolveReadinessBalanceUsdc(readiness) {
  if (hasReadinessBalance(readiness)) {
    return Math.max(0, Number(readiness.clob.collateral.balanceUsdc));
  }
  const control = polymarketTrading.state?.liveControl || {};
  return Math.max(
    0,
    Number(control.currentBalanceUsdc) || 0,
    Number(control.lastValidBalanceUsdc) || 0
  );
}

async function runPolymarketAutoLoop() {
  const planId = POLYMARKET_PAPER_CORE_PLAN_IDS[
    polymarketPaperCoreRoundRobinIndex % POLYMARKET_PAPER_CORE_PLAN_IDS.length
  ];
  polymarketPaperCoreRoundRobinIndex += 1;
  if (polymarketTrading.statusForPlan(planId)?.auto?.enabled) {
    scheduleIsolatedPaperPlanTick(planId);
  }
}

function scheduleIsolatedPaperPlanTick(planId) {
  const id = normalizePaperPlanId(planId);
  if (id === 'plan15') {
    runPlan15PaperScan().catch((error) => {
      console.error(`Plan15 paper scan failed: ${error.message}`);
    });
    return;
  }
  if (id === 'plan16') {
    runPlan16PaperScan().catch((error) => {
      console.error(`Plan16 paper scan failed: ${error.message}`);
    });
    return;
  }
  if (id === 'plan17') {
    runPlan17PaperScan().catch((error) => {
      console.error(`Plan17 paper scan failed: ${error.message}`);
    });
    return;
  }
  if (id === 'plan18' || id === 'plan19') {
    runPlan18PaperScan(id).catch((error) => {
      console.error(`${id} paper scan failed: ${error.message}`);
    });
    return;
  }
  if (polymarketPaperPlanLoopsRunning.has(id)) return;
  polymarketPaperPlanLoopsRunning.add(id);
  const tickContext = {
    tickId: `${id}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
    cancelled: false,
    cancelledStage: null,
    startedAtIso: new Date().toISOString()
  };
  const lockTimeoutMs = Math.max(
    30_000,
    id === 'plan5'
      ? Number(config.polymarket?.plan5PaperTickTimeoutMs) || 90_000
      : Number(config.polymarket?.paperPlanTickTimeoutMs) || 180_000
  );
  let released = false;
  const releaseLock = (reason = null) => {
    if (released) return;
    released = true;
    polymarketPaperPlanLoopsRunning.delete(id);
    if (reason) console.error(`Polymarket ${id} paper auto tick lock released: ${reason}`);
  };
  const lockTimer = setTimeout(() => {
    const stage = polymarketPaperPlanLoopStages.get(id)?.stage || 'unknown';
    tickContext.cancelled = true;
    tickContext.cancelledStage = stage;
    releaseLock(`watchdog exceeded ${lockTimeoutMs}ms at ${stage}; old tick cancelled`);
  }, lockTimeoutMs);
  setImmediate(() => {
    runPolymarketAutoTick(id, { tickContext })
      .then((result) => logPolymarketAutoTicks(result.ticks))
      .catch((error) => {
        console.error(`Polymarket ${id} paper auto tick failed: ${error.message}`);
      })
      .finally(() => {
        clearTimeout(lockTimer);
        releaseLock();
        if (polymarketPaperPlanLoopStages.get(id)?.tickId === tickContext.tickId) {
          polymarketPaperPlanLoopStages.delete(id);
        }
      });
  });
}

function logPolymarketAutoTicks(ticks = []) {
  for (const tick of ticks || []) {
    const sym = (tick.symbol || tick.order?.symbol || 'BTC-USD').replace('-USD', '');
    if (tick.executed) {
      console.log(`Polymarket ${tick.planId} ${sym} ${tick.timeframe} auto order: ${tick.order.outcome} $${tick.order.usd} at ${tick.order.limitPrice}`);
    } else if (tick.reason && /market (unavailable|matched)|No active .+ up\/down/i.test(tick.reason)) {
      console.log(`Polymarket ${tick.planId} ${sym} ${tick.timeframe} skip: ${tick.reason}`);
    }
  }
}

function quotePrice(quote) {
  if (!quote) return null;
  const price = Number(quote.price);
  if (Number.isFinite(price) && price > 0) return price;
  const bid = Number(quote.bid_inclusive_of_sell_spread);
  const ask = Number(quote.ask_inclusive_of_buy_spread);
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) return (bid + ask) / 2;
  return null;
}

function mockCandlesFromCloses(closes, intervalMinutes = 15) {
  const stepMs = intervalMinutes * 60 * 1000;
  const start = Date.now() - closes.length * stepMs;
  return closes.map((close, index) => {
    const previous = index > 0 ? closes[index - 1] : close;
    const high = Math.max(previous, close) * 1.0015;
    const low = Math.min(previous, close) * 0.9985;
    return {
      time: Math.floor((start + index * stepMs) / 1000),
      open: previous,
      high,
      low,
      close,
      volume: 0
    };
  });
}
