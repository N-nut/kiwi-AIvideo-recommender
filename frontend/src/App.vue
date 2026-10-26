<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { api, getPreview, latestRequest, APIError } from './api';
import type { CatalogRefresh, Preferences, PreviewMedia, Recommendation, Work } from './types';
import { emptyPreferences, genres, fieldNames, collectionCategories } from './types';
import { useCatalog } from './useCatalog';
import { useLibrary } from './library';
import { useAuth } from './useAuth';
import { useHomeRecommendations } from './useHomeRecommendations';
import AuthDialog from './components/AuthDialog.vue';
import LegacyImport from './components/LegacyImport.vue';
import WorkCard from './components/WorkCard.vue';
import WorkPreview from './components/WorkPreview.vue';
import PreferenceEditor from './components/PreferenceEditor.vue';
import FeaturedCarousel from './components/FeaturedCarousel.vue';
import CatalogPagination from './components/CatalogPagination.vue';
import logo from '../../demo/assets/kiwi-logo.svg';

const query = ref('想看穿越逆袭的故事，偏好修仙题材。');
const prefs = ref<Preferences>(emptyPreferences());
const parsed = ref(false); const busy = ref(false); const phase = ref(''); const error = ref('');
const auth=useAuth();
const library = useLibrary(auth);
const shelf = useCatalog(library,auth);
const {view,genre:category,contentType,page:catalogPage,visibleWorks,displayTotal,pages:catalogPages,loading:catalogLoading,error:catalogError,favoriteCount,favoriteLoading,favoriteError}=shelf;
const home=useHomeRecommendations(auth,library,view);
const result = ref<Recommendation|null>(null);
const updateDialog=ref<HTMLDialogElement>();
const selectedCategories=ref(['comic-drama','ai-drama']); const includeHotRank=ref(false);
const health = ref<{mode?:string;status?:string;storage?:string;works?:number;configured?:boolean}>({});
const refresh = ref<CatalogRefresh>({status:'idle',message:'选择类别，同步红果作品资料'});
const refreshError = ref(''); const refreshStarting = ref(false);
const syncDetails = ref(false);
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const refreshLane = latestRequest(); let disposed=false;
const editor = ref<HTMLDialogElement>(); const detail = ref<HTMLDialogElement>();
const login=ref<InstanceType<typeof AuthDialog>>(),legacy=ref<InstanceType<typeof LegacyImport>>();
const preview = ref<InstanceType<typeof WorkPreview>>();
const detailScroll = ref<HTMLElement>();
const detailMedia = ref<PreviewMedia|null>(null);
const detailLane = latestRequest();
function closeDetailMetadata(){detailLane.cancel();detailMedia.value=null;}
let backdropPressed = false;
const draft = ref<Preferences>(emptyPreferences()); const selected = ref<Work|null>(null); const pendingFavorite = ref('');
const pendingView=ref(false);
const toast = ref(''); let toastTimer: ReturnType<typeof setTimeout>;
const lane = latestRequest();
function choosePrompt(text:string) {
  lane.cancel();busy.value=false;parsed.value=false;prefs.value=emptyPreferences();result.value=null;error.value='';query.value=text;
}
const updating = computed(() => refreshStarting.value || refresh.value.status==='running');
const updatedTime = computed(() => refresh.value.last_success_at ? new Date(refresh.value.last_success_at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '尚未同步');
const chips = computed(() => [...prefs.value.soft_preferences.genres,...prefs.value.soft_preferences.themes,...(prefs.value.soft_preferences.pace?[`节奏${prefs.value.soft_preferences.pace}`]:[]),...prefs.value.required.map(r=>`必须 ${fieldNames[r.field]}：${typeof r.value==='boolean'?(r.value?'有':'无'):r.value}`),...prefs.value.excluded_features.map(f=>`不要${fieldNames[f]}`),...prefs.value.excluded_genres.map(g=>`不要${g}`)]);
const detailIntro=computed(()=>selected.value?.original_intro.split('\n\n来源标签：')[0]||'');
const detailTags=computed(()=>selected.value?[...new Set([...selected.value.genres,...selected.value.themes,...(selected.value.source_meta?.tags||[])])]:[]);
const detailEvidence=computed(()=>{
  const groups=new Map<string,string[]>();
  for(const evidence of selected.value?.evidence||[]) {
    const labels=groups.get(evidence.quote)||[];
    const label=fieldNames[evidence.field]||'资料';
    if(!labels.includes(label)) labels.push(label);
    groups.set(evidence.quote,labels);
  }
  return Array.from(groups,([quote,labels])=>({quote,label:labels.join('、')}));
});
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
const loadCatalog=()=>shelf.load();
async function loadHealth() {
  try { const response=await fetch('/health/ready'); if(!disposed) health.value=await response.json(); }
  catch { if(!disposed) health.value={status:'not_ready'}; }
}
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if(!disposed && (refresh.value.status==='running'||refresh.value.previews?.active)) refreshTimer=setTimeout(()=>void pollRefresh(),2000);
}
async function acceptRefresh(state:CatalogRefresh, finished=false) {
  refresh.value=state;
  if(state.cooldown&&state.status!=='succeeded') message('刚刚尝试过更新，请稍后再试');
  if(state.status==='succeeded'&&finished) {
    home.invalidate();
    await Promise.all([shelf.reload(),loadHealth()]);
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
function openUpdate() {if(updating.value) {if(refreshError.value) void pollRefresh();return;} updateDialog.value?.showModal();}
const scopeText=computed(()=>refresh.value.scope ? [...refresh.value.scope.categories.map(key=>collectionCategories.find(c=>c.value===key)?.label||key),...(refresh.value.scope.include_hot_rank?['热播榜']:[])].join('、') : '选择类别自动翻页采集');
async function updateCatalog() {
  if(updating.value) { await pollRefresh(); return; }
  const request=refreshLane.begin(); refreshStarting.value=true; refreshError.value='';
  try {
    const state=await api<CatalogRefresh>('/api/v1/catalog/refresh',{categories:[...selectedCategories.value],include_hot_rank:includeHotRank.value},request.signal);
    if(request.current()&&!disposed) {updateDialog.value?.close();await acceptRefresh(state,state.status==='succeeded');}
  } catch(exc) { if(request.current()&&!disposed) refreshError.value=exc instanceof Error?exc.message:'更新失败，请重试'; }
  finally { if(request.current()) refreshStarting.value=false; }
}
function setView(value:string) {
  preview.value?.close();
  if(value==='favorites'&&auth.state.value!=='authenticated') {
    if(auth.state.value==='guest') {pendingFavorite.value='';pendingView.value=true;login.value?.open();}
    else message(auth.state.value==='checking'?'正在检查登录状态':'请先重试检查登录状态');
    return;
  }
  shelf.setView(value);
}
function goToPage(page:number) {
  if(page<1||page>catalogPages.value||page===catalogPage.value) return;
  preview.value?.close(); catalogPage.value=page;
  document.querySelector('.catalog-heading')?.scrollIntoView?.({block:'start'});
}
function showDetail(work:Work) {
  preview.value?.close();
  selected.value=work;
  detail.value?.showModal();
  closeDetailMetadata();
  if(work.source_meta?.content_type!=='漫画') {
    const request=detailLane.begin();
    void getPreview(work.id,request.signal).then(result=>{
      if(request.current()&&detail.value?.open&&selected.value?.id===work.id&&result.work_id===work.id&&result.status==='ready') detailMedia.value=result.preview;
    }).catch(()=>{});
  }
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
  if(backdropPressed&&outsideDetail(event)) (event.currentTarget as HTMLDialogElement).close();
  backdropPressed=false;
}
function openAccount() {pendingFavorite.value='';pendingView.value=false;if(auth.state.value==='error') void auth.restore();else if(auth.state.value==='guest') login.value?.open();}
function dismissLogin() {pendingFavorite.value='';pendingView.value=false;}
async function favorite(id:string) {
  if(auth.state.value==='guest') {preview.value?.close();pendingFavorite.value=id;pendingView.value=false;login.value?.open();return;}
  if(auth.state.value!=='authenticated') {message('请先检查登录状态');return;}
  if(!library.ready.value) {await library.load();return;}
  if(auth.busy.value) return;
  const desired=!library.has(id);
  if(await library.setSaved(id,desired)) message(desired?'已加入账号收藏':'已取消收藏');
  else if(library.error.value) message(library.error.value);
}
async function loginSuccess() {
  const id=pendingFavorite.value, go=pendingView.value,account=auth.scope();dismissLogin();
  await library.load();if(!account.current()) return;
  if(go) shelf.setView('favorites');
  if(id) {
    if(!library.ready.value) {message('已登录，收藏状态加载失败，请重试后再次收藏');return;}
    if(await library.setSaved(id,true)) message('已登录并加入账号收藏');
    else if(library.error.value) message(library.error.value);
  }else message('已登录');
}
async function logout() {if(await auth.logout()){preview.value?.close();detail.value?.close();shelf.setView('discover');message('已退出');}}
const favoriteBusy=(id:string)=>auth.busy.value||auth.state.value==='checking'||auth.state.value==='authenticated'&&(library.loading.value||library.pending.value.has(id));
const favoriteReady=computed(()=>auth.state.value==='guest'||auth.state.value==='authenticated'&&library.ready.value);
watch(auth.generation,()=>{if(!auth.user.value){dismissLogin();preview.value?.close();detail.value?.close();}},{flush:'post'});
function featureText(value:boolean|null) { return value===null?'资料未知':value?'明确有':'明确无'; }
onMounted(async()=>{
  void auth.restore();
  void loadCatalog();
  void loadHealth(); void pollRefresh();
});
onUnmounted(()=>{disposed=true;lane.cancel();refreshLane.cancel();closeDetailMetadata();clearTimeout(toastTimer);clearTimeout(refreshTimer);});
</script>

<template>
  <a class="skip-link" href="#query">跳到观剧需求</a>
  <aside class="sidebar">
    <a class="brand" href="#" @click.prevent="setView('discover')"><span class="brand-icon"><img :src="logo" width="44" height="44" alt=""></span><span>奇维<small>KIWI</small></span></a>
    <nav aria-label="主导航">
      <button :class="['nav-item',{active:view==='discover'}]" :aria-current="view==='discover'?'page':undefined" @click="setView('discover')"><span class="nav-icon">⌂</span>发现好剧</button>
      <button :class="['nav-item',{active:view==='catalog'}]" @click="setView('catalog')"><span class="nav-icon">▦</span>片库<span class="nav-count">{{health.works ?? shelf.overall.value}}</span></button>
      <button :class="['nav-item',{active:view==='favorites'}]" @click="setView('favorites')"><span class="nav-icon">♡</span>我的收藏<span class="nav-count">{{favoriteCount}}</span></button>
    </nav>

    <div class="sidebar-bottom">
      <section class="sidebar-library" aria-label="片库更新">
        <div class="sidebar-section-title"><span>片库管理</span><span class="library-status" :class="{running:updating,failed:refresh.status==='failed'}">{{updating?'更新中':refresh.last_success_at?'已同步':'尚未同步'}}</span></div>
        <button class="catalog-update-button" :disabled="updating&&!refreshError" :aria-busy="updating" @click="openUpdate"><span :class="{spinning:updating}" aria-hidden="true">↻</span>{{updating?(refreshError?'重试更新进度':'正在更新…'):'更新漫剧库'}}</button>
        <div class="catalog-sync" :class="{failed:refresh.status==='failed'||refreshError}" role="status" aria-live="polite">
      <span>{{refreshError || (refresh.status==='running'||refresh.status==='failed'?refresh.message:'最近更新 '+updatedTime)}}</span>
      <span v-if="health.mode==='baseline'" class="baseline-notice">标签基线模式</span>
      <span v-if="refresh.status==='running'" class="sync-counts">已读取 {{refresh.pages_done||0}} 页 · {{refresh.raw_count||0}} 条 · 去重 {{refresh.unique_count||0}} 部</span>
      <span v-if="refresh.status==='running'" class="sync-scope">{{scopeText}}</span>
      <span v-if="refresh.previews?.enabled&&refresh.previews.total" class="sync-preview-count">视频预览 {{refresh.previews.ready}} / {{refresh.previews.total}}<template v-if="refresh.previews.active"> · 补齐中</template><template v-else-if="refresh.previews.error_code"> · 准备暂不可用</template><template v-else-if="refresh.previews.unavailable"> · {{refresh.previews.unavailable}} 部暂不可用</template></span>
      <button v-if="refresh.status==='succeeded'&&refresh.result?.coverage" class="text-button sync-more" :aria-expanded="syncDetails" aria-controls="sync-details" @click="syncDetails=!syncDetails">{{syncDetails?'收起详情':'更新详情'}}</button>
      <button v-if="refreshError" class="text-button" @click="pollRefresh">重试</button>
      <div v-if="refresh.status==='succeeded'&&refresh.result?.coverage&&syncDetails" id="sync-details" class="sync-summary">
        <p class="sync-scope">{{scopeText}} · {{refresh.result.coverage==='limited'?'限定范围':'所选范围'}}</p>
        <p class="sync-counts">{{refresh.result.pages_done||0}} 页 · {{refresh.result.total}} 部；新增 {{refresh.result.new||0}}，更新 {{refresh.result.updated||0}}，未变 {{refresh.result.unchanged||0}}</p>
        <p v-if="refresh.result.filtered_unclassified">已跳过 {{refresh.result.filtered_unclassified}} 部类型不明作品</p>
        <p v-if="refresh.result.same_title_groups" class="constraint-warning">{{refresh.result.same_title_groups}} 组同名资料待核对</p>
      </div>
    </div>
      </section>
      <section class="sidebar-account" aria-label="账号与个人空间">
        <div class="account-identity">
          <span class="account-avatar" aria-label="头像占位"><svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><circle cx="16" cy="11" r="5"/><path d="M6 27c0-6 4-9 10-9s10 3 10 9"/></svg></span>
          <div class="account-copy">
            <strong v-if="auth.user.value" class="account-button" :title="auth.user.value.username">{{auth.user.value.username}}</strong>
            <button v-else class="account-button" :disabled="auth.state.value==='checking'||auth.busy.value" @click="openAccount">{{auth.state.value==='checking'?'正在检查账号…':auth.state.value==='error'?'重试账号状态':'登录 / 注册'}}</button>
            <small>{{auth.user.value?'个人空间':'收藏喜欢的作品'}}</small>
          </div>
        </div>
        <button class="logout-button" v-if="auth.user.value" :disabled="auth.busy.value" @click="logout">{{auth.busy.value?'正在退出…':'退出'}}</button>
      </section>
    </div>
  </aside>
  <main>
    <p v-if="auth.error.value" class="account-notice" role="alert">{{auth.error.value}} <button v-if="auth.state.value==='error'" class="text-button" @click="auth.restore">重试</button><button v-else-if="auth.state.value==='guest'" class="text-button" @click="openAccount">登录</button></p>
    <p v-if="library.error.value" class="account-notice" role="alert">{{library.error.value}} <button class="text-button" @click="library.load">重试收藏状态</button></p>
    <LegacyImport ref="legacy" :auth="auth" :library="library" />

    <section v-if="view==='discover'">
      <FeaturedCarousel :works="home.works.value" :suspended="busy" @detail="showDetail" />
      <div v-if="home.error.value" class="featured-status" role="alert"><span>{{home.error.value}}</span><button class="text-button" @click="home.load">重新加载首页推荐</button></div>
      <p v-else-if="home.loading.value" class="featured-status" role="status">正在加载首页推荐…</p>
      <p v-else-if="!home.works.value.length" class="featured-status">{{auth.state.value==='authenticated'?'暂无可展示的未收藏剧集，可继续浏览片库或更新作品库。':'片库还没有可展示的剧集，点击侧栏“更新漫剧库”即可加载。'}}</p>
      <div v-if="home.notice.value" class="featured-status" role="status">{{home.notice.value}} <button class="text-button" @click="home.load">重试个性化推荐</button></div>
      <p v-if="home.data.value?.warnings.length" class="featured-status" role="status">{{home.data.value.warnings.join('；')}}</p>
      <section class="composer" aria-labelledby="composer-title">
        <div class="section-top"><div><h2 id="composer-title">今天，想看点什么？</h2></div></div>
        <div class="composer-grid">
          <div class="query-column">
            <label class="sr-only" for="query">描述你的观剧需求</label>
            <textarea id="query" v-model="query" maxlength="300" rows="3" placeholder="比如：想看修仙逆袭，不要后宫……" @keydown.ctrl.enter.prevent="!busy && generate()"></textarea>
            <div class="input-bottom prompt-intro"><span id="favorite-prompts-title">{{home.promptTitle.value}}</span><span class="query-count">{{query.length}} / 300</span></div>
            <div class="example-buttons favorite-prompt-examples" role="group" aria-labelledby="favorite-prompts-title"><button type="button" class="example-button" v-for="prompt in home.prompts.value" :key="prompt.label" @click="choosePrompt(prompt.text)">{{prompt.label}}</button></div>
            <p v-if="error" class="field-error" role="alert">{{error}}</p>
          </div>
          <div class="taste-panel">
            <div class="taste-heading"><strong>你的偏好</strong><button class="text-button" @click="edit" :disabled="!parsed||busy">调整 ↗</button></div>
            <div class="preference-chips" aria-live="polite"><span v-if="!parsed" class="empty-preferences">先识别偏好，再由你确认。</span><span v-for="chip in chips" :key="chip" :class="['taste-chip',{exclude:chip.startsWith('不要')}]">{{chip}}</span></div>
            <p v-if="prefs.conflicts.length||prefs.unresolved_constraints.length" class="constraint-warning">{{[...prefs.conflicts,...prefs.unresolved_constraints].join('；')}}。请调整偏好。</p>
            <p v-else>{{parsed?'确认后按当前偏好生成，也可以调整。':'明确排除的内容会严格筛选。'}}</p>
            <button id="recommend-button" class="primary-button" :disabled="busy" @click="generate"><span>{{busy?phase:parsed?'确认偏好，生成片单':'理解我的口味'}}</span><span aria-hidden="true">{{busy?'◌':'›'}}</span></button>
            <button v-if="parsed&&!busy" class="text-button reparse" @click="parse">重新理解原始描述</button>
          </div>
        </div>
      </section>
      <section class="results-section" :aria-busy="busy" aria-labelledby="results-title">
        <div class="section-top result-top"><div><h2 id="results-title">{{busy?'正在查找作品':result?(result.items.length?`找到 ${result.items.length} 部作品`:'请调整偏好'):'你的片单'}}</h2></div><span v-if="result?.timings_ms.total" class="result-caption">用时 {{(result.timings_ms.total/1000).toFixed(1)}} 秒</span></div>
        <div v-if="result?.warnings.length" class="result-status" role="status">{{result.warnings.join(' ')}}</div>
        <div v-if="busy" class="drama-grid"><div v-for="i in 3" :key="i" class="skeleton" aria-hidden="true"><div class="skeleton-poster"></div><div class="skeleton-line long"></div></div></div>
        <div v-else-if="result&&!result.items.length" class="empty-state"><h3>{{result.status==='needs_confirmation'?'有些条件需要你确认':'这一种口味，还没有遇到'}}</h3><p>可以主动调整偏好后重试，明确排除的条件不会自动放宽。</p><button class="secondary-button" @click="edit">调整我的偏好</button></div>
        <div v-else-if="result" class="drama-grid"><WorkCard v-for="(work,i) in result.items" :key="work.id" :work="work" :index="i" :saved="library.has(work.id)" :favorite-busy="favoriteBusy(work.id)" :favorite-ready="favoriteReady" @favorite="favorite" @detail="showDetail" @preview="openPreview" @preview-leave="preview?.leave($event)" /></div>
        <div v-else class="empty-state generation-guide">
          <h3>三步生成你的片单</h3>
          <ol class="generation-steps">
            <li><strong>写下想看的故事</strong><p>在上方描述题材、剧情偏好和不想看的内容，例如“想看修仙逆袭，不要后宫”。</p></li>
            <li><strong>检查识别出的偏好</strong><p>点击“理解我的口味”，确认题材、必须条件和排除项；有偏差时点击“调整”。</p></li>
            <li><strong>确认并生成片单</strong><p>点击“确认偏好，生成片单”，从已有资料中查找最多 3 部作品。点开作品可查看详情与来源。</p></li>
          </ol>
          <p class="source-note">资料未知或条件过严时，可能没有匹配结果。你可以主动调整条件，系统不会自动放宽明确排除项。</p>
        </div>
      </section>
    </section>
    <section v-else class="catalog-section">
      <div class="catalog-heading">
        <div><h1>{{view==='favorites'?'我的收藏':'片库'}}</h1><p>{{view==='favorites'?'收藏保存在当前账号，登录同一账号即可恢复。':'按类别、题材或剧名找作品'}}</p><button v-if="view==='favorites'" class="text-button" @click="legacy?.open()">导入本机旧收藏</button></div>
        <form v-if="view==='catalog'" class="catalog-search" role="search" aria-label="按剧名搜索片库" @submit.prevent="shelf.submitSearch">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>
          <label class="sr-only" for="catalog-search">搜索剧名</label>
          <input id="catalog-search" v-model="shelf.search.value" type="search" maxlength="100" placeholder="搜索剧名，发现想看的故事" autocomplete="off">
          <button v-if="shelf.search.value" type="button" class="search-clear" aria-label="清空搜索" @click="shelf.clearSearch">×</button>
          <button type="submit" class="search-submit">搜索</button>
        </form>
      </div>
      <div v-if="view==='catalog'" class="catalog-filters content-type-filters" aria-label="内容类别筛选"><button v-for="kind in ['全部','漫剧','AI剧','真人剧','漫画']" :key="kind" :class="['filter-button',{active:contentType===kind}]" :aria-pressed="contentType===kind" @click="preview?.close();shelf.setContentType(kind)">{{kind}}</button></div>
      <div v-if="view==='catalog'" class="catalog-filters" aria-label="题材筛选"><button v-for="g in ['全部',...genres]" :key="g" :class="['filter-button',{active:category===g}]" :aria-pressed="category===g" @click="preview?.close();shelf.setGenre(g)">{{g}}</button></div>
      <div class="catalog-count">{{view==='favorites'?'我的收藏':`${contentType} / ${category}`}}<span v-if="view==='catalog'&&shelf.searchTerm.value"> · “{{shelf.searchTerm.value}}”</span> · 共 {{displayTotal}} 部</div>
      <p v-if="favoriteError&&view==='favorites'" role="alert">{{favoriteError}} <button class="text-button" @click="shelf.loadFavorites">重试加载收藏</button></p>
      <p v-if="library.unavailable.value&&view==='favorites'" class="source-note">{{library.unavailable.value}} 部收藏资料已不可用，已从当前展示中排除。</p>
      <details v-if="view==='favorites'&&shelf.unavailableIds.value.length" class="unavailable-favorites"><summary>管理不可用收藏（最多显示 50 部）</summary><ul><li v-for="id in shelf.unavailableIds.value" :key="id"><span>{{id}}</span><button class="text-button" :disabled="favoriteBusy(id)" @click="library.setSaved(id,false)">取消收藏</button></li></ul></details>
      <p v-if="catalogLoading||favoriteLoading&&view==='favorites'" role="status">正在加载作品…</p>
      <p v-if="catalogError" role="alert">{{catalogError}} <button class="text-button" @click="loadCatalog">重试</button></p>
      <div class="drama-grid catalog-grid"><WorkCard v-for="(work,i) in visibleWorks" :key="work.id" :work="work" :index="i" :saved="library.has(work.id)" :favorite-busy="favoriteBusy(work.id)" :favorite-ready="favoriteReady" @favorite="favorite" @detail="showDetail" @preview="openPreview" @preview-leave="preview?.leave($event)" /></div>
      <CatalogPagination :page="catalogPage" :pages="catalogPages" :busy="catalogLoading||favoriteLoading" @change="goToPage" />
      <div v-if="!visibleWorks.length&&!catalogLoading&&!favoriteLoading&&!catalogError&&!favoriteError" class="empty-state"><h3>{{view==='favorites'?'还没有收藏作品':shelf.searchTerm.value?'没有找到相关剧名':'暂时没有符合条件的作品'}}</h3><template v-if="view==='catalog'&&shelf.searchTerm.value"><p>试试其他关键词，或清空搜索后继续浏览。</p><button class="secondary-button" @click="shelf.clearSearch">清空搜索</button></template><button v-else class="secondary-button" @click="setView('discover')">回到首页</button></div>
    </section>
    <footer class="page-footer">作品资料来自红果 · 自动整理，待人工核对</footer>
  </main>

  <dialog ref="updateDialog" class="collection-dialog" aria-labelledby="collection-title">
    <form @submit.prevent="updateCatalog">
      <div class="dialog-heading"><h2 id="collection-title">更新作品库</h2><button class="icon-button" type="button" aria-label="关闭采集设置" @click="updateDialog?.close()">×</button></div>
      <p class="dialog-intro">选择类别，读取红果公开作品资料。</p>
      <fieldset class="collection-options"><legend>采集类别</legend><label v-for="option in collectionCategories" :key="option.value"><input type="checkbox" v-model="selectedCategories" :value="option.value">{{option.label}}</label></fieldset>
      <label class="rank-option"><input type="checkbox" v-model="includeHotRank">补充红果热播榜</label>
      <p class="source-note">每个来源最多 {{refresh.limits?.pages_per_source || 5}} 页，本次最多 {{refresh.limits?.max_pages || 25}} 页、{{refresh.limits?.max_works || 500}} 部。类型不明的记录会跳过，达到上限会说明范围。</p>
      <p v-if="refreshError" class="field-error" role="alert">{{refreshError}}</p>
      <div class="dialog-actions"><button type="submit" class="primary-button" :disabled="updating||!selectedCategories.length&&!includeHotRank">{{refreshStarting?'正在启动…':'开始更新'}}</button></div>
    </form>
  </dialog>
  <dialog ref="editor" class="preference-dialog" aria-labelledby="editor-title"><div class="dialog-heading"><h2 id="editor-title">调整偏好</h2><button class="icon-button" @click="editor?.close()" aria-label="关闭偏好设置">×</button></div><PreferenceEditor :preferences="draft" @update="saveEditor" /></dialog>
  <WorkPreview ref="preview" />
  <dialog ref="detail" class="work-dialog" aria-labelledby="detail-title" @pointerdown="startDetailClick" @click="finishDetailClick" @close="backdropPressed=false;closeDetailMetadata()">
    <template v-if="selected">
      <header class="dialog-heading work-dialog-header"><h2 id="detail-title">{{selected.title}}</h2><button class="icon-button" @click="detail?.close()" aria-label="关闭作品详情">×</button></header>
      <div ref="detailScroll" class="work-dialog-scroll" tabindex="0" role="region" aria-label="作品资料内容">
        <div v-if="selected.source_meta" class="source-facts"><span>{{selected.source_meta.content_type}}</span><span v-if="selected.source_meta.episode_count">全 {{selected.source_meta.episode_count}} 集</span><span v-if="selected.source_meta.chapter_count">{{selected.source_meta.chapter_count}} 话</span><span v-if="selected.source_meta.rank">热播榜 #{{selected.source_meta.rank}}</span></div>
        <p v-if="selected.source_meta?.classification_note" class="source-note">{{selected.source_meta.classification_note}}</p>
        <p class="detail-intro">{{detailIntro}}</p>
        <div v-if="detailTags.length" class="detail-tags"><span v-for="tag in detailTags" :key="tag">{{tag}}</span></div>
        <div v-if="selected.harem!==null||selected.romance!==null||selected.tragic!==null" class="facts"><span v-if="selected.harem!==null">后宫：{{featureText(selected.harem)}}</span><span v-if="selected.romance!==null">感情线：{{featureText(selected.romance)}}</span><span v-if="selected.tragic!==null">虐心：{{featureText(selected.tragic)}}</span></div>
        <details class="detail-evidence"><summary>查看资料依据</summary><div class="evidence" v-for="e in detailEvidence" :key="e.quote"><small>{{e.label}}</small><blockquote>{{e.quote}}</blockquote></div></details>
        <p class="source-note">{{selected.source_meta?.provider==='hongguo'?'红果资料':'来源资料'}} · 采集于 {{selected.collected_at}}<br>{{selected.source_meta?.provider==='hongguo'?'自动整理，待人工核对。':selected.review_note}}</p>
        <p v-if="detailMedia" class="source-note preview-source"><a :href="detailMedia.source_page_url" target="_blank" rel="noopener noreferrer">{{detailMedia.clip_kind==='trailer'?'真实预告来源':'试看片段来源'}}</a> · {{Math.round(detailMedia.duration_ms/1000)}} 秒</p>
      </div>
      <footer class="dialog-actions work-dialog-actions"><a class="secondary-button" :href="selected.source_url" target="_blank" rel="noopener noreferrer">{{selected.source_meta?.content_type==='漫画'?'查看漫画阅读资料':'查看来源资料'}}</a><button class="primary-button" :disabled="favoriteBusy(selected.id)" @click="favorite(selected.id)">{{favoriteBusy(selected.id)?'正在处理…':!favoriteReady?'重试收藏状态':library.has(selected.id)?'♥ 已收藏':'♡ 收藏'}}</button></footer>
    </template>
  </dialog>
  <AuthDialog ref="login" :auth="auth" @success="loginSuccess" @dismiss="dismissLogin" />
  <div class="toast" role="status" aria-live="polite" v-if="toast">{{toast}}</div>
</template>
