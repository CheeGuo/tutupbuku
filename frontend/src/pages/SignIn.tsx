import React, { useState } from 'react';
import { useAuth } from '../state/auth';
import logo from '../assets/tutupbuku-logo.png';

export function SignIn() {
  const { config, error: connectionError, loading, reconnect, signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const local = config?.authMode === 'local-development';
  const configured = config?.authMode === 'local-development' || config?.authMode === 'supabase';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError('');
    try { await signIn(email, password); }
    catch (reason) { setError((reason as Error).message); }
    finally { setPending(false); }
  };

  return <main className="auth-page"><section className="auth-card" aria-labelledby="signin-title">
    <img className="auth-logo" src={logo} alt="TutupBuku" />
    <p className="eyebrow">TutupBuku · Finance workspace</p>
    <h1 id="signin-title">Sign in to your records</h1>
    <p className="auth-intro">Purchasing documents, employee claims, and review decisions stay in your business workspace.</p>
    {loading ? <p role="status">Connecting to the backend…</p> : configured ? <form className="auth-form" onSubmit={submit}>
      <label className="field"><span>Email</span><input type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} /></label>
      {!local && <label className="field"><span>Password</span><input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>}
      {local && <p className="auth-note">Local development sign-in. Do not use this mode on a public deployment.</p>}
      {(error || connectionError) && <p className="auth-error" role="alert">{error || connectionError}</p>}
      <button className="btn btn-primary" type="submit" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
    </form> : <div className="auth-error" role="alert">
      <p>{connectionError || 'The service is not configured for sign-in. Configure Supabase Auth on the backend.'}</p>
      {connectionError && <button className="btn btn-sm" type="button" onClick={reconnect}>Reconnect</button>}
    </div>}
  </section></main>;
}
