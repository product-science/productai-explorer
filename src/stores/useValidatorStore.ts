import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useBlockchain } from './useBlockchain';
import { useBaseStore } from './useBaseStore';
import { useFormatter } from './useFormatter';
import { useStakingStore } from './useStakingStore';
import { get } from '@/libs/http';
import type { Validator } from '@/types';
import { PageRequest } from '@/types';

export interface MlNode {
  node_id: string;
  poc_weight: number;
  timeslot_allocation: boolean[];
}
export interface MlNodeGroup {
  ml_nodes: MlNode[];
}
export interface ValidationWeight {
  member_address: string;
  weight: number; // This might be just confirmation weight or total, depending on context, but API typically returns confirmation_weight separate
  confirmation_weight: number;
  ml_nodes: MlNode[];
}
export interface EpochGroupData {
  epoch_index: string;
  validation_weights: ValidationWeight[];
}
export interface ActiveParticipantSeed {
  participant: string;
  epoch_index: number;
  signature: string;
}
export interface Participant {
  index: string; // participant account address
  validator_key?: string;
  weight?: number;
  inference_url?: string;
  models?: string[];
  seed?: ActiveParticipantSeed;
  ml_nodes?: MlNodeGroup[];
  // Added for local calculation storage
  effective_weight?: number;
  capped_weight?: number;
}

export interface ParticipantTotals {
  account_address: string;
  operator_address: string;
  reputation: number;
  rewarded_coins_current_epoch: string;
  earned_coins_current_epoch: string;
  rewarded_coins_latest_epoch: string;
  epochs_completed: number;
}

// Epoch performance summary types (from /productscience/inference/inference/epoch_performance_summary)
export interface EpochPerformanceSummaryItem {
  epoch_index: string;
  participant_id: string;
  inference_count: string;
  missed_requests: string;
  earned_coins: string;
  rewarded_coins: string;
  burned_coins: string;
  validated_inferences: string;
  invalidated_inferences: string;
  claimed: boolean;
}

export interface EpochPerformanceSummaryResponse {
  epochPerformanceSummary: EpochPerformanceSummaryItem[];
  pagination: {
    next_key: string | null;
    total: string;
  };
}

export interface EpochPerformanceStats {
  inference_count: number;
  missed_requests: number;
}

export const useValidatorStore = defineStore('validatorStore', {
  state: () => ({
    // Data stores
    participantsDataByOperator: {} as Record<string, Participant>,
    previousParticipantsDataByOperator: {} as Record<string, Participant>,
    participantsStakingData: [] as Validator[],
    participantsTotalsData: [] as ParticipantTotals[],
    participantsCount: '0',
    totalPower: '0',
    loading: false,
    error: null as string | null,
    initialized: false,
    params: {
      bond_denom: 'ugonka',
      max_validators: 100,
    },
    // Current epoch PoC data
    pocWeights: {} as Record<string, number>,
    pocModels: {} as Record<string, string[]>,
    // Epoch-specific data cache: epochIndex -> { participants, weights, models, cappedWeights }
    epochDataCache: {} as Record<number, {
      participants: Record<string, Participant>;
      weights: Record<string, number>; // This will store Effective Weight before capping
      cappedWeights: Record<string, number>; // This will store Final Capped Weight
      models: Record<string, string[]>;
    }>,
    selectedEpochIndex: null as number | null, // null = current epoch
    // Claimed amounts cache: epochIndex -> operatorAddress -> { total, details }
    claimedAmountsCache: {} as Record<number, Record<string, { total: string; details: string }>>,

    // Last claimed-range search (for debugging)
    lastClaimSearchRange: null as { epochIndex: number; minHeight: number; maxHeight: number } | null,

    // Epoch performance cache: epochIndex -> operatorAddress -> stats
    epochPerformanceByEpoch: {} as Record<number, Record<string, EpochPerformanceStats>>,

    // Avatars
    avatars: {} as Record<string, string>,
    avatarLoading: {} as Record<string, boolean>,
    avatarErrors: {} as Record<string, string>,
  }),

  getters: {
    blockchain: () => useBlockchain(),
    base: () => useBaseStore(),
    staking: () => useStakingStore(),
    format: () => useFormatter(),

    operatorToAccountMap(state): Record<string, string> {
      const map: Record<string, string> = {};
      for (const p of state.participantsTotalsData) {
        if (p.operator_address && p.account_address) map[p.operator_address] = p.account_address;
      }
      return map;
    },
    accountToOperatorMap(state): Record<string, string> {
      const map: Record<string, string> = {};
      for (const p of state.participantsTotalsData) {
        if (p.operator_address && p.account_address) map[p.account_address] = p.operator_address;
      }
      return map;
    },
    participantsTotalsByOperator(state): Record<string, ParticipantTotals> {
      const map: Record<string, ParticipantTotals> = {};
      for (const p of state.participantsTotalsData) {
        if (p.operator_address) map[p.operator_address] = p;
      }
      return map;
    },

    /**
     * Get epoch performance stats (inferences / missed requests) for a validator
     * in the currently selected epoch (if any).
     */
    getEpochPerformanceForSelectedEpoch(state) {
      return (operatorAddress: string): EpochPerformanceStats | null => {
        if (state.selectedEpochIndex === null) return null;
        const epochMap = state.epochPerformanceByEpoch[state.selectedEpochIndex];
        if (!epochMap) return null;
        return epochMap[operatorAddress] || null;
      };
    },

    getValidatorStats() {
      return (validatorAddress: string) => {
        const stats = this.participantsTotalsByOperator[validatorAddress];
        return stats || {
          earned_coins_current_epoch: '0',
          epochs_completed: 0,
          reputation: 0,
          rewarded_coins_current_epoch: '0',
          rewarded_coins_latest_epoch: '0',
        } as any;
      };
    },

    getParticipant(state) {
      return (operatorAddress: string): Participant | null => {
        // If a specific epoch is selected, use that epoch's data
        if (state.selectedEpochIndex !== null && state.epochDataCache[state.selectedEpochIndex]) {
          return state.epochDataCache[state.selectedEpochIndex].participants[operatorAddress] || null;
        }
        // Otherwise use current epoch data
        return state.participantsDataByOperator[operatorAddress] || null;
      };
    },
    getParticipantWeight(state) {
      return (operatorAddress: string): number => {
        // If a specific epoch is selected, use that epoch's weights
        if (state.selectedEpochIndex !== null && state.epochDataCache[state.selectedEpochIndex]) {
          return state.epochDataCache[state.selectedEpochIndex].weights[operatorAddress] || 0;
        }
        // Otherwise use current epoch weights
        return state.pocWeights[operatorAddress] || 0;
      };
    },
    participantsMap(state) {
      // If a specific epoch is selected, use that epoch's data
      if (state.selectedEpochIndex !== null && state.epochDataCache[state.selectedEpochIndex]) {
        return state.epochDataCache[state.selectedEpochIndex].participants;
      }
      return state.participantsDataByOperator;
    },
    previousParticipantsMap(state) {
      return state.previousParticipantsDataByOperator;
    },

    totalPocWeight(state): number {
      // If a specific epoch is selected, use that epoch's weights
      if (state.selectedEpochIndex !== null && state.epochDataCache[state.selectedEpochIndex]) {
        return Object.values(state.epochDataCache[state.selectedEpochIndex].weights || {}).reduce((sum, w) => sum + (Number.isFinite(w) ? Number(w) : 0), 0);
      }
      return Object.values(state.pocWeights || {}).reduce((sum, w) => sum + (Number.isFinite(w) ? Number(w) : 0), 0);
    },

    // Epoch reward simulation and getters derived from it
    simulatedRewardsMap(): Record<string, string> {
      // Constants
      const INITIAL_EPOCH_REWARD = 285000000000000; // ngonka
      const DECAY_RATE = -0.000475;
      const GENESIS_EPOCH = 1;

      const currentEpoch = Number(this.blockchain.currentEpochIndex || 0) || 1;
      const epochPoolNumber = Math.max(0, Math.floor(INITIAL_EPOCH_REWARD * Math.exp(DECAY_RATE * (currentEpoch - GENESIS_EPOCH))));
      const epochPool = BigInt(epochPoolNumber);

      type WeightedParticipant = { op: string; weight: bigint };
      const SCALE = 1_000_000n;

      const pocEntries = Object.entries(this.pocWeights || {});
      const items: WeightedParticipant[] = pocEntries.length
        ? pocEntries
            .map(([op, w]) => ({ op, weight: (BigInt(Math.max(0, Math.floor(Number(w)))) * SCALE) }))
            .filter((x) => x.weight > 0n)
        : [];

      const totalWeight = items.reduce((acc, it) => acc + it.weight, 0n);
      const result: Record<string, string> = {};
      if (epochPool === 0n || totalWeight === 0n) return result;

      let assigned = 0n;
      const positiveRewards: string[] = [];
      for (const it of items) {
        const reward = (epochPool * it.weight) / totalWeight;
        result[it.op] = reward.toString();
        assigned += reward;
        if (reward > 0n) positiveRewards.push(it.op);
      }
      const remainder = epochPool - assigned;
      if (remainder > 0n && positiveRewards.length > 0) {
        const first = positiveRewards[0];
        const curr = BigInt(result[first] || '0');
        result[first] = (curr + remainder).toString();
      }
      return result;
    },

    getRewardedCoinsCurrentEpoch() {
      return (validatorAddress: string) => {
        const stats = this.getValidatorStats(validatorAddress);
        const apiVal = stats.rewarded_coins_current_epoch || '0';
        if (apiVal && apiVal !== '0') return apiVal;
        return this.simulatedRewardsMap[validatorAddress] || '0';
      };
    },
    getRewardedCoinsLatestEpoch() {
      return (validatorAddress: string) => {
        const stats = this.getValidatorStats(validatorAddress);
        return stats.rewarded_coins_latest_epoch || '0';
      };
    },

    getEarnedCoins() {
      return (operatorAddress: string) => {
        // If a specific epoch is selected (past epoch), return total reward (not time-based)
        if (this.selectedEpochIndex !== null) {
          // For past epochs, return the total reward that should have been earned
          const epochData = this.epochDataCache[this.selectedEpochIndex];
          if (epochData) {
            // Calculate reward for this epoch using the epoch's CAPPED weight
            // Use capped weights for distribution calculation as per protocol rules
            const weights = epochData.cappedWeights || epochData.weights;
            const weight = weights[operatorAddress] || 0;
            if (weight === 0) return '0';
            
            // Use simulated rewards calculation for the selected epoch
            const INITIAL_EPOCH_REWARD = 285000000000000; // ngonka
            const DECAY_RATE = -0.000475;
            const GENESIS_EPOCH = 1;
            
            const epochPoolNumber = Math.max(0, Math.floor(INITIAL_EPOCH_REWARD * Math.exp(DECAY_RATE * (this.selectedEpochIndex - GENESIS_EPOCH))));
            const epochPool = BigInt(epochPoolNumber);
            
            // Total weight must also be the sum of CAPPED weights
            const totalWeight = Object.values(weights).reduce((sum, w) => sum + (Number.isFinite(w) ? Number(w) : 0), 0);
            if (totalWeight === 0 || epochPool === 0n) return '0';
            
            const reward = (epochPool * BigInt(Math.max(0, Math.floor(weight))) * 1_000_000n) / (BigInt(Math.floor(totalWeight)) * 1_000_000n);
            return reward.toString();
          }
          return '0';
        }
        
        // For current epoch, use time-based calculation
        const stats = this.getValidatorStats(operatorAddress);
        const baseEarned = parseFloat(stats.earned_coins_current_epoch || '0');
        const currentHeight = Number(this.base.latest?.block?.header?.height || 0);
        const nextPoC = this.blockchain.nextPocStart;
        const epochLength = this.blockchain.epochLength;
        const rewardedCoinsCurrentEpoch = this.getRewardedCoinsCurrentEpoch(operatorAddress);
        let vestingBonus = 0;
        if (nextPoC && epochLength && currentHeight > 0 && Number(rewardedCoinsCurrentEpoch) > 0) {
          const blocksUntilNextPoC = Math.max(0, Number(nextPoC) - currentHeight);
          const pocFinalizedPercentage = 1 - (blocksUntilNextPoC / Number(epochLength));
          vestingBonus = pocFinalizedPercentage * Number(rewardedCoinsCurrentEpoch);
        }
        return (baseEarned + vestingBonus).toString();
      };
    },
    getEpochsCompleted() {
      return (operatorAddress: string) => {
        const stats = this.getValidatorStats(operatorAddress);
        return stats.epochs_completed || 0;
      };
    },
    getReputation() {
      return (operatorAddress: string) => {
        const stats = this.getValidatorStats(operatorAddress);
        return stats.reputation || 0;
      };
    },

    /**
     * Missed-requests percentage for currently selected epoch, 0–100 range.
     */
    getEpochMissedPercentage() {
      return (operatorAddress: string): number => {
        const stats = this.getEpochPerformanceForSelectedEpoch(operatorAddress);
        if (!stats || !stats.inference_count) return 0;
        const missed = Number(stats.missed_requests || 0);
        const total = Number(stats.inference_count || 0);
        if (!Number.isFinite(missed) || !Number.isFinite(total) || total <= 0) return 0;
        return (missed / total) * 100;
      };
    },

    displayParticipantsCount(state): string {
      if (state.loading) return '...';
      if (state.error) return 'Error';
      return state.participantsCount || '0';
    },
    displayActiveProviders(state): string {
      if (state.loading) return '...';
      if (state.error) return 'Error';
      return state.participantsTotalsData.length.toString() || '0';
    },
    displayTotalPower(state): string {
      if (state.loading) return '...';
      if (state.error) return 'Error';
      const sum = Object.values(this.pocWeights || {}).reduce((acc, w) => acc + (Number.isFinite(w) ? Number(w) : 0), 0);
      return (sum || 0).toString();
    },
    displayTotalValidators(state): string {
      if (state.loading) return '...';
      if (state.error) return 'Error';
      return state.participantsStakingData.length.toString() || '0';
    },
    displayTotalFinalReward(): string {
      if (this.loading) return '...';
      if (this.error) return 'Error';
      const total = this.participantsTotalsData.reduce((sum, p) => sum + parseFloat(p.rewarded_coins_latest_epoch || '0'), 0);
      return this.format.formatToken({ amount: total.toString(), denom: this.blockchain.current?.assets?.[0]?.base || 'ngonka' }, true, '0,0');
    },
    displayTotalEarnedReward(): string {
      if (this.loading) return '...';
      if (this.error) return 'Error';
      const total = this.participantsStakingData.reduce((sum, v) => sum + parseFloat(this.getEarnedCoins(v.operator_address) || '0'), 0);
      return this.format.formatToken({ amount: total.toString(), denom: 'ngonka' }, true, '0,0');
    },

    // Voting power change
    votingPowerChange24ByOperator(state): Record<string, number> {
      const changes: Record<string, number> = {};
      const curr = state.participantsDataByOperator || {};
      const prev = state.previousParticipantsDataByOperator || {};
      const keys = new Set<string>([...Object.keys(curr), ...Object.keys(prev)]);
      for (const op of keys) {
        const cw = Number(curr[op]?.weight ?? 0);
        const pw = Number(prev[op]?.weight ?? 0);
        const dv = (Number.isFinite(cw) ? cw : 0) - (Number.isFinite(pw) ? pw : 0);
        changes[op] = dv;
      }
      return changes;
    },
    getVotingPowerChange24() {
      return (operatorAddress: string): number => {
        const v = this.votingPowerChange24ByOperator[operatorAddress];
        return Number.isFinite(v) ? Number(v) : 0;
      };
    },

    // Governance denominator: sum(staking tokens) for active participants
    activeStakingTotal(): number {
      try {
        const activeOperators = new Set(Object.keys(this.participantsDataByOperator || {}));
        if (activeOperators.size === 0) return 0;
        const validators = this.staking.validators || [];
        return validators.reduce((sum, v) => sum + (activeOperators.has(v.operator_address) ? Number(v.tokens || 0) : 0), 0);
      } catch {
        return 0;
      }
    },
  },

  actions: {
    $reset() {
      this.participantsStakingData = [];
      this.participantsTotalsData = [];
      this.participantsCount = '0';
      this.totalPower = '0';
      this.loading = false;
      this.error = null;
      this.participantsDataByOperator = {};
      this.previousParticipantsDataByOperator = {};
    },

    loadAvatarCache() {
      try {
        const cached = localStorage.getItem('validator-avatars');
        if (cached) this.avatars = JSON.parse(cached);
      } catch (err) {
        console.error('Error loading avatar cache:', err);
      }
    },
    saveAvatarCache() {
      try {
        localStorage.setItem('validator-avatars', JSON.stringify(this.avatars));
      } catch (err) {
        console.error('Error saving avatar cache:', err);
      }
    },

    async fetchParticipantsTotalsData() {
      try {
        this.loading = true;
        this.error = null;
        if (!this.blockchain.endpoint.address) throw new Error('No blockchain endpoint configured');
        const response = await fetch(`${this.blockchain.endpoint.address}/productscience/inference/inference/participants_stats`);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        this.participantsTotalsData = data.participants_stats || [];
      } catch (err: any) {
        console.error('Error fetching participants stats:', err);
        this.error = err?.message || 'Failed to fetch participants stats';
        this.participantsTotalsData = [];
      } finally {
        this.loading = false;
      }
    },

    async fetchParticipantsCount() {
      try {
        this.loading = true;
        this.error = null;
        if (!this.blockchain.endpoint.address) throw new Error('No blockchain endpoint configured');
        const response = await fetch(`${this.blockchain.endpoint.address}/productscience/inference/inference/participants/count`);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        this.participantsCount = data.total || '0';
      } catch (err: any) {
        console.error('Error fetching participants count:', err);
        this.error = err?.message || 'Failed to fetch participants count';
        this.participantsCount = '0';
      } finally {
        this.loading = false;
      }
    },

    async fetchParticipantsStakingData() {
      try {
        this.loading = true;
        this.error = null;
        if (!this.blockchain.rpc) throw new Error('RPC client not available');
        const response = await this.blockchain.rpc.getStakingValidators('', 1000);
        this.participantsStakingData = response.validators || [];
        const total = this.participantsStakingData.reduce((sum, v) => sum + Number(v.tokens || 0), 0);
        this.totalPower = total.toString();
      } catch (err: any) {
        console.error('Error fetching validators:', err);
        this.error = err?.message || 'Failed to fetch validators';
        this.participantsStakingData = [];
      } finally {
        this.loading = false;
      }
    },

    async fetchCurrentEpochParticipants() {
      try {
        const data = await this.blockchain.getCurrentEpochParticipants();
        const list: any[] = data?.active_participants?.participants || [];
        const weights: Record<string, number> = {};
        const modelsMap: Record<string, string[]> = {};
        const participantsMapLocal: Record<string, Participant> = {};

        for (const p of list) {
          const accountAddress = String(p?.index || '');
          if (!accountAddress) continue;
          const operatorAddress = this.accountToOperatorMap[accountAddress] || '';
          if (!operatorAddress) continue;
          const w = Number(p?.weight ?? 0);
          weights[operatorAddress] = Number.isFinite(w) && w > 0 ? w : 0;
          const ms = Array.isArray(p?.models) ? p.models.map((m: any) => String(m)) : [];
          modelsMap[operatorAddress] = ms;
          participantsMapLocal[operatorAddress] = p as Participant;
        }

        this.pocWeights = weights;
        this.pocModels = modelsMap;
        this.participantsDataByOperator = participantsMapLocal;
      } catch (err) {
        console.error('Error fetching current epoch participants:', err);
        this.pocWeights = {};
        this.pocModels = {};
        this.participantsDataByOperator = {};
      }
    },

    async fetchPreviousEpochParticipants() {
      try {
        if (!this.blockchain.currentEpochIndex) {
          await this.blockchain.fetchLatestEpochInfo();
        }
        const currentIdx = Number(this.blockchain.currentEpochIndex || 0);
        const prevIdx = currentIdx > 1 ? currentIdx - 1 : 0;
        if (prevIdx <= 0) {
          this.previousParticipantsDataByOperator = {};
          return;
        }
        const data = await this.blockchain.inferenceApiRequest(`/v1/epochs/${prevIdx}/participants`);
        const list: any[] = data?.participants?.participants || data?.active_participants?.participants || [];
        const participantsMapLocal: Record<string, Participant> = {};
        for (const p of list) {
          const accountAddress = String(p?.index || '');
          if (!accountAddress) continue;
          const operatorAddress = this.accountToOperatorMap[accountAddress] || '';
          if (!operatorAddress) continue;
          participantsMapLocal[operatorAddress] = p as Participant;
        }
        this.previousParticipantsDataByOperator = participantsMapLocal;
      } catch (err) {
        console.error('Error fetching previous epoch participants:', err);
        this.previousParticipantsDataByOperator = {};
      }
    },

    /**
     * Fetch and cache all epoch performance summary data from chain API.
     * Endpoint: /productscience/inference/inference/epoch_performance_summary
     *
     * We currently cannot query a single epoch directly, so we load everything
     * (with a very large pagination.limit) and then filter locally per epoch.
     */
    async fetchAllEpochPerformanceSummary() {
      try {
        if (!this.blockchain.endpoint.address) throw new Error('No blockchain endpoint configured');

        const baseUrl = `${this.blockchain.endpoint.address}/productscience/inference/inference/epoch_performance_summary`;
        const limit = 100000;

        const epochPerformance: Record<number, Record<string, EpochPerformanceStats>> = {};

        let nextKey: string | null = null;
        let page = 0;

        do {
          page += 1;
          const queryParts = [`pagination.limit=${limit}`];
          if (nextKey) {
            queryParts.push(`pagination.key=${encodeURIComponent(nextKey)}`);
          }
          const url = `${baseUrl}?${queryParts.join('&')}`;
          // Use plain fetch instead of Cosmos client; response shape is simple
          const resp = await fetch(url);
          if (!resp.ok) {
            throw new Error(`HTTP error when fetching epoch_performance_summary page ${page}: ${resp.status}`);
          }
          const data: EpochPerformanceSummaryResponse = await resp.json();

          const items = data.epochPerformanceSummary || [];
          for (const item of items) {
            const epoch = Number(item.epoch_index || 0);
            const participant = String(item.participant_id || '');
            if (!epoch || !participant) continue;

            const operatorAddress = this.accountToOperatorMap[participant];
            if (!operatorAddress) continue; // skip non-validator participants

            if (!epochPerformance[epoch]) {
              epochPerformance[epoch] = {};
            }
            if (!epochPerformance[epoch][operatorAddress]) {
              epochPerformance[epoch][operatorAddress] = {
                inference_count: 0,
                missed_requests: 0,
              };
            }

            const stats = epochPerformance[epoch][operatorAddress];
            const inf = Number(item.inference_count || '0');
            const missed = Number(item.missed_requests || '0');
            if (Number.isFinite(inf) && inf > 0) {
              stats.inference_count += inf;
            }
            if (Number.isFinite(missed) && missed > 0) {
              stats.missed_requests += missed;
            }
          }

          nextKey = data.pagination?.next_key ?? null;
        } while (nextKey);

        this.epochPerformanceByEpoch = epochPerformance;
        console.log('[ValidatorStore] Loaded epoch performance summary for epochs:', Object.keys(epochPerformance));
      } catch (err) {
        console.error('Error fetching epoch performance summary:', err);
        // Keep existing cache on error; do not overwrite with empty object
      }
    },

    async fetchEpochParticipants(epochIndex: number) {
      console.log('fetchEpochParticipants', epochIndex);
      try {
        // Check cache first
        if (this.epochDataCache[epochIndex]) {
          return this.epochDataCache[epochIndex];
        }

        console.log('fetching epoch participants', epochIndex);
        // 1. Fetch Participants List (Existing logic)
        const data = await this.blockchain.inferenceApiRequest(`/v1/epochs/${epochIndex}/participants`);
        const list: any[] = data?.participants?.participants || data?.active_participants?.participants || [];
        
        console.log('fetching epoch data', epochIndex);
        // 2. Fetch Epoch Group Data (New logic for accurate weights)
        let groupData: EpochGroupData | null = null;
        try {
          // Use Chain API endpoint (endpoint.address) instead of Inference API
          const chainApiUrl = this.blockchain.endpoint.address;
          if (chainApiUrl) {
            groupData = await get(`${chainApiUrl}/productscience/inference/inference/epoch_group_data/${epochIndex}`);
          } else {
            console.warn('Chain API endpoint not configured');
          }
        } catch (e) {
          console.warn(`Failed to fetch epoch_group_data for epoch ${epochIndex}, falling back to basic weights`, e);
        }

        const weights: Record<string, number> = {}; // Stores Effective Weight
        const initialWeights: Record<string, number> = {}; // Stores Initial/API Weight for comparison
        const cappedWeights: Record<string, number> = {};
        const modelsMap: Record<string, string[]> = {};
        const participantsMapLocal: Record<string, Participant> = {};

        // Process participants
        for (const p of list) {
          const accountAddress = String(p?.index || '');
          if (!accountAddress) continue;
          const operatorAddress = this.accountToOperatorMap[accountAddress] || '';
          if (!operatorAddress) continue;
          
          // Basic processing
          const ms = Array.isArray(p?.models) ? p.models.map((m: any) => String(m)) : [];
          modelsMap[operatorAddress] = ms;
          participantsMapLocal[operatorAddress] = p as Participant;
          
          // Default to API provided weight if group data calculation fails
          let effectiveWeight = Number(p?.weight ?? 0);
          if (effectiveWeight < 0) effectiveWeight = 0;
          weights[operatorAddress] = effectiveWeight;
          initialWeights[operatorAddress] = effectiveWeight;
        }

        // 3. Calculate Effective Weights if group data exists
        if (groupData && groupData.validation_weights) {
          console.debug(`Epoch ${epochIndex}: Fetched ${groupData.validation_weights.length} validation weights`);
          for (const vw of groupData.validation_weights) {
            const memberAddress = vw.member_address;
            const operatorAddress = this.accountToOperatorMap[memberAddress];
            
            if (!operatorAddress || !participantsMapLocal[operatorAddress]) continue;

            let preservedWeight = 0;
            if (vw.ml_nodes) {
              for (const node of vw.ml_nodes) {
                // Check if timeslot_allocation[1] is true (POC_SLOT)
                // The API returns boolean array, ensuring we access safely
                if (node.timeslot_allocation && node.timeslot_allocation.length > 1 && node.timeslot_allocation[1]) {
                  preservedWeight += Number(node.poc_weight || 0);
                }
              }
            }
            
            const confirmationWeight = Number(vw.confirmation_weight || 0);
            const totalEffective = preservedWeight + confirmationWeight;
            
            // Update the weight with our calculated effective weight
            weights[operatorAddress] = totalEffective;
            // Store in participant object for reference
            participantsMapLocal[operatorAddress].effective_weight = totalEffective;
          }
        } else {
          console.warn(`Epoch ${epochIndex}: No validation_weights found in group data`);
        }

        // 4. Apply Power Capping (30% Rule)
        // Create array for sorting: { op: string, weight: number }
        let participantsForCapping = Object.entries(weights)
          .map(([op, w]) => ({ op, weight: w }))
          .filter(p => p.weight > 0);
          
        const numParticipants = participantsForCapping.length;
        
        // Determine cap percentage
        let capPercentage = 0.30; // Standard 30%
        if (numParticipants === 1) capPercentage = 1.0;
        else if (numParticipants === 2) capPercentage = 0.5;
        else if (numParticipants === 3) capPercentage = 0.4;

        // Iterative capping algorithm
        // We simulate the "finding a fixed point" by iteratively capping highest weights
        // until no weight exceeds the cap of the NEW total.
        // A simplified robust approach is to just run the reduction loop until stable.
        
        // Deep copy for calculation
        let currentWeights = participantsForCapping.map(p => ({ ...p }));
        let stable = false;
        let iterations = 0;
        
        while (!stable && iterations < 20) {
          stable = true;
          const totalWeight = currentWeights.reduce((sum, p) => sum + p.weight, 0);
          
          if (totalWeight > 0) {
            const capAmount = totalWeight * capPercentage;
            
            for (let i = 0; i < currentWeights.length; i++) {
              if (currentWeights[i].weight > capAmount + 0.0001) { // epsilon for float comparison
                currentWeights[i].weight = capAmount;
                stable = false; // If we changed any weight, total changed, so we must re-check
              }
            }
          }
          iterations++;
        }

        console.log('participants capped weights', currentWeights);
        // Store result in cappedWeights
        for (const p of currentWeights) {
          cappedWeights[p.op] = p.weight;
          if (participantsMapLocal[p.op]) {
            participantsMapLocal[p.op].capped_weight = p.weight;
            // Log debug info for weight calculations
            const initial = initialWeights[p.op];
            const effective = weights[p.op];
            const capped = p.weight;
            console.info(`Validator ${p.op}: Initial=${initial} -> Effective=${effective} -> Capped=${capped}`);
          }
        }

        // Cache the data
        this.epochDataCache[epochIndex] = {
          participants: participantsMapLocal,
          weights,
          cappedWeights,
          models: modelsMap,
        };

        return this.epochDataCache[epochIndex];
      } catch (err) {
        console.error(`Error fetching epoch ${epochIndex} participants:`, err);
        return {
          participants: {},
          weights: {},
          cappedWeights: {},
          models: {},
        };
      }
    },

    setSelectedEpoch(epochIndex: number | null) {
      this.selectedEpochIndex = epochIndex;
    },

    async fetchClaimedAmounts(epochIndex: number, operatorAddresses: string[]) {
      try {
        // Check cache first
        if (this.claimedAmountsCache[epochIndex]) {
          return this.claimedAmountsCache[epochIndex];
        }

        // We'll compute and log the height range where we search for claimed rewards

        // Import epoch calculator
        const { calculateEpochStages } = await import('@/libs/epochCalculator');
        const nextEpochStages = calculateEpochStages(epochIndex + 1);
        
        // Query transactions between selected epoch's claim_money and next epoch's poc_start
        const claimStart = nextEpochStages.claim_money;
        const claimEnd = nextEpochStages.next_poc_start;
        const queryBase = `tx.height >= ${claimStart} AND tx.height <= ${claimEnd} AND vest_reward.vesting_epochs='180'`;

        // Store and log the claimed-reward tx search height range for debugging
        this.lastClaimSearchRange = {
          epochIndex,
          minHeight: Number(claimStart),
          maxHeight: Number(claimEnd),
        };
        console.log(
          `[ValidatorStore] Claimed-reward tx search height range for epoch ${epochIndex}: [` +
          `${this.lastClaimSearchRange.minHeight} .. ${this.lastClaimSearchRange.maxHeight}]`
        );
        
        // Prepare data structures for incremental processing
        const claimedData: Record<string, { total: bigint; details: string[] }> = {};
        const accountToOperator = this.accountToOperatorMap;
        
        let page = 1;
        const limit = 100;
        let totalCount = 0;
        let hasMore = true;
        let fetchedCount = 0;
        
        while (hasMore) {
          const query = `?query=${encodeURIComponent(queryBase)}&limit=${limit}&page=${page}`;
          const response = await this.blockchain.rpc.getTxs(query, {}, undefined);
          
          const txResponses = response.tx_responses || [];
          
          if (page === 1) {
            const responseAny = response as any;
            totalCount = Number(responseAny.total || response.pagination?.total || '0');
          }
          
          if (txResponses.length > 0) {
            fetchedCount += txResponses.length;
            
            // Process THIS page's transactions immediately
            for (const txResponse of txResponses) {
              if (!txResponse?.events || !Array.isArray(txResponse.events)) continue;
              
              const vestRewardEvents = txResponse.events.filter((evt: any) => 
                evt.type === 'vest_reward'
              );
              
              for (const vestRewardEvent of vestRewardEvents) {
                if (!vestRewardEvent.attributes || !Array.isArray(vestRewardEvent.attributes)) continue;
                
                let participantValue = '';
                let amountValue = '';
                
                for (const attr of vestRewardEvent.attributes) {
                  const key = String(attr.key || '');
                  const value = String(attr.value || '');
                  if (key === 'participant') participantValue = value;
                  else if (key === 'amount') amountValue = value;
                }
                
                if (!participantValue || !amountValue) continue;
                
                const operatorAddress = accountToOperator[participantValue] || '';
                if (!operatorAddress || !operatorAddresses.includes(operatorAddress)) continue;
                
                if (!claimedData[operatorAddress]) {
                  claimedData[operatorAddress] = { total: BigInt(0), details: [] };
                }

                const amounts = amountValue.split(',').map(a => a.trim()).filter(Boolean);
                for (const amtStr of amounts) {
                  const match = amtStr.match(/^(\d+)([a-zA-Z][\w\/-]*)$/);
                  if (match) {
                    const amt = match[1];
                    const denom = match[2];
                    claimedData[operatorAddress].total += BigInt(amt);
                    const formatted = this.format.formatToken({ amount: amt, denom }, true, '0,0.[00]');
                    claimedData[operatorAddress].details.push(formatted);
                  } else {
                    claimedData[operatorAddress].details.push(amtStr);
                  }
                }
              }
            }

            // Update cache incrementally
            const result: Record<string, { total: string; details: string }> = {};
            for (const [op, data] of Object.entries(claimedData)) {
              result[op] = {
                total: data.total.toString(),
                details: data.details.join(' + ')
              };
            }
            this.claimedAmountsCache[epochIndex] = result;

            page++;
            hasMore = fetchedCount < totalCount && txResponses.length === limit;
          } else {
            hasMore = false;
          }
        }

        return this.claimedAmountsCache[epochIndex] || {};
      } catch (err) {
        console.error(`Error fetching claimed amounts for epoch ${epochIndex}:`, err);
        return {};
      }
    },

    getClaimedAmount(operatorAddress: string): string {
      if (this.selectedEpochIndex === null) return '0';
      const claimed = this.claimedAmountsCache[this.selectedEpochIndex];
      return claimed?.[operatorAddress]?.total || '0';
    },

    getClaimedDetails(operatorAddress: string): string {
      if (this.selectedEpochIndex === null) return '';
      const claimed = this.claimedAmountsCache[this.selectedEpochIndex];
      return claimed?.[operatorAddress]?.details || '';
    },

    async fetchUnbondingValidators() {
      try {
        if (!this.blockchain.rpc) throw new Error('RPC client not available');
        const response = await this.blockchain.rpc.getStakingValidators('BOND_STATUS_UNBONDING', 500);
        return response.validators || [];
      } catch (err) {
        console.error('Error fetching unbonding validators:', err);
        return [];
      }
    },

    async fetchInactiveValidators() {
      try {
        if (!this.blockchain.rpc) throw new Error('RPC client not available');
        const response = await this.blockchain.rpc.getStakingValidators('BOND_STATUS_UNBONDED', 500);
        return response.validators || [];
      } catch (err) {
        console.error('Error fetching inactive validators:', err);
        return [];
      }
    },

    async fetchValidator(validatorAddress: string) {
      try {
        if (!this.blockchain.rpc) throw new Error('RPC client not available');
        const response = await this.blockchain.rpc.getStakingValidator(validatorAddress);
        return response.validator;
      } catch (err) {
        console.error('Error fetching validator:', err);
        return null;
      }
    },

    async usernameToKeySuffix(username: string): Promise<string | null> {
      try {
        const response = await fetch(`https://keybase.io/_/api/1.0/user/lookup.json?username=${username}&fields=public_keys`);
        const data = await response.json();
        if (data.status?.code === 0 && data.them?.public_keys?.pgp_public_keys?.length > 0) {
          const pgpKey = data.them.public_keys.pgp_public_keys[0];
          const fingerprint = pgpKey.key_fingerprint;
          return fingerprint.slice(-16);
        }
        return null;
      } catch (err) {
        console.error(`Error converting username ${username} to key suffix:`, err);
        return null;
      }
    },

    async fetchAvatar(keySuffix: string): Promise<string | null> {
      if (!keySuffix) return null;
      if (this.avatars[keySuffix]) return this.avatars[keySuffix];
      if (this.avatarLoading[keySuffix]) return null;
      this.avatarLoading[keySuffix] = true;
      this.avatarErrors[keySuffix] = '';
      try {
        const avatarResponse = await fetch(`https://keybase.io/_/api/1.0/user/lookup.json?key_suffix=${keySuffix}&fields=pictures`);
        const avatarData = await avatarResponse.json();
        if (avatarData.status?.code === 0 && avatarData.them?.length > 0) {
          const avatarUrl = avatarData.them[0]?.pictures?.primary?.url;
          if (avatarUrl) {
            this.avatars[keySuffix] = avatarUrl;
            this.saveAvatarCache();
            return avatarUrl;
          }
        }
        throw new Error('No avatar found');
      } catch (err: any) {
        const errorMsg = err?.message || 'Unknown error';
        this.avatarErrors[keySuffix] = errorMsg;
        console.error(`Error fetching avatar for key_suffix ${keySuffix}:`, err);
        return null;
      } finally {
        this.avatarLoading[keySuffix] = false;
      }
    },

    async loadAllAvatars() {
      const keySuffixes = this.participantsStakingData
        .map((v) => v.description?.identity)
        .filter((keySuffix): keySuffix is string => !!keySuffix && !this.avatars[keySuffix] && !this.avatarLoading[keySuffix]);
      if (keySuffixes.length === 0) return;
      const batchSize = 5;
      for (let i = 0; i < keySuffixes.length; i += batchSize) {
        const batch = keySuffixes.slice(i, i + batchSize);
        await Promise.all(batch.map((k) => this.fetchAvatar(k)));
        if (i + batchSize < keySuffixes.length) await new Promise((r) => setTimeout(r, 100));
      }
    },

    getAvatarUrl(keySuffix?: string): string {
      if (!keySuffix || !this.avatars[keySuffix]) return '';
      return this.avatars[keySuffix];
    },
    isAvatarLoading(keySuffix?: string): boolean {
      return !!(keySuffix && this.avatarLoading[keySuffix]);
    },
    getAvatarError(keySuffix?: string): string {
      return keySuffix ? this.avatarErrors[keySuffix] || '' : '';
    },

    async keybase(identity: string) {
      try {
        const response = await fetch(`https://keybase.io/_/api/1.0/user/lookup.json?key_suffix=${identity}&fields=pictures`);
        return await response.json();
      } catch (err) {
        console.error('Error fetching keybase data:', err);
        return { them: [] };
      }
    },

    async fetchParticipantByAddress(address: string) {
      try {
        if (!this.blockchain.endpoint.address) throw new Error('No blockchain endpoint configured');
        const response = await fetch(`${this.blockchain.endpoint.address}/productscience/inference/inference/participant/${address}`);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        return data?.participant ?? null;
      } catch (err) {
        console.error('Error fetching participant by address:', address, err);
        return null;
      }
    },

    async logAllParticipantsFullData() {
      try {
        const addresses = (this.participantsTotalsData || [])
          .map((p) => p.account_address)
          .filter((a): a is string => typeof a === 'string' && a.length > 0);
        await Promise.all(
          addresses.map(async (addr) => {
            const participant = await this.fetchParticipantByAddress(addr);
            if (participant) console.log('[participant]', addr, participant);
            else console.log('[participant] not found', addr);
          })
        );
      } catch (err) {
        console.error('Error logging full participants data:', err);
      }
    },

    async init() {
      if (this.initialized) return;
      if ((this as any)._initPromise) {
        await (this as any)._initPromise;
        return;
      }
      (this as any)._initPromise = (async () => {
        try {
          await Promise.all([
            this.fetchParticipantsStakingData(),
            this.fetchParticipantsTotalsData(),
            this.fetchParticipantsCount(),
          ]);
          await this.fetchCurrentEpochParticipants();
          await this.blockchain.fetchLatestEpochInfo();
          await this.fetchPreviousEpochParticipants();
          await this.loadAllAvatars();
          // Load full epoch performance summary once and cache it locally.
          // This is a heavy call but required until a per-epoch query is available.
          await this.fetchAllEpochPerformanceSummary();
        } finally {
          this.initialized = true;
          (this as any)._initPromise = null;
        }
      })();
      await (this as any)._initPromise;
    },
  },
});


