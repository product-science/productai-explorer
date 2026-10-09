<script lang="ts" setup>
import { Icon } from '@iconify/vue';

defineProps<{
  currentStep: number;
  isConnected: boolean;
  loading: boolean;
  activeTab: 'deposit' | 'withdraw' | 'purchase';
  connectedWalletName?: string;
  truncatedAddress: string;
  stakingTokenBalance: any;
  format: {
    formatToken(balance: any): string;
  };
}>();

defineEmits<{
  (e: 'connect'): void;
  (e: 'update:currentStep', step: number): void;
}>();
</script>

<template>
  <div class="mt-2">
    <div class="rounded-lg border border-gray-200 dark:border-gray-700 p-5">
      <div class="text-base font-semibold text-main mb-1">Step 1 · Connect your wallet</div>
      <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Required before you can {{ activeTab }}. The Gonka receiving address is read from the wallet you connect.
      </p>

      <!-- Not connected: show connect button -->
      <div v-if="!isConnected && !loading" class="flex justify-center py-4">
        <button @click="$emit('connect')" class="btn btn-primary text-white">
          <Icon icon="mdi:wallet" class="mr-2" />
          Connect wallet
        </button>
      </div>

      <!-- Loading wallet state when connection starts but not fully registered -->
      <div v-else-if="loading && !isConnected" class="bg-gray-100 dark:bg-[#373f59] rounded-lg px-4 py-6 flex items-center justify-center gap-3">
        <div class="loading loading-spinner loading-md text-primary"></div>
        <div class="text-sm text-gray-500 font-medium">Connecting wallet...</div>
      </div>

      <!-- Connected: compact wallet banner or inline loader -->
      <div v-else>
        <!-- Loading wallet assets and balances -->
        <div v-if="loading" class="bg-gray-100 dark:bg-[#373f59] rounded-lg px-4 py-4 flex items-center gap-3">
          <div class="loading loading-spinner loading-sm text-primary shrink-0"></div>
          <div class="text-sm text-gray-500 font-medium">Loading wallet metadata...</div>
        </div>

        <!-- Connected state ready -->
        <div v-else class="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg px-4 py-3 flex items-start gap-3">
          <Icon icon="mdi:check-circle" class="text-green-500 text-lg mt-0.5 shrink-0" />
          <div class="min-w-0">
            <div class="text-sm font-semibold text-main capitalize">
              {{ connectedWalletName || 'Wallet' }} connected · {{ truncatedAddress }}
            </div>
            <div class="text-xs text-gray-500 dark:text-gray-400">
              Gonka balance: {{ format.formatToken(stakingTokenBalance) }}
            </div>
          </div>
        </div>

        <div class="flex justify-end mt-4">
          <button @click="$emit('update:currentStep', 2)" class="btn btn-sm btn-primary text-white" :disabled="loading">
            Continue →
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
