<script lang="ts" setup>
import {
    useValidatorStore,
    useFormatter,
    useTxDialog,
    useInferenceStore,
} from '@/stores';

import { Icon } from '@iconify/vue';
import CardStatisticsVertical from '@/components/CardStatisticsVertical.vue';
import ModelPerformanceChart from '@/components/charts/ModelPerformanceChart.vue';
import { ref, computed, watch, onMounted } from 'vue';
import { useWalletStore, useBaseStore, useBlockchain } from '@/stores';
import type ConnectWallet from '@/components/ConnectWallet.vue';
import { useQRCode } from '@vueuse/integrations/useQRCode';

const props = defineProps(['chain']);

const validatorStore = useValidatorStore();
const inferenceStore = useInferenceStore();
const walletStore = useWalletStore();
const baseStore = useBaseStore();
const blockchain = useBlockchain();
const format = useFormatter();
const dialog = useTxDialog();

// Wallet connection modal
const connectWalletRef = ref<InstanceType<typeof ConnectWallet> | null>(null);

// Initialize inference store on component mount
onMounted(() => {
  inferenceStore.init();
});

// Use real models data from the inference store

// QR code for wallet address - fixed implementation
const qrCodeSource = ref('');
const qrcode = useQRCode(qrCodeSource, {
  logo: '/logos/gonka-mainnet/logo-small.svg',
  logoOptions: {
    width: 40,
    height: 40,
    margin: 4,
  },
  errorCorrectionLevel: 'H',
  margin: 2,
});
const walletAddress = ref<string>('');

// Watch for address changes and update QR code
watch(() => walletStore.currentAddress, (newAddress) => {
  walletAddress.value = newAddress || '';
  qrCodeSource.value = newAddress || '';
}, { immediate: true });

// Wallet state change handler
async function walletStateChange(res: any) {
  try {
    if (res?.detail?.value) {
      // Add a small delay to ensure the modal is properly closed first
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

// Open connect wallet modal
function openConnectWallet() {
  try {
    connectWalletRef.value?.openModal();
  } catch (error) {
    console.error('Error opening wallet modal:', error);
  }
}

// Copy address to clipboard
let showCopyToast = ref(0);
async function copyAddress(address: string) {
  try {
    await navigator.clipboard.writeText(address);
    showCopyToast.value = 1;
    setTimeout(() => {
      showCopyToast.value = 0;
    }, 1000);
  } catch (err) {
    showCopyToast.value = 2;
    setTimeout(() => {
      showCopyToast.value = 0;
    }, 1000);
  }
}

const tipMsg = computed(() => {
  return showCopyToast.value === 2
    ? { class: 'error', msg: 'Copy Error!' }
    : { class: 'success', msg: 'Copy Success!' };
});

// From index.vue for account control
const change = computed(() => {
  const token = walletStore.balanceOfStakingToken;
  return token ? format.priceChanges(token.denom) : 0;
});
const color = computed(() => {
  switch (true) {
    case change.value > 0:
      return 'text-green-600';
    case change.value === 0:
      return 'text-grey-500';
    case change.value < 0:
      return 'text-red-600';
  }
});

function updateState() {
  walletStore.loadMyAsset()
}
</script>

<template>
<div>
  <!-- First Row: Statistics Cards -->
  <div class="grid gap-4 grid-cols-[repeat(auto-fit,minmax(265px,1fr))] mt-4">
    <CardStatisticsVertical
      :title="$t('inference.inferences_today')"
      icon="mdi:robot-outline"
      :stats="inferenceStore.displayInferencesToday"
      color="primary"
      subSymbol="24h"
      :hint="$t('inference.hints.inferences_today')"
    />
    <CardStatisticsVertical
      :title="$t('inference.inferences_last_week')"
      icon="mdi:robot"
      :stats="inferenceStore.displayInferencesLastWeek"
      color="success"
      subSymbol="7d"
      :hint="$t('inference.hints.inferences_last_week')"
    />
    <CardStatisticsVertical
      :title="$t('inference.ai_tokens_today')"
      icon="mdi:alpha-t-box-outline"
      :stats="inferenceStore.displayAiTokensToday"
      color="warning"
      subSymbol="24h"
      :hint="$t('inference.hints.ai_tokens_today')"
    />
    <CardStatisticsVertical
      :title="$t('inference.ai_tokens_last_week')"
      icon="mdi:alpha-t-box"
      :stats="inferenceStore.displayAiTokensLastWeek"
      color="info"
      subSymbol="7d"
      :hint="$t('inference.hints.ai_tokens_last_week')"
    />
  </div>

  <!-- Second Row: Statistics per Model Table -->
  <div class="bg-base-100 rounded mt-4 shadow">
      <div class="px-4 pt-4 pb-2 text-lg font-semibold text-main">
          Statistics per Model
      </div>
      <div class="px-4 pb-4">
          <div class="overflow-x-auto">
              <table class="table table-compact w-full table-zebra">
                  <thead>
                      <tr>
                          <th>{{ $t('inference.model') }}</th>
                          <th>{{ $t('inference.quantization') }}</th>
                          <th>{{ $t('inference.context') }}</th>
                          <th>{{ $t('inference.input_price') }}</th>
                          <th>{{ $t('inference.output_price') }}</th>
                          <!-- <th>{{ $t('inference.max_throughput') }}</th> -->
                          <!-- <th>{{ $t('inference.latency') }}</th> -->
                      </tr>
                  </thead>
                  <tbody>
                      <tr v-for="(model, index) in inferenceStore.models" :key="index">
                          <td>{{ model.id }}</td>
                          <td>{{ model.quantization || '-' }}</td>
                          <td>{{ model.context_window || '-' }}</td>
                          <td>{{ model.coins_per_input_token || '0' }}</td>
                          <td>{{ model.coins_per_output_token || '0' }}</td>
                          <!-- <td>{{ model.maxThroughput }}</td> -->
                          <!-- <td>{{ model.latency }}</td> -->
                      </tr>
                  </tbody>
              </table>
              <div v-if="inferenceStore.models.length === 0" class="text-center py-8 text-gray-500">
                  {{ $t('inference.no_models') }}
              </div>
          </div>
      </div>
  </div>

  <!-- Fourth Row: Model Performance Chart -->
  <div class="bg-base-100 rounded mt-4 shadow">
      <div class="px-4 pt-4 pb-2 text-lg font-semibold text-main">
          Tokens processed per day
      </div>
      <div class="px-4 pb-4">
          <ModelPerformanceChart />
      </div>
  </div>
</div>
</template>

<route>
  {
    meta: {
      i18n: 'inference',
      order: 4,
      descriptionKey: 'inference.meta_description'
    }
  }
</route>

<style>
.inference-table.table :where(th, td) {
    padding: 8px 5px;
    background: transparent;
}
</style> 