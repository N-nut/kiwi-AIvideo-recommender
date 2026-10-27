<script setup lang="ts">
import { computed } from 'vue';
import presets from '../../../data/avatar-presets.json';
const props=defineProps<{id?:string}>();
const avatar=computed(()=>presets.find(item=>item.id===props.id)||presets[0]!);
</script>
<template>
  <svg class="preset-avatar" viewBox="0 0 64 64" aria-hidden="true" :style="{background:avatar.color,color:avatar.accent}">
    <g fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round">
      <template v-if="avatar.kind==='kiwi'"><ellipse cx="30" cy="34" rx="16" ry="13"/><path d="M39 26q7-14 12-7l-2 10 9 3-11 2M20 46l-3 6m16-5 3 5M18 31q-7-1-6 6"/><circle cx="45" cy="25" r="1" fill="currentColor"/></template>
      <template v-else-if="avatar.kind==='leaf'"><path d="M17 46C8 20 35 13 48 15c2 20-8 40-31 31Zm1 0 23-23m-15 5 1 10 10 1"/></template>
      <template v-else-if="avatar.kind==='sun'"><circle cx="32" cy="32" r="12"/><path d="M32 9v5m0 36v5M9 32h5m36 0h5M16 16l4 4m24 24 4 4m0-32-4 4M20 44l-4 4"/></template>
      <path v-else-if="avatar.kind==='moon'" d="M43 14a22 22 0 1 0 8 34A24 24 0 0 1 43 14Z"/>
      <template v-else-if="avatar.kind==='flower'"><path d="M32 24c-17-22-29 4-9 10-13 22 16 27 17 6 27 4 20-24 1-17-1-22-27-17-17 1Z"/><circle cx="32" cy="32" r="6"/></template>
      <path v-else d="m32 11 6.5 14 15.5 2-11 11 2.5 15L32 46l-13.5 7L21 38 10 27l15.5-2Z"/>
    </g>
  </svg>
</template>
