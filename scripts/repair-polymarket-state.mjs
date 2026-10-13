import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const statePath = join(root, 'data', 'polymarket-paper-state.json');
const backupPath = `${statePath}.corrupt-${Date.now()}.bak`;

const raw = await readFile(statePath, 'utf8');

function buildTail() {
  return `,
      "portfolio": {
        "startingCash": 500,
        "cash": 500,
        "portfolioInitialized": true
      },
      "auto": {
        "enabled": false,
        "strategy": "plan1",
        "timeframes": ["5m", "15m"],
        "lastExecutedKeys": []
      },
      "pendingDelayedEntries": {},
      "lastFlipAt": {},
      "daily": {
        "dateKey": "2026-07-06",
        "realizedPnl": 0
      }
    },
    "plan2": {
      "paperOrders": [],
      "portfolio": {
        "startingCash": 500,
        "cash": 500,
        "portfolioInitialized": true
      },
      "auto": {
        "enabled": false,
        "strategy": "plan2",
        "timeframes": ["5m", "15m"],
        "lastExecutedKeys": []
      },
      "pendingDelayedEntries": {},
      "lastFlipAt": {},
      "daily": { "dateKey": null, "realizedPnl": 0 }
    },
    "plan3": {
      "paperOrders": [],
      "portfolio": {
        "startingCash": 500,
        "cash": 500,
        "portfolioInitialized": true
      },
      "auto": {
        "enabled": true,
        "strategy": "plan3",
        "timeframes": ["5m", "15m"],
        "lastExecutedKeys": []
      },
      "pendingDelayedEntries": {},
      "lastFlipAt": {},
      "daily": { "dateKey": null, "realizedPnl": 0 },
      "plan3SubmittedSlots": {},
      "plan3OpportunityLog": [],
      "plan3Daily": {
        "dateKey": "2026-07-06",
        "realizedPnl": 0,
        "lossCount": 0,
        "executionErrors": 0,
        "stopped": false,
        "stopReason": null
      }
    }
  },
  "liveControl": {
    "enabled": false,
    "startedAtIso": null,
    "stoppedAtIso": null,
    "startingBalanceUsdc": 0,
    "currentBalanceUsdc": 0
  },
  "liveAuto": {
    "enabled": false,
    "planId": "plan1",
    "timeframes": ["5m", "15m"],
    "lastExecutedKeys": [],
    "pendingDelayedEntries": {},
    "lastRunAtIso": null,
    "lastError": null,
    "lastAction": null,
    "lastReason": null,
    "lastOrderId": null,
    "startedAtIso": null,
    "stoppedAtIso": null,
    "lastFlipAt": {}
  },
  "liveOrders": []
}`;
}

let repaired = null;
try {
  JSON.parse(raw);
  console.log('State file is already valid JSON.');
  process.exit(0);
} catch {
  const incompleteIdx = raw.search(/\r?\n\s*\{\s*$/);
  const cutAt = incompleteIdx > 0 ? incompleteIdx : raw.length;
  let head = raw.slice(0, cutAt).trimEnd();
  if (head.endsWith(',')) head = head.slice(0, -1);
  if (!head.endsWith('}')) {
    const lastOrderClose = head.lastIndexOf('\n        },');
    if (lastOrderClose >= 0) {
      head = head.slice(0, lastOrderClose + '\n        },'.length);
    }
  }
  repaired = `${head}\n      ]${buildTail()}`;
  JSON.parse(repaired);
}

await copyFile(statePath, backupPath);
await writeFile(statePath, `${JSON.stringify(JSON.parse(repaired), null, 2)}\n`, 'utf8');
const parsed = JSON.parse(repaired);
console.log(`Repaired state saved. Backup: ${backupPath}`);
console.log(`plan1 orders: ${parsed.plans?.plan1?.paperOrders?.length ?? 0}`);
