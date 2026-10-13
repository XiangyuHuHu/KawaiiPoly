import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { resolvePlan3PriceBand, resolvePlan3PriceCentKey } from './polymarketPlan3.js';

/**
 * 轻量统计库（Node 22 内置 node:sqlite，零外部依赖）。
 *
 * 定位：跨重启/跨 state 裁剪持久积累「窗口锁定结果」与「已结算订单」，
 * 给锁定胜率、置信度校准表、Plan3 价位带胜率提供比 markdown 往返更可靠的数据层。
 * 所有写读都容错：数据库不可用时静默降级，绝不阻塞交易主流程。
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS window_locks (
  id TEXT PRIMARY KEY,
  timeframe TEXT NOT NULL,
  symbol TEXT NOT NULL,
  target_time_iso TEXT NOT NULL,
  decision_locked INTEGER NOT NULL DEFAULT 0,
  locked_direction TEXT,
  lock_strength TEXT,
  locked_pm_gap REAL,
  locked_up_prob REAL,
  locked_down_prob REAL,
  lock_elapsed_pct REAL,
  quality REAL,
  pm_correct INTEGER,
  tech_correct INTEGER,
  composite_correct INTEGER,
  actual_direction TEXT,
  skip_reason TEXT,
  evaluated_at_iso TEXT
);
CREATE INDEX IF NOT EXISTS idx_window_locks_tf_time ON window_locks (timeframe, target_time_iso);
CREATE TABLE IF NOT EXISTS window_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timeframe TEXT NOT NULL,
  symbol TEXT NOT NULL,
  target_time_iso TEXT NOT NULL,
  observed_at_iso TEXT NOT NULL,
  elapsed_pct REAL,
  up_price REAL,
  down_price REAL,
  up_ask REAL,
  down_ask REAL,
  up_spread REAL,
  down_spread REAL,
  spot_price REAL,
  slot_open_price REAL,
  quality REAL
);
CREATE INDEX IF NOT EXISTS idx_window_snapshots_tf_target ON window_snapshots (timeframe, target_time_iso);
CREATE TABLE IF NOT EXISTS settled_orders (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  timeframe TEXT,
  direction TEXT,
  entry_type TEXT,
  entry_price REAL,
  usd REAL,
  pnl REAL,
  won INTEGER,
  exit_status TEXT,
  confidence REAL,
  slot_iso TEXT,
  target_time_iso TEXT,
  settled_at_iso TEXT,
  loss_reason TEXT,
  pm_reversal INTEGER,
  loss_analysis_json TEXT,
  symbol TEXT,
  cross_symbol_aligned INTEGER,
  cross_symbol_leader TEXT,
  leader_limit_price REAL,
  lock_strength TEXT,
  lock_pm_gap REAL,
  locked_at_iso TEXT,
  signal_quality_json TEXT,
  expected_value_json TEXT,
  strategy_version TEXT
);
CREATE INDEX IF NOT EXISTS idx_settled_orders_plan ON settled_orders (plan_id, timeframe, entry_type);
CREATE INDEX IF NOT EXISTS idx_settled_orders_settled_at ON settled_orders (settled_at_iso);

CREATE TABLE IF NOT EXISTS next_slot_predictions (
  id TEXT PRIMARY KEY,
  source_slot_iso TEXT NOT NULL,
  source_timeframe TEXT NOT NULL,
  source_target_time_iso TEXT,
  predicted_slot_iso TEXT NOT NULL,
  predicted_direction TEXT NOT NULL,
  predicted_at_iso TEXT,
  lock_strength TEXT,
  lock_gap REAL,
  lock_reason TEXT,
  symbol TEXT,
  same_direction_as_prev INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  correct INTEGER,
  actual_direction TEXT,
  evaluated_at_iso TEXT,
  evaluation_source TEXT
);
CREATE INDEX IF NOT EXISTS idx_nsp_predicted_slot ON next_slot_predictions (predicted_slot_iso, source_timeframe);
CREATE INDEX IF NOT EXISTS idx_nsp_source_tf ON next_slot_predictions (source_timeframe, predicted_at_iso);

CREATE TABLE IF NOT EXISTS direction_judgments (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  slot_iso TEXT,
  target_time_iso TEXT NOT NULL,
  predicted_direction TEXT NOT NULL,
  predicted_at_iso TEXT NOT NULL,
  confidence REAL,
  up_prob REAL,
  down_prob REAL,
  lock_strength TEXT,
  lock_gap REAL,
  price REAL,
  source TEXT,
  hour_bucket INTEGER,
  volatility_bucket TEXT,
  same_direction_as_prev INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  correct INTEGER,
  actual_direction TEXT,
  evaluated_at_iso TEXT,
  refresh_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_dj_tf_target ON direction_judgments (timeframe, target_time_iso);
CREATE INDEX IF NOT EXISTS idx_dj_symbol_tf ON direction_judgments (symbol, timeframe, predicted_at_iso);
CREATE INDEX IF NOT EXISTS idx_dj_status ON direction_judgments (status, timeframe);

CREATE TABLE IF NOT EXISTS plan7_market_samples (
  id TEXT PRIMARY KEY,
  strategy_version TEXT NOT NULL,
  category TEXT NOT NULL,
  opportunity_type TEXT NOT NULL,
  event_slug TEXT,
  market_slug TEXT,
  title TEXT,
  observed_at_iso TEXT NOT NULL,
  shares REAL,
  leg_count INTEGER,
  combined_cost REAL,
  fee_usd REAL,
  locked_pnl REAL,
  eligible INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_p7_samples_time ON plan7_market_samples (observed_at_iso);
CREATE INDEX IF NOT EXISTS idx_p7_samples_market ON plan7_market_samples (market_slug, opportunity_type);
CREATE INDEX IF NOT EXISTS idx_p7_samples_eligible ON plan7_market_samples (eligible, opportunity_type);
`;

function toBoolInt(value) {
  if (value === true) return 1;
  if (value === false) return 0;
  return null;
}

function fromBoolInt(value) {
  if (value === 1) return true;
  if (value === 0) return false;
  return null;
}

function numberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function migrateAddColumns(db, tableName, columns) {
  const existing = new Set(
    db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name)
  );
  for (const [name, type] of columns) {
    if (existing.has(name)) continue;
    try {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${name} ${type}`);
    } catch (error) {
      // duplicate column / race: ignore; other errors log and continue
      if (!/duplicate column/i.test(String(error?.message || error))) {
        console.error(`Stats DB migrate ${tableName}.${name} failed: ${error.message}`);
      }
    }
  }
}

function migrateSettledOrdersSchema(db) {
  migrateAddColumns(db, 'settled_orders', [
    ['loss_reason', 'TEXT'],
    ['pm_reversal', 'INTEGER'],
    ['loss_analysis_json', 'TEXT'],
    ['symbol', 'TEXT'],
    ['cross_symbol_aligned', 'INTEGER'],
    ['cross_symbol_leader', 'TEXT'],
    ['leader_limit_price', 'REAL'],
    ['lock_strength', 'TEXT'],
    ['lock_pm_gap', 'REAL'],
    ['locked_at_iso', 'TEXT'],
    ['signal_quality_json', 'TEXT'],
    ['expected_value_json', 'TEXT'],
    ['strategy_version', 'TEXT']
  ]);
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_settled_orders_loss_reason ON settled_orders (plan_id, loss_reason)');
  } catch (error) {
    console.error(`Stats DB migrate loss_reason index failed: ${error.message}`);
  }
}

/** Best-effort cross-symbol fields from order / action / plan meta. */
function resolveOrderCrossFields(order = {}) {
  const action = order.action || order.plan?.action || null;
  const entryType = String(order.entryType || order.plan?.entryType || action?.entryType || '').toLowerCase();
  let aligned = order.crossSymbolAligned ?? action?.crossSymbolAligned ?? order.plan?.crossSymbolAligned;
  if (aligned == null && entryType === 'cross_follow') aligned = true;
  const leader = order.crossSymbolLeader
    || action?.crossSymbolLeader
    || order.plan?.crossSymbolLeader
    || (entryType === 'cross_follow' ? 'BTC-USD' : null);
  const leaderLimit = order.leaderLimitPrice
    ?? action?.leaderLimitPrice
    ?? order.plan?.leaderLimitPrice
    ?? null;
  return {
    symbol: order.symbol || order.plan?.symbol || null,
    crossSymbolAligned: aligned,
    crossSymbolLeader: leader || null,
    leaderLimitPrice: leaderLimit
  };
}

function migrateNextSlotPredictionsSchema(db) {
  // CREATE TABLE IF NOT EXISTS already ran; PRAGMA ALTER covers older DBs that
  // created a thinner next_slot_predictions table before new columns landed.
  migrateAddColumns(db, 'next_slot_predictions', [
    ['source_target_time_iso', 'TEXT'],
    ['lock_reason', 'TEXT'],
    ['symbol', 'TEXT'],
    ['same_direction_as_prev', 'INTEGER'],
    ['status', "TEXT NOT NULL DEFAULT 'pending'"],
    ['correct', 'INTEGER'],
    ['actual_direction', 'TEXT'],
    ['evaluated_at_iso', 'TEXT'],
    ['evaluation_source', 'TEXT']
  ]);
}

function migrateDirectionJudgmentsSchema(db) {
  migrateAddColumns(db, 'direction_judgments', [
    ['slot_iso', 'TEXT'],
    ['confidence', 'REAL'],
    ['up_prob', 'REAL'],
    ['down_prob', 'REAL'],
    ['lock_strength', 'TEXT'],
    ['lock_gap', 'REAL'],
    ['price', 'REAL'],
    ['source', 'TEXT'],
    ['hour_bucket', 'INTEGER'],
    ['volatility_bucket', 'TEXT'],
    ['same_direction_as_prev', 'INTEGER'],
    ['status', "TEXT NOT NULL DEFAULT 'pending'"],
    ['correct', 'INTEGER'],
    ['actual_direction', 'TEXT'],
    ['evaluated_at_iso', 'TEXT'],
    ['refresh_count', 'INTEGER NOT NULL DEFAULT 1']
  ]);
}
function lookbackCutoffIso(lookbackDays) {
  const days = Math.max(1, Number(lookbackDays) || 14);
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function compactPlan7Samples(samples = []) {
  const grouped = new Map();
  const bucketMs = 60 * 60 * 1000;
  for (const sample of samples) {
    if (!sample?.id) continue;
    const observedMs = Date.parse(sample.observedAtIso || '') || Date.now();
    const bucket = Math.floor(observedMs / bucketMs) * bucketMs;
    const groupKey = [
      sample.strategyVersion || 'plan7',
      sample.category || 'unknown',
      sample.eventSlug || sample.marketSlug || 'unknown',
      sample.opportunityType || 'unknown',
      sample.eligible ? 'eligible' : 'ineligible',
      bucket
    ].join(':');
    const previous = grouped.get(groupKey);
    const pnl = numberOrNull(sample.lockedPnl);
    const previousPnl = numberOrNull(previous?.lockedPnl);
    const cost = numberOrNull(sample.combinedCost);
    const previousCost = numberOrNull(previous?.combinedCost);
    const better = !previous
      || (pnl != null && (previousPnl == null || pnl > previousPnl))
      || (pnl === previousPnl && cost != null && (previousCost == null || cost < previousCost));
    if (better) {
      grouped.set(groupKey, {
        ...sample,
        id: `plan7-sample:${groupKey}`,
        observedAtIso: new Date(bucket).toISOString()
      });
    }
  }
  return [...grouped.values()];
}

export function createStatsDb({ path, enabled = true } = {}) {
  if (!enabled || !path) {
    return createDisabledStatsDb(enabled === false ? 'disabled_by_config' : 'missing_path');
  }

  let db;
  try {
    mkdirSync(dirname(path), { recursive: true });
    db = new DatabaseSync(path);
    // Docker Desktop bind mounts do not reliably support SQLite WAL shared-memory files.
    db.exec('PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
    db.exec(SCHEMA);
    migrateSettledOrdersSchema(db);
    migrateNextSlotPredictionsSchema(db);
    migrateDirectionJudgmentsSchema(db);
  } catch (error) {
    console.error(`Stats DB init failed (${path}): ${error.message}`);
    return createDisabledStatsDb(`init_failed: ${error.message}`);
  }

  let upsertLock;
  let upsertOrder;
  let upsertNextSlotPrediction;
  let upsertDirectionJudgment;
  let upsertPlan7Sample;
  let settleDirectionJudgmentStmt;
  let selectLocks;
  let selectOrders;
  let selectPlanOrders;
  let selectLifetimeLiveStats;
  let selectSettledOrderIds;
  let selectNextSlotPredictions;
  let selectNextSlotPredictionById;
  let selectPendingNextSlotPredictions;
  let selectDirectionJudgments;
  let selectPendingDirectionJudgments;
  let plan7WritesDisabled = false;
  let lastPlan7PruneAt = 0;
  let insertWindowSnapshot;
  let lastSnapshotPruneAt = 0;
  try {
    insertWindowSnapshot = db.prepare(`
    INSERT INTO window_snapshots (
      timeframe, symbol, target_time_iso, observed_at_iso, elapsed_pct,
      up_price, down_price, up_ask, down_ask, up_spread, down_spread,
      spot_price, slot_open_price, quality
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

    upsertLock = db.prepare(`
    INSERT INTO window_locks (
      id, timeframe, symbol, target_time_iso, decision_locked, locked_direction,
      lock_strength, locked_pm_gap, locked_up_prob, locked_down_prob, lock_elapsed_pct,
      quality, pm_correct, tech_correct, composite_correct, actual_direction,
      skip_reason, evaluated_at_iso
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      decision_locked = excluded.decision_locked,
      locked_direction = excluded.locked_direction,
      lock_strength = excluded.lock_strength,
      locked_pm_gap = excluded.locked_pm_gap,
      locked_up_prob = excluded.locked_up_prob,
      locked_down_prob = excluded.locked_down_prob,
      lock_elapsed_pct = excluded.lock_elapsed_pct,
      quality = excluded.quality,
      pm_correct = excluded.pm_correct,
      tech_correct = excluded.tech_correct,
      composite_correct = excluded.composite_correct,
      actual_direction = excluded.actual_direction,
      skip_reason = excluded.skip_reason,
      evaluated_at_iso = excluded.evaluated_at_iso
  `);

    upsertOrder = db.prepare(`
    INSERT INTO settled_orders (
      id, source, plan_id, timeframe, direction, entry_type, entry_price,
      usd, pnl, won, exit_status, confidence, slot_iso, target_time_iso, settled_at_iso,
      loss_reason, pm_reversal, loss_analysis_json,
      symbol, cross_symbol_aligned, cross_symbol_leader, leader_limit_price,
      lock_strength, lock_pm_gap, locked_at_iso, signal_quality_json, expected_value_json, strategy_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source = excluded.source,
      plan_id = excluded.plan_id,
      timeframe = excluded.timeframe,
      direction = excluded.direction,
      entry_type = excluded.entry_type,
      entry_price = COALESCE(excluded.entry_price, settled_orders.entry_price),
      usd = COALESCE(excluded.usd, settled_orders.usd),
      pnl = excluded.pnl,
      won = excluded.won,
      exit_status = excluded.exit_status,
      confidence = COALESCE(excluded.confidence, settled_orders.confidence),
      slot_iso = COALESCE(excluded.slot_iso, settled_orders.slot_iso),
      target_time_iso = COALESCE(excluded.target_time_iso, settled_orders.target_time_iso),
      settled_at_iso = excluded.settled_at_iso,
      loss_reason = excluded.loss_reason,
      pm_reversal = excluded.pm_reversal,
      loss_analysis_json = excluded.loss_analysis_json,
      symbol = COALESCE(excluded.symbol, settled_orders.symbol),
      cross_symbol_aligned = COALESCE(excluded.cross_symbol_aligned, settled_orders.cross_symbol_aligned),
      cross_symbol_leader = COALESCE(excluded.cross_symbol_leader, settled_orders.cross_symbol_leader),
      leader_limit_price = COALESCE(excluded.leader_limit_price, settled_orders.leader_limit_price),
      lock_strength = COALESCE(excluded.lock_strength, settled_orders.lock_strength),
      lock_pm_gap = COALESCE(excluded.lock_pm_gap, settled_orders.lock_pm_gap),
      locked_at_iso = COALESCE(excluded.locked_at_iso, settled_orders.locked_at_iso),
      signal_quality_json = COALESCE(excluded.signal_quality_json, settled_orders.signal_quality_json),
      expected_value_json = COALESCE(excluded.expected_value_json, settled_orders.expected_value_json),
      strategy_version = COALESCE(excluded.strategy_version, settled_orders.strategy_version)
  `);

    upsertPlan7Sample = db.prepare(`
      INSERT INTO plan7_market_samples (
        id, strategy_version, category, opportunity_type, event_slug, market_slug,
        title, observed_at_iso, shares, leg_count, combined_cost, fee_usd,
        locked_pnl, eligible, reason, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        market_slug = excluded.market_slug,
        title = excluded.title,
        shares = excluded.shares,
        leg_count = excluded.leg_count,
        combined_cost = excluded.combined_cost,
        fee_usd = excluded.fee_usd,
        locked_pnl = excluded.locked_pnl,
        reason = excluded.reason
      WHERE
        COALESCE(excluded.locked_pnl, -999999) > COALESCE(plan7_market_samples.locked_pnl, -999999)
        OR (
          COALESCE(excluded.locked_pnl, -999999) = COALESCE(plan7_market_samples.locked_pnl, -999999)
          AND COALESCE(excluded.combined_cost, 999999) < COALESCE(plan7_market_samples.combined_cost, 999999)
        )
    `);

    selectLocks = db.prepare(`
    SELECT * FROM window_locks
    WHERE timeframe = ? AND target_time_iso >= ?
  `);

    selectOrders = db.prepare(`
    SELECT * FROM settled_orders
    WHERE settled_at_iso >= ?
  `);

    selectPlanOrders = db.prepare(`
    SELECT * FROM settled_orders
    WHERE plan_id = ? AND settled_at_iso >= ?
  `);
    selectLifetimeLiveStats = db.prepare(`
    SELECT
      plan_id,
      COUNT(*) AS settled_trades,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) AS losses,
      COALESCE(SUM(usd), 0) AS invested_usd,
      COALESCE(SUM(pnl), 0) AS realized_pnl
    FROM settled_orders
    WHERE source = 'live'
    GROUP BY plan_id
  `);

    selectSettledOrderIds = db.prepare(`
    SELECT id FROM settled_orders
  `);

    // Idempotent lock: never overwrite predicted_direction / lock metadata once written.
    // Only settlement evaluation fields may update on conflict.
    upsertNextSlotPrediction = db.prepare(`
      INSERT INTO next_slot_predictions (
        id, source_slot_iso, source_timeframe, source_target_time_iso,
        predicted_slot_iso, predicted_direction, predicted_at_iso,
        lock_strength, lock_gap, lock_reason, symbol, same_direction_as_prev,
        status, correct, actual_direction, evaluated_at_iso, evaluation_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = CASE
          WHEN excluded.correct IS NOT NULL THEN excluded.status
          ELSE next_slot_predictions.status
        END,
        correct = COALESCE(excluded.correct, next_slot_predictions.correct),
        actual_direction = COALESCE(excluded.actual_direction, next_slot_predictions.actual_direction),
        evaluated_at_iso = COALESCE(excluded.evaluated_at_iso, next_slot_predictions.evaluated_at_iso),
        evaluation_source = COALESCE(excluded.evaluation_source, next_slot_predictions.evaluation_source),
        same_direction_as_prev = COALESCE(
          next_slot_predictions.same_direction_as_prev,
          excluded.same_direction_as_prev
        )
    `);

    selectNextSlotPredictions = db.prepare(`
      SELECT * FROM next_slot_predictions
      WHERE predicted_at_iso >= ?
      ORDER BY predicted_at_iso DESC
    `);

    selectNextSlotPredictionById = db.prepare(`
      SELECT * FROM next_slot_predictions WHERE id = ?
    `);

    selectPendingNextSlotPredictions = db.prepare(`
      SELECT * FROM next_slot_predictions
      WHERE predicted_slot_iso = ? AND source_timeframe = ? AND status = 'pending'
    `);

    // 同一窗同一币种只保留一行：刷新时更新方向/置信度并累加 refresh_count；结算字段不覆盖已结算行。
    upsertDirectionJudgment = db.prepare(`
      INSERT INTO direction_judgments (
        id, symbol, timeframe, slot_iso, target_time_iso, predicted_direction, predicted_at_iso,
        confidence, up_prob, down_prob, lock_strength, lock_gap, price, source,
        hour_bucket, volatility_bucket, same_direction_as_prev, status, correct,
        actual_direction, evaluated_at_iso, refresh_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        predicted_direction = CASE
          WHEN direction_judgments.status = 'pending' THEN excluded.predicted_direction
          ELSE direction_judgments.predicted_direction
        END,
        predicted_at_iso = CASE
          WHEN direction_judgments.status = 'pending' THEN excluded.predicted_at_iso
          ELSE direction_judgments.predicted_at_iso
        END,
        confidence = CASE
          WHEN direction_judgments.status = 'pending' THEN excluded.confidence
          ELSE direction_judgments.confidence
        END,
        up_prob = CASE
          WHEN direction_judgments.status = 'pending' THEN excluded.up_prob
          ELSE direction_judgments.up_prob
        END,
        down_prob = CASE
          WHEN direction_judgments.status = 'pending' THEN excluded.down_prob
          ELSE direction_judgments.down_prob
        END,
        lock_strength = CASE
          WHEN direction_judgments.status = 'pending' THEN excluded.lock_strength
          ELSE direction_judgments.lock_strength
        END,
        lock_gap = CASE
          WHEN direction_judgments.status = 'pending' THEN excluded.lock_gap
          ELSE direction_judgments.lock_gap
        END,
        price = CASE
          WHEN direction_judgments.status = 'pending' THEN excluded.price
          ELSE direction_judgments.price
        END,
        source = CASE
          WHEN direction_judgments.status = 'pending' THEN excluded.source
          ELSE direction_judgments.source
        END,
        hour_bucket = CASE
          WHEN direction_judgments.status = 'pending' THEN excluded.hour_bucket
          ELSE direction_judgments.hour_bucket
        END,
        volatility_bucket = CASE
          WHEN direction_judgments.status = 'pending' THEN excluded.volatility_bucket
          ELSE direction_judgments.volatility_bucket
        END,
        same_direction_as_prev = CASE
          WHEN direction_judgments.status = 'pending' THEN excluded.same_direction_as_prev
          ELSE direction_judgments.same_direction_as_prev
        END,
        refresh_count = CASE
          WHEN direction_judgments.status = 'pending' THEN direction_judgments.refresh_count + 1
          ELSE direction_judgments.refresh_count
        END
    `);

    settleDirectionJudgmentStmt = db.prepare(`
      UPDATE direction_judgments
      SET status = ?,
          correct = ?,
          actual_direction = ?,
          evaluated_at_iso = ?
      WHERE id = ? AND status = 'pending'
    `);

    selectDirectionJudgments = db.prepare(`
      SELECT * FROM direction_judgments
      WHERE predicted_at_iso >= ?
      ORDER BY predicted_at_iso DESC
    `);

    selectPendingDirectionJudgments = db.prepare(`
      SELECT * FROM direction_judgments
      WHERE status = 'pending' AND target_time_iso = ? AND timeframe = ?
    `);
  } catch (error) {
    console.error(`Stats DB prepare failed (${path}): ${error.message}`);
    try { db.close(); } catch { /* already closed */ }
    return createDisabledStatsDb(`prepare_failed: ${error.message}`);
  }

  return {
    enabled: true,
    path,

    recordWindowLock(record) {
      if (!record?.id) return false;
      try {
        upsertLock.run(
          String(record.id),
          record.timeframe === '5m' ? '5m' : '15m',
          String(record.symbol || 'BTC-USD'),
          String(record.targetTimeIso || ''),
          record.decisionLocked ? 1 : 0,
          record.lockedPolymarketPredictedDirection || null,
          record.lockStrength || null,
          numberOrNull(record.lockedPmGap),
          numberOrNull(record.lockedPolymarketUpProbability),
          numberOrNull(record.lockedPolymarketDownProbability),
          numberOrNull(record.lockElapsedPct),
          numberOrNull(record.polymarketQualityScore),
          toBoolInt(record.polymarketCorrect),
          toBoolInt(record.techCorrect),
          toBoolInt(record.compositeCorrect),
          record.actualDirection || null,
          record.skipReason || null,
          record.evaluatedAtIso || new Date().toISOString()
        );
        return true;
      } catch (error) {
        console.error(`Stats DB recordWindowLock failed: ${error.message}`);
        return false;
      }
    },

    recordWindowSnapshot(snapshot) {
      if (!snapshot?.targetTimeIso || !snapshot?.symbol) return false;
      try {
        if (Date.now() - lastSnapshotPruneAt >= 60 * 60 * 1000) {
          db.prepare('DELETE FROM window_snapshots WHERE observed_at_iso < ?')
            .run(new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString());
          lastSnapshotPruneAt = Date.now();
        }
        insertWindowSnapshot.run(
          snapshot.timeframe === '5m' ? '5m' : '15m',
          String(snapshot.symbol),
          String(snapshot.targetTimeIso),
          String(snapshot.observedAtIso || new Date().toISOString()),
          numberOrNull(snapshot.elapsedPct),
          numberOrNull(snapshot.upPrice),
          numberOrNull(snapshot.downPrice),
          numberOrNull(snapshot.upAsk),
          numberOrNull(snapshot.downAsk),
          numberOrNull(snapshot.upSpread),
          numberOrNull(snapshot.downSpread),
          numberOrNull(snapshot.spotPrice),
          numberOrNull(snapshot.slotOpenPrice),
          numberOrNull(snapshot.quality)
        );
        return true;
      } catch (error) {
        console.error(`Stats DB recordWindowSnapshot failed: ${error.message}`);
        return false;
      }
    },

    recordSettledOrders(orders = []) {
      let written = 0;
      try {
        db.exec('BEGIN');
        for (const item of orders) {
          const order = item?.order || item;
          const source = item?.source || order?.source || 'paper';
          if (!order?.id) continue;
          const cross = resolveOrderCrossFields(order);
          const action = order.action || order.plan?.action || null;
          const signalQuality = order.signalQuality || action?.signalQuality || null;
          const expectedValueGate = order.expectedValueGate || action?.expectedValueGate || null;
          upsertOrder.run(
            String(order.id),
            source,
            String(order.planId || 'plan1'),
            order.timeframe || null,
            order.direction || null,
            order.entryType || null,
            numberOrNull(order.entryPrice ?? order.limitPrice),
            numberOrNull(order.usd),
            numberOrNull(order.pnl),
            toBoolInt(order.won ?? (Number(order.pnl) > 0 ? true : Number(order.pnl) < 0 ? false : null)),
            order.exitStatus || null,
            numberOrNull(order.confidence),
            order.slotIso || order.plan?.slotIso || null,
            order.targetTimeIso || null,
            order.settledAtIso || order.closedAtIso || order.updatedAtIso || new Date().toISOString(),
            order.lossReason || order.lossAnalysis?.lossReason || null,
            toBoolInt(order.pmReversal ?? order.lossAnalysis?.pmReversal?.anyLargeReversal ?? null),
            order.lossAnalysis ? JSON.stringify(order.lossAnalysis) : null,
            cross.symbol ? String(cross.symbol) : null,
            toBoolInt(cross.crossSymbolAligned),
            cross.crossSymbolLeader ? String(cross.crossSymbolLeader) : null,
            numberOrNull(cross.leaderLimitPrice),
            order.lockStrength || action?.lockStrength || order.lossAnalysis?.detail?.lockStrength || null,
            numberOrNull(order.lockPmGap ?? action?.lockPmGap),
            order.lockedAtIso || action?.lockedAtIso || null,
            signalQuality ? JSON.stringify(signalQuality) : null,
            expectedValueGate ? JSON.stringify(expectedValueGate) : null,
            order.strategyVersion || action?.strategyVersion || null
          );
          written += 1;
        }
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        console.error(`Stats DB recordSettledOrders failed: ${error.message}`);
      }
      return written;
    },

    recordPlan7Samples(samples = []) {
      let written = 0;
      if (plan7WritesDisabled || !Array.isArray(samples) || !samples.length) return written;
      try {
        if (Date.now() - lastPlan7PruneAt >= 60 * 60 * 1000) {
          db.prepare('DELETE FROM plan7_market_samples WHERE observed_at_iso < ?')
            .run(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
          lastPlan7PruneAt = Date.now();
        }
        db.exec('BEGIN');
        for (const sample of compactPlan7Samples(samples)) {
          if (!sample?.id) continue;
          const result = upsertPlan7Sample.run(
            String(sample.id),
            String(sample.strategyVersion || 'plan7'),
            String(sample.category || 'unknown'),
            String(sample.opportunityType || 'unknown'),
            sample.eventSlug || null,
            sample.marketSlug || null,
            sample.title || null,
            sample.observedAtIso || new Date().toISOString(),
            sample.shares == null ? null : numberOrNull(sample.shares),
            Number.isFinite(Number(sample.legCount)) ? Number(sample.legCount) : null,
            sample.combinedCost == null ? null : numberOrNull(sample.combinedCost),
            sample.feeUsd == null ? null : numberOrNull(sample.feeUsd),
            sample.lockedPnl == null ? null : numberOrNull(sample.lockedPnl),
            sample.eligible ? 1 : 0,
            sample.reason || null,
            null
          );
          written += Number(result.changes || 0);
        }
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        console.error(`Stats DB recordPlan7Samples failed: ${error.message}`);
        if (/malformed|corrupt/i.test(String(error?.message || error))) {
          plan7WritesDisabled = true;
          console.error('Stats DB Plan7 sample writes disabled until restart; trading continues with state-file data.');
        }
      }
      return written;
    },

    recordNextSlotPrediction(prediction) {
      if (!prediction?.id) return false;
      try {
        upsertNextSlotPrediction.run(
          String(prediction.id),
          String(prediction.sourceSlotIso || ''),
          prediction.sourceTimeframe === '15m' ? '15m' : '5m',
          prediction.sourceTargetTimeIso || null,
          String(prediction.predictedSlotIso || ''),
          prediction.predictedDirection || null,
          prediction.predictedAtIso || new Date().toISOString(),
          prediction.lockStrength || null,
          numberOrNull(prediction.lockGap),
          prediction.lockReason || null,
          String(prediction.symbol || 'BTC-USD').toUpperCase(),
          toBoolInt(prediction.sameDirectionAsPrev),
          prediction.status || (prediction.correct == null ? 'pending' : (prediction.correct ? 'correct' : 'wrong')),
          toBoolInt(prediction.correct),
          prediction.actualDirection || null,
          prediction.evaluatedAtIso || null,
          prediction.evaluationSource || null
        );
        return true;
      } catch (error) {
        console.error(`Stats DB recordNextSlotPrediction failed: ${error.message}`);
        return false;
      }
    },

    getNextSlotPrediction(id) {
      try {
        const row = selectNextSlotPredictionById.get(String(id || ''));
        return row ? mapNextSlotPredictionRow(row) : null;
      } catch (error) {
        console.error(`Stats DB getNextSlotPrediction failed: ${error.message}`);
        return null;
      }
    },

    getPendingNextSlotPredictions({ predictedSlotIso, timeframe = '5m' } = {}) {
      try {
        if (!predictedSlotIso) return [];
        const tf = timeframe === '15m' ? '15m' : '5m';
        return selectPendingNextSlotPredictions.all(String(predictedSlotIso), tf).map(mapNextSlotPredictionRow);
      } catch (error) {
        console.error(`Stats DB getPendingNextSlotPredictions failed: ${error.message}`);
        return [];
      }
    },

    getNextSlotPredictions({ lookbackDays = 14, timeframe = null, symbol = null } = {}) {
      try {
        const rows = selectNextSlotPredictions.all(lookbackCutoffIso(lookbackDays));
        const normalizedSymbol = symbol ? String(symbol).toUpperCase() : null;
        const tf = timeframe === '15m' || timeframe === '5m' ? timeframe : null;
        return rows
          .filter((row) => (!tf || row.source_timeframe === tf)
            && (!normalizedSymbol || String(row.symbol || 'BTC-USD').toUpperCase() === normalizedSymbol))
          .map(mapNextSlotPredictionRow);
      } catch (error) {
        console.error(`Stats DB getNextSlotPredictions failed: ${error.message}`);
        return [];
      }
    },

    /**
     * 全量方向判断：每次刷新 upsert 同一窗同一币种一行，累加 refresh_count。
     * id 约定：dj_{timeframe}_{targetTimeIso}_{symbol}
     */
    recordDirectionJudgment(judgment) {
      if (!judgment?.id || !judgment?.predictedDirection) return false;
      try {
        const tf = judgment.timeframe === '15m' ? '15m' : '5m';
        upsertDirectionJudgment.run(
          String(judgment.id),
          String(judgment.symbol || 'BTC-USD').toUpperCase(),
          tf,
          judgment.slotIso || null,
          String(judgment.targetTimeIso || ''),
          judgment.predictedDirection === 'down' ? 'down' : 'up',
          judgment.predictedAtIso || new Date().toISOString(),
          numberOrNull(judgment.confidence),
          numberOrNull(judgment.upProb ?? judgment.upProbability),
          numberOrNull(judgment.downProb ?? judgment.downProbability),
          judgment.lockStrength || null,
          numberOrNull(judgment.lockGap ?? judgment.pmGap),
          numberOrNull(judgment.price),
          judgment.source || null,
          Number.isFinite(Number(judgment.hourBucket)) ? Math.trunc(Number(judgment.hourBucket)) : null,
          judgment.volatilityBucket || null,
          toBoolInt(judgment.sameDirectionAsPrev),
          judgment.status || (judgment.correct == null ? 'pending' : (judgment.correct ? 'correct' : 'wrong')),
          toBoolInt(judgment.correct),
          judgment.actualDirection || null,
          judgment.evaluatedAtIso || null,
          Math.max(1, Number(judgment.refreshCount) || 1)
        );
        return true;
      } catch (error) {
        console.error(`Stats DB recordDirectionJudgment failed: ${error.message}`);
        return false;
      }
    },

    settleDirectionJudgment({ id, actualDirection, evaluatedAtIso = null } = {}) {
      if (!id || !['up', 'down'].includes(actualDirection)) return false;
      try {
        const row = db.prepare('SELECT predicted_direction FROM direction_judgments WHERE id = ?').get(String(id));
        if (!row) return false;
        const correct = row.predicted_direction === actualDirection;
        settleDirectionJudgmentStmt.run(
          correct ? 'correct' : 'wrong',
          correct ? 1 : 0,
          actualDirection,
          evaluatedAtIso || new Date().toISOString(),
          String(id)
        );
        return true;
      } catch (error) {
        console.error(`Stats DB settleDirectionJudgment failed: ${error.message}`);
        return false;
      }
    },

    /** 按 target_time + timeframe 批量回填（窗口结算时调用）。 */
    settleDirectionJudgmentsForTarget({ targetTimeIso, timeframe = '5m', actualDirection, evaluatedAtIso = null } = {}) {
      if (!targetTimeIso || !['up', 'down'].includes(actualDirection)) return 0;
      try {
        const tf = timeframe === '15m' ? '15m' : '5m';
        const pending = selectPendingDirectionJudgments.all(String(targetTimeIso), tf);
        let settled = 0;
        for (const row of pending) {
          if (this.settleDirectionJudgment({
            id: row.id,
            actualDirection,
            evaluatedAtIso
          })) settled += 1;
        }
        return settled;
      } catch (error) {
        console.error(`Stats DB settleDirectionJudgmentsForTarget failed: ${error.message}`);
        return 0;
      }
    },

    getDirectionJudgments({
      lookbackDays = 14,
      timeframe = null,
      symbol = null,
      status = null,
      settledOnly = false,
      limit = null
    } = {}) {
      try {
        // 过滤下推到 SQL，避免胜率页每次把回看窗口全表拉进 JS
        const clauses = ['predicted_at_iso >= ?'];
        const params = [lookbackCutoffIso(lookbackDays)];
        const tf = timeframe === '15m' || timeframe === '5m' ? timeframe : null;
        if (tf) {
          clauses.push('timeframe = ?');
          params.push(tf);
        }
        if (symbol) {
          clauses.push('symbol = ?');
          params.push(String(symbol).toUpperCase());
        }
        if (settledOnly) {
          clauses.push("status != 'pending'");
        } else if (status) {
          clauses.push('status = ?');
          params.push(String(status));
        }
        let sql = `SELECT * FROM direction_judgments WHERE ${clauses.join(' AND ')} ORDER BY predicted_at_iso DESC`;
        const lim = Number(limit);
        if (Number.isFinite(lim) && lim > 0) {
          sql += ' LIMIT ?';
          params.push(Math.trunc(lim));
        }
        return db.prepare(sql).all(...params).map(mapDirectionJudgmentRow);
      } catch (error) {
        console.error(`Stats DB getDirectionJudgments failed: ${error.message}`);
        return [];
      }
    },

    /** 条件胜率聚合：按时段 / 方向 / 锁定强度 / 波动档 / 同向连续性切片。 */
    getConditionalWinRates({
      lookbackDays = 14,
      timeframe = null,
      symbol = null,
      direction = null,
      lockStrength = null,
      hourBucket = null,
      volatilityBucket = null,
      sameDirectionAsPrev = null,
      limit = null
    } = {}) {
      try {
        const rows = this.getDirectionJudgments({
          lookbackDays,
          timeframe,
          symbol,
          settledOnly: true,
          limit
        });
        const match = (row) => {
          if (direction && row.predictedDirection !== direction) return false;
          if (lockStrength && row.lockStrength !== lockStrength) return false;
          if (hourBucket != null && Number(row.hourBucket) !== Number(hourBucket)) return false;
          if (volatilityBucket && row.volatilityBucket !== volatilityBucket) return false;
          if (sameDirectionAsPrev != null && row.sameDirectionAsPrev !== Boolean(sameDirectionAsPrev)) return false;
          return true;
        };
        return summarizeJudgmentRows(rows.filter(match));
      } catch (error) {
        console.error(`Stats DB getConditionalWinRates failed: ${error.message}`);
        return emptyJudgmentSummary();
      }
    },

    /** 返回与 summarizeIntervalPmBuckets / isExplicitPmLockRecord 兼容的记录对象。 */
    getLockRecords({ timeframe = '5m', lookbackDays = 14, symbol = null } = {}) {
      try {
        const rows = selectLocks.all(timeframe, lookbackCutoffIso(lookbackDays));
        const normalizedSymbol = symbol ? String(symbol).toUpperCase() : null;
        return rows
          .filter((row) => !normalizedSymbol || String(row.symbol || 'BTC-USD').toUpperCase() === normalizedSymbol)
          .map((row) => ({
          id: row.id,
          timeframe: row.timeframe,
          symbol: row.symbol,
          targetTimeIso: row.target_time_iso,
          decisionLocked: row.decision_locked === 1,
          lockedPolymarketPredictedDirection: row.locked_direction,
          lockStrength: row.lock_strength,
          lockedPmGap: row.locked_pm_gap,
          lockedPolymarketUpProbability: row.locked_up_prob,
          lockedPolymarketDownProbability: row.locked_down_prob,
          lockElapsedPct: row.lock_elapsed_pct,
          polymarketQualityScore: row.quality,
          polymarketCorrect: fromBoolInt(row.pm_correct),
          techCorrect: fromBoolInt(row.tech_correct),
          compositeCorrect: fromBoolInt(row.composite_correct),
          actualDirection: row.actual_direction,
          skipReason: row.skip_reason,
          evaluatedAtIso: row.evaluated_at_iso
        }));
      } catch (error) {
        console.error(`Stats DB getLockRecords failed: ${error.message}`);
        return [];
      }
    },

    /** 返回与 buildConfidenceCalibrationTable 输入兼容的订单对象。 */
    getCalibrationOrders({ lookbackDays = 30, source = 'all' } = {}) {
      try {
        const want = String(source || 'all').toLowerCase();
        return selectOrders.all(lookbackCutoffIso(lookbackDays))
          .filter((row) => want === 'all' || String(row.source || '').toLowerCase() === want)
          .map(mapSettledOrderRow);
      } catch (error) {
        console.error(`Stats DB getCalibrationOrders failed: ${error.message}`);
        return [];
      }
    },


    /** Plan3 价位带历史胜率；可按 source=live|paper|all 过滤，避免纸面高胜率掩盖实盘负 EV。 */
    getPlan3BandStats({ lookbackDays = 30, source = 'all', includeLegacyPlan35 = false } = {}) {
      try {
        const cutoffIso = lookbackCutoffIso(lookbackDays);
        const plan3Rows = selectPlanOrders.all('plan3', cutoffIso);
        const legacyRows = includeLegacyPlan35
          ? selectPlanOrders.all('plan3_5', cutoffIso)
          : [];
        const rows = [...plan3Rows, ...legacyRows];
        const want = String(source || 'all').toLowerCase();
        const bands = {};
        const bySymbol = {};
        const bySymbolPrice = {};
        const addResult = (bucket, won, pnl) => {
          bucket.total += 1;
          if (won) bucket.wins += 1;
          else bucket.losses += 1;
          bucket.totalPnl = Math.round((bucket.totalPnl + pnl) * 100) / 100;
        };
        const createBucket = () => ({ total: 0, wins: 0, losses: 0, totalPnl: 0 });
        for (const row of rows) {
          if (want !== 'all' && String(row.source || '').toLowerCase() !== want) continue;
          const won = fromBoolInt(row.won);
          if (won == null) continue;
          const symbol = String(row.symbol || 'BTC-USD').toUpperCase();
          const band = resolvePlan3PriceBand(row.entry_price);
          const priceKey = resolvePlan3PriceCentKey(row.entry_price);
          const pnl = Number(row.pnl) || 0;
          if (!bands[band]) bands[band] = createBucket();
          if (!bySymbol[symbol]) bySymbol[symbol] = {};
          if (!bySymbol[symbol][band]) bySymbol[symbol][band] = createBucket();
          if (!bySymbolPrice[symbol]) bySymbolPrice[symbol] = {};
          if (!bySymbolPrice[symbol][priceKey]) bySymbolPrice[symbol][priceKey] = createBucket();
          addResult(bands[band], won, pnl);
          addResult(bySymbol[symbol][band], won, pnl);
          addResult(bySymbolPrice[symbol][priceKey], won, pnl);
        }
        const finalizeBuckets = (collection) => {
          for (const bucket of Object.values(collection)) {
            bucket.winRate = bucket.total ? bucket.wins / bucket.total : 0;
          }
        };
        finalizeBuckets(bands);
        for (const symbolBands of Object.values(bySymbol)) finalizeBuckets(symbolBands);
        for (const symbolPrices of Object.values(bySymbolPrice)) finalizeBuckets(symbolPrices);
        if (Object.keys(bands).length > 0) {
          bands._bySymbol = bySymbol;
          bands._bySymbolPrice = bySymbolPrice;
        }
        if (includeLegacyPlan35) {
          bands._meta = {
            legacyPlan35Merged: true,
            legacyPlan35Samples: legacyRows.filter((row) => (
              (want === 'all' || String(row.source || '').toLowerCase() === want)
              && fromBoolInt(row.won) != null
            )).length
          };
        }
        return bands;
      } catch (error) {
        console.error(`Stats DB getPlan3BandStats failed: ${error.message}`);
        return {};
      }
    },

    getPlanEntryStats({ planId, timeframe = null, entryType = null, lookbackDays = 30, symbol = null } = {}) {
      try {
        const normalizedSymbol = symbol ? String(symbol).toUpperCase() : null;
        const rows = selectPlanOrders.all(String(planId || 'plan1'), lookbackCutoffIso(lookbackDays))
          .filter((row) => (!timeframe || row.timeframe === timeframe))
          .filter((row) => (!entryType || row.entry_type === entryType))
          .filter((row) => (!normalizedSymbol || String(row.symbol || 'BTC-USD').toUpperCase() === normalizedSymbol));
        const settled = rows.filter((row) => fromBoolInt(row.won) != null);
        const wins = settled.filter((row) => row.won === 1);
        return {
          total: settled.length,
          wins: wins.length,
          losses: settled.length - wins.length,
          winRate: settled.length ? wins.length / settled.length : 0,
          totalPnl: Math.round(settled.reduce((sum, row) => sum + (Number(row.pnl) || 0), 0) * 100) / 100
        };
      } catch (error) {
        console.error(`Stats DB getPlanEntryStats failed: ${error.message}`);
        return { total: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0 };
      }
    },

    /**
     * 按 symbol 聚合已结算胜率（供分币展示与奖赏仓位）。
     * 返回 { 'BTC-USD': { total, wins, losses, winRate, totalPnl }, ... }
     */
    getPlanEntryStatsBySymbol({
      planId,
      timeframe = null,
      entryType = null,
      lookbackDays = 30,
      source = 'all'
    } = {}) {
      try {
        const want = String(source || 'all').toLowerCase();
        const rows = selectPlanOrders.all(String(planId || 'plan1'), lookbackCutoffIso(lookbackDays))
          .filter((row) => (!timeframe || row.timeframe === timeframe))
          .filter((row) => (!entryType || row.entry_type === entryType))
          .filter((row) => want === 'all' || String(row.source || '').toLowerCase() === want);
        const bySymbol = {};
        for (const row of rows) {
          if (fromBoolInt(row.won) == null) continue;
          const symbol = String(row.symbol || 'BTC-USD').toUpperCase();
          if (!bySymbol[symbol]) {
            bySymbol[symbol] = { total: 0, wins: 0, losses: 0, totalPnl: 0 };
          }
          bySymbol[symbol].total += 1;
          if (row.won === 1) bySymbol[symbol].wins += 1;
          else bySymbol[symbol].losses += 1;
          bySymbol[symbol].totalPnl = Math.round(
            (bySymbol[symbol].totalPnl + (Number(row.pnl) || 0)) * 100
          ) / 100;
        }
        for (const symbol of Object.keys(bySymbol)) {
          const bucket = bySymbol[symbol];
          bucket.winRate = bucket.total ? bucket.wins / bucket.total : 0;
          bucket.samples = bucket.total;
          bucket.settledOrders = bucket.total;
        }
        return bySymbol;
      } catch (error) {
        console.error(`Stats DB getPlanEntryStatsBySymbol failed: ${error.message}`);
        return {};
      }
    },

    /** 含 loss_reason 的已结算订单，供亏损归因门控 / 仪表聚合。 */
    getLossReasonOrders({
      planId = null,
      lookbackDays = 14,
      source = 'all',
      timeframe = null,
      entryType = null,
      symbol = null
    } = {}) {
      try {
        const want = String(source || 'all').toLowerCase();
        const normalizedSymbol = symbol ? String(symbol).toUpperCase() : null;
        const rows = planId
          ? selectPlanOrders.all(String(planId), lookbackCutoffIso(lookbackDays))
          : selectOrders.all(lookbackCutoffIso(lookbackDays));
        return rows
          .filter((row) => want === 'all' || String(row.source || '').toLowerCase() === want)
          .filter((row) => (!timeframe || row.timeframe === timeframe))
          .filter((row) => (!entryType || row.entry_type === entryType))
          .filter((row) => (!normalizedSymbol || String(row.symbol || 'BTC-USD').toUpperCase() === normalizedSymbol))
          .map(mapSettledOrderRow);
      } catch (error) {
        console.error(`Stats DB getLossReasonOrders failed: ${error.message}`);
        return [];
      }
    },

    /** 按 plan + loss_reason 计数（可选 timeframe / entryType / symbol）。 */
    getLossReasonStats({
      planId = null,
      lookbackDays = 14,
      source = 'all',
      timeframe = null,
      entryType = null,
      symbol = null
    } = {}) {
      try {
        const orders = this.getLossReasonOrders({
          planId,
          lookbackDays,
          source,
          timeframe,
          entryType,
          symbol
        });
        const byReason = {};
        let total = 0;
        let losses = 0;
        let wins = 0;
        for (const order of orders) {
          if (order.won == null) continue;
          total += 1;
          if (order.won) {
            wins += 1;
            continue;
          }
          losses += 1;
          const reason = order.lossReason || 'unknown';
          if (!byReason[reason]) {
            byReason[reason] = { count: 0, totalPnl: 0 };
          }
          byReason[reason].count += 1;
          byReason[reason].totalPnl = Math.round(
            (byReason[reason].totalPnl + (Number(order.pnl) || 0)) * 100
          ) / 100;
        }
        return {
          total,
          wins,
          losses,
          winRate: total ? wins / total : 0,
          byReason,
          orders
        };
      } catch (error) {
        console.error(`Stats DB getLossReasonStats failed: ${error.message}`);
        return { total: 0, wins: 0, losses: 0, winRate: 0, byReason: {}, orders: [] };
      }
    },

    getLifetimeLiveStats({ planIds = null } = {}) {
      try {
        const allowed = Array.isArray(planIds)
          ? new Set(planIds.map((id) => String(id || '').toLowerCase()).filter(Boolean))
          : null;
        const rows = selectLifetimeLiveStats.all()
          .filter((row) => !allowed || allowed.has(String(row.plan_id || '').toLowerCase()));
        const byPlan = {};
        let settledTrades = 0;
        let wins = 0;
        let losses = 0;
        let investedUsd = 0;
        let realizedPnl = 0;
        for (const row of rows) {
          const planId = String(row.plan_id || '').toLowerCase();
          if (!planId) continue;
          const planSettled = Number(row.settled_trades) || 0;
          const planWins = Number(row.wins) || 0;
          const planLosses = Number(row.losses) || 0;
          const planInvested = Number(row.invested_usd) || 0;
          const planPnl = Number(row.realized_pnl) || 0;
          byPlan[planId] = {
            orderCount: planSettled,
            settledTrades: planSettled,
            wins: planWins,
            losses: planLosses,
            investedUsd: Math.round(planInvested * 100) / 100,
            realizedPnl: Math.round(planPnl * 100) / 100,
            totalReturn: planInvested > 0
              ? Math.round((planPnl / planInvested) * 10_000) / 10_000
              : 0
          };
          settledTrades += planSettled;
          wins += planWins;
          losses += planLosses;
          investedUsd += planInvested;
          realizedPnl += planPnl;
        }
        return {
          available: true,
          historySource: 'stats_db_lifetime',
          settledTrades,
          wins,
          losses,
          investedUsd: Math.round(investedUsd * 100) / 100,
          realizedPnl: Math.round(realizedPnl * 100) / 100,
          totalReturn: investedUsd > 0
            ? Math.round((realizedPnl / investedUsd) * 10_000) / 10_000
            : 0,
          winRate: (wins + losses) > 0
            ? Math.round((wins / (wins + losses)) * 10_000) / 10_000
            : 0,
          byPlan
        };
      } catch (error) {
        console.error(`Stats DB getLifetimeLiveStats failed: ${error.message}`);
        return { available: false, historySource: 'unavailable', byPlan: {} };
      }
    },

    resetPaperData() {
      try {
        db.exec('BEGIN IMMEDIATE');
        const settledOrders = db.prepare("DELETE FROM settled_orders WHERE source = 'paper'").run().changes;
        const plan7MarketSamples = db.prepare('DELETE FROM plan7_market_samples').run().changes;
        db.exec('COMMIT');
        return { settledOrders, plan7MarketSamples };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
        console.error(`Stats DB resetPaperData failed: ${error.message}`);
        throw error;
      }
    },

    counts() {
      try {
        return {
          windowLocks: db.prepare('SELECT COUNT(*) AS n FROM window_locks').get().n,
          settledOrders: db.prepare('SELECT COUNT(*) AS n FROM settled_orders').get().n,
          nextSlotPredictions: db.prepare('SELECT COUNT(*) AS n FROM next_slot_predictions').get().n,
          directionJudgments: db.prepare('SELECT COUNT(*) AS n FROM direction_judgments').get().n,
          plan7MarketSamples: db.prepare('SELECT COUNT(*) AS n FROM plan7_market_samples').get().n
        };
      } catch {
        return { windowLocks: 0, settledOrders: 0, nextSlotPredictions: 0, directionJudgments: 0, plan7MarketSamples: 0 };
      }
    },

    listSettledOrderIds() {
      try {
        return selectSettledOrderIds.all().map((row) => String(row.id));
      } catch (error) {
        console.error(`Stats DB listSettledOrderIds failed: ${error.message}`);
        return [];
      }
    },

    close() {
      try { db.close(); } catch { /* already closed */ }
    }
  };
}

function mapNextSlotPredictionRow(row) {
  const sameDirectionAsPrev = fromBoolInt(row.same_direction_as_prev);
  return {
    id: row.id,
    sourceSlotIso: row.source_slot_iso,
    sourceTimeframe: row.source_timeframe,
    sourceTargetTimeIso: row.source_target_time_iso,
    predictedSlotIso: row.predicted_slot_iso,
    predictedDirection: row.predicted_direction,
    predictedAtIso: row.predicted_at_iso,
    lockStrength: row.lock_strength,
    lockGap: row.lock_gap,
    lockReason: row.lock_reason,
    symbol: row.symbol,
    sameDirectionAsPrev,
    continuity: sameDirectionAsPrev === true ? 'same' : sameDirectionAsPrev === false ? 'flip' : 'first',
    status: row.status,
    correct: fromBoolInt(row.correct),
    actualDirection: row.actual_direction,
    evaluatedAtIso: row.evaluated_at_iso,
    evaluationSource: row.evaluation_source
  };
}

function parseLossAnalysisJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function mapSettledOrderRow(row) {
  const lossAnalysis = parseLossAnalysisJson(row.loss_analysis_json);
  const lockStrength = row.lock_strength
    || lossAnalysis?.detail?.lockStrength
    || lossAnalysis?.lockStrength
    || null;
  return {
    id: row.id,
    source: row.source,
    planId: row.plan_id,
    timeframe: row.timeframe,
    symbol: row.symbol || null,
    direction: row.direction,
    entryType: row.entry_type,
    limitPrice: row.entry_price,
    entryPrice: row.entry_price,
    usd: row.usd,
    pnl: row.pnl,
    won: fromBoolInt(row.won),
    exitStatus: row.exit_status,
    confidence: row.confidence,
    slotIso: row.slot_iso,
    targetTimeIso: row.target_time_iso || null,
    settledAtIso: row.settled_at_iso || null,
    crossSymbolAligned: fromBoolInt(row.cross_symbol_aligned),
    crossSymbolLeader: row.cross_symbol_leader || null,
    leaderLimitPrice: row.leader_limit_price ?? null,
    lockPmGap: row.lock_pm_gap ?? null,
    lockedAtIso: row.locked_at_iso || null,
    signalQuality: parseLossAnalysisJson(row.signal_quality_json),
    expectedValueGate: parseLossAnalysisJson(row.expected_value_json),
    strategyVersion: row.strategy_version || null,
    lossReason: row.loss_reason || lossAnalysis?.lossReason || null,
    pmReversal: fromBoolInt(row.pm_reversal),
    lossAnalysis,
    lockStrength,
    settlementStatus: 'settled',
    positionStatus: 'closed'
  };
}

function createDisabledStatsDb(reason) {
  return {
    enabled: false,
    reason,
    recordWindowLock: () => false,
    recordWindowSnapshot: () => false,
    recordSettledOrders: () => 0,
    recordPlan7Samples: () => 0,
    recordNextSlotPrediction: () => false,
    getNextSlotPrediction: () => null,
    getPendingNextSlotPredictions: () => [],
    getNextSlotPredictions: () => [],
    recordDirectionJudgment: () => false,
    settleDirectionJudgment: () => false,
    settleDirectionJudgmentsForTarget: () => 0,
    getDirectionJudgments: () => [],
    getConditionalWinRates: () => emptyJudgmentSummary(),
    getLockRecords: () => [],
    getCalibrationOrders: () => [],
    getPlan3BandStats: () => ({}),
    getPlanEntryStats: () => ({ total: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0 }),
    getPlanEntryStatsBySymbol: () => ({}),
    getLossReasonOrders: () => [],
    getLossReasonStats: () => ({ total: 0, wins: 0, losses: 0, winRate: 0, byReason: {}, orders: [] }),
    getLifetimeLiveStats: () => ({ available: false, historySource: 'disabled', byPlan: {} }),
    resetPaperData: () => ({ settledOrders: 0, plan7MarketSamples: 0 }),
    counts: () => ({ windowLocks: 0, settledOrders: 0, nextSlotPredictions: 0, directionJudgments: 0 }),
    listSettledOrderIds: () => [],
    close: () => {}
  };
}

function emptyJudgmentSummary() {
  return { total: 0, correct: 0, wrong: 0, winRate: 0, sampleInsufficient: true };
}

function summarizeJudgmentRows(rows = []) {
  let correct = 0;
  let wrong = 0;
  for (const row of rows) {
    if (row.correct === true) correct += 1;
    else if (row.correct === false) wrong += 1;
  }
  const total = correct + wrong;
  return {
    total,
    correct,
    wrong,
    winRate: total ? correct / total : 0,
    sampleInsufficient: total < 8
  };
}

function mapDirectionJudgmentRow(row) {
  return {
    id: row.id,
    symbol: row.symbol,
    timeframe: row.timeframe,
    slotIso: row.slot_iso,
    targetTimeIso: row.target_time_iso,
    predictedDirection: row.predicted_direction,
    predictedAtIso: row.predicted_at_iso,
    confidence: row.confidence,
    upProb: row.up_prob,
    downProb: row.down_prob,
    lockStrength: row.lock_strength,
    lockGap: row.lock_gap,
    price: row.price,
    source: row.source,
    hourBucket: row.hour_bucket,
    volatilityBucket: row.volatility_bucket,
    sameDirectionAsPrev: fromBoolInt(row.same_direction_as_prev),
    status: row.status,
    correct: fromBoolInt(row.correct),
    actualDirection: row.actual_direction,
    evaluatedAtIso: row.evaluated_at_iso,
    refreshCount: Number(row.refresh_count) || 1
  };
}
