// Only synthetic accounts in a fresh copy of public catalogue/media metadata.
import {spawn,spawnSync} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const root=fileURLToPath(new URL('..',import.meta.url)),suffix=Date.now().toString(36);
const port=Number(process.env.KIWI_SPACE_TEST_PORT||8006),base=`http://127.0.0.1:${port}`;
const python=resolve(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
const database=resolve(root,`.local/personal-space-${suffix}.db`),password='Synthetic space password 123',newPassword='Synthetic changed password 456';
const probe=createServer();await new Promise((done,fail)=>{probe.once('error',fail);probe.listen(port,'127.0.0.1',done);});await new Promise(done=>probe.close(done));
const prepared=spawnSync(python,['-X','utf8','scripts/prepare-home-validation.py',database,'--with-previews'],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(prepared.status,0,prepared.stderr);
const server=spawn(python,['-X','utf8','-m','uvicorn','kiwi.main:app','--host','127.0.0.1','--port',String(port),'--no-proxy-headers','--no-access-log'],
 {cwd:root,env:{...process.env,PREVIEW_AUTO_ENABLED:'false',AI_MODE:'baseline',DATABASE_URL:`sqlite:///${database.replaceAll('\\','/')}`,AUTH_ALLOWED_ORIGINS:base},stdio:['ignore','pipe','pipe'],windowsHide:true});
const log=createWriteStream(resolve(root,`.local/personal-space-${suffix}.log`));server.stdout.pipe(log);server.stderr.pipe(log);
const preparation=JSON.parse(prepared.stdout);
const report={date:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}),database:preparation.database,public_works:preparation.public_works,
 ready_previews:preparation.ready_work_ids.length,synthetic_accounts_only:true,mode:'baseline',checks:[],viewports:[],page_errors:[],external_covers_blocked:true};
let browser;const pause=ms=>new Promise(done=>setTimeout(done,ms));
const headers={'Origin':base,'X-Kiwi-Request':'1'};
async function check(name,run){await run();report.checks.push(name);console.log(`Passed: ${name}`);}
async function signIn(page,name,register=false,pass=password){
 await page.locator('.account-button').click();if(register)await page.locator('.auth-switch').click();
 await page.locator('#auth-username').fill(name);await page.locator('#auth-password').fill(pass);
 if(register)await page.locator('#auth-confirmation').fill(pass);
 await page.locator('.auth-dialog button[type=submit]').click();await page.locator('.auth-dialog').waitFor({state:'hidden'});
 await page.locator('.personal-space').waitFor();await page.locator('#space-nickname').waitFor();
}
async function discover(page){await page.getByRole('button',{name:/发现好剧/}).first().click();await page.locator('#query').waitFor();}
async function passwordForm(page,current,next){
 await page.getByRole('button',{name:'修改密码',exact:true}).click();
 await page.locator('#space-current_password').fill(current);await page.locator('#space-new_password').fill(next);await page.locator('#space-confirm_password').fill(next);
 await page.getByRole('button',{name:'确认修改密码',exact:true}).click();
}
try{
 let ready=false;for(let i=0;i<100;i++){try{ready=(await(await fetch(`${base}/health/ready`)).json()).mode==='baseline';}catch{}if(ready)break;await pause(200);}assert(ready,'Isolated server failed to start');
 browser=await chromium.launch({channel:process.env.KIWI_BROWSER_CHANNEL||'msedge',headless:true});
 const contextA=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),contextB=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
 for(const context of [contextA,contextB])await context.route('**/*',route=>route.request().resourceType()==='image'&&new URL(route.request().url()).origin!==base?route.abort():route.continue());
 const page=await contextA.newPage(),other=await contextB.newPage();
 for(const p of [page,other]){p.setDefaultTimeout(12000);p.on('pageerror',error=>report.page_errors.push(error.message));await p.goto(base);await p.getByRole('button',{name:'登录 / 注册',exact:true}).waitFor();}
 const accountA=`spaceA_${suffix}`,accountB=`spaceB_${suffix}`;
 await check('guest login cancel preserves viewing input; registration opens the personal space',async()=>{
  await page.locator('#query').fill('想看修仙成长');await page.locator('.account-button').click();await page.getByRole('button',{name:'关闭登录',exact:true}).click();assert.equal(await page.locator('#query').inputValue(),'想看修仙成长');
  await signIn(page,accountA,true);assert(!(await page.locator('.personal-space').innerText()).includes('注册时间'));
  assert.equal(await page.locator('.space-total strong').innerText(),'0');assert.equal(await page.locator('#password-form').count(),0);
 });
 const nickname=`Kiwi_${suffix}`;
 await check('keyboard avatar selection, atomic profile saving, cancel and cross-browser persistence',async()=>{
  await page.locator('#space-nickname').fill(nickname);await page.getByRole('button',{name:'月光头像',exact:true}).focus();await page.keyboard.press('Enter');
  assert.equal(await page.getByRole('button',{name:'月光头像',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'保存资料',exact:true}).click();await page.getByText('资料已保存',{exact:true}).waitFor();assert.equal(await page.locator('.account-button').innerText(),nickname);
  await page.locator('#space-nickname').fill('Unsaved');await page.getByRole('button',{name:'取消修改',exact:true}).click();assert.equal(await page.locator('#space-nickname').inputValue(),nickname);
  await page.reload();await page.locator('.account-button').filter({hasText:nickname}).waitFor();await page.locator('.account-button').click();await page.locator('#space-nickname').waitFor();assert.equal(await page.locator('#space-nickname').inputValue(),nickname);
  await signIn(other,accountA);assert.equal(await other.locator('#space-nickname').inputValue(),nickname);assert.equal(await other.getByRole('button',{name:'月光头像',exact:true}).getAttribute('aria-pressed'),'true');
 });
 await check('normal logout preserves another session; separate account sees no private profile and cannot take the nickname',async()=>{
  await other.getByRole('button',{name:'退出登录',exact:true}).click();await other.getByRole('button',{name:'登录 / 注册',exact:true}).waitFor();
  assert.equal((await page.request.get(`${base}/api/v1/me/profile`)).status(),200);
  await signIn(other,accountB,true);assert.equal(await other.locator('#space-nickname').inputValue(),'');
  await other.locator('#space-nickname').fill(nickname.toUpperCase());await other.getByRole('button',{name:'保存资料',exact:true}).click();await other.getByText('昵称已被使用，请换一个',{exact:false}).first().waitFor();
  assert.equal(await other.locator('#space-nickname').inputValue(),nickname.toUpperCase());
  assert.equal((await(await other.request.get(`${base}/api/v1/me/profile`)).json()).profile.nickname,null);
  await other.getByRole('button',{name:'取消修改',exact:true}).click();
 });
 let favorite;
 await check('real favorite mutation refreshes total and actual interest tags without altering the active list',async()=>{
  await discover(page);await page.locator('#query').fill('想看修仙成长');await page.getByRole('button',{name:'理解我的口味',exact:true}).click();await page.getByRole('button',{name:'确认偏好，生成片单',exact:true}).click();await page.locator('.results-section .skeleton').first().waitFor({state:'hidden'});
  const before={query:await page.locator('#query').inputValue(),chips:await page.locator('.preference-chips').innerText(),titles:await page.locator('.results-section h3').allTextContents()};assert(before.titles.length);
  await page.getByRole('button',{name:/片库/}).click();const data=await(await page.request.get(`${base}/api/v1/works?content_type=${encodeURIComponent('漫剧')}&genre=${encodeURIComponent('修仙')}&page_size=50`)).json();favorite=data.items.find(w=>w.themes.length);assert(favorite);
  await page.locator('#catalog-search').fill(favorite.title);await page.locator('.catalog-search').press('Enter');const card=page.locator('.drama-card').filter({has:page.getByRole('heading',{name:favorite.title,exact:true})}).first();
  await card.locator('.card-favorite:not(:disabled)').click();await card.locator('.card-favorite[aria-pressed=true]').waitFor();
  await page.locator('.account-button').click();await page.getByText('根据 1 部有效剧集收藏整理',{exact:true}).waitFor();assert.equal(await page.locator('.space-total strong').innerText(),'1');assert((await page.locator('.interest-tags').allTextContents()).join(' ').includes('修仙'));
  await discover(page);assert.equal(await page.locator('#query').inputValue(),before.query);assert.equal(await page.locator('.preference-chips').innerText(),before.chips);assert.deepEqual(await page.locator('.results-section h3').allTextContents(),before.titles);
  await page.locator('.account-button').click();await page.locator('#space-nickname').waitFor();
 });
 await check('module failures preserve confirmed counts, drafts and allow independent retry',async()=>{
  await page.locator('#space-nickname').fill('Keep this draft');await contextA.route('**/api/v1/me/space-summary',route=>route.fulfill({status:503,json:{error:{message:'验收模拟概览异常'}}}));
  await page.getByRole('button',{name:'刷新概览',exact:true}).click();await page.getByText('验收模拟概览异常',{exact:false}).waitFor();assert.equal(await page.locator('.space-total strong').innerText(),'1');assert.equal(await page.locator('#space-nickname').inputValue(),'Keep this draft');
  await contextA.unroute('**/api/v1/me/space-summary');await page.getByRole('button',{name:'重试概览与画像',exact:true}).click();await page.getByText('验收模拟概览异常',{exact:false}).waitFor({state:'hidden'});await page.getByRole('button',{name:'取消修改',exact:true}).click();
 });
 await check('personal space is readable on desktop, tablet and narrow phones, with keyboard forms',async()=>{
  await mkdir(resolve(root,'docs/screenshots'),{recursive:true});
  await page.locator('.toast').waitFor({state:'hidden'});
  for(const [width,height] of [[1440,1000],[768,1024],[390,844],[320,740]]){
   await page.setViewportSize({width,height});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   const modules=await page.locator('.space-card').evaluateAll(elements=>elements.every(el=>el.scrollWidth<=el.clientWidth+1));assert(modules);report.viewports.push({width,height,horizontal_overflow:false});
   if(width===1440||width===390)await page.screenshot({path:resolve(root,`docs/screenshots/personal-space-${width===1440?'desktop':'mobile'}.png`),fullPage:true});
  }
  await page.getByRole('button',{name:'修改密码',exact:true}).focus();await page.keyboard.press('Enter');await page.locator('#space-current_password').fill('not saved');
  await discover(page);await page.locator('.account-button').click();await page.locator('#space-nickname').waitFor();assert.equal(await page.locator('#password-form').count(),0);
 });
 await check('wrong current password preserves login; successful change revokes all old sessions and preserves data',async()=>{
  await other.getByRole('button',{name:'退出登录',exact:true}).click();await other.getByRole('button',{name:'登录 / 注册',exact:true}).waitFor();await signIn(other,accountA);
  await passwordForm(page,'incorrect password',newPassword);await page.getByText('当前密码不正确',{exact:true}).first().waitFor();assert.equal((await page.request.get(`${base}/api/v1/me/profile`)).status(),200);
  await page.locator('#space-current_password').fill(password);await page.getByRole('button',{name:'确认修改密码',exact:true}).click();await page.getByText('密码已修改，请重新登录',{exact:false}).waitFor();await page.locator('#query').waitFor();assert.equal(await page.locator('#query').inputValue(),'想看修仙成长');
  assert.equal((await other.request.get(`${base}/api/v1/me/profile`)).status(),401);await other.getByRole('button',{name:'重新读取资料',exact:true}).click();await other.getByRole('button',{name:'登录 / 注册',exact:true}).waitFor();assert.equal(await other.locator('.personal-space').count(),0);
  const failed=await other.request.post(`${base}/api/v1/auth/login`,{headers,data:{username:accountA,password}});assert.equal(failed.status(),401);
  await signIn(other,accountA,false,newPassword);assert.equal(await other.locator('#space-nickname').inputValue(),nickname);assert.equal(await other.locator('.space-total strong').innerText(),'1');
  assert.equal((await(await other.request.get(`${base}/api/v1/me/favorites/ids`)).json()).relation_total,1);
 });
 await check('guest catalogue and ready real previews continue to work',async()=>{
  await page.getByRole('button',{name:/片库/}).click();await page.locator('.drama-card').first().waitFor();
  const id=preparation.ready_work_ids[0];assert(id,'Need one already-ready public preview sample');report.tested_preview=id;
  const preview=await(await page.request.get(`${base}/api/v1/works/${id}/preview`)).json();assert.equal(preview.status,'ready');
  const media=await page.request.get(`${base}${preview.preview.video_url}`,{headers:{Range:'bytes=0-9'}});assert.equal(media.status(),206);assert.equal((await media.body()).length,10);
 });
 assert.deepEqual(report.page_errors,[]);await writeFile(resolve(root,'docs/personal-space-browser-validation.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({checks:report.checks.length,viewports:report.viewports.length,page_errors:report.page_errors}));
}finally{
 await browser?.close();if(server.exitCode===null){server.kill();await Promise.race([new Promise(done=>server.once('exit',done)),pause(3000)]);}log.end();
}
