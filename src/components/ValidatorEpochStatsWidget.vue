<script lang="ts" setup>
import { computed, onMounted, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import { useWindowSize } from '@vueuse/core';
import { operatorAddressToAccount } from '@/libs';
import { useBlockchain } from '@/stores';
import PaginationBar from '@/components/PaginationBar.vue';
import {
  collateralApiBase,
  fetchCurrentEpochGroupData,
  fetchEpochGroupData,
  fetchInferenceParams,
  fetchModelEpochGroupData,
  fetchParticipantCollateral,
  fetchParticipantDetails,
  inferenceApiBase,
  type EpochGroupData,
  type InferenceParams,
  type MlNode,
} from '@/libs/validatorMlNodes';

interface ModelNodeGroup {
  modelId: string;
  scaleFactor: number;
  nodes: MlNode[];
}

interface ValidatorMlNodeCard {
  modelId: string;
  scaleFactor: number;
  node: MlNode;
}

interface StatCard {
  key: string;
  titleKey: string;
  value: string;
  hintKey?: string;
}

const props = defineProps<{
  validator: string;
}>();

const blockchain = useBlockchain();
const { width } = useWindowSize();

const loading = ref(false);
const error = ref('');
const epochIndex = ref('');
const currentEpochIndex = ref<number | null>(null);
const selectedEpoch = ref<number | null>(null);
const hoveredStat = ref('');
const modelGroups = ref<ModelNodeGroup[]>([]);
const chainWeight = ref<number | null>(null);
const confirmationWeight = ref<number | null>(null);
const weightToConfirm = ref<number | null>(null);
const chainConfirmationRatio = ref<number | null>(null);
const collateralDepositedBase = ref<number | null>(null);
const collateralDepositCoin = ref<{ amount: string; denom: string } | null>(null);
const collateralNeededBase = ref<number | null>(null);
const weightBackedPercent = ref<number | null>(null);
const isGracePeriodActive = ref(false);

const accountAddress = computed(() => operatorAddressToAccount(props.validator));
const mlNodeCards = computed<ValidatorMlNodeCard[]>(() =>
  modelGroups.value.flatMap((group) =>
    group.nodes.map((node) => ({
      modelId: group.modelId,
      scaleFactor: group.scaleFactor,
      node,
    }))
  )
);
const nodeCount = computed(() => mlNodeCards.value.length);
const validatorActiveModelCount = computed(() => modelGroups.value.length);
const confirmationRatio = computed(() => {
  if (chainConfirmationRatio.value !== null) {
    return Math.min(chainConfirmationRatio.value, 100);
  }
  if (!weightToConfirm.value || confirmationWeight.value === null) return null;
  return Math.min((confirmationWeight.value / weightToConfirm.value) / 0.909 * 100, 100);
});
const isEmpty = computed(() => !loading.value && !error.value && nodeCount.value === 0);
const minEpochPage = computed(() => {
  const current = currentEpochIndex.value;
  return current ? Math.max(1, current - 9) : 1;
});
const currentEpochPage = computed(() => {
  const current = currentEpochIndex.value;
  if (!current) return 1;
  return selectedEpoch.value === null ? current : selectedEpoch.value;
});
const maxVisiblePages = computed(() => (width.value < 640 ? 3 : 5));
const statCards = computed<StatCard[]>(() => [
  {
    key: 'weight',
    titleKey: 'validator.ml_nodes.chain_weight',
    value: formatOptionalNumber(chainWeight.value),
  },
  {
    key: 'weight_to_confirm',
    titleKey: 'validator.ml_nodes.weight_to_confirm',
    value: formatOptionalNumber(weightToConfirm.value),
  },
  {
    key: 'confirmation_ratio',
    titleKey: 'validator.ml_nodes.confirmation_ratio',
    value: formatRatio(confirmationRatio.value),
    hintKey: 'validator.ml_nodes.confirmation_ratio_hint',
  },
  {
    key: 'needed_collateral',
    titleKey: 'validator.ml_nodes.needed_collateral',
    value: isGracePeriodActive.value
      ? 'Grace period active'
      : formatCollateralBaseAmount(collateralNeededBase.value),
  },
  {
    key: 'collateral_deposited',
    titleKey: 'validator.ml_nodes.collateral_deposited',
    value: formatCollateralDeposited(),
  },
  {
    key: 'weight_backed',
    titleKey: 'validator.ml_nodes.weight_backed',
    value: isGracePeriodActive.value
      ? 'Grace period active'
      : formatRatio(weightBackedPercent.value),
  },
]);

function numberValue(value: string | number | undefined): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatNumber(value: string | number | undefined): string {
  return new Intl.NumberFormat().format(numberValue(value));
}

function formatOptionalNumber(value: number | null): string {
  return value === null ? 'N/A' : new Intl.NumberFormat().format(value);
}

function formatRatio(value: number | null): string {
  return value === null ? 'N/A' : `${value.toFixed(1)}%`;
}

function scaledNodeWeight(item: ValidatorMlNodeCard): number {
  return Math.floor(numberValue(item.node.poc_weight) * item.scaleFactor);
}

function formatCollateralBaseAmount(value: number | null): string {
  if (value === null) return 'N/A';
  const baseDenom = collateralDepositCoin.value?.denom || blockchain.current?.assets?.[0]?.base || 'ngonka';
  return `${new Intl.NumberFormat().format(Math.round(value))} ${baseDenom}`;
}

function formatCollateralDeposited(): string {
  return collateralDepositCoin.value
    ? `${new Intl.NumberFormat().format(numberValue(collateralDepositCoin.value.amount))} ${collateralDepositCoin.value.denom}`
    : 'N/A';
}

function friendlyErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('503')) return 'Chain API is temporarily unavailable. Try refreshing in a moment.';
  if (message.includes('<html') || message.includes('<!DOCTYPE')) return 'Chain API returned an HTML error page.';
  return message || 'Unable to load validator epoch stats.';
}

function scaleFactorValue(value: any): number | null {
  if (value && typeof value === 'object' && 'value' in value) {
    const coefficient = Number(value.value || 0);
    const exponent = Number(value.exponent || 0);
    const scaled = coefficient * 10 ** exponent;
    return Number.isFinite(scaled) ? scaled : null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ratioPercentValue(value: any): number | null {
  const ratio = scaleFactorValue(value);
  if (ratio === null) return null;
  return ratio <= 1 ? ratio * 100 : ratio;
}

function scaleFactorForModel(
  modelId: string,
  root: EpochGroupData,
  params: InferenceParams | null
): number {
  const snapshotScale = root.confirmation_weight_scales?.find(
    (item) => item.model_id === modelId
  )?.weight_scale_factor;
  const paramsScale = params?.poc_params?.models?.find(
    (item) => item.model_id === modelId
  )?.weight_scale_factor;

  return scaleFactorValue(snapshotScale) ?? scaleFactorValue(paramsScale) ?? 1;
}

function nodeRole(node: MlNode): string {
  const slots = node.timeslot_allocation || [];
  if (slots[1]) return 'POC';
  if (slots[0]) return 'VALIDATION';
  return 'ACTIVE';
}

function slotClass(node: MlNode): string {
  const slots = node.timeslot_allocation || [];
  if (slots[1]) return 'bg-sky-500/20 text-sky-200 border-sky-400/30';
  if (slots[0]) return 'bg-emerald-500/20 text-emerald-200 border-emerald-400/30';
  return 'bg-slate-500/20 text-slate-300 border-slate-500/30';
}

async function loadValidatorNodes(force = false) {
  if (!props.validator || !accountAddress.value) return;

  loading.value = true;
  error.value = '';
  modelGroups.value = [];
  chainWeight.value = null;
  confirmationWeight.value = null;
  weightToConfirm.value = null;
  chainConfirmationRatio.value = null;
  collateralDepositedBase.value = null;
  collateralDepositCoin.value = null;
  collateralNeededBase.value = null;
  weightBackedPercent.value = null;
  isGracePeriodActive.value = false;

  try {
    const base = inferenceApiBase(blockchain.endpoint.address);
    const collateralBase = collateralApiBase(blockchain.endpoint.address);
    const currentRoot = await fetchCurrentEpochGroupData(base, force);
    const currentEpoch = Number(currentRoot.epoch_index || 0) || null;
    currentEpochIndex.value = currentEpoch;

    const selectedEpochIndex = selectedEpoch.value ? String(selectedEpoch.value) : '';
    const root = selectedEpochIndex
      ? await fetchEpochGroupData(base, selectedEpochIndex, force)
      : currentRoot;
    const epoch = String(root.epoch_index || '');
    const models = Array.isArray(root.sub_group_models)
      ? root.sub_group_models.filter(Boolean)
      : [];

    epochIndex.value = epoch;
    const rootValidationWeight = (root.validation_weights || []).find(
      (item) => item.member_address === accountAddress.value
    );
    chainWeight.value = rootValidationWeight
      ? numberValue(rootValidationWeight.weight)
      : null;
    confirmationWeight.value = rootValidationWeight
      ? numberValue(rootValidationWeight.confirmation_weight)
      : null;

    if (selectedEpoch.value === null) {
      const participantDetails = await fetchParticipantDetails(
        base,
        accountAddress.value,
        force
      ).catch(() => null);
      const chainRatio = participantDetails?.participant?.current_epoch_stats?.confirmationPoCRatio;
      if (chainRatio !== null && chainRatio !== undefined) {
        chainConfirmationRatio.value = ratioPercentValue(chainRatio);
      }
    }

    if (!epoch || models.length === 0) {
      return;
    }

    const shouldFetchParams = !root.confirmation_weight_scales?.length;
    const params = shouldFetchParams
      ? await fetchInferenceParams(base, force)
      : await fetchInferenceParams(base, force).catch(() => null);
    let computedWeightToConfirm = 0;

    const groups = await Promise.all(
      models.map(async (modelId) => {
        const data = await fetchModelEpochGroupData(base, epoch, modelId, force);
        const validationWeight = (data.validation_weights || []).find(
          (item) => item.member_address === accountAddress.value
        );
        const scaleFactor = scaleFactorForModel(modelId, root, params);

        if (validationWeight) {
          computedWeightToConfirm += Math.floor(
            numberValue(validationWeight.weight) * scaleFactor
          );
        }

        if (!validationWeight?.ml_nodes?.length) return null;

        return {
          modelId,
          scaleFactor,
          nodes: validationWeight.ml_nodes,
        };
      })
    );

    weightToConfirm.value = computedWeightToConfirm;
    modelGroups.value = groups.filter(Boolean) as ModelNodeGroup[];

    const collateral = await fetchParticipantCollateral(
      collateralBase,
      accountAddress.value,
      force
    );
    collateralDepositCoin.value = collateral.amount?.amount && collateral.amount?.denom
      ? {
        amount: String(collateral.amount.amount),
        denom: collateral.amount.denom,
      }
      : null;
    collateralDepositedBase.value = collateralDepositCoin.value
      ? numberValue(collateralDepositCoin.value.amount)
      : null;

    const collateralParams = params?.collateral_params;
    const graceEnd = Number(collateralParams?.grace_period_end_epoch || 0);
    isGracePeriodActive.value = Number(epoch || 0) <= graceEnd;

    if (!isGracePeriodActive.value) {
      const potentialWeight = computedWeightToConfirm;
      const baseWeightRatio = scaleFactorValue(collateralParams?.base_weight_ratio) ?? 0;
      const cpwu = scaleFactorValue(collateralParams?.collateral_per_weight_unit) ?? 0;
      const baseWeight = Math.floor(potentialWeight * baseWeightRatio);
      const eligibleWeight = Math.max(0, potentialWeight - baseWeight);
      const deposited = collateralDepositedBase.value || 0;
      const activatedWeight = cpwu > 0
        ? Math.min(eligibleWeight, Math.floor(deposited / cpwu))
        : 0;

      collateralNeededBase.value = potentialWeight * cpwu;
      weightBackedPercent.value = eligibleWeight > 0
        ? Math.min((activatedWeight / eligibleWeight) * 100, 100)
        : null;
    }
  } catch (err) {
    error.value = friendlyErrorMessage(err);
  } finally {
    loading.value = false;
  }
}

async function handleEpochPageChange(page: number) {
  const current = currentEpochIndex.value;
  if (!current) return;
  selectedEpoch.value = page === current ? null : page;
  await loadValidatorNodes();
}

onMounted(() => loadValidatorNodes());

watch(
  () => [props.validator, blockchain.endpoint.address],
  () => {
    loadValidatorNodes();
  }
);
</script>

<template>
  <div class="mt-5 space-y-5">
    <div class="flex flex-wrap items-center justify-center gap-3">
      <PaginationBar
        :total="String(currentEpochIndex || 0)"
        :limit="1"
        :page="currentEpochPage"
        :min-page="minEpochPage"
        :callback="handleEpochPageChange"
        :loading="loading"
        :max-visible="maxVisiblePages"
        :show-refresh="true"
        :refresh-loading="loading"
        :refresh-callback="() => loadValidatorNodes(true)"
        :refresh-label="$t('validator.ml_nodes.refresh')"
      />
    </div>

    <section class="bg-base-100 rounded shadow overflow-hidden">
      <div class="grid gap-px bg-base-300/60 md:grid-cols-3">
        <div
          v-for="card in statCards"
          :key="card.key"
          class="relative min-h-[96px] bg-base-100 p-4"
        >
          <div
            v-if="card.hintKey"
            class="absolute right-4 top-4 text-primary"
            @mouseenter="hoveredStat = card.key"
            @mouseleave="hoveredStat = ''"
          >
            <Icon icon="mdi:information" size="22" />
          </div>

          <span class="block pr-7 text-xs font-bold uppercase tracking-[0.12em] text-gray-500">
            {{ $t(card.titleKey) }}
          </span>

          <div class="relative mt-2 h-12">
            <div
              class="absolute inset-0 flex items-center transition-opacity duration-200"
              :class="{ 'opacity-0 pointer-events-none': hoveredStat === card.key && card.hintKey }"
            >
              <strong class="block text-2xl font-bold text-main">
                {{ card.value }}
              </strong>
            </div>
            <div
              v-if="card.hintKey"
              class="absolute inset-0 flex items-center transition-opacity duration-200 pointer-events-none"
              :class="{ 'opacity-0': hoveredStat !== card.key }"
            >
              <p class="text-sm leading-5 text-main">
                {{ $t(card.hintKey) }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="bg-base-100 rounded shadow p-4">
      <div class="flex flex-wrap items-start justify-between gap-4 mb-4">
        <div>
          <h2 class="text-lg font-semibold text-main">
            {{ $t('validator.ml_nodes.title') }}
          </h2>
          <p class="text-sm text-gray-500 mt-1">
            {{ $t('validator.ml_nodes.subtitle') }}
          </p>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <span class="rounded bg-base-200/60 px-3 py-1 text-xs font-semibold text-gray-500">
            {{ $t('validator.ml_nodes.active_models') }}: {{ validatorActiveModelCount }}
          </span>
          <span class="rounded bg-base-200/60 px-3 py-1 text-xs font-semibold text-gray-500">
            {{ $t('validator.ml_nodes.nodes') }}: {{ nodeCount }}
          </span>
        </div>
      </div>

      <div
        v-if="loading"
        class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
      >
        <div
          v-for="i in 3"
          :key="i"
          class="rounded bg-base-200/40 p-4 shadow-sm animate-pulse min-h-[150px]"
        >
          <div class="h-4 bg-base-300 rounded w-1/2 mb-8"></div>
          <div class="space-y-3">
            <div class="h-3 bg-base-300 rounded w-full"></div>
            <div class="h-3 bg-base-300 rounded w-3/4"></div>
            <div class="h-3 bg-base-300 rounded w-2/3"></div>
          </div>
        </div>
      </div>

      <div
        v-else-if="error"
        class="flex items-start gap-3 rounded border border-error/20 bg-error/10 p-4 text-error"
      >
        <Icon icon="mdi:cloud-alert-outline" class="mt-0.5 text-2xl shrink-0" />
        <div>
          <p class="font-semibold">{{ $t('validator.ml_nodes.error_title') }}</p>
          <p class="mt-1 text-sm opacity-80">{{ error }}</p>
        </div>
      </div>

      <div
        v-else-if="isEmpty"
        class="flex items-center gap-4 rounded border border-dashed border-base-300 bg-base-200/40 p-6"
      >
        <Icon icon="mdi:server-network-off" class="text-3xl text-gray-400" />
        <div>
          <p class="font-semibold text-main">{{ $t('validator.ml_nodes.empty_title') }}</p>
          <p class="text-sm text-gray-500">{{ $t('validator.ml_nodes.empty_body') }}</p>
        </div>
      </div>

      <div v-else class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <div
          v-for="item in mlNodeCards"
          :key="`${item.modelId}-${item.node.node_id}`"
          class="rounded bg-base-200/40 p-4 shadow-sm"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h4 class="font-bold text-main truncate">{{ item.node.node_id }}</h4>
              <p class="text-xs uppercase tracking-[0.14em] text-gray-500 mt-1">
                {{ $t('validator.ml_nodes.node_id') }}
              </p>
            </div>
            <span
              class="rounded border px-2 py-1 text-[10px] font-bold uppercase tracking-wide"
              :class="slotClass(item.node)"
            >
              {{ nodeRole(item.node) }}
            </span>
          </div>

          <div class="mt-5">
            <p class="block text-xs font-bold uppercase tracking-[0.12em] text-gray-500">
              {{ $t('validator.ml_nodes.model') }}
            </p>
            <p class="text-sm font-medium text-main break-words">{{ item.modelId }}</p>
          </div>

          <div class="mt-5">
            <div>
              <p class="block text-xs font-bold uppercase tracking-[0.12em] text-gray-500">
                {{ $t('validator.ml_nodes.weight') }}
              </p>
              <p class="mt-1 font-mono text-lg font-semibold text-main">
                {{ formatNumber(scaledNodeWeight(item)) }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
