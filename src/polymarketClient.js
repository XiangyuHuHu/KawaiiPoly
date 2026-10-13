import {
  buildDailyUpDownSlugCandidates,
  buildHourlyUpDownSlugCandidates,
  getEtDateParts
} from './polymarketSchedule.js';

const DEFAULT_GAMMA_BASE = 'https://gamma-api.polymarket.com';
const DEFAULT_CLOB_BASE = 'https://clob.polymarket.com';
const DEFAULT_DATA_BASE = 'https://data-api.polymarket.com';
// Must stay <= the 60s window used by pruneResponseCache.
const CRYPTO_DISCOVERY_CACHE_TTL_MS = 60_000;

export class PolymarketClient {
  constructor({
    gammaBaseUrl = DEFAULT_GAMMA_BASE,
    clobBaseUrl = DEFAULT_CLOB_BASE,
    dataBaseUrl = DEFAULT_DATA_BASE,
    requestTimeoutMs = 12000
  } = {}) {
    this.gammaBaseUrl = gammaBaseUrl.replace(/\/$/, '');
    this.clobBaseUrl = clobBaseUrl.replace(/\/$/, '');
    this.dataBaseUrl = dataBaseUrl.replace(/\/$/, '');
    this.requestTimeoutMs = requestTimeoutMs;
    this.responseCache = new Map();
    this.inflightRequests = new Map();
  }

  async searchCryptoMarkets({ asset = 'bitcoin', timeframe = '15m', limit = 100 } = {}) {
    const query = asset === 'bitcoin' ? 'bitcoin up or down' : `${asset} up or down`;
    // Fallback discovery only; the crypto events listing is ~4MB and identical for
    // every asset/timeframe, so a short Gamma TTL would refetch it on every miss.
    const searchResults = await this.request(`${this.gammaBaseUrl}/public-search`, {
      q: query,
      limit: String(Math.min(limit, 100))
    }, { cacheTtlMs: CRYPTO_DISCOVERY_CACHE_TTL_MS });

    const fromSearch = flattenMarkets(searchResults);
    const fromEvents = await this.request(`${this.gammaBaseUrl}/events`, {
      active: 'true',
      closed: 'false',
      tag_slug: 'crypto',
      order: 'volume24hr',
      ascending: 'false',
      limit: String(Math.min(limit, 100))
    }, { cacheTtlMs: CRYPTO_DISCOVERY_CACHE_TTL_MS }).then(flattenMarkets).catch(() => []);

    const merged = dedupeMarkets([...fromSearch, ...fromEvents]);
    return merged.filter((market) => matchesCryptoUpDownMarket(market, { asset, timeframe }));
  }

  async getMarketBySlug(slug) {
    const rows = await this.gammaRequest('/markets', { slug });
    const market = Array.isArray(rows) ? rows[0] : rows;
    return market || null;
  }

  async getActiveWeatherEvents({ limit = 100 } = {}) {
    const requested = String(Math.min(Math.max(Number(limit) || 1, 1), 100));
    for (const order of ['volume24hr', 'volume_24hr']) {
      try {
        const payload = await this.gammaRequest('/events', {
          active: 'true',
          closed: 'false',
          tag_slug: 'weather',
          order,
          ascending: 'false',
          limit: requested
        });
        const rows = Array.isArray(payload) ? payload : payload?.data || [];
        if (rows.length) return rows;
      } catch {
        // Gamma rejects one of the order spellings; try the other.
      }
    }
    return [];
  }

  async getActiveEventsByTag({ tag, limit = 25 } = {}) {
    if (!tag) return [];
    const requested = Math.min(Math.max(Number(limit) || 1, 1), 100);
    try {
      return await this.fetchTaggedEvents({ tag, limit: requested, order: 'volume24hr' });
    } catch {
      return this.fetchTaggedEvents({ tag, limit: requested, order: 'volume_24hr' });
    }
  }

  async fetchTaggedEvents({ tag, limit, order }) {
    const payload = await this.gammaRequest('/events', {
      active: 'true',
      closed: 'false',
      tag_slug: tag,
      order,
      ascending: 'false',
      limit: String(limit)
    });
    const rows = Array.isArray(payload) ? payload : payload?.data || [];
    return rows;
  }

  async getActiveSportsEvents({ limit = 200 } = {}) {
    const requested = Math.min(Math.max(Number(limit) || 1, 1), 500);
    const events = [];
    for (let offset = 0; offset < requested; offset += 100) {
      const pageLimit = Math.min(100, requested - offset);
      // sports tag rejects volume_24hr; volume24hr matches Gamma's accepted order fields.
      const payload = await this.gammaRequest('/events', {
        active: 'true',
        closed: 'false',
        tag_slug: 'sports',
        order: 'volume24hr',
        ascending: 'false',
        limit: String(pageLimit),
        offset: String(offset)
      });
      const rows = Array.isArray(payload) ? payload : payload?.data || [];
      events.push(...rows);
      if (rows.length < pageLimit) break;
    }
    return events;
  }

  async getActiveNegativeRiskEvents({ limit = 300 } = {}) {
    const requested = Math.min(Math.max(Number(limit) || 1, 1), 500);
    const events = [];
    for (let offset = 0; offset < requested; offset += 100) {
      const pageLimit = Math.min(100, requested - offset);
      const payload = await this.gammaRequest('/events', {
        active: 'true',
        closed: 'false',
        order: 'volume24hr',
        ascending: 'false',
        limit: String(pageLimit),
        offset: String(offset)
      });
      const rows = Array.isArray(payload) ? payload : payload?.data || [];
      events.push(...rows);
      if (rows.length < pageLimit) break;
    }
    return events.filter((event) => event?.negRisk === true || String(event?.negRisk).toLowerCase() === 'true');
  }

  async getResolvedMarketOutcome(slug) {
    const named = await this.getNamedMarketOutcome(slug);
    return named?.actualDirection ? named : null;
  }

  async getNamedMarketOutcome(slug) {
    if (!slug) return null;
    // BTC/ETH updown 短窗：/markets?slug= 常返回 []，官方结果在 /events。
    // Gamma /markets omits closed markets unless closed=true is passed.
    const failures = [];
    const recordFailure = (error) => { failures.push(error); return []; };
    const markets = await this.request(
      `${this.gammaBaseUrl}/markets`, { slug }, { cacheTtlMs: 15_000 }
    ).catch(recordFailure);
    const direct = resolveNamedMarketOutcome(markets, slug);
    if (direct) return direct;
    const [closedMarkets, events] = await Promise.all([
      this.request(
        `${this.gammaBaseUrl}/markets`,
        { slug, closed: 'true' },
        { cacheTtlMs: 15_000 }
      ).catch(recordFailure),
      this.request(
        `${this.gammaBaseUrl}/events`,
        { slug },
        { cacheTtlMs: 15_000 }
      ).catch(recordFailure)
    ]);
    const outcome = resolveNamedMarketOutcome(closedMarkets, slug)
      || resolveNamedMarketOutcome(events, slug);
    if (outcome) return outcome;
    if (failures.length) throw new AggregateError(failures, `Official outcome lookup failed for ${slug}: ${failures.map((error) => error.message || String(error)).join('; ')}`);
    return null;
  }

  async getOrderBook(tokenId) {
    if (!tokenId) throw new Error('tokenId is required');
    return this.clobRequest('/book', { token_id: tokenId });
  }

  async getOrderBooks(tokenIds = []) {
    const unique = [...new Set(tokenIds.map(String).filter(Boolean))];
    if (!unique.length) return [];
    const chunks = [];
    for (let index = 0; index < unique.length; index += 500) chunks.push(unique.slice(index, index + 500));
    const pages = await Promise.all(chunks.map(async (chunk) => {
      const response = await fetch(`${this.clobBaseUrl}/books`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk.map((tokenId) => ({ token_id: tokenId }))),
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      });
      const text = await response.text();
      const data = text ? safeJson(text) : null;
      if (!response.ok) {
        throw new Error(typeof data === 'object' ? JSON.stringify(data) : text || response.statusText);
      }
      return Array.isArray(data) ? data : [];
    }));
    return pages.flat();
  }

  async getTokenPrice(tokenId, side = 'BUY') {
    if (!tokenId) throw new Error('tokenId is required');
    const payload = await this.clobRequest('/price', { token_id: tokenId, side });
    return Number(payload?.price);
  }

  async getTokenSpread(tokenId) {
    if (!tokenId) throw new Error('tokenId is required');
    const payload = await this.clobRequest('/spread', { token_id: tokenId });
    return Number(payload?.spread);
  }

  async getRecentTrades({ conditionId, limit = 20 } = {}) {
    if (!conditionId) throw new Error('conditionId is required');
    const payload = await this.dataRequest('/trades', {
      market: conditionId,
      limit: String(Math.min(Math.max(limit, 1), 100))
    });
    return Array.isArray(payload) ? payload : payload?.data || [];
  }

  async getUserActivity({ user, limit = 50 } = {}) {
    if (!user) throw new Error('user is required');
    const payload = await this.dataRequest('/activity', {
      user,
      limit: String(Math.min(Math.max(limit, 1), 500))
    });
    return Array.isArray(payload) ? payload : payload?.data || [];
  }

  async getTraderLeaderboard({
    category = 'OVERALL',
    timePeriod = 'WEEK',
    orderBy = 'PNL',
    limit = 25,
    offset = 0
  } = {}) {
    const payload = await this.dataRequest('/v1/leaderboard', {
      category: String(category || 'OVERALL').toUpperCase(),
      timePeriod: String(timePeriod || 'WEEK').toUpperCase(),
      orderBy: String(orderBy || 'PNL').toUpperCase(),
      limit: String(Math.min(Math.max(limit, 1), 50)),
      offset: String(Math.min(Math.max(offset, 0), 1000))
    });
    return Array.isArray(payload) ? payload : payload?.data || [];
  }

  async gammaRequest(path, query = {}) {
    return this.request(`${this.gammaBaseUrl}${path}`, query, { cacheTtlMs: 1500 });
  }

  async clobRequest(path, query = {}) {
    return this.request(`${this.clobBaseUrl}${path}`, query, { cacheTtlMs: 500 });
  }

  async dataRequest(path, query = {}) {
    return this.request(`${this.dataBaseUrl}${path}`, query, { cacheTtlMs: 2000 });
  }

  async request(url, query = {}, { cacheTtlMs = 0 } = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    }
    const target = params.size ? `${url}?${params}` : url;
    const now = Date.now();
    const cached = this.responseCache.get(target);
    if (cached && now - cached.at < cacheTtlMs) return cached.payload;
    if (this.inflightRequests.has(target)) return this.inflightRequests.get(target);

    const inflight = this.requestFresh(target)
      .then((payload) => {
        if (cacheTtlMs > 0) this.responseCache.set(target, { at: Date.now(), payload });
        this.inflightRequests.delete(target);
        this.pruneResponseCache();
        return payload;
      })
      .catch((error) => {
        this.inflightRequests.delete(target);
        throw error;
      });
    this.inflightRequests.set(target, inflight);
    return inflight;
  }

  async requestFresh(target) {
    const response = await fetch(target, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
    const text = await response.text();
    const data = text ? safeJson(text) : null;
    if (!response.ok) {
      throw new Error(typeof data === 'object' ? JSON.stringify(data) : text || response.statusText);
    }
    return data;
  }

  pruneResponseCache(now = Date.now()) {
    for (const [key, entry] of this.responseCache) {
      if (!entry || now - entry.at > 60_000) this.responseCache.delete(key);
    }
  }
}

export function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return String(value)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

export function parseMarketOutcomes(market) {
  const outcomes = parseJsonArray(market?.outcomes).map(String);
  const tokenIds = parseJsonArray(market?.clobTokenIds).map(String);
  const prices = parseJsonArray(market?.outcomePrices).map(Number);

  const upIndex = outcomes.findIndex((label) => /up|yes|higher|above/i.test(label));
  const downIndex = outcomes.findIndex((label) => /down|no|lower|below/i.test(label));
  const upIdx = upIndex >= 0 ? upIndex : 0;
  const downIdx = downIndex >= 0 ? downIndex : Math.min(1, outcomes.length - 1);

  return {
    outcomes,
    upTokenId: tokenIds[upIdx] || null,
    downTokenId: tokenIds[downIdx] || null,
    upPrice: Number(prices[upIdx]),
    downPrice: Number(prices[downIdx])
  };
}

export function resolveOfficialMarketOutcome(payload, slug = null) {
  const outcome = resolveNamedMarketOutcome(payload, slug);
  if (!outcome?.actualDirection) return null;
  return outcome;
}

export function resolveNamedMarketOutcome(payload, slug = null) {
  const events = Array.isArray(payload) ? payload : [payload].filter(Boolean);
  const markets = events.flatMap((event) => {
    const nested = Array.isArray(event?.markets) ? event.markets : [];
    return nested.length ? nested.map((market) => ({ event, market })) : [{ event, market: event }];
  });
  const selected = markets.find(({ market }) => !slug || market?.slug === slug) || markets[0];
  if (!selected?.market) return null;
  const { event, market } = selected;
  const outcomes = parseJsonArray(market.outcomes).map(String);
  const prices = parseJsonArray(market.outcomePrices).map(Number);
  if (outcomes.length < 2 || prices.length !== outcomes.length) return null;
  const winningIndex = prices.findIndex((price) => Number.isFinite(price) && price >= 0.999);
  const losingPrices = prices.filter((_, index) => index !== winningIndex);
  const finalized = market.closed === true || market.umaResolutionStatus === 'resolved';
  const resolved = winningIndex >= 0
    && losingPrices.every((price) => Number.isFinite(price) && price <= 0.001)
    && finalized;
  if (!resolved) {
    // 作废/平局（如赛事取消）：UMA 已 resolved 且已关闭，但没有一方拿到 1，outcomePrices 各 0.5。
    const allFinite = prices.every((price) => Number.isFinite(price));
    const sum = prices.reduce((total, price) => total + price, 0);
    const noWinner = prices.every((price) => price < 0.999);
    const isVoid = finalized && market.closed === true && market.umaResolutionStatus === 'resolved'
      && allFinite && noWinner && Math.abs(sum - 1) < 0.01;
    if (!isVoid) return null;
    return {
      actualDirection: null,
      officialOutcome: null,
      void: true,
      outcomes,
      outcomePrices: prices,
      conditionId: market.conditionId || null,
      startPrice: null,
      actualClose: null,
      priceSource: 'polymarket-official',
      resolvedAtIso: market.closedTime || market.umaEndDate || event?.closedTime || null
    };
  }
  const winningLabel = String(outcomes[winningIndex] || '').toLowerCase();
  const actualDirection = /up|yes|higher|above/.test(winningLabel)
    ? 'up'
    : /down|no|lower|below/.test(winningLabel)
      ? 'down'
      : null;
  if (!outcomes[winningIndex]) return null;
  return {
    actualDirection,
    officialOutcome: outcomes[winningIndex],
    outcomePrices: prices,
    conditionId: market.conditionId || null,
    startPrice: Number(event?.eventMetadata?.priceToBeat) || null,
    actualClose: Number(event?.eventMetadata?.finalPrice) || null,
    priceSource: 'polymarket-official',
    resolvedAtIso: market.closedTime || market.umaEndDate || event?.closedTime || null
  };
}

export function extractMarketTargetPrice(market) {
  if (!market || typeof market !== 'object') return null;
  const directKeys = [
    'targetPrice',
    'target_price',
    'strikePrice',
    'strike_price',
    'thresholdPrice',
    'threshold_price',
    'startPrice',
    'start_price',
    'openPrice',
    'open_price',
    'resolutionPrice',
    'resolution_price'
  ];
  for (const key of directKeys) {
    const value = parsePriceLike(market[key]);
    if (value != null) return { price: value, source: key };
  }

  const textFields = [
    market.question,
    market.title,
    market.description,
    market.resolutionSource,
    market.rules,
    market.outcomes,
    market.groupItemTitle
  ].filter(Boolean);
  const text = textFields.join('\n');
  const contextual = extractContextualDollarPrice(text);
  if (contextual != null) return { price: contextual, source: 'market_text' };
  const firstDollar = extractFirstDollarPrice(text);
  if (firstDollar != null) return { price: firstDollar, source: 'market_text_dollar' };
  return null;
}

function parsePriceLike(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 100 ? value : null;
  }
  const text = String(value);
  const match = text.match(/\$?\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.\d+)?|[0-9]{4,8}(?:\.\d+)?)/);
  if (!match) return null;
  const parsed = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 100 ? parsed : null;
}

function extractContextualDollarPrice(text) {
  if (!text) return null;
  const pattern = /(target|strike|threshold|starting|start|opening|open|resolution)[^$]{0,80}\$\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.\d+)?|[0-9]{4,8}(?:\.\d+)?)/ig;
  let match;
  while ((match = pattern.exec(text))) {
    const parsed = Number(match[2].replace(/,/g, ''));
    if (Number.isFinite(parsed) && parsed > 100) return parsed;
  }
  return null;
}

function extractFirstDollarPrice(text) {
  if (!text) return null;
  const match = text.match(/\$\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.\d+)?|[0-9]{4,8}(?:\.\d+)?)/);
  if (!match) return null;
  const parsed = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 100 ? parsed : null;
}

export const TIMEFRAME_SECONDS = {
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '1d': 86400
};

export function matchesCryptoUpDownMarket(market, { asset = 'bitcoin', timeframe = '15m' } = {}) {
  if (!market) return false;
  const text = `${market.question || ''} ${market.slug || ''} ${market.description || ''}`.toLowerCase();
  const identity = `${market.question || market.title || ''} ${market.slug || ''}`.toLowerCase();
  const assetAliases = {
    bitcoin: ['bitcoin', 'btc'],
    ethereum: ['ethereum', 'ether', 'eth'],
    solana: ['solana', 'sol'],
    xrp: ['xrp', 'ripple']
  };
  const aliases = assetAliases[asset] || [asset];
  const assetPattern = new RegExp(`\\b(${aliases.map(escapeRegExp).join('|')})\\b`, 'i');
  const hasAsset = assetPattern.test(text);
  const hasUpDown = /up or down|up\/down|up-down|up down/.test(text);
  if (!hasAsset || !hasUpDown) return false;
  if (market.enableOrderBook === false) return false;
  if (timeframe === '5m') {
    if (/updown-5m|up-down-5m/.test(identity)) return true;
    return /\b5m\b|5-min|5 minute|5 minutes/.test(identity) && !/15m|15-min|15 minute|15 minutes/.test(identity);
  }
  if (timeframe === '15m') {
    return /15m|15 m|15-min|15 minute|15 minutes/.test(identity);
  }
  if (timeframe === '1h' || timeframe === 'hourly') {
    return /1h|1 h|hourly|hour|60m|60 m/.test(identity)
      || /up-or-down-[a-z]+-\d{1,2}-(?:\d{4}-)?\d{1,2}(?:\d{2})?(?:am|pm)-et\b/.test(identity)
      || /,\s*\d{1,2}(?::00)?(?:am|pm)\s*et\b/.test(identity);
  }
  if (timeframe === '1d' || timeframe === 'daily') {
    const intraday = /updown-(5m|15m|1h|4h)|\b(5|15|60)\s*(m|min|minute)|\bhour|\d{1,2}:\d{2}/.test(identity);
    return !intraday && (/\bdaily\b|\b24\s*h\b|up or down on\b/.test(identity));
  }
  return true;
}

/** Polymarket crypto up/down slug prefix: bitcoin→btc, ethereum→eth, solana→sol, xrp→xrp */
export const CRYPTO_UPDOWN_SLUG_PREFIX = {
  bitcoin: 'btc',
  ethereum: 'eth',
  solana: 'sol',
  xrp: 'xrp'
};

export function cryptoUpDownSlugPrefix(asset = 'bitcoin') {
  const key = String(asset || 'bitcoin').toLowerCase().trim();
  return CRYPTO_UPDOWN_SLUG_PREFIX[key] || null;
}

export function buildCryptoUpDownMarketSlug(targetTimeIso, timeframe = '15m', asset = 'bitcoin') {
  const prefix = cryptoUpDownSlugPrefix(asset);
  if (!prefix) return null;
  const windowSeconds = TIMEFRAME_SECONDS[timeframe] || TIMEFRAME_SECONDS['15m'];
  const endMs = Date.parse(targetTimeIso);
  const slotStartSec = Math.floor((endMs - windowSeconds * 1000) / 1000 / windowSeconds) * windowSeconds;
  return `${prefix}-updown-${timeframe}-${slotStartSec}`;
}

export function buildBtcUpDownMarketSlug(targetTimeIso, timeframe = '15m') {
  return buildCryptoUpDownMarketSlug(targetTimeIso, timeframe, 'bitcoin');
}

export function buildBtc15mMarketSlug(targetTimeIso) {
  return buildBtcUpDownMarketSlug(targetTimeIso, '15m');
}

export async function findBtcUpDownMarket(client, targetTimeIso, timeframe = '15m') {
  return findCryptoUpDownMarket(client, targetTimeIso, timeframe, 'bitcoin');
}

export async function findCryptoUpDownMarket(client, targetTimeIso, timeframe = '15m', asset = 'bitcoin') {
  const slugCandidates = [
    buildCryptoUpDownMarketSlug(targetTimeIso, timeframe, asset),
    ...(timeframe === '1d' || timeframe === 'daily'
      ? buildDailyUpDownSlugCandidates(asset, getEtDateParts(new Date(targetTimeIso)))
      : []),
    ...(timeframe === '1h' || timeframe === 'hourly'
      ? buildHourlyUpDownSlugCandidates(asset, new Date(Date.parse(targetTimeIso) - 60_000))
      : [])
  ].filter(Boolean);

  for (const slug of [...new Set(slugCandidates)]) {
    const market = await client.getMarketBySlug(slug);
    if (market && market.closed !== true && !isLikelyResolvedMarket(parseMarketOutcomes(market))) {
      return market;
    }
  }

  return null;
}

export async function findBtc15mMarket(client, targetTimeIso) {
  return findBtcUpDownMarket(client, targetTimeIso, '15m');
}

export function pickBestIntervalMarket(markets, targetTimeIso, timeframe = '15m') {
  const targetMs = Date.parse(targetTimeIso);
  const now = Date.now();
  const staleReferenceMs = Math.min(now, targetMs);
  const normalized = String(timeframe || '15m').toLowerCase();
  const toleranceMs = normalized === '5m'
    ? 45_000
    : normalized === '1h' || normalized === 'hourly'
      ? 30 * 60_000
      : normalized === '1d' || normalized === 'daily'
        ? 6 * 60 * 60_000
        : 90_000;
  const candidates = (markets || [])
    .filter((market) => market?.active !== false && market?.closed !== true)
    .map((market) => ({
      market,
      endMs: Date.parse(market.endDate || market.endDateIso || 0),
      parsed: parseMarketOutcomes(market)
    }))
    .filter((item) => Number.isFinite(item.endMs))
    .filter((item) => item.endMs > staleReferenceMs - 60_000)
    .filter((item) => Math.abs(item.endMs - targetMs) <= toleranceMs)
    .filter((item) => !isLikelyResolvedMarket(item.parsed));

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const endDiff = Math.abs(a.endMs - targetMs) - Math.abs(b.endMs - targetMs);
    if (endDiff !== 0) return endDiff;
    return Number(b.market.volume24hr || b.market.volume || 0) - Number(a.market.volume24hr || a.market.volume || 0);
  });

  return candidates[0].market;
}

function isLikelyResolvedMarket(parsed) {
  const up = Number(parsed?.upPrice);
  const down = Number(parsed?.downPrice);
  if (!Number.isFinite(up) || !Number.isFinite(down)) return false;
  return up >= 0.95 || up <= 0.05 || down >= 0.95 || down <= 0.05;
}

function flattenMarkets(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) {
    return payload.flatMap((item) => {
      if (item?.markets?.length) return item.markets;
      if (item?.question || item?.slug) return [item];
      return [];
    });
  }
  if (payload.markets?.length) return payload.markets;
  if (payload.events?.length) return flattenMarkets(payload.events);
  if (payload.question || payload.slug) return [payload];
  return [];
}

function dedupeMarkets(markets) {
  const seen = new Set();
  const rows = [];
  for (const market of markets) {
    const key = market?.id || market?.conditionId || market?.slug;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push(market);
  }
  return rows;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
