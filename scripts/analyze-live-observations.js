import { readFile } from 'node:fs/promises';
import { observationGrid, formatGrid, summarizePicks, selectFirst, indexSettlements } from '../src/polymarketUs/liveAnalyze.js';
import { defaultLedgerRoot, usPaths } from '../src/polymarketUs/signals.js';

function parseJsonl(text) {
  return String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

async function read(path) {
  try {
    return parseJsonl(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

const paths = usPaths(defaultLedgerRoot());
const obsPath = process.argv[2] || paths.liveObservations;
const settledPath = process.argv[3] || paths.liveObservationsSettled;
const rows = await read(obsPath);
const settled = indexSettlements(await read(settledPath));

console.log(`observations=${rows.length} settled_markets=${settled.size}`);
console.log(`file=${obsPath}`);
console.log('\n# endgame threshold x price cap (first hit, $1)');
console.log(formatGrid(observationGrid(rows, settled, { phase: 'endgame' })));

const paper = selectFirst(rows, (row) => (
  row?.sport === 'soccer'
  && row?.rule_pass?.would_signal_paper === true
  && Number(row.model_prob) >= 0.8
  && Number(row.ask) <= 0.93
));
const paperStats = summarizePicks(paper, settled);
const roi = paperStats.roi == null ? 'n/a' : `${(paperStats.roi * 100).toFixed(1)}%`;
console.log(`\n# soccer paper cohort (early/mid/late, devig>=0.80, ask<=0.93)`);
console.log(`n=${paperStats.n} events=${paperStats.events} hit=${paperStats.hit == null ? 'n/a' : `${(paperStats.hit * 100).toFixed(1)}%`} roi=${roi}`);
