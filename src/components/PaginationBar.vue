<script lang="ts" setup>
import { computed, ref, watch } from 'vue';

const props = defineProps({
  total: { type: String },
  limit: { type: Number },
  callback: { type: Function, required: true },
  // Optional externally controlled current page (1-based)
  page: { type: Number, default: 1 },
  // Optional loading state; when true, active page shows inline spinner
  loading: { type: Boolean, default: false },
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

const pageCount = computed(() => {
  const total = Number(props.total || 0);
  if (!props.limit || props.limit <= 0) return 0;
  return total > 0 ? Math.ceil(total / props.limit) : 0;
});

const pagesToLeft = computed(() => Math.max(0, current.value - 1));
const pagesToRight = computed(() => Math.max(0, pageCount.value - current.value));

const showLeftEllipsis = computed(() => pagesToLeft.value > 3);
const showRightEllipsis = computed(() => pagesToRight.value > 3);

const pageNumbers = computed(() => {
  const totalPages = pageCount.value;
  const result: number[] = [];
  if (totalPages === 0) return result;

  if (totalPages <= 5) {
    for (let i = 1; i <= totalPages; i++) result.push(i);
    return result;
  }

  if (current.value <= 3) {
    for (let i = 1; i <= 5; i++) result.push(i);
    return result;
  }

  if (current.value >= totalPages - 2) {
    for (let i = totalPages - 4; i <= totalPages; i++) result.push(i);
    return result;
  }

  for (let i = current.value - 2; i <= current.value + 2; i++) result.push(i);
  return result;
});

function goto(pageNum: number) {
  const totalPages = pageCount.value;
  if (totalPages === 0) return;
  const target = Math.min(Math.max(1, pageNum), totalPages);
  if (target === current.value) return;
  current.value = target;
  props.callback(target);
}

function gotoFirst() {
  goto(1);
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
