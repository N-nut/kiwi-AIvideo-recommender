// Local browser acceptance; synthetic accounts are created in a disposable DB.
// Pass KIWI_PLAYWRIGHT_MODULE when using the desktop's bundled Playwright.
import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const { chromium }=require(process.env.KIWI_PLAYWRIGHT_MODULE || 'playwright');
const base=process.env.KIWI_BROWSER_URL || 'http://127.0.0.1:8001';
const target=new URL(base);
assert(target.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(target.hostname),'Browser acceptance only connects to loopback HTTP.');
const health=await (await fetch(`${base}/health/ready`)).json();
assert.equal(health.mode,'baseline','Use a disposable baseline database for browser acceptance.');
const browser=await chromium.launch({channel:process.env.KIWI_BROWSER_CHANNEL || 'msedge',headless:true});
const a=await browser.newContext({viewport:{width:1440,height:1000}});
const b=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
const page=await a.newPage(),mobile=await b.newPage();
const errors=[];page.on('pageerror',error=>errors.push(error.message));mobile.on('pageerror',error=>errors.push(error.message));
const suffix=Date.now().toString(36),nameA=`qaA_${suffix}`,nameB=`qaB_${suffix}`,password='Only synthetic tests 123';
const report={base,desktop:{width:1440,height:1000},mobile:{width:390,height:844},checks:[]};
async function check(name,test) {await test();report.checks.push(name);}
async function waitText(locator,text) {await locator.filter({hasText:text}).waitFor();}
async function authForm(p,name,register=false) {
  if(register) await p.locator('.auth-switch').click();
  await p.locator('#auth-username').fill(name);await p.locator('#auth-password').fill(password);
  if(register) await p.locator('#auth-confirmation').fill(password);
  await p.locator('.auth-dialog button[type=submit]').click();
  await waitText(p.locator('.account-button'),name);
  await p.locator('.auth-dialog').waitFor({state:'hidden'});
  await p.waitForFunction(()=>!document.querySelector('.account-notice'));
}
async function catalog(p) {await p.getByRole('button',{name:/片库/}).click();await p.locator('.card-favorite').first().waitFor();await p.waitForFunction(()=>!document.querySelector('.card-favorite:disabled'));}
async function favorites(p) {await p.getByRole('button',{name:/我的收藏/}).click();}
async function noOverflow(p) {assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
try {
  await mkdir('docs/screenshots',{recursive:true});
  await page.goto(base);await page.getByRole('button',{name:'登录 / 注册',exact:true}).waitFor();
  await check('guest recommendation remains available',async()=>{
    await page.getByRole('button',{name:'理解我的口味'}).click();await page.getByRole('button',{name:/确认偏好，生成片单/}).waitFor();
    await page.getByRole('button',{name:/确认偏好，生成片单/}).click();await page.waitForFunction(()=>!document.querySelector('.skeleton'));
    assert(!(await page.locator('.auth-dialog').isVisible()));
  });
  await catalog(page);
  const workId=await page.locator('.card-favorite').first().getAttribute('aria-label');
  const workTitle=await page.locator('.drama-card h3').first().innerText();
  await check('registration continues the requested favorite',async()=>{
    await page.locator('.card-favorite').first().click();
    await page.locator('.auth-switch').click();
    await noOverflow(page);await page.screenshot({path:'docs/screenshots/account-register.png',fullPage:false});
    await page.locator('.auth-switch').click();
    await authForm(page,nameA,true);
    await page.locator('.card-favorite[aria-pressed=true]').first().waitFor();
    assert.equal(await page.locator('.nav-count').nth(1).innerText(),'1');
  });
  await check('HttpOnly session and reload restore',async()=>{
    const cookie=(await a.cookies()).find(c=>c.name==='kiwi_session');assert(cookie?.httpOnly);assert.equal(cookie.sameSite,'Lax');assert.equal(cookie.path,'/');
    assert(!(await page.evaluate(()=>document.cookie)).includes('kiwi_session'));
    assert(!(await page.evaluate(()=>JSON.stringify(localStorage))).includes(password));
    await page.reload();await waitText(page.locator('.account-button'),nameA);await favorites(page);await page.getByRole('heading',{name:workTitle,exact:true}).waitFor();
    await noOverflow(page);await page.screenshot({path:'docs/screenshots/account-favorites.png',fullPage:false});
  });
  await check('mobile guest sees no other account data',async()=>{
    await mobile.goto(base);await mobile.getByRole('button',{name:'登录 / 注册',exact:true}).waitFor();
    await favorites(mobile);await mobile.locator('.auth-dialog[open]').waitFor();
    await noOverflow(mobile);await mobile.locator('.auth-switch').click();await mobile.screenshot({path:'docs/screenshots/account-register-mobile.png',fullPage:false});await mobile.locator('.auth-switch').click();
    await authForm(mobile,nameB,true);await favorites(mobile);await mobile.getByRole('heading',{name:'还没有收藏作品'}).waitFor();
  });
  await check('same account restores favorites in independent cookie store',async()=>{
    await mobile.getByRole('button',{name:'退出',exact:true}).click();await mobile.getByRole('button',{name:'登录 / 注册',exact:true}).waitFor();
    await mobile.locator('.account-button').click();await authForm(mobile,nameA);await favorites(mobile);await mobile.getByRole('heading',{name:workTitle,exact:true}).waitFor();
    await noOverflow(mobile);await mobile.screenshot({path:'docs/screenshots/account-favorites-mobile.png',fullPage:false});
    await mobile.locator('.card-favorite').first().click();await mobile.getByRole('heading',{name:'还没有收藏作品'}).waitFor();
    await page.reload();await waitText(page.locator('.account-button'),nameA);await favorites(page);await page.getByRole('heading',{name:'还没有收藏作品'}).waitFor();
  });
  await check('logout revokes only this browser session',async()=>{
    await page.getByRole('button',{name:'退出',exact:true}).click();await page.getByRole('button',{name:'登录 / 注册',exact:true}).waitFor();
    await mobile.reload();await waitText(mobile.locator('.account-button'),nameA);
  });
  await check('legacy import explicitly selects one group and keeps the local dictionary',async()=>{
    const works=await (await mobile.request.get(`${base}/api/v1/works?page_size=2`)).json();const id=works.items[0].id;
    const raw=JSON.stringify({OldNickname:[id,id,'missing-work'],OtherNickname:[works.items[1].id]});
    await mobile.evaluate(value=>localStorage.setItem('kiwi-real-library-v1',value),raw);await mobile.reload();await waitText(mobile.locator('.account-button'),nameA);
    await mobile.locator('.legacy-import').waitFor();assert((await mobile.locator('.legacy-import').innerText()).includes(nameA));
    const before=await (await mobile.request.get(`${base}/api/v1/me/favorites`)).json();assert.equal(before.total,0);
    await mobile.getByRole('button',{name:'导入收藏',exact:true}).click();await mobile.getByText('导入完成：新增 1 部，账号已有 0 部，跳过不可用 1 部。',{exact:true}).waitFor();
    const data=await (await mobile.request.get(`${base}/api/v1/me/favorites/ids`)).json();assert.deepEqual(data.items,[id]);
    assert.equal(await mobile.evaluate(()=>localStorage.getItem('kiwi-real-library-v1')),raw);
    await mobile.screenshot({path:'docs/screenshots/account-import-mobile.png',fullPage:false});
    await mobile.reload();await mobile.locator('.legacy-import').waitFor();assert.equal(await mobile.locator('.legacy-import option').count(),1);
  });
  await check('desktop and mobile have no horizontal overflow or page errors',async()=>{await noOverflow(page);await noOverflow(mobile);assert.deepEqual(errors,[]);});
  report.synthetic_users=[nameA,nameB];report.page_errors=errors;
  await writeFile('docs/account-browser-validation.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({checks:report.checks.length,page_errors:errors,work:workId}));
} finally {await browser.close();}
