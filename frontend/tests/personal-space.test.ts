import { effectScope, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../src/useAuth';
import { useLibrary } from '../src/library';
import { usePersonalSpace, validNickname } from '../src/usePersonalSpace';
import PersonalSpace from '../src/components/PersonalSpace.vue';
import App from '../src/App.vue';
import { homeFixture, workFixture } from './work-fixture';

const response=(body:unknown,status=200)=>Promise.resolve(new Response(status===204?null:JSON.stringify(body),{status}));
const user=(id='Alpha')=>({id,username:id,nickname:null as string|null,avatar_id:'kiwi-default'});
const summary=()=>({favorites:{total:8,available:6,unavailable:2},interest:{status:'ready' as const,analyzed_count:4,
  content_types:[{label:'漫剧',count:4}],genres:[{label:'修仙',count:3}],themes:[{label:'逆袭',count:2}]}});
let scope=effectScope();const cleanup:(()=>void)[]=[];
beforeEach(()=>{scope=effectScope();localStorage.clear();HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');this.dispatchEvent(new Event('close'));};});
afterEach(()=>{cleanup.splice(0).forEach(fn=>fn());scope.stop();vi.unstubAllGlobals();});
function setup(initial:string|null='Alpha') {
  let current=initial?user(initial):null;
  let stored=current?{...current}:null;
  const fetcher=vi.fn((url:string,opts?:RequestInit):Promise<Response>=>{
    if(url==='/api/v1/auth/me')return response({user:current});
    if(url.endsWith('/auth/login')){current=user(JSON.parse(opts!.body as string).username);stored={...current};return response({user:current});}
    if(url.endsWith('/auth/logout')){current=null;return response(null,204);}
    if(url.endsWith('/me/profile')){
      if(!current)return response({error:{message:'expired'}},401);
      if(opts?.method==='PATCH'){stored={...stored!,...JSON.parse(opts.body as string)};return response({profile:stored});}
      return response({profile:stored});
    }
    if(url.endsWith('/space-summary'))return response(summary());
    if(url.endsWith('/me/password'))return response(null,204);
    if(url.includes('/me/favorites'))return response(url.includes('/ids?')?{items:[],relation_total:0}:{items:[],total:0,unavailable_count:0});
    if(url.startsWith('/health'))return response({works:1,mode:'baseline'});
    if(url.includes('/catalog/refresh'))return response({status:'idle'});
    if(url.includes('/home/recommendations')||url.endsWith('/home-recommendations'))return response(homeFixture());
    if(url.includes('/works?'))return response({items:[workFixture()],total:1});
    if(url.endsWith('/preferences/parse'))return response({preferences:{schema_version:1,soft_preferences:{genres:['修仙'],themes:[],pace:null},required:[],excluded_features:[],excluded_genres:[],unresolved_constraints:[],conflicts:[]}});
    if(url==='/api/v1/recommendations')return response({status:'success',items:[workFixture()],warnings:[],timings_ms:{}});
    throw Error(url);
  });
  vi.stubGlobal('fetch',fetcher);
  const state=scope.run(()=>{const auth=useAuth(),library=useLibrary(auth),view=ref('discover');return {auth,library,view,space:usePersonalSpace(auth,library,view)};})!;
  return {...state,fetcher,stored:(value:ReturnType<typeof user>)=>stored=value};
}
async function enter(s:ReturnType<typeof setup>){await s.auth.restore();await flushPromises();s.view.value='personal-space';await flushPromises();}
const fillPassword=(s:ReturnType<typeof setup>)=>{s.space.passwordOpen.value=true;Object.assign(s.space.password,{current_password:'old password',new_password:'new password',confirm_password:'new password'});};

describe('personal space state',()=>{
  it('loads modules independently, saves only changed fields and keeps account generation and favorites',async()=>{
    const s=setup();await enter(s);const generation=s.auth.generation.value,revision=s.library.revision.value;
    s.space.draft.avatar_id='kiwi-moon';await s.space.save();
    expect(s.auth.generation.value).toBe(generation);expect(s.library.revision.value).toBe(revision);
    const patch=s.fetcher.mock.calls.find(([,opts])=>opts?.method==='PATCH')!;
    expect(JSON.parse(patch[1]!.body as string)).toEqual({avatar_id:'kiwi-moon'});
    expect(s.auth.user.value?.avatar_id).toBe('kiwi-moon');expect(s.space.saveNotice.value).toBe('资料已保存');
    s.space.draft.nickname='edited';s.space.cancelEdit();expect(s.space.draft.nickname).toBe('');
  });
  it('validates unicode code points and controls, but permits twenty emoji',()=>{
    for(const nickname of ['',' ','x\ny','x\ty','\u200b','\u2028','a'.repeat(21)])expect(validNickname(nickname)).toBe(false);
    for(const nickname of ['中文昵称','Ａbc','  Kiwi  ','😀'.repeat(20),'<b>text</b>'])expect(validNickname(nickname)).toBe(true);
  });
  it('keeps draft on conflict, and disables repeated writes',async()=>{
    const s=setup();await enter(s);const original=s.fetcher.getMockImplementation()!;let finish!:(r:Response)=>void;
    s.fetcher.mockImplementation((url,opts)=>opts?.method==='PATCH'?new Promise(r=>finish=r):original(url,opts));
    s.space.draft.nickname='Kiwi';const request=s.space.save();await s.space.save();
    expect(s.fetcher.mock.calls.filter(([,opts])=>opts?.method==='PATCH')).toHaveLength(1);
    finish(new Response(JSON.stringify({error:{message:'昵称已被使用，请换一个',field_messages:{nickname:'昵称已被使用，请换一个'}}}),{status:409}));await request;
    expect(s.space.draft.nickname).toBe('Kiwi');expect(s.space.profile.value?.nickname).toBeNull();expect(s.space.fields.value.nickname).toContain('已被使用');
  });
  it('preserves a draft while re-reading an uncertain committed result and allows cancel to the server snapshot',async()=>{
    const s=setup();await enter(s);const original=s.fetcher.getMockImplementation()!;
    s.fetcher.mockImplementation((url,opts)=>opts?.method==='PATCH'?Promise.reject(new TypeError('connection lost')):original(url,opts));
    s.space.draft.nickname='Saved';await s.space.save();expect(s.space.saveUnknown.value).toBe(true);
    s.stored({...user(),nickname:'Saved'});s.space.draft.nickname='Newer draft';await s.space.loadProfile();
    expect(s.space.draft.nickname).toBe('Newer draft');expect(s.space.profile.value?.nickname).toBe('Saved');
    s.space.cancelEdit();expect(s.space.draft.nickname).toBe('Saved');
  });
  it('ignores a stale profile read superseded by saving, even when fetch ignores abort',async()=>{
    const s=setup();await enter(s);const original=s.fetcher.getMockImplementation()!;let finish!:(r:Response)=>void;
    s.fetcher.mockImplementation((url,opts)=>url.endsWith('/me/profile')&&opts?.method==='GET'?new Promise(r=>finish=r):original(url,opts));
    const pending=s.space.loadProfile();s.space.draft.nickname='Newer';await s.space.save();
    finish(new Response(JSON.stringify({profile:user()})));await pending;
    expect(s.space.profile.value?.nickname).toBe('Newer');expect(s.auth.user.value?.nickname).toBe('Newer');
  });
  it('clears private data on switch and ignores a late save or 401 from the old account',async()=>{
    const s=setup();await enter(s);const original=s.fetcher.getMockImplementation()!;let finish!:(r:Response)=>void;
    s.fetcher.mockImplementation((url,opts)=>opts?.method==='PATCH'?new Promise(r=>finish=r):original(url,opts));
    s.space.draft.nickname='Alpha secret';const pending=s.space.save();
    await s.auth.submit('login',{username:'Beta',password:'test password'});await flushPromises();
    finish(new Response(JSON.stringify({error:{message:'expired old account'}}),{status:401}));await pending;
    expect(s.auth.user.value?.id).toBe('Beta');expect(s.space.draft.nickname).toBe('');expect(s.space.profile.value?.id).toBe('Beta');expect(s.space.saveError.value).toBe('');
  });
  it('keeps previous confirmed summary on failure, coalesces mutations, and refreshes on re-entry',async()=>{
    const s=setup();await enter(s);const original=s.fetcher.getMockImplementation()!;
    let fail=true;s.fetcher.mockImplementation((url,opts)=>url.endsWith('/space-summary')&&fail?response({error:{message:'summary failed'}},503):original(url,opts));
    const count=s.fetcher.mock.calls.filter(([url])=>url.endsWith('/space-summary')).length;
    s.library.revision.value++;s.library.revision.value++;await flushPromises();
    expect(s.fetcher.mock.calls.filter(([url])=>url.endsWith('/space-summary'))).toHaveLength(count+1);
    expect(s.space.summary.value?.favorites.total).toBe(8);expect(s.space.summaryError.value).toBe('summary failed');
    s.view.value='discover';s.library.revision.value++;await flushPromises();fail=false;
    s.view.value='personal-space';await flushPromises();expect(s.space.summaryError.value).toBe('');
  });
  it('allows summary success when profile fails without reporting fake zero counts',async()=>{
    const s=setup();const original=s.fetcher.getMockImplementation()!;
    s.fetcher.mockImplementation((url,opts)=>url.endsWith('/me/profile')?response({error:{message:'profile failed'}},503):original(url,opts));await enter(s);
    expect(s.space.profile.value).toBeNull();expect(s.space.summary.value?.favorites.total).toBe(8);expect(s.space.profileError.value).toBe('profile failed');
  });
  it('validates password errors, distinguishes confirmed failure from uncertain outcome, and clears on leaving',async()=>{
    const s=setup();await enter(s);fillPassword(s);s.space.password.confirm_password='not matching';await s.space.changePassword();expect(s.space.passwordFields.value.confirm_password).toContain('不一致');
    fillPassword(s);const original=s.fetcher.getMockImplementation()!;let fail=400;
    s.fetcher.mockImplementation((url,opts)=>url.endsWith('/me/password')?fail?response({error:{message:'当前密码不正确',field_messages:{current_password:'当前密码不正确'}}},fail):Promise.reject(new TypeError('lost')):original(url,opts));
    await s.space.changePassword();expect(s.auth.state.value).toBe('authenticated');expect(s.space.passwordFields.value.current_password).toBe('当前密码不正确');
    fail=0;await s.space.changePassword();expect(s.space.passwordError.value).toBe('修改结果暂未确认，请重新登录验证');expect(s.space.password.current_password).toBe('');
    fillPassword(s);s.view.value='discover';expect(s.space.password.new_password).toBe('');expect(s.space.passwordOpen.value).toBe(false);
  });
  it('honors Retry-After and does not auto-resubmit passwords',async()=>{
    const s=setup();await enter(s);fillPassword(s);const original=s.fetcher.getMockImplementation()!;
    s.fetcher.mockImplementation((url,opts)=>url.endsWith('/me/password')?Promise.resolve(new Response(JSON.stringify({error:{message:'操作过于频繁'}}),{status:429,headers:{'Retry-After':'30'}})):original(url,opts));
    await s.space.changePassword();await s.space.changePassword();expect(s.fetcher.mock.calls.filter(([url])=>url.endsWith('/me/password'))).toHaveLength(1);
  });
  it('expires all local private state with the success notice, but ignores success after an account switch',async()=>{
    const s=setup();await enter(s);fillPassword(s);await s.space.changePassword();
    expect(s.auth.state.value).toBe('guest');expect(s.auth.error.value).toBe('密码已修改，请重新登录');expect(s.space.profile.value).toBeNull();expect(s.space.password.new_password).toBe('');
    await s.auth.submit('login',{username:'Beta',password:'test password'});await flushPromises();fillPassword(s);
    const original=s.fetcher.getMockImplementation()!;let finish!:(r:Response)=>void;
    s.fetcher.mockImplementation((url,opts)=>url.endsWith('/me/password')?new Promise(r=>finish=r):original(url,opts));const pending=s.space.changePassword();
    await s.auth.submit('login',{username:'Gamma',password:'test password'});await flushPromises();finish(new Response(null,{status:204}));await pending;
    expect(s.auth.user.value?.id).toBe('Gamma');
  });
});

it('renders independent modules, real counts, accessible avatar selection and collapsed password form',async()=>{
  const s=setup();await enter(s);const w=mount(PersonalSpace,{props:{space:s.space,logoutBusy:false}});cleanup.push(()=>w.unmount());
  expect(w.text()).toContain('根据 4 部有效剧集收藏整理');expect(w.text()).toContain('2 部资料暂不可用');expect(w.text()).not.toContain('注册时间');expect(w.find('input[value=Alpha]').exists()).toBe(false);
  expect(w.findAll('.avatar-option')).toHaveLength(6);expect(w.find('.avatar-option[aria-pressed=true]').text()).toContain('✓');
  await w.find('[aria-label="月光头像"]').trigger('click');expect(s.space.draft.avatar_id).toBe('kiwi-moon');expect(s.space.profile.value?.avatar_id).toBe('kiwi-default');
  expect(w.find('#password-form').exists()).toBe(false);await w.find('[aria-controls=password-form]').trigger('click');expect(w.findAll('input[type=password]')).toHaveLength(3);
  await w.find('[aria-label=显示当前密码]').trigger('click');expect(w.find('#space-current_password').attributes('type')).toBe('text');
});

it('opens personal space after guest login, preserves the active viewing flow, and never fetches catalogue for that view',async()=>{
  const s=setup(null),w=mount(App);cleanup.push(()=>w.unmount());await flushPromises();
  await w.find('#query').setValue('保留我的观剧需求');await w.find('.account-button').trigger('click');
  await w.find('#auth-username').setValue('Alpha');await w.find('#auth-password').setValue('test password');await w.find('.auth-dialog form').trigger('submit');await flushPromises();
  expect(w.find('.personal-space').exists()).toBe(true);expect(s.fetcher.mock.calls.some(([url])=>url.includes('/works?'))).toBe(false);
  await w.find('.space-heading button').trigger('click');await flushPromises();expect(w.find('#query').element).toHaveProperty('value','保留我的观剧需求');
  await w.find('.account-button').trigger('click');await flushPromises();await w.find('#space-nickname').setValue('Kiwi');await w.find('.profile-card form').trigger('submit');await flushPromises();expect(w.find('.account-button').text()).toBe('Kiwi');
});
