import fixture from '../../tests/fixtures/refinement-cases.json';
import { effectScope, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../src/useAuth';
import { useFeedback } from '../src/useFeedback';
import { useRecommendationBatches } from '../src/useRecommendationBatches';
import { useRefinement } from '../src/useRefinement';
import { clonePreferences, preferenceDiff, reviewPreferences } from '../src/refinement';
import type { Preferences, Recommendation, RefinementResponse } from '../src/types';
import RefinementComposer from '../src/components/RefinementComposer.vue';
import App from '../src/App.vue';
import { homeFixture, workFixture } from './work-fixture';

const base=():Preferences=>clonePreferences(fixture.base as Preferences);
const json=(data:unknown,status=200,headers?:HeadersInit)=>Promise.resolve(new Response(status===204?null:JSON.stringify(data),{status,headers}));
const result=(items=[workFixture()]):Recommendation=>({request_id:'r',status:items.length?'success':'empty',items,warnings:[],timings_ms:{},mode:'baseline',batch:{state:items.length?'ready':'exhausted',has_more:null}});
function understood(p:Preferences,revision:number,text:string):RefinementResponse {
  const candidate=clonePreferences(p);
  if(text==='取消不要后宫')candidate.excluded_features=[];
  else if(text==='一定要节奏快')candidate.required.push({field:'pace',value:'快'});
  else if(text.startsWith('偏好题材'))candidate.soft_preferences.genres=['都市'];
  else if(text!=='加点修仙')candidate.soft_preferences.themes=['重生'];
  const diff=preferenceDiff(p,candidate),unknown=['再轻松一点','加点重生，必须完结','第二部不要了'].includes(text);
  return {request_id:'r',status:unknown?'needs_confirmation':diff.changes.length?'ready':'no_change',base_revision:revision,preferences:unknown?null:candidate,...(unknown?{changes:[],preserved:preferenceDiff(p,p).preserved}:diff),issues:unknown?['请明确本次条件']:[],mode:'baseline',timings_ms:{},usage:{calls:0,tokens:0}};
}
const stops:(()=>void)[]=[];
beforeEach(()=>{localStorage.clear();HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};});
afterEach(()=>{stops.splice(0).forEach(stop=>stop());vi.unstubAllGlobals();vi.useRealTimers();});
function setup(){
  let user:null|{id:string;username:string;nickname:null;avatar_id:string}=null;
  let recFailure=0,refineFailure=0,empty=false,duplicate=false,holdRefine=false,holdRec=false;
  const heldRefine:((response:Response)=>void)[]=[],heldRec:((response:Response)=>void)[]=[];
  const fetcher=vi.fn((url:string,options?:RequestInit):Promise<Response>=>{
    if(url.endsWith('/auth/me'))return json({user});
    if(url.endsWith('/auth/login')){user={id:'b',username:'User_B',nickname:null,avatar_id:'kiwi-default'};return json({user});}
    if(url.endsWith('/auth/logout')){user=null;return json(null,204);}
    if(url.endsWith('/feedback/state'))return json({items:[],complete:true});
    if(url.endsWith('/preferences/refine')){
      if(holdRefine)return new Promise(resolve=>heldRefine.push(resolve));
      if(refineFailure)return json({error:{message:'理解服务失败'}},refineFailure,{'Retry-After':'3'});
      const body=JSON.parse(options!.body as string);return json(understood(body.base_preferences,body.base_revision,body.text));
    }
    if(url.endsWith('/recommendations')){
      if(holdRec)return new Promise(resolve=>heldRec.push(resolve));
      if(recFailure)return json({error:{message:'生成服务失败'}},recFailure);
      const data=result(empty?[]:duplicate?[workFixture(),workFixture()]:[workFixture()]);
      if(user)data.history={status:'saved',id:'new-history'};
      return json(data);
    }
    if(url.endsWith('/preferences/parse'))return json({preferences:base()});
    if(url.includes('home-recommendations')||url.includes('/home/recommendations'))return json(homeFixture([workFixture()]));
    if(url.includes('/favorites/ids'))return json({items:[],relation_total:0});
    if(url.startsWith('/health'))return json({mode:'baseline',works:10});
    if(url.includes('/catalog/refresh'))return json({status:'idle'});
    return json({items:[],total:0});
  });vi.stubGlobal('fetch',fetcher);
  const scope=effectScope();stops.push(()=>scope.stop());
  const state=scope.run(()=>{const auth=useAuth(),feedback=useFeedback(auth),batches=useRecommendationBatches(auth,feedback),view=ref('discover');return {auth,feedback,batches,view,refine:useRefinement(auth,feedback,batches,view)};})!;
  const calls=(suffix:string)=>fetcher.mock.calls.filter(([url])=>url.endsWith(suffix));
  return {...state,fetcher,calls,heldRefine,heldRec,recFailure:(value:number)=>recFailure=value,refineFailure:(value:number)=>refineFailure=value,empty:(value=true)=>empty=value,duplicate:(value=true)=>duplicate=value,holdRefine:(value=true)=>holdRefine=value,holdRec:(value=true)=>holdRec=value};
}
async function initial(s:ReturnType<typeof setup>){await s.auth.restore();await flushPromises();await s.batches.generate(base(),'修仙不要后宫');}
async function propose(s:ReturnType<typeof setup>,text='加点重生'){s.refine.text.value=text;await s.refine.understand();}

describe('executed baseline and staged application',()=>{
  it('does not use a request snapshot as a committed baseline; valid empty activates it',async()=>{
    const s=setup();await s.auth.restore();s.holdRec();const pending=s.batches.generate(base());await flushPromises();
    expect(s.batches.snapshot.value).not.toBeNull();expect(s.refine.available.value).toBe(false);
    s.heldRec[0]!(new Response(JSON.stringify({error:{message:'failed'}}),{status:503}));await pending;
    expect(s.refine.available.value).toBe(false);expect(s.batches.canNext.value).toBe(false);s.holdRec(false);s.empty();await s.batches.generate(base());
    expect(s.refine.available.value).toBe(true);expect(s.batches.result.value?.status).toBe('empty');expect(s.batches.busy.value).toBe(false);
  });
  it('understands without generating, commits every state together only after success, and releases busy',async()=>{
    const s=setup();await initial(s);const old=JSON.parse(JSON.stringify(s.batches.result.value)),revision=s.batches.baseRevision.value;
    await propose(s);expect(s.calls('/recommendations')).toHaveLength(1);expect(s.batches.result.value).toEqual(old);expect(s.batches.committedPreferences.value).toEqual(base());
    expect(s.refine.changes.value[0]?.target).toBe('soft.themes');expect(await s.refine.apply()).toBe(true);
    expect(s.batches.committedPreferences.value?.soft_preferences.themes).toEqual(['重生']);expect(s.batches.committedPreferences.value?.excluded_features).toEqual(['harem']);expect(s.batches.baseRevision.value).toBe(revision+1);
    expect(s.batches.busy.value).toBe(false);expect(s.refine.busy.value).toBe(false);expect(s.refine.text.value).toBe('');expect([...s.batches.shownIds.value]).toEqual(['work-a']);
    expect(JSON.parse(s.calls('/recommendations').at(-1)![1]!.body as string)).toMatchObject({query:'加点重生',exclude_work_ids:[]});
    await propose(s,'取消不要后宫');await s.refine.apply();expect(s.batches.committedPreferences.value?.excluded_features).toEqual([]);expect(s.batches.committedPreferences.value?.soft_preferences.themes).toEqual(['重生']);
  });
  it('commits legal empty results and clears the old visible batch',async()=>{
    const s=setup();await initial(s);await propose(s);s.empty();expect(await s.refine.apply()).toBe(true);
    expect(s.batches.result.value?.items).toEqual([]);expect(s.batches.result.value?.status).toBe('empty');expect(s.batches.shownIds.value.size).toBe(0);expect(s.batches.committedPreferences.value?.soft_preferences.themes).toEqual(['重生']);
  });
  it.each([409,503,504])('keeps baseline, batch, dedup and draft after generation %s, and allows explicit retry',async(code)=>{
    const s=setup();await initial(s);await propose(s);const revision=s.batches.baseRevision.value,batch=s.batches.batch.value,old=s.batches.result.value;
    s.recFailure(code);expect(await s.refine.apply()).toBe(false);expect(s.batches.result.value).toEqual(old);expect(s.batches.baseRevision.value).toBe(revision);expect(s.batches.batch.value).toBe(batch);expect([...s.batches.shownIds.value]).toEqual(['work-a']);expect(s.refine.text.value).toBe('加点重生');expect(s.refine.canApply.value).toBe(true);expect(s.refine.error.value).toContain('生成失败');
    s.recFailure(0);expect(await s.refine.apply()).toBe(true);expect(s.batches.busy.value).toBe(false);
  });
  it('rejects duplicate results without committing or losing the previous batch',async()=>{
    const s=setup();await initial(s);await propose(s);s.duplicate();expect(await s.refine.apply()).toBe(false);
    expect(s.batches.committedPreferences.value).toEqual(base());expect(s.batches.result.value?.items).toHaveLength(1);expect(s.batches.busy.value).toBe(false);
  });
  it('no_change and needs_confirmation never reset dedup or call recommendation',async()=>{
    const s=setup();await initial(s);const revision=s.batches.baseRevision.value,epoch=s.batches.epoch.value;
    for(const text of ['加点修仙','再轻松一点','加点重生，必须完结','第二部不要了']){
      await propose(s,text);expect(s.refine.canApply.value).toBe(false);expect(s.batches.baseRevision.value).toBe(revision);expect(s.batches.epoch.value).toBe(epoch);expect([...s.batches.shownIds.value]).toEqual(['work-a']);
    }expect(s.calls('/recommendations')).toHaveLength(1);
  });
  it('manual review recomputes full conflicts and changes, never applies without a separate confirmation',async()=>{
    const s=setup();await initial(s);await propose(s,'再轻松一点');const edited=s.refine.editCandidate();edited.required=[{field:'harem',value:true}];s.refine.saveCandidate(edited);
    expect(s.refine.issues.value.length).toBeGreaterThan(0);expect(s.refine.canApply.value).toBe(false);
    edited.excluded_features=[];s.refine.saveCandidate(edited);expect(s.refine.canApply.value).toBe(true);expect(s.refine.changes.value.some(row=>row.target==='excluded_features')).toBe(true);expect(s.calls('/recommendations')).toHaveLength(1);
    s.refine.saveCandidate(base());expect(s.refine.status.value).toBe('no_change');expect(s.refine.canApply.value).toBe(false);
  });
});

describe('request, page and identity ownership',()=>{
  it.each([200,401])('input edits invalidate late understanding %s and cannot expire current identity',async(status)=>{
    const s=setup();await initial(s);s.holdRefine();s.refine.text.value='加点重生';const pending=s.refine.understand();await flushPromises();s.refine.text.value='取消不要后宫';
    s.heldRefine[0]!(new Response(JSON.stringify(status===200?understood(base(),s.batches.baseRevision.value,'加点重生'):{error:{message:'old session'}}),{status}));await pending;
    expect(s.refine.pendingPreferences.value).toBeNull();expect(s.refine.reviewOpen.value).toBe(false);expect(s.refine.text.value).toBe('取消不要后宫');expect(s.auth.state.value).toBe('guest');
  });
  it('page navigation keeps text and committed baseline but cancels late prompts; returning does not reissue',async()=>{
    const s=setup();await initial(s);s.holdRefine();s.refine.text.value='加点重生';const pending=s.refine.understand();await flushPromises();s.view.value='catalog';
    s.heldRefine[0]!(new Response(JSON.stringify(understood(base(),s.batches.baseRevision.value,'加点重生'))));await pending;s.view.value='discover';
    expect(s.refine.text.value).toBe('加点重生');expect(s.batches.committedPreferences.value).toEqual(base());expect(s.refine.reviewOpen.value).toBe(false);expect(s.calls('/preferences/refine')).toHaveLength(1);
  });
  it.each([200,401])('account changes invalidate in-flight understanding %s, clear the old context, and preserve results',async(status)=>{
    const s=setup();await initial(s);s.holdRefine();s.refine.text.value='加点重生';const pending=s.refine.understand();await flushPromises();await s.auth.submit('login',{username:'User_B',password:'test password'});await flushPromises();
    s.heldRefine[0]!(new Response(JSON.stringify(status===200?understood(base(),1,'加点重生'):{error:{message:'old'}}),{status}));await pending;
    expect(s.auth.state.value).toBe('authenticated');expect(s.auth.user.value?.username).toBe('User_B');expect(s.refine.text.value).toBe('');expect(s.batches.committedPreferences.value).toBeNull();expect(s.batches.result.value?.items).toHaveLength(1);
  });
  it.each([200,401])('discarding in-flight confirmation %s prevents the old response from committing or expiring a new account',async(status)=>{
    const s=setup();await initial(s);await propose(s);s.holdRec();const pending=s.refine.apply();await flushPromises();s.refine.discard();await s.auth.submit('login',{username:'User_B',password:'test password'});await flushPromises();
    s.heldRec[0]!(new Response(JSON.stringify(status===200?result():{error:{message:'old'}}),{status}));await pending;
    expect(s.auth.state.value).toBe('authenticated');expect(s.batches.committedPreferences.value).toBeNull();expect(s.refine.reviewOpen.value).toBe(false);expect(s.batches.busy.value).toBe(false);
  });
  it('canceling a staged confirmation retains the original baseline and leaves retry text',async()=>{
    const s=setup();await initial(s);await propose(s);s.holdRec();const pending=s.refine.apply();await flushPromises();s.refine.discard();s.heldRec[0]!(new Response(JSON.stringify(result())));await pending;
    expect(s.batches.committedPreferences.value).toEqual(base());expect(s.refine.text.value).toBe('加点重生');expect(s.batches.busy.value).toBe(false);expect(s.batches.result.value?.items).toHaveLength(1);
  });
  it('a main-demand reset invalidates pending candidates; next batch uses only the applied snapshot',async()=>{
    const s=setup();await initial(s);await propose(s);s.empty();await s.batches.next();
    expect(JSON.parse(s.calls('/recommendations').at(-1)![1]!.body as string).preferences).toEqual(base());expect(s.batches.committedPreferences.value).toEqual(base());
    s.batches.reset();expect(s.refine.available.value).toBe(false);expect(s.refine.text.value).toBe('');
  });
  it('counts Unicode code points and waits on 429 without replaying',async()=>{
    const s=setup();await initial(s);s.refine.text.value='😀'.repeat(301);expect(s.refine.count.value).toBe(301);await s.refine.understand();expect(s.calls('/preferences/refine')).toHaveLength(0);
    s.refine.text.value='😀'.repeat(300);expect(s.refine.count.value).toBe(300);expect(s.refine.canUnderstand.value).toBe(true);
    s.refineFailure(429);await s.refine.understand();expect(s.refine.retrySeconds.value).toBeGreaterThan(0);await s.refine.understand();expect(s.calls('/preferences/refine')).toHaveLength(1);expect(s.refine.text.value).toHaveLength(600);
  });
  it.each([413,503,504])('understanding failure %s leaves the executed baseline untouched',async(status)=>{
    const s=setup();await initial(s);s.refineFailure(status);await propose(s);expect(s.refine.error.value).toContain('理解调整失败');expect(s.refine.text.value).toBe('加点重生');expect(s.batches.committedPreferences.value).toEqual(base());expect(s.refine.busy.value).toBe(false);
  });
});

it('shared product examples retain hard constraints and are independently reviewable',()=>{
  for(const item of fixture.cases){const data=understood(base(),1,item.text);expect(data.status).toBe(item.status);if(data.preferences&&item.target)expect(data.changes).toContainEqual(expect.objectContaining({target:item.target,after:item.after}));}
  const invalid=base();invalid.required=[{field:'pace',value:'快'},{field:'pace',value:'舒缓'}];expect(reviewPreferences(invalid).issues.length).toBeGreaterThan(0);
});
it('review UI supports editing, closing and Esc without a recommendation',async()=>{
  const s=setup();await initial(s);const wrapper=mount(RefinementComposer,{props:{refinement:s.refine,disabled:false}});stops.push(()=>wrapper.unmount());await propose(s);await flushPromises();
  expect(wrapper.find('dialog[open]').exists()).toBe(true);expect(wrapper.text()).toContain('保持不变');expect(wrapper.text()).toContain('调整后的完整偏好');
  await wrapper.find('dialog').trigger('cancel');await flushPromises();expect(s.refine.pendingPreferences.value).toBeNull();expect(s.calls('/recommendations')).toHaveLength(1);
  await propose(s);await flushPromises();const button=wrapper.findAll('button').find(b=>b.text()==='手动调整')!;await button.trigger('click');expect(wrapper.find('.preference-editor').exists()).toBe(true);
});
it('App only reveals continuous adjustment after executing first recommendations and syncs applied preference display',async()=>{
  setup();const wrapper=mount(App);stops.push(()=>wrapper.unmount());await flushPromises();expect(wrapper.find('.refinement-composer').exists()).toBe(false);
  await wrapper.find('#recommend-button').trigger('click');await flushPromises();expect(wrapper.find('.refinement-composer').exists()).toBe(false);
  await wrapper.find('.recognition-dialog .primary-button').trigger('click');await flushPromises();expect(wrapper.find('.refinement-composer').exists()).toBe(true);
  await wrapper.find('#refinement-text').setValue('加点重生');await wrapper.find('.refinement-actions .secondary-button').trigger('click');await flushPromises();expect(wrapper.find('.refinement-dialog[open]').exists()).toBe(true);
  await wrapper.find('.refinement-dialog .primary-button').trigger('click');await flushPromises();expect(wrapper.find('.taste-panel').text()).toContain('重生');expect((wrapper.find('#query').element as HTMLTextAreaElement).value).toBe('想看穿越逆袭的故事，偏好修仙题材。');
  await wrapper.find('#query').setValue('想看都市');expect(wrapper.find('.refinement-composer').exists()).toBe(false);
});
