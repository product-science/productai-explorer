import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useBlockchain } from './useBlockchain';
import { useBaseStore } from './useBaseStore';
import { useFormatter } from './useFormatter';
import { useStakingStore } from './useStakingStore';
import type { Validator } from '@/types';

export interface MlNode {
  node_id: string;
  poc_weight: number;
  timeslot_allocation: boolean[];
}
export interface MlNodeGroup {
  ml_nodes: MlNode[];
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
        return state.participantsDataByOperator[operatorAddress] || null;
      };
    },
    participantsMap(state) {
      return state.participantsDataByOperator;
    },
    previousParticipantsMap(state) {
      return state.previousParticipantsDataByOperator;
    },

    totalPocWeight(state): number {
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
        const response = await this.blockchain.rpc.getStakingValidators('', 500);
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
        } finally {
          this.initialized = true;
          (this as any)._initPromise = null;
        }
      })();
      await (this as any)._initPromise;
    },
  },
});


