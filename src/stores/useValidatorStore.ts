import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useBlockchain } from './useBlockchain';
import { useBaseStore } from './useBaseStore';
import { useFormatter } from './useFormatter';
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

export interface VestingSchedule {
  participant_address: string;
  epoch_amounts: Array<{
    coins: Array<{
      denom: string;
      amount: string;
    }>;
  }>;
}

export const useValidatorStore = defineStore('validatorStore', () => {
  const base = useBaseStore();
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
  // Vesting schedules cache
  const vestingSchedules = ref<Record<string, VestingSchedule>>({});

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
      const baseEarned = parseFloat(stats.earned_coins_current_epoch || "0");
      
      // Get next vesting amount for this validator
      const nextVesting = getNextVestingAmount(validatorAddress);
      
      // Calculate vesting bonus using the formula: ((nextPoC - currentHeight)/epochLength)*nextVesting
      // This represents the proportional vesting amount based on blocks until next PoC
      const currentHeight = Number(base.latest?.block?.header?.height || 0);
      const nextPoC = blockchain.nextPocStart;
      const epochLength = blockchain.epochLength;
      
      let vestingBonus = 0;
      if (nextPoC && epochLength && currentHeight > 0 && nextVesting > 0) {
        const blocksUntilNextPoC = Math.max(0, nextPoC - currentHeight);
        const pocFinalizedPercentage = 1 - (blocksUntilNextPoC / epochLength);

        vestingBonus = pocFinalizedPercentage * nextVesting;
      }
      
      return (baseEarned + vestingBonus).toString();
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

  // Get next vesting amount for a validator
  function getNextVestingAmount(validatorAddress: string): number {
    const stats = getValidatorStats.value(validatorAddress);
    // Check if stats has account_address (it's a real participant, not fallback)
    if (!stats || !('account_address' in stats) || !stats.account_address) return 0;
    
    const vestingSchedule = vestingSchedules.value[stats.account_address];
    if (!vestingSchedule || !vestingSchedule.epoch_amounts || vestingSchedule.epoch_amounts.length === 0) {
      return 0;
    }
    
    // Get the first epoch amount (next vesting)
    const firstEpoch = vestingSchedule.epoch_amounts[0];
    if (!firstEpoch || !firstEpoch.coins || firstEpoch.coins.length === 0) {
      return 0;
    }
    
    // Find the ngonka coin amount
    const ngonkaCoin = firstEpoch.coins.find(coin => coin.denom === 'ngonka');
    return ngonkaCoin ? parseFloat(ngonkaCoin.amount) : 0;
  }

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
    // Format with proper denom - use base denom so formatter can convert to display units
    return useFormatter().formatToken({
      amount: total.toString(),
      denom: blockchain.current?.assets?.[0]?.base || 'ngonka'
    }, true, '0,0'); // Set withDenom to true to show denomination
  });

  const displayTotalEarnedReward = computed(() => {
    if (loading.value) return '...';
    if (error.value) return 'Error';
    
    // Calculate total earned including vesting bonuses for all validators
    const total = validators.value.reduce((sum, validator) => {
      const earnedCoins = getEarnedCoins.value(validator.operator_address);
      return sum + parseFloat(earnedCoins || '0');
    }, 0);
    
    // Format with proper denom - use ngonka to match the vesting amounts
    return useFormatter().formatToken({
      amount: total.toString(),
      denom: 'ngonka'
    }, true, '0,0'); // Set withDenom to true to show denomination
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

  // Fetch full participant data by account address and return the participant object
  async function fetchParticipantByAddress(address: string) {
    try {
      if (!blockchain.endpoint.address) {
        throw new Error('No blockchain endpoint configured');
      }

      const response = await fetch(`${blockchain.endpoint.address}/productscience/inference/inference/participant/${address}`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      return data?.participant ?? null;
    } catch (err) {
      console.error('Error fetching participant by address:', address, err);
      return null;
    }
  }

  // Fetch vesting schedule for a participant
  async function fetchVestingSchedule(address: string) {
    try {
      if (!blockchain.endpoint.address) {
        throw new Error('No blockchain endpoint configured');
      }

      const response = await fetch(`${blockchain.endpoint.address}/productscience/inference/streamvesting/vesting_schedule/${address}`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      return data?.vesting_schedule ?? null;
    } catch (err) {
      console.error('Error fetching vesting schedule for address:', address, err);
      return null;
    }
  }

  // Fetch vesting schedules for all participants
  async function fetchAllVestingSchedules() {
    try {
      const addresses = participantsStats.value
        .map(p => p.account_address)
        .filter((a): a is string => typeof a === 'string' && a.length > 0);

      await Promise.all(addresses.map(async (addr) => {
        const vestingSchedule = await fetchVestingSchedule(addr);
        if (vestingSchedule) {
          vestingSchedules.value[addr] = vestingSchedule;
        }
      }));
    } catch (err) {
      console.error('Error fetching all vesting schedules:', err);
    }
  }

  // Iterate over known participants and log their full data
  async function logAllParticipantsFullData() {
    try {
      const addresses = (participantsStats.value || [])
        .map(p => p.account_address)
        .filter((a): a is string => typeof a === 'string' && a.length > 0);

      await Promise.all(addresses.map(async (addr) => {
        const participant = await fetchParticipantByAddress(addr);
        if (participant) {
          // Log the full participant payload for debugging/inspection
          console.log('[participant]', addr, participant);
        } else {
          console.log('[participant] not found', addr);
        }
      }));
    } catch (err) {
      console.error('Error logging full participants data:', err);
    }
  }

  async function init() {
    await Promise.all([
      fetchValidators(),
      fetchParticipantsStats(),
      fetchParticipantsCount()
    ]);
    // After initial data is loaded, fetch vesting schedules and log full participant data
    await fetchAllVestingSchedules();
    logAllParticipantsFullData();
  }

  function $reset() {
    validators.value = [];
    participantsStats.value = [];
    participantsCount.value = '0';
    totalPower.value = '0';
    loading.value = false;
    error.value = null;
    vestingSchedules.value = {};
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
    fetchParticipantByAddress,
    logAllParticipantsFullData,
    init,
    $reset
  };
}); 