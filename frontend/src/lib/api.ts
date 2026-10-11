export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';
const TOKEN_KEY = 'tutupbuku.access-token';

export type ApiRequestOptions = Omit<RequestInit, 'body'> & {
  body?: BodyInit | Record<string, unknown> | unknown[] | null;
  authenticated?: boolean;
  token?: string | null;
};

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export function saveAccessToken(token: string | null) {
  if (!token) {
    window.sessionStorage.removeItem(TOKEN_KEY);
    return;
  }
  window.sessionStorage.setItem(TOKEN_KEY, token);
}

export function getAccessToken() {
  return window.sessionStorage.getItem(TOKEN_KEY);
}

export function clearAccessToken() {
  saveAccessToken(null);
}

export async function apiFetch(path: string, options: ApiRequestOptions = {}): Promise<Response> {
  const { authenticated = true, token, body, headers: inputHeaders, ...init } = options;
  const headers = new Headers(inputHeaders);
  const accessToken = token === undefined ? getAccessToken() : token;
  if (authenticated && accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  if (API_BASE_URL) headers.set('ngrok-skip-browser-warning', 'true');

  let requestBody: BodyInit | null | undefined;
  if (body === undefined || body === null || typeof body === 'string' || body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof FormData || body instanceof URLSearchParams) {
    requestBody = body as BodyInit | null | undefined;
  } else {
    requestBody = JSON.stringify(body);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  }

  const response = await fetch(`${API_BASE_URL}${path}`, { ...init, body: requestBody, headers, credentials: 'omit' });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { error?: string; code?: string };
    if (response.status === 401) window.dispatchEvent(new Event('tutupbuku:unauthorized'));
    throw new ApiError(detail.error || `Service request failed (${response.status}).`, response.status, detail.code);
  }
  return response;
}

export async function apiJson<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const response = await apiFetch(path, options);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
