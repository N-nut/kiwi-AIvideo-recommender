import { effectScope } from 'vue';
import { flushPromises,mount } from '@vue/test-utils';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { useAuth } from '../src/useAuth';
import { useCorrections } from '../src/useCorrections';
import { useReview } from '../src/useReview';
import { correctionLabels,reviewLabel } from '../src/corrections';
import type { Correction,ReviewDetail } from '../src/corrections';
import CorrectionDialog from '../src/components/CorrectionDialog.vue';
import MyCorrections from '../src/components/MyCorrections.vue';
import ReviewWorkspace from '../src/components/ReviewWorkspace.vue';
import App from '../src/App.vue';
import { homeFixture,workFixture } from './work-fixture';

const id='a'.repeat(32),revision='b'.repeat(32),stops:(()=>void)[]=[];
const work=()=>workFixture({harem:false});
const report=():Correction=>({id,work_id:'work-a',work_title:'测试修仙作品',origin:'user',category:'plot_fact',field:'harem',status:'pending',revision,base_revision:1,current_value:false,suggestion:{kind:'unknown'},description:'简介未说明，建议恢复未知',source_hint:null,related_correction_id:null,decision:null,created_at:'2026-10-28T00:00:00Z',updated_at:'2026-10-28T00:00:00Z'});
const detail=():ReviewDetail=>({work:work(),correction:report(),base_snapshot:{harem:false},source_snapshot:{kind:'import',data:{original_intro:work().original_intro}},confirmed_fields:{},recheck_fields:[],manual_hold:false,media_hold:false,hold_reason:null,updated_at:'2026-10-28T00:00:00Z',events:[]});
const json=(value:unknown,status=200)=>Promise.resolve(new Response(status===204?null:JSON.stringify(value),{status}));
beforeEach(()=>{HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');this.dispatchEvent(new Event('close'));};localStorage.clear();});
afterEach(()=>{stops.splice(0).forEach(stop=>stop());vi.restoreAllMocks();vi.unstubAllGlobals();});
function setup(guest=false){let user:Record<string,unknown>|null=guest?null:{id:'u',username:'User',nickname:null,avatar_id:'kiwi-default'};let role=true;
  const fetcher=vi.fn((url:string,options?:RequestInit):Promise<Response>=>{
    if(url.endsWith('/auth/me'))return json({user});
    if(url.endsWith('/auth/logout')){user=null;return json(null,204);}
    if(url.endsWith('/auth/login')){user={id:'v',username:'Other',nickname:null,avatar_id:'kiwi-default'};return json({user});}
    if(url.endsWith('/review-access'))return json({can_review:role});
    if(url.includes('/review/corrections?'))return json({items:[report()],total:1});
    if(url.endsWith('/review/corrections/'+id))return json(detail());
    if(url.endsWith('/actions')||url.includes('/review/operations/'))return json({correction:{...report(),status:'accepted'},work:work()});
    if(url.includes('/corrections?'))return json({items:[report()],total:1});
    if(url.includes('/corrections/operations/'))return json({correction:report()});
    if(url.endsWith('/corrections')&&options?.method==='POST')return json({correction:report()},201);
    if(url==='/api/v1/works/work-a')return json(work());
    if(url.includes('/home'))return json(homeFixture([work()]));
    if(url.includes('/favorites/ids'))return json({items:[],relation_total:0});
    if(url.endsWith('/feedback/state'))return json({items:[],complete:true});
    if(url.endsWith('/preview'))return json({work_id:'work-a',status:'missing',preview:null});
    if(url.includes('/catalog/refresh'))return json({status:'idle'});
    if(url.startsWith('/health'))return json({status:'ready',mode:'baseline',works:1});
    return json({items:[work()],total:1});
  });vi.stubGlobal('fetch',fetcher);
  const scope=effectScope();stops.push(()=>scope.stop());
  const state=scope.run(()=>{const auth=useAuth();return {auth,corrections:useCorrections(auth),review:useReview(auth)};})!;
  return {...state,fetcher,revoke:()=>role=false};
}
const posts=(s:ReturnType<typeof setup>)=>s.fetcher.mock.calls.filter(([url,o])=>url.endsWith('/corrections')&&o?.method==='POST');

it('shows exact scope including confirmed unknown, never claims whole-work review',()=>{
  expect(reviewLabel(work())).toContain('待人工核对');
  expect(reviewLabel(workFixture({review:{revision:2,state:'partial',confirmed_fields:['harem'],recheck_fields:[]}}))).toBe('已核对字段：后宫');
  expect(reviewLabel(workFixture({review:undefined}))).toContain('待人工核对');
});
it('loads latest work, requires explicit submission and supports unknown without false coercion',async()=>{
  const s=setup();await s.auth.restore();await flushPromises();const wrapper=mount(CorrectionDialog,{props:{auth:s.auth,work:work()},attachTo:document.body});stops.push(()=>wrapper.unmount());await flushPromises();
  expect(posts(s)).toHaveLength(0);await wrapper.get('#correction-category').setValue('plot_fact');await flushPromises();
  await wrapper.get('#correction-kind').setValue('unknown');await wrapper.get('#correction-description').setValue('简介未说明');await wrapper.get('form').trigger('submit');await flushPromises();
  const body=JSON.parse(posts(s)[0][1]!.body as string);expect(body.suggestion).toEqual({kind:'unknown'});expect(body.base_revision).toBe(1);expect(body).not.toHaveProperty('user_id');
  expect(wrapper.text()).toContain('已提交');expect(wrapper.emitted('submitted')).toHaveLength(1);expect(localStorage.length).toBe(0);
});
it('Esc discards an unsubmitted draft without creating a report',async()=>{
  const s=setup();await s.auth.restore();const wrapper=mount(CorrectionDialog,{props:{auth:s.auth,work:work()}});stops.push(()=>wrapper.unmount());await flushPromises();
  await wrapper.get('#correction-description').setValue('未提交草稿');await wrapper.get('dialog').trigger('cancel');
  expect(wrapper.emitted('close')).toHaveLength(1);expect(posts(s)).toHaveLength(0);
});
it('network unknown freezes operation and queries receipt before explicit same-key retry',async()=>{
  const s=setup();await s.auth.restore();const original=s.fetcher.getMockImplementation()!;let fails=true,receiptFound=false;
  s.fetcher.mockImplementation((url,o)=>url==='/api/v1/me/corrections'&&o?.method==='POST'&&fails?Promise.reject(new TypeError('network')):url.includes('/corrections/operations/')&&!receiptFound?json({error:{message:'unknown'}},404):original(url,o));
  const body={work_id:'work-a',base_revision:1,category:'plot_fact',field:'harem',suggestion:{kind:'unknown'},description:'问题'};
  await s.corrections.send(body);expect(s.corrections.unknown.value).toBe(true);await s.corrections.send(body);expect(posts(s)).toHaveLength(1);
  const key=JSON.parse(posts(s)[0][1]!.body as string).operation_id;await s.corrections.resolve();expect(s.corrections.unknown.value).toBe(true);expect(s.corrections.submitError.value).toContain('在途');
  fails=false;await s.corrections.retry();expect(JSON.parse(posts(s)[1][1]!.body as string).operation_id).toBe(key);expect(s.corrections.saved.value?.id).toBe(id);expect(s.corrections.busy.value).toBe(false);
});
it.each([200,401])('late submission %s never crosses accounts or logs the next user out',async status=>{
  const s=setup();await s.auth.restore();const original=s.fetcher.getMockImplementation()!;let finish!:(r:Response)=>void;
  s.fetcher.mockImplementation((url,o)=>url==='/api/v1/me/corrections'&&o?.method==='POST'?new Promise(resolve=>finish=resolve):original(url,o));
  const task=s.corrections.send({work_id:'work-a'});await flushPromises();await s.auth.logout();await s.auth.submit('login',{username:'Other',password:'password'});
  finish(new Response(JSON.stringify(status===200?{correction:report()}:{error:{message:'old'}}),{status}));await task;
  expect(s.auth.user.value?.id).toBe('v');expect(s.corrections.saved.value).toBeNull();expect(s.corrections.unknown.value).toBe(false);expect(s.corrections.busy.value).toBe(false);
});
it('my reports show private result and preserve escaped source text',async()=>{
  const s=setup();await s.auth.restore();const original=s.fetcher.getMockImplementation()!;s.fetcher.mockImplementation((url,o)=>url.includes('/corrections?')?json({items:[{...report(),description:'<script>private</script>',status:'rejected',decision:'资料暂不足以核实'}],total:1}):original(url,o));
  const wrapper=mount(MyCorrections,{props:{auth:s.auth}});stops.push(()=>wrapper.unmount());await flushPromises();
  expect(wrapper.text()).toContain('未采纳');expect(wrapper.text()).toContain('资料暂不足以核实');expect(wrapper.find('script').exists()).toBe(false);
});
it('review requires a separate full-change confirmation and releases busy after publication',async()=>{
  const s=setup();await s.auth.restore();await flushPromises();const wrapper=mount(ReviewWorkspace,{props:{auth:s.auth,review:s.review}});stops.push(()=>wrapper.unmount());await flushPromises();await wrapper.get('.review-list button').trigger('click');await flushPromises();
  expect(wrapper.text()).toContain('提交时原值：无');expect(wrapper.text()).toContain('最新来源原文');await wrapper.get('#review-reason').setValue('已核对来源，恢复未知');
  await wrapper.get('.correction-form').trigger('submit');await flushPromises();expect(s.fetcher.mock.calls.filter(([url])=>url.endsWith('/actions'))).toHaveLength(0);
  expect(wrapper.get('[aria-label="发布前核对"]').text()).toContain('无 → 未知');
  await wrapper.findAll('button').find(b=>b.text()==='确认处理并保存')!.trigger('click');await flushPromises();
  expect(s.fetcher.mock.calls.filter(([url])=>url.endsWith('/actions'))).toHaveLength(1);expect(s.review.busy.value).toBe(false);expect(s.review.detail.value).toBeNull();expect(wrapper.emitted('changed')).toHaveLength(1);
});
it('403 clears reviewer private data and refreshes server permission',async()=>{
  const s=setup();await s.auth.restore();await flushPromises();await s.review.open(id);expect(s.review.detail.value).not.toBeNull();s.revoke();const original=s.fetcher.getMockImplementation()!;
  s.fetcher.mockImplementation((url,o)=>url.endsWith('/review/corrections/'+id)?json({error:{message:'已撤权'}},403):original(url,o));
  await s.review.open(id);await flushPromises();expect(s.review.canReview.value).toBe(false);expect(s.review.detail.value).toBeNull();expect(s.review.items.value).toEqual([]);
});
it.each([200,401])('late reviewer detail %s cannot revive old permissions or draft',async status=>{
  const s=setup();await s.auth.restore();await flushPromises();const original=s.fetcher.getMockImplementation()!;let finish!:(r:Response)=>void;
  s.fetcher.mockImplementation((url,o)=>url.endsWith('/review/corrections/'+id)?new Promise(resolve=>finish=resolve):original(url,o));
  const task=s.review.open(id);await flushPromises();await s.auth.logout();await s.auth.submit('login',{username:'Other',password:'password'});
  finish(new Response(JSON.stringify(status===200?detail():{error:{message:'old'}}),{status}));await task;expect(s.review.detail.value).toBeNull();expect(s.review.busy.value).toBe(false);expect(s.auth.user.value?.id).toBe('v');
});
it('guest correction login cancellation retains demand and creates no submission',async()=>{
  const s=setup(true);const wrapper=mount(App,{attachTo:document.body});stops.push(()=>wrapper.unmount());await flushPromises();await wrapper.get('#query').setValue('保留我的观剧需求');await wrapper.findAll('nav button').find(b=>b.text().includes('片库'))!.trigger('click');await flushPromises();await wrapper.get('.poster-button').trigger('click');await flushPromises();
  await wrapper.findAll('.work-dialog button').find(b=>b.text()==='资料有误？')!.trigger('click');await flushPromises();expect(wrapper.find('.auth-dialog[open]').exists()).toBe(true);await wrapper.get('.auth-dialog').trigger('cancel');await flushPromises();
  expect(posts(s)).toHaveLength(0);expect(wrapper.find('.work-dialog[open]').exists()).toBe(true);
});
