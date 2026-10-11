import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useData } from '../state/store';
import { useExecution } from '../lib/execution';
import type { Claim, DocRecord, EvidenceRow, Issue, IssueStatus, Severity } from '../types';
import { claimDoc, docAmount, docDate, docNumber, docParty, field, fieldDisplay as fieldDisplay2, fieldInputValue, poIdOf } from '../lib/docs';
import { formatDate, formatMoney, formatTimestamp, humanStatus, parseAmountToSen } from '../lib/format';
import { Disclosure, Empty, Pill, Segmented, Severity as SeverityTag } from '../components/ui';
import { claimLabel } from './Documents';
import { RecordDialog } from '../components/RecordDialog';

type Tab = 'issues' | 'review';
type StatusFilter = 'ACTIVE' | 'ALL' | IssueStatus;
type Item = Issue & { live?: boolean };
const RANK: Record<Severity, number> = { HIGH: 0, WARNING: 1, INFO: 2 };
const isActive = (i: Issue) => i.status === 'OPEN' || i.status === 'UNDER_REVIEW';
const isPending = (c: Claim) => c.status === 'PLAUSIBLE' || c.status === 'NEEDS_REVIEW';

export function ActionItems() {
  const [params, setParams] = useSearchParams();
  const data = useData();
  const { run } = useExecution();
  const tab: Tab = params.get('tab') === 'review' || (params.get('claim') && !params.get('issue')) ? 'review' : 'issues';
  const set = (patch: Record<string, string | null>) => { const next = new URLSearchParams(params); Object.entries(patch).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k))); setParams(next); };
  const pendingCount = data.claims.filter(isPending).length;

  // The month-end run's findings are ordinary action items; the run id is kept only as provenance.
  const liveItems: Item[] = run ? [
    ...(run.input_issues || []).map((x): Item => ({ id: `RUN-${x.id}`, ruleCode: 'RUN_INPUT', typeLabel: 'Blocked input', title: x.message, severity: 'HIGH', status: 'OPEN', docIds: [], live: true,
      detected: x.message, why: `The run stopped on this input. Location: ${x.location}.`, suggested: [x.required_action], evidence: x.source_refs.map(r => ({ label: 'Source', found: r })), createdAt: run.started_at })),
    ...(run.matching?.exceptions || []).map((x): Item => ({ id: `RUN-${x.exception_id}`, ruleCode: 'RUN_EXCEPTION', typeLabel: 'Bank-row match', title: x.title, severity: 'WARNING', status: 'OPEN', docIds: [], live: true,
      detected: x.reason, why: `Reported by the month-end run for bank row ${x.bank_row_id} (priority ${x.priority}).`, suggested: [x.required_action], evidence: x.source_refs.map(r => ({ label: 'Source', found: r })), createdAt: run.started_at })),
  ] : [];
  const items: Item[] = [...data.issues, ...liveItems];
  const activeCount = items.filter(isActive).length;

  return <div className="page">
    <header className="page-head"><div><h1>Action Items</h1><p>Investigate what the checks found, and decide on claims that need a person.</p></div></header>
    <div className="subhead"><Segmented<Tab> label="Action item types" value={tab} onChange={v => setParams(v === 'review' ? { tab: 'review' } : {})}
      options={[{ value: 'issues', label: 'Issues', count: activeCount }, { value: 'review', label: 'Review', count: pendingCount }]} /></div>
    {tab === 'issues' ? <IssuesView items={items} params={params} set={set} /> : <ReviewView params={params} set={set} />}
  </div>;
}

/* =================================================================== Issues */

function IssuesView({ items, params, set }: { items: Item[]; params: URLSearchParams; set: (p: Record<string, string | null>) => void }) {
  const data = useData();
  const [severity, setSeverity] = useState<Severity | 'ALL'>('ALL');
  const [status, setStatus] = useState<StatusFilter>('ACTIVE');
  const [query, setQuery] = useState('');
  const selectedId = params.get('issue');
  const name = (id: string) => { const d = data.docs.find(x => x.id === id); return d ? docNumber(d) : id; };
  const q = query.trim().toLowerCase();
  const list = items.filter(i => (severity === 'ALL' || i.severity === severity) && (status === 'ALL' || (status === 'ACTIVE' ? isActive(i) : i.status === status))
    && (!q || `${i.title} ${i.typeLabel} ${i.id} ${i.docIds.map(name).join(' ')}`.toLowerCase().includes(q)))
    .sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || RANK[a.severity] - RANK[b.severity] || b.createdAt.localeCompare(a.createdAt));
  const active = items.filter(isActive);
  const count = (s: Severity) => active.filter(i => i.severity === s).length;
  const selected = selectedId ? items.find(i => i.id === selectedId) : undefined;
  return <div className={`split ${selected ? 'has-detail' : ''}`}>
    <div className="split-list">
      <div className="filters">
        <div className="sev-filter" role="group" aria-label="Severity">
          {(['ALL', 'HIGH', 'WARNING', 'INFO'] as const).map(s => <button key={s} type="button" className={severity === s ? 'on' : ''} aria-pressed={severity === s} onClick={() => setSeverity(s)}>{s === 'ALL' ? 'All' : `${s === 'HIGH' ? 'High' : s === 'WARNING' ? 'Warning' : 'Info'} · ${count(s)}`}</button>)}
        </div>
        <div className="search">
          <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search issues or records" aria-label="Search issues" />
          <select value={status} onChange={e => setStatus(e.target.value as StatusFilter)} aria-label="Status"><option value="ACTIVE">Active</option><option value="ALL">All</option><option value="OPEN">Open</option><option value="UNDER_REVIEW">Under review</option><option value="RESOLVED">Resolved</option><option value="DISMISSED">Dismissed</option></select>
        </div>
      </div>
      <section className="group">
        {list.map(i => <button key={i.id} type="button" className={`row issue-row lvl-${i.severity.toLowerCase()} ${i.id === selectedId ? 'on' : ''} ${isActive(i) ? '' : 'done'}`} aria-pressed={i.id === selectedId} onClick={() => set({ issue: i.id, tab: null, claim: null })}>
          <span className="row-main"><strong>{i.title}</strong></span>
          <span className="row-sub"><SeverityTag level={i.severity} />{i.docIds.length > 0 && <><span className="dotsep" aria-hidden="true">·</span>{i.docIds.slice(0, 2).map(name).join(' · ')}</>}</span>
          <Pill status={i.status} />
        </button>)}
        {!list.length && <Empty title={status === 'ACTIVE' ? 'Nothing needs attention' : 'No issues match'}>{status === 'ACTIVE' ? 'Closed issues stay available under the status filter.' : 'Adjust the filters.'}</Empty>}
      </section>
    </div>
    <div className="split-detail">
      {selected ? <><button type="button" className="back" onClick={() => set({ issue: null })}>← All issues</button><IssueDetail key={selected.id} issue={selected} /></>
        : <div className="split-empty"><Empty title="Select an issue">See the evidence and the decisions available for it.</Empty></div>}
    </div>
  </div>;
}

function evidenceFor(issue: Issue, docs: DocRecord[], links: import('../types').DocLink[]): EvidenceRow[] {
  if (issue.ruleCode !== 'PRICE_VARIANCE') return issue.evidence;
  const inv = docs.find(d => d.id === issue.docIds[0]); const po = inv && docs.find(d => d.id === poIdOf(inv, links));
  if (!inv || !po) return issue.evidence;
  return inv.lines.flatMap(l => { const p = po.lines.find(x => x.description === l.description);
    return p && p.unitSen !== null && l.unitSen !== null && p.unitSen !== l.unitSen ? [{ label: `${l.description} · unit price`, expected: `${formatMoney(p.unitSen)} (${docNumber(po)})`, found: `${formatMoney(l.unitSen)} (${docNumber(inv)})`, note: l.quantity === null ? 'Quantity unavailable; total variance cannot be calculated.' : `${l.quantity} × difference = ${formatMoney(Math.round(l.quantity * (l.unitSen - p.unitSen)))}` }] : []; });
}

function priceComparisonComplete(invoice: DocRecord, purchaseOrder: DocRecord) {
  return invoice.lines.length > 0 && invoice.lines.every(line => {
    const poLine = purchaseOrder.lines.find(item => item.description === line.description);
    return Boolean(poLine && poLine.unitSen !== null && line.unitSen !== null);
  });
}

function IssueDetail({ issue }: { issue: Item }) {
  const { docs, links, claims, audit, setIssueStatus, canReview } = useData();
  const history = audit.filter(a => a.entityId === issue.id);
  const records = issue.docIds.map(id => docs.find(d => d.id === id)).filter((d): d is DocRecord => Boolean(d));
  const claim = issue.claimId ? claims.find(c => c.id === issue.claimId) : undefined;
  const open = isActive(issue);
  const [viewing, setViewing] = useState<DocRecord | null>(null);
  const rows = evidenceFor(issue, docs, links);
  const priceInvoice = issue.ruleCode === 'PRICE_VARIANCE' ? records[0] : undefined;
  const pricePo = priceInvoice && docs.find(d => d.id === poIdOf(priceInvoice, links));
  const cleared = Boolean(open && rows.length === 0 && priceInvoice && pricePo && priceComparisonComplete(priceInvoice, pricePo));
  return <article className="detail" aria-label={`Issue ${issue.id}`}>
    <header className="detail-head"><div><span className="eyebrow"><SeverityTag level={issue.severity} /> · {issue.typeLabel} · {issue.id}</span><h2>{issue.title}</h2></div><Pill status={issue.status} /></header>
    <section className="block"><h3>What was detected</h3><p>{issue.detected}</p></section>
    {records.length > 0 && <section className="block"><h3>Affected records</h3><div className="chips">{records.map(d => <button key={d.id} type="button" className="chip" onClick={() => setViewing(d)} aria-haspopup="dialog" title="View this record">{docNumber(d)}<small>{d.flow === 'claims' ? 'view receipt' : d.docType.replace('_', ' ')}</small></button>)}</div></section>}
    {viewing && <RecordDialog doc={viewing} onClose={() => setViewing(null)} />}
    {cleared ? <p className="note-ok">The invoice prices now match the PO. You can resolve this issue.</p> : rows.length > 0 && <section className="block"><h3>Evidence</h3>
      <div className="table-wrap"><table className="table"><thead><tr><th>Check</th><th>Expected</th><th>Found</th></tr></thead><tbody>{rows.map(r => <tr key={r.label + (r.found ?? '')}><td>{r.label}</td><td>{r.expected ?? '—'}</td><td>{r.found ?? '—'}{r.note && <small>{r.note}</small>}</td></tr>)}</tbody></table></div></section>}
    <section className="block"><h3>Why it was flagged</h3><p>{issue.why}</p></section>
    {issue.suggested.length > 0 && <section className="block"><h3>Suggested next steps</h3><ol className="steps">{issue.suggested.map(s => <li key={s}>{s}</li>)}</ol></section>}
    {!open && issue.resolution && <p className="note-ok"><strong>{issue.status === 'RESOLVED' ? 'Resolved' : 'Dismissed'}:</strong> {issue.resolution}</p>}

    {issue.live ? <p className="note-warn">This finding comes from the month-end review run. It clears when the run is repeated with corrected inputs, or when the human question is answered in <Link to="/">Live Execution</Link>.</p>
      : open ? <>
        {canReview && issue.status === 'OPEN' && <div className="actions"><button type="button" className="btn" onClick={() => setIssueStatus(issue.id, 'UNDER_REVIEW')}>Start review</button></div>}
        <Resolution issue={issue} records={records} claim={claim} />
      </> : canReview && <div className="actions"><button type="button" className="btn" onClick={() => setIssueStatus(issue.id, 'OPEN')}>Reopen</button></div>}

    <Disclosure title="Audit history" meta={history.length}>
      {history.length ? <ul className="history">{history.map(h => <li key={h.id}><span className={`who who-${h.actorKind}`}>{h.actorKind === 'agent' ? 'AGENT' : 'HUMAN'}</span><span>{h.action}{h.previous && h.next ? ` (${h.previous} → ${h.next})` : ''}<small>{h.actor} · {formatTimestamp(h.timestamp)}</small></span></li>)}</ul> : <p className="muted">No history yet.</p>}
    </Disclosure>
  </article>;
}

/** Decisions depend on the type of issue; every one writes through the shared store and is audited. */
function Resolution({ issue, records, claim }: { issue: Issue; records: DocRecord[]; claim?: Claim }) {
  const { docs, links, setIssueStatus, confirmField, correctPrice, linkToPo, resolveDuplicate, canReview } = useData();
  const [note, setNote] = useState('');
  const [mode, setMode] = useState<'resolve' | 'dismiss' | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [value, setValue] = useState('');
  const [poChoice, setPoChoice] = useState('');
  const [keep, setKeep] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [msg, setMsg] = useState('');
  const doc = records[0];
  useEffect(() => { const f = doc && issue.fieldKey ? field(doc, issue.fieldKey) : undefined; if (f) setValue(fieldInputValue(f)); }, [doc?.id, issue.fieldKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!canReview) return <p className="note-warn">A reviewer or owner must record a decision on this item.</p>;

  const noteForm = (verb: 'resolve' | 'dismiss', label: string, placeholder: string) => <div className="close-form">
    <label htmlFor="close-note">{label}</label>
    <textarea id="close-note" className="textarea" rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder={placeholder} autoFocus />
    <div className="actions"><button type="button" className="btn btn-primary" disabled={!note.trim()} onClick={() => setIssueStatus(issue.id, verb === 'resolve' ? 'RESOLVED' : 'DISMISSED', note)}>{verb === 'resolve' ? 'Mark resolved' : 'Dismiss issue'}</button>
      <button type="button" className="btn" onClick={() => { setMode(null); setNote(''); }}>Cancel</button></div></div>;
  const dismissRow = (label = 'Dismiss…') => <button type="button" className="btn btn-ghost" onClick={() => { setMode('dismiss'); setNote(''); }}>{label}</button>;
  const close = mode === 'resolve' ? noteForm('resolve', 'How was it resolved?', 'This note is kept in the audit history.') : mode === 'dismiss' ? noteForm('dismiss', 'Why is this being dismissed?', 'This note is kept in the audit history.') : null;

  switch (issue.ruleCode) {
    case 'PRICE_VARIANCE': {
      const inv = docs.find(d => d.id === issue.docIds[0]); const po = inv && docs.find(d => d.id === poIdOf(inv, links));
      if (!inv || !po) break;
      const diff = inv.lines.filter(l => { const p = po.lines.find(x => x.description === l.description); return p && p.unitSen !== null && l.unitSen !== null && p.unitSen !== l.unitSen; });
      return <section className="block resolution"><h3>Decide</h3>
        {diff.length > 0 && <><p className="muted">If the invoice was read wrongly, correct the unit price. The backend queues a re-check against the PO; leave this issue open until the new result appears.</p>
          <div className="side-by-side">{diff.map(l => { const p = po.lines.find(x => x.description === l.description)!; return <div key={l.id} className="compare-card">
            <strong>{l.description}</strong><div className="cmp"><span>PO {docNumber(po)}</span><b>{formatMoney(p.unitSen!)}</b></div>
            <label className="field"><span>Invoice {docNumber(inv)} unit price (RM)</span><input inputMode="decimal" value={prices[l.id] ?? (l.unitSen! / 100).toFixed(2)} onChange={e => setPrices({ ...prices, [l.id]: e.target.value })} /></label></div>; })}</div>
          {msg && <p className="error-text" role="alert">{msg}</p>}
          <div className="actions"><button type="button" className="btn btn-primary" onClick={() => {
            const parsed: Record<string, number> = {};
            for (const l of diff) { const v = parseAmountToSen(prices[l.id] ?? (l.unitSen! / 100).toFixed(2)); if (v === null) return setMsg('Enter each price as an amount such as 100.00.'); parsed[l.id] = v; }
            setMsg(''); void correctPrice(issue.id, inv.id, parsed);
          }}>Save correction &amp; re-check</button>
            <button type="button" className="btn" onClick={() => { setMode('resolve'); setNote(''); }}>Accept the invoice price…</button>{dismissRow()}</div></>}
        {diff.length === 0 && priceComparisonComplete(inv, po) && <div className="actions"><button type="button" className="btn btn-primary" onClick={() => setIssueStatus(issue.id, 'RESOLVED', 'Prices match the PO after reviewer comparison.')}>Resolve</button></div>}
        {diff.length === 0 && !priceComparisonComplete(inv, po) && <p className="note-warn">Current line data cannot prove that the invoice prices match the PO. Check both original files and wait for a complete re-analysis before resolving this issue.</p>}
        {close}</section>;
    }
    case 'DUPLICATE_INVOICE': case 'DUPLICATE_FILE': {
      const [a, b] = records;
      if (!a || !b) break;
      const rowsOf: [string, (d: DocRecord) => string][] = [['Number', docNumber], ['Supplier / merchant', d => docParty(d) || '—'], ['Date', d => (docDate(d) ? formatDate(docDate(d)) : '—')], ['Amount', d => (docAmount(d) !== null ? formatMoney(docAmount(d)!) : '—')], ['File', d => d.filename], ['Checksum', d => d.hash], ['Uploaded', d => `${formatTimestamp(d.uploadedAt)} · ${d.uploadedBy}`], ['Status', d => d.status.replace('_', ' ').toLowerCase()]];
      return <section className="block resolution"><h3>Compare the two records</h3>
        <div className="table-wrap"><table className="table"><thead><tr><th /><th>Record A · {a.id}</th><th>Record B · {b.id}</th></tr></thead><tbody>{rowsOf.map(([label, fn]) => { const same = fn(a) === fn(b); return <tr key={label}><td>{label}</td><td className={same ? '' : 'diff'}>{fn(a)}</td><td className={same ? '' : 'diff'}>{fn(b)}</td></tr>; })}</tbody></table></div>
        {keep ? <div className="confirm-box"><p>Keep <strong>{keep === a.id ? 'A' : 'B'}</strong> and mark <strong>{keep === a.id ? 'B' : 'A'}</strong> as the duplicate? Nothing is deleted: the duplicate stays in Documents as rejected, with its file and audit history.</p>
          <label className="check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> I confirm this choice</label>
          <div className="actions"><button type="button" className="btn btn-primary" disabled={!confirmed} onClick={() => resolveDuplicate(issue.id, keep)}>Confirm</button><button type="button" className="btn" onClick={() => { setKeep(null); setConfirmed(false); }}>Back</button></div></div>
          : <div className="actions"><button type="button" className="btn" onClick={() => setKeep(a.id)}>Keep A, B is the duplicate</button><button type="button" className="btn" onClick={() => setKeep(b.id)}>Keep B, A is the duplicate</button>{dismissRow('Not a duplicate…')}</div>}
        {close}</section>;
    }
    case 'MISSING_PO': case 'AMBIGUOUS_PO_MATCH': {
      if (!doc) break;
      const all = docs.filter(d => d.docType === 'purchase_order' && d.status !== 'REJECTED');
      const options = issue.candidateIds?.length ? all.filter(p => issue.candidateIds!.includes(p.id)) : [...all].sort((x, y) => Number(docParty(y) === docParty(doc)) - Number(docParty(x) === docParty(doc)));
      return <section className="block resolution"><h3>Decide</h3>
        <label className="field"><span>{issue.ruleCode === 'AMBIGUOUS_PO_MATCH' ? 'Which PO does this belong to?' : 'Link to an existing purchase order'}</span>
          <select value={poChoice} onChange={e => setPoChoice(e.target.value)}><option value="">Choose a PO…</option>{options.map(p => <option key={p.id} value={p.id}>{docNumber(p)} · {docParty(p)} · {formatMoney(docAmount(p) ?? 0)}</option>)}</select></label>
        {options.length === 0 && <p className="muted">No purchase order has been uploaded yet.</p>}
        <div className="actions"><button type="button" className="btn btn-primary" disabled={!poChoice} onClick={() => linkToPo(issue.id, doc.id, poChoice)}>Link &amp; re-check</button>
          {issue.ruleCode === 'MISSING_PO' && <button type="button" className="btn" onClick={() => { setMode('resolve'); setNote(''); }}>Record as approved non-PO purchase…</button>}</div>
        {mode === 'resolve' && noteForm('resolve', 'Who approved this purchase without a PO?', 'Name of the approver and the reason. The invoice stays unmatched.')}
        <p className="muted">If no PO exists, the invoice stays unmatched; it is not rejected.</p></section>;
    }
    case 'EXTRACTION_UNCERTAIN': {
      const f = doc && issue.fieldKey ? field(doc, issue.fieldKey) : undefined;
      if (!doc || !f) break;
      return <section className="block resolution"><h3>Check against the source</h3>
        <label className="field"><span>{f.label}</span><input type={f.kind === 'date' ? 'date' : 'text'} value={value} onChange={e => setValue(e.target.value)} /></label>
        <div className="actions"><button type="button" className="btn btn-primary" disabled={!value.trim()} onClick={() => confirmField(issue.id, doc.id, f.key, value)}>{value.trim() === fieldInputValue(f) ? 'Confirm value' : 'Save correction'}</button>{dismissRow()}</div>{close}</section>;
    }
    case 'SERVICE_NO_DO':
      return <section className="block resolution"><h3>Decide</h3><div className="actions"><button type="button" className="btn btn-primary" onClick={() => setIssueStatus(issue.id, 'RESOLVED', 'Marked as a service purchase; two-way verification (PO and invoice) is acceptable under policy.')}>Mark as service purchase (two-way check)</button>{dismissRow()}</div>{close}</section>;
    case 'CLAIM_PURPOSE': case 'CLAIM_DATE_MISMATCH': case 'DUPLICATE_CLAIM':
      return <section className="block resolution"><h3>Decide</h3>
        <p className="muted">Whether to pay the claim is decided in Review. Acknowledge this finding once you have looked into it; it stays visible with the claim.</p>
        <div className="actions"><button type="button" className="btn btn-primary" onClick={() => { setMode('resolve'); setNote(''); }}>Acknowledge…</button>{claim && <Link className="btn" to={`/issues?tab=review&claim=${claim.id}`}>Open claim in Review →</Link>}{dismissRow()}</div>{close}</section>;
  }
  return <section className="block resolution"><h3>Decide</h3><div className="actions"><button type="button" className="btn btn-primary" onClick={() => { setMode('resolve'); setNote(''); }}>Resolve…</button>{dismissRow()}</div>{close}</section>;
}

/* =================================================================== Review */

function ReviewView({ params, set }: { params: URLSearchParams; set: (p: Record<string, string | null>) => void }) {
  const { claims, docs, canReview } = useData();
  const [filter, setFilter] = useState<'pending' | 'decided'>('pending');
  const selectedId = params.get('claim');
  const selected = selectedId ? claims.find(c => c.id === selectedId) : undefined;
  useEffect(() => { if (selected && !isPending(selected)) setFilter('decided'); }, [selected?.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const list = claims.filter(c => (filter === 'pending' ? isPending(c) : !isPending(c)));
  return <div className={`split ${selected ? 'has-detail' : ''}`}>
    {!canReview && <p className="note-warn">You can view your claim history. A reviewer or owner must make review decisions.</p>}
    <div className="split-list">
      <div className="sev-filter" role="group" aria-label="Claims">
        <button type="button" className={filter === 'pending' ? 'on' : ''} aria-pressed={filter === 'pending'} onClick={() => setFilter('pending')}>Awaiting decision · {claims.filter(isPending).length}</button>
        <button type="button" className={filter === 'decided' ? 'on' : ''} aria-pressed={filter === 'decided'} onClick={() => setFilter('decided')}>Decided · {claims.filter(c => !isPending(c)).length}</button>
      </div>
      <section className="group">{list.map(c => { const r = claimDoc(c, docs); return <button key={c.id} type="button" className={`row ${c.id === selectedId ? 'on' : ''}`} onClick={() => set({ claim: c.id, issue: null })} aria-pressed={c.id === selectedId}>
        <span className="row-main"><strong>{r && docParty(r) ? docParty(r) : c.id}</strong><span className="row-type">{c.employee}</span></span>
        <span className="row-sub">{r && docDate(r) ? formatDate(docDate(r)) : '—'}{r && docAmount(r) !== null && <><span className="dotsep" aria-hidden="true">·</span>{formatMoney(docAmount(r)!)}</>}</span>
        <span className="row-status">{claimLabel(c)}</span></button>; })}
        {!list.length && <Empty title={filter === 'pending' ? 'No claims are waiting' : 'No decisions yet'}>{filter === 'pending' ? 'Claims submitted in Live Execution appear here for approval.' : 'Approved and rejected claims appear here.'}</Empty>}</section>
    </div>
    <div className="split-detail">
      {selected ? <><button type="button" className="back" onClick={() => set({ claim: null })}>← All claims</button><ClaimReview key={selected.id} claim={selected} /></>
        : <div className="split-empty"><Empty title="Select a claim">Inspect the receipt and findings, then approve or reject.</Empty></div>}
    </div>
  </div>;
}

function ClaimReview({ claim }: { claim: Claim }) {
  const { docs, issues, audit, updateClaim, decideClaim, canReview, masterData } = useData();
  const receipt = claimDoc(claim, docs);
  const [description, setDescription] = useState(claim.standardizedDescription);
  const [rejecting, setRejecting] = useState(false);
  const [showReceipt, setShowReceipt] = useState(false);
  const [reason, setReason] = useState('');
  const pending = isPending(claim);
  const analysisReady = Boolean(receipt && ['completed', 'needs_review'].includes((receipt.rawStatus || '').toLowerCase()));
  const related = issues.filter(i => i.claimId === claim.id);
  const open = related.filter(isActive);
  const history = audit.filter(a => a.entityId === claim.id);
  const approveBlock = !analysisReady ? `Processing must finish before a decision. Current backend status: ${humanStatus(receipt?.rawStatus || 'unknown')}.` : open.length > 0 ? 'Approval is blocked while issues on this claim are open. Acknowledge or resolve them in Issues.' : !claim.categoryCode ? 'Choose an account before approving.' : '';
  return <article className="detail" aria-label={`Claim ${claim.id}`}>
    <header className="detail-head"><div><span className="eyebrow">Claim · {claim.employee} · {claim.id}</span><h2>{receipt && docParty(receipt) ? docParty(receipt) : claim.id}</h2></div><Pill status={claim.status === 'APPROVED' ? 'APPROVED' : claim.status === 'REJECTED' ? 'REJECTED' : 'OPEN'} label={claimLabel(claim)} /></header>
    {receipt && <dl className="facts">{[['Expense date', formatDate(docDate(receipt))], ['Amount', formatMoney(docAmount(receipt) ?? 0)], ['Receipt reference', docNumber(receipt)], ['Claimant', claim.employee]].map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
    <blockquote className="statement"><span>Employee’s stated purpose</span>{claim.employeePurpose || '(none given)'}</blockquote>
    <section className="block"><h3>What the checks found</h3><ul className="bullets">{claim.findings.map(f => <li key={f}>{f}</li>)}</ul>
      {open.length > 0 && <p className="note-warn">{open.length} open {open.length === 1 ? 'issue' : 'issues'}: {open.map(i => <Link key={i.id} to={`/issues?issue=${i.id}`}>{i.title}</Link>).reduce<React.ReactNode[]>((a, x, k) => (k ? [...a, ' · ', x] : [x]), [])}</p>}
      <p className="muted">These are suggestions. Approving does not confirm that the purpose is true.</p></section>
    <section className="block"><h3>Suggested account</h3>
      <div className="account"><select value={claim.categoryCode ?? ''} disabled={!canReview || !pending || !analysisReady} onChange={e => updateClaim(claim.id, { categoryCode: e.target.value || null })} aria-label="Account">
        <option value="">No account chosen</option>{masterData.chartOfAccounts.map(a => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}</select>
        {claim.categoryConfidence !== null && claim.categoryConfidence > 0 && <span className={`conf ${claim.categoryConfidence < 0.6 ? 'low' : ''}`}>{Math.round(claim.categoryConfidence * 100)}% sure</span>}</div>
      <p className="muted">{claim.categoryReasoning}</p></section>
    <section className="block"><h3>Standard description</h3>
      <textarea className="textarea" rows={3} value={description} disabled={!canReview || !pending || !analysisReady} onChange={e => setDescription(e.target.value)} aria-label="Standardized description" />
      {canReview && pending && analysisReady && description !== claim.standardizedDescription && <div className="actions"><button type="button" className="btn btn-sm btn-primary" onClick={() => updateClaim(claim.id, { standardizedDescription: description })}>Save description</button><button type="button" className="btn btn-sm" onClick={() => setDescription(claim.standardizedDescription)}>Undo</button></div>}</section>
    {receipt && <div className="actions"><button type="button" className="btn" onClick={() => setShowReceipt(true)} aria-haspopup="dialog">View receipt</button></div>}
    {showReceipt && receipt && <RecordDialog doc={receipt} onClose={() => setShowReceipt(false)} />}
    {receipt && <Disclosure title="Receipt" meta={receipt.filename}>
      <dl className="kv">{receipt.fields.map(f => <div key={f.key}><dt>{f.label}</dt><dd>{fieldDisplay2(f)}</dd></div>)}</dl>
      <div className="table-wrap"><table className="table"><thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Unit</th><th className="num">Total</th></tr></thead><tbody>{receipt.lines.map(l => <tr key={l.id}><td>{l.description}</td><td className="num">{l.quantity}</td><td className="num">{l.unitSen === null ? '—' : formatMoney(l.unitSen)}</td><td className="num">{l.totalSen === null ? '—' : formatMoney(l.totalSen)}</td></tr>)}</tbody></table></div></Disclosure>}

    {pending && canReview && !analysisReady && <p className="note-warn">{approveBlock}</p>}
    {pending && canReview && analysisReady ? (rejecting ? <div className="close-form"><label htmlFor="reject-reason">Reason for rejecting</label>
      <textarea id="reject-reason" className="textarea" rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="Recorded with your decision. The claim will not be exported." autoFocus />
      <div className="actions"><button type="button" className="btn btn-danger" disabled={!reason.trim()} onClick={() => decideClaim(claim.id, 'REJECTED', reason)}>Reject claim</button><button type="button" className="btn" onClick={() => setRejecting(false)}>Cancel</button></div></div>
      : <><div className="actions"><button type="button" className="btn btn-primary" disabled={Boolean(approveBlock)} onClick={() => decideClaim(claim.id, 'APPROVED')}>Approve</button><button type="button" className="btn btn-danger" onClick={() => setRejecting(true)}>Reject…</button></div>{approveBlock && <p className="hint">{approveBlock}</p>}</>)
      : claim.decision && <p className={claim.status === 'APPROVED' ? 'note-ok' : 'note-warn'}><strong>{claimLabel(claim)}</strong> {formatTimestamp(claim.decision.at)} by {claim.decision.by}{claim.decision.reason ? ` — ${claim.decision.reason}` : ''}</p>}
    {history.length > 0 && <Disclosure title="Audit history" meta={history.length}><ul className="history">{history.map(h => <li key={h.id}><span className={`who who-${h.actorKind}`}>{h.actorKind === 'agent' ? 'AGENT' : 'HUMAN'}</span><span>{h.action}{h.previous && h.next ? ` (${h.previous} → ${h.next})` : ''}<small>{h.actor} · {formatTimestamp(h.timestamp)}</small></span></li>)}</ul></Disclosure>}
  </article>;
}
