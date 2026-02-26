<script setup lang="ts">
import {
  useBlockchain,
  useFormatter,
  useStakingStore,
  useValidatorStore,
} from '@/stores';
import { onMounted, computed, ref } from 'vue';
import { Icon } from '@iconify/vue';
import {
  consensusPubkeyToHexAddress,
  operatorAddressToAccount,
  pubKeyToValcons,
} from '@/libs';
import type { PaginatedTxs, Validator } from '@/types';

const props = defineProps(['validator', 'chain']);

const staking = useStakingStore();
const validatorStore = useValidatorStore();
const blockchain = useBlockchain();
const format = useFormatter();

const validator: string = props.validator;

const v = ref({} as Validator);
const chain = props.chain as string;
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

// Identity and avatar utilities
const identity = computed(() => String(v.value?.description?.identity || ''));
const avatars = computed<Record<string, string>>(() => validatorStore.avatars || {});
function logo(keySuffix?: string): string {
  if (!keySuffix) return '';
  return validatorStore.getAvatarUrl(keySuffix) || '';
}
function loadAvatar(keySuffix?: string) {
  if (keySuffix) validatorStore.fetchAvatar(keySuffix);
}

let showCopyToast = ref(0);
const copyAddress = async (url: string) => {
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
    // Using old execCommand copy method, works even on non-secure dashboards
    try {
      const textarea = document.createElement('textarea');
      textarea.value = url;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'absolute';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      const successful = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (successful) {
        showCopyToast.value = 1;
      } else {
        showCopyToast.value = 2;
      }
    } catch (e) {
      showCopyToast.value = 2;
    }
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
    <div class="mt-3 grid grid-cols-1 md:!grid-cols-2 gap-4">
      <div class="bg-base-100 px-4 pt-3 pb-4 rounded shadow border-indigo-500">
        <div class="flex flex-col lg:!flex-row pt-2 pb-1">
          <div class="flex-1">
            <div class="flex">
              <div class="avatar mr-4 relative w-24 rounded-lg overflow-hidden">
                <div class="w-24 rounded-lg absolute opacity-10"></div>
                <div class="w-24 rounded-lg">
                  <img
                    v-if="identity && avatars[identity] !== 'undefined'"
                    v-lazy="logo(identity)"
                    class="object-contain"
                    @error="
                      (e) => {
                        loadAvatar(identity);
                      }
                    "
                  />
                  <Icon v-else class="text-8xl" :icon="`mdi-help-circle-outline`" />
                </div>
              </div>
              <div class="mx-2">
                <h4>{{ v.description?.moniker }}</h4>
                <div class="text-sm mb-4">
                  {{ v.description?.identity || '-' }}
                </div>
              </div>
            </div>
            <div class="mt-4 text-sm">
              <p class="text-sm mb-3 font-medium">{{ $t('validator.about_us') }}</p>
              <div class="card-list">
                <div class="flex items-center mb-2">
                  <Icon icon="mdi-web" class="text-xl mr-1" />
                  <span class="font-bold mr-2"
                    >{{ $t('validator.website') }}:
                  </span>
                  <a
                    :href="v?.description?.website || '#'"
                    :class="v?.description?.website ? 'cursor-pointer' : 'cursor-default'"
                  >
                    {{ v.description?.website || '-' }}
                  </a>
                </div>
                <div class="flex items-center">
                  <Icon icon="mdi-email-outline" class="text-xl mr-1" />
                  <span class="font-bold mr-2"
                    >{{ $t('validator.contact') }}:
                  </span>
                  <a
                    v-if="v.description?.security_contact"
                    :href="'mailto:' + v.description.security_contact || '#'"
                    class="cursor-pointer"
                  >
                    {{ v.description?.security_contact || '-' }}
                  </a>
                </div>
              </div>
              <p class="text-sm mt-4 mb-3 font-medium">
                {{ $t('validator.validator_status') }}
              </p>
              <div class="card-list">
                <div class="flex items-center mb-2">
                  <Icon icon="mdi-shield-account-outline" class="text-xl mr-1" />
                  <span class="font-bold mr-2">{{ $t('validator.status') }}: </span
                  ><span>
                    {{ String(v.status).replace('BOND_STATUS_', '') }}
                  </span>
                </div>
                <div class="flex items-center">
                  <Icon icon="mdi-shield-alert-outline" class="text-xl mr-1" />
                  <span class="font-bold mr-2">{{ $t('validator.jailed') }}: </span>
                  <span> {{ v.jailed || '-' }} </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
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
                  @click="copyAddress(addresses.account || '')"
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
                  @click="copyAddress(v.operator_address || '')"
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
                  @click="copyAddress(addresses.hex || '')"
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
                  @click="copyAddress(addresses.valCons || '')"
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
                  @click="copyAddress(JSON.stringify(v.consensus_pubkey) || '')"
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
