<script lang="ts" setup>
import { computed } from '@vue/reactivity';
import MdEditor from 'md-editor-v3';
import ObjectElement from '@/components/dynamic/ObjectElement.vue';
import {
  useBaseStore,
  useBlockchain,
  useFormatter,
  useGovStore,
  useStakingStore,
  useTxDialog,
  useValidatorStore,
} from '@/stores';
import {
  PageRequest,
  type GovProposal,
  type GovVote,
  type PaginatedProposalDeposit,
  type Pagination,
} from '@/types';
import { ref, reactive } from 'vue';
import Countdown from '@/components/Countdown.vue';
import PaginationBar from '@/components/PaginationBar.vue';
import { fromBech32, toHex } from '@cosmjs/encoding';


const props = defineProps(['proposal_id', 'chain']);
const proposal = ref({} as GovProposal);
const format = useFormatter();
const store = useGovStore();
const dialog = useTxDialog();
const stakingStore = useStakingStore();
const chainStore = useBlockchain();
const validatorStore = useValidatorStore();

store.fetchProposal(props.proposal_id).then((res) => {
  let proposalDetail = reactive(res.proposal);
  // when status under the voting, final_tally_result are no data, should request fetchTally
  if (res.proposal?.status === 'PROPOSAL_STATUS_VOTING_PERIOD') {
    store.fetchTally(props.proposal_id).then((tallRes) => {
      proposalDetail.final_tally_result = tallRes?.tally;
    });
    // Ensure validator store is initialized so active participants and validators are available
    validatorStore.init();
  }
  proposal.value = proposalDetail;
  // load origin params if the proposal is param change
  if(proposalDetail.content?.changes) {
    proposalDetail.content?.changes.forEach((item) => {  
        chainStore.rpc.getParams(item.subspace, item.key).then((res) => {
          if(proposal.value.content && res.param) {
            if(proposal.value.content.current){
              proposal.value.content.current.push(res.param);
            } else {
              proposal.value.content.current = [res.param];
            };
          }
        })
    })
  }

  const msgType = proposalDetail.content?.['@type'] || '';
  if(msgType.endsWith('MsgUpdateParams')) {
    if(msgType.indexOf('staking') > -1) {
      chainStore.rpc.getStakingParams().then((res) => {
        addCurrentParams(res);
      });
    } else if(msgType.indexOf('gov') > -1) {
      chainStore.rpc.getGovParamsVoting().then((res) => {
        addCurrentParams(res);
      });
    } else if(msgType.indexOf('distribution') > -1) {
      chainStore.rpc.getDistributionParams().then((res) => {
        addCurrentParams(res);
      });
    } else if(msgType.indexOf('slashing') > -1) {
      chainStore.rpc.getSlashingParams().then((res) => {
        addCurrentParams(res);
      });
    }
  }
});

function addCurrentParams(res: any) {
  if(proposal.value.content && res.params) {
    proposal.value.content.params = [proposal.value.content?.params];
    proposal.value.content.current = [res.params];
  }
}
const color = computed(() => {
  if (proposal.value.status === 'PROPOSAL_STATUS_PASSED') {
    return 'success';
  } else if (proposal.value.status === 'PROPOSAL_STATUS_REJECTED') {
    return 'error';
  }
  return '';
});
const status = computed(() => {
  if (proposal.value.status) {
    return proposal.value.status.replace('PROPOSAL_STATUS_', '');
  }
  return '';
});

const isFinalized = computed(() => {
  const s = proposal.value.status || '';
  return s === 'PROPOSAL_STATUS_PASSED' || s === 'PROPOSAL_STATUS_REJECTED';
});

const deposit = ref({} as PaginatedProposalDeposit);
store.fetchProposalDeposits(props.proposal_id).then((x) => (deposit.value = x));

const votes = ref({} as GovVote[]);
const allVotes = ref<GovVote[] | null>(null);
const matchedVoters = ref<Set<string> | null>(null);
const matchedIndices = ref<number[] | null>(null);
const currentMatchIndex = ref<number | null>(null);
const allVotesLoading = ref(false);
const searchQuery = ref('');
const searchError = ref('');
const highlightedVoter = ref<string | null>(null);

const pageRequest = ref(new PageRequest());
const pageResponse = ref({} as Pagination);
const currentPage = ref(1);

// Ensure default page size is 20
pageRequest.value.setPageSize(20);
pageRequest.value.setPage(1);

store.fetchProposalVotes(props.proposal_id, pageRequest.value).then((x) => {
  votes.value = x.votes;
  pageResponse.value = x.pagination;
});

function shortTime(v: string) {
  if (v) {
    return format.toDay(v, 'from');
  }
  return '';
}

const votingCountdown = computed((): number => {
  const now = new Date();
  const end = new Date(proposal.value.voting_end_time);
  return end.getTime() - now.getTime();
});

const upgradeCountdown = computed((): number => {
  const height = Number(proposal.value.content?.plan?.height || 0);
  if (height > 0) {
    const base = useBaseStore();
    const current = Number(base.latest?.block?.header?.height || 0);
    return (height - current) * Number((base.blocktime / 1000).toFixed()) * 1000;
  }
  const now = new Date();
  const end = new Date(proposal.value.content?.plan?.time || '');
  return end.getTime() - now.getTime();
});

const total = computed(() => {
  const tally = proposal.value.final_tally_result;
  let sum = 0;
  if (tally) {
    sum += Number(tally.abstain || 0);
    sum += Number(tally.yes || 0);
    sum += Number(tally.no || 0);
    sum += Number(tally.no_with_veto || 0);
  }
  console.log('total', sum);
  return sum;
});

// Denominator: during voting -> sum(staking tokens of active participants); after finalized -> sum of tally
const denominator = computed<number>(() => {
  const status = proposal.value.status || '';
  if (status === 'PROPOSAL_STATUS_VOTING_PERIOD') {
    return Number(validatorStore.activeStakingTotal || 0);
  }
  return total.value || 0;
});

const turnout = computed(() => {
  const denom = denominator.value;
  if (denom > 0) {
    return format.percent(total.value / denom);
  }
  return 0;
});

const yes = computed(() => {
  const denom = denominator.value;
  if (denom > 0) {
    const yes = Number(proposal.value?.final_tally_result?.yes || 0);
    return format.percent(yes / denom);
  }
  return 0;
});

const no = computed(() => {
  const denom = denominator.value;
  if (denom > 0) {
    const value = Number(proposal.value?.final_tally_result?.no || 0);
    return format.percent(value / denom);
  }
  return 0;
});

const veto = computed(() => {
  const denom = denominator.value;
  if (denom > 0) {
    const value = Number(proposal.value?.final_tally_result?.no_with_veto || 0);
    return format.percent(value / denom);
  }
  return 0;
});

const abstain = computed(() => {
  const denom = denominator.value;
  if (denom > 0) {
    const value = Number(proposal.value?.final_tally_result?.abstain || 0);
    return format.percent(value / denom);
  }
  return 0;
});
const processList = computed(() => {
  const list = [
    { name: 'Yes', value: yes.value, class: 'bg-success' },
    { name: 'No', value: no.value, class: 'bg-error' },
    { name: 'No With Veto', value: veto.value, class: 'bg-red-800' },
    { name: 'Abstain', value: abstain.value, class: 'bg-warning' },
  ];
  if (!isFinalized.value) {
    list.unshift({ name: 'Turnout', value: turnout.value, class: 'bg-info' });
  }
  return list;
});

function showValidatorName(voter: string) {
  try {
      const { data } = fromBech32(voter);
      const hex = toHex(data);
      const v = stakingStore.validators.find(
        (x) => toHex(fromBech32(x.operator_address).data) === hex
      );
      return v ? v.description.moniker : voter;
  } catch(e){
      return voter;
  }
}

function pageload(p: number) {
  currentPage.value = p;
  pageRequest.value.setPage(p);
  store.fetchProposalVotes(props.proposal_id, pageRequest.value).then((x) => {
    votes.value = x.votes;
    pageResponse.value = x.pagination;
  });
}

async function fetchAllVotes() {
  if (allVotesLoading.value || allVotes.value) return;
  allVotesLoading.value = true;
  try {
    const fullPage = new PageRequest();
    fullPage.setPageSize(100);
    fullPage.setPage(1);
    fullPage.count_total = true;

    let aggregated: GovVote[] = [];
    const first = await store.fetchProposalVotes(props.proposal_id, fullPage);
    aggregated = aggregated.concat(first.votes || []);
    const total = Number(first.pagination.total || aggregated.length);
    let fetched = aggregated.length;

    while (fetched < total) {
      fullPage.offset = fetched;
      fullPage.count_total = false;
      const res = await store.fetchProposalVotes(props.proposal_id, fullPage);
      const batch = res.votes || [];
      if (!batch.length) break;
      aggregated = aggregated.concat(batch);
      fetched = aggregated.length;
    }

    allVotes.value = aggregated;
  } finally {
    allVotesLoading.value = false;
  }
}

async function performSearch() {
  searchError.value = '';
  highlightedVoter.value = null;
  matchedVoters.value = null;
  matchedIndices.value = null;
  currentMatchIndex.value = null;

  const q = searchQuery.value.trim();
  if (!q) return;

  // Make sure validator store is initialized so mappings are available
  if (!validatorStore.initialized) {
    await validatorStore.init();
  }

  await fetchAllVotes();
  const list = allVotes.value || [];
  if (!list.length) {
    searchError.value = 'No votes loaded yet.';
    return;
  }

  const lower = q.toLowerCase();
  const accountToOperator = validatorStore.accountToOperatorMap;
  const participantsTotals = validatorStore.participantsTotalsByOperator;
  const validators = stakingStore.validators || [];

  const indices: number[] = [];

  list.forEach((vote, idx) => {
    const voter = vote.voter || '';
    const items: string[] = [voter.toLowerCase()];

    const op = accountToOperator[voter];
    if (op) {
      items.push(op.toLowerCase());
      const totals = participantsTotals[op];
      if (totals?.account_address) {
        items.push(totals.account_address.toLowerCase());
      }

      const validator = validators.find((v) => v.operator_address === op);
      const moniker = validator?.description?.moniker;
      if (moniker) {
        items.push(moniker.toLowerCase());
      }
    }

    if (items.some((s) => s.includes(lower))) {
      indices.push(idx);
    }
  });

  if (!indices.length) {
    searchError.value = 'No matching voter found.';
    return;
  }

  matchedIndices.value = indices;
  matchedVoters.value = new Set(indices.map((i) => list[i].voter));

  const perPage = pageRequest.value.limit || 20;

  // Helper to go to a specific match by its index in matchedIndices
  const goToMatchAt = (matchPos: number) => {
    if (!matchedIndices.value || !matchedIndices.value.length) return;
    const clampedPos = Math.min(Math.max(0, matchPos), matchedIndices.value.length - 1);
    const globalIndex = matchedIndices.value[clampedPos];
    const vote = list[globalIndex];
    const page = Math.floor(globalIndex / perPage) + 1;
    currentMatchIndex.value = clampedPos;
    highlightedVoter.value = vote.voter;
    pageload(page);
  };

  // Always go to the first match initially
  goToMatchAt(0);
}

function gotoNextMatch() {
  if (!matchedIndices.value || !matchedIndices.value.length) return;
  const list = allVotes.value || [];
  const perPage = pageRequest.value.limit || 20;
  const current = currentMatchIndex.value ?? 0;
  const next = (current + 1) % matchedIndices.value.length;
  const globalIndex = matchedIndices.value[next];
  const vote = list[globalIndex];
  const page = Math.floor(globalIndex / perPage) + 1;
  currentMatchIndex.value = next;
  highlightedVoter.value = vote.voter;
  pageload(page);
}

function gotoPrevMatch() {
  if (!matchedIndices.value || !matchedIndices.value.length) return;
  const list = allVotes.value || [];
  const perPage = pageRequest.value.limit || 20;
  const len = matchedIndices.value.length;
  const current = currentMatchIndex.value ?? 0;
  const prev = (current - 1 + len) % len;
  const globalIndex = matchedIndices.value[prev];
  const vote = list[globalIndex];
  const page = Math.floor(globalIndex / perPage) + 1;
  currentMatchIndex.value = prev;
  highlightedVoter.value = vote.voter;
  pageload(page);
}

function resetSearch() {
  searchQuery.value = '';
  searchError.value = '';
  highlightedVoter.value = null;
  matchedVoters.value = null;
  matchedIndices.value = null;
  currentMatchIndex.value = null;
}

function rowClass(item: GovVote, _localIndex: number) {
  const isMatched =
    matchedVoters.value !== null && matchedVoters.value.has(item.voter);

  return {
    '!bg-primary !text-white': isMatched,
  };
}

function metaItem(metadata: string|undefined): { title: string; summary: string } {
  if (!metadata) {
    return { title: '', summary: '' }
  } else if (metadata.startsWith('{') && metadata.endsWith('}')) {
    return JSON.parse(metadata)
  }
  return { title: metadata, summary: '' }
}
</script>

<template>
  <div>
    <div class="bg-base-100 px-4 pt-3 pb-4 rounded mb-4 shadow">
      <h2 class="card-title flex flex-col md:!justify-between md:!flex-row mb-2">
        <p class="truncate w-full">
          {{ proposal_id }}. {{ proposal.title || proposal.content?.title || metaItem(proposal?.metadata)?.title  }}
        </p>
        <div
          class="badge badge-ghost"
          :class="
            color === 'success'
              ? 'text-yes'
              : color === 'error'
              ? 'text-no'
              : 'text-info'
          "
        >
          {{ status }}
        </div>
      </h2>
      <div class="">
        <ObjectElement :value="proposal.content" />
      </div>
      <div v-if="proposal.summary && !proposal.content?.description || metaItem(proposal?.metadata)?.summary ">
        <MdEditor
          :model-value="format.multiLine(proposal.summary || metaItem(proposal?.metadata)?.summary)"
          previewOnly
          class="md-editor-recover"
        ></MdEditor>
      </div>
    </div>
    <!-- grid lg:!!grid-cols-3 auto-rows-max-->
    <!-- flex-col lg:!!flex-row flex -->
    <div class="gap-4 mb-4 grid lg:!!grid-cols-3 auto-rows-max">
      <!-- flex-1 -->
      <div class="bg-base-100 px-4 pt-3 pb-4 rounded shadow">
        <h2 class="card-title mb-1">{{ $t('gov.tally') }}</h2>
        <div class="mb-1" v-for="(item, index) of processList" :key="index">
          <label class="block text-sm mb-1">{{ item.name }}</label>
          <div class="h-5 w-full relative">
            <div
              class="absolute inset-x-0 inset-y-0 w-full opacity-10 rounded-sm"
              :class="`${item.class}`"
            ></div>
            <div
              class="absolute inset-x-0 inset-y-0 rounded-sm"
              :class="`${item.class}`"
              :style="`width: ${
                item.value === '-' || item.value === 'NaN%' ? '0%' : item.value
              }`"
            ></div>
            <p
              class="absolute inset-x-0 inset-y-0 text-center text-sm text-[#666] dark:text-[#eee] flex items-center justify-center"
            >
              {{ item.value }}
            </p>
          </div>
        </div>
        <div class="mt-6 grid grid-cols-2">
          <label
            for="vote"
            class="btn btn-primary float-right btn-sm mx-1"
            @click="dialog.open('vote', { proposal_id })"
            >{{ $t('gov.btn_vote') }}</label
          >
          <label
            for="deposit"
            class="btn btn-primary float-right btn-sm mx-1"
            @click="dialog.open('deposit', { proposal_id })"
            >{{ $t('gov.btn_deposit') }}</label
          >
        </div>
      </div>

      <div class="bg-base-100 px-4 pt-3 pb-5 rounded shadow lg:!!col-span-2">
        <h2 class="card-title">{{ $t('gov.timeline') }}</h2>

        <div class="px-1">
          <div class="flex items-center mb-4 mt-2">
            <div class="w-2 h-2 rounded-full bg-error mr-3"></div>
            <div class="text-base flex-1 text-main">
              {{ $t('gov.submit_at') }}: {{ format.toDay(proposal.submit_time) }}
            </div>
            <div class="text-sm">{{ shortTime(proposal.submit_time) }}</div>
          </div>
          <div class="flex items-center mb-4">
            <div class="w-2 h-2 rounded-full bg-primary mr-3"></div>
            <div class="text-base flex-1 text-main">
              {{ $t('gov.deposited_at') }}:
              {{
                format.toDay(
                  proposal.status === 'PROPOSAL_STATUS_DEPOSIT_PERIOD'
                    ? proposal.deposit_end_time
                    : proposal.voting_start_time
                )
              }}
            </div>
            <div class="text-sm">
              {{
                shortTime(
                  proposal.status === 'PROPOSAL_STATUS_DEPOSIT_PERIOD'
                    ? proposal.deposit_end_time
                    : proposal.voting_start_time
                )
              }}
            </div>
          </div>
          <div class="mb-4">
            <div class="flex items-center">
              <div class="w-2 h-2 rounded-full bg-yes mr-3"></div>
              <div class="text-base flex-1 text-main">
                {{ $t('gov.vote_start_from') }} {{ format.toDay(proposal.voting_start_time) }}
              </div>
              <div class="text-sm">
                {{ shortTime(proposal.voting_start_time) }}
              </div>
            </div>
            <div class="pl-5 text-sm mt-2">
              <Countdown :time="votingCountdown" />
            </div>
          </div>
          <div>
            <div class="flex items-center mb-1">
              <div class="w-2 h-2 rounded-full bg-success mr-3"></div>
              <div class="text-base flex-1 text-main">
                {{ $t('gov.vote_end') }} {{ format.toDay(proposal.voting_end_time) }}
              </div>
              <div class="text-sm">
                {{ shortTime(proposal.voting_end_time) }}
              </div>
            </div>
            <div class="pl-5 text-sm">
              {{ $t('gov.current_status') }}: {{ $t(`gov.proposal_statuses.${proposal.status}`) }}
            </div>
          </div>

          <div
            class="mt-4"
            v-if="
              proposal?.content?.['@type']?.endsWith('SoftwareUpgradeProposal')
            "
          >
            <div class="flex items-center">
              <div class="w-2 h-2 rounded-full bg-warning mr-3"></div>
              <div class="text-base flex-1 text-main">
                {{ $t('gov.upgrade_plan') }}:
                <span v-if="Number(proposal.content?.plan?.height || '0') > 0">
                  (EST)</span
                >
                <span v-else>{{
                  format.toDay(proposal.content?.plan?.time)
                }}</span>
              </div>
              <div class="text-sm">
                {{ shortTime(proposal.voting_end_time) }}
              </div>
            </div>
            <div class="pl-5 text-sm mt-2">
              <Countdown :time="upgradeCountdown" />
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="bg-base-100 px-4 pt-3 pb-4 rounded mb-4 shadow" v-if="!isFinalized">
      <h2 class="card-title">{{ $t('gov.votes') }}</h2>
      <div>
        <!-- Search + actions -->
        <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-2 mb-3">
          <div class="flex-1 flex gap-2">
            <input
              v-model="searchQuery"
              type="text"
              class="input input-bordered input-sm w-full"
              placeholder="Search by gonka address, dev address, or meta name"
              @keyup.enter="performSearch"
            />
            <button
              class="btn btn-sm btn-primary"
              :disabled="!searchQuery.trim()"
              @click="performSearch"
            >
              Search
            </button>
          </div>
          <div class="flex items-center gap-2 mt-1 md:mt-0 md:ml-2 text-xs">
            <template v-if="matchedIndices && matchedIndices.length">
              <span>
                {{ (currentMatchIndex ?? 0) + 1 }} / {{ matchedIndices.length }} matches
              </span>
              <button class="btn btn-ghost btn-xs" @click="gotoPrevMatch">
                ‹
              </button>
              <button class="btn btn-ghost btn-xs" @click="gotoNextMatch">
                ›
              </button>
            </template>
            <button
              v-if="searchQuery || matchedVoters"
              class="btn btn-outline btn-xs"
              @click="resetSearch"
            >
              Reset
            </button>
            <span v-if="searchError" class="text-error">
              {{ searchError }}
            </span>
          </div>
        </div>

        <div class="overflow-x-auto">
          <table class="table w-full table-zebra">
            <tbody>
              <tr
                v-for="(item, index) of votes"
                :key="index"
                :class="rowClass(item, index)"
              >
                <td class="py-2 text-sm">{{ showValidatorName(item.voter) }}</td>
                <td
                  v-if="item.option && item.option !== 'VOTE_OPTION_UNSPECIFIED'"
                  class="py-2 text-sm"
                  :class="{
                    'text-yes': item.option === 'VOTE_OPTION_YES',
                    'text-gray-400': item.option === 'VOTE_OPTION_ABSTAIN',
                  }"
                >
                  {{ String(item.option).replace('VOTE_OPTION_', '') }}
                </td>
                <td
                  v-if="item.options"
                  class="py-2 text-sm"
                >
                  {{ item.options.map(x => `${x.option.replace('VOTE_OPTION_', '')}:${format.percent(x.weight)}`).join(', ') }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <PaginationBar
          :limit="pageRequest.limit"
          :total="pageResponse.total"
          :callback="pageload"
          :page="currentPage"
        />
      </div>
    </div>
  </div>
</template>
