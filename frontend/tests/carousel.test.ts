import { mount } from '@vue/test-utils';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import FeaturedCarousel from '../src/components/FeaturedCarousel.vue';
import { workFixture } from './work-fixture';

const works=()=>Array.from({length:6},(_,i)=>workFixture({id:`featured-${i}`,title:`精选作品${i+1}`,cover_url:`https://p3-novel.byteimg.com/${i}.jpg`,source_meta:{provider:'hongguo',content_type:'漫剧',tags:[],pages:[],rank:null,heat:null,episode_count:30}}));
let wrapper:ReturnType<typeof mount>;
beforeEach(()=>{vi.useFakeTimers();vi.spyOn(document,'hidden','get').mockReturnValue(false);vi.stubGlobal('matchMedia',vi.fn(()=>({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()})));});
afterEach(()=>{wrapper?.unmount();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
describe('six real-cover featured slides',()=>{
  it('has six selectors, wraps arrows, and opens the selected work',async()=>{
    wrapper=mount(FeaturedCarousel,{props:{works:works()}});
    expect(wrapper.findAll('.featured-pages button')).toHaveLength(6);
    await wrapper.find('[aria-label="上一部精选"]').trigger('click');expect(wrapper.find('h1').text()).toBe('精选作品6');
    await wrapper.find('[aria-label="下一部精选"]').trigger('click');expect(wrapper.find('h1').text()).toBe('精选作品1');
    await wrapper.findAll('.featured-pages button')[3]!.trigger('click');await wrapper.find('.featured-poster').trigger('click');
    expect(wrapper.emitted('detail')![0]![0]).toMatchObject({id:'featured-3'});
    expect(wrapper.find('img').attributes('src')).toContain('/3.jpg');
  });
  it('autoplays but pauses during hover, manual pause and an open modal',async()=>{
    wrapper=mount(FeaturedCarousel,{props:{works:works()}});await vi.advanceTimersByTimeAsync(6000);expect(wrapper.find('h1').text()).toBe('精选作品2');
    await wrapper.find('section').trigger('pointerenter');await vi.advanceTimersByTimeAsync(6000);expect(wrapper.find('h1').text()).toBe('精选作品2');
    await wrapper.find('section').trigger('pointerleave');await wrapper.find('[aria-label="暂停轮播"]').trigger('click');await vi.advanceTimersByTimeAsync(6000);expect(wrapper.find('h1').text()).toBe('精选作品2');
    await wrapper.find('[aria-label="开启自动轮播"]').trigger('click');
    const modal=document.createElement('dialog');modal.setAttribute('open','');document.body.append(modal);
    await vi.advanceTimersByTimeAsync(6000);expect(wrapper.find('h1').text()).toBe('精选作品2');modal.remove();
    await vi.advanceTimersByTimeAsync(6000);expect(wrapper.find('h1').text()).toBe('精选作品3');
  });
  it('respects reduced motion, keyboard navigation and async collection changes',async()=>{
    vi.stubGlobal('matchMedia',vi.fn(()=>({matches:true})));
    wrapper=mount(FeaturedCarousel,{props:{works:works()}});await vi.advanceTimersByTimeAsync(12000);expect(wrapper.find('h1').text()).toBe('精选作品1');
    await wrapper.find('section').trigger('keydown',{key:'ArrowLeft'});expect(wrapper.find('h1').text()).toBe('精选作品6');
    await wrapper.setProps({works:works().slice(0,2)});expect(wrapper.find('h1').text()).toBe('精选作品1');
    expect(wrapper.findAll('.featured-pages button')).toHaveLength(2);
  });
  it('does not advance while hidden, focused, or generating a list, and cleans up timers',async()=>{
    let hidden=true;vi.spyOn(document,'hidden','get').mockImplementation(()=>hidden);
    wrapper=mount(FeaturedCarousel,{props:{works:works()}});await vi.advanceTimersByTimeAsync(6000);expect(wrapper.find('h1').text()).toBe('精选作品1');
    hidden=false;document.dispatchEvent(new Event('visibilitychange'));await wrapper.find('section').trigger('focusin');await vi.advanceTimersByTimeAsync(6000);expect(wrapper.find('h1').text()).toBe('精选作品1');
    await wrapper.find('section').trigger('focusout',{relatedTarget:null});await wrapper.setProps({suspended:true});await vi.advanceTimersByTimeAsync(6000);expect(wrapper.find('h1').text()).toBe('精选作品1');
    wrapper.unmount();expect(vi.getTimerCount()).toBe(0);
  });
  it('retains access to details when a cover fails and handles an empty catalog',async()=>{
    wrapper=mount(FeaturedCarousel,{props:{works:works()}});await wrapper.find('img').trigger('error');
    expect(wrapper.find('.featured-cover-fallback').text()).toContain('封面暂不可用');await wrapper.find('.featured-detail').trigger('click');expect(wrapper.emitted('detail')![0]![0]).toMatchObject({id:'featured-0'});
    await wrapper.setProps({works:[]});expect(wrapper.find('.featured-empty').exists()).toBe(true);expect(wrapper.find('.featured-controls').exists()).toBe(false);
  });
});
