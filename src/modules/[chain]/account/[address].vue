<script lang="ts" setup>
import {
  useBlockchain,
  useFormatter,
  useTxDialog,
} from '@/stores';
import DynamicComponent from '@/components/dynamic/DynamicComponent.vue';
import DonutChart from '@/components/charts/DonutChart.vue';
import PaginationBar from '@/components/PaginationBar.vue';
import { computed, ref } from '@vue/reactivity';
import { onMounted } from 'vue';
import { Icon } from '@iconify/vue';

import type {
  AuthAccount,
  TxResponse,
  InferenceResponse,
} from '@/types';
import type { Coin } from '@cosmjs/amino';
import Countdown from '@/components/Countdown.vue';
// import { fromBase64 } from '@cosmjs/encoding';

const props = defineProps(['address', 'chain']);

const blockchain = useBlockchain();
const dialog = useTxDialog();
const format = useFormatter();
const account = ref({} as AuthAccount);
const txs = ref({} as TxResponse[]);
const balances = ref([] as Coin[]);
const vestingTotal = ref([] as Coin[]);
const recentReceived = ref([] as TxResponse[]);
const recentReceivedTransfers = ref([] as TxResponse[])
const recentMintsOrKeeper = ref([] as TxResponse[])
const vestingRewardsTxs = ref([] as TxResponse[])
const allVestingRewardsTxs = ref([] as TxResponse[])
const vestingRewardsTotal = ref('0')
const vestingRewardsPage = ref(1)
const vestingRewardsLimit = 50
const inferences = ref({ stats: [] } as InferenceResponse);
const chart = {};

const valueFmt = (v: number) => format.formatNumber(v, '0,0.[00]');
const totalFmt = (v: number) => format.formatNumber(v, '0,0.[00]');

const seriesColors = ref<string[]>([])

const hoveredSlice = ref<number | null>(null)

onMounted(() => {
  loadAccount(props.address)
  refreshSeriesColors()
  setTimeout(refreshSeriesColors, 0)
});

const totalAmountByCategory = computed(() => {
  let sumVest = 0;
  vestingTotal.value?.forEach((x) => {
    sumVest += format.tokenDisplayNumber(x as any, 'local');
  });
  let sumBal = 0;
  balances.value?.forEach((x) => {
    sumBal += format.tokenDisplayNumber(x as any, 'local');
  });
  return [sumBal, sumVest];
});

const labels = ['Balance', 'Vesting'];

const totalAmount = computed(() => {
  return totalAmountByCategory.value.reduce((p, c) => c + p, 0);
});

/*
const totalValue = computed(() => {
  let value = 0;
  delegations.value?.forEach((x) => {
    value += format.tokenValueNumber(x.balance);
  });
  rewards.value?.total?.forEach((x) => {
    value += format.tokenValueNumber(x);
  });
  balances.value?.forEach((x) => {
    value += format.tokenValueNumber(x);
  });
  unbonding.value?.forEach((x) => {
    x.entries?.forEach((y) => {
      value += format.tokenValueNumber({amount: y.balance, denom: stakingStore.params.bond_denom});
    });
  });
  return format.formatNumber(value, '0,0.00');
});
*/
// Hide for now - can be enabled later when valuation is available
const showValuations = false;

function loadAccount(address: string) {
  blockchain.rpc.getAuthAccount(address).then((x) => {
    account.value = x.account;
  });
  blockchain.rpc.getTxsBySender(address).then((x) => {
    txs.value = x.tx_responses;
  });
  blockchain.rpc.getBankBalances(address).then((x) => {
    balances.value = x.balances;
  });

  // Vesting totals
  blockchain.getTotalVesting(address)
    .then((x: any) => {
      vestingTotal.value = x?.total_amount || [];
    })
    .catch(() => {
      vestingTotal.value = [];
    });

  // Vesting reward transactions
  // Start from the LAST page so newest vesting reward txs show first,
  // while still keeping server-side pagination for the table.
  initVestingRewards(address);
  // Also load **all** vesting reward txs for analytics (e.g. pie charts)
  loadAllVestingRewards(address);

  // Load inference stats
  loadInferenceStats(address);
}

async function loadInferenceStats(address: string) {
  try {
    const response = await blockchain.inferenceApiRequest(`/productscience/inference/inference/developer/${address}/stats_by_time`);
    inferences.value = response;
  } catch (error) {
    console.error('Failed to load inference stats:', error);
    inferences.value = { stats: [] };
  }
}

function updateEvent() {
  loadAccount(props.address);
}

function mapAmount(events: {type: string, attributes: {key: string, value: string}[]}[]) {
  if (!events) return []
  const decodeKey = (k: string) => (k === 'YW1vdW50' ? 'amount' : k)
  const evt = events.find(x => x.type === 'transfer')
          || events.find(x => x.type === 'coin_received')
          || events.find(x => x.type === 'coinbase')
  if (!evt) return []
  return evt.attributes
    .filter(x => decodeKey(x.key) === 'amount')
    .map(x => x.value)
}

function getVestingRewardDetails(events: any[]) {
  if (!events) return { total: '-', details: '' };
  
  const decodeKey = (k: string) => (k === 'YW1vdW50' ? 'amount' : k);
  const evts = events.filter((x: any) => x.type === 'vest_reward');
  if (!evts.length) return { total: '-', details: '' };

  const totals: Record<string, bigint> = {};
  const individualAmounts: string[] = [];
  const unparsed: string[] = [];

  evts.forEach((evt: any) => {
    evt.attributes
      .filter((x: any) => decodeKey(x.key) === 'amount')
      .forEach((x: any) => {
        const parts = (x.value || '').split(',').map((p: string) => p.trim()).filter(Boolean);
        parts.forEach((p: string) => {
          const m = p.match(/^(\d+)([a-zA-Z][\w\/-]*)$/);
          if (m) {
            const amountStr = m[1];
            const denom = m[2];
            const amt = BigInt(amountStr);
            
            if (!totals[denom]) totals[denom] = BigInt(0);
            totals[denom] += amt;
            
            individualAmounts.push(format.formatToken({ amount: amountStr, denom }, true, '0,0.[00]'));
          } else {
            unparsed.push(p);
            individualAmounts.push(p);
          }
        });
      });
  });

  const totalStrings = Object.entries(totals).map(([denom, amt]) => {
    return format.formatToken({ amount: amt.toString(), denom }, true, '0,0.[00]');
  });
  
  // Append unparsed strings to total if any
  unparsed.forEach(u => totalStrings.push(u));
  
  const total = totalStrings.join(', ') || '-';
  const details = individualAmounts.join(' + ');
  
  return { total, details };
}

function getEpochIndexFromTx(v: TxResponse): string {
  try {
    const msgs: any[] = (v as any)?.tx?.body?.messages || []
    for (const msg of msgs) {
      const type = msg['@type'] || msg.typeUrl || ''
      if (type === '/cosmos.authz.v1beta1.MsgExec' && Array.isArray(msg.msgs)) {
        for (const inner of msg.msgs) {
          const itype = inner['@type'] || inner.typeUrl || ''
          if (itype.includes('MsgClaimRewards') && inner.epoch_index != null) {
            return String(inner.epoch_index)
          }
        }
      } else if (type.includes('MsgClaimRewards') && msg.epoch_index != null) {
        return String(msg.epoch_index)
      }
    }
  } catch (e) {
    // ignore parsing errors and fallback below
  }
  return '-'
}

function getStatusColor(status: string) {
  switch (status) {
    case 'FINISHED':
    case 'VALIDATED':
      return 'text-success';
    case 'STARTED':
    case 'VOTING':
      return 'text-warning';
    case 'EXPIRED':
    case 'INVALIDATED':
      return 'text-error';
    default:
      return 'text-info';
  }
}

function rgbStringToHex(rgb: string): string {
  // supports rgb() or rgba()
  const m = rgb.match(/rgba?\(([^)]+)\)/i)
  if (!m) return rgb
  const parts = m[1].split(',').map(s => parseFloat(s.trim()))
  const [r,g,b] = parts
  const toHex = (n: number) => n.toString(16).padStart(2, '0')
  return `#${toHex(Math.round(r))}${toHex(Math.round(g))}${toHex(Math.round(b))}`
}

function getCssColorForClass(className: string): string | null {
  const el = document.createElement('span')
  el.style.position = 'absolute'
  el.style.left = '-99999px'
  el.style.top = '-99999px'
  el.className = className
  document.body.appendChild(el)
  const color = getComputedStyle(el).color
  document.body.removeChild(el)
  return color ? rgbStringToHex(color) : null
}

function refreshSeriesColors(){
  // Match list icon color classes
  const balanceHex = getCssColorForClass('text-info')
  const rewardHex = getCssColorForClass('text-success')
  const fallback = '#666CFF'
  seriesColors.value = [balanceHex || fallback, rewardHex || fallback]
}

async function initVestingRewards(address: string) {
  const baseQuery = (page: number) =>
    `?query=vest_reward.participant='${address}'&limit=${vestingRewardsLimit}&page=${page}`;

  try {
    // First request to learn the total
    const first: any = await blockchain.rpc.getTxs(baseQuery(1), {});
    const totalStr = first?.total;
    const total = totalStr != null ? Number(totalStr) : NaN;

    // If only one page or total unknown, just use the first page
    if (Number.isNaN(total) || total <= vestingRewardsLimit) {
      vestingRewardsTxs.value = first?.tx_responses || [];
      vestingRewardsTotal.value = totalStr || String(vestingRewardsTxs.value.length || 0);
      vestingRewardsPage.value = 1;
      return;
    }

    const lastPage = Math.max(1, Math.ceil(total / vestingRewardsLimit));
    const last: any = await blockchain.rpc.getTxs(baseQuery(lastPage), {});
    vestingRewardsTxs.value = last?.tx_responses || [];
    vestingRewardsTotal.value = totalStr || String(vestingRewardsTxs.value.length || 0);
    vestingRewardsPage.value = lastPage;
  } catch (_) {
    // Fallback to existing single-page loader if anything goes wrong
    loadVestingRewards(address, 1);
  }
}

function loadVestingRewards(address: string, page: number) {
  vestingRewardsPage.value = page
  const vestQuery = `?query=vest_reward.participant='${address}'&limit=${vestingRewardsLimit}&page=${page}`;
  blockchain.rpc.getTxs(vestQuery, {})
    .then((res: any) => {
      vestingRewardsTxs.value = res?.tx_responses || [];
      vestingRewardsTotal.value = res?.total || vestingRewardsTotal.value || '0';
    })
    .catch(() => {
      vestingRewardsTxs.value = [];
      vestingRewardsTotal.value = '0';
    });
}

async function loadAllVestingRewards(address: string) {
  const all: TxResponse[] = []
  let page = 1
  const limit = vestingRewardsLimit

  try {
    // Keep fetching pages until we've exhausted results or reached the reported total
    while (true) {
      const vestQuery = `?query=vest_reward.participant='${address}'&limit=${limit}&page=${page}`;
      const res: any = await blockchain.rpc.getTxs(vestQuery, {})
      const items: TxResponse[] = res?.tx_responses || []

      if (!items.length) break

      all.push(...items)

      const totalStr = res?.total
      const total = totalStr != null ? Number(totalStr) : NaN

      // Stop when either we know we've reached total, or this page was not full
      if (!Number.isNaN(total) && all.length >= total) break
      if (items.length < limit) break

      page += 1
    }

    allVestingRewardsTxs.value = all
    // Ensure total reflects all fetched txs for consumers like pie charts/pagination
    vestingRewardsTotal.value = String(all.length || 0)
  } catch (_) {
    // On failure, don't break the UI – just fall back to current page data
    allVestingRewardsTxs.value = []
  }
}

function onVestingRewardsPageChange(page: number) {
  loadVestingRewards(props.address, page);
}
</script>
<template>
  <div v-if="account">
    <!-- address -->
    <div class="bg-base-100 px-4 pt-3 pb-4 rounded mb-4 shadow">
      <div class="flex items-center">
        <!-- img -->
        <div class="inline-flex relative w-11 h-11 rounded-md">
          <div
            class="w-11 h-11 absolute rounded-md opacity-10 bg-primary"
          ></div>
          <div
            class="w-full inline-flex items-center align-middle flex-none justify-center"
          >
            <Icon
              icon="mdi-qrcode"
              class="text-primary"
              style="width: 27px; height: 27px"
            />
          </div>
        </div>
        <!-- content -->
        <div class="flex flex-1 flex-col truncate pl-4">
          <h2 class="text-sm card-title">{{ $t('account.address') }}:</h2>
          <span class="text-xs truncate"> {{ address }}</span>
        </div>
      </div>
    </div>

    <!-- Assets -->
    <div class="bg-base-100 px-4 pt-3 pb-4 rounded mb-4 shadow">
      <div class="flex justify-between">
        <h2 class="card-title mb-4">{{ $t('account.assets') }}</h2>
        <!-- button -->
        <div class="flex justify-end mb-4 pr-5">
            <label
              for="send"
              class="btn btn-primary btn-sm mr-2"
              @click="dialog.open('send', { balances: balances }, updateEvent)"
              >{{ $t('account.btn_send') }}</label
            >
            <label
              for="transfer"
              class="btn btn-primary btn-sm"
              @click="
                dialog.open(
                  'transfer',
                  {
                    chain_name: blockchain.current?.prettyName,
                  },
                  updateEvent
                )
              "
              >{{ $t('account.btn_transfer') }}</label
            >
          </div>
      </div>
      <div class="grid md:!grid-cols-3">
        <div class="md:!col-span-1">
          <DonutChart
            :series="totalAmountByCategory"
            :labels="labels"
            :hoverIndex="hoveredSlice"
            :colors="seriesColors"
            :valueFormatter="valueFmt"
            :totalFormatter="totalFmt"
          />
        </div>
        <div class="mt-4 md:!col-span-2 md:!mt-0 md:!ml-4">          
          <!-- list-->
          <div class="">
            <!--balances  -->
            <div
              class="flex items-center px-4 mb-2"
              v-for="(balanceItem, index) in balances"
              :key="index"
            >
              <div class="inline-flex items-center" @mouseenter="hoveredSlice = 0" @mouseleave="hoveredSlice = null">
                <div
                  class="w-9 h-9 rounded overflow-hidden flex items-center justify-center relative mr-4"
                >
                  <Icon icon="mdi-account-cash" class="text-info" size="20" />
                  <div
                    class="absolute top-0 bottom-0 left-0 right-0 bg-info opacity-20"
                  ></div>
                </div>
                <div>
                  <div class="text-sm font-semibold">
                    {{ format.formatToken(balanceItem) }}
                  </div>
                  <div class="text-xs">
                    {{ format.calculatePercent(format.tokenDisplayNumber(balanceItem, 'local'), totalAmount) }}
                  </div>
                </div>
              </div>
              <div
                class="text-xs truncate relative py-1 px-3 rounded-full w-fit text-primary dark:invert mr-2"
                v-if="showValuations"
              >
                <span
                  class="inset-x-0 inset-y-0 opacity-10 absolute bg-primary dark:invert text-sm"
                ></span>
                ${{ format.tokenValue(balanceItem) }}                
              </div>
            </div>
            <!-- vesting.total -->
            <div
              class="flex items-center px-4 mb-2"
              v-for="(vestingItem, index) in vestingTotal"
              :key="index"
            >
              <div class="inline-flex items-center" @mouseenter="hoveredSlice = 1" @mouseleave="hoveredSlice = null">
                <div
                  class="w-9 h-9 rounded overflow-hidden flex items-center justify-center relative mr-4"
                >
                  <Icon
                    icon="mdi-timer-sand"
                    class="text-success"
                    size="20"
                  />
                  <div
                    class="absolute top-0 bottom-0 left-0 right-0 bg-success opacity-20"
                  ></div>
                </div>
                <div>
                  <div class="text-sm font-semibold">
                    {{ format.formatToken(vestingItem) }}
                  </div>
                  <div class="text-xs">{{ format.calculatePercent(format.tokenDisplayNumber(vestingItem, 'local'), totalAmount) }}</div>
                </div>
              </div>
              <div
                class="text-xs truncate relative py-1 px-3 rounded-full w-fit text-primary dark:invert mr-2"
                v-if="showValuations"
              >
                <span
                  class="inset-x-0 inset-y-0 opacity-10 absolute bg-primary  dark:invert text-sm"
                ></span>${{ format.tokenValue(vestingItem) }}
                
              </div>
            </div>
          </div>
          <!-- Total value hidden for now - can be enabled later when valuation is available
          <div class="mt-4 text-lg font-semibold mr-5 pl-5 border-t pt-4 text-right" v-if="showValuations">
            {{ $t('account.total_value') }}: ${{ totalValue }}
          </div>
          -->
        </div>
      </div>
    </div>

    <!-- Transactions -->
    <div class="bg-base-100 px-4 pt-3 pb-4 rounded mb-4 shadow">
      <h2 class="card-title mb-4">{{ $t('account.transactions') }}</h2>
      <div class="overflow-x-auto">
        <table class="table w-full text-sm">
          <thead>
            <tr>
              <th class="py-3">{{ $t('account.height') }}</th>
              <th class="py-3">{{ $t('account.hash') }}</th>
              <th class="py-3">{{ $t('account.messages') }}</th>
              <th class="py-3">{{ $t('account.time') }}</th>
            </tr>
          </thead>
          <tbody class="text-sm">
            <tr v-if="txs.length === 0"><td colspan="10"><div class="text-center">{{ $t('account.no_transactions') }}</div></td></tr>
            <tr v-for="(v, index) in txs" :key="index">
              <td class="text-sm py-3">
                <RouterLink :to="`/${chain}/block/${v.height}`" class="text-primary dark:invert">{{
                  v.height
                }}</RouterLink>
              </td>
              <td class="truncate py-3" style="max-width: 200px">
                <RouterLink :to="`/${chain}/tx/${v.txhash}`" class="text-primary dark:invert">
                  {{ v.txhash }}
                </RouterLink>
              </td>
              <td class="flex items-center py-3">
                <div class="mr-2">
                  {{ format.messages(v.tx.body.messages) }}
                </div>
                <Icon
                  v-if="v.code === 0"
                  icon="mdi-check"
                  class="text-success text-lg"
                />
                <Icon v-else icon="mdi-multiply" class="text-error text-lg" />
              </td>
              <td class="py-3">{{ format.toLocaleDate(v.timestamp) }} <span class=" text-xs">({{ format.toDay(v.timestamp, 'from') }})</span> </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Inferences -->
    <div class="bg-base-100 px-4 pt-3 pb-4 rounded mb-4 shadow">
      <h2 class="card-title mb-4">{{ $t('account.inferences') }}</h2>
      <div class="overflow-x-auto">
        <table class="table w-full text-sm">
          <thead>
            <tr>
              <th class="py-3">ID</th>
              <th class="py-3">Status</th>
              <th class="py-3">Model</th>
              <th class="py-3">Total Tokens</th>
              <th class="py-3">Cost</th>
              <th class="py-3">Epoch</th>
            </tr>
          </thead>
          <tbody class="text-sm">
            <tr v-if="!inferences.stats || inferences.stats.length === 0">
              <td colspan="6">
                <div class="text-center">{{ $t('account.no_inferences') }}</div>
              </td>
            </tr>
            <tr v-for="(item, index) in inferences.stats" :key="index">
              <td class="truncate py-3" style="max-width: 200px">
                {{ item.inference.inference_id }}
              </td>
              <td class="py-3">
                <span :class="getStatusColor(item.inference.status)" class="font-semibold">
                  {{ item.inference.status }}
                </span>
              </td>
              <td class="py-3">{{ item.inference.model }}</td>
              <td class="py-3">{{ format.formatNumber(Number(item.inference.total_token_count)) }}</td>
              <td class="py-3">{{ format.formatNumber(Number(item.inference.actual_cost_in_coins)) }}</td>
              <td class="py-3">{{ item.epoch_id }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Received (Transfers) -->
    <div class="bg-base-100 px-4 pt-3 pb-4 rounded mb-4 shadow">
      <h2 class="card-title mb-4">Received (Transfers)</h2>
      <div class="overflow-x-auto">
        <table class="table w-full text-sm">
          <thead>
            <tr>
              <th class="py-3">{{ $t('account.height') }}</th>
              <th class="py-3">{{ $t('account.hash') }}</th>
              <th class="py-3">{{ $t('account.amount') }}</th>
              <th class="py-3">{{ $t('account.time') }}</th>
            </tr>
          </thead>
          <tbody class="text-sm">
            <tr v-if="recentReceivedTransfers.length === 0"><td colspan="10"><div class="text-center">{{ $t('account.no_transactions') }}</div></td></tr>
            <tr v-for="(v, index) in recentReceivedTransfers" :key="index">
              <td class="text-sm py-3">
                <RouterLink :to="`/${chain}/block/${v.height}`" class="text-primary dark:invert">{{
                  v.height
                }}</RouterLink>
              </td>
              <td class="truncate py-3" style="max-width: 200px">
                <RouterLink :to="`/${chain}/tx/${v.txhash}`" class="text-primary dark:invert">
                  {{ v.txhash }}
                </RouterLink>
              </td>
              <td class="flex items-center py-3">
                <div class="mr-2">
                  {{ mapAmount(v.events)?.join(", ")}}
                </div>
                <Icon
                  v-if="v.code === 0"
                  icon="mdi-check"
                  class="text-success text-lg"
                />
                <Icon v-else icon="mdi-multiply" class="text-error text-lg" />
              </td>
              <td class="py-3">{{ format.toLocaleDate(v.timestamp) }} <span class=" text-xs">({{ format.toDay(v.timestamp, 'from') }})</span> </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Received (Vesting Rewards) -->
    <div class="bg-base-100 px-4 pt-3 pb-4 rounded mb-4 shadow">
      <h2 class="card-title mb-4">Vesting Rewards</h2>
      <div class="overflow-x-auto">
        <table class="table w-full text-sm">
          <thead>
            <tr>
              <th class="py-3">Epoch</th>
              <th class="py-3">{{ $t('account.height') }}</th>
              <th class="py-3">{{ $t('account.hash') }}</th>
              <th class="py-3">{{ $t('account.amount') }}</th>
            </tr>
          </thead>
          <tbody class="text-sm">
            <tr v-if="vestingRewardsTxs.length === 0"><td colspan="10"><div class="text-center">{{ $t('account.no_transactions') }}</div></td></tr>
            <tr v-for="(v, index) in vestingRewardsTxs" :key="index">
              <td class="text-sm py-3">
                {{ getEpochIndexFromTx(v) }}
              </td>
              <td class="text-sm py-3">
                <RouterLink :to="`/${chain}/block/${v.height}`" class="text-primary dark:invert">{{
                  v.height
                }}</RouterLink>
              </td>
              <td class="truncate py-3" style="max-width: 200px">
                <RouterLink :to="`/${chain}/tx/${v.txhash}`" class="text-primary dark:invert">
                  {{ v.txhash }}
                </RouterLink>
              </td>
              <td class="flex items-center py-3">
                <div class="mr-2 tooltip" :data-tip="getVestingRewardDetails(v.events).details">
                  {{ getVestingRewardDetails(v.events).total }}
                </div>
                <Icon
                  v-if="v.code === 0"
                  icon="mdi-check"
                  class="text-success text-lg"
                />
                <Icon v-else icon="mdi-multiply" class="text-error text-lg" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <PaginationBar 
        :total="vestingRewardsTotal" 
        :limit="vestingRewardsLimit" 
        :callback="onVestingRewardsPageChange"
        :page="vestingRewardsPage"
      />
    </div>

    <!-- Account -->
    <div class="bg-base-100 px-4 pt-3 pb-4 rounded mb-4 shadow">
      <h2 class="card-title mb-4">{{ $t('account.acc') }}</h2>
      <DynamicComponent :value="account" />
    </div>
  </div>
  <div v-else class="text-no text-sm">{{ $t('account.error') }}</div>
</template>
