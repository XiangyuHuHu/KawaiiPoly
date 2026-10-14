import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ledgerPaths, readJsonl } from './ledger.js';
import { normalizeSector, readNumber, signalIdentity } from './shape.js';

function coerceSignal(raw, defaults = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const sector = normalizeSector(raw.sector || raw.category || defaults.sector) || defaults.sector || null;
  return {
    ...raw,
    sector,
    slug: raw.slug || raw.marketSlug || raw.market_slug || null,
    side: raw.side || raw.direction || null,
    limit_price: readNumber(raw.limit_price, raw.limitPrice, raw.price, raw.ask, raw.market_price),
    size_usd: readNumber(raw.size_usd, raw.sizeUsd),
    edge: readNumber(raw.edge),
    model_prob: readNumber(raw.model_prob, raw.modelProb, raw.prob),
    ask: readNumber(raw.ask, raw.market_price, raw.marketPrice),
    spread: readNumber(raw.spread),
    spread_cents: readNumber(raw.spread_cents, raw.spreadCents),
    liquidity_usd: readNumber(raw.liquidity_usd, raw.liquidityUsd),
    status: raw.status || 'pending',
    _origin: defaults.origin
  };
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
}

function freshCandidate(row, now, maxAgeMs) {
  const scanned = Date.parse(row?.scanned_at || row?.scannedAt || row?.created_at || '');
  if (!Number.isFinite(scanned)) return false;
  return now.getTime() - scanned <= maxAgeMs && now.getTime() - scanned >= 0;
}

export async function loadUsSignals({
  ledgerDir,
  workspaceDir,
  now = new Date(),
  candidateMaxAgeMs = 6 * 60 * 60 * 1000
} = {}) {
  const paths = ledgerPaths(ledgerDir);
  const signals = [];
  const seen = new Set();
  const push = (signal) => {
    if (!signal?.slug) return;
    const key = signal.id ? String(signal.id) : signalIdentity(signal);
    if (seen.has(key)) return;
    seen.add(key);
    signals.push(signal);
  };

  const pendingRows = await readJsonl(paths.pending);
  pendingRows.forEach((row, index) => {
    push(coerceSignal(row, { origin: { kind: 'jsonl', file: paths.pending, index } }));
  });

  let signalFiles = [];
  try {
    signalFiles = await readdir(paths.signalsDir);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const name of signalFiles) {
    if (!name.endsWith('.json') || name === 'us-health.json') continue;
    const file = join(paths.signalsDir, name);
    const row = await readJson(file);
    const sectorHint = name.split('-')[0];
    push(coerceSignal(row, { sector: sectorHint, origin: { kind: 'json', file } }));
  }

  const candidates = await readJsonl(paths.candidates);
  candidates.forEach((row, index) => {
    if (!freshCandidate(row, now, candidateMaxAgeMs)) return;
    if (['filled', 'skipped', 'expired'].includes(String(row?.status || '').toLowerCase())) return;
    push(coerceSignal(row, { origin: { kind: 'jsonl', file: paths.candidates, index, readonly: true } }));
  });

  let entries = [];
  try {
    entries = await readdir(workspaceDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith('btc15-')) continue;
    const file = join(workspaceDir, entry.name, 'signal.json');
    const row = await readJson(file);
    if (!row) continue;
    const sector = entry.name.startsWith('btc15-mom') ? 'momentum' : 'btc_misprice';
    push(coerceSignal(row, { sector, origin: { kind: 'json', file } }));
  }

  return { signals, paths };
}

export async function persistSignalStatuses(results) {
  const jsonlGroups = new Map();
  const jsonFiles = [];
  for (const result of results) {
    if (!result?.updateStatus || !result?.signal?._origin) continue;
    const origin = result.signal._origin;
    if (origin.readonly) continue;
    if (origin.kind === 'jsonl') {
      if (!jsonlGroups.has(origin.file)) jsonlGroups.set(origin.file, new Map());
      jsonlGroups.get(origin.file).set(origin.index, result.status);
    } else if (origin.kind === 'json') {
      jsonFiles.push({ file: origin.file, status: result.status });
    }
  }

  for (const [file, updates] of jsonlGroups) {
    const rows = await readJsonl(file);
    for (const [index, status] of updates) {
      if (!rows[index]) continue;
      rows[index] = { ...rows[index], status, updated_at: new Date().toISOString() };
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  }

  for (const item of jsonFiles) {
    const row = await readJson(item.file);
    if (!row) continue;
    row.status = item.status;
    row.updated_at = new Date().toISOString();
    await writeFile(item.file, `${JSON.stringify(row, null, 2)}\n`, 'utf8');
  }
}
