import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, APIError, latestRequest } from '../src/api';
afterEach(()=>vi.unstubAllGlobals());
describe('request handling',()=>{
  it('sends explicit credentialed DELETE with the browser write header and accepts 204',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(null,{status:204}));vi.stubGlobal('fetch',fetcher);
    await expect(api('/api/v1/me/favorites/work-a',undefined,undefined,'DELETE')).resolves.toBeUndefined();
    expect(fetcher.mock.calls[0][1]).toMatchObject({method:'DELETE',credentials:'same-origin',headers:{'X-Kiwi-Request':'1'}});
  });
  it('rejects a late completion after the input changes',()=>{ const lane=latestRequest(); const a=lane.begin(); lane.cancel(); expect(a.current()).toBe(false); expect(a.signal.aborted).toBe(true); });
  it('allows only the newest request to update state',()=>{ const lane=latestRequest(); const a=lane.begin(); const b=lane.begin(); expect(a.current()).toBe(false);expect(b.current()).toBe(true); });
  it('posts the edited structure, preserving field names',async()=>{ const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'success'})));vi.stubGlobal('fetch',fetcher);await api('/api/v1/recommendations',{preferences:{excluded_features:['harem']}});expect(JSON.parse(fetcher.mock.calls[0][1].body).preferences.excluded_features).toEqual(['harem']); });
  it('keeps actionable errors and request IDs',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{message:'向量服务调用失败'},request_id:'abc'}),{status:503})));try{await api('/api');throw Error('expected error');}catch(e){expect(e).toBeInstanceOf(APIError);expect((e as APIError).requestId).toBe('abc');}});
});
