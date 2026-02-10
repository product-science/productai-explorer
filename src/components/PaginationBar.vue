<script lang="ts" setup>
import { computed, ref, watch } from 'vue';

const props = defineProps({
  total: { type: String },
  limit: { type: Number },
  callback: { type: Function, required: true },
  // Optional externally controlled current page (1-based or custom index)
  page: { type: Number, default: 1 },
  // Optional minimum allowed page/index (defaults to 1)
  minPage: { type: Number, default: 1 },
  // Optional loading state; when true, active page shows inline spinner
  loading: { type: Boolean, default: false },
  // Max visible pagination buttons (odd number recommended, usually 5 or 3)
  maxVisible: { type: Number, default: 5 },
});

const current = ref(props.page || 1);

watch(
  () => props.page,
  (val) => {
    if (typeof val === 'number' && val >= 1 && val !== current.value) {
      current.value = val;
    }
  }
);

// Highest page/index value we can navigate to (derived from total/limit)
const pageCount = computed(() => {
  const total = Number(props.total || 0);
  if (!props.limit || props.limit <= 0) return 0;
  return total > 0 ? Math.ceil(total / props.limit) : 0;
});

const minPage = computed(() =>
  typeof props.minPage === 'number' && props.minPage > 0 ? props.minPage : 1
);

// Dynamic threshold based on maxVisible (e.g., 2 for 5, 1 for 3)
const buffer = computed(() => Math.floor((props.maxVisible - 1) / 2));

const pagesToLeft = computed(() => Math.max(0, current.value - minPage.value));
const pagesToRight = computed(() => Math.max(0, pageCount.value - current.value));

const showLeftEllipsis = computed(() => pagesToLeft.value > buffer.value + 1);
const showRightEllipsis = computed(() => pagesToRight.value > buffer.value + 1);

const pageNumbers = computed(() => {
  const maxPage = pageCount.value;
  const min = minPage.value;
  const result: number[] = [];
  if (maxPage === 0) return result;

  const totalVisible = maxPage - min + 1;

  // If total page range is small, show everything
  if (totalVisible <= props.maxVisible) {
    for (let i = min; i <= maxPage; i++) result.push(i);
    return result;
  }

  // Use dynamic buffer
  const buf = buffer.value; 

  // Near the beginning of the range
  if (current.value <= min + buf) {
    for (let i = min; i <= min + (props.maxVisible - 1); i++) result.push(i);
    return result;
  }

  // Near the end of the range
  if (current.value >= maxPage - buf) {
    for (let i = maxPage - (props.maxVisible - 1); i <= maxPage; i++) result.push(i);
    return result;
  }

  // Middle of the range
  for (let i = current.value - buf; i <= current.value + buf; i++) result.push(i);
  return result;
});

function goto(pageNum: number) {
  const maxPage = pageCount.value;
  if (maxPage === 0) return;
  const min = minPage.value;
  const target = Math.min(Math.max(min, pageNum), maxPage);
  if (target === current.value) return;
  current.value = target;
  props.callback(target);
}

function gotoFirst() {
  goto(minPage.value);
}

function gotoLast() {
  goto(pageCount.value);
}

function gotoBy(delta: number) {
  goto(current.value + delta);
}
</script>
<template>
  <div class="my-5 text-center">
    <div v-if="total && limit && pageCount > 1" class="btn-group">
      <!-- Jump to first -->
      <button
        class="btn bg-gray-100 text-gray-500 hover:text-white border-none dark:bg-gray-800 dark:text-white"
        :class="{ 'btn-disabled opacity-50 cursor-not-allowed': current === 1 }"
        :disabled="current === 1"
        @click="gotoFirst"
      >
        &laquo;
      </button>

      <!-- Jump by -3 pages -->
      <button
        class="btn bg-gray-100 text-gray-500 hover:text-white border-none dark:bg-gray-800 dark:text-white"
        :class="{ 'btn-disabled opacity-50 cursor-not-allowed': current === 1 }"
        :disabled="current === 1"
        @click="gotoBy(-3)"
      >
        &lsaquo;
      </button>

      <!-- Left ellipsis -->
      <button
        v-if="showLeftEllipsis"
        class="btn bg-gray-100 text-gray-500 border-none dark:bg-gray-800 dark:text-white btn-disabled opacity-50 cursor-not-allowed"
        :disabled="true"
      >
        ...
      </button>

      <!-- Page numbers (max 5) -->
      <button
        v-for="page in pageNumbers"
        :key="page"
        class="btn bg-gray-100 text-gray-500 hover:text-white border-none dark:bg-gray-800 dark:text-white"
        :class="{ '!btn-primary': page === current }"
        @click="goto(page)"
      >
        <span v-if="!(loading && page === current)">{{ page }}</span>
        <span v-else class="loading loading-spinner loading-xs"></span>
      </button>

      <!-- Right ellipsis -->
      <button
        v-if="showRightEllipsis"
        class="btn bg-gray-100 text-gray-500 border-none dark:bg-gray-800 dark:text-white btn-disabled opacity-50 cursor-not-allowed"
        :disabled="true"
      >
        ...
      </button>

      <!-- Jump by +3 pages -->
      <button
        class="btn bg-gray-100 text-gray-500 hover:text-white border-none dark:bg-gray-800 dark:text-white"
        :class="{ 'btn-disabled opacity-50 cursor-not-allowed': current === pageCount }"
        :disabled="current === pageCount"
        @click="gotoBy(3)"
      >
        &rsaquo;
      </button>

      <!-- Jump to last -->
      <button
        class="btn bg-gray-100 text-gray-500 hover:text-white border-none dark:bg-gray-800 dark:text-white"
        :class="{ 'btn-disabled opacity-50 cursor-not-allowed': current === pageCount }"
        :disabled="current === pageCount"
        @click="gotoLast"
      >
        &raquo;
      </button>
    </div>
  </div>
</template>
