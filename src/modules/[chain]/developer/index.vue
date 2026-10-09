<script lang="ts" setup>
import {
    useValidatorStore,
    useFormatter,
    useTxDialog,
    useInferenceStore,
} from '@/stores';

import { Icon } from '@iconify/vue';
import CardStatisticsVertical from '@/components/CardStatisticsVertical.vue';
import { ref, computed, watch, onMounted } from 'vue';
import { useWalletStore, useBaseStore, useBlockchain } from '@/stores';
import ExchangeWidget from '@/components/ExchangeWidget.vue';

const props = defineProps(['chain']);

const validatorStore = useValidatorStore();
const walletStore = useWalletStore();
const baseStore = useBaseStore();
const blockchain = useBlockchain();
const format = useFormatter();
const dialog = useTxDialog();
const inferenceStore = useInferenceStore();

// Mock data for developer statistics - replace with actual data sources
const aiTokensLastWeek = computed(() => inferenceStore.displayAiTokensLastWeek);
const globalUsers = computed(() => validatorStore.displayParticipantsCount);
const activeProviders = computed(() => validatorStore.displayActiveProviders);
const models = computed(() => {
  if (inferenceStore.loading) return '...';
  if (inferenceStore.error) return 'Error';
  return inferenceStore.models.length.toString() || '0';
});
const throughput = computed(() => validatorStore.displayTotalPower);

const isApiHintHover = ref(false);

// Public key functionality
const publicKey = ref<any>(null);
const publicKeyLoading = ref(false);

// Get public key from blockchain account info
async function getPublicKeyFromAccount() {
  publicKeyLoading.value = true;
  try {
    const key = await walletStore.getWalletPublicKey();
    publicKey.value = key;
  } catch (error) {
    console.error('Error getting public key from account:', error);
  } finally {
    publicKeyLoading.value = false;
  }
}

// Get public key directly from wallet
async function getPublicKeyFromWallet() {
  publicKeyLoading.value = true;
  try {
    const key = await walletStore.getWalletPublicKeyFromWallet();
    publicKey.value = key;
  } catch (error) {
    console.error('Error getting public key from wallet:', error);
  } finally {
    publicKeyLoading.value = false;
  }
}

// Admin transaction functionality
const adminTxLoading = ref(false);
const adminTxResult = ref<any>(null);
const adminTxError = ref<string>('');

// Send admin transaction
async function sendAdminTransaction() {
  adminTxLoading.value = true;
  adminTxError.value = '';
  adminTxResult.value = null;
  
  try {
    const result = await walletStore.sendAdminTransaction();
    adminTxResult.value = result;
  } catch (error) {
    adminTxError.value = error instanceof Error ? error.message : String(error);
  } finally {
    adminTxLoading.value = false;
  }
}

// Send admin transaction with alternative formats
async function sendAdminTransactionAlt() {
  adminTxLoading.value = true;
  adminTxError.value = '';
  adminTxResult.value = null;
  
  try {
    const result = await walletStore.sendAdminTransactionAltFormat();
    adminTxResult.value = result;
  } catch (error) {
    adminTxError.value = error instanceof Error ? error.message : String(error);
  } finally {
    adminTxLoading.value = false;
  }
}

// Copy functionality
const showCopyToast = ref(0);

// Copy address to clipboard
function copyAddress(address: string) {
  navigator.clipboard.writeText(address).then(() => {
    console.log('Address copied to clipboard');
    showCopyToast.value = 1;
    setTimeout(() => {
      showCopyToast.value = 0;
    }, 1000);
  }).catch(err => {
    console.error('Failed to copy: ', err);
    showCopyToast.value = 2;
    setTimeout(() => {
      showCopyToast.value = 0;
    }, 1000);
  });
}

// Copy text to clipboard
function copyText(text: string) {
  navigator.clipboard.writeText(text).then(() => {
    console.log('Text copied to clipboard');
  }).catch(err => {
    console.error('Failed to copy: ', err);
  });
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

onMounted(() => {
  // Initialize validator store data when the developer page loads
  validatorStore.init();
  inferenceStore.init();
  updateState();
});

// Inference API functionality
const inferenceApiLoading = ref(false);
const inferenceApiResult = ref<any>(null);
const inferenceApiError = ref<string>('');
const participantData = ref({
  address: '',
  url: '',
  validator_key: '',
  pub_key: '',
  worker_key: ''
});

// Submit new unfunded participant via inference API
async function submitNewUnfundedParticipant() {
  inferenceApiLoading.value = true;
  inferenceApiError.value = '';
  inferenceApiResult.value = null;
  
  try {
    // Auto-fill current wallet address if empty
    if (!participantData.value.address && walletStore.currentAddress) {
      participantData.value.address = walletStore.currentAddress;
    }
    
    // Auto-fill public key if empty and available
    if (!participantData.value.pub_key && publicKey.value) {
      participantData.value.pub_key = publicKey.value;
    }
    
    const result = await blockchain.submitNewUnfundedParticipant(participantData.value);
    inferenceApiResult.value = result;
  } catch (error) {
    inferenceApiError.value = error instanceof Error ? error.message : String(error);
  } finally {
    inferenceApiLoading.value = false;
  }
}

// Get all participants via inference API
async function getParticipants() {
  inferenceApiLoading.value = true;
  inferenceApiError.value = '';
  inferenceApiResult.value = null;
  
  try {
    const result = await blockchain.getParticipants();
    inferenceApiResult.value = result;
  } catch (error) {
    inferenceApiError.value = error instanceof Error ? error.message : String(error);
  } finally {
    inferenceApiLoading.value = false;
  }
}

// Get specific participant via inference API
async function getParticipant() {
  if (!participantData.value.address) {
    inferenceApiError.value = 'Please enter a participant address';
    return;
  }
  
  inferenceApiLoading.value = true;
  inferenceApiError.value = '';
  inferenceApiResult.value = null;
  
  try {
    const result = await blockchain.getParticipant(participantData.value.address);
    inferenceApiResult.value = result;
  } catch (error) {
    inferenceApiError.value = error instanceof Error ? error.message : String(error);
  } finally {
    inferenceApiLoading.value = false;
  }
}

// Fill current wallet data
function fillCurrentWalletData() {
  if (walletStore.currentAddress) {
    participantData.value.address = walletStore.currentAddress;
  }
  if (publicKey.value) {
    participantData.value.pub_key = publicKey.value;
  }
}


</script>

<template>
<div>
  <!-- First Row: Statistics Cards -->
  <div class="grid gap-4 grid-cols-[repeat(auto-fit,minmax(265px,1fr))] mt-4">
    <CardStatisticsVertical
      :title="$t('inference.ai_tokens_last_week')"
      icon="mdi:alpha-t-box"
      :stats="aiTokensLastWeek"
      color="primary"
      :hint="$t('developer.hints.ai_tokens_last_week')"
    />
    <CardStatisticsVertical
      :title="$t('developer.global_users')"
      icon="mdi:account-group"
      :stats="globalUsers"
      color="success"
      :hint="$t('developer.hints.global_users')"
    />
    <CardStatisticsVertical
      :title="$t('developer.active_providers')"
      icon="mdi:server-network"
      :stats="activeProviders"
      color="warning"
      :hint="$t('developer.hints.active_providers')"
    />
    <CardStatisticsVertical
      :title="$t('developer.models')"
      icon="mdi:cube-outline"
      :stats="models"
      color="info"
      :hint="$t('developer.hints.models')"
    />
    <CardStatisticsVertical
      :title="$t('developer.throughput')"
      icon="mdi:lightning-bolt"
      :stats="throughput"
      color="secondary"
      :hint="$t('developer.hints.throughput')"
    />
  </div>

  <!-- Second Row: Two Widgets -->
  <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
      <!-- Exchange Widget (spans 2 columns) -->
      <div class="lg:col-span-2">
        <ExchangeWidget :chain="chain" />
      </div>

      <!-- Use Gonka API Widget -->
      <div class="bg-base-100 rounded shadow">
          <div class="px-4 pt-4 pb-2 text-lg font-semibold text-main">
              {{ $t('developer.use_api') }}
          </div>
          <div class="px-4 pb-4">
              <div class="bg-gray-100 dark:bg-[#373f59] rounded-lg px-4 py-6 relative min-h-[96px] grid place-items-center">
                <div class="absolute top-2 right-2 text-primary" @mouseenter="isApiHintHover = true" @mouseleave="isApiHintHover = false">
                  <Icon icon="mdi:information" />
                </div>
                <div class="flex items-center justify-center">
                  <button v-if="!isApiHintHover" class="btn btn-info text-white cursor-pointer">
                    <Icon icon="mdi:api" class="mr-2" />
                    {{ $t('developer.api_docs') }}
                  </button>
                  <p v-else class="text-sm font-semibold text-primary text-center">
                    {{ $t('developer.api_docs_hint') }}
                  </p>
                </div>
              </div>
          </div>
      </div>


  </div>
  
  
  <!-- Copy Toast -->
  <div class="toast toast-end" v-show="showCopyToast === 1">
      <div class="alert alert-success">
          <div class="text-xs md:!text-sm">
              <span>{{ $t('developer.copy_success') }}</span>
          </div>
      </div>
  </div>
  <div class="toast toast-end" v-show="showCopyToast === 2">
      <div class="alert alert-error">
          <div class="text-xs md:!text-sm">
              <span>{{ $t('developer.copy_error') }}</span>
          </div>
      </div>
  </div>
</div>
</template>

<route>
  {
    meta: {
      i18n: 'developer',
      order: 3,
      descriptionKey: 'developer.meta_description'
    }
  }
</route>

<style>
.developer-table.table :where(th, td) {
    padding: 8px 5px;
    background: transparent;
}
</style> 