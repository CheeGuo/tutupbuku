import React, { useState } from 'react';
import type { DocRecord } from '../types';
import { TYPE_CONFIG, docAmount, docDate, docNumber, docParty, fieldDisplay } from '../lib/docs';
import { formatDate, formatMoney, formatTimestamp } from '../lib/format';
import { Dialog } from './ui';
import { useData } from '../state/store';

/** Read-only pop-up of a saved record, so a reviewer can check a receipt or document without leaving Action Items. */
export function RecordDialog({ doc, onClose }: { doc: DocRecord; onClose: () => void }) {
  const { originalFile } = useData();
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const cfg = TYPE_CONFIG[doc.docType];
  const isDelivery = doc.docType === 'delivery_order';
  const sourceRefs = doc.sourceRefs || [];
  const download = async () => {
    setDownloading(true); setError('');
    try {
      const blob = await originalFile(doc.id); const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = doc.filename; document.body.appendChild(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError((cause as Error).message || 'Original file could not be downloaded.'); }
    finally { setDownloading(false); }
  };
  return <Dialog title={`${cfg.label} ${docNumber(doc)}`} onClose={onClose} footer={<><button type="button" className="btn btn-primary" disabled={downloading} onClick={() => void download()}>{downloading ? 'Preparing…' : 'Download original'}</button><button type="button" className="btn" onClick={onClose}>Close</button></>}>
    <dl className="facts">{[[doc.flow === 'claims' ? 'Merchant' : 'Supplier', docParty(doc) || '—'], ['Date', docDate(doc) ? formatDate(docDate(doc)) : '—'], ['Amount', docAmount(doc) !== null ? formatMoney(docAmount(doc)!) : '—']].map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    {doc.fields.length > 0 && <dl className="kv">{doc.fields.map(f => <div key={f.key}><dt>{f.label}</dt><dd>{fieldDisplay(f)}{(f.confidence ?? 1) < 0.7 && <span className="conf low">uncertain</span>}</dd></div>)}</dl>}
    {doc.lines.length > 0 && <div className="table-wrap"><table className="table"><thead><tr><th>Item</th><th className="num">Qty</th>{!isDelivery && <><th className="num">Unit</th><th className="num">Total</th></>}</tr></thead>
      <tbody>{doc.lines.map(l => <tr key={l.id}><td>{l.description}</td><td className="num">{l.quantity}</td>{!isDelivery && <><td className="num">{l.unitSen === null ? '—' : formatMoney(l.unitSen)}</td><td className="num">{l.totalSen === null ? '—' : formatMoney(l.totalSen)}</td></>}</tr>)}</tbody></table></div>}
    {sourceRefs.length > 0 && <section className="source-evidence"><h3>Source evidence</h3><ul>{sourceRefs.slice(0, 30).map((ref, index) => <li key={`${ref.documentId || doc.id}-${ref.page || ''}-${ref.row || ''}-${ref.line || ''}-${index}`}>
      <span>{ref.field || 'Document source'}{ref.page ? ` · page ${ref.page}` : ''}{ref.row ? ` · row ${ref.row}` : ''}{ref.line ? ` · line ${ref.line}` : ''}</span>
      {ref.quote && <q>{ref.quote}</q>}
    </li>)}</ul>{sourceRefs.length > 30 && <p className="muted">Showing 30 of {sourceRefs.length} source references.</p>}</section>}
    <p className="muted">{doc.filename} · version {doc.inputVersion ?? doc.version} · uploaded {formatTimestamp(doc.uploadedAt)} by {doc.uploadedBy}{doc.hash && <><br />SHA-256 <code>{doc.hash}</code></>}</p>
    {error && <p className="error-text" role="alert">{error}</p>}
  </Dialog>;
}
