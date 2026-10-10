import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAgent, PROGRESS_STAGES, STARTERS, type StageState } from '../lib/agent';
import { useAuth } from '../state/auth';
import { useData } from '../state/store';
import { ChatMessage } from '../components/ChatCards';
import { Orbit, type OrbitMode } from '../components/Orbit';
import type { WorkspaceMasterData } from '../types';
import { formatTimestamp } from '../lib/format';

const ACCEPT = '.csv,.tsv,.txt,.pdf,.png,.jpg,.jpeg,.webp';
const MAX_BYTES = 15 * 1024 * 1024;
const HINTS: Record<string, string> = {
  claim: 'Add the business purpose, then attach the receipt.',
  dinner: 'Include the business purpose and attendees.',
  process: 'Invoices, quotations, POs, delivery orders, or payment records.',
  match: 'Upload an invoice and its purchase order.',
  compare: 'Upload the PO and invoice to check the match.',
};
const stageNames: Record<string, string> = {
  Upload: 'Accept upload', Read: 'Read source', Route: 'Choose workflow', Check: 'Run checks', Save: 'Save proposal',
};
const stageIcon: Record<string, 'document' | 'filter' | 'link' | 'person' | 'arrow'> = {
  Upload: 'document', Read: 'filter', Route: 'arrow', Check: 'link', Save: 'person',
};
const describeStage = (state: StageState) => ({ queued: 'Queued', running: 'In progress', completed: 'Done', waiting: 'Waiting for setup or review', failed: 'Stopped' })[state];

export function Execution() {
  const agent = useAgent();
  const auth = useAuth();
  const data = useData();
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState('');
  const [drag, setDrag] = useState(false);
  const [focusStage, setFocusStage] = useState('Upload');
  const [historyOpen, setHistoryOpen] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const active = agent.active;
  const stages = agent.stages;
  const mode: OrbitMode = agent.busy ? 'running' : stages.includes('failed') ? 'error' : stages.includes('waiting') ? 'waiting' : active ? 'done' : 'idle';
  const activeStageIndex = stages.findIndex(state => state === 'running' || state === 'waiting' || state === 'failed');
  const activeStage = activeStageIndex >= 0 ? PROGRESS_STAGES[activeStageIndex] : focusStage;
  const nodes = useMemo(() => PROGRESS_STAGES.map((label, index) => ({ id: label, label, status: stages[index] || 'queued', icon: stageIcon[label] })), [stages]);
  const completed = stages.filter(state => state === 'completed').length;

  useEffect(() => { end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [agent.messages.length, agent.stamp]);

  const takeFiles = (incoming: FileList | File[]) => {
    const accepted: File[] = [];
    const errors: string[] = [];
    for (const file of Array.from(incoming)) {
      const ext = `.${file.name.split('.').pop()?.toLowerCase() || ''}`;
      if (!ACCEPT.split(',').includes(ext)) errors.push(`${file.name}: unsupported file type.`);
      else if (!file.size) errors.push(`${file.name}: file is empty.`);
      else if (file.size > MAX_BYTES) errors.push(`${file.name}: file exceeds 15 MiB.`);
      else accepted.push(file);
    }
    setFiles(current => [...current, ...accepted]);
    setFileError(errors.join(' '));
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (agent.busy || (!draft.trim() && !files.length)) return;
    agent.send(draft, files);
    setDraft(''); setFiles([]); setFileError('');
  };

  const onNewChat = () => { agent.newChat(); setDraft(''); setFiles([]); setFileError(''); };
  const runJobs = data.jobs.slice(0, 6);

  return <div className={`live ${active ? 'is-active' : 'is-idle'}`}>
    <aside className="live-orbit" aria-label="Document processing progress">
      <Orbit nodes={nodes} mode={mode} activeId={activeStage} onSelect={id => { setFocusStage(id); document.getElementById(`stage-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }} />
      {active ? <div className="readout">
        <p className="readout-state"><span className={`state-dot ${mode}`} aria-hidden="true" />{agent.busy ? 'Processing uploads' : stages.includes('waiting') ? 'Needs setup or review' : stages.includes('failed') ? 'Processing stopped' : 'Latest upload finished'} · {completed}/{stages.length} stages</p>
        <ol className="stage-list" aria-label="Current job stages">
          {PROGRESS_STAGES.map((label, index) => <li id={`stage-${label}`} key={label} className={`${stages[index]} ${activeStage === label ? 'focus' : ''}`}>
            <button type="button" onClick={() => setFocusStage(label)} aria-pressed={focusStage === label}>
              <span className="stage-mark">{stages[index] === 'completed' ? '✓' : index + 1}</span>
              <span className="stage-name">{stageNames[label]}</span>
              <span className="stage-state">{describeStage(stages[index])}</span>
            </button>
          </li>)}
        </ol>
        <p className="stage-detail">{stageNames[activeStage] || 'Processing'}: {agent.busy ? 'The service records each agent update as it arrives.' : stages.includes('waiting') ? 'A reviewer decision or business setup is still needed.' : stages.includes('failed') ? 'The saved document remains available in Records.' : 'Agent completion prepares a proposal; approval stays with a reviewer.'}</p>
      </div> : <div className="readout readout-idle">Upload files to see their saved processing stages here.</div>}
      {runJobs.length > 0 && <section className="recent-jobs" aria-label="Recent processing jobs">
        <h2>Recent uploads</h2>
        <ul>{runJobs.map(job => {
          const doc = data.docs.find(item => item.id === job.documentId);
          return <li key={job.id}><Link to="/documents"><span>{doc?.filename || 'Uploaded document'}</span><small>{job.status.replaceAll('_', ' ')} · {formatTimestamp(job.updatedAt || job.createdAt || '')}</small></Link></li>;
        })}</ul>
      </section>}
    </aside>

    <section className="live-main" aria-label="Upload and agent conversation">
      <div className="chat-bar">
        <details className="history" open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}>
          <summary className="btn btn-ghost btn-sm" aria-label="Conversation history">History <span className="segmented-count">{agent.chats.length}</span></summary>
          <div className="history-panel">
            {!agent.chats.length && <p className="muted pad">Your conversations will appear here.</p>}
            {agent.chats.map(chat => <div key={chat.id} className={`history-item ${chat.current ? 'current' : ''}`}>
              <button type="button" disabled={agent.busy} onClick={() => { agent.openChat(chat.id); setHistoryOpen(false); }}><strong>{chat.title}</strong><small>{formatTimestamp(chat.at)} · {chat.count} messages</small></button>
              <button type="button" className="icon-btn" aria-label={`Delete conversation: ${chat.title}`} disabled={agent.busy} onClick={() => agent.deleteChat(chat.id)}>×</button>
            </div>)}
          </div>
        </details>
        <button type="button" className="btn btn-sm" onClick={onNewChat} disabled={agent.busy}>+ New chat</button>
      </div>

      {!active ? <div className="hero">
        <span className="kicker">Purchasing and claims</span>
        <h1>What are you working on?</h1>
        <p>Upload a receipt, invoice, purchase order, or other record. Each file is saved with its processing history and source evidence.</p>
        {agent.error && <div className="notice notice-error" role="alert"><div><strong>Upload status needs attention</strong><p>{agent.error}</p></div><button type="button" className="btn btn-sm" onClick={agent.clearError}>Dismiss</button></div>}
        {composerForm({ draft, setDraft, files, setFiles, picker, composer, submit, takeFiles, drag, setDrag, fileError, busy: agent.busy, role: auth.role })}
        <div className="starters" aria-label="Suggested tasks">
          {(['Claims', 'Purchasing'] as const).map(group => <div key={group} className="starter-group"><span className="starter-label">{group}</span>
            <div className="starter-grid">{STARTERS.filter(item => item.group === group && !(auth.role === 'employee' && item.group === 'Purchasing')).map(item => <button key={item.id} type="button" className="chip starter-card" onClick={() => agent.startIntent(item.id)}>
              <span>{item.label}<small>{HINTS[item.id]}</small></span></button>)}</div>
          </div>)}
        </div>
        {auth.role === 'owner' && <BusinessSetup masterData={data.masterData} save={data.saveMasterData} />}
      </div> : <>
        <div className="thread" aria-live="polite">
          {agent.messages.map(message => <ChatMessage key={message.id} msg={message} onChoose={agent.choose} />)}
          {agent.busy && <div className="working" role="status"><span className="dots" aria-hidden="true"><i /><i /><i /></span>Waiting for saved agent progress…</div>}
          {agent.error && <div className="notice notice-error" role="alert"><div><strong>Upload status needs attention</strong><p>{agent.error}</p></div><button type="button" className="btn btn-sm" onClick={agent.clearError}>Dismiss</button></div>}
          <div ref={end} />
        </div>
        {composerForm({ draft, setDraft, files, setFiles, picker, composer, submit, takeFiles, drag, setDrag, fileError, busy: agent.busy, role: auth.role })}
      </>}
    </section>
  </div>;
}

function composerForm(props: {
  draft: string; setDraft: (value: string) => void; files: File[]; setFiles: React.Dispatch<React.SetStateAction<File[]>>;
  picker: React.RefObject<HTMLInputElement>; composer: React.RefObject<HTMLTextAreaElement>;
  submit: (event: React.FormEvent<HTMLFormElement>) => void; takeFiles: (incoming: FileList | File[]) => void;
  drag: boolean; setDrag: (value: boolean) => void; fileError: string; busy: boolean; role: string | null;
}) {
  return <form className="composer" noValidate onSubmit={props.submit}>
    <label htmlFor="execution-goal" className="sr-only">Message the upload assistant</label>
    <div className={`composer-box ${props.drag ? 'drag' : ''}`} onDragOver={event => { event.preventDefault(); props.setDrag(true); }} onDragLeave={() => props.setDrag(false)} onDrop={event => { event.preventDefault(); props.setDrag(false); props.takeFiles(event.dataTransfer.files); }}>
      <button type="button" className="attach" aria-label="Attach a document" title="Attach a file" onClick={() => props.picker.current?.click()} disabled={props.busy}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5l-8 8a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8" /></svg>
      </button>
      <input ref={props.picker} type="file" multiple accept={ACCEPT} hidden onChange={event => { if (event.target.files) props.takeFiles(event.target.files); event.target.value = ''; }} />
      <div className="composer-field">
        {props.files.length > 0 && <ul className="attachments" aria-label="Files selected for upload">{props.files.map((file, index) => <li key={`${file.name}-${index}`}><span>📎 {file.name} · {(file.size / 1024).toFixed(0)} KB</span><button type="button" aria-label={`Remove ${file.name}`} disabled={props.busy} onClick={() => props.setFiles(current => current.filter((_, itemIndex) => itemIndex !== index))}>×</button></li>)}</ul>}
        <textarea ref={props.composer} id="execution-goal" rows={1} maxLength={2000} value={props.draft} disabled={props.busy}
          onChange={event => props.setDraft(event.target.value)} placeholder={props.role === 'employee' ? 'Describe the business purpose, or attach a receipt…' : 'Describe the task or attach a file…'}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
      </div>
      <button className="send" type="submit" aria-label="Send" disabled={props.busy || (!props.draft.trim() && !props.files.length)}>{props.busy ? '…' : 'Send'}</button>
    </div>
    {props.fileError && <p className="error-text" role="alert">{props.fileError}</p>}
    <div className="composer-foot"><span className="hint">Enter to send · Shift + Enter for a new line · Files up to 15 MiB each</span></div>
  </form>;
}

type AccountDraft = { code: string; label: string; active: boolean };
type SupplierDraft = { id: string; legalName: string; registrationNumber: string; active: boolean };
function BusinessSetup({ masterData, save }: { masterData: WorkspaceMasterData; save: (value: WorkspaceMasterData) => Promise<void> }) {
  const [accounts, setAccounts] = useState<AccountDraft[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierDraft[]>([]);
  const [buyerName, setBuyerName] = useState('');
  const [buyerRegistration, setBuyerRegistration] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    setAccounts(masterData.chartOfAccounts.map(account => ({ code: account.code, label: account.label || account.name || '', active: account.active !== false })));
    setSuppliers(masterData.suppliers.map(supplier => ({ id: supplier.id || crypto.randomUUID(), legalName: supplier.legalName, registrationNumber: supplier.registrationNumber || '', active: supplier.active !== false })));
    setBuyerName(masterData.buyerProfile?.legalName || ''); setBuyerRegistration(masterData.buyerProfile?.registrationNumber || '');
  }, [masterData]);
  const saveChanges = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      await save({
        chartOfAccounts: accounts.filter(row => row.code.trim() && row.label.trim()).map(row => ({ code: row.code.trim(), label: row.label.trim(), active: row.active })),
        suppliers: suppliers.filter(row => row.legalName.trim()).map(row => ({ ...row, legalName: row.legalName.trim() })),
        buyerProfile: buyerName.trim() ? { legalName: buyerName.trim(), registrationNumber: buyerRegistration.trim() } : null,
      });
      setMessage('Business reference data saved.');
    } catch (error) { setMessage((error as Error).message || 'Reference data was not saved.'); }
    finally { setBusy(false); }
  };
  const missing = !masterData.chartOfAccounts.some(account => account.active !== false);
  return <details className="business-setup" open={missing}>
    <summary>Business setup <span>{missing ? 'Account categories need setup' : 'Chart, suppliers, and buyer profile'}</span></summary>
    <form noValidate onSubmit={saveChanges}>
      <p className="hint">These business reference records help check supplier and buyer details and keep claim categories within your approved chart of accounts.</p>
      <fieldset><legend>Chart of accounts</legend>
        {accounts.map((account, index) => <div className="setup-row account-row" key={`account-${index}`}>
          <label><span>Code</span><input value={account.code} onChange={event => setAccounts(rows => rows.map((row, i) => i === index ? { ...row, code: event.target.value } : row))} /></label>
          <label><span>Account name</span><input value={account.label} onChange={event => setAccounts(rows => rows.map((row, i) => i === index ? { ...row, label: event.target.value } : row))} /></label>
          <label className="check"><input type="checkbox" checked={account.active} onChange={event => setAccounts(rows => rows.map((row, i) => i === index ? { ...row, active: event.target.checked } : row))} /> Active</label>
          <button type="button" className="btn btn-ghost btn-sm" aria-label="Remove account row" onClick={() => setAccounts(rows => rows.filter((_, i) => i !== index))}>Remove</button>
        </div>)}
        <button type="button" className="btn btn-sm" onClick={() => setAccounts(rows => [...rows, { code: '', label: '', active: true }])}>Add account</button>
      </fieldset>
      <fieldset><legend>Approved suppliers</legend>
        {suppliers.map((supplier, index) => <div className="setup-row account-row" key={supplier.id}>
          <label><span>Legal name</span><input value={supplier.legalName} onChange={event => setSuppliers(rows => rows.map((row, i) => i === index ? { ...row, legalName: event.target.value } : row))} /></label>
          <label><span>Registration number</span><input value={supplier.registrationNumber} onChange={event => setSuppliers(rows => rows.map((row, i) => i === index ? { ...row, registrationNumber: event.target.value } : row))} /></label>
          <label className="check"><input type="checkbox" checked={supplier.active} onChange={event => setSuppliers(rows => rows.map((row, i) => i === index ? { ...row, active: event.target.checked } : row))} /> Active</label>
          <button type="button" className="btn btn-ghost btn-sm" aria-label="Remove supplier row" onClick={() => setSuppliers(rows => rows.filter((_, i) => i !== index))}>Remove</button>
        </div>)}
        <button type="button" className="btn btn-sm" onClick={() => setSuppliers(rows => [...rows, { id: crypto.randomUUID(), legalName: '', registrationNumber: '', active: true }])}>Add supplier</button>
      </fieldset>
      <fieldset><legend>Buyer profile</legend><div className="setup-row">
        <label><span>Business legal name</span><input value={buyerName} onChange={event => setBuyerName(event.target.value)} /></label>
        <label><span>Registration number</span><input value={buyerRegistration} onChange={event => setBuyerRegistration(event.target.value)} /></label>
      </div></fieldset>
      <div className="actions"><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save reference data'}</button>{message && <span role="status" className="hint">{message}</span>}</div>
    </form>
  </details>;
}
