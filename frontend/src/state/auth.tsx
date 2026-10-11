import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiFetch, apiJson, clearAccessToken, getAccessToken, saveAccessToken } from '../lib/api';

export type AuthMode = 'local-development' | 'supabase' | 'unconfigured';
export type Role = 'owner' | 'reviewer' | 'employee';
export interface ApiConfig { authMode: AuthMode; supabaseUrl?: string; supabaseAnonKey?: string; aiConfigured?: boolean; maxUploadBytes?: number }
export interface UserSession { email: string; role: Role }
interface AuthApi { config: ApiConfig | null; user: UserSession | null; loading: boolean; error: string; signIn: (email: string, password?: string) => Promise<void>; signOut: () => void; reconnect: () => void }

const Ctx = createContext<AuthApi | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<ApiConfig | null>(null);
  const [user, setUser] = useState<UserSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [check, setCheck] = useState(0);

  useEffect(() => {
    const invalidate = () => {
      clearAccessToken();
      window.sessionStorage.removeItem('tutupbuku.user-email');
      setUser(null);
      setError('Your session expired. Sign in again to continue.');
    };
    window.addEventListener('tutupbuku:unauthorized', invalidate);
    return () => window.removeEventListener('tutupbuku:unauthorized', invalidate);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const result = await apiJson<ApiConfig>('/api/config', { authenticated: false, signal: controller.signal });
        setConfig(result);
        const token = getAccessToken();
        const email = window.sessionStorage.getItem('tutupbuku.user-email');
        if (token && email) {
          try {
            const session = await apiJson<{ role: Role }>('/api/session', { token, signal: controller.signal });
            setUser({ email, role: session.role });
          } catch {
            clearAccessToken();
            window.sessionStorage.removeItem('tutupbuku.user-email');
          }
        }
      } catch (reason) {
        if ((reason as Error).name !== 'AbortError') setError((reason as Error).message || 'The backend is unavailable.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [check]);

  const signIn = useCallback(async (emailInput: string, password?: string) => {
    if (!config) throw new Error('Backend configuration has not loaded.');
    const email = emailInput.trim().toLowerCase();
    let token: string;
    if (config.authMode === 'local-development') {
      const result = await apiJson<{ accessToken: string }>('/api/auth/local', { method: 'POST', authenticated: false, body: { email } });
      token = result.accessToken;
    } else if (config.authMode === 'supabase' && config.supabaseUrl && config.supabaseAnonKey) {
      if (!password) throw new Error('Enter your password.');
      const response = await fetch(`${config.supabaseUrl.replace(/\/$/u, '')}/auth/v1/token?grant_type=password`, {
        method: 'POST', credentials: 'omit',
        headers: { apikey: config.supabaseAnonKey, 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const result = await response.json().catch(() => ({})) as { access_token?: string; error_description?: string; msg?: string; user?: { email?: string } };
      if (!response.ok || !result.access_token) throw new Error(result.error_description || result.msg || 'Email or password was not accepted.');
      token = result.access_token;
    } else {
      throw new Error('Backend sign-in is not configured. Set Supabase Auth credentials in the backend environment.');
    }

    saveAccessToken(token);
    window.sessionStorage.setItem('tutupbuku.user-email', email);
    try {
      const session = await apiJson<{ role: Role }>('/api/session');
      setUser({ email, role: session.role });
      setError('');
    } catch (reason) {
      clearAccessToken();
      window.sessionStorage.removeItem('tutupbuku.user-email');
      throw reason;
    }
  }, [config]);

  const signOut = useCallback(() => {
    clearAccessToken();
    window.sessionStorage.removeItem('tutupbuku.user-email');
    window.sessionStorage.removeItem('tutupbuku.chats.v1');
    setUser(null);
    setError('');
  }, []);

  const value = useMemo<AuthApi>(() => ({ config, user, loading, error, signIn, signOut, reconnect: () => setCheck(n => n + 1) }), [config, user, loading, error, signIn, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const value = useContext(Ctx);
  if (!value) throw new Error('AuthProvider is required.');
  return value;
}

export async function downloadApiFile(path: string, filename?: string) {
  const response = await apiFetch(path);
  const blob = await response.blob();
  const contentDisposition = response.headers.get('content-disposition') || '';
  const encodedName = /filename\*=UTF-8''([^;]+)/iu.exec(contentDisposition)?.[1];
  const ordinaryName = /filename="?([^";]+)"?/iu.exec(contentDisposition)?.[1];
  const name = filename || (encodedName ? decodeURIComponent(encodedName) : ordinaryName) || 'download';
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
