export class APIError extends Error {
  constructor(message: string, public requestId?: string, public status?: number) { super(message); }
}
export async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : {'Content-Type':'application/json'}, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new APIError(data.error?.message || data.detail || '服务暂时不可用，请重试', data.request_id, response.status);
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
