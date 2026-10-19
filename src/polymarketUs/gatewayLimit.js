/**
 * 同一进程里 gateway.polymarket.us 的共享队列。
 * 交易请求优先于观察请求。观察行情在第一次 429 / Cloudflare 1015 之后本轮不再打网。
 * 间隔由 configureGatewayLimiter 设定；测试默认交易间隔是 0。
 */

const state = {
  tradeGapMs: 0,
  observeGapMs: 1000,
  backoffMs: 8000,
  observePaused: false,
  nextAt: 0,
  draining: false,
  waiters: []
};

export function isRateLimitError(error) {
  if (!error) return false;
  if (error.code === 'RATE_LIMITED') return true;
  if (Number(error.status) === 429) return true;
  const payload = error.payload;
  const codes = [];
  if (payload && typeof payload === 'object') {
    if (payload.code != null) codes.push(String(payload.code));
    for (const item of payload.errors || []) {
      if (item?.code != null) codes.push(String(item.code));
    }
  }
  if (codes.includes('1015')) return true;
  return /1015|rate.?limit/i.test(String(error.message || ''));
}

export function configureGatewayLimiter({
  tradeGapMs,
  observeGapMs,
  backoffMs
} = {}) {
  if (tradeGapMs != null) state.tradeGapMs = Math.max(0, Number(tradeGapMs) || 0);
  if (observeGapMs != null) state.observeGapMs = Math.max(0, Number(observeGapMs) || 0);
  if (backoffMs != null) state.backoffMs = Math.max(0, Number(backoffMs) || 0);
}

export function gatewayBackoffMs() {
  return state.backoffMs;
}

export function isObservePaused() {
  return state.observePaused === true;
}

export function noteGatewayRateLimit() {
  state.observePaused = true;
}

export function resetGatewayLimiter() {
  state.tradeGapMs = 0;
  state.observeGapMs = 1000;
  state.backoffMs = 8000;
  state.observePaused = false;
  state.nextAt = 0;
  const pending = state.waiters;
  state.waiters = [];
  for (const job of pending) job.reject(new Error('limiter reset'));
}

function observePausedError() {
  const error = new Error('gateway observe paused after 429');
  error.status = 429;
  error.code = 'RATE_LIMITED';
  return error;
}

function insertJob(job) {
  const index = state.waiters.findIndex((row) => row.priority < job.priority);
  if (index === -1) state.waiters.push(job);
  else state.waiters.splice(index, 0, job);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drain() {
  if (state.draining) return;
  state.draining = true;
  try {
    while (state.waiters.length) {
      const job = state.waiters.shift();
      if (job.lane === 'observe' && state.observePaused) {
        job.reject(observePausedError());
        continue;
      }
      const wait = Math.max(0, state.nextAt - Date.now());
      if (wait > 0) await delay(wait);
      const gap = job.lane === 'observe' ? state.observeGapMs : state.tradeGapMs;
      state.nextAt = Date.now() + gap;
      try {
        job.resolve(await job.fn());
      } catch (error) {
        if (isRateLimitError(error)) noteGatewayRateLimit();
        job.reject(error);
      }
    }
  } finally {
    state.draining = false;
  }
  if (state.waiters.length) drain();
}

/**
 * @param {() => Promise<unknown>} fn
 * @param {{ lane?: 'trade' | 'observe' }} [options]
 * trade 优先。observe 在已经 429 之后直接失败，不再发请求。
 */
export function withGatewaySlot(fn, { lane = 'trade' } = {}) {
  if (lane === 'observe' && state.observePaused) return Promise.reject(observePausedError());
  return new Promise((resolve, reject) => {
    insertJob({
      fn,
      lane,
      priority: lane === 'observe' ? 0 : 1,
      resolve,
      reject
    });
    drain();
  });
}
