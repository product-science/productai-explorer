<script lang="ts" setup>
import {
  useBlockchain,
  useFormatter,
  useTxDialog,
} from '@/stores';
import DynamicComponent from '@/components/dynamic/DynamicComponent.vue';
import DonutChart from '@/components/charts/DonutChart.vue';
import { computed, ref } from '@vue/reactivity';
import { onMounted } from 'vue';
import { Icon } from '@iconify/vue';

import type {
  AuthAccount,
  TxResponse,
  DelegatorRewards,
  InferenceResponse,
} from '@/types';
import type { Coin } from '@cosmjs/amino';
import Countdown from '@/components/Countdown.vue';
import { fromBase64 } from '@cosmjs/encoding';

const props = defineProps(['address', 'chain']);

const blockchain = useBlockchain();
const dialog = useTxDialog();
const format = useFormatter();
const account = ref({} as AuthAccount);
const txs = ref({} as TxResponse[]);
const rewards = ref({} as DelegatorRewards);
const balances = ref([] as Coin[]);
const recentReceived = ref([] as TxResponse[]);
const inferences = ref({ stats: [] } as InferenceResponse);
const chart = {};

onMounted(() => {
  loadAccount(props.address);
});

const totalAmountByCategory = computed(() => {
  let sumRew = 0;
  rewards.value?.total?.forEach((x) => {
    sumRew += Number(x.amount);
  });
  let sumBal = 0;
  balances.value?.forEach((x) => {
    sumBal += Number(x.amount);
  });
  return [sumBal, sumRew];
});

const labels = ['Balance', 'Reward'];

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
  blockchain.rpc.getDistributionDelegatorRewards(address).then((x) => {
    rewards.value = x;
  });
  blockchain.rpc.getBankBalances(address).then((x) => {
    balances.value = x.balances;
  });

  const receivedQuery =  `?&pagination.reverse=true&events=coin_received.receiver='${address}'&pagination.limit=5`;
  blockchain.rpc.getTxs(receivedQuery, {}).then((x) => {
    recentReceived.value = x.tx_responses;
  });

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

function mapAmount(events:{type: string, attributes: {key: string, value: string}[]}[]) {
  if(!events) return []
  return events.find(x => x.type==='coin_received')?.attributes
    .filter(x => x.key === 'YW1vdW50'|| x.key === `amount`)
    .map(x => x.key==='amount'? x.value : String.fromCharCode(...fromBase64(x.value)))
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
          <DonutChart :series="totalAmountByCategory" :labels="labels" />
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
              <div
                class="w-9 h-9 rounded overflow-hidden flex items-center justify-center relative mr-4"
              >
                <Icon icon="mdi-account-cash" class="text-info" size="20" />
                <div
                  class="absolute top-0 bottom-0 left-0 right-0 bg-info opacity-20"
                ></div>
              </div>
              <div class="flex-1">
                <div class="text-sm font-semibold">
                  {{ format.formatToken(balanceItem) }}
                </div>
                <div class="text-xs">
                  {{ format.calculatePercent(balanceItem.amount, totalAmount) }}
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
            <!-- rewards.total -->
            <div
              class="flex items-center px-4 mb-2"
              v-for="(rewardItem, index) in rewards.total"
              :key="index"
            >
              <div
                class="w-9 h-9 rounded overflow-hidden flex items-center justify-center relative mr-4"
              >
                <Icon
                  icon="mdi-account-arrow-up"
                  class="text-success"
                  size="20"
                />
                <div
                  class="absolute top-0 bottom-0 left-0 right-0 bg-success opacity-20"
                ></div>
              </div>
              <div class="flex-1">
                <div class="text-sm font-semibold">
                  {{ format.formatToken(rewardItem) }}
                </div>
                <div class="text-xs">{{ format.calculatePercent(rewardItem.amount, totalAmount) }}</div>
              </div>
              <div
                class="text-xs truncate relative py-1 px-3 rounded-full w-fit text-primary dark:invert mr-2"
                v-if="showValuations"
              >
                <span
                  class="inset-x-0 inset-y-0 opacity-10 absolute bg-primary  dark:invert text-sm"
                ></span>${{ format.tokenValue(rewardItem) }}
                
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

    <!-- Received -->
    <div class="bg-base-100 px-4 pt-3 pb-4 rounded mb-4 shadow">
      <h2 class="card-title mb-4">{{ $t('account.received') }}</h2>
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
            <tr v-if="recentReceived.length === 0"><td colspan="10"><div class="text-center">{{ $t('account.no_transactions') }}</div></td></tr>
            <tr v-for="(v, index) in recentReceived" :key="index">
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

    <!-- Account -->
    <div class="bg-base-100 px-4 pt-3 pb-4 rounded mb-4 shadow">
      <h2 class="card-title mb-4">{{ $t('account.acc') }}</h2>
      <DynamicComponent :value="account" />
    </div>
  </div>
  <div v-else class="text-no text-sm">{{ $t('account.error') }}</div>
</template>
