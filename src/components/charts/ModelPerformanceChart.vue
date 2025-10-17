<script lang="ts" setup>
import ApexCharts from 'vue3-apexcharts';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useBaseStore } from '@/stores';
import { colorVariables, getContrastingBarPalette } from './apexChartConfig';
import { useInferenceStore } from '@/stores/useInferenceStore';

const baseStore = useBaseStore();
const inferenceStore = useInferenceStore();

const chartConfig = computed(() => {
  const theme = baseStore.theme;
  const { themeSecondaryTextColor, themeBorderColor, themeDisabledTextColor } = colorVariables(theme);

  return {
    chart: {
      type: 'bar',
      stacked: true,
      redrawOnParentResize: true,
      width: '100%',
      parentHeightOffset: 0,
      toolbar: { show: false },
      animations: {
        enabled: true,
        easing: 'easeinout',
        speed: 800,
        animateGradually: {
          enabled: true,
          delay: 150
        },
        dynamicAnimation: {
          enabled: true,
          speed: 350
        }
      }
    },
    plotOptions: {
      bar: {
        horizontal: false,
        columnWidth: '70%',
        endingShape: 'rounded',
        borderRadius: 2,
        dataLabels: {
          total: {
            enabled: false,
            style: {
              fontSize: '12px',
              fontWeight: 600
            }
          }
        }
      }
    },
    tooltip: {
      theme: theme === 'dark' ? 'dark' : 'light',
      shared: true,
      intersect: false,
      x: {
        format: 'dd MMM yyyy'
      },
      y: {
        formatter: function (value: number) {
          if (value === 0) return '0 tokens';
          return value.toLocaleString() + ' tokens';
        }
      },
      fixed: {
        enabled: false
      }
    },
    dataLabels: { enabled: false },
    stroke: {
      show: true,
      width: 1,
      colors: ['transparent']
    },
    legend: {
      show: true,
      position: 'top',
      horizontalAlign: 'left',
      fontSize: '12px',
      labels: { 
        colors: themeSecondaryTextColor,
        useSeriesColors: false
      },
      markers: {
        width: 8,
        height: 8,
        strokeWidth: 0,
        strokeColor: '#fff',
        radius: 4,
        offsetX: 0,
        offsetY: 0
      },
      itemMargin: {
        horizontal: 10,
        vertical: 5
      }
    },
    fill: {
      opacity: 0.8
    },
    grid: {
      show: true,
      borderColor: themeBorderColor,
      strokeDashArray: 3,
      position: 'back',
      xaxis: {
        lines: { show: false }
      },
      yaxis: {
        lines: { show: true }
      },
      row: {
        colors: undefined,
        opacity: 0.5
      },
      column: {
        colors: undefined,
        opacity: 0.5
      },
      padding: {
        top: 0,
        right: 0,
        bottom: 0,
        left: 0
      }
    },
    yaxis: {
      show: true,
      showAlways: true,
      labels: {
        style: { 
          colors: themeDisabledTextColor,
          fontSize: '12px'
        },
        formatter: function (value: number) {
          if (value >= 1000000) {
            return (value / 1000000).toFixed(1) + 'M';
          } else if (value >= 1000) {
            return (value / 1000).toFixed(1) + 'K';
          }
          return value.toFixed(0);
        }
      },
      title: {
        text: 'AI Tokens per Day',
        style: {
          color: themeSecondaryTextColor,
          fontSize: '12px',
          fontWeight: 500
        }
      },
      axisBorder: {
        show: false
      },
      axisTicks: {
        show: false
      }
    },
    xaxis: {
      type: 'category',
      axisBorder: { show: false },
      axisTicks: { 
        show: false
      },
      labels: {
        style: { 
          colors: themeDisabledTextColor,
          fontSize: '12px'
        },
        rotate: -45,
        rotateAlways: true,
        hideOverlappingLabels: true,
        formatter: function(value: string) {
          // Convert YYYY-MM-DD to dd MMM format
          const date = new Date(value);
          return date.toLocaleDateString('en-US', { 
            day: '2-digit', 
            month: 'short' 
          });
        }
      },
      categories: inferenceStore.chartCategories,
      tooltip: {
        enabled: false
      }
    },
    colors: getContrastingBarPalette(theme, inferenceStore.chartSeries.length),
    noData: {
      text: 'No data available',
      align: 'center',
      verticalAlign: 'middle',
      offsetX: 0,
      offsetY: 0,
      style: {
        color: themeDisabledTextColor,
        fontSize: '16px'
      }
    }
  };
});

const series = computed(() => {
  return inferenceStore.chartSeries.map(series => ({
    name: series.name,
    data: series.data
  }));
});

const hasData = computed(() => {
  return series.value.length > 0 && series.value.some(s => s.data.some(d => d > 0));
});

const isLoading = computed(() => {
  return inferenceStore.chartLoading;
});

// Add a new computed to check if we're in initial state or actually loading
const isInitialLoading = computed(() => {
  return inferenceStore.chartLoading || (inferenceStore.dailyStats.length === 0 && !inferenceStore.chartError);
});

const hasError = computed(() => {
  return inferenceStore.chartError !== null;
});

// Auto-refresh interval (in minutes)
const AUTO_REFRESH_INTERVAL = 30;
let refreshInterval: NodeJS.Timeout | null = null;
let timeUpdateInterval: NodeJS.Timeout | null = null;
const lastRefresh = ref<Date | null>(null);

// Refresh today's data
async function refreshTodayData() {
  await inferenceStore.refreshTodayData();
  lastRefresh.value = new Date();
}

// Format last refresh time
const lastRefreshText = computed(() => {
  if (!lastRefresh.value) return '';
  const now = new Date();
  const diff = Math.floor((now.getTime() - lastRefresh.value.getTime()) / 1000);
  
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
});

// Setup automatic refresh for today's data
onMounted(() => {
  // Set up auto-refresh every 30 minutes for today's data
  refreshInterval = setInterval(() => {
    if (!inferenceStore.chartLoading) {
      refreshTodayData();
    }
  }, AUTO_REFRESH_INTERVAL * 60 * 1000);
  
  // Update the "last updated" text every minute
  timeUpdateInterval = setInterval(() => {
    // This will trigger reactivity to update the lastRefreshText computed
    if (lastRefresh.value) {
      lastRefresh.value = new Date(lastRefresh.value.getTime());
    }
  }, 60000);
});

// Cleanup interval on unmount
onUnmounted(() => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
  if (timeUpdateInterval) {
    clearInterval(timeUpdateInterval);
  }
});
</script>

<template>
  <div class="w-full">
    <!-- Chart Header with Refresh Button -->
    <div v-if="!isInitialLoading && !hasError && hasData" class="flex justify-between items-center mb-4">
      <div class="text-sm text-gray-500">
        Last 30 days
        <span v-if="lastRefreshText" class="ml-2 text-xs opacity-75">
          • Last updated {{ lastRefreshText }}
        </span>
      </div>
              <button 
        @click="refreshTodayData()"
        class="btn btn-sm btn-ghost gap-2 hover:bg-base-200"
        :disabled="isInitialLoading"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
        </svg>
        Refresh Today
      </button>
    </div>

    <!-- Loading State -->
    <div v-if="isInitialLoading" class="flex items-center justify-center h-64">
      <div class="flex flex-col items-center">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        <p class="mt-2 text-sm text-gray-500">Loading chart data...</p>
      </div>
    </div>

    <!-- Error State -->
    <div v-else-if="hasError" class="flex items-center justify-center h-64">
      <div class="text-center">
        <div class="text-red-500 text-4xl mb-2">⚠️</div>
        <p class="text-red-500 text-sm">{{ inferenceStore.chartError }}</p>
        <button 
          @click="inferenceStore.fetch30DayData()"
          class="mt-2 px-4 py-2 bg-primary text-white rounded-md text-sm hover:bg-primary-focus"
        >
          Retry
        </button>
      </div>
    </div>

    <!-- No Data State -->
    <div v-else-if="!hasData" class="flex items-center justify-center h-64">
      <div class="text-center">
        <div class="text-gray-400 text-4xl mb-2">📊</div>
        <p class="text-gray-500 text-sm">No model performance data available</p>
      </div>
    </div>

    <!-- Chart -->
    <ApexCharts
      v-else
      type="bar"
      height="450"
      :options="chartConfig"
      :series="series"
    />
  </div>
</template> 