import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.vue';
import { workFixture } from './work-fixture';

let wrapper: ReturnType<typeof mount>;
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
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url.startsWith('/health')
    ? { status: 'ready', mode: 'live' }
    : url.includes('/catalog/refresh') ? {status:'idle',message:'尚未同步'}
    : { items: [workFixture({ original_intro: '很长的作品简介。'.repeat(100) })], total: 1 })))));
});
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('long work details', () => {
  it('shows readable content and groups duplicate evidence without exposing internal IDs',async()=>{
    const tagQuote='来源标签：玄幻、穿越';
    vi.stubGlobal('fetch',vi.fn((url:string)=>Promise.resolve(new Response(JSON.stringify(url.startsWith('/health')?{}:url.includes('/catalog/refresh')?{status:'idle'}:{items:[workFixture({original_intro:`完整故事简介。\n\n${tagQuote}`,evidence:[{id:'summary-1',field:'summary',quote:'完整故事简介。'},{id:'genres-1',field:'genres',quote:tagQuote},{id:'themes-1',field:'themes',quote:tagQuote}]})],total:1})))));
    const dialog=await openDetail();
    expect(dialog.find('.detail-intro').text()).toBe('完整故事简介。');
    expect(dialog.text()).not.toMatch(/EVERY STORY|summary-1|genres-1|themes-1/);
    expect(dialog.find('.detail-evidence').attributes('open')).toBeUndefined();
    expect(dialog.findAll('.evidence')).toHaveLength(2);expect(dialog.findAll('.facts span')).toHaveLength(0);
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
