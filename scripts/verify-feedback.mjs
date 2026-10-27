// Isolated public catalogue copy, synthetic accounts, baseline recommendations.
import {spawn,spawnSync} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const root=fileURLToPath(new URL('..',import.meta.url)),suffix=Date.now().toString(36);
const port=Number(process.env.KIWI_FEEDBACK_TEST_PORT||8008),base=`http://127.0.0.1:${port}`;
const python=resolve(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
const database=resolve(root,`.local/feedback-${suffix}.db`),password='Synthetic feedback password 123';
const probe=createServer();await new Promise((done,fail)=>{probe.once('error',fail);probe.listen(port,'127.0.0.1',done);});await new Promise(done=>probe.close(done));
const preparation=spawnSync(python,['-X','utf8','scripts/prepare-home-validation.py',database,'--with-previews'],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(preparation.status,0,preparation.stderr);
const copied=JSON.parse(preparation.stdout);
const server=spawn(python,['-X','utf8','-m','uvicorn','kiwi.main:app','--host','127.0.0.1','--port',String(port),'--no-proxy-headers','--no-access-log'],{cwd:root,env:{...process.env,PREVIEW_AUTO_ENABLED:'false',AI_MODE:'baseline',DATABASE_URL:`sqlite:///${database.replaceAll(String.fromCharCode(92),'/')}`,AUTH_ALLOWED_ORIGINS:base},stdio:['ignore','pipe','pipe'],windowsHide:true});
const log=createWriteStream(resolve(root,`.local/feedback-${suffix}.log`));server.stdout.pipe(log);server.stderr.pipe(log);
const report={date:'2026-10-27',mode:'baseline',database:copied.database,public_works:copied.public_works,checks:[],viewports:[],page_errors:[],synthetic_faults:['delayed batch response','recommendation 503'],external_covers_blocked:true};
const pause=ms=>new Promise(done=>setTimeout(done,ms)),shots=resolve(root,'docs/screenshots');let browser;
async function check(name,run){await run();report.checks.push(name);console.log(`Passed: ${name}`);}
const writeHeaders={'Origin':base,'X-Kiwi-Request':'1'};
try{
 let ready=false;for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('Validation server exited');try{ready=(await(await fetch(`${base}/health/ready`)).json()).mode==='baseline';}catch{}if(ready)break;await pause(200);}assert(ready);
 browser=await chromium.launch({channel:process.env.KIWI_BROWSER_CHANNEL||'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 await context.route('**/*',route=>route.request().resourceType()==='image'&&new URL(route.request().url()).origin!==base?route.abort():route.continue());
 const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>report.page_errors.push(error.message));
 const actions=[];page.on('request',request=>{if(['POST','PATCH','DELETE'].includes(request.method()))actions.push({method:request.method(),path:new URL(request.url()).pathname,body:request.postDataJSON()});});
 const cards=()=>page.locator('.results-section .drama-card'),ids=()=>cards().evaluateAll(elements=>elements.map(el=>el.dataset.workId));
 const generate=async()=>{await page.locator('#recommend-button').click();await cards().first().waitFor();};
 await page.goto(base);await page.getByRole('button',{name:'登录 / 注册',exact:true}).waitFor();
 let firstIds,nextIds,feedbackId,firstVersion;const username=`Feed_${suffix}`;
 await check('guest can generate and switch batches using identical confirmed preferences without reparsing',async()=>{
  await page.locator('#query').fill('只看修仙');await page.locator('#recommend-button').click();await page.locator('.recognition-dialog[open]').waitFor();await page.locator('.recognition-dialog .primary-button').click();await cards().first().waitFor();
  firstIds=await ids();assert(firstIds.length>0);await page.getByRole('button',{name:'换一批',exact:true}).click();await page.waitForFunction(old=>{const el=document.querySelector('.results-section .drama-card');return el&&!old.includes(el.dataset.workId);},firstIds);
  nextIds=await ids();assert(nextIds.every(id=>!firstIds.includes(id)));assert.equal(actions.filter(a=>a.path.endsWith('/parse')).length,1);
  const requests=actions.filter(a=>a.path==='/api/v1/recommendations');assert.deepEqual(requests[1].body.preferences,requests[0].body.preferences);assert.deepEqual(requests[1].body.exclude_work_ids,firstIds);
 });
 await check('cancelled guest feedback leaves input, preferences and cards; registration continues just the selected feedback',async()=>{
  feedbackId=nextIds[0];await cards().first().getByRole('button',{name:'已看过',exact:true}).click();await page.locator('.auth-dialog[open]').waitFor();await page.getByRole('button',{name:'关闭登录',exact:true}).click();assert.deepEqual(await ids(),nextIds);
  await cards().first().getByRole('button',{name:'已看过',exact:true}).click();await page.getByRole('button',{name:'还没有账号？注册',exact:true}).click();
  await page.locator('#auth-username').fill(username);await page.locator('#auth-password').fill(password);await page.locator('#auth-confirmation').fill(password);await page.getByRole('button',{name:'注册并登录',exact:true}).click();
  await page.waitForFunction(id=>![...document.querySelectorAll('.results-section .drama-card')].some(el=>el.dataset.workId===id),feedbackId);
  const data=await(await context.request.get(`${base}/api/v1/me/feedback/${feedbackId}`)).json();assert.equal(data.feedback.status,'watched');firstVersion=data.feedback.revision;
  assert.equal(await page.locator('#query').inputValue(),'只看修仙');assert.equal(actions.filter(a=>a.path.endsWith('/recommendations')&&a.method==='POST').length,2);
 });
 await check('same-batch undo restores the card at its position after server detail verification',async()=>{
  await page.getByRole('button',{name:'撤销刚才的反馈',exact:true}).click();await page.locator(`.results-section [data-work-id="${feedbackId}"]`).waitFor();assert.deepEqual(await ids(),nextIds);
  assert.equal((await(await context.request.get(`${base}/api/v1/me/feedback/${feedbackId}`)).json()).feedback,null);
 });
 await check('private feedback excludes future batches and home but preserves favorites and the confirmed input',async()=>{
  await generate();feedbackId=(await ids())[0];await context.request.put(`${base}/api/v1/me/favorites/${feedbackId}`,{headers:writeHeaders});
  await cards().first().getByRole('button',{name:'不感兴趣',exact:true}).click();
  await page.waitForFunction(id=>!document.querySelector(`.results-section [data-work-id="${id}"]`),feedbackId);
  const data=await(await context.request.get(`${base}/api/v1/me/feedback/${feedbackId}`)).json();firstVersion=data.feedback.revision;
  assert.equal(data.feedback.status,'not_interested');assert.equal((await(await context.request.get(`${base}/api/v1/me/favorites`)).json()).total,1);
  const prefs=actions.filter(a=>a.path==='/api/v1/me/recommendations').at(-1).body.preferences;
  const next=await context.request.post(`${base}/api/v1/me/recommendations`,{headers:writeHeaders,data:{preferences:prefs,limit:3,exclude_work_ids:[]}});assert(!(await next.json()).items.some(w=>w.id===feedbackId));
  assert(!(await(await context.request.get(`${base}/api/v1/me/home-recommendations`)).json()).items.some(w=>w.id===feedbackId));
 });
 await check('management, independent same-account restore, status changes and stale deletion are consistent',async()=>{
  await page.locator('.account-button').click();await page.getByRole('button',{name:'推荐反馈管理 ↗',exact:true}).click();await page.locator('.feedback-list li').first().waitFor();assert((await page.locator('.feedback-list').innerText()).includes('不感兴趣'));
  await mkdir(shots,{recursive:true});
  for(const [width,height] of [[1440,1000],[768,1024],[390,844],[320,740]]){
   await page.setViewportSize({width,height});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   report.viewports.push({width,height,surface:'feedback-management',horizontal_overflow:false});
   if(width===1440||width===390)await page.screenshot({path:resolve(shots,`feedback-management-${width===1440?'desktop':'mobile'}.png`),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});
  const second=await browser.newContext();try{
   const login=await second.request.post(`${base}/api/v1/auth/login`,{headers:writeHeaders,data:{username,password}});assert.equal(login.status(),200);
   const state=await(await second.request.get(`${base}/api/v1/me/feedback/state`)).json();assert(state.items.some(item=>item.work_id===feedbackId));
   const changed=await second.request.patch(`${base}/api/v1/me/feedback/${feedbackId}`,{headers:writeHeaders,data:{status:'watched',expected_revision:firstVersion}});assert.equal(changed.status(),200);
   const stale=await context.request.delete(`${base}/api/v1/me/feedback/${feedbackId}`,{headers:{...writeHeaders,'If-Match':`"${firstVersion}"`}});assert.equal(stale.status(),412);
  }finally{await second.close();}
  await page.getByRole('button',{name:'已看过',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.feedback-list')?.textContent.includes('已看过'));
  await page.getByRole('button',{name:'撤销反馈',exact:true}).click();await page.getByText('这个分类还没有反馈。',{exact:true}).waitFor();
 });
 await check('feedback and batch controls fit desktop, tablet and narrow mobile; keyboard focuses labelled feedback icons',async()=>{
  await page.getByRole('button',{name:/发现好剧/}).click();await generate();await mkdir(shots,{recursive:true});
  for(const [width,height] of [[1440,1000],[768,1024],[390,844],[320,740]]){
   await page.setViewportSize({width,height});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   const icon=cards().first().getByRole('button',{name:'已看过',exact:true});await icon.focus();assert(await icon.evaluate(el=>el===document.activeElement));assert.equal(await icon.locator('svg').count(),1);
   report.viewports.push({width,height,horizontal_overflow:false});if(width===1440||width===390)await page.screenshot({path:resolve(shots,`feedback-${width===1440?'desktop':'mobile'}.png`),fullPage:true});
  }
 });
 await check('batch failure retains cards and shown IDs; leaving and returning does not reset the round',async()=>{
  await page.setViewportSize({width:1440,height:1000});const before=await ids();
  await context.route('**/api/v1/me/recommendations',route=>route.fulfill({status:503,json:{error:{code:'search_incomplete',message:'验收模拟：检索尚未完成'}}}));
  await page.getByRole('button',{name:'换一批',exact:true}).click();await page.getByText('验收模拟：检索尚未完成',{exact:true}).waitFor();assert.deepEqual(await ids(),before);await context.unroute('**/api/v1/me/recommendations');
  await page.getByRole('button',{name:/片库/}).click();await page.getByRole('button',{name:/发现好剧/}).click();assert.deepEqual(await ids(),before);
  let release;const gate=new Promise(done=>release=done);await context.route('**/api/v1/me/recommendations',async route=>{const response=await route.fetch();await gate;await route.fulfill({response});});
  await page.getByRole('button',{name:'换一批',exact:true}).click();await page.getByRole('button',{name:'正在换一批…',exact:true}).waitFor();assert.deepEqual(await ids(),before);
  await page.locator('#query').fill('想看都市成长');release();await pause(150);assert.equal(await cards().count(),0);await context.unroute('**/api/v1/me/recommendations');
 });
 await check('carousel feedback removes only the selected slide without filling the vacancy or generating recommendations',async()=>{
  const oldCount=await page.locator('.featured-pages button').count(),oldTitle=await page.locator('.featured-copy h1').innerText();
  const count=actions.filter(a=>a.path.endsWith('/recommendations')&&a.method==='POST').length;
  await page.locator('.featured-copy').getByRole('button',{name:'已看过',exact:true}).click();
  await page.waitForFunction(title=>document.querySelector('.featured-copy h1')?.textContent!==title,oldTitle);
  assert.equal(await page.locator('.featured-pages button').count(),oldCount-1);assert.equal(actions.filter(a=>a.path.endsWith('/recommendations')&&a.method==='POST').length,count);
  assert.equal(await page.locator('#query').inputValue(),'想看都市成长');
 });
 await check('existing real preview still serves verified media ranges after using feedback',async()=>{
  const id=copied.ready_work_ids[0];assert(id,'Need a ready public preview sample');report.tested_preview=id;
  const preview=await(await context.request.get(`${base}/api/v1/works/${id}/preview`)).json();assert.equal(preview.status,'ready');
  const media=await context.request.get(`${base}${preview.preview.video_url}`,{headers:{Range:'bytes=0-9'}});assert.equal(media.status(),206);assert.equal((await media.body()).length,10);
  const work=await(await context.request.get(`${base}/api/v1/works/${id}`)).json();await page.getByRole('button',{name:/片库/}).click();await page.locator('#catalog-search').fill(work.title);await page.locator('#catalog-search').press('Enter');
  const card=page.locator(`.catalog-section [data-work-id="${id}"]`);await card.waitFor();await card.getByRole('button',{name:`预览《${work.title}》视频片段`,exact:true}).click();await page.locator('#work-preview video').waitFor();
  await page.getByRole('button',{name:'关闭视频预览',exact:true}).click();await page.getByRole('button',{name:/发现好剧/}).click();assert.equal(await page.locator('#query').inputValue(),'想看都市成长');
 });
 await check('another account does not inherit feedback and logout keeps the edited demand',async()=>{
  const isolated=await browser.newContext();try{
   const other=await isolated.request.post(`${base}/api/v1/auth/register`,{headers:writeHeaders,data:{username:`Other_${suffix}`,password,confirm_password:password}});assert.equal(other.status(),201);
   assert.equal((await(await isolated.request.get(`${base}/api/v1/me/feedback`)).json()).total,0);
  }finally{await isolated.close();}
  await page.getByRole('button',{name:'退出',exact:true}).click();await page.getByRole('button',{name:'登录 / 注册',exact:true}).waitFor();assert.equal(await page.locator('#query').inputValue(),'想看都市成长');
 });
 assert.deepEqual(report.page_errors,[]);await writeFile(resolve(root,'docs/feedback-browser-validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({checks:report.checks.length,viewports:report.viewports.length,page_errors:report.page_errors}));
}finally{
 await browser?.close();if(server.exitCode===null){server.kill();await Promise.race([new Promise(done=>server.once('exit',done)),pause(3000)]);}log.end();
}
