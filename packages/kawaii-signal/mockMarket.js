const MOCK_BASE_PRICES = {
  'BTC-USD': 68420.12,
  'ETH-USD': 3520.44,
  'DOGE-USD': 0.1642,
  'SOL-USD': 152.81,
  'XRP-USD': 0.62
};

const mockWalkState = new Map();

function nextMockPrice(symbol, index = 0) {
  let walk = mockWalkState.get(symbol);
  if (!walk) {
    walk = { price: MOCK_BASE_PRICES[symbol] || 100 + index * 10, drift: 0 };
    mockWalkState.set(symbol, walk);
  }

  walk.drift = walk.drift * 0.96 + (Math.random() - 0.5) * 0.0016;
  const noise = (Math.random() - 0.5) * 0.004;
  walk.price = Math.max(walk.price * (1 + walk.drift + noise), 0.000001);
  return walk.price;
}

export function generateMockPriceSeries(symbols, length = 120) {
  const series = {};
  for (const [index, symbol] of symbols.entries()) {
    series[symbol] = Array.from({ length }, () => nextMockPrice(symbol, index));
  }
  return series;
}

export function createMockMarket(symbols = ['BTC-USD', 'ETH-USD']) {
  return {
    results: symbols.map((symbol, index) => {
      const price = nextMockPrice(symbol, index);
      return {
        symbol,
        price: price.toFixed(8),
        bid_inclusive_of_sell_spread: (price * 0.9994).toFixed(8),
        sell_spread: (price * 0.0006).toFixed(8),
        ask_inclusive_of_buy_spread: (price * 1.0006).toFixed(8),
        buy_spread: (price * 0.0006).toFixed(8),
        timestamp: new Date().toISOString(),
        mock: true
      };
    })
  };
}
