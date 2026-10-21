import { dramas, examples } from './data.mjs';
import { parsePreferences, describePreferences, recommend, genreOptions, themeOptions, exclusionOptions } from './recommendation.mjs';
import { posterArt } from './art.mjs';
import { createDemoLibrary, previewPosition, createHoverIntent } from './library.mjs';

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const query = $('#query');
const state = { preferences: parsePreferences(query.value), manual: false, result: null, busy: false, failNext: false, view: 'discover', category: '全部' };
let demoStorage;
try { demoStorage = window.localStorage; } catch { /* 私密或受限环境仍可临时体验。 */ }
const library = createDemoLibrary(demoStorage, dramas.map((drama) => drama.id));
const preview = $('#drama-preview');
let previewAnchor = null;
let previewId = null;
let pendingFavorite = null;
let toastTimer;
let suppressedAnchor = null;
const hoverIntent = createHoverIntent((anchor) => openPreview(anchor), () => closePreview());
const clipSources = { sword: './assets/sword.webm', city: './assets/city.webm', shop: './assets/shop.webm', door: './assets/door.webm', space: './assets/space.webm' };

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
  return `<article class="drama-card" data-card-id="${drama.id}" data-context="${context}"><button class="poster-button" data-preview-trigger aria-haspopup="dialog" aria-expanded="false" aria-controls="drama-preview" aria-label="预览《${drama.title}》精彩片段与详情">${posterArt(drama.art, drama.color, `${context}-${drama.id}-${index}`)}<span class="poster-tag">${drama.genre}</span><span class="poster-demo">DEMO ORIGINAL</span><span class="poster-wordmark"><strong>${drama.title}</strong><small>${drama.subtitle}</small></span><span class="poster-arrow">▷</span><span class="hover-hint">悬停预览精彩片段</span></button><div class="card-body"><div class="card-heading"><h3>${drama.title}</h3><span class="card-meta">${drama.episodes} 集 · 模拟</span></div><div class="card-tags">${[...drama.themes, drama.pace === '快' ? '节奏快' : '节奏舒缓'].map((tag) => `<span class="card-tag">${tag}</span>`).join('')}</div><div class="match-box"><span class="match-label">${recommended ? '为什么推荐给你' : '故事一瞥'}</span><p>${escapeHtml(description)}</p>${recommended && drama.caveats.length ? `<div class="caveat">留意：${escapeHtml(drama.caveats.join('；'))}</div>` : ''}</div><div class="card-footer"><span>悬停看详情 · 点击也可预览</span><button class="card-favorite" data-favorite="${drama.id}" aria-pressed="${library.has(drama.id)}" aria-label="${library.has(drama.id) ? '取消收藏' : '收藏'}《${drama.title}》">${library.has(drama.id) ? '♥ 已收藏' : '♡ 收藏'}</button></div></div></article>`;
}

function renderResults() {
  closePreview();
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
  closePreview();
  $('#catalog-filters').innerHTML = ['全部', ...genreOptions].map((genre) => `<button class="filter-button ${state.category === genre ? 'active' : ''}" data-category="${genre}" aria-pressed="${state.category === genre}">${genre}</button>`).join('');
  const list = dramas.filter((drama) => state.category === '全部' || drama.genre === state.category);
  $('#catalog-count').textContent = `${state.category === '全部' ? '全部题材' : state.category} · 共 ${list.length} 部模拟作品`;
  $('#catalog-grid').innerHTML = list.map((drama, index) => card(drama, 'catalog', index)).join('');
}

function setView(view) {
  closePreview();
  state.view = view;
  $('#discover-view').hidden = view !== 'discover';
  $('#catalog-view').hidden = view !== 'catalog';
  $('#favorites-view').hidden = view !== 'favorites';
  $('#breadcrumb-current').textContent = { discover: '为你推荐', catalog: '示例片库', favorites: '我的收藏' }[view];
  for (const [id, active] of [['discover-nav', view === 'discover'], ['catalog-nav', view === 'catalog'], ['favorites-nav', view === 'favorites']]) {
    $(`#${id}`).classList.toggle('active', active);
    if (active) $(`#${id}`).setAttribute('aria-current', 'page'); else $(`#${id}`).removeAttribute('aria-current');
  }
  if (view === 'catalog') renderCatalog();
  if (view === 'favorites') renderFavorites();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function optionsHtml(values, name, selected) {
  return values.map((value) => `<label class="option-label"><input type="checkbox" name="${name}" value="${value}" ${selected.includes(value) ? 'checked' : ''}><span>${value}</span></label>`).join('');
}

function editPreferences() {
  if (state.busy) return;
  closePreview();
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

function notify(message) {
  window.clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = window.setTimeout(() => { $('#toast').hidden = true; }, 3000);
}

function renderFavorites() {
  const items = library.ids.map((id) => dramas.find((drama) => drama.id === id)).filter(Boolean);
  $('#favorites-description').textContent = library.user ? `${library.user} 的片单，留住每一个想追的故事。` : '登录演示账号，把心动的漫剧放进自己的收藏夹。';
  $('#collection-count').textContent = `我的收藏 · ${items.length} 部`;
  $('#favorites-grid').innerHTML = items.length ? items.map((drama, index) => card(drama, 'favorites', index)).join('') : `<div class="empty-state"><span class="empty-icon">♡</span><h3>${library.user ? '收藏夹，等一个心动的故事' : '登录后，拥有自己的收藏夹'}</h3><p>${library.user ? '悬停任意漫剧卡片，点击「加入收藏」，下次就能在这里找到它。' : '只需填写演示昵称，即可体验收藏。数据仅保存在当前浏览器。'}</p><button class="secondary-button" ${library.user ? 'data-browse' : 'data-login'}>${library.user ? '去片库逛逛 ↗' : '登录体验 ↗'}</button></div>`;
}

function syncLibrary() {
  $('#account-button').textContent = library.user ? `◉ ${library.user}` : '登录体验';
  $('#account-button').title = library.user ? '切换演示账号' : '登录演示账号';
  $('#logout-button').hidden = !library.user;
  $('#favorites-count').textContent = library.ids.length;
  document.querySelectorAll('[data-favorite]').forEach((button) => {
    const saved = library.has(button.dataset.favorite);
    const title = dramas.find((drama) => drama.id === button.dataset.favorite)?.title;
    button.setAttribute('aria-pressed', String(saved));
    button.setAttribute('aria-label', `${saved ? '取消收藏' : '收藏'}《${title}》`);
    button.textContent = saved ? '♥ 已收藏' : button.classList.contains('preview-favorite') ? '♡ 加入收藏' : '♡ 收藏';
  });
  if (state.view === 'favorites') renderFavorites();
}

function openLogin(id = null) {
  pendingFavorite = id;
  closePreview();
  $('#login-description').textContent = id ? '登录后将自动收藏这部漫剧。使用演示昵称即可，无需密码；仅保存在当前浏览器。' : '使用演示昵称体验个人收藏，无需密码。相同昵称可找回当前浏览器里的收藏，不会创建真实账号。';
  $('#demo-nickname').value = library.user || 'nut';
  $('#login-error').hidden = true;
  $('#login-dialog').showModal();
}

function favorite(id) {
  if (!library.user) { openLogin(id); return; }
  const saved = !library.has(id);
  library.setFavorite(id, saved);
  if (state.view === 'favorites' && !saved) closePreview();
  syncLibrary();
  notify(`${saved ? '已加入我的收藏' : '已取消收藏'}${library.persistent ? '' : ' · 仅在当前页面暂存'}`);
}

function positionPreview() {
  if (!previewAnchor?.isConnected || preview.hidden || !preview.matches(':popover-open')) return;
  const position = previewPosition(previewAnchor.getBoundingClientRect(), { width: document.documentElement.clientWidth, height: window.innerHeight }, { width: 420, height: preview.offsetHeight });
  Object.assign(preview.style, { left: `${position.left}px`, top: `${position.top}px`, width: `${position.width}px` });
}

function closePreview({ restoreFocus = false, suppress = false } = {}) {
  hoverIntent.cancel();
  if (suppress) suppressedAnchor = previewAnchor;
  const trigger = previewAnchor?.querySelector('[data-preview-trigger]');
  trigger?.setAttribute('aria-expanded', 'false');
  const video = preview.querySelector('video');
  if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
  if (preview.matches(':popover-open')) preview.hidePopover();
  previewId = null;
  previewAnchor = null;
  preview.innerHTML = '<div id="preview-content"></div>';
  if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
}

function openPreview(anchor, keyboard = false) {
  if (!anchor?.isConnected || anchor === suppressedAnchor || document.querySelector('dialog[open]')) return;
  const id = anchor.dataset.cardId;
  if (previewId === id && previewAnchor === anchor) {
    if (keyboard) preview.querySelector('[data-preview-close]').focus({ preventScroll: true });
    return;
  }
  const drama = dramas.find((item) => item.id === id);
  if (!drama) return;
  closePreview();
  previewAnchor = anchor;
  previewId = id;
  const recommended = anchor.dataset.context === 'recommend' ? state.result?.items.find((item) => item.id === id) : null;
  const labels = [...(recommended?.reasons.length ? recommended.reasons : drama.themes), ...(recommended ? state.preferences.exclude.map((value) => `无${value}`) : [])];
  const factNames = { harem: '后宫', angst: '虐心情节', romance: '感情线' };
  const facts = Object.entries(factNames).map(([field, label]) => drama[field] === null ? `${label}未知` : `${drama[field] ? '有' : '无'}${label}`);
  const poster = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(posterArt(drama.art, drama.color, 'preview-poster'));
  $('#preview-content').innerHTML = `<div class="preview-media"><video id="preview-video" src="${clipSources[drama.art] || clipSources.sword}" poster="${poster}" muted loop playsinline preload="metadata" aria-label="${drama.title}精彩片段模拟预览"></video><span class="preview-kicker"><i></i> 精彩片段预览 <small>模拟</small></span><button class="preview-close" data-preview-close aria-label="关闭预览">×</button><button class="preview-play" id="preview-play" aria-label="播放模拟片段" hidden>▷ 播放预览</button><div class="preview-video-tools"><span>原创氛围动画 · 静音片段</span><button id="preview-pause" aria-label="暂停预览">Ⅱ 暂停</button></div><div class="video-progress"><span id="video-progress"></span></div></div><div class="preview-body"><div class="preview-heading"><div><span class="preview-meta">${drama.genre} · ${drama.episodes} 集 · 虚构作品</span><h2 id="preview-title">${drama.title}</h2></div><button class="preview-favorite" data-favorite="${drama.id}" aria-pressed="${library.has(id)}" aria-label="${library.has(id) ? '取消收藏' : '收藏'}《${drama.title}》">${library.has(id) ? '♥ 已收藏' : '♡ 加入收藏'}</button></div><p class="preview-subtitle">${drama.subtitle}</p><div class="detail-labels">${labels.map((label) => `<span class="detail-label">${escapeHtml(label)}</span>`).join('')}</div>${recommended?.caveats.length ? `<p class="preview-caveat">留意：${escapeHtml(recommended.caveats.join('；'))}</p>` : ''}<h3>${recommended ? '原始简介 · 推荐依据' : '故事简介'}</h3><p class="preview-intro">${drama.intro}</p><div class="preview-facts">${facts.map((fact) => `<span>${fact}</span>`).join('')}</div><div class="preview-source"><span>内置模拟资料 ${id.toUpperCase()}</span><span>片段为同题材演示素材</span></div></div>`;
  preview.style.width = `${Math.min(420, document.documentElement.clientWidth - 24)}px`;
  preview.showPopover();
  positionPreview();
  anchor.querySelector('[data-preview-trigger]').setAttribute('aria-expanded', 'true');
  const video = $('#preview-video');
  const play = $('#preview-play');
  const pause = $('#preview-pause');
  const updatePlaying = () => { if (!video.isConnected) return; pause.textContent = video.paused ? '▷ 播放' : 'Ⅱ 暂停'; pause.setAttribute('aria-label', video.paused ? '播放预览' : '暂停预览'); };
  const playVideo = () => video.play().then(() => { if (play.isConnected) play.hidden = true; }).catch(() => { if (play.isConnected) play.hidden = false; });
  play.addEventListener('click', playVideo);
  pause.addEventListener('click', () => { if (video.paused) playVideo(); else video.pause(); });
  video.addEventListener('play', updatePlaying);
  video.addEventListener('pause', updatePlaying);
  video.addEventListener('error', () => { if (play.isConnected) { play.hidden = false; play.textContent = '片段暂不可用 · 点击重试'; } });
  video.addEventListener('timeupdate', () => { if ($('#video-progress') && video.duration) $('#video-progress').style.width = `${video.currentTime / video.duration * 100}%`; });
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { play.hidden = false; updatePlaying(); } else playVideo();
  if (keyboard) preview.querySelector('[data-preview-close]').focus({ preventScroll: true });
}

document.addEventListener('pointerover', (event) => {
  if (event.pointerType === 'touch' || preview.contains(event.target)) return;
  const anchor = event.target.closest('[data-card-id]');
  if (anchor && !anchor.contains(event.relatedTarget) && anchor !== suppressedAnchor) { suppressedAnchor = null; hoverIntent.enter(anchor); }
});
document.addEventListener('pointerout', (event) => {
  const anchor = event.target.closest('[data-card-id]');
  if (anchor && !anchor.contains(event.relatedTarget)) {
    if (suppressedAnchor === anchor) suppressedAnchor = null;
    if (!preview.contains(event.relatedTarget)) hoverIntent.leave();
  }
});
preview.addEventListener('pointerenter', () => hoverIntent.keep());
preview.addEventListener('pointerleave', () => { if (!preview.querySelector(':focus-visible')) hoverIntent.leave(); });
document.addEventListener('focusin', (event) => {
  const trigger = event.target.closest('[data-preview-trigger]');
  if (trigger && trigger.matches(':focus-visible') && trigger.closest('[data-card-id]') !== suppressedAnchor) openPreview(trigger.closest('[data-card-id]'));
  if (preview.contains(event.target)) hoverIntent.keep();
});
document.addEventListener('focusout', () => {
  window.setTimeout(() => {
    if (previewId && !preview.contains(document.activeElement) && !previewAnchor?.contains(document.activeElement) && !preview.matches(':hover')) closePreview();
  }, 0);
});
preview.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') {
    const buttons = [...preview.querySelectorAll('button:not([hidden])')];
    if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); closePreview({ restoreFocus: true, suppress: true }); }
    else if (!event.shiftKey && document.activeElement === buttons.at(-1)) closePreview({ restoreFocus: true, suppress: true });
  }
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && previewId) { event.preventDefault(); closePreview({ restoreFocus: true, suppress: true }); } });
window.addEventListener('resize', () => closePreview());
window.addEventListener('scroll', () => {
  if (!previewAnchor) return;
  const rect = previewAnchor.getBoundingClientRect();
  if (rect.bottom <= 0 || rect.top >= window.innerHeight) closePreview(); else positionPreview();
}, { passive: true });
document.addEventListener('visibilitychange', () => { if (document.hidden) closePreview(); });

query.addEventListener('input', () => setQuery(query.value));
query.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); generate(); } });
$('#recommend-button').addEventListener('click', generate);
$('#recommend-button').setAttribute('title', '生成片单（Ctrl + Enter）');
$('#edit-preferences').addEventListener('click', editPreferences);
$('#example-buttons').addEventListener('click', (event) => { const button = event.target.closest('[data-example]'); if (button) setQuery(examples[Number(button.dataset.example)].query); });
$('#discover-nav').addEventListener('click', () => setView('discover'));
$('#catalog-nav').addEventListener('click', () => setView('catalog'));
$('#favorites-nav').addEventListener('click', () => setView('favorites'));
$('#account-button').addEventListener('click', () => openLogin());
$('#logout-button').addEventListener('click', () => { closePreview(); library.logout(); syncLibrary(); notify('已退出演示账号，收藏仍保存在本机'); });
$('.brand').addEventListener('click', (event) => { event.preventDefault(); setView('discover'); });
$('#catalog-filters').addEventListener('click', (event) => { const button = event.target.closest('[data-category]'); if (button) { state.category = button.dataset.category; renderCatalog(); } });
for (const id of ['guide-button', 'sidebar-guide']) $(`#${id}`).addEventListener('click', () => { closePreview(); $('#guide-dialog').showModal(); });
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

$('#login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!library.login($('#demo-nickname').value)) { $('#login-error').hidden = false; return; }
  const id = pendingFavorite;
  pendingFavorite = null;
  if (id) library.setFavorite(id, true);
  $('#login-dialog').close();
  syncLibrary();
  notify(`${id ? '已登录，并加入我的收藏' : `你好，${library.user}，欢迎回来`}${library.persistent ? '' : ' · 仅在当前页面暂存'}`);
});
$('#login-dialog').addEventListener('close', () => { pendingFavorite = null; });

document.addEventListener('click', (event) => {
  const close = event.target.closest('[data-close]');
  if (close) $(`#${close.dataset.close}`).close();
  const trigger = event.target.closest('[data-preview-trigger]');
  if (trigger) { suppressedAnchor = null; openPreview(trigger.closest('[data-card-id]'), event.detail === 0); }
  const save = event.target.closest('[data-favorite]');
  if (save) favorite(save.dataset.favorite);
  if (event.target.closest('[data-preview-close]')) closePreview({ restoreFocus: true, suppress: true });
  if (event.target.closest('[data-login]')) openLogin();
  if (event.target.closest('[data-browse]')) setView('catalog');
  if (previewId && !preview.contains(event.target) && !previewAnchor?.contains(event.target)) closePreview();
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
syncLibrary();
