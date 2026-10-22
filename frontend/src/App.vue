<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { api, latestRequest, APIError } from './api';
import type { CatalogRefresh, Preferences, Recommendation, Work } from './types';
import { emptyPreferences, genres, fieldNames } from './types';
import { useLibrary } from './library';
import WorkCard from './components/WorkCard.vue';
import WorkPreview from './components/WorkPreview.vue';
import PreferenceEditor from './components/PreferenceEditor.vue';
import logo from '../../demo/assets/kiwi-logo.svg';
import { posterArt } from '../../demo/art.mjs';

const query = ref('想看穿越逆袭的故事，偏好修仙题材。');
const prefs = ref<Preferences>(emptyPreferences());
const parsed = ref(false); const busy = ref(false); const phase = ref(''); const error = ref('');
const view = ref('discover'); const category = ref('全部'); const catalog = ref<Work[]>([]);
const catalogLoading = ref(false); const catalogError = ref(''); const result = ref<Recommendation|null>(null);
const health = ref<{mode?:string;status?:string;storage?:string;works?:number;configured?:boolean}>({});
const refresh = ref<CatalogRefresh>({status:'idle',message:'同步红果真人剧分类首页与热播榜首页'});
const refreshError = ref(''); const refreshStarting = ref(false);
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const refreshLane = latestRequest(); let disposed=false;
const editor = ref<HTMLDialogElement>(); const detail = ref<HTMLDialogElement>(); const login = ref<HTMLDialogElement>(); const guide = ref<HTMLDialogElement>();
const preview = ref<InstanceType<typeof WorkPreview>>();
const detailScroll = ref<HTMLElement>();
let backdropPressed = false;
const draft = ref<Preferences>(emptyPreferences()); const selected = ref<Work|null>(null); const nickname = ref(''); const pendingFavorite = ref('');
const toast = ref(''); let toastTimer: ReturnType<typeof setTimeout>;
const library = useLibrary(); const lane = latestRequest(); const catalogLane = latestRequest();
const examples = ['想看穿越逆袭的故事，偏好修仙题材。','想看都市和系统，主角逐渐成长。','只看玄幻，要有战斗。','想看修仙逆袭，不要后宫。'];
const heroArt = [posterArt('sword','#315946','hero-a'),posterArt('city','#9c613c','hero-b'),posterArt('space','#5c4378','hero-c')];
const visibleWorks = computed(() => view.value==='favorites' ? catalog.value.filter(w=>library.ids().includes(w.id)) : catalog.value.filter(w=>category.value==='全部'||w.genres.includes(category.value)));
const favoriteCount = computed(() => catalog.value.filter(w=>library.has(w.id)).length);
const updating = computed(() => refreshStarting.value || refresh.value.status==='running');
const updatedTime = computed(() => refresh.value.last_success_at ? new Date(refresh.value.last_success_at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '尚未同步');
const chips = computed(() => [...prefs.value.soft_preferences.genres,...prefs.value.soft_preferences.themes,...(prefs.value.soft_preferences.pace?[`节奏${prefs.value.soft_preferences.pace}`]:[]),...prefs.value.required.map(r=>`必须 ${fieldNames[r.field]}：${typeof r.value==='boolean'?(r.value?'有':'无'):r.value}`),...prefs.value.excluded_features.map(f=>`不要${fieldNames[f]}`),...prefs.value.excluded_genres.map(g=>`不要${g}`)]);
const modeLabel = computed(() => health.value.mode==='baseline'?'标签基线模式':health.value.status==='ready'?'真实 AI 推荐':'服务待就绪');
watch(query, () => { lane.cancel(); busy.value=false; parsed.value=false; prefs.value=emptyPreferences(); result.value=null; error.value=''; });
function message(text:string) { clearTimeout(toastTimer); toast.value=text; toastTimer=setTimeout(()=>toast.value='',3000); }
function fail(exc: unknown) { error.value=exc instanceof APIError?`${exc.message}${exc.requestId?`（请求 ${exc.requestId.slice(0,8)}）`:''}`:'无法连接服务，请检查后端后重试。'; }
async function parse() {
  if (!query.value.trim()) { error.value='先说说想看的故事吧。'; return; }
  const request=lane.begin(); busy.value=true; error.value=''; phase.value='正在理解你的口味…';
  try {
    const data=await api<{preferences:Preferences}>('/api/v1/preferences/parse',{text:query.value},request.signal);
    if (!request.current()) return;
    prefs.value=data.preferences; parsed.value=true; result.value=null;
  } catch(exc) { if(request.current()) fail(exc); }
  finally { if(request.current()) busy.value=false; }
}
async function generate() {
  if (!parsed.value) { await parse(); return; }
  const request=lane.begin(); busy.value=true; error.value=''; phase.value='正在检索资料，整理片单…';
  try {
    const data=await api<Recommendation>('/api/v1/recommendations',{preferences:structuredClonePlain(prefs.value),limit:3},request.signal);
    if (!request.current()) return;
    result.value=data;
    if(data.status==='needs_confirmation') error.value=data.warnings.join('；');
  } catch(exc) { if(request.current()) fail(exc); }
  finally { if(request.current()) busy.value=false; }
}
function structuredClonePlain<T>(value:T):T { return JSON.parse(JSON.stringify(value)); }
function edit() { draft.value=structuredClonePlain(prefs.value); editor.value?.showModal(); }
function saveEditor(value: Preferences) { lane.cancel(); busy.value=false; value.conflicts=[]; prefs.value=structuredClonePlain(value); parsed.value=true; result.value=null; error.value=''; editor.value?.close(); }
async function loadCatalog() {
  const request=catalogLane.begin(); catalogLoading.value=true; catalogError.value='';
  try {
    let page=1; const rows: Work[]=[];
    while(request.current()) {
      const data=await api<{items:Work[];total:number}>(`/api/v1/works?page_size=50&page=${page}`,undefined,request.signal);
      rows.push(...data.items);
      if(rows.length>=data.total||data.items.length<50) break;
      page++;
    }
    if(request.current()) catalog.value=rows.sort((a,b)=>(a.source_meta?.rank || 999)-(b.source_meta?.rank || 999));
  }
  catch(exc) { if(request.current()) catalogError.value=exc instanceof Error?exc.message:'片库加载失败'; }
  finally { if(request.current()) catalogLoading.value=false; }
}
async function loadHealth() {
  try { const response=await fetch('/health/ready'); if(!disposed) health.value=await response.json(); }
  catch { if(!disposed) health.value={status:'not_ready'}; }
}
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if(!disposed && refresh.value.status==='running') refreshTimer=setTimeout(()=>void pollRefresh(),1000);
}
async function acceptRefresh(state:CatalogRefresh, finished=false) {
  refresh.value=state;
  if(state.cooldown&&state.status!=='succeeded') message('刚刚尝试过更新，请稍后再试');
  if(state.status==='succeeded'&&finished) {
    lane.cancel(); busy.value=false; result.value=null; preview.value?.close(); detail.value?.close();
    await Promise.all([loadCatalog(),loadHealth()]);
    message(state.cooldown?'刚刚已更新，请稍后再次同步':state.message);
  }
  scheduleRefresh();
}
async function pollRefresh() {
  const request=refreshLane.begin(); refreshError.value='';
  try {
    const state=await api<CatalogRefresh>('/api/v1/catalog/refresh',undefined,request.signal);
    if(request.current()&&!disposed) await acceptRefresh(state,refresh.value.status==='running'&&state.status!=='running');
  } catch(exc) { if(request.current()&&!disposed) refreshError.value='无法获取更新进度，请点击重试。'; }
}
async function updateCatalog() {
  if(updating.value) { await pollRefresh(); return; }
  const request=refreshLane.begin(); refreshStarting.value=true; refreshError.value='';
  try {
    const state=await api<CatalogRefresh>('/api/v1/catalog/refresh',{},request.signal);
    if(request.current()&&!disposed) await acceptRefresh(state,state.status==='succeeded');
  } catch(exc) { if(request.current()&&!disposed) refreshError.value=exc instanceof Error?exc.message:'更新失败，请重试'; }
  finally { if(request.current()) refreshStarting.value=false; }
}
function setView(value:string) { preview.value?.close(); view.value=value; }
function showDetail(work:Work) {
  preview.value?.close();
  selected.value=work;
  detail.value?.showModal();
  void nextTick(() => { if(detailScroll.value) detailScroll.value.scrollTop=0; });
}
function openPreview(work: Work, anchor: HTMLElement, immediate: boolean) { preview.value?.enter(work,anchor,immediate); }
function outsideDetail(event: MouseEvent | PointerEvent) {
  const dialog=event.currentTarget as HTMLDialogElement;
  if(event.target!==dialog) return false;
  const bounds=dialog.getBoundingClientRect();
  return event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom;
}
function startDetailClick(event: PointerEvent) { backdropPressed=outsideDetail(event); }
function finishDetailClick(event: MouseEvent) {
  if(backdropPressed&&outsideDetail(event)) detail.value?.close();
  backdropPressed=false;
}
function favorite(id:string) { if(!library.user.value) { preview.value?.close(); pendingFavorite.value=id; login.value?.showModal(); return; } library.toggle(id); message(library.has(id)?'已加入本机收藏':'已取消收藏'); }
function loginSubmit() { if(library.login(nickname.value)) { if(pendingFavorite.value) library.toggle(pendingFavorite.value); pendingFavorite.value=''; login.value?.close(); message('演示昵称已登录，收藏仅保存在本机'); } }
function featureText(value:boolean|null) { return value===null?'资料未知':value?'明确有':'明确无'; }
onMounted(async()=>{
  void loadCatalog();
  void loadHealth(); void pollRefresh();
});
onUnmounted(()=>{disposed=true;lane.cancel();catalogLane.cancel();refreshLane.cancel();clearTimeout(toastTimer);clearTimeout(refreshTimer);});
</script>

<template>
  <a class="skip-link" href="#query">跳到观剧需求</a>
  <aside class="sidebar"><a class="brand" href="#" @click.prevent="setView('discover')"><span class="brand-icon"><img :src="logo" width="44" height="44" alt=""></span><span>奇维<small>KIWI</small></span></a><div class="nav-caption">你的漫剧指南</div>
    <nav aria-label="主导航"><button :class="['nav-item',{active:view==='discover'}]" :aria-current="view==='discover'?'page':undefined" @click="setView('discover')"><span class="nav-icon">✧</span>发现好剧<span class="nav-dot"></span></button><button :class="['nav-item',{active:view==='catalog'}]" @click="setView('catalog')"><span class="nav-icon">▦</span>真实片库<span class="nav-count">{{catalog.length}}</span></button><button :class="['nav-item',{active:view==='favorites'}]" @click="setView('favorites')"><span class="nav-icon">♡</span>我的收藏<span class="nav-count">{{favoriteCount}}</span></button></nav>
    <div class="sidebar-note"><span class="note-spark">✳</span><strong>好故事，值得被发现。</strong><p>从你的一点偏好出发，<br>找到下一部想追的漫剧。</p><span class="note-line"></span></div><button class="guide-link" @click="guide?.showModal()"><span>ⓘ</span> 使用说明 <span>↗</span></button><div class="sidebar-footer"><i></i> {{health.mode==='baseline'?'标签检索':'RAG 推荐'}}<span>v1.0</span></div>
  </aside>
  <main>
    <header class="topbar"><div class="breadcrumb">发现 <span>/</span><strong>{{view==='discover'?'为你推荐':view==='catalog'?'真实片库':'我的收藏'}}</strong></div><div class="topbar-actions"><button class="catalog-update-button" :disabled="updating&&!refreshError" :aria-busy="updating" @click="updateCatalog"><span :class="{spinning:updating}">↻</span>{{updating?(refreshError?'重试更新进度':'正在更新…'):'更新漫剧库'}}</button><button class="account-button" @click="login?.showModal()">{{library.user.value?`◉ ${library.user.value}`:'演示昵称登录'}}</button><button class="logout-button" v-if="library.user.value" @click="library.logout()">退出</button></div></header>
    <div class="catalog-sync" :class="{failed:refresh.status==='failed'||refreshError}" role="status" aria-live="polite"><span>{{refreshError || (refresh.status==='running'||refresh.status==='failed'?refresh.message:'红果分类与热播榜 · 最近更新 '+updatedTime)}}</span><span class="sync-scope">同步两个来源的当前页 · {{modeLabel}}</span><button v-if="refreshError" class="text-button" @click="pollRefresh">重试 ↻</button></div>
    <section v-if="view==='discover'">
      <section class="hero" aria-labelledby="hero-title"><div class="hero-copy"><div class="eyebrow"><span></span>FOLLOW YOUR TASTE</div><h1 id="hero-title">故事那么多，<br>总有一部<span>刚好对味。</span></h1><p>说说你想看的剧情，让下一次追剧少一点纠结。</p><div class="hero-footer"><span class="hero-stars">✦ ✧ ✦</span><span>每一份推荐，都有资料可循</span></div></div><div class="hero-art" aria-hidden="true"><div v-for="(art,i) in heroArt" :key="i" class="hero-poster"><div v-html="art"></div><span class="hero-poster-title">{{['赴一场奇遇','与故事相遇','心动有迹可循'][i]}}</span></div></div><span class="hero-corner">YOUR NEXT GOOD STORY ↗</span></section>
      <section class="composer" aria-labelledby="composer-title"><div class="section-top"><div><span class="mini-number">01</span><h2 id="composer-title">今天，想看点什么？</h2></div><span class="section-hint">描述 → 确认口味 → 找到好剧</span></div><div class="composer-grid"><div class="query-column"><label class="sr-only" for="query">描述你的观剧需求</label><textarea id="query" v-model="query" maxlength="300" rows="3" placeholder="比如：想看修仙逆袭，节奏快一点……" @keydown.ctrl.enter.prevent="!busy && generate()"></textarea><div class="input-bottom"><span>每次修改描述都会重新识别，偏好由你确认</span><span>{{query.length}} / 300</span></div><div class="example-row"><span>试试这些</span><div class="example-buttons"><button class="example-button" v-for="(example,i) in examples" :key="example" @click="query=example">{{['穿越逆袭','都市成长','玄幻战斗','严格排除'][i]}}</button></div></div><p v-if="error" class="field-error" role="alert">{{error}}</p></div>
        <div class="taste-panel"><div class="taste-heading"><span>✦</span><strong>你的口味</strong><button class="text-button" @click="edit" :disabled="!parsed||busy">调整 ↗</button></div><div class="preference-chips" aria-live="polite"><span v-if="!parsed" class="empty-preferences">先理解你的描述，再由你确认。</span><span v-for="chip in chips" :key="chip" :class="['taste-chip',{exclude:chip.startsWith('不要')}]">{{chip}}</span></div><p v-if="prefs.conflicts.length||prefs.unresolved_constraints.length" class="constraint-warning">{{[...prefs.conflicts,...prefs.unresolved_constraints].join('；')}}。请调整偏好。</p><p v-else>{{parsed?'已识别，确认后按当前偏好生成；也可以点击调整。':'明确排除项会严格执行，未知信息不会放行。'}}</p><button id="recommend-button" class="primary-button" :disabled="busy" @click="generate"><span>{{busy?phase:parsed?'确认偏好，生成片单':'理解我的口味'}}</span><span>{{busy?'◌':'↗'}}</span></button><button v-if="parsed&&!busy" class="text-button reparse" @click="parse">重新理解原始描述</button></div></div></section>
      <section class="results-section" :aria-busy="busy" aria-labelledby="results-title"><div class="section-top result-top"><div><span class="mini-number">02</span><h2 id="results-title">{{busy?'好故事，正在路上':result?(result.items.length?`找到 ${result.items.length} 部对味好剧`:'给偏好一点小调整'):'先逛逛这些好故事'}}</h2><span class="subtle-pill">{{result?'本次推荐':'真实作品'}}</span></div><span class="result-caption">{{result?.timings_ms.total?`${(result.timings_ms.total/1000).toFixed(1)}s · ${result.request_id.slice(0,8)}`:'从已有资料出发'}}</span></div>
        <div v-if="result?.warnings.length" class="result-status" role="status">{{result.warnings.join(' ')}}</div>
        <div v-if="busy" class="drama-grid"><div v-for="i in 3" :key="i" class="skeleton" aria-hidden="true"><div class="skeleton-poster"></div><div class="skeleton-line long"></div></div></div>
        <div v-else-if="result&&!result.items.length" class="empty-state"><span class="empty-icon">⌕</span><h3>{{result.status==='needs_confirmation'?'有些条件需要你确认':'这一种口味，还没有遇到'}}</h3><p>不会自动放宽条件，也不会为凑足数量推荐无关作品。</p><button class="secondary-button" @click="edit">调整我的偏好 ↗</button></div>
        <div v-else class="drama-grid"><WorkCard v-for="(work,i) in result?.items || catalog.slice(0,3)" :key="work.id" :work="work" :index="i" :saved="library.has(work.id)" @favorite="favorite" @detail="showDetail" @preview="openPreview" @preview-leave="preview?.leave()" /></div>
        <div v-if="!result&&!busy&&catalogLoading" class="loading-message" role="status">正在打开真实片库…</div><div v-if="catalogError&&!result" class="empty-state" role="alert"><p>{{catalogError}}</p><button class="secondary-button" @click="loadCatalog">重新加载片库 ↻</button></div><div v-if="!result&&!busy&&!catalogLoading&&!catalog.length&&!catalogError" class="empty-state">片库还没有作品，点击右上角“更新漫剧库”，从红果加载最新资料。</div>
      </section>
    </section>
    <section v-else><div class="catalog-heading"><div class="eyebrow">{{view==='favorites'?'YOUR STORY COLLECTION':'THE STORY SHELF'}}</div><h1>{{view==='favorites'?'喜欢的故事，留在这里。':'每一种口味，都有故事。'}}</h1><p>{{view==='favorites'?'演示昵称与收藏只保存在当前浏览器，不代表真实账号。':'红果真实作品 · 来源封面与简介 · 自动同步'}}</p></div><div v-if="view==='catalog'" class="catalog-filters" aria-label="题材筛选"><button v-for="g in ['全部',...genres]" :key="g" :class="['filter-button',{active:category===g}]" :aria-pressed="category===g" @click="category=g">{{g}}</button></div><div class="catalog-count">{{view==='favorites'?'我的收藏':category}} · {{visibleWorks.length}} 部</div><p v-if="catalogError" role="alert">{{catalogError}} <button class="text-button" @click="loadCatalog">重试</button></p><div class="drama-grid catalog-grid"><WorkCard v-for="(work,i) in visibleWorks" :key="work.id" :work="work" :index="i" :saved="library.has(work.id)" @favorite="favorite" @detail="showDetail" @preview="openPreview" @preview-leave="preview?.leave()" /></div><div v-if="!visibleWorks.length&&!catalogLoading" class="empty-state"><span class="empty-icon">♡</span><h3>{{view==='favorites'?'收藏夹，等一个心动的故事':'这个题材还没有收录作品'}}</h3><button class="secondary-button" @click="view='discover'">回到发现 ↗</button></div></section>
    <footer class="page-footer"><span class="footer-brand"><img :src="logo" alt="" width="18" height="18">奇维 Kiwi</span><span>推荐范围限于已入库资料 · 剧情特征未知时如实保留</span><span class="footer-end">MADE FOR YOUR NEXT STORY</span></footer>
  </main>
  <dialog ref="editor" class="preference-dialog" aria-labelledby="editor-title"><div class="dialog-heading"><div><span class="eyebrow">MAKE IT YOURS</span><h2 id="editor-title">把口味调得更对一点</h2></div><button class="icon-button" @click="editor?.close()" aria-label="关闭偏好设置">×</button></div><PreferenceEditor :preferences="draft" @update="saveEditor" /></dialog>
  <WorkPreview ref="preview" :saved="library.has" @favorite="favorite" @detail="showDetail" />
  <dialog ref="detail" class="work-dialog" aria-labelledby="detail-title" @pointerdown="startDetailClick" @click="finishDetailClick" @close="backdropPressed=false">
    <template v-if="selected">
      <header class="dialog-heading work-dialog-header"><div><span class="eyebrow">EVERY STORY HAS A SOURCE</span><h2 id="detail-title">{{selected.title}}</h2></div><button class="icon-button" @click="detail?.close()" aria-label="关闭作品详情">×</button></header>
      <div ref="detailScroll" class="work-dialog-scroll" tabindex="0" role="region" aria-label="作品资料内容">
        <div v-if="selected.source_meta" class="source-facts"><span>红果 · {{selected.source_meta.content_type}}</span><span v-if="selected.source_meta.episode_count">全 {{selected.source_meta.episode_count}} 集</span><span v-if="selected.source_meta.rank">热播榜 #{{selected.source_meta.rank}}</span><span v-if="selected.source_meta.heat">{{selected.source_meta.heat}}</span></div>
        <p class="detail-intro">{{selected.original_intro}}</p>
        <div class="facts"><span>后宫：{{featureText(selected.harem)}}</span><span>感情线：{{featureText(selected.romance)}}</span><span>虐心：{{featureText(selected.tragic)}}</span></div>
        <h3>资料依据</h3><div class="evidence" v-for="e in selected.evidence" :key="e.id"><small>{{fieldNames[e.field]}} · {{e.id}}</small><blockquote>{{e.quote}}</blockquote></div>
        <p class="source-note">采集于 {{selected.collected_at}}<br>{{selected.review_note}}</p>
      </div>
      <footer class="dialog-actions work-dialog-actions"><span class="dialog-dismiss-hint">点击空白处或按 Esc 关闭</span><a class="secondary-button" :href="selected.source_url" target="_blank" rel="noopener noreferrer">查看官方资料 ↗</a><button class="primary-button" @click="favorite(selected.id)">{{library.has(selected.id)?'♥ 已收藏':'♡ 加入本机收藏'}}</button></footer>
    </template>
  </dialog>
  <dialog ref="login" aria-labelledby="login-title" @close="pendingFavorite='' "><form @submit.prevent="loginSubmit"><div class="dialog-heading"><div><span class="eyebrow">SAVE YOUR NEXT STORY</span><h2 id="login-title">给喜欢的故事，留个位置。</h2></div><button type="button" class="icon-button" @click="login?.close()" aria-label="关闭登录">×</button></div><p class="dialog-intro">填写演示昵称，无需密码。同一昵称可恢复当前浏览器的收藏，不创建真实账号。</p><label class="login-label">演示昵称<input v-model="nickname" maxlength="20" required placeholder="你的昵称"></label><div class="dialog-actions"><button class="primary-button" type="submit">登录体验 ↗</button></div></form></dialog>
  <dialog ref="guide" aria-labelledby="guide-title"><div class="dialog-heading"><h2 id="guide-title">每一份推荐，都有来处。</h2><button class="icon-button" @click="guide?.close()" aria-label="关闭说明">×</button></div><p class="dialog-intro">先理解需求，检查或调整偏好，再确认生成片单。明确的排除和必须条件优先执行。</p><p class="dialog-intro">当前{{modeLabel}}。右上角“更新漫剧库”同步红果真人剧分类首页与红果热播榜首页，按作品标识去重，覆盖更新这两个页面的当前片单。来源包含真人剧、AI剧及未标注类型的作品，保留原站分类；封面来自来源网页，加载失败时使用原创插画。采集资料仅用于开发验证，待人工复核。资料没有说明的感情线、后宫、节奏等保持未知，因此严格条件下可能没有结果。</p><p class="dialog-intro">昵称登录与收藏为本机演示功能。真实片段、真实账号和跨设备同步属于后续范围。</p><a href="/demo/" target="_blank" rel="noopener noreferrer" class="text-button">打开原有模拟视频 Demo ↗</a></dialog>
  <div class="toast" role="status" aria-live="polite" v-if="toast">{{toast}}</div>
</template>
