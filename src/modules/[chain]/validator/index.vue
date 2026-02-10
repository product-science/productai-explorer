<script lang="ts" setup>
import {
    useBaseStore,
    useBlockchain,
    useFormatter,
    useMintStore,
    useValidatorStore,
    useTxDialog,
} from '@/stores';
import { computed } from '@vue/reactivity';
import { onMounted, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import Countdown from '@/components/Countdown.vue';
import PaginationBar from '@/components/PaginationBar.vue';
import { fromHex, toBase64 } from '@cosmjs/encoding';
import type { Key, SlashingParam, Validator } from '@/types';
import type { SigningInfo } from '@/types';
import { consensusPubkeyToHexAddress, valconsToBase64 } from '@/libs';
import CardStatisticsVertical from '@/components/CardStatisticsVertical.vue';
import ValidatorListSkeleton from '@/components/ValidatorListSkeleton.vue';
import { useWindowSize } from '@vueuse/core';


const validatorStore = useValidatorStore();
const base = useBaseStore();
const format = useFormatter();
const dialog = useTxDialog();
const chainStore = useBlockchain();
const mintStore = useMintStore()

// Remove old local power-change calculation; now handled in store
const tab = ref('active');
const unbondList = ref([] as Validator[]);
const slashing = ref({} as SlashingParam)
const isHoveringNext = ref(false)

// Epoch selector state (using PaginationBar)
const selectedEpoch = ref<number | null>(null); // null = current epoch
const loadingEpoch = ref(false);
const epochTotal = computed(() => Number(chainStore.currentEpochIndex || 0) || 0);
const currentEpochPage = computed(() => {
    const currentIdx = epochTotal.value;
    if (!currentIdx) return 1;
    return selectedEpoch.value === null ? currentIdx : selectedEpoch.value;
});

// Responsive pagination
const { width } = useWindowSize();
const maxVisiblePages = computed(() => (width.value < 640 ? 3 : 5));

// Next PoC mini widget state with phase switching
const currentHeight = computed(() => Number(base.latest?.block?.header?.height || 0))

type PhaseInfo = { labelKey: string; targetHeight: number | null }
const pocPhase = computed<PhaseInfo>(() => {
    const h = currentHeight.value
    const pocStart = Number(chainStore.nextPocStart || 0) || null
    const genEnd = Number(chainStore.nextPocGenerationEnd || 0) || null
    const valStart = Number(chainStore.nextPocValidationStart || 0) || null
    const valEnd = Number(chainStore.nextPocValidationEnd || 0) || null
    const setNew = Number(chainStore.nextSetNewValidators || 0) || null
    const nextPocStart = Number(chainStore.nextPocStart || 0) || null

    // Before next epoch PoC start → show Next PoC
    if (pocStart && h < pocStart) return { labelKey: 'validator.next_poc', targetHeight: pocStart }
    // PoC Generation phase
    if (pocStart && genEnd && h >= pocStart && h < genEnd) return { labelKey: 'validator.poc_generation', targetHeight: genEnd }
    // PoC Validation phase
    if (valStart && valEnd && h >= valStart && h < valEnd) return { labelKey: 'validator.poc_validation', targetHeight: valEnd }
    // Selecting new Active Validators
    if (valEnd && setNew && h >= valEnd && h < setNew) return { labelKey: 'validator.selecting_new_validators', targetHeight: setNew }
    // After setting new validators → countdown to Next PoC for the following epoch
    if (setNew && nextPocStart && h >= setNew && h < nextPocStart) return { labelKey: 'validator.next_poc', targetHeight: nextPocStart }
    // Fallback to simple next PoC target
    if (chainStore.nextPocStart) return { labelKey: 'validator.next_poc', targetHeight: Number(chainStore.nextPocStart) }
    return { labelKey: 'validator.next_poc', targetHeight: null }
})

const hasMeasuredBlockTime = computed(() => {
    const latestH = Number(base.latest?.block?.header?.height || 0)
    const earliestH = Number((base as any).earlest?.block?.header?.height || 0)
    return latestH > 0 && earliestH > 0 && latestH !== earliestH
})

const pocEstimateMs = computed(() => {
    if (!hasMeasuredBlockTime.value || currentHeight.value <= 0) return 0
    const target = Number(pocPhase.value.targetHeight || 0)
    const remaining = target > 0 ? target - currentHeight.value : 0
    const ms = Number(remaining * (base.blocktime || 0))
    return ms > 0 ? ms : 0
})

// Auto-refresh epoch info once when passing set_new_validators to get fresh next stages
const refreshedAfterSet = ref(false)
watch(() => currentHeight.value, async () => {
    const setNew = Number(chainStore.nextSetNewValidators || 0)
    if (!refreshedAfterSet.value && setNew && currentHeight.value >= setNew) {
        try { await chainStore.fetchLatestEpochInfo() } catch {}
        refreshedAfterSet.value = true
    }
    // Reset the guard if next epoch start moved forward
    const nextStart = Number(chainStore.nextPocStart || 0)
    if (nextStart && currentHeight.value < nextStart) {
        refreshedAfterSet.value = false
    }
})

// Sorting state
type SortKey =
  | 'validator'
  | 'voting_power'
  | 'change24'
  | 'earned'
  | 'claimed'
  | 'active'
  | 'reputation'
  | 'missed'
  | 'uptime'
  | 'inferences'
  | 'missed_requests'
const storedSortRaw = localStorage.getItem('validator-sort-by') as any
const initialSortKey: SortKey = (storedSortRaw === 'rank' ? 'voting_power' : storedSortRaw) || 'voting_power'
const sortBy = ref<SortKey>(initialSortKey)
const sortDesc = ref(localStorage.getItem('validator-sort-desc') === 'true')

function toggleSort(key: typeof sortBy.value) {
    if (sortBy.value === key) {
        sortDesc.value = !sortDesc.value
    } else {
        sortBy.value = key
        // Default sort direction per column
        sortDesc.value = key !== 'validator' // strings asc by default, numbers desc
    }
    
    // Save sort state to localStorage
    localStorage.setItem('validator-sort-by', sortBy.value)
    localStorage.setItem('validator-sort-desc', sortDesc.value.toString())
}

function sortIcon(key: typeof sortBy.value) {
    if (sortBy.value !== key) return 'mdi:chevron-up'
    return sortDesc.value ? 'mdi:chevron-down' : 'mdi:chevron-up'
}

// Uptime and slashing state
const signingInfo = ref({} as Record<string, SigningInfo>);

// Function to fetch slashing signing info
async function updateSlashingSigningInfo() {
    try {
        const response = await chainStore.rpc.getSlashingSigningInfos();
        if (response.info) {
            response.info.forEach((info: SigningInfo) => {
                signingInfo.value[valconsToBase64(info.address)] = info;
            });
        }
    } catch (error) {
        console.error('Error fetching slashing signing info:', error);
    }
}

// Function to get validator's base64 address from consensus pubkey
function getValidatorBase64Address(validator: Validator): string {
    try {
        const hex = consensusPubkeyToHexAddress(validator.consensus_pubkey);
        return toBase64(fromHex(hex));
    } catch (error) {
        console.error('Error converting validator address:', error);
        return '';
    }
}

// Function to get missed blocks counter for a validator
function getMissedBlocksCounter(validatorAddress: string): number {
    const base64Address = getValidatorBase64AddressFromOperator(validatorAddress);
    const signing = signingInfo.value[base64Address];
    return signing ? Number(signing.missed_blocks_counter) : 0;
}

// Function to get uptime percentage for a validator
function getUptimePercentage(validatorAddress: string): number {
    const base64Address = getValidatorBase64AddressFromOperator(validatorAddress);
    const signing = signingInfo.value[base64Address];
    const window = Number(slashing.value.signed_blocks_window || 0);
    
    if (!signing || window === 0) return 0;
    
    const missedBlocks = Number(signing.missed_blocks_counter);
    return ((window - missedBlocks) / window) * 100;
}

// Function to format missed blocks display
function formatMissedBlocks(validatorAddress: string): string {
    const count = getMissedBlocksCounter(validatorAddress);
    return count === 0 && !getValidatorBase64AddressFromOperator(validatorAddress) ? '-' : count.toString();
}

// Function to format uptime display  
function formatUptime(validatorAddress: string): string {
    const percentage = getUptimePercentage(validatorAddress);
    const base64Address = getValidatorBase64AddressFromOperator(validatorAddress);
    
    if (!base64Address || !signingInfo.value[base64Address]) {
        return '-';
    }
    
    return format.percent(percentage / 100);
}

// Helper function to get base64 address from operator address
function getValidatorBase64AddressFromOperator(operatorAddress: string): string {
    const validator = validatorStore.participantsStakingData.find(v => v.operator_address === operatorAddress);
    if (!validator) return '';
    return getValidatorBase64Address(validator);
}

// Epoch performance helpers (for selected past epoch)
function getEpochInferenceCount(operatorAddress: string): number {
  const stats = validatorStore.getEpochPerformanceForSelectedEpoch(operatorAddress);
  return stats?.inference_count || 0;
}

function getEpochMissedSummary(operatorAddress: string): string {
  const stats = validatorStore.getEpochPerformanceForSelectedEpoch(operatorAddress);
  if (!stats || !stats.inference_count) return '-';
  const missed = Number(stats.missed_requests || 0);
  const total = Number(stats.inference_count || 0);
  if (!Number.isFinite(missed) || !Number.isFinite(total) || total <= 0) return '-';
  const pct = missed / total;
  return `${missed} (${format.percent(pct)})`;
}

// Handle epoch selection change
async function handleEpochChange() {
    // If switching to a past epoch, avoid sorting by columns that are hidden
    const hiddenSortKeys: SortKey[] = ['change24', 'active', 'reputation', 'missed', 'uptime'];
    if (selectedEpoch.value !== null && hiddenSortKeys.includes(sortBy.value)) {
        sortBy.value = 'voting_power';
        sortDesc.value = true;
        localStorage.setItem('validator-sort-by', sortBy.value);
        localStorage.setItem('validator-sort-desc', sortDesc.value.toString());
    }
    if (selectedEpoch.value === null) {
        // Reset to current epoch
        validatorStore.setSelectedEpoch(null);
        return;
    }
    
    loadingEpoch.value = true;
    try {
        // Set selected epoch in store
        validatorStore.setSelectedEpoch(selectedEpoch.value);
        // Fetch epoch data if not cached
        await validatorStore.fetchEpochParticipants(selectedEpoch.value);
        
        // Fetch claimed amounts for this epoch
        const operatorAddresses = validatorStore.participantsStakingData.map(v => v.operator_address);
        await validatorStore.fetchClaimedAmounts(selectedEpoch.value, operatorAddresses);

        // Log totals for debugging/analysis
        if (list.value && list.value.length > 0) {
            let totalEarned = 0n;
            let totalClaimed = 0n;

            list.value.forEach(item => {
                const v = item.v;
                const earnedStr = validatorStore.getEarnedCoins(v.operator_address) || '0';
                const claimedStr = validatorStore.getClaimedAmount(v.operator_address) || '0';
                
                try {
                    // Remove any non-numeric chars if necessary, but usually it's a clean string
                    totalEarned += BigInt(earnedStr);
                } catch (e) {}
                try {
                    totalClaimed += BigInt(claimedStr);
                } catch (e) {}
            });
            
            console.log(`Epoch ${selectedEpoch.value} Totals (from ${list.value.length} rows):`);
            console.log(`Total Earned: ${format.formatToken({ amount: totalEarned.toString(), denom: 'ngonka' }, true, '0,0.[00]')}`);
            console.log(`Total Claimed: ${format.formatToken({ amount: totalClaimed.toString(), denom: 'ngonka' }, true, '0,0.[00]')}`);
        }
    } catch (error) {
        console.error('Error loading epoch data:', error);
    } finally {
        loadingEpoch.value = false;
    }
}

async function handleEpochPageChange(page: number) {
    const currentIdx = epochTotal.value;
    if (!currentIdx) return;

    // Last page corresponds to current epoch (no specific epoch selected in store)
    if (page === currentIdx) {
        selectedEpoch.value = null;
    } else {
        selectedEpoch.value = page;
    }

    await handleEpochChange();
}

onMounted(async () => {
    validatorStore.fetchUnbondingValidators().then((res) => {
        //unbondList.value = res.concat(unbondList.value);
    });
    validatorStore.fetchInactiveValidators().then((res) => {
        //unbondList.value = unbondList.value.concat(res);
    });
    chainStore.rpc.getSlashingParams().then(res => {
        slashing.value = res.params
    })
    
    // Initialize validator store (this will fetch both validators and participants stats)
    validatorStore.init();
    
    // Fetch initial slashing signing info
    updateSlashingSigningInfo();

    // Ensure epoch info is loaded for store power-change calculations
    await chainStore.fetchLatestEpochInfo();
    await validatorStore.fetchPreviousEpochParticipants();
});

const votingPowerChange24 = (entry: { operator_address: string; }) => {
    const dv = validatorStore.getVotingPowerChange24(entry.operator_address);
    return typeof dv === 'number' ? dv : 0;
};

const votingPowerChange24Text = (entry: { operator_address: string; }) => {
    if (!entry) return '';
    const v = votingPowerChange24(entry);
    return v && v !== 0 ? format.showChanges(v) : '';
};

const votingPowerChange24Color = (entry: { operator_address: string; }) => {
    if (!entry) return '';
    const v = votingPowerChange24(entry);
    if (v > 0) return 'text-success';
    if (v < 0) return 'text-error';
};

// Removed rank calculation and display

function isFeatured(endpoints: string[], who?: {website?: string, moniker: string }) {
    if(!endpoints || !who) return false
    return endpoints.findIndex(x => who.website && who.website?.substring(0, who.website?.lastIndexOf('.')).endsWith(x) || who?.moniker?.toLowerCase().search(x.toLowerCase()) > -1) > -1
}

const list = computed(() => {
    let base: { v: any; logo: string }[] = []
    if (tab.value === 'active') {
        // Show every node in active_participants list (no staking-based filtering)
        const participantOperators = Object.keys(validatorStore.participantsMap || {})
        base = participantOperators.map(op => {
            const v = validatorStore.participantsStakingData.find(x => x.operator_address === op) || ({
                operator_address: op,
                description: { moniker: op }
            } as any)
            return {
                v,
                logo: validatorStore.getAvatarUrl(v.description?.identity)
            }
        })
    } else if (tab.value === 'featured') {
        const endpoint = chainStore.current?.endpoints?.rest?.map(x => x.provider)
        if (endpoint) {
            endpoint.push('ping')
            base = validatorStore.participantsStakingData
                .filter(x => isFeatured(endpoint, x.description))
                .map((x) => ({ 
                    v: x, 
                    logo: validatorStore.getAvatarUrl(x.description.identity)
                }))
        }
    } else {
        base = unbondList.value.map((x) => ({ 
            v: x, 
            logo: validatorStore.getAvatarUrl(x.description.identity)
        }))
    }

    const getValue = (entry: { v: any }) => {
        const val = entry.v
        switch (sortBy.value) {
            case 'validator':
                return String(val.description?.moniker || '').toLowerCase()
            case 'voting_power':
                return Number(validatorStore.getParticipant(val.operator_address)?.weight || 0)
            case 'change24':
                return Number(votingPowerChange24(val) || 0)
            case 'earned':
                return Number(validatorStore.getEarnedCoins(val.operator_address) || 0)
            case 'claimed':
                return Number(validatorStore.getClaimedAmount(val.operator_address) || 0)
            case 'inferences':
                return Number(getEpochInferenceCount(val.operator_address) || 0)
            case 'missed_requests':
                return Number(validatorStore.getEpochMissedPercentage(val.operator_address) || 0)
            case 'active':
                return Number(validatorStore.getEpochsCompleted(val.operator_address) || 0)
            case 'reputation':
                return Number(validatorStore.getReputation(val.operator_address) || 0)
            case 'missed':
                return Number(getMissedBlocksCounter(val.operator_address) || 0)
            case 'uptime':
                return Number(getUptimePercentage(val.operator_address) || 0)
        }
    }

    return [...base].sort((a, b) => {
        const va = getValue(a)
        const vb = getValue(b)
        let cmp = 0
        if (typeof va === 'string' && typeof vb === 'string') {
            cmp = va.localeCompare(vb)
        } else {
            cmp = Number(va) - Number(vb)
        }
        return sortDesc.value ? -cmp : cmp
    })
})

const loaded = ref(false);
base.$subscribe((_, s) => {
    if (s.recents.length >= 2 && loaded.value === false && validatorStore.participantsStakingData.length > 0) {
        // Once basic chain data loaded, ensure previous epoch participants are fetched
        validatorStore.fetchPreviousEpochParticipants().finally(() => { loaded.value = true })
    }
    
    // Update slashing signing info every 7 blocks (similar to uptime module)
    const currentHeight = Number(s.latest?.block?.header?.height || 0);
    if (currentHeight > 0 && currentHeight % 7 === 0) {
        updateSlashingSigningInfo();
    }
});
</script>
<template>
<div>
  <div class="grid gap-4 grid-cols-[repeat(auto-fit,minmax(265px,1fr))] mt-4">
    <!-- Next PoC mini widget -->
    <CardStatisticsVertical
      :title="$t('validator.next_poc')"
      icon="mdi:flag-checkered"
      stats=""
      color="primary"
    >
      <template #content>
        <div class="flex items-center justify-center text-sm mb-1">
          <template v-if="pocEstimateMs > 0">
            <Countdown :time="pocEstimateMs" css="!text-base" :hideDays="true" :short="true" />
          </template>
          <template v-else>—</template>
        </div>
        <p class="text-sm text-center">{{ $t(pocPhase.labelKey) }}</p>
      </template>
      <template #hint>
        <p class="text-sm text-center px-4">{{ $t('validator.hints.next_poc') }}</p>
      </template>
    </CardStatisticsVertical>
    <CardStatisticsVertical
      :title="$t('validator.total_power')"
      icon="mdi:lightning-bolt"
      :stats="validatorStore.displayTotalPower"
      color="primary"
      :hint="$t('validator.hints.total_power')"
    />
    <CardStatisticsVertical
      :title="$t('validator.final_reward')"
      icon="mdi:gift"
      :stats="validatorStore.displayTotalFinalReward"
      color="success"
      :hint="$t('validator.hints.final_reward')"
    />
    <CardStatisticsVertical
      :title="$t('validator.earned_reward')"
      icon="mdi:trending-up"
      :stats="validatorStore.displayTotalEarnedReward"
      color="warning"
      :hint="$t('validator.hints.earned_reward')"
    />
    <CardStatisticsVertical
      :title="$t('validator.validators')"
      icon="mdi:account-group"
      :stats="validatorStore.displayActiveProviders"
      color="info"
      :hint="$t('validator.hints.validators')"
    />
  </div>

  <!-- Epoch selector (top) using PaginationBar -->
  <div class="flex items-center justify-center mt-4 mb-2">
    <div class="flex items-center gap-3">
      <PaginationBar
        :total="String(epochTotal)"
        :limit="1"
        :page="currentEpochPage"
        :min-page="72"
        :callback="handleEpochPageChange"
        :loading="loadingEpoch"
        :max-visible="maxVisiblePages"
      />
    </div>
  </div>

  <div class="bg-base-100 rounded overflow-x-auto mt-4 shadow">
    <div class="pb-4">
      <table class="table validator-table w-full">
        <thead class="bg-base-200">
          <tr>
            <th scope="col" class="uppercase cursor-pointer select-none sticky left-0 z-[2] bg-base-200 th-hover" @click="toggleSort('validator')">
              <span class="inline-flex items-center tooltip tooltip-bottom" :data-tip="$t('validator.hints.table_validators_hosts')">{{ $t('validator.validators_hosts') }}<Icon :icon="sortIcon('validator')" class="ml-1" /></span>
            </th>
            <th scope="col" class="text-right uppercase cursor-pointer select-none th-hover" @click="toggleSort('voting_power')">
              <span class="inline-flex items-center justify-end w-full tooltip tooltip-bottom" :data-tip="$t('validator.hints.table_voting_power')">{{ $t('validator.voting_power') }}<Icon :icon="sortIcon('voting_power')" class="ml-1" /></span>
            </th>
            <th v-if="selectedEpoch === null" scope="col" class="text-right uppercase cursor-pointer select-none th-hover" @click="toggleSort('change24')">
              <span class="inline-flex items-center justify-end w-full tooltip tooltip-bottom" :data-tip="$t('validator.hints.table_24h_changes')">{{ $t('validator.24h_changes') }}<Icon :icon="sortIcon('change24')" class="ml-1" /></span>
            </th>
            <th v-if="selectedEpoch === null" scope="col" class="text-right uppercase cursor-pointer select-none th-hover" @click="toggleSort('earned')">
              <span class="inline-flex items-center justify-end w-full tooltip tooltip-bottom" :data-tip="$t('validator.hints.table_earned')">{{ $t('validator.earned') }}<Icon :icon="sortIcon('earned')" class="ml-1" /></span>
            </th>
            <th v-if="selectedEpoch !== null" scope="col" class="text-right uppercase cursor-pointer select-none th-hover" @click="toggleSort('claimed')">
              <span class="inline-flex items-center justify-end w-full tooltip tooltip-bottom" :data-tip="$t('validator.hints.table_claimed') || 'Amount claimed for this epoch'">{{ $t('validator.claimed') || 'Claimed' }}<Icon :icon="sortIcon('claimed')" class="ml-1" /></span>
            </th>
            <th
              v-if="selectedEpoch !== null"
              scope="col"
              class="text-right uppercase cursor-pointer select-none th-hover"
              @click="toggleSort('inferences')"
            >
              <span
                class="inline-flex items-center justify-end w-full tooltip tooltip-bottom"
                :data-tip="$t('validator.hints.table_inference_count') || 'Number of successful inferences in this epoch'"
              >
                {{ $t('validator.inference_count') || 'Inferences' }}
                <Icon :icon="sortIcon('inferences')" class="ml-1" />
              </span>
            </th>
            <th
              v-if="selectedEpoch !== null"
              scope="col"
              class="text-right uppercase cursor-pointer select-none th-hover"
              @click="toggleSort('missed_requests')"
            >
              <span
                class="inline-flex items-center justify-end w-full tooltip tooltip-bottom"
                :data-tip="$t('validator.hints.table_missed_requests') || 'Missed requests (count and percentage of inferences) for this epoch'"
              >
                {{ $t('validator.missed_requests') || 'Missed req.' }}
                <Icon :icon="sortIcon('missed_requests')" class="ml-1" />
              </span>
            </th>
            <th v-if="selectedEpoch === null" scope="col" class="text-right uppercase cursor-pointer select-none th-hover" @click="toggleSort('active')">
              <span class="inline-flex items-center justify-end w-full tooltip tooltip-bottom" :data-tip="$t('validator.hints.table_active')">{{ $t('validator.active') }}<Icon :icon="sortIcon('active')" class="ml-1" /></span>
            </th>
            <th v-if="selectedEpoch === null" scope="col" class="text-right uppercase cursor-pointer select-none th-hover" @click="toggleSort('reputation')">
              <span class="inline-flex items-center justify-end w-full tooltip tooltip-bottom" :data-tip="$t('validator.hints.table_reputation')">{{ $t('validator.reputation') }}<Icon :icon="sortIcon('reputation')" class="ml-1" /></span>
            </th>
            <th v-if="selectedEpoch === null" scope="col" class="text-right uppercase cursor-pointer select-none th-hover" @click="toggleSort('missed')">
              <span class="inline-flex items-center justify-end w-full tooltip tooltip-bottom" :data-tip="$t('validator.hints.table_missed_blocks')">{{ $t('validator.missed_blocks') }}<Icon :icon="sortIcon('missed')" class="ml-1" /></span>
            </th>
            <th v-if="selectedEpoch === null" scope="col" class="text-right uppercase cursor-pointer select-none th-hover" @click="toggleSort('uptime')">
              <span class="inline-flex items-center justify-end w-full tooltip tooltip-bottom" :data-tip="$t('validator.hints.table_uptime')">{{ $t('validator.uptime') }}<Icon :icon="sortIcon('uptime')" class="ml-1" /></span>
            </th>
          </tr>
        </thead>
        <tbody v-if="validatorStore.loading || !validatorStore.initialized">
          <ValidatorListSkeleton
            :rows="20"
            :view-mode="selectedEpoch === null ? 'current' : 'past'"
          />
        </tbody>
        <tbody v-else>
          <tr
            v-for="({v, logo}, i) in list"
            :key="v.operator_address"
            class="hover:bg-gray-100 dark:hover:bg-[#384059]"
          >
            <!-- 👉 Validator -->
            <td class="sticky left-0 z-[1] bg-base-100">
              <div
                class="flex items-center overflow-hidden"
              >
                <div
                  class="avatar !flex mx-4 relative w-8 h-8 rounded-full"
                  :class="v.jailed ? 'tooltip tooltip-right' : ''"
                  :data-tip="v.jailed ? $t('validator.jailed') : undefined"
                >
                  <div
                    class="w-8 h-8 rounded-full bg-gray-400 absolute opacity-10"
                  ></div>
                  <div
                    class="w-8 h-8 rounded-full flex items-center justify-center overflow-hidden"
                    :class="{ 'bg-gray-200 dark:bg-[#2b2f44]': !validatorStore.getAvatarUrl(v.description?.identity) }"
                  >
                    <img
                      v-if="validatorStore.getAvatarUrl(v.description?.identity)"
                      :src="validatorStore.getAvatarUrl(v.description?.identity)"
                      class="object-contain"
                      @error="
                        (e) => {
                          const keySuffix = v.description?.identity;
                          if (keySuffix) validatorStore.fetchAvatar(keySuffix);
                        }
                      "
                    />
                    <Icon
                      v-else
                      class="text-gray-500 dark:text-gray-400"
                      :width="32"
                      :height="32"
                      :icon="`mdi-help-circle-outline`"
                    />
                    
                  </div>
                  <!-- Jailed overlay (icon only; tooltip is on avatar wrapper) -->
                  <div v-if="v.jailed" class="absolute top-0 left-0 w-8 h-8">
                    <Icon :icon="`mdi-grid`" class="text-error opacity-60" :width="32" :height="32" />
                  </div>
                </div>

                <div class="flex flex-col">
                  <span class="text-sm text-primary dark:invert whitespace-nowrap overflow-hidden">
                    <RouterLink
                      :to="{
                        name: 'chain-validator-validator',
                        params: {
                          validator:
                            v.operator_address,
                        },
                      }"
                      class="font-weight-medium"
                    >
                      {{
                        v.description?.moniker === v.operator_address
                          ? (validatorStore.operatorToAccountMap[v.operator_address] || v.operator_address)
                          : v.description?.moniker
                      }}
                    </RouterLink>
                  </span>
                  <span class="text-xs">{{
                    v.description?.website ||
                    v.description?.identity ||
                    '-'
                  }}</span>
                </div>
              </div>
            </td>

            <!-- 👉 Voting Power -->
            <td class="text-right">
              <div class="flex flex-col">
                <h6 class="text-sm font-weight-medium whitespace-nowrap ">
                  {{ format.formatNumber(Number(validatorStore.getParticipantWeight(v.operator_address) || 0), '0,0') }}
                </h6>
                <span class="text-xs">{{
                  format.calculatePercent(
                    Number(validatorStore.getParticipantWeight(v.operator_address) || 0),
                    validatorStore.totalPocWeight
                  )
                }}</span>
              </div>
            </td>
            <!-- 👉 24h Changes -->
            <td
              v-if="selectedEpoch === null"
              class="text-right text-xs"
              :class="votingPowerChange24Color(v)"
            >
              {{ votingPowerChange24Text(v) }}
            </td>
            <!-- 👉 Earned (only show for current epoch; hide for previous epochs while we refine calculations) -->
            <td v-if="selectedEpoch === null" class="text-right text-xs">
              {{ format.formatToken({
                amount: validatorStore.getEarnedCoins(v.operator_address), 
                denom: 'ngonka'
              }, true, '0,0.[00]') }}
            </td>
            <!-- 👉 Claimed (only show for past epochs) -->
            <td v-if="selectedEpoch !== null" class="text-right text-xs">
              <div class="tooltip" :data-tip="validatorStore.getClaimedDetails(v.operator_address) || undefined">
                {{ format.formatToken({
                  amount: validatorStore.getClaimedAmount(v.operator_address), 
                  denom: 'ngonka'
                }, true, '0,0.[00]') }}
              </div>
            </td>
            <!-- 👉 Inference count (past epochs) -->
            <td v-if="selectedEpoch !== null" class="text-right text-xs">
              {{ format.formatNumber(getEpochInferenceCount(v.operator_address), '0,0') }}
            </td>
            <!-- 👉 Missed requests (count + percentage of inferences, past epochs) -->
            <td v-if="selectedEpoch !== null" class="text-right text-xs">
              {{ getEpochMissedSummary(v.operator_address) }}
            </td>
            <!-- 👉 Active -->
            <td v-if="selectedEpoch === null" class="text-right text-xs">
              {{ validatorStore.getEpochsCompleted(v.operator_address) }}
            </td>
            <!-- 👉 Reputation -->
            <td v-if="selectedEpoch === null" class="text-right text-xs">
              {{ validatorStore.getReputation(v.operator_address) }}
            </td>
            <!-- 👉 Missed Blocks -->
            <td v-if="selectedEpoch === null" class="text-right text-xs">
              <span 
                :class="{
                  'text-green-600': getMissedBlocksCounter(v.operator_address) <= 10,
                  'text-yellow-600': getMissedBlocksCounter(v.operator_address) > 10 && getMissedBlocksCounter(v.operator_address) <= 1000,
                  'text-red-600': getMissedBlocksCounter(v.operator_address) > 1000
                }"
              >
                {{ formatMissedBlocks(v.operator_address) }}
              </span>
            </td>
            <!-- 👉 Uptime -->
            <td v-if="selectedEpoch === null" class="text-right text-xs">
              <span 
                :class="{
                  'text-green-600': getUptimePercentage(v.operator_address) >= 95,
                  'text-yellow-600': getUptimePercentage(v.operator_address) >= 90 && getUptimePercentage(v.operator_address) < 95,
                  'text-red-600': getUptimePercentage(v.operator_address) < 90
                }"
              >
                {{ formatUptime(v.operator_address) }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Epoch selector (bottom) using PaginationBar -->
  <div class="flex items-center justify-center mt-4 mb-2">
    <div class="flex items-center gap-3">
      <PaginationBar
        :total="String(epochTotal)"
        :limit="1"
        :page="currentEpochPage"
        :min-page="72"
        :callback="handleEpochPageChange"
        :loading="loadingEpoch"
        :max-visible="maxVisiblePages"
      />
    </div>
  </div>
</div>
</template>

<route>
  {
    meta: {
      i18n: 'validator',
      order: 2,
      descriptionKey: 'validator.meta_description'
    }
  }
</route>

<style>
.validator-table.table :where(th, td) {
    padding: 8px 5px;
    background: transparent;
}
.validator-table.table th.sticky {
    background: hsl(var(--b2));
}
.validator-table.table td.sticky {
    background: hsl(var(--b1));
}
/* Ensure first column header and cells stay sticky horizontally, overriding library defaults */
.validator-table.table thead th:first-child {
    position: sticky;
    left: 0;
    z-index: 2;
    background: hsl(var(--b2));
}
.validator-table.table thead th.th-hover {
    transition: background-color 0.15s ease-in-out, color 0.15s ease-in-out;
}
.validator-table.table thead th.th-hover:hover {
    background-color: hsl(var(--b3));
    color: #ffffff;
}
.validator-table.table tbody td:first-child {
    position: sticky;
    left: 0;
    z-index: 1;
    background: hsl(var(--b1));
}
/* Match row hover background for the sticky first column */
.validator-table.table tbody tr:hover td:first-child {
    background-color: #f3f4f6; /* same as hover:bg-gray-100 */
}
.dark .validator-table.table tbody tr:hover td:first-child {
    background-color: #384059; /* same as dark:hover:bg-[#384059] */
}
/* On small screens, constrain the sticky first column width so it doesn't cover others */
@media (max-width: 640px) {
    /* Force horizontal scroll like Mintscan on mobile */
    .validator-table.table {
        min-width: 720px;
    }
    .validator-table.table thead th:first-child,
    .validator-table.table tbody td:first-child {
        width: 35vw;
        min-width: 35vw;
        max-width: 35vw;
    }
    /* Constrain inner content so width is respected and text can truncate */
    .validator-table.table thead th:first-child > span {
        max-width: 100%;
    }
    .validator-table.table tbody td:first-child > div {
        max-width: 100%;
        overflow: hidden;
    }
    /* Allow the text column inside the flex row to actually shrink */
    .validator-table.table tbody td:first-child > div .flex.flex-col {
        min-width: 0;
    }
    .validator-table.table tbody td:first-child span.text-sm,
    .validator-table.table tbody td:first-child span.text-xs {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    /* Anchor first header tooltip to the left edge on mobile so it doesn't overflow viewport */
    .validator-table.table thead th:first-child > span.tooltip.tooltip-bottom::before {
        left: 0;
        right: auto;
        transform: translateX(0);
    }
    .validator-table.table thead th:first-child > span.tooltip.tooltip-bottom::after {
        left: 10px; /* inset to align with cell padding */
        right: auto;
        transform: translateX(0);
    }
}

/* Expand header label spans to fill the entire header cell so tooltip hover covers whole cell */
.validator-table.table thead th > span.tooltip {
    display: flex;
    width: 100%; /* do not exceed cell width to avoid widening the table */
    position: relative; /* anchor pseudo-elements */
}
/* Make tooltip bubble compact and avoid overpowering header text */
.validator-table.table thead th > span.tooltip::before {
    font-size: 0.65rem; /* Tailwind text-xs */
    line-height: 1rem;  /* Tailwind leading-4 */
    padding: 4px 8px;   /* smaller bubble padding */
    max-width: 14rem;   /* tighter width to avoid expanding scroll width */
    white-space: normal; /* allow wrapping instead of overflow */
    z-index: 50;        /* ensure above table backgrounds */
    word-break: break-word;
}

/* Keep the last header's tooltip inside the table by anchoring it to the right */
.validator-table.table thead th:last-child > span.tooltip.tooltip-bottom::before {
    left: auto;
    right: 0;           /* align bubble to the cell's right edge */
    transform: translateX(0);
}
.validator-table.table thead th:last-child > span.tooltip.tooltip-bottom::after {
    left: auto;
    right: 10px;        /* place arrow slightly inset from right to match padding */
    transform: translateX(0);
}
</style>
