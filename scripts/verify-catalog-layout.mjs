// Run against an isolated loopback baseline server with a public catalogue copy.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.KIWI_PLAYWRIGHT_MODULE||'playwright');
const base=process.env.KIWI_BROWSER_URL||'http://127.0.0.1:8001';
assert(new URL(base).protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname));
assert.equal((await (await fetch(`${base}/health/ready`)).json()).mode,'baseline','Use an isolated baseline server.');
const browser=await chromium.launch({channel:process.env.KIWI_BROWSER_CHANNEL||'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
const blockCovers=process.env.KIWI_BROWSER_BLOCK_COVERS==='1';
if(blockCovers)await context.route('**/*',route=>route.request().resourceType()==='image'&&new URL(route.request().url()).origin!==base?route.abort():route.continue());
const page=await context.newPage(),errors=[],report={checks:[],viewports:[]};
page.on('pageerror',error=>errors.push(error.message));
async function check(name,test){await test();report.checks.push(name);}
async function settled(){await page.waitForFunction(()=>!document.querySelector('.catalog-pagination[aria-busy=true]')&&!Array.from(document.querySelectorAll('main [role=status]')).some(e=>e.textContent.includes('正在加载作品')));}
async function noOverflow(){
  const state=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,offenders:Array.from(document.querySelectorAll('body *')).filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,8).map(e=>({tag:e.tagName,classes:e.className,right:e.getBoundingClientRect().right}))}));
  if(state.scrollWidth>state.width)await page.screenshot({path:'.local/catalog-overflow.png'});
  assert(state.scrollWidth<=state.width,JSON.stringify(state));
}
async function screen(path){await page.mouse.move(5,5);await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur();});await page.keyboard.press('Escape');await page.evaluate(()=>document.fonts.ready);await page.waitForFunction(()=>Array.from(document.querySelectorAll('.source-cover')).every(image=>image.complete),null,{timeout:5000}).catch(()=>{});await page.screenshot({path,fullPage:false});}
try{
  await mkdir('docs/screenshots',{recursive:true});
  const headers={Origin:base,'X-Kiwi-Request':'1'};
  const credentials={username:'Kiwi_Visitor',password:'Synthetic layout test 123'};
  const created=await context.request.post(`${base}/api/v1/auth/register`,{headers,data:{...credentials,confirm_password:credentials.password}});
  if(created.status()===409)assert.equal((await context.request.post(`${base}/api/v1/auth/login`,{headers,data:credentials})).status(),200);
  else assert.equal(created.status(),201);
  await page.goto(base);await page.locator('.account-button').filter({hasText:'Kiwi_Visitor'}).waitFor();
  await page.getByRole('button',{name:/^▦.*片库/}).click();await page.locator('.catalog-grid .drama-card').first().waitFor();await settled();
  await check('sidebar bottom contains update controls, account and placeholder; main header removed',async()=>{
    assert.equal(await page.locator('.topbar').count(),0);assert.equal(await page.locator('.sidebar-bottom .account-avatar svg').count(),1);
    assert.equal(await page.locator('.catalog-heading h1').innerText(),'片库');assert.equal(await page.getByText('真实片库',{exact:true}).count(),0);
    const avatar=await page.locator('.account-avatar').boundingBox();assert(avatar.y>850&&avatar.y+avatar.height<1000);
    const heading=await page.locator('.catalog-heading').boundingBox();assert(heading.y<80);
    await page.locator('.sidebar-bottom .catalog-update-button').click();await page.locator('.collection-dialog[open]').waitFor();await page.getByRole('button',{name:'关闭采集设置'}).click();
  });
  await noOverflow();report.viewports.push({width:1440,height:1000,horizontal_overflow:false});
  await screen('docs/screenshots/catalog-sidebar-desktop.png');
  await page.locator('.sidebar-bottom').screenshot({path:'docs/screenshots/sidebar-account-example.png'});
  await check('direct numbered navigation reaches the last page and updates the moving number window',async()=>{
    const last=Number((await page.locator('.pagination-summary').innerText()).match(/\/ (\d+)/)[1]);
    await page.getByRole('button',{name:`第 ${last} 页`,exact:true}).click();await settled();assert.equal(await page.locator('.page-number[aria-current=page]').innerText(),String(last));
    assert(await page.getByRole('button',{name:'下一页',exact:true}).isDisabled());
    await page.getByRole('button',{name:'第 1 页',exact:true}).click();await settled();
    for(const number of [3,4,5]){await page.getByRole('button',{name:`第 ${number} 页`,exact:true}).click();await settled();}
    assert.equal(await page.locator('.page-ellipsis').count(),2);
    await page.locator('.catalog-pagination').scrollIntoViewIfNeeded();await screen('docs/screenshots/catalog-numbered-pages.png');
  });
  await check('title search matches the whole catalogue, resets page and clears cleanly',async()=>{
    const works=await (await context.request.get(`${base}/api/v1/works?page_size=1`)).json();const keyword=works.items[0].title.slice(0,2);
    await page.locator('#catalog-search').fill(keyword);await page.locator('#catalog-search').press('Enter');await settled();
    const titles=await page.locator('.catalog-grid h3').allTextContents();assert(titles.length>0&&titles.every(title=>title.includes(keyword)));
    assert((await page.locator('.catalog-count').innerText()).includes(keyword));await page.evaluate(()=>scrollTo(0,0));await screen('docs/screenshots/catalog-title-search.png');
    await page.getByRole('button',{name:'清空搜索',exact:true}).click();await settled();assert((await page.locator('.catalog-count').innerText()).includes('434'));
    await page.locator('#catalog-search').fill('完全不存在的剧名_验收');await page.locator('#catalog-search').press('Enter');await page.getByRole('heading',{name:'没有找到相关剧名'}).waitFor();
    await page.locator('.empty-state').getByRole('button',{name:'清空搜索',exact:true}).click();await settled();
  });
  await check('responsive widths keep search, avatar and number controls within the viewport',async()=>{
    for(const [width,height] of [[2160,1150],[1024,768],[768,1024],[390,844],[320,740],[1366,650]]){
      await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));await noOverflow();
      const search=await page.locator('.catalog-search').boundingBox();assert(search.x>=0&&search.x+search.width<=width);
      if(width<=900){const sidebar=await page.locator('.sidebar').boundingBox(),main=await page.locator('main').boundingBox();assert(main.y>=sidebar.y+sidebar.height-1,'Mobile tools must not overlap the catalogue');}
      await page.locator('.catalog-pagination').scrollIntoViewIfNeeded();await noOverflow();
      report.viewports.push({width,height,horizontal_overflow:false});
      await page.evaluate(()=>scrollTo(0,0));
      if(width===2160)await screen('docs/screenshots/catalog-sidebar-wide.png');
      if(width===390)await screen('docs/screenshots/catalog-sidebar-mobile.png');
    }
  });
  assert.deepEqual(errors,[]);report.page_errors=errors;report.external_covers_blocked=blockCovers;
  await writeFile('docs/catalog-layout-validation.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({checks:report.checks.length,viewports:report.viewports.length,page_errors:errors}));
}finally{await browser.close();}
