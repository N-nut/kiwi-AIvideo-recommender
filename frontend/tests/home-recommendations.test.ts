import { effectScope, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../src/useAuth';
import { useLibrary } from '../src/library';
import { useHomeRecommendations } from '../src/useHomeRecommendations';
import FeaturedCarousel from '../src/components/FeaturedCarousel.vue';
import App from '../src/App.vue';
import { homeFixture, workFixture } from './work-fixture';
import { emptyPreferences } from '../src/types';

const response=(body:unknown,status=200)=>Promise.resolve(new Response(status===204?null:JSON.stringify(body),{status}));
const personalized=(label='修仙逆袭')=>homeFixture([], {prompts_mode:'personalized',prompts:[{label,text:`想看${label}的故事。`,basis:'favorites',genres:['修仙'],themes:['逆袭']}]});
const stops:(()=>void)[]=[];
beforeEach(()=>{localStorage.clear();HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};});
afterEach(()=>{stops.splice(0).forEach(stop=>stop());vi.unstubAllGlobals();});
function setup(initialUser:string|null='Alpha') {
  let user=initialUser,failPrivate=0,failPublic=false,failWrite=false,failMe=false;
  let style='修仙逆袭';const saved=new Set<string>();
  const held:(()=>void)[]=[];let hold=false;
  const fetcher=vi.fn((url:string,options?:RequestInit):Promise<Response>=>{
    if(url.endsWith('/auth/me'))return failMe?response({error:{message:'检查失败'}},503):response({user:user?{id:user,username:user,nickname:null,avatar_id:'kiwi-default'}:null});
    if(url.endsWith('/auth/login')){user=JSON.parse(options!.body as string).username;return response({user:{id:user,username:user,nickname:null,avatar_id:'kiwi-default'}});}
    if(url.endsWith('/auth/logout')){user=null;return response(null,204);}
    if(url==='/api/v1/home/recommendations')return failPublic?response({error:{message:'公开内容加载失败'}},503):response(homeFixture());
    if(url.endsWith('/me/home-recommendations')) {
      const body=failPrivate?{error:{message:'个性化失败'}}:personalized(style),status=failPrivate||200;
      if(hold)return new Promise(resolve=>held.push(()=>resolve(new Response(JSON.stringify(body),{status}))));
      return response(body,status);
    }
    if(url.includes('/me/favorites')) {
      if(options?.method==='PUT'||options?.method==='DELETE') {
        if(failWrite)return response({error:{message:'保存失败'}},503);
        if(options.method==='PUT')saved.add('saved');else saved.delete('saved');style=saved.size?'末世系统':'修仙逆袭';
        return response(null,options.method==='DELETE'?204:200);
      }
      return response(url.includes('/ids?')?{items:[...saved],relation_total:saved.size}:{items:[],total:saved.size,unavailable_count:0});
    }
    if(url.startsWith('/health'))return response({works:20,mode:'baseline'});
    if(url.includes('/catalog/refresh'))return response({status:'idle'});
    throw Error(url);
  });vi.stubGlobal('fetch',fetcher);
  const scope=effectScope();stops.push(()=>scope.stop());
  const state=scope.run(()=>{const auth=useAuth(),library=useLibrary(auth),view=ref('discover');return {auth,library,view,home:useHomeRecommendations(auth,library,view)};})!;
  return {...state,fetcher,held,style:(value:string)=>style=value,hold:(value=true)=>hold=value,
    failPrivate:(value=503)=>failPrivate=value,failPublic:(value=true)=>failPublic=value,failWrite:(value=true)=>failWrite=value,failMe:(value=true)=>failMe=value};
}

describe('home recommendations request scope',()=>{
  it('uses public content while checking, guest or auth check failure and never local demo favorites',async()=>{
    const s=setup(null);localStorage.setItem('kiwi-real-library-v1',JSON.stringify({Alpha:['secret']}));await flushPromises();
    expect(s.home.promptTitle.value).toBe('换个口味试试：');await s.auth.restore();await flushPromises();
    s.failMe();await s.auth.restore();await flushPromises();
    expect(s.auth.state.value).toBe('error');expect(s.home.prompts.value).toHaveLength(4);
    expect(s.fetcher.mock.calls.some(([url])=>url.includes('/me/home-'))).toBe(false);
  });
  it('refreshes after successful save and removal; failed writes keep the confirmed basis',async()=>{
    const s=setup();await s.auth.restore();await flushPromises();expect(s.home.prompts.value[0]?.label).toBe('修仙逆袭');
    await s.library.setSaved('saved',true);await flushPromises();expect(s.home.prompts.value[0]?.label).toBe('末世系统');
    const count=s.fetcher.mock.calls.filter(([url])=>url.endsWith('/me/home-recommendations')).length;
    s.failWrite();await s.library.setSaved('saved',false);await flushPromises();
    expect(s.fetcher.mock.calls.filter(([url])=>url.endsWith('/me/home-recommendations'))).toHaveLength(count);
    expect(s.home.prompts.value[0]?.label).toBe('末世系统');s.failWrite(false);
    await s.library.setSaved('saved',false);await flushPromises();expect(s.home.prompts.value[0]?.label).toBe('修仙逆袭');
  });
  it('marks off-home changes dirty and combines changes before returning home',async()=>{
    const s=setup();await s.auth.restore();await flushPromises();s.view.value='favorites';await flushPromises();
    const count=s.fetcher.mock.calls.length;s.library.revision.value++;s.library.revision.value++;await flushPromises();
    expect(s.fetcher.mock.calls.length).toBe(count);s.style('都市成长');s.view.value='discover';await flushPromises();
    expect(s.fetcher.mock.calls.length).toBe(count+1);expect(s.home.prompts.value[0]?.label).toBe('都市成长');
  });
  it('shows explicit public fallback on 503, preserves the account and retries private content',async()=>{
    const s=setup();s.failPrivate();await s.auth.restore();await flushPromises();
    expect(s.auth.state.value).toBe('authenticated');expect(s.home.notice.value).toContain('已显示片库精选');expect(s.home.data.value?.prompts_mode).toBe('default');
    s.failPrivate(0);await s.home.load();expect(s.home.data.value?.prompts_mode).toBe('personalized');expect(s.home.notice.value).toBe('');
    s.failPrivate();s.failPublic();await s.home.load();expect(s.home.data.value).toBeNull();expect(s.home.error.value).toBe('公开内容加载失败');
  });
  it('expires 401 and immediately clears private content before loading public content',async()=>{
    const s=setup();await s.auth.restore();await flushPromises();s.failPrivate(401);await s.home.load();await flushPromises();
    expect(s.auth.state.value).toBe('guest');expect(s.auth.error.value).toContain('登录状态已失效');expect(s.home.data.value?.prompts_mode).toBe('default');
  });
  it('rejects a same-account late response after favorites changed, even when abort is ignored',async()=>{
    const s=setup();await s.auth.restore();await flushPromises();s.hold();void s.home.load();await flushPromises();
    s.style('都市成长');s.library.revision.value++;await flushPromises();expect(s.held).toHaveLength(2);
    s.held[1]!();await flushPromises();s.held[0]!();await flushPromises();expect(s.home.prompts.value[0]?.label).toBe('都市成长');
  });
  it('clears on logout and rejects an old account response after a different login',async()=>{
    const s=setup();await s.auth.restore();await flushPromises();s.hold();void s.home.load();await flushPromises();
    await s.auth.logout();expect(s.home.data.value).toBeNull();s.style('末世系统');s.hold(false);
    await s.auth.submit('login',{username:'Beta',password:'test password'});await flushPromises();
    s.held[0]!();await flushPromises();expect(s.auth.user.value?.username).toBe('Beta');expect(s.home.prompts.value[0]?.label).toBe('末世系统');
  });
  it('does not write a held response after disposal',async()=>{
    const s=setup();await s.auth.restore();await flushPromises();s.style('迟到结果');s.hold();void s.home.load();await flushPromises();stops.splice(0).forEach(stop=>stop());
    s.held[0]!();await flushPromises();expect(s.home.prompts.value[0]?.label).toBe('修仙逆袭');
  });
});

it('a fully failed legacy import keeps the confirmed recommendation basis',async()=>{
  const s=setup();const original=s.fetcher.getMockImplementation()!;
  s.fetcher.mockImplementation((url:string,options?:RequestInit)=>url.endsWith('/favorites/import')?response({error:{message:'导入服务失败'}},503):original(url,options));
  localStorage.setItem('kiwi-real-library-v1',JSON.stringify({Old:['saved']}));
  const w=mount(App);stops.push(()=>w.unmount());await flushPromises();
  const count=s.fetcher.mock.calls.filter(([url])=>url.endsWith('/me/home-recommendations')).length;
  await w.find('.legacy-import .primary-button').trigger('click');await flushPromises();
  expect(w.find('.legacy-import').text()).toContain('导入服务失败');expect(w.find('#favorite-prompts-title').text()).toBe('根据您的收藏，猜您喜欢：');
  expect(s.fetcher.mock.calls.filter(([url])=>url.endsWith('/me/home-recommendations'))).toHaveLength(count);
});

it('uses server ordering and identifies only genuine favorite matches in the carousel',async()=>{
  const work=workFixture({cover_url:'https://example.org/a.jpg',source_meta:{provider:'hongguo',content_type:'漫剧',tags:[],pages:[],rank:null,heat:null,episode_count:null}});
  const items=homeFixture([work,{...work,id:'second'}]).items;items[0]!.basis='favorites';items[0]!.reason='根据你收藏的修仙风格推荐';
  const w=mount(FeaturedCarousel,{props:{works:items}});stops.push(()=>w.unmount());
  expect(w.find('.featured-label').text()).toBe('根据收藏推荐');expect(w.find('.featured-reason').text()).toContain('修仙');
  await w.find('[aria-label="下一部精选"]').trigger('click');expect(w.find('.featured-label').text()).toBe('片库精选');expect(w.find('.featured-reason').exists()).toBe(false);
});

it('background refresh preserves input, confirmed preferences and the generated list; prompt clicks require new confirmation',async()=>{
  const s=setup();const original=s.fetcher.getMockImplementation()!;
  s.fetcher.mockImplementation((url:string,options?:RequestInit)=>url.endsWith('/preferences/parse')?response({preferences:emptyPreferences()}):url==='/api/v1/recommendations'?response({status:'success',items:[workFixture()],warnings:[],timings_ms:{}}):original(url,options));
  const w=mount(App);stops.push(()=>w.unmount());await flushPromises();
  const button=(text:string)=>w.findAll('button').find(b=>b.text().includes(text))!;
  await w.find('#query').setValue('正在编辑的需求');await button('理解我的口味').trigger('click');await flushPromises();await button('确认偏好').trigger('click');await flushPromises();
  expect(w.find('.drama-card').exists()).toBe(true);
  // The app's own auth restore is now complete; a logout triggers its background home refresh.
  await button('退出').trigger('click');await flushPromises();
  expect(w.find('#query').element).toHaveProperty('value','正在编辑的需求');expect(w.find('.drama-card').exists()).toBe(true);expect(button('确认偏好').exists()).toBe(true);
  const calls=s.fetcher.mock.calls.length;await w.find('.favorite-prompt-examples button').trigger('click');await flushPromises();
  expect(w.find('.drama-card').exists()).toBe(false);expect(button('理解我的口味').exists()).toBe(true);expect(s.fetcher.mock.calls.length).toBe(calls);
});
