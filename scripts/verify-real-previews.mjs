// Real local MP4s, isolated public-data copy, no upstream model or media calls.
import {createRequire} from 'node:module';
import {spawn,spawnSync} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{chromium}=require(process.env.KIWI_PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('..',import.meta.url)),suffix=Date.now().toString(36);
const python=resolve(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
const port=Number(process.env.KIWI_MEDIA_TEST_PORT||8002),base=`http://127.0.0.1:${port}`;
const probe=createServer();await new Promise((done,fail)=>{probe.once('error',fail);probe.listen(port,'127.0.0.1',done);});await new Promise(done=>probe.close(done));
const database=resolve(root,`.local/real-previews-${suffix}.db`);
const prepared=spawnSync(python,['-X','utf8','scripts/prepare-home-validation.py',database,'--with-previews'],{cwd:root,encoding:'utf8'});
assert.equal(prepared.status,0,prepared.stderr);
const {ready_work_ids:ids}=JSON.parse(prepared.stdout);assert(ids.length>=3,'Import at least three verified local previews first');
const server=spawn(python,['-X','utf8','-m','uvicorn','kiwi.main:app','--host','127.0.0.1','--port',String(port),'--no-proxy-headers','--no-access-log'],
 {cwd:root,env:{...process.env,PREVIEW_AUTO_ENABLED:'false',AI_MODE:'baseline',DATABASE_URL:`sqlite:///${database.replaceAll('\\','/')}`,AUTH_ALLOWED_ORIGINS:base,MEDIA_DELIVERY_MODE:'app'},stdio:['ignore','pipe','pipe'],windowsHide:true});
const log=createWriteStream(resolve(root,`.local/real-previews-${suffix}.log`));server.stdout.pipe(log);server.stderr.pipe(log);
const report={date:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}),database:JSON.parse(prepared.stdout).database,real_files:true,checks:[],samples:[],playback:[],page_errors:[],deployment_verified:false};
const pause=ms=>new Promise(done=>setTimeout(done,ms));let browser,page;
async function check(name,test){await test();report.checks.push(name);console.log(`Passed: ${name}`);}
async function close(){await page.keyboard.press('Escape');await page.mouse.move(1,1);}
async function findCard(work){
 await close();await page.locator('.catalog-search input').fill(work.title);
 const card=page.locator('.catalog-grid .drama-card').filter({has:page.getByRole('heading',{name:work.title,exact:true})}).first();
 await card.waitFor();await card.scrollIntoViewIfNeeded();return card;
}
async function open(work,touch=false){
 const card=await findCard(work),button=card.locator('[aria-controls=work-preview]');
 if(touch)await button.tap();else await button.click();
 await page.waitForFunction(()=>!!document.querySelector('#work-preview video')||!!document.querySelector('#work-preview .preview-status'));
 return card;
}
async function playClip(work,device,touch=false){
 const card=await open(work,touch);
 const video=page.locator('#work-preview video');await video.waitFor();
 await page.locator('#work-preview').scrollIntoViewIfNeeded();
 const play=page.locator('#work-preview .preview-play');await play.waitFor();
 if(touch)await play.tap();else await play.click();
 await page.waitForFunction(()=>{const v=document.querySelector('#work-preview video');return v&&v.currentTime>=14.6&&!v.muted&&!v.paused&&v.readyState>=2;},null,{timeout:25000});
 const sound=page.locator('#work-preview .preview-sound'),playback=page.locator('#work-preview .preview-playback');
 assert.equal(await sound.getAttribute('aria-label'),'静音预览');
 if(touch)await sound.tap();else await sound.click();
 await page.waitForFunction(()=>document.querySelector('#work-preview video')?.muted);
 if(touch)await sound.tap();else await sound.click();
 await page.waitForFunction(()=>{const v=document.querySelector('#work-preview video');return v&&!v.muted&&!v.paused&&v.webkitAudioDecodedByteCount>0;});
 if(touch)await playback.tap();else await playback.click();
 await page.waitForFunction(()=>document.querySelector('#work-preview video')?.paused);
 if(touch)await playback.tap();else await playback.click();
 await page.waitForFunction(()=>{const v=document.querySelector('#work-preview video');return v&&!v.muted&&!v.paused;});
 const decodedAudio=await page.locator('#work-preview video').evaluate(v=>v.webkitAudioDecodedByteCount);
 assert.equal(await page.locator('#work-preview input[type=range]').count(),0);
 const state=await page.evaluate(()=>{const v=document.querySelector('#work-preview video'),p=document.querySelector('#work-preview'),c=p.closest('article')||document.querySelector('.catalog-grid .drama-card');const r=p.getBoundingClientRect(),b=c.getBoundingClientRect();return {duration:v.duration,current_time:v.currentTime,muted:v.muted,video_width:v.videoWidth,video_height:v.videoHeight,side:p.dataset.placement,horizontal_overflow:document.documentElement.scrollWidth>innerWidth,panel:{x:r.x,y:r.y,right:r.right,bottom:r.bottom},card:{x:b.x,right:b.right,bottom:b.bottom}};});
 assert(!state.muted&&!state.horizontal_overflow&&Math.abs(state.duration-15)<.2);
 if(device==='desktop')assert(state.panel.x>=state.card.right+8||state.panel.right<=state.card.x-8);
 else assert.equal(state.side,'inline');
 report.playback.push({work_id:work.id,device,...state,default_sound_on:true,sound_toggle_verified:true,resume_keeps_sound:true,decoded_audio_bytes:decodedAudio});
 if(work===report.samples[0])await page.screenshot({path:resolve(root,`docs/screenshots/real-preview-${device}.png`)});
 await close();assert.equal(await page.locator('#work-preview video').count(),0);
}
try{
 let available=false;for(let i=0;i<60;i++){try{available=(await fetch(`${base}/health/ready`)).ok;}catch{}if(available)break;await pause(200);}assert(available);
 browser=await chromium.launch({channel:process.env.KIWI_BROWSER_CHANNEL||'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 // Cover availability is independent of local video delivery.
 await context.route('**/*',route=>route.request().resourceType()==='image'&&new URL(route.request().url()).origin!==base?route.abort():route.continue());
 page=await context.newPage();page.on('pageerror',error=>report.page_errors.push(error.message));page.setDefaultTimeout(12000);
 await mkdir(resolve(root,'docs/screenshots'),{recursive:true});
 await check('three current MP4s support 200, byte Range, HEAD and 416',async()=>{
   for(const id of ids.slice(0,3)){
     const work=await(await context.request.get(`${base}/api/v1/works/${id}`)).json();
     const metadata=await(await context.request.get(`${base}/api/v1/works/${id}/preview`)).json();assert.equal(metadata.status,'ready');
     const media=metadata.preview,url=`${base}${media.video_url}`;
     const full=await context.request.get(url);assert.equal(full.status(),200);
     const head=await context.request.head(url);assert.equal(head.status(),200);assert.equal((await head.body()).length,0);
     const range=await context.request.get(url,{headers:{Range:'bytes=0-31'}});assert.equal(range.status(),206);assert.equal((await range.body()).length,32);
     assert.equal((await context.request.get(url,{headers:{Range:'bytes=999999999-'}})).status(),416);
     report.samples.push({id,title:work.title,metadata:media,bytes:(await full.body()).length});
   }
 });
 await page.goto(base);await page.getByRole('button',{name:/片库/}).click();
 await check('all three real clips play with sound by default on desktop',async()=>{for(const work of report.samples)await playClip(work,'desktop');});
 await check('details expose the matching clip source without repeating it in the media panel',async()=>{
   const work=report.samples[0],card=await open(work);await page.locator('#work-preview video').waitFor();
   assert.equal(await page.locator('#work-preview .preview-source').count(),0);
   await card.getByRole('button',{name:'详情',exact:true}).click();
   const source=page.locator('.work-dialog .preview-source a');await source.waitFor();assert.equal(await source.getAttribute('href'),work.metadata.source_page_url);
   await page.getByRole('button',{name:'关闭作品详情',exact:true}).click();
 });
 await check('unavailable metadata and playback fail with a fresh-metadata retry',async()=>{
   const work=report.samples[0],pattern=`**/api/v1/works/${work.id}/preview`;
   await context.route(pattern,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'test outage'},request_id:'test'})}));
   await open(work);await page.getByText('视频暂不可用',{exact:true}).waitFor();assert.equal(await page.locator('#work-preview video').count(),0);
   await context.unroute(pattern);await page.locator('.preview-retry').click();await page.locator('#work-preview video').waitFor();
   await page.locator('#work-preview video').evaluate(v=>v.dispatchEvent(new Event('error')));
   await page.getByText('视频暂不可用',{exact:true}).waitFor();await page.locator('.preview-retry').click();await page.locator('#work-preview video').waitFor();await close();
 });
 await check('missing clips show the cover and do not load simulated or unrelated media',async()=>{
   const work=report.samples[0],pattern=`**/api/v1/works/${work.id}/preview`;
   await context.route(pattern,route=>route.fulfill({status:200,json:{work_id:work.id,request_id:'missing-fixture',status:'missing',message:'暂无视频预览',preview:null,preparing:false}}));
   await open(work);
   await page.getByText('暂无视频预览',{exact:true}).waitFor();assert.equal(await page.locator('#work-preview video').count(),0);await close();
   await context.unroute(pattern);
 });
 await check('generated lists and account favorites share real previews without changing the query or preferences',async()=>{
   const headers={Origin:base,'X-Kiwi-Request':'1'},password='Synthetic preview check 123';
   const registered=await context.request.post(`${base}/api/v1/auth/register`,{headers,data:{username:`preview_${suffix}`,password,confirm_password:password}});assert.equal(registered.status(),201);
   await page.reload();await page.locator('.logout-button').waitFor();await page.getByRole('button',{name:'发现好剧',exact:false}).click();
   await page.locator('#query').fill('想看修仙玄幻题材，穿越主题的故事');
   await page.getByRole('button',{name:'理解我的口味',exact:true}).click();
   await page.getByRole('button',{name:'确认偏好，生成片单',exact:true}).click();
   const card=page.locator('.results-section .drama-card').filter({has:page.getByRole('heading',{name:report.samples[0].title,exact:true})}).first();await card.waitFor();
   const before={query:await page.locator('#query').inputValue(),chips:await page.locator('.preference-chips').innerText(),results:await page.locator('.results-section').innerText()};
   await card.locator('[aria-controls=work-preview]').click();await page.locator('#work-preview video').waitFor();
   await page.locator('#work-preview .preview-play').click();await page.waitForFunction(()=>document.querySelector('#work-preview video')?.currentTime>.2);await close();
   assert.equal(await page.locator('#query').inputValue(),before.query);assert.equal(await page.locator('.preference-chips').innerText(),before.chips);assert.equal(await page.locator('.results-section').innerText(),before.results);
   await card.locator('.card-favorite').click();await page.waitForFunction(()=>document.querySelector('.results-section .drama-card .card-favorite[aria-pressed=true]'));
   await page.getByRole('button',{name:/我的收藏/}).click();
   const favorite=page.locator('.catalog-grid .drama-card').filter({has:page.getByRole('heading',{name:report.samples[0].title,exact:true})}).first();await favorite.waitFor();
   await favorite.locator('[aria-controls=work-preview]').click();await page.locator('#work-preview video').waitFor();await close();
   await page.getByRole('button',{name:'发现好剧',exact:false}).click();assert.equal(await page.locator('#query').inputValue(),before.query);assert.equal(await page.locator('.preference-chips').innerText(),before.chips);
 });
 await check('all three clips play on an independent touch viewport with inline placement',async()=>{
   const desktop=page,touch=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
   page=await touch.newPage();page.on('pageerror',error=>report.page_errors.push(error.message));
   try{await page.goto(base);await page.getByRole('button',{name:/片库/}).tap();for(const work of report.samples)await playClip(work,'phone',true);}
   finally{await touch.close();page=desktop;}
 });
 assert.deepEqual(report.page_errors,[]);
 await writeFile(resolve(root,'docs/real-preview-validation.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({checks:report.checks.length,samples:report.samples.length,playback:report.playback.length,page_errors:report.page_errors}));
}finally{
 if(page)await page.screenshot({path:resolve(root,'.local/real-preview-last.png')}).catch(()=>{});
 await browser?.close();if(server.exitCode===null){server.kill();await Promise.race([new Promise(done=>server.once('exit',done)),pause(3000)]);}log.end();
}
