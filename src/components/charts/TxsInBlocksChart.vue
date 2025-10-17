<script lang="ts" setup>
import ApexCharts from 'vue3-apexcharts';
import { computed, ref } from '@vue/reactivity';
import { useBaseStore } from '@/stores';
import { getContrastingBarPalette } from './apexChartConfig';

const baseStore = useBaseStore();

const options = computed(() => {
    const theme = baseStore.theme;
    return {
        chart: {
            type: 'bar',
            height: 150
        },
        plotOptions: {
            bar: {
                // borderRadius: 4,
                horizontal: false,
            }
        },
        dataLabels: {
          enabled: false
        },
        colors: getContrastingBarPalette(theme, 1),
        xaxis: {
            labels: {
                show: false,
                rotate: -45
            },
            show: false,
            categories: baseStore.recents.map((x) => x.block.header.height).concat(Array(50-baseStore.recents.length).fill('')),
        }
    };
});
const series = computed(() => {
    return [{
        name: 'Txs',
        data: baseStore.recents?.map((x) => x.block.data.txs.length) || []
    }]
});
</script>

<template>
    <ApexCharts type="bar" height="150" :options="options" :series="series" />
</template>
