import dotenv from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录。这个文件在 src/polymarketUs/。 */
export function usRepoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * 读取仓库根目录的 `.env`，不覆盖进程里已经有的变量。
 * `us:live-observe` 以前不加载 dotenv。循环脚本用 `dirname "$0"` 时也找不到这份文件，
 * 密钥可能还在环境里，但 `POLYMARKET_US_LIVE_TRADING_ENABLED` 缺失，健康检查就是 live_flag_off。
 */
export function loadUsRepoEnv(envPath = join(usRepoRoot(), '.env')) {
  return dotenv.config({ path: envPath });
}
