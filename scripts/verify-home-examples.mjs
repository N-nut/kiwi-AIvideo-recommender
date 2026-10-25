// Frontend acceptance only; use an isolated loopback baseline catalogue.
import { createRequire } from 'node:module';
import { mkdir,writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.KIWI_PLAYWRIGHT_MODULE||'playwright');
const base=process.env.KIWI_BROWSER_URL||'http://127.0.0.1:8001',target=new URL(base);
assert(target.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(target.hostname));
assert.equal((await (await fetch(`${base}/health/ready`)).json()).mode,'baseline');
const browser=await chromium.launch({channel:process.env.KIWI_BROWSER_CHANNEL||'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
await context.route('**/*',route=>route.request().resourceType()==='image'&&new URL(route.request().url()).origin!==target.origin?route.abort():route.continue());
const page=await context.newPage(),errors=[],actions=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('request',request=>{if(request.url().includes('/api/v1/')&&(request.method()!=='GET'||request.url().includes('/me/')))actions.push({method:request.method(),path:new URL(request.url()).pathname});});
const report={date:'2026-10-25',checks:[],viewports:[],backend_personalization:false,external_covers_blocked:true};
async function check(name,test){await test();report.checks.push(name);}
async function unfocus(){await page.mouse.move(0,0);await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur();});}
async function geometry(){
  const values=await page.locator('.featured-control').evaluateAll(buttons=>buttons.map(button=>{
    const rect=button.getBoundingClientRect(),icon=button.querySelector('svg').getBoundingClientRect();
    return {label:button.getAttribute('aria-label'),dx:Math.abs(rect.x+rect.width/2-icon.x-icon.width/2),dy:Math.abs(rect.y+rect.height/2-icon.y-icon.height/2)};
  }));
  assert.equal(values.length,2);for(const value of values){assert(value.dx<=0.5&&value.dy<=0.5,JSON.stringify(value));}
  return values;
}
try{
  await mkdir('docs/screenshots',{recursive:true});await page.goto(base);
  await page.locator('.featured-carousel').waitFor();await page.getByRole('button',{name:'登录 / 注册',exact:true}).waitFor();
  await check('only centered previous/next icons remain and manual navigation still wraps',async()=>{
    assert.equal(await page.locator('.featured-pause').count(),0);await geometry();
    await page.getByRole('button',{name:'上一部精选',exact:true}).click();assert.equal((await page.locator('.featured-counter').innerText()).trim(),'6 / 6');
    await page.getByRole('button',{name:'下一部精选',exact:true}).click();assert.equal((await page.locator('.featured-counter').innerText()).trim(),'1 / 6');
    await page.locator('.featured-carousel').press('ArrowRight');assert.equal((await page.locator('.featured-counter').innerText()).trim(),'2 / 6');
  });
  await check('style examples fill editable text without API calls or generating a list',async()=>{
    assert.equal(await page.locator('.prompt-example-badge').innerText(),'示例');
    assert((await page.locator('.prompt-intro').innerText()).includes('根据您的收藏，猜您喜欢：'));
    assert.deepEqual(await page.locator('.favorite-prompt-examples button').allTextContents(),['修仙逆袭','穿越重生','末世系统','都市成长']);
    await page.getByRole('button',{name:'末世系统',exact:true}).click();assert((await page.locator('#query').inputValue()).includes('末世题材，带有系统和冒险'));
    assert.equal(await page.locator('.drama-card').count(),0);assert.equal(await page.locator('.generation-guide').count(),1);
    await page.getByRole('button',{name:'理解我的口味',exact:true}).waitFor();assert.deepEqual(actions,[]);
  });
  await check('automatic rotation remains available without a manual pause button',async()=>{
    await unfocus();const current=await page.locator('.featured-counter').innerText();await page.emulateMedia({reducedMotion:'no-preference'});
    await page.waitForFunction(text=>document.querySelector('.featured-counter')?.textContent.trim()!==text,current.trim(),{timeout:8500});
    await page.emulateMedia({reducedMotion:'reduce'});
  });
  await check('desktop and mobile icons stay centered and the prompt examples do not overflow',async()=>{
    for(const [width,height] of [[1440,1000],[2160,1150],[768,1024],[390,844],[320,740]]){
      await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));await unfocus();
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Horizontal overflow');
      const icons=await geometry();report.viewports.push({width,height,icons,horizontal_overflow:false});
      if(width===1440){await page.screenshot({path:'docs/screenshots/home-favorite-examples-desktop.png'});await page.locator('.featured-controls').screenshot({path:'docs/screenshots/carousel-controls-centered.png'});await page.locator('.query-column').screenshot({path:'docs/screenshots/favorite-prompt-examples.png'});}
      if(width===390){await page.locator('.composer').scrollIntoViewIfNeeded();await page.screenshot({path:'docs/screenshots/home-favorite-examples-mobile.png'});}
    }
  });
  assert.deepEqual(errors,[]);assert.deepEqual(actions,[]);report.page_errors=errors;report.action_requests=actions;
  await writeFile('docs/home-examples-validation.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({checks:report.checks.length,viewports:report.viewports.length,page_errors:errors,action_requests:actions}));
}finally{await browser.close();}
