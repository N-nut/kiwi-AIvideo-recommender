// Fresh synthetic database, independent browser accounts; no business data/model calls.
import {spawn,spawnSync} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const root=fileURLToPath(new URL('..',import.meta.url)),suffix=Date.now().toString(36),port=Number(process.env.KIWI_REVIEW_TEST_PORT||8014),base=`http://127.0.0.1:${port}`;
const python=resolve(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python'),database=resolve(root,`.local/review-${suffix}.db`),password='Synthetic review password 123';
const probe=createServer();await new Promise((done,fail)=>{probe.once('error',fail);probe.listen(port,'127.0.0.1',done);});await new Promise(done=>probe.close(done));
const prepared=spawnSync(python,['-X','utf8','scripts/prepare-corrections-validation.py',database],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(prepared.status,0,prepared.stderr);
const fixture=JSON.parse(prepared.stdout),headers={Origin:base,'X-Kiwi-Request':'1'};
const server=spawn(python,['-X','utf8','-m','uvicorn','kiwi.main:app','--host','127.0.0.1','--port',String(port),'--no-proxy-headers','--no-access-log'],{cwd:root,env:{...process.env,PREVIEW_AUTO_ENABLED:'false',AI_MODE:'baseline',DATABASE_URL:`sqlite:///${database.replaceAll('\\','/')}`,AUTH_ALLOWED_ORIGINS:base},stdio:['ignore','pipe','pipe'],windowsHide:true});
const log=createWriteStream(resolve(root,`.local/review-${suffix}.log`));server.stdout.pipe(log);server.stderr.pipe(log);
const result={date:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}),mode:'baseline',synthetic_accounts:true,model_calls:0,checks:[],viewports:[],page_errors:[],database_engine:'native SQLite',postgres_concurrency:'not_run'};
const pause=ms=>new Promise(done=>setTimeout(done,ms));let browser;
async function check(name,run){await run();result.checks.push(name);console.log('Passed: '+name);}
async function signIn(context,name){const response=await context.request.post(`${base}/api/v1/auth/login`,{headers,data:{username:name,password}});assert.equal(response.status(),200,await response.text());}
async function overflow(page){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
try{
 let ready=false;for(let i=0;i<80;i++){try{ready=(await(await fetch(`${base}/health/ready`)).json()).mode==='baseline';}catch{}if(ready)break;await pause(200);}assert(ready);
 browser=await chromium.launch({channel:process.env.KIWI_BROWSER_CHANNEL||'msedge',headless:true});
 const reporter=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),reviewer=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),other=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
 const page=await reporter.newPage(),desk=await reviewer.newPage();for(const p of [page,desk]){p.setDefaultTimeout(12000);p.on('pageerror',error=>result.page_errors.push(error.message));}
 await page.goto(base);await page.getByRole('button',{name:'登录 / 注册',exact:true}).waitFor();
 let reportId;
 await check('guest cancels login, retains demand; successful login requires another explicit correction submission',async()=>{
  await page.locator('#query').fill('保留我的观剧需求');await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:/片库/}).click();await page.locator('.poster-button').first().click();await page.getByRole('button',{name:'资料有误？',exact:true}).click();await page.getByRole('button',{name:'关闭登录',exact:true}).click();assert.equal(await page.locator('.work-dialog[open]').count(),1);
  await page.getByRole('button',{name:'资料有误？',exact:true}).click();await page.locator('#auth-username').fill('Reporter');await page.locator('#auth-password').fill(password);await page.locator('.auth-dialog button[type=submit]').click();await page.locator('.correction-dialog[open]').waitFor();
  assert.equal((await(await reporter.request.get(`${base}/api/v1/me/corrections`)).json()).total,0);
  await page.locator('#correction-category').selectOption('plot_fact');await page.locator('#correction-kind').selectOption('unknown');await page.locator('#correction-description').fill('简介没有说明后宫情况，建议恢复未知。');await page.getByRole('button',{name:'提交纠错',exact:true}).click();await page.getByText('已提交，等待审核。',{exact:true}).waitFor();
  const listing=await(await reporter.request.get(`${base}/api/v1/me/corrections`)).json();assert.equal(listing.total,1);reportId=listing.items[0].id;assert.equal((await(await reporter.request.get(`${base}/api/v1/works/review-work-0`)).json()).harem,false);
  await page.getByRole('button',{name:'查看纠错记录',exact:true}).click();await page.locator('.corrections-page').waitFor();assert((await page.locator('.corrections-page').innerText()).includes('待审核'));
 });
 await check('normal and other accounts cannot read review workspace or another person report',async()=>{
  assert.equal((await reporter.request.get(`${base}/api/v1/me/review/corrections`)).status(),403);await signIn(other,'Other');assert.equal((await other.request.get(`${base}/api/v1/me/corrections/${reportId}`)).status(),404);assert.equal((await(await other.request.get(`${base}/api/v1/me/corrections`)).json()).total,0);
 });
 await signIn(reviewer,'Reviewer');await desk.goto(base);await desk.locator('.account-button').click();await desk.getByRole('button',{name:'资料审核工作台',exact:true}).click();await desk.locator('.review-workspace').waitFor();await desk.locator('.review-list button').first().click();await desk.locator('.review-detail').waitFor();await mkdir(resolve(root,'docs/screenshots'),{recursive:true});
 await check('desktop and 320/390/768 screens show source, current values, unknown suggestion and a distinct publication confirmation',async()=>{
  await desk.locator('#review-reason').fill('已核对所列简介，资料未说明后宫；恢复未知，仅核对后宫字段。');
  for(const [width,height] of [[320,740],[390,844],[768,1024],[1440,1000]]){await desk.setViewportSize({width,height});await overflow(desk);await desk.getByRole('button',{name:'核对本次变更',exact:true}).click();await desk.locator('.review-confirm').waitFor();assert((await desk.locator('.review-confirm').innerText()).includes('无 → 未知'));await overflow(desk);if([390,1440].includes(width))await desk.screenshot({path:resolve(root,`docs/screenshots/corrections-review-${width}.png`),fullPage:true});result.viewports.push({width,height,overflow:false});await desk.getByRole('button',{name:'返回修改',exact:true}).click();}
  assert.equal((await(await reviewer.request.get(`${base}/api/v1/works/review-work-0`)).json()).harem,false);
  await desk.getByRole('button',{name:'核对本次变更',exact:true}).click();await desk.getByRole('button',{name:'确认处理并保存',exact:true}).click();await desk.getByText('处理已保存，可重新读取查看最新资料与记录。',{exact:true}).waitFor();
  const current=await(await reviewer.request.get(`${base}/api/v1/works/review-work-0`)).json();assert.equal(current.harem,null);assert.deepEqual(current.review.confirmed_fields,['harem']);assert.equal(current.review.state,'partial');
 });
 await check('submitter sees accepted result and current detail reports only the confirmed field',async()=>{
  await page.getByRole('button',{name:'刷新记录',exact:true}).click();await page.locator('.review-card header span').filter({hasText:'已采纳'}).waitFor();await page.getByRole('button',{name:'查看最新资料／补充关联纠错',exact:true}).click();await page.locator('.work-dialog[open]').waitFor();assert((await page.locator('.detail-review-state').innerText()).includes('已核对字段：后宫'));
  for(const [width,height] of [[320,740],[390,844]]){await page.setViewportSize({width,height});await page.getByRole('button',{name:'资料有误？',exact:true}).click();await page.locator('.correction-dialog[open]').waitFor();await overflow(page);await page.locator('#correction-category').focus();await page.keyboard.press('Tab');await page.keyboard.press('Escape');await page.locator('.correction-dialog').waitFor({state:'hidden'});}
  await page.getByRole('button',{name:'关闭作品详情',exact:true}).click();await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:/发现好剧/}).click();assert.equal(await page.locator('#query').inputValue(),'保留我的观剧需求');
 });
 await check('reviewer proactively creates a report, rejects it with reason and retains append-only events',async()=>{
  await desk.locator('.review-filters select').first().selectOption('works');await desk.locator('.review-list button').first().click();await desk.getByRole('button',{name:'主动建立核对单',exact:true}).click();await desk.locator('.correction-dialog[open]').waitFor();await desk.locator('#correction-description').fill('主动核对该作品名称。');await desk.getByRole('button',{name:'建立核对单',exact:true}).click();await desk.locator('.correction-dialog').waitFor({state:'hidden'});await desk.locator('#review-action').selectOption('reject');await desk.locator('#review-reason').fill('名称与所列来源一致，本次不修正。');await desk.getByRole('button',{name:'核对本次变更',exact:true}).click();await desk.getByRole('button',{name:'确认处理并保存',exact:true}).click();await desk.getByText('处理已保存，可重新读取查看最新资料与记录。',{exact:true}).waitFor();
 });
 assert.deepEqual(result.page_errors,[]);await writeFile(resolve(root,'docs/corrections-browser-validation.json'),JSON.stringify(result,null,2)+'\n');
}finally{if(browser)await browser.close();server.kill();await new Promise(done=>{if(server.exitCode!==null)done();else{server.once('exit',done);setTimeout(done,4000);}});log.end();}
