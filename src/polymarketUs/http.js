import { assertUsLineUrl } from '../polymarketVenue.js';

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function usRequest({
  baseUrl,
  method = 'GET',
  path,
  query,
  body,
  headers = {},
  timeoutMs = 12000,
  fetchImpl = globalThis.fetch,
  label = '美国盘客户端'
} = {}) {
  const url = new URL(path, `${String(baseUrl).replace(/\/$/, '')}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  assertUsLineUrl(url.toString(), label);
  const response = await fetchImpl(url.toString(), {
    method,
    headers: {
      Accept: 'application/json',
      ...(body != null ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  const data = text ? safeJson(text) : null;
  if (!response.ok) {
    const message = data && typeof data === 'object'
      ? (data.message || data.error || JSON.stringify(data))
      : (text || response.statusText);
    const error = new Error(`Polymarket US ${method} ${url.pathname} ${response.status}: ${message}`);
    error.status = response.status;
    error.payload = data;
    error.hostname = url.hostname;
    throw error;
  }
  return { data, url, headers: response.headers ?? null };
}
