import { effectScope, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../src/useAuth';
import { useLibrary } from '../src/library';
import { useFeedback } from '../src/useFeedback';
import { batchPayload, capacityMessage, useRecommendationBatches } from '../src/useRecommendationBatches';
import { useHomeRecommendations } from '../src/useHomeRecommendations';
import { emptyPreferences, type Feedback } from '../src/types';
import FeedbackMenu from '../src/components/FeedbackMenu.vue';
import App from '../src/App.vue';
import { homeFixture, workFixture } from './work-fixture';

const json=(data:unknown,status=200,headers?:HeadersInit)=>Promise.resolve(new Response(status===204?null:JSON.stringify(data),{status,headers}));
const preferences=()=>({...emptyPreferences(),soft_preferences:{genres:['修仙'],themes:[],pace:null}});
const record=(id='work-a',revision='a'.repeat(32)):Feedback=>({work_id:id,status:'watched',revision,updated_at:'2026-10-27T10:00:00Z'});
const stops:(()=>void)[]=[];
beforeEach(()=>{localStorage.clear();HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};});
afterEach(()=>{stops.splice(0).forEach(stop=>stop());vi.unstubAllGlobals();});
function setup(guest=false){
  let user=guest?null:{id:'u',username:'User_A',nickname:null,avatar_id:'kiwi-default'};
  let stored:Feedback|null=null,complete=true,failSnapshot=false,failHome=false,failWrite=0,network=false,hold=false,next=0;
  const held:((response:Response)=>void)[]=[];
  const fetcher=vi.fn((url:string,options?:RequestInit):Promise<Response>=>{
    if(url.endsWith('/auth/me'))return json({user});
    if(url.endsWith('/auth/login')){user={id:'other',username:'User_B',nickname:null,avatar_id:'kiwi-default'};return json({user});}
    if(url.endsWith('/auth/logout')){user=null;return json(null,204);}
    if(url.endsWith('/feedback/state'))return failSnapshot?json({error:{message:'状态失败'}},503):json({items:stored?[stored]:[],complete});
    if(url.startsWith('/api/v1/me/feedback/')){
      if(options?.method==='PATCH'){
        if(network){stored=record();return Promise.reject(Error('network lost'));}
        if(failWrite)return json({error:{message:'状态冲突'}},failWrite,failWrite===429?{'Retry-After':'5'}:undefined);
        stored={...record(),status:JSON.parse(options.body as string).status};return json({feedback:stored});
      }
      if(options?.method==='DELETE'){
        if(failWrite)return json({error:{message:'撤销冲突'}},failWrite);
        stored=null;return json(null,204);
      }
      return json({feedback:stored});
    }
    if(url.endsWith('/me/home-recommendations'))return failHome?json({error:{message:'私人推荐失败'}},503):json(homeFixture([workFixture()]));
    if(url==='/api/v1/home/recommendations')return json(homeFixture([workFixture(),workFixture({id:'work-b'})]));
    if(url.endsWith('/recommendations')){
      if(hold)return new Promise(resolve=>held.push(resolve));
      const id=next++?'work-b':'work-a';return json({status:'success',items:[workFixture({id})],warnings:[],timings_ms:{},batch:{state:'ready',has_more:null}});
    }
    if(url.endsWith('/preferences/parse'))return json({preferences:preferences()});
    if(url==='/api/v1/works/work-a')return json(workFixture());
    if(url.includes('/favorites/ids'))return json({items:[],relation_total:0});
    if(url.includes('/favorites'))return json({items:[],total:0,unavailable_count:0});
    if(url.startsWith('/health'))return json({mode:'baseline',works:10});
    if(url.includes('/catalog/refresh'))return json({status:'idle'});
    return json({items:[],total:0});
  });vi.stubGlobal('fetch',fetcher);
  const scope=effectScope();stops.push(()=>scope.stop());
  const state=scope.run(()=>{const auth=useAuth(),feedback=useFeedback(auth),library=useLibrary(auth),view=ref('discover');return {auth,feedback,library,view,batches:useRecommendationBatches(auth,feedback),home:useHomeRecommendations(auth,library,view,feedback)};})!;
  return {...state,fetcher,held,hold:(v=true)=>hold=v,stored:(v:Feedback|null)=>stored=v,complete:(v=false)=>complete=v,
    failSnapshot:(v=true)=>failSnapshot=v,failHome:(v=true)=>failHome=v,failWrite:(v=409)=>failWrite=v,network:(v=true)=>network=v};
}

describe('feedback state and writes',()=>{
  it('uses explicit status/revision, preserves confirmed state on conflict, and sends quoted If-Match',async()=>{
    const s=setup();await s.auth.restore();await flushPromises();expect(await s.feedback.save('work-a','watched')).toBe(true);
    const call=s.fetcher.mock.calls.find(([,options])=>options?.method==='PATCH')!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({status:'watched',expected_revision:null});
    s.stored({...record(),status:'not_interested',revision:'b'.repeat(32)});s.failWrite(412);
    expect(await s.feedback.remove('work-a','a'.repeat(32))).toBe(false);expect(s.feedback.records.value.get('work-a')?.revision).toBe('b'.repeat(32));
    expect(s.feedback.error.value).toContain('重新读取');s.failWrite(0);expect(await s.feedback.remove('work-a','b'.repeat(32))).toBe(true);
    const deletion=s.fetcher.mock.calls.filter(([,options])=>options?.method==='DELETE').at(-1)!;
    expect(deletion[1]?.headers).toMatchObject({'If-Match':'"'+'b'.repeat(32)+'"','X-Kiwi-Request':'1'});expect(deletion[1]?.body).toBeUndefined();
  });
  it('checks a specific work when state is truncated and does not guess a null version',async()=>{
    const s=setup();s.complete(false);await s.auth.restore();await flushPromises();s.stored(record());
    await s.feedback.save('work-a','not_interested');const call=s.fetcher.mock.calls.find(([,options])=>options?.method==='PATCH')!;
    expect(JSON.parse(call[1]!.body as string).expected_revision).toBe('a'.repeat(32));expect(s.feedback.reliable.value).toBe(false);
  });
  it('does not assume a network failure rolled back; explicit reconciliation reads the committed target',async()=>{
    const s=setup();await s.auth.restore();await flushPromises();s.network();
    expect(await s.feedback.save('work-a','watched')).toBe(false);expect(s.feedback.records.value.has('work-a')).toBe(false);expect(s.feedback.unknown.value.has('work-a')).toBe(true);
    expect(s.feedback.error.value).toContain('暂未确认');expect(await s.feedback.save('work-a','watched')).toBe(false);
    await s.feedback.reconcile('work-a');expect(s.feedback.records.value.get('work-a')?.status).toBe('watched');expect(s.feedback.unknown.value.size).toBe(0);
  });
  it('honors Retry-After without replaying writes',async()=>{
    const s=setup();await s.auth.restore();await flushPromises();s.failWrite(429);await s.feedback.save('work-a','watched');
    const calls=s.fetcher.mock.calls.filter(([,options])=>options?.method==='PATCH').length;
    await s.feedback.save('work-a','watched');expect(s.fetcher.mock.calls.filter(([,options])=>options?.method==='PATCH')).toHaveLength(calls);expect(s.feedback.retryAt.value).toBeGreaterThan(Date.now());
  });
  it.each([200,401])('an old feedback response (%s) cannot write state or expire a newly logged-in account',async(status)=>{
    const s=setup();await s.auth.restore();await flushPromises();const original=s.fetcher.getMockImplementation()!;
    let finish!:(response:Response)=>void;
    s.fetcher.mockImplementation((url:string,options?:RequestInit)=>options?.method==='PATCH'?new Promise(resolve=>finish=resolve):original(url,options));
    const saved=s.feedback.save('work-a','watched');await flushPromises();await s.auth.logout();
    await s.auth.submit('login',{username:'User_B',password:'test password'});await flushPromises();
    finish(new Response(JSON.stringify(status===200?{feedback:record()}:{error:{message:'旧会话失效'}}),{status}));await saved;
    expect(s.auth.state.value).toBe('authenticated');expect(s.auth.user.value?.username).toBe('User_B');expect(s.feedback.records.value.size).toBe(0);expect(s.feedback.error.value).toBe('');
  });
  it('only permits filtered public fallback with a reliable complete same-account snapshot',async()=>{
    const s=setup();s.stored(record());await s.auth.restore();await flushPromises();s.failHome();await s.home.load();
    expect(s.home.works.value.map(w=>w.id)).toEqual(['work-b']);expect(s.home.notice.value).toContain('上次确认的反馈');
    s.complete(false);await s.feedback.load();await s.home.load();expect(s.home.works.value).toEqual([]);expect(s.home.error.value).toContain('反馈状态尚未确认');
    s.failSnapshot();await s.feedback.load();await s.home.load();expect(s.home.works.value).toEqual([]);
    await s.auth.logout();expect(s.feedback.records.value.size).toBe(0);
  });
});

describe('confirmed recommendation batches',()=>{
  it('reuses a frozen preference snapshot and only adds successful shown IDs',async()=>{
    const s=setup(true);await s.auth.restore();await flushPromises();const prefs=preferences();await s.batches.generate(prefs);
    prefs.soft_preferences.genres=['都市'];s.hold();void s.batches.next();await flushPromises();
    expect(s.batches.result.value?.items[0]?.id).toBe('work-a');expect(s.batches.busy.value).toBe(true);void s.batches.next();expect(s.held).toHaveLength(1);
    const payload=JSON.parse(s.fetcher.mock.calls.filter(([url])=>url.endsWith('/recommendations')).at(-1)![1]!.body as string);
    expect(payload.exclude_work_ids).toEqual(['work-a']);expect(payload.preferences.soft_preferences.genres).toEqual(['修仙']);
    s.held[0]!(new Response(JSON.stringify({error:{message:'检索失败'}}),{status:503}));await flushPromises();expect([...s.batches.shownIds.value]).toEqual(['work-a']);expect(s.batches.result.value?.items[0]?.id).toBe('work-a');
  });
  it('keeps the previous result on real exhaustion and requires explicit restart',async()=>{
    const s=setup(true);await s.auth.restore();await flushPromises();await s.batches.generate(preferences());s.hold();void s.batches.next();await flushPromises();
    s.held[0]!(new Response(JSON.stringify({status:'empty',items:[],warnings:[],timings_ms:{},batch:{state:'exhausted',has_more:false}})));await flushPromises();
    expect(s.batches.result.value?.items[0]?.id).toBe('work-a');expect(s.batches.notice.value).toContain('上次结果');expect(s.batches.canNext.value).toBe(false);
    s.hold(false);s.batches.restart();await flushPromises();const body=JSON.parse(s.fetcher.mock.calls.filter(([url])=>url.endsWith('/recommendations')).at(-1)![1]!.body as string);expect(body.exclude_work_ids).toEqual([]);
  });
  it('rejects late batches on input reset, feedback writes and account switch; preserves displayed work on logout',async()=>{
    const s=setup();await s.auth.restore();await flushPromises();await s.batches.generate(preferences());s.hold();void s.batches.next();await flushPromises();
    await s.feedback.save('elsewhere','watched');expect(s.batches.busy.value).toBe(false);
    s.held[0]!(new Response(JSON.stringify({status:'success',items:[workFixture({id:'late'})],warnings:[],timings_ms:{}})));await flushPromises();expect(s.batches.result.value?.items[0]?.id).toBe('work-a');
    await s.auth.logout();expect(s.batches.shownIds.value.size).toBe(0);expect(s.batches.result.value?.items).toHaveLength(1);expect(s.batches.stale.value).toBe(true);expect(s.batches.canNext.value).toBe(false);
  });
  it('enforces 200 entries and actual UTF-8 body bytes without truncating IDs',()=>{
    expect(()=>batchPayload(preferences(),new Set(Array.from({length:198},(_,i)=>String(i))))).toThrow(capacityMessage);
    const ids=new Set(Array.from({length:190},(_,i)=>'剧'.repeat(75)+i));expect(()=>batchPayload(preferences(),ids)).toThrow(capacityMessage);expect(ids.size).toBe(190);
    expect(batchPayload(preferences(),new Set(Array.from({length:197},(_,i)=>String(i)))).exclude_work_ids).toHaveLength(197);
  });
  it('continues after catalogue update without clearing shown IDs or automatically requesting',async()=>{
    const s=setup(true);await s.auth.restore();await flushPromises();await s.batches.generate(preferences());const count=s.fetcher.mock.calls.length;
    s.batches.exhausted.value=true;s.batches.stale.value=true;
    s.batches.catalogChanged();expect([...s.batches.shownIds.value]).toEqual(['work-a']);expect(s.fetcher.mock.calls).toHaveLength(count);expect(s.batches.canNext.value).toBe(true);
  });
});

it('feedback icons are independent, labelled buttons and emit explicit targets',async()=>{
  const w=mount(FeedbackMenu,{props:{title:'测试'}});stops.push(()=>w.unmount());expect(w.findAll('svg')).toHaveLength(2);
  expect(w.find('[role="group"]').attributes('aria-label')).toContain('测试');expect(w.findAll('button')[1]!.attributes('aria-label')).toBe('已看过');
  await w.findAll('button')[1]!.trigger('click');expect(w.emitted('select')).toEqual([['watched']]);await w.setProps({busy:true});expect(w.find('button').attributes('disabled')).toBeDefined();
});

it('undo preserves the original home recommendation explanation when a work also appears in the active batch',async()=>{
  const s=setup(),original=s.fetcher.getMockImplementation()!;
  const work=workFixture({cover_url:'https://example.org/a.jpg',source_meta:{provider:'hongguo',content_type:'漫剧',tags:[],pages:[],rank:null,heat:null,episode_count:null}});
  const home=homeFixture([work]);home.items[0]!.basis='favorites';home.items[0]!.reason='根据你收藏的修仙风格推荐';home.carousel_mode='personalized';
  s.fetcher.mockImplementation((url:string,options?:RequestInit)=>url.endsWith('/me/home-recommendations')?json(home)
    :url==='/api/v1/me/recommendations'?json({status:'success',items:[{...work,reason:'本次主动片单的理由'}],warnings:[],timings_ms:{}})
    :url==='/api/v1/works/work-a'?json(work):original(url,options));
  const w=mount(App);stops.push(()=>w.unmount());await flushPromises();
  expect(w.find('.featured-label').text()).toBe('根据收藏推荐');
  await w.find('#recommend-button').trigger('click');await flushPromises();await w.find('.recognition-dialog .primary-button').trigger('click');await flushPromises();
  await w.find('.results-section .feedback-options button').trigger('click');await flushPromises();expect(w.find('.featured-label').exists()).toBe(false);
  await w.find('.feedback-notice button').trigger('click');await flushPromises();
  expect(w.find('.featured-label').text()).toBe('根据收藏推荐');expect(w.find('.featured-reason').text()).toBe('根据你收藏的修仙风格推荐');
});

it('saving and undo restore the original same-batch card; navigation retains the round',async()=>{
  const s=setup(true),w=mount(App);stops.push(()=>w.unmount());await flushPromises();const button=(text:string)=>w.findAll('button').find(b=>b.text().includes(text))!;
  await button('理解我的口味').trigger('click');await flushPromises();await w.find('.recognition-dialog .primary-button').trigger('click');await flushPromises();expect(w.findAll('.results-section .drama-card')).toHaveLength(1);
  await button('片库').trigger('click');await button('发现好剧').trigger('click');expect(w.findAll('.results-section .drama-card')).toHaveLength(1);
  await w.find('.results-section .feedback-options button').trigger('click');await flushPromises();expect(w.find('.auth-dialog[open]').exists()).toBe(true);
  // Login continuation remains tied to this demand and successful batch.
  await w.find('.auth-dialog input[autocomplete="username"]').setValue('User_B');await w.find('.auth-dialog input[type="password"]').setValue('test password');await w.find('.auth-dialog form').trigger('submit');await flushPromises();
  expect(w.findAll('.results-section .drama-card')).toHaveLength(0);expect(w.find('.feedback-notice').text()).toContain('撤销刚才的反馈');
  await button('撤销刚才的反馈').trigger('click');await flushPromises();expect(w.findAll('.results-section .drama-card')).toHaveLength(1);
});
