import test from 'node:test';
import assert from 'node:assert/strict';
import { dramas } from '../demo/data.mjs';
import { parsePreferences, describePreferences, recommend } from '../demo/recommendation.mjs';

test('默认需求识别题材、剧情、节奏和明确排除项', () => {
  const prefs = parsePreferences('想看修仙逆袭，节奏快一点，不要后宫。');
  assert.deepEqual(prefs.genres, ['修仙']);
  assert.deepEqual(prefs.themes, ['逆袭']);
  assert.equal(prefs.pace, '快');
  assert.deepEqual(prefs.exclude, ['后宫']);
});
test('否定中的题材不应成为正向偏好', () => {
  const prefs = parsePreferences('想看都市，不要修仙和后宫。');
  assert.deepEqual(prefs.genres, ['都市']);
  assert.deepEqual(prefs.excludedGenres, ['修仙']);
  assert.deepEqual(prefs.exclude, ['后宫']);
});
test('连续多个排除项以及无后宫、不虐能够识别', () => {
  assert.deepEqual(parsePreferences('都市，不要后宫和感情线，不要虐心').exclude, ['后宫', '虐心', '感情线']);
  assert.deepEqual(parsePreferences('修仙，无后宫，不虐').exclude, ['后宫', '虐心']);
});
test('未知的后宫信息不能当作不存在后宫', () => {
  const result = recommend(dramas, parsePreferences('修仙逆袭，不要后宫'), 20);
  assert.ok(result.items.length > 0);
  assert.ok(result.items.every((drama) => drama.harem === false));
  assert.ok(!result.items.some((drama) => drama.id === 'd04'));
});
test('多项排除条件同时生效', () => {
  const result = recommend(dramas, parsePreferences('都市逆袭，不要后宫和感情线，不要虐心'), 20);
  assert.deepEqual(result.items.map((drama) => drama.id), ['d05', 'd09']);
});
test('偏好命中更多的作品优先，软偏好不满足时说明差异', () => {
  const result = recommend(dramas, parsePreferences('修仙逆袭，节奏快，不要后宫'));
  assert.deepEqual(result.items.map((drama) => drama.id), ['d01', 'd02', 'd03']);
  assert.ok(result.items[0].reasons.includes('逆袭'));
  assert.ok(result.items[2].caveats.some((text) => text.includes('舒缓')));
  assert.ok(result.items[2].caveats.some((text) => text.includes('逆袭')));
});
test('没有相关作品时不能忽略指定题材并补齐结果', () => {
  const result = recommend(dramas, parsePreferences('想看末日丧尸，节奏快，不要后宫'));
  assert.equal(result.status, 'empty');
  assert.deepEqual(result.items, []);
});
test('候选不足时按实际数量返回', () => {
  const result = recommend(dramas, parsePreferences('治愈温暖，不要虐心'));
  assert.equal(result.items.length, 2);
  assert.ok(result.items.every((drama) => drama.genre === '治愈'));
});
test('相互冲突的节奏与题材需要调整，不直接推荐', () => {
  assert.equal(recommend(dramas, parsePreferences('修仙，节奏快，也要慢节奏')).status, 'conflict');
  assert.equal(recommend(dramas, parsePreferences('修仙，不要修仙')).status, 'conflict');
});
test('空输入与无可识别信息应要求补充', () => {
  for (const value of ['', '   ', '给我推荐一些东西', '<script>alert(1)</script>']) {
    assert.equal(recommend(dramas, parsePreferences(value)).status, 'clarify');
  }
});
test('重新输入从新需求识别，不继承上一轮排除项', () => {
  parsePreferences('修仙，不要后宫');
  const next = parsePreferences('都市逆袭');
  assert.deepEqual(next.exclude, []);
  assert.deepEqual(next.genres, ['都市']);
});
test('去重、上限和排序稳定', () => {
  const prefs = parsePreferences('都市逆袭');
  const result = recommend([...dramas, dramas[4]], prefs, 2);
  assert.equal(new Set(result.items.map((drama) => drama.id)).size, 2);
  assert.equal(result.items.length, 2);
  assert.deepEqual(recommend(dramas, prefs), recommend(dramas, prefs));
});
test('同一作品重复时保留匹配更好的记录', () => {
  const lessRelevant = { ...dramas[4], themes: [], pace: '舒缓' };
  const result = recommend([lessRelevant, dramas[4]], parsePreferences('都市逆袭，节奏快'));
  assert.equal(result.items.length, 1);
  assert.ok(result.items[0].reasons.includes('逆袭'));
});
test('明确包含排除内容的作品不得推荐', () => {
  const blocked = { ...dramas[0], id: 'blocked', harem: true };
  const result = recommend([blocked, dramas[0]], parsePreferences('修仙逆袭，不要后宫'));
  assert.deepEqual(result.items.map((drama) => drama.id), ['d01']);
});
test('模拟数据身份唯一，已知标签与原始简介一致', () => {
  assert.equal(new Set(dramas.map((drama) => drama.id)).size, dramas.length);
  for (const drama of dramas) {
    assert.ok(drama.title && drama.intro && drama.themes.length);
    if (drama.harem === false) assert.ok(drama.intro.includes('无后宫'));
    if (drama.romance === false) assert.ok(drama.intro.includes('无感情线'));
    assert.ok([true, false, null].includes(drama.harem));
  }
});
test('手动条件中的明确题材排除生效，展示中包含排除标签', () => {
  const prefs = { genres: [], themes: [], pace: null, exclude: ['后宫'], excludedGenres: ['修仙'], conflicts: [] };
  const result = recommend(dramas, prefs, 20);
  assert.ok(result.items.every((drama) => drama.genre !== '修仙' && drama.harem === false));
  assert.ok(describePreferences(prefs).some((chip) => chip.value === '不看修仙'));
});
