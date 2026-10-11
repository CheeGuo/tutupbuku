import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { DataProvider } from './state/store';
import { AgentProvider } from './lib/agent';
import { ExecutionProvider } from './lib/execution';
import { AppShell } from './layout/AppShell';
import { Execution } from './pages/Execution';
import { Documents } from './pages/Documents';
import { ActionItems } from './pages/ActionItems';
import { AuthProvider, useAuth } from './state/auth';
import { SignIn } from './pages/SignIn';

function Workspace() {
  const { user, loading } = useAuth();
  if (loading) return <main className="auth-page"><p role="status">Connecting to the backend…</p></main>;
  if (!user) return <SignIn />;

  return <DataProvider><AgentProvider><ExecutionProvider><BrowserRouter><Routes>
    <Route element={<AppShell />}>
      <Route path="/" element={<Execution />} />
      <Route path="/documents" element={<Documents />} />
      <Route path="/issues" element={<ActionItems />} />
    </Route>
    <Route path="/exceptions" element={<Navigate to="/issues" replace />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></BrowserRouter></ExecutionProvider></AgentProvider></DataProvider>;
}

export default function App() {
  return <AuthProvider><Workspace /></AuthProvider>;
}
