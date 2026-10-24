import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import App from '../src/App.vue';
import WorkCard from '../src/components/WorkCard.vue';
import { workFixture } from './work-fixture';

const response=(data:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(data),{status}));
const initial={status:'idle',message:'尚未同步'};
const work=workFixture({id:'hongguo-12345678',title:'真实来源作品',cover_url:'https://p3-novel.byteimg.com/test.image',source_meta:{provider:'hongguo',content_type:'真人剧',tags:['爱情'],pages:[],rank:3,heat:'123万热度',episode_count:30}});
let wrapper:ReturnType<typeof mount>;
const button=(text:string)=>wrapper.findAll('button').find(b=>b.text().includes(text))!;
async function startUpdate() {await wrapper.find('.catalog-update-button').trigger('click');await wrapper.find('.collection-dialog form').trigger('submit');await flushPromises();}
beforeEach(()=>{localStorage.clear();vi.useFakeTimers();HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};});
afterEach(()=>{wrapper?.unmount();vi.useRealTimers();vi.unstubAllGlobals();});

describe('home collection settings and progress',()=>{
  it('does not invent pagination statistics for a result from the earlier version',async()=>{
    vi.stubGlobal('fetch',vi.fn((url:string)=>response(url.includes('/catalog/refresh')?{status:'succeeded',message:'已更新',result:{total:41}}:url.startsWith('/health')?{}:{items:[],total:0})));
    wrapper=mount(App);await flushPromises();expect(wrapper.find('.sync-counts').exists()).toBe(false);
  });
  it('submits selected scope once and refreshes the carousel after completion',async()=>{
    let started=false,done=false;
    const fetcher=vi.fn((url:string,options?:RequestInit)=>{
      if(url==='/api/v1/catalog/refresh') {
        if(options?.method==='POST') {started=true;return response({status:'running',message:'正在读取漫剧…',scope:{categories:['comic-drama','ai-drama'],include_hot_rank:false}});}
        return response(!started?initial:done?{status:'succeeded',message:'片库已更新',last_success_at:'2026-10-22T01:00:00Z',result:{total:1,new:1,coverage:'limited',pages_done:5,same_title_groups:1}}:{status:'running',message:'正在建立检索索引…',pages_done:5,raw_count:24,unique_count:24});
      }
      return response(url.startsWith('/health')?{status:'ready',mode:'live'}:{items:done?[work]:[],total:done?1:0});
    });vi.stubGlobal('fetch',fetcher);wrapper=mount(App);await flushPromises();
    await wrapper.find('.catalog-update-button').trigger('click');await flushPromises();
    expect(fetcher.mock.calls.some(([,opts])=>opts?.method==='POST')).toBe(false);
    expect(wrapper.find('.collection-dialog').attributes('open')).toBeDefined();
    await wrapper.find('.collection-dialog form').trigger('submit');await flushPromises();
    const calls=fetcher.mock.calls.filter(([,opts])=>opts?.method==='POST');expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]![1]!.body as string)).toEqual({categories:['comic-drama','ai-drama'],include_hot_rank:false});
    expect(wrapper.find('.catalog-update-button').attributes('disabled')).toBeDefined();
    await vi.advanceTimersByTimeAsync(2000);await flushPromises();expect(wrapper.find('.catalog-sync').text()).toContain('已读取 5 页');
    done=true;await vi.advanceTimersByTimeAsync(2000);await flushPromises();
    expect(wrapper.find('.featured-copy h1').text()).toBe(work.title);expect(wrapper.find('.sync-summary').exists()).toBe(false);
    expect(wrapper.findAll('.drama-card')).toHaveLength(0);expect(wrapper.find('.generation-guide').exists()).toBe(true);
    await button('更新详情').trigger('click');expect(wrapper.find('.catalog-sync').text()).toContain('限定范围');expect(wrapper.find('.catalog-sync').text()).toContain('1 组同名资料待核对');
    expect(wrapper.find('.catalog-update-button').attributes('disabled')).toBeUndefined();
    wrapper.unmount();const count=fetcher.mock.calls.length;await vi.advanceTimersByTimeAsync(6000);expect(fetcher.mock.calls).toHaveLength(count);
  });

  it('requires a category or ranking and supports the ranking-only option',async()=>{
    vi.stubGlobal('fetch',vi.fn((url:string)=>response(url.includes('/catalog/refresh')?initial:url.startsWith('/health')?{}:{items:[],total:0})));
    wrapper=mount(App);await flushPromises();await wrapper.find('.catalog-update-button').trigger('click');
    const checks=wrapper.findAll('.collection-options input');for(const check of checks) await check.setValue(false);
    expect(wrapper.find('.collection-dialog button[type="submit"]').attributes('disabled')).toBeDefined();
    await wrapper.find('.rank-option input').setValue(true);expect(wrapper.find('.collection-dialog button[type="submit"]').attributes('disabled')).toBeUndefined();
  });

  it('keeps the existing carousel and reports failures without claiming new data',async()=>{
    let started=false;
    vi.stubGlobal('fetch',vi.fn((url:string,opts?:RequestInit)=>{
      if(url.includes('/catalog/refresh')) {if(opts?.method==='POST')started=true;return response(started?{status:'failed',message:'来源暂时不可用，已保留片库'}:initial);}
      return response(url.startsWith('/health')?{}:{items:[work],total:1});
    }));wrapper=mount(App);await flushPromises();await startUpdate();
    expect(wrapper.find('.featured-copy h1').text()).toBe(work.title);expect(wrapper.find('.catalog-sync').text()).toContain('已保留片库');
  });

  it('resumes polling a running task with its actual source scope',async()=>{
    let polls=0;
    vi.stubGlobal('fetch',vi.fn((url:string)=>response(url.includes('/catalog/refresh')?(polls++,{status:'running',message:'正在同步',scope:{categories:['comic'],include_hot_rank:true}}):url.startsWith('/health')?{}:{items:[],total:0})));
    wrapper=mount(App);await flushPromises();expect(wrapper.find('.catalog-sync').text()).toContain('漫画、热播榜');
    await vi.advanceTimersByTimeAsync(2000);await flushPromises();expect(polls).toBe(2);
  });

  it('retries status retrieval after a connection error without starting another job',async()=>{
    let reads=0,started=false;
    const fetcher=vi.fn((url:string,opts?:RequestInit)=>{
      if(url.includes('/catalog/refresh')) {
        if(opts?.method==='POST') {started=true;return response({status:'running',message:'读取中'});}
        if(!started) return response(initial);
        if(++reads===1) return Promise.reject(new Error('network'));
        return response({status:'running',message:'已恢复进度查询'});
      }
      return response(url.startsWith('/health')?{}:{items:[],total:0});
    });vi.stubGlobal('fetch',fetcher);wrapper=mount(App);await flushPromises();await startUpdate();
    await vi.advanceTimersByTimeAsync(2000);await flushPromises();expect(wrapper.text()).toContain('无法获取更新进度');
    await wrapper.find('.catalog-update-button').trigger('click');await flushPromises();
    expect(wrapper.find('.catalog-sync').text()).toContain('已恢复进度查询');expect(fetcher.mock.calls.filter(([,opts])=>opts?.method==='POST')).toHaveLength(1);
  });
});

describe('server paging, category filters',()=>{
  it('fetches only the current page and sends content type separately from genre',async()=>{
    const fetcher=vi.fn((url:string)=>{
      if(url.includes('/catalog/refresh')) return response(initial);
      if(url.startsWith('/health')) return response({works:51});
      const params=new URL(url,'http://localhost').searchParams;
      return response({items:[workFixture({id:`page-${params.get('page')}`,title:`第${params.get('page')}页作品`})],total:51});
    });vi.stubGlobal('fetch',fetcher);wrapper=mount(App);await flushPromises();
    expect(fetcher.mock.calls.filter(([url])=>url.includes('/works?'))).toHaveLength(1);
    expect(new URL(fetcher.mock.calls.find(([url])=>url.includes('/works?'))![0],'http://localhost').searchParams.get('page_size')).toBe('6');
    await button('片库').trigger('click');await flushPromises();await button('下一页').trigger('click');await flushPromises();
    expect(wrapper.find('.drama-card h3').text()).toBe('第2页作品');
    await wrapper.find('.content-type-filters').findAll('button').find(b=>b.text()==='漫画')!.trigger('click');await flushPromises();
    const types=fetcher.mock.calls.filter(([url])=>url.includes('content_type'));expect(types.length).toBeGreaterThan(0);
    const params=new URL(types.at(-1)![0],'http://localhost').searchParams;expect(params.get('content_type')).toBe('漫画');expect(params.get('page')).toBe('1');
    expect(wrapper.findAll('.nav-count')[0]!.text()).toBe('51');
    expect(wrapper.find('.content-type-filters').text()).not.toContain('未标注');
  });

  it('discards a late page response after the category changes',async()=>{
    let resolve!:(value:Response)=>void;
    vi.stubGlobal('fetch',vi.fn((url:string)=>{
      if(url.includes('/catalog/refresh'))return response(initial);if(url.startsWith('/health'))return response({works:50});
      const p=new URL(url,'http://localhost').searchParams;
      if(p.get('page')==='2')return new Promise<Response>(done=>resolve=done);
      return response({items:[workFixture({title:p.get('content_type')==='漫画'?'漫画结果':'首页结果'})],total:50});
    }));wrapper=mount(App);await flushPromises();await button('片库').trigger('click');await flushPromises();await button('下一页').trigger('click');
    await wrapper.find('.content-type-filters').findAll('button').find(b=>b.text()==='漫画')!.trigger('click');await flushPromises();
    resolve(new Response(JSON.stringify({items:[workFixture({title:'迟到结果'})],total:50})));await flushPromises();
    expect(wrapper.find('.drama-card h3').text()).toBe('漫画结果');
  });


});

it('uses real covers and classification, then falls back after image failure',async()=>{
  wrapper=mount(WorkCard,{props:{work,index:0,saved:false}});
  expect(wrapper.find('.source-cover').attributes('src')).toBe(work.cover_url);expect(wrapper.find('.poster-tag').text()).toBe('真人剧');
  expect(wrapper.find('.source-rank').text()).toContain('#3');await wrapper.find('.source-cover').trigger('error');expect(wrapper.find('.poster-svg').exists()).toBe(true);
});
