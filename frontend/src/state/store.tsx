import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { AuditEntry, Claim, DocLink, DocRecord, DocType, Field, IntakeJob, Issue, IssueStatus, SourceRef, Toast, WorkspaceMasterData } from '../types';
import { downloadExport, downloadOriginal, getMasterData, listDocuments, listIssues, listJobs, request, saveMasterData } from '../lib/api';
import { parseAmountToSen } from '../lib/format';
import { useAuth } from './auth';

interface State { docs: DocRecord[]; links: DocLink[]; claims: Claim[]; issues: Issue[]; audit: AuditEntry[] }
interface DataApi extends State {
  jobs: IntakeJob[];
  toasts: Toast[]; dismissToast: (id: number) => void;
  loading: boolean; loadError: string; role: 'owner' | 'reviewer' | 'employee' | null; masterData: WorkspaceMasterData;
  refreshRecords: () => Promise<void>;
  setIssueStatus: (issueId: string, status: IssueStatus, note?: string) => Promise<void>;
  confirmField: (issueId: string, docId: string, key: string, value: string, reason: string) => Promise<void>;
  correctPrice: (issueId: string, invoiceId: string, prices: Record<string, number>, reason: string) => Promise<void>;
  linkToPo: (issueId: string, docId: string, poId: string, reason: string) => Promise<void>;
  resolveDuplicate: (issueId: string, keepId: string, reason: string) => Promise<void>;
  updateClaim: (claimId: string, patch: Partial<Pick<Claim, 'categoryCode' | 'standardizedDescription'>>, reason: string) => Promise<void>;
  decideClaim: (claimId: string, status: 'APPROVED' | 'REJECTED', reason?: string) => Promise<void>;
  exportCsv: (kind: 'purchasing' | 'claims', range?: { from?: string; to?: string }) => Promise<void>;
  originalFile: (documentId: string) => Promise<Blob>;
  saveMasterData: (value: WorkspaceMasterData) => Promise<void>;
}
const Context = createContext<DataApi | null>(null);
const emptyMaster: WorkspaceMasterData = { chartOfAccounts: [], suppliers: [], buyerProfile: null };

const obj = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {};
const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const string = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const sources = (value: unknown): SourceRef[] => list(value).filter(x => x && typeof x === 'object') as SourceRef[];
function reportActionError<A extends unknown[], R>(action: (...args: A) => Promise<R>, show: (message: string, tone?: Toast['tone']) => void) {
  return (...args: A): Promise<R> => action(...args).catch(error => {
    show(error instanceof Error ? error.message : 'The action could not be completed.', 'error');
    throw error;
  });
}
const typeFor = (workflow: string, rawType: string): DocType => {
  if (rawType === 'receipt') return workflow === 'claim' ? 'claim_receipt' : 'payment_receipt';
  if (rawType === 'quotation' || rawType === 'purchase_order' || rawType === 'delivery_order' || rawType === 'invoice' || rawType === 'payment_advice' || rawType === 'claim_receipt' || rawType === 'unclassified') return rawType;
  return 'unclassified';
};
const typeFields: Record<DocType, { key: string; label: string; source: string }[]> = {
  quotation: [{ key: 'quotation_no', label: 'Quotation number', source: 'documentNumber' }, { key: 'date', label: 'Date', source: 'documentDate' }, { key: 'supplier', label: 'Supplier', source: 'supplierName' }, { key: 'grand_total', label: 'Grand total', source: 'totalAmountSen' }],
  purchase_order: [{ key: 'po_no', label: 'PO number', source: 'poNumber' }, { key: 'date', label: 'Date', source: 'documentDate' }, { key: 'supplier', label: 'Supplier', source: 'supplierName' }, { key: 'grand_total', label: 'Grand total', source: 'totalAmountSen' }],
  delivery_order: [{ key: 'do_no', label: 'DO number', source: 'documentNumber' }, { key: 'date', label: 'Date', source: 'documentDate' }, { key: 'supplier', label: 'Supplier', source: 'supplierName' }],
  invoice: [{ key: 'invoice_no', label: 'Invoice number', source: 'invoiceNumber' }, { key: 'date', label: 'Date', source: 'documentDate' }, { key: 'supplier', label: 'Supplier', source: 'supplierName' }, { key: 'due_date', label: 'Due date', source: 'dueDate' }, { key: 'payment_terms', label: 'Payment term', source: 'paymentTerm' }, { key: 'grand_total', label: 'Grand total', source: 'totalAmountSen' }],
  payment_advice: [{ key: 'advice_no', label: 'Payment advice number', source: 'documentNumber' }, { key: 'date', label: 'Date', source: 'documentDate' }, { key: 'supplier', label: 'Supplier', source: 'supplierName' }, { key: 'amount', label: 'Amount', source: 'totalAmountSen' }],
  payment_receipt: [{ key: 'receipt_no', label: 'Receipt number', source: 'documentNumber' }, { key: 'date', label: 'Date', source: 'documentDate' }, { key: 'supplier', label: 'Supplier', source: 'supplierName' }, { key: 'amount', label: 'Amount', source: 'totalAmountSen' }],
  claim_receipt: [{ key: 'receipt_ref', label: 'Receipt reference', source: 'documentNumber' }, { key: 'date', label: 'Date', source: 'documentDate' }, { key: 'merchant', label: 'Merchant', source: 'merchantName' }, { key: 'total', label: 'Total', source: 'totalAmountSen' }],
  unclassified: [{ key: 'date', label: 'Date', source: 'documentDate' }],
};

function fieldValue(document: Record<string, any>, key: string, aliases: string[] = []) {
  for (const name of [key, ...aliases]) if (document[name] !== undefined && document[name] !== null) return document[name];
  return undefined;
}
function mapDocument(raw: Record<string, any>): DocRecord {
  const analysis = obj(raw.analysis); const extracted = obj(analysis.document);
  const workflow = string(raw.workflow, 'purchasing'); const docType = typeFor(workflow, string(extracted.type));
  const fieldSources = obj(extracted.fieldSources);
  const fields: Field[] = typeFields[docType].flatMap(def => {
    const aliases = def.source === 'documentNumber' ? ['invoiceNumber', 'poNumber'] : [];
    const value = fieldValue(extracted, def.source, aliases);
    if (value === undefined) return [];
    const kind: Field['kind'] = def.source.toLowerCase().includes('date') || def.key === 'date' || def.key === 'due_date' ? 'date' : def.source.toLowerCase().includes('sen') ? 'money' : 'text';
    return [{ key: def.key, label: def.label, kind, value: kind === 'money' ? '' : String(value), ...(kind === 'money' ? { sen: number(value) } : {}), sourceRefs: sources(fieldSources[def.source]) }];
  });
  const lines = list(extracted.lines).map((line, index) => {
    const item = obj(line); return { id: string(item.id, `${string(raw.id, 'doc')}-line-${index + 1}`), description: string(item.item ?? item.description, `Line ${index + 1}`), quantity: number(item.quantity) ?? 0, unitSen: number(item.unitPriceSen ?? item.unitSen) ?? null, totalSen: number(item.totalSen) ?? null };
  });
  const jobStatus = string(raw.status, 'uploaded');
  const status: DocRecord['status'] = jobStatus === 'approved' ? 'VERIFIED' : jobStatus === 'rejected' ? 'REJECTED' : jobStatus === 'queued' ? 'UPLOADED' : jobStatus === 'processing' ? 'PROCESSING' : jobStatus === 'needs_configuration' ? 'NEEDS_CONFIGURATION' : jobStatus === 'failed' ? 'FAILED' : (jobStatus === 'needs_review' || list(raw.findings).length) ? 'NEEDS_REVIEW' : 'EXTRACTED';
  const hash = string(raw.sha256, '');
  return {
    id: string(raw.id), docType, flow: workflow === 'claim' ? 'claims' : 'purchasing', filename: string(raw.originalFilename, 'Uploaded file'),
    fields, lines, status, rawStatus: jobStatus, hash, version: number(raw.inputVersion) ?? 1, inputVersion: number(raw.inputVersion) ?? 1, analysisVersion: number(raw.analysisVersion),
    uploadedAt: string(raw.createdAt, new Date(0).toISOString()), uploadedBy: workflow === 'claim' ? 'Employee' : 'Business',
    purpose: string(raw.manualOverrides?.purpose, string(raw.purpose)), note: jobStatus === 'rejected' ? string(raw.rejectionReason) : undefined,
    sourceRefs: sources(analysis.sourceReferences), agentResults: obj(analysis.agentResults),
  };
}
function mapIssue(raw: Record<string, any>): Issue {
  const refs = sources(raw.sourceRefs); const docs = [...new Set([string(raw.documentId), ...refs.map(x => string(x.documentId))].filter(Boolean))];
  const severity = string(raw.severity) === 'error' ? 'HIGH' : string(raw.severity) === 'info' ? 'INFO' : 'WARNING';
  const status = string(raw.status);
  const sourceField = string(refs.find(ref => ref.field)?.field);
  const fieldKeyMap: Record<string, string> = { documentNumber: 'invoice_no', invoiceNumber: 'invoice_no', poNumber: 'po_no', documentDate: 'date', dueDate: 'due_date', supplierName: 'supplier', merchantName: 'merchant', totalAmountSen: 'grand_total', paymentTerm: 'payment_terms' };
  const codes: Record<string, string> = { PURCHASE_MISSING_PO: 'MISSING_PO', PURCHASE_PO_MATCH_REVIEW: 'AMBIGUOUS_PO_MATCH', PURCHASE_DUPLICATE_INVOICE: 'DUPLICATE_INVOICE', DUPLICATE_FILE_CONTENT: 'DUPLICATE_FILE', EXTRACTION_VALIDATION_FAILED: 'EXTRACTION_UNCERTAIN' };
  return {
    id: string(raw.id), ruleCode: codes[string(raw.code)] || string(raw.code, 'REVIEW_REQUIRED'), typeLabel: string(raw.code, 'Review finding').replaceAll('_', ' ').toLowerCase(),
    title: string(raw.message, 'Review required'), severity, status: status === 'resolved' ? 'RESOLVED' : status === 'dismissed' ? 'DISMISSED' : status === 'under_review' ? 'UNDER_REVIEW' : status === 'needs_review' ? 'UNDER_REVIEW' : 'OPEN',
    rawStatus: status, docIds: docs, ...(fieldKeyMap[sourceField] ? { fieldKey: fieldKeyMap[sourceField] } : {}), detected: string(raw.message, 'Review finding'), why: [raw.expected != null ? `Expected: ${typeof raw.expected === 'object' ? JSON.stringify(raw.expected) : String(raw.expected)}` : '', raw.observed != null ? `Observed: ${typeof raw.observed === 'object' ? JSON.stringify(raw.observed) : String(raw.observed)}` : ''].filter(Boolean).join(' · '),
    suggested: [], evidence: refs.map((ref, index) => ({ label: ref.field || `Source ${index + 1}`, ...(ref.quote ? { found: ref.quote } : {}), ...(ref.page ? { note: `Page ${ref.page}` } : {}), ...(ref.row ? { note: `Row ${ref.row}` } : {}) })),
    sourceRefs: refs, createdAt: string(raw.createdAt, new Date(0).toISOString()), resolution: string(raw.resolutionReason) || undefined,
  };
}
function mapClaim(raw: Record<string, any>): Claim | null {
  if (raw.workflow !== 'claim' && raw.flow !== 'claims') return null;
  const record = mapDocument(raw); const extracted = obj(obj(raw.analysis).document);
  const pending = record.status !== 'VERIFIED' && record.status !== 'REJECTED';
  const status: Claim['status'] = record.status === 'VERIFIED' ? 'APPROVED' : record.status === 'REJECTED' ? 'REJECTED' : list(raw.findings).length || record.status === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : 'PLAUSIBLE';
  const account = string(extracted.accountCode, string(extracted.category?.code, string(extracted.categoryCode))) || null;
  const accountName = string(extracted.category?.label);
  return {
    id: record.id, employee: 'Employee', receiptDocId: record.id, employeePurpose: record.purpose || string(extracted.purpose),
    categoryCode: account, categoryConfidence: 0, alternativeCodes: [], categoryReasoning: accountName ? `Suggested account: ${accountName}.` : 'No account recommendation was recorded.',
    standardizedDescription: string(extracted.standardizedDescription), findings: list(raw.findings).map(x => string(obj(x).message)).filter(Boolean), status,
    ...(pending ? {} : { decision: { by: string(raw.approvedBy, 'Reviewer'), at: string(raw.approvedAt, string(raw.updatedAt)) , ...(raw.rejectionReason ? { reason: string(raw.rejectionReason) } : {}) } }),
  };
}
function mapAudit(jobs: IntakeJob[]): AuditEntry[] {
  return jobs.flatMap(job => list(job.events).map((item: unknown, index: number) => {
    const e = obj(item); const payload = obj(e.payload); const action = string(e.summary, string(payload.summary, string(e.state, 'Workflow update')));
    const actor = string(e.actor, string(e.agent, 'Workflow'));
    return { id: string(e.eventId, string(e.event_id, `${string(job.id)}-${index}`)), timestamp: string(e.timestamp, string(e.createdAt, '')), actor, actorKind: ['human-review', 'owner', 'reviewer'].includes(actor) ? 'human' as const : 'agent' as const, action, entityId: string(e.issueId, string(payload.issueId, string(job.documentId))) };
  }));
}

export function DataProvider({ children }: { children: React.ReactNode }) {
  const { token, role } = useAuth();
  const [state, setState] = useState<State>({ docs: [], links: [], claims: [], issues: [], audit: [] });
  const [masterData, setMaster] = useState<WorkspaceMasterData>(emptyMaster);
  const [jobs, setJobs] = useState<IntakeJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const sequence = useRef(0);
  const latest = useRef(state); latest.current = state;

  const refreshRecords = useCallback(async () => {
    if (!token) { setState({ docs: [], links: [], claims: [], issues: [], audit: [] }); setJobs([]); setMaster(emptyMaster); setLoading(false); return; }
    setLoading(true);
    try {
      const [documents, rawIssues, rawJobs, master] = await Promise.all([listDocuments(), listIssues(), listJobs(), getMasterData()]);
      const allowed = role === 'employee' ? documents.filter(d => d.workflow === 'claim') : documents;
      const docs = allowed.map(mapDocument);
      const allowedIds = new Set(docs.map(d => d.id));
      const issues = rawIssues.map(mapIssue).filter(issue => issue.docIds.some(id => allowedIds.has(id))).map(issue => {
        const claimRecord = docs.find(document => document.flow === 'claims' && issue.docIds.includes(document.id));
        return claimRecord ? { ...issue, claimId: claimRecord.id } : issue;
      });
      const claims = allowed.map(mapClaim).filter((c): c is Claim => c !== null);
      const links: DocLink[] = docs.flatMap(d => {
        const raw = allowed.find(x => x.id === d.id); const extracted = obj(obj(raw).analysis).document;
        const poId = string(obj(extracted).linkedPoDocumentId, string(obj(raw).linkedPoDocumentId));
        return poId && allowedIds.has(poId) ? [{ id: `LNK-${d.id}-${poId}`, sourceId: d.id, targetId: poId, relationship: 'for_po' as const, confidence: null, confirmedBy: null }] : [];
      });
      setJobs(rawJobs.filter(job => allowedIds.has(job.documentId)));
      setState({ docs, links, claims, issues, audit: mapAudit(rawJobs) }); setMaster(master || emptyMaster); setLoadError('');
    } catch (error) { setLoadError((error as Error).message || 'Could not load the workspace.'); throw error; }
    finally { setLoading(false); }
  }, [token, role]);

  useEffect(() => { if (token && role) void refreshRecords().catch(() => {}); else { setState({ docs: [], links: [], claims: [], issues: [], audit: [] }); setMaster(emptyMaster); setJobs([]); setLoading(false); } }, [token, role, refreshRecords]);

  const toast = useCallback((message: string, tone: Toast['tone'] = 'success') => {
    const id = Date.now() + ++sequence.current; setToasts(items => [...items.slice(-2), { id, message, tone }]);
    window.setTimeout(() => setToasts(items => items.filter(item => item.id !== id)), 5000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts(items => items.filter(item => item.id !== id)), []);
  const reload = async (message: string) => { await refreshRecords(); toast(message); };
  const requireReviewer = () => { if (role !== 'owner' && role !== 'reviewer') throw new Error('A reviewer or owner must perform this action.'); };
  const setIssueStatus = useCallback(async (issueId: string, status: IssueStatus, note = '') => {
    requireReviewer();
    const wire = status === 'RESOLVED' ? 'resolved' : status === 'DISMISSED' ? 'dismissed' : status === 'UNDER_REVIEW' ? 'needs_review' : 'open';
    await request(`/api/issues/${encodeURIComponent(issueId)}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: wire, reason: note }) });
    await reload(`Issue ${issueId} updated.`);
  }, [token, role, refreshRecords, toast]);
  const correction = useCallback(async (docId: string, field: string, value: unknown, reason: string) => {
    requireReviewer();
    await request(`/api/documents/${encodeURIComponent(docId)}/corrections`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ field, value, reason }) });
    const result = await request<{ job: { id: string } }>(`/api/documents/${encodeURIComponent(docId)}/reprocess`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await refreshRecords();
    return result.job.id;
  }, [token, role, refreshRecords]);
  const confirmField = useCallback(async (_issueId: string, docId: string, key: string, value: string, reason: string) => {
    const fieldMap: Record<string, string> = { invoice_no: 'invoiceNumber', po_no: 'poNumber', date: 'documentDate', supplier: 'supplierName', merchant: 'merchantName', grand_total: 'totalAmountSen', total: 'totalAmountSen', due_date: 'dueDate', payment_terms: 'paymentTerm', advice_no: 'documentNumber', receipt_no: 'documentNumber', quotation_no: 'documentNumber', do_no: 'documentNumber', receipt_ref: 'documentNumber' };
    const field = fieldMap[key] || key; const numeric = field === 'totalAmountSen' ? parseAmountToSen(value) : value;
    if (field === 'totalAmountSen' && numeric === null) throw new Error('Enter a valid amount in Malaysian ringgit.');
    await correction(docId, field, numeric, reason); toast('Correction saved. A new check is running.');
  }, [correction, toast]);
  const correctPrice = useCallback(async (_issueId: string, invoiceId: string, prices: Record<string, number>, reason: string): Promise<void> => {
    const invoice = latest.current.docs.find(d => d.id === invoiceId); if (!invoice) throw new Error('Invoice is no longer available.');
    const lines = invoice.lines.map(line => prices[line.id] === undefined ? line : { id: line.id, item: line.description, quantity: line.quantity, unitPriceSen: prices[line.id], totalSen: Math.round(line.quantity * prices[line.id]) });
    await correction(invoiceId, 'lines', lines, reason); toast('Prices saved. The server is rechecking the invoice.');
  }, [correction, toast]);
  const linkToPo = useCallback(async (_issueId: string, docId: string, poId: string, reason: string) => { await correction(docId, 'linkedPoDocumentId', poId, reason); toast('PO link saved. The server is rechecking the document.'); }, [correction, toast]);
  const resolveDuplicate = useCallback(async (issueId: string, keepId: string, reason: string) => {
    requireReviewer();
    const issue = latest.current.issues.find(i => i.id === issueId); const dropId = issue?.docIds.find(id => id !== keepId);
    if (!dropId) throw new Error('The duplicate record is no longer available.');
    await request(`/api/documents/${encodeURIComponent(dropId)}/reject`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: `${reason} Kept ${keepId}.` }) });
    await request(`/api/issues/${encodeURIComponent(issueId)}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'resolved', reason }) });
    await reload('Duplicate decision saved. Both records remain in the audit trail.');
  }, [token, role, refreshRecords, toast]);
  const updateClaim = useCallback(async (claimId: string, patch: Partial<Pick<Claim, 'categoryCode' | 'standardizedDescription'>>, reason: string) => {
    const docId = latest.current.claims.find(c => c.id === claimId)?.receiptDocId; if (!docId) throw new Error('Claim is no longer available.');
    const field = patch.categoryCode !== undefined ? 'accountCode' : 'standardizedDescription'; const value = patch.categoryCode ?? patch.standardizedDescription;
    if (value === undefined) return;
    await correction(docId, field, value, reason); toast('Claim updated. A new check is running.');
  }, [correction, toast]);
  const decideClaim = useCallback(async (claimId: string, status: 'APPROVED' | 'REJECTED', reason = '') => {
    requireReviewer(); const docId = latest.current.claims.find(c => c.id === claimId)?.receiptDocId; if (!docId) throw new Error('Claim is no longer available.');
    const path = status === 'APPROVED' ? `/api/documents/${encodeURIComponent(docId)}/approve` : `/api/documents/${encodeURIComponent(docId)}/reject`;
    await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: status === 'REJECTED' ? JSON.stringify({ reason }) : '{}' });
    await reload(`Claim ${status === 'APPROVED' ? 'approved' : 'rejected'}.`);
  }, [token, role, refreshRecords, toast]);
  const exportCsv = useCallback(async (kind: 'purchasing' | 'claims', range: { from?: string; to?: string } = {}) => {
    await downloadExport(kind === 'purchasing' ? 'purchasing-approved' : 'claims-approved', range); toast('CSV downloaded.');
  }, [token, toast]);
  const saveBusinessData = useCallback(async (value: WorkspaceMasterData) => { if (role !== 'owner') throw new Error('Only an owner can edit company reference data.'); setMaster(await saveMasterData(value)); toast('Company reference data saved.'); }, [token, role, toast]);
  const api = useMemo<DataApi>(() => ({
    ...state, jobs, toasts, dismissToast, loading, loadError, role, masterData, refreshRecords,
    setIssueStatus: reportActionError(setIssueStatus, toast),
    confirmField: reportActionError(confirmField, toast),
    correctPrice: reportActionError(correctPrice, toast),
    linkToPo: reportActionError(linkToPo, toast),
    resolveDuplicate: reportActionError(resolveDuplicate, toast),
    updateClaim: reportActionError(updateClaim, toast),
    decideClaim: reportActionError(decideClaim, toast),
    exportCsv: reportActionError(exportCsv, toast),
    originalFile: reportActionError(downloadOriginal, toast),
    saveMasterData: reportActionError(saveBusinessData, toast),
  }), [state, jobs, toasts, dismissToast, loading, loadError, role, masterData, refreshRecords, setIssueStatus, confirmField, correctPrice, linkToPo, resolveDuplicate, updateClaim, decideClaim, exportCsv, saveBusinessData, toast]);
  return <Context.Provider value={api}>{children}</Context.Provider>;
}

export function useData() { const value = useContext(Context); if (!value) throw new Error('DataProvider is required.'); return value; }
