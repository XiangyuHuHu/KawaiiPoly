import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PolymarketClient } from '../src/polymarketClient.js';
import { getConfig } from '../src/config.js';

const folder = resolve(process.argv[2] || 'data/analysis/plan14-backtest-20261004');
const input = JSON.parse(readFileSync(join(folder, 'input.json'), 'utf8'));
const path = join(folder, 'official-outcomes.json');
let outcomes = {};
try { outcomes = JSON.parse(readFileSync(path, 'utf8')); } catch {}
for (const o of input.orders) {
  if (o.marketSlug && ['up', 'down'].includes(o.actualDirection)
    && (o.settlementPriceSource === 'polymarket-official' || o.counterfactualOutcomeSource === 'polymarket-official')) {
    outcomes[o.marketSlug] = { actualDirection: o.actualDirection, source: 'persisted-polymarket-official',
      verifiedAtIso: o.officialOutcomeVerifiedAtIso || o.exitDecisionEvaluatedAtIso || o.settledAtIso };
  }
}
const slugs = [...new Set([...input.orders.map(o => o.marketSlug), ...input.opportunities.map(o => o.marketSlug)])]
  .filter(slug => slug && !outcomes[slug]?.actualDirection);
const client = new PolymarketClient(getConfig().polymarket);
let next = 0, completed = 0, found = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < slugs.length) {
    const slug = slugs[next++];
    try {
      const value = await client.getResolvedMarketOutcome(slug);
      if (value?.actualDirection) {
        outcomes[slug] = { ...value, source: 'fetched-polymarket-official', verifiedAtIso: new Date().toISOString() };
        found++;
      }
    } catch { /* An unresolved request is missing data, never a win/loss guess. */ }
    completed++;
    if (completed % 20 === 0) {
      writeFileSync(path, JSON.stringify(outcomes));
      console.log(JSON.stringify({ completed, requested: slugs.length, fetched: found }));
    }
  }
}));
writeFileSync(path, JSON.stringify(outcomes));
console.log(JSON.stringify({ completed, requested: slugs.length, fetched: found, officialMarkets: Object.keys(outcomes).length }));
