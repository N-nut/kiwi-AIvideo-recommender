export interface Requirement { field: 'genres' | 'themes' | 'pace' | 'harem' | 'romance' | 'tragic'; value: string | boolean }
export interface Preferences {
  schema_version: 1;
  soft_preferences: { genres: string[]; themes: string[]; pace: '快' | '舒缓' | null };
  required: Requirement[]; excluded_features: string[]; excluded_genres: string[];
  unresolved_constraints: string[]; conflicts: string[];
}
export interface Evidence { id: string; field: string; quote: string }
export interface PreviewMedia {
  asset_id:string; clip_kind:'trailer'|'excerpt'; video_url:string; poster_url:string|null;
  content_type:'video/mp4'; duration_ms:number; width:number; height:number; source_page_url:string; checked_at:string;
}
export interface PreviewResponse {
  request_id:string; work_id:string; status:'ready'|'missing'|'pending'|'unavailable'|'not_applicable'; message:string; preview:PreviewMedia|null; preparing?:boolean;
}
export interface Work {
  id: string; title: string; summary: string; original_intro: string; genres: string[]; themes: string[];
  pace: string | null; harem: boolean | null; romance: boolean | null; tragic: boolean | null;
  source_url: string; collected_at: string; evidence: Evidence[]; review_note: string;
  cover_url?: string | null;
  review?: {revision:number;state:'automatic'|'partial'|'recheck'|'unavailable';confirmed_fields:string[];recheck_fields:string[]};
  source_meta?: { provider: 'hongguo'; content_type: '真人剧' | '漫剧' | 'AI剧' | '漫画' | '未标注'; tags: string[]; pages: string[]; categories?: string[]; rank: number | null; heat: string | null; episode_count: number | null; chapter_count?: number | null; classification_note?: string } | null;
  reason?: string; reason_mode?: 'model' | 'template'; evidence_ids?: string[]; caveats?: string[];
}
export interface Recommendation { request_id: string; status: 'success' | 'empty' | 'needs_confirmation'; items: Work[]; warnings: string[]; timings_ms: Record<string, number>; mode: string; batch?:{state:'ready'|'exhausted';has_more:boolean|null}|null;history?:{status:'saved';id:string}|{status:'failed'}|null }
export type RefinementValue=string|boolean;
export interface RefinementChange {kind:'added'|'removed'|'replaced';target:string;before:RefinementValue[];after:RefinementValue[]}
export interface RefinementPreserved {target:string;values:RefinementValue[]}
export interface RefinementResponse {
  request_id:string;status:'ready'|'no_change'|'needs_confirmation';base_revision:number;preferences:Preferences|null;
  changes:RefinementChange[];preserved:RefinementPreserved[];issues:string[];mode:'baseline'|'live';timings_ms:Record<string,number>;usage:{calls:number;tokens:number};
}
export interface HistorySummary {id:string;query:string;created_at:string;count:number;mode:string;preferences:Preferences;titles:string[]}
export interface HistoryDetail extends HistorySummary {warnings:string[];items:{id:string;title:string;available:boolean;changed:boolean;work:Work|null}[]}
export type FeedbackStatus='not_interested'|'watched';
export interface Feedback {work_id:string;status:FeedbackStatus;revision:string;updated_at:string}
export interface FeedbackItem extends Feedback {available:boolean;work:{id:string;title:string;cover_url:string|null}|null}
export const feedbackLabels:Record<FeedbackStatus,string>={not_interested:'不感兴趣',watched:'已看过'};
export interface HomeWorkItem extends Work {
  basis: 'favorites' | 'public';
  matched_features: {content_type:string[];genres:string[];themes:string[]};
  reason: string;
}
export interface PromptSuggestion {label:string;text:string;basis:'favorites'|'public';genres:string[];themes:string[]}
export interface HomeRecommendation {
  request_id:string;strategy_version:'favorites-tags-v1';
  carousel_mode:'personalized'|'mixed'|'default';prompts_mode:'personalized'|'default';
  items:HomeWorkItem[];prompts:PromptSuggestion[];warnings:string[];
}
export interface RefreshScope { categories: string[]; include_hot_rank: boolean }
export interface PreviewProgress {total:number;ready:number;pending:number;running:number;unavailable:number;enabled:boolean;active:boolean;error_code?:string|null}
export interface CatalogRefresh { previews?:PreviewProgress|null; status: 'idle' | 'running' | 'succeeded' | 'failed'; message: string; limits?:{pages_per_source:number;max_pages:number;max_works:number}; run_id?: string; scope?: RefreshScope; stage?:string; category?:string; current_page?:number; pages_done?:number; raw_count?:number; unique_count?:number; indexed?:number; index_total?:number; last_success_at?: string; cooldown?: boolean; reused?:boolean; result?: { total: number; catalog_total?:number; new?:number; updated?:number; unchanged?:number; embedded?:number; pages_done?:number; raw_count?:number; coverage?:'complete'|'limited'; indexing_enabled?:boolean; indexed_total?:number; same_title_groups?:number; filtered_unclassified?:number } | null }
export const collectionCategories = [{value:'comic-drama',label:'漫剧'},{value:'ai-drama',label:'AI剧'},{value:'real-drama',label:'真人剧'},{value:'comic',label:'漫画'}];
export const genres = ['修仙','玄幻','都市','末世','科幻','悬疑','恋爱','古风','搞笑','武侠'];
export const themes = ['逆袭','复仇','重生','穿越','系统','成长','冒险','经营','治愈','战斗'];
export const featureNames: Record<string, string> = { harem: '后宫', romance: '感情线', tragic: '虐心' };
export const fieldNames: Record<string, string> = { ...featureNames, genres: '题材', themes: '剧情特色', pace: '节奏', summary: '故事简介' };
export function emptyPreferences(): Preferences { return { schema_version: 1, soft_preferences: { genres: [], themes: [], pace: null }, required: [], excluded_features: [], excluded_genres: [], unresolved_constraints: [], conflicts: [] }; }
