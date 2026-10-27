import { computed, getCurrentScope, onScopeDispose, ref, watch } from 'vue';
import { APIError, latestRequest } from './api';
import { StaleAccount } from './useAuth';
import type { Feedback, FeedbackStatus } from './types';
import type { useAuth } from './useAuth';

export function useFeedback(auth:ReturnType<typeof useAuth>) {
  const records=ref(new Map<string,Feedback>()),complete=ref(false),confirmed=ref(false),loading=ref(false);
  const pending=ref(new Set<string>()),unknown=ref(new Set<string>()),error=ref(''),notice=ref('');
  const revision=ref(0),retryAt=ref(0),lastChange=ref<{id:string;feedback:Feedback|null}|null>(null);
  const lane=latestRequest(),reads=new Map<string,ReturnType<typeof latestRequest>>();let disposed=false;
  const reliable=computed(()=>confirmed.value&&complete.value&&!pending.value.size&&!unknown.value.size);
  function setRecord(id:string,value:Feedback|null) {
    const next=new Map(records.value);if(value)next.set(id,value);else next.delete(id);records.value=next;
  }
  function reset(){lane.cancel();for(const read of reads.values())read.cancel();reads.clear();records.value=new Map();pending.value=new Set();unknown.value=new Set();confirmed.value=false;complete.value=false;loading.value=false;error.value='';notice.value='';retryAt.value=0;lastChange.value=null;revision.value++;}
  async function load() {
    if(auth.state.value!=='authenticated'||disposed)return;
    const request=lane.begin(),account=auth.scope(),version=revision.value;
    loading.value=true;error.value='';
    try {
      const data=await account.request<{items:Feedback[];complete:boolean}>('/api/v1/me/feedback/state',undefined,undefined,request.signal);
      if(!request.current()||!account.current()||version!==revision.value)return;
      if(!Array.isArray(data.items)||typeof data.complete!=='boolean')throw Error('反馈状态响应异常，请重试');
      records.value=new Map(data.items.map(item=>[item.work_id,item]));complete.value=data.complete;confirmed.value=true;
    } catch(exc){if(request.current()&&account.current()){confirmed.value=false;error.value=exc instanceof Error?exc.message:'反馈状态加载失败';}}
    finally{if(request.current()&&account.current())loading.value=false;}
  }
  async function readOne(id:string) {
    if(!reads.has(id))reads.set(id,latestRequest());
    const account=auth.scope(),request=reads.get(id)!.begin();
    try{
      const data=await account.request<{feedback:Feedback|null}>(`/api/v1/me/feedback/${encodeURIComponent(id)}`,undefined,undefined,request.signal);
      if(!request.current())throw new StaleAccount();
      if(!('feedback' in data))throw Error('反馈状态响应异常，请重试');
      setRecord(id,data.feedback);return data.feedback;
    }finally{if(request.current())reads.delete(id);}
  }
  async function reconcile(id:string) {
    if(pending.value.has(id))return;
    const account=auth.scope();pending.value.add(id);revision.value++;error.value='';
    try{const value=await readOne(id);if(!account.current())return;
      unknown.value.delete(id);lastChange.value={id,feedback:value};revision.value++;
      notice.value=value?'已核实服务器反馈，可继续修改或撤销。':'已核实，当前没有这部作品的反馈。';await load();
    }catch(exc){if(account.current())error.value=exc instanceof Error?exc.message:'读取失败，请重试';}
    finally{if(account.current()){pending.value.delete(id);revision.value++;}}
  }
  async function mutate(id:string,status:FeedbackStatus|null,expected?:string) {
    if(auth.state.value!=='authenticated'||pending.value.has(id)||unknown.value.has(id)||disposed)return false;
    if(Date.now()<retryAt.value){error.value='操作过于频繁，请稍后重试';return false;}
    const account=auth.scope();pending.value.add(id);revision.value++;lane.cancel();loading.value=false;error.value='';notice.value='';
    try {
      // A truncated or absent snapshot cannot establish that this ID has no row.
      const previous=(!confirmed.value||!complete.value)&&!records.value.has(id)?await readOne(id):records.value.get(id)||null;
      if(!account.current())return false;
      if(status===null){
        const version=expected||previous?.revision;
        if(!version){lastChange.value={id,feedback:null};return true;}
        await account.request(`/api/v1/me/feedback/${encodeURIComponent(id)}`,undefined,'DELETE',undefined,{ifMatch:`"${version}"`});
        setRecord(id,null);lastChange.value={id,feedback:null};
      }else{
        const data=await account.request<{feedback:Feedback}>(`/api/v1/me/feedback/${encodeURIComponent(id)}`,{status,expected_revision:previous?.revision||null},'PATCH');
        setRecord(id,data.feedback);lastChange.value={id,feedback:data.feedback};
      }
      unknown.value.delete(id);return true;
    }catch(exc){if(account.current()){
      if(exc instanceof APIError&&(exc.status===409||exc.status===412)){
        try{await readOne(id);}catch{confirmed.value=false;}
        if(account.current())error.value='反馈已发生变化，已重新读取；请核对后再决定是否修改或撤销。';
      }else if(exc instanceof APIError&&exc.status!==undefined&&exc.status>=400&&exc.status<500){error.value=exc.message;if(exc.retryAfter)retryAt.value=Date.now()+exc.retryAfter*1000;}
      else{unknown.value.add(id);confirmed.value=false;error.value='保存结果暂未确认，请重新读取核对';}
    }return false;
    }finally{if(account.current()){pending.value.delete(id);revision.value++;}}
  }
  watch(auth.generation,()=>{reset();if(auth.state.value==='authenticated')void load();},{flush:'sync'});
  if(getCurrentScope())onScopeDispose(()=>{disposed=true;lane.cancel();for(const read of reads.values())read.cancel();reads.clear();});
  return {records,complete,confirmed,reliable,loading,pending,unknown,error,notice,revision,retryAt,lastChange,load,readOne,reconcile,
    save:(id:string,status:FeedbackStatus)=>mutate(id,status),remove:(id:string,expected?:string)=>mutate(id,null,expected)};
}
