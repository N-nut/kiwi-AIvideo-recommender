// Real catalogue copy plus an explicitly synthetic judgment/reason display case.
import {createRequire} from 'node:module';
import {spawn,spawnSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{chromium}=require(process.env.KIWI_PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('..',import.meta.url)),suffix=Date.now().toString(36),port=Number(process.env.KIWI_DETAIL_TEST_PORT||8004),base=`http://127.0.0.1:${port}`;
const probe=createServer();await new Promise((done,fail)=>{probe.once('error',fail);probe.listen(port,'127.0.0.1',done);});await new Promise(done=>probe.close(done));
const python=resolve(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python'),database=resolve(root,`.local/detail-evidence-${suffix}.db`);
const prepared=spawnSync(python,['-X','utf8','scripts/prepare-home-validation.py',database,'--with-previews'],{cwd:root,encoding:'utf8'});assert.equal(prepared.status,0,prepared.stderr);
const server=spawn(python,['-X','utf8','-m','uvicorn','kiwi.main:app','--host','127.0.0.1','--port',String(port),'--no-proxy-headers','--no-access-log'],
 {cwd:root,env:{...process.env,PREVIEW_AUTO_ENABLED:'false',AI_MODE:'baseline',DATABASE_URL:`sqlite:///${database.replaceAll('\\','/')}`,AUTH_ALLOWED_ORIGINS:base},stdio:'ignore',windowsHide:true});
const report={date:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}),database:JSON.parse(prepared.stdout).database,checks:[],viewports:[],synthetic_judgment_case:true,page_errors:[]};
const pause=ms=>new Promise(done=>setTimeout(done,ms));let browser,page;
async function check(name,run){await run();report.checks.push(name);console.log(`Passed: ${name}`);}
async function open(title){
 const previous=page.locator('.work-dialog[open]');if(await previous.count())await previous.getByRole('button',{name:'关闭作品详情',exact:true}).click();
 await page.locator('.catalog-search input').fill(title);
 const card=page.locator('.catalog-grid .drama-card').filter({has:page.getByRole('heading',{name:title,exact:true})}).first();await card.waitFor();
 await card.getByRole('button',{name:'详情',exact:true}).click();await page.locator('.work-dialog[open]').waitFor();
 return page.locator('.work-dialog');
}
try{
 let available=false;for(let i=0;i<100;i++){try{available=(await(await fetch(`${base}/health/ready`)).json()).mode==='baseline';}catch{}if(available)break;await pause(200);}assert(available);
 browser=await chromium.launch({channel:process.env.KIWI_BROWSER_CHANNEL||'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>report.page_errors.push(error.message));
 await mkdir(resolve(root,'docs/screenshots'),{recursive:true});await page.goto(base,{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:/片库/}).click();
 const real=(await(await context.request.get(`${base}/api/v1/works?${new URLSearchParams({q:'谁让这个文盲修仙的'})}`)).json()).items.find(work=>work.title==='谁让这个文盲修仙的');assert(real);
 await check('real source introduction and tags appear once with no empty evidence section',async()=>{
  const dialog=await open(real.title);assert.equal(await dialog.locator('.detail-intro').innerText(),real.original_intro.split('\n\n来源标签：')[0]);
  assert.equal(await dialog.locator('.detail-evidence,.detail-reason,.evidence').count(),0);
  assert.equal(await dialog.locator('.work-dialog-actions a').getAttribute('href'),real.source_url);
  await dialog.screenshot({path:resolve(root,'docs/screenshots/detail-clean-desktop.png')});
 });
 const intro='少年在门派中修行，逐步完成试炼。故事明确无后宫，以冒险成长为主。',tags='来源标签：修仙、成长',quote='故事明确无后宫，以冒险成长为主。';
 const fixture={...real,id:'detail-evidence-fixture',title:'界面验证样本 · 判断与推荐',source_meta:null,source_url:'https://example.org/detail-fixture',cover_url:null,
  original_intro:`${intro}\n\n${tags}`,summary:intro,genres:['修仙'],themes:['成长'],harem:false,romance:null,tragic:null,pace:null,
  reason:'修仙与成长主线符合本次偏好，资料明确无后宫。',reason_mode:'model',evidence_ids:['summary-1','tags-1','harem-1'],
  review_note:'合成界面验证资料，不代表真实作品。',evidence:[{id:'summary-1',field:'summary',quote:intro},{id:'tags-1',field:'genres',quote:tags},{id:'harem-1',field:'harem',quote}]};
 await context.route('**/api/v1/works?**',route=>route.fulfill({json:{items:[fixture],total:1}}));
 await context.route('**/api/v1/works/detail-evidence-fixture/preview',route=>route.fulfill({json:{request_id:'fixture',work_id:fixture.id,status:'missing',preview:null,preparing:false}}));
 await check('only meaningful judgments and reason references remain, with repeated source text linked above',async()=>{
  const dialog=await open(fixture.title);assert.equal(await dialog.locator('.detail-reason p').innerText(),fixture.reason);
  assert.equal(await dialog.locator('.detail-evidence').getAttribute('open'),null);await dialog.locator('.detail-evidence summary').click();
  assert.equal(await dialog.locator('.evidence').count(),2);assert.equal(await dialog.locator('.evidence blockquote').count(),1);
  assert.equal(await dialog.locator('.evidence blockquote').innerText(),quote);assert.equal(await dialog.locator('.evidence-reference').count(),2);
  assert(!(await dialog.innerText()).includes('summary-1'));await dialog.screenshot({path:resolve(root,'docs/screenshots/detail-evidence-desktop.png')});
 });
 await check('desktop, tablet and narrow phone layouts wrap correctly with visible close and action buttons',async()=>{
  for(const [width,height] of [[1440,1000],[768,1024],[390,844],[320,740]]){
   await page.setViewportSize({width,height});const dialog=await open(fixture.title);await dialog.locator('.detail-evidence summary').click();
   const bounds=await dialog.evaluate(el=>{const r=el.getBoundingClientRect(),body=el.querySelector('.work-dialog-scroll');return {left:r.left,right:r.right,bodyOverflow:body.scrollWidth>body.clientWidth+1,pageOverflow:document.documentElement.scrollWidth>innerWidth};});
   assert(bounds.left>=0&&bounds.right<=width+1&&!bounds.bodyOverflow&&!bounds.pageOverflow);assert(await dialog.getByRole('button',{name:'关闭作品详情',exact:true}).isVisible());
   report.viewports.push({width,height,...bounds});
   if(width===390){await dialog.locator('.evidence blockquote').scrollIntoViewIfNeeded();await page.screenshot({path:resolve(root,'docs/screenshots/detail-evidence-mobile.png')});}
  }
 });
 await check('reference links move focus to the original text and reopening resets the collapsed state',async()=>{
  const dialog=page.locator('.work-dialog');await dialog.locator('.evidence-reference').first().click();
  assert(await dialog.locator('.detail-intro').evaluate(el=>el===document.activeElement));
  await open(fixture.title);assert.equal(await dialog.locator('.detail-evidence').getAttribute('open'),null);
  await dialog.locator('.detail-evidence summary').focus();await page.keyboard.press('Enter');assert.notEqual(await dialog.locator('.detail-evidence').getAttribute('open'),null);
 });
 await check('switching back to a real work removes synthetic explanations and preserves source actions',async()=>{
  await context.unroute('**/api/v1/works?**');await page.setViewportSize({width:390,height:844});const dialog=await open(real.title);
  assert.equal(await dialog.locator('.detail-reason,.detail-evidence').count(),0);assert.equal(await dialog.locator('.work-dialog-actions a').getAttribute('href'),real.source_url);
  await page.screenshot({path:resolve(root,'docs/screenshots/detail-clean-mobile.png')});assert.deepEqual(report.page_errors,[]);
 });
 await writeFile(resolve(root,'docs/detail-evidence-validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({checks:report.checks.length,viewports:report.viewports.length,page_errors:report.page_errors}));
}finally{
 if(page&&report.checks.length<5)await page.screenshot({path:resolve(root,'.local/detail-evidence-failure.png')}).catch(()=>{});
 await browser?.close();if(server.exitCode===null){server.kill();await Promise.race([new Promise(done=>server.once('exit',done)),pause(3000)]);}
}
