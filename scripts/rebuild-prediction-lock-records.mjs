import { PredictionRecorder } from '../src/predictionRecorder.js';
import { getConfig } from '../src/config.js';

const config = getConfig();
const recordDir = process.argv[2] || config.predictionRecords.recordDir;

const recorder = new PredictionRecorder({
  recordDir,
  fetchQuotes: async () => [],
  enabled: true
});

const repair = await recorder.repairIntervalPmLockRecords();
const rebuild = await recorder.rebuildAllDailyMarkdown();
const summary = await recorder.readIntervalPmLockSummary();

console.log(`recordDir: ${recordDir}`);
console.log(`repaired 15m legacy lock rows: ${repair.repaired}`);
if (repair.dates.length) {
  console.log(`repair dates: ${repair.dates.join(', ')}`);
}
console.log(`rebuilt daily markdown files: ${rebuild.dates.length} (${rebuild.recordCount} records)`);
if (rebuild.dates.length) {
  console.log(`rebuild dates: ${rebuild.dates.join(', ')}`);
}
console.log(
  `15m PM lock summary: ${summary.fifteenMinute.polymarket.correct}/${summary.fifteenMinute.polymarket.total} (${(summary.fifteenMinute.polymarket.accuracy * 100).toFixed(1)}%)`
);
console.log(
  `5m PM lock summary: ${summary.fiveMinute.polymarket.correct}/${summary.fiveMinute.polymarket.total} (${(summary.fiveMinute.polymarket.accuracy * 100).toFixed(1)}%)`
);
