<script lang="ts" setup>
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{
  activeTab: 'deposit' | 'withdraw' | 'purchase';
  isTransactionCompleted: boolean;
  isTransactionFailed: boolean;
  isTransactionPending: boolean;
  lastTxInfo: any;
  unwrapProgress: any;
  txError: string;
  getExplorerTxLink(chainId: string, txHash: string | undefined): string;
  truncateHash(hash: string | undefined): string;
}>();

const emit = defineEmits<{
  (e: 'transferMore'): void;
  (e: 'disconnect'): void;
  (e: 'retry'): void;
  (e: 'resumePending'): void;
  (e: 'discardPending'): void;
}>();

const { t } = useI18n();

function formatError(errStr: string): string {
  if (!errStr) return 'Unknown error';

  // Log full detailed error to console for debugging
  console.warn('Bridge/Exchange Transaction Error Details:', errStr);

  const lower = errStr.toLowerCase();

  // 1. User Rejections (EVM & Cosmos)
  if (
    lower.includes('4001') ||
    lower.includes('action_rejected') ||
    lower.includes('user rejected') ||
    lower.includes('user denied') ||
    lower.includes('request rejected') ||
    lower.includes('user-denied') ||
    lower.includes('rejected request') ||
    lower.includes('rejected by user')
  ) {
    return t('developer.error_rejected');
  }

  // 2. Out of Gas
  if (lower.includes('out of gas') || lower.includes('insufficient gas')) {
    return t('developer.error_out_of_gas');
  }

  // 3. Insufficient Funds
  if (
    lower.includes('insufficient funds') ||
    lower.includes('insufficient balance') ||
    lower.includes('insufficient fee') ||
    lower.includes('exceeds balance')
  ) {
    return t('developer.error_insufficient_funds');
  }

  // 4. Transaction Indexing Disabled
  if (lower.includes('transaction indexing is disabled')) {
    return t('developer.error_indexing_disabled');
  }

  // 5. Try to extract nested JSON/string info inside ethers fields (e.g. info={ "error": { "message": "..." } })
  try {
    const jsonMatch = errStr.match(/(?:info|error)\s*=\s*(\{[\s\S]*?\})(?=\s*,\s*\w+\s*=|\s*\)$|$)/);
    if (jsonMatch && jsonMatch[1]) {
      // Clean up possible unquoted/single-quoted JS object string to make it valid JSON
      let cleanedJson = jsonMatch[1]
        .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')
        .replace(/'/g, '"');
      const obj = JSON.parse(cleanedJson);
      const nestedMsg = obj.error?.message || obj.message;
      if (nestedMsg) {
        return formatError(nestedMsg); // Format recursively
      }
    }
  } catch (e) {
    // Ignore and fall back
  }

  // 6. Parse standard JSON strings
  if (errStr.trim().startsWith('{') && errStr.trim().endsWith('}')) {
    try {
      const obj = JSON.parse(errStr);
      const msg = obj.data || obj.message || (obj.error && obj.error.message);
      if (msg) {
        return formatError(msg); // Format recursively
      }
    } catch (e) {
      // Ignore
    }
  }

  // 7. Handle Ethers.js reason match
  const reasonMatch = errStr.match(/reason="([^"]+)"/);
  if (reasonMatch && reasonMatch[1]) {
    return `Transaction failed: ${reasonMatch[1]}`;
  }

  // 8. General cleanup for very long raw errors
  if (errStr.length > 200) {
    const sentenceEnd = errStr.indexOf('.');
    if (sentenceEnd > 10 && sentenceEnd < 180) {
      return errStr.substring(0, sentenceEnd + 1);
    }
    return errStr.substring(0, 180) + '...';
  }

  return errStr;
}
</script>

<template>
  <div class="mt-2">
    <!-- 1. SUCCESS VIEW -->
    <div v-if="isTransactionCompleted" class="text-center py-4">
      <!-- Success Icon -->
      <div class="w-12 h-12 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto mb-3.5">
        <Icon icon="mdi:check" class="text-2xl text-green-600 dark:text-green-500" />
      </div>

      <!-- Title & Subtitle -->
      <div class="text-lg font-bold text-main">
        {{ activeTab === 'deposit' ? 'Deposit complete' : 'Withdrawal complete' }}
      </div>
      <p class="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-sm mx-auto">
        {{ activeTab === 'deposit' 
          ? 'Your tokens have been deposited and are now in your Gonka wallet.' 
          : 'Your tokens have been released and are now in your wallet.' }}
      </p>

      <!-- Completed Checklist items (under subtitle, above table) -->
      <div class="space-y-2.5 text-left my-5">
        <!-- EVM Withdraw -->
        <template v-if="activeTab === 'withdraw' && lastTxInfo?.type === 'eth'">
          <div class="flex items-center gap-3 text-sm text-green-600 dark:text-green-400 font-medium">
            <Icon icon="mdi:check-circle-outline" class="text-lg shrink-0" />
            <span>Burn tokens on Gonka</span>
          </div>
          <div class="flex items-center gap-3 text-sm text-green-600 dark:text-green-400 font-medium">
            <Icon icon="mdi:check-circle-outline" class="text-lg shrink-0" />
            <span>Validator signatures</span>
          </div>
          <div class="flex items-center gap-3 text-sm text-green-600 dark:text-green-400 font-medium">
            <Icon icon="mdi:check-circle-outline" class="text-lg shrink-0" />
            <span>Release on Ethereum</span>
          </div>
        </template>

        <!-- EVM Deposit -->
        <template v-else-if="activeTab === 'deposit' && lastTxInfo?.type === 'eth'">
          <div class="flex items-center gap-3 text-sm text-green-600 dark:text-green-400 font-medium">
            <Icon icon="mdi:check-circle-outline" class="text-lg shrink-0" />
            <span>Lock tokens on Ethereum</span>
          </div>
          <div class="flex items-center gap-3 text-sm text-green-600 dark:text-green-400 font-medium">
            <Icon icon="mdi:check-circle-outline" class="text-lg shrink-0" />
            <span>Validator signatures</span>
          </div>
          <div class="flex items-center gap-3 text-sm text-green-600 dark:text-green-400 font-medium">
            <Icon icon="mdi:check-circle-outline" class="text-lg shrink-0" />
            <span>Mint on Gonka</span>
          </div>
        </template>

        <!-- IBC Transfer (Deposit & Withdraw) -->
        <template v-else-if="lastTxInfo?.type === 'ibc'">
          <div class="flex items-center gap-3 text-sm text-green-600 dark:text-green-400 font-medium">
            <Icon icon="mdi:check-circle-outline" class="text-lg shrink-0" />
            <span>Approve transfer in wallet</span>
          </div>
          <div class="flex items-center gap-3 text-sm text-green-600 dark:text-green-400 font-medium">
            <Icon icon="mdi:check-circle-outline" class="text-lg shrink-0" />
            <span>IBC packet relay transfer</span>
          </div>
        </template>
      </div>

      <!-- Summary Table inside a card -->
      <div v-if="lastTxInfo" class="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4 text-left space-y-1.5 border border-gray-100 dark:border-gray-700/40">
        <div class="flex justify-between text-sm">
          <span class="text-gray-500">Amount</span>
          <span class="font-semibold text-main">{{ lastTxInfo.amount }} {{ lastTxInfo.token }}</span>
        </div>
        <div class="flex justify-between text-sm">
          <span class="text-gray-500">Network</span>
          <span class="font-semibold text-main">{{ activeTab === 'deposit' ? lastTxInfo.from : lastTxInfo.to }}</span>
        </div>
        <div v-if="(activeTab === 'withdraw' && unwrapProgress?.ethTxHash) || lastTxInfo.txHash" class="flex justify-between text-sm">
          <span class="text-gray-500">Transaction</span>
          <span class="font-semibold text-main font-mono text-xs">{{ truncateHash((activeTab === 'withdraw' && unwrapProgress?.ethTxHash) || lastTxInfo.txHash) }}</span>
        </div>
      </div>

      <!-- View on Explorer Button -->
      <div v-if="(activeTab === 'withdraw' && unwrapProgress?.ethTxHash) || lastTxInfo?.txHash" class="mt-4 flex justify-center w-full">
        <a
          :href="getExplorerTxLink(
            activeTab === 'withdraw' && unwrapProgress?.ethTxHash 
              ? 'ethereum' 
              : (lastTxInfo?.chainId || lastTxInfo?.type || 'external'), 
            (activeTab === 'withdraw' && unwrapProgress?.ethTxHash) || lastTxInfo?.txHash
          )"
          target="_blank"
          rel="noopener noreferrer"
          class="btn btn-outline btn-sm w-full py-2.5 flex items-center justify-center gap-1.5"
        >
          <Icon icon="mdi:open-in-new" class="text-sm" />
          View on Explorer
        </a>
      </div>

      <!-- Bottom Action Buttons -->
      <div class="flex gap-3 mt-5 pt-4 border-t border-gray-200 dark:border-gray-700">
        <button @click="$emit('transferMore')" class="btn btn-sm btn-primary flex-1 text-white">
          <Icon icon="mdi:refresh" class="mr-1" />
          Transfer more tokens
        </button>
        <button @click="$emit('disconnect')" class="btn btn-sm btn-outline border-gray-300 dark:border-gray-700 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 flex-1">
          <Icon icon="mdi:wallet" class="mr-1 text-red-500" />
          Disconnect
        </button>
      </div>
    </div>

    <!-- 2. FAILED VIEW -->
    <div v-else-if="isTransactionFailed" class="text-center py-4">
      <Icon icon="mdi:alert-circle" class="text-5xl text-red-500 mb-3 mx-auto block" />
      <div class="text-lg font-bold text-red-500">Transaction failed</div>
      <p class="text-sm text-gray-500 mt-2 px-4 break-words">
        {{ formatError(activeTab === 'withdraw' && unwrapProgress?.status === 'failed' ? unwrapProgress?.message : txError) }}
      </p>

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
        <div v-if="(activeTab === 'withdraw' && unwrapProgress?.ethTxHash) || lastTxInfo.txHash" class="flex justify-between text-sm">
          <span class="text-gray-500">Transaction</span>
          <span class="font-semibold text-main font-mono text-xs">{{ truncateHash((activeTab === 'withdraw' && unwrapProgress?.ethTxHash) || lastTxInfo.txHash) }}</span>
        </div>
      </div>

      <!-- View on Explorer Button -->
      <div v-if="(activeTab === 'withdraw' && unwrapProgress?.ethTxHash) || lastTxInfo?.txHash" class="mt-4 flex justify-center w-full">
        <a
          :href="getExplorerTxLink(
            activeTab === 'withdraw' && unwrapProgress?.ethTxHash 
              ? 'ethereum' 
              : (lastTxInfo?.chainId || lastTxInfo?.type || 'external'), 
            (activeTab === 'withdraw' && unwrapProgress?.ethTxHash) || lastTxInfo?.txHash
          )"
          target="_blank"
          rel="noopener noreferrer"
          class="btn btn-outline btn-sm w-full py-2.5 flex items-center justify-center gap-1.5"
        >
          <Icon icon="mdi:open-in-new" class="text-sm" />
          View on Explorer
        </a>
      </div>

      <!-- Bottom Full-width Retry Button -->
      <div class="flex justify-center mt-5 pt-4 border-t border-gray-200 dark:border-gray-700">
        <button @click="$emit('retry')" class="btn btn-sm btn-primary w-full text-white">
          <Icon icon="mdi:refresh" class="mr-1" />
          Retry
        </button>
      </div>
    </div>

    <!-- 3. INCOMPLETE / PENDING VIEW -->
    <div v-else-if="isTransactionPending" class="text-center py-4">
      <!-- Yellow Inactive Order Icon -->
      <div class="w-12 h-12 rounded-full bg-yellow-100 dark:bg-yellow-900/30 flex items-center justify-center mx-auto mb-3.5">
        <Icon icon="material-symbols:inactive-order" class="text-2xl text-yellow-600 dark:text-yellow-500" />
      </div>

      <!-- Title & Subtitle -->
      <div class="text-lg font-bold text-main">
        {{ activeTab === 'deposit' ? 'Deposit Incomplete' : 'Withdrawal Incomplete' }}
      </div>
      <p class="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-sm mx-auto px-4 break-words">
        <template v-if="txError || unwrapProgress?.error || (unwrapProgress?.status === 'failed' && unwrapProgress?.message)">
          {{ formatError(txError || unwrapProgress?.error || unwrapProgress?.message) }}
        </template>
        <template v-else>
          We found an incomplete bridge transaction in your browser cache.
        </template>
      </p>

      <!-- Completed & Incomplete Checklist items -->
      <div class="space-y-2.5 text-left my-5">
        <!-- EVM Withdraw -->
        <template v-if="activeTab === 'withdraw' && lastTxInfo?.type === 'eth'">
          <div class="flex items-center gap-3 text-sm text-green-600 dark:text-green-400 font-medium">
            <Icon icon="mdi:check-circle-outline" class="text-lg shrink-0" />
            <span>Burn tokens on Gonka</span>
          </div>
          <div class="flex items-center gap-3 text-sm text-yellow-600 dark:text-yellow-500 font-medium">
            <Icon icon="mdi:alert-circle-outline" class="text-lg shrink-0 animate-pulse" />
            <span>Validator signatures</span>
          </div>
          <div class="flex items-center gap-3 text-sm text-gray-400 dark:text-gray-600 font-medium">
            <Icon icon="mdi:circle-outline" class="text-lg shrink-0" />
            <span>Release on Ethereum</span>
          </div>
        </template>

        <!-- EVM Deposit -->
        <template v-else-if="activeTab === 'deposit' && lastTxInfo?.type === 'eth'">
          <div class="flex items-center gap-3 text-sm text-green-600 dark:text-green-400 font-medium">
            <Icon icon="mdi:check-circle-outline" class="text-lg shrink-0" />
            <span>Lock tokens on Ethereum</span>
          </div>
          <div class="flex items-center gap-3 text-sm text-yellow-600 dark:text-yellow-500 font-medium">
            <Icon icon="mdi:alert-circle-outline" class="text-lg shrink-0 animate-pulse" />
            <span>Validator signatures</span>
          </div>
          <div class="flex items-center gap-3 text-sm text-gray-400 dark:text-gray-600 font-medium">
            <Icon icon="mdi:circle-outline" class="text-lg shrink-0" />
            <span>Mint on Gonka</span>
          </div>
        </template>

        <!-- IBC Transfer (Deposit & Withdraw) -->
        <template v-else-if="lastTxInfo?.type === 'ibc'">
          <div class="flex items-center gap-3 text-sm text-green-600 dark:text-green-400 font-medium">
            <Icon icon="mdi:check-circle-outline" class="text-lg shrink-0" />
            <span>Approve transfer in wallet</span>
          </div>
          <div class="flex items-center gap-3 text-sm text-yellow-600 dark:text-yellow-500 font-medium">
            <Icon icon="mdi:alert-circle-outline" class="text-lg shrink-0 animate-pulse" />
            <span>IBC packet relay transfer</span>
          </div>
        </template>
      </div>

      <!-- Summary Table inside a card -->
      <div v-if="lastTxInfo" class="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4 text-left space-y-1.5 border border-gray-100 dark:border-gray-700/40">
        <div class="flex justify-between text-sm">
          <span class="text-gray-500">Amount</span>
          <span class="font-semibold text-main">{{ lastTxInfo.amount }} {{ lastTxInfo.token }}</span>
        </div>
        <div class="flex justify-between text-sm">
          <span class="text-gray-500">Network</span>
          <span class="font-semibold text-main">{{ activeTab === 'deposit' ? lastTxInfo.from : lastTxInfo.to }}</span>
        </div>
        <div v-if="lastTxInfo.txHash" class="flex justify-between text-sm">
          <span class="text-gray-500">Gonka Transaction</span>
          <span class="font-semibold text-main font-mono text-xs">{{ truncateHash(lastTxInfo.txHash) }}</span>
        </div>
      </div>

      <!-- Bottom Side-by-Side Action Buttons for Resume/Discard -->
      <div class="flex gap-3 mt-5 pt-4 border-t border-gray-200 dark:border-gray-700">
        <button @click="$emit('resumePending')" class="btn btn-sm btn-primary flex-1 text-white">
          <Icon icon="mdi:play" class="mr-1" />
          Resume Transaction
        </button>
        <button @click="$emit('discardPending')" class="btn btn-sm btn-outline border-gray-300 dark:border-gray-700 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 flex-1">
          <Icon icon="mdi:delete" class="mr-1 text-red-500" />
          Discard
        </button>
      </div>
    </div>
  </div>
</template>
