import { computed, getCurrentScope, onScopeDispose, readonly, ref, watch } from 'vue';
import { api, latestRequest } from './api';
import type { Preferences, Recommendation } from './types';
import type { useAuth } from './useAuth';
import type { useFeedback } from './useFeedback';
import { clonePreferences, preferenceDiff, reviewPreferences } from './refinement';

export const capacityMessage='本轮记录达到容量上限，请重新浏览本轮或调整偏好';
export function batchPayload(preferences:Preferences,shownIds:Set<string>,limit=3,query='') {
  if(shownIds.size+limit>200)throw Error(capacityMessage);
  const body={preferences,limit,exclude_work_ids:[...shownIds],...(query?{query}:{})};
  if(new TextEncoder().encode(JSON.stringify(body)).byteLength>24000)throw Error(capacityMessage);
  return body;
}
export function useRecommendationBatches(auth:ReturnType<typeof useAuth>,feedback:ReturnType<typeof useFeedback>) {
  const result=ref<Recommendation|null>(null),shownIds=ref(new Set<string>()),snapshot=ref<Preferences|null>(null);
  const busy=ref(false),error=ref(''),notice=ref(''),stale=ref(false),exhausted=ref(false),epoch=ref(0),batch=ref(0);
  const lane=latestRequest();let accountVersion=auth.generation.value;
  const committed=ref<Preferences|null>(null),baseRevision=ref(0);
  let querySnapshot='';
  const canNext=computed(()=>!!committed.value&&!!snapshot.value&&!busy.value&&!stale.value&&!exhausted.value&&!feedback.pending.value.size&&!feedback.unknown.value.size);
  function cancel(){lane.cancel();busy.value=false;}
  function reset(clear=true){cancel();epoch.value++;committed.value=null;baseRevision.value++;snapshot.value=null;querySnapshot='';shownIds.value=new Set();exhausted.value=false;stale.value=false;error.value='';notice.value='';if(clear)result.value=null;else if(result.value)result.value={...result.value,history:null};}
  function catalogChanged(){cancel();if(snapshot.value&&exhausted.value)stale.value=false;exhausted.value=false;notice.value=result.value?'片库已更新，可继续换一批。':'';}
  async function run(preferences?:Preferences,query='',refinement=false) {
    if(busy.value||auth.state.value==='checking'||auth.state.value==='error'||feedback.pending.value.size||feedback.unknown.value.size)return;
    const first=!!preferences;
    if(refinement&&(!committed.value||!preferences||!preferenceDiff(committed.value,preferences).changes.length||reviewPreferences(preferences).issues.length))return false;
    if(first&&!refinement){reset();snapshot.value=JSON.parse(JSON.stringify(preferences));querySnapshot=query;accountVersion=auth.generation.value;}
    if(!snapshot.value||!first&&!canNext.value)return false;
    const excluded=refinement?new Set<string>():shownIds.value;
    let body;try{body=batchPayload(preferences||snapshot.value,excluded,3,refinement?query:querySnapshot);}catch(exc){error.value=(exc as Error).message;return false;}
    const request=lane.begin(),account=auth.scope(),round=epoch.value,version=feedback.revision.value,sourceRevision=baseRevision.value;
    const current=()=>request.current()&&account.current()&&round===epoch.value&&version===feedback.revision.value&&sourceRevision===baseRevision.value;
    busy.value=true;error.value='';notice.value='';
    try {
      const data=auth.state.value==='authenticated'
        ?await account.request<Recommendation>('/api/v1/me/recommendations',body,undefined,request.signal)
        :await api<Recommendation>('/api/v1/recommendations',body,request.signal);
      if(!current())return;
      if(data.status==='needs_confirmation'){error.value=data.warnings.join('；');if(first&&!refinement)result.value=data;return false;}
      if(!Array.isArray(data.items)||(data.status!=='success'&&data.status!=='empty')||(data.status==='success'&&!data.items.length)||(data.status==='empty'&&data.items.length))throw Error('推荐结果无效，请重试');
      const ids=data.items.map(work=>work.id);
      if(new Set(ids).size!==ids.length||ids.some(id=>!id||excluded.has(id)))throw Error('推荐结果含重复作品，请重试');
      if(refinement){
        snapshot.value=clonePreferences(preferences!);querySnapshot=query;
        result.value=data;shownIds.value=new Set(ids);stale.value=false;epoch.value++;batch.value++;
        exhausted.value=data.batch?.state==='exhausted';
        committed.value=clonePreferences(preferences!);baseRevision.value++;
        if(exhausted.value)notice.value='没有更多符合当前条件的作品';
        return true;
      }
      exhausted.value=data.batch?.state==='exhausted';
      if(data.status==='success'&&data.items.length){
        // Reject malformed duplicates rather than silently repeating old works.
        result.value=data;shownIds.value=new Set([...shownIds.value,...ids]);batch.value++;stale.value=false;
      }else if(first)result.value=data;
      else if(data.status==='empty'){stale.value=true;notice.value='没有更多符合当前条件的作品，以下为上次结果。';}
      if(exhausted.value&&!notice.value)notice.value='没有更多符合当前条件的作品';
      if(first){committed.value=clonePreferences(snapshot.value);baseRevision.value++;}
      return true;
    }catch(exc){if(current())error.value=exc instanceof Error?exc.message:'换批失败，请重试';return false;}
    // A successful commit changes epoch/baseRevision; release by request ownership.
    finally{if(request.current()&&account.current())busy.value=false;}
  }
  function restart(){if(snapshot.value)void run(JSON.parse(JSON.stringify(snapshot.value)),querySnapshot);}
  watch(auth.generation,()=>{if(accountVersion!==auth.generation.value){reset(false);if(result.value){stale.value=true;notice.value='当前为上次结果，请按当前身份重新生成片单。';}accountVersion=auth.generation.value;}},{flush:'sync'});
  watch(feedback.revision,()=>{cancel();},{flush:'sync'});
  if(getCurrentScope())onScopeDispose(cancel);
  return {result,shownIds,snapshot,committedPreferences:computed(()=>committed.value?clonePreferences(committed.value):null),baseRevision:readonly(baseRevision),busy,error,notice,stale,exhausted,epoch,batch,canNext,reset,cancel,catalogChanged,generate:(p:Preferences,q='')=>run(p,q),applyRefinement:(p:Preferences,q:string)=>run(p,q,true),next:()=>run(),restart};
}
