// Real public catalogue copy and baseline parsing; injected failures are labelled.
import {spawn,spawnSync} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const root=fileURLToPath(new URL('..',import.meta.url)),suffix=Date.now().toString(36);
const port=Number(process.env.KIWI_PREFERENCE_TEST_PORT||8007),base=`http://127.0.0.1:${port}`;
const python=resolve(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python'),database=resolve(root,`.local/preference-flow-${suffix}.db`);
const probe=createServer();await new Promise((done,fail)=>{probe.once('error',fail);probe.listen(port,'127.0.0.1',done);});await new Promise(done=>probe.close(done));
const prepared=spawnSync(python,['-X','utf8','scripts/prepare-home-validation.py',database],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(prepared.status,0,prepared.stderr);
const preparation=JSON.parse(prepared.stdout);
const server=spawn(python,['-X','utf8','-m','uvicorn','kiwi.main:app','--host','127.0.0.1','--port',String(port),'--no-proxy-headers','--no-access-log'],
 {cwd:root,env:{...process.env,PREVIEW_AUTO_ENABLED:'false',AI_MODE:'baseline',DATABASE_URL:`sqlite:///${database.replaceAll('\\','/')}`,AUTH_ALLOWED_ORIGINS:base},stdio:['ignore','pipe','pipe'],windowsHide:true});
const log=createWriteStream(resolve(root,`.local/preference-flow-${suffix}.log`));server.stdout.pipe(log);server.stderr.pipe(log);
const report={date:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}),mode:'baseline',database:preparation.database,public_works:preparation.public_works,
 checks:[],viewports:[],page_errors:[],synthetic_faults:['delayed parse','parse 503','delayed recommendation'],external_covers_blocked:true};
const pause=ms=>new Promise(done=>setTimeout(done,ms)),shots=resolve(root,'docs/screenshots');
let browser;
async function check(name,run){await run();report.checks.push(name);console.log(`Passed: ${name}`);}
try{
 let ready=false;for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('Isolated validation server exited');try{ready=(await(await fetch(`${base}/health/ready`)).json()).mode==='baseline';}catch{}if(ready)break;await pause(200);}assert(ready);
 browser=await chromium.launch({channel:process.env.KIWI_BROWSER_CHANNEL||'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1100},reducedMotion:'reduce'});
 await context.route('**/*',route=>route.request().resourceType()==='image'&&new URL(route.request().url()).origin!==base?route.abort():route.continue());
 const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>report.page_errors.push(error.message));
 const actions=[];page.on('request',request=>{if(request.method()==='POST')actions.push({path:new URL(request.url()).pathname,body:request.postDataJSON()});});
 const parseCount=()=>actions.filter(action=>action.path==='/api/v1/preferences/parse').length;
 const recommendationCount=()=>actions.filter(action=>action.path==='/api/v1/recommendations').length;
 const modal=page.locator('.recognition-dialog'),notice=()=>page.locator('.recognition-dialog[open]');
 await mkdir(shots,{recursive:true});await page.goto(base);await page.getByRole('button',{name:'登录 / 注册',exact:true}).waitFor();await page.locator('.favorite-prompt-examples button').first().waitFor();
 await check('balanced composer layout and readable preferences from 320 to 2184 pixels',async()=>{
  for(const [width,height] of [[2184,1100],[1440,1100],[1024,1000],[768,1024],[390,844],[320,740]]){
   await page.setViewportSize({width,height});
   const metrics=await page.locator('.composer-grid').evaluate(el=>{
    const q=el.querySelector('.query-column').getBoundingClientRect(),p=el.querySelector('.taste-panel').getBoundingClientRect(),t=el.querySelector('textarea').getBoundingClientRect();
    return {query_width:q.width,preferences_width:p.width,input_width:t.width,input_height:t.height,same_row:Math.abs(q.top-p.top)<2,
     horizontal_overflow:document.documentElement.scrollWidth>innerWidth,panel_overflow:el.querySelector('.taste-panel').scrollWidth>el.querySelector('.taste-panel').clientWidth+1};
   });
   assert(!metrics.horizontal_overflow&&!metrics.panel_overflow);assert(metrics.input_height>=100&&metrics.input_height<=210);
   if(width>=768){assert(metrics.same_row);assert(metrics.preferences_width>=metrics.query_width*.95);assert(metrics.input_width<=720);}
   else assert(!metrics.same_row);
   report.viewports.push({width,height,...metrics});
   if(width===2184||width===1440||width===390)await page.locator('.composer').screenshot({path:resolve(shots,`preference-composer-${width===2184?'wide':width===1440?'desktop':'mobile'}.png`)});
  }
  assert.equal(actions.length,0);
 });
 await page.setViewportSize({width:1440,height:1100});
 await check('parsing shows recognition progress, not empty-result skeletons; success requires confirmation',async()=>{
  let release;const gate=new Promise(done=>release=done);
  await context.route('**/api/v1/preferences/parse',async route=>{await gate;await route.fulfill({response:await route.fetch()});});
  await page.locator('#query').fill('只看修仙，偏好逆袭，不要后宫');await page.getByRole('button',{name:'理解我的口味',exact:true}).click();
  await page.locator('.parse-progress').waitFor();assert.equal(await page.locator('.skeleton').count(),0);assert.equal(await notice().count(),0);assert.equal(recommendationCount(),0);
  assert.equal(await page.locator('.parse-progress-icon').evaluate(el=>getComputedStyle(el).animationName),'none');
  release();await notice().waitFor();assert.equal(await page.locator('#recognition-title').innerText(),'您的偏好已识别');
  assert((await modal.innerText()).includes('如有不符可手动调整'));assert.equal(await modal.locator('.preference-group').count(),3);
  assert(await modal.getByRole('button',{name:'核对无误，生成片单',exact:true}).evaluate(el=>el===document.activeElement));
  assert.equal(recommendationCount(),0);assert.equal(await page.locator('.results-section .drama-card').count(),0);
  for(const [width,height] of [[1440,1100],[390,844],[320,740]]){
   await page.setViewportSize({width,height});assert(await modal.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&el.scrollWidth<=el.clientWidth+1;}));
   if(width!==320)await modal.screenshot({path:resolve(shots,`preference-recognition-${width===1440?'desktop':'mobile'}.png`)});
  }
  await context.unroute('**/api/v1/preferences/parse');
 });
 await check('Escape preserves preferences and shows an explicit waiting state; manual edits are used without reparsing',async()=>{
  await page.keyboard.press('Escape');await notice().waitFor({state:'hidden'});await page.locator('.confirmation-guide').waitFor();assert.equal(recommendationCount(),0);
  assert((await page.locator('.confirmation-guide').innerText()).includes('等待你确认'));
  await page.setViewportSize({width:2184,height:1100});await page.locator('.composer').screenshot({path:resolve(shots,'preference-confirmation-wide.png')});
  await page.getByRole('button',{name:'再次核对偏好',exact:true}).click();await modal.getByRole('button',{name:'手动调整偏好',exact:true}).click();
  await page.locator('.preference-dialog[open]').waitFor();assert.equal(await notice().count(),0);
  await page.locator('.preference-editor fieldset').filter({has:page.locator('legend').filter({hasText:'偏好题材'})}).getByLabel('都市',{exact:true}).check();
  await page.locator('.preference-editor').getByLabel('不要后宫',{exact:true}).uncheck();
  await page.getByRole('button',{name:'确认修改',exact:false}).click();await page.locator('.preference-dialog[open]').waitFor({state:'hidden'});
  assert.equal(parseCount(),1);assert.equal(recommendationCount(),0);assert((await page.locator('.taste-panel .preference-summary').innerText()).includes('都市'));
  let release;const gate=new Promise(done=>release=done);await context.route('**/api/v1/recommendations',async route=>{await gate;await route.fulfill({response:await route.fetch()});});
  await page.locator('#recommend-button').click();await page.locator('.skeleton').first().waitFor();assert.equal(await page.locator('.skeleton').count(),3);assert.equal(await page.locator('.parse-progress').count(),0);
  release();await page.locator('.skeleton').first().waitFor({state:'hidden'});await page.locator('.results-section .drama-card').first().waitFor();
  const payload=actions.find(action=>action.path==='/api/v1/recommendations').body;
  assert(payload.preferences.soft_preferences.genres.includes('都市'));assert(payload.preferences.required.some(item=>item.field==='genres'&&item.value==='修仙'));assert.deepEqual(payload.preferences.excluded_features,[]);
  assert.equal(parseCount(),1);assert.equal(recommendationCount(),1);await context.unroute('**/api/v1/recommendations');
 });
 await check('parse failure retains input, reports an error and allows explicit retry without a success notice',async()=>{
  await page.locator('#query').fill('想看都市成长');await context.route('**/api/v1/preferences/parse',route=>route.fulfill({status:503,json:{error:{message:'验收模拟：偏好识别暂时不可用'}}}));
  await page.getByRole('button',{name:'理解我的口味',exact:true}).click();await page.locator('.query-column .field-error').waitFor();
  assert.equal(await notice().count(),0);assert.equal(await page.locator('#query').inputValue(),'想看都市成长');assert.equal(await page.locator('.skeleton').count(),0);assert.equal(recommendationCount(),1);
  await context.unroute('**/api/v1/preferences/parse');await page.getByRole('button',{name:'理解我的口味',exact:true}).click();await notice().waitFor();assert.equal(await page.locator('.query-column .field-error').count(),0);await page.keyboard.press('Escape');
 });
 await check('a parse completing after navigation cannot open a notice over the catalogue',async()=>{
  let release,finished;const gate=new Promise(done=>release=done),completion=new Promise(done=>finished=done);
  await context.route('**/api/v1/preferences/parse',async route=>{await gate;await route.fulfill({response:await route.fetch()});finished();});
  await page.locator('#query').fill('想看修仙成长');await page.getByRole('button',{name:'理解我的口味',exact:true}).click();await page.locator('.parse-progress').waitFor();
  await page.getByRole('button',{name:/片库/}).click();await page.locator('.catalog-heading').waitFor();release();await completion;
  await page.waitForFunction(()=>!document.querySelector('#recommend-button'));assert.equal(await notice().count(),0);
  await page.getByRole('button',{name:/发现好剧/}).click();await page.locator('.confirmation-guide').waitFor();assert.equal(await notice().count(),0);await context.unroute('**/api/v1/preferences/parse');
 });
 await check('unsupported constraints prompt adjustment and prevent keyboard generation',async()=>{
  await page.locator('#query').fill('想看修仙，必须已经完结');await page.getByRole('button',{name:'理解我的口味',exact:true}).click();await notice().waitFor();
  assert.equal(await page.locator('#recognition-title').innerText(),'有些偏好需要调整');assert(await modal.getByRole('button',{name:'核对无误，生成片单',exact:true}).isDisabled());
  assert(await page.locator('#recommend-button').isDisabled());await page.keyboard.press('Escape');await page.locator('#query').press('Control+Enter');await notice().waitFor();assert.equal(recommendationCount(),1);
  await modal.getByRole('button',{name:'手动调整偏好',exact:true}).click();await page.locator('.editor-warning button').first().click();await page.getByRole('button',{name:'确认修改',exact:false}).click();assert(await page.locator('#recommend-button').isEnabled());
 });
 assert(!actions.some(action=>/feedback|batch/.test(action.path)),'Feedback and batch switching remain design-only');assert.deepEqual(report.page_errors,[]);
 await writeFile(resolve(root,'docs/preference-flow-browser-validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({checks:report.checks.length,viewports:report.viewports.length,page_errors:report.page_errors}));
}finally{
 await browser?.close();if(server.exitCode===null){server.kill();await Promise.race([new Promise(done=>server.once('exit',done)),pause(3000)]);}log.end();
}
