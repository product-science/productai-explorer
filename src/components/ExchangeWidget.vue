<script lang="ts" setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useBlockchain, useWalletStore, useBaseStore } from '@/stores';
import { Icon } from '@iconify/vue';
import { useBridgeUnwrap, checkBridgeEpochStatus, ensureEpochOnBridge } from '@/composables/useBridgeUnwrap';
import type { UnwrapParams, BridgeEpochStatus } from '@/composables/useBridgeUnwrap';
import { get, post } from '@/libs/http';
import { toBech32 } from '@cosmjs/encoding';
import { ethers } from 'ethers';

// Key derivation mismatch states
const isAddressMismatch = ref(false);
const derivedCosmosAddress = ref('');
const expectedEthAddress = ref('');
const activeEthAddress = ref('');


const props = defineProps<{
  chain: string;
}>();

const blockchain = useBlockchain();
const walletStore = useWalletStore();
const baseStore = useBaseStore();

// Bridge unwrap composable
const { progress: unwrapProgress, isRunning: isUnwrapRunning, executeUnwrap, resumeUnwrap, loadPending, clearPending, reset: resetUnwrap } = useBridgeUnwrap();

// Bridge epoch status
const epochStatus = ref<BridgeEpochStatus | null>(null);
const epochStatusLoading = ref(false);
const epochStatusError = ref<string>('');
const epochUpdateLoading = ref(false);
const epochUpdateMessage = ref<string>('');
const resolvedBridgeAddress = ref<string>('');

// State
const poolInfo = ref<any>(null);
const wrappedTokenBalances = ref<any[]>([]);
const loading = ref(false);
const calculating = ref(false);
const error = ref<string>('');
const txError = ref<string>('');
const calculationTimeout = ref<number | null>(null);
const approximateFee = ref<string>('~0.005 ETH');
const feeLoading = ref(false);

// Form data
const swapAmount = ref<string>('');
const estimatedOutput = ref<string>('');
const currentPrice = ref<string>('');
const priceImpact = ref<string>('');
const selectedWrappedToken = ref<string>('USDT');

export interface SupportedToken {
  chainId: string;
  contractAddress: string;
  symbol?: string;
  type?: 'ibc' | 'eth';
  sourceChannel?: string;
  sourceDenom?: string;
  decimals?: number;
}

// UI State
const activeTab = ref<'deposit' | 'withdraw' | 'purchase'>('deposit');
const supportedIbcTokens = ref<SupportedToken[]>([]);
const supportedEthTokens = ref<SupportedToken[]>([]);
const allDepositTokens = computed(() => {
  const list = [...supportedIbcTokens.value, ...supportedEthTokens.value];
  if (resolvedBridgeAddress.value && resolvedBridgeAddress.value.startsWith('0x')) {
    const hasWgnk = list.some(t => t.symbol === 'WGNK' || String(t.contractAddress).toLowerCase() === resolvedBridgeAddress.value.toLowerCase());
    if (!hasWgnk) {
      list.push({
        chainId: 'ethereum',
        contractAddress: resolvedBridgeAddress.value,
        symbol: 'WGNK',
        decimals: 9,
        type: 'eth',
      });
    }
  }
  return list;
});

// Selection State
const selectedDepositToken = ref<SupportedToken | null>(null);
const selectedWithdrawToken = ref<any>(null);

// Dropdown UI State
const isDepositDropdownOpen = ref(false);
const isPurchaseDropdownOpen = ref(false);
const isWithdrawDropdownOpen = ref(false);

const depositAmount = ref<string>('');
const depositTokenBalance = ref<string>('');
const depositBalanceLoading = ref(false);
const withdrawAmount = ref<string>('');
const withdrawDestinationAddress = ref<string>('');

// Pool availability - Purchase tab disabled when no pool
const isPoolAvailable = computed(() => {
  return !!(poolInfo.value && poolInfo.value.address && poolInfo.value.address.trim());
});

// Computed
const walletAddress = computed(() => walletStore.currentAddress);
const isConnected = computed(() => !!walletAddress.value);

const usdtBalance = computed(() => {
  const usdtToken = wrappedTokenBalances.value.find(
    token => token.symbol === 'USDT'
  );
  return usdtToken ? parseFloat(usdtToken.formatted_balance) : 0;
});

const canSwap = computed(() => {
  if (!isConnected.value) return false;
  if (!swapAmount.value || parseFloat(swapAmount.value) <= 0) return false;
  const selectedToken = wrappedTokenBalances.value.find(token => token.symbol === selectedWrappedToken.value);
  const selectedBalance = selectedToken ? parseFloat(selectedToken.formatted_balance) : 0;
  if (parseFloat(swapAmount.value) > selectedBalance) return false;
  return true;
});

// Withdraw tokens: user's wallet balances available for withdrawal
const withdrawableTokens = computed(() => {
  const list = [...wrappedTokenBalances.value];
  if (walletAddress.value) {
    const gnkBalance = walletStore.balanceOfStakingToken;
    const gnkAmt = parseFloat(gnkBalance.amount || '0') / 1_000_000_000;
    const hasGnk = list.some(t => t.symbol === 'GNK');
    if (!hasGnk) {
      list.unshift({
        symbol: 'GNK',
        full_denom: gnkBalance.denom,
        formatted_balance: gnkAmt.toString(),
        decimals: 9,
        isNative: false,
        isGnk: true,
        token_info: {
          chainId: 'ethereum',
          contractAddress: '', // mapped dynamically to bridge contract
        }
      });
    }
  }
  return list;
});

const depositExceedsBalance = computed(() => {
  if (!depositAmount.value || !depositTokenBalance.value) return false;
  return parseFloat(depositAmount.value) > parseFloat(depositTokenBalance.value);
});

const withdrawExceedsBalance = computed(() => {
  if (!withdrawAmount.value || !selectedWithdrawToken.value) return false;
  return parseFloat(withdrawAmount.value) > parseFloat(selectedWithdrawToken.value.formatted_balance);
});

// Methods
function cleanErrorMessage(err: any): string {
  if (!err) return '';
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('503') || msg.includes('Service Temporarily Unavailable')) {
    return 'Service temporarily unavailable. Please try again later.';
  }
  if (msg.includes('<html') || msg.includes('<!DOCTYPE html>')) {
    return 'Server error occurred. Please try again later.';
  }
  return msg;
}

async function loadAllData() {
  error.value = '';
  // Only load pool info in the background. Wallet-dependent data (balances, metadata)
  // is loaded by the walletAddress watcher to avoid duplicate requests.
  loadPoolInfo();
}

async function retryLoading() {
  error.value = '';
  const tasks: Promise<any>[] = [loadPoolInfo()];
  if (walletAddress.value) {
    tasks.push(loadWrappedTokenBalances());
    tasks.push(loadSupportedDepositTokens());
    tasks.push(fetchDepositTokenBalance());
  }
  await Promise.allSettled(tasks);
}

async function loadPoolInfo() {
  try {
    const info = await blockchain.getLiquidityPoolInfo();
    poolInfo.value = info;
  } catch (err) {
    console.warn('Liquidity pool not configured or active on-chain:', err);
    poolInfo.value = null;
  }
}

function closeDropdowns(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (!target.closest('.custom-dropdown')) {
    isDepositDropdownOpen.value = false;
    isPurchaseDropdownOpen.value = false;
    isWithdrawDropdownOpen.value = false;
  }
}

const pendingUnwrap = ref<any>(null);

function checkForPending() {
  pendingUnwrap.value = loadPending();
}

function handleClearPending() {
  clearPending();
  checkForPending();
}

function handleResetUnwrap() {
  resetUnwrap();
  checkForPending();
}

async function handleResumePending() {
  if (!pendingUnwrap.value) return;

  calculating.value = true;
  txError.value = '';

  try {
    const activeCosmosChain = baseStore.currentChainId || blockchain.current?.chainId || props.chain || '';
    const isTestnet = activeCosmosChain.includes('testnet');
    const ethereumChainIdHex = isTestnet ? '0xaa36a7' : '0x1';

    let rpcEndpoint = blockchain.endpoint?.address?.replace('/chain-api', '/chain-rpc') ||
      blockchain.endpoint?.address?.replace('/rest', '/rpc') ||
      blockchain.endpoint?.address?.replace(':1317', ':26657') ||
      'https://rpc.gonka.network';

    if (rpcEndpoint && !rpcEndpoint.endsWith('/')) {
      rpcEndpoint += '/';
    }

    let apiBase = '';
    if (blockchain.endpoint?.address?.includes('/chain-api')) {
      apiBase = blockchain.endpoint.address.replace('/chain-api', '/api') + '/v1';
    } else {
      apiBase = (blockchain.inferenceApiEndpoint || blockchain.endpoint?.address || '') + '/v1';
    }

    const config = {
      rpcEndpoint,
      apiBase,
      chainId: activeCosmosChain,
      ethereumChainIdHex,
    };

    await resumeUnwrap(config);
    checkForPending();
  } catch (err) {
    txError.value = err instanceof Error ? err.message : 'Resume failed';
  } finally {
    calculating.value = false;
  }
}

onMounted(() => {
  document.addEventListener('click', closeDropdowns);
  loadAllData();
  checkForPending();

  // Check for pending unwrap to resume
  if (pendingUnwrap.value) {
    activeTab.value = 'withdraw';
  }
});

onUnmounted(() => {
  document.removeEventListener('click', closeDropdowns);
});

// --- DEPOSIT TAB LOGIC ---

async function executeDeposit() {
  if (!selectedDepositToken.value || !depositAmount.value || parseFloat(depositAmount.value) <= 0) return;

  calculating.value = true;
  txError.value = '';

  try {
    if (selectedDepositToken.value.type === 'ibc') {
      await initiateIbcDeposit(selectedDepositToken.value, depositAmount.value);
    } else {
      await initiateEthDeposit(selectedDepositToken.value, depositAmount.value);
    }

    depositAmount.value = '';
    selectedDepositToken.value = null;
  } catch (err) {
    txError.value = err instanceof Error ? err.message : 'Deposit failed';
    console.error('Deposit Error:', err);
  } finally {
    calculating.value = false;
  }
}

async function resolveSourceChannel(targetChainId: string): Promise<string | null> {
  try {
    const endpoint = blockchain.endpoint?.address;
    if (!endpoint) return null;

    const channelsData = await get(`${endpoint}/ibc/core/channel/v1/channels`);
    const channels = channelsData?.channels || [];

    for (const channel of channels) {
      if (channel.state !== 'STATE_OPEN' || channel.port_id !== 'transfer') continue;

      const clientData = await get(`${endpoint}/ibc/core/channel/v1/channels/${channel.channel_id}/ports/transfer/client_state`);
      const clientChainId = clientData?.identified_client_state?.client_state?.chain_id || clientData?.client_state?.chain_id;

      if (clientChainId === targetChainId) {
        return channel.counterparty?.channel_id || null;
      }
    }
  } catch (error) {
    console.error('Failed to auto-resolve IBC source channel:', error);
  }
  return null;
}

// Also resolves the local (Gonka-side) channel for a target chain - needed for withdrawals
async function resolveLocalChannel(targetChainId: string): Promise<string | null> {
  try {
    const endpoint = blockchain.endpoint?.address;
    if (!endpoint) return null;

    const channelsData = await blockchain.rpc.getIBCChannels();
    const channels = channelsData?.channels || [];

    for (const channel of channels) {
      if (channel.state !== 'STATE_OPEN' || channel.port_id !== 'transfer') continue;

      const clientData = await get(`${endpoint}/ibc/core/channel/v1/channels/${channel.channel_id}/ports/transfer/client_state`);
      const clientChainId = clientData?.identified_client_state?.client_state?.chain_id || clientData?.client_state?.chain_id;

      if (clientChainId === targetChainId) {
        return channel.channel_id;
      }
    }
  } catch (error) {
    console.error('Failed to resolve local channel:', error);
  }
  return null;
}

async function initiateIbcDeposit(token: SupportedToken, amountInput: string) {
  const chainId = token.chainId;
  const contractHash = token.contractAddress;

  const sourcePort = 'transfer';
  let sourceChannel = token.sourceChannel || 'channel-0';
  let tokenDenom = contractHash;

  if (sourceChannel === 'channel-0' || !sourceChannel) {
    const resolvedChannel = await resolveSourceChannel(chainId);
    if (resolvedChannel) {
      sourceChannel = resolvedChannel;
    }
  }

  if (token.sourceDenom) {
    tokenDenom = token.sourceDenom;
  } else if (tokenDenom.startsWith('ibc/')) {
    try {
      const hash = tokenDenom.replace('ibc/', '');
      const traceData = await blockchain.rpc.getIBCAppTransferDenom(hash);
      if (traceData?.denom_trace?.base_denom) {
        tokenDenom = traceData.denom_trace.base_denom;
      }
    } catch (e) {
      console.warn('Could not resolve denom trace', e);
    }
  }

  const decimals = token.decimals || 6;
  const amountInBaseUnits = Math.floor(parseFloat(amountInput) * Math.pow(10, decimals)).toString();

  const receiver = walletAddress.value;

  await walletStore.executeIbcTransfer(chainId, sourcePort, sourceChannel, tokenDenom, amountInBaseUnits, receiver);
}

async function initiateEthDeposit(token: SupportedToken, amountInput: string) {
  const chainId = token.chainId;
  const contractHash = token.contractAddress;

  const bridgeResp = await blockchain.getBridgeAddresses(chainId);
  let bridgeContractAddress = bridgeResp?.bridge_address || bridgeResp?.address || bridgeResp?.bridge_contract || bridgeResp?.data?.bridge_address || bridgeResp?.approved_bridge_address;

  if (!bridgeContractAddress && bridgeResp?.addresses && Array.isArray(bridgeResp.addresses) && bridgeResp.addresses.length > 0) {
    const match = bridgeResp.addresses.find((a: any) => a.chainId === chainId || String(a.chainId).toLowerCase() === String(chainId).toLowerCase());
    bridgeContractAddress = match?.address || bridgeResp.addresses[0].address;
  }

  if (!bridgeContractAddress || !String(bridgeContractAddress).startsWith('0x')) {
    throw new Error(`Could not resolve valid bridge contract address from API for chain ${chainId}`);
  }

  const methodId = '0xa9059cbb';
  const rawAddress = String(bridgeContractAddress).replace(/^0x/i, '');
  const toPadding = rawAddress.padStart(64, '0');

  const decimals = token.decimals || 6;
  const amountInBaseUnits = Math.floor(parseFloat(amountInput) * Math.pow(10, decimals));
  const amountHex = amountInBaseUnits.toString(16).padStart(64, '0');

  const data = methodId + toPadding + amountHex;

  const connectedWalletType = walletStore.connectedWallet?.wallet;
  let ethProvider;

  if (connectedWalletType === 'keplr' && (window as any).keplr?.ethereum) {
    ethProvider = (window as any).keplr.ethereum;
  } else if (connectedWalletType === 'leap' && (window as any).leap?.ethereum) {
    ethProvider = (window as any).leap.ethereum;
  } else {
    ethProvider = (window as any).ethereum;
  }

  if (!ethProvider) throw new Error('No Ethereum provider (MetaMask/Keplr/Rabby) found in browser. Please install an EVM wallet to bridge tokens.');

  const chainIdFromBaseStore = baseStore.currentChainId;
  const chainIdFromLatestBlock = baseStore.latest?.block?.header?.chain_id;
  const chainIdFromBlockchain = blockchain.current?.chainId;

  let activeCosmosChain = chainIdFromBaseStore || chainIdFromLatestBlock || chainIdFromBlockchain;

  if (!activeCosmosChain) {
    if (!baseStore.latest?.block) {
      try {
        await baseStore.initial();
        activeCosmosChain = baseStore.currentChainId || baseStore.latest?.block?.header?.chain_id;
      } catch (e) {
        console.warn('Failed to fetch base store for chain ID', e);
      }
    }
  }

  activeCosmosChain = activeCosmosChain || props.chain || '';

  const isTestnet = activeCosmosChain.includes('testnet');
  const targetChainIdHex = isTestnet ? '0xaa36a7' : '0x1';

  try {
    await ethProvider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: targetChainIdHex }],
    });
  } catch (switchError: any) {
    if (switchError.code === 4902) {
      throw new Error(`Please add the ${isTestnet ? 'Sepolia' : 'Ethereum'} network to your EVM wallet first.`);
    }
    console.warn('Network switch failed or intercepted:', switchError);
  }

  const accounts = await ethProvider.request({ method: 'eth_requestAccounts' });
  const fromAddress = accounts[0];

  await ethProvider.request({
    method: 'eth_sendTransaction',
    params: [{ from: fromAddress, to: contractHash, data: data }],
  });
}

function parseBytes32OrString(hex: string): string {
  if (!hex || hex === '0x') return '';
  const clean = hex.replace(/^0x/i, '');
  if (clean.length < 64) return '';

  const offset = parseInt(clean.substring(0, 64), 16);
  if (offset === 32 && clean.length >= 128) {
    const length = parseInt(clean.substring(64, 128), 16);
    if (length > 0 && length <= 1000) {
      const dataHex = clean.substring(128, 128 + length * 2);
      let str = '';
      for (let i = 0; i < dataHex.length; i += 2) {
        const charCode = parseInt(dataHex.substring(i, i + 2), 16);
        if (charCode >= 32 && charCode <= 126) {
          str += String.fromCharCode(charCode);
        }
      }
      return str.trim();
    }
  }

  let str = '';
  for (let i = 0; i < clean.length; i += 2) {
    const charCode = parseInt(clean.substring(i, i + 2), 16);
    if (charCode === 0) continue;
    if (charCode >= 32 && charCode <= 126) {
      str += String.fromCharCode(charCode);
    }
  }
  return str.trim();
}

function cleanSymbolFromBaseDenom(denom: string): string {
  if (!denom) return '';
  const parts = denom.split('/');
  const base = parts[parts.length - 1];
  if (base.startsWith('u') && base.length > 1) {
    return base.substring(1).toUpperCase();
  }
  return base.toUpperCase();
}

function getOfflineMetadata(addressOrHash: string): { symbol: string, decimals: number } | null {
  const clean = String(addressOrHash).toLowerCase();
  
  // IBC Tokens
  if (clean.includes('115f68fba220a028c6f6ed08ea0c1a')) {
    return { symbol: 'USDT', decimals: 6 };
  }
  if (clean.includes('27394fb092d2e3d56123e74a88f7d4b')) {
    return { symbol: 'ATOM', decimals: 6 };
  }
  
  // EVM / ERC20 Tokens
  if (
    clean === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' || // Ethereum USDC
    clean === '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238'    // Sepolia USDC
  ) {
    return { symbol: 'USDC', decimals: 6 };
  }
  if (
    clean === '0xdac17f958d2ee523a2206206994597c13d831ec7' || // Ethereum USDT
    clean === '0xaa8e23fb1079ea71e0a56f48a2aa51851d8433d0'    // Sepolia USDT
  ) {
    return { symbol: 'USDT', decimals: 6 };
  }
  
  if (resolvedBridgeAddress.value && clean === resolvedBridgeAddress.value.toLowerCase()) {
    return { symbol: 'WGNK', decimals: 9 };
  }
  
  return null;
}

// Known mainnet ERC20 contracts — always query Ethereum mainnet for these
const KNOWN_MAINNET_CONTRACTS = new Set([
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
  '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
]);

// Multiple RPC fallbacks for resilience
const MAINNET_RPCS = [
  'https://eth-mainnet.g.alchemy.com/public',
  'https://ethereum.publicnode.com',
  'https://1rpc.io/eth',
  'https://rpc.flashbots.net',
  'https://gateway.tenderly.co/public/mainnet'
];
const SEPOLIA_RPCS = [
  'https://eth-sepolia.g.alchemy.com/public',
  'https://ethereum-sepolia.publicnode.com',
  'https://1rpc.io/sepolia',
  'https://gateway.tenderly.co/public/sepolia'
];

async function queryEvmRpc(to: string, data: string): Promise<string> {
  const contractLower = to.toLowerCase();

  // Determine which network to query:
  // If the contract is a known mainnet address, always use mainnet RPC
  // regardless of the Cosmos chain being a testnet.
  const isKnownMainnet = KNOWN_MAINNET_CONTRACTS.has(contractLower);
  const activeCosmosChain = baseStore.currentChainId || blockchain.current?.chainId || '';
  const cosmosIsTestnet = activeCosmosChain.includes('testnet');
  const useMainnet = isKnownMainnet || !cosmosIsTestnet;

  const rpcList = useMainnet ? MAINNET_RPCS : SEPOLIA_RPCS;
  console.log(`[queryEvmRpc] Contract: ${to} | Known mainnet: ${isKnownMainnet} | Cosmos testnet: ${cosmosIsTestnet} | Using: ${useMainnet ? 'MAINNET' : 'SEPOLIA'}`);

  for (const evmRpcUrl of rpcList) {
    try {
      const json = await post(evmRpcUrl, {
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{ to, data }, 'latest'],
        id: 1
      });
      console.log(`[queryEvmRpc] RPC ${evmRpcUrl} response:`, json);
      if (json.error) {
        console.warn(`[queryEvmRpc] RPC returned error:`, json.error);
        continue; // try next RPC
      }
      return json?.result || '0x';
    } catch (e) {
      console.warn(`[queryEvmRpc] RPC ${evmRpcUrl} failed:`, e);
    }
  }
  return '0x';
}

async function requestEvmRpc(method: string, params: any[]): Promise<any> {
  const activeCosmosChain = baseStore.currentChainId || blockchain.current?.chainId || '';
  const cosmosIsTestnet = activeCosmosChain.includes('testnet');
  const rpcList = cosmosIsTestnet ? SEPOLIA_RPCS : MAINNET_RPCS;

  for (const evmRpcUrl of rpcList) {
    try {
      const json = await post(evmRpcUrl, {
        jsonrpc: '2.0',
        method,
        params,
        id: 1
      });
      if (json && !json.error) {
        return json.result;
      }
    } catch (e) {
      console.warn(`[requestEvmRpc] RPC ${evmRpcUrl} failed for method ${method}:`, e);
    }
  }
  return null;
}

async function fetchApproximateFee() {
  if (!isConnected.value) {
    approximateFee.value = '';
    return;
  }

  const isDeposit = activeTab.value === 'deposit';
  const token = isDeposit ? selectedDepositToken.value : selectedWithdrawToken.value;

  if (!token) {
    approximateFee.value = '';
    return;
  }

  const isEth = isDeposit ? (token.type === 'eth') : (!token.isNative);
  if (!isEth) {
    approximateFee.value = '';
    return;
  }

  feeLoading.value = true;

  try {
    const gasPriceHex = await requestEvmRpc('eth_gasPrice', []);
    if (!gasPriceHex) {
      approximateFee.value = '~0.005 ETH';
      return;
    }
    const gasPrice = BigInt(gasPriceHex);

    let gasLimit = isDeposit ? 100_000n : 250_000n;

    try {
      let estimateHex: string | null = null;
      if (isDeposit) {
        const contractHash = token.contractAddress;
        const bridgeResp = await blockchain.getBridgeAddresses(token.chainId);
        let bridgeContractAddress = bridgeResp?.bridge_address || bridgeResp?.address || bridgeResp?.approved_bridge_address;
        if (!bridgeContractAddress && bridgeResp?.addresses?.length > 0) {
          bridgeContractAddress = bridgeResp.addresses[0].address;
        }

        if (bridgeContractAddress && contractHash) {
          const methodId = '0xa9059cbb';
          const toPadding = String(bridgeContractAddress).replace(/^0x/i, '').padStart(64, '0');
          const amountVal = parseFloat(depositAmount.value) || 1.0;
          const decimals = token.decimals || 6;
          const amountInBaseUnits = Math.floor(amountVal * Math.pow(10, decimals));
          const amountHex = amountInBaseUnits.toString(16).padStart(64, '0');
          const data = methodId + toPadding + amountHex;

          estimateHex = await requestEvmRpc('eth_estimateGas', [{
            to: contractHash,
            data: data
          }]);
        }
      }

      if (estimateHex) {
        gasLimit = BigInt(estimateHex);
      }
    } catch (estError) {
      console.warn('[Fee Estimation] estimateGas failed, using standard fallback limit:', estError);
    }

    const totalFeeWei = gasLimit * gasPrice;
    const divisor = 10n ** 14n;
    const feeInEthTenThousandths = totalFeeWei / divisor;
    const feeInEth = Number(feeInEthTenThousandths) / 10000;
    
    if (feeInEth < 0.0001) {
      const divisorSix = 10n ** 12n;
      const feeInEthMillionths = totalFeeWei / divisorSix;
      approximateFee.value = `~${(Number(feeInEthMillionths) / 1000000).toFixed(6)} ETH`;
    } else {
      approximateFee.value = `~${feeInEth.toFixed(4)} ETH`;
    }
  } catch (err) {
    console.warn('[Fee Estimation] Failed to calculate dynamic fee:', err);
    approximateFee.value = '~0.005 ETH';
  } finally {
    feeLoading.value = false;
  }
}

async function loadSupportedDepositTokens() {
  if (!blockchain.endpoint?.address) return;
  try {
    // Dynamically retrieve bridge address from API first
    try {
      const bridgeResp = await blockchain.getBridgeAddresses('ethereum');
      let bridgeAddress = bridgeResp?.bridge_address || bridgeResp?.address || bridgeResp?.approved_bridge_address;
      if (!bridgeAddress && bridgeResp?.addresses?.length > 0) {
        bridgeAddress = bridgeResp.addresses[0].address || bridgeResp.addresses[0];
      }
      resolvedBridgeAddress.value = bridgeAddress || '';
    } catch (e) {
      console.warn('Could not resolve bridge address dynamically on load:', e);
    }

    const approvedTokensResp = await blockchain.getApprovedTokensForTrade();
    const allTokens: SupportedToken[] = approvedTokensResp?.approved_tokens || [];

    const ibcTemp: SupportedToken[] = [];
    const ethTemp: SupportedToken[] = [];

    let wrappedTokensInfo: any[] = [];
    if (walletAddress.value) {
      try {
        const resp = await blockchain.getWrappedTokenBalances(walletAddress.value);
        wrappedTokensInfo = resp?.balances || [];
      } catch (e) { console.warn('Could not fetch wrapped balances for symbol resolution', e); }
    }

    let allIbcMetadata: any[] = [];
    try {
      const resp = await blockchain.rpc.getBankDenomMetadata();
      allIbcMetadata = resp?.metadatas || [];
    } catch (e) { console.warn('Could not fetch IBC metadata', e); }

    allTokens.forEach(t => {
      const contract = String(t.contractAddress);
      const contractLower = contract.toLowerCase();
      const chain = String(t.chainId).toLowerCase();

      let estimatedDecimals = 6;
      if (contractLower === 'inj' || contractLower === 'aevmos' || contractLower.includes('wei') || chain.includes('eth')) {
        estimatedDecimals = 18;
      }

      const tokenObj: SupportedToken = {
        chainId: String(t.chainId),
        contractAddress: contract,
        symbol: contractLower.startsWith('ibc/') ? 'IBC Token' : (contractLower.startsWith('0x') ? 'ERC20 Token' : 'Token'),
        sourceChannel: t.sourceChannel || (t as any).source_channel || (t as any).ibc_channel || 'channel-0',
        sourceDenom: t.sourceDenom || (t as any).source_denom || (t as any).base_denom || undefined,
        decimals: t.decimals || estimatedDecimals
      };

      // Check offline metadata mapping first
      const offline = getOfflineMetadata(contract);
      if (offline) {
        tokenObj.symbol = offline.symbol;
        tokenObj.decimals = offline.decimals;
      }

      if (contractLower.startsWith('ibc') || chain.includes('osmosis') || chain.includes('cosmoshub') || chain.includes('injective')) {
        if (!offline) {
          const match = allIbcMetadata.find(m => String(m.base).toLowerCase() === contractLower);
          if (match && match.symbol) {
            tokenObj.symbol = match.symbol;
          }
        }
        tokenObj.type = 'ibc';
        ibcTemp.push(tokenObj);
      } else if (contractLower.startsWith('0x') || chain.includes('eth') || chain.includes('sepolia')) {
        if (!offline) {
          const match = wrappedTokensInfo.find((w: any) => String(w?.token_info?.contractAddress).toLowerCase() === contractLower);
          if (match && match.symbol) {
            tokenObj.symbol = match.symbol;
          }
        }
        tokenObj.type = 'eth';
        ethTemp.push(tokenObj);
      } else {
        if (contract.length === 42) {
          tokenObj.type = 'eth';
          ethTemp.push(tokenObj);
        } else {
          tokenObj.type = 'ibc';
          ibcTemp.push(tokenObj);
        }
      }
    });

    // Dynamically retrieve real EVM ERC20 metadata via public RPC
    if (ethTemp.length > 0) {
      await Promise.all(ethTemp.map(async (token) => {
        // If already resolved offline, skip RPC queries
        const offline = getOfflineMetadata(token.contractAddress);
        if (offline) return;

        try {
          const symbolRes = await queryEvmRpc(token.contractAddress, '0x95d89b41');
          const parsedSymbol = parseBytes32OrString(symbolRes);
          if (parsedSymbol) {
            token.symbol = parsedSymbol;
          }

          const decimalsRes = await queryEvmRpc(token.contractAddress, '0x313ce567');
          if (decimalsRes && decimalsRes !== '0x') {
            const parsedDecimals = parseInt(decimalsRes, 16);
            if (!isNaN(parsedDecimals)) {
              token.decimals = parsedDecimals;
            }
          }
        } catch (e) {
          console.warn(`Could not dynamically fetch EVM metadata for ${token.contractAddress}:`, e);
        }
      }));
    }

    // Resolve IBC symbols using denom traces asynchronously
    await Promise.all(ibcTemp.map(async (token) => {
      // Check offline metadata mapping first
      const offline = getOfflineMetadata(token.contractAddress);
      if (offline) return;

      if (token.symbol === 'IBC Token' && token.contractAddress.startsWith('ibc/')) {
        try {
          const hash = token.contractAddress.replace('ibc/', '');
          const traceData = await blockchain.rpc.getIBCAppTransferDenom(hash);
          const baseDenom = traceData?.denom_trace?.base_denom;
          if (baseDenom) {
            token.sourceDenom = baseDenom;
            token.symbol = cleanSymbolFromBaseDenom(baseDenom);
          }
        } catch (e) {
          console.warn('Could not resolve IBC denom trace for symbol resolution:', e);
        }
      }
    }));

    supportedIbcTokens.value = ibcTemp;
    supportedEthTokens.value = ethTemp;
  } catch (err) {
    console.error('Failed to load supported deposit tokens for trade', err);
  }
}

// Fetch balance of the selected deposit token on its source chain
async function fetchDepositTokenBalance() {
  // Reset mismatch states
  isAddressMismatch.value = false;
  derivedCosmosAddress.value = '';
  expectedEthAddress.value = '';
  activeEthAddress.value = '';

  if (!selectedDepositToken.value || !isConnected.value || !blockchain.endpoint?.address) {
    depositTokenBalance.value = '';
    return;
  }

  depositBalanceLoading.value = true;
  depositTokenBalance.value = '';

  try {
    const token = selectedDepositToken.value;

    if (token.type === 'eth') {
      // For ETH tokens, get ERC-20 balance from user's Ethereum wallet
      const connectedWalletType = walletStore.connectedWallet?.wallet;
      console.log('[ERC20 Balance] Connected wallet type:', connectedWalletType);
      console.log('[ERC20 Balance] Token:', token.symbol, token.contractAddress);

      // Try to find an EVM provider - check multiple sources
      let ethProvider: any = null;
      let providerSource = 'none';

      // 1. Try wallet-specific ethereum provider
      if (connectedWalletType === 'keplr' && (window as any).keplr?.ethereum) {
        ethProvider = (window as any).keplr.ethereum;
        providerSource = 'keplr.ethereum';
      } else if (connectedWalletType === 'leap' && (window as any).leap?.ethereum) {
        ethProvider = (window as any).leap.ethereum;
        providerSource = 'leap.ethereum';
      }

      // 2. If wallet-specific provider not found, try standalone window.ethereum (MetaMask/Rabby)
      if (!ethProvider && (window as any).ethereum) {
        ethProvider = (window as any).ethereum;
        providerSource = 'window.ethereum';
      }

      console.log('[ERC20 Balance] Provider source:', providerSource, '| Available:', !!ethProvider);
      console.log('[ERC20 Balance] keplr exists:', !!(window as any).keplr);
      console.log('[ERC20 Balance] keplr.ethereum exists:', !!(window as any).keplr?.ethereum);
      console.log('[ERC20 Balance] window.ethereum exists:', !!(window as any).ethereum);

      if (ethProvider) {
        try {
          console.log('[ERC20 Balance] Requesting eth_requestAccounts from', providerSource, '...');
          const accounts = await ethProvider.request({ method: 'eth_requestAccounts' });
          console.log('[ERC20 Balance] Accounts returned:', accounts);

          if (!accounts || accounts.length === 0) {
            console.warn('[ERC20 Balance] No accounts returned from', providerSource);
            depositTokenBalance.value = '0.000000';
            return;
          }
          const from = accounts[0];
          console.log('[ERC20 Balance] Using ETH address:', from);
          activeEthAddress.value = from;

          const activeCosmosChain = baseStore.currentChainId || blockchain.current?.chainId || props.chain || '';
          const walletProvider = connectedWalletType === 'leap' ? (window as any).leap : (window as any).keplr;

          if (walletProvider && activeCosmosChain && token.type === 'eth') {
            try {
              const key = await walletProvider.getKey(activeCosmosChain);
              
              // Derive the REAL Ethereum address from the Cosmos public key
              // using keccak256 (standard Ethereum derivation).
              // NOTE: getKey().ethereumHexAddress is NOT the real ETH address —
              // it's just the Cosmos address bytes (sha256+ripemd160) in hex,
              // which differs from the keccak256-derived ETH address.
              const pubKeyBytes = key.pubKey;
              if (pubKeyBytes && pubKeyBytes.length > 0) {
                const pubKeyHex = '0x' + Array.from(pubKeyBytes as Uint8Array, (b) => (b as number).toString(16).padStart(2, '0')).join('');
                const derivedEthAddress = ethers.computeAddress(pubKeyHex);
                
                console.log('[Key Verification] Cosmos pubKey derived ETH address:', derivedEthAddress);
                console.log('[Key Verification] EVM Provider address (eth_requestAccounts):', from);
                console.log('[Key Verification] Match:', from.toLowerCase() === derivedEthAddress.toLowerCase());
                
                if (from.toLowerCase() !== derivedEthAddress.toLowerCase()) {
                  // Different keys: the EVM account's private key ≠ Cosmos account's private key.
                  // This means mnemonic derivation paths produced different keys per chain.
                  // Bridge-minted tokens would go to a Cosmos address the user doesn't control.
                  isAddressMismatch.value = true;
                  expectedEthAddress.value = derivedEthAddress;
                  
                  // Decode active EVM hex address and Bech32 encode with current prefix
                  const rawHex = from.startsWith('0x') ? from.substring(2) : from;
                  const hexBytes = new Uint8Array(
                    rawHex.match(/.{1,2}/g)?.map((byte: string) => parseInt(byte, 16)) || []
                  );
                  
                  const targetPrefix = blockchain.current?.bech32Prefix || 'gonka';
                  derivedCosmosAddress.value = toBech32(targetPrefix, hexBytes);
                } else {
                  // Same key: private-key account or matching mnemonic — bridge will work correctly
                  isAddressMismatch.value = false;
                }
              }
            } catch (keyErr) {
              console.warn('[Key Verification] Could not verify wallet key mismatch:', keyErr);
            }
          }

          // ERC-20 balanceOf(address) selector = 0x70a08231
          const paddedAddr = from.replace('0x', '').padStart(64, '0');
          const data = '0x70a08231' + paddedAddr;
          
          // Query the public RPC (not the user's wallet provider network)
          console.log('[ERC20 Balance] Querying balanceOf on contract:', token.contractAddress);
          const result = await queryEvmRpc(token.contractAddress, data);
          console.log('[ERC20 Balance] Raw RPC result:', result);

          if (!result || result === '0x' || result === '0x0') {
            console.log('[ERC20 Balance] Empty/zero result from RPC');
            depositTokenBalance.value = '0.000000';
            return;
          }

          const decimals = token.decimals || 6;
          const rawBalance = parseInt(result, 16);
          console.log('[ERC20 Balance] Parsed balance:', rawBalance, 'decimals:', decimals);
          if (isNaN(rawBalance)) {
            depositTokenBalance.value = '0.000000';
          } else {
            depositTokenBalance.value = (rawBalance / Math.pow(10, decimals)).toFixed(6);
          }
          console.log('[ERC20 Balance] Final display balance:', depositTokenBalance.value);
        } catch (e: any) {
          console.warn('[ERC20 Balance] Failed to query ERC-20 balance:', e?.message || e);
          console.warn('[ERC20 Balance] Error code:', e?.code, '| Provider:', providerSource);
          depositTokenBalance.value = '0.000000';
        }
      } else {
        console.warn('[ERC20 Balance] No Ethereum provider found at all! Cannot fetch ERC20 balance.');
        console.warn('[ERC20 Balance] User needs MetaMask, or Keplr/Leap with EVM support enabled.');
        depositTokenBalance.value = '0.000000';
      }
    } else {
      // For IBC tokens, get balance from source chain via Keplr
      const keplr = (window as any).keplr;
      if (keplr) {
        try {
          await keplr.enable(token.chainId);
          const offlineSigner = keplr.getOfflineSigner(token.chainId);
          const accounts = await offlineSigner.getAccounts();
          if (accounts.length > 0) {
            const sourceAddress = accounts[0].address;

            // Resolve the native base denom on the source chain.
            // token.contractAddress is the IBC hash on Gonka (e.g. ibc/115F68...),
            // but on the source chain it's the native denom (e.g. uusdt).
            let nativeDenom = token.sourceDenom || '';
            if (!nativeDenom && token.contractAddress.startsWith('ibc/')) {
              try {
                const hash = token.contractAddress.replace('ibc/', '');
                const traceData = await blockchain.rpc.getIBCAppTransferDenom(hash);
                if (traceData?.denom_trace?.base_denom) {
                  nativeDenom = traceData.denom_trace.base_denom;
                }
              } catch { /* fallback below */ }
            }
            if (!nativeDenom) nativeDenom = token.contractAddress;

            const chainName = token.chainId.replace(/-\d+$/, '').replace(/_\d+$/, '');
            const restUrl = `https://rest.cosmos.directory/${chainName}`;
            const balUrl = `${restUrl}/cosmos/bank/v1beta1/balances/${sourceAddress}/by_denom?denom=${encodeURIComponent(nativeDenom)}`;
            try {
              const data = await get(balUrl);
              const amount = data?.balance?.amount || '0';
              const decimals = token.decimals || 6;
              const rawAmount = parseInt(amount);
              if (isNaN(rawAmount)) {
                depositTokenBalance.value = '0.000000';
              } else {
                depositTokenBalance.value = (rawAmount / Math.pow(10, decimals)).toFixed(6);
              }
            } catch {
              depositTokenBalance.value = '0.000000';
            }
          }
        } catch (e) {
          console.warn('Could not fetch source chain balance:', e);
          depositTokenBalance.value = '0.000000';
        }
      }
    }
  } catch (err) {
    console.warn('Error fetching deposit token balance:', err);
    depositTokenBalance.value = '0.000000';
  } finally {
    depositBalanceLoading.value = false;
  }
}

// Auto-resolve destination address for withdraw based on selected token's target network
async function resolveWithdrawDestination() {
  if (!selectedWithdrawToken.value || !isConnected.value) return;

  const token = selectedWithdrawToken.value;

  try {
    if (token.isNative) {
      // IBC token - get user's address on the destination Cosmos chain
      const chainId = token.token_info?.chainId;
      if (!chainId) return;

      const keplr = (window as any).keplr;
      if (keplr) {
        await keplr.enable(chainId);
        const offlineSigner = keplr.getOfflineSigner(chainId);
        const accounts = await offlineSigner.getAccounts();
        if (accounts.length > 0) {
          withdrawDestinationAddress.value = accounts[0].address;
        }
      }
    } else {
      // ETH token - get user's Ethereum address
      const connectedWalletType = walletStore.connectedWallet?.wallet;
      let ethProvider;

      if (connectedWalletType === 'keplr' && (window as any).keplr?.ethereum) {
        ethProvider = (window as any).keplr.ethereum;
      } else if (connectedWalletType === 'leap' && (window as any).leap?.ethereum) {
        ethProvider = (window as any).leap.ethereum;
      } else {
        ethProvider = (window as any).ethereum;
      }

      if (ethProvider) {
        const accounts = await ethProvider.request({ method: 'eth_requestAccounts' });
        if (accounts.length > 0) {
          withdrawDestinationAddress.value = accounts[0];
        }
      }
    }
  } catch (err) {
    console.warn('Could not auto-resolve destination address:', err);
  }
}

// --- WITHDRAW TAB LOGIC ---

async function executeWithdraw() {
  if (!selectedWithdrawToken.value || !withdrawAmount.value || parseFloat(withdrawAmount.value) <= 0) return;

  calculating.value = true;
  txError.value = '';

  try {
    const token = selectedWithdrawToken.value;
    if (token.isNative) {
      await initiateIbcWithdraw(token);
    } else {
      await initiateEthWithdraw(token);
    }

    withdrawAmount.value = '';
    withdrawDestinationAddress.value = '';
    selectedWithdrawToken.value = null;

    // Refresh balances
    await loadWrappedTokenBalances();
    await walletStore.loadMyAsset();
  } catch (err) {
    txError.value = err instanceof Error ? err.message : 'Withdraw failed';
    console.error('Withdraw Error:', err);
  } finally {
    calculating.value = false;
  }
}

async function initiateIbcWithdraw(token: any) {
  const chainId = token.token_info?.chainId;
  if (!chainId) throw new Error('Cannot determine destination chain for this token');

  // For IBC withdraw FROM Gonka, we need the local channel (Gonka side)
  const localChannel = await resolveLocalChannel(chainId);
  if (!localChannel) throw new Error(`Could not resolve IBC channel to ${chainId}`);

  const denom = token.full_denom || token.token_info?.contractAddress;
  if (!denom) throw new Error('Cannot determine token denom for withdrawal');

  const decimals = token.decimals ?? 6;
  const amountInBaseUnits = Math.floor(parseFloat(withdrawAmount.value) * Math.pow(10, decimals)).toString();

  // Destination address: user-provided or auto-detect
  let receiver = withdrawDestinationAddress.value.trim();
  if (!receiver) {
    throw new Error('Please enter a destination address on the target chain');
  }

  // Gonka is the source chain for this IBC transfer
  const gonkaChainId = baseStore.currentChainId || blockchain.current?.chainId || props.chain;

  await walletStore.executeIbcTransfer(
    gonkaChainId,
    'transfer',
    localChannel,
    denom,
    amountInBaseUnits,
    receiver
  );
}

async function initiateEthWithdraw(token: any) {
  const chainId = token.token_info?.chainId;
  if (!chainId) throw new Error('Cannot determine destination chain for this token');

  let destinationEthAddress = withdrawDestinationAddress.value.trim();
  if (!destinationEthAddress || !destinationEthAddress.startsWith('0x')) {
    throw new Error('Please enter a valid Ethereum destination address (0x...)');
  }

  // Get bridge contract address
  const bridgeResp = await blockchain.getBridgeAddresses(chainId);
  let bridgeContractAddress = bridgeResp?.bridge_address || bridgeResp?.address || bridgeResp?.bridge_contract || bridgeResp?.data?.bridge_address || bridgeResp?.approved_bridge_address;

  if (!bridgeContractAddress && bridgeResp?.addresses && Array.isArray(bridgeResp.addresses) && bridgeResp.addresses.length > 0) {
    const match = bridgeResp.addresses.find((a: any) => a.chainId === chainId || String(a.chainId).toLowerCase() === String(chainId).toLowerCase());
    bridgeContractAddress = match?.address || bridgeResp.addresses[0].address;
  }

  if (!bridgeContractAddress || !String(bridgeContractAddress).startsWith('0x')) {
    throw new Error(`Could not resolve bridge contract address for chain ${chainId}`);
  }

  // CW20 contract address for the wrapped token on Gonka (or 'native' for GNK)
  const cw20Address = token.isGnk ? 'native' : (token.token_info?.wrappedContractAddress || token.token_info?.contractAddress);
  if (!cw20Address) throw new Error('Cannot determine wrapped token contract address');

  // Original ERC20 token contract on Ethereum (for GNK, the WGNK address is the bridge contract itself)
  const tokenContractOnEth = token.isGnk ? bridgeContractAddress : token.token_info?.contractAddress;

  const decimals = token.decimals ?? 6;
  const amountInBaseUnits = Math.floor(parseFloat(withdrawAmount.value) * Math.pow(10, decimals)).toString();

  // Determine network
  const activeCosmosChain = baseStore.currentChainId || blockchain.current?.chainId || props.chain || '';
  const isTestnet = activeCosmosChain.includes('testnet');
  const ethereumChainIdHex = isTestnet ? '0xaa36a7' : '0x1';

  let rpcEndpoint = blockchain.endpoint?.address?.replace('/chain-api', '/chain-rpc') ||
    blockchain.endpoint?.address?.replace('/rest', '/rpc') ||
    blockchain.endpoint?.address?.replace(':1317', ':26657') ||
    'https://rpc.gonka.network';

  if (rpcEndpoint && !rpcEndpoint.endsWith('/')) {
    rpcEndpoint += '/';
  }

  let apiBase = '';
  if (blockchain.endpoint?.address?.includes('/chain-api')) {
    apiBase = blockchain.endpoint.address.replace('/chain-api', '/api') + '/v1';
  } else {
    apiBase = (blockchain.inferenceApiEndpoint || blockchain.endpoint?.address || '') + '/v1';
  }

  const config = {
    rpcEndpoint,
    apiBase,
    chainId: activeCosmosChain,
    ethereumChainIdHex,
  };

  const params: UnwrapParams = {
    cw20Address,
    amount: amountInBaseUnits,
    destinationEthAddress,
    bridgeContractAddress,
    tokenContractOnEth,
    isGnk: token.isGnk,
  };

  await executeUnwrap(config, params);
}

// --- BRIDGE EPOCH LOGIC ---

async function loadBridgeEpochStatus() {
  const chainEpoch = blockchain.currentEpochIndex;
  if (!chainEpoch || !isConnected.value) {
    epochStatus.value = null;
    return;
  }

  epochStatusLoading.value = true;
  epochStatusError.value = '';

  try {
    const bridgeResp = await blockchain.getBridgeAddresses('ethereum');
    let bridgeAddress = bridgeResp?.bridge_address || bridgeResp?.address || bridgeResp?.approved_bridge_address;
    if (!bridgeAddress && bridgeResp?.addresses?.length > 0) {
      bridgeAddress = bridgeResp.addresses[0].address || bridgeResp.addresses[0];
    }
    resolvedBridgeAddress.value = bridgeAddress || '';

    if (!bridgeAddress || !String(bridgeAddress).startsWith('0x')) {
      epochStatusError.value = 'Bridge contract not configured';
      return;
    }

    const activeCosmosChain = baseStore.currentChainId || blockchain.current?.chainId || props.chain || '';
    const isTestnet = activeCosmosChain.includes('testnet');
    const ethereumChainIdHex = isTestnet ? '0xaa36a7' : '0x1';

    epochStatus.value = await checkBridgeEpochStatus(bridgeAddress, chainEpoch, ethereumChainIdHex);
  } catch (err) {
    epochStatusError.value = err instanceof Error ? err.message : 'Failed to check bridge epoch';
    console.error('Error checking bridge epoch:', err);
  } finally {
    epochStatusLoading.value = false;
  }
}

async function updateBridgeEpoch() {
  const chainEpoch = blockchain.currentEpochIndex;
  if (!chainEpoch) return;

  epochUpdateLoading.value = true;
  epochUpdateMessage.value = '';
  txError.value = '';

  try {
    const bridgeResp = await blockchain.getBridgeAddresses('ethereum');
    let bridgeAddress = bridgeResp?.bridge_address || bridgeResp?.address || bridgeResp?.approved_bridge_address;
    if (!bridgeAddress && bridgeResp?.addresses?.length > 0) {
      bridgeAddress = bridgeResp.addresses[0].address || bridgeResp.addresses[0];
    }

    if (!bridgeAddress || !String(bridgeAddress).startsWith('0x')) {
      throw new Error('Bridge contract not configured');
    }

    const activeCosmosChain = baseStore.currentChainId || blockchain.current?.chainId || props.chain || '';
    const isTestnet = activeCosmosChain.includes('testnet');
    const ethereumChainIdHex = isTestnet ? '0xaa36a7' : '0x1';

    let apiBase = '';
    if (blockchain.endpoint?.address?.includes('/chain-api')) {
      apiBase = blockchain.endpoint.address.replace('/chain-api', '/api') + '/v1';
    } else {
      apiBase = (blockchain.inferenceApiEndpoint || blockchain.endpoint?.address || '') + '/v1';
    }

    const result = await ensureEpochOnBridge(
      bridgeAddress,
      chainEpoch,
      apiBase,
      ethereumChainIdHex,
      (msg) => { epochUpdateMessage.value = msg; }
    );

    if (result.alreadyRegistered) {
      epochUpdateMessage.value = 'Bridge is already up to date!';
    } else {
      epochUpdateMessage.value = `Updated! Submitted ${result.epochsSubmitted} epoch(s).`;
    }

    // Refresh status
    await loadBridgeEpochStatus();
  } catch (err) {
    txError.value = err instanceof Error ? err.message : 'Failed to update bridge';
    console.error('Error updating bridge epoch:', err);
  } finally {
    epochUpdateLoading.value = false;
  }
}

// --- PURCHASE TAB LOGIC ---

async function loadWrappedTokenBalances() {
  if (!walletAddress.value || !blockchain.endpoint?.address) return;

  loading.value = true;
  error.value = '';

  try {
    const [approvedTokensResp, balancesResp] = await Promise.all([
      blockchain.getApprovedTokensForTrade(),
      blockchain.getWrappedTokenBalances(walletAddress.value)
    ]);

    const approvedSet = new Set<string>();
    const nativeIbcTokens: any[] = [];
    const ibcEntries: { denom: string; chainId: string }[] = [];

    (approvedTokensResp?.approved_tokens || []).forEach((t: any) => {
      const chainId = String(t.chainId).toLowerCase();
      const contractOrDenom = String(t.contractAddress);

      approvedSet.add(`${chainId}|${contractOrDenom.toLowerCase()}`);

      if (contractOrDenom.toLowerCase().startsWith('ibc/')) {
        const hash = contractOrDenom.substring(4).toUpperCase();
        const canonicalDenom = `ibc/${hash}`;
        ibcEntries.push({ denom: canonicalDenom, chainId: t.chainId });
      }
    });

    await Promise.all(ibcEntries.map(async (entry) => {
      const denom = entry.denom;
      let amount = '0';
      let meta: any = null;

      try {
        const balUrl = `${blockchain.endpoint.address}/cosmos/bank/v1beta1/balances/${walletAddress.value}/by_denom?denom=${encodeURIComponent(denom)}&_t=${Date.now()}`;
        const balResp = await get(balUrl);
        if (balResp?.balance?.amount) {
          amount = balResp.balance.amount;
        }
      } catch (e) {
        console.warn(`Could not fetch balance for ${denom}`, e);
      }

      try {
        const metaUrl = `${blockchain.endpoint.address}/cosmos/bank/v1beta1/denoms_metadata/${denom}?_t=${Date.now()}`;
        const metaResp = await get(metaUrl);
        if (metaResp?.metadata) {
          meta = metaResp.metadata;
        }
      } catch (e) {
        console.warn(`Could not fetch metadata for ${denom}`, e);
      }

      const displaySymbol = meta?.symbol || meta?.display || meta?.name || `IBC/${denom.substring(4, 10)}...`;
      const decimals = meta?.denom_units?.find((u: any) => u.denom === meta?.display)?.exponent ?? 6;

      nativeIbcTokens.push({
        symbol: displaySymbol,
        full_denom: denom,
        formatted_balance: (parseInt(amount) / Math.pow(10, decimals)).toString(),
        decimals: decimals,
        isNative: true,
        token_info: {
          chainId: entry.chainId,
          contractAddress: denom
        }
      });
    }));

    const allBalances = balancesResp?.balances || [];
    const filteredWrappedBalances = allBalances.filter((b: any) => {
      const info = b?.token_info || {};
      const key = `${String(info.chainId || '').toLowerCase()}|${String(info.contractAddress || '').toLowerCase()}`;
      return approvedSet.has(key);
    });

    wrappedTokenBalances.value = [...nativeIbcTokens, ...filteredWrappedBalances];

    if (!wrappedTokenBalances.value.find(token => token.symbol === selectedWrappedToken.value)) {
      selectedWrappedToken.value = wrappedTokenBalances.value.length > 0 ? wrappedTokenBalances.value[0].symbol : 'USDT';
    }
  } catch (err) {
    error.value = cleanErrorMessage(err);
    console.error('Error loading token balances:', err);
  } finally {
    loading.value = false;
  }
}

async function calculateSwap() {
  if (!poolInfo.value || !swapAmount.value || parseFloat(swapAmount.value) <= 0) {
    estimatedOutput.value = '';
    currentPrice.value = '';
    priceImpact.value = '';
    return;
  }

  const selectedToken = wrappedTokenBalances.value.find(t => t.symbol === selectedWrappedToken.value);
  const decimals = selectedToken?.decimals ?? 6;
  const amountInBaseUnits = Math.floor(parseFloat(swapAmount.value) * Math.pow(10, decimals)).toString();

  calculating.value = true;
  error.value = '';

  try {
    const result = await blockchain.calculateTokensFromWrappedToken(
      poolInfo.value.address,
      amountInBaseUnits
    );

    if (result.data) {
      const outputBaseUnits = result.data.tokens ?? result.data.gnk_tokens ?? '0';
      const outputAmount = parseFloat(outputBaseUnits) / 1_000_000_000;

      estimatedOutput.value = outputAmount.toString();
      currentPrice.value = result.data.current_price;

      const price = parseFloat(result.data.current_price);
      if (price > 0) {
        const expectedOutput = parseFloat(swapAmount.value) * price;
        const actualOutput = outputAmount;

        if (expectedOutput > 0) {
          const impact = ((expectedOutput - actualOutput) / expectedOutput) * 100;
          priceImpact.value = impact.toFixed(2);
        } else {
          priceImpact.value = '0.00';
        }
      }
    }
  } catch (err) {
    error.value = cleanErrorMessage(err);
    console.error('Error calculating swap:', err);
    estimatedOutput.value = '';
    currentPrice.value = '';
    priceImpact.value = '';
  } finally {
    calculating.value = false;
  }
}

function handleAmountChange() {
  if (calculationTimeout.value) {
    clearTimeout(calculationTimeout.value);
  }
  calculationTimeout.value = window.setTimeout(() => {
    calculateSwap();
  }, 500);
}

async function executeSwap() {
  if (!canSwap.value) return;

  try {
    const selectedToken = wrappedTokenBalances.value.find(token => token.symbol === selectedWrappedToken.value);
    if (!selectedToken) {
      txError.value = `${selectedWrappedToken.value} token not found in wallet`;
      return;
    }

    calculating.value = true;
    txError.value = '';

    if (selectedToken.isNative) {
      const ibcDenom = selectedToken.full_denom;
      const amountInBaseUnits = Math.floor(parseFloat(swapAmount.value) * Math.pow(10, selectedToken.decimals)).toString();

      await walletStore.executeNativeSwapDirect(
        ibcDenom,
        poolInfo.value.address,
        amountInBaseUnits
      );
    } else {
      const wrappedContractAddress = selectedToken?.token_info?.wrappedContractAddress;
      if (!wrappedContractAddress) {
        txError.value = 'No contract address available for selected token';
        calculating.value = false;
        return;
      }

      const amountInBaseUnits = Math.floor(parseFloat(swapAmount.value) * Math.pow(10, selectedToken.decimals)).toString();

      await walletStore.executeTokenSwapDirect(
        wrappedContractAddress,
        poolInfo.value.address,
        amountInBaseUnits
      );
    }

    txError.value = '';
    await loadWrappedTokenBalances();
    await walletStore.loadMyAsset();

    swapAmount.value = '';
    estimatedOutput.value = '';
    currentPrice.value = '';
    priceImpact.value = '';
  } catch (err) {
    txError.value = err instanceof Error ? err.message : 'Failed to execute swap';
    console.error('Error executing swap:', err);
  } finally {
    calculating.value = false;
  }
}

// Watchers
// Watch blockchain endpoint address to load public configurations on page load/mount
watch(() => blockchain.endpoint?.address, (newEndpoint) => {
  if (newEndpoint) {
    loadSupportedDepositTokens();
  }
}, { immediate: true });

// Watch walletAddress and blockchain endpoint to fetch user balances safely
watch([walletAddress, () => blockchain.endpoint?.address], ([newAddress, newEndpoint]) => {
  if (newAddress && newEndpoint) {
    walletStore.loadMyAsset(); // Fetch native Cosmos balance immediately on wallet connection!
    loadWrappedTokenBalances();
    fetchDepositTokenBalance();
    fetchApproximateFee();
    
    // Fallback in case public configurations were not loaded yet
    if (supportedIbcTokens.value.length === 0 && supportedEthTokens.value.length === 0) {
      loadSupportedDepositTokens();
    }
  } else {
    wrappedTokenBalances.value = [];
    depositTokenBalance.value = '';
  }
}, { immediate: true });

watch(activeTab, (tab) => {
  if (tab === 'withdraw' && isConnected.value) {
    loadBridgeEpochStatus();
  }
});

watch(selectedDepositToken, () => {
  fetchDepositTokenBalance();
});

watch(selectedWithdrawToken, (token) => {
  withdrawDestinationAddress.value = '';
  resolveWithdrawDestination();
  if (token && !token.isNative) {
    loadBridgeEpochStatus();
  }
});

watch([activeTab, selectedDepositToken, selectedWithdrawToken, depositAmount, withdrawAmount], () => {
  fetchApproximateFee();
});
</script>

<template>
  <div class="bg-base-100 rounded shadow">
    <div class="px-4 pt-4 pb-2 flex flex-col items-center">
      <div class="w-full flex items-center justify-between mb-4">
        <span class="text-lg font-semibold text-main">{{ $t('developer.exchange') }}</span>
      </div>

      <!-- Toggle Tabs -->
      <div class="w-full flex p-1 bg-gray-200 dark:bg-gray-800 rounded-lg">
        <button
          class="flex-1 py-2 text-sm font-semibold rounded-md transition-colors"
          :class="activeTab === 'deposit' ? 'bg-primary text-white shadow-sm' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'"
          @click="activeTab = 'deposit'"
        >
          {{ $t('developer.deposit_tab') }}
        </button>
        <button
          class="flex-1 py-2 text-sm font-semibold rounded-md transition-colors"
          :class="activeTab === 'withdraw' ? 'bg-primary text-white shadow-sm' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'"
          @click="activeTab = 'withdraw'"
        >
          {{ $t('developer.withdraw_tab') }}
        </button>
        <button
          class="flex-1 py-2 text-sm font-semibold rounded-md transition-colors relative"
          :class="[
            activeTab === 'purchase' ? 'bg-primary text-white shadow-sm' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200',
            !isPoolAvailable ? 'opacity-50 cursor-not-allowed' : ''
          ]"
          :disabled="!isPoolAvailable"
          :title="!isPoolAvailable ? $t('developer.pool_not_available') : ''"
          @click="isPoolAvailable ? (activeTab = 'purchase') : null"
        >
          {{ $t('developer.purchase_tab') }}
        </button>
      </div>
    </div>
    <div class="px-4 pb-4">
      <!-- Loading State -->
      <div v-if="loading" class="bg-gray-100 dark:bg-[#373f59] rounded-sm px-4 py-3 h-20 flex items-center justify-center">
        <div class="text-center">
          <div class="loading loading-spinner loading-md"></div>
          <div class="text-sm mt-2">{{ $t('developer.loading_pool_info') }}</div>
        </div>
      </div>



      <!-- ===== DEPOSIT TAB ===== -->
      <div v-if="!loading && activeTab === 'deposit'" class="space-y-4 mt-2">
        <div class="bg-gray-100 dark:bg-[#373f59] rounded-lg px-4 py-3" :class="{ 'pointer-events-none': allDepositTokens.length === 0 }">
          <div class="flex flex-col relative" :class="{ 'opacity-[0.4]': allDepositTokens.length === 0 }">
            <div v-if="allDepositTokens.length === 0" class="absolute inset-0 flex items-center justify-center z-10">
               <span class="bg-base-100 px-3 py-1 rounded text-sm font-semibold shadow-sm text-red-500 border border-red-200 dark:border-red-800">{{ $t('developer.no_approved_tokens') }}</span>
            </div>

            <div class="space-y-3">
              <div class="w-full">
                <div class="flex justify-between items-center mb-2">
                  <span class="text-sm font-semibold">{{ $t('developer.stable_coin') }}</span>
                  <span v-if="selectedDepositToken && depositTokenBalance" class="text-xs" :class="depositExceedsBalance ? 'text-red-500' : 'text-gray-600 dark:text-gray-400'">
                    Balance: {{ depositTokenBalance }} {{ selectedDepositToken.symbol }}
                  </span>
                  <span v-else-if="depositBalanceLoading" class="text-xs text-gray-400">
                    <Icon icon="mdi:loading" class="animate-spin inline-block" />
                  </span>
                </div>

                <div class="flex items-center space-x-2">
                  <div class="w-[60%]">
                    <input
                      v-model="depositAmount"
                      type="number"
                      min="0"
                      step="0.01"
                      :placeholder="$t('developer.enter_amount')"
                      class="input input-bordered input-sm w-full bg-base-100"
                      :class="{ 'input-error': depositExceedsBalance }"
                      :disabled="!isConnected"
                    />
                  </div>

                  <div class="w-[40%] relative custom-dropdown">
                    <div
                      class="input input-bordered input-sm bg-base-100 flex justify-between items-center w-full px-2"
                      :class="allDepositTokens.length > 0 ? 'cursor-pointer' : 'cursor-not-allowed bg-gray-50 dark:bg-gray-800 border-transparent'"
                      @click="allDepositTokens.length > 0 ? (isDepositDropdownOpen = !isDepositDropdownOpen) : null"
                    >
                      <div v-if="selectedDepositToken" class="truncate font-semibold flex items-center gap-1.5 text-main">
                        {{ selectedDepositToken.symbol }}
                        <span v-if="selectedDepositToken.type === 'ibc'" class="badge badge-xs badge-info badge-outline p-1.5">IBC</span>
                        <span v-else class="badge badge-xs border-gray-400 text-gray-500 badge-outline p-1.5 ml-1">Bridge</span>
                      </div>
                      <div v-else-if="allDepositTokens.length > 0" class="text-gray-400">{{ $t('developer.select') }}</div>
                      <div v-else class="text-transparent select-none">-</div>
                      <Icon icon="mdi:chevron-down" class="text-gray-400 shrink-0" :class="{ 'opacity-0': allDepositTokens.length === 0 }" />
                    </div>

                    <div v-if="isDepositDropdownOpen && allDepositTokens.length > 0" class="absolute right-0 z-20 w-64 mt-1 bg-base-100 border border-base-300 rounded-md shadow-lg max-h-48 overflow-auto">
                      <div
                        class="px-3 py-2 cursor-pointer hover:bg-base-200 text-sm"
                        @click="selectedDepositToken = null; isDepositDropdownOpen = false"
                      >
                        <span class="text-gray-400">{{ $t('developer.none') }}</span>
                      </div>
                      <div
                        v-for="(token, idx) in allDepositTokens" :key="idx"
                        class="px-3 py-2 border-t border-base-200 cursor-pointer hover:bg-base-200 flex flex-col"
                        @click="selectedDepositToken = token; isDepositDropdownOpen = false"
                      >
                         <div class="flex items-center gap-2">
                           <span class="text-sm font-semibold text-main">{{ token.symbol }}</span>
                           <span class="text-xs text-gray-500">({{ token.chainId }})</span>
                           <span v-if="token.type === 'ibc'" class="badge badge-xs badge-info badge-outline ml-auto bg-base-100 p-1.5">IBC</span>
                           <span v-else class="badge badge-xs border-gray-400 text-gray-500 badge-outline ml-auto bg-base-100 p-1.5">Bridge</span>
                         </div>
                         <span class="text-[10px] text-gray-400 truncate mt-1" :title="token.contractAddress">{{ token.contractAddress }}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Processing Time / Wallet Status / Server Error -->
        <div class="flex flex-col items-center justify-center mt-2 mb-2 text-center gap-1.5">
          <div v-if="error" class="text-xs transition-colors duration-300 h-4 flex items-center text-red-500 dark:text-red-400 font-semibold gap-1">
            <Icon icon="mdi:alert-circle-outline" class="inline-block" /> {{ error }}
          </div>
          <div v-else-if="!isConnected" class="text-xs transition-colors duration-300 h-4 flex items-center text-red-500 dark:text-red-400 font-semibold gap-1">
            <Icon icon="mdi:alert-circle-outline" class="inline-block" /> {{ $t('developer.please_connect_wallet_first') }}
          </div>
          <div v-else-if="isAddressMismatch && selectedDepositToken?.type === 'eth'" class="text-xs text-red-500 dark:text-red-400 font-semibold px-4 leading-relaxed flex items-center justify-center gap-1.5">
            <Icon icon="mdi:alert-circle-outline" class="inline-block shrink-0 animate-pulse text-red-500 dark:text-red-400 w-4 h-4" />
            <span>{{ $t('developer.mnemonic_mismatch_warning') }}</span>
          </div>
          <div v-else class="text-xs transition-colors duration-300 h-4 flex items-center" :class="selectedDepositToken?.type === 'ibc' ? 'text-green-500 dark:text-green-400' : (selectedDepositToken?.type === 'eth' ? 'text-gray-500' : 'opacity-0')">
            <template v-if="selectedDepositToken?.type === 'ibc'">
              <Icon icon="mdi:clock-outline" class="inline-block mr-0.5" /> {{ $t('developer.processing_time_ibc') }}
            </template>
            <template v-else-if="selectedDepositToken?.type === 'eth'">
              <Icon icon="mdi:clock-outline" class="inline-block mr-0.5" /> {{ $t('developer.processing_time_eth') }}
            </template>
            <template v-else>
              &nbsp;
            </template>
          </div>
        </div>

        <!-- Deposit Button -->
        <div class="pt-1">
          <button
            v-if="error"
            class="btn btn-error w-full btn-outline"
            @click="retryLoading"
          >
            <Icon icon="mdi:refresh" class="mr-2" />
            {{ $t('developer.retry') }}
          </button>
          <button
            v-else
            class="btn btn-primary w-full"
            :disabled="!selectedDepositToken || !depositAmount || parseFloat(depositAmount) <= 0 || depositExceedsBalance || calculating || isAddressMismatch"
            @click="executeDeposit"
          >
            <Icon v-if="calculating" icon="mdi:loading" class="animate-spin mr-2" />
            {{
               !selectedDepositToken ? $t('developer.select_token_to_deposit') :
               selectedDepositToken.type === 'ibc' ? $t('developer.deposit_via_ibc') : $t('developer.deposit_via_bridge')
            }}
          </button>
          <div v-if="txError && activeTab === 'deposit'" class="text-xs text-red-500 text-center mt-2 px-2 overflow-hidden text-ellipsis whitespace-nowrap" :title="txError">{{ txError }}</div>

          <!-- Approximate Fee Note under Deposit Button -->
          <div v-if="isConnected && selectedDepositToken?.type === 'eth' && approximateFee" class="text-xs text-gray-500 dark:text-gray-400 flex items-center justify-center gap-1 mt-2 text-center">
            <Icon :icon="feeLoading ? 'mdi:loading' : 'mdi:gas-station'" :class="{ 'animate-spin': feeLoading }" class="inline-block mr-0.5" />
            {{ $t('developer.approximate_fee') }} {{ approximateFee }}
          </div>
        </div>
      </div>

      <div v-else-if="!loading && activeTab === 'withdraw'" class="space-y-4 mt-2">
        <!-- Bridge status is now integrated between the input and action button below -->

        <!-- Unwrap in progress (ETH bridge) -->
        <div v-if="isUnwrapRunning || unwrapProgress.status === 'completed' || unwrapProgress.status === 'failed'" class="bg-gray-100 dark:bg-[#373f59] rounded-lg px-4 py-3">
          <div class="text-sm font-semibold mb-3">{{ $t('developer.withdraw_eth_progress') }}</div>

          <div class="space-y-2">
            <div class="flex items-center gap-2 text-xs">
              <Icon
                :icon="['connecting', 'signing_gonka'].includes(unwrapProgress.status) ? 'mdi:hourglass' : (unwrapProgress.status === 'failed' && !unwrapProgress.gonkaTxHash ? 'mdi:close-circle' : (['waiting_bls', 'signing_ethereum', 'completed'].includes(unwrapProgress.status) || unwrapProgress.gonkaTxHash ? 'mdi:check-circle' : 'mdi:circle-outline'))"
                :class="[
                  ['connecting', 'signing_gonka'].includes(unwrapProgress.status) ? 'animate-pulse text-primary' : '',
                  ['waiting_bls', 'signing_ethereum', 'completed'].includes(unwrapProgress.status) || unwrapProgress.gonkaTxHash ? 'text-green-500' : '',
                  unwrapProgress.status === 'failed' && !unwrapProgress.gonkaTxHash ? 'text-red-500' : ''
                ]"
              />
              <span>{{ $t('developer.withdraw_step_gonka') }}</span>
            </div>
            <div class="flex items-center gap-2 text-xs">
              <Icon
                :icon="unwrapProgress.status === 'waiting_bls' ? 'mdi:hourglass' : (['signing_ethereum', 'completed'].includes(unwrapProgress.status) ? 'mdi:check-circle' : (unwrapProgress.status === 'failed' && unwrapProgress.gonkaTxHash && (unwrapProgress.message.includes('signature') || unwrapProgress.message.includes('BLS')) ? 'mdi:close-circle' : 'mdi:circle-outline'))"
                :class="[
                  unwrapProgress.status === 'waiting_bls' ? 'animate-pulse text-primary' : '',
                  ['signing_ethereum', 'completed'].includes(unwrapProgress.status) ? 'text-green-500' : '',
                  unwrapProgress.status === 'failed' && unwrapProgress.gonkaTxHash && (unwrapProgress.message.includes('signature') || unwrapProgress.message.includes('BLS')) ? 'text-red-500' : 'text-gray-400'
                ]"
              />
              <span>{{ $t('developer.withdraw_step_bls') }}</span>
              <span v-if="unwrapProgress.elapsedSeconds && unwrapProgress.status === 'waiting_bls'" class="text-gray-400">({{ unwrapProgress.elapsedSeconds }}s)</span>
            </div>
            <div class="flex items-center gap-2 text-xs">
              <Icon
                :icon="unwrapProgress.status === 'signing_ethereum' ? 'mdi:hourglass' : (unwrapProgress.status === 'completed' ? 'mdi:check-circle' : (unwrapProgress.status === 'failed' && unwrapProgress.gonkaTxHash && !(unwrapProgress.message.includes('signature') || unwrapProgress.message.includes('BLS')) ? 'mdi:close-circle' : 'mdi:circle-outline'))"
                :class="[
                  unwrapProgress.status === 'signing_ethereum' ? 'animate-pulse text-primary' : '',
                  unwrapProgress.status === 'completed' ? 'text-green-500' : '',
                  unwrapProgress.status === 'failed' && unwrapProgress.gonkaTxHash && !(unwrapProgress.message.includes('signature') || unwrapProgress.message.includes('BLS')) ? 'text-red-500' : 'text-gray-400'
                ]"
              />
              <span>{{ $t('developer.withdraw_step_eth') }}</span>
            </div>
          </div>

          <!-- Status message -->
          <div class="mt-3 text-xs" :class="unwrapProgress.status === 'failed' ? 'text-red-500' : (unwrapProgress.status === 'completed' ? 'text-green-500' : 'text-gray-500')">
            {{ unwrapProgress.message }}
          </div>

          <!-- Tx hashes -->
          <div v-if="unwrapProgress.gonkaTxHash" class="mt-2 text-[10px] text-gray-400 truncate">
            {{ $t('developer.gonka_tx') }} {{ unwrapProgress.gonkaTxHash }}
          </div>
          <div v-if="unwrapProgress.ethTxHash" class="mt-1 text-[10px] text-gray-400 truncate">
            {{ $t('developer.eth_tx') }} {{ unwrapProgress.ethTxHash }}
          </div>

          <!-- Reset button after completion/failure -->
          <div v-if="unwrapProgress.status === 'completed' || unwrapProgress.status === 'failed'" class="mt-3">
            <button class="btn btn-sm btn-outline w-full" @click="handleResetUnwrap">
              {{ unwrapProgress.status === 'completed' ? $t('developer.done') : $t('developer.retry') }}
            </button>
          </div>
        </div>

        <!-- Normal withdraw form -->
        <template v-else>
          <!-- Resume Pending Card -->
          <div v-if="pendingUnwrap" class="bg-primary/10 border border-primary/20 rounded-lg p-4 mb-4 space-y-3">
            <div class="flex items-start gap-2.5">
              <Icon icon="mdi:clock-alert-outline" class="text-primary text-xl shrink-0 mt-0.5 animate-pulse" />
              <div class="flex-1 min-w-0">
                <div class="text-sm font-semibold text-main">{{ $t('developer.pending_tx_detected') }}</div>
                <p class="text-xs text-gray-500 mt-0.5">
                  {{ $t('developer.pending_tx_message') }}
                </p>
                <div class="text-[10px] text-gray-400 font-mono mt-1 bg-gray-50 dark:bg-gray-800/50 p-1.5 rounded truncate" :title="pendingUnwrap.gonkaTxHash">
                  {{ $t('developer.gonka_tx') }} {{ pendingUnwrap.gonkaTxHash }}
                </div>
              </div>
            </div>
            <div class="flex gap-2">
              <button class="btn btn-primary btn-xs flex-1" @click="handleResumePending" :disabled="calculating">
                <Icon v-if="calculating" icon="mdi:loading" class="animate-spin mr-1" />
                {{ $t('developer.resume_tx') }}
              </button>
              <button class="btn btn-outline btn-xs flex-1" @click="handleClearPending" :disabled="calculating">
                {{ $t('developer.discard') }}
              </button>
            </div>
          </div>

          <div class="bg-gray-100 dark:bg-[#373f59] rounded-lg px-4 py-3" :class="{ 'pointer-events-none': withdrawableTokens.length === 0 }">
            <div class="flex flex-col relative" :class="{ 'opacity-[0.4]': withdrawableTokens.length === 0 && isConnected }">
              <div v-if="withdrawableTokens.length === 0 && isConnected" class="absolute inset-0 flex items-center justify-center z-10">
                <span class="bg-base-100 px-3 py-1 rounded text-sm font-semibold shadow-sm text-gray-500 border border-gray-200 dark:border-gray-700">{{ $t('developer.no_tokens_to_withdraw') }}</span>
              </div>

              <div class="space-y-3">
                <!-- Token selector -->
                <div class="w-full">
                  <div class="flex justify-between items-center mb-2">
                    <span class="text-sm font-semibold">{{ $t('developer.token') }}</span>
                    <span v-if="selectedWithdrawToken" class="text-xs" :class="withdrawExceedsBalance ? 'text-red-500' : 'text-gray-600 dark:text-gray-400'">
                      Balance: {{ parseFloat(selectedWithdrawToken.formatted_balance).toFixed(6) }} {{ selectedWithdrawToken.symbol }}
                    </span>
                  </div>

                  <div class="flex items-center space-x-2">
                    <div class="w-[60%]">
                      <input
                        v-model="withdrawAmount"
                        type="number"
                        min="0"
                        step="0.01"
                        :placeholder="$t('developer.enter_amount')"
                        class="input input-bordered input-sm w-full bg-base-100"
                        :class="{ 'input-error': withdrawExceedsBalance }"
                        :disabled="!isConnected"
                      />
                    </div>

                    <div class="w-[40%] relative custom-dropdown">
                      <div
                        class="input input-bordered input-sm bg-base-100 flex justify-between items-center w-full px-2"
                        :class="withdrawableTokens.length > 0 ? 'cursor-pointer' : 'cursor-not-allowed bg-gray-50 dark:bg-gray-800 border-transparent'"
                        @click="withdrawableTokens.length > 0 ? (isWithdrawDropdownOpen = !isWithdrawDropdownOpen) : null"
                      >
                        <div v-if="selectedWithdrawToken" class="truncate font-semibold flex items-center gap-1.5 text-main">
                          {{ selectedWithdrawToken.symbol }}
                          <span v-if="selectedWithdrawToken.isNative" class="badge badge-xs badge-info badge-outline p-1.5">IBC</span>
                          <span v-else class="badge badge-xs border-gray-400 text-gray-500 badge-outline p-1.5 ml-1">Bridge</span>
                        </div>
                        <div v-else-if="withdrawableTokens.length > 0" class="text-gray-400">{{ $t('developer.select') }}</div>
                        <div v-else class="text-transparent select-none">-</div>
                        <Icon icon="mdi:chevron-down" class="text-gray-400 shrink-0" :class="{ 'opacity-0': withdrawableTokens.length === 0 }" />
                      </div>

                      <div v-if="isWithdrawDropdownOpen && withdrawableTokens.length > 0" class="absolute right-0 z-20 w-64 mt-1 bg-base-100 border border-base-300 rounded-md shadow-lg max-h-48 overflow-auto">
                        <div
                          class="px-3 py-2 cursor-pointer hover:bg-base-200 text-sm"
                          @click="selectedWithdrawToken = null; isWithdrawDropdownOpen = false"
                        >
                          <span class="text-gray-400">{{ $t('developer.none') }}</span>
                        </div>
                        <div
                          v-for="token in withdrawableTokens" :key="token.symbol"
                          class="px-3 py-2 border-t border-base-200 cursor-pointer hover:bg-base-200 flex flex-col"
                          @click="selectedWithdrawToken = token; isWithdrawDropdownOpen = false"
                        >
                          <div class="flex items-center gap-2">
                            <span class="text-sm font-semibold text-main">{{ token.symbol }}</span>
                            <span class="text-xs text-gray-500" v-if="token.token_info?.chainId">({{ token.token_info?.chainId }})</span>
                            <span v-if="token.isNative" class="badge badge-xs badge-info badge-outline ml-auto bg-base-100 p-1.5">IBC</span>
                            <span v-else class="badge badge-xs border-gray-400 text-gray-500 badge-outline ml-auto bg-base-100 p-1.5">Bridge</span>
                          </div>
                          <span class="text-[10px] text-gray-400 mt-1">
                            Balance: {{ parseFloat(token.formatted_balance).toFixed(6) }}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- Destination address -->
                <div class="w-full">
                  <div class="flex justify-between items-center mb-2">
                    <span class="text-sm font-semibold">{{ $t('developer.destination_address') }}</span>
                    <span v-if="selectedWithdrawToken && withdrawDestinationAddress" class="text-xs text-gray-600 dark:text-gray-400">
                      {{ $t('developer.auto_filled') }}
                    </span>
                  </div>
                  <input
                    v-model="withdrawDestinationAddress"
                    type="text"
                    :placeholder="!selectedWithdrawToken ? $t('developer.select_token_first') : (selectedWithdrawToken.isNative ? $t('developer.enter_cosmos_address') : $t('developer.enter_eth_address'))"
                    class="input input-bordered input-sm w-full bg-base-100"
                    :disabled="!isConnected || !selectedWithdrawToken"
                  />
                </div>
              </div>
            </div>
          </div>

          <!-- Withdraw type hint / Server Error -->
          <div class="flex flex-col items-center mt-2 mb-2 px-4 text-center">
            <div v-if="error" class="text-xs transition-colors duration-300 flex items-center text-red-500 dark:text-red-400 font-semibold gap-1">
              <Icon icon="mdi:alert-circle-outline" class="inline-block" /> {{ error }}
            </div>
            <div v-else-if="!isConnected" class="text-xs transition-colors duration-300 flex items-center text-red-500 dark:text-red-400 font-semibold gap-1">
              <Icon icon="mdi:alert-circle-outline" class="inline-block" /> {{ $t('developer.please_connect_wallet_first') }}
            </div>

            <!-- Bridge is in ADMIN MODE (Highest priority) -->
            <div v-else-if="selectedWithdrawToken && !selectedWithdrawToken.isNative && epochStatus && epochStatus.isAdminMode" class="text-xs text-red-500 space-y-1 mb-1 font-semibold">
              <div class="flex items-center justify-center gap-1">
                <Icon icon="mdi:lock-outline" class="text-red-500 shrink-0 animate-pulse" />
                {{ $t('developer.bridge_admin_mode') }}
              </div>
              <div class="text-[10px] opacity-80 font-normal">
                {{ $t('developer.bridge_admin_mode_message') }}
              </div>
            </div>
            
            <!-- Bridge status shown only for Ethereum bridge wrapped contracts when not synced -->
            <div v-else-if="selectedWithdrawToken && !selectedWithdrawToken.isNative && epochStatus && !epochStatus.isSynced" class="text-xs text-amber-600 dark:text-amber-400 space-y-1 mb-1">
              <div class="font-semibold flex items-center justify-center gap-1">
                <Icon icon="mdi:alert-outline" class="text-amber-500 shrink-0" />
                {{ $t('developer.bridge_epoch_behind') }}
              </div>
              <div>
                {{ $t('developer.bridge_epoch_info', { bridgeEpoch: epochStatus.bridgeEpoch, chainEpoch: epochStatus.chainEpoch, epochsBehind: epochStatus.epochsBehind }) }}
              </div>
              <div class="opacity-90">
                {{ $t('developer.bridge_epoch_warning') }}
              </div>
              <div v-if="epochUpdateMessage" class="font-semibold mt-1" :class="txError ? 'text-red-500' : 'text-green-600 dark:text-green-400'">
                {{ epochUpdateMessage }}
              </div>
            </div>

            <!-- Normal hints when synced or native -->
            <div v-else class="text-xs transition-colors duration-300 flex items-center" :class="selectedWithdrawToken?.isNative ? 'text-green-500 dark:text-green-400' : (selectedWithdrawToken && !selectedWithdrawToken.isNative ? 'text-gray-500' : 'opacity-0')">
              <template v-if="selectedWithdrawToken?.isNative">
                <Icon icon="mdi:clock-outline" class="inline-block mr-0.5 animate-pulse" /> {{ $t('developer.withdraw_time_ibc') }}
              </template>
              <template v-else-if="selectedWithdrawToken && !selectedWithdrawToken.isNative">
                <span v-if="epochStatus && epochStatus.isSynced" class="text-green-600 dark:text-green-400 flex items-center gap-1">
                  <Icon icon="mdi:check-circle" />
                  {{ $t('developer.bridge_epoch_synced') }} (Epoch {{ epochStatus.bridgeEpoch }})
                </span>
                <span v-else-if="epochStatusLoading" class="text-gray-400 flex items-center gap-1">
                  <Icon icon="mdi:loading" class="animate-spin" />
                  {{ $t('developer.checking_bridge_epoch') }}
                </span>
                <span v-else>
                  <Icon icon="mdi:clock-outline" class="inline-block mr-0.5" /> {{ $t('developer.withdraw_time_eth') }}
                </span>
              </template>
              <template v-else>
                &nbsp;
              </template>
            </div>
          </div>

          <!-- Withdraw Button -->
          <div class="pt-1">
            <button
              v-if="error"
              class="btn btn-error w-full btn-outline"
              @click="retryLoading"
            >
              <Icon icon="mdi:refresh" class="mr-2" />
              {{ $t('developer.retry') }}
            </button>

            <!-- Disallowed Withdraw when Bridge is in Admin Mode -->
            <button
              v-else-if="selectedWithdrawToken && !selectedWithdrawToken.isNative && epochStatus && epochStatus.isAdminMode"
              class="btn btn-error w-full text-white cursor-not-allowed opacity-60"
              disabled
            >
              <Icon icon="mdi:lock-outline" class="mr-2" />
              {{ $t('developer.bridge_in_admin_mode_btn') }}
            </button>

            <!-- Update Bridge button when Ethereum bridge contract is not synced -->
            <button
              v-else-if="selectedWithdrawToken && !selectedWithdrawToken.isNative && epochStatus && !epochStatus.isSynced"
              class="btn btn-primary w-full text-white"
              :disabled="epochUpdateLoading"
              @click="updateBridgeEpoch"
            >
              <Icon v-if="epochUpdateLoading" icon="mdi:loading" class="animate-spin mr-2" />
              {{ epochUpdateLoading ? $t('developer.updating_bridge') : $t('developer.update_bridge') }}
            </button>

            <!-- Normal Withdraw Button -->
            <button
              v-else
              class="btn btn-primary w-full"
              :disabled="!selectedWithdrawToken || !withdrawAmount || parseFloat(withdrawAmount) <= 0 || withdrawExceedsBalance || !withdrawDestinationAddress || calculating"
              @click="executeWithdraw"
            >
              <Icon v-if="calculating" icon="mdi:loading" class="animate-spin mr-2" />
              {{
                !selectedWithdrawToken ? $t('developer.select_token_to_withdraw') :
                selectedWithdrawToken.isNative ? $t('developer.withdraw_via_ibc') :
                selectedWithdrawToken.isGnk ? $t('developer.wrap_via_bridge') : $t('developer.withdraw_via_bridge')
              }}
            </button>
            <div v-if="txError && activeTab === 'withdraw'" class="text-xs text-red-500 text-center mt-2 px-2 overflow-hidden text-ellipsis whitespace-nowrap" :title="txError">{{ txError }}</div>

            <!-- Approximate Fee Note under Withdraw Button -->
            <div v-if="isConnected && selectedWithdrawToken && !selectedWithdrawToken.isNative && approximateFee" class="text-xs text-gray-500 dark:text-gray-400 flex items-center justify-center gap-1 mt-2 text-center">
              <Icon :icon="feeLoading ? 'mdi:loading' : 'mdi:gas-station'" :class="{ 'animate-spin': feeLoading }" class="inline-block mr-0.5" />
              {{ $t('developer.approximate_fee') }} {{ approximateFee }}
            </div>
          </div>
        </template>
      </div>

      <!-- ===== PURCHASE TAB ===== -->
      <div v-else-if="!loading && activeTab === 'purchase'" class="space-y-4 mt-2">
        <!-- Pool not available message -->
        <div v-if="!isPoolAvailable" class="bg-gray-100 dark:bg-[#373f59] rounded-sm px-4 py-6 flex items-center justify-center text-center">
          <div class="space-y-1">
            <div class="text-sm font-medium">{{ $t('developer.pool_not_available') }}</div>
            <div class="text-xs text-gray-600 dark:text-gray-400">{{ $t('developer.coming_soon') }}</div>
          </div>
        </div>

        <!-- Swap Interface -->
        <template v-else>
          <div class="space-y-3">
            <!-- From Token -->
            <div class="bg-gray-100 dark:bg-[#373f59] rounded-lg px-4 py-3">
              <div class="flex justify-between items-center mb-2">
                <span class="text-sm font-semibold">{{ $t('developer.stable_coin') }}</span>
                <span class="text-xs text-gray-600 dark:text-gray-400">
                  Balance: {{
                    (() => {
                      const token = wrappedTokenBalances.find(t => t.symbol === selectedWrappedToken);
                      return token ? parseFloat(token.formatted_balance).toFixed(6) : '0.000000'
                    })()
                  }} {{ selectedWrappedToken }}
                </span>
              </div>
              <div class="flex items-center space-x-2">
                <div class="w-[60%]">
                  <input
                    v-model="swapAmount"
                    @input="handleAmountChange"
                    type="number"
                    :placeholder="$t('developer.enter_amount')"
                    class="input input-bordered input-sm w-full"
                    :disabled="!isConnected"
                  />
                </div>

                <!-- Purchase Selector -->
                <div class="w-[40%] relative custom-dropdown">
                  <div
                    class="input input-bordered input-sm bg-base-100 flex justify-between items-center w-full px-2"
                    :class="wrappedTokenBalances.length > 0 ? 'cursor-pointer' : 'cursor-not-allowed bg-gray-50 dark:bg-gray-800 border-transparent'"
                    @click="wrappedTokenBalances.length > 0 ? (isPurchaseDropdownOpen = !isPurchaseDropdownOpen) : null"
                  >
                    <div v-if="selectedWrappedToken" class="truncate font-semibold flex items-center gap-1.5 text-main">
                      {{ selectedWrappedToken }}
                      <span v-if="(() => {
                          const token = wrappedTokenBalances.find(t => t.symbol === selectedWrappedToken);
                          return token?.isNative;
                        })()" class="badge badge-xs badge-info badge-outline p-1.5">IBC</span>
                      <span v-else-if="(() => {
                          const token = wrappedTokenBalances.find(t => t.symbol === selectedWrappedToken);
                          return token && !token.isNative;
                        })()" class="badge badge-xs border-gray-400 text-gray-500 badge-outline p-1.5 ml-1">Bridge</span>
                    </div>
                    <div v-else-if="wrappedTokenBalances.length > 0" class="text-gray-400">{{ $t('developer.select') }}</div>
                    <div v-else class="text-transparent select-none">-</div>
                    <Icon icon="mdi:chevron-down" class="text-gray-400 shrink-0" :class="{ 'opacity-0': wrappedTokenBalances.length === 0 }" />
                  </div>

                  <div v-if="isPurchaseDropdownOpen && wrappedTokenBalances.length > 0" class="absolute right-0 z-20 w-64 mt-1 bg-base-100 border border-base-300 rounded-md shadow-lg max-h-48 overflow-auto">
                    <div
                      v-for="token in wrappedTokenBalances" :key="token.symbol"
                      class="px-3 py-2 border-b border-base-200 cursor-pointer hover:bg-base-200 flex flex-col last:border-b-0"
                      @click="selectedWrappedToken = token.symbol; isPurchaseDropdownOpen = false; handleAmountChange()"
                    >
                       <div class="flex items-center gap-2">
                         <span class="text-sm font-semibold text-main">{{ token.symbol }}</span>
                         <span class="text-[10px] text-gray-500" v-if="token.token_info?.chainId">({{ token.token_info?.chainId }})</span>
                         <span v-if="token.isNative" class="badge badge-xs badge-info badge-outline ml-auto bg-base-100 p-1.5">IBC</span>
                         <span v-else class="badge badge-xs border-gray-400 text-gray-500 badge-outline ml-auto bg-base-100 p-1.5">Bridge</span>
                       </div>
                       <span class="text-[10px] text-gray-400 truncate mt-1" v-if="token.token_info?.contractAddress" :title="token.token_info?.contractAddress">{{ token.token_info?.contractAddress }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Swap Arrow -->
            <div class="flex justify-center">
              <Icon icon="mdi:arrow-down" class="text-2xl text-gray-400" />
            </div>

            <!-- To Token -->
            <div class="bg-gray-100 dark:bg-[#373f59] rounded-lg px-4 py-3">
              <div class="flex justify-between items-center mb-2">
                <span class="text-sm font-semibold">{{ $t('developer.token') }}</span>
              </div>
              <div class="flex items-center space-x-2">
                <div class="flex-1">
                  <input
                    :value="estimatedOutput"
                    type="text"
                    readonly
                    class="input input-bordered input-sm w-full bg-gray-50 dark:bg-gray-700"
                    :placeholder="calculating ? $t('developer.calculating') : '0'"
                  />
                </div>
                <div class="text-sm font-semibold text-secondary">{{ $t('developer.gnk') }}</div>
              </div>
            </div>

            <!-- Wallet Status / Server Error -->
            <div class="flex justify-center mt-2 mb-2">
              <div v-if="error" class="text-xs transition-colors duration-300 h-4 flex items-center text-red-500 dark:text-red-400 font-semibold gap-1">
                <Icon icon="mdi:alert-circle-outline" class="inline-block" /> {{ error }}
              </div>
              <div v-else-if="!isConnected" class="text-xs transition-colors duration-300 h-4 flex items-center text-red-500 dark:text-red-400 font-semibold gap-1">
                <Icon icon="mdi:alert-circle-outline" class="inline-block" /> {{ $t('developer.please_connect_wallet_first') }}
              </div>
            </div>

            <!-- Swap Button -->
            <div class="pt-3">
              <button
                v-if="error"
                class="btn btn-error w-full btn-outline"
                @click="retryLoading"
              >
                <Icon icon="mdi:refresh" class="mr-2" />
                {{ $t('developer.retry') }}
              </button>
              <button
                v-else
                @click="executeSwap"
                :disabled="!canSwap || calculating"
                class="btn btn-primary w-full"
                :class="{ 'btn-disabled': !canSwap || calculating }"
              >
                <Icon v-if="calculating" icon="mdi:loading" class="animate-spin mr-2" />
                <Icon v-else icon="mdi:swap-horizontal" class="mr-2" />
                {{
                  calculating
                    ? $t('developer.swap_processing')
                    : isConnected
                      ? $t('developer.swap')
                      : $t('developer.connect_wallet_to_swap')
                }}
              </button>
              <div v-if="txError && activeTab === 'purchase'" class="text-xs text-red-500 text-center mt-2 px-2 overflow-hidden text-ellipsis whitespace-nowrap" :title="txError">{{ txError }}</div>
            </div>

            <!-- Validation Messages -->
            <div v-if="swapAmount && (() => {
              const token = wrappedTokenBalances.find(t => t.symbol === selectedWrappedToken);
              return token ? parseFloat(swapAmount) > parseFloat(token.formatted_balance) : false;
            })()" class="text-red-500 text-sm text-center">
              {{ $t('developer.insufficient_balance') }}
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
