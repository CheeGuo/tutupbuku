import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { DataProvider } from './state/store';
import { AgentProvider } from './lib/agent';
import { AuthProvider, useAuth } from './state/auth';
import { AppShell } from './layout/AppShell';
import { Execution } from './pages/Execution';
import { Documents } from './pages/Documents';
import { ActionItems } from './pages/ActionItems';
import { SignIn } from './pages/SignIn';

function Workspace() {
  const auth = useAuth();
  if (auth.loading) return <main className="app-loading" role="status">Loading your session…</main>;
  if (!auth.token || !auth.role) return <SignIn />;
  return <DataProvider key={auth.token}><AgentProvider><BrowserRouter><Routes>
    <Route element={<AppShell />}>
      <Route path="/" element={<Execution />} />
      <Route path="/documents" element={<Documents />} />
      <Route path="/issues" element={<ActionItems />} />
    </Route>
    <Route path="/exceptions" element={<Navigate to="/issues" replace />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></BrowserRouter></AgentProvider></DataProvider>;
}

export default function App() {
  return <AuthProvider><Workspace /></AuthProvider>;
}
