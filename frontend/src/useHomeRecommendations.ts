import { computed, getCurrentScope, onScopeDispose, ref, watch, type Ref } from 'vue';
import { api, latestRequest } from './api';
import type { HomeRecommendation } from './types';
import type { useAuth } from './useAuth';
import type { useLibrary } from './library';
import type { useFeedback } from './useFeedback';

export function useHomeRecommendations(auth:ReturnType<typeof useAuth>, library:ReturnType<typeof useLibrary>, view:Ref<string>,feedback?:ReturnType<typeof useFeedback>) {
  const data=ref<HomeRecommendation|null>(null),loading=ref(false),error=ref(''),notice=ref('');
  const revision=ref(0);let dirty=true;
  const lane=latestRequest();
  const works=computed(()=>data.value?.items||[]);
  const prompts=computed(()=>data.value?.prompts||[]);
  const promptTitle=computed(()=>data.value?.prompts_mode==='personalized'?'根据您的收藏，猜您喜欢：':'换个口味试试：');
  function invalidate() {
    lane.cancel();data.value=null;loading.value=false;error.value='';notice.value='';dirty=true;revision.value++;
  }
  async function load() {
    const request=lane.begin(),account=auth.scope(),feedbackVersion=feedback?.revision.value;
    const current=()=>request.current()&&account.current()&&feedbackVersion===feedback?.revision.value;
    dirty=false;loading.value=true;error.value='';notice.value='';
    try {
      if(auth.state.value==='authenticated') {
        try {
          const result=await account.request<HomeRecommendation>('/api/v1/me/home-recommendations',undefined,undefined,request.signal);
          if(current()) data.value=result;
          return;
        } catch {
          if(!current()) return;
          if(!feedback?.reliable.value)throw Error('推荐暂不可用，反馈状态尚未确认，请重试；仍可浏览片库。');
          data.value=null;notice.value='个性化推荐暂不可用，已显示片库精选';
        }
      }
      const result=await api<HomeRecommendation>('/api/v1/home/recommendations',undefined,request.signal);
      if(current()) {
        if(auth.state.value==='authenticated'){
          if(!feedback?.reliable.value)throw Error('反馈状态尚未确认，请重试');
          result.items=result.items.filter(work=>!feedback.records.value.has(work.id));
          notice.value='个性化推荐暂不可用，已显示片库精选，使用上次确认的反馈。';
        }
        data.value=result;
      }
    } catch(exc) {
      if(current()) {data.value=null;notice.value='';error.value=exc instanceof Error?exc.message:'首页推荐加载失败，请重试';}
    } finally {if(current()) loading.value=false;}
  }
  watch([auth.generation,auth.state,library.revision],invalidate,{flush:'sync'});
  if(feedback)watch(feedback.revision,()=>{
    lane.cancel();loading.value=false;dirty=true;
    if(data.value)data.value={...data.value,items:data.value.items.filter(work=>!feedback.records.value.has(work.id))};
  },{flush:'sync'});
  watch([revision,view],()=>{if(view.value==='discover'&&dirty) void load();},{immediate:true});
  if(getCurrentScope()) onScopeDispose(()=>lane.cancel());
  return {data,works,prompts,promptTitle,loading,error,notice,invalidate,load};
}
