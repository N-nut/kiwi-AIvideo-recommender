import { onScopeDispose, ref, watch } from 'vue';
import { APIError,latestRequest } from './api';
import type { useAuth } from './useAuth';
import type { Work } from './types';
import type { Correction, ReviewDetail } from './corrections';
import { operationId } from './corrections';

export function useReview(auth:ReturnType<typeof useAuth>){
  const canReview=ref(false),accessError=ref(''),items=ref<(Correction|Work)[]>([]),total=ref(0),page=ref(1),mode=ref<'corrections'|'works'>('corrections');
  const status=ref('pending'),category=ref(''),query=ref(''),reviewState=ref('automatic');
  const loading=ref(false),error=ref(''),detail=ref<ReviewDetail|null>(null),detailLoading=ref(false),detailError=ref('');
  const busy=ref(false),unknown=ref(false),actionError=ref(''),notice=ref(''),changed=ref(0);
  const accessLane=latestRequest(),listLane=latestRequest(),detailLane=latestRequest(),actionLane=latestRequest();
  let pending:{path:string;body:Record<string,unknown>}|null=null;
  function loseAccess(){canReview.value=false;items.value=[];detail.value=null;pending=null;unknown.value=false;void checkAccess();}
  function forbidden(exc:unknown){if(exc instanceof APIError&&exc.status===403)loseAccess();}
  async function checkAccess(){if(auth.state.value!=='authenticated')return;const lane=accessLane.begin(),account=auth.scope();accessError.value='';try{const data=await account.request<{can_review:boolean}>('/api/v1/me/review-access',undefined,undefined,lane.signal);if(lane.current()&&account.current()){canReview.value=data.can_review;if(!data.can_review){items.value=[];detail.value=null;pending=null;unknown.value=false;}}}catch(exc){if(lane.current()&&account.current()){canReview.value=false;accessError.value=exc instanceof Error?exc.message:'权限读取失败';}}}
  async function load(){if(!canReview.value)return;const lane=listLane.begin(),account=auth.scope();loading.value=true;error.value='';items.value=[];
    const params=new URLSearchParams({page:String(page.value),page_size:'20',q:query.value.trim()});if(mode.value==='works')params.set('review_state',reviewState.value);else{if(status.value)params.set('status',status.value);if(category.value)params.set('category',category.value);}
    try{const data=await account.request<{items:(Correction|Work)[];total:number}>(`/api/v1/me/review/${mode.value}?${params}`,undefined,undefined,lane.signal);if(lane.current()&&account.current()){items.value=data.items;total.value=data.total;}}
    catch(exc){if(lane.current()&&account.current()){forbidden(exc);error.value=exc instanceof Error?exc.message:'审核列表读取失败';}}
    finally{if(lane.current()&&account.current())loading.value=false;}}
  async function open(id:string,isWork=false){if(busy.value||unknown.value)return;const lane=detailLane.begin(),account=auth.scope();detail.value=null;detailLoading.value=true;detailError.value='';actionError.value='';notice.value='';pending=null;
    try{const data=await account.request<ReviewDetail>(`/api/v1/me/review/${isWork?'works':'corrections'}/${encodeURIComponent(id)}`,undefined,undefined,lane.signal);if(lane.current()&&account.current())detail.value=data;}
    catch(exc){if(lane.current()&&account.current()){forbidden(exc);detailError.value=exc instanceof Error?exc.message:'核对资料读取失败';}}
    finally{if(lane.current()&&account.current())detailLoading.value=false;}}
  async function action(path:string,body:Record<string,unknown>){if(busy.value||unknown.value)return;pending={path,body:{...body,operation_id:operationId()}};await transmit();}
  async function complete(data:{work:Work;correction?:Correction|null},account:{current:()=>boolean}){if(!account.current())return;notice.value='处理已保存，可重新读取查看最新资料与记录。';unknown.value=false;pending=null;detail.value=null;changed.value++;await load();}
  async function transmit(){if(!pending||busy.value)return;const lane=actionLane.begin(),account=auth.scope();busy.value=true;unknown.value=false;actionError.value='';
    try{const data=await account.request<{work:Work;correction?:Correction}>(pending.path,pending.body,undefined,lane.signal);if(lane.current()&&account.current())await complete(data,account);}
    catch(exc){if(lane.current()&&account.current()){forbidden(exc);unknown.value=!(exc instanceof APIError&&exc.status&&exc.status<500&&exc.code!=='operation_in_progress');actionError.value=unknown.value?'处理结果尚未确认，请先核对审核回执和最新记录。':exc instanceof Error?exc.message:'处理失败';}}
    finally{if(lane.current()&&account.current())busy.value=false;}}
  async function resolve(){if(!pending||busy.value)return;const lane=actionLane.begin(),account=auth.scope();busy.value=true;
    try{const data=await account.request<{work:Work;correction?:Correction}>(`/api/v1/me/review/operations/${pending.body.operation_id}`,undefined,undefined,lane.signal);if(lane.current()&&account.current())await complete(data,account);}
    catch(exc){if(lane.current()&&account.current()){forbidden(exc);actionError.value=exc instanceof APIError&&exc.status===404?'暂未查到回执，在途操作仍可能完成，请核对记录。':exc instanceof Error?exc.message:'回执读取失败';}}
    finally{if(lane.current()&&account.current())busy.value=false;}}
  function clear(){for(const lane of [accessLane,listLane,detailLane,actionLane])lane.cancel();canReview.value=false;accessError.value='';items.value=[];total.value=0;page.value=1;detail.value=null;loading.value=false;detailLoading.value=false;busy.value=false;unknown.value=false;error.value='';detailError.value='';actionError.value='';notice.value='';pending=null;}
  watch(auth.generation,()=>{clear();void checkAccess();},{flush:'sync'});onScopeDispose(clear);
  return {canReview,accessError,checkAccess,loseAccess,items,total,page,mode,status,category,query,reviewState,loading,error,detail,detailLoading,detailError,busy,unknown,actionError,notice,changed,load,open,action,resolve,retry:transmit};
}
