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

export interface ModelStatsData {
  model: string;
  ai_tokens: string;
  inferences: number;
}

export interface DailyModelStats {
  date: string;
  timestamp: number;
  stats_models: ModelStatsData[];
  syncedAt?: number; // When this data was fetched/synced
}

export interface ChartSeriesData {
  name: string;
  data: number[];
  color: string;
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

  // New state for 30-day data
  const dailyStats = ref<DailyModelStats[]>([]);
  const chartLoading = ref(false);
  const chartError = ref<string | null>(null);

  // Cache key for localStorage
  const CACHE_KEY = 'inference_30day_cache';
  const CACHE_MODELS_KEY = 'inference_models_cache';

  // Generate consistent color for model based on its name
  function generateModelColor(modelName: string): string {
    const colors = [
      '#bbe81a', '#ff5f0b', '#43ebef', '#1999e5', '#230b2c', '#628be8', 
      '#aa5343', '#c9fa89', '#e88ea8', '#72e4a2', '#38cd87', '#515e13', 
      '#7bf8f5', '#83dd6e', '#e8b203', '#7d11d5', '#3e4927', '#f303e2', 
      '#249493', '#50e5e6', '#11deb2', '#a2f9c7', '#2a7bdc', '#47383a', 
      '#226da4', '#966319', '#1bdf99', '#f3ab0c', '#961f50', '#832efd', 
      '#875287', '#4bebe7', '#1d3d2e', '#9caea4', '#2772f5', '#938bf1', 
      '#6228a5', '#24fea5', '#c9bbc8', '#e27225', '#54bd9f', '#babb2d', 
      '#bcf591', '#803b36', '#124f03'
    ];
    
    // Create hash from model name
    let hash = 0;
    for (let i = 0; i < modelName.length; i++) {
      const char = modelName.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    
    // Use hash to consistently select color
    const colorIndex = Math.abs(hash) % colors.length;
    return colors[colorIndex];
  }

  // Get cached data from localStorage
  function getCachedData(): DailyModelStats[] {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (error) {
      console.error('Error reading cache:', error);
    }
    return [];
  }

  // Save data to localStorage and manage cache size
  function setCachedData(data: DailyModelStats[]) {
    try {
      // Sort by timestamp and keep only last 30 days
      const sortedData = data.sort((a, b) => b.timestamp - a.timestamp);
      const last30Days = sortedData.slice(0, 30);
      
      localStorage.setItem(CACHE_KEY, JSON.stringify(last30Days));
      localStorage.setItem(CACHE_MODELS_KEY, JSON.stringify(Date.now()));
    } catch (error) {
      console.error('Error saving cache:', error);
    }
  }

  // Check if we need to fetch data for a specific day
  function needsFetch(date: string): boolean {
    const today = new Date().toISOString().split('T')[0];
    const cached = getCachedData();
    const cachedItem = cached.find(item => item.date === date);
    
    // If no cached data exists, we need to fetch
    if (!cachedItem) {
      return true;
    }
    
    // Always fetch fresh data for today (it's constantly changing)
    if (date === today) {
      return true;
    }
    
    // Check if cached data was synced today - if so, it might be incomplete for previous days
    if (cachedItem.syncedAt) {
      const syncDate = new Date(cachedItem.syncedAt).toISOString().split('T')[0];
      const currentDate = new Date().toISOString().split('T')[0];
      
      // If data was synced today and it's for yesterday or earlier, resync it
      // (because yesterday's data might have been incomplete when we first fetched it today)
      if (syncDate === currentDate && date < currentDate) {
        const hoursSinceSynced = (Date.now() - cachedItem.syncedAt) / (1000 * 60 * 60);
        
        // Only resync if it's been less than 12 hours since last sync
        // (to avoid constantly refetching old data)
        if (hoursSinceSynced < 12) {
          return true;
        }
      }
    }
    
    // Data exists and doesn't need resyncing
    return false;
  }

  // Fetch data for a specific day
  async function fetchDayData(date: string): Promise<DailyModelStats | null> {
    try {
      if (!blockchain.endpoint.address) {
        throw new Error('No blockchain endpoint configured');
      }

      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);

      const timeFrom = startOfDay.getTime();
      const timeTo = endOfDay.getTime();

      const url = `${blockchain.endpoint.address}/productscience/inference/inference/models_stats_by_time?time_from=${timeFrom}&time_to=${timeTo}`;

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      
      return {
        date,
        timestamp: startOfDay.getTime(),
        stats_models: data.stats_models || [],
        syncedAt: Date.now()
      };
    } catch (error) {
      console.error(`Error fetching data for ${date}:`, error);
      return null;
    }
  }

  // Fetch 30 days of data with intelligent caching
  // Strategy: 
  // 1. Always fetch fresh data for today (constantly changing)
  // 2. Use cached data for previous days, BUT:
  //    - If data was synced today and it's for yesterday/earlier, resync it 
  //      (within 12h window to get complete data)
  //    - This ensures we don't keep incomplete data from early morning fetches
  async function fetch30DayData() {
    try {
      chartLoading.value = true;
      chartError.value = null;

      const cachedData = getCachedData();
      const today = new Date();
      const fetchPromises: Promise<DailyModelStats | null>[] = [];

      // Generate dates for last 30 days
      for (let i = 0; i < 30; i++) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const dateString = date.toISOString().split('T')[0];

        if (needsFetch(dateString)) {
          fetchPromises.push(fetchDayData(dateString));
        }
      }

      // Fetch missing data
      const fetchedData = await Promise.all(fetchPromises);
      const validFetchedData = fetchedData.filter(item => item !== null) as DailyModelStats[];

      // Combine cached and fetched data, prioritizing fresh data over cached
      const allData = [...cachedData, ...validFetchedData];
      
      // Remove duplicates, prioritizing fresh data (especially for today)
      const uniqueData = allData.reduce((acc: DailyModelStats[], current) => {
        const existingIndex = acc.findIndex(item => item.date === current.date);
        
        if (existingIndex === -1) {
          // No existing data for this date, add it
          acc.push(current);
        } else {
          // Data exists, replace it if current data is fresher (from validFetchedData)
          const isFromFreshFetch = validFetchedData.some(item => item.date === current.date);
          if (isFromFreshFetch) {
            acc[existingIndex] = current;
          }
        }
        
        return acc;
      }, []);

      // Sort by date (newest first)
      uniqueData.sort((a, b) => b.timestamp - a.timestamp);

      // Update state and cache
      dailyStats.value = uniqueData.slice(0, 30);
      setCachedData(uniqueData);

    } catch (error) {
      console.error('Error fetching 30-day data:', error);
      chartError.value = error instanceof Error ? error.message : 'Failed to fetch chart data';
    } finally {
      chartLoading.value = false;
    }
  }

  // Generate chart series data
  const chartSeries = computed((): ChartSeriesData[] => {
    if (dailyStats.value.length === 0) return [];

    // Get all unique models
    const modelNames = new Set<string>();
    dailyStats.value.forEach(day => {
      day.stats_models.forEach(model => {
        modelNames.add(model.model);
      });
    });

    // Calculate total usage per model for sorting
    const modelTotals = new Map<string, number>();
    Array.from(modelNames).forEach(modelName => {
      const total = dailyStats.value.reduce((sum, day) => {
        const modelStats = day.stats_models.find(m => m.model === modelName);
        return sum + parseInt(modelStats?.ai_tokens || '0');
      }, 0);
      modelTotals.set(modelName, total);
    });

    // Sort models by total usage (largest to smallest for better stacking)
    const sortedModelNames = Array.from(modelNames).sort((a, b) => {
      return (modelTotals.get(b) || 0) - (modelTotals.get(a) || 0);
    });

    // Create series for each model in sorted order
    return sortedModelNames.map(modelName => {
      const data = dailyStats.value
        .sort((a, b) => a.timestamp - b.timestamp) // Sort chronologically for chart
        .map(day => {
          const modelStats = day.stats_models.find(m => m.model === modelName);
          return parseInt(modelStats?.ai_tokens || '0');
        });

      return {
        name: modelName,
        data,
        color: generateModelColor(modelName)
      };
    });
  });

  // Generate chart categories (dates)
  const chartCategories = computed((): string[] => {
    return dailyStats.value
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(day => day.date);
  });

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

  // Refresh only today's data (useful for periodic updates)
  async function refreshTodayData() {
    try {
      const today = new Date().toISOString().split('T')[0];
      const todayData = await fetchDayData(today);
      
      if (todayData) {
        const cachedData = getCachedData();
        const allData = [...cachedData, todayData];
        
        // Remove duplicates, prioritizing fresh today data
        const uniqueData = allData.reduce((acc: DailyModelStats[], current) => {
          const existingIndex = acc.findIndex(item => item.date === current.date);
          
          if (existingIndex === -1) {
            acc.push(current);
          } else if (current.date === today) {
            // Always replace today's data with fresh data
            acc[existingIndex] = current;
          }
          
          return acc;
        }, []);
        
        // Sort by date (newest first) and update state
        uniqueData.sort((a, b) => b.timestamp - a.timestamp);
        dailyStats.value = uniqueData.slice(0, 30);
        setCachedData(uniqueData);
      }
    } catch (error) {
      console.error('Error refreshing today data:', error);
    }
  }

  async function init() {
    await Promise.all([
      fetchStats24h(),
      fetchStats7d(),
      fetchModels(),
      fetch30DayData()
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
    dailyStats.value = [];
    loading.value = false;
    error.value = null;
    chartLoading.value = false;
    chartError.value = null;
  }

  return {
    // State
    stats24h,
    stats7d,
    models,
    loading,
    error,
    
    // New state
    dailyStats,
    chartLoading,
    chartError,
    
    // Getters
    displayInferencesToday,
    displayInferencesLastWeek,
    displayAiTokensToday,
    displayAiTokensLastWeek,
    displayCostToday,
    displayCostLastWeek,
    
    // New getters
    chartSeries,
    chartCategories,
    
    // Actions
    fetchStats24h,
    fetchStats7d,
    fetchModels,
    init,
    $reset,
    
    // New actions
    fetch30DayData,
    refreshTodayData,
    generateModelColor,
  };
}); 