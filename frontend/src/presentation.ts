import type { Work } from './types';
export function workArt(work: Work): 'sword'|'city'|'shop'|'door'|'space' {
  if (work.genres.includes('都市')) return 'city';
  if (work.genres.includes('科幻')) return 'space';
  if (work.genres.includes('悬疑') || work.genres.includes('末世')) return 'door';
  if (work.themes.includes('经营')) return 'shop';
  return 'sword';
}
