import axios from 'axios';
import { AssetType, ClobClient } from '@polymarket/clob-client';
import { createPublicClient, createWalletClient, http, isAddress } from 'viem';
import { getBytecode } from 'viem/actions';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { humanizeClobError } from './polymarketLiveClob.js';

const PUSD_ADDRESS = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const DEPOSIT_WALLET_FACTORY = '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07';
const CONDITIONAL_TOKENS_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const CLOB_SPENDERS = [
  { key: 'ctfExchange', label: 'CTF Exchange', address: '0xE111180000d2663C0091e4f400237545B87B996B' },
  { key: 'negRiskExchange', label: 'Neg Risk Exchange', address: '0xe2222d279d744050d28e00520010520000310F59' },
  { key: 'negRiskAdapter', label: 'Neg Risk Adapter', address: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296' }
];
const CONDITIONAL_TOKEN_OPERATORS = [
  { key: 'exchangeV3', label: 'Exchange V3', address: '0xe3333700cA9d93003F00f0F71f8515005F6c00Aa' },
  { key: 'negRiskExchangeV2', label: 'Neg Risk Exchange V2', address: '0xe2222d279d744050d28e00520010520000310F59' },
  { key: 'ctfExchange', label: 'CTF Exchange', address: '0xE111180000d2663C0091e4f400237545B87B996B' }
];
const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' }
    ],
    outputs: [{ name: 'allowance', type: 'uint256' }]
  }
];
const ERC1155_ABI = [
  {
    type: 'function',
    name: 'isApprovedForAll',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'operator', type: 'address' }
    ],
    outputs: [{ name: 'approved', type: 'bool' }]
  }
];

export async function buildPolymarketReadiness(config) {
  const requestTimeoutMs = Math.max(1000, Number(config?.requestTimeoutMs) || 12000);
  // Both CLOB SDK generations use the shared axios default without supplying
  // their own timeout. Bound readiness so it can never occupy a plan lock forever.
  axios.defaults.timeout = requestTimeoutMs;
  const checks = [];
  const result = {
    generatedAtIso: new Date().toISOString(),
    configured: Boolean(config.configured),
    liveTradingEnabled: Boolean(config.liveTradingEnabled),
    signerAddress: null,
    funderAddress: config.funderAddress || null,
    profile: null,
    clob: null,
    conditionalTokenApprovals: null,
    checks
  };

  addCheck(checks, 'credentials', 'API 凭证', result.configured, result.configured ? '已配置' : '缺少 key/secret/passphrase/private key');

  if (!result.configured) {
    result.ready = false;
    return result;
  }

  let account;
  try {
    account = privateKeyToAccount(normalizePrivateKey(config.privateKey));
    result.signerAddress = account.address;
    addCheck(checks, 'signer', '签名钱包', true, account.address);
  } catch (error) {
    addCheck(checks, 'signer', '签名钱包', false, error.message);
    result.ready = false;
    return result;
  }

  if (config.funderAddress) {
    const sameAddress = account.address.toLowerCase() === config.funderAddress.toLowerCase();
    addCheck(
      checks,
      'funder',
      '资金/Profile 地址',
      true,
      sameAddress ? '与 signer 相同' : '与 signer 不同，按 proxy/Magic 钱包处理'
    );
  } else {
    addCheck(checks, 'funder', '资金/Profile 地址', false, '未配置 POLYMARKET_FUNDER_ADDRESS');
  }

  result.profile = await fetchProfile(config.funderAddress || account.address, config);
  addCheck(
    checks,
    'profile',
    'Polymarket Profile',
    Boolean(result.profile?.ok),
    result.profile?.ok ? `proxyWallet ${result.profile.proxyWallet || '--'}` : result.profile?.error || '读取失败'
  );

  const publicClient = createPublicClient({
    chain: polygon,
    transport: http(config.polygonRpcUrl || undefined, {
      timeout: requestTimeoutMs,
      retryCount: 0
    })
  });
  const isProxyWallet = Boolean(
    config.funderAddress
    && account.address.toLowerCase() !== config.funderAddress.toLowerCase()
  );
  result.conditionalTokenApprovals = await inspectConditionalTokenApprovals(
    publicClient,
    config.funderAddress || account.address
  );
  if (isProxyWallet && result.conditionalTokenApprovals) {
    result.conditionalTokenApprovals.isProxyWallet = true;
    result.conditionalTokenApprovals.proxyWalletNote =
      'Magic/proxy 钱包的链上 isApprovedForAll 常误报未授权；卖单以 CLOB balance/allowance 为准，不阻塞实盘。';
  }
  const onChainSellReady = Boolean(result.conditionalTokenApprovals?.ready);
  const sellApprovalOk = isProxyWallet ? true : onChainSellReady;
  const sellApprovalDetail = result.conditionalTokenApprovals?.ok
    ? `${result.conditionalTokenApprovals.detail}${isProxyWallet ? '（proxy：链上仅供参考）' : ''}`
    : result.conditionalTokenApprovals?.error || '读取失败';
  addCheck(
    checks,
    'conditionalTokenSellApproval',
    '条件 token 卖出授权',
    sellApprovalOk,
    sellApprovalDetail
  );

  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http()
  });
  const creds = {
    key: config.apiKey,
    secret: config.apiSecret,
    passphrase: config.apiPassphrase
  };
  const client = new ClobClient(
    config.clobBaseUrl,
    137,
    walletClient,
    creds,
    Number(config.signatureType || 0),
    config.funderAddress || undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true
  );

  result.clob = await fetchClobReadiness(client);
  addCheck(checks, 'clobAuth', 'CLOB API 认证', Boolean(result.clob.ok), result.clob.ok ? '可读取' : result.clob.error || '失败');
  addCheck(
    checks,
    'closedOnly',
    '账号交易限制',
    result.clob.closedOnly === false,
    result.clob.closedOnly === false ? '未限制' : result.clob.closedOnly === true ? 'closed-only' : '未知'
  );
  addCheck(
    checks,
    'balance',
    'CLOB 可用余额',
    Number(result.clob.collateral?.balanceUsdc) > 0,
    `$${format2(result.clob.collateral?.balanceUsdc || 0)}`
  );
  addCheck(
    checks,
    'allowance',
    'CLOB 授权额度',
    Number(result.clob.collateral?.allowanceUsdc) > 0,
    `$${format2(result.clob.collateral?.allowanceUsdc || 0)}`
  );

  result.ready = checks
    .filter((check) => ['credentials', 'signer', 'profile', 'clobAuth', 'closedOnly', 'balance', 'allowance', 'conditionalTokenSellApproval'].includes(check.key))
    .every((check) => check.ok);
  return result;
}

export async function buildDepositWalletStatus(config) {
  const checks = [];
  const result = {
    generatedAtIso: new Date().toISOString(),
    configured: Boolean(config.configured),
    signerAddress: null,
    currentFunderAddress: config.funderAddress || null,
    configuredDepositWalletAddress: config.depositWalletAddress || null,
    recommendedSignatureType: 3,
    currentSignatureType: Number(config.signatureType || 0),
    factoryAddress: DEPOSIT_WALLET_FACTORY,
    pusdAddress: PUSD_ADDRESS,
    relayerConfigured: Boolean(config.relayerUrl),
    builderCredentialsConfigured: Boolean(
      config.builderApiKey && (config.builderApiAddress || (config.builderApiSecret && config.builderApiPassphrase))
    ),
    builderCredentialMode: config.builderApiAddress
      ? 'relayer-api-key'
      : config.builderApiSecret && config.builderApiPassphrase
        ? 'builder-secret-passphrase'
        : 'missing',
    clob: null,
    sdk: getDepositWalletSdkStatus(),
    wallets: {},
    checks,
    nextSteps: []
  };

  if (!config.privateKey) {
    addCheck(checks, 'signer', 'Owner signer', false, 'POLYMARKET_PRIVATE_KEY 未配置');
    result.readyForDepositWallet = false;
    result.nextSteps = buildDepositWalletNextSteps(result);
    return result;
  }

  let account;
  try {
    account = privateKeyToAccount(normalizePrivateKey(config.privateKey));
    result.signerAddress = account.address;
    addCheck(checks, 'signer', 'Owner signer', true, account.address);
  } catch (error) {
    addCheck(checks, 'signer', 'Owner signer', false, error.message);
    result.readyForDepositWallet = false;
    result.nextSteps = buildDepositWalletNextSteps(result);
    return result;
  }

  const publicClient = createPublicClient({
    chain: polygon,
    transport: http(config.polygonRpcUrl || undefined)
  });

  addCheck(
    checks,
    'signatureType',
    '签名类型',
    result.currentSignatureType === 3,
    result.currentSignatureType === 3 ? '已设置 POLY_1271 / signatureType 3' : `当前是 ${result.currentSignatureType}，deposit wallet 应使用 3`
  );

  addCheck(
    checks,
    'relayer',
    'Relayer 配置',
    result.relayerConfigured && result.builderCredentialsConfigured,
    result.relayerConfigured && result.builderCredentialsConfigured
      ? `已配置 relayer + ${result.builderCredentialMode}`
      : '缺少 POLYMARKET_RELAYER_URL 或 Relayer API key/address'
  );

  addCheck(
    checks,
    'sdk',
    'Deposit wallet SDK',
    result.sdk.relayerClient && result.sdk.clobClientV2,
    result.sdk.relayerClient && result.sdk.clobClientV2
      ? '已安装 relayer client + clob-client-v2'
      : '缺少 @polymarket/builder-relayer-client 或 @polymarket/clob-client-v2'
  );

  const addresses = [
    { key: 'signer', label: 'Owner signer', address: account.address },
    { key: 'currentFunder', label: '当前 funder/profile', address: config.funderAddress },
    { key: 'depositWallet', label: 'Deposit wallet', address: config.depositWalletAddress }
  ].filter((item) => item.address && isAddress(item.address));

  const seen = new Set();
  const walletsByAddress = new Map();
  for (const item of addresses) {
    const addressKey = item.address.toLowerCase();
    if (seen.has(addressKey)) {
      result.wallets[item.key] = walletsByAddress.get(addressKey);
      continue;
    }
    seen.add(addressKey);
    result.wallets[item.key] = await inspectPusdWallet(publicClient, item.address, item.label);
    walletsByAddress.set(addressKey, result.wallets[item.key]);
  }

  if (config.depositWalletAddress && isAddress(config.depositWalletAddress)) {
    result.clob = await fetchDepositWalletClobStatus(config, account);
    const wallet = result.wallets.depositWallet;
    const clobBalance = Number(result.clob?.collateral?.balanceUsdc || 0);
    const clobAllowance = Number(result.clob?.collateral?.allowanceUsdc || 0);
    const sameFunder = config.funderAddress?.toLowerCase() === config.depositWalletAddress.toLowerCase();
    addCheck(checks, 'depositWalletAddress', 'Deposit wallet 地址', true, shortAddress(config.depositWalletAddress));
    addCheck(
      checks,
      'depositWalletDeployed',
      'Deposit wallet 已部署',
      Boolean(wallet?.deployed) || Boolean(result.clob?.ok),
      wallet?.deployed ? '链上有 bytecode' : result.clob?.ok ? 'CLOB 已能识别该 funder' : '链上还没有 bytecode，可能还未创建'
    );
    addCheck(
      checks,
      'depositWalletBalance',
      'Deposit wallet pUSD',
      Number(wallet?.pusdBalance || 0) > 0 || clobBalance > 0,
      `链上 $${format2(wallet?.pusdBalance || 0)} / CLOB $${format2(clobBalance)}`
    );
    addCheck(
      checks,
      'depositWalletAllowance',
      'Deposit wallet 授权',
      Number(wallet?.maxAllowance || 0) > 0 || clobAllowance > 0,
      `链上 $${format2(wallet?.maxAllowance || 0)} / CLOB $${format2(clobAllowance)}`
    );
    addCheck(
      checks,
      'funderMatchesDepositWallet',
      'Funder 指向 deposit wallet',
      sameFunder,
      sameFunder ? '已一致' : 'POLYMARKET_FUNDER_ADDRESS 还不是 deposit wallet'
    );
  } else {
    addCheck(checks, 'depositWalletAddress', 'Deposit wallet 地址', false, 'POLYMARKET_DEPOSIT_WALLET_ADDRESS 未配置');
  }

  result.readyForDepositWallet = checks
    .filter((check) =>
      [
        'signer',
        'signatureType',
        'depositWalletAddress',
        'depositWalletDeployed',
        'depositWalletBalance',
        'depositWalletAllowance',
        'funderMatchesDepositWallet'
      ].includes(check.key)
    )
    .every((check) => check.ok);
  result.nextSteps = buildDepositWalletNextSteps(result);
  return result;
}

async function fetchProfile(address, config) {
  if (!address) return { ok: false, error: 'missing address' };
  try {
    const response = await axios.get('https://polymarket.com/api/profile/userData', {
      params: { address },
      timeout: config.requestTimeoutMs || 12000
    });
    return {
      ok: true,
      id: response.data?.id || null,
      name: response.data?.name || null,
      pseudonym: response.data?.pseudonym || null,
      proxyWallet: response.data?.proxyWallet || null,
      takerTier: response.data?.takerTier ?? null,
      takerTierName: response.data?.takerTierName || null
    };
  } catch (error) {
    return { ok: false, error: error.response?.data?.error || error.message };
  }
}

async function fetchClobReadiness(client) {
  const result = {
    ok: false,
    closedOnly: null,
    collateral: null,
    openOrdersCount: null,
    error: null
  };
  try {
    await client.getOk();
    const [closedOnly, collateral, openOrders] = await Promise.all([
      client.getClosedOnlyMode().catch((error) => ({ error })),
      client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }),
      client.getOpenOrders({}, true).catch((error) => ({ error }))
    ]);
    result.ok = true;
    result.closedOnly = typeof closedOnly?.closed_only === 'boolean' ? closedOnly.closed_only : null;
    let normalized = normalizeCollateral(collateral);
    // CLOB 偶发返回 balance=0：尝试 sync 后再读一次，减少假零
    if (!(Number(normalized.balanceUsdc) > 0) && typeof client.updateBalanceAllowance === 'function') {
      try {
        await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        const refreshed = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        const refreshedNormalized = normalizeCollateral(refreshed);
        if (Number(refreshedNormalized.balanceUsdc) > 0) {
          normalized = refreshedNormalized;
          result.balanceResynced = true;
        }
      } catch {
        // keep first reading
      }
    }
    result.collateral = normalized;
    result.openOrdersCount = Array.isArray(openOrders)
      ? openOrders.length
      : Array.isArray(openOrders?.data)
        ? openOrders.data.length
        : null;
    if (openOrders?.error) result.openOrdersError = humanizeClobError(openOrders.error);
  } catch (error) {
    result.error = humanizeClobError(error.response?.data?.error || error);
  }
  return result;
}

async function inspectConditionalTokenApprovals(publicClient, owner) {
  const result = {
    ok: false,
    owner,
    conditionalTokens: CONDITIONAL_TOKENS_ADDRESS,
    operators: [],
    ready: false,
    detail: '',
    error: null
  };
  if (!owner || !isAddress(owner)) {
    result.error = 'owner/funder 地址无效';
    return result;
  }
  try {
    const operators = await Promise.all(
      CONDITIONAL_TOKEN_OPERATORS.map(async (operator) => {
        const approved = await publicClient
          .readContract({
            address: CONDITIONAL_TOKENS_ADDRESS,
            abi: ERC1155_ABI,
            functionName: 'isApprovedForAll',
            args: [owner, operator.address]
          })
          .catch(() => false);
        return { ...operator, approved: Boolean(approved) };
      })
    );
    const exchange = operators.find((item) => item.key === 'exchangeV3');
    const negRisk = operators.find((item) => item.key === 'negRiskExchangeV2');
    result.ok = true;
    result.operators = operators;
    result.ready = Boolean(exchange?.approved && negRisk?.approved);
    result.detail = operators
      .map((item) => `${item.label}: ${item.approved ? '已授权' : '未授权'}`)
      .join(' / ');
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

function normalizeCollateral(value = {}) {
  const balanceRaw = String(value.balance || '0');
  const allowanceRaw = value.allowance != null
    ? String(value.allowance)
    : maxStringInteger(Object.values(value.allowances || {}).map(String));
  return {
    raw: value,
    balanceUsdc: usdcFromRaw(balanceRaw),
    allowanceUsdc: usdcFromRaw(allowanceRaw)
  };
}

function maxStringInteger(values) {
  let max = 0n;
  for (const value of values) {
    try {
      const parsed = BigInt(value || '0');
      if (parsed > max) max = parsed;
    } catch {
      // Ignore malformed allowance values.
    }
  }
  return max.toString();
}

function usdcFromRaw(value) {
  try {
    return Number(BigInt(String(value || '0'))) / 1e6;
  } catch {
    return 0;
  }
}

function normalizePrivateKey(value) {
  const privateKey = value?.startsWith('0x') ? value : `0x${value || ''}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error('POLYMARKET_PRIVATE_KEY must be a 32-byte hex private key.');
  }
  return privateKey;
}

function addCheck(checks, key, label, ok, detail) {
  checks.push({ key, label, ok: Boolean(ok), detail: detail || '' });
}

function format2(value) {
  return Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

async function inspectPusdWallet(publicClient, address, label) {
  const checksumAddress = address;
  const [code, balance, allowances] = await Promise.all([
    getWalletCode(publicClient, checksumAddress),
    publicClient
      .readContract({
        address: PUSD_ADDRESS,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [checksumAddress]
      })
      .catch(() => 0n),
    Promise.all(
      CLOB_SPENDERS.map(async (spender) => {
        const raw = await publicClient
          .readContract({
            address: PUSD_ADDRESS,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [checksumAddress, spender.address]
          })
          .catch(() => 0n);
        return {
          ...spender,
          raw: raw.toString(),
          usdc: usdcFromRaw(raw.toString())
        };
      })
    )
  ]);
  return {
    label,
    address: checksumAddress,
    deployed: Boolean(code && code !== '0x'),
    pusdBalance: usdcFromRaw(balance.toString()),
    pusdBalanceRaw: balance.toString(),
    allowances,
    maxAllowance: Math.max(0, ...allowances.map((allowance) => Number(allowance.usdc || 0)))
  };
}

async function getWalletCode(publicClient, address) {
  try {
    const code = await getBytecode(publicClient, { address });
    if (code && code !== '0x') return code;
  } catch {
    // Fall back to client methods below.
  }
  try {
    const code = await publicClient.getBytecode?.({ address });
    if (code && code !== '0x') return code;
  } catch {
    // Try the next viem method name or return no code.
  }
  try {
    const code = await publicClient.getCode?.({ address });
    if (code && code !== '0x') return code;
  } catch {
    // Return no code.
  }
  return null;
}

function getDepositWalletSdkStatus() {
  return {
    relayerClient: Boolean(safeResolve('@polymarket/builder-relayer-client')),
    clobClientV2: Boolean(safeResolve('@polymarket/clob-client-v2')),
    signingSdk: Boolean(safeResolve('@polymarket/builder-signing-sdk'))
  };
}

function safeResolve(packageName) {
  try {
    return import.meta.resolve(packageName);
  } catch {
    return null;
  }
}

function buildDepositWalletNextSteps(result) {
  const steps = [];
  if (!result.sdk.relayerClient || !result.sdk.clobClientV2) {
    steps.push('安装官方 deposit wallet SDK：builder-relayer-client、builder-signing-sdk、clob-client-v2。');
  }
  if (!result.relayerConfigured || !result.builderCredentialsConfigured) {
    steps.push('配置 POLYMARKET_RELAYER_URL、POLYMARKET_BUILDER_API_KEY 和 POLYMARKET_BUILDER_API_ADDRESS，用来创建 wallet / 发授权 batch。');
  }
  if (!result.configuredDepositWalletAddress) {
    steps.push('用 relayer SDK 派生或创建 deposit wallet，然后写入 POLYMARKET_DEPOSIT_WALLET_ADDRESS。');
  }
  if (result.configuredDepositWalletAddress && result.currentFunderAddress?.toLowerCase() !== result.configuredDepositWalletAddress.toLowerCase()) {
    steps.push('把 POLYMARKET_FUNDER_ADDRESS 改成 deposit wallet 地址，并把 POLYMARKET_SIGNATURE_TYPE 改成 3。');
  }
  const depositWallet = result.wallets.depositWallet;
  const clobBalance = Number(result.clob?.collateral?.balanceUsdc || 0);
  const clobAllowance = Number(result.clob?.collateral?.allowanceUsdc || 0);
  if (depositWallet && Number(depositWallet.pusdBalance || 0) <= 0 && clobBalance <= 0) {
    steps.push('把 pUSD 充值或转入 deposit wallet。EOA 里的 pUSD 不算 CLOB buying power。');
  }
  if (depositWallet && Number(depositWallet.maxAllowance || 0) <= 0 && clobAllowance <= 0) {
    steps.push('通过 relayer WALLET batch 从 deposit wallet 发起 pUSD 授权，再同步 CLOB balance/allowance。');
  }
  if (steps.length === 0) {
    steps.push('Deposit wallet 基础条件已满足，可以继续做小额实盘下单前检查。');
  }
  return steps;
}

async function fetchDepositWalletClobStatus(config, account) {
  if (!config.configured || !config.depositWalletAddress) return null;
  try {
    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http()
    });
    const client = new ClobClient(
      config.clobBaseUrl,
      137,
      walletClient,
      {
        key: config.apiKey,
        secret: config.apiSecret,
        passphrase: config.apiPassphrase
      },
      Number(config.signatureType || 3),
      config.depositWalletAddress,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true
    );
    return await fetchClobReadiness(client);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function shortAddress(value) {
  if (!value) return '--';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}
