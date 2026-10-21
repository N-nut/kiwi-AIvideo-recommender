import type { Work } from '../src/types';

export function workFixture(overrides: Partial<Work> = {}): Work {
  return {
    id: 'work-a', title: '测试修仙作品', genres: ['修仙'], themes: ['成长'],
    summary: '少年在修仙途中成长。', original_intro: '少年在修仙途中成长。',
    pace: null, harem: null, romance: null, tragic: null,
    source_url: 'https://example.org/work-a', collected_at: '2026-10-21', review_note: '测试资料',
    evidence: [{ id: 'summary-1', field: 'summary', quote: '少年在修仙途中成长。' }],
    ...overrides,
  };
}
