<script lang="ts" setup>
import { computed } from 'vue';
import { Icon } from '@iconify/vue';

const props = defineProps<{
  activeTab: 'deposit' | 'withdraw' | 'purchase';
  lastTxInfo: any;
  unwrapProgress: any;
  isUnwrapRunning: boolean;
  pendingUnwrap: any;
  calculating: boolean;
  depositTxCompleted: boolean;
  withdrawTxCompleted: boolean;
  depositProgress: {
    status: 'idle' | 'signing_ethereum' | 'waiting_bls' | 'minting' | 'completed' | 'failed';
    lockTxHash?: string;
    message: string;
  };
  ibcProgress: {
    status: 'idle' | 'signing' | 'relaying' | 'completed' | 'failed';
    txHash?: string;
    message: string;
  };
}>();

defineEmits<{
  (e: 'resumePending'): void;
  (e: 'clearPending'): void;
  (e: 'discardPending'): void;
}>();

// Helper to determine if wallet popup banner is active
const showWalletPopupBanner = computed(() => {
  if (props.activeTab === 'withdraw' && props.lastTxInfo?.type === 'eth') {
    return ['connecting', 'signing_gonka', 'signing_ethereum'].includes(props.unwrapProgress?.status);
  }
  if (props.activeTab === 'deposit' && props.lastTxInfo?.type === 'eth') {
    return props.depositProgress.status === 'signing_ethereum';
  }
  if (props.lastTxInfo?.type === 'ibc') {
    return props.ibcProgress.status === 'signing';
  }
  return false;
});
</script>

<template>
  <div class="mt-2">
    <div>
      <div class="text-base font-semibold text-main mb-1">Step 3 · Approve in your wallet</div>
      <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
        A wallet popup will ask you to approve each on-chain action. Keep this tab open — statuses update as the bridge confirms.
      </p>

      <!-- Checklist Container -->
      <div class="space-y-3.5 my-5">
        <!-- CASE 1: EVM Withdrawal Checklist -->
        <template v-if="activeTab === 'withdraw' && lastTxInfo?.type === 'eth'">
          <!-- Step 1: Burn on Gonka -->
          <div class="flex items-center gap-3">
            <Icon
              v-if="['waiting_bls', 'signing_ethereum', 'completed'].includes(unwrapProgress.status) || !!unwrapProgress.gonkaTxHash"
              icon="mdi:check-circle-outline"
              class="text-green-500 text-lg shrink-0"
            />
            <Icon
              v-else-if="['connecting', 'signing_gonka'].includes(unwrapProgress.status) && unwrapProgress.status !== 'failed'"
              icon="mdi:loading"
              class="animate-spin text-primary text-lg shrink-0"
            />
            <Icon
              v-else
              icon="mdi:circle-outline"
              class="text-gray-300 dark:text-gray-600 text-lg shrink-0"
            />
            <span class="text-sm font-medium text-main">Burn tokens on Gonka</span>
          </div>

          <!-- Step 2: Validator signatures -->
          <div class="flex items-center gap-3">
            <Icon
              v-if="['signing_ethereum', 'completed'].includes(unwrapProgress.status)"
              icon="mdi:check-circle-outline"
              class="text-green-500 text-lg shrink-0"
            />
            <Icon
              v-else-if="unwrapProgress.status === 'waiting_bls'"
              icon="mdi:loading"
              class="animate-spin text-primary text-lg shrink-0"
            />
            <Icon
              v-else
              icon="mdi:circle-outline"
              class="text-gray-300 dark:text-gray-600 text-lg shrink-0"
            />
            <span class="text-sm font-medium text-main">
              Validator signatures
              <span v-if="unwrapProgress.status === 'waiting_bls' && unwrapProgress.elapsedSeconds" class="text-xs text-gray-400 font-normal ml-1">
                ({{ unwrapProgress.elapsedSeconds }}s)
              </span>
            </span>
          </div>

          <!-- Step 3: Release on Ethereum -->
          <div class="flex items-center gap-3">
            <Icon
              v-if="unwrapProgress.status === 'completed'"
              icon="mdi:check-circle-outline"
              class="text-green-500 text-lg shrink-0"
            />
            <Icon
              v-else-if="unwrapProgress.status === 'signing_ethereum'"
              icon="mdi:loading"
              class="animate-spin text-primary text-lg shrink-0"
            />
            <Icon
              v-else
              icon="mdi:circle-outline"
              class="text-gray-300 dark:text-gray-600 text-lg shrink-0"
            />
            <span class="text-sm font-medium text-main">Release on Ethereum</span>
          </div>
        </template>

        <!-- CASE 2: EVM Deposit Checklist -->
        <template v-else-if="activeTab === 'deposit' && lastTxInfo?.type === 'eth'">
          <!-- Step 1: Lock on Ethereum -->
          <div class="flex items-center gap-3">
            <Icon
              v-if="['waiting_bls', 'minting', 'completed'].includes(depositProgress.status) || !!depositProgress.lockTxHash"
              icon="mdi:check-circle-outline"
              class="text-green-500 text-lg shrink-0"
            />
            <Icon
              v-else-if="depositProgress.status === 'signing_ethereum'"
              icon="mdi:loading"
              class="animate-spin text-primary text-lg shrink-0"
            />
            <Icon
              v-else
              icon="mdi:circle-outline"
              class="text-gray-300 dark:text-gray-600 text-lg shrink-0"
            />
            <span class="text-sm font-medium text-main">Lock tokens on Ethereum</span>
          </div>

          <!-- Step 2: Validator signatures -->
          <div class="flex items-center gap-3">
            <Icon
              v-if="['minting', 'completed'].includes(depositProgress.status)"
              icon="mdi:check-circle-outline"
              class="text-green-500 text-lg shrink-0"
            />
            <Icon
              v-else-if="depositProgress.status === 'waiting_bls'"
              icon="mdi:loading"
              class="animate-spin text-primary text-lg shrink-0"
            />
            <Icon
              v-else
              icon="mdi:circle-outline"
              class="text-gray-300 dark:text-gray-600 text-lg shrink-0"
            />
            <span class="text-sm font-medium text-main">Validator signatures</span>
          </div>

          <!-- Step 3: Mint on Gonka -->
          <div class="flex items-center gap-3">
            <Icon
              v-if="depositProgress.status === 'completed'"
              icon="mdi:check-circle-outline"
              class="text-green-500 text-lg shrink-0"
            />
            <Icon
              v-else-if="depositProgress.status === 'minting'"
              icon="mdi:loading"
              class="animate-spin text-primary text-lg shrink-0"
            />
            <Icon
              v-else
              icon="mdi:circle-outline"
              class="text-gray-300 dark:text-gray-600 text-lg shrink-0"
            />
            <span class="text-sm font-medium text-main">Mint on Gonka</span>
          </div>
        </template>

        <!-- CASE 3: IBC Transfer Checklist (Deposit & Withdrawal) -->
        <template v-else-if="lastTxInfo?.type === 'ibc'">
          <!-- Step 1: Approve transfer in wallet -->
          <div class="flex items-center gap-3">
            <Icon
              v-if="['relaying', 'completed'].includes(ibcProgress.status) || !!ibcProgress.txHash"
              icon="mdi:check-circle-outline"
              class="text-green-500 text-lg shrink-0"
            />
            <Icon
              v-else-if="ibcProgress.status === 'signing'"
              icon="mdi:loading"
              class="animate-spin text-primary text-lg shrink-0"
            />
            <Icon
              v-else
              icon="mdi:circle-outline"
              class="text-gray-300 dark:text-gray-600 text-lg shrink-0"
            />
            <span class="text-sm font-medium text-main">Approve transfer in wallet</span>
          </div>

          <!-- Step 2: IBC relay packet -->
          <div class="flex items-center gap-3">
            <Icon
              v-if="ibcProgress.status === 'completed'"
              icon="mdi:check-circle-outline"
              class="text-green-500 text-lg shrink-0"
            />
            <Icon
              v-else-if="ibcProgress.status === 'relaying'"
              icon="mdi:loading"
              class="animate-spin text-primary text-lg shrink-0"
            />
            <Icon
              v-else
              icon="mdi:circle-outline"
              class="text-gray-300 dark:text-gray-600 text-lg shrink-0"
            />
            <span class="text-sm font-medium text-main">IBC packet relay transfer</span>
          </div>
        </template>
      </div>

      <!-- Info box banner: Check the wallet popup to approve. -->
      <div v-if="showWalletPopupBanner" class="flex items-center gap-2.5 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3 text-blue-700 dark:text-blue-300 text-xs my-4 shadow-sm">
        <Icon icon="mdi:open-in-new" class="text-blue-500 text-lg shrink-0" />
        <span class="font-medium">Check the wallet popup to approve.</span>
      </div>

      <!-- Summary Card -->
      <div v-if="lastTxInfo" class="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4 mt-4 text-left space-y-1.5 border border-gray-100 dark:border-gray-700/40">
        <div class="flex justify-between text-sm">
          <span class="text-gray-500">Amount</span>
          <span class="font-semibold text-main">{{ lastTxInfo.amount }} {{ lastTxInfo.token }}</span>
        </div>
        <div class="flex justify-between text-sm">
          <span class="text-gray-500">From</span>
          <span class="font-semibold text-main">{{ lastTxInfo.from }}</span>
        </div>
        <div class="flex justify-between text-sm">
          <span class="text-gray-500">To</span>
          <span class="font-semibold text-main">{{ lastTxInfo.to }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
