<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { FeedbackStatus, HomeWorkItem, Work } from '../types';
import FeedbackMenu from './FeedbackMenu.vue';

const props=defineProps<{ works:(Work | HomeWorkItem)[]; suspended?:boolean;feedbackEnabled?:boolean;feedbackPending?:Set<string> }>();
const emit=defineEmits<{ detail:[work:Work];feedback:[work:Work,status:FeedbackStatus] }>();
// Keep the server's candidate order while retaining defensive display checks.
const slides=computed(()=>Array.from(new Map(props.works.filter(w=>w.cover_url&&w.source_meta?.content_type&&w.source_meta.content_type!=='未标注'&&w.source_meta.content_type!=='漫画').map(w=>[w.id,w])).values()).slice(0,6));
const current=ref(0), reducedMotion=ref(false), hovered=ref(false), focused=ref(false), hidden=ref(false);
const failed=ref(new Set<string>());
const active=computed(()=>slides.value[current.value]);
const upcoming=computed(()=>Array.from({length:Math.min(3,Math.max(0,slides.value.length-1))},(_,offset)=>{
  const index=(current.value+offset+1)%slides.value.length;return {work:slides.value[index]!,index};
}));
let timer:ReturnType<typeof setInterval>|undefined;
let motion:MediaQueryList|undefined;
function go(index:number) {if(slides.value.length) current.value=(index+slides.value.length)%slides.value.length;}
function visibility() {hidden.value=document.hidden;}
function motionChange() {reducedMotion.value=!!motion?.matches;}
function focusOut(event:FocusEvent) {if(!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node|null)) focused.value=false;}
function imageError() {if(active.value) failed.value.add(active.value.id);}
watch(()=>slides.value.map(w=>w.id+w.cover_url).join('|'),()=>{current.value=0;failed.value.clear();});
onMounted(()=>{
  motion=window.matchMedia?.('(prefers-reduced-motion: reduce)');
  motionChange();visibility();
  motion?.addEventListener?.('change',motionChange);
  document.addEventListener('visibilitychange',visibility);
  timer=setInterval(()=>{if(!reducedMotion.value&&!hovered.value&&!focused.value&&!hidden.value&&!props.suspended&&!document.querySelector('dialog[open]')) go(current.value+1);},6000);
});
onUnmounted(()=>{clearInterval(timer);motion?.removeEventListener?.('change',motionChange);document.removeEventListener('visibilitychange',visibility);});
</script>

<template>
  <section v-if="active" class="featured-carousel" aria-label="首页作品推荐" aria-roledescription="轮播" tabindex="0" @pointerenter="hovered=true" @pointerleave="hovered=false" @focusin="focused=true" @focusout="focusOut" @keydown.left.prevent="go(current-1)" @keydown.right.prevent="go(current+1)">
    <div class="featured-atmosphere" aria-hidden="true"><img v-if="!failed.has(active.id)" :src="active.cover_url!" alt="" referrerpolicy="no-referrer"></div>
    <div class="featured-copy" role="group" aria-roledescription="幻灯片" :aria-label="`第 ${current+1} 部，共 ${slides.length} 部`">
      <span class="featured-label">{{'basis' in active && active.basis==='favorites'?'根据收藏推荐':'片库精选'}}</span>
      <h1>{{active.title}}</h1>
      <div class="featured-meta"><span>{{active.source_meta?.content_type}}</span><span v-for="tag in active.genres.slice(0,2)" :key="tag">{{tag}}</span><span v-if="active.source_meta?.episode_count">全 {{active.source_meta.episode_count}} 集</span></div>
      <p>{{active.summary}}</p>
      <p v-if="'basis' in active && active.basis==='favorites'" class="featured-reason">{{active.reason}}</p>
      <div class="featured-actions"><button class="featured-detail" @click="emit('detail',active)">查看详情 <span aria-hidden="true">›</span></button>
      <FeedbackMenu v-if="feedbackEnabled" :title="active.title" :busy="feedbackPending?.has(active.id)" @select="emit('feedback',active,$event)"/>
      </div>
    </div>
    <div class="featured-visual">
    <button class="featured-poster" :aria-label="`查看《${active.title}》详情`" @click="emit('detail',active)">
      <img v-if="!failed.has(active.id)" :key="active.id" :src="active.cover_url!" :alt="`${active.title}封面`" referrerpolicy="no-referrer" @error="imageError">
      <span v-else class="featured-cover-fallback">{{active.title}}<small>封面暂不可用</small></span>
    </button>
    <div class="featured-upcoming" v-if="upcoming.length" aria-label="接下来推荐"><button v-for="item in upcoming" :key="item.work.id" class="featured-thumbnail" :aria-label="`切换到《${item.work.title}》`" @click="go(item.index)"><img v-if="!failed.has(item.work.id)" :src="item.work.cover_url!" alt="" referrerpolicy="no-referrer" @error="failed.add(item.work.id)"><span v-else>{{item.work.title}}</span><span class="thumbnail-index" aria-hidden="true">{{String(item.index+1).padStart(2,'0')}}</span></button></div>
    </div>
    <div v-if="slides.length>1" class="featured-controls">
      <div class="featured-pages" aria-label="选择精选作品"><button v-for="(work,index) in slides" :key="work.id" :class="{active:current===index}" :aria-label="`第 ${index+1} 部：${work.title}`" :aria-pressed="current===index" @click="go(index)"><span></span></button></div>
      <span class="featured-counter">{{current+1}} / {{slides.length}}</span>
      <button class="featured-control" aria-label="上一部精选" @click="go(current-1)"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg></button>
      <button class="featured-control" aria-label="下一部精选" @click="go(current+1)"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button>
    </div>
  </section>
  <section v-else class="featured-empty"><h1>找到下一部想看的故事</h1><p>从作品库逛起，或写下你的观剧偏好。</p></section>
</template>
