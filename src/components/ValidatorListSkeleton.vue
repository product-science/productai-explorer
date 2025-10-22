<script lang="ts" setup>
import { computed } from 'vue'

const props = defineProps({
  rows: { type: Number, default: 10 },
  opacities: { type: Array as () => number[] | undefined, default: undefined },
})

const rowOpacities = computed(() => {
  if (props.opacities && props.opacities.length > 0) return props.opacities as number[]
  const count = props.rows || 10
  const start = 0.8 // 80%
  const end = 0.1   // 10%
  const step = count > 1 ? (start - end) / (count - 1) : 0
  return Array.from({ length: count }, (_, i) => Number((start - i * step).toFixed(2)))
})
</script>

<template>
  <!-- Render table rows to be slotted inside an existing <tbody> -->
  <tr v-for="(opacity, index) in rowOpacities" :key="index" class="hover:bg-transparent">
    <!-- Validator (avatar + text) -->
    <td class="sticky left-0 z-[1] bg-base-100">
      <div class="flex items-center overflow-hidden">
        <div class="avatar !flex mx-4 relative w-8 h-8 rounded-full">
          <div class="w-8 h-8 rounded-full bg-black" :style="{ opacity }"></div>
        </div>
        <div class="flex flex-col min-w-0">
          <div class="h-4 w-40 max-w-[40vw] bg-black rounded" :style="{ opacity }"></div>
          <div class="h-3 w-24 mt-2 bg-black rounded-full" :style="{ opacity }"></div>
        </div>
      </div>
    </td>

    <!-- Voting Power -->
    <td class="text-right">
      <div class="flex flex-col items-end">
        <div class="h-4 w-16 bg-black rounded" :style="{ opacity }"></div>
        <div class="h-3 w-12 mt-2 bg-black rounded-full" :style="{ opacity }"></div>
      </div>
    </td>

    <!-- 24h Changes -->
    <td class="text-right">
      <div class="h-3 w-14 bg-black rounded" :style="{ opacity }"></div>
    </td>

    <!-- Earned -->
    <td class="text-right">
      <div class="h-3 w-16 bg-black rounded" :style="{ opacity }"></div>
    </td>

    <!-- Active -->
    <td class="text-right">
      <div class="h-3 w-10 bg-black rounded" :style="{ opacity }"></div>
    </td>

    <!-- Reputation -->
    <td class="text-right">
      <div class="h-3 w-10 bg-black rounded" :style="{ opacity }"></div>
    </td>

    <!-- Missed Blocks -->
    <td class="text-right">
      <div class="h-3 w-12 bg-black rounded" :style="{ opacity }"></div>
    </td>

    <!-- Uptime -->
    <td class="text-right">
      <div class="h-3 w-14 bg-black rounded" :style="{ opacity }"></div>
    </td>
  </tr>
</template>


