<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Work } from '../types';
import { posterArt } from '../../../demo/art.mjs';
const props = defineProps<{ work: Work; index: number; saved: boolean }>();
defineEmits<{ favorite: [id: string]; detail: [work: Work] }>();
const expanded = ref(false);
const art = computed(() => props.work.genres.includes('都市') ? 'city' : props.work.genres.includes('科幻') ? 'space' : props.work.genres.includes('悬疑') ? 'door' : props.work.themes.includes('经营') ? 'shop' : 'sword');
const colors = ['#315946','#5c4378','#9c613c','#405b7e','#546b3b','#82565b'];
const poster = computed(() => posterArt(art.value, colors[props.index % colors.length], `real-${props.work.id}-${props.index}`));
</script>
<template>
  <article class="drama-card" @mouseenter="expanded=true" @mouseleave="expanded=false">
    <button class="poster-button" @click="$emit('detail',work)" :aria-label="`查看《${work.title}》资料依据`">
      <div class="poster-svg" v-html="poster"></div><span class="poster-tag">{{work.genres[0] || '动态漫'}}</span>
      <span class="poster-demo">ORIGINAL ART</span><span class="poster-wordmark"><strong>{{work.title.replace(/ 动态漫.*$/,'')}}</strong><small>每个故事，都有来处</small></span><span class="poster-arrow">↗</span><span class="hover-hint">查看简介与资料依据</span>
    </button>
    <div class="card-body"><div class="card-heading"><h3>{{work.title}}</h3><button class="card-favorite" @click="$emit('favorite',work.id)" :aria-pressed="saved" :aria-label="`${saved?'取消收藏':'收藏'}《${work.title}》`">{{saved?'♥':'♡'}}</button></div>
      <div class="card-tags"><span v-for="tag in [...work.genres,...work.themes].slice(0,4)" :key="tag" class="card-tag">{{tag}}</span><span v-if="!work.themes.length" class="card-tag">资料可追溯</span></div>
      <div class="match-box"><span class="match-label">{{work.reason?'为什么推荐给你':'故事一瞥'}}</span><p>{{work.reason || work.summary}}</p><div v-if="work.caveats?.length" class="caveat">留意：{{work.caveats.join('；')}}</div></div>
      <div class="card-footer"><span>{{work.reason_mode==='template'?'证据模板':work.reason_mode==='model'?'AI 理由 · 已校验引用':'官方资料'}}</span><button class="text-button" @click="$emit('detail',work)">查看依据 ↗</button></div>
      <div v-if="expanded" class="card-source">资料采集于 {{work.collected_at}} · 封面为原创插画</div>
    </div>
  </article>
</template>
