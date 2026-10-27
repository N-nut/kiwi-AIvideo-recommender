import { computed, onScopeDispose, reactive, ref, watch } from 'vue';
import { APIError, latestRequest } from './api';
import { prepareAvatar } from './avatar';
import type { useAuth, User } from './useAuth';
import type { useLibrary } from './library';
import type { Ref } from 'vue';

export interface SpaceSummary {
  favorites:{total:number;available:number;unavailable:number};
  interest:{status:'ready'|'no_favorites'|'no_valid_favorites'|'no_tags';analyzed_count:number;content_types:Tag[];genres:Tag[];themes:Tag[]};
}
interface Tag {label:string;count:number}
export function validNickname(value:string) {
  const display=value.trim(), normalized=display.normalize('NFKC').trim();
  return !/[\p{C}\u2028\u2029]/u.test(value)&&[...display].length>=1&&[...display].length<=20&&!!normalized&&!/[\p{C}\u2028\u2029]/u.test(normalized);
}
export function usePersonalSpace(auth:ReturnType<typeof useAuth>, library:ReturnType<typeof useLibrary>,view:Ref<string>) {
  const profile=ref<User|null>(null),summary=ref<SpaceSummary|null>(null);
  const draft=reactive({nickname:'',avatar_id:'kiwi-default'});
  const photo=ref<string|null>(null),usePhoto=ref(false),avatarLoading=ref(false),avatarError=ref('');
  const avatarPreview=computed(()=>usePhoto.value?(photo.value?'data:image/jpeg;base64,'+photo.value:profile.value?.avatar_url||null):null);
  const photoPending=computed(()=>photo.value!==null);
  const profileLoading=ref(false),summaryLoading=ref(false),saving=ref(false);
  const profileError=ref(''),summaryError=ref(''),saveError=ref(''),saveNotice=ref(''),saveUnknown=ref(false);
  const fields=ref<Record<string,string>>({});
  const password=reactive({current_password:'',new_password:'',confirm_password:''});
  const passwordOpen=ref(false),passwordBusy=ref(false),passwordError=ref(''),passwordFields=ref<Record<string,string>>({});
  const retryAt=ref(0);
  const profileLane=latestRequest(),summaryLane=latestRequest(),saveLane=latestRequest(),passwordLane=latestRequest(),photoLane=latestRequest();
  let refreshQueued=false, disposed=false;
  const active=()=>view.value==='personal-space'&&auth.state.value==='authenticated'&&!disposed;
  const dirty=computed(()=>!!profile.value&&(draft.nickname!==(profile.value.nickname||'')||draft.avatar_id!==profile.value.avatar_id||photo.value!==null||usePhoto.value!==!!profile.value.avatar_url));
  function resetPhoto(){photoLane.cancel();photo.value=null;usePhoto.value=!!profile.value?.avatar_url;avatarLoading.value=false;avatarError.value='';}
  function cancelEdit(){if(!profile.value||saving.value)return;resetPhoto();draft.nickname=profile.value.nickname||'';draft.avatar_id=profile.value.avatar_id;fields.value={};saveError.value='';saveNotice.value='';}
  function selectPreset(id:string){if(saving.value)return;photoLane.cancel();avatarLoading.value=false;avatarError.value='';photo.value=null;usePhoto.value=false;draft.avatar_id=id;}
  async function choosePhoto(file?:File){
    if(!file||!active()||saving.value)return;
    const account=auth.scope(),request=photoLane.begin();avatarLoading.value=true;avatarError.value='';
    try{const encoded=await prepareAvatar(file);if(request.current()&&account.current()&&active()){photo.value=encoded;usePhoto.value=true;saveNotice.value='';}}
    catch(exc){if(request.current()&&account.current()&&active())avatarError.value=exc instanceof Error?exc.message:'照片处理失败，请重试';}
    finally{if(request.current()&&account.current())avatarLoading.value=false;}
  }
  function clearPassword(){password.current_password='';password.new_password='';password.confirm_password='';passwordOpen.value=false;passwordError.value='';passwordFields.value={};}
  function leave(){profileLane.cancel();summaryLane.cancel();saveLane.cancel();passwordLane.cancel();photoLane.cancel();avatarLoading.value=false;profileLoading.value=false;summaryLoading.value=false;saving.value=false;passwordBusy.value=false;clearPassword();}
  function reset(){leave();profile.value=null;resetPhoto();summary.value=null;draft.nickname='';draft.avatar_id='kiwi-default';profileError.value='';summaryError.value='';fields.value={};saveError.value='';saveNotice.value='';saveUnknown.value=false;retryAt.value=0;}
  async function loadProfile(){
    if(!active())return;
    const account=auth.scope(),request=profileLane.begin();profileLoading.value=true;profileError.value='';
    try{
      const data=await account.request<{profile:User}>('/api/v1/me/profile',undefined,undefined,request.signal);
      if(!request.current()||!account.current()||!active())return;
      const preserve=dirty.value||saving.value||saveUnknown.value;
      profile.value=data.profile;auth.mergeProfile(data.profile);
      if(!preserve){draft.nickname=data.profile.nickname||'';draft.avatar_id=data.profile.avatar_id;resetPhoto();}
      if(saveUnknown.value) saveNotice.value='已重新读取服务器资料，请核对当前草稿后再保存。';
      saveUnknown.value=false;
    }catch(exc){if(request.current()&&account.current()&&active())profileError.value=exc instanceof Error?exc.message:'资料加载失败，请重试';}
    finally{if(request.current()&&account.current())profileLoading.value=false;}
  }
  async function loadSummary(){
    if(!active())return;
    const account=auth.scope(),request=summaryLane.begin();summaryLoading.value=true;summaryError.value='';
    try{const data=await account.request<SpaceSummary>('/api/v1/me/space-summary',undefined,undefined,request.signal);
      if(request.current()&&account.current()&&active())summary.value=data;
    }catch(exc){if(request.current()&&account.current()&&active())summaryError.value=exc instanceof Error?exc.message:'收藏概览和画像加载失败，请重试';}
    finally{if(request.current()&&account.current())summaryLoading.value=false;}
  }
  function invalidate(){if(refreshQueued||!active())return;refreshQueued=true;queueMicrotask(()=>{refreshQueued=false;if(active())void loadSummary();});}
  async function save(){
    if(!active()||!profile.value||saving.value||avatarLoading.value||!dirty.value)return;
    fields.value={};saveError.value='';saveNotice.value='';
    const patch:Record<string,string>={};
    if(draft.nickname!==(profile.value.nickname||'')){
      if(!validNickname(draft.nickname)){fields.value.nickname='昵称须为 1～20 个字符，不能含换行或控制字符';return;}
      patch.nickname=draft.nickname.trim();
    }
    if(usePhoto.value&&photo.value)patch.avatar_image=photo.value;
    else if(!usePhoto.value&&(draft.avatar_id!==profile.value.avatar_id||profile.value.avatar_url))patch.avatar_id=draft.avatar_id;
    if(new TextEncoder().encode(JSON.stringify(patch)).byteLength>24000){saveError.value='头像照片过大，请换一张图片';return;}
    profileLane.cancel();profileLoading.value=false;
    const account=auth.scope(),request=saveLane.begin();saving.value=true;saveUnknown.value=false;
    const submitted={...draft};
    try{
      const data=await account.request<{profile:User}>('/api/v1/me/profile',patch,'PATCH',request.signal);
      if(!request.current()||!account.current()||!active())return;
      profile.value=data.profile;auth.mergeProfile(data.profile);saveNotice.value='资料已保存';
      if(draft.nickname===submitted.nickname)draft.nickname=data.profile.nickname||'';
      if(draft.avatar_id===submitted.avatar_id)draft.avatar_id=data.profile.avatar_id;
      resetPhoto();
    }catch(exc){if(request.current()&&account.current()&&active()){
      if(exc instanceof APIError){saveError.value=exc.message;fields.value=exc.fields;}
      else{saveUnknown.value=true;saveError.value='保存结果暂未确认，请重新读取资料核对。';}
    }}finally{if(request.current()&&account.current())saving.value=false;}
  }
  async function changePassword(){
    if(!active()||passwordBusy.value)return;
    passwordFields.value={};passwordError.value='';
    if(Date.now()<retryAt.value){passwordError.value='操作过于频繁，请稍后重试';return;}
    for(const key of ['current_password','new_password','confirm_password'] as const)if([...password[key]].length<8||[...password[key]].length>64)passwordFields.value[key]='密码须为 8～64 个字符';
    if(password.new_password!==password.confirm_password)passwordFields.value.confirm_password='两次新密码不一致';
    if(password.new_password===password.current_password)passwordFields.value.new_password='新密码不能与当前密码相同';
    if(Object.keys(passwordFields.value).length)return;
    const account=auth.scope(),request=passwordLane.begin();passwordBusy.value=true;
    try{
      await account.request('/api/v1/me/password',{...password},'POST',request.signal);
      if(request.current()&&account.current()&&active())auth.expire('密码已修改，请重新登录');
    }catch(exc){if(request.current()&&account.current()&&active()){
      if(exc instanceof APIError){passwordError.value=exc.message;passwordFields.value=exc.fields;if(exc.status===429)retryAt.value=Date.now()+(exc.retryAfter||600)*1000;}
      else{clearPassword();passwordOpen.value=true;passwordError.value='修改结果暂未确认，请重新登录验证';}
    }}finally{if(request.current()&&account.current())passwordBusy.value=false;}
  }
  watch(auth.generation,()=>{reset();if(active()){void loadProfile();void loadSummary();}},{flush:'sync'});
  watch(view,(next,previous)=>{if(next==='personal-space'&&previous!==next&&active()){void loadProfile();void loadSummary();}else if(next!=='personal-space')leave();},{flush:'sync'});
  watch(library.revision,invalidate);
  onScopeDispose(()=>{disposed=true;reset();});
  return {profile,summary,draft,dirty,profileLoading,summaryLoading,saving,profileError,summaryError,saveError,saveNotice,saveUnknown,fields,
    avatarPreview,photoPending,usesPhoto:usePhoto,avatarLoading,avatarError,choosePhoto,selectPreset,
    password,passwordOpen,passwordBusy,passwordError,passwordFields,loadProfile,loadSummary,invalidate,save,cancelEdit,clearPassword,changePassword};
}
