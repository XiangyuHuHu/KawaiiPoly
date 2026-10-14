import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { eventUrl } from './gateway.js';
import { ledgerPaths, readJsonl as readLedgerJsonl } from './ledger.js';
import { normalizeSector, readNumber, signalIdentity } from './shape.js';
import { formatPtTimestamp, formatWindowStamp } from './time.js';

const SECRET_KEY = /private|secret|mnemonic|passphrase|apikey|api_key/i;

export function defaultLedgerRoot() {
  return process.env.POLYMARKET_US_LEDGER_DIR || '/workspace/polymarket-ledger';
}

export function defaultWorkspaceRoot() {
  return process.env.POLYMARKET_US_WORKSPACE_ROOT || '/workspace';
}

export function usPaths(ledgerRoot = defaultLedgerRoot(), workspaceRoot = defaultWorkspaceRoot()) {
  return {
    ledgerRoot,
    workspaceRoot,
    signalsDir: join(ledgerRoot, 'signals'),
    pending: join(ledgerRoot, 'signals', 'pending.jsonl'),
    candidates: join(ledgerRoot, 'candidates.jsonl'),
    emitted: join(ledgerRoot, 'status', 'emitted-ids.json'),
    status: join(ledgerRoot, 'status'),
    picks: join(ledgerRoot, 'picks.jsonl'),
    realOrders: join(ledgerRoot, 'real-orders.jsonl'),
    momentumTrials: join(ledgerRoot, 'momentum-trial.jsonl'),
    account: join(ledgerRoot, 'account.json'),
    modelInput: join(ledgerRoot, 'model-input.jsonl'),
    digests: join(ledgerRoot, 'digests')
  };
}

export async function readJsonl(path) {
  return readLedgerJsonl(path);
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

function assertNoSecrets(value) {
  const keys = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      if (SECRET_KEY.test(key)) keys.push(key);
      walk(node[key]);
    }
  };
  walk(value);
  if (keys.length) throw new Error(`refusing to write secret-like fields: ${keys.join(',')}`);
}

export function signalStamp(signal) {
  const when = signal?.window_id || signal?.expires_at;
  return formatWindowStamp(when || new Date());
}

export function sectorSignalPath(ledgerRoot, signal) {
  return join(ledgerRoot, 'signals', `${signal.sector}-${signalStamp(signal)}.json`);
}

export function compatSignalPath(workspaceRoot, signal) {
  if (signal?.timeframe !== '15m') return null;
  const stamp = signalStamp(signal);
  if (signal.sector === 'btc-misprice') return join(workspaceRoot, `btc15-${stamp}`, 'signal.json');
  if (signal.sector === 'momentum') return join(workspaceRoot, `btc15-mom-${stamp}`, 'signal.json');
  return null;
}

export function toCandidateRow(signal, scannedAt) {
  const price = Number(signal.ask);
  const edge = Number(signal.edge);
  let action = '跳过';
  if (signal.status === 'pending') action = signal.size_usd >= 3 ? '正常仓' : '小仓';
  return {
    scanned_at: scannedAt,
    category: signal.sector,
    title: signal.basis || signal.slug,
    side: signal.side,
    url: signal.event_url || eventUrl(signal.slug),
    market_price: price,
    model_prob: signal.model_prob,
    edge,
    confidence: Math.abs(edge) >= 0.08 ? 'High' : 'Med',
    liquidity_usd: signal.gates?.liquidity_usd ?? signal.gates?.depth_usd ?? null,
    spread_cents: signal.gates?.spread_cents ?? null,
    expires_in: signal.expires_at,
    resolution_source: signal.sector === 'btc-misprice' || signal.sector === 'momentum'
      ? 'CF Benchmarks BRTI'
      : null,
    resolution_risk: 'Low',
    basis: signal.basis,
    main_risk: '美国版单边持仓，反方向相当于平仓',
    action,
    id: signal.id,
    status: signal.status
  };
}

export async function publishUsSignal({
  ledgerRoot,
  workspaceRoot,
  signal,
  now = new Date()
}) {
  assertNoSecrets(signal);
  if (signal?.status !== 'pending' || signal?.auto_order?.scanner_places_orders !== false) {
    throw new Error('scanner can only publish pending signals and cannot place orders');
  }
  if (!String(signal.event_url || '').startsWith('https://polymarket.us/event/')) {
    throw new Error('event_url must be a polymarket.us event link');
  }
  const paths = usPaths(ledgerRoot, workspaceRoot);
  const emitted = await readJson(paths.emitted, { ids: [] });
  const ids = new Set(Array.isArray(emitted.ids) ? emitted.ids : []);
  const pending = await readJsonl(paths.pending);
  if (ids.has(signal.id) || pending.some((row) => row.id === signal.id)) {
    return { wrote: false, reason: 'already-published', id: signal.id };
  }
  const sectorPath = sectorSignalPath(ledgerRoot, signal);
  const candidate = toCandidateRow(signal, formatPtTimestamp(now));
  assertNoSecrets(candidate);
  await mkdir(dirname(sectorPath), { recursive: true });
  await writeFile(sectorPath, `${JSON.stringify(signal, null, 2)}\n`);
  await appendFile(paths.pending, `${JSON.stringify(signal)}\n`);
  await appendFile(paths.candidates, `${JSON.stringify(candidate)}\n`);
  const compat = compatSignalPath(workspaceRoot, signal);
  if (compat) {
    await mkdir(dirname(compat), { recursive: true });
    await writeFile(compat, `${JSON.stringify(signal, null, 2)}\n`);
  }
  ids.add(signal.id);
  await mkdir(dirname(paths.emitted), { recursive: true });
  const kept = [...ids].slice(-500);
  await writeFile(paths.emitted, `${JSON.stringify({ ids: kept }, null, 2)}\n`);
  return { wrote: true, reason: 'published', id: signal.id, sectorPath, compat };
}

export async function writeStatus(ledgerRoot, name, payload) {
  const path = join(usPaths(ledgerRoot).status, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...payload, at: new Date().toISOString() }, null, 2)}\n`);
}

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

async function readJsonOrNull(file) {
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
    const row = await readJsonOrNull(file);
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
    const row = await readJsonOrNull(file);
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
    const row = await readJsonOrNull(item.file);
    if (!row) continue;
    row.status = item.status;
    row.updated_at = new Date().toISOString();
    await writeFile(item.file, `${JSON.stringify(row, null, 2)}\n`, 'utf8');
  }
}
