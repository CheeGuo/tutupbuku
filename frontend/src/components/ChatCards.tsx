import React from 'react';
import { Link } from 'react-router-dom';
import type { Card, Msg } from '../lib/agent';

function CardView({ card }: { card: Card }) {
  return <section className="card-msg saved">
    <h3>Upload result</h3>
    <ul className="bullets">{card.lines.map(line => <li key={line}>{line}</li>)}</ul>
    <div className="actions"><Link className="btn btn-sm" to="/documents">View Documents</Link><Link className="btn btn-sm" to="/issues">Open Action Items</Link></div>
  </section>;
}

export function ChatMessage({ msg, onChoose }: { msg: Msg; onChoose: (msgId: string, optionId: string) => void }) {
  if (msg.kind === 'user') return <div className="msg msg-user"><div className="bubble">{msg.text && <p>{msg.text}</p>}{msg.files.map((file, index) => <span className="attach-chip" key={`${file}-${index}`}>📎 {file}</span>)}</div></div>;
  if (msg.kind === 'agent') return <div className="msg msg-agent"><span className="avatar" aria-hidden="true" /><div className="bubble"><p>{msg.text}</p>
    {msg.to && <Link to={msg.to}>{msg.action || 'Open'} →</Link>}
    {msg.hash && <a href={`#${msg.hash}`} onClick={event => { event.preventDefault(); document.getElementById(msg.hash!)?.scrollIntoView({ block: 'center' }); }}>{msg.action || 'Inspect'} →</a>}</div></div>;
  if (msg.kind === 'quick') return <div className="msg msg-agent"><span className="avatar" aria-hidden="true" /><div className="bubble"><p>What are you sending?</p>
    <div className="hero-actions left">{msg.options.map(option => <button key={option.id} type="button" className="chip" disabled={msg.used} onClick={() => onChoose(msg.id, option.id)}>{option.label}</button>)}</div></div></div>;
  if (msg.kind === 'steps') return <div className="msg msg-agent"><span className="avatar" aria-hidden="true" /><ol className="steps-card" aria-live="polite">{msg.steps.map(step => <li key={step.label} className={step.state}><span className="step-mark">{step.state === 'done' ? '✓' : step.state === 'failed' ? '!' : ''}</span>{step.label}</li>)}</ol></div>;
  return <div className="msg msg-agent"><span className="avatar" aria-hidden="true" /><div className="bubble wide"><CardView card={msg.card} /></div></div>;
}
