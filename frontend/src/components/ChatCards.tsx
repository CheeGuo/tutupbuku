import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Card, Msg } from '../lib/agent';
import { isActive } from '../lib/actionItems';
import { CHART_OF_ACCOUNTS } from '../data/dummy';
import { formatMoney } from '../lib/format';
import { Resolution } from '../pages/ActionItems';
import { useData } from '../state/store';
import type { DocRecord } from '../types';
import { Disclosure, Pill, Severity } from './ui';

type FindingItem = Extract<Card, { type: 'findings' }>['items'][number];

/** One finding in the chat, with the same decisions as in Action Items, working on the saved issue. */
function Finding({ item }: { item: FindingItem }) {
  const { issues, docs, claims, setIssueStatus } = useData();
  const [open, setOpen] = useState(false);
  const issue = item.id ? issues.find(i => i.id === item.id) : undefined;
  const records = issue ? issue.docIds.map(id => docs.find(d => d.id === id)).filter((d): d is DocRecord => Boolean(d)) : [];
  const claim = issue?.claimId ? claims.find(c => c.id === issue.claimId) : undefined;
  return <li className={`finding ${open ? 'open' : ''}`}>
    <div className="finding-head">
      <Severity level={item.severity} />
      <span className="finding-title">{item.title}<small>{item.typeLabel}{issue ? ` · ${issue.id}` : ''}</small></span>
      {issue ? <><Pill status={issue.status} /><button type="button" className="btn btn-sm" aria-expanded={open} onClick={() => setOpen(v => !v)}>{open ? 'Close' : isActive(issue) ? 'Decide' : 'Details'}</button></>
        : item.id && <span className="muted finding-wait" title="Saved only after you choose Fix now or Review later; Fix now clears a price issue.">Not in Action Items</span>}
    </div>
    {open && issue && <div className="finding-body">
      <p>{issue.detected}</p>
      {isActive(issue) ? <>
        {issue.status === 'OPEN' && <div className="actions"><button type="button" className="btn btn-sm" onClick={() => setIssueStatus(issue.id, 'UNDER_REVIEW')}>Start review</button></div>}
        <Resolution issue={issue} records={records} claim={claim} />
      </> : <>
        {issue.resolution && <p className="note-ok"><strong>{issue.status === 'RESOLVED' ? 'Resolved' : 'Dismissed'}:</strong> {issue.resolution}</p>}
        <div className="actions"><button type="button" className="btn btn-sm" onClick={() => setIssueStatus(issue.id, 'OPEN')}>Reopen</button></div>
      </>}
      <Link to={`/issues?issue=${issue.id}`}>Open in Action Items →</Link>
    </div>}
  </li>;
}

const REC: Record<string, [string, string]> = { approve: ['Approve', 'pill-mint'], needs_info: ['Needs more information', 'pill-peach'], reject: ['Reject', 'pill-red'] };
const AGREE: Record<string, [string, string]> = { unanimous: ['Unanimous', 'pill-mint'], majority: ['Majority', 'pill-blue'], split: ['Split decision', 'pill-peach'] };
const accountName = (code: string | null) => (code ? `${code} · ${CHART_OF_ACCOUNTS.find(a => a.code === code)?.name ?? 'unknown'}` : 'No account fits');

/** The claim council's three stages: independent opinions, anonymous peer ranking, and the chairman's recommendation. */
function CouncilCard({ purpose, result }: Extract<Card, { type: 'council' }>) {
  const rankOf = (name: string) => result.ranking.findIndex(r => r.member === name);
  const [agreeLabel, agreeTone] = AGREE[result.agreement] ?? AGREE.split;
  const [chairLabel, chairTone] = REC[result.chair.recommendation] ?? REC.needs_info;
  return <section className="card-msg council" aria-label="Claim council">
    <header className="council-head">
      <div><span className="doc-kicker">Claim council · 3 members</span><h3>How the council sees this claim</h3></div>
      <div className="doc-status"><span className={`pill ${agreeTone}`}><i className="status-dot" aria-hidden="true" />{agreeLabel}</span><small>{result.calls} AI calls · {Math.round(result.seconds)} s</small></div>
    </header>
    <blockquote className="statement"><span>Stated purpose</span>{purpose || '(none given)'}</blockquote>

    <div className="council-stage"><span className="stage-tag">1</span><strong>Independent opinions</strong></div>
    <div className="council-members">{result.opinions.map(o => {
      const [label, tone] = REC[o.recommendation] ?? REC.needs_info; const rank = rankOf(o.name); const r = result.ranking[rank];
      return <article key={o.member} className="council-member">
        <header><strong>{o.name}</strong>{r?.average_position != null && <span className="rank" title={`Average position ${r.average_position} from ${r.votes} anonymous reviews`}>#{rank + 1} in peer review</span>}</header>
        <span className={`pill ${tone}`}>{label}</span>
        <dl><div><dt>Account</dt><dd>{accountName(o.account_code)}</dd></div><div><dt>Confidence</dt><dd>{o.confidence}</dd></div></dl>
        <p>{o.reasoning}</p>
        {o.concerns.length > 0 && <ul className="bullets">{o.concerns.map(c => <li key={c}>{c}</li>)}</ul>}
      </article>; })}</div>

    <div className="council-stage"><span className="stage-tag">2</span><strong>Anonymous peer review</strong><span className="muted">each member ranked the opinions as Response A, B and C without knowing who wrote them; a member's vote on its own answer is not counted</span></div>
    {result.reviews.length ? <ol className="council-ranking">{result.ranking.map(r => <li key={r.response}><strong>{r.member}</strong><span className="muted">{r.response} · average position {r.average_position ?? '—'} ({r.votes} votes)</span></li>)}</ol>
      : <p className="muted">No peer review was available for this claim.</p>}
    {result.reviews.length > 0 && <Disclosure title="What each reviewer said" meta={result.reviews.length}>
      <ul className="bullets">{result.reviews.map(v => <li key={v.member}><strong>{v.name}:</strong> {v.ranking.join(' › ')}{v.ranked_own_first ? ' (put its own answer first)' : ''}{v.critique ? ` — ${v.critique}` : ''}</li>)}</ul></Disclosure>}

    <div className="council-stage"><span className="stage-tag">3</span><strong>{result.chair.source === 'computed' ? 'Combined recommendation' : "Chairman's recommendation"}</strong>
      {result.chair.source === 'computed' && <span className="muted">the chairman could not answer, so this is the members' majority vote, combined by TutupBuku</span>}</div>
    <div className="council-chair">
      <div className="chair-line"><span className={`pill ${chairTone}`}>{chairLabel}</span><span><strong>{accountName(result.chair.account_code)}</strong> · {result.chair.confidence} confidence</span></div>
      <p>{result.chair.reasoning}</p>
      {result.chair.question_for_reviewer && <p className="note-warn"><strong>Check:</strong> {result.chair.question_for_reviewer}</p>}
      {result.chair.standard_description && <div className="statement plain"><span>Standard description</span>{result.chair.standard_description}</div>}
    </div>
    {result.notes.length > 0 && <ul className="doc-warnings" role="note">{result.notes.map(n => <li key={n}>{n}</li>)}</ul>}
    <p className="muted">The council advises only. You approve or reject the claim below.</p>
  </section>;
}

const STATUS: Record<string, [string, string]> = {
  UPLOADED: ['Uploaded', ''], EXTRACTED: ['Extracted', 'pill-blue'], MATCHED: ['Matched to PO', 'pill-blue'], NEEDS_REVIEW: ['Needs review', 'pill-peach'],
  VERIFIED: ['Verified', 'pill-mint'], REJECTED: ['Rejected', 'pill-red'], HELD: ['Awaiting your decision', 'pill-peach'], PENDING: ['Pending approval', 'pill-lime'],
};

/** A document read from an uploaded file: identity and live status, key facts, line items and totals, then its source. */
function DocCard({ card }: { card: Extract<Card, { type: 'extract' }> }) {
  const [label, tone] = STATUS[card.status ?? 'EXTRACTED'] ?? STATUS.EXTRACTED;
  const priced = card.lines.some(l => l.unit !== '—' || l.total !== '—');
  return <section className="card-msg doc-card" aria-label={`${card.docLabel} ${card.number}`}>
    <header className="doc-card-head">
      <span className="doc-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z" /><path d="M15 3v4h4M9 12h6M9 16h6" /></svg></span>
      <div className="doc-id"><span className="doc-kicker">{card.docLabel}</span><strong className="doc-no">{card.number}</strong>{card.party && <span className="doc-party">{card.party}</span>}</div>
      <div className="doc-status" role="status" aria-live="polite"><span className={`pill ${tone}`}><i className="status-dot" aria-hidden="true" />{label}</span>{card.statusNote && <small>{card.statusNote}</small>}</div>
    </header>
    {card.fields.length > 0 && <dl className="doc-facts">{card.fields.map(f => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}{f.low && <span className="conf low">check</span>}</dd></div>)}</dl>}
    {card.lines.length > 0 && <div className="table-wrap"><table className="table doc-lines"><thead><tr><th>Description</th><th className="num">Qty</th>{priced && <><th className="num">Unit price</th><th className="num">Amount</th></>}</tr></thead>
      <tbody>{card.lines.map(l => <tr key={l.item}><td>{l.item}</td><td className="num">{l.qty}</td>{priced && <><td className="num">{l.unit}</td><td className="num">{l.total}</td></>}</tr>)}</tbody></table></div>}
    {(card.amounts?.length ?? 0) > 0 && <dl className="doc-totals">{card.amounts!.map(a => <div key={a.label} className={a.total ? 'grand' : ''}><dt>{a.label}</dt><dd>{a.value}{a.low && <span className="conf low">check</span>}</dd></div>)}</dl>}
    {(card.warnings?.length ?? 0) > 0 && <ul className="doc-warnings" role="note">{card.warnings!.map(w => <li key={w}>{w}</li>)}</ul>}
    <footer className="doc-source"><span className="doc-file">{card.file}</span><span>{card.sample ? 'Prepared sample values · the file could not be read' : card.source === 'ocr' ? 'Read with OCR from the image · values marked “check” need a look' : 'Read from the PDF text'}</span>{card.pdf && <a href={card.pdf} target="_blank" rel="noreferrer">Open PDF ↗</a>}</footer>
  </section>;
}

function CardView({ card }: { card: Card }) {
  switch (card.type) {
    case 'extract': return card.number ? <DocCard card={card} /> : <section className="card-msg">
      <h3>{card.title}</h3>
      <dl className="kv">{card.fields.map(f => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}{f.low && <span className="conf low">uncertain</span>}</dd></div>)}</dl>
      {card.lines.length > 0 && <Disclosure title="Line items" meta={card.lines.length}>
        <div className="table-wrap"><table className="table"><thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Unit</th><th className="num">Total</th></tr></thead>
          <tbody>{card.lines.map(l => <tr key={l.item}><td>{l.item}</td><td className="num">{l.qty}</td><td className="num">{l.unit}</td><td className="num">{l.total}</td></tr>)}</tbody></table></div>
      </Disclosure>}
    </section>;
    case 'links': return <section className="card-msg">
      <h3>{card.title}</h3><p className="muted">{card.basis}</p>
      <ul className="chain-mini">{card.chain.map(c => <li key={c.no} className={c.here ? 'here' : ''}><span>{c.label}</span><strong>{c.no}</strong>{c.here && <em>this upload</em>}</li>)}</ul>
    </section>;
    case 'compare': return <section className="card-msg">
      <h3>Comparison with {card.po}</h3>
      <div className="table-wrap"><table className="table"><thead><tr><th>Item</th><th className="num">PO qty</th><th className="num">Invoice qty</th><th className="num">Delivered</th><th className="num">PO price</th><th className="num">Invoice price</th></tr></thead>
        <tbody>{card.rows.map(r => <tr key={r.item}><td>{r.item}{r.flags.length > 0 && <small className="flag">{r.flags.join(' · ')}</small>}</td>
          <td className="num">{r.poQty ?? '—'}</td><td className={`num ${r.flags.includes('More than ordered') || r.flags.includes('More than delivered') ? 'diff' : ''}`}>{r.invQty}</td><td className="num">{r.delivered ?? 'no DO'}</td>
          <td className="num">{r.poUnit === null ? '—' : formatMoney(r.poUnit)}</td><td className={`num ${r.flags.includes('Price differs') ? 'diff' : ''}`}>{r.invUnit === null ? '—' : formatMoney(r.invUnit)}</td></tr>)}</tbody></table></div>
    </section>;
    case 'claim': return <section className="card-msg">
      <h3>Does the receipt support the purpose?</h3>
      <blockquote className="statement"><span>Your stated purpose</span>{card.purpose || '(none given)'}</blockquote>
      <p className={`verdict ${card.plausibility === 'PLAUSIBLE' ? 'ok' : 'warn'}`}>{card.plausibility === 'PLAUSIBLE' ? 'Plausible' : 'Needs review'}</p>
      <ul className="bullets">{card.findings.map(f => <li key={f}>{f}</li>)}</ul>
      <dl className="kv"><div><dt>Suggested account</dt><dd>{card.category}{card.confidence > 0 && <span className={`conf ${card.confidence < 0.6 ? 'low' : ''}`}>{Math.round(card.confidence * 100)}%</span>}</dd></div></dl>
      <p className="muted">{card.reasoning}</p>
      <div className="statement plain"><span>Standard description</span>{card.description}</div>
    </section>;
    case 'findings': return <section className="card-msg">
      <h3>{card.items.length ? `${card.items.length} ${card.items.length === 1 ? 'thing needs' : 'things need'} attention` : 'No issues found'}</h3>
      {card.items.length > 0 && <ul className="finding-list">{card.items.map(i => <Finding key={i.id ?? i.title} item={i} />)}</ul>}
      <p className="muted">{card.human ? 'Human review is required before this can be approved or exported. Decide here, or later in Action Items.' : 'All automated checks passed.'}</p>
    </section>;
    case 'council': return <CouncilCard {...card} />;
    case 'saved': return <section className="card-msg saved">
      <h3>Saved</h3>
      <ul className="bullets">{card.lines.map(l => <li key={l}>{l}</li>)}</ul>
      <div className="actions"><Link className="btn btn-sm" to="/documents">View in Documents</Link>{!card.hideActionItems && <Link className="btn btn-sm" to="/issues">Open Action Items</Link>}</div>
    </section>;
    case 'lookup': return <section className="card-msg">
      <h3>{card.poNo}</h3>
      <dl className="kv"><div><dt>Supplier</dt><dd>{card.supplier || '—'}</dd></div><div><dt>Date</dt><dd>{card.date}</dd></div><div><dt>Total</dt><dd>{card.total}</dd></div><div><dt>Documents in chain</dt><dd>{card.chain.length}</dd></div></dl>
      <div className="table-wrap"><table className="table"><thead><tr><th>Document</th><th>Date</th><th className="num">Amount</th><th>Status</th></tr></thead>
        <tbody>{card.chain.map(c => <tr key={c.id}><td>{c.label}<small>{c.pdf ? <a href={c.pdf} target="_blank" rel="noreferrer">{c.no}</a> : c.no}{c.hit ? ' · matched your search' : ''}</small></td><td>{c.date}</td><td className="num">{c.amount}</td><td>{c.status}</td></tr>)}</tbody></table></div>
      {card.issues.length > 0 ? <><p className="muted">Open issues on this chain:</p><ul className="mini-list">{card.issues.map(i => <li key={i.title}><Severity level={i.severity} /><span>{i.title}<small>{i.status.replace('_', ' ').toLowerCase()}</small></span></li>)}</ul></> : <p className="muted">No open issues on this chain.</p>}
      <div className="actions"><Link className="btn btn-sm" to={`/documents?doc=${card.poId}`}>Open in Documents</Link>{card.issues.length > 0 && <Link className="btn btn-sm" to="/issues">Open Action Items</Link>}</div>
    </section>;
    case 'alert': return <section className="card-msg alert" role="alert">
      <h3>{card.title}</h3>
      <ul className="bullets">{card.lines.map(l => <li key={l}>{l}</li>)}</ul>
    </section>;
    case 'fix': return <section className="card-msg saved">
      <h3>{card.title}</h3>
      {card.rows.length > 0 && <div className="table-wrap"><table className="table"><thead><tr><th>Item</th><th className="num">Was</th><th className="num">Now</th></tr></thead>
        <tbody>{card.rows.map(r => <tr key={r.item}><td>{r.item}</td><td className="num">{r.from}</td><td className="num">{r.to}</td></tr>)}</tbody></table></div>}
      <ul className="bullets">{card.lines.map(l => <li key={l}>{l}</li>)}</ul>
    </section>;
  }
}

export function ChatMessage({ msg, onChoose }: { msg: Msg; onChoose: (msgId: string, optionId: string) => void }) {
  if (msg.kind === 'user') return <div className="msg msg-user"><div className="bubble">{msg.text && <p>{msg.text}</p>}{msg.files.map(f => <span className="attach-chip" key={f}>📎 {f}</span>)}</div></div>;
  if (msg.kind === 'agent') return <div className="msg msg-agent"><span className="avatar" aria-hidden="true" /><div className="bubble"><p>{msg.text}</p>
    {msg.to && <Link to={msg.to}>{msg.action} →</Link>}
    {msg.hash && <a href={`#${msg.hash}`} onClick={e => { e.preventDefault(); document.getElementById(msg.hash!)?.scrollIntoView({ block: 'center' }); }}>{msg.action} →</a>}</div></div>;
  if (msg.kind === 'quick') return <div className="msg msg-agent"><span className="avatar" aria-hidden="true" /><div className="bubble"><p>{msg.prompt ?? 'What are you sending?'}</p>
    <div className="hero-actions left">{msg.options.map(o => <button key={o.id} type="button" className="chip" disabled={msg.used} onClick={() => onChoose(msg.id, o.id)}>{o.label}</button>)}</div></div></div>;
  if (msg.kind === 'steps') return <div className="msg msg-agent"><span className="avatar" aria-hidden="true" /><ol className="steps-card" aria-live="polite">{msg.steps.map(s => <li key={s.label} className={s.state}><span className="step-mark">{s.state === 'done' ? '✓' : s.state === 'running' ? '' : ''}</span>{s.label}</li>)}</ol></div>;
  return <div className="msg msg-agent"><span className="avatar" aria-hidden="true" /><div className="bubble wide"><CardView card={msg.card} /></div></div>;
}
