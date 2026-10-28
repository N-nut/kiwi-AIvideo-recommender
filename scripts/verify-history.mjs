// Public catalogue copy and synthetic accounts only; no business writes.
import {spawn,spawnSync} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const root=fileURLToPath(new URL('..',import.meta.url)),suffix=Date.now().toString(36),port=Number(process.env.KIWI_HISTORY_TEST_PORT||8010),base=`http://127.0.0.1:${port}`;
const python=resolve(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python'),database=resolve(root,`.local/history-${suffix}.db`);
const probe=createServer();await new Promise((done,fail)=>{probe.once('error',fail);probe.listen(port,'127.0.0.1',done);});await new Promise(done=>probe.close(done));
const prepared=spawnSync(python,['-X','utf8','scripts/prepare-home-validation.py',database,'--with-previews'],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(prepared.status,0,prepared.stderr);
const copied=JSON.parse(prepared.stdout),server=spawn(python,['-X','utf8','-m','uvicorn','kiwi.main:app','--host','127.0.0.1','--port',String(port),'--no-proxy-headers','--no-access-log'],{cwd:root,env:{...process.env,PREVIEW_AUTO_ENABLED:'false',AI_MODE:'baseline',DATABASE_URL:`sqlite:///${database.replaceAll(String.fromCharCode(92),'/')}`,AUTH_ALLOWED_ORIGINS:base},stdio:['ignore','pipe','pipe'],windowsHide:true});
const log=createWriteStream(resolve(root,`.local/history-${suffix}.log`));server.stdout.pipe(log);server.stderr.pipe(log);
const report={date:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}),mode:'baseline',database:copied.database,public_works:copied.public_works,checks:[],viewports:[],page_errors:[],synthetic_accounts:true,faults:['history list 503','history detail 503','delete 503','catalog changes on disposable copy']};
const shots=resolve(root,'docs/screenshots'),pause=ms=>new Promise(done=>setTimeout(done,ms)),headers={Origin:base,'X-Kiwi-Request':'1'};
const username=`History_${suffix}`,password='Synthetic history password 123';let browser;
async function check(name,run){await run();report.checks.push(name);console.log(`Passed: ${name}`);}
try{
 let ready=false;for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('Isolated validation server exited');try{ready=(await(await fetch(`${base}/health/ready`)).json()).mode==='baseline';}catch{}if(ready)break;await pause(200);}assert(ready);
 browser=await chromium.launch({channel:process.env.KIWI_BROWSER_CHANNEL||'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>report.page_errors.push(error.message));
 await context.route('**/*',route=>route.request().resourceType()==='image'&&new URL(route.request().url()).origin!==base?route.abort():route.continue());
 const actions=[];page.on('request',request=>{if(['POST','PATCH','DELETE'].includes(request.method()))actions.push(new URL(request.url()).pathname);});
 const modelCalls=()=>actions.filter(path=>path.endsWith('/recommendations')||path.endsWith('/parse')).length;
 const nav=name=>page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:new RegExp(name)}).click();
 const cards=()=>page.locator('.results-section .drama-card');
 await page.goto(base);await page.getByRole('button',{name:'登录 / 注册',exact:true}).waitFor();await mkdir(shots,{recursive:true});
 await check('guest navigation requires login without losing the demand; public generation remains available',async()=>{
  await page.locator('#query').fill('只看修仙');await nav('历史片单');await page.locator('.auth-dialog[open]').waitFor();await page.getByRole('button',{name:'关闭登录',exact:true}).click();assert.equal(await page.locator('#query').inputValue(),'只看修仙');
  await page.locator('#recommend-button').click();await page.locator('.recognition-dialog[open]').waitFor();await page.locator('.recognition-dialog .primary-button').click();await cards().first().waitFor();assert.equal(await page.locator('.history-save-note').count(),0);
 });
 let firstId,nextId,originalPreferences;
 await check('logged-in generation and next batch automatically save separate server snapshots',async()=>{
  await nav('历史片单');await page.locator('.auth-switch').click();await page.locator('#auth-username').fill(username);await page.locator('#auth-password').fill(password);await page.locator('#auth-confirmation').fill(password);await page.locator('.auth-dialog button[type=submit]').click();await page.locator('#history-title').waitFor();await page.getByText('还没有历史片单',{exact:true}).waitFor();
  await page.getByRole('button',{name:'去发现好剧 →',exact:true}).click();await page.locator('#recommend-button').click();await page.locator('.history-save-note').getByText('已自动保存到历史片单',{exact:true}).waitFor();
  let list=await(await context.request.get(`${base}/api/v1/me/history`)).json();assert.equal(list.total,1);firstId=list.items[0].id;
  const first=await(await context.request.get(`${base}/api/v1/me/history/${firstId}`)).json();originalPreferences=first.history.preferences;assert.equal(first.history.query,'只看修仙');assert.equal(first.history.count,await cards().count());
  await page.getByRole('button',{name:'换一批',exact:true}).click();await page.waitForResponse(response=>response.url()===`${base}/api/v1/me/recommendations`&&response.status()===200);await page.getByText('已自动保存到历史片单',{exact:true}).waitFor();
  list=await(await context.request.get(`${base}/api/v1/me/history`)).json();assert.equal(list.total,2);nextId=list.items[0].id;assert.notEqual(nextId,firstId);
  const second=await(await context.request.get(`${base}/api/v1/me/history/${nextId}`)).json();assert(second.history.items.every(item=>!first.history.items.some(old=>old.id===item.id)));
 });
 await check('viewing history does not generate or replace discovery input; snapshot preferences require explicit confirmation to reuse',async()=>{
  const calls=modelCalls();await page.getByRole('button',{name:'查看这份片单 →',exact:true}).click();await page.locator('.history-detail').waitFor();assert.equal(modelCalls(),calls);assert.equal(await page.locator('.history-detail .history-works>li').count(),3);
  await nav('发现好剧');assert.equal(await page.locator('#query').inputValue(),'只看修仙');await page.locator('#query').fill('正在编辑但尚未确认的需求');
  await nav('历史片单');await page.locator('.history-card .secondary-button').first().click();await page.locator('.history-detail').waitFor();assert.equal(modelCalls(),calls);
  await page.getByRole('button',{name:'沿用偏好，再次推荐 ↗',exact:true}).click();await page.locator('.recognition-dialog[open]').waitFor();assert.equal(await page.locator('#query').inputValue(),'只看修仙');assert.equal(modelCalls(),calls);
  await page.getByRole('button',{name:'关闭偏好识别提示',exact:true}).click();
 });
 await check('independent cookie login restores history while another account sees no private records',async()=>{
  const other=await browser.newContext();try{
   assert.equal((await other.request.get(`${base}/api/v1/me/history`)).status(),401);
   assert.equal((await other.request.post(`${base}/api/v1/auth/login`,{headers,data:{username,password}})).status(),200);assert.equal((await(await other.request.get(`${base}/api/v1/me/history`)).json()).total,2);
   await other.request.post(`${base}/api/v1/auth/register`,{headers,data:{username:`Other_${suffix}`,password,confirm_password:password}});assert.equal((await(await other.request.get(`${base}/api/v1/me/history`)).json()).total,0);assert.equal((await other.request.get(`${base}/api/v1/me/history/${firstId}`)).status(),404);assert.equal((await other.request.delete(`${base}/api/v1/me/history/${firstId}`,{headers})).status(),404);
  }finally{await other.close();}
 });
 await check('history pagination and list/detail layouts work on desktop, tablet and narrow phones',async()=>{
  for(let i=0;i<12;i++)assert.equal((await context.request.post(`${base}/api/v1/me/recommendations`,{headers,data:{preferences:originalPreferences,query:`想看修仙与成长，第 ${i+1} 次发现`}})).status(),200);
  await nav('历史片单');await page.locator('.history-card').first().waitFor();assert.equal(await page.locator('.history-card').count(),12);await page.locator('.toast').waitFor({state:'hidden'});
  for(const [width,height] of [[1920,1080],[1440,1000],[768,1024],[390,844],[320,740]]){
   await page.setViewportSize({width,height});const overflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,elements:[...document.querySelectorAll('main *')].filter(el=>el.getBoundingClientRect().right>innerWidth+1).map(el=>({tag:el.tagName,cls:el.className,right:el.getBoundingClientRect().right})).slice(0,10)}));if(overflow.scroll>width){console.log(JSON.stringify(overflow));await page.screenshot({path:resolve(root,'.local/history-overflow.png'),fullPage:true});}assert.equal(overflow.scroll>width,false);report.viewports.push({surface:'list',width,height,horizontal_overflow:false});
   if(width===1440||width===390)await page.screenshot({path:resolve(shots,`history-list-${width===1440?'desktop':'mobile'}.png`),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});await page.getByRole('button',{name:'下一页',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.history-card').length===2);
  await page.locator('.history-card .secondary-button').first().click();await page.locator('.history-detail').waitFor();
  for(const [width,height] of [[1440,1000],[768,1024],[390,844],[320,740]]){
   await page.setViewportSize({width,height});const overflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,elements:[...document.querySelectorAll('main *')].filter(el=>el.getBoundingClientRect().right>innerWidth+1).map(el=>({tag:el.tagName,cls:el.className,right:el.getBoundingClientRect().right})).slice(0,10)}));if(overflow.scroll>width){console.log(JSON.stringify(overflow));await page.screenshot({path:resolve(root,'.local/history-overflow.png'),fullPage:true});}assert.equal(overflow.scroll>width,false);const columns=await page.locator('.history-preferences').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length);assert.equal(columns,width>760?3:1);report.viewports.push({surface:'detail',width,height,horizontal_overflow:false,preference_columns:columns});
   if(width===1440||width===390)await page.screenshot({path:resolve(shots,`history-detail-${width===1440?'desktop':'mobile'}.png`),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});
 });
 await check('withdrawn and changed works keep their historical positions with clear availability labels',async()=>{
  const detail=await(await context.request.get(`${base}/api/v1/me/history/${nextId}`)).json(),ids=detail.history.items.map(item=>item.id);assert(ids.length>=2);
  const code="import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('UPDATE works SET review_status=? WHERE id=?',('pending',sys.argv[2])); c.execute('UPDATE works SET content_hash=?,summary=? WHERE id=?',('d'*64,'验收用最新资料',sys.argv[3])); c.commit(); c.close()";
  const changed=spawnSync(python,['-X','utf8','-c',code,database,ids[0],ids[1]],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(changed.status,0,changed.stderr);
  await nav('发现好剧');await nav('历史片单');
  // The oldest two records are on page two; newest of those is the next batch.
  await page.getByRole('button',{name:'下一页',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.history-card').length===2);await page.locator('.history-card .secondary-button').first().click();await page.locator('.history-detail').waitFor();
  await page.getByText('作品资料暂不可用，保留当时的片单位置。',{exact:true}).waitFor();await page.getByText('作品资料已更新，以下为当时的推荐理由；详情显示最新资料。',{exact:true}).waitFor();
  await page.locator('.history-works>li').nth(1).getByRole('button',{name:'查看最新作品资料 →',exact:true}).click();await page.locator('.work-dialog[open]').waitFor();assert(await page.locator('.work-dialog').innerText());await page.getByRole('button',{name:'关闭作品详情',exact:true}).click();
 });
 await check('delete requires confirmation, preserves favorites and feedback, and a failed delete can retry',async()=>{
  const detail=await(await context.request.get(`${base}/api/v1/me/history/${nextId}`)).json();const work=detail.history.items.find(item=>item.available);
  await context.request.put(`${base}/api/v1/me/favorites/${work.id}`,{headers});await context.request.patch(`${base}/api/v1/me/feedback/${work.id}`,{headers,data:{status:'watched',expected_revision:null}});
  await page.getByRole('button',{name:'删除这份片单',exact:true}).click();assert.equal(actions.filter(path=>path.includes('/history/')).length,0);await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByRole('button',{name:'删除这份片单',exact:true}).click();await context.route('**/api/v1/me/history/*',route=>route.request().method()==='DELETE'?route.fulfill({status:503,json:{error:{message:'验收模拟：删除失败'}}}):route.continue());
  await page.getByRole('button',{name:'确认删除',exact:true}).click();await page.getByText(/验收模拟：删除失败/).waitFor();assert.equal(await page.locator('.history-detail').count(),1);assert.equal((await context.request.get(`${base}/api/v1/me/history/${nextId}`)).status(),200);
  await context.unroute('**/api/v1/me/history/*');await page.getByRole('button',{name:'确认删除',exact:true}).click();await page.locator('.history-card').first().waitFor();assert.equal((await context.request.get(`${base}/api/v1/me/history/${nextId}`)).status(),404);
  assert.equal((await(await context.request.get(`${base}/api/v1/me/favorites`)).json()).total,1);assert.equal((await(await context.request.get(`${base}/api/v1/me/feedback/state`)).json()).items.length,1);
 });
 await check('list and detail failures expose retry and a page refresh restores only saved snapshots',async()=>{
  await context.route('**/api/v1/me/history?*',route=>route.fulfill({status:503,json:{error:{message:'验收模拟：列表失败'}}}));await page.getByRole('button',{name:'刷新片单',exact:true}).click();await page.getByText(/验收模拟：列表失败/).waitFor();assert((await page.locator('.history-card').count())>0);
  await context.unroute('**/api/v1/me/history?*');await page.getByRole('button',{name:'重试历史片单',exact:true}).click();await page.getByRole('button',{name:'刷新片单',exact:true}).waitFor();
  await context.route('**/api/v1/me/history/*',route=>route.fulfill({status:503,json:{error:{message:'验收模拟：详情失败'}}}));await page.locator('.history-card .secondary-button').first().click();await page.getByText(/验收模拟：详情失败/).waitFor();await context.unroute('**/api/v1/me/history/*');await page.getByRole('button',{name:'重试片单详情',exact:true}).click();await page.locator('.history-detail').waitFor();
  await page.reload();await page.locator('.account-button').getByText(username,{exact:true}).waitFor();await nav('历史片单');await page.locator('.history-card').first().waitFor();assert.equal((await(await context.request.get(`${base}/api/v1/me/history`)).json()).total,13);
 });
 assert.deepEqual(report.page_errors,[]);await writeFile(resolve(root,'docs/history-browser-validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({checks:report.checks.length,viewports:report.viewports.length,page_errors:report.page_errors}));
}finally{await browser?.close();if(server.exitCode===null){server.kill();await Promise.race([new Promise(done=>server.once('exit',done)),pause(3000)]);}log.end();}
