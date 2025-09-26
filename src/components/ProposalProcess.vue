<script lang="ts" setup>
import { useFormatter, useStakingStore, useValidatorStore } from '@/stores';
import type { Tally } from '@/types';
import { computed } from '@vue/reactivity';
import type { PropType } from 'vue';
import { onMounted } from 'vue';

const props = defineProps({
  tally: { type: Object as PropType<Tally> },
  pool: {
    type: Object as PropType<{
      not_bonded_tokens: string;
      bonded_tokens: string;
    }>,
  },
  status: { type: String, required: false },
});

const validatorStore = useValidatorStore();

const total = computed(() => {
  const t = props.tally;
  if (!t) return 0n;
  const yes = BigInt(t.yes || 0);
  const no = BigInt(t.no || 0);
  const abstain = BigInt(t.abstain || 0);
  const veto = BigInt(t.no_with_veto || 0);
  return yes + no + abstain + veto;
});

const format = useFormatter();

// Denominator: during voting -> sum(staking tokens of active participants); after finalized -> sum of tally
const denominator = computed<string>(() => {
  const isVoting = props.status === 'PROPOSAL_STATUS_VOTING_PERIOD';
  if (isVoting) {
    console.log('denominator validatorStore.activeStakingTotal', validatorStore.activeStakingTotal);
    return String(validatorStore.activeStakingTotal || 0);
  }
  console.log('denominator total', total.value);
  return total.value.toString();
});

onMounted(async () => {
  try {
    const needParticipants = !validatorStore.participantsMap || Object.keys(validatorStore.participantsMap).length === 0;
    if (needParticipants) {
      await validatorStore.init();
    }
  } catch {}
});

const yes = computed(() =>  
  format.calculatePercent(props.tally?.yes, denominator.value)
);
const no = computed(() =>
  format.calculatePercent(props.tally?.no, denominator.value)
);
const abstain = computed(() =>
  format.calculatePercent(props.tally?.abstain, denominator.value)
);
const veto = computed(() =>
  format.calculatePercent(props.tally?.no_with_veto, denominator.value)
);
</script>

<template>
  <div class="progress rounded-[3px] h-6 text-xs flex items-center">
    <div
      class="h-6 bg-yes flex items-center pl-2 text-white overflow-hidden"
      :style="`width: ${yes}`"
      :title="yes"
    >
      {{ yes }}
    </div>
    <div
      class="h-6 bg-no flex items-center text-white overflow-hidden"
      :style="`width: ${no}`"
      :title="no"
    >
      {{ no }}
    </div>
    <div
      class="h-6 bg-[#B71C1C] flex items-center text-white overflow-hidden"
      :style="`width: ${veto};`"
      :title="veto"
    >
      {{ veto }}
    </div>
    <div
      class="h-6 bg-secondary flex items-center text-white overflow-hidden"
      :style="`width: ${abstain}`"
      :title="abstain"
    >
      {{ abstain }}
    </div>
  </div>
</template>
<style scoped>
.progress {
  overflow: hidden;
  background-color: rgba(128, 128, 128, 0.178);
}
</style>
