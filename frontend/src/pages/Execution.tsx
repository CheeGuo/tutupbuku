import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatTimestamp } from '../lib/format';
import { DEFAULT_GOAL, OUTPUTS, stageLabel, STEPS, useExecution } from '../lib/execution';
import { DEMO_STAGES, STARTERS, useAgent } from '../lib/agent';
import { HumanCheckpoint } from '../components/ExecutionReview';
import { ChatMessage } from '../components/ChatCards';
import { Orbit, OrbitMode, OrbitNode } from '../components/Orbit';
import { useData } from '../state/store';

const SHORT = ['Inspect', 'Validate', 'Match', 'Review', 'Export'];
const ICONS: OrbitNode['icon'][] = ['document', 'filter', 'link', 'person', 'arrow'];
const HINTS: Record<string, string> = { claim: 'Give the purpose, attach the receipt', dinner: 'Check a meal receipt against its purpose', process: 'Read it, link it to a PO and verify', match: 'Find the purchase order it belongs to', compare: 'Compare prices and quantities line by line' };
const COMMANDS = ['status', 'issues', 'results', 'evidence'];
const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*';
const FILE_OK = /\.(pdf|png|jpe?g|webp)$/i;

export function Execution() {
  const { cases, caseId, caseData, draft, setDraft, run, connection, error, pending, busy, start, reconnect, changeCase, changeGoal, setError } = useExecution();
  const agent = useAgent();
  const backend = useData();
  const [workflow, setWorkflow] = useState<'demo' | 'run'>(run ? 'run' : 'demo');
  const [hideRun, setHideRun] = useState(false);   // the month-end run is a separate conversation; a new chat hides it
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState('');
  const [drag, setDrag] = useState(false);
  const [reportPreview, setReportPreview] = useState<{ file: string; text: string } | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const previewRequest = useRef<AbortController | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    const menus = () => Array.from(document.querySelectorAll<HTMLDetailsElement>('details.history, details.suggest'));
    const away = (ev: Event) => menus().forEach(d => { if (d.open && !d.contains(ev.target as Node)) d.open = false; });
    const esc = (ev: KeyboardEvent) => { if (ev.key === 'Escape') menus().forEach(d => { d.open = false; }); };
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, []);
  const firstStamp = useRef(agent.stamp);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; previewRequest.current?.abort(); }; }, []);
  useEffect(() => { previewRequest.current?.abort(); setPreviewPending(false); setReportPreview(null); setFocusId(null); if (run) setWorkflow('run'); }, [run?.id, caseId]);
  useEffect(() => { if (agent.stamp !== firstStamp.current) { setWorkflow('demo'); setFocusId(null); } }, [agent.stamp]);

  /* ---- what the orbit and stage list describe: the workflow the user touched last ---- */
  const demo = workflow === 'demo' || !run || hideRun;
  const runStages = run?.stages || STEPS.map(([id, label, executor]) => ({ id, label, executor, status: 'queued', detail: '' }));
  const demoStages = DEMO_STAGES.map((label, i) => ({ id: `d${i}`, label, executor: 'TutupBuku backend', status: agent.stages[i], detail: '' }));
  const stages = demo ? demoStages : runStages;
  const currentStage = stages.find(stage => ['running', 'waiting'].includes(stage.status));
  const focusStage = stages.find(stage => stage.id === focusId) || currentStage;
  const completed = stages.filter(stage => stage.status === 'completed').length;
  const mode: OrbitMode = demo
    ? (agent.stages.includes('failed') ? 'error' : agent.busy || agent.stages.includes('running') ? 'running' : agent.stages.includes('waiting') ? 'waiting' : agent.stages.every(s => s === 'completed') ? 'done' : 'idle')
    : !run ? 'idle' : run.error || run.status === 'failed' ? 'error' : run.status === 'running' ? 'running' : run.status === 'waiting_for_input' ? 'waiting' : run.status === 'completed' ? 'done' : 'idle';
  const nodes: OrbitNode[] = stages.map((stage, i) => ({ id: stage.id, label: demo ? stage.label : SHORT[i] ?? stage.label, status: stage.status, icon: ICONS[i % ICONS.length] }));
  const matched = run?.matching?.bank_rows.filter(row => ['proposed_match', 'confirmed_by_operator'].includes(row.state)).length || 0;
  const issueCount = (run?.matching?.exceptions.length || 0) + (run?.input_issues?.length || 0);
  const showRun = Boolean(run) && !hideRun;
  const showRunError = workflow === 'run' && Boolean(error);
  const active = showRun || agent.active;
  const stateLine = demo ? (agent.busy || agent.stages.includes('running') ? 'Processing' : agent.stages.includes('waiting') ? 'Waiting for you' : agent.stages.every(s => s === 'completed') ? 'Done' : 'Ready') : run ? stageLabel(run.status) : '';

  useEffect(() => { end.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' }); },
    [run?.events.length, run?.status, agent.messages.length]);

  const describeStatus = () => !run ? 'No month-end review run has started.' : `${stageLabel(run.status)}. ${runStages.filter(s => s.status === 'completed').length} of ${runStages.length} stages done. ${run.error || (run.pack ? `${run.pack.files.length} files exported; ${run.pack.open_item_count} items remain open.` : 'Inspect the stage list for details.')}`;
  const lookup = (prompt: string): boolean => {
    const command = prompt.trim().toLowerCase().replace(/[?.!]$/g, '');
    if (['status', 'show status', 'show progress'].includes(command)) { setWorkflow('run'); setHideRun(false); agent.reply(prompt, describeStatus(), run ? { hash: 'stage-list', action: 'Inspect stages' } : undefined); return true; }
    if (['issues', 'show issues', 'what needs my attention'].includes(command)) { agent.reply(prompt, run ? `${issueCount} issues are reported in the month-end run, plus any raised by documents and claims.` : 'Open Action Items to see everything that needs a decision.', { to: '/issues', action: 'Open Action Items' }); return true; }
    if (['results', 'show results', 'downloads'].includes(command)) { agent.reply(prompt, run?.pack ? `${run.pack.files.length} review files were exported with ${run.pack.open_item_count} open items.` : 'Approved records are exported from Documents; the review pack is available once a month-end run finishes.', run?.pack ? { hash: 'review-pack', action: 'View outputs' } : { to: '/documents', action: 'Open Documents' }); return true; }
    if (['evidence', 'show evidence', 'show documents'].includes(command)) { agent.reply(prompt, 'Saved records, with their extracted fields and links, are in Documents.', { to: '/documents', action: 'Open Documents' }); return true; }
    return false;
  };
  const takeFiles = (list: FileList | File[] | null) => {
    const picked = Array.from(list || []);
    const bad = picked.filter(f => !FILE_OK.test(f.name));
    setFileError(bad.length ? `Only PDFs and images can be attached: ${bad.map(f => f.name).join(', ')}.` : '');
    setFiles(items => [...items, ...picked.filter(f => FILE_OK.test(f.name))].slice(0, 5));
  };
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if ((!text && !files.length) || pending || agent.busy) return;
    if (!files.length && /\breview\b/i.test(text) && /\bpack\b/i.test(text)) {
      if (busy) { lookup('status'); setDraft(''); return; }
      setWorkflow('run'); setHideRun(false); start(event, text); return;
    }
    if (!files.length && lookup(text)) { setDraft(''); return; }
    setWorkflow('demo'); agent.send(text, files); setDraft(''); setFiles([]);
  };
  const previewReport = async (file: string) => {
    if (!run) return;
    previewRequest.current?.abort();
    const controller = new AbortController(); previewRequest.current = controller;
    setPreviewPending(true); setReportPreview(null);
    try {
      const response = await fetch(`/month-end-api/exports/${encodeURIComponent(file)}?case_id=${encodeURIComponent(run.case_id)}&run_id=${run.id}`, { signal: controller.signal });
      if (!response.ok) { const detail = await response.json().catch(() => ({})); throw new Error(detail.error || 'Report preview is unavailable.'); }
      const text = await response.text();
      if (!controller.signal.aborted) setReportPreview({ file, text });
    } catch (e) { if ((e as Error).name !== 'AbortError' && mounted.current) setError((e as Error).message); }
    finally { if (!controller.signal.aborted && mounted.current) setPreviewPending(false); }
  };
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  const working = pending || agent.busy;
  const onNew = () => { agent.newChat(); setHideRun(true); setFiles([]); setDraft(''); };
  const onOpen = (id: string) => { agent.openChat(id); setHideRun(true); };
  const onOpenRun = () => { agent.newChat(); setHideRun(false); setWorkflow('run'); };
  const closeHistory = (e: React.MouseEvent) => { const d = (e.currentTarget as HTMLElement).closest('details'); if (d) d.open = false; };
  const historyCount = agent.chats.length + (run ? 1 : 0);
  const availableStarters = agent.role === 'employee' ? STARTERS.filter(item => item.group === 'Claims') : STARTERS;
  const backendNotice = backend.connection === 'offline' && <div className="notice notice-error" role="alert"><div><strong>Purchasing and claims backend offline</strong><p>{backend.error}</p></div><button className="btn btn-sm" onClick={() => void backend.refresh()}>Reconnect</button></div>;
  const chatBar = <div className="chat-bar">
    <details className="history">
      <summary className="btn btn-ghost btn-sm" aria-label="Chat history">
        <svg viewBox="0 0 24 24" aria-hidden="true" className="dl-icon"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 7v5l3 2" /></svg>History<span className="segmented-count">{historyCount}</span></summary>
      <div className="history-panel">
        {historyCount === 0 && <p className="muted pad">Your conversations will be listed here.</p>}
        {run && <div className={`history-item ${showRun ? 'current' : ''}`}><button type="button" onClick={e => { onOpenRun(); closeHistory(e); }}><strong>Month-end review run</strong><small>{formatTimestamp(run.started_at)} · {stageLabel(run.status)}</small></button></div>}
        {agent.chats.map(c => <div key={c.id} className={`history-item ${c.current && !showRun ? 'current' : ''}`}>
          <button type="button" disabled={working} onClick={e => { onOpen(c.id); closeHistory(e); }}><strong>{c.title}</strong><small>{formatTimestamp(c.at)} · {c.count} messages</small></button>
          <button type="button" className="icon-btn" aria-label={`Delete conversation: ${c.title}`} title="Delete conversation" disabled={working} onClick={() => agent.deleteChat(c.id)}>✕</button></div>)}
      </div>
    </details>
    <button type="button" className="btn btn-sm" onClick={onNew} disabled={working || !active}>+ New chat</button>
  </div>;

  const composerForm = <form className="composer" onSubmit={submit}>
    <label htmlFor="execution-goal" className="sr-only">Message the agent</label>
    <div className={`composer-box ${drag ? 'drag' : ''}`} onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={e => { e.preventDefault(); setDrag(false); takeFiles(e.dataTransfer.files); }}>
      <button type="button" className="attach" aria-label="Attach a receipt or document" title="Attach a PDF or image" onClick={() => picker.current?.click()} disabled={working}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5l-8 8a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8" /></svg>
      </button>
      <input ref={picker} type="file" multiple accept={ACCEPT} hidden onChange={e => { takeFiles(e.target.files); e.target.value = ''; }} />
      <div className="composer-field">
        {files.length > 0 && <ul className="attachments" aria-label="Attached files">{files.map((f, i) => <li key={`${f.name}${i}`}><span>📎 {f.name}</span><button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>✕</button></li>)}</ul>}
        <textarea ref={composer} id="execution-goal" rows={1} maxLength={2000} value={draft} disabled={pending}
          onChange={e => { setDraft(e.target.value); changeGoal(e.target.value); }}
          placeholder={active ? 'Reply, attach a file, or ask for status…' : 'Ask to submit a claim or process a document…'}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
      </div>
      <button className="send" type="submit" aria-label="Send" disabled={working || (!draft.trim() && !files.length)}>{working ? '…' : 'Send'}</button>
    </div>
    {fileError && <p className="error-text" role="alert">{fileError}</p>}
    <div className="composer-foot">
      {active ? <div className="quick" aria-label="Quick lookups">{COMMANDS.map(c => <button key={c} type="button" onClick={() => lookup(c)}>{c}</button>)}
        <details className="suggest"><summary>suggestions</summary><div className="suggest-panel">{availableStarters.map(s => <button key={s.id} type="button" disabled={working} onClick={e => { e.currentTarget.closest('details')!.open = false; setWorkflow('demo'); agent.startIntent(s.id); }}>{s.label}</button>)}
          {run && !busy && <button type="button" onClick={e => { e.currentTarget.closest('details')!.open = false; setDraft(DEFAULT_GOAL); changeGoal(DEFAULT_GOAL); composer.current?.focus(); }}>Prepare the month-end review pack</button>}</div></details></div>
        : <span className="hint">Enter to send · Shift + Enter for a new line · attach PDFs or images with the paperclip</span>}
      {cases.length > 1 && <label className="case-pick">Case <select value={caseId} disabled={Boolean(busy)} onChange={e => changeCase(e.target.value)} aria-label="Review case">
        {cases.map(item => <option key={item.case_id} value={item.case_id}>{item.business_name}</option>)}</select></label>}
    </div>
  </form>;

  return <div className={`live ${active ? 'is-active' : 'is-idle'}`}>
    <aside className="live-orbit" aria-label="Execution progress">
      <Orbit nodes={nodes} mode={mode} activeId={focusStage?.id} onSelect={id => { setFocusId(id); jump(`stage-${id}`); }} />
      <div className="readout">
        {!active && <ol className="flow-strip" aria-label="How it works">{DEMO_STAGES.map(label => <li key={label}>{label}</li>)}</ol>}
        {active && <>
          <p className="readout-state"><span className={`state-dot ${mode}`} aria-hidden="true" />{stateLine} · {completed}/{stages.length} stages</p>
          <ol id="stage-list" className="stage-list">
            {stages.map((stage, i) => <li id={`stage-${stage.id}`} key={stage.id} className={`${stage.status} ${focusStage?.id === stage.id ? 'focus' : ''}`}>
              <button type="button" onClick={() => setFocusId(stage.id)} aria-pressed={focusStage?.id === stage.id}>
                <span className="stage-mark">{stage.status === 'completed' ? '✓' : i + 1}</span>
                <span className="stage-name">{stage.label}</span>
                <span className="stage-state">{stage.status === 'waiting' ? 'Waiting for you' : stageLabel(stage.status)}</span>
              </button>
            </li>)}
          </ol>
          {demo && <p className="stage-detail">Uploads and progress come from the authenticated business backend. Review extracted records and any issues before approving or exporting.</p>}
          {!demo && focusStage && <p className="stage-detail"><strong>{focusStage.executor}</strong>{focusStage.detail ? ` — ${focusStage.detail}` : ''}</p>}
        </>}
      </div>
    </aside>

    <section className="live-main" aria-label="Agentic Live Execution conversation">
      {chatBar}
      {!active ? <div className="hero">
        <span className="kicker">Purchasing and claims workspace</span>
        <h1>What would you like to do?</h1>
        <p>Submit a claim or process a purchasing document. Attach files right here and I will read them, check them and save the result.</p>
        {backendNotice}
        {showRunError && <div className="notice notice-error" role="alert"><div><strong>{connection === 'offline' ? 'Review service offline' : 'Action required'}</strong><p>{error}</p></div><button className="btn btn-sm" onClick={reconnect}>Reconnect</button></div>}
        {composerForm}
        <div className="starters" aria-label="Suggested prompts">
          {(['Claims', 'Purchasing'] as const).map(group => <div key={group} className="starter-group"><span className="starter-label">{group}</span>
            <div className="starter-grid">{availableStarters.filter(s => s.group === group).map(s => <button key={s.id} type="button" className="chip starter-card" onClick={() => { setWorkflow('demo'); agent.startIntent(s.id); }}>
              <svg viewBox="0 0 24 24" aria-hidden="true">{group === 'Claims' ? <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6" /></> : <><path d="M6 3h9l4 4v14H6z" /><path d="M15 3v5h5M9 13h6M9 17h6" /></>}</svg>
              <span>{s.label}<small>{HINTS[s.id]}</small></span></button>)}</div></div>)}
        </div>
      </div> : <>
        <div className="thread">
          {backendNotice}
          {showRun && run && <>
            <div className="msg msg-user"><div className="bubble"><span className="meta">You · {formatTimestamp(run.started_at)}</span><p>{run.goal}</p></div></div>
            {run.events.map(event => <div className="msg msg-agent" key={`${run.id}:${event.id}`}><span className="avatar" aria-hidden="true" /><div className="bubble"><span className="meta">{event.actor} · {formatTimestamp(event.timestamp)}</span><p>{event.message}</p></div></div>)}
            {run.status === 'running' && <div className="working" role="status" aria-live="polite"><span className="dots" aria-hidden="true"><i /><i /><i /></span>Month-end review is running…</div>}
            {run.status === 'waiting_for_input' && <HumanCheckpoint />}
            {run.error && <div className="notice notice-error" role="alert"><div><strong>Execution stopped safely</strong><p>{run.error}</p><p>No export was approved by this failure.</p></div><Link to="/issues" className="btn btn-sm">Action Items</Link></div>}
            {run.matching && <div className="summary" aria-label="Findings">
              <div><strong>{matched}</strong><span>proposed or confirmed matches</span></div>
              <div><strong>{issueCount}</strong><span>{issueCount === 1 ? 'item needs attention' : 'items need attention'}</span></div>
              <Link className="btn btn-sm" to="/issues">Action Items</Link>
            </div>}
            {run.pack && <section id="review-pack" className="pack" aria-label="Review pack outputs">
              <div className="pack-head"><strong>Review pack exported</strong><span className="muted">{run.pack.files.length} files · {run.pack.open_item_count} open items · {run.pack.decision_count} decisions. This is a review pack, not a completed close.</span></div>
              {run.pack_current === false ? <div className="notice notice-warn">Underlying records changed. Re-run before downloading; these exports are stale.</div> : <>
                <div className="pack-files">{run.pack.files.map(file => <a key={file} className="file" href={`/month-end-api/exports/${encodeURIComponent(file)}?case_id=${encodeURIComponent(run.case_id)}&run_id=${run.id}`} download={file}><span className="file-kind">{file.endsWith('.csv') ? 'CSV' : 'MD'}</span><span><strong>{OUTPUTS[file]?.[0] || file}</strong><small>{OUTPUTS[file]?.[1]}</small></span><span aria-hidden="true">↓</span></a>)}</div>
                <div className="actions"><button className="btn btn-sm" disabled={previewPending} onClick={() => previewReport('03_records_summary.md')}>Preview records summary</button><button className="btn btn-sm" disabled={previewPending} onClick={() => previewReport('02_exceptions.md')}>Preview issue report</button></div>
                {(previewPending || reportPreview) && <div className="preview" aria-live="polite"><div className="preview-head"><strong>{reportPreview?.file || 'Loading report…'}</strong><button className="btn btn-sm" onClick={() => { previewRequest.current?.abort(); setPreviewPending(false); setReportPreview(null); }}>Close</button></div><pre>{reportPreview?.text || 'Loading verified export content…'}</pre></div>}
              </>}
            </section>}
          </>}
          {agent.messages.map(msg => <ChatMessage key={msg.id} msg={msg} onChoose={agent.choose} />)}
          <div ref={end} />
        </div>
        {showRunError && <div className="notice notice-error" role="alert"><div><strong>Action required</strong><p>{error}</p></div><button className="btn btn-sm" onClick={reconnect}>Reconnect</button></div>}
        {composerForm}
      </>}
    </section>
  </div>;
}
