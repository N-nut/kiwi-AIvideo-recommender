import { onScopeDispose, ref, watch } from 'vue';
import { APIError, latestRequest } from './api';
import type { useAuth } from './useAuth';
import type { Correction } from './corrections';
import { operationId } from './corrections';

export function useCorrections(auth:ReturnType<typeof useAuth>){
  const items=ref<Correction[]>([]),total=ref(0),page=ref(1),status=ref(''),loading=ref(false),error=ref('');
  const busy=ref(false),unknown=ref(false),saved=ref<Correction|null>(null),submitError=ref('');
  const forbidden=ref(false);
  const listLane=latestRequest(),submitLane=latestRequest();
  let pending:{path:string;body:Record<string,unknown>}|null=null;
  async function load(){if(auth.state.value!=='authenticated')return;const lane=listLane.begin(),account=auth.scope();loading.value=true;error.value='';
    try{const params=new URLSearchParams({page:String(page.value),page_size:'12'});if(status.value)params.set('status',status.value);const data=await account.request<{items:Correction[];total:number}>(`/api/v1/me/corrections?${params}`,undefined,undefined,lane.signal);if(account.current()&&lane.current()){items.value=data.items;total.value=data.total;}}
    catch(exc){if(account.current()&&lane.current())error.value=exc instanceof Error?exc.message:'纠错记录读取失败';}
    finally{if(account.current()&&lane.current())loading.value=false;}}
  async function send(body:Record<string,unknown>,reviewer=false){if(busy.value||unknown.value)return;pending={path:reviewer?`/api/v1/me/review/works/${encodeURIComponent(String(body.work_id))}/corrections`:'/api/v1/me/corrections',body:{...body,operation_id:operationId()}};await transmit();}
  async function transmit(){if(!pending||busy.value)return;const lane=submitLane.begin(),account=auth.scope(),operation=pending;busy.value=true;submitError.value='';unknown.value=false;
    try{const data=await account.request<{correction:Correction}>(operation.path,operation.body,undefined,lane.signal);if(account.current()&&lane.current()){saved.value=data.correction;pending=null;}}
    catch(exc){if(account.current()&&lane.current()){forbidden.value=exc instanceof APIError&&exc.status===403;unknown.value=!(exc instanceof APIError&&exc.status&&exc.status<500&&exc.code!=='operation_in_progress');submitError.value=unknown.value?'提交结果尚未确认，请先核对回执及本人记录。':exc instanceof Error?exc.message:'提交失败';}}
    finally{if(account.current()&&lane.current())busy.value=false;}}
  async function resolve(){if(!pending||busy.value)return;const lane=submitLane.begin(),account=auth.scope();busy.value=true;
    try{const data=await account.request<{correction:Correction}>(`/api/v1/me/corrections/operations/${pending.body.operation_id}`,undefined,undefined,lane.signal);if(account.current()&&lane.current()){saved.value=data.correction;pending=null;unknown.value=false;submitError.value='';}}
    catch(exc){if(account.current()&&lane.current())submitError.value=exc instanceof APIError&&exc.status===404?'尚未查到回执，在途请求仍可能完成；可读取本人记录或明确使用原标识重试。':exc instanceof Error?exc.message:'回执读取失败';}
    finally{if(account.current()&&lane.current())busy.value=false;}}
  function reset(){listLane.cancel();submitLane.cancel();items.value=[];total.value=0;page.value=1;loading.value=false;error.value='';busy.value=false;unknown.value=false;saved.value=null;submitError.value='';forbidden.value=false;pending=null;}
  watch(auth.generation,reset,{flush:'sync'});onScopeDispose(reset);
  return {items,total,page,status,loading,error,busy,unknown,saved,submitError,forbidden,load,send,resolve,retry:transmit};
}
