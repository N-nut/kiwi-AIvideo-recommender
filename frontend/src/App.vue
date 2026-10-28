<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { api, getPreview, latestRequest, APIError } from './api';
import type { CatalogRefresh, HistoryDetail, FeedbackStatus, HomeWorkItem, Preferences, PreviewMedia, Work } from './types';
import { emptyPreferences, feedbackLabels, genres, fieldNames, collectionCategories } from './types';
import { useCatalog } from './useCatalog';
import { useLibrary } from './library';
import { useAuth } from './useAuth';
import { useHomeRecommendations } from './useHomeRecommendations';
import { usePersonalSpace } from './usePersonalSpace';
import { useFeedback } from './useFeedback';
import { useRecommendationBatches } from './useRecommendationBatches';
import HistoryPanel from './components/HistoryPanel.vue';
import './history.css';
import FeedbackManager from './components/FeedbackManager.vue';
import './feedback.css';
import PersonalSpace from './components/PersonalSpace.vue';
import PresetAvatar from './components/PresetAvatar.vue';
import './personalSpace.css';
import AuthDialog from './components/AuthDialog.vue';
import LegacyImport from './components/LegacyImport.vue';
import WorkCard from './components/WorkCard.vue';
import WorkPreview from './components/WorkPreview.vue';
import PreferenceEditor from './components/PreferenceEditor.vue';
import PreferenceSummary from './components/PreferenceSummary.vue';
import FeaturedCarousel from './components/FeaturedCarousel.vue';
import CatalogPagination from './components/CatalogPagination.vue';
import logo from '../../demo/assets/kiwi-logo.svg';

const query = ref('想看穿越逆袭的故事，偏好修仙题材。');
const prefs = ref<Preferences>(emptyPreferences());
const parsed = ref(false); const parseBusy = ref(false); const phase = ref(''); const error = ref('');
const requestKind=ref<'parse'|'recommend'|null>(null);
const auth=useAuth();
const feedback=useFeedback(auth);
const batches=useRecommendationBatches(auth,feedback);
const {result}=batches;
const historyId=ref(''),historyWorkLane=latestRequest();
const savedHistoryId=computed(()=>result.value?.history?.status==='saved'?result.value.history.id:'');
const busy=computed(()=>parseBusy.value||batches.busy.value);
const parsing=computed(()=>parseBusy.value&&requestKind.value==='parse');
const library = useLibrary(auth);
const shelf = useCatalog(library,auth);
const {view,genre:category,contentType,page:catalogPage,visibleWorks,displayTotal,pages:catalogPages,loading:catalogLoading,error:catalogError,favoriteCount,favoriteLoading,favoriteError}=shelf;
const home=useHomeRecommendations(auth,library,view,feedback);
const space=usePersonalSpace(auth,library,view);
const updateDialog=ref<HTMLDialogElement>();
const selectedCategories=ref(['comic-drama','ai-drama']); const includeHotRank=ref(false);
const health = ref<{mode?:string;status?:string;storage?:string;works?:number;configured?:boolean}>({});
const refresh = ref<CatalogRefresh>({status:'idle',message:'选择类别，同步红果作品资料'});
const refreshError = ref(''); const refreshStarting = ref(false);
const syncDetails = ref(false);
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const refreshLane = latestRequest(); let disposed=false;
const editor = ref<HTMLDialogElement>(); const detail = ref<HTMLDialogElement>();
const recognition=ref<HTMLDialogElement>();
const login=ref<InstanceType<typeof AuthDialog>>(),legacy=ref<InstanceType<typeof LegacyImport>>();
const preview = ref<InstanceType<typeof WorkPreview>>();
const detailScroll = ref<HTMLElement>();
const detailMedia = ref<PreviewMedia|null>(null);
const detailLane = latestRequest();
function closeDetailMetadata(){detailLane.cancel();detailMedia.value=null;}
let backdropPressed = false;
const draft = ref<Preferences>(emptyPreferences()); const selected = ref<Work|null>(null); const pendingFavorite = ref('');
const pendingView=ref('');
const toast = ref(''); let toastTimer: ReturnType<typeof setTimeout>;
const lane = latestRequest();
const demandVersion=ref(0);
type FeedbackContext={work:Work;status:FeedbackStatus;version:number;batch:number;home:boolean};
const pendingFeedback=ref<FeedbackContext|null>(null);
const undo=ref<{id:string;revision:string;work:Work;index:number;homeIndex:number;homeWork:HomeWorkItem|null;epoch:number;batch:number;version:number}|null>(null);
function resetRound(){batches.reset();demandVersion.value++;pendingFeedback.value=null;undo.value=null;}
function choosePrompt(text:string) {
  closeRecognition();lane.cancel();parseBusy.value=false;requestKind.value=null;parsed.value=false;prefs.value=emptyPreferences();resetRound();error.value='';query.value=text;
}
const updating = computed(() => refreshStarting.value || refresh.value.status==='running');
const updatedTime = computed(() => refresh.value.last_success_at ? new Date(refresh.value.last_success_at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '尚未同步');
const preferenceGroups=computed(()=>[
  {label:'偏爱风格',kind:'soft',values:[...prefs.value.soft_preferences.genres,...prefs.value.soft_preferences.themes,...(prefs.value.soft_preferences.pace?[`节奏${prefs.value.soft_preferences.pace}`]:[])]},
  {label:'必须满足',kind:'required',values:prefs.value.required.map(r=>`${fieldNames[r.field]}：${typeof r.value==='boolean'?(r.value?'有':'无'):r.value}`)},
  {label:'明确排除',kind:'exclude',values:[...prefs.value.excluded_features.map(f=>`不要${fieldNames[f]}`),...prefs.value.excluded_genres.map(g=>`不要${g}`)]},
]);
const preferenceIssues=computed(()=>[...prefs.value.conflicts,...prefs.value.unresolved_constraints]);
const recognitionTitle=computed(()=>preferenceIssues.value.length?'有些偏好需要调整':'您的偏好已识别');
const detailIntro=computed(()=>selected.value?.original_intro.split('\n\n来源标签：')[0]||'');
const detailTags=computed(()=>selected.value?[...new Set([...selected.value.genres,...selected.value.themes,...(selected.value.source_meta?.tags||[])])]:[]);
const comparableText=(value:string)=>value.normalize('NFKC').replace(/\s+/g,'');
const detailReason=computed(()=>{
  const work=selected.value;
  if(!work?.reason) return '';
  const reason=(work.reason_mode==='template'?work.reason.split('简介摘录：')[0]:work.reason).trim();
  const text=comparableText(reason);
  return text&&!comparableText(detailIntro.value).includes(text)&&!comparableText(work.summary).includes(text)?reason:'';
});
const detailEvidence=computed(()=>{
  const work=selected.value;
  if(!work) return [];
  const groups=new Map<string,{quote:string;labels:string[];reference:'intro'|'tags'|null}>();
  const reasonIds=new Set(detailReason.value?work.evidence_ids||[]:[]);
  const judgments:Record<string,string>={};
  for(const field of ['harem','romance','tragic'] as const) {
    if(typeof work[field]==='boolean') judgments[field]=`${fieldNames[field]}：${featureText(work[field])}`;
  }
  if(work.pace) judgments.pace=`节奏：${work.pace}`;
  for(const evidence of work.evidence) {
    const labels=[judgments[evidence.field],reasonIds.has(evidence.id)?'推荐理由':''].filter(Boolean);
    const quote=evidence.quote.trim(),key=comparableText(quote);
    if(!labels.length||!key||!work.original_intro.includes(quote)) continue;
    const sourceTags=quote.match(/^来源标签[：:]\s*(.+)$/)?.[1].split(/[、,，;；\s]+/).filter(Boolean);
    const repeatsIntro=key===comparableText(detailIntro.value)||(key===comparableText(work.summary)&&comparableText(detailIntro.value).startsWith(key));
    const repeatsTags=sourceTags?.length&&sourceTags.every(tag=>detailTags.value.some(shown=>comparableText(shown)===comparableText(tag)));
    const group:{quote:string;labels:string[];reference:'intro'|'tags'|null}=groups.get(key)||{quote,labels:[],reference:repeatsIntro?'intro':repeatsTags?'tags':null};
    group.labels=[...new Set([...group.labels,...labels])];
    groups.set(key,group);
  }
  const shown:{quote:string;label:string;references:('intro'|'tags')[]}[]=[];
  for(const group of groups.values()) {
    const label=group.labels.join(' · ');
    const same=group.reference?shown.find(item=>item.references.length&&item.label===label):undefined;
    if(same&&group.reference) same.references=[...new Set([...same.references,group.reference])];
    else shown.push({quote:group.quote,label,references:group.reference?[group.reference]:[]});
  }
  return shown;
});
function revealDetailReference(reference:'intro'|'tags') {
  const target=detailScroll.value?.querySelector<HTMLElement>(reference==='intro'?'.detail-intro':'.detail-tags');
  target?.focus({preventScroll:true});target?.scrollIntoView({block:'start'});
}
watch(query, () => { closeRecognition();lane.cancel();parseBusy.value=false;requestKind.value=null;parsed.value=false;prefs.value=emptyPreferences();resetRound();error.value=''; });
watch(view,()=>{preview.value?.close();historyWorkLane.cancel();if(view.value!=='discover')closeRecognition();});
function closeRecognition(){if(recognition.value?.open)recognition.value.close();}
function showRecognition(){if(view.value==='discover'&&parsed.value&&!busy.value&&!recognition.value?.open)recognition.value?.showModal();}
function message(text:string) { clearTimeout(toastTimer); toast.value=text; toastTimer=setTimeout(()=>toast.value='',3000); }
function fail(exc: unknown) { error.value=exc instanceof APIError?`${exc.message}${exc.requestId?`（请求 ${exc.requestId.slice(0,8)}）`:''}`:'无法连接服务，请检查后端后重试。'; }
async function parse() {
  if(busy.value)return;
  if (!query.value.trim()) { error.value='先说说想看的故事吧。'; return; }
  closeRecognition();
  resetRound();const request=lane.begin();parseBusy.value=true;requestKind.value='parse';error.value='';phase.value='正在理解你的口味…';
  try {
    const data=await api<{preferences:Preferences}>('/api/v1/preferences/parse',{text:query.value},request.signal);
    if (!request.current()) return;
    prefs.value=data.preferences; parsed.value=true; result.value=null;
    void nextTick(()=>{if(request.current()&&!disposed)showRecognition();});
  } catch(exc) { if(request.current()) fail(exc); }
  finally { if(request.current()){parseBusy.value=false;requestKind.value=null;} }
}
async function generate() {
  if(busy.value)return;
  if (!parsed.value) { await parse(); return; }
  if(preferenceIssues.value.length){showRecognition();return;}
  closeRecognition();
  demandVersion.value++;pendingFeedback.value=null;undo.value=null;
  requestKind.value='recommend';error.value='';phase.value='正在检索资料，整理片单…';
  await batches.generate(structuredClonePlain(prefs.value),query.value);
}
async function reuseHistory(saved:HistoryDetail) {
  const account=auth.scope();
  lane.cancel();parseBusy.value=false;requestKind.value=null;closeRecognition();resetRound();
  query.value=saved.query||'按历史片单的确认偏好再次推荐';
  await nextTick();
  if(!account.current()||auth.state.value!=='authenticated')return;
  prefs.value=structuredClonePlain(saved.preferences);parsed.value=true;error.value='';
  shelf.setView('discover');await nextTick();showRecognition();
}
function openSavedHistory(id:string){historyId.value=id;shelf.setView('history');}
async function historyWorkDetail(work:Work){
  const account=auth.scope(),request=historyWorkLane.begin();
  try{const current=await account.request<Work>(`/api/v1/works/${encodeURIComponent(work.id)}`,undefined,undefined,request.signal);if(request.current()&&account.current()&&view.value==='history')showDetail(current);}
  catch(exc){if(request.current()&&account.current())message(exc instanceof Error?exc.message:'作品资料读取失败，请重试');}
}
function structuredClonePlain<T>(value:T):T { return JSON.parse(JSON.stringify(value)); }
function edit() { closeRecognition();draft.value=structuredClonePlain(prefs.value); editor.value?.showModal(); }
function saveEditor(value: Preferences) { lane.cancel();parseBusy.value=false;requestKind.value=null;value.conflicts=[];prefs.value=structuredClonePlain(value);parsed.value=true;resetRound();error.value='';editor.value?.close(); }
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
  const mediaFinished=!!refresh.value.previews?.active&&!state.previews?.active;
  refresh.value=state;
  if(state.cooldown&&state.status!=='succeeded') message('刚刚尝试过更新，请稍后再试');
  if((state.status==='succeeded'&&finished)||mediaFinished) {
    home.invalidate();
    if(state.status==='succeeded'&&finished)batches.catalogChanged();
    space.invalidate();
    await Promise.all([shelf.reload(),loadHealth()]);
    if(finished) message(state.cooldown?'刚刚已更新，请稍后再次同步':state.message);
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
  if(['favorites','personal-space','feedback','history'].includes(value)&&auth.state.value!=='authenticated') {
    if(auth.state.value==='guest') {pendingFavorite.value='';pendingView.value=value;login.value?.open();}
    else message(auth.state.value==='checking'?'正在检查登录状态':'请先重试检查登录状态');
    return;
  }
  if(value==='history')historyId.value='';
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
  void nextTick(() => {
    if(detailScroll.value) detailScroll.value.scrollTop=0;
    const evidence=detail.value?.querySelector<HTMLDetailsElement>('.detail-evidence');
    if(evidence) evidence.open=false;
  });
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
function openAccount() {pendingFavorite.value='';pendingView.value='personal-space';if(auth.state.value==='error') void auth.restore();else setView('personal-space');}
function dismissLogin() {pendingFavorite.value='';pendingView.value='';pendingFeedback.value=null;}
async function favorite(id:string) {
  if(auth.state.value==='guest') {preview.value?.close();pendingFavorite.value=id;pendingView.value='';login.value?.open();return;}
  if(auth.state.value!=='authenticated') {message('请先检查登录状态');return;}
  if(!library.ready.value) {await library.load();return;}
  if(auth.busy.value) return;
  const desired=!library.has(id);
  if(await library.setSaved(id,desired)) message(desired?'已加入账号收藏':'已取消收藏');
  else if(library.error.value) message(library.error.value);
}
async function loginSuccess() {
  const id=pendingFavorite.value,go=pendingView.value,continuation=pendingFeedback.value,account=auth.scope();dismissLogin();
  await library.load();if(!account.current()) return;
  if(go&&!id) shelf.setView(go);
  if(id) {
    if(!library.ready.value) {message('已登录，收藏状态加载失败，请重试后再次收藏');return;}
    if(await library.setSaved(id,true)) message('已登录并加入账号收藏');
    else if(library.error.value) message(library.error.value);
  }else if(continuation&&continuation.version===demandVersion.value&&continuation.batch===batches.batch.value){
    const visible=continuation.home?home.works.value:result.value?.items||[];
    if(visible.some(work=>work.id===continuation.work.id))await submitFeedback(continuation.work,continuation.status);
    else message('已登录，原推荐已变化，请重新选择反馈');
  }else message('已登录');
}
function feedbackBusy(id:string){return feedback.pending.value.has(id)||feedback.unknown.value.has(id);}
watch(feedback.lastChange,change=>{
  if(change?.feedback&&result.value){
    const index=result.value.items.findIndex(work=>work.id===change.id),work=result.value.items[index];
    if(work){
      undo.value={id:change.id,revision:change.feedback.revision,work,index,homeIndex:-1,homeWork:null,epoch:batches.epoch.value,batch:batches.batch.value,version:demandVersion.value};
      result.value={...result.value,items:result.value.items.filter(item=>item.id!==change.id)};
    }
  }
});
async function submitFeedback(work:Work,status:FeedbackStatus) {
  preview.value?.close();
  if(auth.state.value==='guest'){
    pendingFavorite.value='';pendingView.value='';
    pendingFeedback.value={work,status,version:demandVersion.value,batch:batches.batch.value,home:home.works.value.some(item=>item.id===work.id)};
    login.value?.open();return;
  }
  if(auth.state.value!=='authenticated'){message('请先检查登录状态');return;}
  const account=auth.scope(),epoch=batches.epoch.value,batch=batches.batch.value,version=demandVersion.value;
  const index=result.value?.items.findIndex(item=>item.id===work.id)??-1,homeIndex=home.works.value.findIndex(item=>item.id===work.id);
  const homeWork=home.works.value[homeIndex]||null;
  if(await feedback.save(work.id,status)&&account.current()){
    const saved=feedback.records.value.get(work.id);
    if(!saved)return;
    if(version===demandVersion.value&&batch===batches.batch.value){
      if(result.value)result.value={...result.value,items:result.value.items.filter(item=>item.id!==work.id)};
      undo.value={id:work.id,revision:saved.revision,work,index,homeIndex,homeWork,epoch,batch,version};
    }
    if(home.data.value)home.data.value={...home.data.value,items:home.data.value.items.filter(item=>item.id!==work.id)};
    message(`已标记${feedbackLabels[status]}`);void feedback.load();
  }
}
async function removeFeedback(item:{work_id:string;revision:string}) {
  const account=auth.scope(),restore=undo.value?.id===item.work_id?undo.value:null;
  if(!await feedback.remove(item.work_id,item.revision)||!account.current())return;
  const feedbackVersion=feedback.revision.value;
  message('已撤销反馈，恢复后续推荐资格');
  if(restore&&restore.version===demandVersion.value&&restore.batch===batches.batch.value&&restore.epoch===batches.epoch.value){
    try{
      const fresh=await api<Work>(`/api/v1/works/${encodeURIComponent(item.work_id)}`);
      if(!account.current()||feedbackVersion!==feedback.revision.value||restore.version!==demandVersion.value||restore.batch!==batches.batch.value||restore.epoch!==batches.epoch.value)return;
      const fields=['id','title','summary','original_intro','genres','themes','pace','harem','romance','tragic','source_url','cover_url','source_meta','collected_at','evidence','review_note'] as const;
      if(!fields.some(key=>JSON.stringify(fresh[key]??null)!==JSON.stringify(restore.work[key]??null))){
        if(restore.index>=0&&result.value&&!result.value.items.some(work=>work.id===item.work_id))result.value.items.splice(restore.index,0,restore.work);
        if(restore.homeWork&&restore.homeIndex>=0&&home.data.value&&!home.works.value.some(work=>work.id===item.work_id)&&!fields.some(key=>JSON.stringify(fresh[key]??null)!==JSON.stringify(restore.homeWork![key]??null)))home.data.value.items.splice(restore.homeIndex,0,restore.homeWork);
      }
    }catch{/* Unavailable or changed works only regain eligibility for future requests. */}
  }
  if(account.current()){undo.value=null;void feedback.load();}
}
async function nextBatch(){pendingFeedback.value=null;undo.value=null;preview.value?.close();await batches.next();}
function restartBatch(){pendingFeedback.value=null;undo.value=null;demandVersion.value++;batches.restart();}
async function logout() {if(await auth.logout()){preview.value?.close();detail.value?.close();shelf.setView('discover');message('已退出');}}
const favoriteBusy=(id:string)=>auth.busy.value||auth.state.value==='checking'||auth.state.value==='authenticated'&&(library.loading.value||library.pending.value.has(id));
const favoriteReady=computed(()=>auth.state.value==='guest'||auth.state.value==='authenticated'&&library.ready.value);
watch(auth.generation,()=>{historyId.value='';historyWorkLane.cancel();undo.value=null;if(!auth.user.value){dismissLogin();preview.value?.close();detail.value?.close();if(['feedback','history'].includes(view.value))shelf.setView('discover');}},{flush:'post'});
function featureText(value:boolean|null) { return value===null?'资料未知':value?'明确有':'明确无'; }
onMounted(async()=>{
  void auth.restore();
  void loadCatalog();
  void loadHealth(); void pollRefresh();
});
onUnmounted(()=>{disposed=true;lane.cancel();historyWorkLane.cancel();refreshLane.cancel();closeDetailMetadata();clearTimeout(toastTimer);clearTimeout(refreshTimer);});
</script>

<template>
  <a class="skip-link" href="#query">跳到观剧需求</a>
  <aside class="sidebar">
    <a class="brand" href="#" @click.prevent="setView('discover')"><span class="brand-icon"><img :src="logo" width="44" height="44" alt=""></span><span>奇维<small>KIWI</small></span></a>
    <nav aria-label="主导航">
      <button :class="['nav-item',{active:view==='discover'}]" :aria-current="view==='discover'?'page':undefined" @click="setView('discover')"><span class="nav-icon">⌂</span>发现好剧</button>
      <button :class="['nav-item',{active:view==='catalog'}]" @click="setView('catalog')"><span class="nav-icon">▦</span>片库<span class="nav-count">{{health.works ?? shelf.overall.value}}</span></button>
      <button :class="['nav-item',{active:view==='favorites'}]" @click="setView('favorites')"><span class="nav-icon">♡</span>我的收藏<span class="nav-count">{{favoriteCount}}</span></button>
      <button :class="['nav-item',{active:view==='history'}]" :aria-current="view==='history'?'page':undefined" @click="setView('history')"><span class="nav-icon" aria-hidden="true">◷</span>历史片单</button>
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
      <section :class="['sidebar-account',{active:view==='personal-space'}]" aria-label="账号与个人空间">
        <div class="account-identity">
          <button class="account-avatar" aria-label="进入个人空间" :disabled="auth.state.value==='checking'||auth.busy.value" @click="openAccount"><PresetAvatar :id="auth.user.value?.avatar_id" :src="auth.user.value?.avatar_url"/></button>
          <div class="account-copy">
            <button v-if="auth.user.value" class="account-button" :title="auth.user.value.username" :aria-current="view==='personal-space'?'page':undefined" @click="openAccount">{{auth.user.value.nickname||auth.user.value.username}}</button>
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
    <div v-if="feedback.error.value||feedback.notice.value||undo" class="feedback-notice" role="status">
      <p v-if="feedback.error.value">{{feedback.error.value}}</p><p v-if="feedback.notice.value">{{feedback.notice.value}}</p>
      <button v-for="id in feedback.unknown.value" :key="id" class="text-button" @click="feedback.reconcile(id)">重新读取核对</button>
      <button v-if="undo" class="text-button" :disabled="feedbackBusy(undo.id)" @click="removeFeedback({work_id:undo.id,revision:undo.revision})">撤销刚才的反馈</button>
    </div>

    <section v-if="view==='discover'">
      <FeaturedCarousel :works="home.works.value" :suspended="busy" feedback-enabled :feedback-pending="feedback.pending.value" @detail="showDetail" @feedback="submitFeedback" />
      <div v-if="home.error.value" class="featured-status" role="alert"><span>{{home.error.value}}</span><button class="text-button" @click="home.load">重新加载首页推荐</button></div>
      <p v-else-if="home.loading.value" class="featured-status" role="status">正在加载首页推荐…</p>
      <p v-else-if="!home.works.value.length" class="featured-status">{{auth.state.value==='authenticated'?'暂无可展示的未收藏剧集，可继续浏览片库或更新作品库。':'片库还没有可展示的剧集，点击侧栏“更新漫剧库”即可加载。'}}</p>
      <div v-if="home.notice.value" class="featured-status" role="status">{{home.notice.value}} <button class="text-button" @click="home.load">重试个性化推荐</button></div>
      <p v-if="home.data.value?.warnings.length" class="featured-status" role="status">{{home.data.value.warnings.join('；')}}</p>
      <section class="composer" aria-labelledby="composer-title">
        <div class="section-top composer-heading"><div><h2 id="composer-title">今天，想看点什么？</h2></div><span class="composer-flow">写下需求 <span aria-hidden="true">→</span> 核对偏好 <span aria-hidden="true">→</span> 生成片单</span></div>
        <div class="composer-grid">
          <div class="query-column">
            <label class="query-label" for="query">描述你的观剧需求</label>
            <p id="query-help" class="query-help">说说喜欢的题材、剧情，以及不想看的内容。</p>
            <textarea id="query" v-model="query" maxlength="300" rows="3" aria-describedby="query-help" placeholder="比如：想看修仙逆袭，不要后宫……" @keydown.ctrl.enter.prevent="!busy && generate()"></textarea>
            <div class="input-bottom prompt-intro"><span id="favorite-prompts-title">{{home.promptTitle.value}}</span><span class="query-count">{{query.length}} / 300</span></div>
            <div class="example-buttons favorite-prompt-examples" role="group" aria-labelledby="favorite-prompts-title"><button type="button" class="example-button" v-for="prompt in home.prompts.value" :key="prompt.label" @click="choosePrompt(prompt.text)">{{prompt.label}}</button></div>
            <p v-if="error" class="field-error" role="alert">{{error}}</p>
          </div>
          <div :class="['taste-panel',{recognized:parsed}]" role="region" aria-labelledby="taste-title" :aria-busy="busy">
            <div class="taste-heading"><h3 id="taste-title">你的偏好</h3><span class="taste-state">{{parsing?'识别中':busy?'生成中':parsed?(preferenceIssues.length||result?.status==='needs_confirmation'?'待调整':result?(result.items.length?'已生成片单':'暂无匹配'):'待确认'):'待识别'}}</span><button class="text-button" @click="edit" :disabled="!parsed||busy">调整 ↗</button></div>
            <PreferenceSummary v-if="parsed" class="preference-chips" :groups="preferenceGroups"/>
            <div v-else class="preference-chips preference-placeholder"><span class="empty-preferences">先识别偏好，再由你确认。</span><p>题材、剧情特色和排除项会整理在这里，方便你检查与调整。</p></div>
            <p v-if="preferenceIssues.length" class="constraint-warning" role="alert">{{preferenceIssues.join('；')}}。请调整偏好。</p>
            <p v-else class="taste-next-note">{{parsing?'正在识别，完成后会提示你核对。':result?(result.status==='needs_confirmation'?'请调整待确认的条件后重新生成。':result.items.length?'片单已按以上偏好生成，可继续调整偏好。':'暂时没有符合条件的作品，可调整偏好后重试。'):parsed?'请核对以上偏好，确认后才会生成片单。':'点击下方按钮识别偏好，不会直接生成片单。'}}</p>
            <button id="recommend-button" class="primary-button" :disabled="busy||parsed&&!!preferenceIssues.length" @click="generate"><span>{{busy?phase:parsed?'确认偏好，生成片单':'理解我的口味'}}</span><span aria-hidden="true">{{busy?'◌':'›'}}</span></button>
            <button v-if="parsed&&!busy" class="text-button reparse" @click="parse">重新理解原始描述</button>
          </div>
        </div>
      </section>
      <section class="results-section" :aria-busy="busy" aria-labelledby="results-title">
        <div class="section-top result-top"><div><h2 id="results-title">{{parsing?'正在识别偏好':busy&&!result?'正在查找作品':result?(result.items.length?`找到 ${result.items.length} 部作品`:'你的片单'):'你的片单'}}</h2></div><div class="batch-actions"><span v-if="result?.timings_ms.total" class="result-caption">用时 {{(result.timings_ms.total/1000).toFixed(1)}} 秒</span><button v-if="result?.status==='success'" class="secondary-button next-batch" :disabled="!batches.canNext.value||busy" @click="nextBatch">{{batches.busy.value?'正在换一批…':'换一批'}}</button></div></div>
        <div v-if="batches.error.value||batches.notice.value" class="batch-status" role="status"><span>{{batches.error.value||batches.notice.value}}</span><button v-if="batches.snapshot.value" class="text-button" :disabled="busy" @click="restartBatch">重新浏览本轮</button><button class="text-button" :disabled="busy" @click="edit">调整偏好</button></div>
        <p v-if="auth.state.value==='authenticated'" class="source-note history-save-note"><template v-if="savedHistoryId"><span>已自动保存到历史片单</span> <button class="text-button" @click="openSavedHistory(savedHistoryId)">查看这份片单 →</button></template><template v-else-if="result?.history?.status==='failed'">本次历史片单保存失败，当前结果已保留。</template><template v-else>成功生成的非空片单会自动保存，最近 100 份可在历史片单中查看。</template></p>
        <p v-if="batches.stale.value" class="source-note">上次结果 · 按当前身份重新生成后可继续换批</p>
        <div v-if="result?.warnings.length" class="result-status" role="status">{{result.warnings.join(' ')}}</div>
        <div v-if="parsing" class="parse-progress" role="status"><span class="parse-progress-icon" aria-hidden="true">◌</span><div><strong>正在理解你的观剧需求</strong><p>识别完成后会请你核对偏好，确认后再生成片单。</p></div></div>
        <div v-else-if="busy&&!result" class="drama-grid"><div v-for="i in 3" :key="i" class="skeleton" aria-hidden="true"><div class="skeleton-poster"></div><div class="skeleton-line long"></div></div></div>
        <div v-else-if="result&&!result.items.length" class="empty-state"><h3>{{result.status==='needs_confirmation'?'有些条件需要你确认':result.status==='success'?'本批作品已标记反馈':'这一种口味，还没有遇到'}}</h3><p>{{result.status==='success'?'已标记的作品不再展示，可撤销反馈或换一批继续发现。':'可以主动调整偏好后重试，明确排除的条件不会自动放宽。'}}</p><button class="secondary-button" @click="edit">调整我的偏好</button></div>
        <div v-else-if="result" class="drama-grid"><WorkCard v-for="(work,i) in result.items" :key="work.id" :work="work" :index="i" :saved="library.has(work.id)" :favorite-busy="favoriteBusy(work.id)" :favorite-ready="favoriteReady" feedback-enabled :feedback-busy="feedbackBusy(work.id)" :feedback-status="feedback.records.value.get(work.id)?.status" @feedback="submitFeedback" @favorite="favorite" @detail="showDetail" @preview="openPreview" @preview-leave="preview?.leave($event)" /></div>
        <div v-else :class="['empty-state','generation-guide',{'confirmation-guide':parsed}]">
          <h3>{{parsed?(preferenceIssues.length?'请先调整待确认条件':'偏好已识别，等待你确认'):'三步生成你的片单'}}</h3>
          <p v-if="parsed" class="confirmation-guide-copy">当前还没有生成片单。{{preferenceIssues.length?'请手动调整或移除暂不支持的条件。':'核对上方偏好区，点击“确认偏好，生成片单”即可继续。'}}</p>
          <button v-if="parsed" class="secondary-button" @click="showRecognition">再次核对偏好</button>
          <ol v-else class="generation-steps">
            <li><strong>写下想看的故事</strong><p>在上方描述题材、剧情偏好和不想看的内容，例如“想看修仙逆袭，不要后宫”。</p></li>
            <li><strong>检查识别出的偏好</strong><p>点击“理解我的口味”，确认题材、必须条件和排除项；有偏差时点击“调整”。</p></li>
            <li><strong>确认并生成片单</strong><p>点击“确认偏好，生成片单”，从已有资料中查找最多 3 部作品。点开作品可查看详情与来源。</p></li>
          </ol>
          <p v-if="!parsed" class="source-note">资料未知或条件过严时，可能没有匹配结果。你可以主动调整条件，系统不会自动放宽明确排除项。</p>
        </div>
      </section>
    </section>
    <PersonalSpace v-else-if="view==='personal-space'" :key="auth.generation.value" :space="space" :logout-busy="auth.busy.value" @navigate="setView" @logout="logout"/>
    <HistoryPanel v-else-if="view==='history'&&auth.state.value==='authenticated'" :key="auth.generation.value" :auth="auth" :initial-id="historyId" @back="setView('personal-space')" @discover="setView('discover')" @reuse="reuseHistory" @detail="historyWorkDetail"/>
    <FeedbackManager v-else-if="view==='feedback'" :key="auth.generation.value" :auth="auth" :feedback="feedback" @back="setView('personal-space')" @remove="removeFeedback"/>
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
  <dialog ref="recognition" class="recognition-dialog" aria-labelledby="recognition-title" aria-describedby="recognition-description" @cancel.prevent="closeRecognition">
    <div class="dialog-heading"><h2 id="recognition-title">{{recognitionTitle}}</h2><button type="button" class="icon-button" aria-label="关闭偏好识别提示" @click="closeRecognition">×</button></div>
    <p id="recognition-description">{{preferenceIssues.length?'以下条件需要调整或移除，请核对后手动调整。':'请核对您的偏好，如有不符可手动调整。确认后才会生成片单。'}}</p>
    <PreferenceSummary :groups="preferenceGroups"/>
    <p v-if="preferenceIssues.length" class="recognition-warning" role="alert">{{preferenceIssues.join('；')}}</p>
    <p class="recognition-note">{{preferenceIssues.length?'暂不生成片单，请先处理待确认条件。':'偏好已整理完成，当前尚未生成片单。'}}</p>
    <div class="dialog-actions"><button type="button" class="primary-button" :disabled="busy||!!preferenceIssues.length" autofocus @click="generate">核对无误，生成片单 <span aria-hidden="true">›</span></button><button type="button" class="secondary-button" @click="edit">手动调整偏好</button></div>
  </dialog>
  <dialog ref="editor" class="preference-dialog" aria-labelledby="editor-title"><div class="dialog-heading"><h2 id="editor-title">调整偏好</h2><button class="icon-button" @click="editor?.close()" aria-label="关闭偏好设置">×</button></div><PreferenceEditor :preferences="draft" @update="saveEditor" /></dialog>
  <WorkPreview ref="preview" />
  <dialog ref="detail" class="work-dialog" aria-labelledby="detail-title" @pointerdown="startDetailClick" @click="finishDetailClick" @close="backdropPressed=false;closeDetailMetadata()">
    <template v-if="selected">
      <header class="dialog-heading work-dialog-header"><h2 id="detail-title">{{selected.title}}</h2><button class="icon-button" @click="detail?.close()" aria-label="关闭作品详情">×</button></header>
      <div ref="detailScroll" class="work-dialog-scroll" tabindex="0" role="region" aria-label="作品资料内容">
        <div v-if="selected.source_meta" class="source-facts"><span>{{selected.source_meta.content_type}}</span><span v-if="selected.source_meta.episode_count">全 {{selected.source_meta.episode_count}} 集</span><span v-if="selected.source_meta.chapter_count">{{selected.source_meta.chapter_count}} 话</span><span v-if="selected.source_meta.rank">热播榜 #{{selected.source_meta.rank}}</span></div>
        <p v-if="selected.source_meta?.classification_note" class="source-note">{{selected.source_meta.classification_note}}</p>
        <p class="detail-intro" tabindex="-1">{{detailIntro}}</p>
        <div v-if="detailTags.length" class="detail-tags" tabindex="-1"><span v-for="tag in detailTags" :key="tag">{{tag}}</span></div>
        <div v-if="selected.harem!==null||selected.romance!==null||selected.tragic!==null" class="facts"><span v-if="selected.harem!==null">后宫：{{featureText(selected.harem)}}</span><span v-if="selected.romance!==null">感情线：{{featureText(selected.romance)}}</span><span v-if="selected.tragic!==null">虐心：{{featureText(selected.tragic)}}</span></div>
        <section v-if="detailReason" class="detail-reason" aria-label="本次推荐理由"><h3>本次推荐理由</h3><p>{{detailReason}}</p></section>
        <details v-if="detailEvidence.length" :key="selected.id" class="detail-evidence"><summary><span>判断与推荐依据</span><span class="detail-evidence-count">{{detailEvidence.length}} 条</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></summary><div class="evidence" v-for="e in detailEvidence" :key="e.quote"><small>{{e.label}}</small><div v-if="e.references.length" class="evidence-references"><button v-for="reference in e.references" :key="reference" type="button" class="evidence-reference" @click="revealDetailReference(reference)">查看上方{{reference==='intro'?'故事简介':'题材标签'}} <span aria-hidden="true">↑</span></button></div><blockquote v-else>{{e.quote}}</blockquote></div></details>
        <p class="source-note">{{selected.source_meta?.provider==='hongguo'?'红果资料':'来源资料'}} · 采集于 {{selected.collected_at}}<br>{{selected.source_meta?.provider==='hongguo'?'自动整理，待人工核对。':selected.review_note}}</p>
        <p v-if="detailMedia" class="source-note preview-source"><a :href="detailMedia.source_page_url" target="_blank" rel="noopener noreferrer">{{detailMedia.clip_kind==='trailer'?'真实预告来源':'试看片段来源'}}</a> · {{Math.round(detailMedia.duration_ms/1000)}} 秒</p>
      </div>
      <footer class="dialog-actions work-dialog-actions"><a class="secondary-button" :href="selected.source_url" target="_blank" rel="noopener noreferrer">{{selected.source_meta?.content_type==='漫画'?'查看漫画阅读资料':'查看来源资料'}}</a><button class="primary-button" :disabled="favoriteBusy(selected.id)" @click="favorite(selected.id)">{{favoriteBusy(selected.id)?'正在处理…':!favoriteReady?'重试收藏状态':library.has(selected.id)?'♥ 已收藏':'♡ 收藏'}}</button></footer>
    </template>
  </dialog>
  <AuthDialog ref="login" :auth="auth" @success="loginSuccess" @dismiss="dismissLogin" />
  <div class="toast" role="status" aria-live="polite" v-if="toast">{{toast}}</div>
</template>
