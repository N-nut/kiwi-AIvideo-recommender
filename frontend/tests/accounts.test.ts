import { mount,flushPromises } from '@vue/test-utils';
import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import App from '../src/App.vue';
import { homeFixture, workFixture } from './work-fixture';

const work=workFixture({id:'work-a'});
const response=(body:unknown,status=200)=>Promise.resolve(new Response(status===204?null:JSON.stringify(body),{status}));
let wrapper:ReturnType<typeof mount>;
const button=(text:string)=>wrapper.findAll('button').find(b=>b.text().includes(text))!;
beforeEach(()=>{
  localStorage.clear();
  HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
  HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');this.dispatchEvent(new Event('close'));};
});
afterEach(()=>{wrapper?.unmount();vi.unstubAllGlobals();});

function server(initialUser:string|null=null) {
  let user=initialUser,failWrite=false,failLogout=false,failMe=false,failIds=false,expireWrite=false;
  const saved:Record<string,Set<string>>={Alpha:new Set(),Beta:new Set()};
  const fetcher=vi.fn((url:string,options?:RequestInit):Promise<Response>=>{
    if(url.includes('/home/recommendations')||url.endsWith('/home-recommendations'))return response(homeFixture());
    if(url==='/api/v1/auth/me')return failMe?response({error:{message:'账号检查失败'}},503):response({user:user?{id:`uuid-${user}`,username:user,nickname:null,avatar_id:'kiwi-default'}:null});
    if(url.endsWith('/auth/register')||url.endsWith('/auth/login')){user=JSON.parse(options!.body as string).username;return response({user:{id:`uuid-${user}`,username:user,nickname:null,avatar_id:'kiwi-default'}},url.endsWith('/register')?201:200);}
    if(url.endsWith('/me/profile'))return response({profile:{id:`uuid-${user}`,username:user,nickname:null,avatar_id:'kiwi-default'}});
    if(url.endsWith('/me/space-summary'))return response({favorites:{total:saved[user||'']?.size||0,available:saved[user||'']?.size||0,unavailable:0},interest:{status:'no_favorites',analyzed_count:0,content_types:[],genres:[],themes:[]}});
    if(url.endsWith('/auth/logout')){if(failLogout)return response({error:{message:'退出失败，请重试'}},503);user=null;return response(null,204);}
    if(url.includes('/me/favorites')){
      if(!user||expireWrite){user=null;return response({error:{message:'登录状态已失效，请重新登录'}},401);}
      const set=saved[user] ||= new Set<string>();
      if(options?.method==='PUT'){if(failWrite)return response({error:{message:'保存失败，请重试'}},503);set.add('work-a');return response({saved:true});}
      if(options?.method==='DELETE'){set.delete('work-a');return response(null,204);}
      if(url.endsWith('/import')){const ids:string[]=JSON.parse(options!.body as string).work_ids;let added=0;ids.forEach(id=>{if(!set.has(id)){set.add(id);added++;}});return response({requested:ids.length,unique:ids.length,added,already_saved:ids.length-added,skipped_unavailable:0});}
      if(url.includes('/ids?'))return failIds?response({error:{message:'收藏状态失败'}},503):response({items:[...set],relation_total:set.size});
      const params=new URL(url,'http://test').searchParams,page=Number(params.get('page')||1),size=Number(params.get('page_size')||12);
      const items=[...set].slice((page-1)*size,page*size).map(id=>id===work.id?work:workFixture({id,title:`收藏 ${id}`}));
      return response({items,total:set.size,unavailable_count:0,page,page_size:size});
    }
    if(url.startsWith('/health'))return response({status:'ready',mode:'baseline',works:30});
    if(url.includes('/catalog/refresh'))return response({status:'idle'});
    if(url.includes('/works?'))return response({items:[work],total:30});
    if(url.includes('/parse'))return response({preferences:{schema_version:1,soft_preferences:{genres:['修仙'],themes:[],pace:null},required:[],excluded_features:[],excluded_genres:[],unresolved_constraints:[],conflicts:[]}});
    if(url.includes('/recommendations'))return response({status:'success',items:[work],warnings:[],timings_ms:{},request_id:'test'});
    throw Error(`Unexpected test request ${url}`);
  });
  vi.stubGlobal('fetch',fetcher);
  return {fetcher,saved,failWrite:(v=true)=>failWrite=v,failLogout:(v=true)=>failLogout=v,failMe:(v=true)=>failMe=v,failIds:(v=true)=>failIds=v,expireWrite:()=>expireWrite=true};
}
async function signIn(name='Alpha') {
  await wrapper.find('#auth-username').setValue(name);await wrapper.find('#auth-password').setValue('test password');
  await wrapper.find('.auth-dialog form').trigger('submit');await flushPromises();
}
async function showCatalog() {await button('片库').trigger('click');await flushPromises();}

describe('account product flow',()=>{
  it('paginates favorites on the server and retains the complete collection count',async()=>{
    const backend=server('Alpha');for(let i=0;i<13;i++)backend.saved.Alpha!.add(`saved-${i}`);
    wrapper=mount(App);await flushPromises();await button('我的收藏').trigger('click');await flushPromises();
    expect(wrapper.findAll('.drama-card')).toHaveLength(12);expect(wrapper.findAll('.nav-count')[1]!.text()).toBe('13');
    await button('下一页').trigger('click');await flushPromises();expect(wrapper.findAll('.drama-card')).toHaveLength(1);expect(wrapper.find('.drama-card h3').text()).toBe('收藏 saved-12');
    expect(backend.fetcher.mock.calls.some(([url])=>url.includes('/me/favorites?page=2&page_size=12'))).toBe(true);
  });
  it('does not display a late private page from the previous account',async()=>{
    const backend=server('Alpha'),original=backend.fetcher.getMockImplementation()!;let finish!:(r:Response)=>void,delayed=true;
    backend.fetcher.mockImplementation((url:string,opts?:RequestInit)=>url.includes('/me/favorites?page=1&')&&delayed?new Promise<Response>(r=>finish=r):original(url,opts));
    wrapper=mount(App);await flushPromises();await button('我的收藏').trigger('click');await flushPromises();
    await button('退出').trigger('click');await flushPromises();delayed=false;await wrapper.find('.account-button').trigger('click');await signIn('Beta');await button('我的收藏').trigger('click');await flushPromises();
    finish(new Response(JSON.stringify({items:[work],total:1,unavailable_count:0})));await flushPromises();expect(wrapper.findAll('.drama-card')).toHaveLength(0);expect(wrapper.find('.account-button').text()).toBe('Beta');
  });
  it('restores an account and its server favorites without importing same-name legacy data',async()=>{
    localStorage.setItem('kiwi-real-library-v1',JSON.stringify({Alpha:['local-secret'],Other:['other']}));
    const backend=server('Alpha');backend.saved.Alpha!.add('work-a');wrapper=mount(App);await flushPromises();
    expect(wrapper.find('.account-button').text()).toBe('Alpha');expect(wrapper.findAll('.nav-count')[1]!.text()).toBe('1');
    expect(wrapper.find('.legacy-import').text()).toContain('目标账号：Alpha');expect(wrapper.findAll('.legacy-import option').map(x=>x.text())).toEqual(['Alpha（1 部）','Other（1 部）']);
    expect(backend.fetcher.mock.calls.some(([url])=>url.endsWith('/import'))).toBe(false);
    await button('我的收藏').trigger('click');await flushPromises();expect(wrapper.find('.drama-card h3').text()).toBe(work.title);
    expect(backend.fetcher.mock.calls.some(([url])=>url==='/api/v1/works/work-a')).toBe(false);
  });
  it('requires login for collection and continues exactly that favorite after registration',async()=>{
    const backend=server();wrapper=mount(App);await flushPromises();await showCatalog();
    const query=(wrapper.find('textarea').exists()?wrapper.find('textarea').element as HTMLTextAreaElement:null)?.value;
    await wrapper.find('.card-favorite').trigger('click');expect(wrapper.find('.auth-dialog').attributes('open')).toBeDefined();
    await wrapper.find('.auth-switch').trigger('click');expect(wrapper.find('#auth-confirmation').exists()).toBe(true);
    await wrapper.find('#auth-username').setValue('Alpha');await wrapper.find('#auth-password').setValue('test password');await wrapper.find('#auth-confirmation').setValue('test password');
    await wrapper.find('.auth-dialog form').trigger('submit');await flushPromises();
    expect(wrapper.find('.account-button').text()).toBe('Alpha');expect(wrapper.find('.card-favorite').attributes('aria-pressed')).toBe('true');
    expect(backend.fetcher.mock.calls.filter(([,opts])=>opts?.method==='PUT')).toHaveLength(1);expect(backend.saved.Alpha!.has('work-a')).toBe(true);
    expect(wrapper.find('#auth-password').element).toHaveProperty('value','');expect(wrapper.find('.auth-dialog').attributes('open')).toBeUndefined();
    expect(query).toBeUndefined();
  });
  it('closing login keeps the query, preferences, generated results and scroll, and clears pending favorite',async()=>{
    const backend=server();wrapper=mount(App);await flushPromises();await button('理解我的口味').trigger('click');await flushPromises();await button('确认偏好').trigger('click');await flushPromises();
    const query=(wrapper.find('textarea').element as HTMLTextAreaElement).value;
    await wrapper.find('.card-favorite').trigger('click');await wrapper.find('#auth-password').setValue('do not retain');
    await wrapper.find('.auth-dialog [aria-label="关闭登录"]').trigger('click');
    expect(wrapper.find('#auth-password').element).toHaveProperty('value','');expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe(query);
    expect(wrapper.find('.preference-chips').text()).toContain('修仙');expect(wrapper.find('.drama-card').exists()).toBe(true);
    await wrapper.find('.account-button').trigger('click');await signIn();expect(backend.saved.Alpha!.size).toBe(0);
  });
  it('validates fields, preserves username, clears passwords when switching mode and prevents duplicate submit',async()=>{
    const backend=server();wrapper=mount(App);await flushPromises();await wrapper.find('.account-button').trigger('click');await wrapper.find('.auth-switch').trigger('click');
    await wrapper.find('#auth-username').setValue('Alpha');await wrapper.find('#auth-password').setValue('test password');await wrapper.find('#auth-confirmation').setValue('mismatch');await wrapper.find('.auth-dialog form').trigger('submit');
    expect(wrapper.text()).toContain('两次密码不一致');expect(backend.fetcher.mock.calls.some(([url])=>url.endsWith('/register'))).toBe(false);
    await wrapper.find('.auth-switch').trigger('click');expect(wrapper.find('#auth-password').element).toHaveProperty('value','');expect(wrapper.find('#auth-username').element).toHaveProperty('value','Alpha');
    let resolve!:(r:Response)=>void;backend.fetcher.mockImplementationOnce(()=>new Promise<Response>(r=>resolve=r));await wrapper.find('#auth-password').setValue('test password');
    await wrapper.find('.auth-dialog form').trigger('submit');await wrapper.find('.auth-dialog form').trigger('submit');expect(wrapper.find('.auth-dialog button[type=submit]').attributes('disabled')).toBeDefined();
    resolve(new Response(JSON.stringify({error:{message:'用户名或密码不正确'} }),{status:401}));await flushPromises();
    expect(wrapper.find('.auth-dialog').text()).toContain('用户名或密码不正确');expect(wrapper.find('#auth-username').element).toHaveProperty('value','Alpha');
  });
  it('shows a retry for account or ID failure and keeps uncertain favorites unsaved until confirmation',async()=>{
    const backend=server('Alpha');backend.failMe();wrapper=mount(App);await flushPromises();expect(wrapper.find('.account-button').text()).toContain('重试账号状态');
    backend.failMe(false);backend.failIds();await wrapper.find('.account-button').trigger('click');await flushPromises();await showCatalog();
    expect(wrapper.find('.card-favorite').attributes('aria-pressed')).toBeUndefined();expect(wrapper.text()).toContain('收藏状态失败');
    backend.failIds(false);await button('重试收藏状态').trigger('click');await flushPromises();backend.failWrite();await wrapper.find('.card-favorite').trigger('click');await flushPromises();
    expect(wrapper.find('.card-favorite').attributes('aria-pressed')).toBe('false');expect(wrapper.text()).toContain('保存失败');
    backend.failWrite(false);await wrapper.find('.card-favorite').trigger('click');await flushPromises();expect(wrapper.find('.card-favorite').attributes('aria-pressed')).toBe('true');
  });
  it('requires successful logout, clears private UI, and keeps different accounts isolated',async()=>{
    const backend=server('Alpha');backend.saved.Alpha!.add('work-a');wrapper=mount(App);await flushPromises();await button('我的收藏').trigger('click');await flushPromises();
    backend.failLogout();await button('退出').trigger('click');await flushPromises();expect(wrapper.find('.account-button').text()).toBe('Alpha');expect(wrapper.find('.drama-card').exists()).toBe(true);
    backend.failLogout(false);await button('退出').trigger('click');await flushPromises();expect(wrapper.find('.account-button').text()).toBe('登录 / 注册');expect(wrapper.find('.nav-item.active').text()).toContain('发现好剧');
    await wrapper.find('.account-button').trigger('click');await signIn('Beta');await button('我的收藏').trigger('click');await flushPromises();expect(wrapper.findAll('.drama-card')).toHaveLength(0);
    expect(backend.saved.Alpha!.has('work-a')).toBe(true);
  });
  it('expires a protected write without saving or replaying it, preserving viewing input',async()=>{
    const backend=server('Alpha');wrapper=mount(App);await flushPromises();await showCatalog();backend.expireWrite();await wrapper.find('.card-favorite').trigger('click');await flushPromises();
    expect(wrapper.find('.account-button').text()).toBe('登录 / 注册');expect(wrapper.text()).toContain('登录状态已失效');expect(backend.saved.Alpha!.size).toBe(0);
    expect(backend.fetcher.mock.calls.filter(([,opts])=>opts?.method==='PUT')).toHaveLength(1);
  });
  it('imports only the confirmed group, preserves local data, and remembers completed imports',async()=>{
    const raw=JSON.stringify({Old:['work-a'],Other:['untouched']});localStorage.setItem('kiwi-real-library-v1',raw);
    const backend=server('Alpha');wrapper=mount(App);await flushPromises();await button('暂不导入').trigger('click');
    expect(backend.saved.Alpha!.size).toBe(0);await button('我的收藏').trigger('click');await flushPromises();await button('导入本机旧收藏').trigger('click');await button('导入收藏').trigger('click');await flushPromises();
    expect(backend.saved.Alpha!.has('work-a')).toBe(true);expect(backend.saved.Alpha!.has('untouched')).toBe(false);expect(localStorage.getItem('kiwi-real-library-v1')).toBe(raw);expect(wrapper.text()).toContain('导入完成');
    expect(JSON.parse(backend.fetcher.mock.calls.find(([url])=>url.endsWith('/import'))![1]!.body as string)).toEqual({work_ids:['work-a']});
    wrapper.unmount();wrapper=mount(App);await flushPromises();expect(wrapper.findAll('.legacy-import option').map(x=>x.text())).toEqual(['Other（1 部）']);
  });
});
