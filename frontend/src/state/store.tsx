import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { AuditEntry, Claim, DocLink, DocRecord, Issue, IssueStatus, Toast } from '../types';
import { REVIEWER } from '../data/dummy';
import { csvCell, docAmount, docDate, docNumber, docParty, docTax, field, lineTotal, poIdOf, repriceInvoice } from '../lib/docs';
import { decimalFromSen } from '../lib/format';
import { checkInvoice } from '../lib/verify';

/* One shared record set for Live Execution, Documents and Action Items.
   The only source is the backend (/api/records), which reads Supabase Postgres through the Prisma schema.
   The page starts empty and shows exactly what retrieveRecords() returns: no sample data, no browser copy. */

interface State { docs: DocRecord[]; links: DocLink[]; claims: Claim[]; issues: Issue[]; audit: AuditEntry[] }
const EMPTY: State = { docs: [], links: [], claims: [], issues: [], audit: [] };
const OLD_BROWSER_COPY = 'tutupbuku.records.v4';   // earlier versions cached records here; removed on start

/** Retrieve the saved records (and their version) from the backend. */
export async function retrieveRecords(): Promise<{ version: number; records: State; storage: { mode: StorageState['mode'] } }> {
  const response = await fetch('/api/records', { cache: 'no-store' }).catch(() => null);
  const body = response ? await response.json().catch(() => null) : null;
  // No JSON body means the request never reached TutupBuku (for example the Vite proxy could not connect).
  if (!response || !body) throw new Error('The backend is not running or cannot be reached. Start it with: py -3.13 -m tutupbuku.app --web-only --frontend');
  if (!response.ok) throw new Error(body.error || `Record service error ${response.status}`);
  const records = body.records || {};
  return { version: body.version, storage: body.storage, records: { docs: records.docs || [], links: records.links || [], claims: records.claims || [], issues: records.issues || [], audit: records.audit || [] } };
}

/** Sequential ids (ISS-010, ISS-011…) continuing from the highest existing number. */
export const allocIds = (prefix: string, existing: string[], count: number) => {
  const max = existing.reduce((m, id) => { const n = Number(id.split('-').pop()); return id.startsWith(`${prefix}-`) && Number.isFinite(n) ? Math.max(m, n) : m; }, 0);
  return Array.from({ length: count }, (_, k) => `${prefix}-${String(max + 1 + k).padStart(3, '0')}`);
};

/** Where the records are saved, as reported by the backend. */
export interface StorageState { mode: 'loading' | 'supabase' | 'local' | 'offline'; ok: boolean; message?: string }

export interface Bundle { docs: DocRecord[]; links: DocLink[]; claims: Claim[]; issues: Issue[]; note: string; entityId: string }

interface DataApi extends State {
  storage: StorageState;
  /** Fetch the records from Supabase again and show them (discards nothing that is already saved). */
  reload: () => Promise<void>;
  toasts: Toast[];
  dismissToast: (id: number) => void;
  latest: React.MutableRefObject<State>;
  openIssuesFor: (docId: string) => Issue[];
  commit: (bundle: Bundle, actor: string) => void;
  setIssueStatus: (issueId: string, status: IssueStatus, note?: string) => void;
  confirmField: (issueId: string, docId: string, key: string, value: string) => void;
  correctPrice: (issueId: string, invoiceId: string, prices: Record<string, number>) => 'cleared' | 'still-differs';
  linkToPo: (issueId: string, docId: string, poId: string) => void;
  /** The supplier sent a corrected invoice: it supersedes the flagged one (kept as rejected), is re-checked against the PO, and the issue is resolved. */
  replaceInvoice: (issueId: string, oldInvoiceId: string, file: { name: string; hash: string }) => 'replaced' | 'failed';
  resolveDuplicate: (issueId: string, keepId: string) => void;
  updateClaim: (claimId: string, patch: Partial<Pick<Claim, 'categoryCode' | 'standardizedDescription'>>) => void;
  decideClaim: (claimId: string, status: 'APPROVED' | 'REJECTED', reason?: string) => void;
  exportCsv: (kind: 'purchasing' | 'claims', range?: { from?: string; to?: string }) => number;
}

const Ctx = createContext<DataApi | null>(null);
const ACTIVE: IssueStatus[] = ['OPEN', 'UNDER_REVIEW'];
const isActive = (i: Issue) => ACTIVE.includes(i.status);

export function DataProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>(EMPTY);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const latest = useRef(state);
  latest.current = state;
  const seq = useRef(0);

  const [storage, setStorage] = useState<StorageState>({ mode: 'loading', ok: false });
  const version = useRef<number | null>(null);
  const ready = useRef(false);          // true once the backend copy is loaded; only then do edits save
  const skipSave = useRef(false);       // set when the state came from the server, so it is not echoed back
  const inflight = useRef(false);
  const queued = useRef(false);

  const fetchRecords = retrieveRecords;

  const push = useCallback(async (records: State): Promise<void> => {
    if (inflight.current) { queued.current = true; return; }
    inflight.current = true;
    try {
      const response = await fetch('/api/records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records, expected_version: version.current }) });
      const body = await response.json().catch(() => ({}));
      if (response.status === 409) {
        const fresh = await fetchRecords();
        version.current = fresh.version;
        skipSave.current = true; setState(fresh.records);
        toast('These records were changed elsewhere, so the latest saved version was loaded. Repeat your last change if it is missing.', 'info');
        return;
      }
      if (!response.ok) throw new Error(body.error || `Record service error ${response.status}`);
      version.current = body.version;
      setStorage({ mode: body.storage.mode, ok: true });
    } catch (e) {
      setStorage(s => ({ ...s, ok: false, message: `Not saved: ${(e as Error).message}` }));
    } finally {
      inflight.current = false;
      if (queued.current) { queued.current = false; void push(latest.current); }
    }
  }, [fetchRecords]);   // eslint-disable-line react-hooks/exhaustive-deps

  const reload = useCallback(async () => {
    setStorage(s => ({ ...s, mode: s.ok ? s.mode : 'loading' }));
    try {
      const loaded = await fetchRecords();
      version.current = loaded.version;
      skipSave.current = true;            // what came from the server is not echoed back
      setState(loaded.records);
      setStorage({ mode: loaded.storage.mode, ok: true });
      ready.current = true;               // edits save only after a successful load
    } catch (e) {
      setStorage({ mode: 'offline', ok: false, message: (e as Error).message });
    }
  }, [fetchRecords]);

  useEffect(() => {
    try { window.localStorage.removeItem(OLD_BROWSER_COPY); } catch { /* storage unavailable */ }
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!ready.current) return;
    if (skipSave.current) { skipSave.current = false; return; }
    const timer = window.setTimeout(() => void push(latest.current), 400);
    return () => window.clearTimeout(timer);
  }, [state]);   // eslint-disable-line react-hooks/exhaustive-deps

  const toast = useCallback((message: string, tone: Toast['tone'] = 'success') => {
    const id = Date.now() + ++seq.current;
    setToasts(items => [...items.slice(-2), { id, message, tone }]);
    window.setTimeout(() => setToasts(items => items.filter(item => item.id !== id)), 5000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts(items => items.filter(item => item.id !== id)), []);

  const entry = (entityId: string, action: string, actor = REVIEWER, previous?: string, next?: string, kind: 'human' | 'agent' = 'human'): AuditEntry =>
    ({ id: `A-${Date.now().toString(36)}-${++seq.current}`, timestamp: new Date().toISOString(), actor, actorKind: kind, action, entityId, previous, next });

  /** After issues change, a non-rejected invoice with no active issue left is verified (the only route to VERIFIED besides the agent). */
  const autoVerify = (s: State): State => {
    const verified: string[] = [];
    const docs = s.docs.map(d => {
      if (d.docType !== 'invoice' || ['VERIFIED', 'REJECTED', 'UPLOADED'].includes(d.status)) return d;
      if (s.issues.some(i => isActive(i) && i.docIds.includes(d.id))) return d;
      verified.push(d.id); return { ...d, status: 'VERIFIED' as const };
    });
    return verified.length ? { ...s, docs, audit: [...verified.map(id => entry(id, 'Verified: no open issues remain', REVIEWER, 'NEEDS_REVIEW', 'VERIFIED')), ...s.audit] } : s;
  };
  const closeIssue = (s: State, id: string, status: IssueStatus, note: string): State => {
    const issue = s.issues.find(i => i.id === id);
    if (!issue || issue.status === status) return s;
    return { ...s, issues: s.issues.map(i => i.id === id ? { ...i, status, resolution: status === 'RESOLVED' || status === 'DISMISSED' ? note || undefined : i.resolution } : i),
      audit: [entry(id, note ? `Status changed — ${note}` : 'Status changed', REVIEWER, issue.status, status), ...s.audit] };
  };

  const api = useMemo<DataApi>(() => ({
    ...state, storage, reload, toasts, dismissToast, latest,
    openIssuesFor: docId => state.issues.filter(i => i.docIds.includes(docId) && isActive(i)),

    commit(bundle, actor) {
      setState(s => autoVerifyNew({
        docs: [...bundle.docs, ...s.docs], links: [...bundle.links, ...s.links], claims: [...bundle.claims, ...s.claims], issues: [...bundle.issues, ...s.issues],
        audit: [entry(bundle.entityId, bundle.note, actor, undefined, undefined, 'agent'), ...s.audit],
      }));
    },


    setIssueStatus(issueId, status, note = '') {
      setState(s => autoVerify(closeIssue(s, issueId, status, note.trim())));
      toast(`${issueId} ${status.replace('_', ' ').toLowerCase()}.`);
    },

    confirmField(issueId, docId, key, value) {
      setState(s => {
        const doc = s.docs.find(d => d.id === docId); const f = doc && field(doc, key);
        if (!doc || !f) return s;
        const docs = s.docs.map(d => d.id !== docId ? d : { ...d, version: d.version + 1, fields: d.fields.map(x => x.key === key ? { ...x, value: value.trim(), confidence: 1 } : x) });
        const changed = f.value !== value.trim();
        const next = { ...s, docs, audit: [entry(docId, changed ? `Corrected ${f.label}` : `Confirmed ${f.label}`, REVIEWER, f.value, value.trim()), ...s.audit] };
        return autoVerify(closeIssue(next, issueId, 'RESOLVED', changed ? `Value corrected to ${value.trim()}.` : 'Value confirmed against the source.'));
      });
      toast('Saved.');
    },

    correctPrice(issueId, invoiceId, prices) {
      const inv = latest.current.docs.find(d => d.id === invoiceId);
      const poId = inv ? poIdOf(inv, latest.current.links) : null;
      const po = poId ? latest.current.docs.find(d => d.id === poId) : undefined;
      if (!inv || !po) return 'still-differs';
      const { lines, fields: fixedFields } = repriceInvoice(inv, prices);
      const differs = lines.some(l => { const p = po.lines.find(x => x.description === l.description); return p && p.unitSen !== null && l.unitSen !== null && p.unitSen !== l.unitSen; });
      setState(s => {
        const next = { ...s, docs: s.docs.map(d => d.id === invoiceId ? { ...d, lines, fields: fixedFields, version: d.version + 1 } : d),
          audit: [entry(invoiceId, 'Corrected extracted unit price(s)', REVIEWER, undefined, 'Re-check ' + (differs ? 'still differs' : 'passed')), ...s.audit] };
        return differs ? next : autoVerify(closeIssue(next, issueId, 'RESOLVED', 'Unit price corrected; re-check against the PO passed.'));
      });
      toast(differs ? 'Saved. The price still differs from the PO.' : 'Corrected. Re-check passed.', differs ? 'info' : 'success');
      return differs ? 'still-differs' : 'cleared';
    },

    linkToPo(issueId, docId, poId) {
      setState(s => {
        let next: State = { ...s, links: [...s.links.filter(l => !(l.sourceId === docId && l.relationship === 'for_po')),
          { id: `LNK-${docId}-${poId}`, sourceId: docId, targetId: poId, relationship: 'for_po', confidence: 1, confirmedBy: REVIEWER }],
          audit: [entry(docId, 'PO link confirmed', REVIEWER, undefined, poId), ...s.audit] };
        next = closeIssue(next, issueId, 'RESOLVED', `Linked to ${docNumber(s.docs.find(d => d.id === poId)!)}.`);
        const inv = next.docs.find(d => d.id === docId);
        if (inv && inv.docType === 'invoice') {
          // Re-run the PO-dependent checks now that the link exists.
          const po = next.docs.find(d => d.id === poId)!;
          const fresh = checkInvoice(inv, next.docs, next.links, docNumber(po)).issues
            .filter(d => !['MISSING_PO', 'AMBIGUOUS_PO_MATCH', 'DUPLICATE_INVOICE'].includes(d.ruleCode))
            .filter(d => !next.issues.some(i => i.ruleCode === d.ruleCode && isActive(i) && i.docIds.includes(docId)));
          const ids = allocIds('ISS', next.issues.map(i => i.id), fresh.length);
          const created = fresh.map((d, n): Issue => ({ ...d, id: ids[n], status: 'OPEN', createdAt: new Date().toISOString() }));
          if (created.length) next = { ...next, issues: [...created, ...next.issues], audit: [entry(docId, `Re-check after linking raised ${created.length} issue(s)`, 'Verify & Audit Agent', undefined, undefined, 'agent'), ...next.audit] };
        }
        return autoVerify(next);
      });
      toast('Link confirmed and checks re-run.');
    },

    replaceInvoice(issueId, oldInvoiceId, file) {
      const cur = latest.current;
      const old = cur.docs.find(d => d.id === oldInvoiceId && d.docType === 'invoice');
      const poId = old ? poIdOf(old, cur.links) : null;
      const po = poId ? cur.docs.find(d => d.id === poId) : undefined;
      if (!old || !po) return 'failed';
      // No OCR is connected: the corrected invoice is read as the old one billed at the PO's unit prices.
      const prices: Record<string, number> = {};
      for (const l of old.lines) { const p = po.lines.find(x => x.description === l.description); if (p && p.unitSen !== null) prices[l.id] = p.unitSen; }
      const repriced = repriceInvoice(old, prices);
      const oldNo = docNumber(old);
      const found = /([A-Z]{2,4}[-_/]INV[-_/]\d{2}[-_/]\d{3,5}[A-Z]?)/i.exec(file.name);
      let newNo = found ? found[1].replace(/_/g, '-') : '';
      if (!newNo || newNo === oldNo) newNo = `${oldNo}-R`;
      const [newId] = allocIds('DOC', cur.docs.map(d => d.id), 1);
      const today = new Date().toISOString().slice(0, 10);
      const fields = repriced.fields.map(f => f.key === 'invoice_no' ? { ...f, value: newNo, confidence: 1 } : f.key === 'date' ? { ...f, value: today, confidence: 1 } : f);
      const fresh: DocRecord = { ...old, id: newId, filename: file.name, hash: file.hash, version: 1, lines: repriced.lines, fields, status: 'EXTRACTED', note: `Corrected invoice replacing ${oldNo}.`,
        uploadedAt: new Date().toISOString(), uploadedBy: REVIEWER, sourceUrl: undefined };
      setState(s => {
        let next: State = { ...s,
          docs: [fresh, ...s.docs.map(d => d.id === oldInvoiceId ? { ...d, status: 'REJECTED' as const, note: `Superseded by corrected invoice ${newNo} (${newId}).` } : d)],
          links: [{ id: `LNK-${newId}-${po.id}`, sourceId: newId, targetId: po.id, relationship: 'for_po', confidence: 1, confirmedBy: REVIEWER }, ...s.links],
          audit: [entry(oldInvoiceId, `Superseded by corrected invoice ${newNo}`, REVIEWER, old.status, 'REJECTED'), entry(newId, `Corrected invoice ${newNo} received for ${oldNo}`, REVIEWER), ...s.audit] };
        next = closeIssue(next, issueId, 'RESOLVED', `Replaced by corrected invoice ${newNo}.`);
        const recheck = checkInvoice(fresh, next.docs, next.links, docNumber(po)).issues
          .filter(d => !['MISSING_PO', 'AMBIGUOUS_PO_MATCH', 'DUPLICATE_INVOICE'].includes(d.ruleCode));
        if (recheck.length) {
          const ids = allocIds('ISS', next.issues.map(i => i.id), recheck.length);
          next = { ...next, issues: [...recheck.map((d, n): Issue => ({ ...d, id: ids[n], status: 'OPEN', createdAt: new Date().toISOString() })), ...next.issues], docs: next.docs.map(d => d.id === newId ? { ...d, status: 'NEEDS_REVIEW' as const } : d) };
        }
        return autoVerify(next);
      });
      toast(`Corrected invoice ${newNo} saved; ${oldNo} is marked as superseded.`);
      return 'replaced';
    },

    resolveDuplicate(issueId, keepId) {
      setState(s => {
        const issue = s.issues.find(i => i.id === issueId);
        const dropId = issue?.docIds.find(id => id !== keepId && s.docs.some(d => d.id === id && d.docType === s.docs.find(x => x.id === keepId)?.docType));
        const keep = s.docs.find(d => d.id === keepId);
        if (!issue || !dropId || !keep) return s;
        // Nothing is deleted: the duplicate keeps its source file, fields and audit trail with status REJECTED.
        const next: State = { ...s, docs: s.docs.map(d => d.id === dropId ? { ...d, status: 'REJECTED', note: `Marked duplicate of ${docNumber(keep)} (${keepId}).` } : d),
          audit: [entry(dropId, `Marked as duplicate of ${keepId}`, REVIEWER, undefined, 'REJECTED'), ...s.audit] };
        return autoVerify(closeIssue(next, issueId, 'RESOLVED', `Kept ${keepId}; ${dropId} marked as duplicate (record retained).`));
      });
      toast('Duplicate marked. Both records are kept in the audit trail.');
    },

    updateClaim(claimId, patch) {
      setState(s => ({ ...s, claims: s.claims.map(c => c.id === claimId && c.status !== 'APPROVED' && c.status !== 'REJECTED' ? { ...c, ...patch } : c),
        audit: [entry(claimId, patch.categoryCode !== undefined ? 'Account changed' : 'Description edited', REVIEWER, undefined, patch.categoryCode ?? undefined), ...s.audit] }));
    },

    decideClaim(claimId, status, reason) {
      setState(s => {
        const claim = s.claims.find(c => c.id === claimId);
        if (!claim) return s;
        return { ...s, claims: s.claims.map(c => c.id === claimId ? { ...c, status, decision: { by: REVIEWER, at: new Date().toISOString(), reason: reason?.trim() || undefined } } : c),
          audit: [entry(claimId, `Claim ${status.toLowerCase()}${reason?.trim() ? ` — ${reason.trim()}` : ''}`, REVIEWER, claim.status, status), ...s.audit] };
      });
      toast(`${claimId} ${status.toLowerCase()}.`);
    },

    exportCsv(kind, range = {}) {
      const { docs, links, claims } = latest.current;
      const inRange = (date: string) => (!range.from || (!!date && date >= range.from)) && (!range.to || (!!date && date <= range.to));       // always the current persisted status
      const rows: string[][] = [];
      let header: string[];
      if (kind === 'purchasing') {
        header = ['supplier', 'invoice_number', 'invoice_date', 'due_date', 'po_number', 'account_code_if_available', 'amount', 'tax_amount_if_available', 'verification_status'];
        for (const inv of docs.filter(d => d.docType === 'invoice' && d.status === 'VERIFIED' && inRange(docDate(d)))) {
          const po = docs.find(d => d.id === poIdOf(inv, links));
          const tax = docTax(inv);
          rows.push([docParty(inv), docNumber(inv), docDate(inv), field(inv, 'due_date')?.value ?? '', po ? docNumber(po) : '', '', decimalFromSen(docAmount(inv) ?? 0), tax === null ? '' : decimalFromSen(tax), inv.status]);
        }
      } else {
        header = ['employee', 'receipt_reference', 'expense_date', 'merchant', 'account_code', 'standardized_description', 'amount', 'tax_amount_if_available', 'approval_status'];
        for (const claim of claims.filter(c => c.status === 'APPROVED')) {       // PLAUSIBLE/NEEDS_REVIEW (pending) and REJECTED never export
          const receipt = docs.find(d => d.id === claim.receiptDocId);
          if (!receipt || !inRange(docDate(receipt))) continue;
          const tax = docTax(receipt);
          rows.push([claim.employee, docNumber(receipt), docDate(receipt), docParty(receipt), claim.categoryCode ?? '', claim.standardizedDescription, decimalFromSen(docAmount(receipt) ?? 0), tax === null ? '' : decimalFromSen(tax), claim.status]);
        }
      }
      const label = kind === 'purchasing' ? 'verified invoices' : 'approved claims';
      if (!rows.length) { toast(`No ${label} to export${range.from || range.to ? ' in this date range' : ' yet'}.`, 'info'); return 0; }
      const csv = [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url; a.download = `tutupbuku-${kind === 'purchasing' ? 'verified-invoices' : 'approved-claims'}${range.from ? '-from-' + range.from : ''}${range.to ? '-to-' + range.to : ''}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setState(s => ({ ...s, audit: [entry(kind, `Exported ${rows.length} ${label} to CSV`), ...s.audit] }));
      toast(`Exported ${rows.length} ${label}.`);
      return rows.length;
    },
  }), [state, storage, reload, toasts, dismissToast]);   // eslint-disable-line react-hooks/exhaustive-deps

  function autoVerifyNew(s: State): State { return autoVerify(s); }
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useData() {
  const value = useContext(Ctx);
  if (!value) throw new Error('DataProvider is required.');
  return value;
}
