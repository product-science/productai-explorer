<script setup lang="ts">
import {
  useBlockchain,
  useFormatter,
  useStakingStore,
} from '@/stores';
import { onMounted, computed, ref } from 'vue';
import { Icon } from '@iconify/vue';
import {
  consensusPubkeyToHexAddress,
  operatorAddressToAccount,
  pubKeyToValcons,
} from '@/libs';
import { type PaginatedTxs, type Validator } from '@/types';

const props = defineProps(['validator', 'chain']);

const staking = useStakingStore();
const blockchain = useBlockchain();
const format = useFormatter();

const validator: string = props.validator;

const v = ref({} as Validator);
const addresses = ref(
  {} as {
    account: string;
    operAddress: string;
    hex: string;
    valCons: string;
  }
);

addresses.value.account = operatorAddressToAccount(validator);

const txs = ref({} as PaginatedTxs);

blockchain.rpc.getTxsBySender(addresses.value.account).then((x) => {
  txs.value = x;
});

onMounted(() => {
  if (validator) {
    staking.fetchValidator(validator).then((res) => {
      v.value = res.validator;

      addresses.value.hex = consensusPubkeyToHexAddress(
        v.value.consensus_pubkey
      );
      addresses.value.valCons = pubKeyToValcons(
        v.value.consensus_pubkey,
        blockchain.current?.bech32ConsensusPrefix || "",
      );
    });
  }
});

let showCopyToast = ref(0);
const copyWebsite = async (url: string) => {
  if (!url) {
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    showCopyToast.value = 1;
    setTimeout(() => {
      showCopyToast.value = 0;
    }, 1000);
  } catch (err) {
    showCopyToast.value = 2;
    setTimeout(() => {
      showCopyToast.value = 0;
    }, 1000);
  }
};

const tipMsg = computed(() => {
  return showCopyToast.value === 2
    ? { class: 'error', msg: 'Copy Error!' }
    : { class: 'success', msg: 'Copy Success!' };
});

</script>

<template>
  <div>
    <div class="mt-3 grid grid-cols-1 md:!grid-cols-1 gap-4">
      <div class="bg-base-100 rounded shadow overflow-x-auto">
        <div class="px-4 pt-4 mb-2 text-main font-lg font-semibold">
          {{ $t('validator.addresses') }}
        </div>
        <div class="px-4 pb-4">
          <div class="mb-3">
            <div class="text-sm flex">{{ $t('validator.account_addr') }} 
              <Icon
                  icon="mdi:content-copy"
                  class="ml-2 cursor-pointer"
                  v-show="addresses.account"
                  @click="copyWebsite(addresses.account || '')"
                />
              </div>
            <RouterLink
              class="text-xs text-primary"
              :to="`/${chain}/account/${addresses.account}`"
            >
              {{ addresses.account }}
            </RouterLink>
          </div>
          <div class="mb-3">
            <div class="text-sm flex">{{ $t('validator.operator_addr') }}
              <Icon
                  icon="mdi:content-copy"
                  class="ml-2 cursor-pointer"
                  v-show="v.operator_address"
                  @click="copyWebsite(v.operator_address || '')"
                /></div>
            <div class="text-xs">
              {{ v.operator_address }}
            </div>
          </div>
          <div class="mb-3">
            <div class="text-sm flex">{{ $t('validator.hex_addr') }}
              <Icon
                  icon="mdi:content-copy"
                  class="ml-2 cursor-pointer"
                  v-show="addresses.hex"
                  @click="copyWebsite(addresses.hex || '')"
                />
              </div>
            <div class="text-xs">{{ addresses.hex }}</div>
          </div>
          <div class="mb-3">
            <div class="text-sm flex">{{ $t('validator.signer_addr') }}
              <Icon
                  icon="mdi:content-copy"
                  class="ml-2 cursor-pointer"
                  v-show="addresses.valCons"
                  @click="copyWebsite(addresses.valCons || '')"
                />
              </div>
            <div class="text-xs">{{ addresses.valCons }}</div>
          </div>
          <div>
            <div class="text-sm flex">{{ $t('validator.consensus_pub_key') }}
              <Icon
                  icon="mdi:content-copy"
                  class="ml-2 cursor-pointer"
                  v-show="v.consensus_pubkey"
                  @click="copyWebsite(JSON.stringify(v.consensus_pubkey) || '')"
                />
              </div>
            <div class="text-xs">{{ v.consensus_pubkey }}</div>
          </div>
        </div>
      </div>
    </div>

    <div class="mt-5 bg-base-100 shadow rounded p-4">
      <div class="text-lg mb-4 font-semibold">{{ $t('account.transactions') }}</div>
      <div class="rounded overflow-auto">
        <table class="table validatore-table w-full">
          <thead>
            <th class="text-left pl-4" style="position: relative; z-index: 2">
              {{ $t('account.height') }}
            </th>
            <th class="text-left pl-4">{{ $t('account.hash') }}</th>
            <th class="text-left pl-4" width="40%">{{ $t('account.messages') }}</th>
            <th class="text-left pl-4">{{ $t('account.time') }}</th>
          </thead>
          <tbody>
            <tr v-for="(item, i) in txs.tx_responses">
              <td class="text-sm text-primary">
                <RouterLink :to="`/${props.chain}/block/${item.height}`">{{
                  item.height
                }}</RouterLink>
              </td>
              <td class="truncate text-primary" style="max-width: 200px">
                <RouterLink :to="`/${props.chain}/tx/${item.txhash}`">
                  {{ item.txhash }}
                </RouterLink>
              </td>
              <td>
                <div class="flex items-center">
                  <span class="mr-2">{{
                    format.messages(item.tx.body.messages)
                  }}</span>
                  <Icon
                    v-if="item.code === 0"
                    icon="mdi-check"
                    class="text-yes"
                  />
                  <Icon v-else icon="mdi-multiply" class="text-no" />
                </div>
              </td>
              <td width="150">{{ format.toDay(item.timestamp, 'from') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <!-- end -->
    <div class="toast" v-show="showCopyToast === 1">
      <div class="alert alert-success">
        <div class="text-xs md:!text-sm">
          <span>{{ tipMsg.msg }}</span>
        </div>
      </div>
    </div>
    <div class="toast" v-show="showCopyToast === 2">
      <div class="alert alert-error">
        <div class="text-xs md:!text-sm">
          <span>{{ tipMsg.msg }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
.validatore-table.table :where(th, td) {
  padding: 0.6rem 1rem;
  font-size: 14px;
}
</style>
