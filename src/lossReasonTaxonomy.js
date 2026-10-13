/**
 * Plan1/2/3/5 统一亏损归因 taxonomy。
 * 字符串常量稳定，便于 DB 聚合与门控；标签仅用于展示。
 */

export const LOSS_REASONS = Object.freeze({
  WIN: 'win',
  UNKNOWN: 'unknown',
  DATA_INSUFFICIENT: 'data_insufficient',

  // 方向 / 到期
  DIRECTION_WRONG: 'direction_wrong',
  EXPIRY_SETTLEMENT_LOSS: 'expiry_settlement_loss',

  // 反转
  POST_ENTRY_PM_REVERSAL: 'post_entry_pm_reversal',
  FLIP_INTO_ENTRY: 'flip_into_entry',
  SHORT_WINDOW_REVERSAL: 'short_window_reversal',

  // 止损族
  STOP_LOSS: 'stop_loss',
  SOFT_STOP_LOSS: 'soft_stop_loss',
  HARD_STOP_LOSS: 'hard_stop_loss',
  REVERSAL_STOP_LOSS: 'reversal_stop_loss',
  TIME_STOP: 'time_stop',
  DIRECTION_FLIP_LOSS: 'direction_flip_loss',

  // 入场质量
  HIGH_ENTRY_NEGATIVE_EV: 'high_entry_negative_ev',
  LATE_ENTRY_EXPENSIVE: 'late_entry_expensive',
  FAK_FILL_WORSE: 'fak_fill_worse',

  // Plan 特有
  LOCK_STRENGTH_MISJUDGE: 'lock_strength_misjudge',
  CROSS_FOLLOW_FAILED: 'cross_follow_failed'
});

export const LOSS_REASON_LABELS = Object.freeze({
  [LOSS_REASONS.WIN]: '盈利',
  [LOSS_REASONS.UNKNOWN]: '未知',
  [LOSS_REASONS.DATA_INSUFFICIENT]: '数据不足',
  [LOSS_REASONS.DIRECTION_WRONG]: '方向错误（到期反向）',
  [LOSS_REASONS.EXPIRY_SETTLEMENT_LOSS]: '到期结算亏损',
  [LOSS_REASONS.POST_ENTRY_PM_REVERSAL]: '入场后 PM/价格反转',
  [LOSS_REASONS.FLIP_INTO_ENTRY]: '入场前大幅反转后追入',
  [LOSS_REASONS.SHORT_WINDOW_REVERSAL]: '短窗反转',
  [LOSS_REASONS.STOP_LOSS]: '止损',
  [LOSS_REASONS.SOFT_STOP_LOSS]: '软止损',
  [LOSS_REASONS.HARD_STOP_LOSS]: '硬止损',
  [LOSS_REASONS.REVERSAL_STOP_LOSS]: '反转止损',
  [LOSS_REASONS.TIME_STOP]: '时间止损',
  [LOSS_REASONS.DIRECTION_FLIP_LOSS]: '方向翻转亏损',
  [LOSS_REASONS.HIGH_ENTRY_NEGATIVE_EV]: '入场过贵 / 负期望',
  [LOSS_REASONS.LATE_ENTRY_EXPENSIVE]: '过晚高价入场',
  [LOSS_REASONS.FAK_FILL_WORSE]: 'FAK/成交价劣于意图价',
  [LOSS_REASONS.LOCK_STRENGTH_MISJUDGE]: '锁定强度误判',
  [LOSS_REASONS.CROSS_FOLLOW_FAILED]: '跨币跟随失败'
});

/**
 * 下单前已经能够观察到、可以用于未来门控的原因。
 *
 * 结算方向错误、到期亏损、锁定强度误判等只能在结果出来后确认，
 * 它们适合回溯判断模块，但不能冒充为当时可规避的信号。
 */
export const DEFAULT_ACTIONABLE_LOSS_REASONS = Object.freeze([
  LOSS_REASONS.HIGH_ENTRY_NEGATIVE_EV,
  LOSS_REASONS.FLIP_INTO_ENTRY,
  LOSS_REASONS.LATE_ENTRY_EXPENSIVE
]);

/** 只能用于结算后的误判回溯，不能直接作为单笔入场门控。 */
export const RETROSPECTIVE_ONLY_LOSS_REASONS = Object.freeze([
  LOSS_REASONS.LOCK_STRENGTH_MISJUDGE,
  LOSS_REASONS.CROSS_FOLLOW_FAILED,
  LOSS_REASONS.POST_ENTRY_PM_REVERSAL,
  LOSS_REASONS.SHORT_WINDOW_REVERSAL,
  LOSS_REASONS.SOFT_STOP_LOSS,
  LOSS_REASONS.EXPIRY_SETTLEMENT_LOSS,
  LOSS_REASONS.DIRECTION_WRONG
]);

/** @deprecated 保留旧导出名，实际口径已收紧为“下单前可识别”。 */
export const DEFAULT_AVOIDABLE_LOSS_REASONS = DEFAULT_ACTIONABLE_LOSS_REASONS;

export function lossReasonLabel(reason) {
  if (reason == null || reason === '') return null;
  return LOSS_REASON_LABELS[reason] || String(reason);
}

export function isWinLossReason(reason) {
  return reason === LOSS_REASONS.WIN || reason == null;
}
