<script lang="ts" setup>
import Countdown from '@chenfengyuan/vue-countdown';
import { ref } from 'vue';

const props = defineProps({
  time: { type: Number },
  css: { type: String },
  hideDays: { type: Boolean, default: false },
  short: { type: Boolean, default: false },
});

const s = ref(0)

</script>
<template>
  <Countdown
    v-if="time"
    :time="time > 0 ? time : 0"
    v-slot="{ days, hours, minutes, seconds }"
    class="countdown-container justify-items-center items-center"
  >
    <template v-if="!hideDays">
      <span class="text-primary font-bold" :class="css">{{ days }}</span>
      <span class="opacity-70 ml-1 mr-2">{{ short ? 'd' : 'days' }}</span>
    </template>
    <span class="text-primary font-bold inline-block" :class="css">{{ hideDays ? days * 24 + hours : hours }}</span>
    <span class="opacity-70 ml-1 mr-2">{{ short ? 'h' : 'hours' }}</span>
    <span class="text-primary font-bold inline-block" :class="css">{{ minutes }}</span>
    <span class="opacity-70 ml-1 mr-2">{{ short ? 'm' : 'minutes' }}</span>
    <span class="text-primary font-bold inline-block animated-number" :class="css">
      <Transition name="slide-up">
        <span v-if="seconds % 2 === 0" class="countdown">{{ (seconds < 10 ? `0${seconds}` : seconds) }}</span>
        <span v-else="seconds % 2 === 1" class="countdown">{{ (seconds < 10 ? `0${seconds}` : seconds) }}</span>
      </Transition>
    </span>
    <span class="opacity-70 ml-1">{{ short ? 's' : 'seconds' }}</span>
  </Countdown>
</template>

<style>
.number {
  font-variant-numeric: tabular-nums;
}

.animated-number {
  position: relative;
  min-width: 2ch;
  min-height: 1.25ch;
}

.countdown-container {
  display: inline-flex;
  align-items: baseline;
  white-space: nowrap;
  position: relative;
}

.countdown {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  right: 0;
  width: 100%;
  text-align: center;
}

</style>
