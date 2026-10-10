import React from 'react';
import { Link } from 'react-router-dom';
import { sourceUrl, useExecution } from '../lib/execution';
import { formatDate, formatMoney } from '../lib/format';

export function SourceReferences({ refs, caseId }: { refs: string[]; caseId: string }) {
  return <div className="refs"><strong>Supporting evidence</strong>{refs.length
    ? <ul>{refs.map((ref, index) => <li key={`${ref}:${index}`}><a href={sourceUrl(caseId, ref)} target="_blank" rel="noreferrer">{ref}</a>{ref.includes('#row=') && <small> · record {ref.split('#row=')[1]}, opens the full source file</small>}</li>)}</ul>
    : <p className="muted">No specific source reference supplied; inspect the exact error and input manifest.</p>}</div>;
}

/** The human gate of the real run: the user picks a displayed candidate or "neither" and gives evidence. */
export function HumanCheckpoint() {
  const { run, pending, choice, answer, setChoice, setAnswer, resume } = useExecution();
  const question = run?.question;
  if (!question || run?.status !== 'waiting_for_input') return null;
  return <section id="human-checkpoint" className="checkpoint" aria-labelledby="question-title">
    <div className="checkpoint-head"><h2 id="question-title">One decision needs you</h2><span className="pill pill-peach">Human review</span></div>
    <p className="checkpoint-row"><strong>Bank row {question.row_id}</strong> · {formatDate(question.date)} · {formatMoney(question.amount_sen)}<br />{question.description}</p>
    <p>{question.reason} Which document is supported by the remittance advice?</p>
    <fieldset disabled={pending}><legend>Choose a displayed candidate, or neither</legend>
      {question.candidates.map(item => <label className={`choice ${choice === item.id ? 'chosen' : ''}`} key={item.id}>
        <input type="radio" name="candidate" value={item.id} checked={choice === item.id} onChange={() => setChoice(item.id)} />
        <span><strong>{item.id} · {item.name}</strong><span className="muted">{formatDate(item.date)} · {formatMoney(item.amount_sen)}</span>
          <a href={sourceUrl(run.case_id, item.source_path)} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>Inspect source: {item.source_path}</a></span>
      </label>)}
      <label className={`choice ${choice === 'neither' ? 'chosen' : ''}`}><input type="radio" name="candidate" checked={choice === 'neither'} onChange={() => setChoice('neither')} /><span>Neither — record my explanation and leave the item open</span></label>
    </fieldset>
    <label htmlFor="execution-answer" className="label">What evidence supports your answer?</label>
    <textarea id="execution-answer" className="textarea" rows={3} value={answer} onChange={e => setAnswer(e.target.value)} maxLength={1000} disabled={pending} placeholder="State what the remittance advice or source document says. Do not guess." />
    <div className="actions">
      <button className="btn btn-primary" disabled={pending || !choice || !answer.trim()} onClick={() => resume(false)}>Save answer &amp; finish the pack</button>
      <button className="btn" disabled={pending} onClick={() => resume(true)}>Export with this question unresolved</button>
    </div>
  </section>;
}

/** Issues reported by the live (backend) run, unchanged in content, shown compactly. */
export function RunIssues({ search = '', filter = 'all' }: { search?: string; filter?: 'all' | 'input' | 'review' }) {
  const { run } = useExecution();
  if (!run) return <div className="empty"><strong>No live run yet</strong><p><Link to="/">Start a review</Link> to see issues from the supplied evidence.</p></div>;
  const query = search.trim().toLowerCase();
  const input = (run.input_issues || []).filter(item => `${item.id} ${item.message} ${item.location}`.toLowerCase().includes(query));
  const issues = (run.matching?.exceptions || []).filter(item => `${item.exception_id} ${item.title} ${item.reason} ${item.bank_row_id}`.toLowerCase().includes(query));
  const count = (filter !== 'review' ? input.length : 0) + (filter !== 'input' ? issues.length : 0);
  return <div className="run-issues">
    {filter !== 'review' && input.map(item => <article className="run-issue" key={item.id}>
      <div className="run-issue-head"><h3>{item.message}</h3><span className="pill pill-red">Input blocked</span></div>
      <p className="muted mono">{item.id} · {item.location}</p>
      <p className="next"><strong>Next action</strong> {item.required_action}</p>
      <SourceReferences refs={item.source_refs} caseId={run.case_id} />
    </article>)}
    {filter !== 'input' && issues.map(item => {
      const row = run.matching!.bank_rows.find(bank => bank.row_id === item.bank_row_id);
      return <article className="run-issue" key={item.exception_id}>
        <div className="run-issue-head"><h3>{item.title}</h3><span className="pill pill-peach">Priority {item.priority}</span></div>
        <p className="muted mono">{item.exception_id} · {item.status.replace(/_/g, ' ')}</p>
        {row && <p><strong>Bank row {row.row_id}</strong> · {formatDate(row.date)} · {formatMoney(row.amount_sen)}<br />{row.description}</p>}
        <p>{item.reason}</p>
        <p className="next"><strong>Next action</strong> {item.required_action}</p>
        {item.candidate_ids.length > 0 && <p className="muted">Candidates: {item.candidate_ids.join(', ')}</p>}
        <SourceReferences refs={item.source_refs} caseId={run.case_id} />
        {run.status === 'waiting_for_input' && row?.row_id === run.question?.row_id && <Link className="btn btn-sm" to="/">Answer this checkpoint</Link>}
      </article>;
    })}
    {!count && <div className="empty"><strong>{query ? 'No issues match' : 'No open items from the supported checks'}</strong><p>{query ? 'Try a different search.' : run.matching ? 'This does not prove every transaction was supplied.' : 'Issues appear when validation and matching report their findings.'}</p></div>}
  </div>;
}
