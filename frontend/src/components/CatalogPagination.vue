<script setup lang="ts">
import { computed } from 'vue';
import { pageNumbers } from '../pagination';
const props=defineProps<{page:number;pages:number;busy?:boolean}>();
defineEmits<{change:[page:number]}>();
const numbers=computed(()=>pageNumbers(props.page,props.pages));
</script>
<template>
  <nav v-if="pages>1" class="catalog-pagination" aria-label="作品分页" :aria-busy="busy">
    <button class="page-arrow" :disabled="page<=1||busy" aria-label="上一页" @click="$emit('change',page-1)"><span aria-hidden="true">‹</span><span class="sr-only">上一页</span></button>
    <TransitionGroup name="page-number" tag="div" class="page-numbers">
      <template v-for="number in numbers" :key="number">
        <button v-if="typeof number==='number'" class="page-number" :class="{active:number===page}" :aria-current="number===page?'page':undefined" :aria-label="`第 ${number} 页`" :disabled="busy" @click="number!==page&&$emit('change',number)">{{number}}</button>
        <span v-else class="page-ellipsis" aria-hidden="true">…</span>
      </template>
    </TransitionGroup>
    <button class="page-arrow" :disabled="page>=pages||busy" aria-label="下一页" @click="$emit('change',page+1)"><span aria-hidden="true">›</span><span class="sr-only">下一页</span></button>
    <span class="pagination-summary">第 {{page}} / {{pages}} 页</span>
  </nav>
</template>
