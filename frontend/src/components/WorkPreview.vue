<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import type { Work } from '../types';
import { workArt, workClip } from '../presentation';
import { posterArt } from '../../../demo/art.mjs';
import { createHoverIntent, previewPosition } from '../../../demo/library.mjs';

const props = defineProps<{ saved: (id: string) => boolean }>();
const emit = defineEmits<{ detail: [work: Work]; favorite: [id: string] }>();
const active = shallowRef<{ work: Work; anchor: HTMLElement } | null>(null);
const panel = ref<HTMLElement>();
const video = ref<HTMLVideoElement>();
const playing = ref(false);
const blocked = ref(false);
const mediaError = ref(false);
const position = ref({ left: '12px', top: '12px', width: '420px' });
let revision = 0;
let shown = false;
let closing = false;
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

function close(restoreFocus = false) {
  closing = true;
  try {
    intent.cancel();
    revision++;
    const anchor = active.value?.anchor;
    stopMedia();
    if (shown) panel.value?.hidePopover?.();
    shown = false;
    active.value = null;
    if (restoreFocus && anchor?.isConnected) anchor.querySelector<HTMLButtonElement>('.poster-button')?.focus({ preventScroll: true });
  } finally { closing = false; }
}

function reposition() {
  if (!active.value || !panel.value) return;
  const rect = active.value.anchor.getBoundingClientRect();
  if (!active.value.anchor.isConnected || rect.bottom <= 0 || rect.top >= window.innerHeight) { close(); return; }
  const size = previewPosition(rect, { width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight }, { width: 420, height: panel.value.offsetHeight || 480 });
  position.value = { left: `${size.left}px`, top: `${size.top}px`, width: `${size.width}px` };
}

async function play() {
  const target = video.value;
  if (!target) return;
  target.muted = true;
  blocked.value = false;
  mediaError.value = false;
  try { await target.play(); }
  catch { if (target === video.value) blocked.value = true; }
}

async function open(value: { work: Work; anchor: HTMLElement }) {
  if (!value.anchor.isConnected || document.querySelector('dialog[open]')) return;
  if (active.value?.anchor === value.anchor) return;
  stopMedia();
  const current = ++revision;
  active.value = value;
  blocked.value = false;
  mediaError.value = false;
  await nextTick();
  if (current !== revision || !active.value) return;
  if (!shown) { panel.value?.showPopover?.(); shown = true; }
  reposition();
  if (!active.value) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) blocked.value = true;
  else void play();
}

const intent = createHoverIntent((value: { work: Work; anchor: HTMLElement }) => { void open(value); }, () => close());
function enter(work: Work, anchor: HTMLElement, immediate = false) {
  if (closing) return;
  if (immediate) { intent.cancel(); void open({ work, anchor }); }
  else intent.enter({ work, anchor });
}
function leave() { intent.leave(); }
function keep() { intent.keep(); }
function toggle() { if (video.value?.paused) void play(); else video.value?.pause(); }
function viewDetails() { const work = active.value?.work; close(); if (work) emit('detail', work); }
function saveFavorite() { if (active.value) emit('favorite', active.value.work.id); }
function outsideClick(event: MouseEvent) {
  const target = event.target as Node;
  if (!panel.value?.contains(target) && !active.value?.anchor.contains(target)) close();
}
function keyboard(event: KeyboardEvent) {
  if (event.key === 'Escape' && active.value) { event.preventDefault(); close(panel.value?.contains(document.activeElement) || false); }
}
function visibility() { if (document.hidden) close(); }
function scroll(event: Event) { if (!(event.target instanceof Node) || !panel.value?.contains(event.target)) reposition(); }

onMounted(() => {
  document.addEventListener('click', outsideClick);
  document.addEventListener('keydown', keyboard);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', scroll, { passive: true, capture: true });
});
onBeforeUnmount(() => {
  close();
  document.removeEventListener('click', outsideClick);
  document.removeEventListener('keydown', keyboard);
  document.removeEventListener('visibilitychange', visibility);
  window.removeEventListener('resize', reposition);
  window.removeEventListener('scroll', scroll, true);
});
defineExpose({ enter, leave, close });
</script>

<template>
  <Teleport to="body">
    <section ref="panel" id="work-preview" class="drama-preview work-preview" popover="manual" role="dialog" aria-label="作品模拟视频预览" :style="position" @pointerenter="keep" @pointerleave="leave" @focusin="keep" @focusout="leave">
      <template v-if="active">
        <div class="preview-media">
          <video :key="active.work.id" ref="video" :src="workClip(active.work)" :poster="poster" muted loop playsinline preload="metadata" :aria-label="`${active.work.title}原创氛围动画，非真实作品片段`" @play="playing=true" @pause="playing=false" @loadedmetadata="reposition" @error="mediaError=true;blocked=true"></video>
          <span class="preview-kicker"><i></i> 视频预览 <small>原创模拟片段</small></span>
          <button class="preview-close" aria-label="关闭视频预览" @click="close(true)">×</button>
          <button v-if="blocked" class="preview-play" @click="play">{{mediaError?'片段暂不可用 · 重试':'▷ 点击播放预览'}}</button>
          <div class="preview-video-tools"><span>静音循环 · 非真实作品片段</span><button :aria-label="playing?'暂停预览':'播放预览'" @click="toggle">{{playing?'Ⅱ 暂停':'▷ 播放'}}</button></div>
        </div>
        <div class="preview-body">
          <div class="preview-heading"><div><span class="preview-meta">{{active.work.genres.join(' · ') || '动态漫'}}</span><h2>{{active.work.title}}</h2></div><button class="preview-favorite" :aria-pressed="props.saved(active.work.id)" @click="saveFavorite">{{props.saved(active.work.id)?'♥ 已收藏':'♡ 收藏'}}</button></div>
          <div class="card-tags"><span class="card-tag" v-for="tag in active.work.themes.slice(0,4)" :key="tag">{{tag}}</span></div>
          <p class="preview-intro">{{active.work.summary}}</p>
          <p v-if="active.work.reason" class="preview-caveat">{{active.work.reason}}</p>
          <div class="preview-source"><span>题材氛围演示 · 按题材复用</span><button class="text-button" @click="viewDetails">查看完整资料 ↗</button></div>
        </div>
      </template>
    </section>
  </Teleport>
</template>
