<script lang="ts" setup>
import { ref, computed, watch, onMounted } from 'vue';
import { useBlockchain, useWalletStore, useFormatter, useBaseStore } from '@/stores';
import { Icon } from '@iconify/vue';

const props = defineProps<{
  chain: string;
}>();

const blockchain = useBlockchain();
const walletStore = useWalletStore();
const format = useFormatter();
const baseStore = useBaseStore();

// State
const poolInfo = ref<any>(null);
const wrappedTokenBalances = ref<any[]>([]);
const loading = ref(false);
const calculating = ref(false);
const error = ref<string>('');
const txError = ref<string>('');
const calculationTimeout = ref<number | null>(null);

// Form data
const swapAmount = ref<string>('');
const estimatedOutput = ref<string>('');
const currentPrice = ref<string>('');
const priceImpact = ref<string>('');
const selectedWrappedToken = ref<string>('USDT');

export interface SupportedToken {
  chainId: string;
  contractAddress: string;
  symbol?: string; // We'll try to resolve this
  type?: 'ibc' | 'eth';
  sourceChannel?: string;
  sourceDenom?: string;
  decimals?: number;
}

// UI State
const activeTab = ref<'deposit' | 'purchase'>('deposit');
const supportedIbcTokens = ref<SupportedToken[]>([]);
const supportedEthTokens = ref<SupportedToken[]>([]);
const allDepositTokens = computed(() => [...supportedIbcTokens.value, ...supportedEthTokens.value]);

// Selection State (null implies "None selected")
const selectedDepositToken = ref<SupportedToken | null>(null);

// Dropdown UI State
const isDepositDropdownOpen = ref(false);
const isPurchaseDropdownOpen = ref(false);

const depositAmount = ref<string>('');

// Computed
const walletAddress = computed(() => walletStore.currentAddress);
const isConnected = computed(() => !!walletAddress.value);
const shouldShowWidget = computed(() => {
  // Don't show widget if there's an error or no pool info
  if (error.value || !poolInfo.value) return false;
  
  // Don't show widget if pool info is empty or missing required data
  if (!poolInfo.value.address || !poolInfo.value.address.trim()) return false;
  
  return true;
});
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

// Methods
async function loadPoolInfo() {
  loading.value = true;
  error.value = '';
  
  try {
    const info = await blockchain.getLiquidityPoolInfo();
    poolInfo.value = info;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load pool information';
    console.error('Error loading pool info:', err);
  } finally {
    loading.value = false;
  }
}

// Close dropdowns when clicking outside
function closeDropdowns(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (!target.closest('.custom-dropdown')) {
    isDepositDropdownOpen.value = false;
    isPurchaseDropdownOpen.value = false;
  }
}

onMounted(() => {
  document.addEventListener('click', closeDropdowns);
});

onUnmounted(() => {
  document.removeEventListener('click', closeDropdowns);
});

// Transaction Logic Stubs
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
     
     // Clear form on success
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

    // 1. Fetch all local channels on Gonka
    const channelsRes = await fetch(`${endpoint}/ibc/core/channel/v1/channels`);
    if (!channelsRes.ok) return null;
    const channelsData = await channelsRes.json();
    const channels = channelsData?.channels || [];

    // 2. Iterate through channels and check their client states
    for (const channel of channels) {
      if (channel.state !== 'STATE_OPEN' || channel.port_id !== 'transfer') continue;

      const clientStateRes = await fetch(`${endpoint}/ibc/core/channel/v1/channels/${channel.channel_id}/ports/transfer/client_state`);
      if (!clientStateRes.ok) continue;
      
      const clientData = await clientStateRes.json();
      const clientChainId = clientData?.identified_client_state?.client_state?.chain_id || clientData?.client_state?.chain_id;

      // 3. If we find a channel pointing to our target chain (e.g. Injective), return its counterparty ID!
      if (clientChainId === targetChainId) {
        return channel.counterparty?.channel_id || null;
      }
    }
  } catch (error) {
    console.error('Failed to auto-resolve IBC source channel:', error);
  }
  return null;
}

async function initiateIbcDeposit(token: SupportedToken, amountInput: string) {
  console.log('Initiating IBC Deposit for:', token);
  
  const chainId = token.chainId;
  const contractHash = token.contractAddress;
  
  const sourcePort = 'transfer';
  let sourceChannel = token.sourceChannel || 'channel-0'; 
  let tokenDenom = contractHash; 
  
  // Auto-resolve counterparty channel if we only have the default or empty
  if (sourceChannel === 'channel-0' || !sourceChannel) {
     console.log(`Attempting to auto-resolve counterparty channel for ${chainId}...`);
     const resolvedChannel = await resolveSourceChannel(chainId);
     if (resolvedChannel) {
        console.log(`Auto-resolved counterparty channel: ${resolvedChannel}`);
        sourceChannel = resolvedChannel;
     } else {
        console.warn(`Could not auto-resolve channel for ${chainId}, falling back to ${sourceChannel}`);
     }
  }

   // Resolve the native base denom for the source chain if an IBC hash was provided
   if (token.sourceDenom) {
     tokenDenom = token.sourceDenom;
     console.log(`Using explicit native base denom for IBC deposit: ${tokenDenom}`);
   } else if (tokenDenom.startsWith('ibc/')) {
     try {
       const hash = tokenDenom.replace('ibc/', '');
       const traceRes = await fetch(`${blockchain.endpoint?.address}/ibc/apps/transfer/v1/denom_traces/${hash}`);
       if (traceRes.ok) {
         const traceData = await traceRes.json();
         if (traceData?.denom_trace?.base_denom) {
           tokenDenom = traceData.denom_trace.base_denom;
           console.log(`Resolved native base denom for IBC deposit: ${tokenDenom}`);
         }
       }
     } catch (e) {
       console.warn(`Could not resolve denom trace for ${tokenDenom}, attempting transfer with raw string`, e);
     }
   }

  // Convert standard units (e.g. 1.5 INJ) to base units (e.g. 1500000)
  // We assume 6 decimals (stablecoins) or use the token's known decimals
  const decimals = token.decimals || 6;
  const amountInBaseUnits = Math.floor(parseFloat(amountInput) * Math.pow(10, decimals)).toString();
  
  const receiver = walletAddress.value;
  
  const result = await walletStore.executeIbcTransfer(chainId, sourcePort, sourceChannel, tokenDenom, amountInBaseUnits, receiver);
  console.log('IBC Transfer successful! Hash:', result.transactionHash);
}

async function initiateEthDeposit(token: SupportedToken, amountInput: string) {
  console.log('Initiating Ethereum Bridge Deposit for:', token);
  
  const chainId = token.chainId;
  const contractHash = token.contractAddress;
  
  const bridgeResp = await blockchain.getBridgeAddresses(chainId);
  let bridgeContractAddress = bridgeResp?.bridge_address || bridgeResp?.address || bridgeResp?.bridge_contract || bridgeResp?.data?.bridge_address || bridgeResp?.approved_bridge_address;

  // Fallback map check for nested addresses array (as seen in API /inference/bridge_addresses/ethereum)
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
  
  // ERC20 transfers use base units depending on the token's decimal precision
  // Typical stablecoins are 6, others are 18. Defaulting to 6 based on previous assumption `parseFloat(5) -> 5000000`.
  const decimals = 6; 
  const amountInBaseUnits = Math.floor(parseFloat(amountInput) * Math.pow(10, decimals));
  const amountHex = amountInBaseUnits.toString(16).padStart(64, '0');
  
  const data = methodId + toPadding + amountHex;

  // Determine the correct Ethereum Provider to handle the transaction.
  const connectedWalletType = walletStore.connectedWallet?.wallet;
  let ethProvider;

  if (connectedWalletType === 'keplr' && (window as any).keplr?.ethereum) {
    ethProvider = (window as any).keplr.ethereum;
  } else if (connectedWalletType === 'leap' && (window as any).leap?.ethereum) {
    ethProvider = (window as any).leap.ethereum;
  } else {
    // If they aren't using an explicitly EVM-capable Cosmos wallet, invoke standard MetaMask/Rabby
    ethProvider = (window as any).ethereum;
  }
  
  if (!ethProvider) throw new Error('No Ethereum provider (MetaMask/Keplr/Rabby) found in browser. Please install an EVM wallet to bridge tokens.');

  // Force wallet to switch to the correct network FIRST, so connection requests default to it
  const chainIdFromBlockchain = blockchain.current?.chainId;
  const chainIdFromBaseStore = baseStore.currentChainId;
  const chainIdFromLatestBlock = baseStore.latest?.block?.header?.chain_id;
  
  // Use the first available chain ID or fallback to props.chain
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
  console.log('🛠 DEBUG - Active Cosmos Chain ID:', activeCosmosChain, '| isTestnet:', isTestnet);
  
  const targetChainIdHex = isTestnet ? '0xaa36a7' : '0x1'; // 0xaa36a7 = Sepolia (11155111), 0x1 = Ethereum Mainnet (1)

  try {
    console.log(`Requesting EVM provider to switch to chain: ${targetChainIdHex}`);
    await ethProvider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: targetChainIdHex }],
    });
  } catch (switchError: any) {
    if (switchError.code === 4902) {
      throw new Error(`Please add the ${isTestnet ? 'Sepolia' : 'Ethereum'} network to your EVM wallet first.`);
    }
    // We swallow normal switch rejections and let them try to connect anyway, relying on the user.
    console.warn('Network switch failed or intercepted:', switchError);
  }

  const accounts = await ethProvider.request({ method: 'eth_requestAccounts' });
  const fromAddress = accounts[0];

  console.log(`Sending ETH transaction from ${fromAddress} to ${contractHash} with data ${data}`);
  
  const txHash = await ethProvider.request({
    method: 'eth_sendTransaction',
    params: [{ from: fromAddress, to: contractHash, data: data }],
  });
  console.log('EVM Bridge transaction successfully submitted! Hash:', txHash);
}

async function loadSupportedDepositTokens() {
  try {
    const approvedTokensResp = await blockchain.getApprovedTokensForTrade();
    const allTokens: SupportedToken[] = approvedTokensResp?.approved_tokens || [];

    const ibcTemp: SupportedToken[] = [];
    const ethTemp: SupportedToken[] = [];
    
    // We fetch a list of all wrapped tokens for a dummy address or current address to resolve symbols
    const dummyAddress = walletAddress.value || 'gonka1nc5tatafv6eyq7llkr2gv50ff9e22mnf70qgjlv737ktmt4eswrq000000'; 
    let wrappedTokensInfo: any[] = [];
    try {
      const resp = await fetch(`${blockchain.endpoint.address}/productscience/inference/inference/wrapped_token_balances/${dummyAddress}`).then(r => r.json());
      wrappedTokensInfo = resp?.balances || [];
    } catch(e) { console.warn('Could not fetch wrapped balances for symbol resolution', e); }

    // Fetch all IBC denoms metadata to resolve Cosmos symbols
    let allIbcMetadata: any[] = [];
    try {
      const resp = await fetch(`${blockchain.endpoint.address}/cosmos/bank/v1beta1/denoms_metadata?_t=${Date.now()}`).then(r => r.json());
      allIbcMetadata = resp?.metadatas || [];
    } catch(e) { console.warn('Could not fetch IBC metadata', e); }

    // Process all tokens synchronously since we pre-fetched the metadata
    allTokens.forEach(t => {
      const contract = String(t.contractAddress);
      const contractLower = contract.toLowerCase();
      const chain = String(t.chainId).toLowerCase();
      
      // Try to determine decimals based on typical EVM/Cosmos native token footprints
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

      if (contractLower.startsWith('ibc') || chain.includes('osmosis') || chain.includes('cosmoshub') || chain.includes('injective')) {
        // Resolve IBC Metadata
        const match = allIbcMetadata.find(m => String(m.base).toLowerCase() === contractLower);
        if (match && match.symbol) {
           tokenObj.symbol = match.symbol;
        }
        tokenObj.type = 'ibc';
        ibcTemp.push(tokenObj);
      } else if (contractLower.startsWith('0x') || chain.includes('eth') || chain.includes('sepolia')) {
         // Resolve EVM symbol from wrappedTokenBalances response
         const match = wrappedTokensInfo.find((w: any) => String(w?.token_info?.contractAddress).toLowerCase() === contractLower);
         if (match && match.symbol) {
            tokenObj.symbol = match.symbol;
         }
         tokenObj.type = 'eth';
         ethTemp.push(tokenObj);
      } else {
        // Fallback guess based on format
        if (contract.length === 42) {
          tokenObj.type = 'eth';
          ethTemp.push(tokenObj);
        } else {
          tokenObj.type = 'ibc';
          ibcTemp.push(tokenObj);
        }
      }
    });

    supportedIbcTokens.value = ibcTemp;
    supportedEthTokens.value = ethTemp;

  } catch (err) {
    console.error('Failed to load supported deposit tokens for trade', err);
  }
}

async function loadWrappedTokenBalances() {
  if (!walletAddress.value) return;
  
  loading.value = true;
  error.value = '';
  
  try {
    // Fetch approved tokens and balances
    const [approvedTokensResp, balancesResp] = await Promise.all([
      blockchain.getApprovedTokensForTrade(),
      blockchain.getWrappedTokenBalances(walletAddress.value)
    ]);

    const approvedSet = new Set<string>();
    const nativeIbcTokens: any[] = [];

    // Collect native IBC entries — normalize denom to canonical uppercase hash
    const ibcEntries: { denom: string; chainId: string }[] = [];

    // Process approved tokens
    (approvedTokensResp?.approved_tokens || []).forEach((t: any) => {
      const chainId = String(t.chainId).toLowerCase();
      const contractOrDenom = String(t.contractAddress);
      
      // key for mapped/wrapped tokens
      approvedSet.add(`${chainId}|${contractOrDenom.toLowerCase()}`);

      // Check if it's a native IBC token
      if (contractOrDenom.toLowerCase().startsWith('ibc/')) {
        // Normalize to canonical format: ibc/ + UPPERCASE hash
        const hash = contractOrDenom.substring(4).toUpperCase();
        const canonicalDenom = `ibc/${hash}`;
        ibcEntries.push({ denom: canonicalDenom, chainId: t.chainId });
      }
    });

    // For each IBC token, fetch balance and metadata directly via REST (in parallel)
    await Promise.all(ibcEntries.map(async (entry) => {
      const denom = entry.denom;
      let amount = '0';
      let meta: any = null;

      // Fetch balance directly via bank module (query param — encodeURIComponent is correct here)
      try {
        const balUrl = `${blockchain.endpoint.address}/cosmos/bank/v1beta1/balances/${walletAddress.value}/by_denom?denom=${encodeURIComponent(denom)}&_t=${Date.now()}`;
        const balResp = await fetch(balUrl).then(r => r.json());
        if (balResp?.balance?.amount) {
          amount = balResp.balance.amount;
        }
      } catch (e) {
        console.warn(`Could not fetch balance for ${denom}`, e);
      }

      // Fetch denom metadata from chain (path segment — do NOT encodeURIComponent, the / must remain literal)
      try {
        const metaUrl = `${blockchain.endpoint.address}/cosmos/bank/v1beta1/denoms_metadata/${denom}?_t=${Date.now()}`;
        const metaResp = await fetch(metaUrl).then(r => r.json());
        if (metaResp?.metadata) {
          meta = metaResp.metadata;
        }
      } catch (e) {
        console.warn(`Could not fetch metadata for ${denom}`, e);
      }

      // Determine best display name and decimals
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

    // Combine wrapped and native tokens
    wrappedTokenBalances.value = [...nativeIbcTokens, ...filteredWrappedBalances];

    if (!wrappedTokenBalances.value.find(token => token.symbol === selectedWrappedToken.value)) {
      selectedWrappedToken.value = wrappedTokenBalances.value.length > 0 ? wrappedTokenBalances.value[0].symbol : 'USDT';
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load token balances';
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

  // Find selected token to get decimals
  const selectedToken = wrappedTokenBalances.value.find(t => t.symbol === selectedWrappedToken.value);
  const decimals = selectedToken?.decimals ?? 6;
  
  // Convert to base units
  const amountInBaseUnits = Math.floor(parseFloat(swapAmount.value) * Math.pow(10, decimals)).toString();

  calculating.value = true;
  error.value = '';
  
  try {
    const result = await blockchain.calculateTokensFromWrappedToken(
      poolInfo.value.address,
      amountInBaseUnits
    );
    
    if (result.data) {
      // Result is likely in base units (u128), we need to format it for display
      // GNK (output) uses 9 decimals from the pool contract calculation
      const outputBaseUnits = result.data.tokens ?? result.data.gnk_tokens ?? '0';
      const outputAmount = parseFloat(outputBaseUnits) / 1_000_000_000;
      
      estimatedOutput.value = outputAmount.toString();
      currentPrice.value = result.data.current_price;
      
      // Calculate price impact
      // Price is usually returned as "GNK per 1 InputToken" or similar ratio
      // If result.data.current_price is the rate, Expected = Input * Price
      // But let's trust the contract's output vs the theoretical price
      
      // Price Impact = (Theoretical Output - Actual Output) / Theoretical Output
      // Where Theoretical Output = Input * CurrentPrice
      // Note: current_price from contract might be "Input per 1 GNK" or "GNK per 1 Input". 
      // Let's rely on the simple heuristic used before, but updated for base units if needed.
      
      const price = parseFloat(result.data.current_price); // Rate
      if (price > 0) {
        const inputVal = parseFloat(swapAmount.value);
        // Assuming current_price is "GNK received per 1 unit of Input Token"
        // Theoretical = inputVal * price
        
        // However, if the previous code was: outputValue = parseFloat(result.data.gnk_tokens) / parseFloat(result.data.current_price)
        // That implies: gnk_tokens = Value in USD? No.

        // Let's stick to the previous impact logic but using the corrected values:
        // old logic: outputValue = gnk_tokens / price. 
        // This suggests 'gnk_tokens' was the amount, and 'price' was the rate?
        // Wait, if output = input * price, then input = output / price.
        // impact = (input - (output/price)) / input ?? This is confusing.

        // Standard Price Impact: 1 - (ActualPrice / MarketPrice)
        // Let's just calculate simplified impact based on expectation:
        // We know what we are getting: outputAmount (formatted)
        // We assume price is constant for small amounts.
        
        // Let's preserve the old logic's intent but use the formatted values
        // derived above.
        const outputValue = parseFloat(outputBaseUnits); 
        // If the previous logic worked, we can keep it, but we changed input to base units.
        // Let's assume the previous logic was just broken for this contract anyway if it was failing.
        
        // Let's just show the output for now and skip complex impact calculation if we are unsure of the formula.
        // Or better:
        const expectedOutput = parseFloat(swapAmount.value) * price;
        const actualOutput = outputAmount;
        
        // If price is "GNK per Input", then expected = input * price.
        // Impact = (Expected - Actual) / Expected * 100
        
        if (expectedOutput > 0) {
           const impact = ((expectedOutput - actualOutput) / expectedOutput) * 100;
           priceImpact.value = impact.toFixed(2);
        } else {
           priceImpact.value = '0.00';
        }
      }
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to calculate swap';
    console.error('Error calculating swap:', err);
    estimatedOutput.value = '';
    currentPrice.value = '';
    priceImpact.value = '';
  } finally {
    calculating.value = false;
  }
}


function handleAmountChange() {
  // Debounce calculation
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
    // Get the selected token contract address
    const selectedToken = wrappedTokenBalances.value.find(token => token.symbol === selectedWrappedToken.value);
    if (!selectedToken) {
      txError.value = `${selectedWrappedToken.value} token not found in wallet`;
      return;
    }

    // Show loading state
    calculating.value = true;
    txError.value = '';

    if (selectedToken.isNative) {
      // Execute Native IBC Swap
      const ibcDenom = selectedToken.full_denom;
      const amountInBaseUnits = Math.floor(parseFloat(swapAmount.value) * Math.pow(10, selectedToken.decimals)).toString();

      console.log('Executing native swap:', {
        denom: ibcDenom,
        poolAddress: poolInfo.value.address,
        amount: amountInBaseUnits
      });

      const result = await walletStore.executeNativeSwapDirect(
        ibcDenom,
        poolInfo.value.address,
        amountInBaseUnits
      );
       console.log('✅ Native Swap completed successfully:', result);

    } else {
      // Execute Legacy Wrapped Swap
      const wrappedContractAddress = selectedToken?.token_info?.wrappedContractAddress;
      if (!wrappedContractAddress) {
        txError.value = 'No contract address available for selected token';
        calculating.value = false;
        return;
      }
      
      // Convert amount to the token's base unit (considering decimals)
      const amountInBaseUnits = Math.floor(parseFloat(swapAmount.value) * Math.pow(10, selectedToken.decimals)).toString();
      
      console.log('Executing direct swap:', {
        wrappedContract: wrappedContractAddress,
        poolAddress: poolInfo.value.address,
        amount: amountInBaseUnits
      });
      
      const result = await walletStore.executeTokenSwapDirect(
        wrappedContractAddress,
        poolInfo.value.address,
        amountInBaseUnits
      );
      
      console.log('✅ Swap completed successfully:', result);
    }
    
    // Show success message
    txError.value = '';
    
    // Refresh balances
    await loadWrappedTokenBalances();
    // Also refresh wallet balances for native tokens
    await walletStore.loadMyAsset();
    
    // Clear form
    swapAmount.value = '';
    estimatedOutput.value = '';
    currentPrice.value = '';
    priceImpact.value = '';
    
  } catch (err) {
    txError.value = err instanceof Error ? err.message : 'Failed to execute swap';
    console.error('❌ Error executing swap:', err);
  } finally {
    // Hide loading state
    calculating.value = false;
  }
}

// Watchers
watch(walletAddress, (newAddress) => {
  if (newAddress) {
    loadWrappedTokenBalances();
  } else {
    wrappedTokenBalances.value = [];
  }
}, { immediate: true });

// Lifecycle
onMounted(() => {
  loadPoolInfo();
  loadSupportedDepositTokens();
  document.addEventListener('click', closeDropdowns);
});

import { onUnmounted } from 'vue';
onUnmounted(() => {
  document.removeEventListener('click', closeDropdowns);
});
</script>

<template>
  <div class="bg-base-100 rounded shadow">
    <div class="px-4 pt-4 pb-2 flex flex-col items-center">
      <div class="w-full flex items-center justify-between mb-4">
        <span class="text-lg font-semibold text-main">{{ $t('developer.liquidity_pool') }}</span>
        <span v-if="!shouldShowWidget" class="badge badge-outline badge-sm text-xs">
          {{ $t('developer.coming_soon') }}
        </span>
      </div>
      
      <!-- Toggle Tabs -->
      <div v-if="shouldShowWidget" class="w-full flex p-1 bg-gray-200 dark:bg-gray-800 rounded-lg">
        <button 
          class="flex-1 py-2 text-sm font-semibold rounded-md transition-colors"
          :class="activeTab === 'deposit' ? 'bg-primary text-white shadow-sm' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'"
          @click="activeTab = 'deposit'"
        >
          {{ $t('developer.deposit_tab') }}
        </button>
        <button 
          class="flex-1 py-2 text-sm font-semibold rounded-md transition-colors"
          :class="activeTab === 'purchase' ? 'bg-primary text-white shadow-sm' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'"
          @click="activeTab = 'purchase'"
        >
          {{ $t('developer.purchase_tab') }}
        </button>
      </div>
    </div>
    <div class="px-4 pb-4">
      <div v-if="!shouldShowWidget" class="bg-gray-100 dark:bg-[#373f59] rounded-sm px-4 py-6 flex items-center justify-center text-center">
        <div class="space-y-1">
          <div class="text-sm font-medium">{{ $t('developer.feature_unavailable') }}</div>
          <div class="text-xs text-gray-600 dark:text-gray-400">{{ $t('developer.coming_soon') }}</div>
        </div>
      </div>
      <template v-else>
      <!-- Loading State -->
      <div v-if="loading" class="bg-gray-100 dark:bg-[#373f59] rounded-sm px-4 py-3 h-20 flex items-center justify-center">
        <div class="text-center">
          <div class="loading loading-spinner loading-md"></div>
          <div class="text-sm mt-2">{{ $t('developer.loading_pool_info') }}</div>
        </div>
      </div>

      <!-- Error State -->
      <div v-else-if="error" class="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm px-4 py-3">
        <div class="text-red-600 dark:text-red-400 text-sm">{{ error }}</div>
        <button @click="loadPoolInfo" class="btn btn-sm btn-outline btn-error mt-2">
          {{ $t('developer.retry') }}
        </button>
      </div>

      <!-- Deposit Tab -->
      <div v-if="activeTab === 'deposit' && !loading && !error" class="space-y-4 mt-2">
        <div class="bg-gray-100 dark:bg-[#373f59] rounded-lg px-4 py-3" :class="{ 'pointer-events-none': allDepositTokens.length === 0 }">
          <div class="flex flex-col relative" :class="{ 'opacity-[0.4]': allDepositTokens.length === 0 }">
            <div v-if="allDepositTokens.length === 0" class="absolute inset-0 flex items-center justify-center z-10">
               <span class="bg-base-100 px-3 py-1 rounded text-sm font-semibold shadow-sm text-red-500 border border-red-200 dark:border-red-800">{{ $t('developer.no_approved_tokens') }}</span>
            </div>
            
            <div class="space-y-3">
              <!-- merged Input & Selector -->
              <div class="w-full">
                <div class="flex justify-between items-center mb-2">
                  <span class="text-sm font-semibold">{{ $t('developer.stable_coin') }}</span>
                </div>
                
                <div class="flex items-center space-x-2">
                  <!-- Input (70%) -->
                  <div class="w-[70%]">
                    <input
                      v-model="depositAmount"
                      type="number"
                      min="0"
                      step="0.01"
                      :placeholder="$t('developer.enter_amount')"
                      class="input input-bordered input-sm w-full bg-base-100"
                      :disabled="!isConnected"
                    />
                  </div>
                  
                  <!-- Dropdown (30%) -->
                  <div class="w-[30%] relative custom-dropdown">
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

                    <!-- Dropdown Content -->
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

        <!-- Processing Time / Wallet Status -->
        <div class="flex justify-center mt-2 mb-2">
          <div v-if="!isConnected" class="text-xs transition-colors duration-300 h-4 flex items-center text-red-500 dark:text-red-400 font-semibold gap-1">
            <Icon icon="mdi:alert-circle-outline" class="inline-block" /> {{ $t('developer.please_connect_wallet_first') }}
          </div>
          <div v-else class="text-xs transition-colors duration-300 h-4 flex items-center" :class="selectedDepositToken?.type === 'ibc' ? 'text-green-500 dark:text-green-400' : (selectedDepositToken?.type === 'eth' ? 'text-gray-500' : 'opacity-0')">
            <template v-if="selectedDepositToken?.type === 'ibc'">
              <Icon icon="mdi:clock-outline" class="inline-block mr-0.5" /> {{ $t('developer.processing_time_ibc') }}
            </template>
            <template v-else-if="selectedDepositToken?.type === 'eth'">
              <Icon icon="mdi:clock-outline" class="inline-block mr-0.5" /> {{ $t('developer.processing_time_eth') }}
            </template>
            <template v-else>
              Placeholder
            </template>
          </div>
        </div>

        <!-- Deposit Button -->
        <div class="pt-1">
          <button 
            class="btn btn-primary w-full" 
            :disabled="!selectedDepositToken || !depositAmount || parseFloat(depositAmount) <= 0 || calculating"
            @click="executeDeposit"
          >
            <Icon v-if="calculating" icon="mdi:loading" class="animate-spin mr-2" />
            {{ 
               !selectedDepositToken ? $t('developer.select_token_to_deposit') : 
               selectedDepositToken.type === 'ibc' ? $t('developer.deposit_via_ibc') : $t('developer.deposit_via_bridge') 
            }}
          </button>
          <div v-if="txError && activeTab === 'deposit'" class="text-xs text-red-500 text-center mt-2 px-2 overflow-hidden text-ellipsis whitespace-nowrap" :title="txError">{{ txError }}</div>
        </div>
      </div>

      <!-- Purchase Tab (Existing Swap Interface) -->
      <div v-else-if="activeTab === 'purchase' && !loading && !error" class="space-y-4 mt-2">

        <!-- Swap Interface -->
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
              <div class="w-[70%]">
                <input
                  v-model="swapAmount"
                  @input="handleAmountChange"
                  type="number"
                  :placeholder="$t('developer.enter_amount')"
                  class="input input-bordered input-sm w-full"
                  :disabled="!isConnected"
                />
              </div>
              
              <!-- Purchase Selector (30%) -->
              <div class="w-[30%] relative custom-dropdown">
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

          <!-- Swap Button -->
          <div class="pt-3">
            <button
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
      </div>
      </template>
    </div>
  </div>
</template>