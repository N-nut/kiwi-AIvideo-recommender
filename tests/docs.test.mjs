import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const documents = [new URL('../README.md', import.meta.url), new URL('../docs/技术方案.md', import.meta.url)];

test('README 和技术方案中的本地文档链接指向实际文件', async () => {
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

test('技术方案中的 JSON 示例可解析，代码块完整闭合', async () => {
  const source = await readFile(documents[1], 'utf8');
  const fences = source.match(/^```.*$/gm) || [];
  assert.equal(fences.length % 2, 0, '存在未闭合代码块');
  for (const [, json] of source.matchAll(/^```json\r?\n([\s\S]*?)^```\s*$/gm)) {
    assert.doesNotThrow(() => JSON.parse(json), 'JSON 示例必须可直接解析');
  }
});
