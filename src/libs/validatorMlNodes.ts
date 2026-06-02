import { get } from '@/libs/http';

export interface MlNode {
  node_id: string;
  poc_weight?: string | number;
  throughput?: string | number;
  timeslot_allocation?: boolean[];
}

export interface ValidationWeight {
  member_address: string;
  weight?: string | number;
  confirmation_weight?: string | number;
  reputation?: string | number;
  ml_nodes?: MlNode[];
}

export interface WeightScaleFactor {
  value?: string | number;
  exponent?: string | number;
}

export interface ModelWeightScale {
  model_id?: string;
  weight_scale_factor?: WeightScaleFactor | string | number;
}

export interface EpochGroupData {
  epoch_index?: string | number;
  total_weight?: string | number;
  total_throughput?: string | number;
  sub_group_models?: string[];
  validation_weights?: ValidationWeight[];
  confirmation_weight_scales?: ModelWeightScale[];
  params?: InferenceParams;
}

export interface InferenceParams {
  poc_params?: {
    models?: ModelWeightScale[];
  };
  collateral_params?: {
    base_weight_ratio?: WeightScaleFactor | string | number;
    collateral_per_weight_unit?: WeightScaleFactor | string | number;
    grace_period_end_epoch?: string | number;
  };
}

export interface ParticipantCollateral {
  amount?: {
    denom?: string;
    amount?: string | number;
  };
}

export interface ParticipantDetails {
  participant?: {
    current_epoch_stats?: {
      confirmationPoCRatio?: string | number | null;
    };
  };
}

const currentEpochGroupDataCache = new Map<string, Promise<EpochGroupData>>();
const epochGroupDataCache = new Map<string, Promise<EpochGroupData>>();
const modelEpochGroupDataCache = new Map<string, Promise<EpochGroupData>>();
const inferenceParamsCache = new Map<string, Promise<InferenceParams>>();
const participantCollateralCache = new Map<string, Promise<ParticipantCollateral>>();
const participantDetailsCache = new Map<string, Promise<ParticipantDetails>>();

function unwrapEpochGroupData(source: any): EpochGroupData {
  return source?.epoch_group_data || source || {};
}

export function inferenceApiBase(endpoint: string): string {
  if (!endpoint) throw new Error('Chain API endpoint is not configured');
  return `${endpoint}/productscience/inference/inference`;
}

export function collateralApiBase(endpoint: string): string {
  if (!endpoint) throw new Error('Chain API endpoint is not configured');
  return `${endpoint}/productscience/inference/collateral`;
}

export async function fetchCurrentEpochGroupData(
  base: string,
  force = false
): Promise<EpochGroupData> {
  const key = `${base}/current_epoch_group_data`;
  if (force) currentEpochGroupDataCache.delete(key);
  if (!currentEpochGroupDataCache.has(key)) {
    currentEpochGroupDataCache.set(key, get(key).then(unwrapEpochGroupData));
  }
  return currentEpochGroupDataCache.get(key)!;
}

export async function fetchModelEpochGroupData(
  base: string,
  epoch: string,
  modelId: string,
  force = false
): Promise<EpochGroupData> {
  const query = new URLSearchParams({ model_id: modelId }).toString();
  const key = `${base}/epoch_group_data/${epoch}?${query}`;
  if (force) modelEpochGroupDataCache.delete(key);
  if (!modelEpochGroupDataCache.has(key)) {
    modelEpochGroupDataCache.set(key, get(key).then(unwrapEpochGroupData));
  }
  return modelEpochGroupDataCache.get(key)!;
}

export async function fetchEpochGroupData(
  base: string,
  epoch: string,
  force = false
): Promise<EpochGroupData> {
  const key = `${base}/epoch_group_data/${epoch}`;
  if (force) epochGroupDataCache.delete(key);
  if (!epochGroupDataCache.has(key)) {
    epochGroupDataCache.set(key, get(key).then(unwrapEpochGroupData));
  }
  return epochGroupDataCache.get(key)!;
}

export async function fetchInferenceParams(
  base: string,
  force = false
): Promise<InferenceParams> {
  const key = `${base}/params`;
  if (force) inferenceParamsCache.delete(key);
  if (!inferenceParamsCache.has(key)) {
    inferenceParamsCache.set(key, get(key).then((source) => source?.params || source || {}));
  }
  return inferenceParamsCache.get(key)!;
}

export async function fetchParticipantCollateral(
  base: string,
  participant: string,
  force = false
): Promise<ParticipantCollateral> {
  const key = `${base}/collateral/${participant}`;
  if (force) participantCollateralCache.delete(key);
  if (!participantCollateralCache.has(key)) {
    participantCollateralCache.set(key, get(key));
  }
  return participantCollateralCache.get(key)!;
}

export async function fetchParticipantDetails(
  base: string,
  participant: string,
  force = false
): Promise<ParticipantDetails> {
  const key = `${base}/participant/${participant}`;
  if (force) participantDetailsCache.delete(key);
  if (!participantDetailsCache.has(key)) {
    participantDetailsCache.set(key, get(key));
  }
  return participantDetailsCache.get(key)!;
}
