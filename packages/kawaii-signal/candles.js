// 历史K线:优先 Binance 公开行情(与模拟盘行情源一致),Coinbase 作备选,最后回退模拟序列。
import { PublicMarketDataClient } from './publicMarketData.js';

const COINBASE_SOURCE = 'https://api.exchange.coinbase.com/products';
const GRANULARITY_TO_INTERVAL = {
  60: '1m',
  300: '5m',
  900: '15m',
  3600: '1h',
  86400: '1d'
};

const binanceClient = new PublicMarketDataClient();

export async function getCandles({ symbol = 'BTC-USD', granularity = 3600, limit = 300 }) {
  const safeLimit = Math.min(Math.max(Number(limit) || 300, 60), 300);
  const interval = GRANULARITY_TO_INTERVAL[Number(granularity) || 3600] || '1h';

  try {
    const candles = await binanceClient.getCandles(symbol, interval, safeLimit);
    return { symbol, granularity, source: 'binance-public', candles, closes: candles.map((c) => c.close) };
  } catch (binanceError) {
    try {
      return await getCoinbaseCandles({ symbol, granularity, safeLimit });
    } catch (coinbaseError) {
      const candles = mockCandles(symbol, safeLimit, Number(granularity) || 3600);
      return {
        symbol,
        granularity,
        source: 'mock',
        sourceError: `${binanceError.message}; ${coinbaseError.message}`,
        candles,
        closes: candles.map((c) => c.close)
      };
    }
  }
}

async function getCoinbaseCandles({ symbol, granularity, safeLimit }) {
  const response = await fetch(
    `${COINBASE_SOURCE}/${encodeURIComponent(symbol)}/candles?granularity=${Number(granularity) || 3600}`,
    { headers: { 'User-Agent': 'quant-console/0.2' }, signal: AbortSignal.timeout(8000) }
  );
  if (!response.ok) throw new Error(`Coinbase responded ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Empty Coinbase candle payload');

  const candles = rows
    .slice(0, safeLimit)
    .reverse()
    .map(([time, low, high, open, close, volume]) => ({ time, low, high, open, close, volume }));

  return { symbol, granularity, source: 'coinbase-public', candles, closes: candles.map((c) => c.close) };
}

function mockCandles(symbol, limit, granularity) {
  const base = { 'BTC-USD': 68000, 'ETH-USD': 3500, 'SOL-USD': 150, 'DOGE-USD': 0.16 }[symbol] || 100;
  const now = Math.floor(Date.now() / 1000);
  let price = base;
  const candles = [];

  for (let index = 0; index < limit; index += 1) {
    const cycle = Math.sin(index / 23) * 0.004 + Math.sin(index / 7) * 0.0022;
    const noise = (pseudoRandom(index * 7919 + symbol.length) - 0.5) * 0.011;
    const open = price;
    price = Math.max(base * 0.4, price * (1 + cycle + noise));
    const close = price;
    const high = Math.max(open, close) * (1 + pseudoRandom(index * 104729) * 0.004);
    const low = Math.min(open, close) * (1 - pseudoRandom(index * 1299709) * 0.004);
    candles.push({
      time: now - (limit - index) * granularity,
      open: round6(open),
      high: round6(high),
      low: round6(low),
      close: round6(close),
      volume: Math.round(50 + pseudoRandom(index * 31) * 500)
    });
  }

  return candles;
}

function pseudoRandom(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}
