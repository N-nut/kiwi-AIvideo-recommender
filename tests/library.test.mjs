import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoLibrary, previewPosition, createHoverIntent } from '../demo/library.mjs';

function memoryStorage(initial = null) {
  let value = initial;
  return { getItem: () => value, setItem: (_, next) => { value = next; } };
}

test('品牌改名后仍恢复旧版本的登录和个人收藏', () => {
  const entries = new Map([['manyou-demo-library-v1', JSON.stringify({ version: 1, user: 'nut', collections: [{ name: 'nut', ids: ['d01'] }] })]]);
  const storage = { getItem: (key) => entries.get(key), setItem: (key, value) => entries.set(key, value) };
  const library = createDemoLibrary(storage, ['d01', 'd02']);
  assert.equal(library.user, 'nut');
  assert.deepEqual(library.ids, ['d01']);
  library.setFavorite('d02', true);
  assert.deepEqual(createDemoLibrary(storage, ['d01', 'd02']).ids, ['d01', 'd02']);
});

test('未登录不能收藏；登录后收藏去重、取消及刷新恢复', () => {
  const storage = memoryStorage();
  const library = createDemoLibrary(storage, ['d01', 'd02']);
  assert.equal(library.setFavorite('d01', true), 'login-required');
  assert.equal(library.login('  nut  '), true);
  assert.equal(library.setFavorite('d01', true), 'added');
  library.setFavorite('d01', true);
  assert.deepEqual(library.ids, ['d01']);
  const restored = createDemoLibrary(storage, ['d01', 'd02']);
  assert.equal(restored.user, 'nut');
  assert.equal(restored.has('d01'), true);
  restored.setFavorite('d01', false);
  assert.deepEqual(createDemoLibrary(storage, ['d01']).ids, []);
});

test('演示账号切换和退出不混用或丢失个人收藏', () => {
  const library = createDemoLibrary(memoryStorage(), ['d01', 'd02']);
  library.login('nut'); library.setFavorite('d01', true); library.logout();
  assert.deepEqual(library.ids, []);
  assert.equal(library.has('d01'), false);
  library.login('guest'); library.setFavorite('d02', true);
  assert.deepEqual(library.ids, ['d02']);
  library.login('nut'); assert.deepEqual(library.ids, ['d01']);
  library.login('__proto__'); library.setFavorite('d02', true);
  assert.deepEqual(library.ids, ['d02']);
});

test('忽略损坏的数据、未知作品与空昵称，存储禁用时仍可临时体验', () => {
  const library = createDemoLibrary(memoryStorage('{invalid'), ['d01']);
  assert.equal(library.login('  '), false);
  assert.equal(library.user, null);
  const restored = createDemoLibrary(memoryStorage(JSON.stringify({ version: 1, user: 'nut', collections: [null, { name: 'nut', ids: ['d01', 'd01', 'missing'] }] })), ['d01']);
  assert.deepEqual(restored.ids, ['d01']);
  assert.equal(restored.setFavorite('missing', true), 'unknown');
  const temporary = createDemoLibrary({ getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } }, ['d01']);
  temporary.login('nut'); temporary.setFavorite('d01', true);
  assert.deepEqual(temporary.ids, ['d01']); assert.equal(temporary.persistent, false);
});

test('展开浮层在最后一列、小屏与底部不会超出视口', () => {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 480 }]) {
    for (const anchor of [{ left: 10, top: -40, width: 300 }, { left: viewport.width - 150, top: viewport.height - 120, width: 140 }]) {
      const result = previewPosition(anchor, viewport, { width: 420, height: 560 });
      assert.ok(result.left >= 12 && result.top >= 12);
      assert.ok(result.left + result.width <= viewport.width - 12);
      assert.ok(result.top + Math.min(560, viewport.height - 24) <= viewport.height - 12);
    }
  }
});

test('快速扫过不展开；切卡只打开最后一张；跨入浮层取消关闭', () => {
  let serial = 0;
  const pending = new Map();
  const clock = { setTimeout(fn, delay) { pending.set(++serial, { fn, delay }); return serial; }, clearTimeout(id) { pending.delete(id); } };
  const opened = []; let closed = 0;
  const intent = createHoverIntent((value) => opened.push(value), () => closed++, clock);
  const flush = (delay) => { for (const [id, task] of [...pending]) if (task.delay === delay) { pending.delete(id); task.fn(); } };
  intent.enter('d01'); intent.leave(); flush(260);
  assert.deepEqual(opened, []);
  intent.enter('d01'); intent.enter('d02'); flush(260);
  assert.deepEqual(opened, ['d02']);
  intent.leave(); intent.keep(); flush(180); assert.equal(closed, 0);
  intent.leave(); flush(180); assert.equal(closed, 1);
  intent.enter('d03'); intent.cancel(); flush(260); assert.deepEqual(opened, ['d02']);
});
