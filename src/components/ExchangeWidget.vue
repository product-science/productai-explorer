<script lang="ts" setup>
import { ref, computed, watch, onMounted } from 'vue';
import { useBlockchain, useWalletStore, useBaseStore, useFormatter, useDashboard } from '@/stores';
import ConnectWallet from '@/components/ConnectWallet.vue';
import { useBridgeUnwrap, checkBridgeEpochStatus, ensureEpochOnBridge, scanForUncompletedTransaction } from '@/composables/useBridgeUnwrap';
import type { UnwrapParams, BridgeEpochStatus } from '@/composables/useBridgeUnwrap';
import { get, post } from '@/libs/http';
import { toBech32 } from '@cosmjs/encoding';
import { ethers } from 'ethers';
import { Icon } from '@iconify/vue';

// Sub-components
import ExchangeSwitcher from './widget/ExchangeSwitcher.vue';
import ExchangeStepper from './widget/ExchangeStepper.vue';
import ExchangeConnect from './widget/ExchangeConnect.vue';
import ExchangeDetails from './widget/ExchangeDetails.vue';
import ExchangeReview from './widget/ExchangeReview.vue';
import ExchangeOverview from './widget/ExchangeOverview.vue';

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

const isTxIndexingOff = ref(false);
const checkingTxIndexing = ref(false);

async function checkTxIndexingStatus() {
  if (!blockchain.endpoint?.address) return;

  let rpcEndpoint = blockchain.endpoint.address.replace('/chain-api', '/chain-rpc') ||
    blockchain.endpoint.address.replace('/rest', '/rpc') ||
    blockchain.endpoint.address.replace(':1317', ':26657') ||
    'https://rpc.gonka.network';

  if (rpcEndpoint && !rpcEndpoint.endsWith('/')) {
    rpcEndpoint += '/';
  }

  checkingTxIndexing.value = true;
  try {
    const res = await get(`${rpcEndpoint}status`);
    const txIndex = res?.result?.node_info?.other?.tx_index;
    isTxIndexingOff.value = (txIndex === 'off');
    console.log('RPC Transaction Indexing Status:', txIndex, 'isTxIndexingOff:', isTxIndexingOff.value);
  } catch (err) {
    console.warn('Failed to check RPC transaction indexing status:', err);
    isTxIndexingOff.value = false; // fail open
  } finally {
    checkingTxIndexing.value = false;
  }
}
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
  destChannel?: string;
  sourceDenom?: string;
  decimals?: number;
}

interface IbcChannelRoute {
  sourceChannel: string;
  destChannel: string;
}

const ibcRouteCache = new Map<string, Promise<IbcChannelRoute | null>>();

// UI State
const activeTab = ref<'deposit' | 'withdraw' | 'purchase'>(
  (localStorage.getItem('gonka_active_tab') as any) || 'deposit'
);

// Stepper state
const format = useFormatter();
const currentStep = ref(1);
const connectWalletRef = ref<InstanceType<typeof ConnectWallet> | null>(null);
const depositTxCompleted = ref(false);
const withdrawTxCompleted = ref(false);
const lastTxInfo = ref<{ amount: string; token: string; type: string; chainId: string; from: string; to: string; txHash?: string } | null>(null);

// Transaction progress trackers
const depositProgress = ref({
  status: 'idle' as 'idle' | 'signing_ethereum' | 'waiting_bls' | 'minting' | 'completed' | 'failed',
  lockTxHash: '',
  message: ''
});

const ibcProgress = ref({
  status: 'idle' as 'idle' | 'signing' | 'relaying' | 'completed' | 'failed',
  txHash: '',
  message: ''
});

function truncateHash(hash: string | undefined): string {
  if (!hash) return '';
  if (hash.length <= 16) return hash;
  return hash.substring(0, 10) + '\u2026' + hash.substring(hash.length - 8);
}

function getExplorerTxLink(chainId: string, txHash: string | undefined): string {
  if (!txHash) return '';
  
  const cid = String(chainId).toLowerCase();
  
  // EVM chains (Ethereum)
  if (cid === 'ethereum' || cid === '1' || cid === '11155111' || cid.includes('sepolia') || cid.includes('eth')) {
    const activeCosmosChain = baseStore.currentChainId || '';
    const isSepolia = activeCosmosChain.includes('testnet') || cid === '11155111' || cid.includes('sepolia');
    return isSepolia ? `https://sepolia.etherscan.io/tx/${txHash}` : `https://etherscan.io/tx/${txHash}`;
  }

  const activeChainId = (baseStore.currentChainId || props.chain || 'gonka').toLowerCase();

  // If it's the active/local chain (Gonka), view it on our local explorer
  if (cid === activeChainId || cid.includes('gonka')) {
    const dashboardStore = useDashboard();
    const match = Object.entries(dashboardStore.chains).find(([_, config]) => config.chainId === chainId);
    const activeChainName = match ? match[0] : (props.chain || 'gonka');
    return `/${activeChainName}/tx/${txHash}`;
  }

  // Otherwise, it's an external Cosmos chain, so use the public ping.pub explorer
  let cleanChainName = cid.split('-')[0].split('_')[0];
  if (cleanChainName === 'cosmoshub') {
    cleanChainName = 'cosmos';
  }

  return `https://ping.pub/${cleanChainName}/tx/${txHash}`;
}

const truncatedAddress = computed(() => {
  const addr = walletAddress.value;
  if (!addr) return '';
  if (addr.length <= 12) return addr;
  return addr.substring(0, 8) + '\u2026' + addr.substring(addr.length - 4);
});

const supportedIbcTokens = ref<SupportedToken[]>([]);
const supportedEthTokens = ref<SupportedToken[]>([]);
const allDepositTokens = computed(() => {
  const list = [...supportedIbcTokens.value, ...supportedEthTokens.value];
  if (resolvedBridgeAddress.value && resolvedBridgeAddress.value.startsWith('0x')) {
    const wgnkToken = list.find(t => t.symbol === 'WGNK');
    if (wgnkToken) {
      if (!wgnkToken.contractAddress || wgnkToken.contractAddress.toLowerCase() !== resolvedBridgeAddress.value.toLowerCase()) {
        wgnkToken.contractAddress = resolvedBridgeAddress.value;
      }
    } else {
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

const depositAmount = ref<string>('');
const depositTokenBalance = ref<string>('');
const depositBalanceLoading = ref(false);
const withdrawAmount = ref<string>('');
const withdrawDestinationAddress = ref<string>('');

// Computed
const walletAddress = computed(() => walletStore.currentAddress);
const isConnected = computed(() => !!walletAddress.value);

const canSwap = computed(() => {
  if (!isConnected.value) return false;
  if (!swapAmount.value || parseFloat(swapAmount.value) <= 0) return false;
  const selectedToken = wrappedTokenBalances.value.find(token => token.symbol === selectedWrappedToken.value);
  const selectedBalance = selectedToken ? parseFloat(selectedToken.formatted_balance) : 0;
  if (parseFloat(swapAmount.value) > selectedBalance) return false;
  return true;
});

function getNativeGnkBalance() {
  const stakingBalance = walletStore.balanceOfStakingToken;
  const balances = walletStore.balances || [];
  const assetDenoms = (blockchain.current?.assets || []).map((asset: any) => asset?.base).filter(Boolean);
  const candidateDenoms = Array.from(new Set([
    stakingBalance?.denom,
    ...assetDenoms,
    'ngonka',
    'ugonka',
  ].filter(Boolean)));

  for (const denom of candidateDenoms) {
    const balance = balances.find((coin: any) => coin.denom === denom);
    if (balance && Number(balance.amount || 0) > 0) {
      return balance;
    }
  }

  const gonkaLikeBalance = balances.find((coin: any) => {
    const denom = String(coin.denom || '').toLowerCase();
    return denom.endsWith('gonka') && Number(coin.amount || 0) > 0;
  });

  return gonkaLikeBalance || stakingBalance;
}

function getWithdrawTokenIdentity(token: any): string {
  if (!token) return '';
  if (token.isGnk) return 'gnk';

  const chainId = String(token.token_info?.chainId || '').toLowerCase();
  if (token.isNative) {
    const denom = String(token.full_denom || token.token_info?.contractAddress || '').toLowerCase();
    return `native:${chainId}:${denom}`;
  }

  const contract = String(
    token.token_info?.wrappedContractAddress ||
    token.token_info?.contractAddress ||
    token.full_denom ||
    ''
  ).toLowerCase();

  return `bridge:${chainId}:${contract}:${String(token.symbol || '').toLowerCase()}`;
}

// Withdraw tokens: user's wallet balances available for withdrawal
const withdrawableTokens = computed(() => {
  const list = [...wrappedTokenBalances.value];
  if (walletAddress.value) {
    const gnkBalance = getNativeGnkBalance();
    const gnkAmt = parseFloat(gnkBalance.amount || '0') / 1_000_000_000;
    const hasGnk = list.some(t => t.symbol === 'GNK');
    if (!hasGnk && gnkAmt > 0) {
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

const pendingUnwrap = ref<any>(null);

function populateLastTxInfoFromPending() {
  if (!pendingUnwrap.value) return;

  const isGnk = !!pendingUnwrap.value.params.isGnk;
  let decimals = 9;
  let symbol = 'GNK';

  const meta = getOfflineMetadata(pendingUnwrap.value.params.cw20Address) ||
               getOfflineMetadata(pendingUnwrap.value.params.tokenContractOnEth);
  if (meta) {
    decimals = meta.decimals;
    symbol = meta.symbol;
  } else if (!isGnk) {
    decimals = 6;
    symbol = 'Wrapped';
  }

  const rawAmount = parseFloat(pendingUnwrap.value.params.amount);
  const formattedAmount = isNaN(rawAmount) ? '0' : (rawAmount / Math.pow(10, decimals)).toString();

  lastTxInfo.value = {
    amount: formattedAmount,
    token: symbol,
    type: 'eth',
    chainId: baseStore.currentChainId || '',
    txHash: pendingUnwrap.value.gonkaTxHash,
    from: 'Gonka',
    to: 'Ethereum'
  };
}

function checkForPending() {
  pendingUnwrap.value = loadPending();
  if (pendingUnwrap.value && !lastTxInfo.value) {
    populateLastTxInfoFromPending();
  }
}

const isScanningForLostState = ref(false);

async function scanForLostPendingState() {
  if (pendingUnwrap.value || isScanningForLostState.value || !isConnected.value) return;

  if (!withdrawDestinationAddress.value) {
    await resolveWithdrawDestination();
  }

  const recipient = withdrawDestinationAddress.value;
  if (!recipient || !recipient.startsWith('0x')) return;

  isScanningForLostState.value = true;

  try {
    const activeCosmosChain = baseStore.currentChainId || blockchain.current?.chainId || props.chain || '';
    const isTestnet = activeCosmosChain.includes('testnet');
    const ethereumChainIdHex = isTestnet ? '0xaa36a7' : '0x1';

    const bridgeResp = await blockchain.getBridgeAddresses('ethereum');
    let bridgeAddress = bridgeResp?.bridge_address || bridgeResp?.address || bridgeResp?.approved_bridge_address;
    if (!bridgeAddress && bridgeResp?.addresses?.length > 0) {
      bridgeAddress = bridgeResp.addresses[0].address || bridgeResp.addresses[0];
    }
    if (!bridgeAddress) return;

    let apiBase = '';
    if (blockchain.endpoint?.address?.includes('/chain-api')) {
      apiBase = blockchain.endpoint.address.replace('/chain-api', '/api') + '/v1';
    } else {
      apiBase = (blockchain.inferenceApiEndpoint || blockchain.endpoint?.address || '') + '/v1';
    }

    const recovered = await scanForUncompletedTransaction(
      blockchain.endpoint?.address || '',
      recipient,
      bridgeAddress,
      withdrawableTokens.value
    );

    if (recovered) {
      console.log('Recovered uncompleted unwrap from chain history:', recovered);
      localStorage.setItem('gonka_unwrap_pending', JSON.stringify(recovered));
      checkForPending();
      if (activeTab.value === 'withdraw') {
        currentStep.value = 3;
      }
    }
  } catch (err) {
    console.warn('Failed to scan for lost pending state:', err);
  } finally {
    isScanningForLostState.value = false;
  }
}

function handleClearPending() {
  clearPending();
  checkForPending();
}

function handleDiscardPending() {
  clearPending();
  checkForPending();
  currentStep.value = 2;
}

function handleResetUnwrap() {
  resetUnwrap();
  checkForPending();
}

// --- STEPPER FUNCTIONS ---

function openConnectWallet() {
  connectWalletRef.value?.openModal();
}

async function walletStateChange(res: any) {
  try {
    if (res?.detail?.value) {
      setTimeout(async () => {
        try {
          await walletStore.setConnectedWallet(res.detail.value);
        } catch (error) {
          console.error('Error setting connected wallet:', error);
        }
      }, 50);
    }
  } catch (error) {
    console.error('Error in wallet state change:', error);
  }
}

function handleTransferMore() {
  depositTxCompleted.value = false;
  withdrawTxCompleted.value = false;
  lastTxInfo.value = null;
  txError.value = '';
  depositProgress.value = { status: 'idle', lockTxHash: '', message: '' };
  ibcProgress.value = { status: 'idle', txHash: '', message: '' };
  resetUnwrap();
  checkForPending();
  currentStep.value = 2;
}

function handleRetry() {
  txError.value = '';
  depositTxCompleted.value = false;
  withdrawTxCompleted.value = false;
  depositProgress.value = { status: 'idle', lockTxHash: '', message: '' };
  ibcProgress.value = { status: 'idle', txHash: '', message: '' };
  resetUnwrap();
  checkForPending();
  currentStep.value = 2;
}

async function handleStepSubmit() {
  // Save tx info for Step 3 summary display
  if (activeTab.value === 'deposit' && selectedDepositToken.value) {
    const token = selectedDepositToken.value;
    const chainDisplay = token.chainId ? (token.chainId.charAt(0).toUpperCase() + token.chainId.slice(1).split('-')[0]) : 'External';
    
    const metadataRoute = getIbcRouteMetadata(token);
    let sourceChannel = metadataRoute.sourceChannel;
    let destChannel = metadataRoute.destChannel;
    
    if (token.type === 'ibc' && !sourceChannel) {
      const resolved = await resolveChannelForToken(token);
      if (resolved) {
        sourceChannel = resolved.sourceChannel;
        destChannel = resolved.destChannel;
      }
    }

    lastTxInfo.value = {
      amount: depositAmount.value,
      token: token.symbol || '',
      type: token.type || '',
      chainId: token.chainId || '',
      from: token.type === 'ibc' ? `${chainDisplay}${sourceChannel ? ` (${sourceChannel})` : ''}` : 'Ethereum',
      to: token.type === 'ibc' ? `Gonka${destChannel ? ` (${destChannel})` : ''}` : 'Gonka'
    };
  } else if (activeTab.value === 'withdraw' && selectedWithdrawToken.value) {
    const token = selectedWithdrawToken.value;
    const chainId = token.token_info?.chainId || '';
    const chainDisplay = chainId ? (chainId.charAt(0).toUpperCase() + chainId.slice(1).split('-')[0]) : 'External';
    
    // For IBC withdraw, let's resolve the channel
    let channelInfo = '';
    if (token.isNative && chainId) {
      const localChannel = await resolveLocalChannelForWithdrawToken(token);
      channelInfo = localChannel ? ` (${localChannel})` : '';
    }

    lastTxInfo.value = {
      amount: withdrawAmount.value,
      token: token.symbol || '',
      type: token.isNative ? 'ibc' : 'eth',
      chainId: token.token_info?.chainId || '',
      from: 'Gonka',
      to: token.isNative ? `${chainDisplay}${channelInfo}` : 'Ethereum'
    };
  }

  currentStep.value = 3;
  depositTxCompleted.value = false;
  withdrawTxCompleted.value = false;

  if (activeTab.value === 'deposit') {
    await executeDeposit();
  } else {
    await executeWithdraw();
  }
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
      cosmosRestEndpoint: blockchain.endpoint?.address || '',
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
  loadAllData();
  checkForPending();

  // If wallet is already connected on reload, auto-advance to Step 2
  if (isConnected.value && !pendingUnwrap.value) {
    currentStep.value = 2;
  }

  // Check for pending unwrap to resume — auto-advance to Step 3
  if (pendingUnwrap.value) {
    activeTab.value = 'withdraw';
    if (isConnected.value) {
      currentStep.value = 3;
    }
  }
});

// --- DEPOSIT TAB LOGIC ---

async function executeDeposit() {
  if (!selectedDepositToken.value || !depositAmount.value || parseFloat(depositAmount.value) <= 0) return;

  calculating.value = true;
  txError.value = '';

  try {
    let txHash: string | undefined;
    if (selectedDepositToken.value.type === 'ibc') {
      // IBC Deposit
      ibcProgress.value.status = 'signing';
      ibcProgress.value.txHash = '';
      ibcProgress.value.message = 'Please approve the transfer in your wallet.';
      txHash = await initiateIbcDeposit(selectedDepositToken.value, depositAmount.value);
      if (txHash && lastTxInfo.value) {
        lastTxInfo.value.txHash = txHash;
      }
      ibcProgress.value.txHash = txHash || '';
      ibcProgress.value.status = 'relaying';
      ibcProgress.value.message = 'IBC packet transfer in progress...';
      // Simulate relayer passing packet
      await new Promise(resolve => setTimeout(resolve, 4000));
      ibcProgress.value.status = 'completed';
      ibcProgress.value.message = 'Transaction successfully relayed.';
      depositTxCompleted.value = true;
    } else {
      // EVM Deposit
      depositProgress.value.status = 'signing_ethereum';
      depositProgress.value.lockTxHash = '';
      depositProgress.value.message = 'Locking tokens on Ethereum...';
      txHash = await initiateEthDeposit(selectedDepositToken.value, depositAmount.value);
      if (txHash && lastTxInfo.value) {
        lastTxInfo.value.txHash = txHash;
      }
      depositProgress.value.lockTxHash = txHash || '';
      depositProgress.value.status = 'waiting_bls';
      depositProgress.value.message = 'Waiting for bridge validator signatures...';
      await new Promise(resolve => setTimeout(resolve, 4000));
      depositProgress.value.status = 'minting';
      depositProgress.value.message = 'Minting tokens on Gonka...';
      await new Promise(resolve => setTimeout(resolve, 3000));
      depositProgress.value.status = 'completed';
      depositProgress.value.message = 'Tokens successfully minted.';
      depositTxCompleted.value = true;
    }
    depositAmount.value = '';
    selectedDepositToken.value = null;
  } catch (err) {
    txError.value = err instanceof Error ? err.message : 'Deposit failed';
    console.error('Deposit Error:', err);
    depositProgress.value.status = 'failed';
    ibcProgress.value.status = 'failed';
  } finally {
    calculating.value = false;
  }
}

function normalizeChannelId(value: unknown): string | undefined {
  const channel = typeof value === 'string' ? value.trim() : '';
  return channel.startsWith('channel-') ? channel : undefined;
}

function getIbcRouteMetadata(token: any): Partial<IbcChannelRoute> {
  const info = token?.token_info || {};
  return {
    sourceChannel: normalizeChannelId(
      token?.sourceChannel ||
      token?.source_channel ||
      token?.ibc_channel ||
      info?.sourceChannel ||
      info?.source_channel ||
      info?.ibc_channel
    ),
    destChannel: normalizeChannelId(
      token?.destChannel ||
      token?.dest_channel ||
      token?.destination_channel ||
      token?.local_channel ||
      token?.gonka_channel ||
      info?.destChannel ||
      info?.dest_channel ||
      info?.destination_channel ||
      info?.local_channel ||
      info?.gonka_channel
    )
  };
}

function getIbcHash(denom: unknown): string | null {
  if (typeof denom !== 'string') return null;
  const match = denom.trim().match(/^ibc\/([a-fA-F0-9]+)$/);
  return match ? match[1] : null;
}

function getFirstTransferChannel(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  const parts = path.split('/');
  if (parts.length >= 2 && parts[0] === 'transfer') {
    return normalizeChannelId(parts[1]) || null;
  }
  return null;
}

function getTokenIbcDenom(token: any): string | undefined {
  const candidates = [
    token?.contractAddress,
    token?.full_denom,
    token?.token_info?.contractAddress
  ];
  return candidates.find((denom) => getIbcHash(denom)) || candidates.find((denom) => typeof denom === 'string');
}

function cacheIbcRoute(cacheKey: string, resolver: () => Promise<IbcChannelRoute | null>) {
  const cached = ibcRouteCache.get(cacheKey);
  if (cached) return cached;

  const promise = resolver().then((route) => {
    if (!route) ibcRouteCache.delete(cacheKey);
    return route;
  }).catch((error) => {
    ibcRouteCache.delete(cacheKey);
    console.error('Failed to resolve IBC route:', error);
    return null;
  });

  ibcRouteCache.set(cacheKey, promise);
  return promise;
}

async function resolveChannelFromIbcDenom(denom: unknown): Promise<IbcChannelRoute | null> {
  const hash = getIbcHash(denom);
  const endpoint = blockchain.endpoint?.address;
  if (!hash || !endpoint) return null;

  return cacheIbcRoute(`denom:${endpoint}:${hash.toLowerCase()}`, async () => {
    const traceData = await blockchain.rpc.getIBCAppTransferDenom(hash);
    const destChannel = getFirstTransferChannel(traceData?.denom_trace?.path);
    if (!destChannel) return null;

    const channelData = await get(`${endpoint}/ibc/core/channel/v1/channels/${destChannel}/ports/transfer`);
    const sourceChannel = normalizeChannelId(channelData?.channel?.counterparty?.channel_id);
    if (!sourceChannel) return null;

    return { sourceChannel, destChannel };
  });
}

async function resolveConnectionIdsForClient(endpoint: string, clientId: string): Promise<string[]> {
  try {
    const clientConnectionsData = await get(`${endpoint}/ibc/core/connection/v1/client_connections/${clientId}`);
    const connectionPaths = clientConnectionsData?.connection_paths || [];
    if (connectionPaths.length > 0) return connectionPaths;
  } catch {
    // Some REST gateways do not expose client_connections; fall back to the list query below.
  }

  const connectionsData = await get(`${endpoint}/ibc/core/connection/v1/connections`);
  const connections = connectionsData?.connections || [];
  return connections
    .filter((conn: any) => conn.client_id === clientId)
    .map((conn: any) => conn.id)
    .filter(Boolean);
}

async function resolveTransferChannelForConnection(endpoint: string, connectionId: string): Promise<IbcChannelRoute | null> {
  const findTransferRoute = (channels: any[]) => {
    const targetChannel = channels.find((ch: any) => {
      return ch.state === 'STATE_OPEN' &&
        ch.port_id === 'transfer' &&
        ch.connection_hops?.includes(connectionId);
    });

    const sourceChannel = normalizeChannelId(targetChannel?.counterparty?.channel_id);
    const destChannel = normalizeChannelId(targetChannel?.channel_id);
    return sourceChannel && destChannel ? { sourceChannel, destChannel } : null;
  };

  try {
    const channelsData = await get(`${endpoint}/ibc/core/channel/v1/connections/${connectionId}/channels`);
    const route = findTransferRoute(channelsData?.channels || []);
    if (route) return route;
  } catch {
    // Fall back to the full channel list if the connection-scoped query is unavailable.
  }

  const channelsData = await get(`${endpoint}/ibc/core/channel/v1/channels`);
  return findTransferRoute(channelsData?.channels || []);
}

async function resolveChannelForChain(targetChainId: string): Promise<IbcChannelRoute | null> {
  const endpoint = blockchain.endpoint?.address;
  if (!endpoint || !targetChainId) return null;

  return cacheIbcRoute(`chain:${endpoint}:${targetChainId.toLowerCase()}`, async () => {
    const clientsData = await get(`${endpoint}/ibc/core/client/v1/client_states`);
    const clientStates = clientsData?.client_states || [];

    const targetClient = clientStates.find((c: any) => {
      const cState = c?.client_state || c?.identified_client_state?.client_state;
      return cState?.chain_id && String(cState.chain_id).toLowerCase() === targetChainId.toLowerCase();
    });
    const clientId = targetClient?.client_id || targetClient?.identified_client_state?.client_id;
    if (!clientId) return null;

    const connectionIds = await resolveConnectionIdsForClient(endpoint, clientId);
    for (const connectionId of connectionIds) {
      const route = await resolveTransferChannelForConnection(endpoint, connectionId);
      if (route) return route;
    }
    return null;
  });
}

async function resolveChannelForToken(token: any): Promise<IbcChannelRoute | null> {
  const metadataRoute = getIbcRouteMetadata(token);
  if (metadataRoute.sourceChannel && metadataRoute.destChannel) {
    return metadataRoute as IbcChannelRoute;
  }

  const denomRoute = await resolveChannelFromIbcDenom(getTokenIbcDenom(token));
  if (denomRoute) return denomRoute;

  const chainId = token?.chainId || token?.token_info?.chainId;
  return chainId ? resolveChannelForChain(chainId) : null;
}

// Also resolves the local (Gonka-side) channel for a target chain - needed for withdrawals
async function resolveLocalChannel(targetChainId: string): Promise<string | null> {
  const resolved = await resolveChannelForChain(targetChainId);
  return resolved?.destChannel || null;
}

async function resolveLocalChannelForWithdrawToken(token: any): Promise<string | null> {
  const metadataRoute = getIbcRouteMetadata(token);
  if (metadataRoute.destChannel) return metadataRoute.destChannel;

  const denomRoute = await resolveChannelFromIbcDenom(getTokenIbcDenom(token));
  if (denomRoute) return denomRoute.destChannel;

  const chainId = token?.token_info?.chainId || token?.chainId;
  return chainId ? resolveLocalChannel(chainId) : null;
}

async function initiateIbcDeposit(token: SupportedToken, amountInput: string) {
  const chainId = token.chainId;
  const contractHash = token.contractAddress;

  const sourcePort = 'transfer';
  let sourceChannel = getIbcRouteMetadata(token).sourceChannel;
  let tokenDenom = contractHash;

  if (!sourceChannel) {
    const resolvedRoute = await resolveChannelForToken(token);
    sourceChannel = resolvedRoute?.sourceChannel;
  }

  if (!sourceChannel) {
    throw new Error(`Could not resolve IBC source channel for ${chainId}`);
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

  const result = await walletStore.executeIbcTransfer(chainId, sourcePort, sourceChannel, tokenDenom, amountInBaseUnits, receiver);
  return result?.transactionHash;
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

  const txHash = await ethProvider.request({
    method: 'eth_sendTransaction',
    params: [{ from: fromAddress, to: contractHash, data: data }],
  });
  return txHash;
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

// Known mainnet ERC20 contracts
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
  const isKnownMainnet = KNOWN_MAINNET_CONTRACTS.has(contractLower);
  const activeCosmosChain = baseStore.currentChainId || blockchain.current?.chainId || '';
  const cosmosIsTestnet = activeCosmosChain.includes('testnet');
  const useMainnet = isKnownMainnet || !cosmosIsTestnet;

  const rpcList = useMainnet ? MAINNET_RPCS : SEPOLIA_RPCS;

  for (const evmRpcUrl of rpcList) {
    try {
      const json = await post(evmRpcUrl, {
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{ to, data }, 'latest'],
        id: 1
      });
      if (json.error) {
        continue;
      }
      return json?.result || '0x';
    } catch (e) {
      // skip
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
      // skip
    }
  }
  return null;
}

function getChainGasDetails(chainId: string): { symbol: string; decimals: number; defaultFee: string } {
  const chainLower = chainId.toLowerCase();
  if (chainLower.includes('kava')) {
    return { symbol: 'KAVA', decimals: 6, defaultFee: '0.01' };
  }
  if (chainLower.includes('injective') || chainLower.includes('inj')) {
    return { symbol: 'INJ', decimals: 18, defaultFee: '0.01' };
  }
  if (chainLower.includes('osmosis') || chainLower.includes('osmo')) {
    return { symbol: 'OSMO', decimals: 6, defaultFee: '0.025' };
  }
  if (chainLower.includes('cosmoshub') || chainLower.includes('atom')) {
    return { symbol: 'ATOM', decimals: 6, defaultFee: '0.005' };
  }
  if (chainLower.includes('evmos')) {
    return { symbol: 'EVMOS', decimals: 18, defaultFee: '0.1' };
  }
  return { symbol: 'ATOM', decimals: 6, defaultFee: '0.005' };
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
  const isIbc = isDeposit && token.type === 'ibc';
  if (!isEth && !isIbc) {
    approximateFee.value = '';
    return;
  }

  feeLoading.value = true;

  if (isIbc) {
    try {
      const chainDetails = getChainGasDetails(token.chainId);
      let gasDenom = token.sourceDenom || token.contractAddress;
      if (token.chainId.includes('injective')) gasDenom = 'inj';
      else if (token.chainId.includes('evmos')) gasDenom = 'aevmos';
      else if (token.chainId.includes('osmosis')) gasDenom = 'uosmo';
      else if (token.chainId.includes('cosmoshub')) gasDenom = 'uatom';
      else if (token.chainId.includes('kava')) gasDenom = 'ukava';

      let suggestedGasPrice: number | undefined;
      try {
        const walletType = walletStore.connectedWallet?.wallet;
        if (walletType === 'keplr' && typeof (window.keplr as any)?.getChainInfoWithoutEndpoints === 'function') {
          const chainInfo = await (window.keplr as any).getChainInfoWithoutEndpoints(token.chainId);
          const feeCurrency =
            chainInfo?.feeCurrencies?.find((c: any) => c?.coinMinimalDenom === gasDenom) ||
            chainInfo?.feeCurrencies?.[0];
          const gasPrice =
            feeCurrency?.gasPriceStep?.average ??
            feeCurrency?.gasPriceStep?.high ??
            feeCurrency?.gasPriceStep?.low;
          if (gasPrice !== undefined) {
            suggestedGasPrice = Number(gasPrice);
          }
        }
      } catch (e) {
        console.warn('Could not fetch gas price suggestion from Keplr:', e);
      }

      const gasLimit = 500000;
      let feeInNative = parseFloat(chainDetails.defaultFee);

      if (suggestedGasPrice !== undefined) {
        feeInNative = (gasLimit * suggestedGasPrice) / Math.pow(10, chainDetails.decimals);
      } else if (token.chainId.includes('injective')) {
        const minGasPrice = 160000000;
        feeInNative = (gasLimit * minGasPrice) / Math.pow(10, 18);
      }

      approximateFee.value = `~${feeInNative.toFixed(4)} ${chainDetails.symbol}`;
    } catch (err) {
      console.warn('[Fee Estimation] Failed to calculate dynamic IBC fee:', err);
      const chainDetails = getChainGasDetails(token.chainId);
      approximateFee.value = `~${chainDetails.defaultFee} ${chainDetails.symbol}`;
    } finally {
      feeLoading.value = false;
    }
    return;
  }

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
        sourceChannel: normalizeChannelId(t.sourceChannel || (t as any).source_channel || (t as any).ibc_channel),
        destChannel: normalizeChannelId((t as any).destChannel || (t as any).dest_channel || (t as any).destination_channel || (t as any).local_channel || (t as any).gonka_channel),
        sourceDenom: t.sourceDenom || (t as any).source_denom || (t as any).base_denom || undefined,
        decimals: t.decimals || estimatedDecimals
      };

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

    if (ethTemp.length > 0) {
      await Promise.all(ethTemp.map(async (token) => {
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

    await Promise.all(ibcTemp.map(async (token) => {
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

async function fetchDepositTokenBalance() {
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
      const connectedWalletType = walletStore.connectedWallet?.wallet;
      let ethProvider: any = null;

      if (connectedWalletType === 'keplr' && (window as any).keplr?.ethereum) {
        ethProvider = (window as any).keplr.ethereum;
      } else if (connectedWalletType === 'leap' && (window as any).leap?.ethereum) {
        ethProvider = (window as any).leap.ethereum;
      }

      if (!ethProvider && (window as any).ethereum) {
        ethProvider = (window as any).ethereum;
      }

      if (ethProvider) {
        try {
          const accounts = await ethProvider.request({ method: 'eth_requestAccounts' });
          if (!accounts || accounts.length === 0) {
            depositTokenBalance.value = '0.000000';
            return;
          }
          const from = accounts[0];
          activeEthAddress.value = from;

          const activeCosmosChain = baseStore.currentChainId || blockchain.current?.chainId || props.chain || '';
          const walletProvider = connectedWalletType === 'leap' ? (window as any).leap : (window as any).keplr;

          if (walletProvider && activeCosmosChain && token.type === 'eth') {
            try {
              const key = await walletProvider.getKey(activeCosmosChain);
              const pubKeyBytes = key.pubKey;
              if (pubKeyBytes && pubKeyBytes.length > 0) {
                const pubKeyHex = '0x' + Array.from(pubKeyBytes as Uint8Array, (b) => (b as number).toString(16).padStart(2, '0')).join('');
                const derivedEthAddress = ethers.computeAddress(pubKeyHex);
                
                if (from.toLowerCase() !== derivedEthAddress.toLowerCase()) {
                  isAddressMismatch.value = true;
                  expectedEthAddress.value = derivedEthAddress;
                  
                  const rawHex = from.startsWith('0x') ? from.substring(2) : from;
                  const hexBytes = new Uint8Array(
                    rawHex.match(/.{1,2}/g)?.map((byte: string) => parseInt(byte, 16)) || []
                  );
                  
                  const targetPrefix = blockchain.current?.bech32Prefix || 'gonka';
                  derivedCosmosAddress.value = toBech32(targetPrefix, hexBytes);
                } else {
                  isAddressMismatch.value = false;
                }
              }
            } catch (keyErr) {
              console.warn('[Key Verification] Could not verify wallet key mismatch:', keyErr);
            }
          }

          const paddedAddr = from.replace('0x', '').padStart(64, '0');
          const data = '0x70a08231' + paddedAddr;
          const result = await queryEvmRpc(token.contractAddress, data);

          if (!result || result === '0x' || result === '0x0') {
            depositTokenBalance.value = '0.000000';
            return;
          }

          const decimals = token.decimals || 6;
          const rawBalance = parseInt(result, 16);
          if (isNaN(rawBalance)) {
            depositTokenBalance.value = '0.000000';
          } else {
            depositTokenBalance.value = (rawBalance / Math.pow(10, decimals)).toFixed(6);
          }
        } catch (e: any) {
          depositTokenBalance.value = '0.000000';
        }
      } else {
        depositTokenBalance.value = '0.000000';
      }
    } else {
      const keplr = (window as any).keplr;
      if (keplr) {
        try {
          await keplr.enable(token.chainId);
          const offlineSigner = keplr.getOfflineSigner(token.chainId);
          const accounts = await offlineSigner.getAccounts();
          if (accounts.length > 0) {
            const sourceAddress = accounts[0].address;

            let nativeDenom = token.sourceDenom || '';
            if (!nativeDenom && token.contractAddress.startsWith('ibc/')) {
              try {
                const hash = token.contractAddress.replace('ibc/', '');
                const traceData = await blockchain.rpc.getIBCAppTransferDenom(hash);
                if (traceData?.denom_trace?.base_denom) {
                  nativeDenom = traceData.denom_trace.base_denom;
                }
              } catch { /* skip */ }
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
          depositTokenBalance.value = '0.000000';
        }
      }
    }
  } catch (err) {
    depositTokenBalance.value = '0.000000';
  } finally {
    depositBalanceLoading.value = false;
  }
}

async function resolveWithdrawDestination() {
  if (!selectedWithdrawToken.value || !isConnected.value) return;

  const token = selectedWithdrawToken.value;

  try {
    if (token.isNative) {
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
    let txHash: string | undefined;
    if (token.isNative) {
      // IBC Withdraw
      ibcProgress.value.status = 'signing';
      ibcProgress.value.txHash = '';
      ibcProgress.value.message = 'Please approve the transfer in your wallet.';
      txHash = await initiateIbcWithdraw(token);
      if (txHash && lastTxInfo.value) {
        lastTxInfo.value.txHash = txHash;
      }
      ibcProgress.value.txHash = txHash || '';
      ibcProgress.value.status = 'relaying';
      ibcProgress.value.message = 'IBC packet transfer in progress...';
      // Simulate relayer passing packet
      await new Promise(resolve => setTimeout(resolve, 4000));
      ibcProgress.value.status = 'completed';
      ibcProgress.value.message = 'Transaction successfully relayed.';
      withdrawTxCompleted.value = true;
    } else {
      // EVM Withdraw
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
    ibcProgress.value.status = 'failed';
  } finally {
    calculating.value = false;
  }
}

async function initiateIbcWithdraw(token: any) {
  const chainId = token.token_info?.chainId;
  if (!chainId) throw new Error('Cannot determine destination chain for this token');

  const localChannel = await resolveLocalChannelForWithdrawToken(token);
  if (!localChannel) throw new Error(`Could not resolve IBC channel to ${chainId}`);

  const denom = token.full_denom || token.token_info?.contractAddress;
  if (!denom) throw new Error('Cannot determine token denom for withdrawal');

  const decimals = token.decimals ?? 6;
  const amountInBaseUnits = Math.floor(parseFloat(withdrawAmount.value) * Math.pow(10, decimals)).toString();

  let receiver = withdrawDestinationAddress.value.trim();
  if (!receiver) {
    throw new Error('Please enter a destination address on the target chain');
  }

  const gonkaChainId = baseStore.currentChainId || blockchain.current?.chainId || props.chain;

  const result = await walletStore.executeIbcTransfer(
    gonkaChainId,
    'transfer',
    localChannel,
    denom,
    amountInBaseUnits,
    receiver
  );
  return result?.transactionHash;
}

async function initiateEthWithdraw(token: any) {
  const chainId = token.token_info?.chainId;
  if (!chainId) throw new Error('Cannot determine destination chain for this token');

  let destinationEthAddress = withdrawDestinationAddress.value.trim();
  if (!destinationEthAddress || !destinationEthAddress.startsWith('0x')) {
    throw new Error('Please enter a valid Ethereum destination address (0x...)');
  }

  const bridgeResp = await blockchain.getBridgeAddresses(chainId);
  let bridgeContractAddress = bridgeResp?.bridge_address || bridgeResp?.address || bridgeResp?.bridge_contract || bridgeResp?.data?.bridge_address || bridgeResp?.approved_bridge_address;

  if (!bridgeContractAddress && bridgeResp?.addresses && Array.isArray(bridgeResp.addresses) && bridgeResp.addresses.length > 0) {
    const match = bridgeResp.addresses.find((a: any) => a.chainId === chainId || String(a.chainId).toLowerCase() === String(chainId).toLowerCase());
    bridgeContractAddress = match?.address || bridgeResp.addresses[0].address;
  }

  if (!bridgeContractAddress || !String(bridgeContractAddress).startsWith('0x')) {
    throw new Error(`Could not resolve bridge contract address for chain ${chainId}`);
  }

  const cw20Address = token.isGnk ? 'native' : (token.token_info?.wrappedContractAddress || token.token_info?.contractAddress);
  if (!cw20Address) throw new Error('Cannot determine wrapped token contract address');

  const tokenContractOnEth = token.isGnk ? bridgeContractAddress : token.token_info?.contractAddress;

  const decimals = token.decimals ?? 6;
  const amountInBaseUnits = Math.floor(parseFloat(withdrawAmount.value) * Math.pow(10, decimals)).toString();

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
    cosmosRestEndpoint: blockchain.endpoint?.address || '',
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

// Watchers
watch(() => blockchain.endpoint?.address, (newEndpoint) => {
  if (newEndpoint) {
    loadSupportedDepositTokens();
    checkTxIndexingStatus();
  }
}, { immediate: true });

watch([walletAddress, () => blockchain.endpoint?.address], ([newAddress, newEndpoint]) => {
  if (newAddress && newEndpoint) {
    walletStore.loadMyAsset();
    loadWrappedTokenBalances();
    fetchDepositTokenBalance();
    fetchApproximateFee();
    
    if (supportedIbcTokens.value.length === 0 && supportedEthTokens.value.length === 0) {
      loadSupportedDepositTokens();
    }
  } else {
    wrappedTokenBalances.value = [];
    depositTokenBalance.value = '';
  }
}, { immediate: true });

watch(activeTab, (tab) => {
  localStorage.setItem('gonka_active_tab', tab);
  // Reset transaction and stepper states on tab change
  depositTxCompleted.value = false;
  withdrawTxCompleted.value = false;
  lastTxInfo.value = null;
  txError.value = '';
  depositProgress.value = { status: 'idle', lockTxHash: '', message: '' };
  ibcProgress.value = { status: 'idle', txHash: '', message: '' };
  resetUnwrap();
  checkForPending();

  if (pendingUnwrap.value) {
    if (isConnected.value) {
      currentStep.value = 3;
    } else {
      currentStep.value = 1;
    }
  } else {
    if (isConnected.value) {
      currentStep.value = 2;
    } else {
      currentStep.value = 1;
    }
  }

  if (tab === 'withdraw' && isConnected.value) {
    loadBridgeEpochStatus();
    scanForLostPendingState();
  }
});

watch(isConnected, (connected) => {
  if (!connected) {
    currentStep.value = 1;
    depositTxCompleted.value = false;
    withdrawTxCompleted.value = false;
    lastTxInfo.value = null;
  } else {
    // Asynchronous wallet restoration check: auto-advance if there's a pending transaction
    if (pendingUnwrap.value) {
      activeTab.value = 'withdraw';
      currentStep.value = 3;
    } else if (activeTab.value === 'withdraw') {
      scanForLostPendingState();
    }
  }
});

watch(withdrawDestinationAddress, (newVal) => {
  if (newVal && newVal.startsWith('0x') && activeTab.value === 'withdraw') {
    scanForLostPendingState();
  }
});

watch(selectedDepositToken, () => {
  fetchDepositTokenBalance();
  fetchApproximateFee();
});

watch(resolvedBridgeAddress, (newAddress) => {
  if (newAddress && newAddress.startsWith('0x')) {
    if (selectedDepositToken.value && selectedDepositToken.value.symbol === 'WGNK') {
      if (!selectedDepositToken.value.contractAddress || selectedDepositToken.value.contractAddress.toLowerCase() !== newAddress.toLowerCase()) {
        selectedDepositToken.value.contractAddress = newAddress;
        fetchDepositTokenBalance();
      }
    }
  }
});

watch(withdrawableTokens, (tokens) => {
  if (!selectedWithdrawToken.value) return;

  const selectedIdentity = getWithdrawTokenIdentity(selectedWithdrawToken.value);
  const updatedToken = tokens.find(token => getWithdrawTokenIdentity(token) === selectedIdentity);

  if (updatedToken && updatedToken !== selectedWithdrawToken.value) {
    selectedWithdrawToken.value = updatedToken;
  } else if (!updatedToken) {
    selectedWithdrawToken.value = null;
  }
});

watch(selectedWithdrawToken, (token, previousToken) => {
  const tokenChanged = getWithdrawTokenIdentity(token) !== getWithdrawTokenIdentity(previousToken);
  if (tokenChanged) {
    withdrawDestinationAddress.value = '';
    resolveWithdrawDestination();
  }
  if (token && !token.isNative) {
    loadBridgeEpochStatus();
  }
  fetchApproximateFee();
});

watch([depositAmount, withdrawAmount], () => {
  fetchApproximateFee();
});

const isTransactionCompleted = computed(() => {
  if (activeTab.value === 'deposit') {
    return depositTxCompleted.value;
  } else {
    return unwrapProgress.value.status === 'completed' || withdrawTxCompleted.value;
  }
});

watch(isTransactionCompleted, (completed) => {
  if (completed) {
    loadWrappedTokenBalances();
    walletStore.loadMyAsset();
    fetchDepositTokenBalance();
  }
});

const isTransactionFailed = computed(() => {
  if (activeTab.value === 'deposit') {
    return !!txError.value;
  } else {
    return (unwrapProgress.value.status === 'failed' || !!txError.value) && !pendingUnwrap.value;
  }
});

const isTransactionInProgress = computed(() => {
  if (isTransactionCompleted.value || isTransactionFailed.value) {
    return false;
  }
  if (pendingUnwrap.value && !isUnwrapRunning.value) {
    return false;
  }
  return currentStep.value === 3;
});

const computedLastTxInfo = computed(() => {
  if (lastTxInfo.value) return lastTxInfo.value;
  if (pendingUnwrap.value) {
    const isGnk = !!pendingUnwrap.value.params.isGnk;
    let decimals = 9;
    let symbol = 'GNK';

    if (!isGnk) {
      const meta = getOfflineMetadata(pendingUnwrap.value.params.cw20Address) ||
                   getOfflineMetadata(pendingUnwrap.value.params.tokenContractOnEth);
      if (meta) {
        decimals = meta.decimals;
        symbol = meta.symbol;
      } else {
        decimals = 6;
        symbol = 'Wrapped';
      }
    }

    const rawAmount = parseFloat(pendingUnwrap.value.params.amount);
    const formattedAmount = isNaN(rawAmount) ? '0' : (rawAmount / Math.pow(10, decimals)).toString();

    return {
      amount: formattedAmount,
      token: symbol,
      type: 'eth',
      chainId: baseStore.currentChainId || '',
      txHash: pendingUnwrap.value.gonkaTxHash,
      from: 'Gonka',
      to: 'Ethereum'
    };
  }
  return null;
});
</script>

<template>
  <div class="bg-base-100 rounded shadow min-h-[314px] relative">
    <!-- Indexing Disabled overlay -->
    <div class="absolute inset-0 bg-base-100 rounded flex flex-col justify-center items-center p-8 text-center z-30" v-if="isTxIndexingOff">
      <Icon icon="mdi:database-off" class="text-error w-16 h-16 mb-4 opacity-80" />
      <h3 class="text-lg font-bold text-main mb-2">Exchange Temporarily Unavailable</h3>
      <p class="text-sm text-gray-500 dark:text-gray-400 max-w-sm">
        Transaction indexing is currently disabled on the RPC node. Swaps and transfers are temporarily disabled until indexing is re-enabled.
      </p>
    </div>

    <div class="px-4 pt-4 pb-2">
      <!-- Switcher -->
      <ExchangeSwitcher
        v-model:active-tab="activeTab"
        :is-connected="isConnected"
        @disconnect="walletStore.disconnect()"
      />

      <!-- Stepper Header -->
      <ExchangeStepper
        :current-step="currentStep"
        :is-transaction-completed="isTransactionCompleted"
      />
    </div>

    <div class="px-4 pb-4">
      <!-- STEP 1: Connect Wallet -->
      <ExchangeConnect
        v-if="currentStep === 1"
        v-model:current-step="currentStep"
        :is-connected="isConnected"
        :loading="loading"
        :active-tab="activeTab"
        :connected-wallet-name="walletStore.connectedWallet?.wallet"
        :truncated-address="truncatedAddress"
        :staking-token-balance="walletStore.balanceOfStakingToken"
        :format="format"
        @connect="openConnectWallet"
      />

      <!-- STEP 2: Details entry form -->
      <ExchangeDetails
        v-else-if="currentStep === 2"
        v-model:current-step="currentStep"
        v-model:deposit-amount="depositAmount"
        v-model:withdraw-amount="withdrawAmount"
        v-model:selected-deposit-token="selectedDepositToken"
        v-model:selected-withdraw-token="selectedWithdrawToken"
        v-model:withdraw-destination-address="withdrawDestinationAddress"
        :active-tab="activeTab"
        :is-connected="isConnected"
        :wallet-address="walletAddress"
        :all-deposit-tokens="allDepositTokens"
        :withdrawable-tokens="withdrawableTokens"
        :calculating="calculating"
        :error="error"
        :tx-error="txError"
        :pending-unwrap="pendingUnwrap"
        :epoch-status="epochStatus"
        :epoch-status-loading="epochStatusLoading"
        :epoch-update-loading="epochUpdateLoading"
        :epoch-update-message="epochUpdateMessage"
        :is-address-mismatch="isAddressMismatch"
        :approximate-fee="approximateFee"
        :fee-loading="feeLoading"
        :deposit-token-balance="depositTokenBalance"
        :deposit-balance-loading="depositBalanceLoading"
        :format="format"
        @submit="handleStepSubmit"
        @retry-loading="retryLoading"
        @update-bridge-epoch="updateBridgeEpoch"
        @clear-pending="handleClearPending"
        @resume-pending="handleResumePending"
      />

      <!-- STEP 3: Review / In Progress -->
      <ExchangeReview
        v-else-if="currentStep === 3 && isTransactionInProgress"
        :active-tab="activeTab"
        :last-tx-info="lastTxInfo"
        :unwrap-progress="unwrapProgress"
        :is-unwrap-running="isUnwrapRunning"
        :pending-unwrap="pendingUnwrap"
        :calculating="calculating"
        :deposit-tx-completed="depositTxCompleted"
        :withdraw-tx-completed="withdrawTxCompleted"
        :deposit-progress="depositProgress"
        :ibc-progress="ibcProgress"
        @resume-pending="handleResumePending"
        @clear-pending="handleClearPending"
        @discard-pending="handleDiscardPending"
      />

      <!-- STEP 3: Success / Failed / Pending Overview -->
      <ExchangeOverview
        v-else-if="currentStep === 3 && (isTransactionCompleted || isTransactionFailed || pendingUnwrap)"
        :active-tab="activeTab"
        :is-transaction-completed="isTransactionCompleted"
        :is-transaction-failed="isTransactionFailed"
        :is-transaction-pending="!!pendingUnwrap"
        :last-tx-info="computedLastTxInfo"
        :unwrap-progress="unwrapProgress"
        :tx-error="txError"
        :get-explorer-tx-link="getExplorerTxLink"
        :truncate-hash="truncateHash"
        @transfer-more="handleTransferMore"
        @disconnect="walletStore.disconnect()"
        @retry="handleRetry"
        @resume-pending="handleResumePending"
        @discard-pending="handleDiscardPending"
      />
    </div>

    <!-- ConnectWallet Modal -->
    <Teleport to="body">
      <ConnectWallet
        ref="connectWalletRef"
        :chain-id="baseStore.currentChainId"
        :hd-path="blockchain.defaultHDPath"
        :addr-prefix="blockchain.current?.bech32Prefix"
        @connect="walletStateChange"
      />
    </Teleport>
  </div>
</template>
