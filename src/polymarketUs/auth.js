import nacl from 'tweetnacl';

function base64ToBytes(value) {
  const cleaned = String(value || '').trim().replace(/\s+/g, '');
  const bytes = Buffer.from(cleaned, 'base64');
  if (!bytes.length || bytes.toString('base64').replace(/=+$/g, '') !== cleaned.replace(/=+$/g, '')) {
    throw new Error('POLYMARKET_US_SECRET_KEY 不是合法 base64。');
  }
  return new Uint8Array(bytes);
}

function hexToBytes(hex) {
  const cleaned = hex.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]+$/.test(cleaned) || cleaned.length % 2 !== 0) {
    throw new Error('POLYMARKET_US_SECRET_KEY 不是合法 hex。');
  }
  return Uint8Array.from(Buffer.from(cleaned, 'hex'));
}

/**
 * 与 polymarket-us SDK 一致：secret 是 base64 的 32 字节 seed；
 * 若给了 64 字节扩展私钥，只用前 32 字节。
 */
export function decodeUsSecretKey(secretKey) {
  const raw = String(secretKey || '').trim();
  if (!raw) throw new Error('缺少 POLYMARKET_US_SECRET_KEY。');
  const bytes = raw.startsWith('0x') ? hexToBytes(raw) : base64ToBytes(raw);
  if (bytes.length !== 32 && bytes.length !== 64) {
    throw new Error('POLYMARKET_US_SECRET_KEY 必须是 32 字节 seed 或 64 字节 Ed25519 私钥。');
  }
  const seed = bytes.length === 64 ? bytes.slice(0, 32) : bytes;
  return nacl.sign.keyPair.fromSeed(seed);
}

export function signUsRequest({ secretKey, method, path, timestamp }) {
  const keyPair = secretKey?.secretKey ? secretKey : decodeUsSecretKey(secretKey);
  const message = `${timestamp}${String(method || 'GET').toUpperCase()}${path}`;
  const signature = nacl.sign.detached(new TextEncoder().encode(message), keyPair.secretKey);
  return Buffer.from(signature).toString('base64');
}

export function createUsAuthHeaders({
  accessKey,
  secretKey,
  method,
  path,
  timestamp = Date.now()
} = {}) {
  if (!accessKey) throw new Error('缺少 POLYMARKET_US_ACCESS_KEY。');
  const ts = String(timestamp);
  return {
    'X-PM-Access-Key': String(accessKey),
    'X-PM-Timestamp': ts,
    'X-PM-Signature': signUsRequest({ secretKey, method, path, timestamp: ts })
  };
}
