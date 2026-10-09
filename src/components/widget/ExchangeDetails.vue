<script lang="ts" setup>
import { ref, computed } from 'vue';
import { Icon } from '@iconify/vue';

const props = defineProps<{
  activeTab: 'deposit' | 'withdraw' | 'purchase';
  isConnected: boolean;
  walletAddress: string;
  allDepositTokens: any[];
  withdrawableTokens: any[];
  calculating: boolean;
  error: string;
  txError: string;
  pendingUnwrap: any;
  epochStatus: any;
  epochStatusLoading: boolean;
  epochUpdateLoading: boolean;
  epochUpdateMessage: string;
  isAddressMismatch: boolean;
  approximateFee: string;
  feeLoading: boolean;
  depositTokenBalance: string;
  depositBalanceLoading: boolean;
  // standard v-model props for Vue 3.2 compatibility
  depositAmount: string;
  withdrawAmount: string;
  selectedDepositToken: any;
  selectedWithdrawToken: any;
  withdrawDestinationAddress: string;
  format: {
    formatToken(balance: any): string;
  };
}>();

const emit = defineEmits<{
  (e: 'submit'): void;
  (e: 'retryLoading'): void;
  (e: 'updateBridgeEpoch'): void;
  (e: 'clearPending'): void;
  (e: 'resumePending'): void;
  (e: 'update:currentStep', val: number): void;
  // v-model update emits
  (e: 'update:depositAmount', val: string): void;
  (e: 'update:withdrawAmount', val: string): void;
  (e: 'update:selectedDepositToken', val: any): void;
  (e: 'update:selectedWithdrawToken', val: any): void;
  (e: 'update:withdrawDestinationAddress', val: string): void;
}>();

// Vue 3.2 compatible getter/setter computed properties
const localDepositAmount = computed({
  get: () => props.depositAmount,
  set: (val) => emit('update:depositAmount', val)
});

const localWithdrawAmount = computed({
  get: () => props.withdrawAmount,
  set: (val) => emit('update:withdrawAmount', val)
});

const localSelectedDepositToken = computed({
  get: () => props.selectedDepositToken,
  set: (val) => emit('update:selectedDepositToken', val)
});

const localSelectedWithdrawToken = computed({
  get: () => props.selectedWithdrawToken,
  set: (val) => emit('update:selectedWithdrawToken', val)
});

const localWithdrawDestinationAddress = computed({
  get: () => props.withdrawDestinationAddress,
  set: (val) => emit('update:withdrawDestinationAddress', val)
});

// Dropdown state local to details component
const isDepositDropdownOpen = ref(false);
const isWithdrawDropdownOpen = ref(false);

const depositExceedsBalance = computed(() => {
  if (!props.depositAmount || !props.depositTokenBalance) return false;
  return parseFloat(props.depositAmount) > parseFloat(props.depositTokenBalance);
});

const withdrawExceedsBalance = computed(() => {
  if (!props.withdrawAmount || !props.selectedWithdrawToken) return false;
  return parseFloat(props.withdrawAmount) > parseFloat(props.selectedWithdrawToken.formatted_balance);
});

// Dropdown handler helpers
function toggleDepositDropdown() {
  if (props.allDepositTokens.length > 0) {
    isDepositDropdownOpen.value = !isDepositDropdownOpen.value;
  }
}

function toggleWithdrawDropdown() {
  if (props.withdrawableTokens.length > 0) {
    isWithdrawDropdownOpen.value = !isWithdrawDropdownOpen.value;
  }
}
</script>

<template>
  <div class="mt-2">
    <div class="rounded-lg border border-gray-200 dark:border-gray-700 p-5">
      <div class="text-base font-semibold text-main mb-1">
        Step 2 · Enter {{ activeTab }} details
      </div>
      <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
        <template v-if="activeTab === 'deposit'">
          Set the amount and source token. Funds move from your Ethereum wallet into Gonka via the bridge.
        </template>
        <template v-else>
          Select the token and amount to withdraw from Gonka.
        </template>
      </p>

      <!-- ===== DEPOSIT FORM ===== -->
      <div v-if="activeTab === 'deposit'" class="space-y-4">
        <div class="relative w-full" :class="{ 'pointer-events-none opacity-[0.4]': allDepositTokens.length === 0 }">
          <div v-if="allDepositTokens.length === 0" class="absolute inset-0 flex items-center justify-center z-10">
             <span class="bg-base-100 px-3 py-1 rounded text-sm font-semibold shadow-sm text-red-500 border border-red-200 dark:border-red-800">{{ $t('developer.no_approved_tokens') }}</span>
          </div>

          <div class="space-y-4">
            <div class="w-full">
              <!-- Labels row above inputs -->
              <div class="flex gap-[10%] text-sm text-gray-500 dark:text-gray-400 mb-1.5">
                <!-- Dropdown Label (above dropdown, w-[40%]) -->
                <div class="w-[40%] pl-1">
                  <span class="font-semibold text-main">{{ $t('developer.token') }}</span>
                </div>

                <!-- Amount Input Labels (above input, w-[50%]) -->
                <div class="w-[50%] flex justify-between items-end pr-1">
                  <span class="font-semibold text-main">{{ $t('developer.amount') }}</span>
                  <div class="text-[10px]">
                    <span v-if="selectedDepositToken && depositTokenBalance" :class="{ 'text-red-500': depositExceedsBalance }">
                      {{ $t('developer.balance') }}: {{ depositTokenBalance }} {{ selectedDepositToken.symbol }}
                    </span>
                    <span v-else-if="depositBalanceLoading">
                      <Icon icon="mdi:loading" class="animate-spin inline-block" />
                    </span>
                    <span v-else>-</span>
                  </div>
                </div>
              </div>

              <div class="flex items-center gap-[10%]">
                <!-- Token selector (now on the left) -->
                <div class="w-[40%] relative custom-dropdown">
                  <div
                    class="input input-bordered input-sm bg-base-100 flex justify-between items-center w-full px-2 h-10 border"
                    :class="[
                      allDepositTokens.length > 0 ? 'cursor-pointer' : 'cursor-not-allowed bg-gray-50 dark:bg-gray-800 !border-transparent',
                      isDepositDropdownOpen ? '!border-primary dark:!border-primary ring-1 ring-primary' : '!border-gray-300 dark:!border-gray-600'
                    ]"
                    @click="toggleDepositDropdown"
                  >
                    <div v-if="selectedDepositToken" class="truncate font-semibold flex items-center gap-1.5 text-main">
                      {{ selectedDepositToken.symbol }}
                      <span v-if="selectedDepositToken.type === 'ibc'" class="badge badge-xs badge-info badge-outline p-1.5">IBC</span>
                      <span v-else class="badge badge-xs border-gray-400 text-gray-500 badge-outline p-1.5 ml-1">Bridge</span>
                    </div>
                    <div v-else-if="allDepositTokens.length > 0" class="text-gray-400">{{ $t('developer.select') }}</div>
                    <div v-else class="text-transparent select-none">-</div>
                    <Icon icon="mdi:chevron-down" class="text-gray-400 shrink-0" :class="{ 'opacity-0': allDepositTokens.length === 0 }" />
                  </div>
 
                  <div v-if="isDepositDropdownOpen && allDepositTokens.length > 0" class="absolute left-0 z-20 w-64 mt-1 bg-base-100 border border-base-300 rounded-md shadow-lg max-h-48 overflow-auto">
                    <div
                      class="px-3 py-2 cursor-pointer hover:bg-base-200 text-sm"
                      @click="emit('update:selectedDepositToken', null); isDepositDropdownOpen = false"
                    >
                      <span class="text-gray-400">{{ $t('developer.none') }}</span>
                    </div>
                    <div
                      v-for="(token, idx) in allDepositTokens" :key="idx"
                      class="px-3 py-2 border-t border-base-200 cursor-pointer hover:bg-base-200 flex flex-col"
                      @click="emit('update:selectedDepositToken', token); isDepositDropdownOpen = false"
                    >
                       <div class="flex items-center gap-2">
                         <span class="text-sm font-semibold text-main">{{ token.symbol }}</span>
                         <span class="text-xs text-gray-500">({{ token.chainId }})</span>
                         <span v-if="token.type === 'ibc'" class="badge badge-xs badge-info badge-outline ml-auto bg-base-100 p-1.5">IBC</span>
                         <span v-else class="badge badge-xs border-gray-400 text-gray-500 badge-outline ml-auto bg-base-100 p-1.5">Bridge</span>
                       </div>
                       <span class="text-[10px] text-gray-400 truncate mt-1" :title="token.contractAddress">{{ token.contractAddress }}</span>
                    </div>
                  </div>
                </div>
 
                <!-- Amount input (now on the right) -->
                <div class="w-[50%]">
                  <input
                    v-model="localDepositAmount"
                    type="number"
                    min="0"
                    step="0.01"
                    :placeholder="$t('developer.enter_amount')"
                    class="input input-bordered input-sm w-full bg-base-100 h-10 border !border-gray-300 dark:!border-gray-600 focus:!border-primary dark:focus:!border-primary focus:!ring-1 focus:!ring-primary focus:outline-none"
                    :class="{ 'input-error': depositExceedsBalance }"
                    :disabled="!isConnected"
                  />
                </div>
              </div>
            </div>

            <!-- Receiving address (auto-filled from wallet) -->
            <div v-if="isConnected && walletAddress" class="w-full">
              <div class="flex justify-between items-center mb-1.5">
                <span class="text-sm font-semibold text-main">Receiving address on Gonka</span>
                <span class="text-xs text-gray-600 dark:text-gray-400">
                  {{ $t('developer.auto_filled') }}
                </span>
              </div>
              <input
                :value="walletAddress"
                type="text"
                readonly
                class="input input-bordered input-sm w-full bg-gray-50 dark:bg-gray-800 text-gray-500 font-mono text-xs h-10 border !border-gray-300 dark:!border-gray-600"
              />
            </div>
          </div>
        </div>

        <!-- Processing Time / Wallet Status / Server Error -->
        <div class="flex flex-col items-center justify-center text-center gap-1.5">
          <div v-if="error" class="text-xs transition-colors duration-300 h-4 flex items-center text-red-500 dark:text-red-400 font-semibold gap-1">
            <Icon icon="mdi:alert-circle-outline" class="inline-block" /> {{ error }}
          </div>
          <div v-else-if="isAddressMismatch && selectedDepositToken?.type === 'eth'" class="text-xs text-red-500 dark:text-red-400 font-semibold px-4 leading-relaxed flex items-start justify-center gap-1.5 text-left whitespace-pre-line">
            <Icon icon="mdi:alert-circle-outline" class="inline-block shrink-0 animate-pulse text-red-500 dark:text-red-400 w-4 h-4 mt-0.5" />
            <span>{{ $t('developer.mnemonic_mismatch_warning') }}</span>
          </div>
          <div class="text-xs transition-colors duration-300 h-4 flex items-center text-gray-500 dark:text-gray-400" :class="{ 'opacity-0': !selectedDepositToken }">
            <template v-if="selectedDepositToken?.type === 'ibc'">
              <Icon icon="mdi:clock-outline" class="inline-block mr-0.5" /> {{ $t('developer.processing_time_ibc') }}
            </template>
            <template v-else-if="selectedDepositToken?.type === 'eth'">
              <Icon icon="mdi:clock-outline" class="inline-block mr-0.5" /> {{ $t('developer.processing_time_eth') }}
            </template>
          </div>
        </div>

        <!-- Approximate Fee Note -->
        <div v-if="isConnected && (selectedDepositToken?.type === 'eth' || selectedDepositToken?.type === 'ibc') && (feeLoading || approximateFee)" class="text-xs text-gray-500 dark:text-gray-400 flex items-center justify-center gap-1 text-center">
          <Icon icon="mdi:gas-station" class="inline-block mr-0.5" />
          <span>{{ $t('developer.approximate_fee') }}</span>
          <span v-if="feeLoading" class="inline-block w-16 h-3 bg-gray-300 dark:bg-gray-700 animate-pulse rounded ml-1"></span>
          <span v-else>{{ approximateFee }}</span>
        </div>
      </div>

      <!-- ===== WITHDRAW FORM ===== -->
      <div v-else-if="activeTab === 'withdraw'" class="space-y-4">
        <div class="relative w-full" :class="{ 'pointer-events-none': withdrawableTokens.length === 0 }">
          <div class="flex flex-col relative" :class="{ 'opacity-[0.4]': withdrawableTokens.length === 0 && isConnected }">
            <div v-if="withdrawableTokens.length === 0 && isConnected" class="absolute inset-0 flex items-center justify-center z-10">
              <span class="bg-base-100 px-3 py-1 rounded text-sm font-semibold shadow-sm text-gray-500 border border-gray-200 dark:border-gray-700">{{ $t('developer.no_tokens_to_withdraw') }}</span>
            </div>

            <div class="space-y-4">
              <div class="w-full">
                <!-- Token selector & Amount input -->
                <!-- Labels row above inputs -->
                <div class="flex gap-[10%] text-sm text-gray-500 dark:text-gray-400 mb-1.5">
                  <!-- Dropdown Label (above dropdown, w-[40%]) -->
                  <div class="w-[40%] pl-1">
                    <span class="font-semibold text-main">{{ $t('developer.token') }}</span>
                  </div>

                  <!-- Amount Input Labels (above input, w-[50%]) -->
                  <div class="w-[50%] flex justify-between items-end pr-1">
                    <span class="font-semibold text-main">{{ $t('developer.amount') }}</span>
                    <div class="text-[10px]">
                      <span v-if="selectedWithdrawToken" :class="{ 'text-red-500': withdrawExceedsBalance }">
                        {{ $t('developer.balance') }}: {{ parseFloat(selectedWithdrawToken.formatted_balance).toFixed(6) }} {{ selectedWithdrawToken.symbol }}
                      </span>
                    </div>
                  </div>
                </div>

                <div class="flex items-center gap-[10%]">
                  <!-- Token selector (now on the left) -->
                  <div class="w-[40%] relative custom-dropdown">
                    <div
                      class="input input-bordered input-sm bg-base-100 flex justify-between items-center w-full px-2 h-10 border"
                      :class="[
                        withdrawableTokens.length > 0 ? 'cursor-pointer' : 'cursor-not-allowed bg-gray-50 dark:bg-gray-800 !border-transparent',
                        isWithdrawDropdownOpen ? '!border-primary dark:!border-primary ring-1 ring-primary' : '!border-gray-300 dark:!border-gray-600'
                      ]"
                      @click="toggleWithdrawDropdown"
                    >
                      <div v-if="selectedWithdrawToken" class="truncate font-semibold flex items-center gap-1.5 text-main">
                        {{ selectedWithdrawToken.symbol }}
                        <span v-if="selectedWithdrawToken.isNative" class="badge badge-xs badge-info badge-outline p-1.5">IBC</span>
                        <span v-else class="badge badge-xs border-gray-400 text-gray-500 badge-outline p-1.5 ml-1">Bridge</span>
                      </div>
                      <div v-else-if="withdrawableTokens.length > 0" class="text-gray-400">{{ $t('developer.select') }}</div>
                      <div v-else class="text-transparent select-none">-</div>
                      <Icon icon="mdi:chevron-down" class="text-gray-400 shrink-0" :class="{ 'opacity-0': withdrawableTokens.length === 0 }" />
                    </div>

                    <div v-if="isWithdrawDropdownOpen && withdrawableTokens.length > 0" class="absolute left-0 z-20 w-64 mt-1 bg-base-100 border border-base-300 rounded-md shadow-lg max-h-48 overflow-auto">
                      <div
                        class="px-3 py-2 cursor-pointer hover:bg-base-200 text-sm"
                        @click="emit('update:selectedWithdrawToken', null); isWithdrawDropdownOpen = false"
                      >
                        <span class="text-gray-400">{{ $t('developer.none') }}</span>
                      </div>
                      <div
                        v-for="token in withdrawableTokens" :key="token.symbol"
                        class="px-3 py-2 border-t border-base-200 cursor-pointer hover:bg-base-200 flex flex-col"
                        @click="emit('update:selectedWithdrawToken', token); isWithdrawDropdownOpen = false"
                      >
                        <div class="flex items-center gap-2">
                          <span class="text-sm font-semibold text-main">{{ token.symbol }}</span>
                          <span class="text-xs text-gray-500" v-if="token.token_info?.chainId">({{ token.token_info?.chainId }})</span>
                          <span v-if="token.isNative" class="badge badge-xs badge-info badge-outline ml-auto bg-base-100 p-1.5">IBC</span>
                          <span v-else class="badge badge-xs border-gray-400 text-gray-500 badge-outline ml-auto bg-base-100 p-1.5">Bridge</span>
                        </div>
                        <span class="text-[10px] text-gray-400 mt-1">
                          Balance: {{ parseFloat(token.formatted_balance).toFixed(6) }}
                        </span>
                      </div>
                    </div>
                  </div>

                  <!-- Amount input (now on the right) -->
                  <div class="w-[50%]">
                    <input
                      v-model="localWithdrawAmount"
                      type="number"
                      min="0"
                      step="0.01"
                      :placeholder="$t('developer.enter_amount')"
                      class="input input-bordered input-sm w-full bg-base-100 h-10 border !border-gray-300 dark:!border-gray-600 focus:!border-primary dark:focus:!border-primary focus:!ring-1 focus:!ring-primary focus:outline-none"
                      :class="{ 'input-error': withdrawExceedsBalance }"
                      :disabled="!isConnected"
                    />
                  </div>
                </div>
              </div>

              <!-- Destination address -->
              <div class="w-full">
                <div class="flex justify-between items-center mb-1.5">
                  <span class="text-sm font-semibold text-main">{{ $t('developer.destination_address') }}</span>
                  <span v-if="selectedWithdrawToken && withdrawDestinationAddress" class="text-xs text-gray-600 dark:text-gray-400">
                    {{ $t('developer.auto_filled') }}
                  </span>
                </div>
                <input
                  v-model="localWithdrawDestinationAddress"
                  type="text"
                  :placeholder="!selectedWithdrawToken ? $t('developer.select_token_first') : (selectedWithdrawToken.isNative ? $t('developer.enter_cosmos_address') : $t('developer.enter_eth_address'))"
                  class="input input-bordered input-sm w-full bg-base-100 h-10 border !border-gray-300 dark:!border-gray-600 focus:!border-primary dark:focus:!border-primary focus:!ring-1 focus:!ring-primary focus:outline-none"
                  :disabled="!isConnected || !selectedWithdrawToken"
                />
              </div>
            </div>
          </div>
        </div>

        <!-- Withdraw type hint / Bridge status -->
        <div class="flex flex-col items-center text-center">
          <div v-if="error" class="text-xs transition-colors duration-300 flex items-center text-red-500 dark:text-red-400 font-semibold gap-1">
            <Icon icon="mdi:alert-circle-outline" class="inline-block" /> {{ error }}
          </div>

          <!-- Bridge is in ADMIN MODE -->
          <div v-else-if="selectedWithdrawToken && !selectedWithdrawToken.isNative && epochStatus && epochStatus.isAdminMode" class="text-xs text-red-500 space-y-1 mb-1 font-semibold">
            <div class="flex items-center justify-center gap-1">
              <Icon icon="mdi:lock-outline" class="text-red-500 shrink-0 animate-pulse" />
              {{ $t('developer.bridge_admin_mode') }}
            </div>
            <div class="text-[10px] opacity-80 font-normal">
              {{ $t('developer.bridge_admin_mode_message') }}
            </div>
          </div>

          <!-- Bridge behind -->
          <div v-else-if="selectedWithdrawToken && !selectedWithdrawToken.isNative && epochStatus && !epochStatus.isSynced" class="text-xs text-amber-600 dark:text-amber-400 space-y-1 mb-1">
            <div class="font-semibold flex items-center justify-center gap-1">
              <Icon icon="mdi:alert-outline" class="text-amber-500 shrink-0" />
              {{ $t('developer.bridge_epoch_behind') }}
            </div>
            <div>
              {{ $t('developer.bridge_epoch_info', { bridgeEpoch: epochStatus.bridgeEpoch, chainEpoch: epochStatus.chainEpoch, epochsBehind: epochStatus.epochsBehind }) }}
            </div>
            <div class="opacity-90">
              {{ $t('developer.bridge_epoch_warning') }}
            </div>
            <div v-if="epochUpdateMessage" class="font-semibold mt-1" :class="txError ? 'text-red-500' : 'text-green-600 dark:text-green-400'">
              {{ epochUpdateMessage }}
            </div>
          </div>

          <!-- Normal hints when synced or native -->
          <div v-else class="text-xs transition-colors duration-300 flex items-center text-gray-500 dark:text-gray-400" :class="{ 'opacity-0': !selectedWithdrawToken }">
            <template v-if="selectedWithdrawToken?.isNative">
              <Icon icon="mdi:clock-outline" class="inline-block mr-0.5 animate-pulse" /> {{ $t('developer.withdraw_time_ibc') }}
            </template>
            <template v-else-if="selectedWithdrawToken && !selectedWithdrawToken.isNative">
              <span v-if="epochStatus && epochStatus.isSynced" class="text-green-600 dark:text-green-400 flex items-center gap-1">
                <Icon icon="mdi:check-circle" />
                {{ $t('developer.bridge_epoch_synced') }} (Epoch {{ epochStatus.bridgeEpoch }})
              </span>
              <span v-else-if="epochStatusLoading" class="text-gray-400 flex items-center gap-1">
                <Icon icon="mdi:loading" class="animate-spin" />
                {{ $t('developer.checking_bridge_epoch') }}
              </span>
              <span v-else>
                <Icon icon="mdi:clock-outline" class="inline-block mr-0.5" /> {{ $t('developer.withdraw_time_eth') }}
              </span>
            </template>
          </div>
        </div>

        <!-- Approximate Fee Note for withdraw -->
        <div v-if="isConnected && selectedWithdrawToken && !selectedWithdrawToken.isNative && (feeLoading || approximateFee)" class="text-xs text-gray-500 dark:text-gray-400 flex items-center justify-center gap-1 text-center">
          <Icon icon="mdi:gas-station" class="inline-block mr-0.5" />
          <span>{{ $t('developer.approximate_fee') }}</span>
          <span v-if="feeLoading" class="inline-block w-16 h-3 bg-gray-300 dark:bg-gray-700 animate-pulse rounded ml-1"></span>
          <span v-else>{{ approximateFee }}</span>
        </div>
      </div>

      <!-- Navigation buttons -->
      <div class="flex items-center justify-between mt-5 pt-4 border-t border-gray-200 dark:border-gray-700">
        <button @click="emit('update:currentStep', 1)" class="btn btn-sm btn-outline border-gray-300 dark:border-gray-700 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 gap-1">
          ← Back
        </button>

        <!-- Deposit submit -->
        <template v-if="activeTab === 'deposit'">
          <button
            v-if="error"
            class="btn btn-sm btn-error btn-outline"
            @click="emit('retryLoading')"
          >
            <Icon icon="mdi:refresh" class="mr-1" />
            {{ $t('developer.retry') }}
          </button>
          <button
            v-else
            class="btn btn-sm btn-primary text-white"
            :disabled="!selectedDepositToken || !depositAmount || parseFloat(depositAmount) <= 0 || depositExceedsBalance || calculating || isAddressMismatch"
            @click="emit('submit')"
          >
            <Icon v-if="calculating" icon="mdi:loading" class="animate-spin mr-1" />
            Review &amp; bridge →
          </button>
        </template>

        <!-- Withdraw submit -->
        <template v-else-if="activeTab === 'withdraw'">
          <button
            v-if="error"
            class="btn btn-sm btn-error btn-outline"
            @click="emit('retryLoading')"
          >
            <Icon icon="mdi:refresh" class="mr-1" />
            {{ $t('developer.retry') }}
          </button>

          <!-- Disallowed: Admin Mode -->
          <button
            v-else-if="selectedWithdrawToken && !selectedWithdrawToken.isNative && epochStatus && epochStatus.isAdminMode"
            class="btn btn-sm btn-error text-white cursor-not-allowed opacity-60"
            disabled
          >
            <Icon icon="mdi:lock-outline" class="mr-1" />
            {{ $t('developer.bridge_in_admin_mode_btn') }}
          </button>

          <!-- Update Bridge -->
          <button
            v-else-if="selectedWithdrawToken && !selectedWithdrawToken.isNative && epochStatus && !epochStatus.isSynced"
            class="btn btn-sm btn-primary text-white"
            :disabled="epochUpdateLoading"
            @click="emit('updateBridgeEpoch')"
          >
            <Icon v-if="epochUpdateLoading" icon="mdi:loading" class="animate-spin mr-1" />
            {{ epochUpdateLoading ? $t('developer.updating_bridge') : $t('developer.update_bridge') }}
          </button>

          <!-- Normal Withdraw -->
          <button
            v-else
            class="btn btn-sm btn-primary text-white"
            :disabled="!selectedWithdrawToken || !withdrawAmount || parseFloat(withdrawAmount) <= 0 || withdrawExceedsBalance || !withdrawDestinationAddress || calculating"
            @click="emit('submit')"
          >
            <Icon v-if="calculating" icon="mdi:loading" class="animate-spin mr-1" />
            Review &amp; bridge →
          </button>
        </template>
      </div>
    </div>
  </div>
</template>
