import { computed, getCurrentScope, onScopeDispose, ref, watch } from 'vue';
import { api, latestRequest } from './api';
import type { Preferences, Recommendation } from './types';
import type { useAuth } from './useAuth';
import type { useFeedback } from './useFeedback';

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
  let querySnapshot='';
  const canNext=computed(()=>!!snapshot.value&&!busy.value&&!stale.value&&!exhausted.value&&!feedback.pending.value.size&&!feedback.unknown.value.size);
  function cancel(){lane.cancel();busy.value=false;}
  function reset(clear=true){cancel();epoch.value++;snapshot.value=null;querySnapshot='';shownIds.value=new Set();exhausted.value=false;stale.value=false;error.value='';notice.value='';if(clear)result.value=null;else if(result.value)result.value={...result.value,history:null};}
  function catalogChanged(){cancel();if(snapshot.value&&exhausted.value)stale.value=false;exhausted.value=false;notice.value=result.value?'片库已更新，可继续换一批。':'';}
  async function run(preferences?:Preferences,query='') {
    if(busy.value||auth.state.value==='checking'||auth.state.value==='error'||feedback.pending.value.size||feedback.unknown.value.size)return;
    const first=!!preferences;
    if(first){reset();snapshot.value=JSON.parse(JSON.stringify(preferences));querySnapshot=query;accountVersion=auth.generation.value;}
    if(!snapshot.value||!first&&!canNext.value)return;
    let body;try{body=batchPayload(snapshot.value,shownIds.value,3,querySnapshot);}catch(exc){notice.value=(exc as Error).message;return;}
    const request=lane.begin(),account=auth.scope(),round=epoch.value,version=feedback.revision.value;
    const current=()=>request.current()&&account.current()&&round===epoch.value&&version===feedback.revision.value;
    busy.value=true;error.value='';notice.value='';
    try {
      const data=auth.state.value==='authenticated'
        ?await account.request<Recommendation>('/api/v1/me/recommendations',body,undefined,request.signal)
        :await api<Recommendation>('/api/v1/recommendations',body,request.signal);
      if(!current())return;
      if(data.status==='needs_confirmation'){error.value=data.warnings.join('；');if(first)result.value=data;return;}
      exhausted.value=data.batch?.state==='exhausted';
      if(data.status==='success'&&data.items.length){
        // Reject malformed duplicates rather than silently repeating old works.
        const ids=data.items.map(work=>work.id);
        if(new Set(ids).size!==ids.length||ids.some(id=>shownIds.value.has(id)))throw Error('推荐结果含重复作品，请重试');
        result.value=data;shownIds.value=new Set([...shownIds.value,...ids]);batch.value++;stale.value=false;
      }else if(first)result.value=data;
      else if(data.status==='empty'){stale.value=true;notice.value='没有更多符合当前条件的作品，以下为上次结果。';}
      if(exhausted.value&&!notice.value)notice.value='没有更多符合当前条件的作品';
    }catch(exc){if(current())error.value=exc instanceof Error?exc.message:'换批失败，请重试';}
    finally{if(current())busy.value=false;}
  }
  function restart(){if(snapshot.value)void run(JSON.parse(JSON.stringify(snapshot.value)),querySnapshot);}
  watch(auth.generation,()=>{if(accountVersion!==auth.generation.value){reset(false);if(result.value){stale.value=true;notice.value='当前为上次结果，请按当前身份重新生成片单。';}accountVersion=auth.generation.value;}},{flush:'sync'});
  watch(feedback.revision,()=>{cancel();},{flush:'sync'});
  if(getCurrentScope())onScopeDispose(cancel);
  return {result,shownIds,snapshot,busy,error,notice,stale,exhausted,epoch,batch,canNext,reset,cancel,catalogChanged,generate:run,next:()=>run(),restart};
}
