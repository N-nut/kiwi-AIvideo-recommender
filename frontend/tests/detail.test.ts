import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.vue';
import { homeFixture, workFixture } from './work-fixture';
import type { Work } from '../src/types';

let wrapper: ReturnType<typeof mount>;
function showWork(work:Work) {
  vi.stubGlobal('fetch',vi.fn((url:string)=>Promise.resolve(new Response(JSON.stringify(
    url.startsWith('/health')?{status:'ready'}:url.endsWith('/auth/me')?{user:null}:url.includes('/catalog/refresh')?{status:'idle'}:
    url==='/api/v1/home/recommendations'?homeFixture():url.endsWith('/preview')?{work_id:work.id,status:'missing',preview:null}:
    {items:[work],total:1})))));
}
async function openDetail() {
  wrapper = mount(App, { attachTo: document.body });
  await flushPromises(); await wrapper.findAll('button').find(b=>b.text().includes('片库'))!.trigger('click'); await flushPromises();
  await wrapper.find('.poster-button').trigger('click'); await flushPromises();
  return wrapper.find('dialog.work-dialog');
}
beforeEach(() => {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 600, 500));
  HTMLElement.prototype.scrollIntoView=vi.fn();
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url.startsWith('/health')
    ? { status: 'ready', mode: 'live' }
    : url.includes('/catalog/refresh') ? {status:'idle',message:'尚未同步'}
    : url==='/api/v1/home/recommendations' ? homeFixture()
    : { items: [workFixture({ original_intro: '很长的作品简介。'.repeat(100) })], total: 1 })))));
});
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('long work details', () => {
  it('hides the entire evidence section when only the introduction and displayed tags are repeated',async()=>{
    const tagQuote='来源标签：玄幻、穿越';
    showWork(workFixture({genres:['玄幻'],themes:['穿越'],original_intro:`完整故事简介。\n\n${tagQuote}`,evidence:[{id:'summary-1',field:'summary',quote:'完整故事简介。'},{id:'genres-1',field:'genres',quote:tagQuote},{id:'themes-1',field:'themes',quote:tagQuote}]}));
    const dialog=await openDetail();
    expect(dialog.find('.detail-intro').text()).toBe('完整故事简介。');
    expect(dialog.text()).not.toMatch(/EVERY STORY|summary-1|genres-1|themes-1/);
    expect(dialog.find('.detail-evidence').exists()).toBe(false);expect(dialog.find('.detail-reason').exists()).toBe(false);
    expect(dialog.findAll('.evidence')).toHaveLength(0);expect(dialog.findAll('.facts span')).toHaveLength(0);
    expect(dialog.findAll('.detail-tags span').map(tag=>tag.text())).toEqual(['玄幻','穿越']);
    expect(dialog.find('.work-dialog-actions a').attributes('href')).toBe('https://example.org/work-a');
  });
  it('groups explanations of known judgments and excludes unrelated or unknown fields',async()=>{
    const quote='故事明确无后宫，也没有感情线。';
    showWork(workFixture({harem:false,romance:false,original_intro:`少年在山门中修炼。${quote}随后开始冒险。`,evidence:[
      {id:'harem-1',field:'harem',quote},{id:'romance-1',field:'romance',quote},
      {id:'pace-1',field:'pace',quote},{id:'summary-1',field:'summary',quote}]}));
    const dialog=await openDetail();
    expect(dialog.findAll('.evidence')).toHaveLength(1);expect(dialog.find('.evidence blockquote').text()).toBe(quote);
    expect(dialog.find('.evidence small').text()).toBe('后宫：明确无 · 感情线：明确无');
    expect(dialog.find('.detail-evidence').attributes('open')).toBeUndefined();
    expect(dialog.text()).not.toMatch(/harem-1|romance-1|节奏：/);
  });
  it('does not show unsupported judgments or unreferenced snippets',async()=>{
    const quote='少年在山门中修炼。';
    showWork(workFixture({original_intro:quote,evidence:[{id:'harem-1',field:'harem',quote},{id:'other',field:'summary',quote}]}));
    const dialog=await openDetail();expect(dialog.find('.detail-evidence').exists()).toBe(false);
  });
  it('links to already displayed introduction and tags for an actual recommendation instead of quoting them again',async()=>{
    const intro='少年在修仙途中逆袭成长。',tags='来源标签：修仙、成长';
    showWork(workFixture({original_intro:`${intro}\n\n${tags}`,summary:intro,reason:'修仙与成长的主线符合本次观剧偏好。',reason_mode:'model',evidence_ids:['summary-1','tags-1','unknown'],evidence:[
      {id:'summary-1',field:'summary',quote:intro},{id:'tags-1',field:'themes',quote:tags}]}));
    const dialog=await openDetail();
    expect(dialog.find('.detail-reason p').text()).toBe('修仙与成长的主线符合本次观剧偏好。');
    expect(dialog.findAll('.evidence-reference').map(link=>link.text())).toEqual(['查看上方故事简介 ↑','查看上方题材标签 ↑']);
    expect(dialog.findAll('.evidence')).toHaveLength(1);
    expect(dialog.findAll('.evidence blockquote')).toHaveLength(0);
    await dialog.find('.evidence-reference').trigger('click');
    expect(document.activeElement).toBe(dialog.find('.detail-intro').element);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({block:'start'});
  });
  it('keeps only the linked excerpt needed to explain a recommendation',async()=>{
    const quote='主角在险境中不断成长。';
    showWork(workFixture({original_intro:`少年离开山门。${quote}最终击败对手。`,reason:'主角逐步成长，符合成长主题的偏好。',reason_mode:'model',evidence_ids:['reason-1'],evidence:[
      {id:'reason-1',field:'summary',quote},{id:'unused',field:'summary',quote:'少年离开山门。'}]}));
    const dialog=await openDetail();
    expect(dialog.findAll('.evidence')).toHaveLength(1);expect(dialog.find('.evidence small').text()).toBe('推荐理由');
    expect(dialog.find('.evidence blockquote').text()).toBe(quote);
  });
  it('removes the copied introduction from template reasons',async()=>{
    const intro='少年在修仙途中逆袭成长。';
    showWork(workFixture({original_intro:intro,summary:intro,reason:`资料中的修仙与你的偏好相符。简介摘录：${intro}`,reason_mode:'template',evidence_ids:['summary-1'],evidence:[{id:'summary-1',field:'summary',quote:intro}]}));
    const dialog=await openDetail();
    expect(dialog.find('.detail-reason p').text()).toBe('资料中的修仙与你的偏好相符。');
    expect(dialog.text()).not.toContain('简介摘录：');expect(dialog.find('.evidence blockquote').exists()).toBe(false);
  });
  it('hides a reason that merely copies the displayed introduction',async()=>{
    const intro='少年在修仙途中逆袭成长。';
    showWork(workFixture({original_intro:intro,reason:intro,reason_mode:'model',evidence_ids:['summary-1'],evidence:[{id:'summary-1',field:'summary',quote:intro}]}));
    const dialog=await openDetail();expect(dialog.find('.detail-reason').exists()).toBe(false);expect(dialog.find('.detail-evidence').exists()).toBe(false);
  });
  it('collapses additional explanations again when reopening details',async()=>{
    const intro='本作明确无后宫，侧重修行成长。';
    showWork(workFixture({original_intro:intro,harem:false,evidence:[{id:'harem-1',field:'harem',quote:intro}]}));
    const dialog=await openDetail();(dialog.find('.detail-evidence').element as HTMLDetailsElement).open=true;
    await dialog.find('[aria-label="关闭作品详情"]').trigger('click');await wrapper.find('.poster-button').trigger('click');await flushPromises();
    expect((dialog.find('.detail-evidence').element as HTMLDetailsElement).open).toBe(false);
  });
  it('closes when the blank backdrop is clicked after scrolling', async () => {
    const dialog = await openDetail(); expect(dialog.attributes()).toHaveProperty('open');
    (dialog.find('.work-dialog-scroll').element as HTMLElement).scrollTop = 600;
    await dialog.trigger('pointerdown', { clientX: 20, clientY: 20 });
    await dialog.trigger('click', { clientX: 20, clientY: 20 });
    expect(dialog.attributes()).not.toHaveProperty('open');
  });
  it('keeps close and action buttons outside the scrolling content', async () => {
    const dialog = await openDetail(); const body = dialog.find('.work-dialog-scroll');
    expect(body.find('[aria-label="关闭作品详情"]').exists()).toBe(false);
    expect(body.find('.work-dialog-actions').exists()).toBe(false);
    (body.element as HTMLElement).scrollTop = 600;
    await dialog.find('[aria-label="关闭作品详情"]').trigger('click');
    expect(dialog.attributes()).not.toHaveProperty('open');
  });
  it('does not dismiss when selecting text inside or dragging from inside to outside', async () => {
    const dialog = await openDetail();
    await dialog.find('.detail-intro').trigger('pointerdown', { clientX: 150, clientY: 150 });
    await dialog.trigger('click', { clientX: 20, clientY: 20 });
    expect(dialog.attributes()).toHaveProperty('open');
    await dialog.trigger('pointerdown', { clientX: 150, clientY: 150 });
    await dialog.trigger('click', { clientX: 150, clientY: 150 });
    expect(dialog.attributes()).toHaveProperty('open');
  });
  it('resets the scroll position when details are opened again', async () => {
    const dialog = await openDetail(); const body = dialog.find('.work-dialog-scroll').element as HTMLElement;
    body.scrollTop = 600; await dialog.find('[aria-label="关闭作品详情"]').trigger('click');
    await wrapper.find('.poster-button').trigger('click'); await flushPromises(); expect(body.scrollTop).toBe(0);
  });
});
