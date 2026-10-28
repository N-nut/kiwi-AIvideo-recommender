import { computed, getCurrentScope, onScopeDispose, ref, watch, type Ref } from 'vue';
import { api, APIError, latestRequest } from './api';
import { clonePreferences, preferenceDiff, reviewPreferences } from './refinement';
import type { Preferences, RefinementChange, RefinementPreserved, RefinementResponse } from './types';
import type { useAuth } from './useAuth';
import type { useFeedback } from './useFeedback';
import type { useRecommendationBatches } from './useRecommendationBatches';

export function useRefinement(auth:ReturnType<typeof useAuth>,feedback:ReturnType<typeof useFeedback>,batches:ReturnType<typeof useRecommendationBatches>,view:Ref<string>) {
  const text=ref(''),status=ref<'idle'|'understanding'|'ready'|'no_change'|'needs_confirmation'|'applying'|'error'>('idle');
  const pendingPreferences=ref<Preferences|null>(null),changes=ref<RefinementChange[]>([]),preserved=ref<RefinementPreserved[]>([]),issues=ref<string[]>([]);
  const error=ref(''),notice=ref(''),reviewOpen=ref(false),sourceRevision=ref(0),retryAt=ref(0),now=ref(Date.now());
  const lane=latestRequest();let timer:ReturnType<typeof setInterval>|undefined;
  const busy=computed(()=>status.value==='understanding'||status.value==='applying');
  const count=computed(()=>Array.from(text.value.trim()).length);
  const retrySeconds=computed(()=>Math.max(0,Math.ceil((retryAt.value-now.value)/1000)));
  const available=computed(()=>!!batches.committedPreferences.value);
  const blocked=computed(()=>batches.busy.value||feedback.pending.value.size>0||feedback.unknown.value.size>0||!['guest','authenticated'].includes(auth.state.value));
  const canUnderstand=computed(()=>available.value&&!busy.value&&!blocked.value&&count.value>0&&count.value<=300&&!retrySeconds.value);
  const canApply=computed(()=>status.value==='ready'&&!!pendingPreferences.value&&changes.value.length>0&&!issues.value.length&&!blocked.value&&sourceRevision.value===batches.baseRevision.value);

  function discard(clearText=false){
    lane.cancel();if(status.value==='applying')batches.cancel();
    status.value='idle';pendingPreferences.value=null;changes.value=[];preserved.value=[];issues.value=[];
    error.value='';notice.value='';reviewOpen.value=false;
    if(clearText)text.value='';
  }
  watch(text,()=>discard(),{flush:'sync'});
  watch(auth.generation,()=>discard(true),{flush:'sync'});
  watch([batches.baseRevision,batches.epoch,batches.batch],()=>{
    if(status.value==='applying'&&batches.busy.value)return;
    discard(!batches.committedPreferences.value);
  },{flush:'sync'});
  watch(feedback.revision,()=>discard(),{flush:'sync'});
  watch(view,()=>{if(view.value!=='discover')discard();},{flush:'sync'});

  async function understand(){
    if(!canUnderstand.value)return;
    const base=clonePreferences(batches.committedPreferences.value!),revision=batches.baseRevision.value,input=text.value.trim();
    const body={base_preferences:base,text:input,base_revision:revision};
    if(new TextEncoder().encode(JSON.stringify(body)).byteLength>24000){error.value='请求内容过长，请减少本次条件后重试';return;}
    const request=lane.begin(),account=auth.scope(),round=batches.epoch.value,batch=batches.batch.value;
    const current=()=>request.current()&&account.current()&&view.value==='discover'&&revision===batches.baseRevision.value&&round===batches.epoch.value&&batch===batches.batch.value;
    status.value='understanding';error.value='';notice.value='';reviewOpen.value=false;
    pendingPreferences.value=null;changes.value=[];issues.value=[];preserved.value=[];
    try{
      const data=await api<RefinementResponse>('/api/v1/preferences/refine',body,request.signal);
      if(!current())return;
      if(data.base_revision!==revision)throw Error('基准版本已变化，请重新理解本次调整');
      sourceRevision.value=revision;
      if(data.status==='needs_confirmation'){
        if(data.preferences!==null||data.changes.length||!data.issues.length)throw Error('调整理解结果无效，请重试');
        status.value='needs_confirmation';issues.value=data.issues;preserved.value=data.preserved;reviewOpen.value=true;return;
      }
      if(!data.preferences||data.issues.length)throw Error('调整理解结果无效，请重试');
      const reviewed=reviewPreferences(data.preferences),diff=preferenceDiff(base,reviewed.preferences);
      if(reviewed.issues.length||!['ready','no_change'].includes(data.status)||data.status==='no_change'&&diff.changes.length||data.status==='ready'&&!diff.changes.length)throw Error('调整理解结果无效，请重试或手动核对');
      changes.value=diff.changes;preserved.value=diff.preserved;
      if(data.status==='no_change'){status.value='no_change';notice.value='条件没有变化，当前片单与去重记录已保留。';return;}
      pendingPreferences.value=reviewed.preferences;status.value='ready';reviewOpen.value=true;
    }catch(exc){
      if(!current())return;
      if(exc instanceof APIError&&exc.status===401){auth.expire();return;}
      status.value='error';error.value=exc instanceof Error?`理解调整失败：${exc.message}`:'理解调整失败，请重试';
      if(exc instanceof APIError&&exc.status===429){
        now.value=Date.now();retryAt.value=now.value+(exc.retryAfter||1)*1000;
        clearInterval(timer);timer=setInterval(()=>{now.value=Date.now();if(now.value>=retryAt.value)clearInterval(timer);},1000);
      }
    }
  }
  function editCandidate(){
    return clonePreferences(pendingPreferences.value||batches.committedPreferences.value!);
  }
  function saveCandidate(value:Preferences){
    if(!available.value||busy.value)return;
    const reviewed=reviewPreferences(value),diff=preferenceDiff(batches.committedPreferences.value!,reviewed.preferences);
    sourceRevision.value=batches.baseRevision.value;pendingPreferences.value=reviewed.preferences;
    changes.value=diff.changes;preserved.value=diff.preserved;issues.value=reviewed.issues;error.value='';
    status.value=issues.value.length?'needs_confirmation':diff.changes.length?'ready':'no_change';
    notice.value=diff.changes.length?'':'条件没有变化，当前片单与去重记录已保留。';reviewOpen.value=true;
  }
  async function apply(){
    if(!canApply.value)return false;
    const request=lane.begin(),account=auth.scope(),candidate=clonePreferences(pendingPreferences.value!),input=text.value.trim();
    status.value='applying';error.value='';
    const success=await batches.applyRefinement(candidate,input);
    // Commit changes the source revision. Only the request/account own cleanup.
    if(!request.current()||!account.current())return false;
    if(success){discard(true);return true;}
    status.value='ready';error.value=`生成失败：${batches.error.value||'本次请求未完成，请重试；旧条件与片单已保留'}`;return false;
  }
  if(getCurrentScope())onScopeDispose(()=>{discard();clearInterval(timer);});
  return {text,status,pendingPreferences,changes,preserved,issues,error,notice,reviewOpen,busy,count,retrySeconds,available,canUnderstand,canApply,understand,apply,discard,editCandidate,saveCandidate};
}
