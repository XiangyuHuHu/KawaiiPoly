import 'dotenv/config';
import { RelayClient } from '@polymarket/builder-relayer-client';
import { createPublicClient, createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const deploy = process.argv.includes('--deploy');
const relayerUrl = process.env.POLYMARKET_RELAYER_URL || 'https://relayer.polymarket.com';
const privateKey = normalizePrivateKey(process.env.POLYMARKET_PRIVATE_KEY || '');
const relayerApiKey = process.env.POLYMARKET_BUILDER_API_KEY || '';
const relayerApiKeyAddress = process.env.POLYMARKET_BUILDER_API_ADDRESS || '';

if (!privateKey) {
  throw new Error('POLYMARKET_PRIVATE_KEY is required.');
}

const account = privateKeyToAccount(privateKey);
const walletClient = createWalletClient({
  account,
  chain: polygon,
  transport: http(process.env.POLYGON_RPC_URL || undefined)
});
const publicClient = createPublicClient({
  chain: polygon,
  transport: http(process.env.POLYGON_RPC_URL || undefined)
});
const client = new RelayClient(relayerUrl, 137, walletClient);

if (relayerApiKey && relayerApiKeyAddress) {
  client.sendAuthedRequest = async (method, path, body) =>
    client.send(path, method, {
      headers: {
        RELAYER_API_KEY: relayerApiKey,
        RELAYER_API_KEY_ADDRESS: relayerApiKeyAddress
      },
      data: body
    });
}

console.log(`Owner signer: ${account.address}`);
console.log(`Relayer URL: ${relayerUrl}`);
console.log(`Relayer API headers: ${relayerApiKey && relayerApiKeyAddress ? 'configured' : 'missing'}`);

const depositWalletAddress = await client.deriveDepositWalletAddress();
const code = await publicClient.getBytecode({ address: depositWalletAddress });
const deployed = Boolean(code && code !== '0x');

console.log(`Deposit wallet address: ${depositWalletAddress}`);
console.log(`Deposit wallet deployed: ${deployed ? 'yes' : 'no'}`);
console.log('');
console.log('Add these to .env after you decide to use this deposit wallet:');
console.log(`POLYMARKET_DEPOSIT_WALLET_ADDRESS=${depositWalletAddress}`);
console.log(`POLYMARKET_FUNDER_ADDRESS=${depositWalletAddress}`);
console.log('POLYMARKET_SIGNATURE_TYPE=3');

if (!deploy) {
  console.log('');
  console.log('Dry run only. Re-run with --deploy to submit WALLET-CREATE through the relayer.');
  process.exit(0);
}

if (!relayerApiKey || !relayerApiKeyAddress) {
  throw new Error('POLYMARKET_BUILDER_API_KEY and POLYMARKET_BUILDER_API_ADDRESS are required for --deploy.');
}

if (deployed) {
  console.log('Deposit wallet is already deployed. No create request was submitted.');
  process.exit(0);
}

console.log('Submitting deposit wallet deployment request...');
const response = await client.deployDepositWallet();
console.log(`Relayer transaction id: ${response.transactionID}`);
console.log(`Initial state: ${response.state}`);
const result = await response.wait();
if (!result) {
  console.log('Deployment did not reach a final success state before timeout.');
  process.exit(1);
}
console.log(`Final state: ${result.state}`);
console.log(`Transaction hash: ${result.transactionHash || '--'}`);

function normalizePrivateKey(value) {
  const privateKeyValue = value?.startsWith('0x') ? value : `0x${value || ''}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKeyValue)) return '';
  return privateKeyValue;
}
