import type { HomeRecommendation, Work } from '../src/types';

export function homeFixture(items:Work[]=[],overrides:Partial<HomeRecommendation>={}):HomeRecommendation {
  return {request_id:'home-test',strategy_version:'favorites-tags-v1',carousel_mode:'default',prompts_mode:'default',warnings:[],
    items:items.map(work=>({...work,basis:'public',matched_features:{content_type:[],genres:[],themes:[]},reason:'片库精选'})),
    prompts:[{label:'修仙逆袭',text:'想看修仙题材，偏好逆袭主题。',basis:'public',genres:[],themes:[]},
      {label:'穿越重生',text:'想看带有穿越和重生元素的故事。',basis:'public',genres:[],themes:[]},
      {label:'末世系统',text:'想看末世题材，偏好系统主题。',basis:'public',genres:[],themes:[]},
      {label:'都市成长',text:'想看都市题材，偏好成长主题。',basis:'public',genres:[],themes:[]}],...overrides};
}

export function workFixture(overrides: Partial<Work> = {}): Work {
  return {
    id: 'work-a', title: '测试修仙作品', genres: ['修仙'], themes: ['成长'],
    summary: '少年在修仙途中成长。', original_intro: '少年在修仙途中成长。',
    pace: null, harem: null, romance: null, tragic: null,
    review:{revision:1,state:'automatic',confirmed_fields:[],recheck_fields:[]},
    source_url: 'https://example.org/work-a', collected_at: '2026-10-21', review_note: '测试资料',
    evidence: [{ id: 'summary-1', field: 'summary', quote: '少年在修仙途中成长。' }],
    ...overrides,
  };
}
