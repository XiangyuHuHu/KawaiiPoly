import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function readJsonl(file) {
  try {
    const text = await readFile(file, 'utf8');
    return text.split('\n').map((line) => line.trim()).filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function appendJsonl(file, row) {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(row)}\n`, 'utf8');
}

export async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8');
  await rename(temp, file);
}

export function ledgerPaths(ledgerDir) {
  return {
    dir: ledgerDir,
    signalsDir: join(ledgerDir, 'signals'),
    pending: join(ledgerDir, 'signals', 'pending.jsonl'),
    candidates: join(ledgerDir, 'candidates.jsonl'),
    realOrders: join(ledgerDir, 'real-orders.jsonl'),
    calibration: join(ledgerDir, 'calibration.jsonl'),
    momentum: join(ledgerDir, 'momentum-trial.jsonl'),
    health: join(ledgerDir, 'us-health.json')
  };
}
