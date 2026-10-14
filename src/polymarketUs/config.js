import {
  US_API_BASE,
  US_BBO_MAX_AGE_MS,
  US_CASH_RESERVE_USD,
  US_GATEWAY_BASE,
  US_SCHEDULE_WINDOW_MINUTES,
  US_SPEC_VERSION
} from './constants.js';

function trimmed(value) {
  return String(value || '').trim();
}

/**
 * 实盘必须同时满足三件事，否则保持 dry-run：
 * 1. POLYMARKET_US_DRY_RUN=false
 * 2. POLYMARKET_US_LIVE_TRADING_ENABLED=true
 * 3. POLYMARKET_US_ACCESS_KEY 与 POLYMARKET_US_SECRET_KEY 都存在
 */
export function buildPolymarketUsConfig(env = process.env) {
  const accessKey = trimmed(env.POLYMARKET_US_ACCESS_KEY);
  const secretKey = trimmed(env.POLYMARKET_US_SECRET_KEY);
  const credentialsConfigured = Boolean(accessKey && secretKey);
  const liveTradingEnabled = env.POLYMARKET_US_LIVE_TRADING_ENABLED === 'true';
  const dryRunRequested = env.POLYMARKET_US_DRY_RUN !== 'false';
  let liveBlockedReason = null;
  if (!credentialsConfigured) liveBlockedReason = 'missing_credentials';
  else if (!liveTradingEnabled) liveBlockedReason = 'live_flag_off';
  else if (dryRunRequested) liveBlockedReason = 'dry_run_flag';
  const dryRun = liveBlockedReason != null;
  return {
    line: 'polymarket_us',
    specVersion: US_SPEC_VERSION,
    gatewayBaseUrl: trimmed(env.POLYMARKET_US_GATEWAY_BASE || US_GATEWAY_BASE).replace(/\/$/, ''),
    apiBaseUrl: trimmed(env.POLYMARKET_US_API_BASE || US_API_BASE).replace(/\/$/, ''),
    accessKey,
    secretKey,
    credentialsConfigured,
    liveTradingEnabled,
    dryRun,
    liveBlockedReason,
    ledgerDir: trimmed(env.POLYMARKET_US_LEDGER_DIR || '/workspace/polymarket-ledger'),
    workspaceDir: trimmed(env.POLYMARKET_US_WORKSPACE_DIR || '/workspace'),
    requestTimeoutMs: Number(env.POLYMARKET_US_REQUEST_TIMEOUT_MS || 12000),
    scheduleWindowMinutes: Number(env.POLYMARKET_US_SCHEDULE_WINDOW_MINUTES || US_SCHEDULE_WINDOW_MINUTES),
    bboMaxAgeMs: Number(env.POLYMARKET_US_BBO_MAX_AGE_MS || US_BBO_MAX_AGE_MS),
    candidateMaxAgeMs: Number(env.POLYMARKET_US_CANDIDATE_MAX_AGE_MS || 6 * 60 * 60 * 1000),
    cashReserveUsd: Number(env.POLYMARKET_US_CASH_RESERVE_USD || US_CASH_RESERVE_USD)
  };
}

export function publicUsConfig(config = buildPolymarketUsConfig()) {
  return {
    line: config.line,
    specVersion: config.specVersion,
    gatewayBaseUrl: config.gatewayBaseUrl,
    apiBaseUrl: config.apiBaseUrl,
    credentialsConfigured: config.credentialsConfigured,
    accessKeyConfigured: Boolean(config.accessKey),
    secretKeyConfigured: Boolean(config.secretKey),
    liveTradingEnabled: config.liveTradingEnabled,
    dryRun: config.dryRun,
    liveBlockedReason: config.liveBlockedReason,
    ledgerDir: config.ledgerDir,
    scheduleWindowMinutes: config.scheduleWindowMinutes,
    bboMaxAgeMs: config.bboMaxAgeMs,
    cashReserveUsd: config.cashReserveUsd,
    sdkPackage: 'polymarket-us@0.1.1',
    sdkAuth: 'keyId=POLYMARKET_US_ACCESS_KEY secretKey=POLYMARKET_US_SECRET_KEY',
    intlClobIsolated: true
  };
}
