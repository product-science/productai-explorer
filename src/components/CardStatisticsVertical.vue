<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { controlledComputed } from '@vueuse/core'
import { ref, computed, useSlots } from 'vue'

interface Props {
  title: string;
  color?: string;
  icon: string;
  stats: string;
  change?: number;
  subtitle?: string;
  subSymbol?: string;
  hint?: string;
}

const props = withDefaults(defineProps<Props>(), {
  color: 'primary',
});

const isPositive = controlledComputed(
  () => props.change,
  () => Math.sign(props.change || 0) === 1
);
const isHovering = ref(false)
const slots = useSlots()
const hasHintSlot = computed(() => !!slots.hint)
const hasContentSlot = computed(() => !!slots.content)
const hasHint = computed(() => !!props.hint || hasHintSlot.value)
</script>

<template>
  <div class="bg-base-100 shadow rounded py-4 px-2 relative min-w-[265px]">
    <div v-if="hasHint" class="absolute top-2 right-2 text-primary" @mouseenter="isHovering = true" @mouseleave="isHovering = false">
      <Icon icon="mdi:information" size="28" />
    </div>
    <div class="flex items-center justify-center">
      <div
        v-if="props.icon"
        class="relative w-9 h-9 rounded overflow-hidden flex items-center justify-center"
      >
        <Icon :class="[`text-${props?.color}`]" :icon="props.icon" size="32" />
        <div
          class="absolute top-0 left-0 bottom-0 right-0 opacity-20"
          :class="[`bg-${props?.color}`]"
        ></div>
        <div
          v-if="props.subSymbol"
          class="absolute -bottom-0 -right-0 px-1 font-semibold"
          :class="[`text-${props?.color}`]"
          style="font-size: 0.5rem;"
        >
          {{ props.subSymbol }}
        </div>
      </div>

      <div
        v-if="props.change"
        :class="isPositive ? 'text-success' : 'text-error'"
        class="flex items-center text-sm font-semibold"
      >
        <span>{{ isPositive ? `+${props.change}` : props.change }}%</span>
        <Icon :icon="isPositive ? 'mdi-chevron-up' : 'mdi-chevron-down'" />
      </div>
    </div>

    <div class="relative min-h-[72px] mt-2">
      <div
        class="absolute inset-0 flex flex-col items-center justify-center transition-opacity duration-200"
        :class="{ 'opacity-0 pointer-events-none': isHovering && hasHint }"
      >
        <slot name="content">
          <h6 class="text-lg text-center font-semibold mb-1">
            {{ props.stats || '-' }}
          </h6>
          <p class="text-sm text-center">
            {{ props.title }}
          </p>
          <div v-if="props.subtitle" size="x-small" class="font-semibold">
            <span class="truncate">{{ props.subtitle }}</span>
          </div>
        </slot>
      </div>
      <div
        class="absolute inset-0 flex items-center justify-center transition-opacity duration-200 pointer-events-none"
        :class="{ 'opacity-0': !(isHovering && hasHint) }"
      >
        <slot name="hint">
          <p class="text-sm text-center px-4">{{ props.hint }}</p>
        </slot>
      </div>
    </div>
  </div>
</template>
