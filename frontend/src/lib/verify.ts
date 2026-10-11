import type { DocLink, DocRecord, Issue } from '../types';
import { chainOf, docAmount, docNumber, docParty, docTax } from './docs';
import { formatMoney } from './format';

/* Deterministic checks (context §5: arithmetic, matching constraints and duplicates are code, not AI). */

export type IssueDraft = Omit<Issue, 'id' | 'createdAt' | 'status'>;

export interface Comparison {
  item: string; poQty: number | null; poUnit: number | null; invQty: number; invUnit: number | null; delivered: number | null; flags: string[];
}

export interface InvoiceCheck {
  po: DocRecord | null;
  confidence: number;
  basis: string;
  confirmed: boolean;
  comparison: Comparison[];
  issues: IssueDraft[];
}

export function checkInvoice(inv: DocRecord, docs: DocRecord[], links: DocLink[], poRef: string | null): InvoiceCheck {
  const pos = docs.filter(d => d.docType === 'purchase_order' && d.status !== 'REJECTED');
  const supplier = docParty(inv);
  const issues: IssueDraft[] = [];
  let po: DocRecord | null = null; let confidence = 0; let basis = ''; let confirmed = false;
  const ref = poRef ? pos.find(p => docNumber(p).toLowerCase() === poRef.toLowerCase()) : undefined;
  if (ref) { po = ref; confidence = 0.99; basis = `explicit PO reference ${poRef}`; confirmed = true; }
  else {
    const total = docAmount(inv);
    const near = pos.filter(p => docParty(p) === supplier && docAmount(p) === total);
    if (near.length === 1) { po = near[0]; confidence = 0.6; basis = 'same supplier and amount (no PO reference on the invoice)'; }
    else if (near.length > 1) {
      issues.push({ ruleCode: 'AMBIGUOUS_PO_MATCH', typeLabel: 'Ambiguous match', severity: 'WARNING', docIds: [inv.id, ...near.map(n => n.id)], candidateIds: near.map(n => n.id),
        title: `${docNumber(inv)} could belong to ${near.length} POs`, detected: `${near.length} purchase orders from ${supplier} have the same total.`,
        why: 'More than one PO matches. The link was not attached silently.', suggested: ['Choose the correct PO.'],
        evidence: near.map(n => ({ label: docNumber(n), note: `${formatMoney(docAmount(n) ?? 0)} · ${n.status.toLowerCase()}` })) });
    }
  }
  if (!po && !issues.length) {
    issues.push({ ruleCode: 'MISSING_PO', typeLabel: 'Missing purchase order', severity: 'WARNING', docIds: [inv.id], title: `Invoice ${docNumber(inv)} has no purchase order`,
      detected: poRef ? `The invoice cites ${poRef}, which has not been uploaded.` : 'No PO reference was found and no uploaded PO matches this supplier and amount.',
      why: 'Company policy normally expects a PO for goods. A missing document is not proof of an invalid purchase.',
      suggested: ['Link an existing PO, upload the PO, or record an approved non-PO purchase.'],
      evidence: [{ label: 'PO reference on invoice', found: poRef ?? 'None found' }, { label: 'Invoice total', found: formatMoney(docAmount(inv) ?? 0) }] });
  }
  const dup = docs.find(d => d.docType === 'invoice' && d.id !== inv.id && d.status !== 'REJECTED' && docNumber(d) === docNumber(inv) && docParty(d) === supplier);
  if (dup) issues.push({ ruleCode: 'DUPLICATE_INVOICE', typeLabel: 'Possible duplicate', severity: 'WARNING', docIds: [inv.id, dup.id], title: `${docNumber(inv)} may already be on file`,
    detected: `An invoice with the same number from ${supplier} already exists.`, why: 'Duplicate invoice number per supplier. Posting both would double-count the amount.',
    suggested: ['Keep one record and mark the other as the duplicate.'], evidence: [{ label: 'Invoice number', expected: docNumber(dup), found: docNumber(inv) }] });
  const lineSum = inv.lines.reduce((s, l) => s + (l.totalSen ?? 0), 0) + (docTax(inv) ?? 0);   // grand total includes the printed Sales Tax
  const grand = docAmount(inv);
  if (grand !== null && Math.abs(lineSum - grand) > 1) issues.push({ ruleCode: 'TOTAL_MISMATCH', typeLabel: 'Amount mismatch', severity: 'WARNING', docIds: [inv.id], title: `${docNumber(inv)} lines do not add up to the total`,
    detected: 'The sum of the line totals differs from the grand total.', why: 'Line totals must add up to the grand total within rounding tolerance.', suggested: ['Compare with the source file and correct the value.'],
    evidence: [{ label: 'Sum of lines + tax', expected: formatMoney(lineSum), found: formatMoney(grand) }] });

  const comparison: Comparison[] = [];
  if (po) {
    if (docParty(po) !== supplier) issues.push({ ruleCode: 'SUPPLIER_MISMATCH', typeLabel: 'Supplier mismatch', severity: 'HIGH', docIds: [inv.id, po.id], title: `Invoice supplier differs from ${docNumber(po)}`,
      detected: `Invoice: ${supplier}. PO: ${docParty(po)}.`, why: 'Supplier on the invoice does not match the PO.', suggested: ['Confirm the supplier with the buyer before processing.'],
      evidence: [{ label: 'Supplier', expected: docParty(po), found: supplier }] });
    const delivered = chainOf(po.id, docs, links).filter(d => d.docType === 'delivery_order' && d.status !== 'REJECTED');
    for (const line of inv.lines) {
      const pl = po.lines.find(p => p.description === line.description);
      const got = delivered.length ? delivered.reduce((s, d) => s + (d.lines.find(l => l.description === line.description)?.quantity ?? 0), 0) : null;
      const flags: string[] = [];
      if (!pl) flags.push('Not on PO');
      else {
        if (pl.unitSen !== null && line.unitSen !== null && pl.unitSen !== line.unitSen) flags.push('Price differs');
        if (line.quantity > pl.quantity) flags.push('More than ordered');
      }
      if (got !== null && line.quantity > got) flags.push('More than delivered');
      comparison.push({ item: line.description, poQty: pl?.quantity ?? null, poUnit: pl?.unitSen ?? null, invQty: line.quantity, invUnit: line.unitSen, delivered: got, flags });
    }
    const priced = comparison.filter(c => c.flags.includes('Price differs'));
    if (priced.length) {
      const one = priced.length === 1 ? priced[0] : null;
      const poTotal = docAmount(po);
      const wholePo = inv.lines.length === po.lines.length && comparison.every(c => c.poQty === c.invQty);
      issues.push({ ruleCode: 'PRICE_VARIANCE', typeLabel: 'Unit-price mismatch', severity: 'HIGH', docIds: [inv.id, po.id],
        title: one ? `Invoice unit price is ${formatMoney(one.invUnit!)}, PO says ${formatMoney(one.poUnit!)}` : `Invoice unit prices differ from ${docNumber(po)}`,
        detected: one ? `${docNumber(inv)} bills ${one.item} at a higher or different unit price than ${docNumber(po)}.` : `${docNumber(inv)} bills ${priced.length} items at a different unit price than ${docNumber(po)}.`,
        why: 'Unit price on an invoice line differs from the approved PO line, and no variance tolerance is configured. The PO says no variation is accepted without written approval.',
        suggested: ['Ask the supplier whether a price change was agreed, and request a credit note or a corrected invoice.', 'If the invoice was misread, correct the value here.', 'Do not approve the invoice for export until this is settled.'],
        evidence: [
          ...priced.map(c => ({ label: `${c.item}: unit price`, expected: `${formatMoney(c.poUnit!)} (PO)`, found: `${formatMoney(c.invUnit!)} (invoice)` })),
          ...(wholePo && poTotal !== null && grand !== null && poTotal !== grand ? [{ label: 'Invoice grand total', expected: `${formatMoney(poTotal)} (PO)`, found: formatMoney(grand), note: `${formatMoney(Math.abs(grand - poTotal))} ${grand > poTotal ? 'more' : 'less'} than the PO, including tax` }] : []),
        ] });
    }
    const qty = comparison.filter(c => c.flags.includes('More than ordered') || c.flags.includes('More than delivered') || c.flags.includes('Not on PO'));
    if (qty.length) issues.push({ ruleCode: 'QUANTITY_MISMATCH', typeLabel: 'Quantity mismatch', severity: 'WARNING', docIds: [inv.id, po.id],
      title: `Invoice quantity exceeds what was ordered or delivered`, detected: qty.map(q => `${q.item}: ${q.flags.join(', ').toLowerCase()}`).join('; '),
      why: 'Invoice quantity should not exceed the PO, or the cumulative verified deliveries (partial deliveries are summed).', suggested: ['Check outstanding deliveries before approving.'],
      evidence: qty.map(q => ({ label: q.item, expected: `ordered ${q.poQty ?? '—'} · delivered ${q.delivered ?? 'no DO'}`, found: `invoiced ${q.invQty}` })) });
  }
  return { po, confidence, basis, confirmed, comparison, issues };
}
