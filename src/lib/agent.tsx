import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Severity } from '../types';
import { getJob, listJobs, uploadFile } from './api';
import { useAuth } from '../state/auth';
import { useData } from '../state/store';

export type Intent = 'claim' | 'dinner' | 'process' | 'match' | 'compare';
export const STARTERS: { id: Intent; group: 'Claims' | 'Purchasing'; label: string }[] = [
  { id: 'claim', group: 'Claims', label: 'Submit an employee expense claim' },
  { id: 'dinner', group: 'Claims', label: 'Submit a business dinner claim with a receipt' },
  { id: 'process', group: 'Purchasing', label: 'Upload and process a supplier invoice' },
  { id: 'match', group: 'Purchasing', label: 'Match an invoice to its purchase order' },
  { id: 'compare', group: 'Purchasing', label: 'Check a purchase order against an invoice' },
];
export type StageState = 'queued' | 'running' | 'completed' | 'waiting' | 'failed';
export const PROGRESS_STAGES = ['Upload', 'Read', 'Route', 'Check', 'Save'] as const;
export type Card =
  | { type: 'extract'; title: string; fields: { label: string; value: string; low?: boolean }[]; lines: { item: string; qty: number; unit: string; total: string }[]; sample: boolean }
  | { type: 'links'; title: string; basis: string; confirmed: boolean; chain: { label: string; no: string; here?: boolean }[] }
  | { type: 'compare'; po: string; rows: { item: string; poQty: number | null; invQty: number; delivered: number | null; poUnit: number | null; invUnit: number | null; flags: string[] }[] }
  | { type: 'claim'; purpose: string; plausibility: 'PLAUSIBLE' | 'NEEDS_REVIEW'; findings: string[]; category: string; confidence: number; reasoning: string; description: string }
  | { type: 'findings'; items: { severity: Severity; title: string; typeLabel: string }[]; human: boolean }
  | { type: 'saved'; lines: string[] };
export type Msg =
  | { id: string; kind: 'user'; text: string; files: string[] }
  | { id: string; kind: 'agent'; text: string; to?: string; action?: string; hash?: string }
  | { id: string; kind: 'quick'; options: { id: string; label: string }[]; used?: boolean }
  | { id: string; kind: 'steps'; steps: { label: string; state: 'done' | 'running' | 'queued' | 'failed' }[] }
  | { id: string; kind: 'card'; card: Card };
export interface ChatSummary { id: string; title: string; at: string; count: number; current: boolean }
interface Chat { id: string; at: string; messages: Msg[]; flow: { intent: Intent | null; stage: 'ask_purpose' | 'ask_file' | 'idle'; purpose?: string } }
interface AgentApi {
  chats: ChatSummary[]; activeId: string; newChat: () => void; openChat: (id: string) => void; deleteChat: (id: string) => void;
  messages: Msg[]; stages: StageState[]; busy: boolean; active: boolean; stamp: number; error: string; clearError: () => void; refresh: () => Promise<void>;
  startIntent: (id: Intent) => void; send: (text: string, files: File[]) => void;
  reply: (prompt: string, text: string, link?: { to?: string; hash?: string; action: string }) => void;
  choose: (msgId: string, optionId: string) => void;
}
const Context = createContext<AgentApi | null>(null);
const uid = () => crypto.randomUUID();
const blank = (): Chat => ({ id: uid(), at: new Date().toISOString(), messages: [], flow: { intent: null, stage: 'idle' } });
const labelFor = (name: string) => name.replaceAll('-', ' ').replace(/\b\w/g, x => x.toUpperCase());
const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));
const terminal = (status: string) => ['completed', 'needs_review', 'failed', 'needs_configuration'].includes(status);
const stageFor = (state = ''): StageState => ['completed'].includes(state) ? 'completed' : ['failed'].includes(state) ? 'failed' : /waiting|needs_review|needs_configuration/.test(state) ? 'waiting' : /queued/.test(state) ? 'queued' : 'running';
const historyKey = (token: string | null) => `tutupbuku.chat-session.v1:${token?.slice(-10) || 'anonymous'}`;

function initialChats(key: string) {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(key) || '[]') as Chat[];
    if (Array.isArray(saved)) {
      const chats = saved.filter(chat => chat && Array.isArray(chat.messages)).map(chat => ({ ...chat, messages: chat.messages.map(message => message.kind === 'steps' ? { ...message, steps: message.steps.map(step => step.state === 'running' ? { ...step, state: 'queued' as const } : step) } : message) }));
      const fresh = blank(); return { chats: [...chats, fresh], activeId: fresh.id };
    }
  } catch { /* Conversation history is optional and session-scoped. */ }
  const fresh = blank(); return { chats: [fresh], activeId: fresh.id };
}

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const { token, role } = useAuth(); const data = useData();
  const storageKey = historyKey(token);
  const [store, setStore] = useState(() => initialChats(storageKey));
  const [stages, setStages] = useState<StageState[]>(PROGRESS_STAGES.map(() => 'queued'));
  const [busy, setBusy] = useState(false); const [stamp, setStamp] = useState(0); const [error, setError] = useState('');
  const flow = useRef<Chat['flow']>({ intent: null, stage: 'idle' });
  const pendingFiles = useRef<File[]>([]);
  const activeRef = useRef(store.activeId); activeRef.current = store.activeId;
  const messages = store.chats.find(chat => chat.id === store.activeId)?.messages || [];
  const chats = store.chats.filter(chat => chat.messages.length).map(chat => {
    const first = chat.messages.find(message => message.kind === 'user') as Extract<Msg, { kind: 'user' }> | undefined;
    return { id: chat.id, title: (first?.text || first?.files[0] || 'New chat').slice(0, 70), at: chat.at, count: chat.messages.length, current: chat.id === store.activeId };
  });
  const setMessages = useCallback((fn: (items: Msg[]) => Msg[]) => setStore(old => ({ ...old, chats: old.chats.map(chat => chat.id === activeRef.current ? { ...chat, messages: fn(chat.messages), flow: flow.current } : chat) })), []);
  const add = useCallback((message: Msg) => setMessages(items => [...items, message]), [setMessages]);
  const say = useCallback((text: string, extra: Partial<Extract<Msg, { kind: 'agent' }>> = {}) => add({ id: uid(), kind: 'agent', text, ...extra }), [add]);
  const touch = useCallback(() => setStamp(Date.now()), []);

  useEffect(() => {
    try { const saved = store.chats.filter(chat => chat.messages.length); window.sessionStorage.setItem(storageKey, JSON.stringify(saved.slice(-30))); }
    catch { /* History is best-effort and does not hold business records. */ }
  }, [store, storageKey]);

  const refresh = useCallback(async () => { await data.refreshRecords(); }, [data.refreshRecords]);
  const pollJob = useCallback(async (jobId: string, documentName: string, stepsId: string) => {
    const deadline = Date.now() + 5 * 60_000;
    let lastEvents = '';
    while (Date.now() < deadline) {
      const job = await getJob(jobId);
      const events = Array.isArray(job.events) ? job.events : [];
      const signature = events.map(e => e.eventId || `${e.agent}:${e.state}:${e.timestamp}`).join('|');
      if (signature !== lastEvents) {
        lastEvents = signature;
        const progress = PROGRESS_STAGES.map(() => 'queued' as StageState);
        progress[0] = 'completed';
        for (const event of events) {
          const index = event.agent === 'ocr-engine' ? 1 : event.agent === 'master-agent' ? 2 : event.agent === 'documentation-db-agent' ? 4 : event.agent ? 3 : -1;
          if (index < 0) continue;
          const state = stageFor(event.state);
          if (state === 'failed' || state === 'waiting') progress[index] = state;
          else if (state === 'completed' || state === 'running') progress[index] = state;
        }
        setStages(progress);
        const relevant = events.filter(e => e.agent && e.agent !== 'workflow');
        const view = relevant.length ? relevant : events.slice(-1);
        const items = view.slice(-6).map(e => ({ label: `${labelFor(e.agent || 'workflow')}: ${e.summary || e.state || 'update'}`, state: stageFor(e.state) === 'completed' ? 'done' as const : stageFor(e.state) === 'failed' ? 'failed' as const : stageFor(e.state) === 'waiting' ? 'queued' as const : stageFor(e.state) === 'running' ? 'running' as const : 'queued' as const }));
        setMessages(current => current.map(message => message.id === stepsId ? { id: stepsId, kind: 'steps', steps: items } : message));
      }
      const normalized = job.status;
      if (terminal(normalized)) {
        const outcome = normalized === 'completed' ? 'Analysis finished. It is awaiting a human decision.'
          : normalized === 'needs_review' ? 'Analysis finished with findings for a reviewer.'
            : normalized === 'needs_configuration' ? 'The file was saved, but processing needs setup. No analysis was claimed.'
              : `Processing failed${job.error?.message ? `: ${job.error.message}` : '. Check the record and service setup before trying again.'}`;
        say(`${documentName}: ${outcome}`, { to: normalized === 'failed' || normalized === 'needs_configuration' ? '/documents' : '/issues', action: 'View record' });
        setStages(current => current.map(state => state === 'running' || state === 'queued' ? (normalized === 'failed' ? 'failed' : normalized === 'needs_configuration' || normalized === 'needs_review' ? 'waiting' : 'completed') : state));
        await data.refreshRecords(); return;
      }
      await sleep(1200);
    }
    say(`${documentName}: the job is still active. Open Documents to inspect the saved record; refreshing this conversation will not submit it again.`, { to: '/documents', action: 'View Documents' });
  }, [data.refreshRecords, say, setMessages]);

  const run = useCallback(async (files: File[], workflow: 'auto' | 'purchasing' | 'claim', purpose: string) => {
    if (!files.length) return;
    if (role === 'employee' && workflow !== 'claim') { say('Employee accounts can upload claims only.'); return; }
    setBusy(true); setError(''); setStages(PROGRESS_STAGES.map(() => 'queued')); flow.current = { intent: null, stage: 'idle' }; touch();
    const jobs: { file: File; jobId: string }[] = []; const stepsByJob: string[] = [];
    try {
      for (const file of files) {
        const progressId = uid(); stepsByJob.push(progressId);
        add({ id: progressId, kind: 'steps', steps: [{ label: `${file.name}: uploading source file`, state: 'running' }, { label: 'Agent processing', state: 'queued' }, { label: 'Human review', state: 'queued' }] });
        const response = await uploadFile(file, workflow, purpose);
        jobs.push({ file, jobId: response.job.id });
        setMessages(items => items.map(item => item.id === progressId ? { id: progressId, kind: 'steps', steps: [{ label: `${file.name}: upload accepted`, state: 'done' }, { label: `Job ${response.job.id}: waiting for persisted agent progress`, state: 'running' }, { label: 'Human review', state: 'queued' }] } : item));
      }
      await Promise.all(jobs.map((job, index) => pollJob(job.jobId, job.file.name, stepsByJob[index])));
      setStages(PROGRESS_STAGES.map(() => 'completed'));
    } catch (cause) {
      const message = (cause as Error).message || 'Upload status is uncertain.';
      setError(message); setStages(current => current.map(state => state === 'running' ? 'failed' : state));
      say(`I could not confirm every upload. Check Documents before retrying so you do not submit a duplicate. ${message}`, { to: '/documents', action: 'Check Documents' });
      if (jobs.length) await data.refreshRecords().catch(() => {});
    } finally { setBusy(false); touch(); }
  }, [role, add, pollJob, say, setMessages, data.refreshRecords, touch]);

  const newChat = useCallback(() => {
    if (busy || !messages.length) return; const chat = blank(); flow.current = chat.flow; activeRef.current = chat.id; setStore(old => ({ chats: [...old.chats, chat], activeId: chat.id })); setStages(PROGRESS_STAGES.map(() => 'queued')); touch();
  }, [busy, messages.length, touch]);
  const openChat = useCallback((id: string) => {
    if (busy) return; const target = store.chats.find(chat => chat.id === id); if (!target) return;
    flow.current = target.flow; activeRef.current = id; setStore(old => ({ ...old, activeId: id })); setStages(target.messages.some(m => m.kind === 'steps' && m.steps.every(s => s.state === 'done')) ? PROGRESS_STAGES.map(() => 'completed') : PROGRESS_STAGES.map(() => 'queued')); touch();
  }, [busy, store.chats, touch]);
  const deleteChat = useCallback((id: string) => {
    if (busy) return; const remaining = store.chats.filter(chat => chat.id !== id);
    if (id === store.activeId) { const next = blank(); remaining.push(next); flow.current = next.flow; activeRef.current = next.id; setStore({ chats: remaining, activeId: next.id }); }
    else setStore(old => ({ ...old, chats: remaining })); touch();
  }, [busy, store.chats, store.activeId, touch]);

  const startIntent = useCallback((id: Intent) => {
    if (busy) return; const starter = STARTERS.find(item => item.id === id); if (!starter) return;
    add({ id: uid(), kind: 'user', text: starter.label, files: [] });
    const isClaim = id === 'claim' || id === 'dinner'; flow.current = { intent: id, stage: isClaim ? 'ask_purpose' : 'ask_file' };
    setStages(PROGRESS_STAGES.map((_, i) => i === 0 ? 'waiting' : 'queued')); touch();
    say(isClaim ? 'Before uploading, tell me the business purpose and any attendees or companies. You can attach the receipt with your reply.' : 'Attach the purchasing document. You can select more than one file; each gets its own server job.');
  }, [busy, add, say, touch]);

  const reply = useCallback((prompt: string, text: string, link?: { to?: string; hash?: string; action: string }) => { add({ id: uid(), kind: 'user', text: prompt, files: [] }); say(text, link); }, [add, say]);

  const send = useCallback((text: string, attached: File[]) => {
    if (busy) return;
    const files = attached.length ? attached : pendingFiles.current; if (attached.length) pendingFiles.current = attached;
    const clean = text.trim(); add({ id: uid(), kind: 'user', text: clean, files: attached.map(file => file.name) });
    const current = flow.current;
    const wantsClaim = current.intent === 'claim' || current.intent === 'dinner';
    const lower = clean.toLowerCase();
    if (!files.length && /^(status|show status|issues|show issues|results|show results|evidence|show evidence|show documents)[?.!]*$/i.test(clean)) {
      void listJobs().then(jobs => {
        const active = jobs.filter(job => ['queued', 'processing'].includes(job.status)).length;
        const pending = data.claims.filter(claim => claim.status === 'PLAUSIBLE' || claim.status === 'NEEDS_REVIEW').length;
        const open = data.issues.filter(issue => issue.status === 'OPEN' || issue.status === 'UNDER_REVIEW').length;
        if (/status/i.test(lower)) reply(clean, `${active} processing job${active === 1 ? '' : 's'} active; ${data.docs.length} saved records.`, { to: '/documents', action: 'Open Documents' });
        else if (/issue/i.test(lower)) reply(clean, `${open} open issue${open === 1 ? '' : 's'} and ${pending} claim${pending === 1 ? '' : 's'} awaiting a decision.`, { to: '/issues', action: 'Open Action Items' });
        else reply(clean, `${data.docs.length} saved records are available, with their fields and source files.`, { to: '/documents', action: 'Open Documents' });
      }).catch(cause => say((cause as Error).message || 'Could not read job status.'));
      return;
    }
    if (current.stage === 'ask_purpose') {
      if (clean.length < 3) { say('Please add a short business purpose before submitting this claim.'); return; }
      flow.current = { ...current, purpose: clean, stage: files.length ? 'idle' : 'ask_file' }; pendingFiles.current = [];
      if (files.length) void run(files, 'claim', clean); else say('Purpose noted. Now attach the claim receipt.'); return;
    }
    if (!files.length && /claim|receipt|expense|reimburs/.test(lower)) { flow.current = { intent: 'claim', stage: 'ask_purpose' }; say('What was the business purpose? Include attendees or companies if relevant, then attach the receipt.'); return; }
    if (!files.length && /invoice|quotation|purchase order|\bpo\b|delivery order|payment|supplier/.test(lower)) { flow.current = { intent: 'process', stage: 'ask_file' }; say('Attach the purchasing document. You can select several files; the server creates one job per file.'); return; }
    if (!files.length) { say('I can process a purchasing document or submit an employee expense claim. Choose a suggestion, or attach a file.'); return; }
    pendingFiles.current = [];
    if ((role === 'employee' || wantsClaim || /\b(claim|receipt|expense)\b/.test(lower)) && !current.purpose) { flow.current = { intent: 'claim', stage: 'ask_purpose' }; pendingFiles.current = files; say('What was the business purpose for these receipts?'); return; }
    const workflow: 'auto' | 'purchasing' | 'claim' = role === 'employee' || wantsClaim ? 'claim' : current.intent ? 'purchasing' : 'auto';
    void run(files, workflow, current.purpose || '');
  }, [busy, add, say, run, data.claims, data.docs.length, data.issues, role, reply]);

  const choose = useCallback((msgId: string, optionId: string) => {
    setMessages(items => items.map(item => item.id === msgId && item.kind === 'quick' ? { ...item, used: true } : item));
    const files = pendingFiles.current; pendingFiles.current = [];
    if (optionId === 'claim') { flow.current = { intent: 'claim', stage: 'ask_purpose' }; pendingFiles.current = files; say('What was the business purpose for this expense?'); }
    else { flow.current = { intent: 'process', stage: 'ask_file' }; if (files.length) void run(files, 'purchasing', ''); else say('Now attach the purchasing document.'); }
  }, [run, say, setMessages]);
  const clearError = useCallback(() => setError(''), []);
  const value = useMemo<AgentApi>(() => ({ chats, activeId: store.activeId, newChat, openChat, deleteChat, messages, stages, busy, active: messages.length > 0, stamp, error, clearError, refresh, startIntent, send, reply, choose }), [chats, store.activeId, newChat, openChat, deleteChat, messages, stages, busy, stamp, error, clearError, refresh, startIntent, send, reply, choose]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAgent() { const value = useContext(Context); if (!value) throw new Error('AgentProvider is required.'); return value; }
