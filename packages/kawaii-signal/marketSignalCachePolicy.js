/**
 * Policy for the shared polymarket market-signal cache.
 * Plan1 paper/UI may reuse short TTL snapshots; trading engines (Plan4/9)
 * should pass bypassCache so Plan1 traffic cannot starve their freshness.
 */
export function resolveMarketSignalCachePolicy(options = {}) {
  const bypassCache = options?.bypassCache === true || options?.preferFresh === true;
  const maxAgeMs = Number.isFinite(Number(options?.maxAgeMs))
    ? Math.max(0, Number(options.maxAgeMs))
    : 4_000;
  return { bypassCache, maxAgeMs };
}

export function shouldReuseCachedMarketSignal(entry, {
  nowMs = Date.now(),
  maxAgeMs = 4_000,
  bypassCache = false,
  slotMatches = true
} = {}) {
  if (bypassCache) return false;
  if (!entry?.payload || !slotMatches) return false;
  const at = Number(entry.at);
  if (!Number.isFinite(at)) return false;
  return nowMs - at < maxAgeMs;
}
