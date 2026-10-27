import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.vue';
import { emptyPreferences } from '../src/types';
import { homeFixture, workFixture } from './work-fixture';

const preferences=()=>({...emptyPreferences(),soft_preferences:{genres:['修仙'],themes:['逆袭'],pace:null},
  required:[{field:'themes' as const,value:'系统'}],excluded_features:['harem' as const]});
const response=(body:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status}));
const initial=(url:string)=>url==='/api/v1/home/recommendations'?response(homeFixture()):url.endsWith('/auth/me')?response({user:null}):url.startsWith('/health')?response({mode:'baseline',works:20}):url.includes('/catalog/refresh')?response({status:'idle'}):response({items:[],total:0});
let wrapper:ReturnType<typeof mount>;
const button=(text:string)=>wrapper.findAll('button').find(button=>button.text().includes(text))!;
beforeEach(()=>{localStorage.clear();HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};});
afterEach(()=>{wrapper?.unmount();vi.unstubAllGlobals();});

describe('visible preference recognition and confirmation',()=>{
  it('shows parsing progress without result skeletons, then a summary dialog without requesting recommendations',async()=>{
    let finish!:(response:Response)=>void;
    const fetcher=vi.fn((url:string)=>url.endsWith('/preferences/parse')?new Promise<Response>(resolve=>finish=resolve):initial(url));vi.stubGlobal('fetch',fetcher);
    wrapper=mount(App);await flushPromises();await button('理解我的口味').trigger('click');
    expect(wrapper.find('.parse-progress').text()).toContain('确认后再生成片单');expect(wrapper.findAll('.skeleton')).toHaveLength(0);
    expect(wrapper.find('#results-title').text()).toBe('正在识别偏好');expect(wrapper.find('#recommend-button').attributes('disabled')).toBeDefined();
    await wrapper.find('#query').trigger('keydown',{key:'Enter',ctrlKey:true});expect(fetcher.mock.calls.filter(([url])=>url.endsWith('/parse'))).toHaveLength(1);
    finish(new Response(JSON.stringify({preferences:preferences()})));await flushPromises();
    expect(wrapper.find('.recognition-dialog').attributes('open')).toBeDefined();expect(wrapper.find('#recognition-title').text()).toBe('您的偏好已识别');
    expect(wrapper.find('#recognition-description').text()).toContain('如有不符可手动调整');
    expect(wrapper.find('.recognition-dialog .preference-summary').text()).toContain('偏爱风格');expect(wrapper.find('.recognition-dialog .preference-summary').text()).toContain('必须满足');
    expect(wrapper.find('.recognition-dialog .preference-summary').text()).toContain('不要后宫');
    expect(wrapper.find('.confirmation-guide').text()).toContain('等待你确认');expect(wrapper.findAll('.drama-card')).toHaveLength(0);
    expect(fetcher.mock.calls.some(([url])=>url==='/api/v1/recommendations')).toBe(false);
  });
  it('dismisses and reopens the notice; generating is a separate action and only that action shows result skeletons',async()=>{
    let finish!:(response:Response)=>void;
    const fetcher=vi.fn((url:string)=>url.endsWith('/parse')?response({preferences:preferences()}):url==='/api/v1/recommendations'?new Promise<Response>(resolve=>finish=resolve):initial(url));vi.stubGlobal('fetch',fetcher);
    wrapper=mount(App);await flushPromises();await button('理解我的口味').trigger('click');await flushPromises();
    await wrapper.find('.recognition-dialog').trigger('cancel');expect(wrapper.find('.recognition-dialog').attributes('open')).toBeUndefined();
    expect(wrapper.find('.confirmation-guide').exists()).toBe(true);expect(fetcher.mock.calls.some(([url])=>url==='/api/v1/recommendations')).toBe(false);
    await button('再次核对偏好').trigger('click');expect(wrapper.find('.recognition-dialog').attributes('open')).toBeDefined();
    await wrapper.find('.recognition-dialog .primary-button').trigger('click');expect(wrapper.find('.recognition-dialog').attributes('open')).toBeUndefined();
    expect(wrapper.findAll('.skeleton')).toHaveLength(3);expect(wrapper.find('.parse-progress').exists()).toBe(false);
    const call=fetcher.mock.calls.find(([url])=>url==='/api/v1/recommendations');expect(call).toBeDefined();
    finish(new Response(JSON.stringify({status:'success',items:[workFixture()],warnings:[],timings_ms:{}})));await flushPromises();
    expect(wrapper.findAll('.drama-card')).toHaveLength(1);expect(wrapper.find('.confirmation-guide').exists()).toBe(false);
  });
  it('opens manual adjustment from the notice and submits edited preferences without another parse',async()=>{
    const fetcher=vi.fn((url:string)=>url.endsWith('/parse')?response({preferences:preferences()}):url==='/api/v1/recommendations'?response({status:'empty',items:[],warnings:[],timings_ms:{}}):initial(url));vi.stubGlobal('fetch',fetcher);
    wrapper=mount(App);await flushPromises();await button('理解我的口味').trigger('click');await flushPromises();await wrapper.find('.recognition-dialog .secondary-button').trigger('click');
    expect(wrapper.find('.recognition-dialog').attributes('open')).toBeUndefined();expect(wrapper.find('.preference-dialog').attributes('open')).toBeDefined();
    await wrapper.findAll('.preference-editor fieldset')[0]!.find('input[value="都市"]').setValue(true);await button('确认修改').trigger('click');
    expect(wrapper.find('.taste-panel .preference-summary').text()).toContain('都市');expect(wrapper.find('.taste-state').text()).toBe('待确认');
    await wrapper.find('#recommend-button').trigger('click');await flushPromises();
    const call=fetcher.mock.calls.find(([url])=>url==='/api/v1/recommendations') as unknown as [string,RequestInit];
    expect(JSON.parse(call[1].body as string).preferences.soft_preferences.genres).toEqual(['修仙','都市']);expect(JSON.parse(call[1].body as string).preferences.excluded_features).toEqual(['harem']);
    expect(fetcher.mock.calls.filter(([url])=>url.endsWith('/parse'))).toHaveLength(1);
  });
  it('clears recognition notice and old preferences when the user edits input or chooses a different prompt',async()=>{
    const fetcher=vi.fn((url:string)=>url.endsWith('/parse')?response({preferences:preferences()}):initial(url));vi.stubGlobal('fetch',fetcher);
    wrapper=mount(App);await flushPromises();await button('理解我的口味').trigger('click');await flushPromises();
    await wrapper.find('#query').setValue('想看都市');expect(wrapper.find('.recognition-dialog').attributes('open')).toBeUndefined();expect(wrapper.find('.confirmation-guide').exists()).toBe(false);
    expect(wrapper.find('.taste-panel .empty-preferences').exists()).toBe(true);
    await button('理解我的口味').trigger('click');await flushPromises();await wrapper.find('.favorite-prompt-examples button').trigger('click');await flushPromises();
    expect(wrapper.find('.recognition-dialog').attributes('open')).toBeUndefined();expect(wrapper.find('.taste-state').text()).toBe('待识别');expect(fetcher.mock.calls.some(([url])=>url==='/api/v1/recommendations')).toBe(false);
  });
  it('does not report successful recognition on parse failure and supports an explicit retry',async()=>{
    let fail=true;
    const fetcher=vi.fn((url:string)=>url.endsWith('/parse')?fail?response({error:{message:'偏好识别暂时不可用'}},503):response({preferences:preferences()}):initial(url));vi.stubGlobal('fetch',fetcher);
    wrapper=mount(App);await flushPromises();const query=(wrapper.find('#query').element as HTMLTextAreaElement).value;
    await button('理解我的口味').trigger('click');await flushPromises();expect(wrapper.find('.recognition-dialog').attributes('open')).toBeUndefined();
    expect(wrapper.find('.query-column .field-error').text()).toContain('偏好识别暂时不可用');expect(wrapper.find('.taste-state').text()).toBe('待识别');expect(wrapper.findAll('.skeleton')).toHaveLength(0);
    expect((wrapper.find('#query').element as HTMLTextAreaElement).value).toBe(query);fail=false;
    await button('理解我的口味').trigger('click');await flushPromises();expect(wrapper.find('.recognition-dialog').attributes('open')).toBeDefined();expect(wrapper.find('.query-column .field-error').exists()).toBe(false);
  });
  it('shows unresolved conditions in the notice and blocks mouse and keyboard generation until manual adjustment',async()=>{
    const value=preferences();value.unresolved_constraints=['必须已完结'];
    const fetcher=vi.fn((url:string)=>url.endsWith('/parse')?response({preferences:value}):initial(url));vi.stubGlobal('fetch',fetcher);
    wrapper=mount(App);await flushPromises();await button('理解我的口味').trigger('click');await flushPromises();
    expect(wrapper.find('#recognition-title').text()).toBe('有些偏好需要调整');expect(wrapper.find('.recognition-warning').text()).toBe('必须已完结');
    expect(wrapper.find('.recognition-dialog .primary-button').attributes('disabled')).toBeDefined();expect(wrapper.find('#recommend-button').attributes('disabled')).toBeDefined();
    await wrapper.find('#query').trigger('keydown',{key:'Enter',ctrlKey:true});expect(fetcher.mock.calls.some(([url])=>url==='/api/v1/recommendations')).toBe(false);
    await wrapper.find('.recognition-dialog .secondary-button').trigger('click');await wrapper.find('.editor-warning button').trigger('click');await button('确认修改').trigger('click');expect(wrapper.find('#recommend-button').attributes('disabled')).toBeUndefined();
  });
  it('never opens a late success notice over another page and ignores a superseded input response',async()=>{
    const held:((response:Response)=>void)[]=[];
    vi.stubGlobal('fetch',vi.fn((url:string)=>url.endsWith('/parse')?new Promise<Response>(resolve=>held.push(resolve)):initial(url)));
    wrapper=mount(App);await flushPromises();await button('理解我的口味').trigger('click');await button('片库').trigger('click');
    held[0]!(new Response(JSON.stringify({preferences:preferences()})));await flushPromises();expect(wrapper.find('.recognition-dialog').attributes('open')).toBeUndefined();
    await button('发现好剧').trigger('click');await flushPromises();expect(wrapper.find('.confirmation-guide').exists()).toBe(true);
    await button('重新理解原始描述').trigger('click');await wrapper.find('#query').setValue('全新的需求');held[1]!(new Response(JSON.stringify({preferences:preferences()})));await flushPromises();
    expect(wrapper.find('.recognition-dialog').attributes('open')).toBeUndefined();expect(wrapper.find('.taste-state').text()).toBe('待识别');
  });
});
