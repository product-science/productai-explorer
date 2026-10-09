<script lang="ts" setup>
import { Icon } from '@iconify/vue';

defineProps<{
  activeTab: 'deposit' | 'withdraw' | 'purchase';
  isConnected: boolean;
}>();

defineEmits<{
  (e: 'update:activeTab', tab: 'deposit' | 'withdraw' | 'purchase'): void;
  (e: 'disconnect'): void;
}>();
</script>

<template>
  <!-- Top row: Tab switcher + Disconnect button -->
  <div class="w-full flex items-center justify-between mb-3">
    <div class="inline-flex p-1 bg-gray-200 dark:bg-gray-800 rounded-lg">
      <button
        class="px-4 py-1.5 text-sm font-semibold rounded-md transition-colors"
        :class="activeTab === 'withdraw' ? 'bg-primary text-white shadow-sm' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'"
        @click="$emit('update:activeTab', 'withdraw')"
      >
        {{ $t('developer.withdraw_tab') }}
      </button>
      <button
        class="px-4 py-1.5 text-sm font-semibold rounded-md transition-colors"
        :class="activeTab === 'deposit' ? 'bg-primary text-white shadow-sm' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'"
        @click="$emit('update:activeTab', 'deposit')"
      >
        {{ $t('developer.deposit_tab') }}
      </button>
    </div>
  </div>
</template>
