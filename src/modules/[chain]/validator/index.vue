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
import { onMounted, ref } from 'vue';
import { Icon } from '@iconify/vue';
import Countdown from '@/components/Countdown.vue';
import { fromHex, toBase64 } from '@cosmjs/encoding';
import type { Key, SlashingParam, Validator } from '@/types';
import type { SigningInfo } from '@/types';
import { consensusPubkeyToHexAddress, valconsToBase64 } from '@/libs';
import CardStatisticsVertical from '@/components/CardStatisticsVertical.vue';


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

// Next PoC mini widget state - now using store
const currentHeight = computed(() => Number(base.latest?.block?.header?.height || 0))
const pocRemainingBlocks = computed(() => {
    if (!chainStore.nextPocStart) return 0
    return Math.max(0, Number(chainStore.nextPocStart) - currentHeight.value)
})
const pocEstimateMs = computed(() => {
    const ms = Number(pocRemainingBlocks.value * (base.blocktime || 0))
    return ms > 0 ? ms : 0
})
const pocRemainingBlocksDisplay = computed(() => pocRemainingBlocks.value.toString())

// Sorting state
type SortKey = 'validator' | 'voting_power' | 'change24' | 'earned' | 'active' | 'reputation' | 'missed' | 'uptime'
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
        // Only show validators that are active participants in the current epoch
        const filtered = validatorStore.participantsStakingData
            .filter(x => {
                const p = validatorStore.getParticipant(x.operator_address)
                return !!p && Number(p.weight || 0) > 0
            })

        base = filtered.map((x) => ({ 
            v: x, 
            logo: validatorStore.getAvatarUrl(x.description.identity)
        }))
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
        <p class="text-sm text-center">Next PoC</p>
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

  <div class="bg-base-100 rounded overflow-x-auto mt-4 shadow">
    <div class="pb-4">
      <table class="table validator-table w-full">
        <thead class="bg-base-200">
          <tr>
            <th scope="col" class="uppercase cursor-pointer select-none sticky left-0 z-[2] bg-base-200 th-hover" @click="toggleSort('validator')" :title="$t('validator.hints.table_validators_hosts')">
              <span class="inline-flex items-center">{{ $t('validator.validators_hosts') }}<Icon :icon="sortIcon('validator')" class="ml-1" /></span>
            </th>
            <th scope="col" class="text-right uppercase cursor-pointer select-none th-hover" @click="toggleSort('voting_power')" :title="$t('validator.hints.table_voting_power')">
              <span class="inline-flex items-center justify-end w-full">{{ $t('validator.voting_power') }}<Icon :icon="sortIcon('voting_power')" class="ml-1" /></span>
            </th>
            <th scope="col" class="text-right uppercase cursor-pointer select-none th-hover" @click="toggleSort('change24')" :title="$t('validator.hints.table_24h_changes')">
              <span class="inline-flex items-center justify-end w-full">{{ $t('validator.24h_changes') }}<Icon :icon="sortIcon('change24')" class="ml-1" /></span>
            </th>
            <th scope="col" class="text-right uppercase cursor-pointer select-none th-hover" @click="toggleSort('earned')" :title="$t('validator.hints.table_earned')">
              <span class="inline-flex items-center justify-end w-full">{{ $t('validator.earned') }}<Icon :icon="sortIcon('earned')" class="ml-1" /></span>
            </th>
            <th scope="col" class="text-right uppercase cursor-pointer select-none th-hover" @click="toggleSort('active')" :title="$t('validator.hints.table_active')">
              <span class="inline-flex items-center justify-end w-full">{{ $t('validator.active') }}<Icon :icon="sortIcon('active')" class="ml-1" /></span>
            </th>
            <th scope="col" class="text-right uppercase cursor-pointer select-none th-hover" @click="toggleSort('reputation')" :title="$t('validator.hints.table_reputation')">
              <span class="inline-flex items-center justify-end w-full">{{ $t('validator.reputation') }}<Icon :icon="sortIcon('reputation')" class="ml-1" /></span>
            </th>
            <th scope="col" class="text-right uppercase cursor-pointer select-none th-hover" @click="toggleSort('missed')" :title="$t('validator.hints.table_missed_blocks')">
              <span class="inline-flex items-center justify-end w-full">{{ $t('validator.missed_blocks') }}<Icon :icon="sortIcon('missed')" class="ml-1" /></span>
            </th>
            <th scope="col" class="text-right uppercase cursor-pointer select-none th-hover" @click="toggleSort('uptime')" :title="$t('validator.hints.table_uptime')">
              <span class="inline-flex items-center justify-end w-full">{{ $t('validator.uptime') }}<Icon :icon="sortIcon('uptime')" class="ml-1" /></span>
            </th>
          </tr>
        </thead>
        <tbody>
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
                  {{ format.formatNumber(Number(validatorStore.getParticipant(v.operator_address)?.weight || 0), '0,0') }}
                </h6>
                <span class="text-xs">{{
                  format.calculatePercent(
                    Number(validatorStore.getParticipant(v.operator_address)?.weight || 0),
                    validatorStore.totalPocWeight
                  )
                }}</span>
              </div>
            </td>
            <!-- 👉 24h Changes -->
            <td
              class="text-right text-xs"
              :class="votingPowerChange24Color(v)"
            >
              {{ votingPowerChange24Text(v) }}
            </td>
            <!-- 👉 Earned -->
            <td class="text-right text-xs">
              {{ format.formatToken({
                amount: validatorStore.getEarnedCoins(v.operator_address), 
                denom: 'ngonka'
              }, true, '0,0.[00]') }}
            </td>
            <!-- 👉 Active -->
            <td class="text-right text-xs">
              {{ validatorStore.getEpochsCompleted(v.operator_address) }}
            </td>
            <!-- 👉 Reputation -->
            <td class="text-right text-xs">
              {{ validatorStore.getReputation(v.operator_address) }}
            </td>
            <!-- 👉 Missed Blocks -->
            <td class="text-right text-xs">
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
            <td class="text-right text-xs">
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
</div>
</template>

<route>
  {
    meta: {
      i18n: 'validator',
      order: 2,
      description: 'Validator selection happens through Sprints — short cycles where Hosts (who also serve as Validators) prove their computational power by generating nonces. The more nonces produced, the higher the Host’s Potential Weight.\n\nSince Hosts are simultaneously Validators, all network decisions — from block finalization to model registration and treasury allocation — are made based on these PoC-weighted votes.'
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
        width: 20vw;
        min-width: 20vw;
        max-width: 20vw;
    }
    /* Constrain inner content so width is respected and text can truncate */
    .validator-table.table thead th:first-child > span {
        max-width: 100%;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
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
}
</style>
