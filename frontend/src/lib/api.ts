import type { IntakeJob, WorkspaceMasterData } from '../types';

const TOKEN_KEY = 'tutupbuku.access-token.v1';

export type ApiConfig = {
  aiConfigured: boolean;
  maxUploadBytes: number;
  authMode: 'supabase' | 'local-development' | 'unconfigured';
  supabaseUrl?: string;
  supabaseAnonKey?: string;
};

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function token() { return window.sessionStorage.getItem(TOKEN_KEY); }
export function savedToken() { return token(); }
export function saveToken(value: string | null) {
  if (value) window.sessionStorage.setItem(TOKEN_KEY, value);
  else window.sessionStorage.removeItem(TOKEN_KEY);
}

export async function request<T>(path: string, options: RequestInit = {}, accessToken = token()): Promise<T> {
  const headers = new Headers(options.headers);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  const response = await fetch(path, { ...options, headers, cache: 'no-store' });
  if (response.status === 401 && accessToken) window.dispatchEvent(new CustomEvent('tutupbuku:unauthorized'));
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; code?: string };
    throw new ApiError(body.error || `Request failed (${response.status}).`, response.status, body.code);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function loadConfig() { return request<ApiConfig>('/api/config', {}, null); }
export async function localSignIn(email: string) {
  return request<{ accessToken: string }>('/api/auth/local', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
  }, null);
}
export async function supabaseSignIn(config: ApiConfig, email: string, password: string) {
  if (!config.supabaseUrl || !config.supabaseAnonKey) throw new ApiError('Supabase sign-in is not configured.', 503);
  const response = await fetch(`${config.supabaseUrl.replace(/\/$/, '')}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: config.supabaseAnonKey }, body: JSON.stringify({ email, password }),
  });
  const data = await response.json().catch(() => ({})) as { access_token?: string; msg?: string; error_description?: string };
  if (!response.ok || !data.access_token) throw new ApiError('Sign-in failed. Check your email and password.', response.status);
  return data.access_token;
}

export async function uploadFile(file: File, workflow: 'auto' | 'purchasing' | 'claim', purpose = '', idempotencyKey = crypto.randomUUID()) {
  const headers = new Headers({
    'Content-Type': file.type || mimeFor(file.name),
    'X-Filename': encodeURIComponent(file.name),
    'X-Workflow': workflow,
    'Idempotency-Key': idempotencyKey,
  });
  if (purpose) headers.set('X-Claim-Purpose', encodeURIComponent(purpose));
  return request<{ document: Record<string, unknown>; job: IntakeJob; idempotentReplay?: boolean }>('/api/documents', {
    method: 'POST', headers, body: file,
  });
}

function mimeFor(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  return ({ csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' } as Record<string, string>)[ext || ''] || 'application/octet-stream';
}

export async function listJobs() { return request<IntakeJob[]>('/api/jobs'); }
export async function getJob(jobId: string) { return request<IntakeJob>(`/api/jobs/${encodeURIComponent(jobId)}`); }
export async function listDocuments() { return request<Record<string, unknown>[]>('/api/documents'); }
export async function listIssues() { return request<Record<string, unknown>[]>('/api/issues'); }
export async function getMasterData() { return request<WorkspaceMasterData>('/api/master-data'); }
export async function saveMasterData(value: WorkspaceMasterData) {
  return request<WorkspaceMasterData>('/api/master-data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
}
export async function downloadOriginal(documentId: string) {
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/file`, { headers: token() ? { Authorization: `Bearer ${token()}` } : {}, cache: 'no-store' });
  if (!response.ok) throw new ApiError('The original file is unavailable.', response.status);
  return response.blob();
}

export async function downloadExport(kind: 'purchasing-approved' | 'claims-approved', range: { from?: string; to?: string } = {}) {
  const query = new URLSearchParams({ kind });
  if (range.from) query.set('from', range.from);
  if (range.to) query.set('to', range.to);
  const response = await fetch(`/api/export?${query}`, { headers: token() ? { Authorization: `Bearer ${token()}` } : {}, cache: 'no-store' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new ApiError(body.error || `Export failed (${response.status}).`, response.status);
  }
  const disposition = response.headers.get('content-disposition') || '';
  const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] || `tutupbuku-${kind}.csv`;
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function idempotencyKey(file: File, index: number) { return `${crypto.randomUUID()}-${index}-${file.size}`; }
