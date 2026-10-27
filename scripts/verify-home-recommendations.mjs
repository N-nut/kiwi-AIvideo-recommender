// Real HTTP/UI acceptance against a disposable copy of public works only.
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.KIWI_PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('..',import.meta.url));
const python=resolve(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
const suffix=Date.now().toString(36),port=Number(process.env.KIWI_HOME_TEST_PORT||8001),base=`http://127.0.0.1:${port}`;
const database=resolve(root,`.local/home-recommendations-${suffix}.db`);
// Refuse an occupied port before sending any account operations to a service.
const probe=createServer();
await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(port,'127.0.0.1',resolve);});
await new Promise((resolve,reject)=>probe.close(error=>error?reject(error):resolve()));
await mkdir(resolve(root,'.local'),{recursive:true});
const prepared=spawnSync(python,['-X','utf8','scripts/prepare-home-validation.py',database],{cwd:root,encoding:'utf8'});
assert.equal(prepared.status,0,prepared.stderr);const preparation=JSON.parse(prepared.stdout);
const server=spawn(python,['-X','utf8','-m','uvicorn','kiwi.main:app','--host','127.0.0.1','--port',String(port),'--no-proxy-headers','--no-access-log'],
  {cwd:root,env:{...process.env,PREVIEW_AUTO_ENABLED:'false',AI_MODE:'baseline',DATABASE_URL:`sqlite:///${database.replaceAll('\\','/')}`,AUTH_ALLOWED_ORIGINS:base},stdio:['ignore','pipe','pipe'],windowsHide:true});
const log=createWriteStream(resolve(root,`.local/home-recommendations-${suffix}.log`));server.stdout.pipe(log);server.stderr.pipe(log);
let browser;
const report={date:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}),strategy_version:'favorites-tags-v1',database:preparation.database,public_works:preparation.public_works,
  mode:'baseline',checks:[],viewports:[],page_errors:[],external_covers_blocked:true};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function check(name,test){await test();report.checks.push(name);console.log(`Passed: ${name}`);}
async function defaultPrompts(page){await page.waitForFunction(()=>document.querySelector('#favorite-prompts-title')?.textContent==='换个口味试试：'&&document.querySelectorAll('.favorite-prompt-examples button').length===4);}
async function home(page){await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:/发现好剧/}).click();await page.waitForFunction(()=>!document.querySelector('.featured-status[role=status]')?.textContent.includes('正在加载'));}
async function signIn(page,name,register=false){
  await page.locator('.account-button').click();if(register)await page.locator('.auth-switch').click();
  await page.locator('#auth-username').fill(name);await page.locator('#auth-password').fill('Synthetic browser password 123');
  if(register)await page.locator('#auth-confirmation').fill('Synthetic browser password 123');
  await page.locator('.auth-dialog button[type=submit]').click();await page.locator('.auth-dialog').waitFor({state:'hidden'});
  await page.locator('.account-button').filter({hasText:name}).waitFor();
  await page.locator('.personal-space').waitFor();
  await home(page);
}
async function saveFromCatalog(page,work){
  await page.getByRole('button',{name:/片库/}).click();await page.locator('#catalog-search').fill(work.title);
  await page.locator('.catalog-search').press('Enter');
  const card=page.locator('.drama-card').filter({has:page.getByRole('heading',{name:work.title,exact:true})});
  await card.locator('.card-favorite:not(:disabled)').click();await card.locator('.card-favorite[aria-pressed=true]').waitFor();
}
try{
  let ready=false;
  for(let i=0;i<60;i++){
    if(server.exitCode!==null)throw Error('Isolated validation server exited; see .local log');
    try{const response=await fetch(`${base}/health/ready`);ready=response.ok&&(await response.json()).mode==='baseline';}catch{}
    if(ready)break;await pause(200);
  }
  assert(ready,'Validation server did not become ready');
  browser=await chromium.launch({channel:process.env.KIWI_BROWSER_CHANNEL||'msedge',headless:true});
  const a=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  const b=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce',isMobile:true,hasTouch:true});
  for(const context of [a,b])await context.route('**/*',route=>route.request().resourceType()==='image'&&new URL(route.request().url()).origin!==base?route.abort():route.continue());
  const page=await a.newPage(),mobile=await b.newPage();
  for(const p of [page,mobile])p.on('pageerror',error=>report.page_errors.push(error.message));
  const posts=[];page.on('request',request=>{if(request.method()==='POST')posts.push(new URL(request.url()).pathname);});
  await page.goto(base);await page.getByRole('button',{name:'登录 / 注册',exact:true}).waitFor();await defaultPrompts(page);
  const worksA=await (await page.request.get(`${base}/api/v1/works?genre=${encodeURIComponent('修仙')}&content_type=${encodeURIComponent('漫剧')}&page_size=50`)).json();
  const worksB=await (await page.request.get(`${base}/api/v1/works?genre=${encodeURIComponent('末世')}&content_type=${encodeURIComponent('漫剧')}&page_size=50`)).json();
  const workA=worksA.items.find(w=>w.themes.length),workB=worksB.items.find(w=>w.themes.length);assert(workA&&workB,'Public copy needs two distinct tagged drama styles');
  await check('guest receives real public content and prompts do not auto-submit',async()=>{
    assert.equal(await page.locator('.prompt-example-badge').count(),0);assert.equal(await page.locator('.favorite-prompt-examples button').count(),4);
    const count=posts.length;await page.getByRole('button',{name:'修仙逆袭',exact:true}).click();assert.equal(posts.length,count);
    assert.equal(await page.locator('.generation-guide').count(),1);assert.equal(await page.locator('.drama-card').count(),0);
    const publicData=await (await page.request.get(`${base}/api/v1/home/recommendations`)).json();
    assert.equal(publicData.carousel_mode,'default');assert(publicData.items.length<=6);assert(publicData.items.every(w=>w.basis==='public'));
  });
  const nameA=`homeA_${suffix}`,nameB=`homeB_${suffix}`;
  await check('favorite saves update personalized carousel and tag-derived prompts',async()=>{
    await signIn(page,nameA,true);await defaultPrompts(page);await saveFromCatalog(page,workA);await home(page);
    await page.waitForFunction(()=>document.querySelector('#favorite-prompts-title')?.textContent==='根据您的收藏，猜您喜欢：');
    await page.locator('.featured-label').filter({hasText:'根据收藏推荐'}).waitFor();
    const data=await (await page.request.get(`${base}/api/v1/me/home-recommendations`)).json();
    assert(data.items.every(w=>w.id!==workA.id));assert(data.prompts.every(p=>p.genres.every(g=>workA.genres.includes(g))&&p.themes.every(t=>workA.themes.includes(t))));
    assert.equal(await page.locator('#query').inputValue(),'想看修仙题材，偏好逆袭主题。');
    report.account_a={favorite:workA.id,first:data.items[0]?.id,prompts:data.prompts.map(p=>p.label)};
    await mkdir(resolve(root,'docs/screenshots'),{recursive:true});await page.screenshot({path:resolve(root,'docs/screenshots/home-personalized-desktop.png')});
  });
  await check('second cookie store and different favorite styles remain isolated',async()=>{
    await mobile.goto(base);await mobile.getByRole('button',{name:'登录 / 注册',exact:true}).waitFor();await defaultPrompts(mobile);
    await signIn(mobile,nameB,true);await saveFromCatalog(mobile,workB);await home(mobile);
    await mobile.waitForFunction(()=>document.querySelector('#favorite-prompts-title')?.textContent==='根据您的收藏，猜您喜欢：');
    const data=await (await mobile.request.get(`${base}/api/v1/me/home-recommendations`)).json();
    report.account_b={favorite:workB.id,first:data.items[0]?.id,prompts:data.prompts.map(p=>p.label)};
    assert.notDeepEqual(report.account_a.prompts,report.account_b.prompts);assert.notEqual(report.account_a.first,report.account_b.first);
    const publicWithCookie=await (await mobile.request.get(`${base}/api/v1/home/recommendations`)).json();assert.equal(publicWithCookie.prompts_mode,'default');
    await mobile.screenshot({path:resolve(root,'docs/screenshots/home-personalized-mobile.png')});
  });
  await check('canceling the last favorite restores default and confirmed legacy import refreshes again',async()=>{
    await page.getByRole('button',{name:/我的收藏/}).click();await page.locator('.card-favorite[aria-pressed=true]:not(:disabled)').click();
    await page.getByRole('heading',{name:'还没有收藏作品'}).waitFor();await home(page);await defaultPrompts(page);
    await page.evaluate(id=>localStorage.setItem('kiwi-real-library-v1',JSON.stringify({OldTest:[id]})),workA.id);await page.reload();
    await page.getByRole('button',{name:'导入收藏',exact:true}).waitFor();await defaultPrompts(page);
    await page.getByRole('button',{name:'导入收藏',exact:true}).click();await page.getByText(/导入完成：新增 1 部/).waitFor();
    await page.waitForFunction(()=>document.querySelector('#favorite-prompts-title')?.textContent==='根据您的收藏，猜您喜欢：');
    await page.locator('.legacy-import').getByRole('button',{name:'关闭',exact:true}).click();
  });
  await check('private 503 uses public fallback and retry restores personalization without changing the query',async()=>{
    await page.locator('#query').fill('想看修仙成长');await page.getByRole('button',{name:'理解我的口味',exact:true}).click();
    await page.locator('.recognition-dialog').getByRole('button',{name:'核对无误，生成片单',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.skeleton'));
    const before={query:await page.locator('#query').inputValue(),chips:await page.locator('.preference-chips').innerText(),results:await page.locator('.results-section').innerText()};
    await a.route('**/api/v1/me/home-recommendations',route=>route.fulfill({status:503,json:{error:{message:'验收模拟服务异常'}}}));
    // Switching auth by restoring the page also discards user edits, so trigger the existing refresh through a successful import.
    await page.evaluate(id=>localStorage.setItem('kiwi-real-library-v1',JSON.stringify({AnotherTest:[id]})),workA.id);
    await page.getByRole('button',{name:/我的收藏/}).click();await page.getByRole('button',{name:'导入本机旧收藏',exact:true}).click();
    await page.getByRole('button',{name:'导入收藏',exact:true}).click();await page.getByText(/导入完成：新增 0 部/).waitFor();
    await page.locator('.legacy-import').getByRole('button',{name:'关闭',exact:true}).click();await home(page);
    await page.getByText('个性化推荐暂不可用，已显示片库精选',{exact:false}).waitFor();await defaultPrompts(page);
    assert.equal(await page.locator('.account-button').innerText(),nameA);
    assert.equal(await page.locator('#query').inputValue(),before.query);assert.equal(await page.locator('.preference-chips').innerText(),before.chips);
    assert.equal(await page.locator('.results-section').innerText(),before.results);
    await page.screenshot({path:resolve(root,'docs/screenshots/home-public-fallback.png')});
    await a.unroute('**/api/v1/me/home-recommendations');await page.getByRole('button',{name:'重试个性化推荐',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#favorite-prompts-title')?.textContent==='根据您的收藏，猜您喜欢：');
  });
  await check('logout and account switch clear old personalization while preserving the active list',async()=>{
    const query=await page.locator('#query').inputValue(),list=await page.locator('.results-section').innerText();
    await page.getByRole('button',{name:'退出',exact:true}).click();await page.getByRole('button',{name:'登录 / 注册',exact:true}).waitFor();await defaultPrompts(page);
    assert.equal(await page.locator('#query').inputValue(),query);assert.equal((await page.locator('.results-section').innerText()).replace(/[♡♥]/g,''),list.replace(/[♡♥]/g,''));
    await signIn(page,nameB);await page.waitForFunction(()=>document.querySelector('#favorite-prompts-title')?.textContent==='根据您的收藏，猜您喜欢：');
    assert.deepEqual(await page.locator('.favorite-prompt-examples button').allTextContents(),report.account_b.prompts);
    const count=posts.length;await page.locator('.favorite-prompt-examples button').first().click();
    await page.getByRole('button',{name:'理解我的口味',exact:true}).waitFor();assert.equal(await page.locator('.drama-card').count(),0);assert.equal(posts.length,count);
  });
  await check('desktop and mobile stay within the viewport without page errors',async()=>{
    for(const [width,height] of [[1440,1000],[2160,1150],[768,1024],[390,844],[320,740]]){
      await page.setViewportSize({width,height});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      report.viewports.push({width,height,horizontal_overflow:false});
    }
    assert.deepEqual(report.page_errors,[]);
  });
  await writeFile(resolve(root,'docs/home-recommendations-browser-validation.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({checks:report.checks.length,viewports:report.viewports.length,page_errors:report.page_errors,public_works:report.public_works}));
}finally{
  await browser?.close();
  if(server.exitCode===null){server.kill();await Promise.race([new Promise(resolve=>server.once('exit',resolve)),pause(3000)]);}
  log.end();
}
