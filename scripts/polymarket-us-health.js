import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { publicUsConfig, buildPolymarketUsConfig } from '../src/polymarketUs/config.js';
import { ledgerPaths } from '../src/polymarketUs/ledger.js';

const config = publicUsConfig(buildPolymarketUsConfig());
let last = null;
try {
  last = JSON.parse(await readFile(ledgerPaths(config.ledgerDir).health, 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
console.log(JSON.stringify({ config, lastRun: last }, null, 2));
