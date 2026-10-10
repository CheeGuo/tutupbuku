import React from 'react';
import { Link } from 'react-router-dom';
import type { Card, Msg } from '../lib/agent';
import { formatMoney } from '../lib/format';
import { Disclosure, Severity } from './ui';

function CardView({ card }: { card: Card }) {
  switch (card.type) {
    case 'extract': return <section className="card-msg">
      <h3>{card.title}</h3>
      {card.sample && <p className="sample-note">Prepared sample extraction: no OCR is connected in this build, so these values are not read from your file. The checks that follow are computed from them.</p>}
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
      {card.items.length > 0 && <ul className="mini-list">{card.items.map(i => <li key={i.title}><Severity level={i.severity} /><span>{i.title}<small>{i.typeLabel}</small></span></li>)}</ul>}
      <p className="muted">{card.human ? 'Human review is required before this can be approved or exported.' : 'All automated checks passed.'}</p>
    </section>;
    case 'saved': return <section className="card-msg saved">
      <h3>Saved</h3>
      <ul className="bullets">{card.lines.map(l => <li key={l}>{l}</li>)}</ul>
      <div className="actions"><Link className="btn btn-sm" to="/documents">View in Documents</Link><Link className="btn btn-sm" to="/issues">Open Action Items</Link></div>
    </section>;
  }
}

export function ChatMessage({ msg, onChoose }: { msg: Msg; onChoose: (msgId: string, optionId: string) => void }) {
  if (msg.kind === 'user') return <div className="msg msg-user"><div className="bubble">{msg.text && <p>{msg.text}</p>}{msg.files.map(f => <span className="attach-chip" key={f}>📎 {f}</span>)}</div></div>;
  if (msg.kind === 'agent') return <div className="msg msg-agent"><span className="avatar" aria-hidden="true" /><div className="bubble"><p>{msg.text}</p>
    {msg.to && <Link to={msg.to}>{msg.action} →</Link>}
    {msg.hash && <a href={`#${msg.hash}`} onClick={e => { e.preventDefault(); document.getElementById(msg.hash!)?.scrollIntoView({ block: 'center' }); }}>{msg.action} →</a>}</div></div>;
  if (msg.kind === 'quick') return <div className="msg msg-agent"><span className="avatar" aria-hidden="true" /><div className="bubble"><p>What are you sending?</p>
    <div className="hero-actions left">{msg.options.map(o => <button key={o.id} type="button" className="chip" disabled={msg.used} onClick={() => onChoose(msg.id, o.id)}>{o.label}</button>)}</div></div></div>;
  if (msg.kind === 'steps') return <div className="msg msg-agent"><span className="avatar" aria-hidden="true" /><ol className="steps-card" aria-live="polite">{msg.steps.map(s => <li key={s.label} className={s.state}><span className="step-mark">{s.state === 'done' ? '✓' : s.state === 'failed' ? '!' : ''}</span>{s.label}</li>)}</ol></div>;
  return <div className="msg msg-agent"><span className="avatar" aria-hidden="true" /><div className="bubble wide"><CardView card={msg.card} /></div></div>;
}
