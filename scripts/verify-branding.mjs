// UI-only verification in a new synthetic database; background preparation disabled.
import {spawn,spawnSync} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const root=fileURLToPath(new URL('..',import.meta.url)),suffix=Date.now().toString(36),port=Number(process.env.KIWI_BRANDING_TEST_PORT||8015),base=`http://127.0.0.1:${port}`;
const python=resolve(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python'),database=resolve(root,`.local/branding-${suffix}.db`);
console.log('Checking isolated test port');
const probe=createServer(socket=>socket.destroy());await new Promise((done,fail)=>{probe.once('error',fail);probe.listen(port,'127.0.0.1',done);});await new Promise(done=>probe.close(done));
console.log('Preparing synthetic fixtures');
const seeded=spawnSync(python,['-X','utf8','scripts/prepare-refinement-validation.py',database],{cwd:root,encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(seeded.status,0,seeded.stderr||String(seeded.error));
const server=spawn(python,['-X','utf8','-m','uvicorn','kiwi.main:app','--host','127.0.0.1','--port',String(port),'--no-proxy-headers','--no-access-log'],{cwd:root,env:{...process.env,PREVIEW_AUTO_ENABLED:'false',AI_MODE:'baseline',DATABASE_URL:`sqlite:///${database.replaceAll('\\','/')}`,AUTH_ALLOWED_ORIGINS:base},stdio:['ignore','pipe','pipe'],windowsHide:true});
const log=createWriteStream(resolve(root,`.local/branding-${suffix}.log`));server.stdout.pipe(log);server.stderr.pipe(log);
const notice='所有短剧来源红果短剧，推荐大家前往红果短剧观看。',report={date:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}),synthetic_database:true,business_database_modified:false,model_calls:0,checks:[],viewports:[],page_errors:[]};
const pause=ms=>new Promise(done=>setTimeout(done,ms));let browser;
async function check(name,run){await run();report.checks.push(name);console.log('Passed: '+name);}
try{
 let ready=false;for(let i=0;i<80;i++){try{ready=(await(await fetch(`${base}/health/ready`)).json()).mode==='baseline';}catch{}if(ready)break;await pause(200);}assert(ready);
 browser=await chromium.launch({channel:process.env.KIWI_BROWSER_CHANNEL||'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(12000);page.on('pageerror',error=>report.page_errors.push(error.message));
 const writes=[];page.on('request',request=>{if(request.method()!=='GET'&&new URL(request.url()).pathname.startsWith('/api/'))writes.push(request.url());});
 await page.goto(base);await page.getByRole('button',{name:'登录 / 注册',exact:true}).waitFor();
 await check('production tab uses the Kiwi SVG icon and requested title',async()=>{
  assert.equal(await page.title(),'奇维 Kiwi · 发现刚好对位的漫剧');
  const icon=await page.evaluate(()=>new Promise((done,fail)=>{const link=document.querySelector('link[rel="icon"]');if(!link)return fail(Error('missing icon'));const img=new Image();img.onload=()=>done({width:img.naturalWidth,height:img.naturalHeight,type:link.type});img.onerror=fail;img.src=link.href;}));assert.equal(icon.type,'image/svg+xml');assert(icon.width>0&&icon.height>0);
 });
 const nav=name=>page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:new RegExp(name)}).click();
 await check('logo slogan, short-drama update label and source notice remain visible across public views',async()=>{
  assert.equal(await page.locator('.brand-slogan').innerText(),'发现刚好对位的漫剧');assert((await page.locator('.catalog-update-button').innerText()).includes('更新短剧库'));
  for(const view of ['发现好剧','片库']){await nav(view);assert.equal(await page.locator('.page-footer .source-attribution').innerText(),notice);}
  await page.locator('.poster-button').first().click();await page.locator('.work-dialog[open]').waitFor();assert.equal(await page.locator('.work-dialog .source-attribution').innerText(),notice);assert(await page.locator('.work-dialog-actions a').getAttribute('href'));assert.equal(await page.locator('.detail-review-state').count(),1);await page.keyboard.press('Escape');
 });
 await mkdir(resolve(root,'docs/screenshots'),{recursive:true});
 await check('320/390/768/1440 layouts keep branding, navigation, notices and detail within viewport',async()=>{
  for(const [width,height] of [[320,740],[390,844],[768,1024],[1440,1000]]){await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.locator('.brand-slogan').waitFor({state:'visible'});if([390,1440].includes(width))await page.screenshot({path:resolve(root,`docs/screenshots/branding-${width}.png`),fullPage:true});await page.locator('.poster-button').first().click();await page.locator('.work-dialog[open]').waitFor();assert.equal(await page.locator('.work-dialog').evaluate(el=>el.scrollWidth>el.clientWidth),false);await page.keyboard.press('Escape');report.viewports.push({width,height,overflow:false});}
 });
 assert.deepEqual(writes,[]);assert.deepEqual(report.page_errors,[]);await writeFile(resolve(root,'docs/branding-validation.json'),JSON.stringify(report,null,2)+'\n');
}finally{await browser?.close();server.kill();await Promise.race([new Promise(done=>{if(server.exitCode!==null)done();else server.once('exit',done);}),pause(3000)]);log.end();}
