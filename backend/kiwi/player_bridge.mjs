// Normal, public first-episode playback in a reusable browser. JSONL only.
import {createRequire} from 'node:module';
import {createInterface} from 'node:readline';
const require=createRequire(import.meta.url);
let browser;
try {
  const {chromium}=require(process.env.KIWI_PLAYWRIGHT_MODULE||'playwright');
  browser=await chromium.launch({channel:process.env.KIWI_PREVIEW_BROWSER||'msedge',headless:true});
  process.stdout.write(JSON.stringify({type:'ready'})+'\n');
} catch {
  process.stdout.write(JSON.stringify({type:'error',error:'browser_unavailable'})+'\n');
  process.exit(1);
}
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
const running=new Set();
function identity(seriesId){
  const queue=[window._ROUTER_DATA?.loaderData],seen=new Set();
  for(let i=0;i<queue.length&&i<2000;i++){
    const value=queue[i];if(!value||typeof value!=='object'||seen.has(value))continue;seen.add(value);
    const detail=value.seriesDetail;
    if(detail&&String(detail.series_id)===seriesId){
      const first=detail.vid_list?.[0],episode=value.vid||value.publicVideoSeo?.itemId;
      const social=value.seriesSocialInfo||{};
      return {title:detail.series_name,series_id:String(detail.series_id),episode_id:episode?String(episode):null,first_episode_id:first?String(first):null,
        source_data:{series_id:String(detail.series_id),series_name:detail.series_name,series_intro:detail.series_intro,series_cover:detail.series_cover,
          tags:detail.tags,episode_cnt:detail.episode_cnt,rank_label:social.rank_label,heat:social.hot_score_data?.text}};
    }
    queue.push(...Object.values(value));
  }
  return null;
}
input.on('line',line=>{
  let request;try {request=JSON.parse(line);}catch {return;}
  if(request.type==='close'){void browser.close().finally(()=>process.exit(0));return;}
  const job=(async()=>{
    let page,jobContext,stage='navigation';
    try {
      if(!/^[0-9]{5,24}$/.test(request.series_id))throw Error('invalid_series');
      const playerUrl=`https://hongguoduanju.com/player/${request.series_id}`;
      // Each public player has its own guest cookies and playback identity.
      jobContext=await browser.newContext();page=await jobContext.newPage();
      const response=await page.goto(playerUrl,{waitUntil:'domcontentloaded',timeout:25000});
      if(!response||response.status()>=400)throw Error(`source_http_${response?.status()||'missing'}`);
      stage='playback';
      await page.waitForFunction(()=>{const v=document.querySelector('video');return v&&v.readyState>=2&&v.duration>=15&&v.currentSrc.startsWith('https:');},null,{timeout:20000});
      const url=await page.locator('video').evaluate(v=>v.currentSrc);
      stage='metadata';
      const info=await page.evaluate(identity,request.series_id);
      if(!info||String(info.series_id)!==request.series_id||!info.episode_id||info.episode_id!==info.first_episode_id)throw Error('episode_identity_mismatch');
      if(info.title!==request.title){
        // A rename is resolved against the canonical detail page, by stable ID.
        stage='source_metadata';const detailPage=await jobContext.newPage();
        const detailResponse=await detailPage.goto(`https://hongguoduanju.com/detail?series_id=${request.series_id}`,{waitUntil:'domcontentloaded',timeout:25000});
        if(!detailResponse||detailResponse.status()>=400)throw Error(`source_http_${detailResponse?.status()||'missing'}`);
        const detail=await detailPage.evaluate(identity,request.series_id);
        if(!detail||detail.series_id!==info.series_id||detail.title!==info.title||detail.first_episode_id!==info.first_episode_id)throw Error('episode_identity_mismatch');
        info.source_data=detail.source_data;await detailPage.close();
      }
      info.url=url;
      info.user_agent=await page.evaluate(()=>navigator.userAgent);
      info.referer=page.url();
      process.stdout.write(JSON.stringify({request_id:request.request_id,info})+'\n');
    }catch(error){
      const code=/^(?:source_http_\d+|episode_identity_mismatch)$/.test(error.message)?error.message:`player_${stage}_unavailable`;
      const diagnostic=await page?.evaluate(()=>{const v=document.querySelector('video');let host;try{host=new URL(v?.currentSrc).hostname;}catch{}return {host,ready:v?.readyState,duration:Number.isFinite(v?.duration)?v.duration:null,paused:v?.paused,hidden:document.hidden,error:v?.error?.code};}).catch(()=>null);
      process.stdout.write(JSON.stringify({request_id:request.request_id,error:code,diagnostic})+'\n');
    }finally {await jobContext?.close().catch(()=>{});}
  })();
  running.add(job);job.finally(()=>running.delete(job));
});
input.on('close',async()=>{await Promise.allSettled([...running]);await browser.close();});
