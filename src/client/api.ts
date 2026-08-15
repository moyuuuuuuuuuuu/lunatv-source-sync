export interface Session { authenticated: true; csrfToken: string; expiresAt: string }
let csrfToken = '';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (csrfToken && !['GET', 'HEAD'].includes(init.method ?? 'GET')) headers.set('x-csrf-token', csrfToken);
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; code?: string };
    throw new ApiError(body.error || `请求失败 (${response.status})`, response.status, body.code);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export async function session(): Promise<Session | null> {
  try { const value = await request<Session>('/api/auth/session'); csrfToken = value.csrfToken; return value; }
  catch (error) { if (error instanceof ApiError && error.status === 401) return null; throw error; }
}
export async function login(username: string, password: string): Promise<Session> {
  const value = await request<Session>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  csrfToken = value.csrfToken; return value;
}
export async function logout(): Promise<void> { await request('/api/auth/logout', { method: 'POST' }); csrfToken = ''; }
export const api = {
  get: <T>(path: string) => request<T>(path),
  send: <T>(path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown) => request<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
};
