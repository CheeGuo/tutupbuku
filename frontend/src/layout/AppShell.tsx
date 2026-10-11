import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useExecution } from '../lib/execution';
import { useData } from '../state/store';
import { Toasts } from '../components/ui';
import logo from '../assets/tutupbuku-logo.png';

const NAV = [
  { to: '/', label: 'Live Execution', full: 'Agentic Live Execution', end: true },
  { to: '/documents', label: 'Documents', full: 'Documents', end: false },
  { to: '/issues', label: 'Action Items', full: 'Action Items', end: false },
];

export function AppShell() {
  const { connection } = useExecution();
  const { issues, claims } = useData();
  const open = issues.filter(i => i.status === 'OPEN' || i.status === 'UNDER_REVIEW').length + claims.filter(c => c.status === 'PLAUSIBLE' || c.status === 'NEEDS_REVIEW').length;
  return <div className="shell">
    <a className="skip-link" href="#content">Skip to content</a>
    <header className="topbar">
      <NavLink to="/" className="brand" aria-label="TutupBuku home"><img src={logo} alt="" /><span>TutupBuku</span></NavLink>
      <nav className="nav" aria-label="Main navigation">
        {NAV.map(item => <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} aria-label={item.full}>
          {item.label}{item.to === '/issues' && open > 0 && <span className="nav-count" aria-label={`${open} items need action`}>{open}</span>}
        </NavLink>)}
      </nav>
      <div className={`conn conn-${connection}`} role="status" title="Month-end review service">
        <span className="conn-dot" aria-hidden="true" />
        <span className="conn-text">{connection === 'connected' ? 'Review service connected' : connection === 'checking' ? 'Connecting…' : 'Review service offline'}</span>
      </div>
    </header>
    <main id="content" className="content" tabIndex={-1}><Outlet /></main>
    <Toasts />
  </div>;
}
