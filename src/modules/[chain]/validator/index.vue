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

const cache = JSON.parse(localStorage.getItem('avatars') || '{}');
const avatars = ref(cache || {});
const latest = ref({} as Record<string, number>);
const yesterday = ref({} as Record<string, number>);
const tab = ref('active');
const unbondList = ref([] as Validator[]);
const slashing = ref({} as SlashingParam)

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
const sortBy = ref<'rank' | 'validator' | 'voting_power' | 'change24' | 'earned' | 'active' | 'reputation' | 'missed' | 'uptime'>(
  (localStorage.getItem('validator-sort-by') as any) || 'rank'
)
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
    const validator = validatorStore.validators.find(v => v.operator_address === operatorAddress);
    if (!validator) return '';
    return getValidatorBase64Address(validator);
}

onMounted(() => {
    validatorStore.fetchUnbondingValidators().then((res) => {
        unbondList.value = res.concat(unbondList.value);
    });
    validatorStore.fetchInactiveValidators().then((res) => {
        unbondList.value = unbondList.value.concat(res);
    });
    chainStore.rpc.getSlashingParams().then(res => {
        slashing.value = res.params
    })
    
    // Initialize validator store (this will fetch both validators and participants stats)
    validatorStore.init();
    
    // Fetch initial slashing signing info
    updateSlashingSigningInfo();

    // Fetch latest epoch info for Next PoC widget
    chainStore.fetchLatestEpochInfo();
});

async function fetchVotingPowerChange(blockWindow: number = 14400) {
  let page = 0;

  let height = Number(base.latest?.block?.header?.height || 0);

  if (height > blockWindow) {
    height -= blockWindow;
  } else {
    height = 1;
  }

  // voting power 24h ago
  while (page < validatorStore.validators.length && height > 0) {
    await base.fetchValidatorByHeight(height, page).then((x) => {
      x.validators.forEach((v) => {
        const power = Number(v.voting_power);
        const key = v.pub_key.key;
        yesterday.value[key] = power;
      });
    });
    page += 100;
  }

  page = 0;

  // voting power now
  while (page < validatorStore.validators.length) {
    await base.fetchLatestValidators(page).then((x) => {
      x.validators.forEach((v) => {
        const power = Number(v.voting_power);
        const key = v.pub_key.key;
        latest.value[key] = power;
      });
    });
    page += 100;
  }
}

const votingPowerChanges = computed(() => {
    const changes = {} as Record<string, number>;
    Object.keys(latest.value).forEach((k) => {
        const l = latest.value[k] || 0;
        const y = yesterday.value[k] || 0;
        changes[k] = l - y;
    });
    return changes;
});

const votingPowerChange24 = (entry: { consensus_pubkey: Key; }) => {
    const txt = entry.consensus_pubkey.key;
    // Show raw voting power change from validatorset snapshots
    const diff = votingPowerChanges.value[txt];
    return typeof diff === 'number' ? diff : 0;
};

const votingPowerChange24Text = (entry: { consensus_pubkey: Key; }) => {
    if (!entry) return '';
    const v = votingPowerChange24(entry);
    return v && v !== 0 ? format.showChanges(v) : '';
};

const votingPowerChange24Color = (entry: { consensus_pubkey: Key; }) => {
    if (!entry) return '';
    const v = votingPowerChange24(entry);
    if (v > 0) return 'text-success';
    if (v < 0) return 'text-error';
};

const calculateRank = function (position: number) {
    let sum = 0;
    for (let i = 0; i < position; i++) {
        sum += Number(validatorStore.validators[i]?.delegator_shares);
    }
    const percent = sum / Number(validatorStore.totalPower);

    switch (true) {
        case tab.value === 'active' && percent < 0.33:
            return 'error';
        case tab.value === 'active' && percent < 0.67:
            return 'warning';
        default:
            return 'primary';
    }
};

function isFeatured(endpoints: string[], who?: {website?: string, moniker: string }) {
    if(!endpoints || !who) return false
    return endpoints.findIndex(x => who.website && who.website?.substring(0, who.website?.lastIndexOf('.')).endsWith(x) || who?.moniker?.toLowerCase().search(x.toLowerCase()) > -1) > -1
}

const list = computed(() => {
    let base: { v: any; rank: string; logo: string; pos: number }[] = []
    if (tab.value === 'active') {
        base = validatorStore.validators.map((x, i) => ({ v: x, rank: calculateRank(i), logo: logo(x.description.identity), pos: i }))
    } else if (tab.value === 'featured') {
        const endpoint = chainStore.current?.endpoints?.rest?.map(x => x.provider)
        if (endpoint) {
            endpoint.push('ping')
            base = validatorStore.validators
                .filter(x => isFeatured(endpoint, x.description))
                .map((x) => ({ v: x, rank: 'primary', logo: logo(x.description.identity), pos: validatorStore.validators.findIndex(v => v.operator_address === x.operator_address) }))
        }
    } else {
        base = unbondList.value.map((x, i) => ({ v: x, rank: 'primary', logo: logo(x.description.identity), pos: i }))
    }

    // Rank preserves original ordering
    if (sortBy.value === 'rank') return base

    const getValue = (entry: { v: any }) => {
        const val = entry.v
        switch (sortBy.value) {
            case 'validator':
                return String(val.description?.moniker || '').toLowerCase()
            case 'voting_power':
                return Number(val.tokens || 0)
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

const fetchAvatar = (identity: string) => {
  // fetch avatar from keybase
  return new Promise<void>((resolve) => {
    validatorStore
      .keybase(identity)
      .then((d) => {
        if (Array.isArray(d.them) && d.them.length > 0) {
          const uri = String(d.them[0]?.pictures?.primary?.url).replace(
            'https://s3.amazonaws.com/keybase_processed_uploads/',
            ''
          );

          avatars.value[identity] = uri;
          resolve();
        } else throw new Error(`failed to fetch avatar for ${identity}`);
      })
      .catch((error) => {
        // console.error(error); // uncomment this if you want the user to see which avatars failed to load.
        resolve();
      });
  });
};

const loadAvatar = (identity: string) => {
  // fetches avatar from keybase and stores it in localStorage
  fetchAvatar(identity).then(() => {
    localStorage.setItem('avatars', JSON.stringify(avatars.value));
  });
};

const loadAvatars = () => {
  // fetches all avatars from keybase and stores it in localStorage
  const promises = validatorStore.validators.map((validator) => {
    const identity = validator.description?.identity;

    // Here we also check whether we haven't already fetched the avatar
    if (identity && !avatars.value[identity]) {
      return fetchAvatar(identity);
    } else {
      return Promise.resolve();
    }
  });

  Promise.all(promises).then(() =>
    localStorage.setItem('avatars', JSON.stringify(avatars.value))
  );
};

const logo = (identity?: string) => {
    if (!identity || !avatars.value[identity]) return '';
    const url = avatars.value[identity] || '';
    return url.startsWith('http')
        ? url
        : `https://s3.amazonaws.com/keybase_processed_uploads/${url}`;
};

const loaded = ref(false);
base.$subscribe((_, s) => {
    if (s.recents.length >= 2 && loaded.value === false && validatorStore.validators.length > 0) {
        const diff_time = Date.parse(s.recents[1].block.header.time) - Date.parse(s.recents[0].block.header.time)
        const diff_height = Number(s.recents[1].block.header.height) - Number(s.recents[0].block.header.height)
        const block_window = Number(Number(86400 * 1000 * diff_height / diff_time).toFixed(0))
        fetchVotingPowerChange(block_window).finally(() => { loaded.value = true })
    }
    
    // Update slashing signing info every 7 blocks (similar to uptime module)
    const currentHeight = Number(s.latest?.block?.header?.height || 0);
    if (currentHeight > 0 && currentHeight % 7 === 0) {
        updateSlashingSigningInfo();
    }
});

loadAvatars();
</script>
<template>
<div>
  <div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-5 mt-4">
    <!-- Next PoC mini widget -->
    <div class="bg-base-100 shadow rounded p-4">
      <div class="flex items-center justify-center">
        <div class="relative w-9 h-9 rounded overflow-hidden flex items-center justify-center">
          <Icon class="text-primary" icon="mdi:flag-checkered" size="32" />
          <div class="absolute top-0 left-0 bottom-0 right-0 opacity-20 bg-primary"></div>
        </div>
      </div>
      <div class="mt-2">
        <div class="flex items-center justify-center text-sm mt-2 mb-1">
          <template v-if="pocEstimateMs > 0">
            <Countdown :time="pocEstimateMs" css="!text-base" :hideDays="true" :short="true" />
          </template>
          <template v-else>—</template>
        </div>
        <p class="text-sm text-center">Next PoC</p>
      </div>
    </div>
    <CardStatisticsVertical
      :title="$t('validator.total_power')"
      icon="mdi:lightning-bolt"
      :stats="validatorStore.displayTotalPower"
      color="primary"
    />
    <CardStatisticsVertical
      :title="$t('validator.final_reward')"
      icon="mdi:gift"
      :stats="validatorStore.displayTotalFinalReward"
      color="success"
    />
    <CardStatisticsVertical
      :title="$t('validator.earned_reward')"
      icon="mdi:trending-up"
      :stats="validatorStore.displayTotalEarnedReward"
      color="warning"
    />
    <CardStatisticsVertical
      :title="$t('validator.validators')"
      icon="mdi:account-group"
      :stats="validatorStore.displayTotalValidators"
      color="info"
    />
  </div>

  <div class="bg-base-100 rounded mt-4 shadow">
    <div class="px-4 pt-4 pb-2 text-lg font-semibold text-main">
      Validators
    </div>
    <div class="px-4 pb-4">
      <div class="overflow-x-auto">
        <table class="table validator-table w-full">
          <thead class="bg-base-200">
            <tr>
              <th
                scope="col"
                class="uppercase cursor-pointer select-none"
                style="width: 3rem; position: relative"
                @click="toggleSort('rank')"
              >
                <span class="inline-flex items-center">{{ $t('validator.rank') }}<Icon :icon="sortIcon('rank')" class="ml-1" /></span>
              </th>
              <th scope="col" class="uppercase cursor-pointer select-none" @click="toggleSort('validator')">
                <span class="inline-flex items-center">{{ $t('validator.validator') }}<Icon :icon="sortIcon('validator')" class="ml-1" /></span>
              </th>
              <th scope="col" class="text-right uppercase cursor-pointer select-none" @click="toggleSort('voting_power')">
                <span class="inline-flex items-center justify-end w-full">{{ $t('validator.voting_power') }}<Icon :icon="sortIcon('voting_power')" class="ml-1" /></span>
              </th>
              <th scope="col" class="text-right uppercase cursor-pointer select-none" @click="toggleSort('change24')">
                <span class="inline-flex items-center justify-end w-full">{{ $t('validator.24h_changes') }}<Icon :icon="sortIcon('change24')" class="ml-1" /></span>
              </th>
              <th scope="col" class="text-right uppercase cursor-pointer select-none" @click="toggleSort('earned')">
                <span class="inline-flex items-center justify-end w-full">{{ $t('validator.earned') }}<Icon :icon="sortIcon('earned')" class="ml-1" /></span>
              </th>
              <th scope="col" class="text-right uppercase cursor-pointer select-none" @click="toggleSort('active')">
                <span class="inline-flex items-center justify-end w-full">{{ $t('validator.active') }}<Icon :icon="sortIcon('active')" class="ml-1" /></span>
              </th>
              <th scope="col" class="text-right uppercase cursor-pointer select-none" @click="toggleSort('reputation')">
                <span class="inline-flex items-center justify-end w-full">{{ $t('validator.reputation') }}<Icon :icon="sortIcon('reputation')" class="ml-1" /></span>
              </th>
              <th scope="col" class="text-right uppercase cursor-pointer select-none" @click="toggleSort('missed')">
                <span class="inline-flex items-center justify-end w-full">{{ $t('validator.missed_blocks') }}<Icon :icon="sortIcon('missed')" class="ml-1" /></span>
              </th>
              <th scope="col" class="text-right uppercase cursor-pointer select-none" @click="toggleSort('uptime')">
                <span class="inline-flex items-center justify-end w-full">{{ $t('validator.uptime') }}<Icon :icon="sortIcon('uptime')" class="ml-1" /></span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="({v, rank, logo, pos}, i) in list"
              :key="v.operator_address"
              class="hover:bg-gray-100 dark:hover:bg-[#384059]"
            >
              <!-- 👉 rank -->
              <td>
                <div
                  class="text-xs truncate relative px-2 py-1 rounded-full w-fit"
                  :class="`text-${rank}`"
                >
                  <span
                    class="inset-x-0 inset-y-0 opacity-10 absolute"
                    :class="`bg-${rank}`"
                  ></span>
                  {{ pos + 1 }}
                </div>
              </td>
              <!-- 👉 Validator -->
              <td>
                <div
                  class="flex items-center overflow-hidden"
                  style="max-width: 300px"
                >
                  <div
                    class="avatar mr-4 relative w-8 h-8 rounded-full"
                  >
                    <div
                      class="w-8 h-8 rounded-full bg-gray-400 absolute opacity-10"
                    ></div>
                    <div class="w-8 h-8 rounded-full">
                      <img
                        v-if="logo"
                        :src="logo"
                        class="object-contain"
                        @error="
                          (e) => {
                            const identity = v.description?.identity;
                            if (identity) loadAvatar(identity);
                          }
                        "
                      />
                      <Icon
                        v-else
                        class="text-3xl"
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
                        {{ v.description?.moniker }}
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
                    {{
                      format.formatToken(
                        {
                          amount: parseInt(
                            v.tokens
                          ).toString(),
                          denom: validatorStore.params
                            .bond_denom,
                        },
                        false,
                        '0,0'
                      )
                    }}
                  </h6>
                  <span class="text-xs">{{
                    format.calculatePercent(
                      v.tokens,
                      validatorStore.totalPower
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
</div>
</template>

<route>
  {
    meta: {
      i18n: 'validator',
      order: 3
    }
  }
</route>

<style>
.validator-table.table :where(th, td) {
    padding: 8px 5px;
    background: transparent;
}
</style>
