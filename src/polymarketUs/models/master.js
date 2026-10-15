import { round4, yesQuote } from './math.js';

function strikeFrom(market) {
  const description = String(market?.description || '');
  const above = description.match(/(?:above|or above)\s*\$?([\d,]+(?:\.\d+)?)/i);
  if (!above) return null;
  const value = Number(above[1].replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  return value >= 1000 ? Math.round(value / 1000) * 1000 : value;
}

function pushRow(rows, market, prob, basis) {
  if (!(prob > 0.05 && prob < 0.95) || !market?.slug) return;
  rows.push({
    sector: 'master',
    slug: market.slug,
    side: 'Yes',
    model_prob: round4(prob),
    title: market.question || market.slug,
    question: market.question || '',
    category: market.category || 'master',
    resolution_risk: 'Med',
    confidence: 'Med',
    basis,
    expires_at: market.endDate || null,
    window_id: market.slug
  });
}

export function masterRowsFromMarkets(markets = []) {
  const rows = [];
  const groups = new Map();
  for (const market of markets) {
    if (market?.closed === true || market?.active === false) continue;
    if (!/only one outcome/i.test(market?.description || '')) continue;
    const quote = yesQuote(market);
    if (!quote) continue;
    const key = `${market.question || ''}|${String(market.endDate || '').slice(0, 10)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ market, ...quote });
  }
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    const sum = bucket.reduce((total, row) => total + row.mid, 0);
    if (!(sum > 0) || Math.abs(sum - 1) < 0.08) continue;
    for (const row of bucket) {
      const fair = row.mid / sum;
      if (fair - row.ask < 0.03) continue;
      pushRow(
        rows,
        row.market,
        fair,
        `同一问题互斥合约中间价合计 ${(sum * 100).toFixed(1)}%，归一后 ${(fair * 100).toFixed(1)}%，卖价 ${(row.ask * 100).toFixed(1)}%。`
      );
    }
  }

  const ladders = new Map();
  for (const market of markets) {
    if (!/at any point/i.test(market?.description || '')) continue;
    const strike = strikeFrom(market);
    const quote = yesQuote(market);
    if (!strike || !quote) continue;
    const key = `${market.question || ''}|${String(market.endDate || '').slice(0, 10)}`;
    if (!ladders.has(key)) ladders.set(key, []);
    ladders.get(key).push({ market, strike, ...quote });
  }
  for (const ladder of ladders.values()) {
    const ordered = ladder.sort((left, right) => left.strike - right.strike);
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const lower = ordered[index];
      const higher = ordered.slice(index + 1).reduce((best, row) => (row.mid > best.mid ? row : best), ordered[index + 1]);
      if (higher.mid - lower.ask < 0.03) continue;
      pushRow(
        rows,
        lower.market,
        Math.max(lower.mid, higher.mid),
        `触及阶梯不一致：${lower.strike} 卖价 ${(lower.ask * 100).toFixed(1)}% 低于更高档 ${higher.strike} 的 ${(higher.mid * 100).toFixed(1)}%。`
      );
    }
  }
  return rows.slice(0, 12);
}
