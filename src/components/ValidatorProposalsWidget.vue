<script lang="ts" setup>
import { Icon } from '@iconify/vue';
import { useBlockchain, useFormatter, useGovStore, useTxDialog, useValidatorStore } from '@/stores';
import type { GovProposal, Tally } from '@/types/gov';
import {
  formatProposalType,
  proposalHasMultipleMessages,
  proposalPrimaryMsgType,
} from '@/libs/utils';
import { computed, onMounted, ref, watch } from 'vue';

/** Voting, passed, rejected, failed — union then 5 latest by id */
const GOV_WIDGET_STATUSES = ['2', '3', '4', '5'] as const;
const GOV_ACTIVE_STATUS = '2' as const;

type WidgetMode = 'latest' | 'active';
const props = withDefaults(defineProps<{ mode?: WidgetMode }>(), {
  mode: 'active',
});

const govStore = useGovStore();
const chain = useBlockchain();
const format = useFormatter();
const dialog = useTxDialog();
const validatorStore = useValidatorStore();

const carouselIndex = ref(0);
const initialFetchDone = ref(false);
const quorum = ref(0);

const statusMap: Record<string, string> = {
  PROPOSAL_STATUS_VOTING_PERIOD: 'VOTING',
  PROPOSAL_STATUS_PASSED: 'PASSED',
  PROPOSAL_STATUS_REJECTED: 'REJECTED',
  PROPOSAL_STATUS_FAILED: 'FAILED',
};

function cardVariantClass(status: string): string {
  switch (status) {
    case 'PROPOSAL_STATUS_PASSED':
      return 'proposal-card--passed';
    case 'PROPOSAL_STATUS_REJECTED':
    case 'PROPOSAL_STATUS_FAILED':
      return 'proposal-card--rejected';
    default:
      return 'proposal-card--voting';
  }
}

function statusInnerIcon(status: string): string {
  switch (status) {
    case 'PROPOSAL_STATUS_PASSED':
      return 'mdi:check';
    case 'PROPOSAL_STATUS_REJECTED':
    case 'PROPOSAL_STATUS_FAILED':
      return 'mdi:close';
    default:
      return 'mdi:timer-sand';
  }
}

function statusInnerIconClass(status: string): string {
  switch (status) {
    case 'PROPOSAL_STATUS_PASSED':
      return 'text-emerald-300';
    case 'PROPOSAL_STATUS_REJECTED':
    case 'PROPOSAL_STATUS_FAILED':
      return 'text-red-300';
    default:
      return 'text-violet-200';
  }
}

function statusPillClass(status: string): string {
  switch (status) {
    case 'PROPOSAL_STATUS_PASSED':
      return 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
    case 'PROPOSAL_STATUS_REJECTED':
    case 'PROPOSAL_STATUS_FAILED':
      return 'bg-red-500/20 text-red-300 border border-red-500/30';
    default:
      return 'bg-violet-500/20 text-violet-200 border border-violet-500/25';
  }
}

function metaItem(metadata: string | undefined): { title: string; summary: string } {
  if (!metadata) return { title: '', summary: '' };
  try {
    return JSON.parse(metadata);
  } catch {
    return { title: '', summary: '' };
  }
}

function proposalTitle(p: GovProposal): string {
  return p.content?.title || p.title || metaItem(p.metadata).title || '';
}

function proposalSummary(p: GovProposal): string {
  return p.summary || p.content?.description || metaItem(p.metadata).summary || '';
}

const latestProposals = computed(() => {
  const map = new Map<string, GovProposal>();
  for (const st of GOV_WIDGET_STATUSES) {
    for (const p of govStore.proposals[st]?.proposals || []) {
      map.set(p.proposal_id, p);
    }
  }
  return [...map.values()]
    .sort((a, b) => Number(b.proposal_id) - Number(a.proposal_id))
    .slice(0, 5);
});

const activeProposals = computed(() =>
  [...(govStore.proposals[GOV_ACTIVE_STATUS]?.proposals || [])]
    .sort((a, b) => Number(b.proposal_id) - Number(a.proposal_id))
);

const visibleProposals = computed(() =>
  props.mode === 'active' ? activeProposals.value : latestProposals.value
);

const isLoading = computed(() => !initialFetchDone.value);
const isEmpty = computed(() => initialFetchDone.value && visibleProposals.value.length === 0);
const showCarousel = computed(() => !isLoading.value && visibleProposals.value.length > 0);
const titleKey = computed(() => {
  if (isLoading.value) {
    return props.mode === 'active'
      ? 'validator.proposals_widget.checking_active'
      : 'validator.proposals_widget.loading_proposals';
  }
  if (props.mode === 'active' && isEmpty.value) return 'validator.proposals_widget.no_active_title';
  return props.mode === 'active'
    ? 'validator.proposals_widget.active_title'
    : 'validator.proposals_widget.title';
});

function voteSplit(tally: Tally | undefined) {
  const empty = [
    { key: 'yes', label: 'Yes', pct: 0, class: 'text-emerald-400' },
    { key: 'no', label: 'No', pct: 0, class: 'text-red-400' },
    { key: 'veto', label: 'NoWithVeto', pct: 0, class: 'text-amber-400' },
    { key: 'abstain', label: 'Abstain', pct: 0, class: 'text-gray-400' },
  ];
  if (!tally) return empty;
  const yes = Number(tally.yes);
  const no = Number(tally.no);
  const veto = Number(tally.no_with_veto);
  const abstain = Number(tally.abstain);
  const sum = yes + no + veto + abstain;
  if (sum === 0) return empty;
  return [
    { key: 'yes', label: 'Yes', pct: (yes / sum) * 100, class: 'text-emerald-400' },
    { key: 'no', label: 'No', pct: (no / sum) * 100, class: 'text-red-400' },
    { key: 'veto', label: 'NoWithVeto', pct: (veto / sum) * 100, class: 'text-amber-400' },
    { key: 'abstain', label: 'Abstain', pct: (abstain / sum) * 100, class: 'text-gray-500' },
  ];
}

function participationPercent(p: GovProposal): number {
  if (p.status !== 'PROPOSAL_STATUS_VOTING_PERIOD') return 0;
  const active = validatorStore.activeStakingTotal;
  const tally = p.final_tally_result as Tally | undefined;
  if (!active || active <= 0 || !tally) return 0;
  const total =
    Number(tally.yes || 0) +
    Number(tally.no || 0) +
    Number(tally.no_with_veto || 0) +
    Number(tally.abstain || 0);
  if (!total) return 0;
  return (total / active) * 100;
}

watch(
  visibleProposals,
  (list) => {
    if (carouselIndex.value >= list.length) carouselIndex.value = Math.max(0, list.length - 1);
  },
  { deep: true }
);

function prevSlide() {
  const n = visibleProposals.value.length;
  if (n <= 1) return;
  carouselIndex.value = (carouselIndex.value - 1 + n) % n;
}

function nextSlide() {
  const n = visibleProposals.value.length;
  if (n <= 1) return;
  carouselIndex.value = (carouselIndex.value + 1) % n;
}

onMounted(async () => {
  chain.rpc
    .getGovParamsTally()
    .then((res: any) => {
      if (res?.tally_params?.quorum) quorum.value = Number(res.tally_params.quorum);
    })
    .catch(() => undefined);

  try {
    const statusesToFetch = props.mode === 'active' ? [GOV_ACTIVE_STATUS] : [...GOV_WIDGET_STATUSES];
    await Promise.all(statusesToFetch.map((s) => govStore.fetchProposals(s).catch(() => undefined)));
  } finally {
    initialFetchDone.value = true;
  }
});
</script>

<template>
  <section class="mt-6">
    <!-- Row 1: single line — Title + subtitle on left | counter + view all on right -->
    <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 mb-4 px-1">
      <div class="flex flex-wrap items-baseline gap-x-3 min-w-0">
        <h2 class="text-base sm:text-lg font-bold tracking-[0.14em] text-white uppercase whitespace-nowrap">
          {{ $t(titleKey) }}
        </h2>
        <p class="text-sm text-gray-500 leading-snug truncate">
          {{ $t('validator.proposals_widget.subtitle') }}
        </p>
      </div>
      <div class="flex items-baseline gap-5 text-sm text-gray-500 shrink-0">
        <span v-if="initialFetchDone && !isEmpty">
          {{
            props.mode === 'active'
              ? $t('validator.proposals_widget.active_count', { n: visibleProposals.length })
              : $t('validator.proposals_widget.latest_count', { n: visibleProposals.length })
          }}
        </span>
        <RouterLink
          :to="`/${chain.chainName}/gov`"
          class="link link-primary font-semibold no-underline hover:underline whitespace-nowrap"
        >
          {{ $t('validator.proposals_widget.view_all') }}
        </RouterLink>
      </div>
    </div>

    <div v-if="showCarousel" class="relative">
      <button
        type="button"
        class="btn btn-square bg-gray-100 text-gray-500 hover:text-white border-none dark:bg-gray-800 dark:text-white absolute left-0 top-1/2 -translate-y-1/2 z-10"
        :class="{ 'btn-disabled opacity-50 cursor-not-allowed': visibleProposals.length <= 1 }"
        :disabled="visibleProposals.length <= 1"
        aria-label="Previous proposal"
        @click="prevSlide"
      >
        <Icon icon="mdi:chevron-left" class="text-3xl" />
      </button>
      <button
        type="button"
        class="btn btn-square bg-gray-100 text-gray-500 hover:text-white border-none dark:bg-gray-800 dark:text-white absolute right-0 top-1/2 -translate-y-1/2 z-10"
        :class="{ 'btn-disabled opacity-50 cursor-not-allowed': visibleProposals.length <= 1 }"
        :disabled="visibleProposals.length <= 1"
        aria-label="Next proposal"
        @click="nextSlide"
      >
        <Icon icon="mdi:chevron-right" class="text-3xl" />
      </button>

      <div class="mx-14 sm:mx-16">
        <div
          v-for="(item, idx) in visibleProposals"
          v-show="idx === carouselIndex"
          :key="item.proposal_id"
          :class="['proposal-card', cardVariantClass(item.status)]"
          class="grid grid-cols-1 sm:grid-cols-[auto_minmax(0,1fr)_minmax(12rem,15rem)] sm:grid-rows-[auto_1fr_auto] gap-x-6 gap-y-3 p-5 sm:p-6 rounded-2xl"
        >
          <!-- Col 1 Row 1: empty -->
          <div class="sm:block"></div>
          <!-- Col 2 Row 1: #id + status pill -->
          <div class="flex flex-wrap items-center gap-2.5 gap-y-1 min-w-0">
            <RouterLink
              :to="`/${chain.chainName}/gov/${item.proposal_id}`"
              class="text-sm sm:text-base font-semibold text-white hover:text-sky-400 transition-colors"
            >
              #{{ item.proposal_id }}
            </RouterLink>
            <span
              :class="statusPillClass(item.status)"
              class="text-[10px] sm:text-xs font-bold uppercase tracking-wide px-2.5 py-1 rounded-full"
            >
              {{ statusMap[item.status] || item.status }}
            </span>
          </div>
          <!-- Col 3 Row 1: clock + time -->
          <div class="flex items-center gap-2 text-base text-gray-300 font-medium sm:justify-end">
            <Icon icon="mdi:clock-outline" class="text-xl shrink-0 text-gray-400" />
            <span>{{ format.toDay(item.voting_end_time, 'from') }}</span>
          </div>

          <!-- Col 1 Row 2: draft icon with status glyph overlaid inside -->
          <div
            class="relative shrink-0 w-14 h-14 sm:w-16 sm:h-16 flex items-center justify-center sm:self-center"
          >
            <Icon
              icon="material-symbols:draft-outline"
              :class="statusInnerIconClass(item.status)"
              class="text-[3.5rem] sm:text-[4rem]"
            />
            <Icon
              :icon="statusInnerIcon(item.status)"
              :class="statusInnerIconClass(item.status)"
              class="absolute text-lg sm:text-xl"
              style="top: 58%; left: 50%; transform: translate(-50%, -50%);"
            />
          </div>
          <!-- Col 2 Row 2: title, type pill, summary -->
          <div class="min-w-0 flex flex-col gap-2">
            <RouterLink
              :to="`/${chain.chainName}/gov/${item.proposal_id}`"
              class="text-lg sm:text-xl font-bold text-white leading-snug hover:text-sky-300 transition-colors line-clamp-2"
            >
              {{ proposalTitle(item) }}
            </RouterLink>
            <div
              v-if="proposalHasMultipleMessages(item) || proposalPrimaryMsgType(item)"
              class="bg-[#f6f2ff] text-[#9c6cff] dark:bg-gray-600 dark:text-gray-300 inline-block w-fit rounded-full px-2.5 py-[3px] text-xs"
            >
              {{
                proposalHasMultipleMessages(item)
                  ? $t('gov.multiple_messages')
                  : formatProposalType(proposalPrimaryMsgType(item))
              }}
            </div>
            <p
              v-if="proposalSummary(item)"
              class="text-sm text-gray-500 line-clamp-2 leading-relaxed"
            >
              {{ proposalSummary(item) }}
            </p>
          </div>
          <!-- Col 3 Row 2: participation bar + vote button (voting proposals only) -->
          <div
            v-if="item.status === 'PROPOSAL_STATUS_VOTING_PERIOD'"
            class="flex items-center gap-3 min-w-0 w-full sm:justify-end sm:self-center"
          >
            <div class="flex-1 sm:max-w-[180px] h-5 rounded-full bg-[#1e2436] overflow-hidden min-w-0">
              <div
                class="h-full rounded-full bg-emerald-500 shadow-[0_0_10px_rgba(52,211,153,0.45)] transition-[width] duration-300"
                :style="{ width: `${Math.min(100, Math.max(0, participationPercent(item)))}%` }"
              />
            </div>
            <label
              for="vote"
              class="btn btn-primary btn-sm shrink-0 rounded-lg font-semibold normal-case cursor-pointer"
              @click="dialog.open('vote', { proposal_id: item.proposal_id })"
            >
              {{ $t('gov.btn_vote') }}
            </label>
          </div>
          <div v-else class="sm:block"></div>

          <!-- Col 1 Row 3: empty -->
          <div class="sm:block"></div>
          <!-- Col 2 Row 3: votes split -->
          <div class="flex flex-wrap items-center gap-x-1 gap-y-1 text-sm font-medium">
            <template
              v-for="(row, i) in voteSplit(item.final_tally_result as Tally)"
              :key="row.key"
            >
              <span
                v-if="i > 0"
                class="text-gray-600 px-2"
                aria-hidden="true"
              >&bull;</span>
              <span :class="row.class">
                <span class="font-semibold">{{ row.label }}</span>
                <span class="ml-1">{{ row.pct.toFixed(0) }}%</span>
              </span>
            </template>
          </div>
          <!-- Col 3 Row 3: quorum — turnout / required (voting proposals only) -->
          <p
            v-if="item.status === 'PROPOSAL_STATUS_VOTING_PERIOD' && quorum > 0"
            class="text-xs text-gray-500 sm:text-right"
          >
            {{ participationPercent(item).toFixed(0) }}% / {{ (quorum * 100).toFixed(0) }}%
            {{ $t('validator.proposals_widget.quorum') }}
          </p>
          <div v-else class="sm:block"></div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.proposal-card {
  background: rgba(255, 255, 255, 0.1);
  border: 1.5px solid transparent;
}

.proposal-card--voting {
  border-color: rgba(99, 102, 241, 0.55);
  box-shadow:
    0 0 0 1px rgba(99, 102, 241, 0.15),
    0 0 28px -4px rgba(99, 102, 241, 0.45),
    0 0 60px -12px rgba(139, 92, 246, 0.35);
}

.proposal-card--passed {
  border-color: rgba(16, 185, 129, 0.55);
}

.proposal-card--rejected {
  border-color: rgba(239, 68, 68, 0.55);
}

</style>
