import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const documents = [new URL('../README.md', import.meta.url), new URL('../docs/技术方案.md', import.meta.url), new URL('../产品设计文档.md', import.meta.url), new URL('../docs/实现与验收.md', import.meta.url), new URL('../data/审核说明.md', import.meta.url)];

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
  const section = source.slice(source.indexOf('## 11.')).split(/\r?\n## \d+\./)[0];
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

test('真实媒体技术设计的公开响应与状态、资源地址和内部字段约定一致', async () => {
  const source = await readFile(new URL('../docs/技术方案.md', import.meta.url), 'utf8');
  const section = source.slice(source.indexOf('## 12.'));
  assert.match(section, /^## 12\. 真实片段接入与预览（技术设计，待实现）/);
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
  assert.match(section,/本次只更新技术设计和文档校验/);
});

test('真实片段预览方案保留待实现状态、来源边界与异常验收要求', async () => {
  const source = await readFile(new URL('../产品设计文档.md', import.meta.url), 'utf8');
  const section = source.match(/^### 3\.8 .*\r?\n([\s\S]*?)(?=^## 4\.)/m)?.[0];
  assert.ok(section, '真实片段预览须有独立产品方案');
  assert.match(section, /侧边交互已实现，真实素材待接入/);
  assert.match(source, /\| 真实片段预览 \|[^\n]+\| 产品方案已补充；素材核实、接入与验收待完成 \|/);
  for (const requirement of ['3～5 部作品', '10～20 秒', '作品唯一标识', '使用依据', '暂无视频预览', '视频暂不可用', '重试', '迟到', '静音', '后台', '减少动态效果', 'Esc']) {
    assert.ok(section.includes(requirement), `预览方案缺少要求：${requirement}`);
  }
  assert.match(section, /不包含整剧站内播放、自动识别精彩片段或大规模视频采集/);
  assert.match(source, /真实预览验收覆盖[^\n]+当前真实片段接入不计为已实现/);
  assert.match(section, /浮层只保留视频画面/);
  assert.match(section, /不遮挡原卡片的封面、文字和操作/);
  assert.match(section, /卡片资料区下方/);
  assert.match(source, /首版不提供完整剧集站内播放/);
});
