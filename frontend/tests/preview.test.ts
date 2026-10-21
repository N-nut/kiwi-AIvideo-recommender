import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkPreview from '../src/components/WorkPreview.vue';
import WorkCard from '../src/components/WorkCard.vue';
import type { Work } from '../src/types';
import { workClip } from '../src/presentation';
import { workFixture } from './work-fixture';

type PreviewAPI = { enter: (work: Work, anchor: HTMLElement, immediate?: boolean) => void; leave: () => void; close: () => void };
let wrapper: ReturnType<typeof mount> | undefined;
let anchor: HTMLElement;
let play: ReturnType<typeof vi.spyOn>;
let pause: ReturnType<typeof vi.spyOn>;

function mountPreview() {
  wrapper = mount(WorkPreview, { props: { saved: () => false }, attachTo: document.body });
  return wrapper.vm as unknown as PreviewAPI;
}
const panel = () => document.querySelector<HTMLElement>('#work-preview')!;
const video = () => panel().querySelector('video');

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 120, 300, 240));
  HTMLElement.prototype.showPopover = function () { this.setAttribute('data-open', 'true'); };
  HTMLElement.prototype.hidePopover = function () { this.removeAttribute('data-open'); };
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  anchor = document.createElement('article');
  anchor.innerHTML = '<button class="poster-button">作品</button>';
  document.body.append(anchor);
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined; anchor.remove();
  document.querySelectorAll('dialog').forEach(node => node.remove());
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('shared hover video preview', () => {
  it('waits before opening and cancels a quick pass over the card', async () => {
    const api = mountPreview(); api.enter(workFixture(), anchor);
    await vi.advanceTimersByTimeAsync(150); expect(video()).toBeNull();
    api.leave(); await vi.advanceTimersByTimeAsync(400); expect(video()).toBeNull(); expect(play).not.toHaveBeenCalled();
  });
  it('opens only the latest hovered work with a real bundled video and a simulation label', async () => {
    const api = mountPreview(); api.enter(workFixture(), anchor);
    api.enter(workFixture({ id: 'work-b', title: '都市作品', genres: ['都市'] }), anchor);
    await vi.advanceTimersByTimeAsync(270);
    expect(video()?.getAttribute('src')).toContain('city');
    expect(video()?.muted).toBe(true); expect(play).toHaveBeenCalledTimes(1);
    expect(panel().textContent).toContain('都市作品'); expect(panel().textContent).toContain('非真实作品片段');
  });
  it('allows moving into the floating panel and unloads the video after leaving', async () => {
    const api = mountPreview(); api.enter(workFixture(), anchor); await vi.advanceTimersByTimeAsync(270);
    const playingVideo = video()!; api.leave(); panel().dispatchEvent(new Event('pointerenter'));
    await vi.advanceTimersByTimeAsync(200); expect(video()).toBe(playingVideo);
    panel().dispatchEvent(new Event('pointerleave')); await vi.advanceTimersByTimeAsync(200);
    expect(video()).toBeNull(); expect(pause).toHaveBeenCalled(); expect(playingVideo.hasAttribute('src')).toBe(false);
  });
  it('offers manual play when autoplay is rejected', async () => {
    play.mockRejectedValueOnce(new Error('autoplay blocked'));
    const api = mountPreview(); api.enter(workFixture(), anchor); await vi.advanceTimersByTimeAsync(270);
    const fallback = panel().querySelector<HTMLButtonElement>('.preview-play')!;
    expect(fallback.textContent).toContain('点击播放'); fallback.click(); await vi.advanceTimersByTimeAsync(0);
    expect(play).toHaveBeenCalledTimes(2); expect(panel().querySelector('.preview-play')).toBeNull();
  });
  it('respects reduced motion and never autoplays under that preference', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    const api = mountPreview(); api.enter(workFixture(), anchor); await vi.advanceTimersByTimeAsync(270);
    expect(play).not.toHaveBeenCalled(); expect(panel().textContent).toContain('点击播放');
  });
  it('closes on Escape and on an outside click', async () => {
    const api = mountPreview(); api.enter(workFixture(), anchor); await vi.advanceTimersByTimeAsync(270);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await vi.advanceTimersByTimeAsync(0);
    expect(video()).toBeNull();
    api.enter(workFixture(), anchor); await vi.advanceTimersByTimeAsync(270);
    panel().dispatchEvent(new MouseEvent('click', { bubbles: true })); expect(video()).not.toBeNull();
    document.body.click(); await vi.advanceTimersByTimeAsync(0); expect(video()).toBeNull();
  });
  it('cannot open a delayed preview over an active modal', async () => {
    const api = mountPreview(); api.enter(workFixture(), anchor);
    const modal = document.createElement('dialog'); modal.setAttribute('open', ''); document.body.append(modal);
    await vi.advanceTimersByTimeAsync(270); expect(video()).toBeNull();
  });
  it('does not reopen when closing returns keyboard focus to the poster', async () => {
    const api = mountPreview();
    anchor.querySelector('button')!.addEventListener('focus', () => api.enter(workFixture(), anchor, true));
    api.enter(workFixture(), anchor); await vi.advanceTimersByTimeAsync(270);
    panel().querySelector<HTMLButtonElement>('.preview-close')!.click();
    await vi.advanceTimersByTimeAsync(300); expect(video()).toBeNull();
  });
  it('unloads active media before its component is removed', async () => {
    const api = mountPreview(); api.enter(workFixture(), anchor); await vi.advanceTimersByTimeAsync(270);
    const activeVideo = video()!; const previousPauses = pause.mock.calls.length;
    wrapper!.unmount(); wrapper=undefined;
    expect(pause.mock.calls.length).toBeGreaterThan(previousPauses); expect(activeVideo.hasAttribute('src')).toBe(false);
  });
  it('provides a direct preview button for touch and keyboard access', async () => {
    wrapper = mount(WorkCard, { props: { work: workFixture(), index: 0, saved: false }, attachTo: document.body });
    await wrapper.find('[aria-controls="work-preview"]').trigger('click');
    const emitted = wrapper.emitted('preview')!;
    expect(emitted).toHaveLength(1); expect(emitted[0][2]).toBe(true);
  });
  it('maps all available atmospheres to video assets', () => {
    for (const genre of ['修仙', '都市', '末世', '科幻', '悬疑']) expect(workClip(workFixture({ genres: [genre] }))).toMatch(/\.webm/);
    expect(workClip(workFixture({ genres: [], themes: ['经营'] }))).toContain('shop');
  });
});
