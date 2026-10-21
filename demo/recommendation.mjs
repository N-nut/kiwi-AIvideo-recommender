export const genreOptions = ['修仙', '都市', '悬疑', '治愈', '科幻'];
export const themeOptions = ['逆袭', '复仇', '成长', '冒险', '推理', '反转', '温暖', '日常'];
export const exclusionOptions = ['后宫', '虐心', '感情线'];

const genreRules = [
  ['修仙', /修仙|仙侠|玄幻/], ['都市', /都市|职场|商战/],
  ['悬疑', /悬疑|侦探/], ['治愈', /治愈|轻松/], ['科幻', /科幻|星际|太空/],
  ['末日丧尸', /末日|丧尸/], ['机甲', /机甲/], ['体育', /体育|足球|篮球/],
];
const themeRules = [
  ['逆袭', /逆袭|爽剧|打脸|翻盘/], ['复仇', /复仇|报仇/],
  ['成长', /成长/], ['冒险', /冒险/], ['推理', /推理|破案/],
  ['反转', /反转/], ['温暖', /温暖|温柔|暖心/], ['日常', /日常|生活/],
];
const unique = (values) => [...new Set(values)];

export function parsePreferences(query) {
  const text = String(query ?? '').trim();
  const excludedText = [];
  const positive = text.replace(/(?:不要|不想看|不喜欢|不看|拒绝|排除|避开|别来)([^，。；！!?？\n]*)/g, (_, content) => {
    excludedText.push(content);
    return '';
  }).replace(/无后宫|无感情线|无恋爱|不虐(?:心)?/g, (content) => {
    excludedText.push(content);
    return '';
  });
  const negative = excludedText.join(' ');
  const exclude = [];
  if (/后宫/.test(negative)) exclude.push('后宫');
  if (/虐/.test(negative)) exclude.push('虐心');
  if (/感情|恋爱|爱情/.test(negative)) exclude.push('感情线');
  const excludedGenres = genreRules.filter(([, rule]) => rule.test(negative)).map(([name]) => name);
  const genres = genreRules.filter(([, rule]) => rule.test(positive)).map(([name]) => name);
  const themes = themeRules.filter(([, rule]) => rule.test(positive)).map(([name]) => name);
  const fast = /节奏快|快一点|快节奏|紧凑|明快/.test(positive);
  const slow = /舒缓|慢节奏|慢一点|慢热/.test(positive);
  const conflicts = [];
  if (fast && slow) conflicts.push('同时选择了快节奏和舒缓节奏，请保留一种。');
  if (genres.some((genre) => excludedGenres.includes(genre))) conflicts.push('同一题材同时被喜欢和排除，请调整后重试。');
  return { genres: unique(genres), themes: unique(themes), pace: fast ? '快' : slow ? '舒缓' : null, exclude, excludedGenres, conflicts };
}

export function describePreferences(preferences) {
  return [
    ...preferences.genres.map((value) => ({ value, kind: 'genre' })),
    ...preferences.themes.map((value) => ({ value, kind: 'theme' })),
    ...(preferences.pace ? [{ value: preferences.pace === '快' ? '节奏快' : '节奏舒缓', kind: 'pace' }] : []),
    ...preferences.exclude.map((value) => ({ value: `不要${value}`, kind: 'exclude' })),
    ...preferences.excludedGenres.map((value) => ({ value: `不看${value}`, kind: 'exclude' })),
  ];
}

export function recommend(catalog, preferences, limit = 3) {
  if (preferences.conflicts.length) return { status: 'conflict', items: [], message: preferences.conflicts.join(' ') };
  if (!describePreferences(preferences).length) return { status: 'clarify', items: [], message: '可以补充题材、剧情特点，或明确不想看的内容。' };
  const fields = { 后宫: 'harem', 虐心: 'angst', 感情线: 'romance' };
  const candidates = catalog.filter((drama) => {
    if (preferences.genres.length && !preferences.genres.includes(drama.genre)) return false;
    if (preferences.excludedGenres.includes(drama.genre)) return false;
    // 缺失值不等同于“没有”，明确排除条件仅接受已知的 false。
    return preferences.exclude.every((value) => drama[fields[value]] === false);
  });
  const ranked = candidates.map((drama) => {
    const reasons = [];
    if (preferences.genres.includes(drama.genre)) reasons.push(`${drama.genre}题材`);
    for (const theme of preferences.themes) if (drama.themes.includes(theme)) reasons.push(theme);
    if (preferences.pace === drama.pace) reasons.push(drama.pace === '快' ? '节奏快' : '节奏舒缓');
    const caveats = [];
    if (preferences.pace && preferences.pace !== drama.pace) caveats.push(`节奏${drama.pace === '快' ? '较快' : '偏舒缓'}`);
    const missingThemes = preferences.themes.filter((theme) => !drama.themes.includes(theme));
    if (missingThemes.length) caveats.push(`简介未体现${missingThemes.join('、')}`);
    const score = (preferences.genres.includes(drama.genre) ? 4 : 0) + preferences.themes.filter((theme) => drama.themes.includes(theme)).length * 3 + (preferences.pace === drama.pace ? 2 : 0);
    return { ...drama, reasons, caveats, score };
  }).filter((drama) => !preferences.themes.length || drama.reasons.length > 0);
  // 同分按固定标识排序，便于重复演示和测试；先按作品标识去重。
  const byId = new Map();
  for (const drama of ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))) {
    if (!byId.has(drama.id)) byId.set(drama.id, drama);
  }
  const deduped = [...byId.values()];
  return { status: deduped.length ? 'success' : 'empty', items: deduped.slice(0, Math.max(0, limit)), total: deduped.length, message: deduped.length ? '' : '当前示例片库里没有满足这些条件的作品。可以主动调整题材或排除项，再找一次。' };
}
