import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const documents = [new URL('../README.md', import.meta.url), new URL('../docs/技术方案.md', import.meta.url), new URL('../产品设计文档.md', import.meta.url), new URL('../docs/实现与验收.md', import.meta.url), new URL('../data/审核说明.md', import.meta.url), new URL('../docs/媒体预览.md', import.meta.url)];

function technicalSection(source, number) {
  const start=source.search(new RegExp(`^## ${number}\\.`, 'm'));
  assert.notEqual(start,-1,`技术方案缺少第 ${number} 节`);
  return source.slice(start).split(/\r?\n## \d+\./)[0];
}

test('历史片单契约对应服务端快照、隐私、迁移与再次确认', async () => {
  const source=await readFile(new URL('../docs/技术方案.md',import.meta.url),'utf8');
  const product=await readFile(new URL('../产品设计文档.md',import.meta.url),'utf8');
  const section=technicalSection(source,15);
  assert.match(product,/^### 3\.12 历史片单（已实现）/m);
  assert.match(product,/^### 6\.3 历史片单验收/m);
  for(const text of ['recommendation_history','0009_recommendation_history.py','down_revision="0008"','auth.write()',
    '最近 100 份','24,000 字节','POST /api/v1/me/recommendations','GET /api/v1/me/history','DELETE /api/v1/me/history',
    'no-store','available=false','changed=true','auth.scope()','latestRequest()','TextEncoder','不自动解析或推荐','只读','失败回滚']) {
    assert.ok(section.includes(text),`历史片单缺少契约：${text}`);
  }
  assert.doesNotMatch(product,/不扩展为历史片单功能/);
  assert.doesNotMatch(technicalSection(source,14),/不增加历史片单持久化/);
  const migration=await readFile(new URL('../backend/migrations/versions/0009_recommendation_history.py',import.meta.url),'utf8');
  assert.match(migration,/revision = "0009"/);assert.match(migration,/down_revision = "0008"/);
  for(const file of ['backend/kiwi/history.py','backend/tests/test_history.py','frontend/src/useHistory.ts','frontend/src/components/HistoryPanel.vue',
    'frontend/tests/history.test.ts','scripts/verify-history.mjs'])assert.ok((await stat(new URL('../'+file,import.meta.url))).isFile(),file);
});

test('推荐反馈与换一批说明与已实现状态及产品边界一致', async () => {
  const source=await readFile(new URL('../产品设计文档.md',import.meta.url),'utf8');
  const section=source.match(/^### 3\.11 推荐反馈＋换一批（已实现）\r?\n([\s\S]*?)(?=^## 4\.)/m)?.[0];
  assert.ok(section,'反馈与换批须有独立产品要求');
  assert.match(source,/\| 推荐反馈＋换一批 \|[^\n]+\| 已实现账号反馈/);
  for(const requirement of ['服务端','不感兴趣','已看过','推荐反馈管理','撤销','游客继续浏览和生成片单',
    '不删除或自动新增收藏','不推断用户讨厌整类题材','不重新解析原始描述','不自动放宽必须条件或明确排除项',
    '此前成功展示过','没有更多符合当前条件的作品','重新浏览本轮','失败保留上批','账号切换','迟到响应','键盘']) {
    assert.ok(section.includes(requirement),`反馈方案缺少：${requirement}`);
  }
  assert.match(source,/^### 6\.2 推荐反馈与换批验收/m);
});

test('反馈换批技术契约衔接实际迁移、鉴权、请求限制与验证模块', async () => {
  const source=await readFile(new URL('../docs/技术方案.md',import.meta.url),'utf8');
  const product=await readFile(new URL('../产品设计文档.md',import.meta.url),'utf8');
  const section=technicalSection(source,14);
  assert.match(section,/^## 14\. 推荐反馈与换一批技术方案（已实现）/);
  assert.ok(section.includes('已实施并完成本地验证'));
  assert.ok(product.includes('技术方案第 14 节'));
  assert.doesNotMatch(source,/尚未进入技术设计或功能实现/);
  const migration=await readFile(new URL('../backend/migrations/versions/0006_user_profiles.py',import.meta.url),'utf8');
  const revision=migration.match(/^revision = "([^"]+)"/m)?.[1];
  assert.ok(revision);assert.ok(section.includes(`down_revision="${revision}"`));
  const middleware=await readFile(new URL('../backend/kiwi/main.py',import.meta.url),'utf8');
  const bytes=Number(middleware.match(/if size > ([\d_]+):/)?.[1]?.replaceAll('_',''));
  assert.ok(bytes>0);assert.ok(section.includes(bytes.toLocaleString('en-US')+' 字节'));
  for(const requirement of ['Python + FastAPI + 现有 Vue 3','SQLAlchemy 2.0','Alembic','user_work_feedback','0007_user_work_feedback.py',
    'profile_upgrade.py','create_all()','auth.write()','复合主键','expected_revision','If-Match','412 precondition_failed','漫画可反馈',
    '不全局放开 PUT／DELETE 正文','POST /api/v1/me/recommendations','公开接口即使带 Cookie','NOT EXISTS',
    '前 10 条','稳定顺序的补取','search_incomplete','has_more=null','content_hash','完整、最近确认的反馈快照',
    'complete=false','shownIds','TextEncoder','不截断','auth.scope()','latestRequest','新账号不能继承旧账号去重依据',
    '不自动追加一次模型请求','功能验收','不代替接口、迁移、并发和浏览器验证']) {
    assert.ok(section.includes(requirement),`反馈换批技术方案缺少：${requirement}`);
  }
  for(const file of ['backend/kiwi/feedback.py','backend/migrations/versions/0007_user_work_feedback.py','backend/tests/test_feedback.py',
    'frontend/src/useFeedback.ts','frontend/src/useRecommendationBatches.ts','frontend/src/components/FeedbackManager.vue',
    'frontend/src/components/FeedbackMenu.vue','frontend/tests/feedback.test.ts','scripts/verify-feedback.mjs'])assert.ok((await stat(new URL('../'+file,import.meta.url))).isFile(),file);
  const feedbackMigration=await readFile(new URL('../backend/migrations/versions/0007_user_work_feedback.py',import.meta.url),'utf8');
  assert.match(feedbackMigration,/revision = "0007"/);assert.match(feedbackMigration,/down_revision = "0006"/);
});

test('反馈与换批 JSON 示例的状态、版本、请求字段及隐私约定一致', async () => {
  const source=await readFile(new URL('../docs/技术方案.md',import.meta.url),'utf8');
  const section=technicalSection(source,14);
  const examples=[...section.matchAll(/^```json\s*\r?\n([\s\S]*?)^```\s*$/gm)].map(([,body])=>JSON.parse(body));
  assert.equal(examples.length,4,'提供反馈输入、保存结果、换批输入和耗尽片段');
  const [patch,saved,batch,exhausted]=examples;
  assert.deepEqual(Object.keys(patch).sort(),['expected_revision','status']);
  assert.equal(patch.status,'not_interested');assert.equal(patch.expected_revision,null);
  assert.ok(saved.request_id);assert.equal(saved.feedback.status,patch.status);
  assert.deepEqual(Object.keys(saved.feedback).sort(),['revision','status','updated_at','work_id']);
  assert.match(saved.feedback.revision,/^[a-f0-9]{32}$/);assert.ok(Number.isFinite(Date.parse(saved.feedback.updated_at)));
  assert.deepEqual(Object.keys(batch).sort(),['exclude_work_ids','limit','preferences']);
  assert.equal(batch.limit,3);assert.equal(batch.preferences.schema_version,1);
  assert.ok(batch.exclude_work_ids.length<=200);assert.equal(new Set(batch.exclude_work_ids).size,batch.exclude_work_ids.length);
  assert.equal(batch.exclude_work_ids[0],saved.feedback.work_id);
  for(const id of batch.exclude_work_ids)assert.ok(typeof id==='string'&&[...id].length>=1&&[...id].length<=80);
  assert.deepEqual(batch.preferences.soft_preferences.genres,['修仙']);assert.deepEqual(batch.preferences.excluded_features,[]);
  assert.ok(Buffer.byteLength(JSON.stringify(batch),'utf8')<=24000);
  assert.equal(exhausted.status,'empty');assert.deepEqual(exhausted.items,[]);
  assert.deepEqual(exhausted.batch,{state:'exhausted',has_more:false});assert.ok(exhausted.warnings[0].includes('没有更多'));
  const forbidden=new Set(['user_id','username','nickname','password','password_hash','token','token_hash','cookie','database_url']);
  function check(value){if(!value||typeof value!=='object')return;for(const [key,child] of Object.entries(value)){assert.ok(!forbidden.has(key),`示例不能暴露 ${key}`);check(child);}}
  examples.forEach(check);
});

test('口味推荐说明明确识别提示、独立确认及分别加载，与反馈操作区分', async () => {
  const source=await readFile(new URL('../产品设计文档.md',import.meta.url),'utf8');
  const section=source.match(/^### 3\.4 首页轮播与操作指引\r?\n([\s\S]*?)(?=^### 3\.5)/m)?.[0];
  assert.ok(section);
  for(const requirement of ['接近等宽','浅绿色卡片','偏爱风格／必须满足／明确排除','正在识别偏好','不展示作品卡片骨架',
    '您的偏好已识别','如有不符可手动调整','核对无误，生成片单','关闭及 Esc','等待你确认','识别失败','迟到响应']) {
    assert.ok(section.includes(requirement),`口味推荐缺少：${requirement}`);
  }
  const technical=await readFile(new URL('../docs/技术方案.md',import.meta.url),'utf8');
  const ui=technicalSection(technical,6);
  for(const requirement of ['requestKind','recognition-dialog','PreferenceSummary.vue','680px','700px','Ctrl+Enter','不新增模型调用']) assert.ok(ui.includes(requirement),requirement);
});

test('个人空间产品说明覆盖四项功能、账号边界和验收，与已实现状态一致', async () => {
  const source=await readFile(new URL('../产品设计文档.md',import.meta.url),'utf8');
  const space=source.match(/^### 3\.10 用户个人空间（已实现）\r?\n([\s\S]*?)(?=^## 4\.)/m)?.[0];
  assert.ok(space,'个人空间须有独立产品方案');
  assert.match(source,/\| 用户个人空间 \|[^\n]+\| 已实现资料、概览、画像、改密/);
  for(const heading of ['入口与页面组织','个人资料','收藏概览','兴趣画像','账号安全','状态与账号隔离']) assert.ok(space.includes(`#### ${heading}`),heading);
  for(const requirement of ['独立个人空间','用户名只读','不允许重复','忽略英文字母大小写后判重','昵称已被使用，请换一个','保存本人当前昵称','多人并发修改','预设头像','不展示注册时间','不复制整套收藏列表',
    '画像只读','根据 X 部有效剧集收藏整理','不推断用户明确排除','不覆盖用户当次输入','当前密码','确认新密码','8～64',
    '当前及其他已登录会话失效','只退出当前会话','结果未知','客户端传入身份','迟到响应不能显示旧账号内容','用户确认后导入']) {
    assert.ok(space.includes(requirement),`个人空间缺少约定：${requirement}`);
  }
  const acceptance=source.match(/^### 6\.1 个人空间验收\r?\n([\s\S]*?)(?=^## 7\.)/m)?.[0];
  assert.ok(acceptance,'个人空间须有独立验收范围');
  for(const requirement of ['昵称占用','并发争用','独立浏览器','注册时间','仅漫画','会话','键盘']) assert.ok(acceptance.includes(requirement),requirement);
  assert.doesNotMatch(space,/昵称可修改，允许重复|同名昵称的两个账号/,'昵称须唯一');
  assert.doesNotMatch(source,/暂不增加个人资料编辑/,'原阶段说明不得与新增产品范围冲突');
});

test('个人空间实现说明对应当前产品版本、迁移和实际功能文件', async () => {
  const source=await readFile(new URL('../docs/技术方案.md',import.meta.url),'utf8');
  const product=await readFile(new URL('../产品设计文档.md',import.meta.url),'utf8');
  const version=product.match(/^版本：(v[\d.]+)/m)?.[1];
  assert.ok(version,'产品文档须声明版本');
  assert.ok(source.includes(`[产品设计文档 ${version}]`),'技术方案应对齐当前产品文档版本');
  assert.doesNotMatch(product,/待技术设计与实现|补充资料保存、画像口径、密码更新与会话失效的技术方案/,'技术设计完成后须同步产品文档进度');
  const migration=await readFile(new URL('../backend/migrations/versions/0005_preview_jobs.py',import.meta.url),'utf8');
  const revision=migration.match(/^revision = "([^"]+)"/m)?.[1];
  assert.ok(revision,'既有媒体任务迁移须声明版本');
  const section=technicalSection(source,13);
  assert.ok(section.includes(`down_revision="${revision}"`),'新增迁移须衔接实际 revision，而非文件名');
  assert.match(section,/^## 13\. 用户个人空间技术方案（已实现）/);
  assert.match(section,/新增字段、迁移、接口、页面及功能测试已完成/);
  assert.match(section,/原生多连接并发、Docker 或 HTTPS 部署验收/);
  for(const file of ['backend/kiwi/personal_space.py','backend/kiwi/profile_upgrade.py','backend/migrations/versions/0006_user_profiles.py',
    'frontend/src/usePersonalSpace.ts','frontend/src/components/PersonalSpace.vue','backend/tests/test_personal_space.py',
    'frontend/tests/personal-space.test.ts','scripts/verify-personal-space.mjs','data/avatar-presets.json']) {
    assert.ok((await stat(new URL('../'+file,import.meta.url))).isFile(),file);
  }
  for(const requirement of ['Python + FastAPI + 现有 Vue 3','不代表已经掌握该工具','0006_user_profiles.py',
    'create_all()','uq_users_nickname_key','NFKC','casefold()','多个 NULL','保存本人当前昵称',
    '并发正确性由唯一索引保证','不展示注册时间','服务端 Session','extra="forbid"',
    'PATCH /api/v1/me/profile','GET /api/v1/me/profile','GET /api/v1/me/space-summary','POST /api/v1/me/password',
    'total + unavailable_count','build_profile','不调用大模型','no_valid_favorites','no_tags',
    'Argon2id','BEGIN IMMEDIATE','FOR UPDATE','全部 `user_sessions`','锁之外',
    '不能在撤销后补发有效会话','提交前','只删除当前会话','结果暂未确认','auth.scope()',
    '账号代次和请求序号','不改变身份代次','不覆盖用户当次输入','320','受控屏障']) {
    assert.ok(section.includes(requirement),`技术方案缺少约定：${requirement}`);
  }
});

test('个人空间响应不泄露内部信息，收藏与兴趣统计示例口径一致', async () => {
  const source=await readFile(new URL('../docs/技术方案.md',import.meta.url),'utf8');
  const section=technicalSection(source,13);
  const examples=[...section.matchAll(/^```json\s*\r?\n([\s\S]*?)^```\s*$/gm)].map(([,body])=>JSON.parse(body));
  assert.equal(examples.length,3,'分别给出资料、字段错误和收藏画像结构');
  const forbidden=new Set(['created_at','nickname_key','password','password_hash','token','token_hash','cookie','user_id','favorite_ids']);
  function checkKeys(value) {
    if(!value || typeof value!=='object') return;
    for(const [key,child] of Object.entries(value)) {
      assert.ok(!forbidden.has(key),`个人空间响应不能暴露 ${key}`);
      checkKeys(child);
    }
  }
  for(const example of examples) { assert.ok(example.request_id);checkKeys(example); }
  const {profile}=examples.find(example=>example.profile);
  assert.deepEqual(Object.keys(profile).sort(),['avatar_id','avatar_url','id','nickname','username']);
  assert.ok(profile.id && profile.username && profile.nickname && profile.avatar_id);
  const {error}=examples.find(example=>example.error);
  assert.equal(error.code,'nickname_taken');
  assert.deepEqual(error.fields,['nickname']);
  assert.equal(error.field_messages.nickname,error.message);
  const {favorites,interest}=examples.find(example=>example.interest);
  assert.equal(favorites.total,favorites.available+favorites.unavailable);
  assert.ok(interest.analyzed_count>0 && interest.analyzed_count<=favorites.available);
  assert.equal(interest.status,'ready');
  for(const group of ['content_types','genres','themes']) {
    const tags=interest[group];
    assert.ok(tags.length<=5);
    assert.equal(new Set(tags.map(tag=>tag.label)).size,tags.length,'标签不得重复计数');
    for(const tag of tags) assert.ok(tag.label && Number.isInteger(tag.count) && tag.count>0 && tag.count<=interest.analyzed_count);
    assert.deepEqual(tags.map(tag=>tag.count),tags.map(tag=>tag.count).sort((a,b)=>b-a),'按真实数量降序');
  }
  assert.equal(interest.content_types.reduce((sum,tag)=>sum+tag.count,0),interest.analyzed_count);
  assert.ok(interest.genres.length || interest.themes.length,'画像 ready 需要真实风格标签');
});

test('照片头像和布局契约保留账号隐私、正文限制、系统头像与真实迁移',async()=>{
  const technical=technicalSection(await readFile(new URL('../docs/技术方案.md',import.meta.url),'utf8'),13);
  for(const text of ['0008_user_avatars.py','down_revision="0007"','user_avatars','avatar_image','avatar_url','5 MB','16,000','24,000 字节',
    'Pillow 13.0.0','EXIF','auth.write()','GET /api/v1/me/avatar/{asset_id}','no-store','nosniff','不写入 localStorage','space-side','not-allowed'])assert.ok(technical.includes(text),text);
  for(const name of ['backend/kiwi/avatars.py','backend/migrations/versions/0008_user_avatars.py','backend/tests/test_avatars.py','frontend/src/avatar.ts','frontend/tests/avatar.test.ts','scripts/verify-profile-polish.mjs'])assert.ok((await stat(new URL('../'+name,import.meta.url))).isFile(),name);
});

test('README、产品设计和技术方案中的本地文档链接指向实际文件', async () => {
  for (const document of documents) {
    const source = await readFile(document, 'utf8');
    for (const [, target] of source.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)) {
      if (/^(?:https?:|#)/.test(target)) continue;
      const file = new URL(target, document);
      file.hash = '';
      const entry = await stat(file);
      assert.ok(entry.isFile(), `${document.pathname} 中的链接不是文件：${target}`);
    }
  }
});

test('项目文档的代码块成对闭合，JSON 示例可直接解析', async () => {
  for (const document of documents) {
    const source = await readFile(document, 'utf8');
    let block;
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      const fence = line.match(/^```([a-zA-Z0-9_-]*)\s*$/);
      if (!fence) { if (block) block.lines.push(line); continue; }
      if (!block) { block = { language: fence[1], start: index + 1, lines: [] }; continue; }
      assert.equal(fence[1], '', `${document.pathname}:${index + 1} 前一个代码块尚未闭合`);
      if (block.language === 'json') {
        assert.doesNotThrow(() => JSON.parse(block.lines.join('\n')), `${document.pathname}:${block.start} 的 JSON 示例无效`);
      }
      block = undefined;
    }
    assert.equal(block, undefined, `${document.pathname} 存在未闭合代码块`);
  }
});

test('文档表格各行列数一致，接口与字段约定不会因漏写分隔符而错位', async () => {
  for (const document of documents) {
    const source = await readFile(document, 'utf8');
    let columns = 0, inFence = false;
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      if (/^```/.test(line)) { inFence = !inFence; columns = 0; continue; }
      if (inFence) continue;
      if (!/^\s*\|.*\|\s*$/.test(line)) { columns = 0; continue; }
      const count = line.trim().slice(1, -1).split(/(?<!\\)\|/).length;
      columns ||= count;
      assert.equal(count, columns, `${document.pathname}:${index + 1} 的表格列数不一致`);
    }
  }
});

test('推荐接口的文档示例在数量、来源和隐私字段上自洽', async () => {
  const source = await readFile(new URL('../docs/技术方案.md', import.meta.url), 'utf8');
  const section = technicalSection(source,11);
  const examples = [...section.matchAll(/^```json\s*\r?\n([\s\S]*?)^```\s*$/gm)];
  assert.ok(examples.length, '新方案须提供可校验的响应结构示例');
  const forbidden = new Set(['password', 'password_hash', 'token', 'token_hash', 'cookie', 'user_id', 'profile', 'favorite_ids']);
  function checkKeys(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!forbidden.has(key), `首页响应不能暴露 ${key}`);
      checkKeys(child);
    }
  }
  for (const [, body] of examples) {
    const example = JSON.parse(body);
    assert.ok(example.request_id && example.strategy_version);
    assert.ok(example.items.length <= 6 && example.prompts.length <= 4);
    assert.equal(new Set(example.items.map(item => item.id)).size, example.items.length);
    const sources = new Set(example.items.map(item => item.basis));
    const expectedMode = sources.has('favorites') ? (sources.has('public') ? 'mixed' : 'personalized') : 'default';
    assert.equal(example.carousel_mode, expectedMode, '轮播模式须与实际来源一致');
    for (const item of example.items) {
      assert.ok(item.id && ['favorites', 'public'].includes(item.basis));
      const features = item.matched_features;
      if (item.basis === 'favorites') assert.ok(features.genres.length || features.themes.length, '只有类别相同不能称为风格匹配');
      else assert.deepEqual(Object.values(features).flat(), [], '公开补充不能携带收藏匹配依据');
    }
    assert.ok(['personalized', 'default'].includes(example.prompts_mode));
    assert.equal(new Set(example.prompts.map(prompt => prompt.label)).size, example.prompts.length);
    for (const prompt of example.prompts) {
      assert.ok(prompt.label && [...prompt.label].length <= 16);
      assert.ok(prompt.text && [...prompt.text].length <= 300);
      assert.equal(prompt.basis, example.prompts_mode === 'personalized' ? 'favorites' : 'public');
      if (prompt.basis === 'favorites') assert.ok(prompt.genres.length || prompt.themes.length);
    }
    checkKeys(example);
  }
});

test('真实媒体实现文档的公开响应与状态、资源地址和内部字段约定一致', async () => {
  const source = await readFile(new URL('../docs/技术方案.md', import.meta.url), 'utf8');
  const section = technicalSection(source,12);
  assert.match(section, /^## 12\. 真实片段接入与预览（已实现，全库自动准备）/);
  const examples = [...section.matchAll(/^```json\s*\r?\n([\s\S]*?)^```\s*$/gm)].map(([,body])=>JSON.parse(body));
  assert.deepEqual(examples.map(example=>example.status), ['ready','missing']);
  const forbidden = new Set(['video_path','poster_path','usage_basis','source_hash','processing_hash','video_sha256','password','token','user_id']);
  for (const example of examples) {
    assert.ok(example.request_id && example.work_id);
    const serialized = JSON.stringify(example);
    for (const field of forbidden) assert.ok(!Object.hasOwn(example,field) && !Object.hasOwn(example.preview||{},field), `公开媒体响应不能暴露 ${field}`);
    assert.ok(!/file:\/\/|[A-Z]:\\/i.test(serialized));
    if (example.status !== 'ready') { assert.equal(example.preview,null); continue; }
    const preview=example.preview;
    assert.match(preview.asset_id,/^[a-f0-9]{32}$/);
    assert.ok(['trailer','excerpt'].includes(preview.clip_kind));
    assert.equal(preview.content_type,'video/mp4');
    assert.ok(preview.duration_ms>=10000 && preview.duration_ms<=20200 && preview.width>0 && preview.height>0);
    for (const [key,kind] of [['video_url','video'],['poster_url','poster']]) {
      assert.equal(preview[key],`/api/v1/media/previews/${preview.asset_id}/${kind}`);
    }
    assert.equal(new URL(preview.source_page_url).protocol,'https:');
    assert.ok(Number.isFinite(Date.parse(preview.checked_at)));
  }
  assert.match(section,/真实预览流程取消按题材映射/);
  assert.match(section,/不补其他作品或模拟片段/);
  assert.match(section,/Nginx 实际 Range／HEAD[\s\S]+尚未实测/);
});

test('真实片段预览文档区分已验证样本、来源边界与待完成部署', async () => {
  const source = await readFile(new URL('../产品设计文档.md', import.meta.url), 'utf8');
  const section = source.match(/^### 3\.8 .*\r?\n([\s\S]*?)(?=^## 4\.)/m)?.[0];
  assert.ok(section, '真实片段预览须有独立产品方案');
  assert.match(section, /已实现全库自动准备/);
  assert.match(source, /\| 真实片段预览 \|[^\n]+\| 已实现全库剧集和新增作品自动准备/);
  for (const requirement of ['3～5 部作品', '10～20 秒', '作品唯一标识', '使用依据', '暂无视频预览', '视频暂不可用', '重试', '迟到', '静音', '后台', '减少动态效果', 'Esc']) {
    assert.ok(section.includes(requirement), `预览方案缺少要求：${requirement}`);
  }
  assert.match(section, /不包含整剧站内播放、自动识别精彩片段或大规模视频采集/);
  assert.match(source, /真实预览验收覆盖[^\n]+真实手机与媒体部署验收另行进行/);
  assert.match(section, /浮层只保留视频画面/);
  assert.match(section, /不遮挡原卡片的封面、文字和操作/);
  assert.match(section, /卡片资料区下方/);
  assert.match(source, /首版不提供完整剧集站内播放/);
  for (const requirement of ['更新漫剧库成功保存后','预览准备中','重启恢复','默认有声','漫画暂不支持预览','不显示封面或章节画面']) assert.ok(section.includes(requirement), requirement);
  const technical=await readFile(new URL('../docs/技术方案.md',import.meta.url),'utf8');
  for (const requirement of ['0005_preview_jobs.py','sync-previews --retry-failed','preparing','preview_jobs','有限','首集 ID','同一作品更名','预期内容指纹','404']) assert.ok(technical.includes(requirement),requirement);
});
