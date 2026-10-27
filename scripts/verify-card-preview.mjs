// Isolated real-browser checks for full catalogue rows and media beside a card.
import {createRequire} from 'node:module';
import {spawn,spawnSync} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{chromium}=require(process.env.KIWI_PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('..',import.meta.url)),suffix=Date.now().toString(36);
const python=resolve(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
const port=Number(process.env.KIWI_CARD_TEST_PORT||8001),base=`http://127.0.0.1:${port}`;
const probe=createServer();await new Promise((done,fail)=>{probe.once('error',fail);probe.listen(port,'127.0.0.1',done);});await new Promise(done=>probe.close(done));
const database=resolve(root,`.local/card-preview-${suffix}.db`);
await mkdir(resolve(root,'.local'),{recursive:true});
const prepared=spawnSync(python,['-X','utf8','scripts/prepare-home-validation.py',database],{cwd:root,encoding:'utf8'});
assert.equal(prepared.status,0,prepared.stderr);
const server=spawn(python,['-X','utf8','-m','uvicorn','kiwi.main:app','--host','127.0.0.1','--port',String(port),'--no-proxy-headers','--no-access-log'],
  {cwd:root,env:{...process.env,PREVIEW_AUTO_ENABLED:'false',AI_MODE:'baseline',DATABASE_URL:`sqlite:///${database.replaceAll('\\','/')}`,AUTH_ALLOWED_ORIGINS:base},stdio:['ignore','pipe','pipe'],windowsHide:true});
const log=createWriteStream(resolve(root,`.local/card-preview-${suffix}.log`));server.stdout.pipe(log);server.stderr.pipe(log);
const report={date:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}),database:JSON.parse(prepared.stdout).database,mode:'baseline',checks:[],viewports:[],placements:[],page_errors:[],real_clips:false};
const pause=ms=>new Promise(done=>setTimeout(done,ms));let browser,page;
async function check(name,test){await test();report.checks.push(name);console.log(`Passed: ${name}`);}
async function ready(){await page.waitForFunction(()=>document.querySelectorAll('.catalog-grid .drama-card').length>0&&!document.querySelector('.catalog-pagination[aria-busy=true]'));}
async function closePreview(){await page.keyboard.press('Escape');await page.mouse.move(1,1);}
async function geometry(){return page.evaluate(()=>{
  const cards=[...document.querySelectorAll('.catalog-grid .drama-card')],grid=document.querySelector('.catalog-grid');
  const rect=grid.getBoundingClientRect(),columns=getComputedStyle(grid).gridTemplateColumns.split(' ').length;
  const boxes=cards.map(card=>{const r=card.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom};});
  return {columns,cards:cards.length,gridRight:rect.right,boxes,overflow:document.documentElement.scrollWidth>innerWidth};
});}
async function preview(index,immediate=false,touch=false){
  await closePreview();const card=page.locator('.catalog-grid .drama-card').nth(index);
  if(immediate) {if(touch)await card.locator('[aria-controls=work-preview]').tap();else await card.locator('[aria-controls=work-preview]').click();}
  else await card.hover({position:{x:15,y:30}});
  await page.waitForFunction(()=>document.querySelector('#work-preview .preview-placeholder')||document.querySelector('#work-preview .preview-reading'));
  await page.waitForTimeout(220);
  const state=await page.evaluate(index=>{
    const card=document.querySelectorAll('.catalog-grid .drama-card')[index],preview=document.querySelector('#work-preview');
    const c=card.getBoundingClientRect(),p=preview.getBoundingClientRect(),body=card.querySelector('.card-body').getBoundingClientRect();
    return {side:preview.dataset.placement,card:{x:c.x,right:c.right,y:c.y,bottom:c.bottom},panel:{x:p.x,right:p.right,y:p.y,bottom:p.bottom},bodyBottom:body.bottom,
      duplicate:!!preview.querySelector('.preview-body,.preview-favorite,.preview-intro,.preview-source,h2'),overflow:document.documentElement.scrollWidth>innerWidth};
  },index);
  assert(!state.duplicate&&!state.overflow);
  if(state.side==='inline')assert(state.panel.y>=state.bodyBottom-1,JSON.stringify(state));
  else assert(state.panel.x>=state.card.right+8||state.panel.right<=state.card.x-8,JSON.stringify(state));
  report.placements.push(state);return card;
}
try{
  let available=false;
  for(let i=0;i<60;i++){if(server.exitCode!==null)throw Error('Validation server exited');try{const r=await fetch(`${base}/health/ready`);available=r.ok&&(await r.json()).mode==='baseline';}catch{}if(available)break;await pause(200);}
  assert(available,'Validation server did not start');
  browser=await chromium.launch({channel:process.env.KIWI_BROWSER_CHANNEL||'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:2209,height:1150},reducedMotion:'reduce'});
  if(process.env.KIWI_BROWSER_BLOCK_COVERS==='1')await context.route('**/*',route=>route.request().resourceType()==='image'&&new URL(route.request().url()).origin!==base?route.abort():route.continue());
  page=await context.newPage();page.on('pageerror',error=>report.page_errors.push(error.message));page.setDefaultTimeout(12000);
  await mkdir(resolve(root,'docs/screenshots'),{recursive:true});
  await page.goto(base);await page.getByRole('button',{name:'登录 / 注册',exact:true}).waitFor();
  await page.getByRole('button',{name:/片库/}).click();await ready();
  await check('complete catalogue pages fill rows at wide desktop, tablet and phone widths',async()=>{
    for(const [width,height] of [[2209,1150],[2073,1075],[2540,1200],[1440,1000],[1280,900],[1024,900],[768,1024],[390,844],[320,740]]){
      await page.setViewportSize({width,height});await closePreview();const state=await geometry();
      assert.equal(state.cards,12);assert.equal(12%state.columns,0,JSON.stringify(state));assert(!state.overflow);
      const lastRow=state.boxes.filter(box=>Math.abs(box.y-state.boxes.at(-1).y)<2);
      assert.equal(lastRow.length,state.columns);assert(Math.abs(lastRow.at(-1).right-state.gridRight)<2);
      report.viewports.push({width,height,columns:state.columns,cards:state.cards,last_row:lastRow.length,horizontal_overflow:false});
    }
    await page.setViewportSize({width:2209,height:1150});await page.locator('.catalog-grid .drama-card').nth(6).scrollIntoViewIfNeeded();await closePreview();
    await page.waitForFunction(()=>[...document.querySelectorAll('.source-cover')].every(image=>image.complete),null,{timeout:10000}).catch(()=>{});
    await page.screenshot({path:resolve(root,'docs/screenshots/catalog-full-rows-wide.png')});
  });
  await check('hover preview contains only media and flips between the right and left sides',async()=>{
    await page.setViewportSize({width:1440,height:1000});await preview(0);assert.equal(report.placements.at(-1).side,'right');
    await page.screenshot({path:resolve(root,'docs/screenshots/card-preview-right.png')});
    await preview(3);assert.equal(report.placements.at(-1).side,'left');
    await page.screenshot({path:resolve(root,'docs/screenshots/card-preview-left.png')});
  });
  await check('moving into the preview keeps it open; closing unloads and stays closed',async()=>{
    const card=await preview(1),title=await card.locator('h3').innerText();
    await page.locator('#work-preview').hover();await page.waitForTimeout(300);
    assert((await page.locator('#work-preview').getAttribute('aria-label')).includes(title));
    await page.locator('#work-preview .preview-close').click();await page.waitForTimeout(500);
    assert.equal(await page.locator('#work-preview video').count(),0);
  });
  await check('the source card keeps accessible favorite and detail buttons while previewing',async()=>{
    const card=await preview(0);await card.locator('.card-favorite').click();await page.locator('.auth-dialog[open]').waitFor();
    await page.getByRole('button',{name:'关闭登录',exact:true}).click();
    const source=await preview(0),title=await source.locator('h3').innerText();await source.getByRole('button',{name:'详情',exact:true}).click();
    await page.locator('.work-dialog[open]').waitFor();assert.equal(await page.locator('#detail-title').innerText(),title);
    assert.equal(await page.locator('#work-preview video').count(),0);await page.getByRole('button',{name:'关闭作品详情',exact:true}).click();
  });
  await check('phone preview expands below card information and displays missing media honestly',async()=>{
    const desktop=page,touch=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
    page=await touch.newPage();page.on('pageerror',error=>report.page_errors.push(error.message));
    try {
      await page.goto(base);await page.getByRole('button',{name:/片库/}).tap();await ready();
      await preview(0,true,true);assert.equal(report.placements.at(-1).side,'inline');
      await page.locator('#work-preview').scrollIntoViewIfNeeded();await page.getByText('暂无视频预览',{exact:true}).waitFor();
      assert.equal(await page.locator('#work-preview video').count(),0);
      await page.screenshot({path:resolve(root,'docs/screenshots/card-preview-mobile.png')});
      await page.locator('#work-preview .preview-close').tap();await page.waitForTimeout(300);assert.equal(await page.locator('#work-preview video').count(),0);
    } finally {page=desktop;await touch.close();}
  });
  await check('favorites share complete rows and the same media-only side preview',async()=>{
    await closePreview();const headers={Origin:base,'X-Kiwi-Request':'1'},password='Synthetic card check 123';
    const registered=await context.request.post(`${base}/api/v1/auth/register`,{headers,data:{username:`card_${suffix}`,password,confirm_password:password}});assert.equal(registered.status(),201);
    const works=await(await context.request.get(`${base}/api/v1/works?page_size=12`)).json();
    assert.equal((await context.request.post(`${base}/api/v1/me/favorites/import`,{headers,data:{work_ids:works.items.map(work=>work.id)}})).status(),200);
    await page.setViewportSize({width:2209,height:1150});await page.reload();await page.locator('.logout-button').waitFor();
    await page.getByRole('button',{name:/我的收藏/}).click();await ready();const state=await geometry();assert.equal(state.cards,12);assert.equal(12%state.columns,0);
    await preview(0);assert.equal(report.placements.at(-1).side,'right');
  });
  await check('a real last page keeps its actual count rather than filling fabricated cards',async()=>{
    await closePreview();await page.getByRole('button',{name:/片库/}).click();await ready();
    const summary=await page.locator('.pagination-summary').innerText(),last=Number(summary.match(/\/\s*(\d+)/)[1]);
    await page.getByRole('button',{name:`第 ${last} 页`,exact:true}).click();await ready();
    const api=await(await context.request.get(`${base}/api/v1/works?page=${last}&page_size=12`)).json();
    assert.equal(await page.locator('.catalog-grid .drama-card').count(),api.items.length);assert.deepEqual(report.page_errors,[]);
  });
  await check('comic previews show only the unsupported message on desktop and touch without requesting media',async()=>{
    const result=await(await context.request.get(`${base}/api/v1/works?${new URLSearchParams({content_type:'漫画',page_size:'1'})}`)).json();
    const comic=result.items[0];assert(comic,'A real comic record is required');
    const desktop=page;
    async function comicMessage(touch=false){
      const mediaRequests=[];
      const observe=request=>{if(new URL(request.url()).pathname===`/api/v1/works/${comic.id}/preview`)mediaRequests.push(request.url());};
      page.on('request',observe);
      try{
        await closePreview();
        const filter=page.locator('.content-type-filters').getByRole('button',{name:'漫画',exact:true});
        if(touch)await filter.tap();else await filter.click();
        await page.locator('.catalog-search input').fill(comic.title);
        const card=page.locator('.catalog-grid .drama-card').filter({has:page.getByRole('heading',{name:comic.title,exact:true})}).first();
        await card.waitFor();const button=card.locator('[aria-controls=work-preview]');
        if(touch)await button.tap();else await button.click();
        assert.equal(await page.locator('#work-preview .preview-reading').innerText(),'漫画暂不支持预览');
        assert.equal(await page.locator('#work-preview').getAttribute('data-placement')==='inline',touch);
        assert.equal(await page.locator('#work-preview img,#work-preview video,#work-preview svg,#work-preview canvas').count(),0);
        assert.equal(await page.locator('#work-preview .preview-video-tools').count(),0);assert.deepEqual(mediaRequests,[]);
        await page.locator('#work-preview').scrollIntoViewIfNeeded();
        await page.screenshot({path:resolve(root,`docs/screenshots/comic-preview-${touch?'phone':'desktop'}.png`)});
        if(touch)await page.locator('#work-preview .preview-close').tap();else await page.locator('#work-preview .preview-close').click();
      }finally{page.off('request',observe);}
    }
    await page.setViewportSize({width:1440,height:1000});await comicMessage();
    const touch=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
    try{
      page=await touch.newPage();page.on('pageerror',error=>report.page_errors.push(error.message));
      await page.goto(base);await page.getByRole('button',{name:/片库/}).tap();await ready();await comicMessage(true);
    }finally{page=desktop;await touch.close();}
    assert.deepEqual(report.page_errors,[]);
  });
  await writeFile(resolve(root,'docs/card-preview-validation.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({checks:report.checks.length,viewports:report.viewports.length,page_errors:report.page_errors}));
}finally{
  if(page&&report.checks.length<8)await page.screenshot({path:resolve(root,'.local/card-preview-failure.png')}).catch(()=>{});
  await browser?.close();if(server.exitCode===null){server.kill();await Promise.race([new Promise(done=>server.once('exit',done)),pause(3000)]);}log.end();
}
