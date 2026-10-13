const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function normalizedText(value) {
  return String(value || '').trim().toLowerCase();
}

function evidenceScopeCandidates({ symbol, timeframe, entryType }) {
  const wantedSymbol = String(symbol || '').trim().toUpperCase();
  const wantedTimeframe = normalizedText(timeframe);
  const wantedEntryType = normalizedText(entryType);
  const matches = ({ matchSymbol = false, matchTimeframe = false, matchEntryType = false }) => (row) => (
    (!matchSymbol || String(row?.symbol || '').trim().toUpperCase() === wantedSymbol)
    && (!matchTimeframe || normalizedText(row?.timeframe) === wantedTimeframe)
    && (!matchEntryType || normalizedText(row?.entryType) === wantedEntryType)
  );
  const candidates = [];
  if (wantedSymbol && wantedTimeframe && wantedEntryType) {
    candidates.push({ scope: 'symbol+timeframe+entry', match: matches({ matchSymbol: true, matchTimeframe: true, matchEntryType: true }) });
  }
  if (wantedSymbol && wantedTimeframe) {
    candidates.push({ scope: 'symbol+timeframe', match: matches({ matchSymbol: true, matchTimeframe: true }) });
  }
  if (wantedSymbol) candidates.push({ scope: 'symbol', match: matches({ matchSymbol: true }) });
  if (wantedTimeframe) candidates.push({ scope: 'timeframe', match: matches({ matchTimeframe: true }) });
  candidates.push({ scope: 'plan', match: () => true });
  return candidates;
}

function usableSettlement(row) {
  return row?.won === true || row?.won === false;
}

export function selectAdaptiveRiskEvidence({
  liveOrders = [],
  paperOrders = [],
  symbol = null,
  timeframe = null,
  entryType = null,
  minSamples = 12,
  paperWeight = 0.20
} = {}) {
  const live = liveOrders.filter(usableSettlement);
  const paper = paperOrders.filter(usableSettlement);
  const candidates = evidenceScopeCandidates({ symbol, timeframe, entryType });
  let broadest = { scope: 'plan', liveOrders: live, paperOrders: paper, effectiveSamples: live.length + paper.length * paperWeight };
  for (const candidate of candidates) {
    const matchingLive = live.filter(candidate.match);
    const matchingPaper = paper.filter(candidate.match);
    const effectiveSamples = matchingLive.length + matchingPaper.length * paperWeight;
    broadest = {
      scope: candidate.scope,
      liveOrders: matchingLive,
      paperOrders: matchingPaper,
      effectiveSamples
    };
    if (effectiveSamples >= minSamples) return broadest;
  }
  return broadest;
}

function summarizeWeightedEvidence({ liveOrders, paperOrders, paperWeight, fallbackEntryPrice }) {
  const weightedRows = [
    ...liveOrders.map((row) => ({ row, weight: 1 })),
    ...paperOrders.map((row) => ({ row, weight: paperWeight }))
  ];
  let samples = 0;
  let wins = 0;
  let investedUsd = 0;
  let pnlUsd = 0;
  let priceWeight = 0;
  let weightedEntryPrice = 0;
  for (const { row, weight } of weightedRows) {
    samples += weight;
    if (row.won === true) wins += weight;
    const usd = Math.max(0, Number(row.usd) || 0);
    investedUsd += usd * weight;
    pnlUsd += (Number(row.pnl) || 0) * weight;
    const entryPrice = Number(row.entryPrice ?? row.limitPrice);
    if (Number.isFinite(entryPrice) && entryPrice > 0 && entryPrice < 1) {
      weightedEntryPrice += entryPrice * weight;
      priceWeight += weight;
    }
  }
  const fallback = clamp(Number(fallbackEntryPrice) || 0.5, 0.01, 0.99);
  const breakEvenWinRate = priceWeight > 0 ? clamp(weightedEntryPrice / priceWeight, 0.01, 0.99) : fallback;
  const priorSamples = 6;
  const calibratedWinRate = samples > 0
    ? (wins + breakEvenWinRate * priorSamples) / (samples + priorSamples)
    : breakEvenWinRate;
  return {
    samples,
    liveSamples: liveOrders.length,
    paperSamples: paperOrders.length,
    rawWinRate: samples > 0 ? wins / samples : null,
    calibratedWinRate,
    breakEvenWinRate,
    calibratedEdge: calibratedWinRate - breakEvenWinRate,
    investedUsd,
    pnlUsd,
    realizedRoi: investedUsd > 0 ? pnlUsd / investedUsd : 0
  };
}

function signalFactor({ confidence, edge, qualityScore }) {
  const scores = [];
  const confidenceNumber = Number(confidence);
  if (Number.isFinite(confidenceNumber)) scores.push(clamp((confidenceNumber - 0.52) / 0.28, 0, 1));
  const edgeNumber = Number(edge);
  if (Number.isFinite(edgeNumber)) scores.push(clamp(edgeNumber / 0.18, 0, 1));
  const qualityNumber = Number(qualityScore);
  if (Number.isFinite(qualityNumber)) scores.push(clamp((qualityNumber - 0.30) / 0.55, 0, 1));
  const average = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 0.5;
  return 0.78 + average * 0.30;
}

export function computeAdaptiveLiveOrderCap({
  equity,
  absoluteMaxUsd = 100,
  baseEquityPct = 0.08,
  floorEquityPct = 0.03,
  maxEquityPct = 0.10,
  minOrderUsd = 5,
  minSamples = 12,
  paperWeight = 0.20,
  liveOrders = [],
  paperOrders = [],
  symbol = null,
  timeframe = null,
  entryType = null,
  entryPrice = 0.5,
  confidence = null,
  edge = null,
  qualityScore = null
} = {}) {
  const principal = Math.max(0, Number(equity) || 0);
  const selected = selectAdaptiveRiskEvidence({
    liveOrders,
    paperOrders,
    symbol,
    timeframe,
    entryType,
    minSamples,
    paperWeight
  });
  const evidence = summarizeWeightedEvidence({
    liveOrders: selected.liveOrders,
    paperOrders: selected.paperOrders,
    paperWeight,
    fallbackEntryPrice: entryPrice
  });
  const sampleConfidence = clamp(evidence.samples / Math.max(1, minSamples), 0, 1);
  const measuredPerformance = clamp(
    0.70 + evidence.calibratedEdge * 2 + evidence.realizedRoi * 0.80,
    0.40,
    1.20
  );
  const dataFactor = 0.70 + (measuredPerformance - 0.70) * sampleConfidence;
  const currentSignalFactor = signalFactor({ confidence, edge, qualityScore });
  const adaptiveEquityPct = clamp(
    (Number(baseEquityPct) || 0.08) * dataFactor * currentSignalFactor,
    Number(floorEquityPct) || 0.03,
    Number(maxEquityPct) || 0.10
  );
  const capBeforeAbsolute = Math.max(Number(minOrderUsd) || 0, principal * adaptiveEquityPct);
  const capUsd = Math.min(Math.max(0, Number(absoluteMaxUsd) || 0), capBeforeAbsolute);
  return {
    capUsd,
    equityPct: adaptiveEquityPct,
    dataFactor,
    signalFactor: currentSignalFactor,
    sampleConfidence,
    scope: selected.scope,
    ...evidence
  };
}
