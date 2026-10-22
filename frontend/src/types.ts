export interface Requirement { field: 'genres' | 'themes' | 'pace' | 'harem' | 'romance' | 'tragic'; value: string | boolean }
export interface Preferences {
  schema_version: 1;
  soft_preferences: { genres: string[]; themes: string[]; pace: '快' | '舒缓' | null };
  required: Requirement[]; excluded_features: string[]; excluded_genres: string[];
  unresolved_constraints: string[]; conflicts: string[];
}
export interface Evidence { id: string; field: string; quote: string }
export interface Work {
  id: string; title: string; summary: string; original_intro: string; genres: string[]; themes: string[];
  pace: string | null; harem: boolean | null; romance: boolean | null; tragic: boolean | null;
  source_url: string; collected_at: string; evidence: Evidence[]; review_note: string;
  cover_url?: string | null;
  source_meta?: { provider: 'hongguo'; content_type: '真人剧' | '漫剧' | 'AI剧' | '漫画' | '未标注'; tags: string[]; pages: string[]; categories?: string[]; rank: number | null; heat: string | null; episode_count: number | null; chapter_count?: number | null; classification_note?: string } | null;
  reason?: string; reason_mode?: 'model' | 'template'; evidence_ids?: string[]; caveats?: string[];
}
export interface Recommendation { request_id: string; status: 'success' | 'empty' | 'needs_confirmation'; items: Work[]; warnings: string[]; timings_ms: Record<string, number>; mode: string }
export interface RefreshScope { categories: string[]; include_hot_rank: boolean }
export interface CatalogRefresh { status: 'idle' | 'running' | 'succeeded' | 'failed'; message: string; limits?:{pages_per_source:number;max_pages:number;max_works:number}; run_id?: string; scope?: RefreshScope; stage?:string; category?:string; current_page?:number; pages_done?:number; raw_count?:number; unique_count?:number; indexed?:number; index_total?:number; last_success_at?: string; cooldown?: boolean; reused?:boolean; result?: { total: number; catalog_total?:number; new?:number; updated?:number; unchanged?:number; embedded?:number; pages_done?:number; raw_count?:number; coverage?:'complete'|'limited'; indexing_enabled?:boolean; indexed_total?:number; same_title_groups?:number; filtered_unclassified?:number } | null }
export const collectionCategories = [{value:'comic-drama',label:'漫剧'},{value:'ai-drama',label:'AI剧'},{value:'real-drama',label:'真人剧'},{value:'comic',label:'漫画'}];
export const genres = ['修仙','玄幻','都市','末世','科幻','悬疑','恋爱','古风','搞笑','武侠'];
export const themes = ['逆袭','复仇','重生','穿越','系统','成长','冒险','经营','治愈','战斗'];
export const featureNames: Record<string, string> = { harem: '后宫', romance: '感情线', tragic: '虐心' };
export const fieldNames: Record<string, string> = { ...featureNames, genres: '题材', themes: '剧情特色', pace: '节奏', summary: '故事简介' };
export function emptyPreferences(): Preferences { return { schema_version: 1, soft_preferences: { genres: [], themes: [], pace: null }, required: [], excluded_features: [], excluded_genres: [], unresolved_constraints: [], conflicts: [] }; }
