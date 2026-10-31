// Isolated public catalogue copy and synthetic account. No model or media jobs.
import {spawn,spawnSync} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const root=fileURLToPath(new URL('..',import.meta.url)),suffix=Date.now().toString(36);
const python=resolve(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
const port=Number(process.env.KIWI_INTERFACE_TEST_PORT||8018),base=`http://127.0.0.1:${port}`;
const database=resolve(root,`.local/interface-${suffix}.db`),shots=resolve(root,'docs/screenshots');
const probe=createServer();await new Promise((done,fail)=>{probe.once('error',fail);probe.listen(port,'127.0.0.1',done);});await new Promise(done=>probe.close(done));
const prepared=spawnSync(python,['-X','utf8','scripts/prepare-home-validation.py',database],{cwd:root,encoding:'utf8',windowsHide:true});
assert.equal(prepared.status,0,prepared.stderr);const fixture=JSON.parse(prepared.stdout);assert(fixture.public_works>0);
const server=spawn(python,['-X','utf8','-m','uvicorn','kiwi.main:app','--host','127.0.0.1','--port',String(port),'--no-proxy-headers','--no-access-log'],{
  cwd:root,env:{...process.env,AI_MODE:'baseline',PREVIEW_AUTO_ENABLED:'false',DATABASE_URL:`sqlite:///${database.replaceAll('\\','/')}`,
    MEDIA_ROOT:resolve(root,`.local/interface-media-${suffix}`),AUTH_ALLOWED_ORIGINS:base,AUTH_COOKIE_SECURE:'false',DEEPSEEK_API_KEY:'',DASHSCOPE_API_KEY:''},
  stdio:['ignore','pipe','pipe'],windowsHide:true,
});
const log=createWriteStream(resolve(root,`.local/interface-${suffix}.log`));server.stdout.pipe(log);server.stderr.pipe(log);
const report={date:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}),mode:'baseline',database:fixture.database,
  public_works:fixture.public_works,synthetic_account:true,external_model_calls:0,external_images:'local SVG stand-ins for layout only',checks:[],viewports:[],page_errors:[]};
const pause=ms=>new Promise(done=>setTimeout(done,ms));let browser;
async function check(name,run){await run();report.checks.push(name);console.log(`Passed: ${name}`);}
const widths=[[2560,1300],[1920,1080],[1440,1000],[1280,900],[1024,1000],[768,1024],[390,844],[320,740]];
async function settle(page){await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));}
async function noCardOverlap(page){
  const result=await page.locator('.space-grid').evaluate(grid=>{
    const cards=[...grid.querySelectorAll('.space-card')].filter(el=>el.getBoundingClientRect().height>0).map(el=>({name:el.className,r:el.getBoundingClientRect()}));
    const overlaps=[];
    for(let i=0;i<cards.length;i++)for(let j=i+1;j<cards.length;j++){
      const a=cards[i],b=cards[j];if(Math.min(a.r.right,b.r.right)-Math.max(a.r.left,b.r.left)>1&&Math.min(a.r.bottom,b.r.bottom)-Math.max(a.r.top,b.r.top)>1)overlaps.push([a.name,b.name]);
    }
    return {overlaps,horizontal_overflow:document.documentElement.scrollWidth>innerWidth+1,profile_position:getComputedStyle(grid.querySelector('.profile-card')).position};
  });
  assert.deepEqual(result.overlaps,[]);assert(!result.horizontal_overflow);assert.equal(result.profile_position,'static');return result;
}
try{
  let ready=false;for(let i=0;i<100;i++){
    if(server.exitCode!==null)throw Error('Isolated interface server exited');
    try{const state=await(await fetch(`${base}/health/ready`)).json();ready=state.mode==='baseline';}catch{}
    if(ready)break;await pause(200);
  }assert(ready);
  browser=await chromium.launch({channel:process.env.KIWI_BROWSER_CHANNEL||'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  // Keep font/layout checks deterministic without downloading third-party covers.
  const colors=['#536b50','#6f5551','#4c6375','#71603f','#635672','#416659'];let cover=0;
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(request.resourceType()==='image'&&url.origin!==base){
      const color=colors[cover++%colors.length];
      return route.fulfill({contentType:'image/svg+xml',body:`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600"><defs><linearGradient id="g" x2=".7" y2="1"><stop stop-color="${color}"/><stop offset="1" stop-color="#1c3028"/></linearGradient></defs><rect width="400" height="600" fill="url(#g)"/><circle cx="295" cy="130" r="76" fill="#e4dbc4" opacity=".6"/><path d="M0 460 140 240 270 460 360 350 400 440V600H0Z" fill="#182d25" opacity=".7"/><path d="M36 35H364V565H36Z" fill="none" stroke="#e4dbc4" opacity=".45"/><text x="200" y="510" text-anchor="middle" font-family="sans-serif" font-size="28" fill="#f2ebd7">排版验证</text></svg>`});
    }
    if(!['data:','blob:'].includes(url.protocol)&&url.origin!==base)throw Error(`Unexpected external request: ${url.origin}`);
    return route.continue();
  });
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.page_errors.push(error.message));
  await mkdir(shots,{recursive:true});await page.goto(base);await page.locator('.featured-poster').waitFor();await page.locator('.favorite-prompt-examples button').first().waitFor();
  await check('top navigation and readable composer at eight viewport widths',async()=>{
    for(const [width,height] of widths){
      await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));await settle(page);
      const metrics=await page.evaluate(()=>{
        const header=document.querySelector('.site-header'),main=document.querySelector('main'),query=document.querySelector('#query'),taste=document.querySelector('.empty-preferences');
        const nav=[...document.querySelectorAll('.site-navigation .nav-item')];
        return {horizontal_overflow:document.documentElement.scrollWidth>innerWidth+1,header_top:header.getBoundingClientRect().top,
          main_top:main.getBoundingClientRect().top,header_bottom:header.getBoundingClientRect().bottom,input_font:parseFloat(getComputedStyle(query).fontSize),
          hint_font:parseFloat(getComputedStyle(taste).fontSize),nav_labels:nav.map(el=>({text:el.textContent,font:parseFloat(getComputedStyle(el).fontSize),width:el.getBoundingClientRect().width})),
          composer_heading_border:getComputedStyle(document.querySelector('.composer-heading')).borderBottomStyle,
          taste_heading_border:getComputedStyle(document.querySelector('.taste-heading')).borderBottomStyle};
      });
      assert(!metrics.horizontal_overflow);assert.equal(metrics.header_top,0);assert(metrics.main_top>=metrics.header_bottom);
      assert(metrics.input_font>=16&&metrics.hint_font>=14);assert(metrics.nav_labels.every(item=>item.font>=14&&item.width>40));
      assert.equal(metrics.composer_heading_border,'solid');assert.equal(metrics.taste_heading_border,'solid');
      assert.equal(await page.locator('.featured-reason,.query-help,.composer-flow,.footer-review-note').count(),0);
      report.viewports.push({surface:'discovery',width,height,...metrics});
      if([1920,1440,390,320].includes(width))await page.screenshot({path:resolve(shots,`interface-discovery-${width}.png`),fullPage:true});
    }
  });
  await page.setViewportSize({width:1440,height:1000});
  await check('library popover closes with Escape/outside click and retains update settings',async()=>{
    await page.locator('.header-library>summary').click();await page.locator('.library-panel').waitFor({state:'visible'});
    await page.keyboard.press('Escape');assert.equal(await page.locator('.header-library').getAttribute('open'),null);
    assert(await page.locator('.header-library>summary').evaluate(el=>document.activeElement===el));
    await page.locator('.header-library>summary').click();await page.locator('#query').click();assert.equal(await page.locator('.header-library').getAttribute('open'),null);
    for(const width of [390,320]){
      await page.setViewportSize({width,height:844});await page.locator('.header-library>summary').click();
      assert(await page.locator('.library-panel').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&el.scrollWidth<=el.clientWidth+1;}));
      await page.keyboard.press('Escape');
    }
    await page.setViewportSize({width:1440,height:1000});await page.locator('.header-library>summary').click();await page.getByRole('button',{name:'更新短剧库',exact:true}).click();
    await page.locator('.collection-dialog[open]').waitFor();assert.equal(await page.locator('.collection-options input').count(),4);await page.keyboard.press('Escape');
  });
  await check('explicit preference confirmation still runs separately after copy simplification',async()=>{
    await page.locator('#query').fill('想看修仙，偏好逆袭');await page.getByRole('button',{name:'理解我的口味',exact:true}).click();
    await page.locator('.recognition-dialog[open]').waitFor();assert.equal(await page.locator('.results-section .drama-card').count(),0);
    await page.getByRole('button',{name:'核对无误，生成片单',exact:true}).click();await page.locator('.recognition-dialog[open]').waitFor({state:'hidden'});
    await page.getByRole('button',{name:'确认偏好，生成片单',exact:true}).waitFor({state:'visible'});
    await page.waitForFunction(()=>!document.querySelector('#recommend-button').disabled);
    assert(await page.locator('.results-section .drama-card,.results-section .empty-state').count()>0);
  });
  await check('synthetic account and profile controls remain functional',async()=>{
    const username=`Layout_${suffix}`,password='Synthetic interface password 123',headers={Origin:base,'X-Kiwi-Request':'1'};
    const registered=await context.request.post(`${base}/api/v1/auth/register`,{headers,data:{username,password,confirm_password:password}});assert.equal(registered.status(),201);
    const catalogue=await(await context.request.get(`${base}/api/v1/works?page=1&page_size=12`)).json();
    for(const work of catalogue.items.slice(0,8)){const saved=await context.request.put(`${base}/api/v1/me/favorites/${encodeURIComponent(work.id)}`,{headers});assert(saved.ok());}
    await page.reload();await page.locator('.header-account .account-button').click();await page.locator('#space-nickname').waitFor();
    await page.locator('#space-nickname').fill(`排版测试_${suffix}`);await page.getByRole('button',{name:'保存资料',exact:true}).click();await page.getByText('资料已保存',{exact:true}).waitFor();
    assert.equal(await page.locator('.space-overview>.space-card').count(),2);assert.equal(await page.locator('.space-shortcuts>.space-card').count(),3);
    assert.equal(await page.getByRole('button',{name:'资料审核工作台',exact:true}).count(),0);
  });
  await check('personal space cards never overlap while scrolling or expanding password fields',async()=>{
    for(const [width,height] of widths){
      await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));await settle(page);
      const metrics=await noCardOverlap(page);report.viewports.push({surface:'personal-space',width,height,...metrics});
      const actionMetrics=await page.locator('.space-shortcuts button').evaluateAll(buttons=>buttons.map(el=>({text:el.textContent,border:getComputedStyle(el).borderTopStyle,font:parseFloat(getComputedStyle(el).fontSize),height:el.getBoundingClientRect().height})));
      assert(actionMetrics.every(item=>item.border==='solid'&&item.font>=14&&item.height>=40&&!/[↗→←]/.test(item.text)));
      const limit=await page.evaluate(()=>document.documentElement.scrollHeight-innerHeight);
      for(const top of [0,limit*.25,limit*.5,limit]){await page.evaluate(y=>scrollTo(0,y),top);await settle(page);await noCardOverlap(page);assert.equal(await page.locator('.site-header').evaluate(el=>el.getBoundingClientRect().top),0);}
      if([1920,1440,390,320].includes(width)){await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:resolve(shots,`interface-personal-space-${width}.png`),fullPage:true});}
    }
    await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'修改密码',exact:true}).click();await page.locator('#password-form').waitFor();
    await noCardOverlap(page);await page.locator('.security-card').screenshot({path:resolve(shots,'interface-security-expanded-mobile.png')});
    await page.getByRole('button',{name:'收起修改密码',exact:true}).click();
  });
  await check('catalogue cards, action buttons and work details stay readable on desktop and mobile',async()=>{
    const nav=page.getByRole('navigation',{name:'主导航'});
    await nav.getByRole('button',{name:/^片库/}).click();await page.locator('.catalog-grid .drama-card').first().waitFor();
    await settle(page);assert.equal(await page.evaluate(()=>scrollY),0);
    for(const [width,height] of [[1440,1000],[768,1024],[390,844],[320,740]]){
      await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));await settle(page);
      const metrics=await page.locator('.catalog-section').evaluate(section=>{
        const card=section.querySelector('.drama-card'),title=card.querySelector('h3');
        return {horizontal_overflow:document.documentElement.scrollWidth>innerWidth+1,title_font:parseFloat(getComputedStyle(title).fontSize),
          card_width:card.getBoundingClientRect().width,actions:[...card.querySelectorAll('.card-actions button')].map(button=>({height:button.getBoundingClientRect().height,font:parseFloat(getComputedStyle(button).fontSize),border:getComputedStyle(button).borderTopStyle}))};
      });
      assert(!metrics.horizontal_overflow);assert(metrics.title_font>=16&&metrics.card_width>=200);
      assert(metrics.actions.every(action=>action.height>=36&&action.font>=13&&action.border==='solid'));
      report.viewports.push({surface:'catalogue',width,height,...metrics});
      if(width===1440||width===390)await page.screenshot({path:resolve(shots,`interface-catalogue-${width}.png`),fullPage:true});
      await page.locator('.catalog-grid .drama-card').first().getByRole('button',{name:'详情',exact:true}).click();
      const dialog=page.locator('.work-dialog[open]');await dialog.waitFor();
      assert(await dialog.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&el.scrollWidth<=el.clientWidth+1;}));
      assert.equal(await dialog.getByRole('button',{name:'关闭作品详情',exact:true}).count(),1);
      await dialog.getByRole('button',{name:'关闭作品详情',exact:true}).click();
    }
  });
  await check('navigation, catalogue search, favorites, history and feedback remain reachable',async()=>{
    await page.setViewportSize({width:1440,height:1000});const nav=page.getByRole('navigation',{name:'主导航'});
    await nav.getByRole('button',{name:/^片库/}).click();await page.locator('.catalog-grid .drama-card').first().waitFor();
    await page.locator('#catalog-search').fill('不可能匹配的合成标题');await page.getByRole('button',{name:'搜索',exact:true}).click();await page.getByRole('heading',{name:'没有找到相关剧名',exact:true}).waitFor();
    await nav.getByRole('button',{name:/^我的收藏/}).click();await page.locator('.catalog-grid .drama-card').first().waitFor();
    await page.locator('.header-account .account-avatar').click();await page.getByRole('button',{name:'找回往期推荐',exact:true}).click();await page.locator('#history-title').waitFor();
    await page.locator('.header-account .account-avatar').click();await page.getByRole('button',{name:'推荐反馈管理',exact:true}).click();await page.locator('#feedback-title').waitFor();
    await page.locator('.header-account .account-avatar').click();await page.getByRole('button',{name:'我的纠错',exact:true}).click();await page.getByRole('heading',{name:'我的纠错',exact:true}).waitFor();
    for(const [view,heading] of [['history','历史片单'],['feedback','推荐反馈管理'],['corrections','我的纠错']]){
      for(const [width,height] of [[1440,1000],[390,844],[320,740]]){
        await page.setViewportSize({width,height});await page.locator('.header-account .account-avatar').click();
        const label={history:'找回往期推荐',feedback:'推荐反馈管理',corrections:'我的纠错'}[view];
        await page.getByRole('button',{name:label,exact:true}).click();await page.getByRole('heading',{name:heading,exact:true}).waitFor();await settle(page);
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      }
    }
  });
  assert.deepEqual(report.page_errors,[]);report.status='passed';
}finally{
  await browser?.close();server.kill();await new Promise(done=>{if(server.exitCode!==null)done();else{server.once('exit',done);setTimeout(done,3000).unref();}});log.end();
  await writeFile(resolve(root,'docs/interface-browser-validation.json'),JSON.stringify(report,null,2)+'\n');
}
