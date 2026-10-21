// 仅模拟本机账号和收藏，不承担身份认证。
export function createDemoLibrary(storage, validIds) {
  const key = 'manyou-demo-library-v1';
  const allowed = new Set(validIds);
  const collections = new Map();
  let user = null;
  let persistent = true;
  const nameOf = (name) => typeof name === 'string' ? name.trim().slice(0, 20) : '';
  try {
    const saved = JSON.parse(storage?.getItem(key) || 'null');
    if (saved?.version === 1 && Array.isArray(saved.collections)) {
      for (const entry of saved.collections.slice(0, 100)) {
        const name = nameOf(entry?.name);
        if (name && Array.isArray(entry.ids)) collections.set(name, new Set(entry.ids.filter((id) => allowed.has(id))));
      }
      user = nameOf(saved.user) || null;
    }
  } catch { /* 损坏或被禁用的本地存储不影响浏览。 */ }
  function save() {
    try {
      if (!storage) throw new Error('Storage unavailable');
      storage.setItem(key, JSON.stringify({ version: 1, user, collections: [...collections].map(([name, ids]) => ({ name, ids: [...ids] })) }));
      persistent = true;
    } catch { persistent = false; }
  }
  return {
    get user() { return user; },
    get persistent() { return persistent; },
    get ids() { return user ? [...(collections.get(user) || [])] : []; },
    has(id) { return Boolean(user && collections.get(user)?.has(id)); },
    login(name) {
      const normalized = nameOf(name);
      if (!normalized) return false;
      user = normalized;
      if (!collections.has(user)) collections.set(user, new Set());
      save();
      return true;
    },
    logout() { user = null; save(); },
    setFavorite(id, wanted) {
      if (!allowed.has(id)) return 'unknown';
      if (!user) return 'login-required';
      if (!collections.has(user)) collections.set(user, new Set());
      if (wanted) collections.get(user).add(id); else collections.get(user).delete(id);
      save();
      return wanted ? 'added' : 'removed';
    },
  };
}

// 浮层覆盖原卡片，始终限制在视口内，避免最后一列向右溢出。
export function previewPosition(anchor, viewport, size) {
  const margin = 12;
  const width = Math.min(size.width, viewport.width - margin * 2);
  const height = Math.min(size.height, viewport.height - margin * 2);
  return {
    width,
    left: Math.max(margin, Math.min(anchor.left + (anchor.width - width) / 2, viewport.width - width - margin)),
    top: Math.max(margin, Math.min(anchor.top - 12, viewport.height - height - margin)),
  };
}

// 离开时留出跨入浮层的时间；取消待执行任务后不会弹出旧卡片。
export function createHoverIntent(open, close, scheduler = globalThis) {
  let opening;
  let closing;
  return {
    enter(value) {
      scheduler.clearTimeout(opening);
      scheduler.clearTimeout(closing);
      opening = scheduler.setTimeout(() => open(value), 260);
    },
    keep() { scheduler.clearTimeout(opening); scheduler.clearTimeout(closing); },
    leave() {
      scheduler.clearTimeout(opening);
      scheduler.clearTimeout(closing);
      closing = scheduler.setTimeout(close, 180);
    },
    cancel() { scheduler.clearTimeout(opening); scheduler.clearTimeout(closing); },
  };
}
