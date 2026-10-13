import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { slotIsoFromTargetTime } from './polymarketSchedule.js';

export { slotIsoFromTargetTime };

const DEFAULT_RPC_URL = 'https://ethereum-rpc.publicnode.com';
const DEFAULT_BTC_USD_FEED = '0xF4030086522a5bEEa4988F8cA5B36dbc97BeE88c';
const DEFAULT_RTDS_URL = 'wss://ws-live-data.polymarket.com';
const LATEST_ROUND_DATA_SELECTOR = '0xfeaf968c';
const DEFAULT_CACHE_PATH = join(process.cwd(), 'data', 'polymarket', 'chainlink-targets.json');
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MAX_CAPTURE_DELAY_SECONDS = 90;
const DEFAULT_MAX_CHAINLINK_STALENESS_SECONDS = 90;

let cacheLoaded = false;
const slotTargetCache = new Map();

export async function fetchChainlinkBtcUsdPrice({
  rpcUrl = process.env.CHAINLINK_ETH_RPC_URL || DEFAULT_RPC_URL,
  feedAddress = process.env.CHAINLINK_BTC_USD_FEED || DEFAULT_BTC_USD_FEED,
  timeoutMs = Number(process.env.CHAINLINK_RPC_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  maxStalenessSeconds = Number(process.env.CHAINLINK_MAX_STALENESS_SECONDS) || DEFAULT_MAX_CHAINLINK_STALENESS_SECONDS,
  now = new Date()
} = {}) {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: feedAddress, data: LATEST_ROUND_DATA_SELECTOR }, 'latest']
  };
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const payload = await response.json();
  if (!payload?.result || payload.result === '0x') {
    throw new Error(payload?.error?.message || 'Chainlink BTC/USD feed returned no data.');
  }
  const words = payload.result.slice(2).match(/.{1,64}/g) || [];
  if (words.length < 4) throw new Error('Chainlink BTC/USD feed response is incomplete.');

  const roundId = BigInt(`0x${words[0]}`).toString();
  const answer = decodeSigned256(words[1]);
  const updatedAt = Number(BigInt(`0x${words[3]}`));
  const price = Number(answer) / 1e8;
  if (!Number.isFinite(price) || price <= 0) throw new Error('Chainlink BTC/USD feed returned invalid price.');
  const stalenessSeconds = updatedAt > 0 ? Math.max(0, (new Date(now).getTime() - updatedAt * 1000) / 1000) : Infinity;
  if (stalenessSeconds > maxStalenessSeconds) {
    throw new Error(`Chainlink BTC/USD feed is stale (${round2(stalenessSeconds)}s).`);
  }

  return {
    price: round2(price),
    source: 'chainlink_btc_usd_feed',
    roundId,
    updatedAtIso: updatedAt > 0 ? new Date(updatedAt * 1000).toISOString() : null,
    stalenessSeconds: round2(stalenessSeconds)
  };
}

export async function fetchPolymarketRtdsBtcUsdPrice({
  url = process.env.POLYMARKET_RTDS_WS_URL || DEFAULT_RTDS_URL,
  timeoutMs = Number(process.env.POLYMARKET_RTDS_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  targetTimestampMs = Date.now()
} = {}) {
  if (typeof WebSocket !== 'function') throw new Error('WebSocket is not available in this Node runtime.');
  const snapshot = await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error('Polymarket RTDS Chainlink price timed out.'));
    }, timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Ignore close failures during cleanup.
      }
      if (error) reject(error);
      else resolve(value);
    }

    ws.addEventListener('open', () => {
      try {
        ws.send(JSON.stringify({
          action: 'subscribe',
          subscriptions: [{
            topic: 'crypto_prices_chainlink',
            type: '*',
            filters: JSON.stringify({ symbol: 'btc/usd' })
          }]
        }));
      } catch (error) {
        finish(error);
      }
    });

    ws.addEventListener('message', (event) => {
      if (settled) return;
      const text = String(event.data || '');
      if (!text.trim()) return;
      try {
        const payload = JSON.parse(text);
        const rows = extractRtdsPriceRows(payload);
        if (!rows.length) return;
        const picked = pickRtdsPriceSample(rows, targetTimestampMs);
        if (!picked) return;
        finish(null, picked);
      } catch (error) {
        finish(error);
      }
    });

    ws.addEventListener('error', () => {
      finish(new Error('Polymarket RTDS Chainlink price websocket failed.'));
    });
    ws.addEventListener('close', () => {
      // close 后若尚未拿到价格，按超时失败，避免悬挂；禁止再触发 close→finish 递归
      finish(new Error('Polymarket RTDS Chainlink price websocket closed.'));
    });
  });

  return {
    price: round2(snapshot.value),
    source: 'polymarket_rtds_chainlink',
    updatedAtIso: new Date(snapshot.timestamp).toISOString(),
    targetDistanceSeconds: round2(Math.abs(snapshot.timestamp - targetTimestampMs) / 1000)
  };
}

export function pickRtdsPriceSample(rows, targetTimestampMs) {
  const normalized = rows
    .map((row) => ({
      timestamp: Number(row.timestamp),
      value: Number(row.value)
    }))
    .filter((row) => Number.isFinite(row.timestamp) && Number.isFinite(row.value) && row.value > 0);
  if (!normalized.length) return null;
  return normalized.reduce((best, row) => {
    const distance = Math.abs(row.timestamp - targetTimestampMs);
    const bestDistance = Math.abs(best.timestamp - targetTimestampMs);
    return distance < bestDistance ? row : best;
  }, normalized[0]);
}

export async function resolveChainlinkSlotTarget({
  symbol = 'BTC-USD',
  timeframe = '15m',
  slotIso,
  now = new Date(),
  cachePath = DEFAULT_CACHE_PATH,
  maxCaptureDelaySeconds = Number(process.env.POLYMARKET_TARGET_MAX_CAPTURE_DELAY_SECONDS) || DEFAULT_MAX_CAPTURE_DELAY_SECONDS
} = {}) {
  if (symbol !== 'BTC-USD' || !slotIso) return null;
  await loadSlotTargetCache(cachePath);
  const key = buildSlotTargetKey({ symbol, timeframe, slotIso });
  const cached = slotTargetCache.get(key);
  if (cached?.price) return cached;

  const slotTime = new Date(slotIso).getTime();
  const elapsedSeconds = Number.isFinite(slotTime) ? Math.max(0, (new Date(now).getTime() - slotTime) / 1000) : Infinity;
  if (elapsedSeconds > maxCaptureDelaySeconds) {
    return null;
  }

  let latest;
  try {
    // HTTP 优先：避免高频路径狂开 WebSocket；失败再回退 RTDS
    latest = await fetchChainlinkBtcUsdPrice({ now });
  } catch {
    latest = await fetchPolymarketRtdsBtcUsdPrice({ targetTimestampMs: slotTime });
  }
  const target = {
    ...latest,
    source: latest.source === 'polymarket_rtds_chainlink'
      ? 'polymarket_rtds_chainlink_slot_start_cache'
      : 'chainlink_slot_start_cache',
    symbol,
    timeframe,
    slotIso,
    capturedAtIso: new Date(now).toISOString(),
    captureDelaySeconds: round2(elapsedSeconds)
  };
  slotTargetCache.set(key, target);
  await saveSlotTargetCache(cachePath);
  return target;
}

export function mergeSentimentTarget(sentiment, target) {
  if (!sentiment || sentiment.targetPrice || !target?.price) return sentiment;
  return {
    ...sentiment,
    targetPrice: target.price,
    targetPriceSource: target.source,
    targetPriceCapturedAtIso: target.capturedAtIso,
    targetPriceUpdatedAtIso: target.updatedAtIso,
    targetPriceCaptureDelaySeconds: target.captureDelaySeconds
  };
}

export async function resolvePolymarketWindowPrices({
  symbol = 'BTC-USD',
  timeframe = '5m',
  slotIso,
  targetTimeIso,
  cachePath = DEFAULT_CACHE_PATH
} = {}) {
  if (symbol !== 'BTC-USD' || !targetTimeIso) return null;
  const startSlotIso = slotIso || slotIsoFromTargetTime(targetTimeIso, timeframe);
  if (!startSlotIso) return null;

  const startTarget = await resolveChainlinkSlotTarget({
    symbol,
    timeframe,
    slotIso: startSlotIso,
    cachePath
  });
  const endTarget = await resolveChainlinkSlotTarget({
    symbol,
    timeframe,
    slotIso: targetTimeIso,
    cachePath
  });
  if (!startTarget?.price || !endTarget?.price) return null;

  const startPrice = round2(startTarget.price);
  const actualClose = round2(endTarget.price);
  return {
    startPrice,
    actualClose,
    actualDirection: actualClose >= startPrice ? 'up' : 'down',
    priceSource: 'chainlink'
  };
}

function decodeSigned256(word) {
  let value = BigInt(`0x${word}`);
  if (value >> 255n) value -= 1n << 256n;
  return value;
}

function extractRtdsPriceRows(payload) {
  const data = payload?.payload?.data ?? payload?.data ?? payload?.payload;
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') return [data];
  return [];
}

async function loadSlotTargetCache(cachePath) {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const parsed = JSON.parse(await readFile(cachePath, 'utf8'));
    for (const item of Array.isArray(parsed?.targets) ? parsed.targets : []) {
      if (item?.key && item?.price && isReusableCachedTarget(item)) slotTargetCache.set(item.key, item);
    }
  } catch {
    // Empty cache on first run is expected.
  }
}

async function saveSlotTargetCache(cachePath) {
  const targets = Array.from(slotTargetCache.entries())
    .map(([key, value]) => ({ key, ...value }))
    .slice(-1000);
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify({ targets })}\n`, 'utf8');
}

function buildSlotTargetKey({ symbol, timeframe, slotIso }) {
  return `${symbol}:${timeframe}:${slotIso}`;
}

function isReusableCachedTarget(item) {
  return item.source === 'polymarket_rtds_chainlink_slot_start_cache'
    || item.source === 'polymarket_target_cache';
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}
