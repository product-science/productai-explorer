<script lang="ts" setup>
import { Icon } from '@iconify/vue';

defineProps<{
  currentStep: number;
  isTransactionCompleted: boolean;
}>();
</script>

<template>
  <!-- Stepper header -->
  <div class="flex items-center w-full mb-1">
    <!-- Step 1 -->
    <div class="flex items-center gap-2 shrink-0">
      <div
        class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-colors"
        :class="[
          currentStep > 1 ? 'bg-green-100 dark:bg-green-900/30 text-green-600' : '',
          currentStep === 1 ? 'bg-primary text-white' : '',
          currentStep < 1 ? 'bg-gray-200 dark:bg-gray-700 text-gray-400' : ''
        ]"
      >
        <Icon v-if="currentStep > 1" icon="mdi:check" class="text-sm" />
        <span v-else>1</span>
      </div>
      <span class="text-sm font-medium" :class="currentStep >= 1 ? 'text-main' : 'text-gray-400'">Connect wallet</span>
    </div>
    <!-- Line 1→2 -->
    <div class="flex-1 h-px mx-3 transition-colors" :class="currentStep > 1 ? 'bg-green-400' : 'bg-gray-300 dark:bg-gray-600'"></div>
    <!-- Step 2 -->
    <div class="flex items-center gap-2 shrink-0">
      <div
        class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-colors"
        :class="[
          currentStep > 2 ? 'bg-green-100 dark:bg-green-900/30 text-green-600' : '',
          currentStep === 2 ? 'bg-primary text-white' : '',
          currentStep < 2 ? 'bg-gray-200 dark:bg-gray-700 text-gray-400' : ''
        ]"
      >
        <Icon v-if="currentStep > 2" icon="mdi:check" class="text-sm" />
        <span v-else>2</span>
      </div>
      <span class="text-sm font-medium" :class="currentStep >= 2 ? 'text-main' : 'text-gray-400'">Enter details</span>
    </div>
    <!-- Line 2→3 -->
    <div class="flex-1 h-px mx-3 transition-colors" :class="currentStep > 2 ? 'bg-green-400' : 'bg-gray-300 dark:bg-gray-600'"></div>
    <!-- Step 3 -->
    <div class="flex items-center gap-2 shrink-0">
      <div
        class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-colors"
        :class="[
          isTransactionCompleted ? 'bg-green-100 dark:bg-green-900/30 text-green-600' : '',
          currentStep === 3 && !isTransactionCompleted ? 'bg-primary text-white' : '',
          currentStep < 3 ? 'bg-gray-200 dark:bg-gray-700 text-gray-400' : ''
        ]"
      >
        <Icon v-if="isTransactionCompleted" icon="mdi:check" class="text-sm" />
        <span v-else>3</span>
      </div>
      <span class="text-sm font-medium" :class="currentStep >= 3 ? 'text-main' : 'text-gray-400'">Approve in wallet</span>
    </div>
  </div>
</template>
