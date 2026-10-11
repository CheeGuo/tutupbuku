import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Account, AuditEntry, Claim, DocLink, DocRecord, Issue, IssueStatus, Toast } from '../types';
import { apiJson } from '../lib/api';
import { downloadApiFile } from './auth';
import { projectBackendRecords } from '../lib/backend-model.mjs';
import { parseAmountToSen } from '../lib/format';
import { useAuth } from './auth';

interface State { docs: DocRecord[]; links: DocLink[]; claims: Claim[]; issues: Issue[]; audit: AuditEntry[] }
interface BackendJob { id: string; documentId: string; status: string; events?: Record<string, unknown>[] }
interface MasterData { chartOfAccounts: Account[]; suppliers: Record<string, unknown>[]; buyerProfile?: Record<string, unknown> | null; [key: string]: unknown }

interface DataApi extends State {
  masterData: MasterData;
  jobs: BackendJob[];
  toasts: Toast[];
  connection: 'checking' | 'connected' | 'offline';
  loading: boolean;
  error: string;
  role: 'owner' | 'reviewer' | 'employee';
  canReview: boolean;
  canEditMasterData: boolean;
  dismissToast: (id: number) => void;
  openIssuesFor: (docId: string) => Issue[];
  refresh: (silent?: boolean) => Promise<void>;
  setIssueStatus: (issueId: string, status: IssueStatus, note?: string) => Promise<void>;
  confirmField: (issueId: string, docId: string, key: string, value: string) => Promise<void>;
  correctPrice: (issueId: string, invoiceId: string, prices: Record<string, number>) => Promise<void>;
  linkToPo: (issueId: string, docId: string, poId: string) => Promise<void>;
  resolveDuplicate: (issueId: string, keepId: string) => Promise<void>;
  updateClaim: (claimId: string, patch: Partial<Pick<Claim, 'categoryCode' | 'standardizedDescription'>>) => Promise<void>;
  decideClaim: (claimId: string, status: 'APPROVED' | 'REJECTED', reason?: string) => Promise<void>;
  exportCsv: (kind: 'purchasing' | 'claims', range?: { from?: string; to?: string }) => Promise<void>;
  downloadOriginal: (docId: string) => Promise<void>;
}

const EMPTY: State = { docs: [], links: [], claims: [], issues: [], audit: [] };
const EMPTY_MASTER: MasterData = { chartOfAccounts: [], suppliers: [], buyerProfile: null };
const Ctx = createContext<DataApi | null>(null);
const ACTIVE: IssueStatus[] = ['OPEN', 'UNDER_REVIEW'];
const isActive = (issue: Issue) => ACTIVE.includes(issue.status);
const FIELD_NAMES: Record<string, string> = {
  quotation_no: 'documentNumber', po_no: 'documentNumber', do_no: 'documentNumber', invoice_no: 'documentNumber',
  advice_no: 'documentNumber', receipt_no: 'documentNumber', receipt_ref: 'documentNumber', date: 'documentDate', due_date: 'dueDate',
  supplier: 'supplierName', merchant: 'merchantName', grand_total: 'totalAmountSen', amount: 'totalAmountSen', total: 'totalAmountSen', tax: 'taxAmountSen',
};

export function DataProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [state, setState] = useState<State>(EMPTY);
  const [masterData, setMasterData] = useState<MasterData>(EMPTY_MASTER);
  const [jobs, setJobs] = useState<BackendJob[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [connection, setConnection] = useState<DataApi['connection']>('checking');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const toastSequence = useRef(0);
  const role = user?.role || 'employee';
  const canReview = role === 'owner' || role === 'reviewer';

  const toast = useCallback((message: string, tone: Toast['tone'] = 'success') => {
    const id = Date.now() + ++toastSequence.current;
    setToasts(items => [...items.slice(-2), { id, message, tone }]);
    window.setTimeout(() => setToasts(items => items.filter(item => item.id !== id)), 5000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts(items => items.filter(item => item.id !== id)), []);

  const refresh = useCallback(async (silent = false) => {
    const requestId = ++sequence.current;
    if (!silent) { setConnection('checking'); setLoading(true); }
    try {
      const [documents, issues, latestJobs, remoteMaster] = await Promise.all([
        apiJson<Record<string, unknown>[]>('/api/documents'),
        apiJson<Record<string, unknown>[]>('/api/issues'),
        apiJson<BackendJob[]>('/api/jobs'),
        apiJson<MasterData>('/api/master-data'),
      ]);
      if (requestId !== sequence.current) return;
      const projection = projectBackendRecords({ documents, issues, jobs: latestJobs, masterData: remoteMaster, email: user?.email || '' });
      setState({ docs: projection.docs, links: projection.links, claims: projection.claims, issues: projection.issues, audit: projection.audit });
      setMasterData(projection.masterData as MasterData);
      setJobs(latestJobs);
      setConnection('connected');
      setError('');
    } catch (reason) {
      if (requestId !== sequence.current) return;
      setConnection('offline');
      setError((reason as Error).message || 'The backend could not be reached.');
    } finally {
      if (requestId === sequence.current) setLoading(false);
    }
  }, [user?.email]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!jobs.some((job) => ['queued', 'processing'].includes(String(job.status).toLowerCase()))) return;
    const timer = window.setInterval(() => { void refresh(true); }, 2000);
    return () => window.clearInterval(timer);
  }, [jobs, refresh]);

  const perform = useCallback(async (action: () => Promise<unknown>, success: string) => {
    try {
      await action();
      await refresh(true);
      toast(success);
    } catch (reason) {
      toast((reason as Error).message || 'The action could not be saved.', 'error');
    }
  }, [refresh, toast]);

  const recordCorrection = useCallback(async (docId: string, fieldName: string, value: unknown, reason: string) => {
    await apiJson(`/api/documents/${encodeURIComponent(docId)}/corrections`, { method: 'POST', body: { field: fieldName, value, reason } });
  }, []);
  const reprocess = useCallback(async (docId: string) => {
    await apiJson(`/api/documents/${encodeURIComponent(docId)}/reprocess`, { method: 'POST' });
  }, []);

  const api = useMemo<DataApi>(() => ({
    ...state, masterData, jobs, toasts, connection, loading, error, role, canReview, canEditMasterData: role === 'owner',
    dismissToast,
    openIssuesFor: (docId) => state.issues.filter(issue => issue.docIds.includes(docId) && isActive(issue)),
    refresh,

    async setIssueStatus(issueId, status, note = '') {
      const backendStatus = status === 'UNDER_REVIEW' ? 'needs_review' : status.toLowerCase();
      const reason = note.trim() || (status === 'UNDER_REVIEW' ? 'Review started in the workspace.' : status === 'OPEN' ? 'Issue reopened in the workspace.' : 'Reviewer decision recorded in the workspace.');
      await perform(() => apiJson(`/api/issues/${encodeURIComponent(issueId)}/status`, { method: 'POST', body: { status: backendStatus, reason } }), `${issueId} ${status.replace('_', ' ').toLowerCase()}.`);
    },

    async confirmField(_issueId, docId, key, value) {
      const record = state.docs.find(item => item.id === docId);
      const sourceField = record?.fields.find(item => item.key === key);
      let corrected: unknown = value.trim();
      if (sourceField?.kind === 'money') {
        corrected = parseAmountToSen(value);
        if (corrected === null) { toast('Enter a valid amount such as 100.00.', 'error'); return; }
      }
      await perform(async () => {
        await recordCorrection(docId, FIELD_NAMES[key] || key, corrected, 'Checked or corrected against the uploaded source document.');
        await reprocess(docId);
      }, 'Correction saved. Re-check queued; the issue remains open for review.');
    },

    async correctPrice(_issueId, invoiceId, prices) {
      const invoice = state.docs.find(item => item.id === invoiceId);
      if (!invoice) { toast('The invoice is no longer available. Refresh the workspace.', 'error'); return; }
      const lines = invoice.lines.map(line => {
        const unitPriceSen = prices[line.id] ?? line.unitSen;
        const next: Record<string, unknown> = { description: line.description };
        if (line.quantity !== null) next.quantity = line.quantity;
        if (unitPriceSen !== null) next.unitPriceSen = unitPriceSen;
        if (line.quantity !== null && unitPriceSen !== null) next.totalSen = Math.round(line.quantity * unitPriceSen);
        else if (line.totalSen !== null) next.totalSen = line.totalSen;
        return next;
      });
      await perform(async () => {
        await recordCorrection(invoiceId, 'lines', lines, 'Corrected invoice line prices against the source document.');
        await reprocess(invoiceId);
      }, 'Price correction saved. Re-check queued; review the result before closing the issue.');
    },

    async linkToPo(_issueId, docId, poId) {
      await perform(async () => {
        await recordCorrection(docId, 'linkedPoDocumentId', poId, 'Purchase order link selected by a reviewer.');
        await reprocess(docId);
      }, 'PO link saved. Re-check queued; review the result before closing the issue.');
    },

    async resolveDuplicate(issueId, keepId) {
      const issue = state.issues.find(item => item.id === issueId);
      const duplicateId = issue?.docIds.find(id => id !== keepId);
      if (!issue || !duplicateId) { toast('Both duplicate records must be available to save this decision.', 'error'); return; }
      await perform(async () => {
        await apiJson(`/api/documents/${encodeURIComponent(duplicateId)}/reject`, { method: 'POST', body: { reason: `Marked as a duplicate of ${keepId}. The source file is retained.` } });
        await apiJson(`/api/issues/${encodeURIComponent(issueId)}/resolve`, { method: 'POST', body: { reason: `Kept ${keepId}; marked ${duplicateId} as the duplicate.` } });
      }, 'Duplicate decision saved. Both records remain in the audit trail.');
    },

    async updateClaim(claimId, patch) {
      const claim = state.claims.find(item => item.id === claimId);
      if (!claim) { toast('This claim is no longer available.', 'error'); return; }
      const entries = Object.entries(patch);
      if (!entries.length) return;
      await perform(async () => {
        for (const [key, value] of entries) {
          await recordCorrection(claim.receiptDocId, key === 'categoryCode' ? 'accountCode' : key, value, 'Claim updated by an authorized reviewer.');
        }
        await reprocess(claim.receiptDocId);
      }, 'Claim update saved. Re-check queued.');
    },

    async decideClaim(claimId, status, reason) {
      const claim = state.claims.find(item => item.id === claimId);
      if (!claim) { toast('This claim is no longer available.', 'error'); return; }
      const path = `/api/documents/${encodeURIComponent(claim.receiptDocId)}/${status === 'APPROVED' ? 'approve' : 'reject'}`;
      await perform(() => apiJson(path, { method: 'POST', ...(status === 'REJECTED' ? { body: { reason: reason || '' } } : {}) }), `Claim ${status.toLowerCase()}.`);
    },

    async exportCsv(kind, range = {}) {
      const params = new URLSearchParams({ kind: kind === 'claims' ? 'claims-approved' : 'purchasing-approved' });
      if (range.from) params.set('from', range.from);
      if (range.to) params.set('to', range.to);
      await perform(() => downloadApiFile(`/api/export?${params.toString()}`), 'Reviewed export downloaded.');
    },

    async downloadOriginal(docId) {
      await perform(() => downloadApiFile(`/api/documents/${encodeURIComponent(docId)}/file`), 'Original file downloaded.');
    },
  }), [state, masterData, jobs, toasts, connection, loading, error, role, canReview, dismissToast, refresh, perform, recordCorrection, reprocess, toast]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useData() {
  const value = useContext(Ctx);
  if (!value) throw new Error('DataProvider is required.');
  return value;
}
