/**
 * Epoch Calculator Utility
 * 
 * Calculates epoch stages for any epoch index based on epoch parameters.
 * Handles parameter changes that occurred at block 223932.
 */

export interface EpochParams {
  epoch_length: number;
  epoch_multiplier: number;
  epoch_shift: number;
  default_unit_of_compute_price: number;
  poc_stage_duration: number;
  poc_exchange_duration: number;
  poc_validation_delay: number;
  poc_validation_duration: number;
  set_new_validators_delay: number;
  inference_validation_cutoff: number; // block offset before next_poc_start
  inference_pruning_epoch_threshold?: number;
  inference_pruning_max?: number;
  poc_pruning_max?: number;
  poc_slot_allocation?: {
    value: number;
    exponent: number;
  };
}

export interface EpochStages {
  epoch_index: number;
  poc_start: number;
  poc_generation_wind_down: number;
  poc_generation_end: number;
  poc_validation_start: number;
  poc_validation_wind_down: number;
  poc_validation_end: number;
  set_new_validators: number;
  claim_money: number;
  inference_validation_cutoff: number;
  next_poc_start: number;
  poc_exchange_window: {
    start: number;
    end: number;
  };
  poc_validation_exchange_window: {
    start: number;
    end: number;
  };
}

// Genesis epoch parameters (before block 223932)
const GENESIS_EPOCH_PARAMS: EpochParams = {
  epoch_length: 17280,
  epoch_multiplier: 1,
  epoch_shift: 16980,
  default_unit_of_compute_price: 100,
  poc_stage_duration: 60,
  poc_exchange_duration: 5,
  poc_validation_delay: 5,
  poc_validation_duration: 20,
  set_new_validators_delay: 120,
  inference_validation_cutoff: 80,
  inference_pruning_epoch_threshold: 2,
};

// Updated epoch parameters (active after block 223932's epoch)
const UPDATED_EPOCH_PARAMS: EpochParams = {
  epoch_length: 15391,
  epoch_multiplier: 1,
  epoch_shift: 16980, // Note: This parameter wasn't updated on-chain, creating a drift
  default_unit_of_compute_price: 100,
  poc_stage_duration: 60,
  poc_exchange_duration: 5,
  poc_validation_delay: 5,
  poc_validation_duration: 120,
  set_new_validators_delay: 120,
  inference_validation_cutoff: 80,
  inference_pruning_epoch_threshold: 2,
  inference_pruning_max: 0,
  poc_pruning_max: 0,
};

// Effective shift for the current era to align with the grid
// Calculated as: poc_start_91 - (90 * 15391) = 1411936 - 1385190 = 26746
const CURRENT_ERA_SHIFT = 26746;
const CURRENT_ERA_START_EPOCH = 15; // Safe boundary where new shift definitely applies

// Block height where parameter change proposal was submitted
const PARAM_CHANGE_BLOCK = 223932;

/**
 * Calculate which epoch a given block height belongs to
 */
export function calculateEpochIndex(blockHeight: number, params: EpochParams): number {
  // Use the Current Era formula for blocks that are clearly in the new era
  // Check if block is roughly past the transition zone (e.g. > block 250,000)
  if (blockHeight > 250000) {
    // Formula: floor((block - current_shift) / new_length) + 1
    return Math.floor((blockHeight - CURRENT_ERA_SHIFT) / UPDATED_EPOCH_PARAMS.epoch_length) + 1;
  }

  // Genesis era calculation
  // Epoch index calculation: floor((block_height - epoch_shift) / epoch_length) + 1
  // But we need to handle the case where block_height < epoch_shift
  if (blockHeight < params.epoch_shift) {
    return 1; // First epoch starts at epoch_shift
  }
  return Math.floor((blockHeight - params.epoch_shift) / params.epoch_length) + 1;
}

/**
 * Calculate the PoC start block height for a given epoch index
 * Uses the effective shift for the current era
 */
export function calculatePocStart(epochIndex: number, params: EpochParams): number {
  // For current era, use the calculated effective shift
  if (epochIndex >= CURRENT_ERA_START_EPOCH) {
    return CURRENT_ERA_SHIFT + (epochIndex - 1) * UPDATED_EPOCH_PARAMS.epoch_length;
  }
  
  // For epochs before the reference, work backwards
  // First, determine which epoch had the parameter change
  // The param change proposal was submitted at block 223932
  // Calculate which epoch that block belongs to with old params
  const paramChangeEpochWithOldParams = calculateEpochIndex(PARAM_CHANGE_BLOCK, GENESIS_EPOCH_PARAMS);
  // New params become active with the next epoch
  const firstEpochWithNewParams = paramChangeEpochWithOldParams + 1;
  
  // If target epoch is before param change, use genesis params
  if (epochIndex < firstEpochWithNewParams) {
    return GENESIS_EPOCH_PARAMS.epoch_shift + (epochIndex - 1) * GENESIS_EPOCH_PARAMS.epoch_length;
  }
  
  // For the transition epochs (between param change and stable era), calculated via offset
  // This handles the "messy middle" between Epoch 13 and 15
  // We'll anchor from the stable era start
  const stableStart = CURRENT_ERA_SHIFT + (CURRENT_ERA_START_EPOCH - 1) * UPDATED_EPOCH_PARAMS.epoch_length;
  const epochsBack = CURRENT_ERA_START_EPOCH - epochIndex;
  return stableStart - epochsBack * UPDATED_EPOCH_PARAMS.epoch_length;
}

/**
 * Get epoch parameters for a given epoch index
 * Handles the parameter change that occurred around block 223932
 */
export function getEpochParamsForEpoch(epochIndex: number): EpochParams {
  // Calculate which epoch block 223932 belongs to with genesis params
  const paramChangeEpoch = calculateEpochIndex(PARAM_CHANGE_BLOCK, GENESIS_EPOCH_PARAMS);
  
  // The new params become active with the next epoch after the param change epoch
  const firstEpochWithNewParams = paramChangeEpoch + 1;
  
  // Use updated params if epoch is >= firstEpochWithNewParams, otherwise use genesis params
  return epochIndex >= firstEpochWithNewParams ? UPDATED_EPOCH_PARAMS : GENESIS_EPOCH_PARAMS;
}

/**
 * Calculate all epoch stages for a given epoch index
 */
export function calculateEpochStages(epochIndex: number): EpochStages {
  const params = getEpochParamsForEpoch(epochIndex);
  
  // Calculate PoC start block height
  const pocStart = calculatePocStart(epochIndex, params);
  
  // Calculate generation phase
  const pocGenerationEnd = pocStart + params.poc_stage_duration;
  const pocGenerationWindDown = pocGenerationEnd - 12; // Based on API response pattern
  
  // Calculate validation phase
  const pocValidationStart = pocGenerationEnd + params.poc_validation_delay;
  const pocValidationEnd = pocValidationStart + params.poc_validation_duration;
  const pocValidationWindDown = pocValidationEnd - 24; // Based on API response pattern
  
  // Calculate validator selection phase
  const setNewValidators = pocValidationEnd + params.set_new_validators_delay;
  const claimMoney = setNewValidators + 1;
  
  // Calculate next epoch start
  const nextPocStart = pocStart + params.epoch_length;
  
  // Calculate inference validation cutoff
  // This is a block offset before next_poc_start (not a percentage)
  const inferenceValidationCutoff = nextPocStart - params.inference_validation_cutoff;
  
  // Calculate exchange windows
  const pocExchangeWindow = {
    start: pocStart + 1,
    end: pocValidationStart,
  };
  
  const pocValidationExchangeWindow = {
    start: pocValidationStart + 1,
    end: pocValidationEnd,
  };
  
  return {
    epoch_index: epochIndex,
    poc_start: pocStart,
    poc_generation_wind_down: pocGenerationWindDown,
    poc_generation_end: pocGenerationEnd,
    poc_validation_start: pocValidationStart,
    poc_validation_wind_down: pocValidationWindDown,
    poc_validation_end: pocValidationEnd,
    set_new_validators: setNewValidators,
    claim_money: claimMoney,
    inference_validation_cutoff: inferenceValidationCutoff,
    next_poc_start: nextPocStart,
    poc_exchange_window: pocExchangeWindow,
    poc_validation_exchange_window: pocValidationExchangeWindow,
  };
}

/**
 * Calculate epoch stages for a given block height
 */
export function calculateEpochStagesForBlock(blockHeight: number): EpochStages | null {
  if (blockHeight < GENESIS_EPOCH_PARAMS.epoch_shift) {
    return null; // Before first epoch
  }
  
  // Determine which epoch this block belongs to
  let epochIndex: number;
  
  // Use simplified logic for Current Era (> block 250k)
  if (blockHeight > 250000) {
    epochIndex = calculateEpochIndex(blockHeight, UPDATED_EPOCH_PARAMS);
  } else {
    // Legacy logic for early chain history
    epochIndex = calculateEpochIndex(blockHeight, GENESIS_EPOCH_PARAMS);
  }
  
  // Verify and adjust if we landed on a boundary
  let stages = calculateEpochStages(epochIndex);
  
  // Boundary check: if block is before this epoch's start, move to previous
  while (blockHeight < stages.poc_start && epochIndex > 1) {
    epochIndex--;
    stages = calculateEpochStages(epochIndex);
  }
  
  // Boundary check: if block is after this epoch's end (next start), move to next
  while (blockHeight >= stages.next_poc_start) {
    epochIndex++;
    stages = calculateEpochStages(epochIndex);
  }
  
  return stages;
}

/**
 * Get current phase for a given block height
 */
export function getPhaseForBlock(blockHeight: number): {
  phase: 'Inference' | 'PoC Generation' | 'PoC Validation' | 'Selecting Validators' | 'Waiting for Next Epoch';
  epochStages: EpochStages | null;
} {
  const epochStages = calculateEpochStagesForBlock(blockHeight);
  
  if (!epochStages) {
    return { phase: 'Inference', epochStages: null };
  }
  
  if (blockHeight >= epochStages.poc_start && blockHeight < epochStages.poc_generation_end) {
    return { phase: 'PoC Generation', epochStages };
  }
  
  if (blockHeight >= epochStages.poc_validation_start && blockHeight < epochStages.poc_validation_end) {
    return { phase: 'PoC Validation', epochStages };
  }
  
  if (blockHeight >= epochStages.poc_validation_end && blockHeight < epochStages.set_new_validators) {
    return { phase: 'Selecting Validators', epochStages };
  }
  
  if (blockHeight >= epochStages.set_new_validators && blockHeight < epochStages.next_poc_start) {
    return { phase: 'Waiting for Next Epoch', epochStages };
  }
  
  return { phase: 'Inference', epochStages };
}

