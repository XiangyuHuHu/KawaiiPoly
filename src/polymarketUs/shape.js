import { US_SECTORS } from './constants.js';

const SECTOR_ALIASES = new Map([
  ['live', 'live'],
  ['live_sports', 'live'],
  ['sports_live', 'live'],
  ['momentum', 'momentum'],
  ['mom', 'momentum'],
  ['btc_momentum', 'momentum'],
  ['btc_misprice', 'btc_misprice'],
  ['btc15', 'btc_misprice'],
  ['btc_15m', 'btc_misprice'],
  ['btc-15m', 'btc_misprice'],
  ['btc_1h', 'btc_misprice'],
  ['btc-1h', 'btc_misprice'],
  ['misprice', 'btc_misprice'],
  ['pregame', 'pregame'],
  ['sports', 'pregame'],
  ['weather', 'weather'],
  ['macro', 'macro'],
  ['economics', 'macro'],
  ['politics', 'macro'],
  ['crypto', 'crypto'],
  ['master', 'master']
]);

export function normalizeSector(value) {
  const key = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
  return SECTOR_ALIASES.get(key) || null;
}

export function normalizeOutcomeSide(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (['yes', 'y', 'up', 'long', 'buy_long', 'order_intent_buy_long'].includes(raw)) return 'yes';
  if (['no', 'n', 'down', 'short', 'buy_short', 'order_intent_buy_short'].includes(raw)) return 'no';
  return null;
}

export function tradingSlug(slug) {
  return String(slug || '').trim();
}

export function displaySlug(slug) {
  return tradingSlug(slug).replace(/^cpc-/, '');
}

export function isInternationalEventUrl(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === 'polymarket.com' || host === 'www.polymarket.com' || host.endsWith('.polymarket.com');
  } catch {
    return false;
  }
}

export function eventUrlForSignal(signal) {
  const explicit = signal?.event_url || signal?.url;
  if (explicit && !isInternationalEventUrl(explicit)) {
    try {
      const host = new URL(explicit).hostname;
      if (host === 'polymarket.us' || host === 'www.polymarket.us') return explicit;
    } catch {
      // 落到下面的标准事件链接。
    }
  }
  const slug = displaySlug(signal?.slug);
  return slug ? `https://polymarket.us/event/${slug}` : null;
}

export function signalIdentity(signal) {
  if (signal?.id) return String(signal.id);
  const sector = normalizeSector(signal?.sector) || String(signal?.sector || '');
  const side = normalizeOutcomeSide(signal?.side) || String(signal?.side || '');
  return [sector, tradingSlug(signal?.slug), side, signal?.expires_at || ''].join('|');
}

export function windowKey(signal) {
  return String(signal?.window_id || signal?.windowId || tradingSlug(signal?.slug) || '');
}

export function contractsForUsd(sizeUsd, price) {
  const notional = Number(sizeUsd);
  const px = Number(price);
  if (!(notional > 0) || !(px > 0)) return 0;
  return Math.floor((notional / px) * 100) / 100;
}

export function isKnownSector(sector) {
  return US_SECTORS.includes(sector);
}

export function readNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}
