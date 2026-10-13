import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'data/polymarket-paper-state.json',
  'data/polymarket-paper-state.json.bak',
  'data/polymarket-paper-state.json.corrupt-1783309759045.bak'
];

function summarize(parsed, label) {
  const lo = parsed.liveOrders || [];
  const lc = parsed.liveControl || {};
  const la = parsed.liveAuto || {};
  console.log(`${label}:`);
  console.log(`  liveOrders: ${lo.length}`);
  console.log(`  liveControl.enabled: ${lc.enabled}`);
  console.log(`  liveAuto.enabled: ${la.enabled}, planId: ${la.planId}`);
  if (lo.length > 0) {
    console.log(`  first: ${lo[0].id || lo[0].orderId} ${lo[0].createdAtIso} ${lo[0].status}`);
    console.log(`  last: ${lo[lo.length - 1].id || lo[lo.length - 1].orderId} ${lo[lo.length - 1].createdAtIso}`);
  }
}

for (const f of files) {
  const path = join(root, f);
  try {
    const raw = await readFile(path, 'utf8');
    try {
      summarize(JSON.parse(raw), f);
    } catch (e) {
      console.log(`${f}: INVALID JSON - ${e.message.slice(0, 100)}`);
      const idx = raw.indexOf('"liveOrders"');
      console.log(`  liveOrders key at: ${idx}`);
      if (idx >= 0) {
        const slice = raw.slice(idx, idx + 200);
        console.log(`  snippet: ${slice.replace(/\n/g, ' ').slice(0, 150)}`);
        const objs = (raw.match(/"side"\s*:\s*"(BUY|SELL)"/g) || []).length;
        console.log(`  approx side fields in file: ${objs}`);
      }
    }
  } catch (e) {
    console.log(`${f}: ERROR ${e.message}`);
  }
}
