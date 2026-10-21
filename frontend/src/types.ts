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
  reason?: string; reason_mode?: 'model' | 'template'; evidence_ids?: string[]; caveats?: string[];
}
export interface Recommendation { request_id: string; status: 'success' | 'empty' | 'needs_confirmation'; items: Work[]; warnings: string[]; timings_ms: Record<string, number>; mode: string }
export const genres = ['修仙','玄幻','都市','末世','科幻','悬疑','恋爱','古风','搞笑','武侠'];
export const themes = ['逆袭','复仇','重生','穿越','系统','成长','冒险','经营','治愈','战斗'];
export const featureNames: Record<string, string> = { harem: '后宫', romance: '感情线', tragic: '虐心' };
export const fieldNames: Record<string, string> = { ...featureNames, genres: '题材', themes: '剧情特色', pace: '节奏', summary: '故事简介' };
export function emptyPreferences(): Preferences { return { schema_version: 1, soft_preferences: { genres: [], themes: [], pace: null }, required: [], excluded_features: [], excluded_genres: [], unresolved_constraints: [], conflicts: [] }; }
