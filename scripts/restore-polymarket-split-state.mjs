import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'data');
const splitDir = join(dataDir, 'polymarket');

const LEGACY_CANDIDATES = [
  join(dataDir, 'polymarket-paper-state.json.bak'),
  join(dataDir, 'polymarket-paper-state.json.migrated-1783310787020.bak'),
  join(dataDir, 'polymarket-paper-state.json.pre-merge-1783310660514.bak')
];

const LIVE_CANDIDATES = [
  join(dataDir, 'live-state.json'),
  join(splitDir, 'live-state.json.bak'),
  join(splitDir, 'live-state.json')
];

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readFirstExisting(paths) {
  for (const path of paths) {
    try {
      return { path, data: await readJson(path) };
    } catch {
      // try next
    }
  }
  return null;
}

function bucketScore(bucket = {}) {
  return (bucket.paperOrders?.length || 0) * 1000
    + (bucket.portfolio?.portfolioInitialized ? 500 : 0)
    + Number(bucket.portfolio?.startingCash || 0);
}

async function readSplitPlan(planId) {
  const mainPath = join(splitDir, `${planId}-state.json`);
  const bakPath = `${mainPath}.bak`;
  let main = null;
  let bak = null;
  try { main = await readJson(mainPath); } catch { /* empty */ }
  try { bak = await readJson(bakPath); } catch { /* empty */ }
  return bucketScore(bak) > bucketScore(main) ? { path: bakPath, data: bak } : { path: mainPath, data: main };
}

async function main() {
  await mkdir(splitDir, { recursive: true });

  const legacy = await readFirstExisting(LEGACY_CANDIDATES);
  if (!legacy) {
    throw new Error('找不到可用的 polymarket-paper-state 备份文件');
  }
  console.log(`使用备份: ${legacy.path}`);

  for (const planId of ['plan1', 'plan2', 'plan3']) {
    const split = await readSplitPlan(planId);
    const legacyBucket = legacy.data.plans?.[planId];
    const useSplit = bucketScore(split.data) >= bucketScore(legacyBucket);
    const bucket = useSplit ? split.data : legacyBucket;
    if (!bucket) {
      console.warn(`跳过 ${planId}：无数据`);
      continue;
    }
    const target = join(splitDir, `${planId}-state.json`);
    await writeFile(target, `${JSON.stringify(bucket, null, 2)}\n`, 'utf8');
    await copyFile(target, `${target}.bak`);
    console.log(`${planId}: ${bucket.paperOrders?.length || 0} 笔订单 (来源: ${useSplit ? 'split' : 'legacy'})`);
  }

  const liveLegacy = await readFirstExisting(LIVE_CANDIDATES);
  if (liveLegacy?.data) {
    const payload = {
      liveControl: liveLegacy.data.liveControl || { enabled: false },
      liveAuto: liveLegacy.data.liveAuto || { enabled: false, lastFlipAt: {} },
      liveOrders: liveLegacy.data.liveOrders || []
    };
    const target = join(splitDir, 'live-state.json');
    await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await copyFile(target, `${target}.bak`);
    console.log(`live: ${payload.liveOrders.length} 笔订单 (来源: ${liveLegacy.path})`);
  }

  console.log('恢复完成。请重启 docker: docker compose up -d --force-recreate');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
