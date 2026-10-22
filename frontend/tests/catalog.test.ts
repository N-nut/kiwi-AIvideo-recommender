import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import App from '../src/App.vue';
import WorkCard from '../src/components/WorkCard.vue';
import { workFixture } from './work-fixture';

const response=(data:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(data),{status}));
const initial={status:'idle',message:'尚未同步'};
const work=workFixture({id:'hongguo-12345678',title:'真实来源作品',cover_url:'https://p3-novel.byteimg.com/test.image',source_meta:{provider:'hongguo',content_type:'真人剧',tags:['爱情'],pages:[],rank:3,heat:'123万热度',episode_count:30}});
let wrapper:ReturnType<typeof mount>;
beforeEach(()=>{localStorage.clear();vi.useFakeTimers();HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};});
afterEach(()=>{wrapper?.unmount();vi.useRealTimers();vi.unstubAllGlobals();});

describe('home catalog refresh',()=>{
  it('loads real works after the shared background job finishes',async()=>{
    let started=false,done=false;
    const fetcher=vi.fn((url:string,options?:RequestInit)=>{
      if(url==='/api/v1/catalog/refresh') {
        if(options?.method==='POST') {started=true;return response({status:'running',message:'正在读取红果…'});}
        return response(!started?initial:done?{status:'succeeded',message:'片库已更新',last_success_at:'2026-10-22T01:00:00Z',result:{total:1}}:{status:'running',message:'正在建立检索索引…'});
      }
      return response(url.startsWith('/health')?{status:'ready',mode:'live'}:{items:done?[work]:[],total:done?1:0});
    });vi.stubGlobal('fetch',fetcher);
    wrapper=mount(App);await flushPromises();
    expect(wrapper.find('.catalog-update-button').text()).toContain('更新漫剧库');
    await wrapper.find('.catalog-update-button').trigger('click');await flushPromises();
    expect(wrapper.find('.catalog-update-button').attributes('disabled')).toBeDefined();
    expect(wrapper.find('.catalog-sync').text()).toContain('正在读取红果');
    await vi.advanceTimersByTimeAsync(1000);await flushPromises();
    expect(wrapper.find('.catalog-sync').text()).toContain('正在建立检索索引');
    done=true;await vi.advanceTimersByTimeAsync(1000);await flushPromises();
    expect(wrapper.find('.drama-card h3').text()).toBe('真实来源作品');
    expect(wrapper.find('.catalog-update-button').attributes('disabled')).toBeUndefined();
    expect(fetcher.mock.calls.filter(([url,opts])=>url.includes('/refresh')&&opts?.method==='POST')).toHaveLength(1);
    wrapper.unmount();const count=fetcher.mock.calls.length;await vi.advanceTimersByTimeAsync(5000);expect(fetcher.mock.calls).toHaveLength(count);
  });

  it('keeps existing cards when an update fails',async()=>{
    let started=false;
    vi.stubGlobal('fetch',vi.fn((url:string,opts?:RequestInit)=>{
      if(url.includes('/catalog/refresh')) {if(opts?.method==='POST')started=true;return response(started?{status:'failed',message:'来源暂时不可用，已保留片库'}:initial);}
      return response(url.startsWith('/health')?{}:{items:[work],total:1});
    }));wrapper=mount(App);await flushPromises();await wrapper.find('.catalog-update-button').trigger('click');await flushPromises();
    expect(wrapper.find('.drama-card h3').text()).toBe(work.title);expect(wrapper.find('.catalog-sync').text()).toContain('已保留片库');
  });

  it('resumes watching a running job after the page reloads',async()=>{
    let polls=0;
    vi.stubGlobal('fetch',vi.fn((url:string)=>response(url.includes('/catalog/refresh')?(polls++,{status:'running',message:'正在同步'}):url.startsWith('/health')?{}:{items:[],total:0})));
    wrapper=mount(App);await flushPromises();expect(wrapper.find('.catalog-update-button').attributes('disabled')).toBeDefined();
    await vi.advanceTimersByTimeAsync(1000);await flushPromises();expect(polls).toBe(2);
  });

  it('loads catalog pages beyond fifty records and hides obsolete seed favorites',async()=>{
    localStorage.setItem('kiwi-real-library-v1',JSON.stringify({nut:['bili-45128',work.id]}));
    const rows=Array.from({length:50},(_,i)=>workFixture({id:`hongguo-${i}`}));
    vi.stubGlobal('fetch',vi.fn((url:string)=>response(url.includes('/catalog/refresh')?initial:url.startsWith('/health')?{}:{items:url.endsWith('page=2')?[work]:rows,total:51})));
    wrapper=mount(App);await flushPromises();
    await wrapper.find('.account-button').trigger('click');await wrapper.find('input[maxlength="20"]').setValue('nut');await wrapper.find('dialog form').trigger('submit');await flushPromises();
    expect(wrapper.findAll('.nav-count').map(n=>n.text())).toEqual(['51','1']);
  });
});

it('uses source covers, preserves classification and falls back after image failure',async()=>{
  wrapper=mount(WorkCard,{props:{work,index:0,saved:false}});
  expect(wrapper.find('.source-cover').attributes('src')).toBe(work.cover_url);expect(wrapper.find('.poster-tag').text()).toBe('真人剧');
  expect(wrapper.find('.source-rank').text()).toContain('#3');await wrapper.find('.source-cover').trigger('error');expect(wrapper.find('.poster-svg').exists()).toBe(true);
});
