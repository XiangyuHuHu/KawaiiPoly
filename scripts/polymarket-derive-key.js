import 'dotenv/config';
import axios from 'axios';
import { ClobClient } from '@polymarket/clob-client';
import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const host = process.env.POLYMARKET_CLOB_BASE || 'https://clob.polymarket.com';
const chainId = 137;
const rawPrivateKey = process.env.POLYMARKET_PRIVATE_KEY;
const funderAddress = process.env.POLYMARKET_FUNDER_ADDRESS || '';

if (!rawPrivateKey) {
  console.error('Missing POLYMARKET_PRIVATE_KEY. Set it only in your local shell or local .env, never commit it.');
  process.exit(1);
}

const privateKey = rawPrivateKey.startsWith('0x') ? rawPrivateKey : `0x${rawPrivateKey}`;
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
  console.error('POLYMARKET_PRIVATE_KEY must be a 32-byte hex private key.');
  process.exit(1);
}

const account = privateKeyToAccount(privateKey);
console.log(`Signer wallet address: ${account.address}`);
if (funderAddress) {
  console.log(`Funder/profile address: ${funderAddress}`);
  if (account.address.toLowerCase() !== funderAddress.toLowerCase()) {
    console.log('Note: signer wallet and funder/profile address differ. This is only valid for proxy/Magic setups.');
  }
}

try {
  const okResponse = await axios.get(`${host}/ok`, { timeout: 15000 });
  console.log(`CLOB connectivity: ${okResponse.status} ${okResponse.data}`.trim());
} catch (error) {
  console.error(`CLOB connectivity check failed: ${error.code || error.message}`);
  console.error('If you use a local proxy, set HTTPS_PROXY and HTTP_PROXY before running this script.');
  process.exit(1);
}

const walletClient = createWalletClient({
  account,
  chain: polygon,
  transport: http()
});

const client = new ClobClient(
  host,
  chainId,
  walletClient,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  true
);

let creds;
try {
  creds = await client.createOrDeriveApiKey();
} catch (error) {
  console.error('createOrDeriveApiKey failed; trying deriveApiKey fallback...');
  console.error(error?.code || error?.message || error);
  try {
    creds = await client.deriveApiKey();
  } catch (fallbackError) {
    console.error('Failed to derive Polymarket CLOB API credentials.');
    console.error(fallbackError?.message || fallbackError);
    if (fallbackError?.data) console.error(JSON.stringify(fallbackError.data, null, 2));
    process.exit(1);
  }
}

const apiKey = creds?.key || creds?.apiKey;
const apiSecret = creds?.secret;
const apiPassphrase = creds?.passphrase;

if (!apiKey || !apiSecret || !apiPassphrase) {
  console.error('Polymarket did not return complete API credentials.');
  console.error('Response keys:', Object.keys(creds || {}).join(', ') || '(empty response)');
  if (creds?.error) console.error(`Error: ${creds.error}`);
  if (creds?.status) console.error(`Status: ${creds.status}`);
  process.exit(1);
}

console.log('Derived Polymarket CLOB API credentials. Store these in local .env or Docker env only.');
console.log('');
console.log(`POLYMARKET_API_KEY=${apiKey}`);
console.log(`POLYMARKET_API_SECRET=${apiSecret}`);
console.log(`POLYMARKET_API_PASSPHRASE=${apiPassphrase}`);
if (process.env.POLYMARKET_FUNDER_ADDRESS) {
  console.log(`POLYMARKET_FUNDER_ADDRESS=${process.env.POLYMARKET_FUNDER_ADDRESS}`);
}
if (process.env.POLYMARKET_SIGNATURE_TYPE) {
  console.log(`POLYMARKET_SIGNATURE_TYPE=${process.env.POLYMARKET_SIGNATURE_TYPE}`);
}
console.log('');
console.log('The private key was not printed.');
