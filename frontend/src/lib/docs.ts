import type { Claim, DocLink, DocRecord, DocType, Field } from '../types';
import { decimalFromSen, formatDate, formatMoney } from './format';

interface TypeConfig {
  label: string;
  short: string;
  numberKey: string | null;
  dateKey: string | null;
  partyKey: string | null;
  amountKey: string | null;
  hasLines: boolean;
}

/** Which extracted field plays which role, per context §6 "Requested extracted fields". */
export const TYPE_CONFIG: Record<DocType, TypeConfig> = {
  quotation:       { label: 'Quotation',       short: 'QT',  numberKey: 'quotation_no', dateKey: 'date', partyKey: 'supplier', amountKey: 'grand_total', hasLines: true },
  purchase_order:  { label: 'Purchase order',  short: 'PO',  numberKey: 'po_no',        dateKey: 'date', partyKey: 'supplier', amountKey: 'grand_total', hasLines: true },
  delivery_order:  { label: 'Delivery order',  short: 'DO',  numberKey: 'do_no',        dateKey: 'date', partyKey: 'supplier', amountKey: null,          hasLines: true },
  invoice:         { label: 'Invoice',         short: 'INV', numberKey: 'invoice_no',   dateKey: 'date', partyKey: 'supplier', amountKey: 'grand_total', hasLines: true },
  payment_advice:  { label: 'Payment advice',  short: 'PA',  numberKey: 'advice_no',    dateKey: 'date', partyKey: 'supplier', amountKey: 'amount',      hasLines: false },
  payment_receipt: { label: 'Payment receipt', short: 'PR',  numberKey: 'receipt_no',   dateKey: 'date', partyKey: 'supplier', amountKey: 'amount',      hasLines: false },
  claim_receipt:   { label: 'Claim receipt',   short: 'RCP', numberKey: 'receipt_ref',  dateKey: 'date', partyKey: 'merchant', amountKey: 'total',       hasLines: true },
  unclassified:    { label: 'Not yet read',    short: '—',   numberKey: null,           dateKey: null,   partyKey: null,       amountKey: null,          hasLines: false },
};

/** Order of the typical purchasing sequence (context §6). */
export const CHAIN_ORDER: DocType[] = ['quotation', 'purchase_order', 'delivery_order', 'invoice', 'payment_advice', 'payment_receipt'];

export const field = (doc: DocRecord, key: string | null): Field | undefined => (key ? doc.fields.find(f => f.key === key) : undefined);

export const docNumber = (doc: DocRecord) => field(doc, TYPE_CONFIG[doc.docType].numberKey)?.value || doc.filename;
export const docDate = (doc: DocRecord) => field(doc, TYPE_CONFIG[doc.docType].dateKey)?.value || '';
export const docParty = (doc: DocRecord) => field(doc, TYPE_CONFIG[doc.docType].partyKey)?.value || '';
export const docAmount = (doc: DocRecord): number | null => field(doc, TYPE_CONFIG[doc.docType].amountKey)?.sen ?? null;
export const docTax = (doc: DocRecord): number | null => field(doc, 'tax')?.sen ?? null;

export function fieldDisplay(f: Field): string {
  if (f.kind === 'money') return f.sen === undefined ? 'Not supplied' : formatMoney(f.sen);
  if (f.kind === 'date') return formatDate(f.value);
  return f.value || 'Not supplied';
}

export function fieldInputValue(f: Field): string {
  return f.kind === 'money' ? (f.sen === undefined ? '' : decimalFromSen(f.sen)) : f.value;
}

/** Deterministic arithmetic (context §5: code, not AI, does the sums). */
export const lineTotal = (quantity: number, unitSen: number | null) => (unitSen === null ? null : Math.round(quantity * unitSen));

/** Link the document points at (its PO), if any. */
export function linkOf(docId: string, links: DocLink[]): DocLink | undefined {
  return links.find(l => l.sourceId === docId && l.relationship === 'for_po');
}

/** PO document id that a document belongs to (a PO belongs to itself). */
export function poIdOf(doc: DocRecord, links: DocLink[]): string | null {
  if (doc.docType === 'purchase_order') return doc.id;
  return linkOf(doc.id, links)?.targetId ?? null;
}

export function chainOf(poId: string, docs: DocRecord[], links: DocLink[]): DocRecord[] {
  const members = docs.filter(d => poIdOf(d, links) === poId);
  return members.sort((a, b) => CHAIN_ORDER.indexOf(a.docType) - CHAIN_ORDER.indexOf(b.docType) || docDate(a).localeCompare(docDate(b)));
}

export function claimDoc(claim: Claim, docs: DocRecord[]): DocRecord | undefined {
  return docs.find(d => d.id === claim.receiptDocId);
}

export function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
