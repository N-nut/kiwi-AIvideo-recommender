import { effectScope, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as avatar from '../src/avatar';
import { useAuth } from '../src/useAuth';
import { useLibrary } from '../src/library';
import { usePersonalSpace } from '../src/usePersonalSpace';
import PresetAvatar from '../src/components/PresetAvatar.vue';

const stops:(()=>void)[]=[];
afterEach(()=>{stops.splice(0).forEach(stop=>stop());vi.restoreAllMocks();vi.unstubAllGlobals();});
const photo=()=>new File(['test'],'photo.png',{type:'image/png'});
function setup(){
  let user={id:'alpha',username:'Alpha',nickname:null as string|null,avatar_id:'kiwi-default',avatar_url:null as string|null};
  const fetcher=vi.fn((url:string,options?:RequestInit)=>{
    if(url.endsWith('/auth/login'))user={...user,id:'beta',username:'Beta',avatar_url:null};
    if(url.endsWith('/me/profile')&&options?.method==='PATCH'){
      const patch=JSON.parse(options.body as string);user={...user,nickname:patch.nickname??user.nickname,avatar_id:patch.avatar_id??user.avatar_id,
        avatar_url:patch.avatar_image?'/api/v1/me/avatar/'+('a'.repeat(32)):patch.avatar_id?null:user.avatar_url};
    }
    return Promise.resolve(new Response(JSON.stringify(url.endsWith('/me/profile')?{profile:user}:url.endsWith('/space-summary')?{favorites:{total:0,available:0,unavailable:0},interest:{status:'no_favorites',analyzed_count:0,content_types:[],genres:[],themes:[]}}:url.includes('/favorites')?{items:[],relation_total:0}:{user})));
  });vi.stubGlobal('fetch',fetcher);
  const scope=effectScope();stops.push(()=>scope.stop());
  const state=scope.run(()=>{const auth=useAuth(),library=useLibrary(auth),view=ref('discover');return {auth,view,space:usePersonalSpace(auth,library,view)};})!;
  return {...state,fetcher};
}
async function enter(s:ReturnType<typeof setup>){await s.auth.restore();s.view.value='personal-space';await flushPromises();}

describe('photo draft and account storage',()=>{
  it('previews a selected photo, cancels without requests, then atomically saves nickname and photo',async()=>{
    vi.spyOn(avatar,'prepareAvatar').mockResolvedValue('dGVzdA==');const s=setup();await enter(s);
    const count=s.fetcher.mock.calls.length;await s.space.choosePhoto(photo());expect(s.space.avatarPreview.value).toBe('data:image/jpeg;base64,dGVzdA==');expect(s.space.dirty.value).toBe(true);expect(s.fetcher.mock.calls).toHaveLength(count);
    s.space.cancelEdit();expect(s.space.avatarPreview.value).toBeNull();expect(s.space.dirty.value).toBe(false);
    await s.space.choosePhoto(photo());s.space.draft.nickname='新昵称';await s.space.save();
    const patch=JSON.parse(s.fetcher.mock.calls.find(([,options])=>options?.method==='PATCH')![1]!.body as string);
    expect(patch).toEqual({nickname:'新昵称',avatar_image:'dGVzdA=='});expect(s.auth.user.value?.avatar_url).toContain('/avatar/');expect(s.space.photoPending.value).toBe(false);expect(s.space.dirty.value).toBe(false);
  });
  it('selecting the same fallback preset explicitly removes a stored photo',async()=>{
    vi.spyOn(avatar,'prepareAvatar').mockResolvedValue('dGVzdA==');const s=setup();await enter(s);await s.space.choosePhoto(photo());await s.space.save();
    s.space.selectPreset('kiwi-default');expect(s.space.dirty.value).toBe(true);expect(s.space.avatarPreview.value).toBeNull();await s.space.save();
    expect(s.auth.user.value?.avatar_url).toBeNull();const body=JSON.parse(s.fetcher.mock.calls.filter(([,options])=>options?.method==='PATCH').at(-1)![1]!.body as string);expect(body).toEqual({avatar_id:'kiwi-default'});
  });
  it('ignores late photo processing after preset selection or an account change',async()=>{
    const held:((value:string)=>void)[]=[];vi.spyOn(avatar,'prepareAvatar').mockImplementation(()=>new Promise(resolve=>held.push(resolve)));
    const s=setup();await enter(s);const first=s.space.choosePhoto(photo());s.space.selectPreset('kiwi-moon');held[0]!('old');await first;expect(s.space.avatarPreview.value).toBeNull();
    const second=s.space.choosePhoto(photo());await s.auth.submit('login',{username:'Beta',password:'test password'});held[1]!('alpha-secret');await second;
    expect(s.auth.user.value?.id).toBe('beta');expect(s.space.avatarPreview.value).toBeNull();expect(s.space.avatarLoading.value).toBe(false);
  });
  it('retains the photo draft on a confirmed save failure and does not claim success',async()=>{
    vi.spyOn(avatar,'prepareAvatar').mockResolvedValue('dGVzdA==');const s=setup();await enter(s);const original=s.fetcher.getMockImplementation()!;
    s.fetcher.mockImplementation((url,options)=>options?.method==='PATCH'?Promise.resolve(new Response(JSON.stringify({error:{message:'保存失败'}}),{status:503})):original(url,options));
    await s.space.choosePhoto(photo());await s.space.save();expect(s.space.photoPending.value).toBe(true);expect(s.space.saveError.value).toBe('保存失败');expect(s.auth.user.value?.avatar_url).toBeNull();
  });
});

describe('bounded browser image preparation',()=>{
  it('rejects invalid format and size before decoding',async()=>{
    const decode=vi.fn();vi.stubGlobal('createImageBitmap',decode);
    await expect(avatar.prepareAvatar(new File(['x'],'x.svg',{type:'image/svg+xml'}))).rejects.toThrow('JPG');
    const big=photo();Object.defineProperty(big,'size',{value:5*1024*1024+1});await expect(avatar.prepareAvatar(big)).rejects.toThrow('5 MB');expect(decode).not.toHaveBeenCalled();
  });
  it('crops centrally, encodes JPEG inside the existing body budget, and releases the bitmap',async()=>{
    const bitmap={width:600,height:400,close:vi.fn()},context={fillStyle:'',fillRect:vi.fn(),drawImage:vi.fn()};
    vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue(bitmap));vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype,'toDataURL').mockReturnValue('data:image/jpeg;base64,'+'a'.repeat(20000));
    const result=await avatar.prepareAvatar(photo());expect(context.drawImage).toHaveBeenCalledWith(bitmap,100,0,400,400,0,0,256,256);
    expect(new TextEncoder().encode(JSON.stringify({avatar_image:result,nickname:'测试'})).byteLength).toBeLessThan(24000);expect(bitmap.close).toHaveBeenCalledOnce();
  });
  it('tries a smaller image if compression is too large and releases failed decodes',async()=>{
    const bitmap={width:200,height:200,close:vi.fn()},context={fillRect:vi.fn(),drawImage:vi.fn()};vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue(bitmap));
    vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const encode=vi.spyOn(HTMLCanvasElement.prototype,'toDataURL').mockReturnValueOnce('data:image/jpeg;base64,'+'a'.repeat(22000)).mockReturnValue('data:image/jpeg;base64,dGVzdA==');
    expect(await avatar.prepareAvatar(photo())).toBe('dGVzdA==');expect(encode).toHaveBeenCalledTimes(2);
    vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue({...bitmap,width:25000,height:1000}));await expect(avatar.prepareAvatar(photo())).rejects.toThrow('2400');expect(bitmap.close).toHaveBeenCalledTimes(2);
  });
});

it('shows a stored photo and falls back to the selected preset if the image becomes unavailable',async()=>{
  const w=mount(PresetAvatar,{props:{id:'kiwi-moon',src:'/api/v1/me/avatar/test'}});stops.push(()=>w.unmount());expect(w.find('img').exists()).toBe(true);
  await w.find('img').trigger('error');expect(w.find('svg').exists()).toBe(true);await w.setProps({src:'/api/v1/me/avatar/new'});expect(w.find('img').exists()).toBe(true);
});
