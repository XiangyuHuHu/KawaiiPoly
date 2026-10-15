import { US_BTC_SHORT_RESOLUTION, US_COUNTED_FILL_STATUSES, US_SPEC_VERSION } from './constants.js';
import { buildPolymarketUsConfig, publicUsConfig } from './config.js';
import { PolymarketUsGateway, quoteForSide } from './gateway.js';
import { appendJsonl, ledgerPaths, readJsonl, writeJsonAtomic } from './ledger.js';
import { loadUsSignals, persistSignalStatuses } from './signals.js';
import { normalizeOutcomeSide, normalizeSector, readNumber, readPresentNumber, windowKey } from './shape.js';
import {
  countSectorFills,
  evaluateUsSignal,
  formatPacificTimestamp,
  pacificParts,
  settlementResult,
  summarizeSectorStats
} from './strategy.js';
import { createUsTradingClient } from './sdk.js';
import {
  summarizeUsAccount,
  usdBuyingPower,
  windowsFromOpenOrders,
  windowsFromPositions
} from './trading.js';

function parseExchangeTime(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  const normalized = text.replace(/(\.\d{3})\d+(?=Z|[+-]\d{2}:?\d{2}$)/, '$1');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function quoteFromSignal(signal) {
  const side = normalizeOutcomeSide(signal?.side);
  const ask = readNumber(signal?.ask, signal?.market_price, signal?.marketPrice);
  const spread = readNumber(signal?.spread);
  const spreadCents = readPresentNumber(signal?.spread_cents, signal?.spreadCents, signal?.gates?.spread_cents);
  const observedAt = signal?.bbo_at || signal?.bboAt || null;
  if (ask == null && spread == null && spreadCents == null && !observedAt) return null;
  return {
    yesAsk: side === 'no' ? null : ask,
    noAsk: side === 'no' ? ask : null,
    bestAsk: side === 'no' ? null : ask,
    spread: spread != null && spread >= 0 && spread <= 1 ? spread : (spreadCents == null ? null : spreadCents / 100),
    observedAt,
    depthUsd: readPresentNumber(
      signal?.depth_usd,
      signal?.depthUsd,
      signal?.gates?.depth_usd,
      signal?.liquidity_usd,
      signal?.liquidityUsd,
      signal?.gates?.liquidity_usd
    )
  };
}

function sideDepthUsd(bbo, book, side) {
  const normalized = normalizeOutcomeSide(side);
  if (normalized === 'no') {
    const noAsk = quoteForSide(bbo, 'no');
    const top = book?.bids?.[0];
    if (top && noAsk != null && Number(top.shares) > 0) return Number(top.shares) * noAsk;
    const shares = readPresentNumber(bbo?.bidShares);
    if (shares != null && shares > 0 && noAsk != null) return shares * noAsk;
    return book ? 0 : null;
  }
  const top = book?.asks?.[0];
  if (top && Number(top.price) > 0 && Number(top.shares) > 0) return Number(top.price) * Number(top.shares);
  const yesAsk = quoteForSide(bbo, 'yes');
  const shares = readPresentNumber(bbo?.askShares);
  if (shares != null && shares > 0 && yesAsk != null) return shares * yesAsk;
  return book ? 0 : null;
}

function tradeObservedAt(sampledAt, fetchedAt) {
  const fetchedMs = fetchedAt.getTime();
  const sampledMs = parseExchangeTime(sampledAt);
  if (sampledMs == null) return fetchedAt.toISOString();
  const ahead = sampledMs - fetchedMs;
  if (ahead > 0 && ahead <= 2_000) return fetchedAt.toISOString();
  return new Date(sampledMs).toISOString();
}

async function resolveQuote(signal, { gateway, now, fetchQuotes }) {
  const local = quoteFromSignal(signal);
  if (fetchQuotes === false || !gateway || !signal?.slug) {
    return { quote: local, bboAsOf: now };
  }
  const fetchedAt = new Date();
  let bbo = null;
  let quoteError = null;
  try {
    bbo = await gateway.getBbo(signal.slug);
  } catch (error) {
    quoteError = error.message;
  }
  if (!bbo) {
    return {
      quote: local ? { ...local, quoteError } : { quoteError },
      bboAsOf: now
    };
  }
  let book = null;
  if (typeof gateway.getBook === 'function') {
    try {
      book = await gateway.getBook(signal.slug);
    } catch {
      book = null;
    }
  }
  const depthUsd = sideDepthUsd(bbo, book, signal.side);
  return {
    quote: {
      ...bbo,
      observedAt: tradeObservedAt(bbo.sampledAt || bbo.observedAt, fetchedAt),
      depthUsd: depthUsd != null ? depthUsd : (local?.depthUsd ?? null),
      spread: bbo.spread ?? local?.spread ?? null
    },
    bboAsOf: fetchedAt
  };
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
    ? createUsTradingClient(config, { fetchImpl: options.fetchImpl })
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
  let account = null;
  let openWindows = windowsFromOrders(orders.filter((order) => isBlockingOrder(order, parts.dateKey)));

  if (!config.dryRun && trading && buyingPower == null) {
    const [balances, positions, openOrders] = await Promise.all([
      trading.getBalances(),
      trading.getPositions(),
      trading.listOpenOrders ? trading.listOpenOrders() : Promise.resolve({ orders: [] })
    ]);
    account = summarizeUsAccount(balances, openOrders, positions);
    buyingPower = account.buyingPower ?? usdBuyingPower(balances);
    openWindows = openWindows.concat(windowsFromPositions(positions), windowsFromOpenOrders(openOrders));
  }

  const results = [];
  for (const signal of loaded.signals) {
    const resolved = await resolveQuote(signal, {
      gateway,
      now,
      fetchQuotes: options.fetchQuotes
    });
    const quote = resolved.quote;
    const decision = evaluateUsSignal(signal, {
      now,
      quote,
      bboAsOf: resolved.bboAsOf,
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
        sector: normalizeSector(decision.sector) || decision.sector,
        pt_date: parts.dateKey,
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
    account,
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
