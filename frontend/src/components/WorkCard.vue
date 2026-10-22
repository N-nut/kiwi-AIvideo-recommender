<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Work } from '../types';
import { workArt } from '../presentation';
import { posterArt } from '../../../demo/art.mjs';
const props = defineProps<{ work: Work; index: number; saved: boolean }>();
const emit = defineEmits<{ favorite: [id: string]; detail: [work: Work]; preview: [work: Work, anchor: HTMLElement, immediate: boolean]; previewLeave: [] }>();
const art = computed(() => workArt(props.work));
const coverFailed = ref(false);
watch(() => props.work.cover_url, () => { coverFailed.value=false; });
const hasCover = computed(() => !!props.work.cover_url && !coverFailed.value);
const tags = computed(() => [...new Set([...props.work.genres,...props.work.themes,...(props.work.source_meta?.tags || [])])].slice(0,4));
const colors = ['#315946','#5c4378','#9c613c','#405b7e','#546b3b','#82565b'];
const poster = computed(() => posterArt(art.value, colors[props.index % colors.length], `real-${props.work.id}-${props.index}`));
function preview(event: Event, immediate = false) {
  if ('pointerType' in event && event.pointerType === 'touch') return;
  const anchor = (event.currentTarget as HTMLElement).closest<HTMLElement>('article');
  if (anchor) emit('preview', props.work, anchor, immediate);
}
function focusPreview(event: FocusEvent) {
  if ((event.target as HTMLElement).matches('.poster-button:focus-visible')) preview(event, true);
}
</script>
<template>
  <article class="drama-card" @pointerenter="preview($event)" @pointerleave="$emit('previewLeave')" @focusin="focusPreview" @focusout="$emit('previewLeave')">
    <button :class="['poster-button',{'has-cover':hasCover}]" @click="$emit('detail',work)" :aria-label="`查看《${work.title}》资料依据`">
      <img v-if="hasCover" class="source-cover" :src="work.cover_url!" :alt="`${work.title}封面`" loading="lazy" referrerpolicy="no-referrer" @error="coverFailed=true">
      <div v-else class="poster-svg" v-html="poster"></div><span class="poster-tag">{{work.source_meta?.content_type || work.genres[0] || '作品'}}</span>
      <span class="poster-demo">{{hasCover?'红果封面':'ORIGINAL ART'}}</span><span v-if="!hasCover" class="poster-wordmark"><strong>{{work.title.replace(/ 动态漫.*$/,'')}}</strong><small>每个故事，都有来处</small></span><span class="poster-arrow">▷</span><span class="hover-hint">悬停模拟预览 · 点击看资料</span>
    </button>
    <div class="card-body"><div class="card-heading"><h3>{{work.title}}</h3><button class="card-favorite" @click="$emit('favorite',work.id)" :aria-pressed="saved" :aria-label="`${saved?'取消收藏':'收藏'}《${work.title}》`">{{saved?'♥':'♡'}}</button></div>
      <div class="card-tags"><span v-for="tag in tags" :key="tag" class="card-tag">{{tag}}</span><span v-if="!tags.length" class="card-tag">资料可追溯</span></div>
      <p v-if="work.source_meta?.rank" class="source-rank">红果热播榜 #{{work.source_meta.rank}} <span>{{work.source_meta.heat}}</span></p>
      <div class="match-box"><span class="match-label">{{work.reason?'为什么推荐给你':'故事一瞥'}}</span><p>{{work.reason || work.summary}}</p><div v-if="work.caveats?.length" class="caveat">留意：{{work.caveats.join('；')}}</div></div>
      <div class="card-footer"><span>{{work.reason_mode==='template'?'证据模板':work.reason_mode==='model'?'AI 理由 · 已校验引用':'官方资料'}}</span><div class="card-actions"><button class="text-button" :aria-label="`预览《${work.title}》模拟片段`" aria-haspopup="dialog" aria-controls="work-preview" @click="preview($event,true)">▷ 预览</button><button class="text-button" @click="$emit('detail',work)">查看依据 ↗</button></div></div>
    </div>
  </article>
</template>
