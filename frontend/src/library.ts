import { ref } from 'vue';
export function useLibrary() {
  let storage: Storage | undefined;
  try { storage = localStorage; } catch { /* Session-only if browser storage is unavailable. */ }
  const user = ref(''); const saved = ref<Record<string,string[]>>({});
  try { const parsed = JSON.parse(storage?.getItem('kiwi-real-library-v1') || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      saved.value = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string,string[]] => Array.isArray(entry[1]) && entry[1].every((x: unknown) => typeof x === 'string')));
    }
  } catch { /* Corrupt state is ignored. */ }
  const ids = () => saved.value[user.value] || [];
  const has = (id: string) => ids().includes(id);
  function login(name: string) { user.value = name.trim().slice(0,20); return !!user.value; }
  function toggle(id: string) {
    if (!user.value) return false;
    const set = new Set(ids()); if (set.has(id)) set.delete(id); else set.add(id);
    saved.value = {...saved.value, [user.value]: [...set]};
    try { storage?.setItem('kiwi-real-library-v1', JSON.stringify(saved.value)); } catch { /* Keep current session state. */ }
    return true;
  }
  return { user, ids, has, login, toggle, logout: () => { user.value = ''; } };
}
