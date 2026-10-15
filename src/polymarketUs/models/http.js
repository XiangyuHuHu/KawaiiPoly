const USER_AGENT = 'kawaii-poly-us-models/1.0 (polymarket-us-scan)';

export async function fetchJson(url, {
  fetchImpl = globalThis.fetch,
  headers = {},
  timeoutMs = 12000
} = {}) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      ...headers
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response?.ok) {
    const error = new Error(`HTTP ${response?.status || 'failed'}`);
    error.status = response?.status;
    throw error;
  }
  return response.json();
}

export function safeError(error) {
  return String(error?.message || error || 'failed').slice(0, 160);
}
