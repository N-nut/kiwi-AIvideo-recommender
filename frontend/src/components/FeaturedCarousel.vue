<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { Work } from '../types';

const props=defineProps<{ works:Work[]; suspended?:boolean }>();
const emit=defineEmits<{ detail:[work:Work] }>();
// This selection deliberately uses catalog order; favorites do not affect it yet.
const slides=computed(()=>Array.from(new Map(props.works.filter(w=>w.cover_url&&w.source_meta?.content_type&&w.source_meta.content_type!=='未标注'&&w.source_meta.content_type!=='漫画').map(w=>[w.id,w])).values()).slice(0,6));
const current=ref(0), paused=ref(false), hovered=ref(false), focused=ref(false), hidden=ref(false);
const failed=ref(new Set<string>());
const active=computed(()=>slides.value[current.value]);
let timer:ReturnType<typeof setInterval>|undefined;
let motion:MediaQueryList|undefined;
function go(index:number) {if(slides.value.length) current.value=(index+slides.value.length)%slides.value.length;}
function visibility() {hidden.value=document.hidden;}
function motionChange() {if(motion?.matches) paused.value=true;}
function focusOut(event:FocusEvent) {if(!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node|null)) focused.value=false;}
function imageError() {if(active.value) failed.value.add(active.value.id);}
watch(()=>slides.value.map(w=>w.id+w.cover_url).join('|'),()=>{current.value=0;failed.value.clear();});
onMounted(()=>{
  motion=window.matchMedia?.('(prefers-reduced-motion: reduce)');
  motionChange();visibility();
  motion?.addEventListener?.('change',motionChange);
  document.addEventListener('visibilitychange',visibility);
  timer=setInterval(()=>{if(!paused.value&&!hovered.value&&!focused.value&&!hidden.value&&!props.suspended&&!document.querySelector('dialog[open]')) go(current.value+1);},6000);
});
onUnmounted(()=>{clearInterval(timer);motion?.removeEventListener?.('change',motionChange);document.removeEventListener('visibilitychange',visibility);});
</script>

<template>
  <section v-if="active" class="featured-carousel" aria-label="片库精选" aria-roledescription="轮播" tabindex="0" @pointerenter="hovered=true" @pointerleave="hovered=false" @focusin="focused=true" @focusout="focusOut" @keydown.left.prevent="go(current-1)" @keydown.right.prevent="go(current+1)">
    <div class="featured-copy" role="group" aria-roledescription="幻灯片" :aria-label="`第 ${current+1} 部，共 ${slides.length} 部`">
      <span class="featured-label">片库精选</span>
      <h1>{{active.title}}</h1>
      <div class="featured-meta"><span>{{active.source_meta?.content_type}}</span><span v-for="tag in active.genres.slice(0,2)" :key="tag">{{tag}}</span><span v-if="active.source_meta?.episode_count">全 {{active.source_meta.episode_count}} 集</span></div>
      <p>{{active.summary}}</p>
      <button class="featured-detail" @click="emit('detail',active)">查看详情 <span aria-hidden="true">›</span></button>
    </div>
    <button class="featured-poster" :aria-label="`查看《${active.title}》详情`" @click="emit('detail',active)">
      <img v-if="!failed.has(active.id)" :key="active.id" :src="active.cover_url!" :alt="`${active.title}封面`" referrerpolicy="no-referrer" @error="imageError">
      <span v-else class="featured-cover-fallback">{{active.title}}<small>封面暂不可用</small></span>
    </button>
    <div v-if="slides.length>1" class="featured-controls">
      <div class="featured-pages" aria-label="选择精选作品"><button v-for="(work,index) in slides" :key="work.id" :class="{active:current===index}" :aria-label="`第 ${index+1} 部：${work.title}`" :aria-pressed="current===index" @click="go(index)"><span></span></button></div>
      <span class="featured-counter">{{current+1}} / {{slides.length}}</span>
      <button class="featured-control" aria-label="上一部精选" @click="go(current-1)">‹</button>
      <button class="featured-control featured-pause" :aria-label="paused?'开启自动轮播':'暂停轮播'" :aria-pressed="paused" @click="paused=!paused">{{paused?'▷':'Ⅱ'}}</button>
      <button class="featured-control" aria-label="下一部精选" @click="go(current+1)">›</button>
    </div>
  </section>
  <section v-else class="featured-empty"><h1>找到下一部想看的故事</h1><p>从作品库逛起，或写下你的观剧偏好。</p></section>
</template>
