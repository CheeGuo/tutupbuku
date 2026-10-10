import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { loadConfig, localSignIn, request, savedToken, saveToken, supabaseSignIn, type ApiConfig } from '../lib/api';

export type UserRole = 'owner' | 'reviewer' | 'employee';
interface AuthValue {
  token: string | null;
  role: UserRole | null;
  config: ApiConfig | null;
  loading: boolean;
  error: string;
  signIn: (email: string, password?: string) => Promise<void>;
  signOut: () => void;
  refreshSession: () => Promise<void>;
}
const Context = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() => savedToken());
  const [role, setRole] = useState<UserRole | null>(null);
  const [config, setConfig] = useState<ApiConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void loadConfig().then(value => { if (active) setConfig(value); }).catch(() => { if (active) setConfig({ authMode: 'unconfigured', aiConfigured: false, maxUploadBytes: 15 * 1024 * 1024 }); });
    return () => { active = false; };
  }, []);

  const signOut = useCallback(() => { saveToken(null); setToken(null); setRole(null); setError(''); }, []);
  const refreshSession = useCallback(async () => {
    if (!token) { setRole(null); setLoading(false); return; }
    setLoading(true);
    try {
      const session = await request<{ role: UserRole }>('/api/session', {}, token);
      if (!['owner', 'reviewer', 'employee'].includes(session.role)) throw new Error('This account does not have an allowed TutupBuku role.');
      setRole(session.role); setError('');
    } catch (cause) {
      signOut();
      if ((cause as { status?: number }).status !== 401) setError((cause as Error).message || 'Could not load your account.');
    } finally { setLoading(false); }
  }, [token, signOut]);

  useEffect(() => { void refreshSession(); }, [refreshSession]);
  useEffect(() => {
    const unauthorized = () => signOut();
    window.addEventListener('tutupbuku:unauthorized', unauthorized);
    return () => window.removeEventListener('tutupbuku:unauthorized', unauthorized);
  }, [signOut]);

  const signIn = useCallback(async (email: string, password = '') => {
    setError(''); setLoading(true);
    try {
      const currentConfig = config ?? await loadConfig();
      const accessToken = currentConfig.authMode === 'supabase'
        ? await supabaseSignIn(currentConfig, email, password)
        : currentConfig.authMode === 'local-development'
          ? (await localSignIn(email)).accessToken
          : (() => { throw new Error('The service is not configured for sign-in. Start the local backend or configure production authentication.'); })();
      saveToken(accessToken); setToken(accessToken);
    } catch (cause) { setError((cause as Error).message || 'Sign-in failed.'); setLoading(false); throw cause; }
  }, [config]);

  const value = useMemo(() => ({ token, role, config, loading, error, signIn, signOut, refreshSession }), [token, role, config, loading, error, signIn, signOut, refreshSession]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAuth() {
  const value = useContext(Context);
  if (!value) throw new Error('AuthProvider is required.');
  return value;
}
