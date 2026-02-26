<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useWalletStore, useBlockchain, useDashboard } from '@/stores';
import { Icon } from '@iconify/vue';
import { CosmosRestClient } from '@/libs/client';

// TypeScript declarations for wallet objects
declare global {
  interface Window {
    // @ts-ignore
    keplr?: any;
    // @ts-ignore
    leap?: any;
    ethereum?: {
      request: (params: { method: string; params?: any }) => Promise<any>;
      isMetaMask?: boolean;
    };
    cosmos?: any;
    cosmsnap?: any;
    okex?: any;
    unisat?: any;
  }
}

const props = defineProps<{
  chainId: string;
  hdPath: string;
  addrPrefix?: string;
  params?: string;
}>();

const emit = defineEmits<{
  (e: 'connect', value: any): void;
  (e: 'keplr-config'): void;
}>();

const walletStore = useWalletStore();
const chainStore = useBlockchain();
const dashboard = useDashboard();
const showModal = ref(false);
const selectedWallet = ref('');
const error = ref('');
const chainConfig = ref('');
const metamaskSnapInstalled = ref(false);

// Parse wallet params if provided
const walletOptions = computed(() => {
  // Parse params if provided
  if (props.params) {
    try {
      const parsedParams = JSON.parse(props.params);
      if (parsedParams.wallet && Array.isArray(parsedParams.wallet)) {
        return parsedParams.wallet;
      }
    } catch (e) {
      console.warn('Failed to parse wallet params:', e);
    }
  }
  
  // Default wallets if no params or parsing failed
  return ['keplr', 'leap'];
});

// Check if wallet is available
const isWalletAvailable = (wallet: string) => {
  try {
    switch (wallet) {
      case 'keplr':
        // Check if keplr exists and has the required methods, and is the real Keplr wallet
        return !!(window.keplr && 
          typeof (window.keplr as any).enable === 'function' && 
          typeof (window.keplr as any).getOfflineSigner === 'function' &&
          (window.keplr as any).ethereum?.isKeplr);
      case 'leap':
        // Check if leap exists and has the required methods
        return !!(window.leap && 
          typeof (window.leap as any).enable === 'function' && 
          typeof (window.leap as any).getOfflineSigner === 'function' &&
          (window.leap as any).ethereum?.isLeap);
      case 'metamask':
        return !!window.ethereum;
      default:
        return false;
    }
  } catch (error) {
    console.warn(`Error checking wallet availability for ${wallet}:`, error);
    return false;
  }
};

// Check if MetaMask supports snaps
async function isMetaMaskSnapsSupported(): Promise<boolean> {
  try {
    if (!window.ethereum) return false;
    
    // Method 1: Try wallet_getSnaps (works in Flask and newer MetaMask)
    try {
      const snaps = await window.ethereum.request({
        method: 'wallet_getSnaps',
        params: []
      });
      console.log('wallet_getSnaps successful, snaps supported');
      return typeof snaps === 'object';
    } catch (error: any) {
      console.log('wallet_getSnaps not available:', error.message);
    }
    
    // Method 2: If it's MetaMask, assume it might support snaps
    // The web3_clientVersion doesn't reflect the actual Chrome extension version
    if (window.ethereum.isMetaMask) {
      console.log('MetaMask detected - assuming snap support (will test during installation)');
      return true;
    }
    
    return false;
  } catch (error: any) {
    console.log('MetaMask snaps support check failed:', error);
    return false;
  }
}

// Check if MetaMask Cosmos snap is installed
async function isCosmosSnapInstalled(): Promise<boolean> {
  try {
    if (!window.ethereum) return false;
    
    // Method 1: Try wallet_getSnaps API
    try {
      const snaps = await window.ethereum.request({
        method: 'wallet_getSnaps',
        params: []
      });
      
      // Check for various possible snap IDs
      const possibleSnapIds = [
        'npm:@cosmsnap/snap',
        '@cosmsnap/snap',
        'cosmsnap'
      ];
      
      const installedSnaps = Object.keys(snaps);
      console.log('Installed snaps:', installedSnaps);
      
      return possibleSnapIds.some(snapId => installedSnaps.includes(snapId));
    } catch (error: any) {
      console.log('wallet_getSnaps failed, trying alternative methods:', error.message);
    }
    
    // Method 2: Try to invoke the snap directly (if it exists, this should work)
    try {
      await window.ethereum.request({
        method: 'wallet_invokeSnap',
        params: {
          snapId: 'npm:@cosmsnap/snap',
          request: {
            method: 'initialized',
          },
        },
      });
      console.log('Cosmos snap detected via direct invoke');
      return true;
    } catch (error: any) {
      console.log('Direct snap invoke failed:', error.message);
    }
    
    // Method 3: Check for cosmos-specific injected objects (some snaps inject their own objects)
    if (window.cosmos || (window as any).cosmsnap) {
      console.log('Cosmos snap detected via injected objects');
      return true;
    }
    
    return false;
  } catch (error) {
    console.error('Error checking Cosmos snap:', error);
    return false;
  }
}

// Install MetaMask Cosmos snap
async function installCosmosSnap(): Promise<boolean> {
  try {
    if (!window.ethereum) throw new Error('MetaMask not found');
    
    // Try the snap installation API directly
    console.log('Attempting to install Cosmos snap...');
    
    try {
      await window.ethereum.request({
        method: 'wallet_requestSnaps',
        params: {
          'npm:@cosmsnap/snap': {
            version: '^0.1.0',
          },
        },
      });
      
      console.log('Cosmos snap installation successful, initializing...');
      
      // Initialize the snap with default chains
      await window.ethereum.request({
        method: 'wallet_invokeSnap',
        params: {
          snapId: 'npm:@cosmsnap/snap',
          request: {
            method: 'initialize',
          },
        },
      });
      
      console.log('Cosmos snap initialized successfully');
      return true;
    } catch (snapError: any) {
      console.log('Snap installation failed:', snapError);
      
      if (snapError.message?.includes('does not exist') || snapError.message?.includes('not available')) {
        // Snap APIs not available - might be older MetaMask
        throw new Error('Snap APIs not available. Please install the Cosmos snap manually from: https://snaps.metamask.io/snap/npm/cosmsnap/snap/ or update MetaMask to the latest version.');
      }
      
      throw snapError;
    }
  } catch (error: any) {
    if (error.code === 4001) {
      throw new Error('User rejected the Cosmos snap installation');
    }
    
    console.error('Error installing Cosmos snap:', error);
    throw new Error(error.message || 'Failed to install Cosmos snap');
  }
}

// Add chain to MetaMask Cosmos snap
async function addChainToCosmosSnap(): Promise<boolean> {
  try {
    const chain = chainStore.current;
    if (!chain) throw new Error('No chain selected');
    
    // Convert our chain config to chain registry format
    const chainInfo = {
      chain_name: chain.chainName.toLowerCase().replace(/\s+/g, ''),
      chain_id: props.chainId,
      pretty_name: chain.chainName,
      status: 'live',
      network_type: 'mainnet',
      bech32_prefix: chain.bech32Prefix,
      daemon_name: 'gaiad', // Generic daemon name
      node_home: '$HOME/.gaia',
      key_algos: ['secp256k1'],
      slip44: Number(chain.coinType),
      fees: {
        fee_tokens: [{
          denom: chain.assets[0].base,
          fixed_min_gas_price: chain.keplrPriceStep?.low || 0.01,
          low_gas_price: chain.keplrPriceStep?.low || 0.01,
          average_gas_price: chain.keplrPriceStep?.average || 0.025,
          high_gas_price: chain.keplrPriceStep?.high || 0.03,
        }]
      },
      staking: {
        staking_tokens: [{
          denom: chain.assets[0].base,
        }]
      },
      codebase: {
        git_repo: 'https://github.com/cosmos/gaia',
        recommended_version: 'v7.0.0',
        compatible_versions: ['v7.0.0'],
      },
      apis: {
        rpc: chain.endpoints?.rpc?.map(rpc => ({ 
          address: rpc.address,
          provider: rpc.provider || 'unknown'
        })) || [],
        rest: chain.endpoints?.rest?.map(rest => ({ 
          address: rest.address,
          provider: rest.provider || 'unknown'
        })) || [],
      }
    };
    
    await window.ethereum?.request({
      method: 'wallet_invokeSnap',
      params: {
        snapId: 'npm:@cosmsnap/snap',
        request: {
          method: 'addChain',
          params: {
            chain_info: JSON.stringify(chainInfo),
          }
        },
      },
    });
    
    return true;
  } catch (error) {
    console.error('Error adding chain to Cosmos snap:', error);
    return false;
  }
}

// Get address from MetaMask Cosmos snap
async function getCosmosSnapAddress(): Promise<string> {
  try {
    const address = await window.ethereum?.request({
      method: 'wallet_invokeSnap',
      params: {
        snapId: 'npm:@cosmsnap/snap',
        request: {
          method: 'getChainAddress',
          params: {
            chain_id: props.chainId,
          }
        },
      },
    });
    
    return address;
  } catch (error) {
    console.error('Error getting address from Cosmos snap:', error);
    throw error;
  }
}

// Initialize chain configuration
async function initChainConfig() {
  const chain = chainStore.current;
  if (!chain?.endpoints?.rest?.at(0)) throw new Error("Endpoint not set");
  
  const client = CosmosRestClient.newDefault(chain.endpoints.rest[0].address);
  const b = await client.getBaseBlockLatest();
  const chainid = b.block.header.chain_id;

  const gasPriceStep = chain.keplrPriceStep || {
    low: 0.01,
    average: 0.025,
    high: 0.03,
  };
  
  const coinDecimals = chain.assets[0].denom_units.find(
    x => x.denom === chain.assets[0].symbol.toLowerCase()
  )?.exponent || 6;

  chainConfig.value = JSON.stringify({
    chainId: chainid,
    chainName: chain.chainName,
    rpc: chain.endpoints?.rpc?.at(0)?.address,
    rest: chain.endpoints?.rest?.at(0)?.address,
    bip44: {
      coinType: Number(chain.coinType),
    },
    coinType: Number(chain.coinType),
    bech32Config: {
      bech32PrefixAccAddr: chain.bech32Prefix,
      bech32PrefixAccPub: `${chain.bech32Prefix}pub`,
      bech32PrefixValAddr: `${chain.bech32Prefix}valoper`,
      bech32PrefixValPub: `${chain.bech32Prefix}valoperpub`,
      bech32PrefixConsAddr: `${chain.bech32Prefix}valcons`,
      bech32PrefixConsPub: `${chain.bech32Prefix}valconspub`,
    },
    currencies: [
      {
        coinDenom: chain.assets[0].symbol,
        coinMinimalDenom: chain.assets[0].base,
        coinDecimals,
        coinGeckoId: chain.assets[0].coingecko_id || 'unknown',
      },
    ],
    feeCurrencies: [
      {
        coinDenom: chain.assets[0].symbol,
        coinMinimalDenom: chain.assets[0].base,
        coinDecimals,
        coinGeckoId: chain.assets[0].coingecko_id || 'unknown',
        gasPriceStep,
      },
    ],
    gasPriceStep,
    stakeCurrency: {
      coinDenom: chain.assets[0].symbol,
      coinMinimalDenom: chain.assets[0].base,
      coinDecimals,
      coinGeckoId: chain.assets[0].coingecko_id || 'unknown',
    },
    features: chain.keplrFeatures || [],
  });
}

// Suggest chain to wallet
async function suggestChain(wallet: string) {
  try {
    const config = JSON.parse(chainConfig.value);
    
    if (wallet === 'keplr') {
      if (!window.keplr) throw new Error('Keplr wallet not found');
      await (window.keplr as any).experimentalSuggestChain(config);
    } else if (wallet === 'leap') {
      if (!window.leap) throw new Error('Leap wallet not found');
      await (window.leap as any).experimentalSuggestChain(config);
    }
    
    return true;
  } catch (e: any) {
    error.value = e.message || 'Failed to suggest chain to wallet';
    console.error('Chain suggestion error:', e);
    return false;
  }
}

// Check if chain exists in wallet
async function checkChainExists(wallet: string): Promise<boolean> {
  try {
    if (wallet === 'keplr') {
      if (!window.keplr) throw new Error('Keplr wallet not found');
      const chainInfo = await (window.keplr as any).getChainInfo(props.chainId);
      return !!chainInfo;
    } else if (wallet === 'leap') {
      if (!window.leap) throw new Error('Leap wallet not found');
      const chainInfo = await (window.leap as any).getChainInfo(props.chainId);
      return !!chainInfo;
    }
    return false;
  } catch {
    return false;
  }
}

// Connect to selected wallet
async function connectWallet(wallet: string) {
  try {
    selectedWallet.value = wallet;
    error.value = '';

    // Initialize chain config if not already done
    if (!chainConfig.value) {
      await initChainConfig();
    }

    // Proceed with wallet connection
    switch (wallet) {
      case 'keplr':
        if (!window.keplr) throw new Error('Keplr wallet not found');
        
        // Check if chain exists in wallet
        const keplrChainExists = await checkChainExists(wallet);
        
        // If chain doesn't exist, suggest it
        if (!keplrChainExists) {
          const suggested = await suggestChain(wallet);
          if (!suggested) {
            throw new Error('Failed to add chain to wallet');
          }
        }
        
        await (window.keplr as any).enable(props.chainId);
        const offlineSigner = (window.keplr as any).getOfflineSigner(props.chainId);
        const accounts = await offlineSigner.getAccounts();
        emit('connect', {
          detail: {
            value: {
              wallet: 'keplr',
              cosmosAddress: accounts[0].address,
              hdPath: props.hdPath
            }
          }
        });
        break;

      case 'leap':
        if (!window.leap) throw new Error('Leap wallet not found');
        
        // Check if chain exists in wallet
        const leapChainExists = await checkChainExists(wallet);
        
        // If chain doesn't exist, suggest it
        if (!leapChainExists) {
          const suggested = await suggestChain(wallet);
          if (!suggested) {
            throw new Error('Failed to add chain to wallet');
          }
        }
        
        await (window.leap as any).enable(props.chainId);
        const leapSigner = (window.leap as any).getOfflineSigner(props.chainId);
        const leapAccounts = await leapSigner.getAccounts();
        emit('connect', {
          detail: {
            value: {
              wallet: 'leap',
              cosmosAddress: leapAccounts[0].address,
              hdPath: props.hdPath
            }
          }
        });
        break;

      case 'metamask':
        if (!window.ethereum) throw new Error('MetaMask not found');
        
        // Re-check if Cosmos snap is installed (in case status is stale)
        let snapInstalled = await isCosmosSnapInstalled();
        
        if (!snapInstalled) {
          // Try to install the Cosmos snap
          try {
            await installCosmosSnap();
            // Update the snap installation status
            metamaskSnapInstalled.value = true;
            snapInstalled = true;
          } catch (e: any) {
            // If installation fails due to API unavailability, provide helpful guidance
            if (e.message?.includes('snaps.metamask.io')) {
              throw new Error(e.message);
            }
            throw new Error(e.message || 'Failed to install Cosmos snap for MetaMask');
          }
        } else {
          // Update the reactive status if it was wrong
          metamaskSnapInstalled.value = true;
        }
        
        // Add chain to the snap if needed
        try {
          await addChainToCosmosSnap();
        } catch (e) {
          // Chain might already exist, continue
          console.log('Chain may already exist in snap:', e);
        }
        
        // Get the address for this chain
        const metamaskAddress = await getCosmosSnapAddress();
        emit('connect', {
          detail: {
            value: {
              wallet: 'metamask',
              cosmosAddress: metamaskAddress,
              hdPath: props.hdPath
            }
          }
        });
        break;

      default:
        throw new Error(`Unsupported wallet: ${wallet}`);
    }

    showModal.value = false;
  } catch (e: any) {
    error.value = e.message || 'Failed to connect wallet';
    console.error('Wallet connection error:', e);
  }
}

// Open modal
async function openModal() {
  showModal.value = true;
  // Check MetaMask snap status when opening modal
  await checkMetaMaskSnapStatus();
}

// Close modal
function closeModal() {
  showModal.value = false;
  error.value = '';
  selectedWallet.value = '';
}

// Get wallet display name
function getWalletDisplayName(wallet: string): string {
  switch (wallet) {
    case 'keplr':
      return 'Keplr';
    case 'leap':
      return 'Leap';
    case 'metamask':
      return 'MetaMask';
    default:
      return wallet;
  }
}

// Get wallet status message
function getWalletStatusMessage(wallet: string): string {
  if (!isWalletAvailable(wallet)) {
    return '(Not installed)';
  }
  
  if (wallet === 'metamask' && !metamaskSnapInstalled.value) {
    return '(Requires Cosmos snap)';
  }
  
  return '';
}

// Check and update MetaMask snap installation status
async function checkMetaMaskSnapStatus() {
  if (isWalletAvailable('metamask')) {
    const snapsSupported = await isMetaMaskSnapsSupported();
    if (snapsSupported) {
      metamaskSnapInstalled.value = await isCosmosSnapInstalled();
    } else {
      metamaskSnapInstalled.value = false;
    }
    console.log('MetaMask snap status:', {
      snapsSupported,
      snapInstalled: metamaskSnapInstalled.value,
      message: snapsSupported ? 'Snaps supported' : 'Snaps not supported - may need MetaMask update'
    });
  }
}

// Initialize chain config when component is mounted
onMounted(async () => {
  await initChainConfig();
  await checkMetaMaskSnapStatus();
});

// Expose methods
defineExpose({
  openModal,
  closeModal
});
</script>

<template>
  <!-- Modal -->
  <div v-if="showModal" class="modal modal-open">
    <div class="modal-box relative">
      <button class="btn btn-sm btn-circle absolute right-2 top-2" @click="closeModal">✕</button>
      <h3 class="font-bold text-lg mb-4">Connect Wallet</h3>
      
      <!-- Error message -->
      <div v-if="error" class="alert alert-error mb-4">
        <Icon icon="mdi:alert-circle" class="text-xl" />
        <span>{{ error }}</span>
      </div>

      <!-- Wallet options -->
      <div class="grid grid-cols-1 gap-4">
        <button
          v-for="wallet in walletOptions"
          :key="wallet"
          class="btn btn-outline justify-start"
          :class="{ 'btn-disabled': !isWalletAvailable(wallet) }"
          @click="connectWallet(wallet)"
        >
          <img 
            :src="`/wallets/${wallet}.svg`" 
            :alt="wallet"
            class="w-6 h-6 mr-2"
          />
          <span>{{ getWalletDisplayName(wallet) }}</span>
          <span v-if="getWalletStatusMessage(wallet)" class="text-xs text-warning ml-2">
            {{ getWalletStatusMessage(wallet) }}
          </span>
        </button>
      </div>
    </div>
    <label class="modal-backdrop" @click="closeModal">Close</label>
  </div>

  <!-- Hidden trigger button -->
  <label id="PingConnectWallet" class="hidden" @click="openModal"></label>
</template>

<style scoped>
.modal {
  @apply fixed inset-0 z-50 flex items-center justify-center;
}

.modal-box {
  @apply bg-base-100 rounded-lg shadow-lg p-6 max-w-md w-full mx-4;
}

.modal-backdrop {
  @apply fixed inset-0 bg-black bg-opacity-50;
}

.btn-outline {
  @apply border-2 border-base-300 hover:border-white hover:bg-[#373f59] hover:text-white transition-colors duration-200;
}

.btn-disabled {
  @apply opacity-50 cursor-not-allowed hover:bg-transparent hover:border-base-300;
}

/* Wallet button specific styles */
.wallet-button {
  @apply w-full text-left px-4 py-3 rounded-lg transition-colors duration-200;
}

.wallet-button:not(.btn-disabled):hover {
  @apply bg-[#373f59] border-white;
}

.wallet-button.btn-disabled:hover {
  @apply bg-transparent border-base-300;
}
</style> 