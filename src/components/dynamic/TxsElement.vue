<script lang="ts" setup>
import { fromBase64, toBase64 } from '@cosmjs/encoding';
import { decodeTxRaw } from '@cosmjs/proto-signing';
import { computed, ref, watch } from 'vue';
import { hashTx } from '@/libs';
import { Icon } from '@iconify/vue';
import { useFormatter } from '@/stores/useFormatter';
import { useBlockchain } from '@/stores/useBlockchain';
import { useBaseStore } from '@/stores/useBaseStore';
import type { TxResponse } from '@/types/transaction';
import type { PropType } from 'vue';
import { MsgExec } from 'cosmjs-types/cosmos/authz/v1beta1/tx';
import { PubKey } from 'cosmjs-types/cosmos/crypto/secp256k1/keys';
import { pubkeyToAddress } from '@cosmjs/amino';

const props = defineProps({
  value: { type: Array<string> },
  responses: { type: Array as PropType<TxResponse[]> },
  loading: { type: Boolean, default: false },
});

const format = useFormatter();
const chain = useBlockchain();
const baseStore = useBaseStore(); // Use global store for persistent filter state

// Helper to extract message names (copied from useFormatter to group properly)
const formatMsgUrl = (url: string) => {
  return url.substring(url.lastIndexOf('.') + 1).replace('Msg', '');
}

// Simple proto field reader for fallback address extraction (Field 1 = Creator convention)
const extractStringField = (data: Uint8Array, fieldNum: number): string | null => {
    try {
        let offset = 0;
        while(offset < data.length) {
             const byte = data[offset++];
             const wireType = byte & 0x07;
             const num = byte >> 3;
             
             let value: any; // minimal varint/bytes reader
             if (wireType === 0) {
                 // varint
                 let shift = 0;
                 while(offset < data.length) {
                     const b = data[offset++];
                     if ((b & 0x80) === 0) break;
                     shift += 7;
                 }
             } else if (wireType === 2) {
                 // length delimited
                 let len = 0;
                 let shift = 0;
                 while(offset < data.length) {
                     const b = data[offset++];
                     len |= (b & 0x7F) << shift;
                     if ((b & 0x80) === 0) break;
                     shift += 7;
                 }
                 const bytes = data.slice(offset, offset + len);
                 offset += len;
                 if (num === fieldNum) {
                     return new TextDecoder().decode(bytes);
                 }
             } else {
                 // skip other types (simplified, barely needed for field 1 usually)
                 break; 
             }
        }
    } catch(e) {}
    return null;
}

const getMsgName = (msg: { '@type'?: string; typeUrl?: string; value?: Uint8Array }): string[] => {
  const typeUrl = msg['@type'] || msg.typeUrl || 'unknown';
  if (typeUrl === '/cosmos.authz.v1beta1.MsgExec' && msg.value) {
    try {
      const decoded = MsgExec.decode(msg.value);
      if (decoded.msgs && decoded.msgs.length > 0) {
        return decoded.msgs.map((inner: any) => {
          const innerName = getMsgName(inner);
          return innerName; // Recursive flatten
        }).flat();
      }
    } catch (e) { }
  }
  return [formatMsgUrl(typeUrl)];
};

const txs = computed(() => {
  return props.value?.map((x) => {
    const tx_bytes = fromBase64(x);
    let tx = null
    let injected = false
    let sender = ''
    let gasLimit = ''
    
    // 1. Decode generic Tx
    try {
      tx = decodeTxRaw(fromBase64(x))
      if(tx) {
          // Gas Limit
          gasLimit = tx.authInfo.fee?.gasLimit.toString() || '';
          
          // Sender Strategy 0: MsgExec Inner Creator (High Priority)
          if (tx.body.messages.length > 0 && chain.current?.bech32Prefix) {
               const msg = tx.body.messages[0];
               if (msg.typeUrl === '/cosmos.authz.v1beta1.MsgExec') {
                   try {
                       const decoded = MsgExec.decode(msg.value);
                       if (decoded.msgs.length > 0) {
                           // Extract Field 1 (Creator) from the first inner message
                           const innerSender = extractStringField(decoded.msgs[0].value, 1);
                           if (innerSender && innerSender.startsWith(chain.current.bech32Prefix)) {
                               sender = innerSender;
                           }
                       }
                   } catch(e) {}
               }
          }
          
          // Sender Strategy 1: PubKey
          if (!sender && tx.authInfo.signerInfos.length > 0 && chain.current?.bech32Prefix) {
               try {
                   const pubKey = tx.authInfo.signerInfos[0].publicKey;
                   if (pubKey) {
                       // Decode Proto PubKey wrapper
                       if(pubKey.typeUrl.includes('secp256k1')) {
                           const decoded = PubKey.decode(pubKey.value);
                           sender = pubkeyToAddress({
                               type: 'tendermint/PubKeySecp256k1',
                               value: toBase64(decoded.key)
                           }, chain.current.bech32Prefix);
                       }
                   }
               } catch(e) { }
          }
           
          // Sender Strategy 2: First Message Field 1 (Fallback)
          if (!sender && tx.body.messages.length > 0 && chain.current?.bech32Prefix) {
               try {
                   const msg = tx.body.messages[0];
                   // Basic heuristic: check if we can read field 1 as string and if it looks like an address
                   const possibleAddr = extractStringField(msg.value, 1);
                   if (possibleAddr && possibleAddr.startsWith(chain.current.bech32Prefix)) {
                       sender = possibleAddr;
                   }
               } catch(e) {}
          }
      }
    } catch(e) {
      injected = true
    } 
    
    const hash = hashTx(tx_bytes);
    // Find response by hash (upper case)
    const response = props.responses?.find((r: TxResponse) => r.txhash === hash);
    
    // Extract message types for this tx
    let msgTypes: string[] = [];
    if(tx) {
        msgTypes = tx.body.messages.map((m: any) => getMsgName({ ...m, value: m.value })).flat();
    }
    
    // Gas Used / Wanted
    const gasUsed = response?.gas_used;
    const gasWanted = response?.gas_wanted;

    return {
      hash,
      tx,
      injected,
      code: response?.code,
      raw_log: response?.raw_log,
      msgTypes,
      sender,
      gasLimit,
      gasUsed,
      gasWanted
    }
  }) || []
});

// Sorting State for List Table
const sortBy = ref('');
const sortDesc = ref(false);

const toggleSort = (col: string) => {
    if(sortBy.value === col) {
        sortDesc.value = !sortDesc.value;
    } else {
        sortBy.value = col;
        sortDesc.value = false;
    }
}

// Filter State from Store
const activeFilter = computed(() => baseStore.txFilterState);

const toggleMsgType = (msgType: string) => {
    baseStore.toggleTxFilter('msgTypes', msgType);
}

const toggleCreator = (creator: string) => {
    baseStore.toggleTxFilter('creators', creator);
}

// Check if a creator is selected
const isCreatorActive = (creator: string) => {
    return activeFilter.value.creators.includes(creator);
}

// Check if Msg Group is active (itself selected OR implicit via child creator)
const isMsgGroupActive = (msgType: string, creatorsInGroup: string[]) => {
    // 1. Is the Msg Type explicitly selected?
    if (activeFilter.value.msgTypes.includes(msgType)) return true;
    
    // 2. Is any creator in this group selected?
    // We check if any of the creators currently listed in this group (based on visible/total txs) is in the selected creators list.
    if (activeFilter.value.creators.some(c => creatorsInGroup.includes(c))) return true;
    
    return false;
}

// Expansion State
const expandedGroups = ref<Record<string, boolean>>({});
const creatorLimits = ref<Record<string, number>>({});

const toggleGroup = (key: string) => {
    expandedGroups.value[key] = !expandedGroups.value[key];
    if(!creatorLimits.value[key]) creatorLimits.value[key] = 10;
}

// Auto-expand group if filter is added
watch(activeFilter, (val, oldVal) => {
    // If a new msgType was added, expand it
    val.msgTypes.forEach(t => {
        if (!oldVal.msgTypes.includes(t)) expandedGroups.value[t] = true;
    });
}, { deep: true });

const showMoreCreators = (key: string) => {
    creatorLimits.value[key] = (creatorLimits.value[key] || 10) + 10;
}

// Calculate Totals for Stats Table
const totals = computed(() => {
    const map = {} as Record<string, { 
        total: number, 
        failed: number, 
        gas: number, 
        failedGas: number,
        creators: Record<string, { count: number, failed: number, gas: number, failedGas: number }> 
    }>;
    
    txs.value.forEach(t => {
         const displayMsg = t.tx ? format.messages(t.tx.body.messages.map((x: any) => ({ '@type': x.typeUrl, typeUrl: x.typeUrl, value: x.value }))) : 'Unknown';
         const key = displayMsg || 'Unknown';

         if(!map[key]) map[key] = { total: 0, failed: 0, gas: 0, failedGas: 0, creators: {} };
         
         const group = map[key];
         group.total++;
         
         const gas = Number(t.gasUsed || t.gasLimit || 0);
         group.gas += gas;

         if(t.code !== undefined && t.code !== 0) {
             group.failed++;
             group.failedGas += gas;
         }
         
         const sender = t.sender || 'Unknown';
         if(!group.creators[sender]) group.creators[sender] = { count: 0, failed: 0, gas: 0, failedGas: 0 };
         const cStats = group.creators[sender];
         cStats.count++;
         cStats.gas += gas;
         if(t.code !== undefined && t.code !== 0) {
             cStats.failed++;
             cStats.failedGas += gas;
         }
    });
    
    return Object.keys(map).sort().map(k => {
        const sortedCreators = Object.keys(map[k].creators).map(c => ({
            address: c,
            ...map[k].creators[c]
        })).sort((a,b) => b.count - a.count);
        
        return {
            type: k,
            ...map[k],
            sortedCreators,
            // Pre-calculate list of creator addresses for fast lookup in isMsgGroupActive
            creatorAddresses: sortedCreators.map(c => c.address)
        };
    }).sort((a,b) => b.total - a.total);
});

// Computed List of Txs based on Filters
const filteredTxs = computed(() => {
    const list = txs.value.map(t => {
        const displayMsg = t.tx ? format.messages(t.tx.body.messages.map((x: any) => ({ '@type': x.typeUrl, typeUrl: x.typeUrl, value: x.value }))) : 'Unknown';
        return { ...t, displayMsg: displayMsg || 'Unknown' };
    });
    
    // Filter Logic:
    // If msgTypes has selection, Tx MUST be one of them.
    // If creators has selection, Tx MUST be from one of them.
    // (Intersection logic)
    
    let result = list;
    
    if (activeFilter.value.msgTypes.length > 0) {
        result = result.filter(t => activeFilter.value.msgTypes.includes(t.displayMsg));
    }
    
    if (activeFilter.value.creators.length > 0) {
        result = result.filter(t => activeFilter.value.creators.includes(t.sender));
    }
    
    // Sort
    if(!sortBy.value) return result;
    
    return result.sort((a,b) => {
        let valA: any = '';
        let valB: any = '';
        
        switch(sortBy.value) {
            case 'msg':
                valA = a.displayMsg || '';
                valB = b.displayMsg || '';
                break;
            case 'status':
                valA = a.code !== undefined ? a.code : 999;
                valB = b.code !== undefined ? b.code : 999;
                break;
            case 'gas':
                valA = Number(a.gasUsed || a.gasLimit || 0);
                valB = Number(b.gasUsed || b.gasLimit || 0);
                break;
            case 'creator':
                valA = a.sender || '';
                valB = b.sender || '';
                break;
            case 'hash':
                valA = a.hash;
                valB = b.hash;
                break;
        }
        
        if(valA < valB) return sortDesc.value ? 1 : -1;
        if(valA > valB) return sortDesc.value ? -1 : 1;
        return 0;
    });
});

const shortAddress = (addr: string) => {
    if(!addr) return '';
    return `${addr.substring(0, 8)}...${addr.substring(addr.length - 4)}`;
}

const getSortIcon = (key: string) => {
    if (sortBy.value !== key) return 'mdi:chevron-up';
    return sortDesc.value ? 'mdi:chevron-down' : 'mdi:chevron-up';
}

const isSortActive = (key: string) => sortBy.value === key;

// Hover State for Row Swap
const hoveredRow = ref<string | null>(null);

const setHovered = (hash: string | undefined) => {
    if (hash) hoveredRow.value = hash;
};

const clearHovered = () => {
    hoveredRow.value = null;
};

const formatGasPair = (count: number, gas: number) => {
    // Show gas as simple formatted number (e.g. 1.5M, 230k) or comma separated
    const gasStr = format.formatNumber(gas, '0,0.[00]a');
    return `${count} / ${gasStr}`
}
</script>

<template>
  <div>
    <!-- Stats Table (First) -->
    <div class="bg-base-100 rounded-lg shadow overflow-hidden mb-8" v-if="loading || totals.length > 0">
        <table class="table w-full custom-table">
          <thead class="bg-base-200">
            <tr class="uppercase">
              <th class="th-hover">{{ $t('tx.msg_type') }}</th>
              <th class="text-right th-hover">{{ $t('tx.total_stat') }}</th>
              <th class="text-right th-hover">{{ $t('tx.failed_stat') }}</th>
            </tr>
          </thead>
          <!-- Skeleton Loading for Stats -->
          <tbody v-if="loading">
              <tr v-for="i in 5" :key="i" class="border-b dark:border-gray-700/50 hover:bg-transparent">
                  <td>
                    <div class="flex items-center gap-2">
                        <div class="h-4 bg-black rounded w-4 text-transparent select-none" :style="{ opacity: (0.8 - (i-1)*0.15) }">.</div>
                        <div class="h-4 bg-black rounded w-32" :style="{ opacity: (0.8 - (i-1)*0.15) }"></div>
                    </div>
                  </td>
                  <td><div class="h-4 bg-black rounded w-24 ml-auto" :style="{ opacity: (0.8 - (i-1)*0.15) }"></div></td>
                  <td><div class="h-4 bg-black rounded w-16 ml-auto" :style="{ opacity: (0.8 - (i-1)*0.15) }"></div></td>
              </tr>
          </tbody>
          <tbody class="text-sm" v-else>
            <template v-for="t in totals" :key="t.type">
                <!-- Main Row -->
                <tr class="hover:bg-gray-100 dark:hover:bg-[#384059] group"> 
                  <td class="font-bold">
                       <div class="flex items-center gap-2">
                           <!-- Filter Toggle Icon -->
                           <button class="btn btn-ghost btn-xs btn-square" @click.stop="toggleMsgType(t.type)">
                               <Icon :icon="isMsgGroupActive(t.type, t.creatorAddresses) ? 'mdi:filter' : 'mdi:filter-outline'" 
                                     class="text-lg" 
                                     :class="isMsgGroupActive(t.type, t.creatorAddresses) ? 'text-primary' : 'opacity-50 group-hover:opacity-100'" />
                           </button>
                           <!-- Expand Toggle -->
                           <span class="cursor-pointer flex items-center gap-2 select-none" @click="toggleGroup(t.type)">
                               <span class="text-xs">{{ expandedGroups[t.type] ? '▼' : '▶' }}</span>
                                {{ t.type }}
                           </span>
                       </div>
                  </td>
                  <td class="text-right font-mono">{{ formatGasPair(t.total, t.gas) }}</td>
                  <td class="text-right font-mono">
                      <span :class="t.failed > 0 ? 'text-error font-bold' : 'text-success/50'">
                          {{ t.failed > 0 ? formatGasPair(t.failed, t.failedGas) : ' - / - ' }} 
                      </span>
                  </td>
                </tr>
                
                <!-- Creators Sub-rows (Inline style) -->
                <template v-if="expandedGroups[t.type]">
                     <tr v-for="c in t.sortedCreators.slice(0, creatorLimits[t.type] || 10)" :key="c.address" 
                         class="hover:bg-gray-50 dark:hover:bg-[#2d3345] border-none">
                         <td class="pl-12"> <!-- Indent -->
                             <div class="flex items-center gap-2">
                                <button class="btn btn-ghost btn-xs btn-square" @click.stop="toggleCreator(c.address)">
                                     <Icon :icon="isCreatorActive(c.address) ? 'mdi:filter' : 'mdi:filter-outline'" 
                                         class="text-base" 
                                         :class="isCreatorActive(c.address) ? 'text-primary' : 'opacity-30 hover:opacity-100'" />
                                 </button>
                                 <RouterLink :to="`/${chain.chainName}/account/${c.address}`" class="font-mono text-primary text-xs">
                                    {{ c.address }}
                                 </RouterLink>
                             </div>
                         </td>
                         <td class="text-right text-xs opacity-70">{{ formatGasPair(c.count, c.gas) }}</td>
                         <td class="text-right text-xs opacity-70">
                             <span :class="c.failed > 0 ? 'text-error' : ''">{{ c.failed > 0 ? formatGasPair(c.failed, c.failedGas) : ' - / - ' }}</span>
                         </td>
                     </tr>
                     <!-- Show More Button Row -->
                     <tr v-if="expandedGroups[t.type] && t.sortedCreators.length > (creatorLimits[t.type] || 10)">
                         <td colspan="3" class="text-center p-2">
                             <button class="btn btn-xs btn-ghost text-primary" @click="showMoreCreators(t.type)">
                                 {{ $t('tx.show_more') }} ({{ t.sortedCreators.length - (creatorLimits[t.type] || 10) }})
                             </button>
                         </td>
                     </tr>
                </template>
            </template>
          </tbody>
        </table>
    </div>

    <!-- Separator / Info if filtered -->
    <div v-if="activeFilter.msgTypes.length > 0 || activeFilter.creators.length > 0" class="mb-4 flex flex-wrap items-center gap-2 text-sm opacity-70 px-1">
        <Icon icon="mdi:filter" />
        <span v-if="activeFilter.msgTypes.length > 0">
            Msgs: 
            <span v-for="(m, i) in activeFilter.msgTypes" :key="m" class="font-bold">
                {{ m }}{{ i < activeFilter.msgTypes.length - 1 ? ', ' : '' }}
            </span>
        </span>
        <span v-if="activeFilter.msgTypes.length > 0 && activeFilter.creators.length > 0" class="mx-1">&</span>
        <span v-if="activeFilter.creators.length > 0">
            Creators: 
            <span v-for="(c, i) in activeFilter.creators" :key="c" class="font-bold font-mono">
                {{ shortAddress(c) }}{{ i < activeFilter.creators.length - 1 ? ', ' : '' }}
            </span>
        </span>
        <button class="btn btn-xs btn-ghost text-error" @click="baseStore.clearTxFilter()">Clear All</button>
    </div>

    <!-- List View (Second) -->
    <div class="bg-base-100 rounded-lg shadow overflow-x-auto">
        <table class="table w-full custom-table table-fixed" v-if="loading || filteredTxs.length > 0">
          <thead class="bg-base-200">
            <tr class="uppercase">
              <th scope="col" class="cursor-pointer select-none th-hover w-[35vw] md:w-[22%] sticky left-0 z-10 bg-base-200" @click="toggleSort('msg')">
                  <span class="inline-flex items-center">
                      {{ $t('tx.msg_type') }} 
                      <Icon :icon="getSortIcon('msg')" class="ml-1" :class="{ 'opacity-30': !isSortActive('msg') }" />
                  </span>
              </th>
              <th scope="col" class="cursor-pointer select-none th-hover w-[13%]" @click="toggleSort('status')">
                  <span class="inline-flex items-center">
                      {{ $t('tx.status') }}
                      <Icon :icon="getSortIcon('status')" class="ml-1" :class="{ 'opacity-30': !isSortActive('status') }" />
                  </span>
              </th>
              <th scope="col" class="cursor-pointer select-none th-hover w-[15%]" @click="toggleSort('gas')">
                  <span class="inline-flex items-center">
                      {{ $t('tx.gas') }}
                      <Icon :icon="getSortIcon('gas')" class="ml-1" :class="{ 'opacity-30': !isSortActive('gas') }" />
                  </span>
              </th>
              <th scope="col" class="cursor-pointer select-none th-hover w-[20%]" @click="toggleSort('creator')">
                  <span class="inline-flex items-center">
                      {{ $t('tx.creator') }}
                      <Icon :icon="getSortIcon('creator')" class="ml-1" :class="{ 'opacity-30': !isSortActive('creator') }" />
                  </span>
              </th>
              <th scope="col" class="cursor-pointer select-none th-hover w-[30%]" @click="toggleSort('hash')">
                  <span class="inline-flex items-center">
                      {{ $t('tx.tx_hash') }}
                      <Icon :icon="getSortIcon('hash')" class="ml-1" :class="{ 'opacity-30': !isSortActive('hash') }" />
                  </span>
              </th>
            </tr>
          </thead>
          <!-- Skeleton Loading for List -->
          <tbody v-if="loading">
              <tr v-for="i in 10" :key="i" class="border-b dark:border-gray-700/50 hover:bg-transparent">
                  <td><div class="h-4 bg-black rounded w-32" :style="{ opacity: (0.8 - (i-1)*0.07) }"></div></td>
                  <td><div class="h-4 bg-black rounded w-16" :style="{ opacity: (0.8 - (i-1)*0.07) }"></div></td>
                  <td><div class="h-4 bg-black rounded w-24" :style="{ opacity: (0.8 - (i-1)*0.07) }"></div></td>
                  <td><div class="h-4 bg-black rounded w-28" :style="{ opacity: (0.8 - (i-1)*0.07) }"></div></td>
                  <td><div class="h-4 bg-black rounded w-1/2" :style="{ opacity: (0.8 - (i-1)*0.07) }"></div></td>
              </tr>
          </tbody>
          <tbody class="text-sm" v-else @mouseleave="clearHovered">
            <tr v-for="item in filteredTxs" :key="item.hash" 
                class="hover:bg-gray-100 dark:hover:bg-[#384059] transition-colors duration-150 group"
                @mouseleave="clearHovered">
                
              <!-- HOVER STATE FOR FAILED TRANSACTIONS: Show Type + Error spanning all cols -->
              <template v-if="item.code !== undefined && item.code !== 0 && hoveredRow === item.hash">
                  <!-- Msg Type (Keep Visible) -->
                  <td class="truncate sticky left-0 z-10 bg-base-100 group-hover:bg-gray-100 dark:group-hover:bg-[#384059]">
                    <span v-if="item.tx" :title="item.displayMsg">
                       {{ item.displayMsg }}
                    </span>
                  </td>
                  <!-- Error Message Spanning Remaining 4 Columns -->
                  <td colspan="4" class="py-2 px-4 relative">
                      <div class="flex items-center h-full w-full text-error font-mono text-xs">
                          <span class="font-bold mr-2 whitespace-nowrap">{{ $t('tx.error') }}:</span> 
                          <span class="whitespace-normal break-all line-clamp-3 leading-tight flex-1">{{ item.raw_log }}</span>
                      </div>
                      <!-- Add a subtle border or background to highlight 'Error Mode' -->
                      <div class="absolute inset-y-0 left-0 w-1 bg-error/50"></div>
                  </td>
              </template>

              <!-- NORMAL STATE -->
              <template v-else>
                  <!-- Msg Type -->
                  <td class="truncate sticky left-0 z-10 bg-base-100 group-hover:bg-gray-100 dark:group-hover:bg-[#384059]">
                    <span v-if="item.tx" :title="item.displayMsg">
                        {{ item.displayMsg }}
                    </span>
                  </td>
                  <!-- Status (Hover Trigger) -->
                  <td @mouseenter="setHovered(item.hash)">
                      <span v-if="item.injected" class="badge badge-warning badge-sm">Injected</span>
                      <span v-else-if="item.code === 0" class="text-success flex items-center gap-1">
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10s10-4.5 10-10S17.5 2 12 2m-2 15l-5-5l1.41-1.41L10 14.17l7.59-7.59L19 8z"/></svg>
                          Success
                      </span>
                      <!-- Failed Status (Standard View) -->
                      <div v-else-if="item.code !== undefined" class="flex items-center">
                          <span class="text-error flex items-center gap-1">
                              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10s10-4.47 10-10S17.53 2 12 2m5 13.59L15.59 17L12 13.41L8.41 17L7 15.59L10.59 12L7 8.41L8.41 7L12 10.59L15.59 7L17 8.41L13.41 12z"/></svg>
                              {{ $t('tx.failed') }}
                          </span>
                      </div>
                      <span v-else class="text-gray-400">-</span>
                  </td>
                  <!-- Gas -->
                  <td>
                      <div v-if="item.gasUsed && item.gasWanted" class="text-xs">
                          <div><span class="font-bold">{{ format.formatNumber(Number(item.gasUsed)) }}</span> Used</div>
                          <div class="opacity-70">{{ format.formatNumber(Number(item.gasWanted)) }} Wanted</div>
                      </div>
                      <div v-else class="text-xs opacity-70">
                          {{ format.formatNumber(Number(item.gasLimit)) }} Limit
                      </div>
                  </td>
                  <!-- Creator -->
                  <td class="truncate">
                      <RouterLink v-if="item.sender" :to="`/${chain.chainName}/account/${item.sender}`" class="text-primary dark:invert font-mono">
                          {{ shortAddress(item.sender) }}
                      </RouterLink>
                      <span v-else>-</span>
                  </td>
                  <!-- Hash -->
                  <td class="truncate">
                    <span v-if="item.injected">{{ item.hash }}</span>
                    <RouterLink v-else :to="`/${chain.chainName}/tx/${item.hash}`" class="text-primary dark:invert font-mono">
                      {{ item.hash }}
                    </RouterLink>
                  </td>
              </template>
            </tr>
          </tbody>
        </table>
        <div v-if="!loading && filteredTxs.length === 0" class="text-center py-4 text-gray-500">
            {{ activeFilter.msgTypes.length > 0 || activeFilter.creators.length > 0 ? $t('tx.no_filter_match') : $t('account.no_transactions') }}
        </div>
    </div>

  </div>
</template>

<style scoped>
.custom-table :where(th, td) {
    padding: 8px 16px; /* more padding from validator style, slightly adjusted for readability */
    background: transparent;
}
.custom-table th.sticky {
    background: hsl(var(--b2)); /* Use base-200 for headers */
}

/* Header Hover Effect matching validator/index.vue */
.bg-base-200 tr {
    background: hsl(var(--b2));
}

.th-hover {
    transition: background-color 0.15s ease-in-out, color 0.15s ease-in-out;
}
.th-hover:hover {
    background-color: hsl(var(--b3));
    color: #ffffff;
}
</style>
