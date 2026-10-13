const CACHE_MS = 20_000;

export const PREDICTION_CATEGORIES = [
  {
    id: 'sports',
    label: '体育',
    tag: 'sports',
    tradable: 'paper',
    why: 'Plan15 模拟买入 2 天内结算、领先结果在 40–70¢ 的单场。永续不买。'
  },
  {
    id: 'esports',
    label: '电竞',
    tag: 'esports',
    tradable: 'paper',
    why: '系列赛胜负有官方结果。Plan15 只买价差够窄、两周内结束的领先结果。'
  },
  {
    id: 'weather',
    label: '天气',
    tag: 'weather',
    tradable: 'paper',
    why: '温度区间在观测截止后结算。Plan15 买领先结果。Plan16 用机场集合预报，只在扣费后仍高出盘口时买入。'
  },
  {
    id: 'politics',
    label: '政治选举',
    tag: 'politics',
    tradable: 'paper',
    why: '只买 2 天内结束的市场。更长的选举不占用这笔模拟现金。'
  },
  {
    id: 'finance',
    label: '宏观金融',
    tag: 'finance',
    fallbackTags: ['business', 'economy'],
    tradable: 'paper',
    why: '利率、财报、指数点位按官方结果结算。Plan15 与 5 分钟涨跌分开记账。'
  },
  {
    id: 'crypto',
    label: '加密事件',
    tag: 'crypto',
    tradable: 'paper',
    why: '价格目标和上所、ETF 一类事件盘进 Plan15。5 分钟和 15 分钟涨跌仍走 Plan14。'
  }
];

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function isShortWindowCryptoUpDown(event) {
  const text = `${event?.slug || ''} ${event?.title || ''}`.toLowerCase();
  return /up or down|up-or-down|updown-/.test(text);
}

function leadingOutcome(market) {
  const names = parseList(market?.outcomes);
  const prices = parseList(market?.outcomePrices);
  let best = null;
  names.forEach((name, index) => {
    const price = finite(prices[index]);
    if (price == null) return;
    if (!best || price > best.price) best = { outcome: String(name), price };
  });
  return best;
}

export function summarizePredictionEvent(event) {
  const markets = (Array.isArray(event?.markets) ? event.markets : [])
    .filter((market) => market && market.closed !== true && market.active !== false);
  const ranked = [...markets].sort((left, right) => (
    (finite(right.volume24hr) || finite(right.volume) || 0) - (finite(left.volume24hr) || finite(left.volume) || 0)
  ));
  const market = ranked[0] || null;
  const leader = market ? leadingOutcome(market) : null;
  const slug = String(event?.slug || '');
  return {
    slug,
    title: String(event?.title || market?.question || slug),
    endDate: event?.endDate || market?.endDate || null,
    volume24hr: finite(event?.volume24hr) || finite(event?.volume) || 0,
    liquidity: finite(event?.liquidity) || 0,
    marketCount: markets.length,
    leader: leader
      ? {
        question: market.question || market.groupItemTitle || event?.title || '',
        outcome: leader.outcome,
        price: leader.price
      }
      : null,
    url: slug ? `https://polymarket.com/event/${slug}` : null
  };
}

export class PolymarketCatalog {
  constructor({ client, cacheMs = CACHE_MS, now = () => Date.now() } = {}) {
    this.client = client;
    this.cacheMs = cacheMs;
    this.now = now;
    this.cache = new Map();
  }

  categories() {
    return PREDICTION_CATEGORIES.map((item) => ({
      id: item.id,
      label: item.label,
      tradable: item.tradable,
      why: item.why
    }));
  }

  async snapshot({ category } = {}) {
    const selected = category
      ? PREDICTION_CATEGORIES.filter((item) => item.id === category)
      : PREDICTION_CATEGORIES;
    const boards = await Promise.all(selected.map((item) => this.loadCategory(item)));
    return {
      updatedAtIso: new Date(this.now()).toISOString(),
      categories: this.categories(),
      boards
    };
  }

  async loadCategory(item) {
    const cached = this.cache.get(item.id);
    if (cached && this.now() - cached.at < this.cacheMs) return cached.value;
    const tags = [item.tag, ...(item.fallbackTags || [])];
    let events = [];
    let usedTag = item.tag;
    let error = null;
    for (const tag of tags) {
      try {
        const rows = await this.client.getActiveEventsByTag({ tag, limit: 25 });
        events = Array.isArray(rows) ? rows : [];
        usedTag = tag;
        error = null;
        if (events.length) break;
      } catch (cause) {
        error = cause?.message || String(cause);
      }
    }
    if (item.id === 'crypto') {
      events = events.filter((event) => !isShortWindowCryptoUpDown(event));
    }
    const value = {
      id: item.id,
      label: item.label,
      tag: usedTag,
      tradable: item.tradable,
      why: item.why,
      error,
      count: 0,
      events: []
    };
    value.events = events
      .map(summarizePredictionEvent)
      .filter((row) => row.slug)
      .sort((left, right) => right.volume24hr - left.volume24hr)
      .slice(0, 12);
    value.count = value.events.length;
    this.cache.set(item.id, { at: this.now(), value });
    return value;
  }
}
