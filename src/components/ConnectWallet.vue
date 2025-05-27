<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useWalletStore, useBlockchain, useDashboard } from '@/stores';
import { Icon } from '@iconify/vue';
import { CosmosRestClient } from '@/libs/client';

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

// Parse wallet params if provided
const walletOptions = computed(() => {
  // Always return only Keplr and Leap, ignoring params
  return ['keplr', 'leap'];
});

// Check if wallet is available
const isWalletAvailable = (wallet: string) => {
  switch (wallet) {
    case 'keplr':
      return !!window.keplr;
    case 'leap':
      return !!window.leap;
    default:
      return false;
  }
};

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
      await window.keplr.experimentalSuggestChain(config);
    } else if (wallet === 'leap') {
      if (!window.leap) throw new Error('Leap wallet not found');
      await window.leap.experimentalSuggestChain(config);
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
      const chainInfo = await window.keplr.getChainInfo(props.chainId);
      return !!chainInfo;
    } else if (wallet === 'leap') {
      if (!window.leap) throw new Error('Leap wallet not found');
      const chainInfo = await window.leap.getChainInfo(props.chainId);
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

    // Check if chain exists in wallet
    const chainExists = await checkChainExists(wallet);
    
    // If chain doesn't exist, suggest it
    if (!chainExists) {
      const suggested = await suggestChain(wallet);
      if (!suggested) {
        throw new Error('Failed to add chain to wallet');
      }
    }

    // Proceed with wallet connection
    switch (wallet) {
      case 'keplr':
        if (!window.keplr) throw new Error('Keplr wallet not found');
        await window.keplr.enable(props.chainId);
        const offlineSigner = window.keplr.getOfflineSigner(props.chainId);
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
        await window.leap.enable(props.chainId);
        const leapSigner = window.leap.getOfflineSigner(props.chainId);
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
function openModal() {
  showModal.value = true;
}

// Close modal
function closeModal() {
  showModal.value = false;
  error.value = '';
  selectedWallet.value = '';
}

// Initialize chain config when component is mounted
onMounted(async () => {
  await initChainConfig();
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
          <span class="capitalize">{{ wallet }}</span>
          <span v-if="!isWalletAvailable(wallet)" class="text-xs text-error ml-2">
            (Not installed)
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