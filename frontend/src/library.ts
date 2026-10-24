import { getCurrentScope, onScopeDispose, ref, watch } from 'vue';
import { latestRequest } from './api';
import type { useAuth } from './useAuth';

export interface FavoritePage<T> {items:T[];total:number;unavailable_count:number;unavailable_ids?:string[];page:number;page_size:number}
export function useLibrary(auth:ReturnType<typeof useAuth>) {
  const saved=ref(new Set<string>()), ready=ref(false), loading=ref(false), error=ref('');
  const total=ref(0), unavailable=ref(0), revision=ref(0), pending=ref(new Set<string>());
  const lane=latestRequest();
  const has=(id:string)=>saved.value.has(id);
  async function load() {
    const request=lane.begin(), account=auth.scope();
    if(auth.state.value!=='authenticated') return;
    loading.value=true;ready.value=false;error.value='';
    try {
      const summary=await account.request<FavoritePage<never>>('/api/v1/me/favorites?page_size=1',undefined,undefined,request.signal);
      const ids=new Set<string>();let page=1, relationTotal=0;
      do {
        const data=await account.request<{items:string[];relation_total:number}>(`/api/v1/me/favorites/ids?page=${page}&page_size=200`,undefined,undefined,request.signal);
        if(!request.current()) return;
        data.items.forEach(id=>ids.add(id));relationTotal=data.relation_total;page++;
      } while((page-1)*200<relationTotal);
      if(!request.current()||!account.current()) return;
      saved.value=ids;total.value=summary.total;unavailable.value=summary.unavailable_count;ready.value=true;
    } catch(exc) {if(request.current()&&account.current()) error.value=exc instanceof Error?exc.message:'收藏状态加载失败';}
    finally {if(request.current()&&account.current()) loading.value=false;}
  }
  async function setSaved(id:string,desired:boolean) {
    if(!ready.value||pending.value.has(id)||auth.state.value!=='authenticated') return false;
    const account=auth.scope();pending.value.add(id);error.value='';
    try {
      await account.request(`/api/v1/me/favorites/${encodeURIComponent(id)}`,undefined,desired?'PUT':'DELETE');
      if(!account.current()) return false;
      if(desired) saved.value.add(id);else saved.value.delete(id);
      revision.value++;
      await load();
      return true;
    } catch(exc) {if(account.current()) error.value=exc instanceof Error?exc.message:'收藏保存失败，请重试';return false;}
    finally {if(account.current()) pending.value.delete(id);}
  }
  watch(auth.generation,()=>{
    lane.cancel();saved.value=new Set();pending.value=new Set();total.value=0;unavailable.value=0;
    ready.value=false;loading.value=false;error.value='';revision.value++;
    if(auth.state.value==='authenticated') void load();
  },{flush:'sync'});
  if(getCurrentScope()) onScopeDispose(()=>lane.cancel());
  return {saved,ready,loading,error,total,unavailable,revision,pending,has,load,setSaved};
}
