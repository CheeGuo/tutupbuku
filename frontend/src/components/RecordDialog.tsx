import React from 'react';
import type { DocRecord } from '../types';
import { TYPE_CONFIG, docAmount, docDate, docNumber, docParty, fieldDisplay } from '../lib/docs';
import { formatDate, formatMoney, formatTimestamp } from '../lib/format';
import { Dialog } from './ui';

/** Read-only pop-up of a saved record, so a reviewer can check a receipt or document without leaving Action Items. */
export function RecordDialog({ doc, onClose }: { doc: DocRecord; onClose: () => void }) {
  const cfg = TYPE_CONFIG[doc.docType];
  const isDelivery = doc.docType === 'delivery_order';
  return <Dialog title={`${cfg.label} ${docNumber(doc)}`} onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
    <dl className="facts">{[[doc.flow === 'claims' ? 'Merchant' : 'Supplier', docParty(doc) || '—'], ['Date', docDate(doc) ? formatDate(docDate(doc)) : '—'], ['Amount', docAmount(doc) !== null ? formatMoney(docAmount(doc)!) : '—']].map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    {doc.fields.length > 0 && <dl className="kv">{doc.fields.map(f => <div key={f.key}><dt>{f.label}</dt><dd>{fieldDisplay(f)}{(f.confidence ?? 1) < 0.7 && <span className="conf low">uncertain</span>}</dd></div>)}</dl>}
    {doc.lines.length > 0 && <div className="table-wrap"><table className="table"><thead><tr><th>Item</th><th className="num">Qty</th>{!isDelivery && <><th className="num">Unit</th><th className="num">Total</th></>}</tr></thead>
      <tbody>{doc.lines.map(l => <tr key={l.id}><td>{l.description}</td><td className="num">{l.quantity}</td>{!isDelivery && <><td className="num">{l.unitSen === null ? '—' : formatMoney(l.unitSen)}</td><td className="num">{l.totalSen === null ? '—' : formatMoney(l.totalSen)}</td></>}</tr>)}</tbody></table></div>}
    <p className="muted">{doc.filename} · v{doc.version} · uploaded {formatTimestamp(doc.uploadedAt)} by {doc.uploadedBy}<br />Checksum <code>{doc.hash}</code>. The sample build stores the extracted values, not an image of the file.</p>
  </Dialog>;
}
