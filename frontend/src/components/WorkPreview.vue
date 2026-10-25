<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import type { Work } from '../types';
import { workArt, workClip } from '../presentation';
import { posterArt } from '../../../demo/art.mjs';
import { createHoverIntent } from '../../../demo/library.mjs';
import { sidePreviewPosition, type PreviewLayout } from '../previewPosition';

const active = shallowRef<{ work: Work; anchor: HTMLElement } | null>(null);
const panel = ref<HTMLElement>();
const video = ref<HTMLVideoElement>();
const playing = ref(false);
const isComic = computed(()=>active.value?.work.source_meta?.content_type==='漫画');
const readingCoverFailed = ref(false);
const blocked = ref(false);
const mediaError = ref(false);
const layout=ref<PreviewLayout>({side:'right',left:12,top:12,width:360});
const inline=computed(()=>layout.value.side==='inline');
const position=computed(()=>inline.value?{width:'100%'}:{left:`${layout.value.left}px`,top:`${layout.value.top}px`,width:`${layout.value.width}px`});
let revision = 0;
let shown = false;
let closing = false;
let dismissedAnchor: HTMLElement | null = null;
let lastPointer:{clientX:number;clientY:number}|undefined;
let observer:MutationObserver|undefined;
const poster = computed(() => active.value
  ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(posterArt(workArt(active.value.work), '#315946', 'hover-preview'))
  : '');

function stopMedia() {
  if (!video.value) return;
  video.value.pause();
  video.value.removeAttribute('src');
  video.value.load();
  playing.value = false;
}

function close(restoreFocus = false, pointer=lastPointer) {
  closing = true;
  try {
    intent.cancel();
    observer?.disconnect();
    revision++;
    const anchor = active.value?.anchor;
    if (restoreFocus && anchor) dismissedAnchor = anchor;
    stopMedia();
    if (shown) panel.value?.hidePopover?.();
    // A side preview can expose a different card beneath its close button.
    if(restoreFocus&&pointer&&document.elementFromPoint) {
      dismissedAnchor=document.elementFromPoint(pointer.clientX,pointer.clientY)?.closest<HTMLElement>('.drama-card')||null;
    }
    shown = false;
    active.value = null;
    if(restoreFocus&&pointer&&document.elementFromPoint) {
      const closedRevision=revision;
      void nextTick(()=>{
        if(closedRevision!==revision||active.value) return;
        // Inline collapse can move the next row under a stationary pointer.
        dismissedAnchor=document.elementFromPoint(pointer.clientX,pointer.clientY)?.closest<HTMLElement>('.drama-card')||null;
        intent.cancel();
      });
    }
    if (restoreFocus && anchor?.isConnected) anchor.querySelector<HTMLButtonElement>('.poster-button')?.focus({ preventScroll: true });
  } finally { closing = false; }
}

function reposition() {
  if (!active.value || !panel.value) return;
  const rect = active.value.anchor.getBoundingClientRect();
  if (!active.value.anchor.isConnected || rect.bottom <= 0 || rect.top >= window.innerHeight) { close(); return; }
  const next=sidePreviewPosition(rect,{width:document.documentElement.clientWidth||window.innerWidth,height:window.innerHeight});
  if((next.side==='inline')!==inline.value) {close();return;}
  layout.value=next;
}

async function play() {
  const target = video.value;
  const current=revision;
  if (!target) return;
  target.muted = true;
  blocked.value = false;
  mediaError.value = false;
  try { await target.play(); }
  catch { if (current===revision && target === video.value) blocked.value = true; }
}

function mediaState(event:Event,state:'play'|'pause'|'error'|'metadata') {
  if(event.target!==video.value||!active.value) return;
  if(state==='error') {mediaError.value=true;blocked.value=true;}
  else if(state==='metadata') reposition();
  else playing.value=state==='play';
}

async function open(value: { work: Work; anchor: HTMLElement }) {
  if (!value.anchor.isConnected || document.querySelector('dialog[open]')) return;
  if (active.value?.anchor === value.anchor && active.value.work.id===value.work.id) return;
  stopMedia();
  if(shown) {panel.value?.hidePopover?.();shown=false;}
  observer?.disconnect();
  const current = ++revision;
  layout.value=sidePreviewPosition(value.anchor.getBoundingClientRect(),{width:document.documentElement.clientWidth||window.innerWidth,height:window.innerHeight});
  active.value = value;
  readingCoverFailed.value=false;
  blocked.value = false;
  mediaError.value = false;
  await nextTick();
  if (current !== revision || !active.value) return;
  if (!inline.value) { panel.value?.showPopover?.(); shown = true; }
  reposition();
  if (!active.value) return;
  observer=new MutationObserver(()=>{if(active.value&&!active.value.anchor.isConnected) close();});
  observer.observe(document.body,{childList:true,subtree:true});
  if (isComic.value) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) blocked.value = true;
  else void play();
}

const intent = createHoverIntent((value: { work: Work; anchor: HTMLElement }) => { void open(value); }, () => close());
function enter(work: Work, anchor: HTMLElement, immediate = false) {
  if (closing) return;
  // Closing the floating panel exposes the underlying card to the same pointer.
  // Wait for a real card leave or an explicit preview click before reopening it.
  if (!immediate && dismissedAnchor === anchor) return;
  dismissedAnchor = null;
  if (immediate) { intent.cancel(); void open({ work, anchor }); }
  else intent.enter({ work, anchor });
}
function leave(anchor?: HTMLElement) {
  if (anchor === dismissedAnchor) dismissedAnchor = null;
  if(panel.value?.matches(':hover')||active.value?.anchor.matches(':hover')) intent.keep();
  else intent.leave();
}
function keep() { intent.keep(); }
function manualPlay() {
  void play();
  void nextTick(()=>panel.value?.querySelector<HTMLButtonElement>('.preview-video-tools button')?.focus({preventScroll:true}));
}
function toggle() { if (video.value?.paused) void play(); else video.value?.pause(); }
function outsideClick(event: MouseEvent) {
  // The play overlay can disappear during its own click before it bubbles here.
  if(!panel.value||!active.value) return;
  const path=event.composedPath();
  if (!path.includes(panel.value) && !path.includes(active.value.anchor)) close();
}
function keyboard(event: KeyboardEvent) {
  if (event.key === 'Escape' && active.value) { event.preventDefault(); close(true); }
}
function pointerMove(event:PointerEvent) {lastPointer={clientX:event.clientX,clientY:event.clientY};}
function visibility() { if (document.hidden) close(); }
function scroll(event: Event) { if (!(event.target instanceof Node) || !panel.value?.contains(event.target)) reposition(); }

onMounted(() => {
  document.addEventListener('click', outsideClick);
  document.addEventListener('keydown', keyboard);
  document.addEventListener('visibilitychange', visibility);
  document.addEventListener('pointermove',pointerMove,{capture:true,passive:true});
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', scroll, { passive: true, capture: true });
});
onBeforeUnmount(() => {
  close();
  document.removeEventListener('click', outsideClick);
  document.removeEventListener('keydown', keyboard);
  document.removeEventListener('visibilitychange', visibility);
  document.removeEventListener('pointermove',pointerMove,true);
  window.removeEventListener('resize', reposition);
  window.removeEventListener('scroll', scroll, true);
});
defineExpose({ enter, leave, close });
</script>

<template>
  <Teleport :to="inline && active?active.anchor:'body'">
    <section v-show="!!active" ref="panel" id="work-preview" :class="['drama-preview','work-preview',{'preview-inline':inline}]" :popover="inline?undefined:'manual'" :data-placement="layout.side" role="dialog" :aria-label="`${active?.work.title||'作品'}${isComic?'阅读资料预览':'模拟视频预览'}`" :style="position" @pointerenter="keep" @pointerleave="leave()" @focusin="keep" @focusout="leave()">
      <template v-if="active">
        <div class="preview-media">
          <div v-if="isComic" class="preview-reading"><img :src="!readingCoverFailed&&active.work.cover_url?active.work.cover_url:poster" :alt="`${active.work.title}封面`" referrerpolicy="no-referrer" @error="readingCoverFailed=true" @load="reposition"><span>漫画资料预览 · {{active.work.source_meta?.chapter_count?`${active.work.source_meta.chapter_count} 话`:'章节资料待补充'}}</span></div>
          <template v-else>
          <video :key="active.work.id" ref="video" :src="workClip(active.work)" :poster="poster" muted loop playsinline preload="metadata" :aria-label="`${active.work.title}原创氛围动画，非真实作品片段`" @play="mediaState($event,'play')" @pause="mediaState($event,'pause')" @loadedmetadata="mediaState($event,'metadata')" @error="mediaState($event,'error')"></video>
          <span class="preview-kicker"><i></i> 视频预览 <small>原创模拟片段</small></span>
          <button v-if="blocked" class="preview-play" @click="manualPlay">{{mediaError?'片段暂不可用 · 重试':'▷ 点击播放预览'}}</button>
          <div class="preview-video-tools"><span>静音循环 · 非真实作品片段</span><button :aria-label="playing?'暂停预览':'播放预览'" @click="toggle">{{playing?'Ⅱ 暂停':'▷ 播放'}}</button></div>
          </template>
          <button class="preview-close" :aria-label="isComic?'关闭漫画预览':'关闭视频预览'" @click="close(true,$event)">×</button>
        </div>
      </template>
    </section>
  </Teleport>
</template>
