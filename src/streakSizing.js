/**
 * 连赢加仓 / 连亏减仓（streak sizing）
 *
 * 与现有 lossStreakScale（冷却/恢复闸门）配合：
 * - 本模块只负责「阶梯仓位乘数」
 * - 4+/5 连亏的 cooldown（scale=0）与 recovery 门槛仍由 getLossStreakRisk 负责
 *
 * 结算判定：已结算买单 pnl（pnl>0 计赢，pnl<0 计亏，pnl===0 跳过）
 * paper / live 各自用各自订单流，与 risk snapshot 一致。
 */

const PLAN_OVERRIDE_KEYS = {
  plan1: 'plan1StreakSizingEnabled',
  plan2: 'plan2StreakSizingEnabled',
  plan2_5: 'plan2_5StreakSizingEnabled',
  plan2_6: 'plan2_6StreakSizingEnabled',
  plan11: 'plan11StreakSizingEnabled',
  plan14: 'plan14StreakSizingEnabled',
  plan3: 'plan3StreakSizingEnabled',
  plan3_5: 'plan3_5StreakSizingEnabled',
  plan3_6: 'plan3_6StreakSizingEnabled',
  plan4: 'plan4StreakSizingEnabled',
  plan5: 'plan5StreakSizingEnabled'
};

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}

function parseOptionalBool(value) {
  if (value === true || value === false) return value;
  if (value == null || value === '') return null;
  const text = String(value).trim().toLowerCase();
  if (text === 'true' || text === '1' || text === 'yes' || text === 'on') return true;
  if (text === 'false' || text === '0' || text === 'no' || text === 'off') return false;
  return null;
}

/**
 * 从已结算买单（最新在前）计算连赢/连亏。
 * pnl===0（未成交过期等）跳过，不打断 streak。
 */
export function computeSettledStreaks(closedOrders = []) {
  let winStreak = 0;
  let lossStreak = 0;
  let mode = 'flat';

  for (const order of closedOrders) {
    const pnl = Number(order?.pnl);
    if (!Number.isFinite(pnl) || pnl === 0) continue;

    if (pnl < 0) {
      if (mode === 'win') break;
      mode = 'loss';
      lossStreak += 1;
      continue;
    }

    if (mode === 'loss') break;
    mode = 'win';
    winStreak += 1;
  }

  return { winStreak, lossStreak, mode };
}

/**
 * 同一 Plan5 窗口的多币订单来自同一个组合判断，连赢/连亏只能记一次。
 * 以窗口净 PnL 作为这一轮的结果，避免四币全错被误算成连续亏损四次。
 */
export function collapseSettledOrdersByWindow(closedOrders = []) {
  const grouped = new Map();
  for (const order of closedOrders || []) {
    const slot = order?.slotIso || order?.targetTimeIso;
    if (!slot) {
      const unique = order?.id || `row-${grouped.size}`;
      grouped.set(`unique|${unique}`, { ...order, basketOrderCount: 1 });
      continue;
    }
    const key = `${order?.timeframe || '5m'}|${slot}`;
    const atIso = order?.settledAtIso || order?.closedAtIso || order?.createdAtIso || slot;
    const atMs = Date.parse(atIso);
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, {
        ...order,
        id: `plan5-basket:${key}`,
        pnl: Number(order?.pnl) || 0,
        usd: Number(order?.usd) || 0,
        basketOrderCount: 1,
        basketSymbols: [order?.symbol].filter(Boolean),
        basketLatestAtMs: Number.isFinite(atMs) ? atMs : 0
      });
      continue;
    }
    current.pnl = Number(current.pnl || 0) + (Number(order?.pnl) || 0);
    current.usd = Number(current.usd || 0) + (Number(order?.usd) || 0);
    current.basketOrderCount += 1;
    if (order?.symbol && !current.basketSymbols.includes(order.symbol)) {
      current.basketSymbols.push(order.symbol);
    }
    if (Number.isFinite(atMs) && atMs > current.basketLatestAtMs) {
      current.basketLatestAtMs = atMs;
      current.closedAtIso = order.closedAtIso || current.closedAtIso;
      current.settledAtIso = order.settledAtIso || current.settledAtIso;
    }
  }
  return [...grouped.values()]
    .map((order) => ({ ...order, pnl: round4(order.pnl) }))
    .sort((a, b) => (
      Number(b.basketLatestAtMs ?? Date.parse(b.settledAtIso || b.closedAtIso || b.createdAtIso || 0))
      - Number(a.basketLatestAtMs ?? Date.parse(a.settledAtIso || a.closedAtIso || a.createdAtIso || 0))
    ));
}

export function resolveStreakSizingConfig(config = {}, planId = null) {
  const enabledGlobal = config.streakSizingEnabled !== false;
  const overrideKey = planId ? PLAN_OVERRIDE_KEYS[String(planId)] : null;
  const override = overrideKey ? parseOptionalBool(config[overrideKey]) : null;
  const enabled = override == null ? enabledGlobal : override;

  const winStepPct = clampNumber(Number(config.streakSizingWinStepPct), 0, 0.5, 0.12);
  const winMaxLevels = Math.max(0, Math.floor(Number(config.streakSizingWinMaxLevels) || 4));
  const winCap = clampNumber(Number(config.streakSizingWinCap), 1, 3, 1.5);

  const lossStepPct = clampNumber(Number(config.streakSizingLossStepPct), 0, 0.5, 0.22);
  const lossMaxLevels = Math.max(0, Math.floor(Number(config.streakSizingLossMaxLevels) || 4));
  const lossFloor = clampNumber(Number(config.streakSizingLossFloor), 0.05, 1, 0.4);

  const belowMinMode = String(config.streakSizingBelowMinMode || 'clamp').toLowerCase() === 'skip'
    ? 'skip'
    : 'clamp';

  return {
    enabled,
    winStepPct,
    winMaxLevels,
    winCap,
    lossStepPct,
    lossMaxLevels,
    lossFloor,
    belowMinMode,
    planId: planId || null,
    override
  };
}

export function isStreakSizingEnabled(config = {}, planId = null) {
  return resolveStreakSizingConfig(config, planId).enabled === true;
}

/**
 * 连赢：scale = min(cap, (1+winStep)^levels)
 * 连亏：scale = max(floor, (1-lossStep)^levels)
 * 互斥：同一时刻只会处于 win 或 loss 一侧。
 */
export function computeStreakSizingScale({
  winStreak = 0,
  lossStreak = 0,
  config = {}
} = {}) {
  const resolved = resolveStreakSizingConfig(config, config.planId || null);
  if (!resolved.enabled) {
    return {
      enabled: false,
      scale: 1,
      mode: 'disabled',
      levels: 0,
      winStreak: Math.max(0, Number(winStreak) || 0),
      lossStreak: Math.max(0, Number(lossStreak) || 0),
      ...resolved
    };
  }

  const wins = Math.max(0, Math.floor(Number(winStreak) || 0));
  const losses = Math.max(0, Math.floor(Number(lossStreak) || 0));

  if (losses > 0) {
    const levels = Math.min(losses, resolved.lossMaxLevels);
    const raw = levels > 0 ? (1 - resolved.lossStepPct) ** levels : 1;
    const scale = round4(Math.max(resolved.lossFloor, raw));
    return {
      enabled: true,
      scale,
      mode: 'loss',
      levels,
      winStreak: 0,
      lossStreak: losses,
      rawScale: round4(raw),
      ...resolved
    };
  }

  if (wins > 0) {
    const levels = Math.min(wins, resolved.winMaxLevels);
    const raw = levels > 0 ? (1 + resolved.winStepPct) ** levels : 1;
    const scale = round4(Math.min(resolved.winCap, raw));
    return {
      enabled: true,
      scale,
      mode: 'win',
      levels,
      winStreak: wins,
      lossStreak: 0,
      rawScale: round4(raw),
      ...resolved
    };
  }

  return {
    enabled: true,
    scale: 1,
    mode: 'flat',
    levels: 0,
    winStreak: 0,
    lossStreak: 0,
    rawScale: 1,
    ...resolved
  };
}

/**
 * 合成最终入场仓位乘数。
 * - streak 开启时：用阶梯 scale；严重连亏 cooldown(scale=0) 仍拦截
 * - streak 关闭时：回退旧 lossStreakScale 行为
 * - recovery 模式：取 min(streakScale, recoveryScale)，避免加仓冲破恢复小仓
 */
export function resolveEntrySizeScale({
  planId = null,
  config = {},
  winStreak = 0,
  lossStreak = 0,
  lossStreakScale = 1,
  lossRecoveryMode = 'normal',
  appliesGlobalLossRecovery = false
} = {}) {
  const streak = computeStreakSizingScale({
    winStreak,
    lossStreak,
    config: { ...config, planId }
  });

  if (appliesGlobalLossRecovery && Number(lossStreakScale) <= 0) {
    return {
      sizeScale: 0,
      blocked: true,
      blockReason: 'loss_cooldown',
      streak,
      lossStreakScale: Number(lossStreakScale) || 0,
      lossRecoveryMode
    };
  }

  let sizeScale = 1;
  if (streak.enabled) {
    sizeScale = Number(streak.scale) || 1;
    if (
      appliesGlobalLossRecovery
      && (lossRecoveryMode === 'recovery' || lossRecoveryMode === 'reduced')
      && Number.isFinite(Number(lossStreakScale))
      && Number(lossStreakScale) > 0
    ) {
      // recovery/reduced：不允许超过旧闸门给出的上限（尤其 recovery 小仓）
      if (lossRecoveryMode === 'recovery') {
        sizeScale = Math.min(sizeScale, Number(lossStreakScale));
      }
    }
  } else if (appliesGlobalLossRecovery) {
    sizeScale = Number(lossStreakScale) || 0;
  }

  return {
    sizeScale: round4(Math.max(0, sizeScale)),
    blocked: false,
    blockReason: null,
    streak,
    lossStreakScale: Number(lossStreakScale) || 0,
    lossRecoveryMode
  };
}

export { PLAN_OVERRIDE_KEYS };
