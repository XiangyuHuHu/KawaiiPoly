/**
 * us:live-observe 在写完观察日志之后，只下 live_endgame_v2 的 pending。
 * 其他板块仍只由 polymarket:us 下。
 */

import { liveEndgameV2Enabled } from './constants.js';
import { buildPolymarketUsConfig } from './config.js';
import { readJsonl } from './ledger.js';
import { runPolymarketUsCycle } from './runner.js';
import { normalizeSector } from './shape.js';
import { usPaths } from './signals.js';

function openPending(row) {
  return !['filled', 'skipped', 'expired'].includes(String(row?.status || 'pending'));
}

export async function placePendingLiveEndgameV2({
  ledgerRoot,
  workspaceRoot,
  config,
  now,
  gateway,
  trading,
  fetchQuotes,
  buyingPower,
  fetchImpl,
  runCycle = runPolymarketUsCycle
} = {}) {
  if (!liveEndgameV2Enabled()) {
    return { placed: 0, enabled: false, skipReasons: [], report: null };
  }
  const pending = await readJsonl(usPaths(ledgerRoot, workspaceRoot).pending);
  const waiting = pending.filter((row) => (
    normalizeSector(row.sector) === 'live_endgame_v2' && openPending(row)
  ));
  if (!waiting.length) {
    return { placed: 0, enabled: true, skipReasons: [], report: null };
  }
  const built = config || buildPolymarketUsConfig();
  const report = await runCycle({
    sector: 'live_endgame_v2',
    now,
    gateway,
    trading,
    fetchQuotes,
    buyingPower,
    fetchImpl,
    config: { ...built, ledgerDir: ledgerRoot, workspaceDir: workspaceRoot }
  });
  const skipReasons = [];
  for (const row of report.results || []) {
    if ((row.action === 'skip' || row.action === 'defer') && row.code) skipReasons.push(row.code);
  }
  return { placed: report.placed || 0, enabled: true, skipReasons, report };
}
