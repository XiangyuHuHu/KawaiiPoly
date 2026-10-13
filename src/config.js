import 'dotenv/config';

function parseHoldingsUsd(value) {
  if (!value) return {};
  return Object.fromEntries(
    value
      .split(',')
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const [symbol, amount] = pair.split(':').map((part) => part.trim());
        return [symbol, Number(amount)];
      })
      .filter(([symbol, amount]) => symbol && Number.isFinite(amount) && amount >= 0)
  );
}

function parseList(value, fallback) {
  return (value || fallback)
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

function parsePositiveNumberList(value, fallback = [4, 3, 2, 1]) {
  const raw = (value == null || value === '')
    ? fallback
    : String(value).split(',').map((item) => item.trim()).filter(Boolean);
  const parsed = raw
    .map((item) => Number(item))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parsed.length ? parsed : [...fallback];
}

function parseDelaysMs(value, fallback = []) {
  if (!value) return fallback;
  const parsed = String(value)
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item >= 0);
  return parsed.length ? parsed : fallback;
}

function buildPredictionRecordConfig() {
  return {
    enabled: process.env.PREDICTION_RECORDS_ENABLED !== 'false',
    pollIntervalMs: Number(process.env.PREDICTION_RECORD_POLL_INTERVAL_MS || 5000),
    symbols: parseList(process.env.PREDICTION_RECORD_SYMBOLS, 'BTC-USD,ETH-USD,SOL-USD,XRP-USD'),
    recordDir:
      process.env.PREDICTION_RECORD_DIR ||
      [
        'D:',
        'Obsidian\u4ed3\u5e93',
        'Kawaii\u7684\u4ed3\u5e93',
        '\u6295\u8d44',
        '\u865a\u62df\u5e01',
        '\u6bd4\u7279\u5e01\u731c\u8f93\u8d62\u8bb0\u5f55'
      ].join('\\')
  };
}

function buildHourlyMonitorConfig(predictionRecords) {
  return {
    enabled: process.env.HOURLY_MONITOR_ENABLED !== 'false',
    intervalMs: Number(process.env.HOURLY_MONITOR_INTERVAL_MS || 3600000),
    recordDir: process.env.HOURLY_MONITOR_DIR || predictionRecords.recordDir
  };
}

function resolvePolymarketOrderUsdAtBase() {
  if (process.env.POLYMARKET_ORDER_USD_AT_BASE) {
    return Number(process.env.POLYMARKET_ORDER_USD_AT_BASE);
  }
  return 100;
}

/** 算卦对照组（Plan18 梅花 / Plan19 小六壬）共用的一组配置，按 env 前缀读取。 */
function divinationPlanConfig(planId, envPrefix) {
  const env = (suffix) => process.env[`${envPrefix}_${suffix}`];
  const num = (suffix, fallback) => Number(env(suffix) || fallback);
  return {
    [`${planId}Enabled`]: env('ENABLED') !== 'false',
    [`${planId}NewEntriesEnabled`]: env('NEW_ENTRIES_ENABLED') === 'true',
    [`${planId}StartingCash`]: num('STARTING_CASH', 500),
    [`${planId}Timeframes`]: String(env('TIMEFRAMES') || '5m,15m,1h')
      .split(',').map((item) => item.trim()).filter((item) => ['5m', '15m', '1h'].includes(item)),
    [`${planId}Symbols`]: String(env('SYMBOLS') || 'BTC,ETH,SOL,XRP')
      .split(',').map((item) => item.trim().toUpperCase()).filter((item) => ['BTC', 'ETH', 'SOL', 'XRP'].includes(item)),
    [`${planId}OrderUsd`]: num('ORDER_USD', 5),
    [`${planId}OrderUsdByTimeframe`]: {
      '5m': num('ORDER_USD_5M', 1),
      '15m': num('ORDER_USD_15M', 1),
      '1h': num('ORDER_USD', 5)
    },
    [`${planId}MaxAsk`]: num('MAX_ASK', 0.65),
    [`${planId}MaxSpread`]: num('MAX_SPREAD', 0.03),
    [`${planId}EntryWindowMinutes`]: {
      '5m': num('ENTRY_WINDOW_MINUTES_5M', 1),
      '15m': num('ENTRY_WINDOW_MINUTES_15M', 3),
      '1h': num('ENTRY_WINDOW_MINUTES', 10)
    },
    [`${planId}LoopMs`]: num('LOOP_MS', 20000),
    // 已结算订单在状态文件里只保留这么多天；更早的追加到 JSONL 归档，避免状态文件无限增长。
    [`${planId}RetentionDays`]: num('RETENTION_DAYS', 35),
    // 现金低于 MIN_CASH_USD 时自动追加 AUTO_TOP_UP_USD（0 关闭）；startingCash 同步上调，不是重置。
    [`${planId}MinCashUsd`]: num('MIN_CASH_USD', 100),
    [`${planId}AutoTopUpUsd`]: num('AUTO_TOP_UP_USD', 500)
  };
}

function buildPolymarketConfig() {
  return {
    enabled: process.env.POLYMARKET_ENABLED !== 'false',
    blendEnabled: process.env.POLYMARKET_BLEND_ENABLED !== 'false',
    liveTradingEnabled: process.env.POLYMARKET_LIVE_TRADING_ENABLED === 'true',
    // When enabled, paper plans use production judgment/entry rules. Only the
    // wallet and order submission transport remain simulated.
    paperLiveParityEnabled: process.env.POLYMARKET_PAPER_LIVE_PARITY_ENABLED !== 'false',
    // Paper fills at the book best ask (not midpoint) and pays crypto taker fees on
    // entry and early exit, so paper PnL is comparable to live FAK execution.
    paperExecutableAskFillEnabled: process.env.POLYMARKET_PAPER_EXECUTABLE_ASK_FILL_ENABLED !== 'false',
    paperMaxAskQuoteGap: Number(process.env.POLYMARKET_PAPER_MAX_ASK_QUOTE_GAP || 0.05),
    paperTakerFeeEnabled: process.env.POLYMARKET_PAPER_TAKER_FEE_ENABLED !== 'false',
    paperTakerFeeRate: Number(process.env.POLYMARKET_PAPER_TAKER_FEE_RATE || 0.07),
    liveAutoEnabled: process.env.POLYMARKET_LIVE_AUTO_ENABLED === 'true',
    liveAutoPlanId: process.env.POLYMARKET_LIVE_AUTO_PLAN === 'plan2' ? 'plan2' : 'plan1',
    timeframe: process.env.POLYMARKET_BTC_TIMEFRAME || '15m',
    plan1Symbols: parseList(process.env.POLYMARKET_PLAN1_SYMBOLS, 'BTC-USD,ETH-USD'),
    plan2Symbols: parseList(process.env.POLYMARKET_PLAN2_SYMBOLS, 'BTC-USD,ETH-USD,SOL-USD,XRP-USD'),
    plan2CrossSymbolEnabled: process.env.POLYMARKET_PLAN2_CROSS_SYMBOL_ENABLED !== 'false',
    plan2CrossSymbolMinLeaderConfidence: Number(process.env.POLYMARKET_PLAN2_CROSS_SYMBOL_MIN_LEADER_CONFIDENCE || 0.62),
    plan2CrossSymbolAlignBoost: Number(process.env.POLYMARKET_PLAN2_CROSS_SYMBOL_ALIGN_BOOST || 0.02),
    plan2CrossFollowEnabled: process.env.POLYMARKET_PLAN2_CROSS_FOLLOW_ENABLED !== 'false',
    plan2CrossFollowMinLeaderConfidence: Number(process.env.POLYMARKET_PLAN2_CROSS_FOLLOW_MIN_LEADER_CONFIDENCE || 0.64),
    plan2CrossFollowMinDiscount: Number(process.env.POLYMARKET_PLAN2_CROSS_FOLLOW_MIN_DISCOUNT || 0.04),
    plan2CrossFollowMaxOpposingGap: Number(process.env.POLYMARKET_PLAN2_CROSS_FOLLOW_MAX_OPPOSING_GAP || 0.10),
    plan2CrossFollowMinPrice: Number(process.env.POLYMARKET_PLAN2_CROSS_FOLLOW_MIN_PRICE || 0.40),
    plan2CrossFollowMaxPrice: Number(process.env.POLYMARKET_PLAN2_CROSS_FOLLOW_MAX_PRICE || 0.85),
    plan2CrossFollowMinElapsedPct: Number(process.env.POLYMARKET_PLAN2_CROSS_FOLLOW_MIN_ELAPSED_PCT || 0.10),
    plan2CrossFollowMaxElapsedPct: Number(process.env.POLYMARKET_PLAN2_CROSS_FOLLOW_MAX_ELAPSED_PCT || 0.72),
    plan2CrossFollowMaxReverseDistanceBps: Number(process.env.POLYMARKET_PLAN2_CROSS_FOLLOW_MAX_REVERSE_DISTANCE_BPS || 6),
    plan2CrossFollowMinQuality: Number(process.env.POLYMARKET_PLAN2_CROSS_FOLLOW_MIN_QUALITY || 0.35),
    plan2CrossFollowSizeMultiplier: Number(process.env.POLYMARKET_PLAN2_CROSS_FOLLOW_SIZE_MULTIPLIER || 0.35),
    gammaBaseUrl: process.env.POLYMARKET_GAMMA_BASE || 'https://gamma-api.polymarket.com',
    clobBaseUrl: process.env.POLYMARKET_CLOB_BASE || 'https://clob.polymarket.com',
    dataBaseUrl: process.env.POLYMARKET_DATA_BASE || 'https://data-api.polymarket.com',
    requestTimeoutMs: Number(process.env.POLYMARKET_REQUEST_TIMEOUT_MS || 12000),
    // Live CLOB calls sit on the critical 5m execution path. Keep their per-call
    // timeout below the whole-order watchdog so one half-open request cannot use
    // the entire entry window.
    clobRequestTimeoutMs: Number(process.env.POLYMARKET_CLOB_REQUEST_TIMEOUT_MS || 6000),
    // 整个账户就绪状态刷新也必须有总截止时间，避免共享 Promise 永久锁死 Plan1/Plan5。
    readinessRefreshTimeoutMs: Number(process.env.POLYMARKET_READINESS_REFRESH_TIMEOUT_MS || 20000),
    defaultOrderUsd: Number(process.env.POLYMARKET_DEFAULT_ORDER_USD || 5),
    maxOrderUsd: Number(process.env.POLYMARKET_MAX_ORDER_USD || 500),
    liveMaxOrderUsd: Number(process.env.POLYMARKET_LIVE_MAX_ORDER_USD || process.env.POLYMARKET_MAX_ORDER_USD || 500),
    dailyMaxLossUsd: Number(process.env.POLYMARKET_DAILY_MAX_LOSS_USD || 0),
    globalDailyLossLimitPct: Number(
      process.env.POLYMARKET_GLOBAL_DAILY_LOSS_LIMIT_PCT
      || process.env.POLYMARKET_PLAN3_DAILY_LOSS_LIMIT_PCT
      || 0.01
    ),
    // 默认开；显式 false 时关闭全策略日亏停（UI 开关仍可覆盖）
    globalDailyLossProtectionEnabled: process.env.POLYMARKET_GLOBAL_DAILY_LOSS_PROTECTION_ENABLED !== 'false',
    // Plan1 同时未结算仓上限（open+pending）；默认 1，避免多窗并行打穿小账户
    plan1MaxOpenLivePositions: Number(process.env.POLYMARKET_PLAN1_MAX_OPEN_LIVE_POSITIONS || 1),
    defaultStartingCash: Number(process.env.POLYMARKET_PAPER_STARTING_CASH || 500),
    sizingBasePrincipal: Number(process.env.POLYMARKET_SIZING_BASE_PRINCIPAL || 500),
    orderPct15m: Number(process.env.POLYMARKET_ORDER_PCT_15M || 0.055),
    orderPct5m: Number(process.env.POLYMARKET_ORDER_PCT_5M || 0.025),
    orderUsdAtBase: resolvePolymarketOrderUsdAtBase(),
    orderUsd5m: Number(process.env.POLYMARKET_ORDER_USD_5M || 20),
    orderUsd15m: Number(process.env.POLYMARKET_ORDER_USD_15M || 30),
    maxOrderEquityPct: Number(process.env.POLYMARKET_MAX_ORDER_EQUITY_PCT || 0.08),
    liveAdaptiveCapEnabled: process.env.POLYMARKET_LIVE_ADAPTIVE_CAP_ENABLED !== 'false',
    liveAdaptiveCapBaseEquityPct: Number(process.env.POLYMARKET_LIVE_ADAPTIVE_CAP_BASE_EQUITY_PCT || 0.08),
    liveAdaptiveCapFloorEquityPct: Number(process.env.POLYMARKET_LIVE_ADAPTIVE_CAP_FLOOR_EQUITY_PCT || 0.03),
    liveAdaptiveCapMaxEquityPct: Number(process.env.POLYMARKET_LIVE_ADAPTIVE_CAP_MAX_EQUITY_PCT || 0.10),
    liveAdaptiveCapMinSamples: Number(process.env.POLYMARKET_LIVE_ADAPTIVE_CAP_MIN_SAMPLES || 12),
    liveAdaptiveCapLookbackDays: Number(process.env.POLYMARKET_LIVE_ADAPTIVE_CAP_LOOKBACK_DAYS || 30),
    liveAdaptiveCapPaperWeight: Number(process.env.POLYMARKET_LIVE_ADAPTIVE_CAP_PAPER_WEIGHT || 0.20),
    // CLOB 实盘过小会买得进、卖不出（invalid maker amount）；默认抬到 $5
    minOrderUsd: Number(process.env.POLYMARKET_MIN_ORDER_USD || 5),
    maxTotalOpenExposurePct: Number(process.env.POLYMARKET_MAX_TOTAL_OPEN_EXPOSURE_PCT || 0.20),
    maxTimeframeOpenExposurePct: Number(process.env.POLYMARKET_MAX_TIMEFRAME_OPEN_EXPOSURE_PCT || 0.12),
    globalExposureCapEnabled: process.env.POLYMARKET_GLOBAL_EXPOSURE_CAP_ENABLED === 'true',
    globalExposureMode: String(process.env.POLYMARKET_GLOBAL_EXPOSURE_MODE || 'layered').toLowerCase(),
    globalSlotDirectionMaxExposurePct: Number(process.env.POLYMARKET_GLOBAL_SLOT_DIRECTION_MAX_EXPOSURE_PCT || 0.08),
    globalTimeframeMaxExposurePct: Number(process.env.POLYMARKET_GLOBAL_TIMEFRAME_MAX_EXPOSURE_PCT || 0.12),
    globalTotalBtcMarketExposurePct: Number(process.env.POLYMARKET_GLOBAL_TOTAL_BTC_MARKET_EXPOSURE_PCT || 0.20),
    confidenceCalibrationEnabled: process.env.POLYMARKET_CONFIDENCE_CALIBRATION_ENABLED !== 'false',
    confidenceMinBucketSamples: Number(process.env.POLYMARKET_CONFIDENCE_MIN_BUCKET_SAMPLES || 20),
    calibrationLookbackDays: Number(process.env.POLYMARKET_CALIBRATION_LOOKBACK_DAYS || 45),
    historyWinRateGateEnabled: process.env.POLYMARKET_HISTORY_WINRATE_GATE_ENABLED !== 'false',
    historyWinRateMargin: Number(process.env.POLYMARKET_HISTORY_WINRATE_MARGIN || 0.02),
    // soft：略低于盈亏平衡时降仓放行；hard：直接跳过
    historyWinRateGateMode: String(process.env.POLYMARKET_HISTORY_WINRATE_GATE_MODE || 'hard').toLowerCase(),
    historyWinRateSoftGap: Number(process.env.POLYMARKET_HISTORY_WINRATE_SOFT_GAP || 0.04),
    historyWinRateSoftSizeFloor: Number(process.env.POLYMARKET_HISTORY_WINRATE_SOFT_SIZE_FLOOR || 0.35),
    historyWinRateRequireCalibration: process.env.POLYMARKET_HISTORY_WINRATE_REQUIRE_CALIBRATION === 'true',
    // 亏损归因反馈门控：近期同类可规避亏损占比过高 → skip / 降仓（冷启动放行）
    lossReasonGateEnabled: process.env.POLYMARKET_LOSS_REASON_GATE_ENABLED !== 'false',
    lossReasonGateMinSamples: Number(process.env.POLYMARKET_LOSS_REASON_GATE_MIN_SAMPLES || 12),
    lossReasonGateLookbackDays: Number(process.env.POLYMARKET_LOSS_REASON_GATE_LOOKBACK_DAYS || 14),
    lossReasonGateMaxLossRate: Number(process.env.POLYMARKET_LOSS_REASON_GATE_MAX_LOSS_RATE || 0.55),
    lossReasonGateRequireSamples: process.env.POLYMARKET_LOSS_REASON_GATE_REQUIRE_SAMPLES === 'true',
    lossReasonGateSizeScaleEnabled: process.env.POLYMARKET_LOSS_REASON_GATE_SIZE_SCALE_ENABLED !== 'false',
    lossReasonGateSizeScaleFloor: Number(process.env.POLYMARKET_LOSS_REASON_GATE_SIZE_SCALE_FLOOR || 0.5),
    lossReasonHighEntryPrice: Number(process.env.POLYMARKET_LOSS_REASON_HIGH_ENTRY_PRICE || 0.85),
    lossReasonShortHoldMs: Number(process.env.POLYMARKET_LOSS_REASON_SHORT_HOLD_MS || 90000),
    // 分币胜率奖赏仓位：按开启币种的历史胜率排名分配权重（默认 mean_preserving，平均≈base）
    symbolWrSizingEnabled: process.env.POLYMARKET_SYMBOL_WR_SIZING_ENABLED !== 'false',
    symbolWrRankWeights: parsePositiveNumberList(process.env.POLYMARKET_SYMBOL_WR_RANK_WEIGHTS, [4, 3, 2, 1]),
    symbolWrMinSamples: Number(process.env.POLYMARKET_SYMBOL_WR_MIN_SAMPLES || 10),
    symbolWrLookbackDays: Number(process.env.POLYMARKET_SYMBOL_WR_LOOKBACK_DAYS || 30),
    // mean_preserving | fixed_pool
    symbolWrSizingMode: String(process.env.POLYMARKET_SYMBOL_WR_SIZING_MODE || 'mean_preserving').toLowerCase(),
    regimeFilterEnabled: process.env.POLYMARKET_REGIME_FILTER_ENABLED !== 'false',
    chopFilterEnabled: process.env.POLYMARKET_CHOP_FILTER_ENABLED !== 'false',
    chopMaxDistanceBps: Number(process.env.POLYMARKET_CHOP_MAX_DISTANCE_BPS || 4),
    chopMinDirectionFlips: Number(process.env.POLYMARKET_CHOP_MIN_DIRECTION_FLIPS || 3),
    chopMainSizeScale: Number(process.env.POLYMARKET_CHOP_MAIN_SIZE_SCALE ?? 0),
    chopProbeSizeScale: Number(process.env.POLYMARKET_CHOP_PROBE_SIZE_SCALE || 0.2),
    chopMaxLowVolatilityBps: Number(process.env.POLYMARKET_CHOP_MAX_LOW_VOLATILITY_BPS || 6),
    chopNearOpenSeconds: Number(process.env.POLYMARKET_CHOP_NEAR_OPEN_SECONDS || 60),
    plan1EdgeConfidenceMode: process.env.POLYMARKET_PLAN1_EDGE_CONFIDENCE_MODE || 'tech_heavy',
    plan1TechEdgeWeight: Number(process.env.POLYMARKET_PLAN1_TECH_EDGE_WEIGHT || 0.75),
    plan1FlipBlockInChop: process.env.POLYMARKET_PLAN1_FLIP_BLOCK_IN_CHOP !== 'false',
    fiveMinutePathExperimentEnabled: process.env.POLYMARKET_5M_PATH_EXPERIMENT_ENABLED !== 'false',
    plan1FiveMinutePathGuardEnabled: process.env.POLYMARKET_PLAN1_5M_PATH_GUARD_ENABLED === 'true',
    fiveMinutePathMinSamples: Number(process.env.POLYMARKET_5M_PATH_MIN_SAMPLES || 8),
    fiveMinutePathMinImpulseBps: Number(process.env.POLYMARKET_5M_PATH_MIN_IMPULSE_BPS || 4),
    fiveMinutePathMaxStartElapsedPct: Number(process.env.POLYMARKET_5M_PATH_MAX_START_ELAPSED_PCT || 0.12),
    fiveMinutePathMaxPlateauRangeBps: Number(process.env.POLYMARKET_5M_PATH_MAX_PLATEAU_RANGE_BPS || 4),
    fiveMinutePathMaxPlateauDriftBps: Number(process.env.POLYMARKET_5M_PATH_MAX_PLATEAU_DRIFT_BPS || 3),
    fiveMinutePathMinRetracementRatio: Number(process.env.POLYMARKET_5M_PATH_MIN_RETRACEMENT_RATIO || 0.45),
    fiveMinutePathMinReversalBps: Number(process.env.POLYMARKET_5M_PATH_MIN_REVERSAL_BPS || 4),
    fiveMinutePathMinLateHoldMs: Number(process.env.POLYMARKET_5M_PATH_MIN_LATE_HOLD_MS || 20000),
    fiveMinutePathMinPmGap: Number(process.env.POLYMARKET_5M_PATH_MIN_PM_GAP || 0.04),
    kellyCapEnabled: process.env.POLYMARKET_KELLY_CAP_ENABLED !== 'false',
    kellyFraction: Number(process.env.POLYMARKET_KELLY_FRACTION || 0.25),
    kellyMaxEquityPct: Number(process.env.POLYMARKET_KELLY_MAX_EQUITY_PCT || 0.08),
    lossStreakCooldown4Ms: Number(process.env.POLYMARKET_LOSS_STREAK_4_COOLDOWN_MS || 15 * 60 * 1000),
    lossStreakCooldown5Ms: Number(process.env.POLYMARKET_LOSS_STREAK_5_COOLDOWN_MS || 30 * 60 * 1000),
    lossStreakRecoveryScale: Number(process.env.POLYMARKET_LOSS_STREAK_RECOVERY_SCALE || 0.25),
    lossStreakRecoveryMinConfidence: Number(process.env.POLYMARKET_LOSS_STREAK_RECOVERY_MIN_CONFIDENCE || 0.65),
    lossStreakRecoveryMinEdge: Number(process.env.POLYMARKET_LOSS_STREAK_RECOVERY_MIN_EDGE || 0.08),
    plan1ApplyLossStreakRecovery: process.env.POLYMARKET_PLAN1_APPLY_LOSS_STREAK_RECOVERY === 'true',
    plan11ApplyLossStreakRecovery: process.env.POLYMARKET_PLAN11_APPLY_LOSS_STREAK_RECOVERY === 'true',
    // 连赢加仓 / 连亏减仓（入场 sizing；不改止损路径）
    // 默认偏保守（约 $80–100 小资金）：连赢 +12%/级 cap 1.5x；连亏 −22%/级 floor 0.4x
    streakSizingEnabled: process.env.POLYMARKET_STREAK_SIZING_ENABLED !== 'false',
    streakSizingWinStepPct: Number(process.env.POLYMARKET_STREAK_SIZING_WIN_STEP_PCT || 0.12),
    streakSizingWinMaxLevels: Number(process.env.POLYMARKET_STREAK_SIZING_WIN_MAX_LEVELS || 4),
    streakSizingWinCap: Number(process.env.POLYMARKET_STREAK_SIZING_WIN_CAP || 1.5),
    streakSizingLossStepPct: Number(process.env.POLYMARKET_STREAK_SIZING_LOSS_STEP_PCT || 0.22),
    streakSizingLossMaxLevels: Number(process.env.POLYMARKET_STREAK_SIZING_LOSS_MAX_LEVELS || 4),
    streakSizingLossFloor: Number(process.env.POLYMARKET_STREAK_SIZING_LOSS_FLOOR || 0.4),
    // clamp=缩到计划/CLOB 最小单；skip=缩仓后低于最小单则跳过噪声单
    streakSizingBelowMinMode: String(process.env.POLYMARKET_STREAK_SIZING_BELOW_MIN_MODE || 'clamp').toLowerCase(),
    // 每 plan 可选覆盖：未设置则跟随全局 streakSizingEnabled
    plan1StreakSizingEnabled: process.env.POLYMARKET_PLAN1_STREAK_SIZING_ENABLED,
    plan2StreakSizingEnabled: process.env.POLYMARKET_PLAN2_STREAK_SIZING_ENABLED,
    plan2_5StreakSizingEnabled: process.env.POLYMARKET_PLAN2_5_STREAK_SIZING_ENABLED,
    plan2_6StreakSizingEnabled: process.env.POLYMARKET_PLAN2_6_STREAK_SIZING_ENABLED,
    plan11StreakSizingEnabled: process.env.POLYMARKET_PLAN11_STREAK_SIZING_ENABLED,
    plan3StreakSizingEnabled: process.env.POLYMARKET_PLAN3_STREAK_SIZING_ENABLED,
    plan3_5StreakSizingEnabled: process.env.POLYMARKET_PLAN3_5_STREAK_SIZING_ENABLED,
    plan3_6StreakSizingEnabled: process.env.POLYMARKET_PLAN3_6_STREAK_SIZING_ENABLED,
    plan4StreakSizingEnabled: process.env.POLYMARKET_PLAN4_STREAK_SIZING_ENABLED,
    plan5StreakSizingEnabled: process.env.POLYMARKET_PLAN5_STREAK_SIZING_ENABLED,
    minConfidence5m: Number(process.env.POLYMARKET_MIN_CONFIDENCE_5M || 0.58),
    minConfidence15m: Number(process.env.POLYMARKET_MIN_CONFIDENCE_15M || 0.56),
    minEdge5m: Number(process.env.POLYMARKET_MIN_EDGE_5M || 0.06),
    minEdge15m: Number(process.env.POLYMARKET_MIN_EDGE_15M || 0.04),
    minMarketQuality: Number(process.env.POLYMARKET_MIN_MARKET_QUALITY || 0.40),
    plan1MinMarketQuality: Number(process.env.POLYMARKET_PLAN1_MIN_MARKET_QUALITY || 0.40),
    plan1MinEdge5m: Number(process.env.POLYMARKET_PLAN1_MIN_EDGE_5M || 0.025),
    plan1MinEdge15m: Number(process.env.POLYMARKET_PLAN1_MIN_EDGE_15M || 0.02),
    plan1MinConfidence: Number(process.env.POLYMARKET_PLAN1_MIN_CONFIDENCE || 0.55),
    plan1MaxEntryPrice: Number(process.env.POLYMARKET_PLAN1_MAX_ENTRY_PRICE || 0.70),
    plan1MaxEntryPrice5m: Number(process.env.POLYMARKET_PLAN1_MAX_ENTRY_PRICE_5M || 0.70),
    plan1MaxEntryPrice15m: Number(process.env.POLYMARKET_PLAN1_MAX_ENTRY_PRICE_15M || 0.70),
    plan1MinEntryPrice: Number(process.env.POLYMARKET_PLAN1_MIN_ENTRY_PRICE || 0),
    plan1MinEntryPrice5m: Number(process.env.POLYMARKET_PLAN1_MIN_ENTRY_PRICE_5M || 0),
    plan1MinEntryPrice15m: Number(process.env.POLYMARKET_PLAN1_MIN_ENTRY_PRICE_15M || 0.45),
    plan1EntryMinElapsedPct: Number(process.env.POLYMARKET_PLAN1_ENTRY_MIN_ELAPSED_PCT || 0.08),
    plan1EntryMaxElapsedPct: Number(process.env.POLYMARKET_PLAN1_ENTRY_MAX_ELAPSED_PCT || 0.80),
    plan1EntryMinElapsedPct5m: Number(process.env.POLYMARKET_PLAN1_ENTRY_MIN_ELAPSED_PCT_5M || 0.08),
    plan1EntryMaxElapsedPct5m: Number(process.env.POLYMARKET_PLAN1_ENTRY_MAX_ELAPSED_PCT_5M || 0.75),
    plan1EntryMinElapsedPct15m: Number(process.env.POLYMARKET_PLAN1_ENTRY_MIN_ELAPSED_PCT_15M || 0.08),
    plan1EntryMaxElapsedPct15m: Number(process.env.POLYMARKET_PLAN1_ENTRY_MAX_ELAPSED_PCT_15M || 0.80),
    plan1TakeProfitOffset: Number(process.env.POLYMARKET_PLAN1_TAKE_PROFIT_OFFSET || 0.14),
    plan1StopLossOffset: Number(process.env.POLYMARKET_PLAN1_STOP_LOSS_OFFSET || 0.10),
    plan1HoldToSettlementEnabled: process.env.POLYMARKET_PLAN1_HOLD_TO_SETTLEMENT_ENABLED === 'true',
    plan1StopLossAbsoluteFloor: process.env.POLYMARKET_PLAN1_STOP_LOSS_ABSOLUTE_FLOOR === '0'
      ? 0
      : Number(process.env.POLYMARKET_PLAN1_STOP_LOSS_ABSOLUTE_FLOOR || 0),
    plan1LiveStopConfirmationEnabled: process.env.POLYMARKET_PLAN1_LIVE_STOP_CONFIRMATION_ENABLED !== 'false',
    plan1LiveStopConfirmSamples: Number(process.env.POLYMARKET_PLAN1_LIVE_STOP_CONFIRM_SAMPLES || 3),
    plan1LiveStopConfirmMs5m: Number(process.env.POLYMARKET_PLAN1_LIVE_STOP_CONFIRM_MS_5M || 6000),
    plan1LiveStopConfirmMs15m: Number(process.env.POLYMARKET_PLAN1_LIVE_STOP_CONFIRM_MS_15M || 12000),
    stopLossAbsoluteFloor: process.env.POLYMARKET_STOP_LOSS_ABSOLUTE_FLOOR === '0'
      ? 0
      : Number(process.env.POLYMARKET_STOP_LOSS_ABSOLUTE_FLOOR || 0.50),
    plan1TimeStopRemainingPct: Number(process.env.POLYMARKET_PLAN1_TIME_STOP_REMAINING_PCT || 0.25),
    plan1DirectionFlipEnabled: process.env.POLYMARKET_PLAN1_DIRECTION_FLIP_ENABLED !== 'false',
    plan1DirectionFlipEnabled5m: process.env.POLYMARKET_PLAN1_DIRECTION_FLIP_ENABLED_5M === 'true',
    plan1DirectionFlipEnabled15m: process.env.POLYMARKET_PLAN1_DIRECTION_FLIP_ENABLED_15M !== 'false',
    plan1FlipCooldownMs: Number(process.env.POLYMARKET_PLAN1_FLIP_COOLDOWN_MS || 120000),
    plan1FlipMinHoldMs: Number(process.env.POLYMARKET_PLAN1_FLIP_MIN_HOLD_MS || 90000),
    plan1FlipMinConfidence: Number(process.env.POLYMARKET_PLAN1_FLIP_MIN_CONFIDENCE || 0.64),
    plan1FlipMinEdge: Number(process.env.POLYMARKET_PLAN1_FLIP_MIN_EDGE || 0.035),
    plan1FlipMaxFloatingLossPct: Number(process.env.POLYMARKET_PLAN1_FLIP_MAX_FLOATING_LOSS_PCT || 0.25),
    plan1FlipMaxElapsedPct: Number(process.env.POLYMARKET_PLAN1_FLIP_MAX_ELAPSED_PCT || 0.80),
    plan1BasketConflictProbeEnabled: process.env.POLYMARKET_PLAN1_BASKET_CONFLICT_PROBE_ENABLED === 'true',
    plan1BasketConflictProbeMultiplier: Number(process.env.POLYMARKET_PLAN1_BASKET_CONFLICT_PROBE_MULTIPLIER || 0.15),
    plan1PaperCashPctEnabled: process.env.POLYMARKET_PLAN1_PAPER_CASH_PCT_ENABLED !== 'false',
    plan1PaperMinOrderUsd: Number(process.env.POLYMARKET_PLAN1_PAPER_MIN_ORDER_USD || 1),
    // 实盘最小单：过小会导致 CLOB「invalid maker amount」、止损卖不出死循环
    plan1LiveMinOrderUsd: Number(process.env.POLYMARKET_PLAN1_LIVE_MIN_ORDER_USD || 5),
    // 可执行底（默认 $2.5）：即使 LIVE_MIN 配成 $1，也不提交廉价侧 5 份≈$1 灰尘单
    plan1LiveExecutableFloorUsd: Number(process.env.POLYMARKET_PLAN1_LIVE_EXECUTABLE_FLOOR_USD || 2.5),
    // soft/late 抬底时单笔不超过可用现金的该比例，避免小账户半仓硬抬
    plan1LiveMaxOrderCashPct: Number(process.env.POLYMARKET_PLAN1_LIVE_MAX_ORDER_CASH_PCT || 0.35),
    // 已废弃：意向低于 floor 时若余额/敞口够则抬仓，不再按此阈值跳过
    plan1LiveDustSkipUsd: Number(process.env.POLYMARKET_PLAN1_LIVE_DUST_SKIP_USD || 2),
    plan1PaperOrderPct: Number(process.env.POLYMARKET_PLAN1_PAPER_ORDER_PCT || 0.05),
    plan1HistoryHierarchyEnabled: process.env.POLYMARKET_PLAN1_HISTORY_HIERARCHY_ENABLED !== 'false',
    // 单边市需要显式开启；默认仍关，避免本地开发误开高价尾段
    plan1LateCaptureEnabled: process.env.POLYMARKET_PLAN1_LATE_CAPTURE_ENABLED === 'true',
    plan1LateCaptureMinPrice: Number(process.env.POLYMARKET_PLAN1_LATE_CAPTURE_MIN_PRICE || 0.70),
    plan1LateCaptureMaxPrice: Number(process.env.POLYMARKET_PLAN1_LATE_CAPTURE_MAX_PRICE || 0.88),
    plan1LateCaptureMinElapsedPct: Number(process.env.POLYMARKET_PLAN1_LATE_CAPTURE_MIN_ELAPSED_PCT || 0.45),
    plan1LateCaptureMaxElapsedPct: Number(process.env.POLYMARKET_PLAN1_LATE_CAPTURE_MAX_ELAPSED_PCT || 0.92),
    plan1LateCaptureMinDistanceBps: Number(process.env.POLYMARKET_PLAN1_LATE_CAPTURE_MIN_DISTANCE_BPS || 3),
    plan1LateCaptureMinMarketQuality: Number(process.env.POLYMARKET_PLAN1_LATE_CAPTURE_MIN_MARKET_QUALITY || 0.40),
    plan1LateCaptureMidSizeMultiplier: Number(process.env.POLYMARKET_PLAN1_LATE_CAPTURE_MID_SIZE_MULTIPLIER || 0.35),
    plan1LateCaptureHighSizeMultiplier: Number(process.env.POLYMARKET_PLAN1_LATE_CAPTURE_HIGH_SIZE_MULTIPLIER || 0.18),
    plan1LateCaptureMinConfidence: Number(process.env.POLYMARKET_PLAN1_LATE_CAPTURE_MIN_CONFIDENCE || 0.58),
    plan1OppositeHedgeEnabled: process.env.POLYMARKET_PLAN1_OPPOSITE_HEDGE_ENABLED !== 'false',
    plan1OppositeHedgeMaxPrice: Number(process.env.POLYMARKET_PLAN1_OPPOSITE_HEDGE_MAX_PRICE || 0.15),
    plan1OppositeHedgeSizePct: Number(process.env.POLYMARKET_PLAN1_OPPOSITE_HEDGE_SIZE_PCT || 0.05),
    plan1OppositeHedgeMinRemainingPct: Number(process.env.POLYMARKET_PLAN1_OPPOSITE_HEDGE_MIN_REMAINING_PCT || 0),
    plan2EntryMinPrice: Number(process.env.POLYMARKET_PLAN2_ENTRY_MIN_PRICE || 0.35),
    plan2EntryMaxPrice: Number(process.env.POLYMARKET_PLAN2_ENTRY_MAX_PRICE || 0.78),
    plan2MinConfidence: Number(process.env.POLYMARKET_PLAN2_MIN_CONFIDENCE || 0.63),
    plan2MinEdge: Number(process.env.POLYMARKET_PLAN2_MIN_EDGE || 0.08),
    plan2MinMarketQuality: Number(process.env.POLYMARKET_PLAN2_MIN_MARKET_QUALITY || 0.42),
    plan2ProbeMarketQuality: Number(process.env.POLYMARKET_PLAN2_PROBE_MARKET_QUALITY || 0.40),
    plan2QualityScaleMid: Number(process.env.POLYMARKET_PLAN2_QUALITY_SCALE_MID || 0.60),
    plan2QualityScaleLow: Number(process.env.POLYMARKET_PLAN2_QUALITY_SCALE_LOW || 0.35),
    plan2RequirePolymarketAlignment: process.env.POLYMARKET_PLAN2_REQUIRE_PM_ALIGNMENT !== 'false',
    plan2DirectionPmGapLead: Number(process.env.POLYMARKET_PLAN2_DIRECTION_PM_GAP_LEAD || 0.05),
    plan2DirectionTechHighConfidence: Number(process.env.POLYMARKET_PLAN2_DIRECTION_TECH_HIGH_CONFIDENCE || 0.68),
    plan2DirectionCompositeMinConfidence: Number(process.env.POLYMARKET_PLAN2_DIRECTION_COMPOSITE_MIN_CONFIDENCE || 0.62),
    plan2ProbeMinPmEdge: Number(process.env.POLYMARKET_PLAN2_PROBE_MIN_PM_EDGE || 0.04),
    plan2ProbeEnabled: process.env.POLYMARKET_PLAN2_PROBE_ENABLED !== 'false',
    plan2ProbeMinPrice: Number(process.env.POLYMARKET_PLAN2_PROBE_MIN_PRICE || 0.48),
    plan2ProbeMaxPrice: Number(process.env.POLYMARKET_PLAN2_PROBE_MAX_PRICE || 0.68),
    plan2ProbeMinConfidence: Number(process.env.POLYMARKET_PLAN2_PROBE_MIN_CONFIDENCE || 0.56),
    plan2ProbeMinEdge: Number(process.env.POLYMARKET_PLAN2_PROBE_MIN_EDGE || 0.005),
    plan2ProbeMinElapsedPct: Number(process.env.POLYMARKET_PLAN2_PROBE_MIN_ELAPSED_PCT || 0.08),
    plan2ProbeMaxElapsedPct: Number(process.env.POLYMARKET_PLAN2_PROBE_MAX_ELAPSED_PCT || 0.55),
    plan2ProbeSizeMultiplier: Number(process.env.POLYMARKET_PLAN2_PROBE_SIZE_MULTIPLIER || 0.18),
    plan2ProbeSizeMultiplier5m: Number(process.env.POLYMARKET_PLAN2_PROBE_SIZE_MULTIPLIER_5M || 0.32),
    plan2ProbeSizeMultiplier15m: Number(process.env.POLYMARKET_PLAN2_PROBE_SIZE_MULTIPLIER_15M || process.env.POLYMARKET_PLAN2_PROBE_SIZE_MULTIPLIER || 0.18),
    plan2ProbeUpgradeSizeMultiplier: Number(process.env.POLYMARKET_PLAN2_PROBE_UPGRADE_SIZE_MULTIPLIER || 1.10),
    plan2ProbeUpgradeEnabled5m: process.env.POLYMARKET_PLAN2_PROBE_UPGRADE_ENABLED_5M !== 'false',
    plan2ProbeUpgradeMinMs: Number(process.env.POLYMARKET_PLAN2_PROBE_UPGRADE_MIN_MS || 10000),
    plan2ProbeUpgradeMinMs5m: Number(process.env.POLYMARKET_PLAN2_PROBE_CONFIRM_MIN_MS_5M || process.env.POLYMARKET_PLAN2_PROBE_UPGRADE_MIN_MS_5M || 7000),
    plan2ProbeUpgradeMinMs15m: Number(process.env.POLYMARKET_PLAN2_PROBE_CONFIRM_MIN_MS_15M || process.env.POLYMARKET_PLAN2_PROBE_UPGRADE_MIN_MS_15M || process.env.POLYMARKET_PLAN2_PROBE_UPGRADE_MIN_MS || 10000),
    plan2ProbeUpgradeMaxMs: Number(process.env.POLYMARKET_PLAN2_PROBE_UPGRADE_MAX_MS || 35000),
    plan2ProbeUpgradeMaxMs5m: Number(process.env.POLYMARKET_PLAN2_PROBE_CONFIRM_MAX_MS_5M || process.env.POLYMARKET_PLAN2_PROBE_UPGRADE_MAX_MS_5M || 18000),
    plan2ProbeUpgradeMaxMs15m: Number(process.env.POLYMARKET_PLAN2_PROBE_CONFIRM_MAX_MS_15M || process.env.POLYMARKET_PLAN2_PROBE_UPGRADE_MAX_MS_15M || process.env.POLYMARKET_PLAN2_PROBE_UPGRADE_MAX_MS || 35000),
    plan2ProbeUpgradeMinPriceMove: Number(process.env.POLYMARKET_PLAN2_PROBE_UPGRADE_MIN_PRICE_MOVE || 0.025),
    plan2ProbeUpgradeMaxPrice: Number(process.env.POLYMARKET_PLAN2_PROBE_UPGRADE_MAX_PRICE || 0.72),
    plan2ProbeUpgradeMaxElapsedPct: Number(process.env.POLYMARKET_PLAN2_PROBE_UPGRADE_MAX_ELAPSED_PCT || 0.70),
    plan2ProbeUpdateScoreEnabled: process.env.POLYMARKET_PLAN2_PROBE_UPDATE_SCORE_ENABLED !== 'false',
    plan2ProbeUpdateScoreMin: Number(process.env.POLYMARKET_PLAN2_PROBE_UPDATE_SCORE_MIN || 0.65),
    plan2ProbeUpdatePriceScale: Number(process.env.POLYMARKET_PLAN2_PROBE_UPDATE_PRICE_SCALE || 0.05),
    plan2ProbeUpdateConfidenceScale: Number(process.env.POLYMARKET_PLAN2_PROBE_UPDATE_CONFIDENCE_SCALE || 0.08),
    plan2ProbeUpdateDistanceScale: Number(process.env.POLYMARKET_PLAN2_PROBE_UPDATE_DISTANCE_SCALE || 8),
    plan2LateCaptureBypassChop: process.env.POLYMARKET_PLAN2_LATE_CAPTURE_BYPASS_CHOP !== 'false',
    plan2LateCaptureUsePmLeadingPrice: process.env.POLYMARKET_PLAN2_LATE_CAPTURE_USE_PM_LEADING_PRICE !== 'false',
    plan2LateCaptureSafetyMargin: Number(process.env.POLYMARKET_PLAN2_LATE_CAPTURE_SAFETY_MARGIN || 0.025),
    plan2UltraLateCaptureSafetyMargin: Number(process.env.POLYMARKET_PLAN2_ULTRA_LATE_CAPTURE_SAFETY_MARGIN || 0.015),
    plan2LowPriceMinPrice: Number(process.env.POLYMARKET_PLAN2_LOW_PRICE_MIN_PRICE || 0.55),
    plan2LowPriceMinConfidence: Number(process.env.POLYMARKET_PLAN2_LOW_PRICE_MIN_CONFIDENCE || 0.66),
    plan2LowPriceMinEdge: Number(process.env.POLYMARKET_PLAN2_LOW_PRICE_MIN_EDGE || 0.10),
    plan2DownMinConfidence5m: Number(process.env.POLYMARKET_PLAN2_DOWN_MIN_CONFIDENCE_5M || 0.64),
    plan2DownMinConfidence15m: Number(process.env.POLYMARKET_PLAN2_DOWN_MIN_CONFIDENCE_15M || 0.63),
    plan2DownMinEdge: Number(process.env.POLYMARKET_PLAN2_DOWN_MIN_EDGE || 0.04),
    plan2RegimeFilterEnabled: process.env.POLYMARKET_PLAN2_REGIME_FILTER_ENABLED !== 'false',
    plan2ChopMaxDistanceBps: Number(process.env.POLYMARKET_PLAN2_CHOP_MAX_DISTANCE_BPS || 4),
    plan2ChopMaxPmEdge: Number(process.env.POLYMARKET_PLAN2_CHOP_MAX_PM_EDGE || 0.08),
    plan2ChopMinDirectionFlips: Number(process.env.POLYMARKET_PLAN2_CHOP_MIN_DIRECTION_FLIPS || 3),
    plan2ChopMaxTechConfidence: Number(process.env.POLYMARKET_PLAN2_CHOP_MAX_TECH_CONFIDENCE || 0.62),
    plan2ChopAllowProbe: process.env.POLYMARKET_PLAN2_CHOP_ALLOW_PROBE !== 'false',
    plan2ChopMainSizeScale: Number(process.env.POLYMARKET_PLAN2_CHOP_MAIN_SIZE_SCALE || 0.20),
    plan2RegimeMildSizeScale: Number(process.env.POLYMARKET_PLAN2_REGIME_MILD_SIZE_SCALE || 0.65),
    plan2RegimeSkipMainRisk: Number(process.env.POLYMARKET_PLAN2_REGIME_SKIP_MAIN_RISK || 6),
    plan2RegimeSkipAllRisk: Number(process.env.POLYMARKET_PLAN2_REGIME_SKIP_ALL_RISK || 8),
    plan2RegimeMaxSpread: Number(process.env.POLYMARKET_PLAN2_REGIME_MAX_SPREAD || 0.06),
    plan2RegimeMaxVolBps5m: Number(process.env.POLYMARKET_PLAN2_REGIME_MAX_VOL_BPS_5M || 18),
    plan2RegimeMaxVolBps15m: Number(process.env.POLYMARKET_PLAN2_REGIME_MAX_VOL_BPS_15M || 14),
    plan2FiveMinuteLockEnabled: process.env.POLYMARKET_PLAN2_FIVE_MINUTE_LOCK_ENABLED !== 'false',
    plan2FiveMinuteLockRequireLock: process.env.POLYMARKET_PLAN2_FIVE_MINUTE_LOCK_REQUIRE_LOCK === 'true',
    plan2FiveMinuteLockWeakScale: Number(process.env.POLYMARKET_PLAN2_FIVE_MINUTE_LOCK_WEAK_SCALE || 0.5),
    plan2FiveMinuteLockAllowProbeOnConflict: process.env.POLYMARKET_PLAN2_FIVE_MINUTE_LOCK_ALLOW_PROBE_ON_CONFLICT !== 'false',
    plan2FiveMinuteLockAllowProbeOnUnstable: process.env.POLYMARKET_PLAN2_FIVE_MINUTE_LOCK_ALLOW_PROBE_ON_UNSTABLE !== 'false',
    plan2FiveMinuteLockStatsLookbackDays: Number(process.env.POLYMARKET_PLAN2_FIVE_MINUTE_LOCK_STATS_LOOKBACK_DAYS || 14),
    plan2FiveMinuteLockStatsMinSamples: Number(process.env.POLYMARKET_PLAN2_FIVE_MINUTE_LOCK_STATS_MIN_SAMPLES || 5),
    plan2FiveMinuteLockMinHistoricalAccuracy: Number(process.env.POLYMARKET_PLAN2_FIVE_MINUTE_LOCK_MIN_HISTORICAL_ACCURACY || 0.52),
    plan2FiveMinuteLockDirectionBoostStrong: Number(process.env.POLYMARKET_PLAN2_FIVE_MINUTE_LOCK_DIRECTION_BOOST_STRONG || 0.06),
    plan2FiveMinuteLockDirectionBoostNormal: Number(process.env.POLYMARKET_PLAN2_FIVE_MINUTE_LOCK_DIRECTION_BOOST_NORMAL || 0.04),
    plan2FiveMinuteLockDirectionBoostWeak: Number(process.env.POLYMARKET_PLAN2_FIVE_MINUTE_LOCK_DIRECTION_BOOST_WEAK || 0.02),
    plan2FiveMinuteLockConflictPreferMinWeight: Number(process.env.POLYMARKET_PLAN2_FIVE_MINUTE_LOCK_CONFLICT_PREFER_MIN_WEIGHT || 0.7),
    plan2FiveMinuteLockStrongTpOffsetBonus: Number(process.env.POLYMARKET_PLAN2_FIVE_MINUTE_LOCK_STRONG_TP_OFFSET_BONUS || 0.02),
    plan2EntryMinElapsedPct: Number(process.env.POLYMARKET_PLAN2_ENTRY_MIN_ELAPSED_PCT || 0.08),
    plan2MaxEntryElapsedPct: Number(process.env.POLYMARKET_PLAN2_MAX_ENTRY_ELAPSED_PCT || 0),
    plan2MaxEntryElapsedPct5m: Number(process.env.POLYMARKET_PLAN2_MAX_ENTRY_ELAPSED_PCT_5M || 0.85),
    plan2MaxEntryElapsedPct15m: Number(process.env.POLYMARKET_PLAN2_MAX_ENTRY_ELAPSED_PCT_15M || 0.82),
    plan2TakeProfitOffset: Number(process.env.POLYMARKET_PLAN2_TAKE_PROFIT_OFFSET || 0.18),
    plan2TakeProfitEnabled: process.env.POLYMARKET_PLAN2_TAKE_PROFIT_ENABLED !== 'false',
    // 回撤止盈仅实验开关；Plan13 本版强制关闭。默认关，避免写进 2.5/2.6。
    plan2TrailingTakeProfitEnabled: process.env.POLYMARKET_PLAN2_TRAILING_TAKE_PROFIT_ENABLED === 'true',
    plan2TrailingTakeProfitOffset: Number(process.env.POLYMARKET_PLAN2_TRAILING_TAKE_PROFIT_OFFSET || 0.10),
    plan2StopLossOffset: Number(process.env.POLYMARKET_PLAN2_STOP_LOSS_OFFSET || 0.08),
    // 纸盘/实盘默认开启止损：expiry 均亏远大于 SL（本地 plan2 expiry≈-$16 vs SL≈-$4）
    plan2StopLossEnabled: process.env.POLYMARKET_PLAN2_STOP_LOSS_ENABLED !== 'false',
    plan2ProbeStopLossOffset5m: Number(process.env.POLYMARKET_PLAN2_PROBE_STOP_LOSS_OFFSET_5M || 0.16),
    plan2ProbeStopLossOffset15m: Number(process.env.POLYMARKET_PLAN2_PROBE_STOP_LOSS_OFFSET_15M || 0.14),
    plan2TakeProfitPrice: Number(process.env.POLYMARKET_PLAN2_TAKE_PROFIT_PRICE || 0.8),
    plan2HighEntryMinPrice: Number(process.env.POLYMARKET_PLAN2_HIGH_ENTRY_MIN_PRICE || 0.70),
    plan2HighTakeProfitPrice: Number(process.env.POLYMARKET_PLAN2_HIGH_TAKE_PROFIT_PRICE || 0.9),
    plan2HighPriceMinConfidence: Number(process.env.POLYMARKET_PLAN2_HIGH_PRICE_MIN_CONFIDENCE || 0.8),
    plan2StopLossPrice: Number(process.env.POLYMARKET_PLAN2_STOP_LOSS_PRICE || 0.3),
    plan2HighEntryDelayMs: Number(process.env.POLYMARKET_PLAN2_HIGH_ENTRY_DELAY_MS || 45000),
    plan2HighEntryDelayMs5m: Number(process.env.POLYMARKET_PLAN2_HIGH_ENTRY_DELAY_MS_5M || 6000),
    plan2HighEntryDelayMs15m: Number(process.env.POLYMARKET_PLAN2_HIGH_ENTRY_DELAY_MS_15M || process.env.POLYMARKET_PLAN2_HIGH_ENTRY_DELAY_MS || 15000),
    plan2DelayedEntryTtlMs5m: Number(process.env.POLYMARKET_PLAN2_DELAYED_ENTRY_TTL_MS_5M || 30000),
    plan2DelayedEntryTtlMs15m: Number(process.env.POLYMARKET_PLAN2_DELAYED_ENTRY_TTL_MS_15M || 120000),
    plan2LateCaptureEnabled: process.env.POLYMARKET_PLAN2_LATE_CAPTURE_ENABLED !== 'false',
    plan2LateCaptureMinElapsedPct: Number(process.env.POLYMARKET_PLAN2_LATE_CAPTURE_MIN_ELAPSED_PCT || 0.75),
    plan2LateCaptureMaxElapsedPct: Number(process.env.POLYMARKET_PLAN2_LATE_CAPTURE_MAX_ELAPSED_PCT || 0.96),
    plan2LateCaptureMinPrice: Number(process.env.POLYMARKET_PLAN2_LATE_CAPTURE_MIN_PRICE || 0.82),
    plan2LateCaptureMaxPrice: Number(process.env.POLYMARKET_PLAN2_LATE_CAPTURE_MAX_PRICE || 0.88),
    plan2LateCaptureMinDistanceBps: Number(process.env.POLYMARKET_PLAN2_LATE_CAPTURE_MIN_DISTANCE_BPS || 3),
    plan2LateCaptureMaxReverseBps: Number(process.env.POLYMARKET_PLAN2_LATE_CAPTURE_MAX_REVERSE_BPS || 3),
    plan2LateCaptureMinQuality: Number(process.env.POLYMARKET_PLAN2_LATE_CAPTURE_MIN_QUALITY || 0.60),
    plan2LateCaptureSizeMultiplier: Number(process.env.POLYMARKET_PLAN2_LATE_CAPTURE_SIZE_MULTIPLIER || 0.10),
    plan2LateCaptureRequireCalibratedEdge: process.env.POLYMARKET_PLAN2_LATE_CAPTURE_REQUIRE_CALIBRATED_EDGE === 'true',
    plan2LiveSyncPaperEnabled: process.env.POLYMARKET_PLAN2_LIVE_SYNC_PAPER_ENABLED !== 'false',
    // 入场默认同步关闭（实盘严格入场）；退出默认同步开启（及时止损）。可用 ENTRY/EXIT 显式覆盖。
    plan2LiveSyncPaperEntryEnabled: process.env.POLYMARKET_PLAN2_LIVE_SYNC_PAPER_ENTRY_ENABLED != null
      ? process.env.POLYMARKET_PLAN2_LIVE_SYNC_PAPER_ENTRY_ENABLED !== 'false'
      : false,
    plan2LiveSyncPaperExitEnabled: process.env.POLYMARKET_PLAN2_LIVE_SYNC_PAPER_EXIT_ENABLED != null
      ? process.env.POLYMARKET_PLAN2_LIVE_SYNC_PAPER_EXIT_ENABLED !== 'false'
      : process.env.POLYMARKET_PLAN2_LIVE_SYNC_PAPER_ENABLED !== 'false',
    // 显式开启才放宽纸面门控，避免未设 env 时默认 paper_relaxed（minEdge=0）抬高假 WR。
    plan2PaperRelaxedEnabled: process.env.POLYMARKET_PLAN2_PAPER_RELAXED_ENABLED === 'true',
    // Plan2 纸面成交 realism：默认要求 ask<=limit，避免无条件秒成抬高纸面 WR。
    plan2PaperRequireAskFillable: process.env.POLYMARKET_PLAN2_PAPER_REQUIRE_ASK_FILLABLE !== 'false',
    plan2PaperFillSlippageTicks: Number(process.env.POLYMARKET_PLAN2_PAPER_FILL_SLIPPAGE_TICKS || 1),
    plan2PaperFillTickSize: Number(process.env.POLYMARKET_PLAN2_PAPER_FILL_TICK_SIZE || 0.01),
    // 校准表默认优先 live，避免纸面高 WR 反哺 historyGate。
    plan2CalibrationPreferLive: process.env.POLYMARKET_PLAN2_CALIBRATION_PREFER_LIVE !== 'false',
    plan2ProbeHistoricalEdgeGateEnabled: process.env.POLYMARKET_PLAN2_PROBE_HISTORICAL_EDGE_GATE_ENABLED !== 'false',
    plan2ProbeHistoricalEdgeMinSamples: Number(process.env.POLYMARKET_PLAN2_PROBE_HISTORICAL_EDGE_MIN_SAMPLES || 20),
    plan2ProbeHistoricalEdgeMargin: Number(process.env.POLYMARKET_PLAN2_PROBE_HISTORICAL_EDGE_MARGIN || 0.01),
    plan2PaperRegimeFilterEnabled: process.env.POLYMARKET_PLAN2_PAPER_REGIME_FILTER_ENABLED !== 'false',
    // ≥82% 入场本地 stats 高 WR 仍负 EV；纸面默认压到 0.82 以下。
    plan2PaperEntryMaxPrice: Number(process.env.POLYMARKET_PLAN2_PAPER_ENTRY_MAX_PRICE || 0.82),
    plan2PaperProbeMaxPrice: Number(process.env.POLYMARKET_PLAN2_PAPER_PROBE_MAX_PRICE || 0.80),
    plan2PaperProbeMaxElapsedPct: Number(process.env.POLYMARKET_PLAN2_PAPER_PROBE_MAX_ELAPSED_PCT || 0.78),
    plan2PaperMinConfidence: Number(process.env.POLYMARKET_PLAN2_PAPER_MIN_CONFIDENCE || 0.52),
    plan2PaperMinEdge: Number(process.env.POLYMARKET_PLAN2_PAPER_MIN_EDGE || 0.04),
    plan2PaperDownMinConfidence: Number(process.env.POLYMARKET_PLAN2_PAPER_DOWN_MIN_CONFIDENCE || 0.52),
    plan2PaperDownMinEdge: Number(process.env.POLYMARKET_PLAN2_PAPER_DOWN_MIN_EDGE || 0),
    plan2PaperHighEntryMinPrice: Number(process.env.POLYMARKET_PLAN2_PAPER_HIGH_ENTRY_MIN_PRICE || 0.95),
    plan2PaperHighEntryDelayMs: Number(process.env.POLYMARKET_PLAN2_PAPER_HIGH_ENTRY_DELAY_MS || 0),
    plan2PaperHighEntryDelayMs5m: Number(process.env.POLYMARKET_PLAN2_PAPER_HIGH_ENTRY_DELAY_MS_5M || 0),
    plan2PaperHighEntryDelayMs15m: Number(process.env.POLYMARKET_PLAN2_PAPER_HIGH_ENTRY_DELAY_MS_15M || 0),
    plan2PaperFiveMinuteLockEnabled: process.env.POLYMARKET_PLAN2_PAPER_FIVE_MINUTE_LOCK_ENABLED !== 'false',
    plan2PaperLateCaptureRequireCalibratedEdge: process.env.POLYMARKET_PLAN2_PAPER_LATE_CAPTURE_REQUIRE_CALIBRATED_EDGE === 'true',
    plan2PaperLateCaptureMinElapsedPct: Number(process.env.POLYMARKET_PLAN2_PAPER_LATE_CAPTURE_MIN_ELAPSED_PCT || 0.65),
    plan2PaperLateCaptureMinQuality: Number(process.env.POLYMARKET_PLAN2_PAPER_LATE_CAPTURE_MIN_QUALITY || 0.35),
    plan2PaperLateCaptureMinDistanceBps: Number(process.env.POLYMARKET_PLAN2_PAPER_LATE_CAPTURE_MIN_DISTANCE_BPS || 1),
    plan2PaperLateCaptureMaxReverseBps: Number(process.env.POLYMARKET_PLAN2_PAPER_LATE_CAPTURE_MAX_REVERSE_BPS || 6),
    plan2PaperLateCaptureBypassChop: process.env.POLYMARKET_PLAN2_PAPER_LATE_CAPTURE_BYPASS_CHOP !== 'false',
    plan2PaperSettlementCapture90MinQuality: Number(process.env.POLYMARKET_PLAN2_PAPER_SETTLEMENT_CAPTURE_90_MIN_QUALITY || 0.30),
    plan2PaperSettlementCapture90MinDistanceBps: Number(process.env.POLYMARKET_PLAN2_PAPER_SETTLEMENT_CAPTURE_90_MIN_DISTANCE_BPS || 0.5),
    plan2PaperSettlementCapture90MaxReverseBps: Number(process.env.POLYMARKET_PLAN2_PAPER_SETTLEMENT_CAPTURE_90_MAX_REVERSE_BPS || 6),
    plan2PaperRegimeSkipMainRisk: Number(process.env.POLYMARKET_PLAN2_PAPER_REGIME_SKIP_MAIN_RISK || 5),
    plan2PaperRegimeSkipAllRisk: Number(process.env.POLYMARKET_PLAN2_PAPER_REGIME_SKIP_ALL_RISK || 7),
    plan2PaperRequirePmAlignment: process.env.POLYMARKET_PLAN2_PAPER_REQUIRE_PM_ALIGNMENT !== 'false',
    plan2PaperProbeMinConfidence: Number(process.env.POLYMARKET_PLAN2_PAPER_PROBE_MIN_CONFIDENCE || 0.52),
    plan2PaperProbeMinEdge: Number(process.env.POLYMARKET_PLAN2_PAPER_PROBE_MIN_EDGE || 0.001),
    plan2PaperMaxEntryElapsedPct5m: Number(process.env.POLYMARKET_PLAN2_PAPER_MAX_ENTRY_ELAPSED_PCT_5M || 0.88),
    plan2PaperMaxEntryElapsedPct15m: Number(process.env.POLYMARKET_PLAN2_PAPER_MAX_ENTRY_ELAPSED_PCT_15M || 0.86),
    plan2PaperMinMarketQuality: Number(process.env.POLYMARKET_PLAN2_PAPER_MIN_MARKET_QUALITY || 0.35),
    plan2PaperProbeMarketQuality: Number(process.env.POLYMARKET_PLAN2_PAPER_PROBE_MARKET_QUALITY || 0.28),
    plan2PaperChopAllowProbe: process.env.POLYMARKET_PLAN2_PAPER_CHOP_ALLOW_PROBE !== 'false',
    plan2PaperSustainedMomentumMinQuality: Number(process.env.POLYMARKET_PLAN2_PAPER_SUSTAINED_MOMENTUM_MIN_QUALITY || 0.38),
    plan2PaperSustainedMomentumMinDistanceBps5m: Number(process.env.POLYMARKET_PLAN2_PAPER_SUSTAINED_MOMENTUM_MIN_DISTANCE_BPS_5M || 5),
    plan2PaperSustainedMomentumMinDistanceBps15m: Number(process.env.POLYMARKET_PLAN2_PAPER_SUSTAINED_MOMENTUM_MIN_DISTANCE_BPS_15M || 5),
    plan2PaperSustainedMomentumMaxPrice5m: Number(process.env.POLYMARKET_PLAN2_PAPER_SUSTAINED_MOMENTUM_MAX_PRICE_5M || 0.82),
    plan2PaperSustainedMomentumMaxPrice15m: Number(process.env.POLYMARKET_PLAN2_PAPER_SUSTAINED_MOMENTUM_MAX_PRICE_15M || 0.80),
    plan2PaperSettlementCapture90MaxSecondsRemaining5m: Number(process.env.POLYMARKET_PLAN2_PAPER_SETTLEMENT_CAPTURE_90_MAX_SECONDS_REMAINING_5M || 180),
    plan2PaperSettlementCapture90MaxSecondsRemaining15m: Number(process.env.POLYMARKET_PLAN2_PAPER_SETTLEMENT_CAPTURE_90_MAX_SECONDS_REMAINING_15M || 240),
    plan2PaperKellyCapEnabled: process.env.POLYMARKET_PLAN2_PAPER_KELLY_CAP_ENABLED === 'true',
    plan2PaperMinOrderUsd: Number(process.env.POLYMARKET_PLAN2_PAPER_MIN_ORDER_USD || 1),
    plan2PaperOrderPct: Number(process.env.POLYMARKET_PLAN2_PAPER_ORDER_PCT || 0.03),
    plan2SettlementCapture90Enabled: process.env.POLYMARKET_PLAN2_SETTLEMENT_CAPTURE_90_ENABLED !== 'false',
    plan2SettlementCapture90MinPrice: Number(process.env.POLYMARKET_PLAN2_SETTLEMENT_CAPTURE_90_MIN_PRICE || 0.90),
    plan2SettlementCapture90MaxPrice: Number(process.env.POLYMARKET_PLAN2_SETTLEMENT_CAPTURE_90_MAX_PRICE || 0.92),
    plan2SettlementCapture90MinSecondsRemaining5m: Number(process.env.POLYMARKET_PLAN2_SETTLEMENT_CAPTURE_90_MIN_SECONDS_REMAINING_5M || 3),
    plan2SettlementCapture90MaxSecondsRemaining5m: Number(process.env.POLYMARKET_PLAN2_SETTLEMENT_CAPTURE_90_MAX_SECONDS_REMAINING_5M || 120),
    plan2SettlementCapture90MinSecondsRemaining15m: Number(process.env.POLYMARKET_PLAN2_SETTLEMENT_CAPTURE_90_MIN_SECONDS_REMAINING_15M || 5),
    plan2SettlementCapture90MaxSecondsRemaining15m: Number(process.env.POLYMARKET_PLAN2_SETTLEMENT_CAPTURE_90_MAX_SECONDS_REMAINING_15M || 180),
    plan2SettlementCapture90MinDistanceBps: Number(process.env.POLYMARKET_PLAN2_SETTLEMENT_CAPTURE_90_MIN_DISTANCE_BPS || 1),
    plan2SettlementCapture90UsePmLeadingPrice: process.env.POLYMARKET_PLAN2_SETTLEMENT_CAPTURE_90_USE_PM_LEADING_PRICE !== 'false',
    plan2SettlementCapture90MaxReverseBps: Number(process.env.POLYMARKET_PLAN2_SETTLEMENT_CAPTURE_90_MAX_REVERSE_BPS || 4),
    plan2SettlementCapture90MinQuality: Number(process.env.POLYMARKET_PLAN2_SETTLEMENT_CAPTURE_90_MIN_QUALITY || 0.40),
    plan2SettlementCapture90RequireCalibratedEdge: process.env.POLYMARKET_PLAN2_SETTLEMENT_CAPTURE_90_REQUIRE_CALIBRATED_EDGE === 'true',
    plan2SettlementCapture90SizeMultiplier: Number(process.env.POLYMARKET_PLAN2_SETTLEMENT_CAPTURE_90_SIZE_MULTIPLIER || 0.15),
    plan2SettlementCapture90TakeProfitPrice: Number(process.env.POLYMARKET_PLAN2_SETTLEMENT_CAPTURE_90_TAKE_PROFIT_PRICE || 0.99),
    plan2SettlementCapture90StopLossPrice: Number(process.env.POLYMARKET_PLAN2_SETTLEMENT_CAPTURE_90_STOP_LOSS_PRICE || 0.05),
    plan2UltraLateCaptureEnabled: process.env.POLYMARKET_PLAN2_ULTRA_LATE_CAPTURE_ENABLED === 'true',
    plan2UltraLateCaptureMinPrice: Number(process.env.POLYMARKET_PLAN2_ULTRA_LATE_CAPTURE_MIN_PRICE || 0.95),
    plan2UltraLateCaptureMaxPrice: Number(process.env.POLYMARKET_PLAN2_ULTRA_LATE_CAPTURE_MAX_PRICE || 0.99),
    plan2UltraLateCaptureMinSeconds5m: Number(process.env.POLYMARKET_PLAN2_ULTRA_LATE_CAPTURE_MIN_SECONDS_5M || 20),
    plan2UltraLateCaptureMaxSeconds5m: Number(process.env.POLYMARKET_PLAN2_ULTRA_LATE_CAPTURE_MAX_SECONDS_5M || 60),
    plan2UltraLateCaptureMinSeconds15m: Number(process.env.POLYMARKET_PLAN2_ULTRA_LATE_CAPTURE_MIN_SECONDS_15M || 45),
    plan2UltraLateCaptureMaxSeconds15m: Number(process.env.POLYMARKET_PLAN2_ULTRA_LATE_CAPTURE_MAX_SECONDS_15M || 90),
    plan2UltraLateCaptureMinDistanceBps: Number(process.env.POLYMARKET_PLAN2_ULTRA_LATE_CAPTURE_MIN_DISTANCE_BPS || 15),
    plan2UltraLateCaptureMaxReverseBps: Number(process.env.POLYMARKET_PLAN2_ULTRA_LATE_CAPTURE_MAX_REVERSE_BPS || 2),
    plan2UltraLateCaptureMinQuality: Number(process.env.POLYMARKET_PLAN2_ULTRA_LATE_CAPTURE_MIN_QUALITY || 0.65),
    plan2UltraLateCaptureSizeMultiplier: Number(process.env.POLYMARKET_PLAN2_ULTRA_LATE_CAPTURE_SIZE_MULTIPLIER || 0.06),
    plan2SustainedMomentumEnabled: process.env.POLYMARKET_PLAN2_SUSTAINED_MOMENTUM_ENABLED !== 'false',
    plan2SustainedMomentumMinPrice5m: Number(process.env.POLYMARKET_PLAN2_SUSTAINED_MOMENTUM_MIN_PRICE_5M || 0.72),
    plan2SustainedMomentumMinPrice15m: Number(process.env.POLYMARKET_PLAN2_SUSTAINED_MOMENTUM_MIN_PRICE_15M || 0.70),
    plan2SustainedMomentumMaxPrice5m: Number(process.env.POLYMARKET_PLAN2_SUSTAINED_MOMENTUM_MAX_PRICE_5M || 0.92),
    plan2SustainedMomentumMaxPrice15m: Number(process.env.POLYMARKET_PLAN2_SUSTAINED_MOMENTUM_MAX_PRICE_15M || 0.85),
    plan2SustainedMomentumMaxPullback5m: Number(process.env.POLYMARKET_PLAN2_SUSTAINED_MOMENTUM_MAX_PULLBACK_5M || 0.025),
    plan2SustainedMomentumMaxPullback15m: Number(process.env.POLYMARKET_PLAN2_SUSTAINED_MOMENTUM_MAX_PULLBACK_15M || 0.03),
    plan2SustainedMomentumMinElapsedPct5m: Number(process.env.POLYMARKET_PLAN2_SUSTAINED_MOMENTUM_MIN_ELAPSED_PCT_5M || 0.25),
    plan2SustainedMomentumMinElapsedPct15m: Number(process.env.POLYMARKET_PLAN2_SUSTAINED_MOMENTUM_MIN_ELAPSED_PCT_15M || 0.20),
    plan2SustainedMomentumMaxElapsedPct5m: Number(process.env.POLYMARKET_PLAN2_SUSTAINED_MOMENTUM_MAX_ELAPSED_PCT_5M || 0.72),
    plan2SustainedMomentumMaxElapsedPct15m: Number(process.env.POLYMARKET_PLAN2_SUSTAINED_MOMENTUM_MAX_ELAPSED_PCT_15M || 0.74),
    plan2SustainedMomentumMinSamples5m: Number(process.env.POLYMARKET_PLAN2_SUSTAINED_MOMENTUM_MIN_SAMPLES_5M || 4),
    plan2SustainedMomentumMinSamples15m: Number(process.env.POLYMARKET_PLAN2_SUSTAINED_MOMENTUM_MIN_SAMPLES_15M || 6),
    plan2SustainedMomentumMinHoldMs5m: Number(process.env.POLYMARKET_PLAN2_SUSTAINED_MOMENTUM_MIN_HOLD_MS_5M || 15000),
    plan2SustainedMomentumMinHoldMs15m: Number(process.env.POLYMARKET_PLAN2_SUSTAINED_MOMENTUM_MIN_HOLD_MS_15M || 30000),
    plan2SustainedMomentumMinDistanceBps5m: Number(process.env.POLYMARKET_PLAN2_SUSTAINED_MOMENTUM_MIN_DISTANCE_BPS_5M || 6),
    plan2SustainedMomentumMinDistanceBps15m: Number(process.env.POLYMARKET_PLAN2_SUSTAINED_MOMENTUM_MIN_DISTANCE_BPS_15M || 8),
    plan2SustainedMomentumMaxReverseBps5m: Number(process.env.POLYMARKET_PLAN2_SUSTAINED_MOMENTUM_MAX_REVERSE_BPS_5M || 4),
    plan2SustainedMomentumMaxReverseBps15m: Number(process.env.POLYMARKET_PLAN2_SUSTAINED_MOMENTUM_MAX_REVERSE_BPS_15M || 5),
    plan2SustainedMomentumSizeMultiplier5m: Number(process.env.POLYMARKET_PLAN2_SUSTAINED_MOMENTUM_SIZE_MULTIPLIER_5M || 1.35),
    plan2SustainedMomentumSizeMultiplier15m: Number(process.env.POLYMARKET_PLAN2_SUSTAINED_MOMENTUM_SIZE_MULTIPLIER_15M || 1.25),
    plan2StopLossReversalEnabled: process.env.POLYMARKET_PLAN2_STOP_LOSS_REVERSAL_ENABLED !== 'false',
    plan2StopLossReversalMinPrice: Number(process.env.POLYMARKET_PLAN2_STOP_LOSS_REVERSAL_MIN_PRICE || 0.48),
    plan2StopLossReversalMaxPrice: Number(process.env.POLYMARKET_PLAN2_STOP_LOSS_REVERSAL_MAX_PRICE || 0.68),
    plan2StopLossReversalMinConfidence: Number(process.env.POLYMARKET_PLAN2_STOP_LOSS_REVERSAL_MIN_CONFIDENCE || 0.58),
    plan2StopLossReversalMinEdge: Number(process.env.POLYMARKET_PLAN2_STOP_LOSS_REVERSAL_MIN_EDGE || 0.04),
    plan2StopLossReversalMaxElapsedPct: Number(process.env.POLYMARKET_PLAN2_STOP_LOSS_REVERSAL_MAX_ELAPSED_PCT || 0.78),
    plan2StopLossReversalMaxElapsedPct5m: Number(process.env.POLYMARKET_PLAN2_STOP_LOSS_REVERSAL_MAX_ELAPSED_PCT_5M || 0.75),
    plan2StopLossReversalMaxElapsedPct15m: Number(process.env.POLYMARKET_PLAN2_STOP_LOSS_REVERSAL_MAX_ELAPSED_PCT_15M || 0.80),
    plan2StopLossReversalSizeMultiplier: Number(process.env.POLYMARKET_PLAN2_STOP_LOSS_REVERSAL_SIZE_MULTIPLIER || 0.32),
    plan2StopLossReversalSizeMultiplier5m: Number(process.env.POLYMARKET_PLAN2_STOP_LOSS_REVERSAL_SIZE_MULTIPLIER_5M || 0.35),
    plan2StopLossReversalSizeMultiplier15m: Number(process.env.POLYMARKET_PLAN2_STOP_LOSS_REVERSAL_SIZE_MULTIPLIER_15M || 0.30),
    plan2StopLossReversalAfterDirectionStop: process.env.POLYMARKET_PLAN2_STOP_LOSS_REVERSAL_AFTER_DIRECTION_STOP === 'true',
    plan2LiveSlotLossCircuitEnabled: process.env.POLYMARKET_PLAN2_LIVE_SLOT_LOSS_CIRCUIT_ENABLED !== 'false',
    plan2LiveSlotLossCircuitMaxLosses: Number(process.env.POLYMARKET_PLAN2_LIVE_SLOT_LOSS_CIRCUIT_MAX_LOSSES || 2),
    // Plan2 经典 profile（main 风格）：默认关闭增强门控；入场/退出随 LIVE_SYNC_PAPER
    plan2ClassicHistoryGateEnabled: process.env.POLYMARKET_PLAN2_CLASSIC_HISTORY_GATE_ENABLED === 'true',
    plan2ClassicLossReasonGateEnabled: process.env.POLYMARKET_PLAN2_CLASSIC_LOSS_REASON_GATE_ENABLED === 'true',
    plan2ClassicSymbolWrSizingEnabled: process.env.POLYMARKET_PLAN2_CLASSIC_SYMBOL_WR_SIZING_ENABLED === 'true',
    plan2ClassicPaperRequireAskFillable: process.env.POLYMARKET_PLAN2_CLASSIC_PAPER_REQUIRE_ASK_FILLABLE === 'true',
    plan2ClassicPaperFillSlippageTicks: Number(process.env.POLYMARKET_PLAN2_CLASSIC_PAPER_FILL_SLIPPAGE_TICKS || 0),
    plan2ClassicLiveSyncPaperEntryEnabled: process.env.POLYMARKET_PLAN2_CLASSIC_LIVE_SYNC_PAPER_ENTRY_ENABLED != null
      ? process.env.POLYMARKET_PLAN2_CLASSIC_LIVE_SYNC_PAPER_ENTRY_ENABLED !== 'false'
      : null,
    plan2ClassicLiveSyncPaperExitEnabled: process.env.POLYMARKET_PLAN2_CLASSIC_LIVE_SYNC_PAPER_EXIT_ENABLED != null
      ? process.env.POLYMARKET_PLAN2_CLASSIC_LIVE_SYNC_PAPER_EXIT_ENABLED !== 'false'
      : null,
    // Plan2.5 增强 profile：默认开历史/亏损门控与分币仓位；入场严格、退出对齐纸面
    plan25HistoryWinRateGateEnabled: process.env.POLYMARKET_PLAN25_HISTORY_GATE_ENABLED != null
      ? process.env.POLYMARKET_PLAN25_HISTORY_GATE_ENABLED !== 'false'
      : null,
    plan25LossReasonGateEnabled: process.env.POLYMARKET_PLAN25_LOSS_REASON_GATE_ENABLED != null
      ? process.env.POLYMARKET_PLAN25_LOSS_REASON_GATE_ENABLED !== 'false'
      : null,
    plan25SymbolWrSizingEnabled: process.env.POLYMARKET_PLAN25_SYMBOL_WR_SIZING_ENABLED != null
      ? process.env.POLYMARKET_PLAN25_SYMBOL_WR_SIZING_ENABLED !== 'false'
      : null,
    plan25PaperRequireAskFillable: process.env.POLYMARKET_PLAN25_PAPER_REQUIRE_ASK_FILLABLE != null
      ? process.env.POLYMARKET_PLAN25_PAPER_REQUIRE_ASK_FILLABLE !== 'false'
      : null,
    plan25PaperFillSlippageTicks: process.env.POLYMARKET_PLAN25_PAPER_FILL_SLIPPAGE_TICKS != null
      ? Number(process.env.POLYMARKET_PLAN25_PAPER_FILL_SLIPPAGE_TICKS)
      : null,
    plan25LiveSyncPaperEntryEnabled: process.env.POLYMARKET_PLAN25_LIVE_SYNC_PAPER_ENTRY_ENABLED != null
      ? process.env.POLYMARKET_PLAN25_LIVE_SYNC_PAPER_ENTRY_ENABLED === 'true'
      : null,
    plan25LiveSyncPaperExitEnabled: process.env.POLYMARKET_PLAN25_LIVE_SYNC_PAPER_EXIT_ENABLED != null
      ? process.env.POLYMARKET_PLAN25_LIVE_SYNC_PAPER_EXIT_ENABLED !== 'false'
      : null,
    plan25RecoveryGateEnabled: process.env.POLYMARKET_PLAN25_RECOVERY_GATE_ENABLED === 'true',
    plan25RecoverySymbols: parseList(process.env.POLYMARKET_PLAN25_RECOVERY_SYMBOLS, 'ETH-USD,SOL-USD,XRP-USD'),
    plan25RecoveryTimeframes: parseList(process.env.POLYMARKET_PLAN25_RECOVERY_TIMEFRAMES, '15m'),
    plan25RecoveryDirections: parseList(process.env.POLYMARKET_PLAN25_RECOVERY_DIRECTIONS, 'down'),
    plan25RecoveryEntryTypes: parseList(process.env.POLYMARKET_PLAN25_RECOVERY_ENTRY_TYPES, 'sustained_momentum'),
    plan25RecoveryMinPrice: Number(process.env.POLYMARKET_PLAN25_RECOVERY_MIN_PRICE || 0.55),
    plan25RecoveryMaxPrice: Number(process.env.POLYMARKET_PLAN25_RECOVERY_MAX_PRICE || 0.86),
    plan25RecoveryMinEdge: Number(process.env.POLYMARKET_PLAN25_RECOVERY_MIN_EDGE || 0.02),
    // Plan2.5 live entry-max / ask-chase. Default ON for wallet safety (doc/safe package);
    // set POLYMARKET_PLAN2_5_LIVE_ENTRY_MAX_ENABLED=false only for explicit paper-parity chase.
    plan2_5LiveEntryMaxEnabled: process.env.POLYMARKET_PLAN2_5_LIVE_ENTRY_MAX_ENABLED !== 'false',
    plan2_5EntryMaxPrice: Number(
      process.env.POLYMARKET_PLAN2_5_ENTRY_MAX_PRICE
      || process.env.POLYMARKET_PLAN2_5_ENTRY_HARD_MAX_PRICE
      || 0.88
    ),
    plan2_5EntryHardMaxPrice: Number(process.env.POLYMARKET_PLAN2_5_ENTRY_HARD_MAX_PRICE || 0.92),
    plan2ReversalRequirePmAlign: process.env.POLYMARKET_PLAN2_REVERSAL_REQUIRE_PM_ALIGN !== 'false',
    plan2ReversalChopMinConfidence: Number(process.env.POLYMARKET_PLAN2_REVERSAL_CHOP_MIN_CONFIDENCE || 0.66),
    plan2SustainedMomentumMinQuality: Number(process.env.POLYMARKET_PLAN2_SUSTAINED_MOMENTUM_MIN_QUALITY || 0.42),
    // 默认关闭 dynamic hold，避免软逻辑延迟止损（止盈可慢、止损必须及时）。
    plan2DynamicExitEnabled: process.env.POLYMARKET_PLAN2_DYNAMIC_EXIT === 'true',
    plan2ExitReverseConfidence: Number(process.env.POLYMARKET_PLAN2_EXIT_REVERSE_CONFIDENCE || 0.56),
    plan2ExitHoldConfidence: Number(process.env.POLYMARKET_PLAN2_EXIT_HOLD_CONFIDENCE || 0.60),
    plan2ExitHoldConfidenceProbe: Number(process.env.POLYMARKET_PLAN2_EXIT_HOLD_CONFIDENCE_PROBE || 0.54),
    plan2ExitWeakConfidence: Number(process.env.POLYMARKET_PLAN2_EXIT_WEAK_CONFIDENCE || 0.58),
    plan2ExitLockAlignedHoldDelta: Number(process.env.POLYMARKET_PLAN2_EXIT_LOCK_ALIGNED_HOLD_DELTA || -0.04),
    plan2ExitLockConflictReverseDelta: Number(process.env.POLYMARKET_PLAN2_EXIT_LOCK_CONFLICT_REVERSE_DELTA || -0.06),
    plan2ExitLockStrongConflictReverseDelta: Number(process.env.POLYMARKET_PLAN2_EXIT_LOCK_STRONG_CONFLICT_REVERSE_DELTA || -0.08),
    plan2ExitHardStopOffset: Number(process.env.POLYMARKET_PLAN2_EXIT_HARD_STOP_OFFSET || 0.22),
    plan2MinHoldBeforeExitMs5m: Number(process.env.POLYMARKET_PLAN2_MIN_HOLD_BEFORE_EXIT_MS_5M || 120000),
    plan3Enabled: process.env.POLYMARKET_PLAN3_ENABLED === 'true',
    plan3LiveEnabled: process.env.POLYMARKET_PLAN3_LIVE_ENABLED === 'true',
    plan3LiveWideBandEnabled: process.env.POLYMARKET_PLAN3_LIVE_WIDE_BAND_ENABLED !== 'false',
    plan3LiveWideMinPrice: Number(process.env.POLYMARKET_PLAN3_LIVE_WIDE_MIN_PRICE || 0.93),
    plan3LiveWideMaxPrice: Number(process.env.POLYMARKET_PLAN3_LIVE_WIDE_MAX_PRICE || 0.99),
    plan3LiveWideMinSecondsRemaining5m: Number(process.env.POLYMARKET_PLAN3_LIVE_WIDE_MIN_SECONDS_REMAINING_5M || 20),
    plan3LiveWideMaxSecondsRemaining5m: Number(process.env.POLYMARKET_PLAN3_LIVE_WIDE_MAX_SECONDS_REMAINING_5M || 120),
    plan3LiveWideMinSecondsRemaining15m: Number(process.env.POLYMARKET_PLAN3_LIVE_WIDE_MIN_SECONDS_REMAINING_15M || 30),
    plan3LiveWideMaxSecondsRemaining15m: Number(process.env.POLYMARKET_PLAN3_LIVE_WIDE_MAX_SECONDS_REMAINING_15M || 180),
    plan3LiveWideMaxReverseBps: Number(process.env.POLYMARKET_PLAN3_LIVE_WIDE_MAX_REVERSE_BPS || 4),
    plan3LiveWideMaxSpread: Number(process.env.POLYMARKET_PLAN3_LIVE_WIDE_MAX_SPREAD || 0.08),
    plan3PaperFillEnabled: process.env.POLYMARKET_PLAN3_PAPER_FILL_ENABLED !== 'false',
    // 默认 false：纸面不再乐观 direct-fill；需显式 =true 才秒成。
    plan3PaperDirectFill: process.env.POLYMARKET_PLAN3_PAPER_DIRECT_FILL === 'true',
    // 纸面成交价默认模拟 FAK bump（半程步数），避免按理想限价记账。
    plan3PaperSimulateFakBump: process.env.POLYMARKET_PLAN3_PAPER_SIMULATE_FAK_BUMP !== 'false',
    plan3PaperMinOrderUsd: Number(process.env.POLYMARKET_PLAN3_PAPER_MIN_ORDER_USD || 1),
    plan3PaperMaxOrderPct: Number(process.env.POLYMARKET_PLAN3_PAPER_MAX_ORDER_PCT || 0.05),
    plan3FillTickSize: Number(process.env.POLYMARKET_PLAN3_FILL_TICK_SIZE || 0.01),
    plan3PaperRelaxedEnabled: process.env.POLYMARKET_PLAN3_PAPER_RELAXED_ENABLED !== 'false',
    plan3PaperMaxSecondsRemaining5m: Number(process.env.POLYMARKET_PLAN3_PAPER_MAX_SECONDS_REMAINING_5M || 45),
    plan3PaperMaxSecondsRemaining15m: Number(process.env.POLYMARKET_PLAN3_PAPER_MAX_SECONDS_REMAINING_15M || 90),
    plan3PaperMinDistanceBps5m: Number(process.env.POLYMARKET_PLAN3_PAPER_MIN_DISTANCE_BPS_5M || 8),
    plan3PaperMinDistanceBps15m: Number(process.env.POLYMARKET_PLAN3_PAPER_MIN_DISTANCE_BPS_15M || 12),
    plan3PaperMinDirectionalBps: Number(process.env.POLYMARKET_PLAN3_PAPER_MIN_DIRECTIONAL_BPS || 0.5),
    plan3PaperMinPrice: Number(process.env.POLYMARKET_PLAN3_PAPER_MIN_PRICE || 0.85),
    plan3PaperWideBandEnabled: process.env.POLYMARKET_PLAN3_PAPER_WIDE_BAND_ENABLED !== 'false',
    plan3PaperWideMinPrice: Number(process.env.POLYMARKET_PLAN3_PAPER_WIDE_MIN_PRICE || 0.93),
    plan3PaperWideMaxPrice: Number(process.env.POLYMARKET_PLAN3_PAPER_WIDE_MAX_PRICE || 0.998),
    plan3PaperWideMinSecondsRemaining5m: Number(process.env.POLYMARKET_PLAN3_PAPER_WIDE_MIN_SECONDS_REMAINING_5M || 12),
    plan3PaperWideMinSecondsRemaining15m: Number(process.env.POLYMARKET_PLAN3_PAPER_WIDE_MIN_SECONDS_REMAINING_15M || 12),
    plan3PaperWideMaxSecondsRemaining5m: Number(process.env.POLYMARKET_PLAN3_PAPER_WIDE_MAX_SECONDS_REMAINING_5M || 120),
    plan3PaperWideMaxSecondsRemaining15m: Number(process.env.POLYMARKET_PLAN3_PAPER_WIDE_MAX_SECONDS_REMAINING_15M || 180),
    plan3Paper15mEnabled: process.env.POLYMARKET_PLAN3_PAPER_15M_ENABLED !== 'false',
    plan3PaperBandStatsGateEnabled: process.env.POLYMARKET_PLAN3_PAPER_BAND_STATS_GATE_ENABLED !== 'false',
    plan3PaperMinMarketQuality: Number(process.env.POLYMARKET_PLAN3_PAPER_MIN_MARKET_QUALITY || 0.45),
    plan3PaperMaxSpread: Number(process.env.POLYMARKET_PLAN3_PAPER_MAX_SPREAD || 0.03),
    plan3PaperWideMaxSpread: Number(process.env.POLYMARKET_PLAN3_PAPER_WIDE_MAX_SPREAD || 0.08),
    plan3PaperWideMidSpread: Number(process.env.POLYMARKET_PLAN3_PAPER_WIDE_MID_SPREAD || 0.06),
    plan3PaperWideSkipSpreadCheck: process.env.POLYMARKET_PLAN3_PAPER_WIDE_SKIP_SPREAD_CHECK === 'true',
    plan3PaperWideMaxReverseBps: Number(process.env.POLYMARKET_PLAN3_PAPER_WIDE_MAX_REVERSE_BPS || 4),
    plan3PaperUsePmLeadingPrice: process.env.POLYMARKET_PLAN3_PAPER_USE_PM_LEADING_PRICE !== 'false',
    plan3OpportunityLogEnabled: process.env.POLYMARKET_PLAN3_OPPORTUNITY_LOG_ENABLED !== 'false',
    plan3OpportunityLogMaxEntries: Number(process.env.POLYMARKET_PLAN3_OPPORTUNITY_LOG_MAX_ENTRIES || 400),
    plan3FastLoopMs: Number(process.env.POLYMARKET_PLAN3_FAST_LOOP_MS || 1000),
    plan3MinSecondsRemaining5m: Number(process.env.POLYMARKET_PLAN3_MIN_SECONDS_REMAINING_5M || 3),
    plan3MaxSecondsRemaining5m: Number(process.env.POLYMARKET_PLAN3_MAX_SECONDS_REMAINING_5M || 20),
    plan3MinSecondsRemaining15m: Number(process.env.POLYMARKET_PLAN3_MIN_SECONDS_REMAINING_15M || 5),
    plan3MaxSecondsRemaining15m: Number(process.env.POLYMARKET_PLAN3_MAX_SECONDS_REMAINING_15M || 45),
    plan3MinDistanceBps5m: Number(process.env.POLYMARKET_PLAN3_MIN_DISTANCE_BPS_5M || 18),
    plan3MinDistanceBps15m: Number(process.env.POLYMARKET_PLAN3_MIN_DISTANCE_BPS_15M || 25),
    plan3MaxReverseBps: Number(process.env.POLYMARKET_PLAN3_MAX_REVERSE_BPS || 2),
    plan3ReverseLookbackSeconds: Number(process.env.POLYMARKET_PLAN3_REVERSE_LOOKBACK_SECONDS || 3),
    plan3DynamicSettlementEnabled: process.env.POLYMARKET_PLAN3_DYNAMIC_SETTLEMENT_ENABLED === 'true',
    plan3PaperDynamicSettlementEnabled: process.env.POLYMARKET_PLAN3_PAPER_DYNAMIC_SETTLEMENT_ENABLED === 'true',
    plan3DynamicSafetyMultiplier: Number(process.env.POLYMARKET_PLAN3_DYNAMIC_SAFETY_MULTIPLIER || 2.0),
    plan3DynamicMinVolatilityBpsPerSecond: Number(process.env.POLYMARKET_PLAN3_DYNAMIC_MIN_VOLATILITY_BPS_PER_SECOND || 0.05),
    plan3EntryConfirmationEnabled: process.env.POLYMARKET_PLAN3_ENTRY_CONFIRMATION_ENABLED !== 'false',
    plan3RequirePmTechAlignment: process.env.POLYMARKET_PLAN3_REQUIRE_PM_TECH_ALIGNMENT !== 'false',
    plan3ConfirmationMinSamples: Number(process.env.POLYMARKET_PLAN3_CONFIRMATION_MIN_SAMPLES || 4),
    plan3ConfirmationLookbackSamples: Number(process.env.POLYMARKET_PLAN3_CONFIRMATION_LOOKBACK_SAMPLES || 10),
    plan3ConfirmationMinStableMs5m: Number(process.env.POLYMARKET_PLAN3_CONFIRMATION_MIN_STABLE_MS_5M || 6000),
    plan3ConfirmationMinStableMs15m: Number(process.env.POLYMARKET_PLAN3_CONFIRMATION_MIN_STABLE_MS_15M || 12000),
    plan3ConfirmationMaxPmDeterioration: Number(process.env.POLYMARKET_PLAN3_CONFIRMATION_MAX_PM_DETERIORATION || 0.02),
    plan3MinPrice: Number(process.env.POLYMARKET_PLAN3_MIN_PRICE || 0.985),
    plan3MaxPrice: Number(process.env.POLYMARKET_PLAN3_MAX_PRICE || 0.998),
    plan3EarlyCaptureEnabled: process.env.POLYMARKET_PLAN3_EARLY_CAPTURE_ENABLED !== 'false',
    plan3EarlyCaptureLiveEnabled: process.env.POLYMARKET_PLAN3_EARLY_CAPTURE_LIVE_ENABLED === 'true',
    plan3EarlyMinPrice: Number(process.env.POLYMARKET_PLAN3_EARLY_MIN_PRICE || 0.90),
    plan3EarlyMaxPrice: Number(process.env.POLYMARKET_PLAN3_EARLY_MAX_PRICE || 0.989),
    plan3EarlyMinSecondsRemaining5m: Number(process.env.POLYMARKET_PLAN3_EARLY_MIN_SECONDS_REMAINING_5M || 46),
    plan3EarlyMaxSecondsRemaining5m: Number(process.env.POLYMARKET_PLAN3_EARLY_MAX_SECONDS_REMAINING_5M || 120),
    plan3EarlyMinSecondsRemaining15m: Number(process.env.POLYMARKET_PLAN3_EARLY_MIN_SECONDS_REMAINING_15M || 91),
    plan3EarlyMaxSecondsRemaining15m: Number(process.env.POLYMARKET_PLAN3_EARLY_MAX_SECONDS_REMAINING_15M || 180),
    plan3EarlyMinDistanceBps5m: Number(process.env.POLYMARKET_PLAN3_EARLY_MIN_DISTANCE_BPS_5M || 18),
    plan3EarlyMinDistanceBps15m: Number(process.env.POLYMARKET_PLAN3_EARLY_MIN_DISTANCE_BPS_15M || 25),
    plan3EarlyMinDirectionalBps: Number(process.env.POLYMARKET_PLAN3_EARLY_MIN_DIRECTIONAL_BPS || 8),
    plan3MinMarketQuality: Number(process.env.POLYMARKET_PLAN3_MIN_MARKET_QUALITY || 0.65),
    plan3MaxSpread: Number(process.env.POLYMARKET_PLAN3_MAX_SPREAD || 0.01),
    plan3QuoteSumMin: Number(process.env.POLYMARKET_PLAN3_QUOTE_SUM_MIN || 0.95),
    plan3QuoteSumMax: Number(process.env.POLYMARKET_PLAN3_QUOTE_SUM_MAX || 1.08),
    plan3PriceMode: process.env.POLYMARKET_PLAN3_PRICE_MODE || 'balanced',
    plan3PriceConservative: Number(process.env.POLYMARKET_PLAN3_PRICE_CONSERVATIVE || 0.992),
    plan3PriceBalanced: Number(process.env.POLYMARKET_PLAN3_PRICE_BALANCED || 0.995),
    plan3PriceAggressive: Number(process.env.POLYMARKET_PLAN3_PRICE_AGGRESSIVE || 0.998),
    plan3OrderPct: Number(process.env.POLYMARKET_PLAN3_ORDER_PCT || 0.003),
    plan3ProbSizingEnabled: process.env.POLYMARKET_PLAN3_PROB_SIZING_ENABLED === 'true',
    plan3ProbSizingReferenceOrderUsd: Number(process.env.POLYMARKET_PLAN3_PROB_SIZING_REFERENCE_ORDER_USD || 100),
    plan3ProbSizingReferenceEquity: Number(process.env.POLYMARKET_PLAN3_PROB_SIZING_REFERENCE_EQUITY || 500),
    plan3ProbSizingReferencePrice: Number(process.env.POLYMARKET_PLAN3_PROB_SIZING_REFERENCE_PRICE || 0.99),
    plan3ProbSizingCoeff: process.env.POLYMARKET_PLAN3_PROB_SIZING_COEFF
      ? Number(process.env.POLYMARKET_PLAN3_PROB_SIZING_COEFF)
      : null,
    plan3MaxOrderPct: Number(process.env.POLYMARKET_PLAN3_MAX_ORDER_PCT || 0.10),
    plan3MinOrderUsd: Number(process.env.POLYMARKET_PLAN3_MIN_ORDER_USD || 50),
    plan3BandStatsGateEnabled: process.env.POLYMARKET_PLAN3_BAND_STATS_GATE_ENABLED !== 'false',
    plan3BandStatsMinSamples: Number(process.env.POLYMARKET_PLAN3_BAND_STATS_MIN_SAMPLES || 30),
    plan3BandStatsMargin: Number(process.env.POLYMARKET_PLAN3_BAND_STATS_MARGIN || 0.005),
    plan3BandStatsLookbackDays: Number(process.env.POLYMARKET_PLAN3_BAND_STATS_LOOKBACK_DAYS || 30),
    plan3MergePlan35History: process.env.POLYMARKET_PLAN3_MERGE_PLAN35_HISTORY !== 'false',
    plan3MaxSlotExposurePct: Number(process.env.POLYMARKET_PLAN3_MAX_SLOT_EXPOSURE_PCT || 0.01),
    plan3BandStatsGateEnabled: process.env.POLYMARKET_PLAN3_BAND_STATS_GATE_ENABLED !== 'false',
    plan3BandStatsMinSamples: Number(process.env.POLYMARKET_PLAN3_BAND_STATS_MIN_SAMPLES || 30),
    plan3BandStatsMargin: Number(process.env.POLYMARKET_PLAN3_BAND_STATS_MARGIN || 0.005),
    plan3BandStatsLookbackDays: Number(process.env.POLYMARKET_PLAN3_BAND_STATS_LOOKBACK_DAYS || 30),
    // 实盘决策优先用 live-only 档位统计；样本不足回退 all。
    plan3BandStatsPreferLive: process.env.POLYMARKET_PLAN3_BAND_STATS_PREFER_LIVE !== 'false',
    plan3BandStatsSource: process.env.POLYMARKET_PLAN3_BAND_STATS_SOURCE || null,
    // EV 门控用的预期 bump 步数；未设时取 liveFakBumpSteps/2。
    plan3BandStatsFillBumpSteps: process.env.POLYMARKET_PLAN3_BAND_STATS_FILL_BUMP_STEPS
      ? Number(process.env.POLYMARKET_PLAN3_BAND_STATS_FILL_BUMP_STEPS)
      : null,
    plan3DailyLossLimitPct: Number(process.env.POLYMARKET_PLAN3_DAILY_LOSS_LIMIT_PCT || 0.01),
    plan3StopAfterOneLoss: process.env.POLYMARKET_PLAN3_STOP_AFTER_ONE_LOSS !== 'false',
    plan3MaxOrdersPerSlot: Number(process.env.POLYMARKET_PLAN3_MAX_ORDERS_PER_SLOT || 1),
    plan3OrderTtlMs5m: Number(process.env.POLYMARKET_PLAN3_ORDER_TTL_MS_5M || 3000),
    plan3OrderTtlMs15m: Number(process.env.POLYMARKET_PLAN3_ORDER_TTL_MS_15M || 5000),
    plan3LiveMaxOrderUsd: Number(process.env.POLYMARKET_PLAN3_LIVE_MAX_ORDER_USD || process.env.POLYMARKET_PLAN3_PROB_SIZING_REFERENCE_ORDER_USD || 100),
    plan3LiveMaxOrderEquityPct: Number(process.env.POLYMARKET_PLAN3_LIVE_MAX_ORDER_EQUITY_PCT || process.env.POLYMARKET_PLAN3_MAX_ORDER_PCT || 0.10),
    plan3LiveImmediateOnly: process.env.POLYMARKET_PLAN3_LIVE_IMMEDIATE_ONLY !== 'false',
    plan3LiveFakBumpSteps: Number(process.env.POLYMARKET_PLAN3_LIVE_FAK_BUMP_STEPS || 4),
    plan3LiveBlockedRetryAfterMs: Number(process.env.POLYMARKET_PLAN3_LIVE_BLOCKED_RETRY_AFTER_MS || 2000),
    plan3LivePendingTtlMs: Number(process.env.POLYMARKET_PLAN3_LIVE_PENDING_TTL_MS || 4000),
    // Plan3.6 热门侧 FAK：默认对齐 Plan5 多档追 ask（旧默认 4 + 误用 20¢ 上限 → 几乎无法 bump）
    plan3_6LiveFakBumpSteps: Number(
      process.env.POLYMARKET_PLAN3_6_LIVE_FAK_BUMP_STEPS
      || process.env.POLYMARKET_PLAN3_LIVE_FAK_BUMP_STEPS
      || 8
    ),
    plan3LiveMinOrderMaxEquityPct: Number(process.env.POLYMARKET_PLAN3_LIVE_MIN_ORDER_MAX_EQUITY_PCT || 0.25),
    plan3MaxExecutionErrorsPerDay: Number(process.env.POLYMARKET_PLAN3_MAX_EXECUTION_ERRORS_PER_DAY || 3),
    plan3LossReversalLookbackMs: Number(process.env.POLYMARKET_PLAN3_LOSS_REVERSAL_LOOKBACK_MS || 300000),
    plan3LossReversalExtremePrice: Number(process.env.POLYMARKET_PLAN3_LOSS_REVERSAL_EXTREME_PRICE || 0.95),
    plan3LossHighEntryPrice: Number(process.env.POLYMARKET_PLAN3_LOSS_HIGH_ENTRY_PRICE || 0.97),
    plan3LossLateSeconds: Number(process.env.POLYMARKET_PLAN3_LOSS_LATE_SECONDS || 15),
    plan3EventPaperEnabled: process.env.POLYMARKET_PLAN3_EVENT_PAPER_ENABLED !== 'false',
    // Keep the engine running to reconcile old orders while blocking new paper exposure.
    plan3EventNewEntriesEnabled: process.env.POLYMARKET_PLAN3_EVENT_NEW_ENTRIES_ENABLED === 'true',
    plan3EventObserveEnabled: process.env.POLYMARKET_PLAN3_EVENT_OBSERVE_ENABLED === 'true',
    plan3EventsDiscoveryMs: Number(process.env.POLYMARKET_PLAN3_EVENTS_DISCOVERY_MS || 300000),
    plan3EventStartingCash: Number(process.env.POLYMARKET_PLAN3_EVENT_STARTING_CASH || 500),
    plan3EventMinPrice: Number(process.env.POLYMARKET_PLAN3_EVENT_MIN_PRICE || 0.93),
    plan3EventMaxPrice: Number(process.env.POLYMARKET_PLAN3_EVENT_MAX_PRICE || 0.99),
    plan3EventMaxSpread: Number(process.env.POLYMARKET_PLAN3_EVENT_MAX_SPREAD || 0.03),
    plan3EventCapitalPct: Number(process.env.POLYMARKET_PLAN3_EVENT_CAPITAL_PCT || 0.01),
    plan3EventMinOrderUsd: Number(process.env.POLYMARKET_PLAN3_EVENT_MIN_ORDER_USD || 5),
    plan3EventMaxOrderUsd: Number(process.env.POLYMARKET_PLAN3_EVENT_MAX_ORDER_USD || 10),
    plan3EventConfirmationSnapshots: Number(process.env.POLYMARKET_PLAN3_EVENT_CONFIRMATION_SNAPSHOTS || 3),
    plan3EventConfirmationTtlMs: Number(process.env.POLYMARKET_PLAN3_EVENT_CONFIRMATION_TTL_MS || 900000),
    plan3EventMaxConfirmationRange: Number(process.env.POLYMARKET_PLAN3_EVENT_MAX_CONFIRMATION_RANGE || 0.015),
    plan3EventMaxDeterioration: Number(process.env.POLYMARKET_PLAN3_EVENT_MAX_DETERIORATION || 0.01),
    plan3EventEventsPerCategoryTick: Number(process.env.POLYMARKET_PLAN3_EVENT_EVENTS_PER_CATEGORY_TICK || 5),
    plan3EventWeatherPreEndHours: Number(process.env.POLYMARKET_PLAN3_EVENT_WEATHER_PRE_END_HOURS || 18),
    plan3EventWeatherPostEndHours: Number(process.env.POLYMARKET_PLAN3_EVENT_WEATHER_POST_END_HOURS || 12),
    plan3EventSportsPreStartMinutes: Number(process.env.POLYMARKET_PLAN3_EVENT_SPORTS_PRE_START_MINUTES || 0),
    plan3EventSportsPostStartHours: Number(process.env.POLYMARKET_PLAN3_EVENT_SPORTS_POST_START_HOURS || 6),
    plan3EventWeatherFeeRate: Number(process.env.POLYMARKET_PLAN3_EVENT_WEATHER_FEE_RATE || 0.05),
    plan3EventSportsFeeRate: Number(process.env.POLYMARKET_PLAN3_EVENT_SPORTS_FEE_RATE || 0.05),
    plan3EventRequestTimeoutMs: Number(process.env.POLYMARKET_PLAN3_EVENT_REQUEST_TIMEOUT_MS || 10000),
    plan3EventLoopMs: Number(process.env.POLYMARKET_PLAN3_EVENT_LOOP_MS || 30000),
    // Plan3.5 已并入 Plan3 的 99¢ 历史校准；只保留旧状态用于分析。
    plan3_5Enabled: process.env.POLYMARKET_PLAN3_5_ENABLED === 'true',
    plan3_5LiveEnabled: process.env.POLYMARKET_PLAN3_5_LIVE_ENABLED === 'true',
    plan3_5MinPrice: Number(process.env.POLYMARKET_PLAN3_5_MIN_PRICE || 0.99),
    plan3_5MaxSecondsRemaining: Number(process.env.POLYMARKET_PLAN3_5_MAX_SECONDS_REMAINING || 60),
    plan3_5MinSecondsRemaining: Number(process.env.POLYMARKET_PLAN3_5_MIN_SECONDS_REMAINING || 1),
    plan3_5SizePct: Number(process.env.POLYMARKET_PLAN3_5_SIZE_PCT || 0.20),
    plan3_5MinOrderUsd: Number(process.env.POLYMARKET_PLAN3_5_MIN_ORDER_USD || 1),
    plan3_5FastLoopMs: Number(process.env.POLYMARKET_PLAN3_5_FAST_LOOP_MS || 1000),
    // Plan2.6 — Plan2.5 clone with tighter entry allowlist (paper on; live when LIVE_ENABLED + manual start).
    // Historical live ROI is significantly negative; require an explicit opt-in.
    plan2_6Enabled: process.env.POLYMARKET_PLAN2_6_ENABLED === 'true',
    plan2_6LiveEnabled: process.env.POLYMARKET_PLAN2_6_LIVE_ENABLED === 'true',
    plan2_6LateCaptureEnabled: process.env.POLYMARKET_PLAN2_6_LATE_CAPTURE_ENABLED !== 'false',
    // Strict late: only allow late_capture when entry ≥ this (default 0.90).
    plan2_6LateCaptureMinPrice: Number(process.env.POLYMARKET_PLAN2_6_LATE_CAPTURE_MIN_PRICE || 0.90),
    // Cap late favorites ≤ live entry max — 0.93–0.97 hold-to-settlement wipeouts.
    plan2_6LateCaptureMaxPrice: Number(process.env.POLYMARKET_PLAN2_6_LATE_CAPTURE_MAX_PRICE || 0.90),
    // Soft late (default off): size-down weak late (< min) instead of hard-skip.
    plan2_6LateCaptureSoftMode: process.env.POLYMARKET_PLAN2_6_LATE_CAPTURE_SOFT_MODE === 'true',
    plan2_6LateCaptureSoftSizeScale: Number(process.env.POLYMARKET_PLAN2_6_LATE_CAPTURE_SOFT_SIZE_SCALE || 0.35),
    // Plan2.6 live ask-chase intercept. Default ON — blocking ≥0.90–0.93 chase protects bankroll;
    // set POLYMARKET_PLAN2_6_LIVE_ENTRY_MAX_ENABLED=false only for explicit paper-parity experiments.
    plan2_6LiveEntryMaxEnabled: process.env.POLYMARKET_PLAN2_6_LIVE_ENTRY_MAX_ENABLED !== 'false',
    // Live chase ceiling. Do not reuse plan2EntryMax=0.62.
    plan2_6EntryMaxPrice: Number(
      process.env.POLYMARKET_PLAN2_6_ENTRY_MAX_PRICE
      || process.env.POLYMARKET_PLAN2_6_ENTRY_HARD_MAX_PRICE
      || 0.90
    ),
    // Strategy hard cap (paper+live decision). Live chase intercept is separate (flag above).
    plan2_6EntryHardMaxPrice: Number(process.env.POLYMARKET_PLAN2_6_ENTRY_HARD_MAX_PRICE || 0.92),
    // Momentum band ceiling (clamped by entry max / hard max).
    plan2_6SustainedMomentumMaxPrice: Number(process.env.POLYMARKET_PLAN2_6_SUSTAINED_MOMENTUM_MAX_PRICE || 0.90),
    // Plan2.6 live: entry may sync paper; exit sync defaults OFF so hard SL stays armed.
    plan26LiveSyncPaperEntryEnabled: process.env.POLYMARKET_PLAN26_LIVE_SYNC_PAPER_ENTRY_ENABLED != null
      ? process.env.POLYMARKET_PLAN26_LIVE_SYNC_PAPER_ENTRY_ENABLED !== 'false'
      : null,
    plan26LiveSyncPaperExitEnabled: process.env.POLYMARKET_PLAN26_LIVE_SYNC_PAPER_EXIT_ENABLED != null
      ? process.env.POLYMARKET_PLAN26_LIVE_SYNC_PAPER_EXIT_ENABLED !== 'false'
      : false,
    // Plan11 — PM 热门侧 + Binance 窗口现货确认；纸面/实盘同一入场，只打硬止损。
    plan11Enabled: process.env.POLYMARKET_PLAN11_ENABLED !== 'false',
    plan11LiveEnabled: process.env.POLYMARKET_PLAN11_LIVE_ENABLED === 'true',
    plan11MinPrice: Number(process.env.POLYMARKET_PLAN11_MIN_PRICE || 0.70),
    plan11MaxPrice: Number(process.env.POLYMARKET_PLAN11_MAX_PRICE || 0.78),
    plan11MinGap: Number(process.env.POLYMARKET_PLAN11_MIN_GAP || 0.28),
    plan11MinElapsedPct: Number(process.env.POLYMARKET_PLAN11_MIN_ELAPSED_PCT || 0.12),
    plan11MaxElapsedPct5m: Number(process.env.POLYMARKET_PLAN11_MAX_ELAPSED_PCT_5M || 0.55),
    plan11MaxElapsedPct15m: Number(process.env.POLYMARKET_PLAN11_MAX_ELAPSED_PCT_15M || 0.50),
    plan11MinSpotDistanceBps5m: Number(process.env.POLYMARKET_PLAN11_MIN_SPOT_DISTANCE_BPS_5M || 3),
    plan11MinSpotDistanceBps15m: Number(process.env.POLYMARKET_PLAN11_MIN_SPOT_DISTANCE_BPS_15M || 5),
    plan11MinQuality: Number(process.env.POLYMARKET_PLAN11_MIN_QUALITY || 0.42),
    plan11MinEdgeAfterFee: Number(process.env.POLYMARKET_PLAN11_MIN_EDGE_AFTER_FEE || 0.012),
    plan11TakerFeeRate: Number(process.env.POLYMARKET_PLAN11_TAKER_FEE_RATE || 0.07),
    plan11StopLossOffset: Number(process.env.POLYMARKET_PLAN11_STOP_LOSS_OFFSET || 0.10),
    plan11StopLossEnabled: process.env.POLYMARKET_PLAN11_STOP_LOSS_ENABLED === 'true',
    plan11StopLossAbsoluteFloor: process.env.POLYMARKET_PLAN11_STOP_LOSS_ABSOLUTE_FLOOR === '0'
      ? 0
      : (process.env.POLYMARKET_PLAN11_STOP_LOSS_ABSOLUTE_FLOOR != null
        && process.env.POLYMARKET_PLAN11_STOP_LOSS_ABSOLUTE_FLOOR !== ''
        ? Number(process.env.POLYMARKET_PLAN11_STOP_LOSS_ABSOLUTE_FLOOR)
        : null),
    plan11PaperOrderPct: Number(process.env.POLYMARKET_PLAN11_PAPER_ORDER_PCT || 0.05),
    plan11LiveOrderPct: Number(process.env.POLYMARKET_PLAN11_LIVE_ORDER_PCT || 0.05),
    plan11PaperMinOrderUsd: Number(process.env.POLYMARKET_PLAN11_PAPER_MIN_ORDER_USD || 1),
    plan11LiveMinOrderUsd: Number(process.env.POLYMARKET_PLAN11_LIVE_MIN_ORDER_USD || 5),
    plan11LiveMaxOrderUsd: Number(process.env.POLYMARKET_PLAN11_LIVE_MAX_ORDER_USD || 5),
    plan11MaxOpenLivePositions: Number(process.env.POLYMARKET_PLAN11_MAX_OPEN_LIVE_POSITIONS || 1),
    // Plan14 v5 — 归一化估值、费后预期收益选单；旧仓保留 v3/v4 退出参数；仅模拟。
    plan14Enabled: process.env.POLYMARKET_PLAN14_ENABLED !== 'false',
    // 新开仓默认关。v9 廉价侧持有到结算已经亏掉本金的一大半，重启不能再自动打开。
    plan14NewEntriesEnabled: process.env.POLYMARKET_PLAN14_NEW_ENTRIES_ENABLED === 'true',
    plan14ProfitExperimentEnabled: process.env.POLYMARKET_PLAN14_PROFIT_EXPERIMENT_ENABLED !== 'false',
    plan14Symbols: parseList(
      process.env.POLYMARKET_PLAN14_SYMBOLS,
      'BTC-USD,ETH-USD,SOL-USD,XRP-USD'
    ),
    plan14Timeframes: ['5m'],
    plan14StreakSizingEnabled: process.env.POLYMARKET_PLAN14_STREAK_SIZING_ENABLED === 'true',
    plan14MinElapsedPct: Number(process.env.POLYMARKET_PLAN14_MIN_ELAPSED_PCT || 0.10),
    plan14MaxElapsedPct: Number(process.env.POLYMARKET_PLAN14_MAX_ELAPSED_PCT || 0.85),
    plan14MinExecPrice: Number(process.env.POLYMARKET_PLAN14_MIN_EXEC_PRICE || 0.40),
    plan14MaxExecPrice: Number(process.env.POLYMARKET_PLAN14_MAX_EXEC_PRICE || 0.90),
    plan14MarketWeight: Number(process.env.POLYMARKET_PLAN14_MARKET_WEIGHT || 1.0),
    plan14ModelWeight5m: Number(process.env.POLYMARKET_PLAN14_MODEL_WEIGHT_5M || 0.23),
    plan14ModelWeight15m: Number(process.env.POLYMARKET_PLAN14_MODEL_WEIGHT_15M || 0.16),
    plan14MinEdgeAfterCost: Number(process.env.POLYMARKET_PLAN14_MIN_EDGE_AFTER_COST || 0.01),
    plan14MinExpectedRoi: process.env.POLYMARKET_PLAN14_MIN_EXPECTED_ROI != null
      && process.env.POLYMARKET_PLAN14_MIN_EXPECTED_ROI !== ''
      ? Number(process.env.POLYMARKET_PLAN14_MIN_EXPECTED_ROI)
      : 0,
    plan14MinModelOverMid: Number(process.env.POLYMARKET_PLAN14_MIN_MODEL_OVER_MID || 0.01),
    plan14ValueExitMargin: Number(process.env.POLYMARKET_PLAN14_VALUE_EXIT_MARGIN || 0.01),
    plan14PrescreenSlack: Number(process.env.POLYMARKET_PLAN14_PRESCREEN_SLACK || 0.02),
    plan14MaxSpotAgeSeconds: Number(process.env.POLYMARKET_PLAN14_MAX_SPOT_AGE_SECONDS || 10),
    plan14MaxAskMidGap: Number(process.env.POLYMARKET_PLAN14_MAX_ASK_MID_GAP || 0.05),
    plan14MaxBookSpread: Number(process.env.POLYMARKET_PLAN14_MAX_BOOK_SPREAD || 0.05),
    plan14TakerFeeRate: Number(process.env.POLYMARKET_PLAN14_TAKER_FEE_RATE || 0.07),
    plan14KellyFraction: Number(process.env.POLYMARKET_PLAN14_KELLY_FRACTION || 0.25),
    plan14MaxOrderPct: Number(process.env.POLYMARKET_PLAN14_MAX_ORDER_PCT || 0.03),
    plan14MinShares: Number(process.env.POLYMARKET_PLAN14_MIN_SHARES || 5),
    plan14TakeProfitMargin: Number(process.env.POLYMARKET_PLAN14_TAKE_PROFIT_MARGIN || 0.01),
    plan14StopLossMargin: Number(process.env.POLYMARKET_PLAN14_STOP_LOSS_MARGIN || 0),
    plan14StopConfirmSamples: Number(process.env.POLYMARKET_PLAN14_STOP_CONFIRM_SAMPLES || 3),
    plan14StopConfirmMs: Number(process.env.POLYMARKET_PLAN14_STOP_CONFIRM_MS || 10000),
    plan14RiskStopLossPct: Number(process.env.POLYMARKET_PLAN14_RISK_STOP_LOSS_PCT || 0.25),
    plan14MaxSameDirectionEntriesPerSlot: Number(process.env.POLYMARKET_PLAN14_MAX_SAME_DIRECTION_ENTRIES_PER_SLOT || 4),
    // Plan15 — 市场扩展事件盘，独立模拟账本。持有到官方结果，禁止实盘。
    plan15Enabled: process.env.POLYMARKET_PLAN15_ENABLED !== 'false',
    plan15NewEntriesEnabled: process.env.POLYMARKET_PLAN15_NEW_ENTRIES_ENABLED === 'true',
    plan15StartingCash: Number(process.env.POLYMARKET_PLAN15_STARTING_CASH || 500),
    plan15MinPrice: Number(process.env.POLYMARKET_PLAN15_MIN_PRICE || 0.40),
    plan15MaxPrice: Number(process.env.POLYMARKET_PLAN15_MAX_PRICE || 0.70),
    plan15MaxSpread: Number(process.env.POLYMARKET_PLAN15_MAX_SPREAD || 0.05),
    plan15MaxDays: Number(process.env.POLYMARKET_PLAN15_MAX_DAYS || 2),
    plan15MinVolume24hr: Number(process.env.POLYMARKET_PLAN15_MIN_VOLUME_24HR || 1000),
    plan15OrderUsd: Number(process.env.POLYMARKET_PLAN15_ORDER_USD || 5),
    plan15MaxTradeBankrollPct: Number(process.env.POLYMARKET_PLAN15_MAX_TRADE_BANKROLL_PCT ?? 0.05),
    plan15MaxOpenExposureBankrollPct: Number(process.env.POLYMARKET_PLAN15_MAX_OPEN_EXPOSURE_BANKROLL_PCT ?? 0.30),
    // 0 = 不设笔数上限，现金用完即停。模拟盘要留够各类样本，不把仓位卡在 12。
    plan15MaxOpen: process.env.POLYMARKET_PLAN15_MAX_OPEN != null
      && process.env.POLYMARKET_PLAN15_MAX_OPEN !== ''
      ? Number(process.env.POLYMARKET_PLAN15_MAX_OPEN)
      : 0,
    plan15MaxNewPerScan: process.env.POLYMARKET_PLAN15_MAX_NEW_PER_SCAN != null
      && process.env.POLYMARKET_PLAN15_MAX_NEW_PER_SCAN !== ''
      ? Number(process.env.POLYMARKET_PLAN15_MAX_NEW_PER_SCAN)
      : 0,
    plan15LoopMs: Number(process.env.POLYMARKET_PLAN15_LOOP_MS || 60000),
    // Plan16 — 公开集合预报对温度盘，独立模拟账本。持有到官方结果，禁止实盘。
    plan16Enabled: process.env.POLYMARKET_PLAN16_ENABLED !== 'false',
    plan16NewEntriesEnabled: process.env.POLYMARKET_PLAN16_NEW_ENTRIES_ENABLED === 'true',
    plan16StartingCash: Number(process.env.POLYMARKET_PLAN16_STARTING_CASH || 500),
    plan16MinAsk: Number(process.env.POLYMARKET_PLAN16_MIN_ASK || 0.08),
    plan16MaxAsk: Number(process.env.POLYMARKET_PLAN16_MAX_ASK || 0.80),
    plan16MaxSpread: Number(process.env.POLYMARKET_PLAN16_MAX_SPREAD || 0.06),
    plan16MinEdge: Number(process.env.POLYMARKET_PLAN16_MIN_EDGE || 0.08),
    plan16MinMembers: Number(process.env.POLYMARKET_PLAN16_MIN_MEMBERS || 20),
    plan16MaxDays: Number(process.env.POLYMARKET_PLAN16_MAX_DAYS || 2),
    plan16OrderUsd: Number(process.env.POLYMARKET_PLAN16_ORDER_USD || 5),
    plan16MaxOpen: Number(process.env.POLYMARKET_PLAN16_MAX_OPEN || 30),
    plan16MaxNewPerScan: Number(process.env.POLYMARKET_PLAN16_MAX_NEW_PER_SCAN || 8),
    plan16LoopMs: Number(process.env.POLYMARKET_PLAN16_LOOP_MS || 60000),
    plan16FeeRate: Number(process.env.POLYMARKET_PLAN16_FEE_RATE || 0.07),
    plan17Enabled: process.env.POLYMARKET_PLAN17_ENABLED !== 'false',
    plan17NewEntriesEnabled: process.env.POLYMARKET_PLAN17_NEW_ENTRIES_ENABLED === 'true',
    plan17StartingCash: Number(process.env.POLYMARKET_PLAN17_STARTING_CASH || 500),
    plan17MaxIvAgeMs: Number(process.env.POLYMARKET_PLAN17_MAX_IV_AGE_MS || 300000),
    plan17MinEdge: Number(process.env.POLYMARKET_PLAN17_MIN_EDGE || 0.10),
    plan17MinAsk: Number(process.env.POLYMARKET_PLAN17_MIN_ASK || 0.03),
    plan17MaxAsk: Number(process.env.POLYMARKET_PLAN17_MAX_ASK || 0.95),
    plan17MaxSpread: Number(process.env.POLYMARKET_PLAN17_MAX_SPREAD || 0.05),
    plan17MaxPerEvent: Number(process.env.POLYMARKET_PLAN17_MAX_PER_EVENT || 4),
    plan17Families: (process.env.POLYMARKET_PLAN17_FAMILIES || 'hitDaily,above').split(',').map((value) => value.trim()).filter(Boolean),
    plan17OrderUsd: Number(process.env.POLYMARKET_PLAN17_ORDER_USD || 5),
    plan17KellyEnabled: process.env.POLYMARKET_PLAN17_KELLY_ENABLED !== 'false',
    // 半凯利。满凯利要模型概率是真概率；DVOL 概率只是估计。
    plan17KellyFraction: Number(process.env.POLYMARKET_PLAN17_KELLY_FRACTION || 0.5),
    plan17KellyMaxFraction: Number(process.env.POLYMARKET_PLAN17_KELLY_MAX_FRACTION || 0.08),
    plan17KellyScanCap: Number(process.env.POLYMARKET_PLAN17_KELLY_SCAN_CAP || 0.25),
    plan17KellyMinUsd: Number(process.env.POLYMARKET_PLAN17_KELLY_MIN_USD || 1),
    plan17MaxOpen: Number(process.env.POLYMARKET_PLAN17_MAX_OPEN || 40),
    plan17MaxNewPerScan: Number(process.env.POLYMARKET_PLAN17_MAX_NEW_PER_SCAN || 6),
    plan17LoopMs: Number(process.env.POLYMARKET_PLAN17_LOOP_MS || 120000),
    plan17FeeRate: Number(process.env.POLYMARKET_PLAN17_FEE_RATE || 0.07),
    // Plan18（梅花易数）/ Plan19（小六壬）：算卦随机对照组，配置项同构。
    ...divinationPlanConfig('plan18', 'POLYMARKET_PLAN18'),
    ...divinationPlanConfig('plan19', 'POLYMARKET_PLAN19'),
    // Plan13 v2 — 仅 15m standard；65–88¢；费后正期望单机会；确认止损且不反手。
    plan13Enabled: process.env.POLYMARKET_PLAN13_ENABLED !== 'false',
    plan13LiveEnabled: process.env.POLYMARKET_PLAN13_LIVE_ENABLED === 'true',
    plan13EntryMinPrice: Number(process.env.POLYMARKET_PLAN13_ENTRY_MIN_PRICE || 0.65),
    plan13EntryMaxPrice: Number(process.env.POLYMARKET_PLAN13_ENTRY_MAX_PRICE || 0.88),
    plan13EntryHardMaxPrice: Number(process.env.POLYMARKET_PLAN13_ENTRY_HARD_MAX_PRICE || 0.88),
    plan13TakerFeeRate: Number(process.env.POLYMARKET_PLAN13_TAKER_FEE_RATE || 0.07),
    plan13MinEdgeAfterFee: Number(process.env.POLYMARKET_PLAN13_MIN_EDGE_AFTER_FEE || 0.02),
    plan13UpMinConfidence: Number(process.env.POLYMARKET_PLAN13_UP_MIN_CONFIDENCE || 0.72),
    plan13UpMinEdgeAfterFee: Number(process.env.POLYMARKET_PLAN13_UP_MIN_EDGE_AFTER_FEE || 0.05),
    plan13RequireUpSpotAlignment: process.env.POLYMARKET_PLAN13_REQUIRE_UP_SPOT_ALIGNMENT !== 'false',
    plan13StopLossEnabled: process.env.POLYMARKET_PLAN13_STOP_LOSS_ENABLED !== 'false',
    plan13StopConfirmSamples: Number(process.env.POLYMARKET_PLAN13_STOP_CONFIRM_SAMPLES || 2),
    plan13StopConfirmMs: Number(process.env.POLYMARKET_PLAN13_STOP_CONFIRM_MS || 0),
    plan13StopRequireSpotReversal: process.env.POLYMARKET_PLAN13_STOP_REQUIRE_SPOT_REVERSAL !== 'false',
    plan13LiveSyncPaperEntryEnabled: process.env.POLYMARKET_PLAN13_LIVE_SYNC_PAPER_ENTRY_ENABLED === 'true',
    // Plan3.6 — 默认关闭（廉价侧盈亏集中单日；当前 favorite 版本负期望）。
    plan3_6Enabled: process.env.POLYMARKET_PLAN3_6_ENABLED === 'true',
    plan3_6LiveEnabled: process.env.POLYMARKET_PLAN3_6_LIVE_ENABLED === 'true',
    plan3_6MinPrice: Number(process.env.POLYMARKET_PLAN3_6_MIN_PRICE || 0.05),
    // Live hard floor for favorite buys (legacy default 0.10 was cheap-side era — unsafe).
    plan3_6LiveMinPrice: Number(process.env.POLYMARKET_PLAN3_6_LIVE_MIN_PRICE || 0.75),
    plan3_6FullBandMinPrice: Number(process.env.POLYMARKET_PLAN3_6_FULL_BAND_MIN_PRICE || 0.10),
    plan3_6HalfBandSizeScale: Number(process.env.POLYMARKET_PLAN3_6_HALF_BAND_SIZE_SCALE || 0.5),
    // Legacy cheap-side band (observation only). Live FAK bumps must NOT use this as max.
    plan3_6MaxPrice: Number(process.env.POLYMARKET_PLAN3_6_MAX_PRICE || 0.20),
    plan3_6OrderUsd: Number(process.env.POLYMARKET_PLAN3_6_ORDER_USD || 5),
    plan3_6CheapMinPrice: Number(process.env.POLYMARKET_PLAN3_6_CHEAP_MIN_PRICE || 0.10),
    plan3_6CheapMaxPrice: Number(process.env.POLYMARKET_PLAN3_6_CHEAP_MAX_PRICE || 0.20),
    plan3_6FavoriteMinPrice: Number(process.env.POLYMARKET_PLAN3_6_FAVORITE_MIN_PRICE || 0.75),
    plan3_6FavoriteMaxPrice: Number(process.env.POLYMARKET_PLAN3_6_FAVORITE_MAX_PRICE || 0.85),
    plan3_6MaxOverround: Number(process.env.POLYMARKET_PLAN3_6_MAX_OVERROUND || 1.04),
    plan3_6PrimaryMinPrice: Number(process.env.POLYMARKET_PLAN3_6_PRIMARY_MIN_PRICE || 0.15),
    plan3_6PrimaryMaxPrice: Number(process.env.POLYMARKET_PLAN3_6_PRIMARY_MAX_PRICE || 0.20),
    plan3_6Shadow5mMinPrice: Number(process.env.POLYMARKET_PLAN3_6_SHADOW_5M_MIN_PRICE || 0.10),
    plan3_6Shadow5mMaxPrice: Number(process.env.POLYMARKET_PLAN3_6_SHADOW_5M_MAX_PRICE || 0.15),
    plan3_6ShadowSol5mMinPrice: Number(process.env.POLYMARKET_PLAN3_6_SHADOW_SOL_5M_MIN_PRICE || 0.15),
    plan3_6ShadowSol5mMaxPrice: Number(process.env.POLYMARKET_PLAN3_6_SHADOW_SOL_5M_MAX_PRICE || 0.20),
    plan3_6PaperSlippageTicks: Number(process.env.POLYMARKET_PLAN3_6_PAPER_SLIPPAGE_TICKS || 1),
    plan3_6PaperTickSize: Number(process.env.POLYMARKET_PLAN3_6_PAPER_TICK_SIZE || 0.01),
    plan3_6ObservationLogMaxEntries: Number(process.env.POLYMARKET_PLAN3_6_OBSERVATION_LOG_MAX_ENTRIES || 10000),
    plan3_6MinSecondsRemaining: Number(process.env.POLYMARKET_PLAN3_6_MIN_SECONDS_REMAINING || 3),
    // Live: do not enter in the final seconds when favorites can dump to junk asks.
    plan3_6LiveMinSecondsRemaining: Number(process.env.POLYMARKET_PLAN3_6_LIVE_MIN_SECONDS_REMAINING || 8),
    plan3_6LiveMaxAdversePriceDropAbs: Number(process.env.POLYMARKET_PLAN3_6_LIVE_MAX_ADVERSE_PRICE_DROP_ABS || 0.08),
    plan3_6MaxSecondsRemaining5m: Number(process.env.POLYMARKET_PLAN3_6_MAX_SECONDS_REMAINING_5M || 300),
    plan3_6MaxSecondsRemaining15m: Number(process.env.POLYMARKET_PLAN3_6_MAX_SECONDS_REMAINING_15M || 900),
    plan3_6MaxSecondsRemaining1h: Number(process.env.POLYMARKET_PLAN3_6_MAX_SECONDS_REMAINING_1H || 3600),
    plan3_6MinSecondsRemaining1d: Number(process.env.POLYMARKET_PLAN3_6_MIN_SECONDS_REMAINING_1D || 900),
    plan3_6MaxSecondsRemaining1d: Number(process.env.POLYMARKET_PLAN3_6_MAX_SECONDS_REMAINING_1D || 86400),
    plan3_6FastLoopMs: Number(process.env.POLYMARKET_PLAN3_6_FAST_LOOP_MS || 2000),
    plan3_6RequireSignalAlignment: process.env.POLYMARKET_PLAN3_6_REQUIRE_SIGNAL_ALIGNMENT !== 'false',
    plan3_6MinSignalConfidence: Number(process.env.POLYMARKET_PLAN3_6_MIN_SIGNAL_CONFIDENCE || 0.55),
    plan3_6MinModelEdge: Number(process.env.POLYMARKET_PLAN3_6_MIN_MODEL_EDGE || 0.05),
    plan3_6LiveBlockedRetryAfterMs: Number(process.env.POLYMARKET_PLAN3_6_LIVE_BLOCKED_RETRY_AFTER_MS || 500),
    plan3_6LiveJunkBlockRetryAfterMs: Number(process.env.POLYMARKET_PLAN3_6_LIVE_JUNK_BLOCK_RETRY_AFTER_MS || 8000),
    plan3_6LiveBlockedRetryMaxPerKey: Number(process.env.POLYMARKET_PLAN3_6_LIVE_BLOCKED_RETRY_MAX_PER_KEY || 8),
    // Plan8 - multi-symbol, multi-timeframe executable leader strategy. Paper only until independently validated.
    plan8PaperEnabled: process.env.POLYMARKET_PLAN8_PAPER_ENABLED === 'true',
    plan8Symbols: parseList(process.env.POLYMARKET_PLAN8_SYMBOLS, 'BTC-USD,ETH-USD,SOL-USD,XRP-USD'),
    plan8Timeframes: parseList(process.env.POLYMARKET_PLAN8_TIMEFRAMES, '5m'),
    plan8AllowedDirections: parseList(process.env.POLYMARKET_PLAN8_ALLOWED_DIRECTIONS, 'down'),
    plan8StartingCash: Number(process.env.POLYMARKET_PLAN8_STARTING_CASH || 500),
    plan8MinPrice: Number(process.env.POLYMARKET_PLAN8_MIN_PRICE || 0.76),
    plan8MaxPrice: Number(process.env.POLYMARKET_PLAN8_MAX_PRICE || 0.80),
    plan8MinSecondsRemaining: Number(process.env.POLYMARKET_PLAN8_MIN_SECONDS_REMAINING || 20),
    plan8MaxSecondsRemaining: Number(process.env.POLYMARKET_PLAN8_MAX_SECONDS_REMAINING || 90),
    plan8MinSecondsRemaining15m: Number(process.env.POLYMARKET_PLAN8_MIN_SECONDS_REMAINING_15M || 30),
    plan8MaxSecondsRemaining15m: Number(process.env.POLYMARKET_PLAN8_MAX_SECONDS_REMAINING_15M || 180),
    plan8MinSpotDistanceBps: Number(process.env.POLYMARKET_PLAN8_MIN_SPOT_DISTANCE_BPS || 1),
    plan8MinConfidence: Number(process.env.POLYMARKET_PLAN8_MIN_CONFIDENCE || 0.55),
    plan8MaxSpread: Number(process.env.POLYMARKET_PLAN8_MAX_SPREAD || 0.06),
    plan8ConfirmationSnapshots: Number(process.env.POLYMARKET_PLAN8_CONFIRMATION_SNAPSHOTS || 3),
    plan8ConfirmationTtlMs: Number(process.env.POLYMARKET_PLAN8_CONFIRMATION_TTL_MS || 30000),
    plan8CapitalPct: Number(process.env.POLYMARKET_PLAN8_CAPITAL_PCT || 0.02),
    plan8MinOrderUsd: Number(process.env.POLYMARKET_PLAN8_MIN_ORDER_USD || 5),
    plan8MaxOrderUsd: Number(process.env.POLYMARKET_PLAN8_MAX_ORDER_USD || 20),
    plan8TakerFeeRate: Number(process.env.POLYMARKET_PLAN8_TAKER_FEE_RATE || 0.07),
    plan8MinCalibrationSamples: Number(process.env.POLYMARKET_PLAN8_MIN_CALIBRATION_SAMPLES || 100),
    plan8MinCalibratedEdge: Number(process.env.POLYMARKET_PLAN8_MIN_CALIBRATED_EDGE || 0.01),
    plan8LiveEnabled: process.env.POLYMARKET_PLAN8_LIVE_ENABLED === 'true',
    plan8LiveMinSamples: Number(process.env.POLYMARKET_PLAN8_LIVE_MIN_SAMPLES || 200),
    plan8LiveBalanceRefreshMs: Number(process.env.POLYMARKET_PLAN8_LIVE_BALANCE_REFRESH_MS || 30000),
    plan8LiveRetryMax: Number(process.env.POLYMARKET_PLAN8_LIVE_RETRY_MAX || 3),
    plan8LiveRetryDelayMs: Number(process.env.POLYMARKET_PLAN8_LIVE_RETRY_DELAY_MS || 5000),
    plan8RequestTimeoutMs: Number(process.env.POLYMARKET_PLAN8_REQUEST_TIMEOUT_MS || 8000),
    plan8LoopMs: Number(process.env.POLYMARKET_PLAN8_LOOP_MS || 3000),
    // Plan9 - lock-edge judgment strategy: strong PM lock + mid gap + underpriced ask, hold to settlement.
    plan9PaperEnabled: process.env.POLYMARKET_PLAN9_PAPER_ENABLED === 'true',
    plan9Symbols: parseList(process.env.POLYMARKET_PLAN9_SYMBOLS, 'BTC-USD,ETH-USD,XRP-USD'),
    plan9SymbolSizeScales: process.env.POLYMARKET_PLAN9_SYMBOL_SIZE_SCALES || 'SOL-USD:0.25',
    plan9Timeframes: parseList(process.env.POLYMARKET_PLAN9_TIMEFRAMES, '5m'),
    plan9AllowedDirections: parseList(process.env.POLYMARKET_PLAN9_ALLOWED_DIRECTIONS, 'up,down'),
    plan9AllowedStrengths: parseList(process.env.POLYMARKET_PLAN9_ALLOWED_STRENGTHS, 'strong,normal'),
    plan9StartingCash: Number(process.env.POLYMARKET_PLAN9_STARTING_CASH || 500),
    plan9MinPrice: Number(process.env.POLYMARKET_PLAN9_MIN_PRICE || 0.55),
    plan9MaxPrice: Number(process.env.POLYMARKET_PLAN9_MAX_PRICE || 0.82),
    plan9MinPmGap: Number(process.env.POLYMARKET_PLAN9_MIN_PM_GAP || 0.30),
    plan9MaxPmGap: Number(process.env.POLYMARKET_PLAN9_MAX_PM_GAP || 0.65),
    plan9MaxElapsedPct: Number(process.env.POLYMARKET_PLAN9_MAX_ELAPSED_PCT || 0.85),
    plan9MinSecondsRemaining: Number(process.env.POLYMARKET_PLAN9_MIN_SECONDS_REMAINING || 45),
    plan9MaxSecondsRemaining: Number(process.env.POLYMARKET_PLAN9_MAX_SECONDS_REMAINING || 270),
    plan9MinSecondsRemaining15m: Number(process.env.POLYMARKET_PLAN9_MIN_SECONDS_REMAINING_15M || 90),
    plan9MaxSecondsRemaining15m: Number(process.env.POLYMARKET_PLAN9_MAX_SECONDS_REMAINING_15M || 810),
    plan9MaxSpread: Number(process.env.POLYMARKET_PLAN9_MAX_SPREAD || 0.06),
    plan9ConfirmationSnapshots: Number(process.env.POLYMARKET_PLAN9_CONFIRMATION_SNAPSHOTS || 3),
    plan9ConfirmationTtlMs: Number(process.env.POLYMARKET_PLAN9_CONFIRMATION_TTL_MS || 30000),
    plan9CapitalPct: Number(process.env.POLYMARKET_PLAN9_CAPITAL_PCT || 0.02),
    plan9MinOrderUsd: Number(process.env.POLYMARKET_PLAN9_MIN_ORDER_USD || 5),
    plan9MaxOrderUsd: Number(process.env.POLYMARKET_PLAN9_MAX_ORDER_USD || 10),
    plan9NormalSizeScale: Number(process.env.POLYMARKET_PLAN9_NORMAL_SIZE_SCALE || 0.5),
    plan9WeakSizeScale: Number(process.env.POLYMARKET_PLAN9_WEAK_SIZE_SCALE || 0.25),
    plan9TakerFeeRate: Number(process.env.POLYMARKET_PLAN9_TAKER_FEE_RATE || 0.07),
    plan9MinCalibrationSamples: Number(process.env.POLYMARKET_PLAN9_MIN_CALIBRATION_SAMPLES || 100),
    plan9MinCalibratedEdge: Number(process.env.POLYMARKET_PLAN9_MIN_CALIBRATED_EDGE || 0.015),
    plan9LiveEnabled: process.env.POLYMARKET_PLAN9_LIVE_ENABLED === 'true',
    plan9LiveMinSamples: Number(process.env.POLYMARKET_PLAN9_LIVE_MIN_SAMPLES || 200),
    plan9LiveBalanceRefreshMs: Number(process.env.POLYMARKET_PLAN9_LIVE_BALANCE_REFRESH_MS || 30000),
    plan9LiveRetryMax: Number(process.env.POLYMARKET_PLAN9_LIVE_RETRY_MAX || 2),
    plan9LiveRetryDelayMs: Number(process.env.POLYMARKET_PLAN9_LIVE_RETRY_DELAY_MS || 8000),
    plan9RequestTimeoutMs: Number(process.env.POLYMARKET_PLAN9_REQUEST_TIMEOUT_MS || 8000),
    plan9LoopMs: Number(process.env.POLYMARKET_PLAN9_LOOP_MS || 3000),
    // Plan10 — live sports favorite (≥80¢) paper capture.
    plan10PaperEnabled: process.env.POLYMARKET_PLAN10_PAPER_ENABLED === 'true',
    // Settlement remains active when entries are paused.
    plan10NewEntriesEnabled: process.env.POLYMARKET_PLAN10_NEW_ENTRIES_ENABLED === 'true',
    plan10StartingCash: Number(process.env.POLYMARKET_PLAN10_STARTING_CASH || 500),
    plan10MinPrice: Number(process.env.POLYMARKET_PLAN10_MIN_PRICE || 0.80),
    plan10MaxPrice: Number(process.env.POLYMARKET_PLAN10_MAX_PRICE || 0.99),
    plan10MaxSpread: Number(process.env.POLYMARKET_PLAN10_MAX_SPREAD || 0.05),
    plan10CapitalPct: Number(process.env.POLYMARKET_PLAN10_CAPITAL_PCT || 0.02),
    plan10MinOrderUsd: Number(process.env.POLYMARKET_PLAN10_MIN_ORDER_USD || 5),
    plan10MaxOrderUsd: Number(process.env.POLYMARKET_PLAN10_MAX_ORDER_USD || 15),
    plan10ConfirmationSnapshots: Number(process.env.POLYMARKET_PLAN10_CONFIRMATION_SNAPSHOTS || 3),
    plan10ConfirmationTtlMs: Number(process.env.POLYMARKET_PLAN10_CONFIRMATION_TTL_MS || 300000),
    plan10MaxConfirmationRange: Number(process.env.POLYMARKET_PLAN10_MAX_CONFIRMATION_RANGE || 0.03),
    plan10MaxDeterioration: Number(process.env.POLYMARKET_PLAN10_MAX_DETERIORATION || 0.02),
    plan10EventsPerTick: Number(process.env.POLYMARKET_PLAN10_EVENTS_PER_TICK || 8),
    plan10SportsPreStartMinutes: Number(process.env.POLYMARKET_PLAN10_SPORTS_PRE_START_MINUTES || 0),
    plan10SportsPostStartHours: Number(process.env.POLYMARKET_PLAN10_SPORTS_POST_START_HOURS || 6),
    plan10SportsFeeRate: Number(process.env.POLYMARKET_PLAN10_SPORTS_FEE_RATE || 0.05),
    plan10SportsDiscoveryMs: Number(process.env.POLYMARKET_PLAN10_SPORTS_DISCOVERY_MS || 60000),
    plan10SportsMaxEvents: Number(process.env.POLYMARKET_PLAN10_SPORTS_MAX_EVENTS || 50),
    plan10MaxMarketsPerEvent: Number(process.env.POLYMARKET_PLAN10_MAX_MARKETS_PER_EVENT || 4),
    plan10MaxBookSidesPerEvent: Number(process.env.POLYMARKET_PLAN10_MAX_BOOK_SIDES_PER_EVENT || 8),
    plan10RequestTimeoutMs: Number(process.env.POLYMARKET_PLAN10_REQUEST_TIMEOUT_MS || 15000),
    plan10DiscoveryTimeoutMs: Number(process.env.POLYMARKET_PLAN10_DISCOVERY_TIMEOUT_MS || 60000),
    plan10LoopMs: Number(process.env.POLYMARKET_PLAN10_LOOP_MS || 30000),
    // Plan4 — probability mispricing (independent engine, like Plan9).
    plan4PaperEnabled: process.env.POLYMARKET_PLAN4_PAPER_ENABLED === 'true',
    plan4Symbols: parseList(process.env.POLYMARKET_PLAN4_SYMBOLS, 'BTC-USD'),
    plan4Timeframes: parseList(process.env.POLYMARKET_PLAN4_TIMEFRAMES, '1h,1d').map((item) => String(item).toLowerCase()),
    plan4AllowedDirections: parseList(process.env.POLYMARKET_PLAN4_ALLOWED_DIRECTIONS, 'up,down'),
    plan4StartingCash: Number(process.env.POLYMARKET_PLAN4_STARTING_CASH || 500),
    plan4MinPrice: Number(process.env.POLYMARKET_PLAN4_MIN_PRICE || 0.35),
    plan4MinPrice1d: Number(process.env.POLYMARKET_PLAN4_MIN_PRICE_1D || 0.20),
    plan4MaxPrice: Number(process.env.POLYMARKET_PLAN4_MAX_PRICE || 0.72),
    plan4MinModelEdge: Number(process.env.POLYMARKET_PLAN4_MIN_MODEL_EDGE || 0.03),
    plan4SoftMaxModelEdge: Number(process.env.POLYMARKET_PLAN4_SOFT_MAX_MODEL_EDGE || 0.06),
    plan4MaxModelEdge: Number(process.env.POLYMARKET_PLAN4_MAX_MODEL_EDGE || 0.08),
    plan4LargeEdgeSizeScale: Number(process.env.POLYMARKET_PLAN4_LARGE_EDGE_SIZE_SCALE || 0.5),
    plan4RequireHistoryGate: process.env.POLYMARKET_PLAN4_REQUIRE_HISTORY_GATE !== 'false',
    plan4MinElapsedPct: Number(process.env.POLYMARKET_PLAN4_MIN_ELAPSED_PCT || 0.05),
    plan4MaxElapsedPct: Number(process.env.POLYMARKET_PLAN4_MAX_ELAPSED_PCT || 0.92),
    plan4MinSecondsRemaining: Number(process.env.POLYMARKET_PLAN4_MIN_SECONDS_REMAINING || 180),
    plan4MaxSecondsRemaining: Number(process.env.POLYMARKET_PLAN4_MAX_SECONDS_REMAINING || 3300),
    plan4MinSecondsRemaining1d: Number(process.env.POLYMARKET_PLAN4_MIN_SECONDS_REMAINING_1D || 900),
    plan4MaxSecondsRemaining1d: Number(process.env.POLYMARKET_PLAN4_MAX_SECONDS_REMAINING_1D || 72000),
    plan4MaxSpread: Number(process.env.POLYMARKET_PLAN4_MAX_SPREAD || 0.06),
    plan4ConfirmationSnapshots: Number(process.env.POLYMARKET_PLAN4_CONFIRMATION_SNAPSHOTS || 1),
    plan4ConfirmationTtlMs: Number(process.env.POLYMARKET_PLAN4_CONFIRMATION_TTL_MS || 30000),
    plan4CapitalPct: Number(process.env.POLYMARKET_PLAN4_CAPITAL_PCT || 0.01),
    plan4MinOrderUsd: Number(process.env.POLYMARKET_PLAN4_MIN_ORDER_USD || 5),
    plan4MaxOrderUsd: Number(process.env.POLYMARKET_PLAN4_MAX_ORDER_USD || 15),
    plan4TakerFeeRate: Number(process.env.POLYMARKET_PLAN4_TAKER_FEE_RATE || 0.07),
    plan4MinCalibrationSamples: Number(process.env.POLYMARKET_PLAN4_MIN_CALIBRATION_SAMPLES || 50),
    plan4MinCalibratedEdge: Number(process.env.POLYMARKET_PLAN4_MIN_CALIBRATED_EDGE || 0.01),
    plan4LiveEnabled: process.env.POLYMARKET_PLAN4_LIVE_ENABLED === 'true',
    plan4LiveMinSamples: Number(process.env.POLYMARKET_PLAN4_LIVE_MIN_SAMPLES || 200),
    plan4LiveBalanceRefreshMs: Number(process.env.POLYMARKET_PLAN4_LIVE_BALANCE_REFRESH_MS || 30000),
    plan4LiveRetryMax: Number(process.env.POLYMARKET_PLAN4_LIVE_RETRY_MAX || 2),
    plan4LiveRetryDelayMs: Number(process.env.POLYMARKET_PLAN4_LIVE_RETRY_DELAY_MS || 8000),
    plan4RequestTimeoutMs: Number(process.env.POLYMARKET_PLAN4_REQUEST_TIMEOUT_MS || 8000),
    plan4LoopMs: Number(process.env.POLYMARKET_PLAN4_LOOP_MS || 5000),
    plan5Enabled: process.env.POLYMARKET_PLAN5_ENABLED === 'true',
    // 实盘默认关闭；需显式 POLYMARKET_PLAN5_LIVE_ENABLED=true
    plan5LiveEnabled: process.env.POLYMARKET_PLAN5_LIVE_ENABLED === 'true',
    plan5WeakCashPct: Number(process.env.POLYMARKET_PLAN5_WEAK_CASH_PCT || 0.05),
    plan5NormalCashPct: Number(process.env.POLYMARKET_PLAN5_NORMAL_CASH_PCT || 0.10),
    plan5StrongCashPct: Number(process.env.POLYMARKET_PLAN5_STRONG_CASH_PCT || 0.15),
    plan5MinOrderUsd: Number(process.env.POLYMARKET_PLAN5_MIN_ORDER_USD || 5),
    plan5LiveMinOrderUsd: Number(process.env.POLYMARKET_PLAN5_LIVE_MIN_ORDER_USD || 1),
    plan5HistoryGateEnabled: process.env.POLYMARKET_PLAN5_HISTORY_GATE_ENABLED !== 'false',
    plan5HistoryMinSamples: Number(process.env.POLYMARKET_PLAN5_HISTORY_MIN_SAMPLES || 20),
    // 默认 0：历史胜率覆盖入场价即可；不足时 soft 降仓（见 plan5HistoryGateMode）
    plan5HistoryMargin: Number(process.env.POLYMARKET_PLAN5_HISTORY_MARGIN || 0),
    plan5HistoryMinAccuracy: Number(process.env.POLYMARKET_PLAN5_HISTORY_MIN_ACCURACY || 0.55),
    plan5HistoryRequireSamples: process.env.POLYMARKET_PLAN5_HISTORY_REQUIRE_SAMPLES === 'true',
    // soft：历史胜率略低于盈亏平衡时降仓仍买；hard：直接跳过
    plan5HistoryGateMode: String(process.env.POLYMARKET_PLAN5_HISTORY_GATE_MODE || 'soft').toLowerCase(),
    // soft 下，requiredWR - winRate >= gap 才硬拒（默认 15pct）
    plan5HistoryHardRejectGap: Number(process.env.POLYMARKET_PLAN5_HISTORY_HARD_REJECT_GAP || 0.15),
    plan5RequireCurrentPmAlignment: process.env.POLYMARKET_PLAN5_REQUIRE_CURRENT_PM_ALIGNMENT !== 'false',
    plan5QuoteSumMin: Number(process.env.POLYMARKET_PLAN5_QUOTE_SUM_MIN || 0.95),
    plan5QuoteSumMax: Number(process.env.POLYMARKET_PLAN5_QUOTE_SUM_MAX || 1.08),
    plan5HistorySizeScaleEnabled: process.env.POLYMARKET_PLAN5_HISTORY_SIZE_SCALE_ENABLED === 'true',
    plan5HistoryLookbackDays: Number(process.env.POLYMARKET_PLAN5_HISTORY_LOOKBACK_DAYS || 14),
    // 双记忆：长期基准持续累积，近期窗口只负责识别市场状态变化。
    plan5LongTermLookbackDays: Number(process.env.POLYMARKET_PLAN5_LONG_TERM_LOOKBACK_DAYS || 3650),
    plan5LearningRecentWeight: Number(process.env.POLYMARKET_PLAN5_LEARNING_RECENT_WEIGHT || 0.35),
    plan5LearningRecentWeightMin: Number(process.env.POLYMARKET_PLAN5_LEARNING_RECENT_WEIGHT_MIN || 0.15),
    plan5LearningRecentWeightMax: Number(process.env.POLYMARKET_PLAN5_LEARNING_RECENT_WEIGHT_MAX || 0.70),
    plan5LearningDriftThreshold: Number(process.env.POLYMARKET_PLAN5_LEARNING_DRIFT_THRESHOLD || 0.05),
    plan5LearningConservativeZ: Number(process.env.POLYMARKET_PLAN5_LEARNING_CONSERVATIVE_Z || 0.50),
    plan5LearningPriorAlpha: Number(process.env.POLYMARKET_PLAN5_LEARNING_PRIOR_ALPHA || 1),
    plan5LearningPriorBeta: Number(process.env.POLYMARKET_PLAN5_LEARNING_PRIOR_BETA || 1),
    // 胜率页同条件胜率 / 建议权重 → Plan5 软调仓（样本不足不挡买入）
    plan5WinrateGuidanceEnabled: process.env.POLYMARKET_PLAN5_WINRATE_GUIDANCE_ENABLED !== 'false',
    plan5WinrateGuidanceMode: String(process.env.POLYMARKET_PLAN5_WINRATE_GUIDANCE_MODE || 'soft').toLowerCase(),
    plan5WinrateGuidanceMinSamples: Number(process.env.POLYMARKET_PLAN5_WINRATE_GUIDANCE_MIN_SAMPLES || 8),
    plan5WinrateGuidanceLookbackDays: Number(process.env.POLYMARKET_PLAN5_WINRATE_GUIDANCE_LOOKBACK_DAYS || 14),
    plan5WinrateGuidanceSizeFloor: Number(process.env.POLYMARKET_PLAN5_WINRATE_GUIDANCE_SIZE_FLOOR || 0.5),
    plan5WinrateGuidanceHardRejectWeight: Number(process.env.POLYMARKET_PLAN5_WINRATE_GUIDANCE_HARD_REJECT_WEIGHT || 0.55),
    // Plan5 v6 EV：按方向分层；零优势先验=市价；样本不足时实盘禁止放行
    plan5ExpectedValueGateEnabled: process.env.POLYMARKET_PLAN5_EV_GATE_ENABLED !== 'false',
    // 负期望订单直接跳过；只对仍为正 EV、但未达到安全边际的订单保留 soft 模式。
    plan5EvGateMode: String(process.env.POLYMARKET_PLAN5_EV_GATE_MODE || 'hard').toLowerCase(),
    // soft 模式下，期望 ROI 低至此阈值才硬拒（默认 -40%）
    plan5EvHardRejectRoi: Number(process.env.POLYMARKET_PLAN5_EV_HARD_REJECT_ROI || -0.40),
    plan5EvCalibrationSinceIso: process.env.POLYMARKET_PLAN5_EV_CALIBRATION_SINCE_ISO || '2026-07-12T00:00:00.000Z',
    plan5EvStrategyVersionIsolationEnabled:
      process.env.POLYMARKET_PLAN5_EV_STRATEGY_VERSION_ISOLATION_ENABLED !== 'false',
    plan5EvVersionBootstrapMinSamples:
      Number(process.env.POLYMARKET_PLAN5_EV_VERSION_BOOTSTRAP_MIN_SAMPLES || 48),
    plan5EvMargin: Number(process.env.POLYMARKET_PLAN5_EV_MARGIN || 0.02),
    plan5EvPriorWeight: Number(process.env.POLYMARKET_PLAN5_EV_PRIOR_WEIGHT || 6),
    plan5EvUncertaintyWeight: Number(process.env.POLYMARKET_PLAN5_EV_UNCERTAINTY_WEIGHT || 0.2),
    plan5EvLiveWeight: Number(process.env.POLYMARKET_PLAN5_EV_LIVE_WEIGHT || 3),
    plan5EvPaperWeight: Number(process.env.POLYMARKET_PLAN5_EV_PAPER_WEIGHT || 1),
    plan5EvRecencyHalfLifeDays: Number(process.env.POLYMARKET_PLAN5_EV_RECENCY_HALF_LIFE_DAYS || 7),
    plan5EvRealizedRoiWeight: Number(process.env.POLYMARKET_PLAN5_EV_REALIZED_ROI_WEIGHT || 0.35),
    // 实盘已有同类样本后，只使用真实成交的净收益校准，避免模拟盘乐观结果覆盖实盘亏损。
    plan5EvLiveOnlyEnabled: process.env.POLYMARKET_PLAN5_EV_LIVE_ONLY_ENABLED !== 'false',
    // 模拟实验使用自己的成交校准，避免旧实盘样本主导新版本判断。
    plan5EvPaperOnlyEnabled: process.env.POLYMARKET_PLAN5_EV_PAPER_ONLY_ENABLED === 'true',
    // 默认禁止已实现 ROI 覆盖保守胜率低于盈亏平衡线的判断。
    plan5EvRealizedOverrideEnabled: process.env.POLYMARKET_PLAN5_EV_REALIZED_OVERRIDE_ENABLED === 'true',
    plan5EvExploratoryVetoEnabled: process.env.POLYMARKET_PLAN5_EV_EXPLORATORY_VETO_ENABLED !== 'false',
    plan5EvExploratoryMinSamples: Number(process.env.POLYMARKET_PLAN5_EV_EXPLORATORY_MIN_SAMPLES || 8),
    plan5EvExploratoryHardRejectRoi: Number(process.env.POLYMARKET_PLAN5_EV_EXPLORATORY_HARD_REJECT_ROI || -0.15),
    plan5EvExploratoryHardRejectGap: Number(process.env.POLYMARKET_PLAN5_EV_EXPLORATORY_HARD_REJECT_GAP || 0.12),
    // 让模拟盘使用与实盘相同的 EV 数据源和样本要求，产出可直接对照的影子实盘记录。
    plan5LiveParityEnabled: process.env.POLYMARKET_PLAN5_LIVE_PARITY_ENABLED === 'true',
    plan5EvRecentLiveEnabled: process.env.POLYMARKET_PLAN5_EV_RECENT_LIVE_ENABLED !== 'false',
    plan5EvRecentLiveMinSamples: Number(process.env.POLYMARKET_PLAN5_EV_RECENT_LIVE_MIN_SAMPLES || 6),
    plan5EvRecentLiveLookbackSamples: Number(process.env.POLYMARKET_PLAN5_EV_RECENT_LIVE_LOOKBACK_SAMPLES || 8),
    plan5EvRecentLiveMinRoi: Number(process.env.POLYMARKET_PLAN5_EV_RECENT_LIVE_MIN_ROI || 0),
    plan5EvRealizedRoiWeightLive: Number(process.env.POLYMARKET_PLAN5_EV_REALIZED_ROI_WEIGHT_LIVE || 1),
    plan5EvExactMinSamples: Number(process.env.POLYMARKET_PLAN5_EV_EXACT_MIN_SAMPLES || 6),
    plan5EvPriceMinSamples: Number(process.env.POLYMARKET_PLAN5_EV_PRICE_MIN_SAMPLES || 8),
    plan5EvTimeframePriceMinSamples: Number(process.env.POLYMARKET_PLAN5_EV_TIMEFRAME_PRICE_MIN_SAMPLES || 12),
    plan5EvSymbolTimeframeMinSamples: Number(process.env.POLYMARKET_PLAN5_EV_SYMBOL_TIMEFRAME_MIN_SAMPLES || 16),
    // true=样本不足时连模拟也硬拒；默认 false（模拟可积累方向样本，实盘始终禁放行）
    plan5EvRejectInsufficientSamples: process.env.POLYMARKET_PLAN5_EV_REJECT_INSUFFICIENT_SAMPLES === 'true',
    plan5SignalQualityEnabled: process.env.POLYMARKET_PLAN5_SIGNAL_QUALITY_ENABLED !== 'false',
    // soft：回撤/反向超阈降仓仍买；unstable/未满稳定时长仍等待
    plan5SignalQualityMode: String(process.env.POLYMARKET_PLAN5_SIGNAL_QUALITY_MODE || 'soft').toLowerCase(),
    plan5SignalQualityMinSamples: Number(process.env.POLYMARKET_PLAN5_SIGNAL_QUALITY_MIN_SAMPLES || 3),
    plan5SignalQualityLookbackSamples: Number(process.env.POLYMARKET_PLAN5_SIGNAL_QUALITY_LOOKBACK_SAMPLES || 8),
    plan5SignalQualityMinStableMs5m: Number(process.env.POLYMARKET_PLAN5_SIGNAL_QUALITY_MIN_STABLE_MS_5M || 5000),
    plan5SignalQualityMinStableMs15m: Number(process.env.POLYMARKET_PLAN5_SIGNAL_QUALITY_MIN_STABLE_MS_15M || 10000),
    plan5SignalQualityMaxPullback: Number(process.env.POLYMARKET_PLAN5_SIGNAL_QUALITY_MAX_PULLBACK || 0.10),
    plan5SignalQualityMaxReverseBps: Number(process.env.POLYMARKET_PLAN5_SIGNAL_QUALITY_MAX_REVERSE_BPS || 20),
    plan5SignalQualityRequireSamplesLive: process.env.POLYMARKET_PLAN5_SIGNAL_QUALITY_REQUIRE_SAMPLES_LIVE !== 'false',
    // 已锁定且盘口可交易时，统计/置信度门控只调仓，不再硬拒；资金足够时至少下最小单。
    plan5LockedSignalSizingOnlyEnabled: process.env.POLYMARKET_PLAN5_LOCKED_SIGNAL_SIZING_ONLY_ENABLED !== 'false',
    plan5LockedSignalMinSizeScale: Number(process.env.POLYMARKET_PLAN5_LOCKED_SIGNAL_MIN_SIZE_SCALE || 0.25),
    // The shared lock starts from PM and may be corrected by spot move
    // strength; Plan5 consumes that final direction and decides order size.
    plan5LockDirectionOptimizationEnabled: process.env.POLYMARKET_PLAN5_LOCK_DIRECTION_OPTIMIZATION_ENABLED !== 'false',
    // Cross-symbol voting may inform a future lock, but must not mutate an
    // already displayed/consumed Plan5 direction inside the same window.
    plan5CrossSymbolMajorityEnabled: process.env.POLYMARKET_PLAN5_CROSS_SYMBOL_MAJORITY_ENABLED !== 'false',
    // Production Plan5 must consume the same explicit recorder lock shown on
    // the win-rate page; a momentary PM quote is not an orderable lock.
    plan5RequireDisplayedLock: process.env.POLYMARKET_PLAN5_REQUIRE_DISPLAYED_LOCK === 'true',
    plan5StrengthPmWeight: Number(process.env.POLYMARKET_PLAN5_STRENGTH_PM_WEIGHT || 1),
    plan5StrengthCurrentMoveWeight: Number(process.env.POLYMARKET_PLAN5_STRENGTH_CURRENT_MOVE_WEIGHT || 0.5),
    plan5StrengthCurrentPaceWeight: Number(process.env.POLYMARKET_PLAN5_STRENGTH_CURRENT_PACE_WEIGHT || 0.25),
    plan5StrengthPreviousMoveWeight: Number(process.env.POLYMARKET_PLAN5_STRENGTH_PREVIOUS_MOVE_WEIGHT || 0.5),
    plan5StrengthRecentThreeWeight: Number(process.env.POLYMARKET_PLAN5_STRENGTH_RECENT_THREE_WEIGHT || -0.25),
    plan5DirectionLookbackDays: Number(process.env.POLYMARKET_PLAN5_DIRECTION_LOOKBACK_DAYS || 30),
    plan5DirectionRecentSamples: Number(process.env.POLYMARKET_PLAN5_DIRECTION_RECENT_SAMPLES || 40),
    plan5DirectionMinSamples: Number(process.env.POLYMARKET_PLAN5_DIRECTION_MIN_SAMPLES || 12),
    plan5DirectionRecentWeight: Number(process.env.POLYMARKET_PLAN5_DIRECTION_RECENT_WEIGHT || 0.70),
    plan5DirectionHistoryMaxWeight: Number(process.env.POLYMARKET_PLAN5_DIRECTION_HISTORY_MAX_WEIGHT || 0.25),
    plan5ContinuityEnabled: process.env.POLYMARKET_PLAN5_CONTINUITY_ENABLED !== 'false',
    plan5ContinuityMinSamples: Number(process.env.POLYMARKET_PLAN5_CONTINUITY_MIN_SAMPLES || 10),
    plan5ContinuityMaxStreak: Number(process.env.POLYMARKET_PLAN5_CONTINUITY_MAX_STREAK || 4),
    plan5ContinuityMaxWeight: Number(process.env.POLYMARKET_PLAN5_CONTINUITY_MAX_WEIGHT || 0.10),
    plan5PriceCalibrationEnabled: process.env.POLYMARKET_PLAN5_PRICE_CALIBRATION_ENABLED !== 'false',
    plan5PriceCalibrationRecentSamples: Number(process.env.POLYMARKET_PLAN5_PRICE_CALIBRATION_RECENT_SAMPLES || 20),
    plan5PriceCalibrationMinSamples: Number(process.env.POLYMARKET_PLAN5_PRICE_CALIBRATION_MIN_SAMPLES || 8),
    plan5PriceCalibrationWeight: Number(process.env.POLYMARKET_PLAN5_PRICE_CALIBRATION_WEIGHT || 0.20),
    plan5DirectionMinProbabilityEdge: Number(process.env.POLYMARKET_PLAN5_DIRECTION_MIN_PROBABILITY_EDGE || 0.005),
    plan5DirectionMinExpectedRoi: Number(process.env.POLYMARKET_PLAN5_DIRECTION_MIN_EXPECTED_ROI || 0.01),
    plan5DirectionRecheckEnabled: process.env.POLYMARKET_PLAN5_DIRECTION_RECHECK_ENABLED !== 'false',
    plan5DirectionRecheckCollapsePrice: Number(process.env.POLYMARKET_PLAN5_DIRECTION_RECHECK_COLLAPSE_PRICE || 0.54),
    plan5DirectionRecheckMinDropAbs: Number(process.env.POLYMARKET_PLAN5_DIRECTION_RECHECK_MIN_DROP_ABS || 0.04),
    plan5DirectionRecheckExtremePrice: Number(process.env.POLYMARKET_PLAN5_DIRECTION_RECHECK_EXTREME_PRICE || 0.20),
    plan5LivePreflightEnabled: process.env.POLYMARKET_PLAN5_LIVE_PREFLIGHT_ENABLED !== 'false',
    // 临近截止放弃：默认 5s（原 10s）给 FAK 无对手盘多留几轮快速重试。
    plan5LiveMinSecondsRemaining: Number(process.env.POLYMARKET_PLAN5_LIVE_MIN_SECONDS_REMAINING || 5),
    // 默认只允许小幅追涨；崩价回撤由 maxAdverseDrop 拦截。
    plan5LiveMaxPriceChaseAbs: Number(process.env.POLYMARKET_PLAN5_LIVE_MAX_PRICE_CHASE_ABS || 0.03),
    plan5LiveReversalPriceThreshold: Number(process.env.POLYMARKET_PLAN5_LIVE_REVERSAL_PRICE_THRESHOLD || 0.20),
    plan5LiveReversalMicroProbeEnabled: process.env.POLYMARKET_PLAN5_LIVE_REVERSAL_MICRO_PROBE_ENABLED === 'true',
    plan5LiveReversalProbeFloor: Number(process.env.POLYMARKET_PLAN5_LIVE_REVERSAL_PROBE_FLOOR || 0.15),
    plan5LiveReversalProbeSizeScale: Number(process.env.POLYMARKET_PLAN5_LIVE_REVERSAL_PROBE_SIZE_SCALE || 0.20),
    plan5LiveMaxAdversePriceDropAbs: Number(process.env.POLYMARKET_PLAN5_LIVE_MAX_ADVERSE_PRICE_DROP_ABS || 0.12),
    plan5LiveMaxAdversePriceDropPct: Number(process.env.POLYMARKET_PLAN5_LIVE_MAX_ADVERSE_PRICE_DROP_PCT || 0.25),
    plan5LiveAdverseMoveMinPriceSamples: Number(process.env.POLYMARKET_PLAN5_LIVE_ADVERSE_MOVE_MIN_PRICE_SAMPLES || 8),
    plan5LiveAdverseMoveHistoricalMargin: Number(process.env.POLYMARKET_PLAN5_LIVE_ADVERSE_MOVE_HISTORICAL_MARGIN || 0.005),
    plan5ConsensusEnabled: process.env.POLYMARKET_PLAN5_CONSENSUS_ENABLED !== 'false',
    plan5ConsensusMinConfidence5m: Number(process.env.POLYMARKET_PLAN5_CONSENSUS_MIN_CONFIDENCE_5M || 0.62),
    plan5ConsensusMinConfidence15m: Number(process.env.POLYMARKET_PLAN5_CONSENSUS_MIN_CONFIDENCE_15M || 0.62),
    plan5ConsensusMinPmGap: Number(process.env.POLYMARKET_PLAN5_CONSENSUS_MIN_PM_GAP || 0.30),
    plan5ConsensusMinPmGap5m: Number(process.env.POLYMARKET_PLAN5_CONSENSUS_MIN_PM_GAP_5M || 0.30),
    plan5ConsensusMinPmGap15m: Number(process.env.POLYMARKET_PLAN5_CONSENSUS_MIN_PM_GAP_15M || 0.40),
    plan5ConsensusRequireTechnicalAlignment: process.env.POLYMARKET_PLAN5_CONSENSUS_REQUIRE_TECH_ALIGNMENT !== 'false',
    plan5ConsensusRequireSpotAlignment: process.env.POLYMARKET_PLAN5_CONSENSUS_REQUIRE_SPOT_ALIGNMENT !== 'false',
    plan5EntryTimingEnabled: process.env.POLYMARKET_PLAN5_ENTRY_TIMING_ENABLED !== 'false',
    plan5MinElapsedPct5m: Number(process.env.POLYMARKET_PLAN5_MIN_ELAPSED_PCT_5M || 0.25),
    plan5MinElapsedPct15m: Number(process.env.POLYMARKET_PLAN5_MIN_ELAPSED_PCT_15M || 0.25),
    plan5WeakMinElapsedPct5m: Number(process.env.POLYMARKET_PLAN5_WEAK_MIN_ELAPSED_PCT_5M || 0.25),
    plan5WeakMinElapsedPct15m: Number(process.env.POLYMARKET_PLAN5_WEAK_MIN_ELAPSED_PCT_15M || 0.25),
    plan5MinLockAgeMs5m: Number.isFinite(Number(process.env.POLYMARKET_PLAN5_MIN_LOCK_AGE_MS_5M))
      ? Math.max(0, Number(process.env.POLYMARKET_PLAN5_MIN_LOCK_AGE_MS_5M))
      : 15000,
    plan5MinLockAgeMs15m: Number(process.env.POLYMARKET_PLAN5_MIN_LOCK_AGE_MS_15M || 30000),
    plan5StopLossEnabled: process.env.POLYMARKET_PLAN5_STOP_LOSS_ENABLED !== 'false',
    plan5ConditionalStopPrice: Number(process.env.POLYMARKET_PLAN5_CONDITIONAL_STOP_PRICE || 0.30),
    plan5EmergencyStopPrice: Number(process.env.POLYMARKET_PLAN5_EMERGENCY_STOP_PRICE || 0.20),
    // 每次评估写入机会日志（含 skip），便于分析「为何不买」
    plan5OpportunityLogEnabled: process.env.POLYMARKET_PLAN5_OPPORTUNITY_LOG_ENABLED !== 'false',
    plan5OpportunityLogMaxEntries: Number(process.env.POLYMARKET_PLAN5_OPPORTUNITY_LOG_MAX_ENTRIES || 800),
    plan5ShadowEnabled: process.env.POLYMARKET_PLAN5_SHADOW_ENABLED !== 'false',
    plan5ShadowMaxEntries: Number(process.env.POLYMARKET_PLAN5_SHADOW_MAX_ENTRIES || 10000),
    plan5ShadowHypotheticalUsd: Number(process.env.POLYMARKET_PLAN5_SHADOW_HYPOTHETICAL_USD || 5),
    plan5EvStrictExecutionEnabled: process.env.POLYMARKET_PLAN5_EV_STRICT_EXECUTION_ENABLED !== 'false',
    plan5EvExecutionPriceBufferAbs: Number(process.env.POLYMARKET_PLAN5_EV_EXECUTION_PRICE_BUFFER_ABS || 0.01),
    // Keep the selected strength tier amount fixed; strategy results do not shrink it after losses.
    plan5AdaptiveSizingEnabled: process.env.POLYMARKET_PLAN5_ADAPTIVE_SIZING_ENABLED === 'true',
    // Plan5 A: 连续同向 next-slot 预测奖赏（样本不足不 boost）
    plan5SameDirBoostEnabled: process.env.POLYMARKET_PLAN5_SAME_DIR_BOOST_ENABLED !== 'false',
    plan5SameDirBoost: Number(process.env.POLYMARKET_PLAN5_SAME_DIR_BOOST || 1.25),
    plan5SameDirBoostMax: Number(process.env.POLYMARKET_PLAN5_SAME_DIR_BOOST_MAX || 1.35),
    plan5SameDirMinSamples: Number(process.env.POLYMARKET_PLAN5_SAME_DIR_MIN_SAMPLES || 15),
    plan5SameDirMinEdge: Number(process.env.POLYMARKET_PLAN5_SAME_DIR_MIN_EDGE || 0.03),
    // Plan5 B: 开盘前下一窗小仓 + 开盘后同向加仓
    // v6：默认关闭下一槽预开仓；需显式 POLYMARKET_PLAN5_PRE_OPEN_ENABLED=true
    plan5PreOpenEnabled: process.env.POLYMARKET_PLAN5_PRE_OPEN_ENABLED === 'true',
    plan5PreOpenMinAccuracy: Number(process.env.POLYMARKET_PLAN5_PRE_OPEN_MIN_ACCURACY || 0.65),
    plan5PreOpenMinSamples: Number(process.env.POLYMARKET_PLAN5_PRE_OPEN_MIN_SAMPLES || 20),
    plan5PreOpenSizeFraction: Number(process.env.POLYMARKET_PLAN5_PRE_OPEN_SIZE_FRACTION || 0.4),
    // history × sameDir × symbolWr 叠加上限，避免杠杆失控
    plan5CombinedSizeScaleCap: Number(process.env.POLYMARKET_PLAN5_COMBINED_SIZE_SCALE_CAP || 1.8),
    // Plan5 同窗多币总敞口：防止 SOL/ETH/XRP 同向齐开导致一次方向错全军覆没
    plan5SlotMaxSymbols: Number(process.env.POLYMARKET_PLAN5_SLOT_MAX_SYMBOLS || 2),
    plan5SlotMaxExposurePct: Number(process.env.POLYMARKET_PLAN5_SLOT_MAX_EXPOSURE_PCT || 0.35),
    plan5SlotExposureEnabled: process.env.POLYMARKET_PLAN5_SLOT_EXPOSURE_ENABLED === 'true',
    // 同窗同方向候选按价格调整后 EV 排名；共享总仓位，第一/第二名约 65%/35%。
    plan5BasketAllocationEnabled: process.env.POLYMARKET_PLAN5_BASKET_ALLOCATION_ENABLED !== 'false',
    plan5BasketMaxSymbols: Number(process.env.POLYMARKET_PLAN5_BASKET_MAX_SYMBOLS || 2),
    plan5BasketPrimaryShare: Number(process.env.POLYMARKET_PLAN5_BASKET_PRIMARY_SHARE || 0.65),
    plan5BasketMinExpectedRoi: Number(process.env.POLYMARKET_PLAN5_BASKET_MIN_EXPECTED_ROI || 0),
    plan5BasketMinNetEdge: Number(process.env.POLYMARKET_PLAN5_BASKET_MIN_NET_EDGE || 0),
    // Plan5 连亏熔断（跨币种、跨周期，按最近已结算买单；冷却后自动重开）
    plan5LiveLossCircuitEnabled: process.env.POLYMARKET_PLAN5_LIVE_LOSS_CIRCUIT_ENABLED === 'true',
    plan5LiveLossCircuitMaxLosses: Number(process.env.POLYMARKET_PLAN5_LIVE_LOSS_CIRCUIT_MAX_LOSSES || 3),
    // 连亏时间冷却独立开关：默认关（只计数/提示，不因冷却拦开仓）；想暂停开仓时再手动开
    plan5LiveLossCircuitCooldownEnabled:
      process.env.POLYMARKET_PLAN5_LIVE_LOSS_CIRCUIT_COOLDOWN_ENABLED === 'true',
    // 触发熔断后冷却时长；冷却起点=触发连亏的最新亏损单 closedAt/settledAt（默认 45 分钟）
    plan5LiveLossCircuitCooldownMs: Number(process.env.POLYMARKET_PLAN5_LIVE_LOSS_CIRCUIT_COOLDOWN_MS || 45 * 60 * 1000),
    // 低价入场默认硬拒 <0.50；极端高价默认硬拒 ≥0.92
    plan5MinEntryPrice: Number(process.env.POLYMARKET_PLAN5_MIN_ENTRY_PRICE || 0.50),
    // 即使 sizing-only 软化参考下限，仍硬拦低于此价的彩票票（默认 0.35；15–20¢ 探索带由 live preflight 单独放行）
    plan5HardMinEntryPrice: Number(process.env.POLYMARKET_PLAN5_HARD_MIN_ENTRY_PRICE || 0.35),
    plan5MaxEntryPrice: Number(process.env.POLYMARKET_PLAN5_MAX_ENTRY_PRICE || 0.92),
    // Plan5 纸面成交 realism：默认要求 ask<=limit，并按 tick 滑点抬高成交价（贴近实盘 FAK）
    plan5PaperRequireAskFillable: process.env.POLYMARKET_PLAN5_PAPER_REQUIRE_ASK_FILLABLE !== 'false',
    plan5PaperFillSlippageTicks: Number(process.env.POLYMARKET_PLAN5_PAPER_FILL_SLIPPAGE_TICKS || 1),
    plan5PaperFillTickSize: Number(process.env.POLYMARKET_PLAN5_PAPER_FILL_TICK_SIZE || 0.01),
    // Plan5 是否参与全局连亏降仓（默认关）
    plan5ApplyLossStreakScale: process.env.POLYMARKET_PLAN5_APPLY_LOSS_STREAK_SCALE === 'true',
    autoLoopIntervalMs: Number(process.env.POLYMARKET_AUTO_LOOP_MS || 5000),
    settlementLoopIntervalMs: Number(process.env.POLYMARKET_SETTLEMENT_LOOP_MS || 3000),
    apiKey: process.env.POLYMARKET_API_KEY || '',
    apiSecret: process.env.POLYMARKET_API_SECRET || '',
    apiPassphrase: process.env.POLYMARKET_API_PASSPHRASE || '',
    privateKey: process.env.POLYMARKET_PRIVATE_KEY || '',
    funderAddress: process.env.POLYMARKET_FUNDER_ADDRESS || '',
    signatureType: Number(process.env.POLYMARKET_SIGNATURE_TYPE || 0),
    liveExitRetryMs: Number(process.env.POLYMARKET_LIVE_EXIT_RETRY_MS || 60000),
    liveExitRetryMs5m: Number(process.env.POLYMARKET_LIVE_EXIT_RETRY_MS_5M || process.env.POLYMARKET_LIVE_EXIT_RETRY_MS || 3000),
    liveExitRetryMs5mUrgent: Number(process.env.POLYMARKET_LIVE_EXIT_RETRY_MS_5M_URGENT || 2000),
    liveExitRetryMs15m: Number(process.env.POLYMARKET_LIVE_EXIT_RETRY_MS_15M || process.env.POLYMARKET_LIVE_EXIT_RETRY_MS || 20000),
    liveMinHoldBeforeExitMs: Number(process.env.POLYMARKET_LIVE_MIN_HOLD_BEFORE_EXIT_MS || 30000),
    liveMinHoldBeforeExitMs5m: Number(process.env.POLYMARKET_LIVE_MIN_HOLD_BEFORE_EXIT_MS_5M || process.env.POLYMARKET_LIVE_MIN_HOLD_BEFORE_EXIT_MS || 7000),
    liveMinHoldBeforeExitMs15m: Number(process.env.POLYMARKET_LIVE_MIN_HOLD_BEFORE_EXIT_MS_15M || process.env.POLYMARKET_LIVE_MIN_HOLD_BEFORE_EXIT_MS || 20000),
    liveMinHoldBeforeExitMsProbe5m: Number(process.env.POLYMARKET_LIVE_MIN_HOLD_BEFORE_EXIT_MS_PROBE_5M || 45000),
    liveMinHoldBeforeExitMsProbe15m: Number(process.env.POLYMARKET_LIVE_MIN_HOLD_BEFORE_EXIT_MS_PROBE_15M || 60000),
    liveMinHoldBypassOnHardStop: process.env.POLYMARKET_LIVE_MIN_HOLD_BYPASS_ON_HARD_STOP !== 'false',
    liveMinHoldBypassOnStopLoss5m: process.env.POLYMARKET_LIVE_MIN_HOLD_BYPASS_ON_STOP_LOSS_5M !== 'false',
    liveStopSellUseGtc5m: process.env.POLYMARKET_LIVE_STOP_SELL_USE_GTC_5M === 'true',
    liveStopGtcSellOffset5m: Number(process.env.POLYMARKET_LIVE_STOP_GTC_SELL_OFFSET_5M || 0.02),
    liveStopGtcMinMarketRatio5m: Number(process.env.POLYMARKET_LIVE_STOP_GTC_MIN_MARKET_RATIO_5M || 0.75),
    liveTakeProfitSellUseGtc: process.env.POLYMARKET_LIVE_TAKE_PROFIT_SELL_USE_GTC !== 'false',
    plan1PrepostedTakeProfitEnabled: process.env.POLYMARKET_PLAN1_PREPOSTED_TAKE_PROFIT_ENABLED !== 'false',
    liveTakeProfitGtcSellOffset: Number(process.env.POLYMARKET_LIVE_TAKE_PROFIT_GTC_SELL_OFFSET || 0.005),
    liveExitRetryMs5mTakeProfit: Number(process.env.POLYMARKET_LIVE_EXIT_RETRY_MS_5M_TAKE_PROFIT || 12000),
    liveExitRetryMs15mTakeProfit: Number(process.env.POLYMARKET_LIVE_EXIT_RETRY_MS_15M_TAKE_PROFIT || 25000),
    liveSellRetryDelaysMs5mStop: parseDelaysMs(process.env.POLYMARKET_LIVE_SELL_RETRY_DELAYS_MS_5M_STOP, [0, 1500, 3500]),
    liveSellRetryDelaysMsTakeProfit: parseDelaysMs(process.env.POLYMARKET_LIVE_SELL_RETRY_DELAYS_MS_TAKE_PROFIT, [0, 5000, 12000]),
    liveSellShareRatio: Number(process.env.POLYMARKET_LIVE_SELL_SHARE_RATIO || 0.97),
    liveDynamicSellLimitEnabled: process.env.POLYMARKET_LIVE_DYNAMIC_SELL_LIMIT !== 'false',
    liveStopSellOffset5m: Number(process.env.POLYMARKET_LIVE_STOP_SELL_OFFSET_5M || 0.03),
    liveStopSellOffset15m: Number(process.env.POLYMARKET_LIVE_STOP_SELL_OFFSET_15M || 0.02),
    liveTakeProfitSellOffset: Number(process.env.POLYMARKET_LIVE_TAKE_PROFIT_SELL_OFFSET || 0.005),
    liveUrgentSellExtraOffset: Number(process.env.POLYMARKET_LIVE_URGENT_SELL_EXTRA_OFFSET || 0.01),
    liveMinSellLimitPrice: Number(process.env.POLYMARKET_LIVE_MIN_SELL_LIMIT_PRICE || 0.01),
    liveBuyOrderType: process.env.POLYMARKET_LIVE_BUY_ORDER_TYPE || 'FAK',
    // Plan1 等非即时策略的 FAK 抬价步数；Plan5 使用下面的专用快速成交配置。
    liveFakBumpSteps: Number(process.env.POLYMARKET_LIVE_FAK_BUMP_STEPS || 6),
    // Plan5 必须尽快完成本轮多币种提交：默认仅尝试一次 FAK，不生成会阻塞后续币种的 GTC 挂单。
    plan5LiveImmediateOnly: process.env.POLYMARKET_PLAN5_LIVE_IMMEDIATE_ONLY !== 'false',
    // 同请求内 FAK 抬价档数；无对手盘时多追几档 ask。
    plan5LiveFakBumpSteps: Number(process.env.POLYMARKET_PLAN5_LIVE_FAK_BUMP_STEPS || 8),
    // Plan5 consumes finalized locks on a five-second loop. Keeping a 30-second
    // plan-view cache made a newly locked direction wait for a stale "unlocked"
    // view to expire before it could reach execution.
    plan5LiveViewCacheMaxAgeMs: Number(process.env.POLYMARKET_PLAN5_LIVE_VIEW_CACHE_MAX_AGE_MS || 3000),
    // Plan2.5 尾盘/90¢ 结算窗只有数秒；30s 缓存会让实盘一直吃「跳过」快照，而模拟盘每次新鲜评估能下单。
    plan2LiveViewCacheMaxAgeMs: Number(process.env.POLYMARKET_PLAN2_LIVE_VIEW_CACHE_MAX_AGE_MS || 1500),
    // All four view promises are joined before execution. Keep the per-view
    // deadline below one short trading tick so a slow symbol cannot hold ready
    // siblings for 25 seconds.
    plan5LiveViewTimeoutMs: Number(process.env.POLYMARKET_PLAN5_LIVE_VIEW_TIMEOUT_MS || 8000),
    plan5LiveOrderExecutionTimeoutMs: Number(process.env.POLYMARKET_PLAN5_LIVE_ORDER_EXECUTION_TIMEOUT_MS || 12000),
    plan5LiveTickTimeoutMs: Number(process.env.POLYMARKET_PLAN5_LIVE_TICK_TIMEOUT_MS || 90000),
    // A timed-out Promise cannot be cancelled reliably. Quarantine it and allow one
    // fresh view to replace it so Plan5 paper/live lanes do not remain disabled forever.
    plan5ViewStaleReplaceMs: Number(process.env.POLYMARKET_PLAN5_VIEW_STALE_REPLACE_MS || 15000),
    plan5PaperTickTimeoutMs: Number(process.env.POLYMARKET_PLAN5_PAPER_TICK_TIMEOUT_MS || 90000),
    planViewStaleReplaceMs: Number(process.env.POLYMARKET_PLAN_VIEW_STALE_REPLACE_MS || 120000),
    paperPlanTickTimeoutMs: Number(process.env.POLYMARKET_PAPER_PLAN_TICK_TIMEOUT_MS || 180000),
    livePlanViewTimeoutMs: Number(process.env.POLYMARKET_LIVE_PLAN_VIEW_TIMEOUT_MS || 30000),
    liveOrderExecutionTimeoutMs: Number(process.env.POLYMARKET_LIVE_ORDER_EXECUTION_TIMEOUT_MS || 30000),
    liveMinSharesBuffer: Number(process.env.POLYMARKET_LIVE_MIN_SHARES_BUFFER || 6),
    // 意图仓位略低于 CLOB 最小份数金额时，允许上浮的最大差额（美元）
    liveClobMinTopUpSlackUsd: Number(process.env.POLYMARKET_LIVE_CLOB_MIN_TOPUP_SLACK_USD || 2),
    // Plan2.5 不再用美元噪声底拦单（0=关闭）；真实下限是 CLOB 5 份。
    plan2LiveMinOrderUsd5m: Number(process.env.POLYMARKET_PLAN2_LIVE_MIN_ORDER_USD_5M || 0),
    plan2LiveMinOrderUsd15m: Number(process.env.POLYMARKET_PLAN2_LIVE_MIN_ORDER_USD_15M || 0),
    plan2LiveProbeEnabled: process.env.POLYMARKET_PLAN2_LIVE_PROBE_ENABLED === 'true',
    plan2LiveBlockedRetryEnabled: process.env.POLYMARKET_PLAN2_LIVE_BLOCKED_RETRY_ENABLED !== 'false',
    // Plan2/2.5 激进成交：下单前拉盘口改价（默认开）
    plan2LivePreflightEnabled: process.env.POLYMARKET_PLAN2_LIVE_PREFLIGHT_ENABLED !== 'false',
    // 热门侧崩价回撤拦截（默认 15¢ / 30%）：阻止 90¢ 信号在盘口塌到 34¢ 时仍追单吃廉价侧
    plan2LiveMaxAdversePriceDropAbs: Number(process.env.POLYMARKET_PLAN2_LIVE_MAX_ADVERSE_PRICE_DROP_ABS || 0.15),
    plan2LiveMaxAdversePriceDropPct: Number(process.env.POLYMARKET_PLAN2_LIVE_MAX_ADVERSE_PRICE_DROP_PCT || 0.30),
    // 同请求内 FAK 抬价档数；5m 默认更激进（10），15m/其它默认 8
    plan2LiveFakBumpSteps: Number(process.env.POLYMARKET_PLAN2_LIVE_FAK_BUMP_STEPS || 8),
    plan2LiveFakBumpSteps5m: Number(process.env.POLYMARKET_PLAN2_LIVE_FAK_BUMP_STEPS_5M || 10),
    // 5m 短窗：FAK 追价失败后不挂 GTC，避免挂单占余额；跨 tick 亚秒重试继续吃单
    plan2LiveImmediateOnly5m: process.env.POLYMARKET_PLAN2_LIVE_IMMEDIATE_ONLY_5M !== 'false',
    // Plan2 FAK 无对手盘：跨 tick 快速重试（默认 500ms；5m 默认 300ms）
    plan2LiveBlockedRetryAfterMs: Number(process.env.POLYMARKET_PLAN2_LIVE_BLOCKED_RETRY_AFTER_MS || 500),
    plan2LiveBlockedRetryAfterMs5m: Number(process.env.POLYMARKET_PLAN2_LIVE_BLOCKED_RETRY_AFTER_MS_5M || 300),
    plan2LiveUnfilledRetryAfterMs: Number(process.env.POLYMARKET_PLAN2_LIVE_UNFILLED_RETRY_AFTER_MS || 2000),
    plan2LiveUnfilledRetryAfterMs5m: Number(process.env.POLYMARKET_PLAN2_LIVE_UNFILLED_RETRY_AFTER_MS_5M || 1500),
    plan2LiveBlockedRetryMaxPerKey: Number(process.env.POLYMARKET_PLAN2_LIVE_BLOCKED_RETRY_MAX_PER_KEY || 16),
    plan2LiveUnfilledRetryMaxPerKey: Number(process.env.POLYMARKET_PLAN2_LIVE_UNFILLED_RETRY_MAX_PER_KEY || 10),
    // 未成交买单：短暂等待后释放窗口锁，允许重评信号并再下单（防无限刷单有次数上限）
    liveUnfilledRetryEnabled: process.env.POLYMARKET_LIVE_UNFILLED_RETRY_ENABLED !== 'false',
    liveUnfilledRetryAfterMs: Number(process.env.POLYMARKET_LIVE_UNFILLED_RETRY_AFTER_MS || 12000),
    liveUnfilledRetryMaxPerKey: Number(process.env.POLYMARKET_LIVE_UNFILLED_RETRY_MAX_PER_KEY || 5),
    liveBlockedRetryAfterMs: Number(process.env.POLYMARKET_LIVE_BLOCKED_RETRY_AFTER_MS || 8000),
    liveBlockedRetryMaxPerKey: Number(process.env.POLYMARKET_LIVE_BLOCKED_RETRY_MAX_PER_KEY || 5),
    // Plan5 FAK 无对手盘：跨 tick 快速重试（默认 500ms / 未成交 2s）
    plan5LiveBlockedRetryAfterMs: Number(process.env.POLYMARKET_PLAN5_LIVE_BLOCKED_RETRY_AFTER_MS || 500),
    plan5LiveUnfilledRetryAfterMs: Number(process.env.POLYMARKET_PLAN5_LIVE_UNFILLED_RETRY_AFTER_MS || 2000),
    // 风控上限 < CLOB 最小：长冷却（默认 3 分钟），避免同窗刷屏
    plan5LiveStructuralBlockRetryAfterMs: Number(
      process.env.POLYMARKET_PLAN5_LIVE_STRUCTURAL_BLOCK_RETRY_AFTER_MS || 180000
    ),
    plan5LiveBlockedRetryMaxPerKey: Number(process.env.POLYMARKET_PLAN5_LIVE_BLOCKED_RETRY_MAX_PER_KEY || 20),
    plan5LiveUnfilledRetryMaxPerKey: Number(process.env.POLYMARKET_PLAN5_LIVE_UNFILLED_RETRY_MAX_PER_KEY || 12),
    plan2LiveProbeUseClobMin: process.env.POLYMARKET_PLAN2_LIVE_PROBE_USE_CLOB_MIN !== 'false',
    polygonRpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
    relayerUrl: process.env.POLYMARKET_RELAYER_URL || '',
    builderApiKey: process.env.POLYMARKET_BUILDER_API_KEY || '',
    builderApiAddress: process.env.POLYMARKET_BUILDER_API_ADDRESS || '',
    builderApiSecret: process.env.POLYMARKET_BUILDER_API_SECRET || '',
    builderApiPassphrase: process.env.POLYMARKET_BUILDER_API_PASSPHRASE || '',
    depositWalletAddress: process.env.POLYMARKET_DEPOSIT_WALLET_ADDRESS || '',
    configured: Boolean(
      process.env.POLYMARKET_API_KEY &&
        process.env.POLYMARKET_API_SECRET &&
        process.env.POLYMARKET_API_PASSPHRASE &&
        process.env.POLYMARKET_PRIVATE_KEY
    )
  };
}

export function getConfig() {
  const port = Number(process.env.PORT || 3000);
  const apiKey = process.env.ROBINHOOD_API_KEY || '';
  const privateKeyBase64 = process.env.ROBINHOOD_PRIVATE_KEY_BASE64 || '';
  const publicKeyBase64 = process.env.ROBINHOOD_PUBLIC_KEY_BASE64 || '';
  const liveTradingEnabled = process.env.ENABLE_LIVE_TRADING === 'true';
  const accountEquityUsd = Number(process.env.ACCOUNT_EQUITY_USD || 10000);

  return {
    port,
    accountEquityUsd,
    robinhood: {
      apiKey,
      privateKeyBase64,
      publicKeyBase64,
      configured: Boolean(apiKey && privateKeyBase64 && publicKeyBase64)
    },
    liveTradingEnabled,
    statsDb: {
      enabled: process.env.STATS_DB_ENABLED !== 'false',
      path: process.env.STATS_DB_PATH || 'data/polymarket-stats.db'
    },
    predictionRecords: buildPredictionRecordConfig(),
    hourlyMonitor: buildHourlyMonitorConfig(buildPredictionRecordConfig()),
    statsDb: {
      enabled: process.env.STATS_DB_ENABLED !== 'false',
      path: process.env.STATS_DB_PATH || 'data/polymarket-stats.db'
    },
    polymarket: buildPolymarketConfig(),
    market: {
      source: (process.env.MARKET_DATA_SOURCE || 'binance').toLowerCase(),
      klineInterval: process.env.MARKET_KLINE_INTERVAL || '1h',
      klineLimit: Number(process.env.MARKET_KLINE_LIMIT || 120),
      sparklineLimit: Number(process.env.MARKET_SPARKLINE_LIMIT || 24),
      binanceBaseUrls: (process.env.BINANCE_API_BASE || 'https://data-api.binance.vision,https://api.binance.com')
        .split(',')
        .map((url) => url.trim())
        .filter(Boolean)
    },
    paper: {
      startingCash: Number(process.env.PAPER_STARTING_CASH || 0),
      initialHoldingsUsd: parseHoldingsUsd(process.env.PAPER_INITIAL_HOLDINGS || ''),
      tickIntervalMs: Number(process.env.PAPER_TICK_INTERVAL_MS || 30000),
      positionFraction: Number(process.env.PAPER_POSITION_FRACTION || 0.2),
      symbols: (process.env.PAPER_SYMBOLS || 'BTC-USD,ETH-USD,SOL-USD,DOGE-USD')
        .split(',')
        .map((symbol) => symbol.trim())
        .filter(Boolean)
    },
    stock: {
      accountEquityUsd: Number(process.env.STOCK_ACCOUNT_EQUITY_USD || 100000),
      commissionModelId: process.env.IBKR_COMMISSION_MODEL || 'proFixed',
      defaultModel: process.env.STOCK_DEFAULT_MODEL || 'rsi2',
      candleRange: process.env.STOCK_CANDLE_RANGE || '1y',
      symbols: (process.env.STOCK_SYMBOLS || 'AAPL,MSFT,NVDA,SPY')
        .split(',')
        .map((symbol) => symbol.trim().toUpperCase())
        .filter(Boolean),
      watchlistDir:
        process.env.STOCK_WATCHLIST_DIR ||
        'D:\\Obsidian仓库\\Kawaii的仓库\\投资\\股票\\List\\美股\\KawaiiList',
      paper: {
        startingCash: Number(process.env.STOCK_PAPER_STARTING_CASH || 0),
        tickIntervalMs: Number(process.env.STOCK_PAPER_TICK_INTERVAL_MS || 60000),
        // 单票上限(占净值);实际下单优先用策略 tradePlan 风险仓位,再以此封顶
        positionFraction: Number(process.env.STOCK_PAPER_POSITION_FRACTION || 0.1),
        // 始终保留的现金比例,避免一轮信号把本金买光
        cashFloorPct: Number(process.env.STOCK_PAPER_CASH_FLOOR_PCT || 0.2),
        minOrderUsd: Number(process.env.STOCK_PAPER_MIN_ORDER_USD || 25)
      },
      finnhub: {
        apiKey: process.env.FINNHUB_API_KEY || '',
        configured: Boolean(String(process.env.FINNHUB_API_KEY || '').trim()),
        newsLookbackDays: Number(process.env.FINNHUB_NEWS_LOOKBACK_DAYS || 7),
        earningsHorizonDays: Number(process.env.FINNHUB_EARNINGS_HORIZON_DAYS || 21)
      }
    }
  };
}
