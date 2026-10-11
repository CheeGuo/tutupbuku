import React, { useState } from 'react';
import { useAuth } from '../state/auth';
import logo from '../assets/tutupbuku-logo.png';

export function SignIn() {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const mode = auth.config?.authMode;

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email.trim())) { setError('Enter a valid email address.'); return; }
    if (mode === 'supabase' && !password) { setError('Enter your password.'); return; }
    setSubmitting(true);
    try { await auth.signIn(email.trim(), password); }
    catch (cause) { setError((cause as Error).message || 'Sign-in could not be completed.'); setPassword(''); }
    finally { setSubmitting(false); }
  };

  return <main className="signin-page">
    <section className="signin-card" aria-labelledby="signin-title">
      <img src={logo} alt="" width="64" height="64" />
      <p className="eyebrow">TutupBuku · Finance workspace</p>
      <h1 id="signin-title">Sign in to your records</h1>
      <p>Purchasing documents, employee claims, and review decisions stay in your business workspace.</p>
      {!mode && <p className="notice notice-warn" role="status">Connecting to the service…</p>}
      {mode === 'unconfigured' && <p className="notice notice-error" role="alert">The service is not configured for sign-in. Start the local backend for development or configure Supabase Auth.</p>}
      {auth.error && <p className="notice notice-error" role="alert">{auth.error}</p>}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {mode && mode !== 'unconfigured' && <form noValidate onSubmit={submit}>
        <label className="field" htmlFor="signin-email"><span>Email address</span>
          <input id="signin-email" type="email" autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} required />
        </label>
        {mode === 'supabase' ? <label className="field" htmlFor="signin-password"><span>Password</span>
          <input id="signin-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required />
        </label> : <p className="hint">Local development sign-in · email only</p>}
        <button className="btn btn-primary signin-submit" type="submit" disabled={submitting || auth.loading}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>}
    </section>
  </main>;
}
