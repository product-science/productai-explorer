<script lang="ts" setup>
import { ref, computed, watch, onMounted } from 'vue';
import { useBlockchain, useWalletStore, useFormatter } from '@/stores';
import { Icon } from '@iconify/vue';

const props = defineProps<{
  chain: string;
}>();

const blockchain = useBlockchain();
const walletStore = useWalletStore();
const format = useFormatter();

// State
const poolInfo = ref<any>(null);
const wrappedTokenBalances = ref<any[]>([]);
const loading = ref(false);
const calculating = ref(false);
const error = ref<string>('');
const calculationTimeout = ref<number | null>(null);

// Form data
const swapAmount = ref<string>('');
const estimatedOutput = ref<string>('');
const currentPrice = ref<string>('');
const priceImpact = ref<string>('');
const selectedWrappedToken = ref<string>('USDT');

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

async function loadWrappedTokenBalances() {
  if (!walletAddress.value) return;
  
  loading.value = true;
  error.value = '';
  
  try {
    // Fetch approved tokens and balances, then filter balances to approved set only
    const [approvedTokensResp, balancesResp] = await Promise.all([
      blockchain.getApprovedTokensForTrade(),
      blockchain.getWrappedTokenBalances(walletAddress.value)
    ]);

    const approvedSet = new Set(
      (approvedTokensResp?.approved_tokens || []).map((t: any) =>
        `${String(t.chainId).toLowerCase()}|${String(t.contractAddress).toLowerCase()}`
      )
    );

    const allBalances = balancesResp?.balances || [];
    wrappedTokenBalances.value = allBalances.filter((b: any) => {
      const info = b?.token_info || {};
      const key = `${String(info.chainId || '').toLowerCase()}|${String(info.contractAddress || '').toLowerCase()}`;
      return approvedSet.has(key);
    });

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

  calculating.value = true;
  error.value = '';
  
  try {
    const result = await blockchain.calculateTokensFromWrappedToken(
      poolInfo.value.address,
      String(swapAmount.value)
    );
    
    if (result.data) {
      estimatedOutput.value = result.data.tokens ?? result.data.aic_tokens ?? '';
      currentPrice.value = result.data.current_price;
      // Calculate price impact (simplified)
      const inputValue = parseFloat(swapAmount.value);
      const outputValue = parseFloat(result.data.aic_tokens) / parseFloat(result.data.current_price);
      const impact = ((inputValue - outputValue) / inputValue) * 100;
      priceImpact.value = impact.toFixed(2);
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
      error.value = `${selectedWrappedToken.value} token not found in wallet`;
      return;
    }
    const wrappedContractAddress = selectedToken?.token_info?.wrappedContractAddress;
    if (!wrappedContractAddress) {
      error.value = 'No contract address available for selected token';
      return;
    }
    
    // Convert amount to the token's base unit (considering decimals)
    const amountInBaseUnits = Math.floor(parseFloat(swapAmount.value) * Math.pow(10, selectedToken.decimals)).toString();
    
    console.log('Executing direct swap:', {
      wrappedContract: wrappedContractAddress,
      poolAddress: poolInfo.value.address,
      amount: amountInBaseUnits
    });
    
    // Show loading state
    calculating.value = true;
    error.value = '';
    
    // Execute the swap directly without dialog
    const result = await walletStore.executeTokenSwapDirect(
      wrappedContractAddress,
      poolInfo.value.address,
      amountInBaseUnits
    );
    
    console.log('✅ Swap completed successfully:', result);
    
    // Show success message
    error.value = '';
    
    // Refresh balances
    await loadWrappedTokenBalances();
    
    // Clear form
    swapAmount.value = '';
    estimatedOutput.value = '';
    currentPrice.value = '';
    priceImpact.value = '';
    
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to execute swap';
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
});
</script>

<template>
  <div class="bg-base-100 rounded shadow">
    <div class="px-4 pt-4 pb-2 text-lg font-semibold text-main">
      {{ $t('developer.liquidity_pool') }}
    </div>
    <div class="px-4 pb-4">
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
          Retry
        </button>
      </div>

      <!-- Main Content -->
      <div v-else class="space-y-4">

        <!-- Swap Interface -->
        <div class="space-y-3">
          <!-- From Token -->
          <div class="bg-gray-100 dark:bg-[#373f59] rounded-sm px-4 py-3">
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
              <div class="flex-1">
                <input
                  v-model="swapAmount"
                  @input="handleAmountChange"
                  type="number"
                  :placeholder="$t('developer.enter_amount')"
                  class="input input-bordered input-sm w-full"
                  :disabled="!isConnected"
                />
              </div>
              <div>
                <select
                  v-model="selectedWrappedToken"
                  class="select select-bordered select-sm"
                  :disabled="!isConnected"
                >
                  <option
                    v-for="token in wrappedTokenBalances"
                    :key="token.symbol"
                    :value="token.symbol"
                  >
                    {{ token.symbol }}
                  </option>
                </select>
              </div>
            </div>
          </div>

          <!-- Swap Arrow -->
          <div class="flex justify-center">
            <Icon icon="mdi:arrow-down" class="text-2xl text-gray-400" />
          </div>

          <!-- To Token -->
          <div class="bg-gray-100 dark:bg-[#373f59] rounded-sm px-4 py-3">
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
              <div class="text-sm font-semibold text-secondary">AIC</div>
            </div>
          </div>

          <!-- Swap Button -->
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

          <!-- Validation Messages -->
          <div v-if="swapAmount && (() => {
            const token = wrappedTokenBalances.find(t => t.symbol === selectedWrappedToken);
            return token ? parseFloat(swapAmount) > parseFloat(token.formatted_balance) : false;
          })()" class="text-red-500 text-sm text-center">
            {{ $t('developer.insufficient_balance') }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>