import { mount,flushPromises } from '@vue/test-utils';
import { describe,it,expect,vi,beforeEach,afterEach } from 'vitest';
import App from '../src/App.vue';
import { emptyPreferences } from '../src/types';
import { workFixture } from './work-fixture';

const prefs=()=>({...emptyPreferences(),soft_preferences:{genres:['修仙'],themes:[],pace:null}});
const response=(body:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status}));
const initial=(url:string)=>url.endsWith('/auth/me')?response({user:null}):url.startsWith('/health')?response({status:'ready',mode:'live',works:41}):url.includes('/catalog/refresh')?response({status:'idle',message:'尚未同步'}):response({items:[],total:0});
const findButton=(wrapper:ReturnType<typeof mount>,text:string)=>wrapper.findAll('button').find(b=>b.text().includes(text))!;
beforeEach(()=>{localStorage.clear();HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};});
afterEach(()=>vi.unstubAllGlobals());
describe('preference confirmation flow',()=>{
  it('shows inline steps instead of default cards or a help dialog, while retaining the carousel',async()=>{
    const works=Array.from({length:6},(_,i)=>workFixture({id:`featured-${i}`,cover_url:`https://example.org/${i}.jpg`,source_meta:{provider:'hongguo',content_type:'漫剧',tags:[],pages:[],rank:null,heat:null,episode_count:30}}));
    const fetcher=vi.fn((url:string)=>url.includes('/works?')?response({items:works,total:6}):initial(url));vi.stubGlobal('fetch',fetcher);
    const w=mount(App);await flushPromises();const text=(w.find('textarea').element as HTMLTextAreaElement).value;
    const guide=w.find('.results-section .generation-guide');expect(guide.classes()).toContain('empty-state');
    expect(guide.findAll('.generation-steps li')).toHaveLength(3);expect(guide.text()).toContain('明确排除项');
    expect(w.findAll('.featured-pages button')).toHaveLength(6);expect(w.findAll('.drama-card')).toHaveLength(0);
    expect(w.find('.help-button').exists()).toBe(false);expect(w.find('#guide-dialog').exists()).toBe(false);expect(w.find('.guide-link').exists()).toBe(false);
    expect(fetcher.mock.calls.some(([url])=>url.includes('/recommendations')||url.includes('/parse'))).toBe(false);
    expect((w.find('textarea').element as HTMLTextAreaElement).value).toBe(text);w.unmount();
  });
  it('keeps the guide after parsing, shows only generated cards, and restores it after input changes',async()=>{
    let finish!:(r:Response)=>void;
    const fetcher=vi.fn((url:string)=>url.includes('/parse')?response({preferences:prefs()}):url.includes('/recommendations')?new Promise<Response>(resolve=>finish=resolve):initial(url));vi.stubGlobal('fetch',fetcher);
    const w=mount(App);await flushPromises();await findButton(w,'理解我的口味').trigger('click');await flushPromises();
    expect(w.find('.generation-guide').exists()).toBe(true);expect(w.findAll('.drama-card')).toHaveLength(0);
    await findButton(w,'确认偏好').trigger('click');expect(w.findAll('.skeleton')).toHaveLength(3);expect(w.find('.generation-guide').exists()).toBe(false);
    finish(new Response(JSON.stringify({status:'success',items:[workFixture({title:'本次生成作品'})],warnings:[],timings_ms:{total:100},request_id:'test',mode:'live'})));await flushPromises();
    expect(w.findAll('.drama-card')).toHaveLength(1);expect(w.find('.drama-card h3').text()).toBe('本次生成作品');expect(w.find('.generation-guide').exists()).toBe(false);
    await w.find('textarea').setValue('想看都市成长');expect(w.findAll('.drama-card')).toHaveLength(0);expect(w.find('.generation-guide').exists()).toBe(true);w.unmount();
  });
  it.each(['empty','needs_confirmation'])('preserves the %s result and adjustment action instead of replacing it with the guide',async(status)=>{
    vi.stubGlobal('fetch',vi.fn((url:string)=>url.includes('/parse')?response({preferences:prefs()}):url.includes('/recommendations')?response({status,items:[],warnings:['请检查当前条件'],timings_ms:{},request_id:'test'}):initial(url)));
    const w=mount(App);await flushPromises();await findButton(w,'理解我的口味').trigger('click');await flushPromises();await findButton(w,'确认偏好').trigger('click');await flushPromises();
    expect(w.find('.generation-guide').exists()).toBe(false);expect(w.find('.results-section').text()).toContain(status==='empty'?'这一种口味，还没有遇到':'有些条件需要你确认');
    expect(w.find('.result-status').text()).toContain('请检查当前条件');await findButton(w,'调整我的偏好').trigger('click');expect(w.find('.preference-dialog').attributes('open')).toBeDefined();
    await findButton(w,'确认修改').trigger('click');expect(w.find('.generation-guide').exists()).toBe(true);w.unmount();
  });
  it('keeps the guide usable when the carousel load fails and allows a separate retry',async()=>{
    let failed=true;const fetcher=vi.fn((url:string)=>url.includes('/works?')?(failed?response({error:{message:'片库暂时不可用'}},503):response({items:[],total:0})):initial(url));vi.stubGlobal('fetch',fetcher);
    const w=mount(App);await flushPromises();expect(w.find('.featured-status').text()).toContain('片库暂时不可用');expect(w.find('.generation-guide').exists()).toBe(true);
    failed=false;await findButton(w,'重新加载片库').trigger('click');await flushPromises();expect(w.find('.featured-status').text()).toContain('片库还没有作品');expect(w.find('.generation-guide').exists()).toBe(true);
    expect(fetcher.mock.calls.some(([url])=>url.includes('/recommendations')||url.includes('/parse'))).toBe(false);w.unmount();
  });
  it('requires a separate confirmation before recommendation',async()=>{
    const fetcher=vi.fn((url:string)=>url.includes('/parse')?response({preferences:prefs()}):url.includes('/recommendations')?response({status:'empty',items:[],warnings:[],timings_ms:{},request_id:'test'}):initial(url));vi.stubGlobal('fetch',fetcher);
    const w=mount(App);await flushPromises();await findButton(w,'理解我的口味').trigger('click');await flushPromises();expect(fetcher.mock.calls.some(([u])=>u.includes('/recommendations'))).toBe(false);expect(w.text()).toContain('确认偏好，生成片单');await findButton(w,'确认偏好').trigger('click');await flushPromises();expect(w.text()).toContain('这一种口味，还没有遇到');w.unmount();
  });
  it('sends user-edited preferences without reparsing',async()=>{
    const fetcher=vi.fn((url:string)=>url.includes('/parse')?response({preferences:prefs()}):url.includes('/recommendations')?response({status:'empty',items:[],warnings:[],timings_ms:{},request_id:'test'}):initial(url));vi.stubGlobal('fetch',fetcher);
    const w=mount(App);await flushPromises();await findButton(w,'理解我的口味').trigger('click');await flushPromises();await findButton(w,'调整 ↗').trigger('click');const inputs=w.findAll('input[type=checkbox]');const city=inputs.find(i=>i.element.getAttribute('value')==='都市')!;await city.setValue(true);await findButton(w,'确认修改').trigger('click');await findButton(w,'确认偏好').trigger('click');await flushPromises();
    const call=fetcher.mock.calls.find(([u])=>u.includes('/recommendations')) as unknown as [string,RequestInit];expect(JSON.parse(call[1].body as string).preferences.soft_preferences.genres).toContain('都市');expect(fetcher.mock.calls.filter(([u])=>u.includes('/parse'))).toHaveLength(1);w.unmount();
  });
  it('ignores an old parse response after the description changes',async()=>{
    let finish!:(r:Response)=>void;const old=new Promise<Response>(resolve=>finish=resolve);vi.stubGlobal('fetch',vi.fn((url:string)=>url.includes('/parse')?old:initial(url)));const w=mount(App);await flushPromises();await findButton(w,'理解我的口味').trigger('click');await w.find('textarea').setValue('想看都市');finish(new Response(JSON.stringify({preferences:prefs()})));await flushPromises();expect(w.text()).toContain('理解我的口味');expect(w.find('.preference-chips').text()).not.toContain('修仙');w.unmount();
  });
  it('preserves confirmed preferences after failure and allows retry',async()=>{
    let attempts=0;const fetcher=vi.fn((url:string)=>url.includes('/parse')?response({preferences:prefs()}):url.includes('/recommendations')?(++attempts===1?response({error:{message:'向量服务调用失败'}},503):response({status:'empty',items:[],warnings:[],timings_ms:{},request_id:'r'})):initial(url));vi.stubGlobal('fetch',fetcher);const w=mount(App);await flushPromises();await findButton(w,'理解我的口味').trigger('click');await flushPromises();await findButton(w,'确认偏好').trigger('click');await flushPromises();expect(w.text()).toContain('向量服务调用失败');expect(w.find('.preference-chips').text()).toContain('修仙');await findButton(w,'确认偏好').trigger('click');await flushPromises();expect(attempts).toBe(2);w.unmount();
  });
});
