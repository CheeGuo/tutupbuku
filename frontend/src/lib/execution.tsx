import React, { createContext, useContext, useEffect, useRef, useState } from 'react';

export type Source = { path: string; sha256: string; size_bytes: number; processing: string };
export type CaseSummary = { case_id: string; business_name: string; period_start: string | null; period_end: string | null; status?: string };
export type ReviewCase = CaseSummary & { files: Source[]; cached_extraction_notice: string };
export type Candidate = { id: string; date: string; name: string; amount_sen: number; source_path: string };
export type ReviewRow = { row_id: string; date: string; description: string; amount_sen: number; reason: string; candidates: Candidate[]; state: string };
export type ReviewException = { exception_id: string; bank_row_id: string; title: string; reason: string; reason_code: string; priority: number; candidate_ids: string[]; source_refs: string[]; status: string; required_action: string };
export type InputIssue = { id: string; message: string; source_refs: string[]; location: string; required_action: string };
export type Run = {
  id: string; case_id: string; goal: string; status: string; started_at: string; version: number;
  stages: { id: string; label: string; executor: string; status: string; detail?: string }[];
  events: { id: number; timestamp: string; actor: string; message: string; stage?: string }[];
  case: ReviewCase | null;
  matching: { bank_rows: ReviewRow[]; exceptions: ReviewException[]; checks: Record<string, { passed: boolean; detail: string }> } | null;
  review_items: ReviewRow[]; question: ReviewRow | null;
  pack: { files: string[]; open_item_count: number; decision_count: number; message: string } | null;
  pack_current?: boolean; error: string | null; input_issues?: InputIssue[];
};
export const DEFAULT_GOAL = 'Prepare the month-end review pack from the supplied records. Validate balances, propose matches, ask me about ambiguous evidence, and export all five review files.';
export const STEPS = [
  ['inspect', 'Inspect supplied evidence', 'Input inspector'],
  ['validate', 'Validate schemas and balances', 'Validation engine'],
  ['match', 'Propose conservative matches', 'Matching engine'],
  ['review', 'Ask about ambiguity', 'Human review gate'],
  ['export', 'Build the five-file review pack', 'Export builder'],
];
export const OUTPUTS: Record<string, [string, string]> = {
  '01_proposals.csv': ['Match proposals', 'Every bank row, candidate and supporting reference'],
  '02_exceptions.md': ['Issue report', 'Unresolved issues and the evidence still required'],
  '03_records_summary.md': ['Records summary', 'Supplied records, checks and review limitations'],
  '04_decisions_log.csv': ['Decision log', 'Operator answers recorded during review'],
  '05_manifest.csv': ['Evidence manifest', 'Source files and their SHA-256 hashes'],
};
export async function request<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `Service request failed (${response.status}).`);
  }
  return response.json();
}
const MONTH_END_API = '/month-end-api';
export const sourceUrl = (caseId: string, path: string) => `${MONTH_END_API}/source/${encodeURIComponent(path.split('#')[0])}?case_id=${encodeURIComponent(caseId)}`;
export const stageLabel = (state: string) => ({ queued: 'Queued', running: 'Running', completed: 'Done', waiting: 'Needs your answer', waiting_for_input: 'Waiting for your answer', failed: 'Stopped' }[state] || state);

function useExecutionState() {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [caseId, setCaseId] = useState('');
  const [caseData, setCaseData] = useState<ReviewCase | null>(null);
  const [goal, setGoal] = useState(DEFAULT_GOAL);
  const [run, setRunState] = useState<Run | null>(null);
  const [draft, setDraft] = useState('');
  const runRef = useRef<Run | null>(null);
  const setRun = (next: Run | null) => {
    const current = runRef.current;
    if (next && current?.id === next.id && next.version < current.version) return;
    runRef.current = next;
    setRunState(next);
  };
  const [connection, setConnection] = useState<'checking' | 'connected' | 'offline'>('checking');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [choice, setChoice] = useState('');
  const [answer, setAnswer] = useState('');
  const [refresh, setRefresh] = useState(0);
  const submission = useRef(false);
  const runRequestId = useRef<string | null>(null);
  const mounted = useRef(true);
  const initialized = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setConnection('checking');
    Promise.all([request<{ cases: CaseSummary[] }>(`${MONTH_END_API}/cases`, undefined, controller.signal), request<{ run: Run | null }>(`${MONTH_END_API}/execution`, undefined, controller.signal)])
      .then(([available, current]) => {
        setCases(available.cases);
        setCaseId(current.run?.case_id || available.cases[0]?.case_id || '');
        setRun(current.run);
        if (current.run && !initialized.current) { setGoal(current.run.goal); setDraft(''); runRequestId.current = null; }
        initialized.current = true;
        setConnection('connected'); setError('');
      }).catch(e => { if (e.name !== 'AbortError') { setConnection('offline'); setError('The review service is unavailable. Start the Python service, then reconnect. No simulated execution has been substituted.'); } });
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => {
    if (!caseId) return;
    const controller = new AbortController();
    setCaseData(null);
    request<ReviewCase>(`${MONTH_END_API}/case?case_id=${encodeURIComponent(caseId)}`, undefined, controller.signal).then(setCaseData).catch(e => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, [caseId, refresh]);
  useEffect(() => {
    if (!run || !['running', 'waiting_for_input'].includes(run.status)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await request<{ run: Run }>(`${MONTH_END_API}/execution?run_id=${run.id}`, undefined, controller.signal);
        setRun(response.run); setConnection('connected');
        if (['running', 'waiting_for_input'].includes(response.run.status)) timer = setTimeout(poll, 700);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') { setConnection('offline'); setError('Connection interrupted. Reconnect to inspect the server outcome before retrying.'); }
      }
    };
    poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [run?.id, run?.status, refresh]);
  useEffect(() => { setChoice(''); setAnswer(''); }, [run?.question?.row_id, run?.id]);
  const busy = pending || run?.status === 'running' || run?.status === 'waiting_for_input';
  const start = async (event: React.FormEvent, submittedGoal = goal) => {
    event.preventDefault();
    if (submission.current || !caseData || busy || connection !== 'connected') return;
    submission.current = true; setPending(true); setError('');
    const id = runRequestId.current || crypto.randomUUID();
    runRequestId.current = id;
    try {
      const response = await request<{ run: Run }>(`${MONTH_END_API}/execution`, { case_id: caseId, goal: submittedGoal, request_id: id });
      if (mounted.current) { setRun(response.run); setGoal(submittedGoal); setDraft(''); runRequestId.current = null; }
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { submission.current = false; if (mounted.current) setPending(false); }
  };
  const resume = async (leaveOpen: boolean) => {
    if (!run || submission.current || run.status !== 'waiting_for_input' || connection !== 'connected') return;
    submission.current = true; setPending(true); setError('');
    try {
      const response = await request<{ run: Run }>(`${MONTH_END_API}/execution/continue`, { run_id: run.id, expected_version: run.version, candidate_id: choice === 'neither' ? null : choice, answer, leave_open: leaveOpen });
      if (mounted.current) setRun(response.run);
    } catch (e) { if (mounted.current) { setError((e as Error).message); setRefresh(n => n + 1); } }
    finally { submission.current = false; if (mounted.current) setPending(false); }
  };
  return { cases, caseId, caseData, goal, draft, setDraft, run, connection, error, pending, busy, choice, answer, start, resume,
    setChoice, setAnswer, setError,
    reconnect: () => { if (!submission.current) setRefresh(n => n + 1); },
    changeCase: (id: string) => { if (busy) return; setCaseId(id); setRun(null); setDraft(''); setGoal(DEFAULT_GOAL); runRequestId.current = null; },
    changeGoal: (text: string) => { setGoal(text); runRequestId.current = null; },
  };
}
const ExecutionContext = createContext<ReturnType<typeof useExecutionState> | null>(null);
export function ExecutionProvider({ children }: { children: React.ReactNode }) {
  const value = useExecutionState();
  return <ExecutionContext.Provider value={value}>{children}</ExecutionContext.Provider>;
}
export function useExecution() {
  const value = useContext(ExecutionContext);
  if (!value) throw new Error('ExecutionProvider is required.');
  return value;
}
