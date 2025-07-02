import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useBlockchain } from './useBlockchain';

export interface InferenceStats {
  ai_tokens: string;
  inferences: number;
  actual_inferences_cost: string;
}

export interface ModelData {
  proposed_by: string;
  id: string;
  units_of_compute_per_token: string;
  context_window: string;
  quantization: string;
  coins_per_input_token: string;
  coins_per_output_token: string;
}

export const useInferenceStore = defineStore('inferenceStore', () => {
  const blockchain = useBlockchain();
  
  // State
  const stats24h = ref<InferenceStats>({
    ai_tokens: '0',
    inferences: 0,
    actual_inferences_cost: '0'
  });
  
  const stats7d = ref<InferenceStats>({
    ai_tokens: '0',
    inferences: 0,
    actual_inferences_cost: '0'
  });
  
  const models = ref<ModelData[]>([]);
  
  const loading = ref(false);
  const error = ref<string | null>(null);

  // Getters with loading/error handling
  const displayInferencesToday = computed(() => {
    if (loading.value) return '...';
    if (error.value) return 'Error';
    return stats24h.value.inferences.toLocaleString() || '0';
  });

  const displayInferencesLastWeek = computed(() => {
    if (loading.value) return '...';
    if (error.value) return 'Error';
    return stats7d.value.inferences.toLocaleString() || '0';
  });

  const displayAiTokensToday = computed(() => {
    if (loading.value) return '...';
    if (error.value) return 'Error';
    return parseInt(stats24h.value.ai_tokens).toLocaleString() || '0';
  });

  const displayAiTokensLastWeek = computed(() => {
    if (loading.value) return '...';
    if (error.value) return 'Error';
    return parseInt(stats7d.value.ai_tokens).toLocaleString() || '0';
  });

  const displayCostToday = computed(() => {
    if (loading.value) return '...';
    if (error.value) return 'Error';
    return parseInt(stats24h.value.actual_inferences_cost).toLocaleString() || '0';
  });

  const displayCostLastWeek = computed(() => {
    if (loading.value) return '...';
    if (error.value) return 'Error';
    return parseInt(stats7d.value.actual_inferences_cost).toLocaleString() || '0';
  });

  // Actions
  async function fetchStats24h() {
    try {
      loading.value = true;
      error.value = null;
      
      if (!blockchain.endpoint.address) {
        throw new Error('No blockchain endpoint configured');
      }
      
      const response = await fetch(`${blockchain.endpoint.address}/productscience/inference/inference/all_stats_by_time`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      stats24h.value = {
        ai_tokens: data.ai_tokens || '0',
        inferences: data.inferences || 0,
        actual_inferences_cost: data.actual_inferences_cost || '0'
      };
    } catch (err) {
      console.error('Error fetching 24h inference stats:', err);
      error.value = err instanceof Error ? err.message : 'Failed to fetch 24h inference stats';
      stats24h.value = {
        ai_tokens: '0',
        inferences: 0,
        actual_inferences_cost: '0'
      };
    } finally {
      loading.value = false;
    }
  }

  async function fetchStats7d() {
    try {
      loading.value = true;
      error.value = null;
      
      if (!blockchain.endpoint.address) {
        throw new Error('No blockchain endpoint configured');
      }
      
      // Calculate 7 days ago from now
      const now = Date.now();
      const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
      
      const response = await fetch(
        `${blockchain.endpoint.address}/productscience/inference/inference/all_stats_by_time?time_from=${sevenDaysAgo}&time_to=${now}`
      );
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      stats7d.value = {
        ai_tokens: data.ai_tokens || '0',
        inferences: data.inferences || 0,
        actual_inferences_cost: data.actual_inferences_cost || '0'
      };
    } catch (err) {
      console.error('Error fetching 7-day inference stats:', err);
      error.value = err instanceof Error ? err.message : 'Failed to fetch 7-day inference stats';
      stats7d.value = {
        ai_tokens: '0',
        inferences: 0,
        actual_inferences_cost: '0'
      };
    } finally {
      loading.value = false;
    }
  }

  async function fetchModels() {
    try {
      loading.value = true;
      error.value = null;
      
      if (!blockchain.endpoint.address) {
        throw new Error('No blockchain endpoint configured');
      }
      
      const response = await fetch(`${blockchain.endpoint.address}/productscience/inference/inference/models_all`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      models.value = data.model || [];
    } catch (err) {
      console.error('Error fetching models:', err);
      error.value = err instanceof Error ? err.message : 'Failed to fetch models';
      models.value = [];
    } finally {
      loading.value = false;
    }
  }

  async function init() {
    await Promise.all([
      fetchStats24h(),
      fetchStats7d(),
      fetchModels()
    ]);
  }

  function $reset() {
    stats24h.value = {
      ai_tokens: '0',
      inferences: 0,
      actual_inferences_cost: '0'
    };
    stats7d.value = {
      ai_tokens: '0',
      inferences: 0,
      actual_inferences_cost: '0'
    };
    models.value = [];
    loading.value = false;
    error.value = null;
  }

  return {
    // State
    stats24h,
    stats7d,
    models,
    loading,
    error,
    
    // Getters
    displayInferencesToday,
    displayInferencesLastWeek,
    displayAiTokensToday,
    displayAiTokensLastWeek,
    displayCostToday,
    displayCostLastWeek,
    
    // Actions
    fetchStats24h,
    fetchStats7d,
    fetchModels,
    init,
    $reset,
  };
}); 