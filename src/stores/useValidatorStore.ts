import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useBlockchain } from './useBlockchain';
import type { Validator } from '@/types';

export interface ParticipantStats {
  account_address: string;
  operator_address: string;
  reputation: number;
  rewarded_coins_current_epoch: string;
  earned_coins_current_epoch: string;
  rewarded_coins_latest_epoch: string;
  epochs_completed: number;
}

export const useValidatorStore = defineStore('validatorStore', () => {
  const blockchain = useBlockchain();
  
  // State
  const validators = ref<Validator[]>([]);
  const participantsStats = ref<ParticipantStats[]>([]);
  const participantsCount = ref('0');
  const totalPower = ref('0');
  const loading = ref(false);
  const error = ref<string | null>(null);
  const params = ref({
    bond_denom: 'ugonka',
    max_validators: 100
  });

  // Getters
  const getValidatorStats = computed(() => {
    return (validatorAddress: string) => {
      const stats = participantsStats.value.find(
        (stat) => stat.operator_address === validatorAddress
      );
      return stats || {
        earned_coins_current_epoch: "0",
        epochs_completed: 0,
        reputation: 0,
        rewarded_coins_current_epoch: "0",
        rewarded_coins_latest_epoch: "0"
      };
    };
  });

  const getEarnedCoins = computed(() => {
    return (validatorAddress: string) => {
      const stats = getValidatorStats.value(validatorAddress);
      return stats.earned_coins_current_epoch || "0";
    };
  });

  const getEpochsCompleted = computed(() => {
    return (validatorAddress: string) => {
      const stats = getValidatorStats.value(validatorAddress);
      return stats.epochs_completed || 0;
    };
  });

  const getReputation = computed(() => {
    return (validatorAddress: string) => {
      const stats = getValidatorStats.value(validatorAddress);
      return stats.reputation || 0;
    };
  });

  const getRewardedCoinsCurrentEpoch = computed(() => {
    return (validatorAddress: string) => {
      const stats = getValidatorStats.value(validatorAddress);
      return stats.rewarded_coins_current_epoch || "0";
    };
  });

  const getRewardedCoinsLatestEpoch = computed(() => {
    return (validatorAddress: string) => {
      const stats = getValidatorStats.value(validatorAddress);
      return stats.rewarded_coins_latest_epoch || "0";
    };
  });

  // Display computed properties with loading/error handling
  const displayParticipantsCount = computed(() => {
    if (loading.value) return '...';
    if (error.value) return 'Error';
    return participantsCount.value || '0';
  });

  const displayActiveProviders = computed(() => {
    if (loading.value) return '...';
    if (error.value) return 'Error';
    return participantsStats.value.length.toString() || '0';
  });

  const displayTotalPower = computed(() => {
    if (loading.value) return '...';
    if (error.value) return 'Error';
    return totalPower.value || '0';
  });

  const displayTotalValidators = computed(() => {
    if (loading.value) return '...';
    if (error.value) return 'Error';
    return validators.value.length.toString() || '0';
  });

  const displayTotalFinalReward = computed(() => {
    if (loading.value) return '...';
    if (error.value) return 'Error';
    const total = participantsStats.value.reduce((sum, participant) => {
      const earned = parseFloat(participant.rewarded_coins_latest_epoch || '0');
      return sum + earned;
    }, 0);
    return total.toString();
  });

  const displayTotalEarnedReward = computed(() => {
    if (loading.value) return '...';
    if (error.value) return 'Error';
    const total = participantsStats.value.reduce((sum, participant) => {
      const earned = parseFloat(participant.earned_coins_current_epoch || '0');
      return sum + earned;
    }, 0);
    return total.toString();
  });

  // Actions
  async function fetchParticipantsStats() {
    try {
      loading.value = true;
      error.value = null;
      
      if (!blockchain.endpoint.address) {
        throw new Error('No blockchain endpoint configured');
      }
      
      const response = await fetch(`${blockchain.endpoint.address}/productscience/inference/inference/participants_stats`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      participantsStats.value = data.participants_stats || [];
    } catch (err) {
      console.error('Error fetching participants stats:', err);
      error.value = err instanceof Error ? err.message : 'Failed to fetch participants stats';
      participantsStats.value = [];
    } finally {
      loading.value = false;
    }
  }

  async function fetchParticipantsCount() {
    try {
      loading.value = true;
      error.value = null;
      
      if (!blockchain.endpoint.address) {
        throw new Error('No blockchain endpoint configured');
      }
      
      const response = await fetch(`${blockchain.endpoint.address}/productscience/inference/inference/participants/count`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      participantsCount.value = data.total || '0';
    } catch (err) {
      console.error('Error fetching participants count:', err);
      error.value = err instanceof Error ? err.message : 'Failed to fetch participants count';
      participantsCount.value = '0';
    } finally {
      loading.value = false;
    }
  }

  async function fetchValidators() {
    try {
      loading.value = true;
      error.value = null;
      
      if (!blockchain.rpc) {
        throw new Error('RPC client not available');
      }

      const response = await blockchain.rpc.getStakingValidators('BOND_STATUS_BONDED', 500);
      validators.value = response.validators || [];
      
      // Calculate total power
      const total = validators.value.reduce((sum, validator) => {
        return sum + Number(validator.tokens || 0);
      }, 0);
      totalPower.value = total.toString();
      
    } catch (err) {
      console.error('Error fetching validators:', err);
      error.value = err instanceof Error ? err.message : 'Failed to fetch validators';
      validators.value = [];
    } finally {
      loading.value = false;
    }
  }

  async function fetchUnbondingValidators() {
    try {
      if (!blockchain.rpc) {
        throw new Error('RPC client not available');
      }
      
      const response = await blockchain.rpc.getStakingValidators('BOND_STATUS_UNBONDING', 500);
      return response.validators || [];
    } catch (err) {
      console.error('Error fetching unbonding validators:', err);
      return [];
    }
  }

  async function fetchInactiveValidators() {
    try {
      if (!blockchain.rpc) {
        throw new Error('RPC client not available');
      }
      
      const response = await blockchain.rpc.getStakingValidators('BOND_STATUS_UNBONDED', 500);
      return response.validators || [];
    } catch (err) {
      console.error('Error fetching inactive validators:', err);
      return [];
    }
  }

  async function fetchValidator(validatorAddress: string) {
    try {
      if (!blockchain.rpc) {
        throw new Error('RPC client not available');
      }
      
      const response = await blockchain.rpc.getStakingValidator(validatorAddress);
      return response.validator;
    } catch (err) {
      console.error('Error fetching validator:', err);
      return null;
    }
  }

  async function keybase(identity: string) {
    try {
      const response = await fetch(`https://keybase.io/_/api/1.0/user/lookup.json?key_suffix=${identity}&fields=pictures`);
      return await response.json();
    } catch (err) {
      console.error('Error fetching keybase data:', err);
      return { them: [] };
    }
  }

  async function init() {
    await Promise.all([
      fetchValidators(),
      fetchParticipantsStats(),
      fetchParticipantsCount()
    ]);
  }

  function $reset() {
    validators.value = [];
    participantsStats.value = [];
    participantsCount.value = '0';
    totalPower.value = '0';
    loading.value = false;
    error.value = null;
  }

  return {
    // State
    validators,
    participantsStats,
    participantsCount,
    totalPower,
    loading,
    error,
    params,
    
    // Getters
    getValidatorStats,
    getEarnedCoins,
    getEpochsCompleted,
    getReputation,
    getRewardedCoinsCurrentEpoch,
    getRewardedCoinsLatestEpoch,
    displayParticipantsCount,
    displayActiveProviders,
    displayTotalPower,
    displayTotalValidators,
    displayTotalFinalReward,
    displayTotalEarnedReward,
    
    // Actions
    fetchParticipantsStats,
    fetchParticipantsCount,
    fetchValidators,
    fetchUnbondingValidators,
    fetchInactiveValidators,
    fetchValidator,
    keybase,
    init,
    $reset
  };
}); 