<script lang="ts" setup>
import ApexCharts from 'vue3-apexcharts';
import { computed, watch, ref, onMounted, nextTick } from 'vue';
import { useBaseStore } from '@/stores';
import { getDonutChartConfig } from './apexChartConfig';

const props = defineProps([
  'series',
  'labels',
  'hoverIndex',
  'colors',
  // optional: (val: number|string, ctx?: any) => string
  'valueFormatter',
  // optional: (total: number, ctx?: any) => string
  'totalFormatter',
]);

const baseStore = useBaseStore();

const chartRef = ref<any>(null)

const lastAppliedIndex = ref<number | null>(null)

const expenseRationChartConfig = computed(() => {
  const theme = baseStore.theme;
  const cfg: any = getDonutChartConfig(theme, props?.labels);
  // prevent Apex from altering colors on hover/active
  cfg.states = {
    normal: { filter: { type: 'none' } },
    hover: { filter: { type: 'none' } },
    active: { filter: { type: 'none' } }
  }
  // also disable expand on click at the option level (belt & suspenders)
  cfg.plotOptions = cfg.plotOptions || {}
  cfg.plotOptions.pie = cfg.plotOptions.pie || {}
  cfg.plotOptions.pie.expandOnClick = false
  // fire our opacity applier when a real slice gets hovered
  cfg.chart = cfg.chart || {}
  cfg.chart.events = {
    dataPointMouseEnter: (e: any, _ctx: any, opts: any) => {
      if (e && e.isTrusted === false) return
      applyHover(opts?.dataPointIndex ?? null)
    },
    dataPointMouseLeave: (e: any) => {
      if (e && e.isTrusted === false) return
      applyHover(null)
    }
  }
  if (props?.colors && props.colors.length) {
    cfg.colors = props.colors;
  }
  // allow parent to control value/total formatting
  try {
    cfg.plotOptions = cfg.plotOptions || {}
    cfg.plotOptions.pie = cfg.plotOptions.pie || {}
    cfg.plotOptions.pie.donut = cfg.plotOptions.pie.donut || {}
    cfg.plotOptions.pie.donut.labels = cfg.plotOptions.pie.donut.labels || {}
    cfg.plotOptions.pie.donut.labels.value = cfg.plotOptions.pie.donut.labels.value || {}
    cfg.plotOptions.pie.donut.labels.total = cfg.plotOptions.pie.donut.labels.total || {}
    if (props.valueFormatter) {
      cfg.plotOptions.pie.donut.labels.value.formatter = (val: any, w: any) => props.valueFormatter!(Number(val), w)
    }
    if (props.totalFormatter) {
      cfg.plotOptions.pie.donut.labels.total.show = true
      cfg.plotOptions.pie.donut.labels.total.formatter = (w: any) => {
        const totals: number[] = (w?.globals?.seriesTotals || []) as number[]
        const sum = totals.reduce((a, b) => a + b, 0)
        return props.totalFormatter!(sum, w)
      }
    }
  } catch (_e) {
    // no-op
  }
  return cfg;
});

function getSlicePaths(): SVGPathElement[] {
  if (!chartRef.value) return []
  // vue3-apexcharts exposes $el; Apex also attaches .el on the instance
  const el: HTMLElement = (chartRef.value as any).$el || (chartRef.value as any).el || chartRef.value
  return Array.from(el.querySelectorAll('.apexcharts-pie path')) as SVGPathElement[]
}


const UNHOVER_OPACITY = 0.2

function updateCenterLabel(idx: number | null) {
  if (!chartRef.value) return
  const el: HTMLElement = (chartRef.value as any).$el || (chartRef.value as any).el || chartRef.value
  const labelEl = el.querySelector('.apexcharts-datalabel-label') as HTMLElement | null
  const valueEl = el.querySelector('.apexcharts-datalabel-value') as HTMLElement | null
  if (!labelEl || !valueEl) return

  // Compute label + value
  if (idx === null) {
    labelEl.textContent = 'Total'
    const seriesArray: number[] = (props.series as any[] || []).map((v: any) => Number(v) || 0)
    const total = seriesArray.reduce((a, b) => a + b, 0)
    try {
      valueEl.textContent = props.totalFormatter ? props.totalFormatter(total) : String(total)
    } catch (_) {
      valueEl.textContent = String(total)
    }
  } else {
    const name = props.labels?.[idx] ?? ''
    const rawVal = Number((props.series as any[])[idx] || 0)
    labelEl.textContent = String(name)
    try {
      valueEl.textContent = props.valueFormatter ? props.valueFormatter(rawVal) : String(rawVal)
    } catch (_) {
      valueEl.textContent = String(rawVal)
    }
  }
}

function applyHover(idx: number | null) {
  // avoid redundant work & guard against recursion
  if (lastAppliedIndex.value === idx) return
  lastAppliedIndex.value = idx

  const paths = getSlicePaths()
  if (!paths.length) return

  // Set pure opacity (no color change) so it matches list icon BG blending
  paths.forEach((p, i) => {
    p.style.opacity = (idx === null || i === idx) ? '1' : String(UNHOVER_OPACITY)
  })

  updateCenterLabel(idx)

  // Optionally synthesize events when hovering a slice to update center labels
  const target = (idx === null) ? null : paths[idx]
  if (target) {
    const rect = target.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }))
    target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }))
  } else if (paths[0]) {
    paths[0].dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
  }
}

watch(() => props.hoverIndex, (idx) => {
  requestAnimationFrame(() => {
    applyHover(idx ?? null)
    updateCenterLabel(idx ?? null)
  })
})

onMounted(() => nextTick(() => {
  applyHover(null)
  updateCenterLabel(null)
}))
</script>

<template>
  <ApexCharts
    ref="chartRef"
    type="donut"
    height="410"
    :options="expenseRationChartConfig"
    :series="series"
  />
</template>

<style scoped>
:deep(.apexcharts-pie path){
  transition: opacity .12s ease-in-out;
}
</style>