import { mount,flushPromises } from '@vue/test-utils';
import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import App from '../src/App.vue';
import { homeFixture, workFixture } from './work-fixture';
const response=(data:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(data),{status}));
let wrapper:ReturnType<typeof mount>;
const button=(text:string)=>wrapper.findAll('button').find(b=>b.text().includes(text))!;
beforeEach(()=>{vi.useFakeTimers();localStorage.clear();HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};});
afterEach(()=>{wrapper?.unmount();vi.useRealTimers();vi.unstubAllGlobals();});
function server(override?:(url:string)=>Promise<Response>|undefined) {
  const fetcher=vi.fn((url:string)=>{
    if(url==='/api/v1/home/recommendations')return response(homeFixture());
    if(url.endsWith('/auth/me'))return response({user:null});
    if(url.startsWith('/health'))return response({works:434});
    if(url.includes('/catalog/refresh'))return response({status:'idle'});
    if(!url.includes('/works?'))throw Error(url);
    const result=override?.(url);if(result)return result;
    const p=new URL(url,'http://local').searchParams,q=p.get('q');
    return response({items:[workFixture({id:`${q||'all'}-${p.get('page')}`,title:q?`${q}的故事`:`第${p.get('page')}页作品`})],total:q?25:434});
  });vi.stubGlobal('fetch',fetcher);return fetcher;
}
async function catalog() {wrapper=mount(App);await flushPromises();await button('片库').trigger('click');await flushPromises();}

describe('sidebar and catalogue search',()=>{
  it('moves update and account controls into the lower sidebar with an avatar placeholder',async()=>{
    server();await catalog();
    expect(wrapper.find('.sidebar-bottom .catalog-update-button').exists()).toBe(true);
    expect(wrapper.find('.sidebar-bottom .account-button').text()).toBe('登录 / 注册');expect(wrapper.find('.account-avatar svg').exists()).toBe(true);
    expect(wrapper.find('.topbar').exists()).toBe(false);expect(wrapper.find('.catalog-heading h1').text()).toBe('片库');
    expect(wrapper.find('[aria-label="主导航"]').text()).not.toContain('真实片库');expect(wrapper.find('input[type=file]').exists()).toBe(false);
  });
  it('jumps to a numbered last page and keeps first/last and neighboring pages available',async()=>{
    const fetcher=server();await catalog();await wrapper.find('[aria-label="第 37 页"]').trigger('click');await flushPromises();
    expect(wrapper.find('.drama-card h3').text()).toBe('第37页作品');expect(wrapper.find('[aria-current=page]').text()).toBe('37');
    expect(wrapper.find('[aria-label="下一页"]').attributes('disabled')).toBeDefined();expect(fetcher.mock.calls.some(([url])=>url.includes('page=37'))).toBe(true);
    await wrapper.find('[aria-label="第 35 页"]').trigger('click');await flushPromises();expect(wrapper.find('[aria-current=page]').text()).toBe('35');
  });
  it('debounces typing, resets to page one and combines the title with both filters',async()=>{
    const fetcher=server();await catalog();await wrapper.find('[aria-label="第 37 页"]').trigger('click');await flushPromises();
    await wrapper.find('#catalog-search').setValue('修');await vi.advanceTimersByTimeAsync(150);await wrapper.find('#catalog-search').setValue(' 修仙 ');
    expect(fetcher.mock.calls.filter(([url])=>url.includes('q='))).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);await flushPromises();expect(wrapper.find('.drama-card h3').text()).toBe('修仙的故事');expect(wrapper.find('[aria-current=page]').text()).toBe('1');
    await wrapper.find('.content-type-filters button:nth-child(2)').trigger('click');await flushPromises();
    await wrapper.findAll('.catalog-filters')[1]!.findAll('button').find(b=>b.text()==='修仙')!.trigger('click');await flushPromises();
    const params=new URL(fetcher.mock.calls.at(-1)![0],'http://local').searchParams;
    expect(Object.fromEntries(params)).toMatchObject({q:'修仙',page:'1',content_type:'漫剧',genre:'修仙'});
    expect(wrapper.findAll('.nav-count')[0]!.text()).toBe('434');expect(wrapper.find('.catalog-count').text()).toContain('共 25 部');
  });
  it('submits immediately with Enter and clears search without waiting for the debounce',async()=>{
    const fetcher=server();await catalog();await wrapper.find('#catalog-search').setValue('系统');await wrapper.find('.catalog-search').trigger('submit');await flushPromises();
    expect(wrapper.find('.drama-card h3').text()).toBe('系统的故事');const count=fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(400);await flushPromises();expect(fetcher.mock.calls.length).toBe(count);
    await wrapper.find('#catalog-search').setValue('系统 ');await wrapper.find('.content-type-filters button').trigger('click');await flushPromises();
    expect(wrapper.find('.drama-card h3').text()).toBe('系统的故事');
    await wrapper.find('[aria-label="清空搜索"]').trigger('click');await flushPromises();expect(wrapper.find('.catalog-count').text()).toContain('434');
    expect(new URL(fetcher.mock.calls.at(-1)![0],'http://local').searchParams.has('q')).toBe(false);
  });
  it('ignores an older response as soon as a different title is entered',async()=>{
    let finish!:(r:Response)=>void;
    server(url=>new URL(url,'http://local').searchParams.get('q')==='旧词'?new Promise<Response>(r=>finish=r):undefined);
    await catalog();await wrapper.find('#catalog-search').setValue('旧词');await vi.advanceTimersByTimeAsync(300);await flushPromises();
    await wrapper.find('#catalog-search').setValue('新词');finish(new Response(JSON.stringify({items:[workFixture({title:'迟到旧结果'})],total:1})));await flushPromises();
    expect(wrapper.text()).not.toContain('迟到旧结果');await vi.advanceTimersByTimeAsync(300);await flushPromises();expect(wrapper.find('.drama-card h3').text()).toBe('新词的故事');
  });
  it('shows a useful empty search state and lets the user clear it',async()=>{
    server(url=>new URL(url,'http://local').searchParams.has('q')?response({items:[],total:0}):undefined);
    await catalog();await wrapper.find('#catalog-search').setValue('不存在');await wrapper.find('.catalog-search').trigger('submit');await flushPromises();
    expect(wrapper.find('.empty-state h3').text()).toBe('没有找到相关剧名');expect(wrapper.find('.catalog-pagination').exists()).toBe(false);
    await button('清空搜索').trigger('click');await flushPromises();expect(wrapper.find('.drama-card').exists()).toBe(true);
  });
  it('keeps title filters on failure, retries, and does not filter the home carousel',async()=>{
    let fail=true;const fetcher=server(url=>new URL(url,'http://local').searchParams.has('q')&&fail?response({error:{message:'搜索暂时不可用'}},503):undefined);
    await catalog();await wrapper.find('#catalog-search').setValue('玄幻');await wrapper.find('.catalog-search').trigger('submit');await flushPromises();expect(wrapper.text()).toContain('搜索暂时不可用');
    fail=false;await wrapper.find('main [role=alert] .text-button').trigger('click');await flushPromises();expect(wrapper.find('.drama-card h3').text()).toBe('玄幻的故事');
    const homeCalls=fetcher.mock.calls.filter(([url])=>url==='/api/v1/home/recommendations').length;
    await button('发现好剧').trigger('click');await flushPromises();expect(fetcher.mock.calls.filter(([url])=>url==='/api/v1/home/recommendations')).toHaveLength(homeCalls);
    expect(wrapper.find('.catalog-search').exists()).toBe(false);expect(wrapper.find('#favorite-prompts-title').text()).toBe('换个口味试试：');
  });
});
