import { effectScope } from 'vue';
import { flushPromises } from '@vue/test-utils';
import { describe,it,expect,beforeEach,afterEach,vi } from 'vitest';
import { useAuth } from '../src/useAuth';
import { useLibrary } from '../src/library';
import { importGroup,importHistory,importMarker,legacyGroups,markImported } from '../src/legacyImport';
const response=(data:unknown,status=200)=>Promise.resolve(new Response(status===204?null:JSON.stringify(data),{status}));
let scope=effectScope();
beforeEach(()=>{localStorage.clear();scope=effectScope();});
afterEach(()=>{scope.stop();vi.unstubAllGlobals();});
function setup() {return scope.run(()=>{const auth=useAuth();return {auth,library:useLibrary(auth)};})!;}

describe('account collection state',()=>{
  it('loads every ID page and uses server counts instead of the ID or current page length',async()=>{
    const ids=Array.from({length:205},(_,i)=>`id-${i}`);
    vi.stubGlobal('fetch',vi.fn((url:string)=>response(url.endsWith('/me')?{user:{id:'a',username:'Alpha'}}:url.includes('/ids?')?{items:url.includes('page=1&')?ids.slice(0,200):ids.slice(200),relation_total:205}:{items:[],total:201,unavailable_count:4})));
    const {auth,library}=setup();await auth.restore();await flushPromises();
    expect(library.ready.value).toBe(true);expect(library.saved.value.size).toBe(205);expect(library.total.value).toBe(201);expect(library.unavailable.value).toBe(4);
  });
  it('does not update a failed write and retries the same desired PUT state',async()=>{
    let saved=false,failed=true;
    const fetcher=vi.fn((url:string,opts?:RequestInit)=>{
      if(opts?.method==='PUT') {saved=true;if(failed)return Promise.reject(new Error('network uncertain'));return response({saved:true});}
      return response(url.endsWith('/me')?{user:{id:'a',username:'Alpha'}}:url.includes('/ids?')?{items:saved?['x']:[],relation_total:saved?1:0}:{items:[],total:saved?1:0,unavailable_count:0});
    });vi.stubGlobal('fetch',fetcher);const {auth,library}=setup();await auth.restore();await flushPromises();
    expect(await library.setSaved('x',true)).toBe(false);expect(library.has('x')).toBe(false);
    failed=false;expect(await library.setSaved('x',true)).toBe(true);expect(library.has('x')).toBe(true);
    expect(fetcher.mock.calls.filter(([,opts])=>opts?.method==='PUT')).toHaveLength(2);
  });
  it('clears private state on expiry and ignores an old account response even if fetch ignores abort',async()=>{
    let user={id:'a',username:'Alpha'},late!:(r:Response)=>void,delay=true;
    vi.stubGlobal('fetch',vi.fn((url:string)=>{
      if(url.endsWith('/me')) return response({user});
      if(url.includes('/ids?')&&delay) return new Promise<Response>(r=>late=r);
      return response(url.includes('/ids?')?{items:['b-only'],relation_total:1}:{items:[],total:1,unavailable_count:0});
    }));const {auth,library}=setup();await auth.restore();await flushPromises();
    user={id:'b',username:'Beta'};delay=false;await auth.restore();await flushPromises();
    late(new Response(JSON.stringify({items:['a-secret'],relation_total:1})));await flushPromises();
    expect(library.has('a-secret')).toBe(false);expect(library.has('b-only')).toBe(true);
    auth.expire();expect(library.saved.value.size).toBe(0);expect(library.total.value).toBe(0);
  });
  it('keeps checking errors separate from guest and does not claim logout after failure',async()=>{
    let failed=true;
    vi.stubGlobal('fetch',vi.fn((url:string)=>failed?response({error:{message:'storage unavailable'}},503):response({user:{id:'a',username:'Alpha'}})));
    const {auth}=setup();await auth.restore();expect(auth.state.value).toBe('error');
    failed=false;await auth.restore();expect(auth.state.value).toBe('authenticated');failed=true;
    expect(await auth.logout()).toBe(false);expect(auth.user.value?.id).toBe('a');
  });
  it('expires only the current account on a protected 401 and never replays a write',async()=>{
    const fetcher=vi.fn((url:string)=>url.endsWith('/me')?response({user:{id:'a',username:'Alpha'}}):response({error:{message:'expired'}},401));vi.stubGlobal('fetch',fetcher);
    const auth=scope.run(()=>useAuth())!;await auth.restore();const current=auth.scope();
    await expect(current.request('/api/v1/me/favorites/x',undefined,'PUT')).rejects.toThrow('expired');
    expect(auth.state.value).toBe('guest');expect(fetcher.mock.calls.filter(([url])=>url.endsWith('/x'))).toHaveLength(1);
  });
});

describe('explicit legacy group import',()=>{
  it('validates groups, deduplicates and never infers identity from nickname',()=>{
    localStorage.setItem('kiwi-real-library-v1',JSON.stringify({Alpha:['a','a','b'],Beta:['c'],bad:[3]}));
    const groups=legacyGroups();expect(groups.map(g=>g.ids)).toEqual([['a','b'],['c']]);
    expect(importMarker('uuid-1',groups[0]!)).not.toBe(importMarker('uuid-2',groups[0]!));
    const history=importHistory();markImported(importMarker('uuid-1',groups[0]!),history);expect(importHistory().size).toBe(1);
    expect(localStorage.getItem('kiwi-real-library-v1')).toContain('Beta');
  });
  it('batches at 100, exposes partial progress, retries idempotently and preserves local data',async()=>{
    const ids=Array.from({length:205},(_,i)=>`id-${i}`);localStorage.setItem('kiwi-real-library-v1',JSON.stringify({Old:ids}));
    const group=legacyGroups()[0]!,progress=vi.fn(),stored=new Set<string>();let fail=true;
    const send=vi.fn(async(batch:string[])=>{if(fail&&batch[0]==='id-100')throw Error('temporary');let added=0;batch.forEach(id=>{if(!stored.has(id)){stored.add(id);added++;}});return {requested:batch.length,unique:batch.length,added,already_saved:batch.length-added,skipped_unavailable:0};});
    await expect(importGroup(group,send,progress)).rejects.toThrow('temporary');expect(progress).toHaveBeenCalledWith(1,105);expect(importHistory().size).toBe(0);
    fail=false;const stats=await importGroup(group,send,progress);expect(stats.added).toBe(105);expect(stats.already_saved).toBe(100);expect(send.mock.calls.every(([batch])=>batch.length<=100)).toBe(true);
    expect(JSON.parse(localStorage.getItem('kiwi-real-library-v1')!).Old).toEqual(ids);
  });
  it('tolerates corrupt and unwritable storage while keeping the in-memory import marker',()=>{
    localStorage.setItem('kiwi-real-library-v1','broken');expect(legacyGroups()).toEqual([]);
    const history=new Set<string>(),storage={setItem:()=>{throw Error('blocked');}} as unknown as Storage;
    expect(()=>markImported('completed',history,storage)).not.toThrow();expect(history.has('completed')).toBe(true);
  });
});
