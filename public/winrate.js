const SYMBOLS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD'];
const POLL_MS = 5000;
const DEADLINE_POLL_MS = 2000;
const REQUEST_TIMEOUT_MS = 10000;
const WINRATE_SNAPSHOT_KEY = 'kawaiiWinrateSnapshotV2';

const statusEl = document.querySelector('#winrateStatus');
const loadingEl = document.querySelector('#winrateLoading');
const refreshBtn = document.querySelector('#refreshWinrate');
const lookbackEl = document.querySelector('#winrateLookback');
const slot5mEl = document.querySelector('#winrateSlot5m');
const next5mEl = document.querySelector('#winrateNext5m');
const countdown5mEl = document.querySelector('#winrateCountdown5m');
const slot15mEl = document.querySelector('#winrateSlot15m');
const next15mEl = document.querySelector('#winrateNext15m');
const countdown15mEl = document.querySelector('#winrateCountdown15m');
const sourceEl = document.querySelector('#winrateSource');
const signalsEl = document.querySelector('#winrateSignals');
const guidanceBanner = document.querySelector('#winrateGuidanceBanner');
const dbMetaEl = document.querySelector('#winrateDbMeta');
const progressTextEl = document.querySelector('#winrateProgressText');
const progressFillEl = document.querySelector('#winrateProgressFill');
const progressTrackEl = document.querySelector('.winrate-progress-track');
const freshnessEl = document.querySelector('#winrateFreshness');
const symbolProgressEl = document.querySelector('#winrateSymbolProgress');

let pageState = null;
let lastSlotIso5m = null;
let lastSlotIso15m = null;
let refreshAbort = null;
let refreshSeq = 0;
let lastDeadlineRefreshAt = 0;
let lastBoundaryBurstSlot = null;

async function getJson(url, { signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const requestController = new AbortController();
  let deadlineReached = false;
  const relayAbort = () => requestController.abort(signal?.reason);
  signal?.addEventListener('abort', relayAbort, { once: true });
  const timer = setTimeout(() => {
    deadlineReached = true;
    requestController.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, { signal: requestController.signal });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `HTTP ${response.status}`);
    }
    return response.json();
  } catch (error) {
    if (deadlineReached) {
      throw new Error(`胜率接口超过 ${Math.round(timeoutMs / 1000)} 秒未返回`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
  }
}

function formatTime(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '--:--';
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

function formatCountdown(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function currentSlotSchedule(minutes = 5, nowMs = Date.now()) {
  const slotMs = minutes * 60_000;
  const startMs = Math.floor(nowMs / slotMs) * slotMs;
  return {
    startMs,
    nextMs: startMs + slotMs,
    elapsedSeconds: Math.max(0, Math.floor((nowMs - startMs) / 1000)),
    totalSeconds: minutes * 60
  };
}

function readCachedSnapshot() {
  try {
    const parsed = JSON.parse(localStorage.getItem(WINRATE_SNAPSHOT_KEY) || 'null');
    const generatedAtMs = Date.parse(parsed?.generatedAt);
    if (!parsed?.bySymbol || !Number.isFinite(generatedAtMs)) return null;
    if (Date.now() - generatedAtMs > 30 * 60_000) return null;
    return { ...parsed, browserCached: true };
  } catch {
    return null;
  }
}

function saveCachedSnapshot(data) {
  if (!data?.bySymbol || data.refreshing) return;
  try {
    localStorage.setItem(WINRATE_SNAPSHOT_KEY, JSON.stringify(data));
  } catch {
    // The live page remains usable when browser storage is unavailable/full.
  }
}

function updateCycleProgress() {
  const live = currentSlotSchedule(5);
  const pct = Math.max(0, Math.min(1, live.elapsedSeconds / live.totalSeconds));
  if (progressTextEl) {
    progressTextEl.textContent = `${formatCountdown(live.elapsedSeconds)} / 05:00 · ${Math.round(pct * 100)}%`;
  }
  if (progressFillEl) progressFillEl.style.width = `${(pct * 100).toFixed(2)}%`;
  if (progressTrackEl) progressTrackEl.setAttribute('aria-valuenow', String(Math.round(pct * 100)));

  const generatedAtMs = Date.parse(pageState?.generatedAt);
  const dataAgeSeconds = Number.isFinite(generatedAtMs)
    ? Math.max(0, Math.floor((Date.now() - generatedAtMs) / 1000))
    : null;
  if (freshnessEl) {
    freshnessEl.textContent = pageState?.refreshing
      ? `后台同步中 · 当前数据 ${dataAgeSeconds ?? '--'} 秒前`
      : (dataAgeSeconds === null ? '正在连接实时数据' : `实时数据 ${dataAgeSeconds} 秒前`);
    freshnessEl.classList.toggle('is-stale', pageState?.refreshing || (dataAgeSeconds ?? 0) > 15);
  }

  if (!symbolProgressEl) return;
  const payloadSchedule = pickSharedSchedule(pageState, '5m');
  const payloadSlotMs = Date.parse(payloadSchedule?.currentSlotIso);
  const sameLiveSlot = Number.isFinite(payloadSlotMs) && Math.abs(payloadSlotMs - live.startMs) < 1000;
  symbolProgressEl.innerHTML = SYMBOLS.map((symbol) => {
    const bundle = pageState?.bySymbol?.[symbol]?.['5m'];
    const signal = bundle?.signal;
    const locked = sameLiveSlot && Boolean(bundle?.locked || signal?.lockedDecision?.direction);
    const pm = signal?.polymarket;
    let state = 'syncing';
    let label = '新轮同步中';
    if (locked) {
      state = 'locked';
      label = `${directionLabel(resolveLockedDirection(bundle))} · 已锁定`;
    } else if (sameLiveSlot && pm?.available) {
      state = pm.reusedLastGood ? 'cached' : 'judging';
      label = pm.reusedLastGood ? '沿用本轮有效值' : '实时判断中';
    } else if (sameLiveSlot) {
      state = 'reconnecting';
      label = live.elapsedSeconds >= 108 ? '兜底锁定同步中' : 'PM 数据重连';
    }
    return `<div class="winrate-symbol-chip ${state}"><strong>${symbol.replace('-USD', '')}</strong><span>${escapeHtml(label)}</span></div>`;
  }).join('');
}

function formatPct(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '--';
  return `${(num * 100).toFixed(1)}%`;
}

function formatPrice(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '--';
  return `$${num.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function directionLabel(direction) {
  if (direction === 'up') return '上涨 UP';
  if (direction === 'down') return '下跌 DOWN';
  return '未知';
}

function strengthLabel(strength) {
  if (strength === 'strong') return '强锁定';
  if (strength === 'normal') return '普通锁定';
  if (strength === 'weak') return '弱锁定';
  return '';
}

/** A locked direction is immutable for the current interval. */
function resolveLockedDirection(bundle) {
  const locked = bundle?.signal?.lockedDecision;
  if (locked?.direction === 'up' || locked?.direction === 'down') return locked.direction;
  if (bundle?.locked && (bundle?.judgment?.predictedDirection === 'up' || bundle?.judgment?.predictedDirection === 'down')) {
    return bundle.judgment.predictedDirection;
  }
  return null;
}

function resolveCandidateDirection(bundle) {
  const up = Number(bundle?.signal?.polymarket?.upProbability);
  const down = Number(bundle?.signal?.polymarket?.downProbability);
  if (!Number.isFinite(up) || !Number.isFinite(down) || up === down) return null;
  return up > down ? 'up' : 'down';
}

function resolveCandidateConfidence(bundle) {
  const up = Number(bundle?.signal?.polymarket?.upProbability);
  const down = Number(bundle?.signal?.polymarket?.downProbability);
  return Number.isFinite(up) && Number.isFinite(down) ? Math.max(up, down) : null;
}

function resolveDisplayPrice(bundle) {
  const candidates = [
    bundle?.judgment?.price,
    bundle?.signal?.currentPrice,
    bundle?.signal?.price,
    bundle?.signal?.indicators?.currentPrice,
    bundle?.signal?.indicators?.close,
    bundle?.signal?.polymarket?.underlyingPrice,
    bundle?.signal?.polymarket?.price
  ];
  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return null;
}

function resolveDisplaySource(bundle) {
  const locked = bundle?.signal?.lockedDecision;
  if (locked?.source) return locked.source;
  if (bundle?.judgment?.source) return bundle.judgment.source;
  if (bundle?.signal?.polymarket?.available) return 'polymarket';
  return pageState?.source || '--';
}

function pickSharedSchedule(data, timeframe) {
  for (const symbol of SYMBOLS) {
    const schedule = data?.bySymbol?.[symbol]?.[timeframe]?.signal?.schedule;
    if (schedule?.currentSlotIso || schedule?.nextSlotIso) return schedule;
  }
  if (timeframe === '5m') {
    return data?.schedule5m || data?.signals5m?.[0]?.schedule || null;
  }
  return data?.signals?.[0]?.schedule || null;
}

function renderStatsBlock(stats, label) {
  const total = Number(stats?.total) || 0;
  const winRate = formatPct(stats?.winRate);
  const detail = total
    ? `正确 ${stats.correct || 0} / 错误 ${stats.wrong || 0}`
    : '暂无结算样本';
  const insufficient = !total || stats?.sampleInsufficient;
  return `
    <div class="winrate-stat-card ${insufficient ? 'is-insufficient' : ''}">
      <span>${escapeHtml(label)}</span>
      <strong>${total ? winRate : '--'}</strong>
      <small>${escapeHtml(detail)}${insufficient ? ' · 样本不足' : ''}</small>
    </div>
  `;
}

function renderStrengthRows(stats) {
  const buckets = stats?.buckets?.strength || {};
  const rows = [
    ['强锁定', 'strong'],
    ['普通锁定', 'normal'],
    ['弱锁定', 'weak']
  ].map(([label, key]) => {
    const bucket = buckets[key] || {};
    const total = Number(bucket.total) || 0;
    const correct = Number(bucket.correct ?? bucket.wins) || 0;
    const wrong = Number(bucket.wrong ?? bucket.losses) || Math.max(0, total - correct);
    const winRate = total > 0
      ? (Number.isFinite(Number(bucket.winRate)) ? Number(bucket.winRate) : correct / total)
      : null;
    return `<div class="winrate-strength-row"><span>${label}</span><strong>${total ? formatPct(winRate) : '--'}</strong><small>n=${total}</small></div>`;
  }).join('');
  return `<div class="winrate-strength-rows">${rows}</div>`;
}

function renderGuidanceCard(guidance, locked, candidateDirection = null) {
  if (!locked) {
    const candidate = candidateDirection
      ? `当前 PM 候选为「${directionLabel(candidateDirection)}」；候选会随盘口变化，不用于下单或胜率统计。`
      : '当前 PM 盘口还没有形成候选方向。';
    return `<div class="winrate-guidance-card is-insufficient"><strong>等待正式锁定</strong><p>${escapeHtml(candidate)} 达到价差、质量和稳定性条件后才会正式锁定并入库。</p></div>`;
  }
  if (!guidance) {
    return `<div class="winrate-guidance-card is-insufficient"><strong>样本不足</strong><p>尚无历史指导。</p></div>`;
  }
  const tone = guidance.sampleInsufficient
    ? 'is-insufficient'
    : guidance.alignsWithHistoricalEdge === false
      ? 'is-conflict'
      : guidance.alignsWithHistoricalEdge === true
        ? 'is-aligned'
        : '';
  const pref = guidance.preferredDirection
    ? (guidance.preferredDirection === 'up' ? '历史优势 UP' : '历史优势 DOWN')
    : '历史优势未形成';
  const cond = guidance.conditional || {};
  return `
    <div class="winrate-guidance-card ${tone}">
      <div class="winrate-guidance-head">
        <strong>${guidance.sampleInsufficient ? '样本不足' : '历史指导生效'}</strong>
        <span>建议权重 ×${Number(guidance.suggestedWeight || 1).toFixed(2)}</span>
      </div>
      <p>${escapeHtml(guidance.note || '')}</p>
      <div class="winrate-guidance-meta">
        <span>同条件 ${formatPct(cond.winRate)}（n=${cond.total || 0}）</span>
        <span>${escapeHtml(pref)}</span>
        <span>${guidance.alignsWithHistoricalEdge === true ? '与优势方向一致' : guidance.alignsWithHistoricalEdge === false ? '与优势方向不一致' : '一致性未知'}</span>
      </div>
    </div>
  `;
}

function renderTimeframeColumn(bundle, timeframe, symbol) {
  const signal = bundle?.signal;
  const locked = Boolean(bundle?.locked || signal?.lockedDecision?.direction);
  const direction = resolveLockedDirection(bundle);
  const candidateDirection = locked ? null : resolveCandidateDirection(bundle);
  const displayDirection = direction || candidateDirection;
  const lockedDecision = signal?.lockedDecision;
  const strength = lockedDecision?.strength || lockedDecision?.lockStrength || bundle?.judgment?.lockStrength || '';
  const confidence = locked
    ? (lockedDecision?.confidence ?? signal?.confidence ?? bundle?.judgment?.confidence)
    : resolveCandidateConfidence(bundle);
  const before = signal?.confidenceBeforeGuidance;
  const tone = displayDirection === 'up' ? 'up' : displayDirection === 'down' ? 'down' : 'muted';
  const tfLabel = timeframe === '15m' ? '15 分钟' : '5 分钟';
  const price = resolveDisplayPrice(bundle);
  const source = resolveDisplaySource(bundle);
  const lockStats = timeframe === '15m'
    ? pageState?.lockSummary?.fifteenMinute
    : pageState?.lockSummary?.fiveMinute;
  const stats = lockStats?.total ? lockStats : bundle?.stats;
  const symbolLabel = String(symbol || '').replace('-USD', '') || '--';

  return `
    <div class="interval-timeframe-column interval-column-${timeframe === '15m' ? '15m' : '5m'}">
      <div class="interval-timeframe-label">${escapeHtml(symbolLabel)} ${tfLabel}预测</div>
      <div class="interval-card ${tone} interval-card-${timeframe === '15m' ? '15m' : '5m'}">
        <div class="interval-card-head">
          <strong>${escapeHtml(locked ? directionLabel(direction) : (candidateDirection ? `候选 ${directionLabel(candidateDirection)}` : directionLabel(null)))}</strong>
          <span>${escapeHtml(locked ? (strengthLabel(strength) || (timeframe === '15m' ? '15m' : '5m')) : 'PM 候选 · 未锁定')}</span>
        </div>
        <div class="signal-metrics">
          <span>当前判断</span><b>${escapeHtml(locked ? directionLabel(direction) : (candidateDirection ? `候选 ${directionLabel(candidateDirection)}` : directionLabel(null)))}</b>
          <span>置信度</span><b>${Number.isFinite(Number(confidence)) ? `${formatPct(confidence)}${locked && Number.isFinite(Number(before)) && Number(before) !== Number(confidence) ? ` ← ${formatPct(before)}` : ''}` : '--'}</b>
          <span>现价</span><b>${formatPrice(price)}</b>
          <span>来源</span><b>${escapeHtml(String(source))}</b>
        </div>
        <div class="winrate-stat-row">
          ${renderStatsBlock(stats, `${tfLabel} PM 锁定胜率`)}
          ${renderStatsBlock(locked ? bundle?.guidance?.conditional : null, `${tfLabel} 同条件胜率`)}
        </div>
        ${renderStrengthRows(stats)}
        ${renderGuidanceCard(bundle?.guidance, locked, candidateDirection)}
      </div>
    </div>
  `;
}

function renderSymbolBlock(symbol, symbolData) {
  const label = symbol.replace('-USD', '');
  return `
    <section class="winrate-symbol-block" data-symbol="${escapeHtml(symbol)}" aria-label="${escapeHtml(label)} 预测">
      <header class="winrate-symbol-head">
        <h3>${escapeHtml(label)}</h3>
        <span>${escapeHtml(symbol)}</span>
      </header>
      <div class="interval-signals-grid winrate-signals-grid">
        ${renderTimeframeColumn(symbolData?.['5m'], '5m', symbol)}
        ${renderTimeframeColumn(symbolData?.['15m'], '15m', symbol)}
      </div>
    </section>
  `;
}

function fillSchedule(elSlot, elNext, elCountdown, schedule) {
  if (!schedule) {
    if (elSlot) elSlot.textContent = '--:--';
    if (elNext) elNext.textContent = '--:--';
    if (elCountdown) elCountdown.textContent = '--:--';
    return;
  }
  if (elSlot) elSlot.textContent = formatTime(schedule.currentSlotIso);
  if (elNext) elNext.textContent = formatTime(schedule.nextSlotIso);
  const nextMs = Date.parse(schedule.nextSlotIso);
  const seconds = Number.isFinite(nextMs)
    ? Math.max(0, Math.floor((nextMs - Date.now()) / 1000))
    : Number(schedule.secondsToNext) || 0;
  if (elCountdown) elCountdown.textContent = formatCountdown(seconds);
}

function renderPage(data) {
  const schedule15m = pickSharedSchedule(data, '15m');
  const schedule5m = pickSharedSchedule(data, '5m');
  updateCycleProgress();

  fillSchedule(slot5mEl, next5mEl, countdown5mEl, schedule5m);
  fillSchedule(slot15mEl, next15mEl, countdown15mEl, schedule15m);

  if (sourceEl) {
    sourceEl.textContent = data.polymarketEnabled
      ? 'Polymarket 锁定（主） + Binance K 线'
      : (data.source === 'binance' ? 'Binance 15m/5m K线' : 'Mock');
  }

  let anyLocked = false;
  let anyInsufficient = true;
  const notes = [];
  for (const symbol of SYMBOLS) {
    const symbolData = data.bySymbol?.[symbol];
    const g15 = symbolData?.['15m']?.guidance;
    const g5 = symbolData?.['5m']?.guidance;
    const locked15 = Boolean(symbolData?.['15m']?.locked);
    const locked5 = Boolean(symbolData?.['5m']?.locked);
    if (locked5 || locked15) anyLocked = true;
    if (!(g15?.sampleInsufficient && g5?.sampleInsufficient)) anyInsufficient = false;
    if (g15?.note) notes.push(`${symbol.replace('-USD', '')} 15m：${g15.note}`);
    if (g5?.note) notes.push(`${symbol.replace('-USD', '')} 5m：${g5.note}`);
  }

  if (guidanceBanner) {
    if (!anyLocked) {
      guidanceBanner.textContent = '四币完整预测见下方；等待 PM 正式锁定后才会入库并更新同条件胜率。候选方向会随盘口变化。';
      guidanceBanner.classList.add('is-insufficient');
    } else {
      guidanceBanner.textContent = notes[0] || '四币完整预测见下方；历史样本将在此指导新判断。';
      guidanceBanner.classList.toggle('is-insufficient', anyInsufficient);
    }
  }

  if (signalsEl) {
    signalsEl.innerHTML = SYMBOLS.map((symbol) => renderSymbolBlock(symbol, data.bySymbol?.[symbol])).join('');
  }

  if (dbMetaEl) {
    const db = data.db || {};
    const lock = data.lockSummary || {};
    dbMetaEl.innerHTML = [
      db.enabled
        ? `SQLite 已启用 · 方向判断 ${db.directionJudgments || 0} 条 · 窗口锁定 ${db.windowLocks || 0} 条`
        : `SQLite 未启用（${escapeHtml(db.reason || 'disabled')}）`,
      `旧台同源锁定胜率：5m n=${lock.fiveMinute?.total || 0} · 15m n=${lock.fifteenMinute?.total || 0}`,
      `回看 ${data.lookbackDays || 14} 日`,
      `展示 ${SYMBOLS.map((s) => s.replace('-USD', '')).join(' / ')}`
    ].join(' · ');
  }
}

function setLoading(loading, silent = false, message = '') {
  refreshBtn?.classList.toggle('is-loading', loading);
  if (loading) {
    if (!silent && loadingEl) loadingEl.textContent = '正在判断...';
    if (!silent && statusEl) statusEl.textContent = '刷新中…';
    return;
  }
  const text = message || `已更新 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  if (loadingEl) loadingEl.textContent = text;
  if (statusEl) statusEl.textContent = text;
}

function mergeWinrateState(prev, next) {
  if (!next) return prev;
  if (!prev) return next;
  return {
    ...prev,
    ...next,
    bySymbol: {
      ...(prev.bySymbol || {}),
      ...(next.bySymbol || {})
    },
    lockSummary: next.lockSummary || prev.lockSummary,
    db: next.db || prev.db
  };
}

async function refreshWinrate({ silent = false } = {}) {
  // 定时/倒计时刷新不能打断仍在完成的上一请求，否则慢请求会每 15 秒被永久重置。
  if (silent && refreshAbort) return;
  refreshAbort?.abort();
  const ac = new AbortController();
  refreshAbort = ac;
  const seq = ++refreshSeq;
  setLoading(true, silent);
  try {
    const lookbackDays = Number(lookbackEl?.value || 14);
    const primary = await getJson(
      `/api/crypto/winrate?symbols=${encodeURIComponent(SYMBOLS.join(','))}&lookbackDays=${lookbackDays}&mode=summary`,
      { signal: ac.signal }
    );
    if (seq !== refreshSeq || ac.signal.aborted) return;
    pageState = mergeWinrateState(pageState, primary);
    const schedule5m = pickSharedSchedule(primary, '5m');
    const schedule15m = pickSharedSchedule(primary, '15m');
    lastSlotIso5m = schedule5m?.currentSlotIso || lastSlotIso5m;
    lastSlotIso15m = schedule15m?.currentSlotIso || lastSlotIso15m;
    renderPage(pageState);
    saveCachedSnapshot(primary);
    setLoading(
      false,
      silent,
      primary.refreshing ? '已显示现有数据 · 后台同步中' : ''
    );
    if (primary.refreshing) {
      setTimeout(() => {
        if (document.visibilityState !== 'hidden') refreshWinrate({ silent: true });
      }, 1500);
    }
  } catch (error) {
    if (error?.name === 'AbortError' || ac.signal.aborted) return;
    setLoading(false, false, `判断失败: ${error.message}`);
    if (signalsEl && !pageState) {
      signalsEl.innerHTML = `<div class="signal">${escapeHtml(error.message)}</div>`;
    }
  } finally {
    if (refreshAbort === ac) refreshAbort = null;
  }
}

function anyFiveMinuteUnlocked() {
  return SYMBOLS.some((symbol) => {
    const bundle = pageState?.bySymbol?.[symbol]?.['5m'];
    return !Boolean(bundle?.locked || bundle?.signal?.lockedDecision?.direction);
  });
}

function tickCountdown() {
  updateCycleProgress();
  if (!pageState) return;
  const schedule15m = pickSharedSchedule(pageState, '15m');
  const schedule5m = pickSharedSchedule(pageState, '5m');
  fillSchedule(slot5mEl, next5mEl, countdown5mEl, schedule5m);
  fillSchedule(slot15mEl, next15mEl, countdown15mEl, schedule15m);

  const next5 = Date.parse(schedule5m?.nextSlotIso);
  const next15 = Date.parse(schedule15m?.nextSlotIso);
  const sec5 = Number.isFinite(next5) ? Math.max(0, Math.floor((next5 - Date.now()) / 1000)) : null;
  const sec15 = Number.isFinite(next15) ? Math.max(0, Math.floor((next15 - Date.now()) / 1000)) : null;
  const live5m = currentSlotSchedule(5);
  const liveSlotKey = String(live5m.startMs);
  const boundaryBurst = live5m.elapsedSeconds <= 12;
  const terminalBurst = live5m.elapsedSeconds >= 90 && live5m.elapsedSeconds <= 150;
  if (
    anyFiveMinuteUnlocked()
    && (boundaryBurst || terminalBurst || (Number.isFinite(sec5) && sec5 > 0 && sec5 <= 60))
    && Date.now() - lastDeadlineRefreshAt >= DEADLINE_POLL_MS
  ) {
    lastDeadlineRefreshAt = Date.now();
    if (boundaryBurst) lastBoundaryBurstSlot = liveSlotKey;
    refreshWinrate({ silent: true });
    return;
  }
  if (boundaryBurst && lastBoundaryBurstSlot !== liveSlotKey) {
    lastBoundaryBurstSlot = liveSlotKey;
    refreshWinrate({ silent: true });
  } else if (sec15 === 0 && lastSlotIso15m === schedule15m?.currentSlotIso) {
    refreshWinrate({ silent: true });
  }
}

refreshBtn?.addEventListener('click', () => refreshWinrate());
lookbackEl?.addEventListener('change', () => {
  // 回看变化会使缓存失效；清空 bySymbol 强制重拉四币
  if (pageState) pageState = { ...pageState, bySymbol: {} };
  refreshWinrate();
});

const cachedSnapshot = readCachedSnapshot();
if (cachedSnapshot) {
  pageState = cachedSnapshot;
  renderPage(pageState);
  setLoading(false, false, '已显示上次数据 · 后台同步中');
} else {
  updateCycleProgress();
}
refreshWinrate();
setInterval(tickCountdown, 1000);
setInterval(() => {
  if (document.visibilityState !== 'hidden') refreshWinrate({ silent: true });
}, POLL_MS);
