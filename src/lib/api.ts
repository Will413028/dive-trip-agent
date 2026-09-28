export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

export async function request<T>(url: string, body?: unknown, method?: 'DELETE'): Promise<T> {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  if (serialized && new TextEncoder().encode(serialized).length >= 32 * 1024) {
    throw new ApiError(400, 'REQUEST_TOO_LARGE');
  }
  const response = await fetch(url, {
    method: method ?? (serialized === undefined ? 'GET' : 'POST'), cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
    credentials: 'same-origin',
    ...(serialized === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: serialized }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(response.status, typeof data.error === 'string' ? data.error : 'REQUEST_FAILED');
  }
  return response.json() as Promise<T>;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'RUN_ACTIVE') return 'Agent 仍在執行，請稍候再試。';
    if (error.status === 409) return '行程已更新，請重新整理，再重新產生提案。';
    if (error.status === 404) return '找不到可存取的行程或提案，可能已過期，請回首頁重新試玩。';
    if (error.status === 400) return '無法處理這次修改，請檢查輸入與提案內容。';
    if (error.status === 429) return '操作較頻繁，請稍後再試。';
    return '服務暫時無法使用，請稍後再試。';
  }
  return '連線中斷或未收到完整回應，請再試一次。';
}
