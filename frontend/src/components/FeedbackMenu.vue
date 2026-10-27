<script setup lang="ts">
import { ref } from 'vue';
import type { FeedbackStatus } from '../types';
defineProps<{busy?:boolean;title:string;status?:FeedbackStatus}>();
const emit=defineEmits<{select:[status:FeedbackStatus]}>();
const menu=ref<HTMLDetailsElement>();
function select(status:FeedbackStatus){if(menu.value)menu.value.open=false;emit('select',status);}
function focusOut(event:FocusEvent){if(!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node|null))menu.value?.removeAttribute('open');}
</script>
<template>
  <details ref="menu" class="feedback-menu" @keydown.esc.prevent="menu?.removeAttribute('open')" @focusout="focusOut">
    <summary :aria-label="`《${title}》推荐反馈`" :aria-disabled="!!busy" @click="busy&&$event.preventDefault()">{{busy?'保存中…':'推荐反馈'}} <span aria-hidden="true">⌄</span></summary>
    <div class="feedback-options" aria-label="推荐反馈选项"><button type="button" :disabled="busy" :aria-pressed="status==='not_interested'" @click="select('not_interested')">不感兴趣</button><button type="button" :disabled="busy" :aria-pressed="status==='watched'" @click="select('watched')">已看过</button></div>
  </details>
</template>
