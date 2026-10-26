import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkPreview from '../src/components/WorkPreview.vue';
import WorkCard from '../src/components/WorkCard.vue';
import type { Work } from '../src/types';
import type { PreviewResponse } from '../src/types';
import { workFixture } from './work-fixture';

type PreviewAPI = { enter: (work: Work, anchor: HTMLElement, immediate?: boolean) => void; leave: (anchor?: HTMLElement) => void; close: () => void };
let wrapper: ReturnType<typeof mount> | undefined;
let anchor: HTMLElement;
let play: ReturnType<typeof vi.spyOn>;
let pause: ReturnType<typeof vi.spyOn>;
let fetchPreview: ReturnType<typeof vi.fn>;
function ready(id='work-a'):PreviewResponse {return {request_id:'test',work_id:id,status:'ready',message:'试看片段',preview:{asset_id:'a'.repeat(32),clip_kind:'excerpt',video_url:`/api/v1/media/previews/${id}/video`,poster_url:null,content_type:'video/mp4',duration_ms:15000,width:720,height:1280,source_page_url:'https://example.org/preview',checked_at:'2026-10-25T00:00:00Z'}};}

function mountPreview() {
  wrapper = mount(WorkPreview, { attachTo: document.body });
  return wrapper.vm as unknown as PreviewAPI;
}
const panel = () => document.querySelector<HTMLElement>('#work-preview')!;
const video = () => panel().querySelector('video');

beforeEach(() => {
  vi.useFakeTimers();
  fetchPreview=vi.fn().mockImplementation((url:string)=>Promise.resolve({ok:true,json:async()=>ready(decodeURIComponent(url.split('/').at(-2)!))}));
  vi.stubGlobal('fetch',fetchPreview);
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
  it('loads only the latest hovered work from its metadata and identifies the clip', async () => {
    const api = mountPreview(); api.enter(workFixture(), anchor);
    api.enter(workFixture({ id: 'work-b', title: '都市作品', genres: ['都市'] }), anchor);
    await vi.advanceTimersByTimeAsync(270);
    expect(video()?.getAttribute('src')).toBe('/api/v1/media/previews/work-b/video');
    expect(video()?.muted).toBe(false); expect(play).toHaveBeenCalledTimes(1);
    expect(video()?.getAttribute('aria-label')).toContain('都市作品'); expect(panel().textContent).toContain('试看片段');
    expect(fetchPreview).toHaveBeenCalledTimes(1);
    expect(panel().querySelector('.preview-body,.preview-favorite,.preview-intro,.preview-source,h2')).toBeNull();
    expect(panel().textContent).not.toContain('收藏');expect(panel().textContent).not.toContain('查看完整资料');
    expect(panel().dataset.placement).toBe('right');
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
    expect(video()?.muted).toBe(false);
    expect(fallback.textContent).toContain('点击播放'); fallback.click(); await vi.advanceTimersByTimeAsync(0);
    expect(play).toHaveBeenCalledTimes(2); expect(panel().querySelector('.preview-play')).toBeNull();
    expect(document.activeElement).toBe(panel().querySelector('.preview-playback'));
  });
  it('respects reduced motion and never autoplays under that preference', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    const api = mountPreview(); api.enter(workFixture(), anchor); await vi.advanceTimersByTimeAsync(270);
    expect(play).not.toHaveBeenCalled(); expect(panel().textContent).toContain('点击播放');
  });
  it('toggles sound without changing volume or restarting playback, and preserves it on resume',async()=>{
    const api=mountPreview();api.enter(workFixture(),anchor,true);await vi.advanceTimersByTimeAsync(0);
    const target=video()!,button=panel().querySelector<HTMLButtonElement>('.preview-sound')!;
    expect(target.muted).toBe(false);expect(button.textContent).toContain('静音');
    const calls=play.mock.calls.length;target.volume=.6;button.click();await vi.advanceTimersByTimeAsync(0);
    expect(target.muted).toBe(true);expect(target.volume).toBe(.6);expect(button.getAttribute('aria-label')).toBe('打开预览声音');
    expect(button.getAttribute('aria-pressed')).toBe('false');expect(play).toHaveBeenCalledTimes(calls);
    panel().querySelector<HTMLButtonElement>('.preview-playback')!.click();await vi.advanceTimersByTimeAsync(0);
    expect(target.muted).toBe(true);
    button.click();await vi.advanceTimersByTimeAsync(0);
    expect(target.muted).toBe(false);expect(target.volume).toBe(.6);expect(button.getAttribute('aria-label')).toBe('静音预览');
    expect(panel().querySelector('input[type=range]')).toBeNull();
  });
  it('resets sound on switching or reopening and ignores old volume events',async()=>{
    const api=mountPreview();api.enter(workFixture(),anchor,true);await vi.advanceTimersByTimeAsync(0);
    const old=video()!;panel().querySelector<HTMLButtonElement>('.preview-sound')!.click();await vi.advanceTimersByTimeAsync(0);
    expect(old.muted).toBe(true);
    api.enter(workFixture({id:'other'}),anchor,true);await vi.advanceTimersByTimeAsync(0);
    old.muted=true;old.dispatchEvent(new Event('volumechange'));await vi.advanceTimersByTimeAsync(0);
    expect(video()?.muted).toBe(false);expect(panel().querySelector('.preview-sound')?.textContent).toContain('静音');
    panel().querySelector<HTMLButtonElement>('.preview-sound')!.click();await vi.advanceTimersByTimeAsync(0);
    api.close();api.enter(workFixture(),anchor,true);await vi.advanceTimersByTimeAsync(0);expect(video()?.muted).toBe(false);
  });
  it('shows buffering until actual frame data arrives and ignores detached media events',async()=>{
    const api=mountPreview();api.enter(workFixture(),anchor,true);await vi.advanceTimersByTimeAsync(0);
    const old=video()!;expect(panel().textContent).toContain('正在加载片段');
    old.dispatchEvent(new Event('loadeddata'));await vi.advanceTimersByTimeAsync(0);expect(panel().textContent).not.toContain('正在加载片段');
    old.dispatchEvent(new Event('waiting'));await vi.advanceTimersByTimeAsync(0);expect(panel().textContent).toContain('正在加载片段');
    api.enter(workFixture({id:'other'}),anchor,true);await vi.advanceTimersByTimeAsync(0);
    old.dispatchEvent(new Event('loadeddata'));await vi.advanceTimersByTimeAsync(0);expect(panel().textContent).toContain('正在加载片段');
  });
  it('closes on Escape and on an outside click', async () => {
    const api = mountPreview(); api.enter(workFixture(), anchor); await vi.advanceTimersByTimeAsync(270);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await vi.advanceTimersByTimeAsync(0);
    expect(video()).toBeNull();
    api.leave(anchor);api.enter(workFixture(), anchor); await vi.advanceTimersByTimeAsync(270);
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
  it('stays closed when the close button exposes the hovered card, then allows a new hover', async () => {
    const api=mountPreview();api.enter(workFixture(),anchor);await vi.advanceTimersByTimeAsync(270);
    const previousVideo=video()!;
    panel().querySelector<HTMLButtonElement>('.preview-close')!.click();
    api.enter(workFixture(),anchor);await vi.advanceTimersByTimeAsync(300);
    expect(video()).toBeNull();expect(previousVideo.hasAttribute('src')).toBe(false);
    api.leave(anchor);api.enter(workFixture(),anchor);await vi.advanceTimersByTimeAsync(270);
    expect(video()).not.toBeNull();
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
  it('ignores touch hover while accepting an explicit touch click on the preview button',async()=>{
    wrapper=mount(WorkCard,{props:{work:workFixture(),index:0,saved:false},attachTo:document.body});
    await wrapper.find('article').trigger('pointerenter',{pointerType:'touch'});expect(wrapper.emitted('preview')).toBeUndefined();
    await wrapper.find('[aria-controls=work-preview]').trigger('click',{pointerType:'touch'});expect(wrapper.emitted('preview')?.[0]?.[2]).toBe(true);
  });
  it.each(['missing','pending'])('shows a cover and no simulated fallback for %s',async(status)=>{
    fetchPreview.mockResolvedValueOnce({ok:true,json:async()=>({...ready(),status,preview:null,preparing:status==='pending'})});
    const api=mountPreview();api.enter(workFixture({cover_url:'https://example.org/cover.jpg'}),anchor,true);await vi.advanceTimersByTimeAsync(0);
    expect(video()).toBeNull();expect(panel().textContent).toContain(status==='pending'?'预览准备中':'暂无视频预览');expect(play).not.toHaveBeenCalled();
    expect(panel().querySelector('img')?.src).toBe('https://example.org/cover.jpg');expect(panel().textContent).not.toContain('模拟');
  });
  it('refetches metadata after a service failure and after playback error, never reuses a failed URL',async()=>{
    fetchPreview.mockRejectedValueOnce(new Error('offline'));
    const api=mountPreview();api.enter(workFixture(),anchor,true);await vi.advanceTimersByTimeAsync(0);
    expect(panel().textContent).toContain('视频暂不可用');panel().querySelector<HTMLButtonElement>('.preview-retry')!.click();await vi.advanceTimersByTimeAsync(0);
    const old=video()!;expect(old).not.toBeNull();old.dispatchEvent(new Event('error'));await vi.advanceTimersByTimeAsync(0);
    expect(old.hasAttribute('src')).toBe(false);expect(video()).toBeNull();
    fetchPreview.mockResolvedValueOnce({ok:true,json:async()=>({...ready(),preview:{...ready().preview!,video_url:'/new-version.mp4'}})});
    panel().querySelector<HTMLButtonElement>('.preview-retry')!.click();await vi.advanceTimersByTimeAsync(0);
    expect(video()?.getAttribute('src')).toBe('/new-version.mp4');expect(fetchPreview).toHaveBeenCalledTimes(3);
  });
  it('polls preparing metadata until ready and cancels preparation polling after close',async()=>{
    fetchPreview.mockResolvedValueOnce({ok:true,json:async()=>({...ready(),status:'pending',preview:null,preparing:true})});
    const api=mountPreview();api.enter(workFixture(),anchor,true);await vi.advanceTimersByTimeAsync(0);
    expect(panel().textContent).toContain('预览准备中');expect(video()).toBeNull();
    await vi.advanceTimersByTimeAsync(3000);expect(video()).not.toBeNull();expect(video()?.muted).toBe(false);
    api.close();
    fetchPreview.mockResolvedValueOnce({ok:true,json:async()=>({...ready(),status:'pending',preview:null,preparing:true})});
    api.enter(workFixture(),anchor,true);await vi.advanceTimersByTimeAsync(0);api.close();
    const count=fetchPreview.mock.calls.length;await vi.advanceTimersByTimeAsync(10000);expect(fetchPreview).toHaveBeenCalledTimes(count);
  });
  it('ignores late metadata on switching, retrying and closing, and aborts previous fetches',async()=>{
    const responses:Array<(value:unknown)=>void>=[];
    fetchPreview.mockImplementation(()=>new Promise(resolve=>responses.push(resolve)));
    const api=mountPreview();api.enter(workFixture(),anchor,true);await vi.advanceTimersByTimeAsync(0);
    expect(panel().textContent).toContain('正在加载');expect(video()).toBeNull();
    const signal=fetchPreview.mock.calls[0][1].signal as AbortSignal;
    api.enter(workFixture({id:'new-work'}),anchor,true);await vi.advanceTimersByTimeAsync(0);expect(signal.aborted).toBe(true);
    responses[0]({ok:true,json:async()=>ready()});await vi.advanceTimersByTimeAsync(0);expect(video()).toBeNull();
    api.close();responses[1]({ok:true,json:async()=>ready('new-work')});await vi.advanceTimersByTimeAsync(0);
    expect(video()).toBeNull();expect(play).not.toHaveBeenCalled();
  });
  it('shows reading material for a comic without loading or playing video', async () => {
    const api=mountPreview();api.enter(workFixture({source_meta:{provider:'hongguo',content_type:'漫画',tags:[],pages:[],rank:null,heat:null,episode_count:null,chapter_count:30}}),anchor,true);
    await vi.advanceTimersByTimeAsync(0);
    expect(panel().getAttribute('aria-label')).toContain('阅读资料预览');expect(video()).toBeNull();
    expect(play).not.toHaveBeenCalled();expect(panel().textContent).toContain('30 话');
    expect(fetchPreview).not.toHaveBeenCalled();
    panel().querySelector<HTMLButtonElement>('.preview-close')!.click();await vi.advanceTimersByTimeAsync(0);
    expect(panel().querySelector('.preview-reading')).toBeNull();
  });
  it('expands below the source card on a narrow screen instead of covering its content',async()=>{
    vi.stubGlobal('innerWidth',390);
    vi.spyOn(anchor,'getBoundingClientRect').mockReturnValue(new DOMRect(16,120,358,700));
    const api=mountPreview();api.enter(workFixture(),anchor,true);await vi.advanceTimersByTimeAsync(0);
    expect(panel().dataset.placement).toBe('inline');expect(panel().parentElement).toBe(anchor);
    expect(panel().hasAttribute('popover')).toBe(false);expect(panel().classList.contains('preview-inline')).toBe(true);
    expect(anchor.querySelector('.poster-button')).not.toBeNull();expect(video()).not.toBeNull();
  });
  it('stops and unloads if the source card is removed from the page',async()=>{
    const api=mountPreview();api.enter(workFixture(),anchor,true);await vi.advanceTimersByTimeAsync(0);
    const old=video()!;anchor.remove();await vi.advanceTimersByTimeAsync(0);
    expect(video()).toBeNull();expect(old.hasAttribute('src')).toBe(false);
  });
  it('ignores a previous video rejection and error after switching to another work',async()=>{
    let reject!:(reason:Error)=>void;
    play.mockImplementationOnce(()=>new Promise<void>((_,fail)=>reject=fail));
    const api=mountPreview();api.enter(workFixture(),anchor,true);await vi.advanceTimersByTimeAsync(0);
    const old=video()!;
    api.enter(workFixture({id:'new-work',title:'新作品'}),anchor,true);await vi.advanceTimersByTimeAsync(0);
    reject(new Error('late rejection'));old.dispatchEvent(new Event('error'));await vi.advanceTimersByTimeAsync(0);
    expect(video()?.getAttribute('aria-label')).toContain('新作品');expect(panel().querySelector('.preview-play')).toBeNull();
  });
  it('does not immediately open the neighboring card exposed by closing a side preview',async()=>{
    const neighbor=document.createElement('article');neighbor.className='drama-card';document.body.append(neighbor);
    Object.defineProperty(document,'elementFromPoint',{configurable:true,value:()=>neighbor});
    try {
      const api=mountPreview();api.enter(workFixture(),anchor,true);await vi.advanceTimersByTimeAsync(0);
      panel().querySelector<HTMLButtonElement>('.preview-close')!.click();
      api.enter(workFixture({id:'neighbor'}),neighbor);await vi.advanceTimersByTimeAsync(300);expect(video()).toBeNull();
      api.leave(neighbor);api.enter(workFixture({id:'neighbor'}),neighbor);await vi.advanceTimersByTimeAsync(300);expect(video()).not.toBeNull();
    } finally {neighbor.remove();delete (document as unknown as Record<string,unknown>).elementFromPoint;}
  });
  it('does not dismiss on a focus change while the pointer is still over the media',async()=>{
    const api=mountPreview();api.enter(workFixture(),anchor,true);await vi.advanceTimersByTimeAsync(0);
    const hover=vi.spyOn(panel(),'matches').mockImplementation(selector=>selector===':hover');
    api.leave(anchor);await vi.advanceTimersByTimeAsync(250);expect(video()).not.toBeNull();
    hover.mockReturnValue(false);api.leave(anchor);await vi.advanceTimersByTimeAsync(250);expect(video()).toBeNull();
  });
  it('recognizes an inside click even if its play overlay is removed before document bubbling',async()=>{
    const api=mountPreview();api.enter(workFixture(),anchor,true);await vi.advanceTimersByTimeAsync(0);
    const button=document.createElement('button');panel().append(button);
    button.addEventListener('click',()=>button.remove());button.click();await vi.advanceTimersByTimeAsync(250);
    expect(video()).not.toBeNull();
  });
  it('rechecks the card exposed after an inline preview collapses',async()=>{
    vi.stubGlobal('innerWidth',390);vi.spyOn(anchor,'getBoundingClientRect').mockReturnValue(new DOMRect(16,120,358,700));
    const neighbor=document.createElement('article');neighbor.className='drama-card';document.body.append(neighbor);
    let exposed=anchor;Object.defineProperty(document,'elementFromPoint',{configurable:true,value:()=>exposed});
    try {
      const api=mountPreview();api.enter(workFixture(),anchor,true);await vi.advanceTimersByTimeAsync(0);
      panel().querySelector<HTMLButtonElement>('.preview-close')!.click();exposed=neighbor;await vi.advanceTimersByTimeAsync(0);
      api.enter(workFixture({id:'neighbor'}),neighbor);await vi.advanceTimersByTimeAsync(300);expect(video()).toBeNull();
    } finally {neighbor.remove();delete (document as unknown as Record<string,unknown>).elementFromPoint;}
  });
});
