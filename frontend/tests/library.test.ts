import { describe,it,expect,beforeEach } from 'vitest';
import { useLibrary } from '../src/library';
beforeEach(()=>localStorage.clear());
describe('local demo library',()=>{
  it('requires a nickname and separates collections',()=>{const l=useLibrary();expect(l.toggle('a')).toBe(false);l.login('甲');l.toggle('a');l.login('乙');expect(l.has('a')).toBe(false);l.login('甲');expect(l.has('a')).toBe(true);l.toggle('a');expect(l.has('a')).toBe(false);});
  it('restores the same nickname without claiming authentication',()=>{const l=useLibrary();l.login('甲');l.toggle('a');l.logout();const restored=useLibrary();expect(restored.user.value).toBe('');restored.login('甲');expect(restored.ids()).toEqual(['a']);});
  it('ignores corrupt state',()=>{localStorage.setItem('kiwi-real-library-v1','{broken');const l=useLibrary();l.login('甲');expect(l.ids()).toEqual([]);});
});
