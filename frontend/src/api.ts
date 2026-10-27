import type { PreviewResponse } from './types';
export const getPreview = (id:string, signal?:AbortSignal) => api<PreviewResponse>(`/api/v1/works/${encodeURIComponent(id)}/preview`, undefined, signal);
export class APIError extends Error {
  constructor(message: string, public requestId?: string, public status?: number, public fields: Record<string,string> = {}, public retryAfter?:number) { super(message); }
}
export async function api<T>(path: string, body?: unknown, signal?: AbortSignal, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const headers: Record<string,string> = body === undefined ? {} : {'Content-Type':'application/json'};
  if (method !== 'GET' && path.startsWith('/api/v1/')) headers['X-Kiwi-Request']='1';
  const response = await fetch(path, { method, credentials:'same-origin',
    headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  if (response.ok && response.status === 204) return undefined as T;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new APIError(data.error?.message || data.detail || '服务暂时不可用，请重试', data.request_id, response.status, data.error?.field_messages || {}, Number(response.headers.get('Retry-After'))||undefined);
  return data as T;
}
// A completed request from a previous input must never overwrite current edits.
export function latestRequest() {
  let revision = 0;
  let controller: AbortController | undefined;
  return {
    cancel() { revision++; controller?.abort(); },
    begin() { controller?.abort(); controller = new AbortController(); const id = ++revision;
      return { signal: controller.signal, current: () => id === revision }; },
  };
}
