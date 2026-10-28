// Public catalogue copy and synthetic accounts/photos only; no business writes.
import {spawn,spawnSync} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const root=fileURLToPath(new URL('..',import.meta.url)),suffix=Date.now().toString(36),port=Number(process.env.KIWI_POLISH_TEST_PORT||8009),base=`http://127.0.0.1:${port}`;
const python=resolve(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python'),database=resolve(root,`.local/profile-polish-${suffix}.db`);
const probe=createServer();await new Promise((done,fail)=>{probe.once('error',fail);probe.listen(port,'127.0.0.1',done);});await new Promise(done=>probe.close(done));
const prepared=spawnSync(python,['-X','utf8','scripts/prepare-home-validation.py',database,'--with-previews'],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(prepared.status,0,prepared.stderr);
const copied=JSON.parse(prepared.stdout),server=spawn(python,['-X','utf8','-m','uvicorn','kiwi.main:app','--host','127.0.0.1','--port',String(port),'--no-proxy-headers','--no-access-log'],{cwd:root,env:{...process.env,PREVIEW_AUTO_ENABLED:'false',AI_MODE:'baseline',DATABASE_URL:`sqlite:///${database.replaceAll(String.fromCharCode(92),'/')}`,AUTH_ALLOWED_ORIGINS:base},stdio:['ignore','pipe','pipe'],windowsHide:true});
const log=createWriteStream(resolve(root,`.local/profile-polish-${suffix}.log`));server.stdout.pipe(log);server.stderr.pipe(log);
const report={date:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}),mode:'baseline',database:copied.database,public_works:copied.public_works,checks:[],viewports:[],page_errors:[],synthetic_photos:true,faults:['profile 503','delayed profile write','delayed feedback write']};
const shots=resolve(root,'docs/screenshots'),pause=ms=>new Promise(done=>setTimeout(done,ms)),headers={Origin:base,'X-Kiwi-Request':'1'};
const username=`Photo_${suffix}`,password='Synthetic photo password 123';let browser;
async function check(name,run){await run();report.checks.push(name);console.log(`Passed: ${name}`);}
try{
 let ready=false;for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('Isolated validation server exited');try{ready=(await(await fetch(`${base}/health/ready`)).json()).mode==='baseline';}catch{}if(ready)break;await pause(200);}assert(ready);
 browser=await chromium.launch({channel:process.env.KIWI_BROWSER_CHANNEL||'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.page_errors.push(error.message));
 await page.goto(base);await page.getByRole('button',{name:'登录 / 注册',exact:true}).waitFor();await page.locator('.featured-poster').waitFor();await mkdir(shots,{recursive:true});
 await check('carousel fills the visual column with a larger poster and previews; feedback is two labelled icons',async()=>{
  for(const [width,height] of [[2384,1100],[1440,1000],[1024,1000],[768,1024],[390,844],[320,740]]){
   await page.setViewportSize({width,height});const metrics=await page.locator('.featured-carousel').evaluate(el=>{
    const copy=el.querySelector('.featured-copy').getBoundingClientRect(),visual=el.querySelector('.featured-visual').getBoundingClientRect(),poster=el.querySelector('.featured-poster').getBoundingClientRect(),box=el.getBoundingClientRect();
    return {horizontal_overflow:document.documentElement.scrollWidth>innerWidth,copy_visual_gap:Math.round(visual.left-copy.right),poster_width:Math.round(poster.width),hero_width:Math.round(box.width),hero_height:Math.round(box.height),thumbnails:getComputedStyle(el.querySelector('.featured-upcoming')).display!=='none'};
   });assert(!metrics.horizontal_overflow);assert(metrics.copy_visual_gap<=280);if(width>=1024){assert(metrics.thumbnails);assert(metrics.poster_width>=170);}else if(width<=390)assert(!metrics.thumbnails);
   assert.equal(await page.locator('.featured-actions .feedback-icon').count(),2);assert.equal(await page.locator('.feedback-menu summary').count(),0);report.viewports.push({surface:'carousel',width,height,...metrics});
   if(width===2384||width===1440||width===390){await page.evaluate(()=>{document.activeElement?.blur();scrollTo(0,0);});await page.locator('.featured-carousel').screenshot({path:resolve(shots,`carousel-polish-${width===2384?'wide':width===1440?'desktop':'mobile'}.png`)});}
  }
 });
 await page.setViewportSize({width:1440,height:1000});await page.locator('#query').fill('保留当前编辑的观剧需求');await page.locator('.account-button').click();await page.locator('.auth-switch').click();await page.locator('#auth-username').fill(username);await page.locator('#auth-password').fill(password);await page.locator('#auth-confirmation').fill(password);await page.locator('.auth-dialog button[type=submit]').click();await page.locator('#space-nickname').waitFor();
 const photoBuffer=Buffer.from(await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;const ctx=canvas.getContext('2d');const gradient=ctx.createLinearGradient(0,0,640,480);gradient.addColorStop(0,'#b8d39c');gradient.addColorStop(1,'#446b54');ctx.fillStyle=gradient;ctx.fillRect(0,0,640,480);ctx.fillStyle='#f3eed9';ctx.beginPath();ctx.arc(320,170,74,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.ellipse(320,400,155,128,0,0,Math.PI*2);ctx.fill();return canvas.toDataURL('image/png').split(',')[1];}),'base64');
 const selectPhoto=()=>page.locator('#avatar-photo-file').setInputFiles({name:'synthetic-photo.png',mimeType:'image/png',buffer:photoBuffer});
 const save=()=>page.getByRole('button',{name:'保存资料',exact:true});
 let storedUrl;
 await check('photo selection is a local draft, cancellation keeps the server untouched, and presets remain selectable',async()=>{
  const requests=[];page.on('request',request=>{if(request.method()==='PATCH'&&request.url().endsWith('/me/profile'))requests.push(request.postDataJSON());});
  await selectPhoto();await page.locator('.space-identity img[src^="data:"]').waitFor();assert(await save().isEnabled());assert.equal(requests.length,0);assert.equal(await page.locator('.avatar-option').count(),6);
  await page.getByRole('button',{name:'取消修改',exact:true}).click();assert.equal(await page.locator('.space-identity img').count(),0);assert.equal(requests.length,0);assert(await save().isDisabled());
  await selectPhoto();await page.locator('.space-identity img[src^="data:"]').waitFor();await page.locator('#space-nickname').fill(`照片_${suffix}`);await save().click();await page.getByText('资料已保存',{exact:true}).waitFor();
  assert.equal(requests.length,1);assert(requests[0].avatar_image&&!requests[0].avatar_id);assert(Buffer.byteLength(JSON.stringify(requests[0]),'utf8')<=24000);
  storedUrl=(await(await context.request.get(`${base}/api/v1/me/profile`)).json()).profile.avatar_url;assert(storedUrl);
  await page.locator('.sidebar .account-avatar img').waitFor();assert(await page.locator('.sidebar .account-avatar img').evaluate(el=>el.complete&&el.naturalWidth===256));
 });
 await check('personal space uses independent columns without an empty row, including narrow screens',async()=>{
  await page.locator('.toast').waitFor({state:'hidden'});
  for(const [width,height] of [[2384,1100],[1440,1000],[768,1024],[390,844],[320,740]]){
   await page.setViewportSize({width,height});const metrics=await page.locator('.space-grid').evaluate(el=>{
    const profile=el.querySelector('.profile-card').getBoundingClientRect(),summary=el.querySelector('.summary-card').getBoundingClientRect(),feedback=el.querySelector('.feedback-entry-card').getBoundingClientRect(),history=el.querySelector('.history-entry-card').getBoundingClientRect();
    return {horizontal_overflow:document.documentElement.scrollWidth>innerWidth,profile_top:Math.round(profile.top),summary_top:Math.round(summary.top),summary_feedback_gap:Math.round(feedback.top-history.bottom),summary_history_gap:Math.round(history.top-summary.bottom),columns:getComputedStyle(el).gridTemplateColumns.split(' ').length};
   });assert(!metrics.horizontal_overflow);assert(metrics.summary_feedback_gap>=12&&metrics.summary_feedback_gap<=24);assert(metrics.summary_history_gap>=12&&metrics.summary_history_gap<=24);if(width>=768)assert(Math.abs(metrics.profile_top-metrics.summary_top)<=3);else assert.equal(metrics.columns,1);report.viewports.push({surface:'personal-space',width,height,...metrics});
   if(width===1440||width===390){await page.evaluate(()=>{document.activeElement?.blur();scrollTo(0,0);});await page.screenshot({path:resolve(shots,`profile-polish-${width===1440?'desktop':'mobile'}.png`),fullPage:true});}
  }
 });
 await page.setViewportSize({width:1440,height:1000});
 await check('a photo survives refresh and an independent login while another account cannot read it',async()=>{
  await page.reload();await page.locator('.sidebar .account-avatar img').waitFor();assert.equal(await page.locator('.sidebar .account-avatar img').getAttribute('src'),storedUrl);await page.locator('#query').fill('保留当前编辑的观剧需求');await page.locator('.account-button').click();await page.locator('#space-nickname').waitFor();
  const second=await browser.newContext();try{
   const login=await second.request.post(`${base}/api/v1/auth/login`,{headers,data:{username,password}});assert.equal(login.status(),200);assert.equal((await login.json()).user.avatar_url,storedUrl);assert.equal((await second.request.get(`${base}${storedUrl}`)).status(),200);
   await second.request.post(`${base}/api/v1/auth/register`,{headers,data:{username:`Other_${suffix}`,password,confirm_password:password}});assert.equal((await second.request.get(`${base}${storedUrl}`)).status(),404);
  }finally{await second.close();}
 });
 await check('preset selection can be cancelled, then explicitly replaces a photo; invalid files leave the confirmed avatar intact',async()=>{
  await page.getByRole('button',{name:'月光头像',exact:true}).click();assert.equal(await page.locator('.space-identity img').count(),0);await page.getByRole('button',{name:'取消修改',exact:true}).click();await page.locator('.space-identity img').waitFor();
  await page.getByRole('button',{name:'月光头像',exact:true}).click();await save().click();await page.getByText('资料已保存',{exact:true}).waitFor();assert.equal((await context.request.get(`${base}${storedUrl}`)).status(),404);assert.equal(await page.locator('.sidebar .account-avatar img').count(),0);
  await page.locator('#avatar-photo-file').setInputFiles({name:'bad.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg/>')});await page.getByText('请选择 JPG、PNG 或 WebP 图片',{exact:true}).waitFor();assert(await save().isDisabled());
  await page.locator('#avatar-photo-file').setInputFiles({name:'big.png',mimeType:'image/png',buffer:Buffer.alloc(5*1024*1024+1)});await page.getByText('照片须小于 5 MB，请重新选择',{exact:true}).waitFor();assert(await save().isDisabled());
 });
 await check('failed photo save retains the preview and can retry; disabled and saving controls use the forbidden cursor',async()=>{
  await selectPhoto();await page.locator('.space-identity img[src^="data:"]').waitFor();await context.route('**/api/v1/me/profile',route=>route.request().method()==='PATCH'?route.fulfill({status:503,json:{error:{message:'验收模拟：保存失败'}}}):route.continue());
  await save().click();await page.getByText('验收模拟：保存失败',{exact:true}).waitFor();assert.equal(await page.locator('.space-identity img[src^="data:"]').count(),1);assert(await save().isEnabled());await context.unroute('**/api/v1/me/profile');
  let release;const gate=new Promise(done=>release=done);await context.route('**/api/v1/me/profile',async route=>{if(route.request().method()==='PATCH')await gate;await route.continue();});
  await save().click();const saving=page.getByRole('button',{name:'正在保存…',exact:true});await saving.waitFor();assert(await saving.isDisabled());assert.equal(await saving.evaluate(el=>getComputedStyle(el).cursor),'not-allowed');release();await page.getByText('资料已保存',{exact:true}).waitFor();await context.unroute('**/api/v1/me/profile');assert.equal(await save().evaluate(el=>getComputedStyle(el).cursor),'not-allowed');
  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:/发现好剧/}).click();assert.equal(await page.locator('#query').inputValue(),'保留当前编辑的观剧需求');const disabled=page.locator('.taste-heading button');assert(await disabled.isDisabled());assert.equal(await disabled.evaluate(el=>getComputedStyle(el).cursor),'not-allowed');
 });
 await check('both feedback icons disable with a forbidden cursor while saving and do not generate a list',async()=>{
  await page.locator('.featured-actions .feedback-icon').first().waitFor();let release;const gate=new Promise(done=>release=done);
  await context.route('**/api/v1/me/feedback/*',async route=>{if(route.request().method()==='PATCH')await gate;await route.continue();});
  const count=await page.locator('.featured-pages button').count();await page.locator('.featured-actions').getByRole('button',{name:'已看过',exact:true}).click();
  for(const icon of await page.locator('.featured-actions .feedback-icon').all()){assert(await icon.isDisabled());assert.equal(await icon.evaluate(el=>getComputedStyle(el).cursor),'not-allowed');}
  release();await page.waitForFunction(old=>document.querySelectorAll('.featured-pages button').length===old-1,count);await context.unroute('**/api/v1/me/feedback/*');assert.equal(await page.locator('.results-section .drama-card').count(),0);
 });
 assert.deepEqual(report.page_errors,[]);await writeFile(resolve(root,'docs/profile-polish-browser-validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({checks:report.checks.length,viewports:report.viewports.length,page_errors:report.page_errors}));
}finally{await browser?.close();if(server.exitCode===null){server.kill();await Promise.race([new Promise(done=>server.once('exit',done)),pause(3000)]);}log.end();}
