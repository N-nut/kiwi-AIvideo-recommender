import { computed, onScopeDispose, ref, watch } from 'vue';
import { APIError, latestRequest } from './api';
import type { HistoryDetail, HistorySummary } from './types';
import type { useAuth } from './useAuth';

export function useHistory(auth:ReturnType<typeof useAuth>) {
  const items=ref<HistorySummary[]>([]),total=ref(0),page=ref(1),loading=ref(false),error=ref('');
  const selected=ref<HistoryDetail|null>(null),selectedId=ref(''),detailLoading=ref(false),detailError=ref('');
  const deleting=ref(''),deleteError=ref('');
  const pages=computed(()=>Math.max(1,Math.ceil(total.value/12)));
  const listLane=latestRequest(),detailLane=latestRequest(),deleteLane=latestRequest();
  let disposed=false;
  async function load() {
    if(disposed||auth.state.value!=='authenticated')return;
    const request=listLane.begin(),account=auth.scope();loading.value=true;error.value='';
    try {
      const data=await account.request<{items:HistorySummary[];total:number}>(`/api/v1/me/history?page=${page.value}&page_size=12`,undefined,undefined,request.signal);
      if(!request.current()||!account.current())return;
      items.value=data.items;total.value=data.total;
      if(page.value>pages.value)page.value=pages.value;
    } catch(exc){if(request.current()&&account.current())error.value=exc instanceof Error?exc.message:'片单读取失败，请重试';}
    finally{if(request.current()&&account.current())loading.value=false;}
  }
  async function open(id:string) {
    if(auth.state.value!=='authenticated')return;
    const request=detailLane.begin(),account=auth.scope();selectedId.value=id;selected.value=null;detailLoading.value=true;detailError.value='';deleteError.value='';
    try {
      const data=await account.request<{history:HistoryDetail}>(`/api/v1/me/history/${encodeURIComponent(id)}`,undefined,undefined,request.signal);
      if(request.current()&&account.current())selected.value=data.history;
    }catch(exc){if(request.current()&&account.current())detailError.value=exc instanceof Error?exc.message:'片单读取失败，请重试';}
    finally{if(request.current()&&account.current())detailLoading.value=false;}
  }
  function back(){detailLane.cancel();selected.value=null;selectedId.value='';detailError.value='';detailLoading.value=false;deleteError.value='';}
  async function remove(id:string) {
    if(deleting.value||auth.state.value!=='authenticated')return false;
    const request=deleteLane.begin(),account=auth.scope();deleting.value=id;deleteError.value='';
    try {
      try{await account.request(`/api/v1/me/history/${encodeURIComponent(id)}`,undefined,'DELETE',request.signal);}
      catch(exc){if(!(exc instanceof APIError&&exc.status===404))throw exc;}
      if(!request.current()||!account.current())return false;
      if(selectedId.value===id)back();
      await load();return true;
    }catch(exc){if(request.current()&&account.current())deleteError.value=exc instanceof Error?exc.message:'删除未确认，请重试或刷新列表';return false;}
    finally{if(request.current()&&account.current())deleting.value='';}
  }
  function clear(){listLane.cancel();detailLane.cancel();deleteLane.cancel();items.value=[];total.value=0;page.value=1;selected.value=null;selectedId.value='';loading.value=false;detailLoading.value=false;deleting.value='';error.value='';detailError.value='';deleteError.value='';}
  watch(page,()=>void load());
  watch(auth.generation,()=>{clear();void load();},{flush:'sync'});
  onScopeDispose(()=>{disposed=true;clear();});
  void load();
  return {items,total,page,pages,loading,error,selected,selectedId,detailLoading,detailError,deleting,deleteError,load,open,back,remove};
}
