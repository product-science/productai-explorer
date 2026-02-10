<script lang="ts" setup>
import { onMounted, ref, watch, computed } from 'vue';
import { Icon } from '@iconify/vue';
import TxsElement from '@/components/dynamic/TxsElement.vue';
import DynamicComponent from '@/components/dynamic/DynamicComponent.vue';
import { onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';
import { useBaseStore, useFormatter, useBlockchain } from '@/stores';
import type { Block, TxResponse } from '@/types';
import Countdown from '@/components/Countdown.vue';
import { hashTx } from '@/libs';
import { fromBase64 } from '@cosmjs/encoding';

const props = defineProps(['height', 'chain']);
const route = useRoute();
const store = useBaseStore();
const format = useFormatter();
const blockchain = useBlockchain();

const current = ref({} as Block);
const target = ref(Number(props.height || 0));
const txResponses = ref<TxResponse[]>([]);
const loadingTxs = ref(false);
const router = useRouter();
const txViewMode = ref<'list' | 'totals'>('list');
const activeTab = ref<'header' | 'transactions' | 'commit'>((route.query.tab as any) || 'transactions');

// Sync tab with URL
watch(activeTab, (val) => {
    router.replace({ query: { ...route.query, tab: val } });
});

watch(() => route.query.tab, (val) => {
    if(val && ['header', 'transactions', 'commit'].includes(val as string)) {
        activeTab.value = val as any;
    }
});

const height = computed(() => {
  return Number(current.value.block?.header?.height || props.height || 0);
});

const isFutureBlock = computed(() => {
  const latest = store.latest?.block?.header.height;
  return latest ? target.value > Number(latest) : false;
});

const isLoading = ref(true);

// Helper to fetch data
const loadData = async (h: number) => {
    // if (isLoading.value) return; // Prevent concurrent fetches - Removed to allow initial load with isLoading=true
    isLoading.value = true;
    
    target.value = h;
    const latest = store.latest?.block?.header.height;
    
    // If we know it's a future block (and latest is loaded), stop.
    // If latest not loaded, we fetch anyway.
    if (latest && h > Number(latest)) {
        current.value = {} as Block;
        txResponses.value = [];
        isLoading.value = false;
        return;
    }
    
    try {
        const block = await store.fetchBlock(h);
        current.value = block;
        
        // Fetch Tx Responses if there are txs
        if(block?.block?.data?.txs?.length > 0) {
            loadingTxs.value = true;
            
            // Try to load from cache
            const cachedTxs = store.getCachedTxResponses(h);
            if (cachedTxs) {
                txResponses.value = cachedTxs;
                loadingTxs.value = false;
                return;
            }

            try {
                // 1. Try LCD first
                const res = await blockchain.rpc.getTxsAt(h) as any;
                if(res && res.tx_responses && res.tx_responses.length > 0) {
                    txResponses.value = res.tx_responses;
                } else {
                    // 2. Fallback to RPC block_results
                    // Construct RPC URL: replace "chain-api" with "chain-rpc"
                    let rpcUrl = blockchain.endpoint.address.includes('chain-api') 
                        ? blockchain.endpoint.address.replace('chain-api', 'chain-rpc')
                        : blockchain.endpoint.address; // heuristic fallback
                    
                    // RPC endpoint for block_results
                    const resultsUrl = `${rpcUrl}/block_results?height=${h}`;
                    const rpcRes = await fetch(resultsUrl).then(r => r.json());
                    
                    if(rpcRes && rpcRes.result && rpcRes.result.txs_results) {
                        // Map results to TxResponse format by index
                        const rawTxs = block.block.data.txs;
                        const results = rpcRes.result.txs_results;
                        
                        txResponses.value = rawTxs.map((txStr: string, i: number) => {
                            const result = results[i] || {};
                            const txBytes = fromBase64(txStr);
                            const hash = hashTx(txBytes);
                            
                            return {
                                txhash: hash,
                                code: result.code || 0,
                                raw_log: result.log || '',
                                gas_used: result.gas_used || '0',
                                gas_wanted: result.gas_wanted || '0',
                                height: String(h),
                                logs: [] 
                            } as any as TxResponse;
                        });
                    } else {
                         txResponses.value = [];
                    }
                }
                // Cache the final result
                store.cacheTxResponses(h, txResponses.value);

            } catch(e) {
                console.error("Failed to fetch tx responses", e);
                txResponses.value = [];
            } finally {
                loadingTxs.value = false;
            }
        } else {
            txResponses.value = [];
        }
    } catch(e) {
        console.error(e);
    } finally {
        isLoading.value = false;
    }
};

const remainingBlocks = computed(() => {
  const latest = store.latest?.block?.header.height;
  return latest ? Number(target.value) - Number(latest) : 0;
});

// Auto-load if we entered the block range (from future to present)
watch(() => remainingBlocks.value, (rem) => {
     if (rem <= 0 && !current.value.block_id && Number(target.value) > 0 && !isLoading.value) {
         loadData(target.value);
     }
});

const estimateTime = computed(() => {
  const seconds = Number((remainingBlocks.value * store.blocktime).toFixed(2));
  return seconds;
});

const estimateDate = computed(() => {
  return new Date(new Date().getTime() + estimateTime.value);
});

// Merged Header Data
const mergedHeader = computed(() => {
    if(!current.value?.block?.header) return {};
    
    const h = current.value.block.header;
    const id = current.value.block_id;
    
    // Create new object order: ... fields ..., block_id, last_block_id, ...
    const { last_block_id, ...rest } = h as any; // Extract last_block_id to re-insert it later
    
    // We want block_id before last_block_id
    // Simple way is to rebuild object manually or just Object.assign but keys order matters for UI often
    // Let's rely on standard object spread for acceptable ordering
    // Ideally: Version -> ChainID -> Height -> Time -> BlockID -> LastBlockID -> etc
    
    return {
        version: h.version,
        chain_id: h.chain_id,
        height: h.height,
        time: h.time,
        block_id: id, // Injected here
        last_block_id: last_block_id,
        ...rest // Rest of fields like last_commit_hash, etc.
    };
});

const edit = ref(false);
const newHeight = ref(props.height);

function updateTarget() {
  const newTarget = Number(newHeight.value);
  target.value = newTarget;
  loadData(newTarget);
}

// Watch for prop changes (e.g. route change)
watch(() => props.height, (newVal) => {
    if(newVal) {
        newHeight.value = newVal;
        loadData(Number(newVal));
    }
});

// Initial load
onMounted(() => {
    if(props.height) loadData(Number(props.height));
});

// Route update hook
onBeforeRouteUpdate(async (to, from, next) => {
  if (to.params.height !== from.params.height) {
    await loadData(Number(to.params.height));
  }
  next();
});

</script>
<template>
  <div>
    <div v-if="isFutureBlock" class="text-center">
      <div v-if="remainingBlocks > 0">
        <div class="text-primary font-bold text-lg my-10">#{{ target }}</div>
        <Countdown :time="estimateTime" css="md:!text-5xl font-sans md:mx-5" />
        <div class="my-5">{{ $t('block.estimated_time') }}: <span class="text-xl font-bold">{{ format.toLocaleDate(estimateDate) }}</span>
        </div>
        <div class="pt-10 flex justify-center">
          <table class="table w-max rounded-lg bg-base-100">
            <tbody>
              <tr class="hover cursor-pointer" @click="edit = !edit">
                <td>{{ $t('block.countdown_for_block') }}:</td>
                <td class="text-right"><span class="md:!ml-40">{{ target }}</span></td>
              </tr>
              <tr v-if="edit">
                <td colspan="2" class="text-center">
                  <h3 class="text-lg font-bold">{{ $t('block.countdown_for_block_input') }}</h3>
                  <p class="py-4">
                  <div class="join">
                    <input class="input input-bordered join-item" v-model="newHeight" type="number" />
                    <button class="btn btn-primary join-item" @click="updateTarget()">{{ $t('block.btn_update') }}</button>
                  </div>
                  </p>
                </td>
              </tr>
              <tr>
                <td>{{ $t('block.current_height') }}:</td>
                <td class="text-right">#{{ store.latest?.block?.header.height }}</td>
              </tr>
              <tr>
                <td>{{ $t('block.remaining_blocks') }}:</td>
                <td class="text-right">{{ remainingBlocks }}</td>
              </tr>
              <tr>
                <td>{{ $t('block.average_block_time') }}:</td>
                <td class="text-right">{{ (store.blocktime / 1000).toFixed(1) }}s</td>
              </tr>
            </tbody>
          </table>
        </div>

      </div>
    </div>
    <div v-else>
      <!-- Top Navigation -->
      <div class="flex items-center justify-center gap-4 mb-6">
          <RouterLink v-if="props.height" :to="`/${store.blockchain.chainName}/block/${height - 1}`"
            class="btn btn-ghost btn-sm p-1 text-2xl">
            <Icon icon="mdi-arrow-left" class="w-6 h-6" />
          </RouterLink>
          
          <h1 class="text-3xl font-bold">Block #{{ current.block?.header?.height }}</h1>
          
          <RouterLink v-if="props.height" :to="`/${store.blockchain.chainName}/block/${height + 1}`"
            class="btn btn-ghost btn-sm p-1 text-2xl">
            <Icon icon="mdi-arrow-right" class="w-6 h-6" />
          </RouterLink>
      </div>

      <!-- Main Tabs -->
      <div class="tabs tabs-boxed mb-6 justify-center bg-base-100 p-2 rounded-lg shadow-sm w-fit mx-auto">
        <a class="tab tab-lg" :class="{ 'tab-active': activeTab === 'header' }" @click="activeTab = 'header'">{{ $t('block.block_header') }}</a>
        <a class="tab tab-lg" :class="{ 'tab-active': activeTab === 'transactions' }" @click="activeTab = 'transactions'">{{ $t('account.transactions') }}</a>
        <a class="tab tab-lg" :class="{ 'tab-active': activeTab === 'commit' }" @click="activeTab = 'commit'">{{ $t('block.last_commit') }}</a>
      </div>

      <!-- Tab Content: Header (Merged) -->
      <div v-if="activeTab === 'header'" class="bg-base-100 px-4 pt-3 pb-4 rounded mb-4 shadow">
        <DynamicComponent :value="mergedHeader" />
      </div>

      <!-- Tab Content: Transactions -->
      <div v-if="activeTab === 'transactions'">
          <TxsElement 
            :value="current.block?.data?.txs" 
            :responses="txResponses" 
            :loading="isLoading || loadingTxs"
            :view-mode="txViewMode"
          />
      </div>

      <!-- Tab Content: Last Commit -->
      <div v-if="activeTab === 'commit'" class="bg-base-100 px-4 pt-3 pb-4 rounded shadow">
        <DynamicComponent :value="current.block?.last_commit" />
      </div>
  </div>
</div></template>
