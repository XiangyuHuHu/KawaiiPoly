/** CF Benchmarks BRTI window price: mean of 60 one-second prints, 2 decimals. */

export function brtiOfficialPrice(samples) {
  const values = (Array.isArray(samples) ? samples : [])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (values.length < 60) {
    return { ok: false, reason: 'need-60-prints', count: values.length };
  }
  const last = values.slice(-60);
  const mean = last.reduce((sum, value) => sum + value, 0) / 60;
  return { ok: true, price: Math.round(mean * 100) / 100, count: 60 };
}

/** Yes / Up when the window-end official price is greater than or equal to the start. */
export function brtiSettlesUp(startPrice, endPrice) {
  const start = Number(startPrice);
  const end = Number(endPrice);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round(end * 100) / 100 >= Math.round(start * 100) / 100;
}

export function settlementFromUsMarket(market) {
  const terms = market?.assetPriceTerms;
  if (!terms || terms.indexSymbol !== 'BRTI') return null;
  const start = Number(terms.priceToBeat?.value);
  const end = Number(terms.settlementPrice?.value);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const up = brtiSettlesUp(start, end);
  return {
    source: 'cf-benchmarks-brti',
    startPrice: Math.round(start * 100) / 100,
    endPrice: Math.round(end * 100) / 100,
    direction: up ? 'up' : 'down',
    officialOutcome: up ? 'Up' : 'Down'
  };
}
