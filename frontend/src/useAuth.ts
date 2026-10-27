import { getCurrentScope, onScopeDispose, ref } from 'vue';
import { api, APIError, latestRequest } from './api';

export interface User { id:string; username:string; nickname:string|null; avatar_id:string }
export class StaleAccount extends Error {}

export function useAuth() {
  const state=ref<'checking'|'guest'|'authenticated'|'error'>('checking');
  const user=ref<User|null>(null), error=ref(''), busy=ref(false), generation=ref(0);
  const lane=latestRequest(); let controller=new AbortController();
  function reset(next:User|null, status:typeof state.value) {
    controller.abort();controller=new AbortController();user.value=next;state.value=status;generation.value++;
  }
  function expire(notice='登录状态已失效，请重新登录') {lane.cancel();busy.value=false;reset(null,'guest');error.value=notice;}
  function mergeProfile(profile:User) {if(user.value?.id===profile.id) user.value={...profile};}
  function scope() {
    const version=generation.value, signal=controller.signal;
    const current=()=>version===generation.value&&!signal.aborted;
    async function request<T>(path:string,body?:unknown,method?:string,localSignal?:AbortSignal):Promise<T> {
      if(!current()) throw new StaleAccount();
      try {
        const value=await api<T>(path,body,localSignal?AbortSignal.any([signal,localSignal]):signal,method);
        if(!current()) throw new StaleAccount();
        return value;
      } catch(exc) {
        if(!current()||localSignal?.aborted) throw new StaleAccount();
        if(exc instanceof APIError&&exc.status===401) expire();
        throw exc;
      }
    }
    return {current,request};
  }
  async function restore() {
    const request=lane.begin();state.value='checking';error.value='';
    try {
      const data=await api<{user:User|null}>('/api/v1/auth/me',undefined,request.signal);
      if(!request.current()) return;
      if(data.user===undefined) throw new Error('登录状态响应异常，请重试');
      reset(data.user,data.user?'authenticated':'guest');
    } catch(exc) {if(request.current()){reset(null,'error');error.value=exc instanceof Error?exc.message:'无法检查登录状态，请重试';}}
  }
  async function submit(mode:'login'|'register',form:{username:string;password:string;confirm_password?:string}) {
    if(busy.value) return false;
    const request=lane.begin();busy.value=true;error.value='';
    try {
      const data=await api<{user:User}>(`/api/v1/auth/${mode}`,form,request.signal);
      if(!request.current()) return false;
      reset(data.user,'authenticated');return true;
    } finally {if(request.current()) busy.value=false;}
  }
  async function logout() {
    if(busy.value) return false;
    const request=lane.begin();busy.value=true;error.value='';
    try {
      await api('/api/v1/auth/logout',undefined,request.signal,'POST');
      if(!request.current()) return false;
      reset(null,'guest');return true;
    } catch(exc) {if(request.current()) error.value=exc instanceof Error?exc.message:'退出失败，请重试';return false;}
    finally {if(request.current()) busy.value=false;}
  }
  function cancelLogin() {lane.cancel();busy.value=false;}
  if(getCurrentScope()) onScopeDispose(()=>{lane.cancel();controller.abort();});
  return {state,user,error,busy,generation,scope,restore,submit,logout,expire,cancelLogin,mergeProfile};
}
