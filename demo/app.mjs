import { dramas, examples } from './data.mjs';
import { parsePreferences, describePreferences, recommend, genreOptions, themeOptions, exclusionOptions } from './recommendation.mjs';
import { posterArt } from './art.mjs';

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const query = $('#query');
const state = { preferences: parsePreferences(query.value), manual: false, result: null, busy: false, failNext: false, view: 'discover', category: '全部' };

$('#hero-art').innerHTML = [dramas[6], dramas[0], dramas[4]].map((drama, index) => `<div class="hero-poster">${posterArt(drama.art, drama.color, `hero-${index}`)}<span class="hero-poster-title">${drama.title}</span></div>`).join('');
$('#example-buttons').innerHTML = examples.map((example, index) => `<button class="example-button" data-example="${index}" aria-pressed="false">${example.label}</button>`).join('');

function renderPreferences() {
  const chips = describePreferences(state.preferences);
  $('#preference-chips').innerHTML = chips.length ? chips.map((chip) => `<span class="taste-chip ${chip.kind === 'exclude' ? 'exclude' : ''}">${escapeHtml(chip.value)}</span>`).join('') : '<span class="empty-preferences">等你说说想看的故事…</span>';
  $('#preference-note').textContent = state.preferences.conflicts.length ? state.preferences.conflicts.join(' ') : state.manual ? '已使用手动调整的偏好；重新输入需求会重新识别。' : '根据你的描述整理，明确不想看的会优先排除。';
  $('#character-count').textContent = `${query.value.length} / 300`;
  document.querySelectorAll('[data-example]').forEach((button) => button.setAttribute('aria-pressed', String(query.value === examples[Number(button.dataset.example)].query)));
}

function card(drama, context, index) {
  const recommended = context === 'recommend';
  const reasons = recommended ? drama.reasons : [];
  const description = recommended ? reasons.length ? `这部作品的${reasons.join('、')}，符合你的偏好。` : '简介确认满足你设置的排除条件，可作为候选。' : drama.intro.split('。')[0] + '。';
  return `<article class="drama-card"><button class="poster-button" data-drama-id="${drama.id}" data-context="${context}" aria-label="查看《${drama.title}》${recommended ? '的推荐依据' : '的模拟资料'}">${posterArt(drama.art, drama.color, `${context}-${drama.id}-${index}`)}<span class="poster-tag">${drama.genre}</span><span class="poster-demo">DEMO ORIGINAL</span><span class="poster-wordmark"><strong>${drama.title}</strong><small>${drama.subtitle}</small></span><span class="poster-arrow">↗</span></button><div class="card-body"><div class="card-heading"><h3>${drama.title}</h3><span class="card-meta">${drama.episodes} 集 · 模拟</span></div><div class="card-tags">${[...drama.themes, drama.pace === '快' ? '节奏快' : '节奏舒缓'].map((tag) => `<span class="card-tag">${tag}</span>`).join('')}</div><div class="match-box"><span class="match-label">${recommended ? '为什么推荐给你' : '故事一瞥'}</span><p>${escapeHtml(description)}</p>${recommended && drama.caveats.length ? `<div class="caveat">留意：${escapeHtml(drama.caveats.join('；'))}</div>` : ''}</div><div class="card-footer"><span>虚构作品 · 模拟资料</span><button class="evidence-button" data-drama-id="${drama.id}" data-context="${context}">${recommended ? '查看推荐依据' : '看看这个故事'} <span>↗</span></button></div></div></article>`;
}

function renderResults() {
  const result = state.result;
  $('#results-section').setAttribute('aria-busy', String(state.busy));
  $('#results-message').innerHTML = '';
  if (state.busy) {
    $('#results-title').textContent = '正在整理你的片单';
    $('#results-badge').textContent = '稍等一下';
    $('#results-caption').textContent = '正在模拟筛选与生成过程';
    $('#results-message').innerHTML = '<div class="loading-message"><span class="loading-dot"></span>筛选符合条件的作品，整理推荐理由…</div>';
    $('#results-grid').innerHTML = Array.from({ length: 3 }, () => '<div class="skeleton" aria-hidden="true"><div class="skeleton-poster"></div><div class="skeleton-line"></div><div class="skeleton-line long"></div><div class="skeleton-line long"></div></div>').join('');
    return;
  }
  if (!result) {
    $('#results-title').textContent = '先逛逛这些好故事';
    $('#results-badge').textContent = '灵感片单';
    $('#results-caption').textContent = '虚构作品 · 用于界面体验';
    $('#results-grid').innerHTML = [dramas[0], dramas[4], dramas[6]].map((drama, index) => card(drama, 'inspiration', index)).join('');
    return;
  }
  $('#results-badge').textContent = '本次推荐';
  if (result.status === 'success') {
    $('#results-title').textContent = `为你找到 ${result.items.length} 部对味好剧`;
    $('#results-caption').innerHTML = `<button class="text-button" data-adjust>再调调口味 ↗</button>`;
    $('#results-message').innerHTML = `<div class="result-status">✓ 已按本次偏好筛选${state.preferences.exclude.length || state.preferences.excludedGenres.length ? '，保留了你的明确排除条件' : ''}。${result.items.length < 3 ? '符合条件的候选不足 3 部，按实际数量展示。' : ''}<span>· 模拟结果</span></div>`;
    $('#results-grid').innerHTML = result.items.map((drama, index) => card(drama, 'recommend', index)).join('');
  } else {
    const title = { empty: '这一种口味，还没有遇到', conflict: '有两个条件，需要你做个选择', clarify: '再具体一点，故事就近一点', error: '这次没生成成功，再试一次吧' }[result.status];
    $('#results-title').textContent = result.status === 'error' ? '片单暂时没有生成' : '给偏好一点小调整';
    $('#results-caption').textContent = '保留你的需求，由你决定如何调整';
    $('#results-grid').innerHTML = `<div class="empty-state"><span class="empty-icon">${result.status === 'error' ? '↻' : '⌕'}</span><h3>${title}</h3><p>${escapeHtml(result.message)}</p>${result.status === 'error' ? '<button class="secondary-button" data-retry>重新生成 ↗</button>' : '<button class="secondary-button" data-adjust>调整我的偏好 ↗</button>'}<button class="secondary-button" data-back-input>修改描述</button></div>`;
    $('#results-message').textContent = title;
    $('#results-message').classList.add('sr-only');
  }
  if (result.status === 'success') $('#results-message').classList.remove('sr-only');
}

function clearResult() {
  state.result = null;
  $('#query-error').hidden = true;
  $('#results-message').classList.remove('sr-only');
  renderPreferences();
  renderResults();
}

function setQuery(value) {
  query.value = value;
  state.preferences = parsePreferences(value);
  state.manual = false;
  clearResult();
}

function setBusy(busy) {
  state.busy = busy;
  query.disabled = busy;
  $('#edit-preferences').disabled = busy;
  $('#recommend-button').disabled = busy;
  $('#recommend-button').innerHTML = busy ? '<span>正在为你挑选…</span><span>✦</span>' : '<span>生成我的片单</span><span>↗</span>';
  document.querySelectorAll('[data-example], #empty-scenario, #error-scenario').forEach((button) => { button.disabled = busy; });
}

async function generate() {
  if (state.busy) return;
  $('#results-message').classList.remove('sr-only');
  if (!query.value.trim() && !state.manual) {
    $('#query-error').textContent = '先说说想看什么吧，或者点选一个灵感示例。';
    $('#query-error').hidden = false;
    query.focus();
    return;
  }
  $('#query-error').hidden = true;
  setBusy(true);
  renderResults();
  await new Promise((resolve) => window.setTimeout(resolve, 750));
  if (state.failNext) {
    state.result = { status: 'error', items: [], message: '这是特意模拟的失败状态。你的描述和偏好已保留，可以直接重新生成。' };
    state.failNext = false;
  } else state.result = recommend(dramas, state.preferences);
  setBusy(false);
  renderResults();
  $('#results-section').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
}

function renderCatalog() {
  $('#catalog-filters').innerHTML = ['全部', ...genreOptions].map((genre) => `<button class="filter-button ${state.category === genre ? 'active' : ''}" data-category="${genre}" aria-pressed="${state.category === genre}">${genre}</button>`).join('');
  const list = dramas.filter((drama) => state.category === '全部' || drama.genre === state.category);
  $('#catalog-count').textContent = `${state.category === '全部' ? '全部题材' : state.category} · 共 ${list.length} 部模拟作品`;
  $('#catalog-grid').innerHTML = list.map((drama, index) => card(drama, 'catalog', index)).join('');
}

function setView(view) {
  state.view = view;
  $('#discover-view').hidden = view !== 'discover';
  $('#catalog-view').hidden = view !== 'catalog';
  $('#breadcrumb-current').textContent = view === 'discover' ? '为你推荐' : '示例片库';
  for (const [id, active] of [['discover-nav', view === 'discover'], ['catalog-nav', view === 'catalog']]) {
    $(`#${id}`).classList.toggle('active', active);
    if (active) $(`#${id}`).setAttribute('aria-current', 'page'); else $(`#${id}`).removeAttribute('aria-current');
  }
  if (view === 'catalog') renderCatalog();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function optionsHtml(values, name, selected) {
  return values.map((value) => `<label class="option-label"><input type="checkbox" name="${name}" value="${value}" ${selected.includes(value) ? 'checked' : ''}><span>${value}</span></label>`).join('');
}

function editPreferences() {
  if (state.busy) return;
  const prefs = state.preferences;
  const genres = [...new Set([...genreOptions, ...prefs.genres])];
  $('#genre-select').innerHTML = '<option value="">不限题材</option>' + genres.map((genre) => `<option value="${genre}">${genre}${genreOptions.includes(genre) ? '' : '（片库未收录）'}</option>`).join('');
  $('#genre-select').value = prefs.genres[0] || '';
  $('#pace-select').value = prefs.pace || '';
  $('#theme-options').innerHTML = optionsHtml(themeOptions, 'themes', prefs.themes);
  $('#exclusion-options').innerHTML = optionsHtml(exclusionOptions, 'exclude', prefs.exclude);
  $('#excluded-genre-options').innerHTML = optionsHtml([...new Set([...genreOptions, ...prefs.excludedGenres])], 'excludedGenres', prefs.excludedGenres);
  $('#preference-form-error').hidden = true;
  $('#preference-dialog').showModal();
}

function openDetail(id, context) {
  const drama = dramas.find((item) => item.id === id);
  if (!drama) return;
  const recommended = context === 'recommend' ? state.result?.items.find((item) => item.id === id) : null;
  const reasons = recommended?.reasons || [];
  const exclusions = recommended ? state.preferences.exclude : [];
  const factNames = { harem: '后宫', angst: '虐心情节', romance: '感情线' };
  const facts = Object.entries(factNames).map(([field, label]) => drama[field] === null ? `${label}：资料未知` : `${drama[field] ? '有' : '无'}${label}`);
  $('#detail-content').innerHTML = `<div class="detail-banner">${posterArt(drama.art, drama.color, 'detail-art')}<div class="detail-banner-text"><span>${drama.genre} / 虚构作品</span><h2 id="detail-title">${drama.title}</h2><span>${drama.subtitle}</span></div></div><div class="detail-main"><h3>${recommended ? '这些地方，符合你的口味' : '这个故事的特点'}</h3><div class="detail-labels">${(reasons.length ? reasons : drama.themes).map((value) => `<span class="detail-label">✓ ${escapeHtml(value)}</span>`).join('')}${exclusions.map((value) => `<span class="detail-label">✓ 无${escapeHtml(value)}</span>`).join('')}</div>${recommended?.caveats.length ? `<div class="notice">与你的偏好有一点差异：${escapeHtml(recommended.caveats.join('；'))}。是否观看，由你决定。</div>` : ''}<h3>原始简介 · 推荐依据</h3><blockquote class="evidence-quote">${drama.intro}</blockquote><h3>已知内容信息</h3><p>${facts.join('　·　')}</p><div class="detail-source"><span class="source-badge">来源：内置模拟资料 ${drama.id.toUpperCase()}</span><span>虚构作品，无真实播放或资料链接</span></div></div>`;
  $('#detail-dialog').showModal();
}

query.addEventListener('input', () => setQuery(query.value));
query.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); generate(); } });
$('#recommend-button').addEventListener('click', generate);
$('#recommend-button').setAttribute('title', '生成片单（Ctrl + Enter）');
$('#edit-preferences').addEventListener('click', editPreferences);
$('#example-buttons').addEventListener('click', (event) => { const button = event.target.closest('[data-example]'); if (button) setQuery(examples[Number(button.dataset.example)].query); });
$('#discover-nav').addEventListener('click', () => setView('discover'));
$('#catalog-nav').addEventListener('click', () => setView('catalog'));
$('.brand').addEventListener('click', (event) => { event.preventDefault(); setView('discover'); });
$('#catalog-filters').addEventListener('click', (event) => { const button = event.target.closest('[data-category]'); if (button) { state.category = button.dataset.category; renderCatalog(); } });
for (const id of ['guide-button', 'sidebar-guide']) $(`#${id}`).addEventListener('click', () => $('#guide-dialog').showModal());
$('#empty-scenario').addEventListener('click', () => { $('#guide-dialog').close(); setView('discover'); setQuery('想看末日丧尸，节奏快，不要后宫。'); generate(); });
$('#error-scenario').addEventListener('click', () => { $('#guide-dialog').close(); setView('discover'); if (!query.value.trim()) setQuery(examples[0].query); state.failNext = true; generate(); });

$('#preference-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const genres = $('#genre-select').value ? [$('#genre-select').value] : [];
  const excludedGenres = data.getAll('excludedGenres');
  if (genres.some((genre) => excludedGenres.includes(genre))) {
    $('#preference-form-error').textContent = '同一题材不能同时被喜欢和排除，请调整后保存。';
    $('#preference-form-error').hidden = false;
    return;
  }
  state.preferences = { genres, themes: data.getAll('themes'), pace: $('#pace-select').value || null, exclude: data.getAll('exclude'), excludedGenres, conflicts: [] };
  state.manual = true;
  clearResult();
  $('#preference-dialog').close();
});

document.addEventListener('click', (event) => {
  const close = event.target.closest('[data-close]');
  if (close) $(`#${close.dataset.close}`).close();
  const detail = event.target.closest('[data-drama-id]');
  if (detail) openDetail(detail.dataset.dramaId, detail.dataset.context);
  if (event.target.closest('[data-adjust]')) editPreferences();
  if (event.target.closest('[data-retry]')) generate();
  if (event.target.closest('[data-back-input]')) { query.scrollIntoView({ block: 'center', behavior: 'smooth' }); query.focus({ preventScroll: true }); }
});
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
  const rect = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
}));

renderPreferences();
renderResults();
