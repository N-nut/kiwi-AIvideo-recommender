import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const documents = [new URL('../README.md', import.meta.url), new URL('../docs/技术方案.md', import.meta.url), new URL('../产品设计文档.md', import.meta.url), new URL('../docs/实现与验收.md', import.meta.url), new URL('../data/审核说明.md', import.meta.url), new URL('../docs/媒体预览.md', import.meta.url)];

function technicalSection(source, number) {
  const start=source.search(new RegExp(`^## ${number}\\.`, 'm'));
  assert.notEqual(start,-1,`技术方案缺少第 ${number} 节`);
  return source.slice(start).split(/\r?\n## \d+\./)[0];
}

test('个人空间产品方案覆盖四项功能、账号边界和验收，明确待实现且不展示注册时间', async () => {
  const source=await readFile(new URL('../产品设计文档.md',import.meta.url),'utf8');
  const space=source.match(/^### 3\.10 用户个人空间（产品方案，待实现）\r?\n([\s\S]*?)(?=^## 4\.)/m)?.[0];
  assert.ok(space,'个人空间须有独立产品方案');
  assert.match(source,/\| 用户个人空间 \|[^\n]+\| 产品方案已明确，待实现/);
  for(const heading of ['入口与页面组织','个人资料','收藏概览','兴趣画像','账号安全','状态与账号隔离']) assert.ok(space.includes(`#### ${heading}`),heading);
  for(const requirement of ['独立个人空间','用户名只读','不允许重复','忽略英文字母大小写后判重','昵称已被使用，请换一个','保存本人当前昵称','多人并发修改','预设头像','不展示注册时间','不复制整套收藏列表',
    '画像只读','根据 X 部有效剧集收藏整理','不推断用户明确排除','不覆盖用户当次输入','当前密码','确认新密码','8～64',
    '当前及其他已登录会话失效','只退出当前会话','结果未知','客户端传入身份','迟到响应不能显示旧账号内容','用户确认后导入']) {
    assert.ok(space.includes(requirement),`个人空间缺少约定：${requirement}`);
  }
  const acceptance=source.match(/^### 6\.1 个人空间验收（待实现）\r?\n([\s\S]*?)(?=^## 7\.)/m)?.[0];
  assert.ok(acceptance,'个人空间须有独立待实现验收范围');
  for(const requirement of ['昵称占用','并发争用','独立浏览器','注册时间','仅漫画','会话','键盘']) assert.ok(acceptance.includes(requirement),requirement);
  assert.doesNotMatch(space,/昵称可修改，允许重复|同名昵称的两个账号/,'昵称须唯一');
  assert.doesNotMatch(source,/暂不增加个人资料编辑/,'原阶段说明不得与新增产品范围冲突');
});

test('个人空间技术设计对应当前产品版本，区分学习基础、待实现接口和安全验收', async () => {
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
  assert.match(section,/^## 13\. 用户个人空间技术方案（待实现）/);
  assert.match(section,/接口、页面及功能测试尚未编写/,'不能将技术设计称为功能交付');
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

test('个人空间计划响应不泄露内部信息，收藏与兴趣统计示例口径一致', async () => {
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
  assert.deepEqual(Object.keys(profile).sort(),['avatar_id','id','nickname','username']);
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
