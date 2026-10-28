import { effectScope } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAuth } from '../src/useAuth';
import { useHistory } from '../src/useHistory';
import { useFeedback } from '../src/useFeedback';
import { batchPayload, useRecommendationBatches } from '../src/useRecommendationBatches';
import { emptyPreferences, type HistoryDetail } from '../src/types';
import HistoryPanel from '../src/components/HistoryPanel.vue';
import App from '../src/App.vue';
import { homeFixture, workFixture } from './work-fixture';

const stops:(()=>void)[]=[];
const id='a'.repeat(32),secondId='b'.repeat(32);
const prefs=()=>({...emptyPreferences(),soft_preferences:{genres:['修仙'],themes:[],pace:null}});
const fixture=(key=id):HistoryDetail=>({id:key,query:'想看修仙，不要后宫',created_at:'2026-10-28T02:30:00Z',count:1,mode:'baseline',
  preferences:prefs(),titles:['测试作品'],warnings:[],items:[{id:'work-a',title:'测试作品',available:true,changed:false,work:workFixture({reason:'当时的推荐理由'})}]});
const json=(data:unknown,status=200)=>Promise.resolve(new Response(status===204?null:JSON.stringify(data),{status}));
beforeEach(()=>{localStorage.clear();HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};});
afterEach(()=>{stops.splice(0).forEach(stop=>stop());vi.unstubAllGlobals();});
function setup(guest=false){
  let rows=[fixture()],failure='',deleteFailure=0;
  let user:Record<string,unknown>|null=guest?null:{id:'u',username:'User_A',nickname:null,avatar_id:'kiwi-default'};
  const fetcher=vi.fn((url:string,options?:RequestInit):Promise<Response>=>{
    if(url.endsWith('/auth/me'))return json({user});
    if(url.endsWith('/auth/logout')){user=null;return json(null,204);}
    if(url.endsWith('/auth/login')){user={id:'other',username:'User_B',nickname:null,avatar_id:'kiwi-default'};rows=[];return json({user});}
    if(url.startsWith('/api/v1/me/history?'))return failure==='list'?json({error:{message:'历史列表失败'}},503):json({items:rows,total:rows.length});
    if(url.startsWith('/api/v1/me/history/')){
      if(options?.method==='DELETE'){
        if(deleteFailure)return json({error:{message:'删除失败'}},deleteFailure);
        rows=rows.filter(row=>!url.endsWith(row.id));return json(null,204);
      }
      return failure==='detail'?json({error:{message:'历史详情失败'}},503):json({history:rows.find(row=>url.endsWith(row.id))||fixture()});
    }
    if(url.includes('/home'))return json(homeFixture([workFixture()]));
    if(url.endsWith('/recommendations'))return json({status:'success',items:[workFixture()],warnings:[],timings_ms:{},history:{status:'saved',id},batch:{state:'ready',has_more:null}});
    if(url.endsWith('/preferences/parse'))return json({preferences:prefs()});
    if(url.endsWith('/feedback/state'))return json({items:[],complete:true});
    if(url.includes('/favorites/ids'))return json({items:[],relation_total:0});
    if(url==='/api/v1/works/work-a')return json(workFixture({summary:'最新作品资料'}));
    if(url.startsWith('/health'))return json({mode:'baseline',works:1});
    if(url.includes('/catalog/refresh'))return json({status:'idle'});
    return json({items:[],total:0});
  });vi.stubGlobal('fetch',fetcher);
  const scope=effectScope();stops.push(()=>scope.stop());
  const state=scope.run(()=>{const auth=useAuth(),feedback=useFeedback(auth);return {auth,history:useHistory(auth),batches:useRecommendationBatches(auth,feedback)};})!;
  return {...state,fetcher,fail:(value:string)=>failure=value,failDelete:(status:number)=>deleteFailure=status,rows:(value:HistoryDetail[])=>rows=value};
}

it('guests make no private requests; login loads only current account history',async()=>{
  const s=setup(true);await s.auth.restore();await flushPromises();expect(s.fetcher.mock.calls.some(([url])=>url.includes('/history'))).toBe(false);
  await s.auth.submit('login',{username:'User_B',password:'password'});await flushPromises();expect(s.history.items.value).toEqual([]);
});
it('reads details without generation and does not mutate confirmation preferences or active batch',async()=>{
  const s=setup();await s.auth.restore();await flushPromises();await s.batches.generate(prefs());const active=s.batches.result.value;
  const count=s.fetcher.mock.calls.filter(([url,o])=>url.endsWith('/recommendations')&&o?.method==='POST').length;
  await s.history.open(id);expect(s.history.selected.value?.items[0]!.work?.reason).toBe('当时的推荐理由');expect(s.batches.result.value).toEqual(active);
  expect(s.fetcher.mock.calls.filter(([url,o])=>url.endsWith('/recommendations')&&o?.method==='POST')).toHaveLength(count);
});
it.each([200,401])('late detail response %s cannot publish or expire a newly logged-in account',async status=>{
  const s=setup();await s.auth.restore();await flushPromises();const original=s.fetcher.getMockImplementation()!;let finish!:(r:Response)=>void;
  s.fetcher.mockImplementation((url,options)=>url==='/api/v1/me/history/'+id?new Promise(resolve=>finish=resolve):original(url,options));
  const opened=s.history.open(id);await flushPromises();await s.auth.logout();await s.auth.submit('login',{username:'User_B',password:'password'});await flushPromises();
  finish(new Response(JSON.stringify(status===200?{history:fixture()}:{error:{message:'旧账号会话过期'}}),{status}));await opened;
  expect(s.auth.user.value?.username).toBe('User_B');expect(s.history.selected.value).toBeNull();expect(s.history.selectedId.value).toBe('');expect(s.history.detailError.value).toBe('');
});
it('list failures keep the last confirmed data and recover on retry',async()=>{
  const s=setup();await s.auth.restore();await flushPromises();s.fail('list');await s.history.load();expect(s.history.error.value).toBe('历史列表失败');expect(s.history.items.value).toHaveLength(1);
  s.fail('');await s.history.load();expect(s.history.error.value).toBe('');
});
it('detail failure has an independent error and can retry without losing the list',async()=>{
  const s=setup();await s.auth.restore();await flushPromises();s.fail('detail');await s.history.open(id);expect(s.history.selected.value).toBeNull();expect(s.history.items.value).toHaveLength(1);expect(s.history.detailError.value).toBe('历史详情失败');
  s.fail('');await s.history.open(id);expect(s.history.selected.value?.id).toBe(id);
});
it('a superseded detail request and a request completed after back cannot reopen a record',async()=>{
  const s=setup();await s.auth.restore();await flushPromises();const original=s.fetcher.getMockImplementation()!;let finish!:(r:Response)=>void;
  s.fetcher.mockImplementation((url,options)=>url==='/api/v1/me/history/'+id?new Promise(resolve=>finish=resolve):original(url,options));
  const old=s.history.open(id);await s.history.open(secondId);finish(new Response(JSON.stringify({history:fixture()})));await old;
  expect(s.history.selectedId.value).toBe(secondId);
  const another=s.history.open(id);s.history.back();finish(new Response(JSON.stringify({history:fixture()})));await another;expect(s.history.selected.value).toBeNull();expect(s.history.selectedId.value).toBe('');
});
it('failed delete keeps the record and can retry; deleting a selected record returns to the list',async()=>{
  const s=setup();await s.auth.restore();await flushPromises();await s.history.open(id);s.failDelete(503);
  expect(await s.history.remove(id)).toBe(false);expect(s.history.selected.value?.id).toBe(id);expect(s.history.deleteError.value).toBe('删除失败');
  s.failDelete(0);expect(await s.history.remove(id)).toBe(true);expect(s.history.selected.value).toBeNull();expect(s.history.items.value).toHaveLength(0);
});
it('deleting a record already gone in another session reconciles as success',async()=>{
  const s=setup();await s.auth.restore();await flushPromises();s.failDelete(404);s.rows([]);expect(await s.history.remove(id)).toBe(true);expect(s.history.total.value).toBe(0);
});
it('pagination corrects an empty final page after deletion',async()=>{
  const s=setup();await s.auth.restore();await flushPromises();s.history.page.value=2;await flushPromises();expect(s.history.page.value).toBe(1);
});
it('batch query is snapshotted for next and restart, counts toward actual UTF-8 bytes and private pointer clears at logout',async()=>{
  const s=setup();await s.auth.restore();await flushPromises();await s.batches.generate(prefs(),'当时的需求');expect(s.batches.result.value?.history?.status).toBe('saved');
  const original=s.fetcher.getMockImplementation()!;s.fetcher.mockImplementation((url,options)=>url.endsWith('/recommendations')?json({status:'success',items:[workFixture({id:'work-b'})],warnings:[],timings_ms:{},batch:{state:'ready',has_more:null}}):original(url,options));
  await s.batches.next();s.batches.restart();await flushPromises();
  const requests=s.fetcher.mock.calls.filter(([url,o])=>url.endsWith('/recommendations')&&o?.method==='POST').map(([,options])=>JSON.parse(options!.body as string));expect(requests).toHaveLength(3);expect(requests.every(body=>body.query==='当时的需求')).toBe(true);
  const ids=new Set(Array.from({length:190},(_,i)=>'x'.repeat(80)+i));expect(()=>batchPayload(prefs(),ids,3,'字'.repeat(3000))).toThrow();
  await s.auth.logout();expect(s.batches.result.value?.history).toBeNull();
});
it('panel shows explicit confirmation before delete and emits reuse without generating',async()=>{
  const s=setup();await s.auth.restore();await flushPromises();const w=mount(HistoryPanel,{props:{auth:s.auth}});stops.push(()=>w.unmount());await flushPromises();
  const button=(text:string)=>w.findAll('button').find(b=>b.text()===text)!;
  await button('删除').trigger('click');expect(s.fetcher.mock.calls.some(([,o])=>o?.method==='DELETE')).toBe(false);await button('取消').trigger('click');
  await button('查看片单 →').trigger('click');await flushPromises();expect(w.text()).toContain('当时的推荐理由');expect(w.text()).toContain('标签基线');
  await button('沿用偏好，再次推荐 ↗').trigger('click');expect(w.emitted('reuse')?.[0]?.[0]).toEqual(fixture());expect(s.fetcher.mock.calls.some(([url,o])=>url.endsWith('/recommendations')&&o?.method==='POST')).toBe(false);
});
it('unavailable works have no detail controls, changed works clearly label their historical reasons',async()=>{
  const s=setup();await s.auth.restore();await flushPromises();const data=fixture();data.items[0]!.changed=true;data.items.push({id:'removed',title:'已移除作品',available:false,changed:false,work:null});s.rows([data]);
  const w=mount(HistoryPanel,{props:{auth:s.auth,initialId:id}});stops.push(()=>w.unmount());await flushPromises();
  expect(w.text()).toContain('作品资料已更新');expect(w.text()).toContain('作品资料暂不可用');expect(w.findAll('.history-works button')).toHaveLength(1);
});
it('App reuses saved preferences only after the explicit action and still asks for confirmation',async()=>{
  const s=setup(),w=mount(App);stops.push(()=>w.unmount());await flushPromises();await w.find('#query').setValue('保留正在编辑的需求');
  await w.findAll('.nav-item').find(b=>b.text().includes('历史片单'))!.trigger('click');await flushPromises();expect(s.fetcher.mock.calls.some(([url,o])=>url.endsWith('/recommendations')&&o?.method==='POST')).toBe(false);
  await w.find('.history-card .secondary-button').trigger('click');await flushPromises();expect(w.find('.history-detail').text()).toContain('当时的推荐理由');
  await w.find('.history-detail-heading .primary-button').trigger('click');await flushPromises();
  expect((w.find('#query').element as HTMLTextAreaElement).value).toBe('想看修仙，不要后宫');expect(w.find('.recognition-dialog[open]').exists()).toBe(true);
  expect(s.fetcher.mock.calls.some(([url,o])=>url.endsWith('/recommendations')&&o?.method==='POST')).toBe(false);
  await w.find('.recognition-dialog .primary-button').trigger('click');await flushPromises();expect(w.find('.history-save-note').text()).toContain('已自动保存');
  const sent=s.fetcher.mock.calls.filter(([url,o])=>url.endsWith('/recommendations')&&o?.method==='POST');expect(JSON.parse(sent[0]![1]!.body as string).query).toBe('想看修仙，不要后宫');
});
it('App requests current work data when opening a historical work',async()=>{
  const s=setup(),w=mount(App);stops.push(()=>w.unmount());await flushPromises();await w.findAll('.nav-item').find(b=>b.text().includes('历史片单'))!.trigger('click');await flushPromises();
  await w.find('.history-card .secondary-button').trigger('click');await flushPromises();await w.find('.history-works button').trigger('click');await flushPromises();
  expect(s.fetcher.mock.calls.some(([url])=>url==='/api/v1/works/work-a')).toBe(true);expect(w.find('.work-dialog[open]').exists()).toBe(true);
});
