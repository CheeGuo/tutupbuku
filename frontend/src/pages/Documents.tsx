import React, { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useData } from '../state/store';
import type { Claim, DocRecord, DocType } from '../types';
import { CHART_OF_ACCOUNTS } from '../data/dummy';
import { TYPE_CONFIG, chainOf, claimDoc, docAmount, docDate, docNumber, docParty, fieldDisplay, linkOf, poIdOf } from '../lib/docs';
import { decimalFromSen, formatDate, formatMoney, formatTimestamp, humanStatus } from '../lib/format';
import { Disclosure, Empty, Segmented } from '../components/ui';

type Tab = 'purchasing' | 'claims';
const CATEGORIES: DocType[] = ['quotation', 'purchase_order', 'delivery_order', 'invoice', 'payment_advice', 'payment_receipt'];
export const claimLabel = (c: Claim) => (c.status === 'APPROVED' ? 'Approved' : c.status === 'REJECTED' ? 'Rejected' : 'Pending');
const claimKey = (c: Claim) => claimLabel(c).toUpperCase();

const DownloadIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true" className="dl-icon"><path d="M12 3v12" /><path d="M7 11l5 5 5-5" /><path d="M5 20h14" /></svg>;

const Facts = ({ items }: { items: [string, React.ReactNode][] }) =>
  <dl className="facts">{items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;

export function Documents() {
  const [params, setParams] = useSearchParams();
  const data = useData();
  const tab: Tab = params.get('tab') === 'claims' ? 'claims' : 'purchasing';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const category = params.get('category') ?? '';
  const q = params.get('q') ?? '';
  const selected = params.get(tab === 'claims' ? 'claim' : 'doc');
  const set = (patch: Record<string, string | null>) => { const next = new URLSearchParams(params); Object.entries(patch).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k))); setParams(next); };
  const setQuery = (value: string) => { const next = new URLSearchParams(params); if (value) next.set('q', value); else next.delete('q'); setParams(next, { replace: true }); };   // typing must not fill the back-button history
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) => terms.every(t => text.includes(t));
  const inRange = (date: string) => (!from || (!!date && date >= from)) && (!to || (!!date && date <= to));
  const rangeError = from && to && from > to ? 'Date from must be on or before Date to.' : '';
  const range = rangeError ? { from: '', to: '' } : { from, to };

  const purchasing = data.docs.filter(d => d.flow === 'purchasing');
  // Each purchase order with everything linked to it, newest first. Filters apply to the linked records themselves.
  const groups = useMemo(() => purchasing.filter(d => d.docType === 'purchase_order').map(po => ({ po, chain: chainOf(po.id, purchasing, data.links) }))
    .sort((a, b) => docDate(b.po).localeCompare(docDate(a.po))), [data.docs, data.links]);   // eslint-disable-line react-hooks/exhaustive-deps
  const docText = (d: DocRecord) => [d.id, d.filename, TYPE_CONFIG[d.docType].label, d.status.replace('_', ' '), d.uploadedBy, ...d.fields.flatMap(f => [f.label, f.value, f.sen === undefined ? '' : `${decimalFromSen(f.sen)} ${formatMoney(f.sen)}`]), ...d.lines.map(l => l.description)].join(' ').toLowerCase();
  const passes = (d: DocRecord) => !rangeError && inRange(docDate(d)) && (!category || d.docType === category) && matches(docText(d));
  const shownGroups = groups.map(g => ({ ...g, children: g.chain.filter(d => d.id !== g.po.id && passes(d)), poPasses: passes(g.po) })).filter(g => g.poPasses || g.children.length);
  const loose = purchasing.filter(d => d.docType !== 'purchase_order' && poIdOf(d, data.links) === null && passes(d));
  const claimsShown = data.claims.filter(c => { const r = claimDoc(c, data.docs); return !rangeError && inRange(r ? docDate(r) : '') && (!category || c.categoryCode === category) && matches(`${c.id} ${c.employee} ${c.employeePurpose} ${c.standardizedDescription} ${c.categoryCode ?? ''} ${r ? docText(r) : ''}`.toLowerCase()); });
  const claimGroups = (['APPROVED', 'PENDING', 'REJECTED'] as const).map(k => ({ key: k, items: claimsShown.filter(c => claimKey(c) === k) }));

  const invoicesReady = purchasing.filter(d => d.docType === 'invoice' && d.status === 'VERIFIED' && inRange(docDate(d)) && !rangeError).length;
  const claimsReady = data.claims.filter(c => { const r = claimDoc(c, data.docs); return c.status === 'APPROVED' && r && inRange(docDate(r)) && !rangeError; }).length;

  // Open the first record by default so the right-hand side is never an empty void on desktop.
  const explicit = tab === 'claims' ? data.claims.find(c => c.id === selected) : purchasing.find(d => d.id === selected);
  const effective = explicit ? selected : tab === 'purchasing' ? shownGroups[0]?.po.id ?? loose[0]?.id ?? null : claimGroups.flatMap(g => g.items)[0]?.id ?? null;
  const selectedPo = tab === 'purchasing' && effective ? groups.find(g => g.po.id === effective) : undefined;
  const selectedDoc = tab === 'purchasing' && effective && !selectedPo ? purchasing.find(d => d.id === effective) : undefined;
  const selectedClaim = tab === 'claims' && effective ? data.claims.find(c => c.id === effective) : undefined;
  const hasDetail = Boolean(explicit);
  const key = tab === 'claims' ? 'claim' : 'doc';
  const rowOn = (id: string) => id === effective;

  return <div className="page">
    <header className="page-head docs-head">
      <div><h1>Documents</h1><p>Saved records and how they connect. To change a record, use Action Items.</p>
        <p className="storage-note" role="status" title={data.storage.message || ''}>
          <span className={`pill ${data.storage.ok ? (data.storage.mode === 'supabase' ? 'pill-mint' : 'pill-blue') : 'pill-red'}`}>
            {data.storage.mode === 'loading' ? 'Loading records…'
              : !data.storage.ok ? (data.storage.mode === 'offline' ? 'Not connected: changes stay in this browser' : 'Not saved')
              : data.storage.mode === 'supabase' ? 'Saved in Supabase' : 'Saved on the server (no database configured)'}
          </span>
          {!data.storage.ok && data.storage.message && <span className="muted"> {data.storage.message}</span>}
        </p></div>
      <div className="export-bar" role="group" aria-label="Download CSV">
        <button type="button" className="btn btn-primary" onClick={() => data.exportCsv('purchasing', range)} title="Verified invoices only, within the dates chosen below"><DownloadIcon />Verified invoices CSV<span className="btn-count">{invoicesReady}</span></button>
        <button type="button" className="btn btn-primary" onClick={() => data.exportCsv('claims', range)} title="Approved claims only, within the dates chosen below"><DownloadIcon />Approved claims CSV<span className="btn-count">{claimsReady}</span></button>
      </div>
    </header>

    <div className="filterbar" role="search" aria-label="Search and filters">
      <label className="field field-search"><span>Search</span><input type="search" value={q} onChange={e => setQuery(e.target.value)} placeholder={tab === 'claims' ? 'Employee, merchant, receipt no., purpose…' : 'Document no., supplier, item, amount, PO…'} aria-label="Search documents" /></label>
      <label className="field"><span>Date from</span><input type="date" value={from} max={to || undefined} onChange={e => set({ from: e.target.value || null })} /></label>
      <label className="field"><span>Date to</span><input type="date" value={to} min={from || undefined} onChange={e => set({ to: e.target.value || null })} /></label>
      <label className="field"><span>Category</span><select value={category} onChange={e => set({ category: e.target.value || null })}>
        <option value="">All categories</option>
        {tab === 'purchasing' ? CATEGORIES.map(c => <option key={c} value={c}>{TYPE_CONFIG[c].label}</option>) : CHART_OF_ACCOUNTS.map(a => <option key={a.code} value={a.code}>{a.name}</option>)}
      </select></label>
      {(from || to || category || q) && <button type="button" className="btn btn-ghost btn-sm" onClick={() => set({ from: null, to: null, category: null, q: null })}>Clear</button>}
      <p className="hint filter-note">Dates apply to each record’s own date and also set the range of the CSV downloads above.{rangeError && <span className="error-text" role="alert"> {rangeError}</span>}</p>
    </div>

    <div className="subhead"><Segmented<Tab> label="Record types" value={tab} onChange={v => setParams(v === 'claims' ? { tab: 'claims' } : {})}
      options={[{ value: 'purchasing', label: 'Purchasing', count: groups.length + loose.length }, { value: 'claims', label: 'Claims', count: data.claims.length }]} /></div>

    <div className={`split ${hasDetail ? 'has-detail' : ''}`}>
      <div className="split-list">
        {tab === 'purchasing' ? <>
          {shownGroups.map(({ po, children }) => <section key={po.id} className="po-group" aria-label={`${docNumber(po)} and related documents`}>
            <button type="button" className={`row po-row ${rowOn(po.id) ? 'on' : ''}`} onClick={() => set({ doc: po.id })} aria-pressed={rowOn(po.id)}>
              <span className="row-main"><strong>{docNumber(po)}</strong><span className="row-type">Purchase order</span></span>
              <span className="row-sub">{docParty(po)}<span className="dotsep" aria-hidden="true">·</span>{formatDate(docDate(po))}<span className="dotsep" aria-hidden="true">·</span>{formatMoney(docAmount(po) ?? 0)}</span>
            </button>
            {children.length > 0 && <ul className="po-children">{children.map(d => <li key={d.id}><button type="button" className={`row child-row ${rowOn(d.id) ? 'on' : ''} ${d.status === 'REJECTED' ? 'done' : ''}`} onClick={() => set({ doc: d.id })} aria-pressed={rowOn(d.id)}>
              <span className="row-main"><strong>{docNumber(d)}</strong><span className="row-type">{TYPE_CONFIG[d.docType].label}{d.status === 'REJECTED' ? ' · duplicate' : ''}</span></span>
              <span className="row-sub">{docDate(d) ? formatDate(docDate(d)) : '—'}{docAmount(d) !== null && <><span className="dotsep" aria-hidden="true">·</span>{formatMoney(docAmount(d)!)}</>}</span>
            </button></li>)}</ul>}
          </section>)}
          {loose.length > 0 && <section className="po-group group-loose" aria-label="Not linked to a PO"><h3><span>Not linked to a PO</span><small>{loose.length}</small></h3>
            <ul className="po-children flat">{loose.map(d => <li key={d.id}><button type="button" className={`row child-row ${rowOn(d.id) ? 'on' : ''}`} onClick={() => set({ doc: d.id })} aria-pressed={rowOn(d.id)}>
              <span className="row-main"><strong>{docNumber(d)}</strong><span className="row-type">{TYPE_CONFIG[d.docType].label}</span></span>
              <span className="row-sub">{docParty(d)}<span className="dotsep" aria-hidden="true">·</span>{docDate(d) ? formatDate(docDate(d)) : '—'}</span></button></li>)}</ul></section>}
          {!shownGroups.length && !loose.length && <Empty title={groups.length ? 'No records match' : 'No purchase orders yet'}>{groups.length ? 'Adjust the dates or category.' : 'Process a purchase order in Live Execution and it will appear here.'}</Empty>}
        </> : <>
          {claimGroups.map(g => <section key={g.key} className="group" aria-label={`${humanStatus(g.key)} claims`}>
            <h3><span>{g.key === 'APPROVED' ? 'Approved' : g.key === 'PENDING' ? 'Pending' : 'Rejected'}</span><small>{g.items.length}</small></h3>
            {g.items.map(c => { const r = claimDoc(c, data.docs); return <button key={c.id} type="button" className={`row ${rowOn(c.id) ? 'on' : ''}`} onClick={() => set({ claim: c.id })} aria-pressed={rowOn(c.id)}>
              <span className="row-main"><strong>{r && docParty(r) ? docParty(r) : c.id}</strong><span className="row-type">{c.employee}</span></span>
              <span className="row-sub">{r && docDate(r) ? formatDate(docDate(r)) : '—'}{r && docAmount(r) !== null && <><span className="dotsep" aria-hidden="true">·</span>{formatMoney(docAmount(r)!)}</>}</span>
              <span className="row-status">{claimLabel(c)}</span></button>; })}
            {!g.items.length && <p className="muted pad">None.</p>}
          </section>)}
        </>}
      </div>

      <div className="split-detail">
        {hasDetail && <button type="button" className="back" onClick={() => set({ [key]: null })}>← All records</button>}
        {selectedPo ? <PoDetail po={selectedPo.po} chain={selectedPo.chain} />
          : selectedDoc ? <DocBlock doc={selectedDoc} heading />
          : selectedClaim ? <ClaimDetail claim={selectedClaim} />
          : <div className="split-empty"><Empty title="Nothing to show">No records match the filters.</Empty></div>}
      </div>
    </div>
  </div>;
}

/* ---------- read-only record views ---------- */

function PoDetail({ po, chain }: { po: DocRecord; chain: DocRecord[] }) {
  const { issues, audit } = useData();
  const ids = chain.map(d => d.id);
  const open = issues.filter(i => (i.status === 'OPEN' || i.status === 'UNDER_REVIEW') && i.docIds.some(id => ids.includes(id)));
  const history = audit.filter(a => ids.includes(a.entityId));
  return <article className="detail" aria-label={`Purchase order ${docNumber(po)}`}>
    <header className="detail-head"><div><span className="eyebrow">Purchase order</span><h2>{docNumber(po)}</h2></div></header>
    <Facts items={[['Supplier', docParty(po)], ['Date', formatDate(docDate(po))], ['Total', formatMoney(docAmount(po) ?? 0)], ['Documents', `${chain.length} in chain`]]} />
    {open.length > 0 && <div className="alert"><span>{open.length} open {open.length === 1 ? 'item' : 'items'} on this purchase</span><Link to={`/issues?issue=${open[0].id}`}>Open in Action Items →</Link></div>}
    <section className="block"><h3>Purchasing chain</h3>
      <div className="chain-list">{chain.map(d => <DocBlock key={d.id} doc={d} />)}</div></section>
    {history.length > 0 && <Disclosure title="History" meta={history.length}><ul className="history">{history.slice(0, 20).map(h => <li key={h.id}><span className={`who who-${h.actorKind}`}>{h.actorKind === 'agent' ? 'AGENT' : 'HUMAN'}</span><span>{h.action}<small>{h.actor} · {formatTimestamp(h.timestamp)}</small></span></li>)}</ul></Disclosure>}
  </article>;
}

function DocBlock({ doc, heading }: { doc: DocRecord; heading?: boolean }) {
  const { links, docs } = useData();
  const link = linkOf(doc.id, links);
  const settles = links.find(l => l.sourceId === doc.id && l.relationship === 'settles_invoice');
  const settled = settles && docs.find(d => d.id === settles.targetId);
  const cfg = TYPE_CONFIG[doc.docType];
  const summary = <>
    <span className="chain-type">{cfg.label}</span><strong>{docNumber(doc)}</strong>
    <span className="chain-meta">{docDate(doc) ? formatDate(docDate(doc)) : '—'}{docAmount(doc) !== null && ` · ${formatMoney(docAmount(doc)!)}`}</span>
    </>;
  const body = <div className="doc-body">
    {doc.status === 'REJECTED' && <p className="muted">Marked as a duplicate. The record and its file are kept for the audit trail.</p>}
    {(link || settled) && <p className="muted">{link ? (link.confirmedBy ? `Linked to the PO (${Math.round(link.confidence * 100)}%, confirmed${link.confirmedBy.includes('(') || link.confirmedBy === 'You (finance reviewer)' ? ' by you' : ''}).` : `Link proposed at ${Math.round(link.confidence * 100)}%, not yet confirmed.`) : ''}{settled ? ` Settles ${docNumber(settled)}.` : ''}</p>}
    {doc.fields.length > 0 && <dl className="kv">{doc.fields.map(f => <div key={f.key}><dt>{f.label}</dt><dd>{fieldDisplay(f)}{f.confidence !== undefined && f.confidence < 0.7 && <span className="conf low">uncertain</span>}</dd></div>)}</dl>}
    {doc.lines.length > 0 && <div className="table-wrap"><table className="table"><thead><tr><th>Item</th><th className="num">Qty</th>{doc.docType !== 'delivery_order' && <><th className="num">Unit price</th><th className="num">Total</th></>}</tr></thead>
      <tbody>{doc.lines.map(l => <tr key={l.id}><td>{l.description}</td><td className="num">{l.quantity}</td>{doc.docType !== 'delivery_order' && <><td className="num">{l.unitSen === null ? '—' : formatMoney(l.unitSen)}</td><td className="num">{l.totalSen === null ? '—' : formatMoney(l.totalSen)}</td></>}</tr>)}</tbody></table></div>}
    <p className="muted">{doc.sourceUrl ? <a href={doc.sourceUrl} target="_blank" rel="noreferrer">{doc.filename} (open original PDF)</a> : doc.filename} · v{doc.version} · uploaded {formatTimestamp(doc.uploadedAt)} by {doc.uploadedBy} · checksum <code>{doc.hash}</code></p>
  </div>;
  if (heading) return <article className="detail"><header className="detail-head"><div><span className="eyebrow">{cfg.label}</span><h2>{docNumber(doc)}</h2></div></header>{!poIdOf(doc, links) && <p className="muted">Not linked to a purchase order. It is kept for review in Action Items.</p>}{body}</article>;
  return <details className={`chain-doc ${doc.status === 'REJECTED' ? 'rejected' : ''}`}><summary>{summary}</summary>{body}</details>;
}

function ClaimDetail({ claim }: { claim: Claim }) {
  const { docs, issues } = useData();
  const receipt = claimDoc(claim, docs);
  const related = issues.filter(i => i.claimId === claim.id && (i.status === 'OPEN' || i.status === 'UNDER_REVIEW'));
  const account = CHART_OF_ACCOUNTS.find(a => a.code === claim.categoryCode);
  return <article className="detail" aria-label={`Claim ${claim.id}`}>
    <header className="detail-head"><div><span className="eyebrow">Claim · {claim.employee} · {claim.id}</span><h2>{receipt ? docParty(receipt) : claim.id}</h2></div><span className="status-text">{claimLabel(claim)}</span></header>
    {receipt && <Facts items={[['Expense date', formatDate(docDate(receipt))], ['Amount', formatMoney(docAmount(receipt) ?? 0)], ['Receipt reference', docNumber(receipt)], ['Account', account ? `${account.code} · ${account.name}` : 'Not chosen']]} />}
    <blockquote className="statement"><span>Employee’s stated purpose</span>{claim.employeePurpose || '(none given)'}</blockquote>
    <section className="block"><h3>Standard description</h3><p>{claim.standardizedDescription || '—'}</p></section>
    {claim.status === 'REJECTED' && claim.decision && <p className="note-warn"><strong>Rejected</strong> {formatTimestamp(claim.decision.at)}{claim.decision.reason ? ` — ${claim.decision.reason}` : ''}</p>}
    {claim.status === 'APPROVED' && claim.decision && <p className="note-ok"><strong>Approved</strong> {formatTimestamp(claim.decision.at)} · included in the approved-claims export.</p>}
    {(claim.status === 'PLAUSIBLE' || claim.status === 'NEEDS_REVIEW') && <div className="alert"><span>Waiting for a decision{related.length ? ` · ${related.length} open ${related.length === 1 ? 'issue' : 'issues'}` : ''}</span><Link to={`/issues?tab=review&claim=${claim.id}`}>Open in Action Items →</Link></div>}
    {receipt && <Disclosure title="Receipt" meta={receipt.filename}><DocBlockBody doc={receipt} /></Disclosure>}
    <Disclosure title="What the agents found" meta={claim.findings.length}><ul className="bullets">{claim.findings.map(f => <li key={f}>{f}</li>)}</ul><p className="muted">{claim.categoryReasoning}</p></Disclosure>
  </article>;
}

function DocBlockBody({ doc }: { doc: DocRecord }) {
  return <div className="doc-body"><dl className="kv">{doc.fields.map(f => <div key={f.key}><dt>{f.label}</dt><dd>{fieldDisplay(f)}</dd></div>)}</dl>
    <div className="table-wrap"><table className="table"><thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Unit</th><th className="num">Total</th></tr></thead>
      <tbody>{doc.lines.map(l => <tr key={l.id}><td>{l.description}</td><td className="num">{l.quantity}</td><td className="num">{l.unitSen === null ? '—' : formatMoney(l.unitSen)}</td><td className="num">{l.totalSen === null ? '—' : formatMoney(l.totalSen)}</td></tr>)}</tbody></table></div></div>;
}
