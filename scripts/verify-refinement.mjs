// All writes go to a new synthetic database; no live models or business accounts.
import {spawn,spawnSync} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const root=fileURLToPath(new URL('..',import.meta.url)),suffix=Date.now().toString(36),port=Number(process.env.KIWI_REFINEMENT_TEST_PORT||8012),base=`http://127.0.0.1:${port}`;
const python=resolve(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python'),database=resolve(root,`.local/refinement-${suffix}.db`);
const probe=createServer();await new Promise((done,fail)=>{probe.once('error',fail);probe.listen(port,'127.0.0.1',done);});await new Promise(done=>probe.close(done));
const seeded=spawnSync(python,['-X','utf8','scripts/prepare-refinement-validation.py',database],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(seeded.status,0,seeded.stderr);
const server=spawn(python,['-X','utf8','-m','uvicorn','kiwi.main:app','--host','127.0.0.1','--port',String(port),'--no-proxy-headers','--no-access-log'],{cwd:root,env:{...process.env,PREVIEW_AUTO_ENABLED:'false',AI_MODE:'baseline',DATABASE_URL:`sqlite:///${database.replaceAll('\\','/')}`,AUTH_ALLOWED_ORIGINS:base,PREFERENCE_REFINE_IP_LIMIT:'20'},stdio:['ignore','pipe','pipe'],windowsHide:true});
const log=createWriteStream(resolve(root,`.local/refinement-${suffix}.log`));server.stdout.pipe(log);server.stderr.pipe(log);
const report={date:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}),mode:'baseline',...JSON.parse(seeded.stdout),checks:[],viewports:[],page_errors:[],synthetic_accounts:true};
const pause=ms=>new Promise(done=>setTimeout(done,ms)),headers={Origin:base,'X-Kiwi-Request':'1'},shots=resolve(root,'docs/screenshots');let browser;
async function check(name,run){await run();report.checks.push(name);console.log(`Passed: ${name}`);}
try{
 let ready=false;for(let i=0;i<80;i++){if(server.exitCode!==null)throw Error('Validation server exited');try{ready=(await(await fetch(`${base}/health/ready`)).json()).mode==='baseline';}catch{}if(ready)break;await pause(200);}assert(ready);
 browser=await chromium.launch({channel:process.env.KIWI_BROWSER_CHANNEL||'msedge',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>report.page_errors.push(error.message));
 await context.route('**/*',route=>route.request().resourceType()==='image'&&new URL(route.request().url()).origin!==base?route.abort():route.continue());
 const actions=[];page.on('request',request=>{const path=new URL(request.url()).pathname;if(request.method()==='POST')actions.push({path,body:request.postDataJSON()});});
 const recs=()=>actions.filter(a=>a.path.endsWith('/recommendations')),refines=()=>actions.filter(a=>a.path.endsWith('/preferences/refine'));
 const cards=()=>page.locator('.results-section .drama-card'),dialog=()=>page.locator('.refinement-dialog[open]');
 const nav=name=>page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:new RegExp(name)}).click();
 async function understand(text){await page.locator('#refinement-text').fill(text);await page.getByRole('button',{name:'理解本次调整',exact:true}).click();await dialog().waitFor();}
 async function apply(){await dialog().getByRole('button',{name:'确认调整并推荐',exact:true}).click();await dialog().waitFor({state:'hidden'});}
 await page.goto(base);await page.getByRole('button',{name:'登录 / 注册',exact:true}).waitFor();await mkdir(shots,{recursive:true});
 await check('first parsing is not an executed baseline; explicit first recommendation activates refinement',async()=>{
  assert.equal(await page.locator('.refinement-composer').count(),0);await page.locator('#query').fill('想看修仙，不要后宫');await page.locator('#recommend-button').click();await page.locator('.recognition-dialog[open]').waitFor();assert.equal(await page.locator('.refinement-composer').count(),0);
  await page.locator('.recognition-dialog .primary-button').click();await cards().first().waitFor();await page.locator('#refinement-text').waitFor();assert.equal(await cards().count(),3);
 });
 await check('understanding and Esc do not generate; append applies only after a separate confirmation',async()=>{
  const count=recs().length;await understand('加点重生');assert.equal(recs().length,count);assert((await dialog().textContent()).includes('保持不变'));assert((await dialog().textContent()).includes('调整后的完整偏好'));await page.keyboard.press('Escape');await dialog().waitFor({state:'hidden'});assert.equal(recs().length,count);
  await understand('加点重生');await apply();assert.equal(recs().length,count+1);assert.deepEqual(recs().at(-1).body.exclude_work_ids,[]);assert.deepEqual(recs().at(-1).body.preferences.excluded_features,['harem']);assert((await page.locator('.taste-panel').textContent()).includes('重生'));assert.equal(await page.locator('#query').inputValue(),'想看修仙，不要后宫');
 });
 await check('successive adjustments use the committed base and canceled exclusions never return',async()=>{
  await understand('一定要节奏快');assert.deepEqual(refines().at(-1).body.base_preferences.soft_preferences.themes,['重生']);await apply();
  await understand('取消不要后宫');await apply();assert.deepEqual(recs().at(-1).body.preferences.excluded_features,[]);
  await understand('加点穿越');await apply();assert.deepEqual(recs().at(-1).body.preferences.excluded_features,[]);assert.deepEqual(recs().at(-1).body.preferences.soft_preferences.themes,['穿越','重生']);assert.deepEqual(recs().at(-1).body.preferences.required,[{field:'pace',value:'快'}]);
 });
 await check('repeated conditions do not generate or reset next-batch exclusions',async()=>{
  const count=recs().length;await page.locator('#refinement-text').fill('加点重生');await page.getByRole('button',{name:'理解本次调整',exact:true}).click();await page.getByText('条件没有变化，当前片单与去重记录已保留。',{exact:true}).waitFor();assert.equal(recs().length,count);
  await page.getByRole('button',{name:'换一批',exact:true}).click();await page.waitForResponse(r=>r.url().endsWith('/recommendations')&&r.status()===200);assert.equal(recs().at(-1).body.exclude_work_ids.length,3);
 });
 await check('failed generation keeps the old cards and conditions, with a working explicit retry',async()=>{
  const previous=await cards().allTextContents();await understand('偏好题材改成都市，其他不变');let failed=false;
  const fault=async route=>{if(!failed){failed=true;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'合成生成失败'}})});}else await route.continue();};await page.route('**/api/v1/recommendations',fault);
  await dialog().getByRole('button',{name:'确认调整并推荐',exact:true}).click();await dialog().getByText(/生成失败：/).waitFor();assert.deepEqual(await cards().allTextContents(),previous);assert(!(await page.locator('.taste-panel').textContent()).includes('都市'));
  await apply();assert((await page.locator('.taste-panel').textContent()).includes('都市'));await page.unroute('**/api/v1/recommendations',fault);
 });
 await check('unknown mixed clauses remain uncommitted; manual review and keyboard confirmation remain separate',async()=>{
  const count=recs().length;await understand('加点重生，必须完结');assert.equal(recs().length,count);assert.equal(await dialog().getByRole('button',{name:'确认调整并推荐',exact:true}).isDisabled(),true);
  await dialog().getByRole('button',{name:'手动调整',exact:true}).click();await dialog().getByRole('checkbox',{name:'悬疑',exact:true}).first().check();await dialog().getByRole('button',{name:/确认修改/}).click();assert.equal(recs().length,count);await page.keyboard.press('Escape');
 });
 await check('review fits desktop, tablet and narrow phones, supports keyboard Esc, and has disabled pointer feedback',async()=>{
  for(const [width,height] of [[320,740],[390,844],[768,1024],[1440,1000]]){
   await page.setViewportSize({width,height});await page.locator('#refinement-text').fill('取消必须节奏快');await page.locator('#refinement-text').press('Control+Enter');await dialog().waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   const bounds=await dialog().boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=width+1);report.viewports.push({width,height,horizontal_overflow:false});
   if(width===390||width===1440)await page.screenshot({path:resolve(shots,`refinement-review-${width}.png`)});await page.keyboard.press('Escape');await dialog().waitFor({state:'hidden'});
  }
  await page.locator('#refinement-text').fill('');assert.equal(await page.getByRole('button',{name:'理解本次调整',exact:true}).evaluate(el=>getComputedStyle(el).cursor),'not-allowed');
 });
 await check('leaving discovery retains committed preferences and text; returning never restores a dismissed prompt',async()=>{
  await understand('取消必须节奏快');await page.keyboard.press('Escape');await page.locator('#refinement-text').fill('加点成长');const count=refines().length;await nav('片库');await nav('发现好剧');assert.equal(await page.locator('#refinement-text').inputValue(),'加点成长');assert.equal(await dialog().count(),0);assert.equal(refines().length,count);
 });
 await check('login clears prior context; confirmed private refinement saves its current text and full preferences',async()=>{
  await page.getByRole('button',{name:'登录 / 注册',exact:true}).click();await page.locator('.auth-switch').click();await page.locator('#auth-username').fill(`Refine_${suffix}`);await page.locator('#auth-password').fill('Synthetic password 123');await page.locator('#auth-confirmation').fill('Synthetic password 123');await page.locator('.auth-dialog button[type=submit]').click();await page.locator('.auth-dialog').waitFor({state:'hidden'});await nav('发现好剧');assert.equal(await page.locator('.refinement-composer').count(),0);
  await page.locator('#recommend-button').click();await page.locator('#refinement-text').waitFor();await understand('取消必须节奏快');await apply();assert.equal(recs().at(-1).path,'/api/v1/me/recommendations');
  const histories=await(await context.request.get(`${base}/api/v1/me/history`)).json(),latest=histories.items[0];assert.equal(histories.total,2);assert.equal(latest.query,'取消必须节奏快');assert.deepEqual(latest.preferences.required,[]);assert.deepEqual(latest.preferences.excluded_features,[]);
  assert.deepEqual((await(await context.request.get(`${base}/api/v1/me/favorites/ids`)).json()).items,[]);assert.deepEqual((await(await context.request.get(`${base}/api/v1/me/feedback/state`)).json()).items,[]);
  const other=await browser.newContext();try{await other.request.post(`${base}/api/v1/auth/register`,{headers,data:{username:`Other_${suffix}`,password:'Synthetic password 123',confirm_password:'Synthetic password 123'}});assert.equal((await(await other.request.get(`${base}/api/v1/me/history`)).json()).total,0);assert.equal((await other.request.get(`${base}/api/v1/me/history/${latest.id}`)).status(),404);}finally{await other.close();}
 });
 await check('refresh clears unsaved adjustment context instead of silently restoring it',async()=>{await page.reload();await page.locator('#query').waitFor();assert.equal(await page.locator('.refinement-composer').count(),0);});
 assert.deepEqual(report.page_errors,[]);await writeFile(resolve(root,'docs/refinement-validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({checks:report.checks.length,viewports:report.viewports.length,page_errors:report.page_errors.length}));
}finally{
 await browser?.close();server.kill();await Promise.race([new Promise(done=>server.once('exit',done)),pause(3000)]);log.end();
}
