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
import ConnectWallet from '@/components/ConnectWallet.vue';
import LiquidityPoolWidget from '@/components/LiquidityPoolWidget.vue';
import { useQRCode } from '@vueuse/integrations/useQRCode';

const props = defineProps(['chain']);

const validatorStore = useValidatorStore();
const walletStore = useWalletStore();
const baseStore = useBaseStore();
const blockchain = useBlockchain();
const format = useFormatter();
const dialog = useTxDialog();
const inferenceStore = useInferenceStore();

// Wallet connection modal
const connectWalletRef = ref<InstanceType<typeof ConnectWallet> | null>(null);

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

// QR code for wallet address - fixed implementation
const qrCodeSource = ref('');
const qrcode = useQRCode(qrCodeSource, {
  logo: '/public/logos/gonka-mainnet/logo-small.svg',
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

  <!-- Second Row: Three Widgets -->
  <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
      <!-- Connect Wallet Widget -->
      <div class="bg-base-100 rounded shadow">
          <div class="px-4 pt-4 pb-2 text-lg font-semibold text-main">
              Connect Wallet
          </div>
          <div class="px-4 pb-4">
              <!-- Not Connected State -->
              <div v-if="!walletAddress" class="bg-gray-100 dark:bg-[#373f59] rounded-sm px-4 py-3 h-20 flex items-center justify-center">
                  <button @click="openConnectWallet" class="btn btn-primary text-white cursor-pointer">
                      <Icon icon="mdi:wallet" class="mr-2" />
                      Connect Wallet
                  </button>
              </div>
              
              <!-- Connected State -->
              <div v-else class="space-y-3">
                  <!-- Wallet Info -->
                  <div class="bg-gray-100 dark:bg-[#373f59] rounded-sm px-4 py-3">
                      <div class="flex items-center justify-between mb-2">
                          <span class="text-sm font-semibold text-primary capitalize">
                              {{ walletStore.connectedWallet?.wallet || 'Unknown' }}
                          </span>
                      </div>
                      
                      <!-- QR Code -->
                      <div class="flex justify-center mb-3">
                          <img v-if="qrcode" :src="qrcode" alt="QR Code" class="w-24 h-24 rounded-sm" />
                      </div>
                      
                      <!-- Address -->
                      <div class="text-center">
                          <div class="text-xs text-gray-600 dark:text-gray-400 mb-1">Address:</div>
                          <div 
                              class="text-xs font-mono bg-white dark:bg-gray-800 rounded px-2 py-1 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700"
                              @click="copyAddress(walletAddress)"
                              :title="walletAddress"
                          >
                              {{ walletAddress.length > 4 ? walletAddress.substring(walletAddress.length - 4) : walletAddress }}
                          </div>
                      </div>
                      

                  </div>
                  
                  <!-- Disconnect Button -->
                  <button @click="walletStore.disconnect()" class="btn btn-outline btn-error w-full text-sm">
                      <Icon icon="mdi:logout" class="mr-2" />
                      Disconnect
                  </button>
              </div>
          </div>
      </div>

      <!-- Liquidity Pool Widget -->
      <LiquidityPoolWidget :chain="chain" />

      <!-- Use Gonka API Widget -->
      <div class="bg-base-100 rounded shadow">
          <div class="px-4 pt-4 pb-2 text-lg font-semibold text-main">
              Use Gonka API
          </div>
          <div class="px-4 pb-4">
              <div class="bg-gray-100 dark:bg-[#373f59] rounded-sm px-4 py-3 h-20 flex items-center justify-center">
                  <button class="btn btn-info text-white cursor-pointer">
                      <Icon icon="mdi:api" class="mr-2" />
                      API Documentation
                  </button>
              </div>
          </div>
      </div>


  </div>

  <!-- Third Row: Wallet Widget (Only visible when connected) -->
  <div v-if="walletAddress" class="bg-base-100 rounded mt-4 shadow">
      <div class="flex justify-between px-4 pt-4 pb-2 text-lg font-semibold text-main">
        <RouterLink v-if="walletStore.currentAddress"
          class="float-right text-sm cursor-pointert link link-primary no-underline font-medium"
          :to="`/${chain}/account/${walletStore.currentAddress}`">{{ $t('index.more') }}</RouterLink>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 gap-4 px-4 pb-6">
        <div class="bg-gray-100 dark:bg-[#373f59] rounded-sm px-4 py-3">
          <div class="text-sm mb-1">{{ $t('account.balance') }}</div>
          <div class="text-lg font-semibold text-main">
            {{ format.formatToken(walletStore.balanceOfStakingToken) }}
          </div>
          <div class="text-sm" :class="color">
            ${{ format.tokenValue(walletStore.balanceOfStakingToken) }}
          </div>
        </div>
        <div class="bg-gray-100 dark:bg-[#373f59] rounded-sm px-4 py-3">
          <div class="text-sm mb-1">{{ $t('index.reward') }}</div>
          <div class="text-lg font-semibold text-main">
            {{ format.formatToken(walletStore.rewardAmount) }}
          </div>
          <div class="text-sm" :class="color">
            ${{ format.tokenValue(walletStore.rewardAmount) }}
          </div>
        </div>
      </div>

      <div v-if="walletStore.delegations.length > 0" class="px-4 pb-4 overflow-auto">
        <table class="table table-compact w-full table-zebra">
          <thead>
            <tr>
              <th>{{ $t('account.validator') }}</th>
              <th>{{ $t('account.delegations') }}</th>
              <th>{{ $t('account.rewards') }}</th>
              <th>{{ $t('staking.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(item, index) in walletStore.delegations" :key="index">
              <td>
                <RouterLink class="link link-primary no-underline" :to="`/${chain}/staking/${item?.delegation?.validator_address}`">
                {{
                  format.validatorFromBech32(
                    item?.delegation?.validator_address
                  )
                }}
                </RouterLink>
              </td>
              <td>{{ format.formatToken(item?.balance) }}</td>
              <td>
                {{
                  format.formatTokens(
                    walletStore?.rewards?.rewards?.find(
                      (el) =>
                        el?.validator_address ===
                        item?.delegation?.validator_address
                    )?.reward)
                }}
              </td>
              <td>
                <div>
                  <label for="withdraw" class="btn !btn-xs !btn-primary btn-ghost rounded-sm"
                    @click="dialog.open('withdraw', { validator_address: item.delegation.validator_address }, updateState)">
                    {{ $t('index.btn_withdraw_reward') }}
                  </label>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-2 gap-4 px-4 pb-6 mt-4">
      <label for="PingTokenConvert" class="btn btn-primary text-white">{{ $t('index.btn_swap') }}</label>
        <label for="send" class="btn !bg-yes !border-yes text-white" @click="dialog.open('send', { balances: walletStore.balances }, updateState)">{{ $t('account.btn_send') }}</label>
        <RouterLink to="/wallet/receive" class="btn !bg-info !border-info text-white hidden">{{ $t('index.receive') }}</RouterLink>
      </div>
      <Teleport to="body">
        <ping-token-convert :chain-name="blockchain?.current?.prettyName" :endpoint="blockchain?.endpoint?.address"
          :hd-path="walletStore?.connectedWallet?.hdPath"></ping-token-convert>
      </Teleport>
  </div>
  
  <!-- Copy Toast -->
  <div class="toast toast-end" v-show="showCopyToast === 1">
      <div class="alert alert-success">
          <div class="text-xs md:!text-sm">
              <span>{{ tipMsg.msg }}</span>
          </div>
      </div>
  </div>
  <div class="toast toast-end" v-show="showCopyToast === 2">
      <div class="alert alert-error">
          <div class="text-xs md:!text-sm">
              <span>{{ tipMsg.msg }}</span>
          </div>
      </div>
  </div>
  
  <!-- Connect Wallet Modal -->
  <Teleport to="body">
      <ConnectWallet 
          ref="connectWalletRef"
          :chain-id="baseStore.currentChainId" 
          :hd-path="blockchain.defaultHDPath"
          :addr-prefix="blockchain.current?.bech32Prefix" 
          @connect="walletStateChange"
          @keplr-config="walletStore.suggestChain()"
      />
  </Teleport>
</div>
</template>

<route>
  {
    meta: {
      i18n: 'developer',
      order: 3,
      description: 'Developers build and deploy AI applications within Gonka decentralized network, leveraging the distributed computational power to run their models.'
    }
  }
</route>

<style>
.developer-table.table :where(th, td) {
    padding: 8px 5px;
    background: transparent;
}
</style> 