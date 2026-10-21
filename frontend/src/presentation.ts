import type { Work } from './types';
import sword from '../../demo/assets/sword.webm?url';
import city from '../../demo/assets/city.webm?url';
import shop from '../../demo/assets/shop.webm?url';
import door from '../../demo/assets/door.webm?url';
import space from '../../demo/assets/space.webm?url';

const clips = { sword, city, shop, door, space };
export function workArt(work: Work): keyof typeof clips {
  if (work.genres.includes('都市')) return 'city';
  if (work.genres.includes('科幻')) return 'space';
  if (work.genres.includes('悬疑') || work.genres.includes('末世')) return 'door';
  if (work.themes.includes('经营')) return 'shop';
  return 'sword';
}
export function workClip(work: Work) { return clips[workArt(work)]; }
