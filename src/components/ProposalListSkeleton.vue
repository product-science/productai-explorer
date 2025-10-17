<script lang="ts" setup>
import { computed } from 'vue';

const props = defineProps({
  rows: { type: Number, default: 5 },
  opacities: { type: Array as () => number[] | undefined, default: undefined },
});

const rowOpacities = computed(() => {
  if (props.opacities && props.opacities.length > 0) return props.opacities as number[];
  const count = props.rows || 5;
  const start = 0.8; // 80%
  const end = 0.1;   // 10%
  const step = count > 1 ? (start - end) / (count - 1) : 0;
  return Array.from({ length: count }, (_, i) => Number((start - i * step).toFixed(2)));
});
</script>

<template>
  <div class="bg-white dark:bg-[#28334e] rounded text-sm">
    <!-- Desktop/tablet -->
    <table class="table-compact w-full table-fixed hidden lg:!table">
      <tbody>
        <tr v-for="(opacity, index) in rowOpacities" :key="index">
          <td class="px-4 w-20">
            <div class="h-4 w-10 bg-black rounded" :style="{ opacity }"></div>
          </td>
          <td class="w-full">
            <div class="space-y-2">
              <div class="h-4 w-3/5 bg-black rounded" :style="{ opacity }"></div>
              <div class="h-3 w-24 bg-black rounded-full" :style="{ opacity }"></div>
            </div>
          </td>
          <td class="w-60">
            <div class="h-3 w-full bg-black rounded" :style="{ opacity }"></div>
          </td>
          <td class="w-36">
            <div class="pl-4 space-y-2">
              <div class="h-3 w-16 bg-black rounded" :style="{ opacity }"></div>
              <div class="h-3 w-20 bg-black rounded ml-auto" :style="{ opacity }"></div>
            </div>
          </td>
          <td class="w-40">
            <div class="h-6 w-16 bg-black rounded" :style="{ opacity }"></div>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- Mobile -->
    <div class="lg:!hidden">
      <div
        v-for="(opacity, index) in rowOpacities"
        :key="index"
        class="px-4 py-4"
      >
        <div class="text-main text-base mb-1 flex justify-between items-center">
          <div class="flex-1 w-0 truncate mr-4">
            <div class="h-4 w-3/5 bg-black rounded" :style="{ opacity }"></div>
          </div>
          <div class="h-4 w-10 bg-black rounded" :style="{ opacity }"></div>
        </div>

        <div class="grid grid-cols-4 mt-2 mb-2">
          <div class="col-span-2">
            <div class="h-3 w-24 bg-black rounded-full" :style="{ opacity }"></div>
          </div>
          <div class="h-3 w-24 bg-black rounded justify-self-end" :style="{ opacity }"></div>
        </div>

        <div class="h-3 w-full bg-black rounded" :style="{ opacity }"></div>

        <div class="mt-4 flex justify-between items-center">
          <div class="h-3 w-16 bg-black rounded" :style="{ opacity }"></div>
          <div class="h-6 w-16 bg-black rounded" :style="{ opacity }"></div>
        </div>
      </div>
    </div>
  </div>
  
</template>


