<script setup lang="ts">
import type { FeedbackStatus } from '../types';
defineProps<{busy?:boolean;title:string;status?:FeedbackStatus}>();
const emit=defineEmits<{select:[status:FeedbackStatus]}>();
</script>
<template>
  <div class="feedback-menu" role="group" :aria-label="`《${title}》推荐反馈`" :aria-busy="!!busy">
    <div class="feedback-options">
      <button class="feedback-icon feedback-dismiss" type="button" :disabled="busy" :aria-pressed="status==='not_interested'" aria-label="不感兴趣" title="不感兴趣" data-label="不感兴趣" @click="emit('select','not_interested')"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.25"/><path d="m6.2 6.2 11.6 11.6"/></svg></button>
      <button class="feedback-icon feedback-watched" type="button" :disabled="busy" :aria-pressed="status==='watched'" aria-label="已看过" title="已看过" data-label="已看过" @click="emit('select','watched')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.7 9.4C18.8 6.5 15.8 5 12 5 7.5 5 4.2 7.2 2 12c1.7 3.7 4.1 5.9 7.4 6.7"/><circle cx="12" cy="12" r="3"/><path d="m14.5 18 2.2 2.2 4.8-5.1"/></svg></button>
    </div><span v-if="busy" class="sr-only" role="status">正在保存反馈</span>
  </div>
</template>
