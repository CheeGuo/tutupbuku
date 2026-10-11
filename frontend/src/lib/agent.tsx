import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { apiJson } from './api';
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
export const DEMO_STAGES = ['Upload', 'Extract', 'Match', 'Check', 'Save'] as const;
export type Card = { type: 'saved'; lines: string[] };
export type Msg =
  | { id: string; kind: 'user'; text: string; files: string[] }
  | { id: string; kind: 'agent'; text: string; to?: string; action?: string; hash?: string }
  | { id: string; kind: 'quick'; options: { id: string; label: string }[]; used?: boolean }
  | { id: string; kind: 'steps'; steps: { label: string; state: 'done' | 'running' | 'queued' | 'failed' }[] }
  | { id: string; kind: 'card'; card: Card };

interface Flow { intent: Intent | null; stage: 'ask_purpose' | 'ask_file' | 'processing' | 'idle'; purpose?: string }
export interface ChatSummary { id: string; title: string; at: string; count: number; current: boolean }
interface Chat { id: string; at: string; messages: Msg[]; flow: Flow }
interface JobEvent { summary?: string; state?: string; agent?: string; timestamp?: string }
interface UploadResult { document: { id: string; originalFilename?: string; filename?: string }; job: { id: string; status: string } }
interface JobStatus { id: string; documentId: string; status: string; error?: { message?: string }; events?: JobEvent[] }

const CHATS_KEY = 'tutupbuku.chats.v1';
const blank = (): Chat => ({ id: crypto.randomUUID(), at: new Date().toISOString(), messages: [], flow: { intent: null, stage: 'idle' } });
const uid = () => crypto.randomUUID();
const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));
const terminal = (status: string) => !['queued', 'processing'].includes(status.toLowerCase());
const statusLabel = (status: string) => status.replace(/_/gu, ' ');

function settle(message: Msg): Msg {
  return message.kind === 'steps'
    ? { ...message, steps: message.steps.map(step => step.state === 'running' ? { ...step, state: 'queued' as const } : step) }
    : message;
}

function loadChats(): { chats: Chat[]; activeId: string } {
  let saved: Chat[] = [];
  try {
    const raw = window.sessionStorage.getItem(CHATS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) saved = parsed.filter((chat: Chat) => chat && Array.isArray(chat.messages)).map((chat: Chat) => ({ ...chat, messages: chat.messages.map(settle) }));
    }
  } catch { /* Conversation history is optional. */ }
  const fresh = blank();
  return { chats: [...saved, fresh], activeId: fresh.id };
}

const titleOf = (chat: Chat) => {
  const first = chat.messages.find(message => message.kind === 'user') as Extract<Msg, { kind: 'user' }> | undefined;
  return (first?.text || first?.files[0] || 'New chat').slice(0, 70);
};

interface AgentApi {
  role: 'owner' | 'reviewer' | 'employee';
  chats: ChatSummary[]; activeId: string; newChat: () => void; openChat: (id: string) => void; deleteChat: (id: string) => void;
  messages: Msg[]; stages: StageState[]; busy: boolean; active: boolean; stamp: number;
  startIntent: (id: Intent) => void;
  send: (text: string, files: File[]) => void;
  reply: (prompt: string, text: string, link?: { to?: string; hash?: string; action: string }) => void;
  choose: (msgId: string, optionId: string) => void;
}

const Ctx = createContext<AgentApi | null>(null);

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const data = useData();
  const [store, setStore] = useState(loadChats);
  const activeRef = useRef(store.activeId);
  activeRef.current = store.activeId;
  const activeChat = store.chats.find(chat => chat.id === store.activeId) ?? store.chats[0];
  const messages = activeChat.messages;
  const [stages, setStages] = useState<StageState[]>(DEMO_STAGES.map(() => 'queued'));
  const [busy, setBusy] = useState(false);
  const [stamp, setStamp] = useState(0);
  const flow = useRef<Flow>({ intent: null, stage: 'idle' });
  const pendingFiles = useRef<File[]>([]);

  const setMessages = useCallback((update: (items: Msg[]) => Msg[]) => {
    setStore(state => ({ ...state, chats: state.chats.map(chat => chat.id === activeRef.current ? { ...chat, messages: update(chat.messages) } : chat) }));
  }, []);
  const add = useCallback((message: Msg) => setMessages(items => [...items, message]), [setMessages]);
  const say = useCallback((text: string, extra: Partial<Extract<Msg, { kind: 'agent' }>> = {}) => add({ id: uid(), kind: 'agent', text, ...extra }), [add]);
  const touch = useCallback(() => setStamp(Date.now()), []);
  const setStage = useCallback((index: number, state: StageState) => setStages(current => current.map((item, i) => i === index ? state : item)), []);

  useEffect(() => {
    try {
      const history = store.chats.filter(chat => chat.messages.length).map(chat => chat.id === store.activeId ? { ...chat, flow: flow.current } : chat);
      window.sessionStorage.setItem(CHATS_KEY, JSON.stringify(history.slice(-40)));
    } catch { /* Conversation history is optional. */ }
  }, [store]);

  const switchTo = useCallback((id: string, chats: Chat[]) => {
    const currentChats = chats.map(chat => chat.id === activeRef.current ? { ...chat, flow: flow.current } : chat);
    const target = currentChats.find(chat => chat.id === id)!;
    flow.current = target.flow.stage === 'processing' ? { ...target.flow, stage: 'idle' } : target.flow;
    pendingFiles.current = [];
    activeRef.current = id;
    setStore({ chats: currentChats, activeId: id });
    setStages(DEMO_STAGES.map(() => 'queued'));
    touch();
  }, [store.chats, touch]);

  const newChat = useCallback(() => {
    if (busy || !messages.length) return;
    const fresh = blank();
    switchTo(fresh.id, [...store.chats, fresh]);
  }, [busy, messages.length, store.chats, switchTo]);
  const openChat = useCallback((id: string) => {
    if (busy || id === store.activeId || !store.chats.some(chat => chat.id === id)) return;
    switchTo(id, store.chats);
  }, [busy, store.activeId, store.chats, switchTo]);
  const deleteChat = useCallback((id: string) => {
    if (busy) return;
    const rest = store.chats.filter(chat => chat.id !== id);
    if (id !== store.activeId) { setStore({ ...store, chats: rest }); return; }
    const fresh = blank();
    switchTo(fresh.id, [...rest, fresh]);
  }, [busy, store, switchTo]);

  const setSteps = useCallback((id: string, completed: number, failed = false) => {
    const labels = ['Upload original file', 'Extract document details', 'Match related records', 'Run validation checks', 'Save results for review'];
    const next = labels.map((label, index) => ({ label, state: index < completed ? 'done' as const : index === completed ? failed ? 'failed' as const : 'running' as const : 'queued' as const }));
    if (failed) next[completed] = { ...next[completed], state: 'running' };
    setMessages(items => items.map(message => message.id === id ? { id, kind: 'steps', steps: next } : message));
  }, [setMessages]);

  const uploadAndWait = useCallback(async (file: File, intent: Intent, purpose: string, stepsId: string) => {
    const isClaim = intent === 'claim' || intent === 'dinner';
    const workflow = isClaim ? 'claim' : 'purchasing';
    let accepted: UploadResult;
    try {
      accepted = await apiJson<UploadResult>('/api/documents', {
        method: 'POST', body: file,
        headers: {
          'content-type': file.type || 'application/octet-stream',
          'x-filename': encodeURIComponent(file.name),
          'x-workflow': workflow,
          ...(isClaim ? { 'x-claim-purpose': encodeURIComponent(purpose) } : {}),
          'idempotency-key': uid(),
        },
      });
    } catch (error) {
      setStages(current => current.map((state, index) => index === 0 ? 'failed' : state));
      setSteps(stepsId, 0, true);
      say(`Upload failed for ${file.name}: ${(error as Error).message}. The backend did not accept this file.`);
      throw error;
    }

    setStage(0, 'completed');
    setStage(1, 'running');
    setSteps(stepsId, 1);
    await data.refresh(true);

    const filename = accepted.document.originalFilename || accepted.document.filename || file.name;
    const jobId = accepted.job.id;
    let job: JobStatus = { id: jobId, documentId: accepted.document.id, status: accepted.job.status };
    const deadline = Date.now() + 120_000;
    try {
      while (!terminal(job.status) && Date.now() < deadline) {
        await sleep(1500);
        job = await apiJson<JobStatus>(`/api/jobs/${encodeURIComponent(jobId)}`);
        const eventCount = job.events?.length ?? 0;
        const mappedStage = Math.min(3, 1 + Math.floor(eventCount / 2));
        setStages(current => current.map((state, index) => index < mappedStage ? 'completed' : index === mappedStage ? 'running' : state));
        setSteps(stepsId, mappedStage);
        await data.refresh(true);
      }
    } catch (error) {
      setStage(1, 'running');
      setSteps(stepsId, 1);
      say(`${filename} was accepted and stored. I lost contact while checking its progress: ${(error as Error).message}. Check Documents before trying to upload it again.`);
      return;
    }

    await data.refresh(true);
    const status = job.status.toLowerCase();
    if (!terminal(job.status)) {
      setStage(1, 'running');
      say(`${filename} was uploaded and is still processing. Its progress and final result will appear in Documents and Action Items.`);
      return;
    }

    if (status === 'completed' || status === 'needs_review') {
      setStages(DEMO_STAGES.map(() => 'completed'));
      setSteps(stepsId, DEMO_STAGES.length);
      add({ id: uid(), kind: 'card', card: { type: 'saved', lines: [
        `${filename} was processed and saved in Documents${status === 'needs_review' ? ' with findings that need human review' : ''}.`,
        'Review extracted fields, linked records, and issues in the workspace. Claims and purchasing records still require an authorized reviewer before approval or export.',
      ] } });
      say('Processing finished. I did not approve anything on your behalf.', { to: status === 'needs_review' ? '/issues' : '/documents', action: status === 'needs_review' ? 'Review Action Items' : 'Open Documents' });
      return;
    }

    setStages(current => current.map((state, index) => index === 1 ? 'failed' : state));
    setSteps(stepsId, 1, true);
    const detail = job.error?.message || `The backend returned “${statusLabel(job.status)}”.`;
    add({ id: uid(), kind: 'card', card: { type: 'saved', lines: [
      `${filename} was uploaded and retained in Documents.`,
      `Processing did not finish: ${detail}`,
      'Check backend AI/OCR configuration and the document status before retrying.',
    ] } });
    say('The original file is saved, but processing did not complete. Check the backend configuration and the record status in Documents.', { to: '/documents', action: 'Open Documents' });
  }, [add, data, say, setStage, setSteps]);

  const run = useCallback(async (files: File[], intent: Intent, purpose = '') => {
    if (!files.length) return;
    flow.current = { intent, purpose, stage: 'processing' };
    setBusy(true);
    setStages(DEMO_STAGES.map(() => 'queued'));
    touch();
    const stepsId = uid();
    add({ id: stepsId, kind: 'steps', steps: DEMO_STAGES.map((label, index) => ({ label, state: index === 0 ? 'running' : 'queued' })) });
    try {
      for (const file of files) {
        try { await uploadAndWait(file, intent, purpose, stepsId); }
        catch { /* The failed file has its own message; continue with the remaining attachments. */ }
      }
    }
    finally {
      flow.current = { intent: null, stage: 'idle' };
      pendingFiles.current = [];
      setBusy(false);
      touch();
    }
  }, [add, touch, uploadAndWait]);

  const startIntent = useCallback((intent: Intent) => {
    if (busy || (data.role === 'employee' && !['claim', 'dinner'].includes(intent))) return;
    const starter = STARTERS.find(item => item.id === intent);
    if (!starter) return;
    add({ id: uid(), kind: 'user', text: starter.label, files: [] });
    setStages(DEMO_STAGES.map((_, index) => index === 0 ? 'waiting' : 'queued'));
    touch();
    if (intent === 'claim' || intent === 'dinner') {
      flow.current = { intent, stage: 'ask_purpose' };
      say(intent === 'dinner' ? 'Who attended the dinner, which company were they from, and what was the business purpose? Attach the receipt now or after replying.' : 'What was the business purpose? Include any attendees or companies, then attach the receipt.');
    } else {
      flow.current = { intent, stage: 'ask_file' };
      say(intent === 'match' ? 'Attach the supplier invoice. The backend will process it and check available purchase records.' : intent === 'compare' ? 'Attach the invoice you want checked against its purchase order.' : 'Attach a supplier invoice, quotation, purchase order, delivery order, or payment document.');
    }
  }, [add, busy, data.role, say, touch]);

  const send = useCallback((text: string, attached: File[]) => {
    if (busy) return;
    const clean = text.trim();
    add({ id: uid(), kind: 'user', text: clean, files: attached.map(file => file.name) });
    const current = flow.current;
    if (current.stage === 'ask_purpose') {
      const files = attached.length ? attached : pendingFiles.current;
      pendingFiles.current = [];
      if (!clean) { say('Please describe the business purpose before submitting the claim.'); return; }
      flow.current = { ...current, purpose: clean, stage: files.length ? 'processing' : 'ask_file' };
      if (files.length) { void run(files, current.intent || 'claim', clean); return; }
      setStages(DEMO_STAGES.map((_, index) => index === 0 ? 'waiting' : 'queued'));
      say('Purpose noted. Attach the receipt to submit the claim.');
      return;
    }
    if (current.stage === 'ask_file') {
      const files = attached.length ? attached : pendingFiles.current;
      pendingFiles.current = [];
      if (!files.length) { say('Attach the document with the paperclip and send it to process.'); return; }
      void run(files, current.intent || 'process', current.purpose || '');
      return;
    }

    const lower = clean.toLowerCase();
    const claimish = /claim|receipt|expense|reimburs|dinner|meal/u.test(lower);
    const purchasing = /invoice|quotation|purchase order|\bpo\b|delivery order|payment|supplier/u.test(lower);
    if (attached.length && !claimish && !purchasing) {
      pendingFiles.current = attached;
      const options = data.role === 'employee'
        ? [{ id: 'claim', label: 'Employee claim receipt' }]
        : [{ id: 'claim', label: 'Employee claim receipt' }, { id: 'process', label: 'Purchasing document' }];
      add({ id: uid(), kind: 'quick', options });
      return;
    }
    if (claimish && !purchasing) {
      pendingFiles.current = attached;
      flow.current = { intent: /dinner/u.test(lower) ? 'dinner' : 'claim', stage: 'ask_purpose' };
      setStages(DEMO_STAGES.map((_, index) => index === 0 ? 'waiting' : 'queued'));
      touch();
      if (clean) say('Before uploading, tell me the business purpose and any attendees or companies.');
      else say('Please describe the expense purpose, including attendees or companies if relevant.');
      return;
    }
    if (purchasing) {
      const intent: Intent = /match/u.test(lower) ? 'match' : /check|compare/u.test(lower) ? 'compare' : 'process';
      flow.current = { intent, stage: 'ask_file' };
      setStages(DEMO_STAGES.map((_, index) => index === 0 ? 'waiting' : 'queued'));
      touch();
      if (attached.length) { void run(attached, intent); return; }
      say('Attach the purchasing document with the paperclip and send it for processing.');
      return;
    }
    if (attached.length) {
      pendingFiles.current = attached;
      add({ id: uid(), kind: 'quick', options: data.role === 'employee'
        ? [{ id: 'claim', label: 'Employee claim receipt' }]
        : [{ id: 'claim', label: 'Employee claim receipt' }, { id: 'process', label: 'Purchasing document' }] });
      return;
    }
    say('Choose a claim or purchasing task, or describe the document you want to process.');
  }, [add, busy, data.role, run, say, touch]);

  const choose = useCallback((messageId: string, optionId: string) => {
    setMessages(items => items.map(message => message.id === messageId && message.kind === 'quick' ? { ...message, used: true } : message));
    const files = pendingFiles.current;
    pendingFiles.current = [];
    if (optionId === 'claim') {
      flow.current = { intent: 'claim', stage: 'ask_purpose' };
      say('What was the business purpose? Include attendees or companies, then I will submit the attached receipt.');
    } else {
      flow.current = { intent: 'process', stage: files.length ? 'processing' : 'ask_file' };
      if (files.length) void run(files, 'process');
      else say('Attach the purchasing document with the paperclip.');
    }
  }, [run, say, setMessages]);

  const reply = useCallback((prompt: string, text: string, link?: { to?: string; hash?: string; action: string }) => {
    add({ id: uid(), kind: 'user', text: prompt, files: [] });
    say(text, link ? { to: link.to, hash: link.hash, action: link.action } : {});
  }, [add, say]);

  const chats = useMemo<ChatSummary[]>(() => store.chats.filter(chat => chat.messages.length).map(chat => ({ id: chat.id, title: titleOf(chat), at: chat.at, count: chat.messages.length, current: chat.id === store.activeId })).reverse(), [store]);
  const api = useMemo<AgentApi>(() => ({ role: data.role, chats, activeId: store.activeId, newChat, openChat, deleteChat, messages, stages, busy, active: messages.length > 0, stamp, startIntent, send, reply, choose }), [data.role, chats, store.activeId, newChat, openChat, deleteChat, messages, stages, busy, stamp, startIntent, send, reply, choose]);
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useAgent() {
  const value = useContext(Ctx);
  if (!value) throw new Error('AgentProvider is required.');
  return value;
}
