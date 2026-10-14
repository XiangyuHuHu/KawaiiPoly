import { US_BTC_SHORT_RESOLUTION, US_COUNTED_FILL_STATUSES, US_SPEC_VERSION } from './constants.js';
import { buildPolymarketUsConfig, publicUsConfig } from './config.js';
import { PolymarketUsGateway, quoteForSide } from './gateway.js';
import { appendJsonl, ledgerPaths, readJsonl, writeJsonAtomic } from './ledger.js';
import { loadUsSignals, persistSignalStatuses } from './signals.js';
import { normalizeOutcomeSide, normalizeSector, readNumber, windowKey } from './shape.js';
import {
  countSectorFills,
  evaluateUsSignal,
  formatPacificTimestamp,
  pacificParts,
  settlementResult,
  summarizeSectorStats
} from './strategy.js';
import { PolymarketUsTradingClient, usdBuyingPower } from './trading.js';

function quoteFromSignal(signal) {
  const side = normalizeOutcomeSide(signal?.side);
  const ask = readNumber(signal?.ask, signal?.market_price, signal?.marketPrice);
  const spread = readNumber(signal?.spread);
  const spreadCents = readNumber(signal?.spread_cents, signal?.spreadCents);
  const observedAt = signal?.bbo_at || signal?.bboAt || null;
  if (ask == null && spread == null && spreadCents == null && !observedAt) return null;
  return {
    yesAsk: side === 'no' ? null : ask,
    noAsk: side === 'no' ? ask : null,
    bestAsk: side === 'no' ? null : ask,
    spread: spread != null && spread >= 0 && spread <= 1 ? spread : (spreadCents == null ? null : spreadCents / 100),
    observedAt,
    depthUsd: readNumber(signal?.liquidity_usd, signal?.liquidityUsd, signal?.depth_usd)
  };
}

async function resolveQuote(signal, { gateway, now, bboMaxAgeMs, fetchQuotes }) {
  const local = quoteFromSignal(signal);
  const observedMs = Date.parse(local?.observedAt || '');
  const localFresh = Number.isFinite(observedMs) && now.getTime() - observedMs <= bboMaxAgeMs && now.getTime() - observedMs >= 0;
  const sector = normalizeSector(signal?.sector);
  if (fetchQuotes === false || (local && (sector !== 'btc_misprice' || localFresh))) return local;
  if (!gateway || !signal?.slug) return local;
  try {
    const bbo = await gateway.getBbo(signal.slug);
    const side = normalizeOutcomeSide(signal.side);
    const ask = quoteForSide(bbo, side);
    const shares = side === 'no' ? bbo.bidShares : bbo.askShares;
    return {
      ...bbo,
      observedAt: bbo.observedAt || now.toISOString(),
      depthUsd: shares != null && ask != null ? shares * ask : local?.depthUsd ?? null,
      spread: bbo.spread ?? local?.spread ?? null
    };
  } catch (error) {
    return local ? { ...local, quoteError: error.message } : { quoteError: error.message };
  }
}

function windowsFromPositions(payload) {
  const map = payload?.positions || {};
  const rows = [];
  for (const [slug, position] of Object.entries(map)) {
    const net = Number(position?.netPositionDecimal ?? position?.netPosition ?? 0);
    if (!Number.isFinite(net) || net === 0) continue;
    rows.push({ slug, windowId: slug, side: net > 0 ? 'yes' : 'no' });
  }
  return rows;
}

function windowsFromOrders(orders) {
  return orders.map((order) => ({
    slug: order.slug,
    windowId: order.window_id || order.slug,
    side: normalizeOutcomeSide(order.side)
  })).filter((row) => row.side && (row.slug || row.windowId));
}

function isRealFill(order) {
  return !order?.dry_run && US_COUNTED_FILL_STATUSES.includes(order?.fill_status);
}

function isBlockingOrder(order, dateKey) {
  if (order?.dry_run) return String(order.time_pt || '').startsWith(dateKey);
  if (!isRealFill(order)) return false;
  return settlementResult(order) == null;
}

export async function runPolymarketUsCycle(options = {}) {
  let config = options.config || buildPolymarketUsConfig();
  if (!config.dryRun && !options.trading && !config.credentialsConfigured) {
    config = { ...config, dryRun: true, liveBlockedReason: 'missing_credentials' };
  }
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const gateway = options.gateway === undefined
    ? new PolymarketUsGateway({
      gatewayBaseUrl: config.gatewayBaseUrl,
      requestTimeoutMs: config.requestTimeoutMs,
      fetchImpl: options.fetchImpl
    })
    : options.gateway;
  const trading = options.trading === undefined
    ? new PolymarketUsTradingClient({
      apiBaseUrl: config.apiBaseUrl,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      requestTimeoutMs: config.requestTimeoutMs,
      fetchImpl: options.fetchImpl
    })
    : options.trading;

  const loaded = await loadUsSignals({
    ledgerDir: config.ledgerDir,
    workspaceDir: config.workspaceDir,
    now,
    candidateMaxAgeMs: config.candidateMaxAgeMs
  });
  const paths = ledgerPaths(config.ledgerDir);
  const orders = await readJsonl(paths.realOrders);
  const parts = pacificParts(now);
  const realIds = orders.filter(isRealFill).map((order) => order.signal_id).filter(Boolean);
  const dryIds = orders.filter((order) => order.dry_run).map((order) => order.signal_id).filter(Boolean);
  const dailyCounts = countSectorFills(orders, parts.dateKey);
  const stats = summarizeSectorStats(orders);
  let buyingPower = options.buyingPower ?? null;
  let openWindows = windowsFromOrders(orders.filter((order) => isBlockingOrder(order, parts.dateKey)));

  if (!config.dryRun && trading && buyingPower == null) {
    const balances = await trading.getBalances();
    buyingPower = usdBuyingPower(balances);
    const positions = await trading.getPositions();
    openWindows = openWindows.concat(windowsFromPositions(positions));
  }

  const results = [];
  for (const signal of loaded.signals) {
    const quote = await resolveQuote(signal, {
      gateway,
      now,
      bboMaxAgeMs: config.bboMaxAgeMs,
      fetchQuotes: options.fetchQuotes
    });
    const decision = evaluateUsSignal(signal, {
      now,
      quote,
      stats,
      dailyCounts,
      openWindows,
      buyingPower,
      realIds,
      dryIds,
      dryRun: config.dryRun,
      bboMaxAgeMs: config.bboMaxAgeMs,
      scheduleWindowMinutes: config.scheduleWindowMinutes,
      cashReserveUsd: config.cashReserveUsd
    });
    decision.signal = signal;

    if (decision.action === 'place') {
      const row = {
        id: `us-${now.getTime()}-${decision.sector}-${results.length + 1}`,
        signal_id: decision.signal_id,
        time_pt: formatPacificTimestamp(now),
        time_utc: now.toISOString(),
        venue: 'polymarket_us',
        spec: US_SPEC_VERSION,
        market: signal.title || signal.market || decision.slug,
        slug: decision.slug,
        sector: decision.sector,
        side: signal.side,
        limit_price: decision.limitPrice,
        shares: decision.quantity,
        amount_usd: decision.sizeUsd,
        url: decision.event_url,
        picks_id: signal.picks_id || signal.pick_id || null,
        basis: decision.basis,
        edge: decision.edge,
        model_prob: decision.model_prob,
        order_payload: decision.order,
        window_id: windowKey(signal),
        resolution_source: decision.sector === 'btc_misprice' || decision.sector === 'momentum'
          ? US_BTC_SHORT_RESOLUTION
          : (signal.resolution_source || signal.resolutionSource || null),
        dry_run: config.dryRun
      };
      try {
        if (config.dryRun) {
          row.fill_status = 'dry_run';
          row.order_id = null;
        } else {
          const response = await trading.createOrder(decision.order);
          const executions = response?.executions || [];
          const filled = executions.some((item) => String(item?.type || '').includes('FILL'));
          row.fill_status = filled ? 'filled' : 'submitted';
          row.order_id = response?.id || null;
          decision.status = 'filled';
          decision.updateStatus = true;
          dailyCounts[decision.sector] += 1;
          if (buyingPower != null) buyingPower -= decision.sizeUsd;
        }
        await appendJsonl(paths.realOrders, row);
        if (decision.sector === 'momentum') await appendJsonl(paths.momentum, row);
        openWindows.push({ slug: row.slug, windowId: row.window_id, side: decision.side });
        if (config.dryRun) dryIds.push(decision.signal_id);
        else realIds.push(decision.signal_id);
        decision.fill_status = row.fill_status;
        decision.ledger_id = row.id;
      } catch (error) {
        const permanent = error?.status === 400;
        decision.action = permanent ? 'skip' : 'defer';
        decision.code = permanent ? 'order_rejected' : 'api_error';
        decision.reason = error.message;
        decision.status = permanent ? 'skipped' : 'pending';
        decision.updateStatus = permanent;
        decision.fill_status = 'rejected';
      }
    }
    results.push(decision);
  }

  await persistSignalStatuses(results);
  const summary = {
    ...publicUsConfig(config),
    ranAt: now.toISOString(),
    pacificDate: parts.dateKey,
    schedule: results[0]?.schedule || null,
    placed: results.filter((row) => row.action === 'place').length,
    skipped: results.filter((row) => row.action === 'skip').length,
    deferred: results.filter((row) => row.action === 'defer').length,
    results: results.map((row) => ({
      signal_id: row.signal_id,
      action: row.action,
      code: row.code,
      reason: row.reason,
      sector: row.sector,
      side: row.side,
      sizeUsd: row.sizeUsd ?? null,
      fill_status: row.fill_status || null,
      order: row.order || null
    }))
  };
  await writeJsonAtomic(paths.health, summary);
  return summary;
}
