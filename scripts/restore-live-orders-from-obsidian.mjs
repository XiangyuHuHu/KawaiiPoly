import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const statePath = join(root, 'data', 'polymarket-paper-state.json');
const liveStatePath = join(root, 'data', 'live-state.json');
const obsidianDir = 'D:\\Obsidian仓库\\Kawaii的仓库\\投资\\虚拟币\\比特币猜输赢记录\\实盘';
const mdFiles = ['2026-07-05.md', '2026-07-06.md'];
const MAX_ORDERS = 300;

const TEXT = { up: '上涨', down: '下跌' };

function parseShanghaiTime(text) {
  const match = String(text || '').trim().match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/);
  if (!match) return null;
  return new Date(`${match[1]}T${match[2]}+08:00`).toISOString();
}

function parseUsd(text) {
  const raw = String(text || '').replace(/[$,]/g, '').trim();
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function parsePct(text) {
  const raw = String(text || '').replace(/%/g, '').trim();
  if (!raw || raw === '--') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value / 100 : null;
}

function parseSignedUsd(text) {
  const raw = String(text || '').trim();
  if (!raw || raw === '--') return null;
  const negative = raw.startsWith('-');
  const cleaned = raw.replace(/^[+-]/, '').replace(/[$,]/g, '');
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

function parseDirection(text) {
  if (text === TEXT.up) return 'up';
  if (text === TEXT.down) return 'down';
  return null;
}

function parseExitFromDisplay(statusText) {
  if (statusText.includes('止盈')) return 'take-profit';
  if (statusText.includes('止损')) return 'stop-loss';
  if (statusText.includes('到期')) return 'expiry';
  if (statusText.includes('expired-unfilled') || statusText.includes('未成交过期')) return 'expired-unfilled';
  if (statusText.includes('hard-stop-loss')) return 'hard-stop-loss';
  return null;
}

function mapOrderFields({ displayStatus, orderSide, exitStatus, pnl }) {
  if (displayStatus === '拦截') {
    return { status: 'blocked', positionStatus: null };
  }
  if (displayStatus === '未成交过期' || displayStatus.startsWith('已关闭-expired-unfilled')) {
    return { status: 'submitted', positionStatus: 'closed', exitStatus: 'expired-unfilled' };
  }
  if (orderSide === 'SELL') {
    return {
      status: 'submitted',
      positionStatus: null,
      exitStatus: exitStatus && exitStatus !== '--' ? exitStatus : displayStatus
    };
  }
  if (displayStatus.startsWith('已结算-') || displayStatus.startsWith('已关闭-')) {
    return {
      status: 'submitted',
      positionStatus: 'closed',
      exitStatus: exitStatus && exitStatus !== '--' ? exitStatus : parseExitFromDisplay(displayStatus)
    };
  }
  if (displayStatus === '持仓中') {
    return { status: 'submitted', positionStatus: 'open' };
  }
  if (displayStatus === '待成交') {
    return { status: 'pending', positionStatus: null };
  }
  return { status: 'submitted', positionStatus: orderSide === 'BUY' ? 'open' : null };
}

function parseMarkdownTableRow(line) {
  if (!line.startsWith('| pm-live-')) return null;
  const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
  if (cells.length < 17) return null;

  const [
    id,
    timeText,
    orderSide,
    displayStatus,
    planRaw,
    timeframe,
    directionText,
    entryType,
    usdText,
    sharesText,
    limitPriceText,
    tpText,
    slText,
    exitStatus,
    pnlText,
    clobText,
    market,
    note
  ] = cells;

  const createdAtIso = parseShanghaiTime(timeText);
  if (!createdAtIso) return null;

  const orderSideNorm = orderSide === 'SELL' ? 'SELL' : 'BUY';
  const mapped = mapOrderFields({
    displayStatus,
    orderSide: orderSideNorm,
    exitStatus,
    pnl: parseSignedUsd(pnlText)
  });

  const direction = parseDirection(directionText);
  const pnl = parseSignedUsd(pnlText);
  const closedAtIso = mapped.positionStatus === 'closed' ? createdAtIso : null;

  return {
    id,
    createdAtIso,
    status: mapped.status,
    orderSide: orderSideNorm,
    positionStatus: mapped.positionStatus,
    symbol: 'BTC-USD',
    timeframe: timeframe === '--' ? null : timeframe,
    direction,
    outcome: direction === 'up' ? 'UP' : direction === 'down' ? 'DOWN' : null,
    planId: String(planRaw || '').toLowerCase() || null,
    entryType: entryType === '--' ? null : entryType,
    usd: parseUsd(usdText),
    shares: Number(sharesText) || null,
    limitPrice: parsePct(limitPriceText),
    entryPrice: parsePct(limitPriceText),
    takeProfitPrice: parsePct(tpText),
    stopLossPrice: parsePct(slText),
    exitStatus: mapped.exitStatus || (exitStatus !== '--' ? exitStatus : null),
    exitReason: note !== '--' ? note : null,
    note: note !== '--' ? note : null,
    pnl,
    payoutUsd: orderSideNorm === 'BUY' && pnl != null && parseUsd(usdText) != null
      ? Math.round((parseUsd(usdText) + pnl) * 100) / 100
      : null,
    closedAtIso,
    filledAtIso: mapped.status !== 'blocked' ? createdAtIso : null,
    clobOrderId: clobText !== '--' ? clobText : null,
    market: market !== '--' ? market : null,
    restoredFromObsidian: true
  };
}

async function parseObsidianFiles() {
  const byId = new Map();
  for (const file of mdFiles) {
    const raw = await readFile(join(obsidianDir, file), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const order = parseMarkdownTableRow(line);
      if (order) byId.set(order.id, order);
    }
  }
  return [...byId.values()].sort((a, b) => String(b.createdAtIso).localeCompare(String(a.createdAtIso)));
}

const orders = await parseObsidianFiles();
const restored = orders.slice(0, MAX_ORDERS);

const rawState = await readFile(statePath, 'utf8');
const state = JSON.parse(rawState);
const backupPath = `${statePath}.pre-live-restore-${Date.now()}.bak`;
await copyFile(statePath, backupPath);

state.liveOrders = restored;
await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

await mkdir(dirname(liveStatePath), { recursive: true });
await writeFile(liveStatePath, `${JSON.stringify({
  liveControl: state.liveControl,
  liveAuto: state.liveAuto,
  liveOrders: restored
}, null, 2)}\n`, 'utf8');

console.log(`Parsed ${orders.length} unique live orders from Obsidian`);
console.log(`Restored ${restored.length} orders into ${statePath}`);
console.log(`Also wrote ${liveStatePath} for split-state migration`);
console.log(`Backup: ${backupPath}`);
console.log(`plan1 paper orders untouched: ${state.plans?.plan1?.paperOrders?.length ?? 0}`);
