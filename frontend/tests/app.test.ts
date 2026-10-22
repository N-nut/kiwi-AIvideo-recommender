import { mount,flushPromises } from '@vue/test-utils';
import { describe,it,expect,vi,beforeEach,afterEach } from 'vitest';
import App from '../src/App.vue';
import { emptyPreferences } from '../src/types';

const prefs=()=>({...emptyPreferences(),soft_preferences:{genres:['修仙'],themes:[],pace:null}});
const response=(body:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status}));
const initial=(url:string)=>url.startsWith('/health')?response({status:'ready',mode:'live',works:41}):url.includes('/catalog/refresh')?response({status:'idle',message:'尚未同步'}):response({items:[],total:0});
const findButton=(wrapper:ReturnType<typeof mount>,text:string)=>wrapper.findAll('button').find(b=>b.text().includes(text))!;
beforeEach(()=>{localStorage.clear();HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};});
afterEach(()=>vi.unstubAllGlobals());
describe('preference confirmation flow',()=>{
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
