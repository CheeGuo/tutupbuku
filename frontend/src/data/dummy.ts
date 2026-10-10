/* ============================================================
   DUMMY DATA — Documents and Issues pages only.
   Shaped after TutupBuku_Project_Context.md (purchasing chains,
   claims, chart of accounts, issues, audit log). Nothing here comes
   from the live backend; the UI labels it as sample data.
   ============================================================ */
import type { Account, AuditEntry, Claim, DocLink, DocRecord, DocType, Field, Issue, LineItem } from '../types';

export const SAMPLE_COMPANY = 'Sarawak Fabrication Sdn Bhd';
export const REVIEWER = 'You (finance reviewer)';

const t = (key: string, label: string, value: string, confidence = 0.97): Field => ({ key, label, kind: 'text', value, confidence });
const d = (key: string, label: string, value: string, confidence = 0.97): Field => ({ key, label, kind: 'date', value, confidence });
const m = (key: string, label: string, sen: number, confidence = 0.98): Field => ({ key, label, kind: 'money', value: '', sen, confidence });
const li = (id: string, description: string, quantity: number, unitSen: number | null): LineItem =>
  ({ id, description, quantity, unitSen, totalSen: unitSen === null ? null : Math.round(quantity * unitSen) });
const hash = (seed: string) => (seed.split('').reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, '0') + 'c0ffee11d00d5eed').slice(0, 16);

let n = 0;
function doc(docType: DocType, filename: string, fields: Field[], lines: LineItem[], status: DocRecord['status'],
  extra: Partial<DocRecord> = {}): DocRecord {
  n += 1;
  return {
    id: `DOC-${String(n).padStart(3, '0')}`, docType, flow: docType === 'claim_receipt' ? 'claims' : 'purchasing',
    filename, fields, lines, status, hash: hash(filename), version: 1,
    uploadedAt: '2026-10-09T09:12:00+08:00', uploadedBy: 'Faridah (purchasing)', ...extra,
  };
}

/* ---------- Purchasing chain A: price variance on the invoice ---------- */
const poA = doc('purchase_order', 'PO-2026-0412.pdf', [
  t('po_no', 'PO number', 'PO-2026-0412'), d('date', 'Date', '2026-09-22'), t('supplier', 'Supplier', 'Teknik Mesra Sdn Bhd'), m('grand_total', 'Grand total', 485000),
], [li('l1', 'Hydraulic hose assembly', 40, 10000), li('l2', 'Pressure gauge 0–10 bar', 10, 8500)], 'MATCHED');
const qtA = doc('quotation', 'QT-8841.pdf', [
  t('quotation_no', 'Quotation number', 'QT-8841'), d('date', 'Date', '2026-09-15', 0.62), t('supplier', 'Supplier', 'Teknik Mesra Sdn Bhd'), m('grand_total', 'Grand total', 485000),
], [li('l1', 'Hydraulic hose assembly', 40, 10000), li('l2', 'Pressure gauge 0–10 bar', 10, 8500)], 'MATCHED');
const do1 = doc('delivery_order', 'DO-5521.pdf', [
  t('do_no', 'DO number', 'DO-5521'), d('date', 'Date', '2026-09-30'), t('supplier', 'Supplier', 'Teknik Mesra Sdn Bhd'), t('delivery_status', 'Delivery status', 'Delivered in part'),
], [li('l1', 'Hydraulic hose assembly', 40, null), li('l2', 'Pressure gauge 0–10 bar', 6, null)], 'MATCHED');
const do2 = doc('delivery_order', 'DO-5533.jpg', [
  t('do_no', 'DO number', 'DO-5533', 0.58), d('date', 'Date', '2026-10-05'), t('supplier', 'Supplier', 'Teknik Mesra Sdn Bhd'), t('delivery_status', 'Delivery status', 'Delivered', 0.9),
], [li('l1', 'Pressure gauge 0–10 bar', 4, null)], 'NEEDS_REVIEW');
const invA = doc('invoice', 'INV-77120.pdf', [
  t('invoice_no', 'Invoice number', 'INV-77120'), d('date', 'Date', '2026-10-06'), t('supplier', 'Supplier', 'Teknik Mesra Sdn Bhd'),
  d('due_date', 'Due date', '2026-11-05'), t('payment_terms', 'Payment term', 'Net 30'), m('grand_total', 'Grand total', 565000),
], [li('l1', 'Hydraulic hose assembly', 40, 12000), li('l2', 'Pressure gauge 0–10 bar', 10, 8500)], 'NEEDS_REVIEW');
const invADup = doc('invoice', 'INV-77120 (re-upload).pdf', [
  t('invoice_no', 'Invoice number', 'INV-77120'), d('date', 'Date', '2026-10-06'), t('supplier', 'Supplier', 'Teknik Mesra Sdn Bhd'),
  d('due_date', 'Due date', '2026-11-05'), t('payment_terms', 'Payment term', 'Net 30'), m('grand_total', 'Grand total', 565000),
], [li('l1', 'Hydraulic hose assembly', 40, 12000), li('l2', 'Pressure gauge 0–10 bar', 10, 8500)], 'NEEDS_REVIEW',
{ hash: invA.hash, uploadedAt: '2026-10-10T16:40:00+08:00', uploadedBy: 'Hui Ling (admin)' });

/* ---------- Chain B: clean, verified ---------- */
const poB = doc('purchase_order', 'PO-2026-0415.pdf', [
  t('po_no', 'PO number', 'PO-2026-0415'), d('date', 'Date', '2026-09-25'), t('supplier', 'Supplier', 'Borneo Packaging Sdn Bhd'), m('grand_total', 'Grand total', 120000),
], [li('l1', 'Corrugated carton, large', 500, 240)], 'VERIFIED');
const doB = doc('delivery_order', 'DO-3310.pdf', [
  t('do_no', 'DO number', 'DO-3310'), d('date', 'Date', '2026-10-01'), t('supplier', 'Supplier', 'Borneo Packaging Sdn Bhd'), t('delivery_status', 'Delivery status', 'Delivered'),
], [li('l1', 'Corrugated carton, large', 500, null)], 'VERIFIED');
const invB = doc('invoice', 'INV-BP-20931.pdf', [
  t('invoice_no', 'Invoice number', 'INV-BP-20931'), d('date', 'Date', '2026-10-02'), t('supplier', 'Supplier', 'Borneo Packaging Sdn Bhd'),
  d('due_date', 'Due date', '2026-11-01'), t('payment_terms', 'Payment term', 'Net 30'), m('grand_total', 'Grand total', 120000), m('tax', 'Tax (SST)', 0),
], [li('l1', 'Corrugated carton, large', 500, 240)], 'VERIFIED');
const paB = doc('payment_advice', 'PA-0099.pdf', [
  t('advice_no', 'Payment advice number', 'PA-0099'), d('date', 'Date', '2026-10-08'), t('supplier', 'Supplier', 'Borneo Packaging Sdn Bhd'), m('amount', 'Amount', 120000), t('payment_reference', 'Payment reference', 'IBG 20261008-77'),
], [], 'MATCHED');

/* ---------- Chain C: PO exists for tape, ambiguous payment advice ---------- */
const poC = doc('purchase_order', 'PO-2026-0419.pdf', [
  t('po_no', 'PO number', 'PO-2026-0419'), d('date', 'Date', '2026-10-01'), t('supplier', 'Supplier', 'Borneo Packaging Sdn Bhd'), m('grand_total', 'Grand total', 120000),
], [li('l1', 'Packing tape 48mm', 200, 600)], 'MATCHED');
const paC = doc('payment_advice', 'PA-0102.pdf', [
  t('advice_no', 'Payment advice number', 'PA-0102'), d('date', 'Date', '2026-10-09'), t('supplier', 'Supplier', 'Borneo Packaging Sdn Bhd', 0.88), m('amount', 'Amount', 120000), t('payment_reference', 'Payment reference', 'BP OCT', 0.55),
], [], 'NEEDS_REVIEW');

/* ---------- Service purchase, two-way ---------- */
const poS = doc('purchase_order', 'PO-2026-0409.pdf', [
  t('po_no', 'PO number', 'PO-2026-0409'), d('date', 'Date', '2026-09-18'), t('supplier', 'Supplier', 'Kuching Cold Chain Services'), m('grand_total', 'Grand total', 90000),
], [li('l1', 'Cold-room rental, October 2026', 1, 90000)], 'MATCHED');
const invS = doc('invoice', 'INV-KCS-1180.pdf', [
  t('invoice_no', 'Invoice number', 'INV-KCS-1180'), d('date', 'Date', '2026-10-01'), t('supplier', 'Supplier', 'Kuching Cold Chain Services'),
  d('due_date', 'Due date', '2026-10-31'), t('payment_terms', 'Payment term', 'Net 30'), m('grand_total', 'Grand total', 90000),
], [li('l1', 'Cold-room rental, October 2026', 1, 90000)], 'MATCHED');

/* ---------- Unmatched invoice ---------- */
const invU = doc('invoice', 'INV-SOH-5512.pdf', [
  t('invoice_no', 'Invoice number', 'INV-SOH-5512'), d('date', 'Date', '2026-10-02'), t('supplier', 'Supplier', 'Sarawak Office Hub'),
  d('due_date', 'Due date', '2026-11-01'), t('payment_terms', 'Payment term', 'Net 30'), m('grand_total', 'Grand total', 64000),
], [li('l1', 'Ergonomic office chair', 2, 32000)], 'NEEDS_REVIEW');

/* ---------- Claim receipts ---------- */
const rcLunch = doc('claim_receipt', 'receipt-example-cafe.jpg', [
  t('receipt_ref', 'Receipt reference', 'EC-004217'), d('date', 'Date', '2026-10-08'), t('merchant', 'Merchant', 'Example Cafe'), m('total', 'Total', 8650), m('tax', 'Service tax', 490, 0.9),
], [li('l1', 'Set lunch', 3, 2400), li('l2', 'Iced drinks', 3, 600), li('l3', 'Dessert platter', 1, 1000)], 'EXTRACTED',
{ uploadedBy: 'Aisyah Rahman', uploadedAt: '2026-10-09T08:30:00+08:00' });
const rcStationery = doc('claim_receipt', 'receipt-stationery.png', [
  t('receipt_ref', 'Receipt reference', 'KSC-88120'), d('date', 'Date', '2026-10-05'), t('merchant', 'Merchant', 'Kuching Stationery Centre'), m('total', 'Total', 14230),
], [li('l1', 'A4 paper, 5 reams', 5, 1590), li('l2', 'Toner cartridge', 1, 6280)], 'VERIFIED',
{ uploadedBy: 'Daniel Wong', uploadedAt: '2026-10-06T10:05:00+08:00' });
const rcLounge = doc('claim_receipt', 'receipt-neon-lounge.jpg', [
  t('receipt_ref', 'Receipt reference', 'NL-20931'), d('date', 'Date', '2026-10-09'), t('merchant', 'Merchant', 'Neon Lounge Kuching'), m('total', 'Total', 61200),
], [li('l1', 'Private room, 3 hrs', 1, 18000), li('l2', 'Beer tower', 3, 9800), li('l3', 'Bar snacks platter', 2, 6900)], 'NEEDS_REVIEW',
{ uploadedBy: 'Daniel Wong', uploadedAt: '2026-10-10T11:20:00+08:00' });
const rcRide = doc('claim_receipt', 'receipt-grab.png', [
  t('receipt_ref', 'Receipt reference', 'GRB-A7731'), d('date', 'Date', '2026-10-07'), t('merchant', 'Merchant', 'Grab'), m('total', 'Total', 3600),
], [li('l1', 'Ride Kuching City – Airport', 1, 3600)], 'NEEDS_REVIEW',
{ uploadedBy: 'Aisyah Rahman', uploadedAt: '2026-10-10T09:02:00+08:00' });

export const SEED_DOCS: DocRecord[] = [poA, qtA, do1, do2, invA, invADup, poB, doB, invB, paB, poC, paC, poS, invS, invU, rcLunch, rcStationery, rcLounge, rcRide];

const link = (src: DocRecord, target: DocRecord, confidence: number, confirmedBy: string | null, relationship: DocLink['relationship'] = 'for_po'): DocLink =>
  ({ id: `LNK-${src.id}-${target.id}`, sourceId: src.id, targetId: target.id, relationship, confidence, confirmedBy });

export const SEED_LINKS: DocLink[] = [
  link(qtA, poA, 0.97, 'Docs match (PO no.)'), link(do1, poA, 0.99, 'Explicit PO reference'), link(do2, poA, 0.93, null), link(invA, poA, 0.99, 'Explicit PO reference'),
  link(invADup, poA, 0.99, null),
  link(doB, poB, 0.99, 'Explicit PO reference'), link(invB, poB, 0.99, 'Explicit PO reference'), link(paB, poB, 0.9, REVIEWER), link(paB, invB, 0.9, REVIEWER, 'settles_invoice'),
  link(paC, poC, 0.52, null),
  link(invS, poS, 0.99, 'Explicit PO reference'),
];

export const CHART_OF_ACCOUNTS: Account[] = [
  { code: '6010', name: 'Office Supplies & Stationery' },
  { code: '6020', name: 'Business Entertainment' },
  { code: '6030', name: 'Travel & Transport' },
  { code: '6040', name: 'Staff Welfare' },
  { code: '6050', name: 'Software & Subscriptions' },
];

export const SEED_CLAIMS: Claim[] = [
  {
    id: 'CLM-101', employee: 'Aisyah Rahman', receiptDocId: rcLunch.id,
    employeePurpose: 'Lunch with ABC Sdn Bhd to discuss the new supplier contract.',
    categoryCode: '6020', categoryConfidence: 0.78, alternativeCodes: ['6040'],
    categoryReasoning: 'A meal with an external company and a stated commercial purpose fits Business Entertainment, subject to company policy on entertainment limits.',
    standardizedDescription: 'Business lunch with representatives of ABC Sdn Bhd on 8 October 2026 at Example Cafe to discuss a proposed supplier contract.',
    findings: ['Receipt shows three set lunches, which is consistent with a small group meal.', 'The receipt cannot prove that a business meeting took place; attendees and purpose are employee-stated.'],
    status: 'PLAUSIBLE',
  },
  {
    id: 'CLM-102', employee: 'Daniel Wong', receiptDocId: rcStationery.id,
    employeePurpose: 'Printer paper and toner for the office printer.',
    categoryCode: '6010', categoryConfidence: 0.94, alternativeCodes: [],
    categoryReasoning: 'Paper and toner are consumable office supplies.',
    standardizedDescription: 'Office printing supplies (A4 paper and toner cartridge) purchased on 5 October 2026 at Kuching Stationery Centre.',
    findings: ['Receipt items directly support the stated purpose.'],
    status: 'APPROVED',
  },
  {
    id: 'CLM-103', employee: 'Daniel Wong', receiptDocId: rcLounge.id,
    employeePurpose: 'Client dinner with Mr Lim to close the Teknik Mesra pricing.',
    categoryCode: '6020', categoryConfidence: 0.41, alternativeCodes: ['6040'],
    categoryReasoning: 'Possible entertainment, but the venue and items do not clearly match a business dinner. Low confidence.',
    standardizedDescription: 'Client entertainment with Mr Lim on 9 October 2026 at Neon Lounge Kuching, stated purpose: to close pricing with Teknik Mesra.',
    findings: ['Receipt lists a private room and three beer towers, not a meal; "dinner" is not supported by the items.', 'Attendees beyond "Mr Lim" are not stated and were not assumed.', 'Amount is high for the stated purpose; check against company entertainment policy.'],
    status: 'NEEDS_REVIEW',
  },
  {
    id: 'CLM-104', employee: 'Aisyah Rahman', receiptDocId: rcRide.id,
    employeePurpose: 'Taxi to the airport for the Kuala Lumpur supplier visit on 6 October.',
    categoryCode: '6030', categoryConfidence: 0.88, alternativeCodes: [],
    categoryReasoning: 'Ride-hailing to an airport for business travel fits Travel & Transport.',
    standardizedDescription: 'Ride-hailing from Kuching city to the airport on 7 October 2026 for a supplier visit (employee stated 6 October).',
    findings: ['Receipt date (7 Oct) differs from the date in the employee statement (6 Oct).'],
    status: 'NEEDS_REVIEW',
  },
];

const ts = (day: number, time: string) => `2026-10-${String(day).padStart(2, '0')}T${time}:00+08:00`;

export const SEED_ISSUES: Issue[] = [
  {
    id: 'ISS-001', ruleCode: 'PRICE_VARIANCE', typeLabel: 'Unit-price mismatch', severity: 'HIGH', status: 'OPEN',
    docIds: [invA.id, poA.id], title: 'Invoice unit price is RM120.00, PO says RM100.00',
    detected: 'INV-77120 bills hydraulic hose assemblies at a higher unit price than PO-2026-0412.',
    why: 'Unit price on an invoice line differs from the approved PO line, and no price-variance tolerance is configured for this supplier.',
    suggested: ['Ask Teknik Mesra Sdn Bhd whether a price change was agreed and request a revised PO or a credit note.', 'If the PO is wrong, correct it and resolve this issue with a note.', 'Do not approve the invoice for export until this is settled.'],
    evidence: [], createdAt: ts(9, '09:40'),
  },
  {
    id: 'ISS-002', ruleCode: 'MISSING_PO', typeLabel: 'Missing purchase order', severity: 'WARNING', status: 'OPEN',
    docIds: [invU.id], title: 'Invoice INV-SOH-5512 has no purchase order',
    detected: 'No PO reference was found on the invoice and no uploaded PO matches Sarawak Office Hub.',
    why: 'Company policy normally expects a PO for goods purchases. A missing document is not proof of an invalid purchase.',
    suggested: ['Upload the PO if it exists.', 'Or record it as an approved non-PO purchase and resolve with the approver’s name.'],
    evidence: [
      { label: 'PO reference on invoice', found: 'None found' },
      { label: 'Uploaded POs for this supplier', found: 'None' },
      { label: 'Invoice total', found: 'RM 640.00' },
    ], createdAt: ts(10, '08:15'),
  },
  {
    id: 'ISS-003', ruleCode: 'DUPLICATE_INVOICE', typeLabel: 'Possible duplicate', severity: 'WARNING', status: 'UNDER_REVIEW',
    docIds: [invADup.id, invA.id], title: 'INV-77120 appears to have been uploaded twice',
    detected: 'Two files carry the same checksum and the same supplier invoice number.',
    why: 'Duplicate file hash and duplicate invoice number for one supplier. Posting both would double-count RM 5,650.00.',
    suggested: ['Keep one copy and reject the other.', 'Confirm with whoever uploaded the second file that it is not a corrected invoice.'],
    evidence: [
      { label: 'File checksum', expected: invA.hash, found: invADup.hash },
      { label: 'Invoice number', expected: 'INV-77120', found: 'INV-77120' },
      { label: 'Uploaded', expected: '9 Oct 2026 · Faridah', found: '10 Oct 2026 · Hui Ling' },
    ], createdAt: ts(10, '16:41'),
  },
  {
    id: 'ISS-004', ruleCode: 'AMBIGUOUS_PO_MATCH', typeLabel: 'Ambiguous match', severity: 'WARNING', status: 'OPEN',
    docIds: [paC.id, poC.id, poB.id], candidateIds: [poC.id, poB.id], title: 'Payment advice PA-0102 could belong to two POs',
    detected: 'RM 1,200.00 from Borneo Packaging matches both PO-2026-0419 (open) and PO-2026-0415 (already settled by PA-0099).',
    why: 'Same supplier and same amount, and the payment reference “BP OCT” does not name a document. The link was proposed at 52% and left unconfirmed.',
    suggested: ['Choose the correct PO in the document’s link list, or ask the supplier for the settled invoice number.'],
    evidence: [
      { label: 'PO-2026-0419', note: 'Open · RM 1,200.00 · packing tape' },
      { label: 'PO-2026-0415', note: 'Already paid by PA-0099 · RM 1,200.00' },
      { label: 'Payment reference', found: 'BP OCT', note: 'Does not name an invoice' },
    ], createdAt: ts(10, '10:02'),
  },
  {
    id: 'ISS-005', ruleCode: 'EXTRACTION_UNCERTAIN', typeLabel: 'Extraction uncertainty', severity: 'INFO', status: 'OPEN',
    docIds: [do2.id], title: 'DO number on DO-5533 was hard to read',
    detected: 'The delivery order number was read with 58% confidence from a photo.',
    why: 'Low-confidence extraction is shown for confirmation rather than assumed correct.',
    suggested: ['Compare the value with the source image and correct it if needed.'],
    fieldKey: 'do_no', evidence: [{ label: 'DO number', found: 'DO-5533', note: 'Confidence 58%' }], createdAt: ts(9, '09:45'),
  },
  {
    id: 'ISS-006', ruleCode: 'SERVICE_NO_DO', typeLabel: 'No delivery order', severity: 'INFO', status: 'OPEN',
    docIds: [invS.id, poS.id], title: 'No delivery order for a rental service',
    detected: 'PO-2026-0409 and INV-KCS-1180 are linked, but there is no delivery order.',
    why: 'Services may legitimately be verified two-way (PO and invoice) where policy permits. This is not a mismatch.',
    suggested: ['Mark the purchase as a service to allow two-way verification, or upload a service completion note.'],
    evidence: [{ label: 'Items', found: 'Cold-room rental, October 2026' }], createdAt: ts(10, '08:20'),
  },
  {
    id: 'ISS-007', ruleCode: 'CLAIM_PURPOSE', typeLabel: 'Claim purpose concern', severity: 'HIGH', status: 'OPEN',
    docIds: [rcLounge.id], claimId: 'CLM-103', title: '“Client dinner” claim is for a lounge room and beer',
    detected: 'The stated purpose is a client dinner; the receipt lists a private room and three beer towers.',
    why: 'Receipt contents contradict part of the stated purpose, and the amount is high. A receipt cannot independently prove a business meeting.',
    suggested: ['Ask Daniel Wong for attendees and the business reason.', 'Reject, or request a corrected claim, if the policy does not allow this spending.'],
    evidence: [
      { label: 'Stated purpose', found: 'Client dinner with Mr Lim' },
      { label: 'Receipt items', found: 'Private room, beer tower ×3, snacks' },
      { label: 'Amount', found: 'RM 612.00' },
    ], createdAt: ts(10, '11:25'),
  },
  {
    id: 'ISS-008', ruleCode: 'CLAIM_DATE_MISMATCH', typeLabel: 'Claim date mismatch', severity: 'WARNING', status: 'OPEN',
    docIds: [rcRide.id], claimId: 'CLM-104', title: 'Taxi receipt is dated a day after the trip described',
    detected: 'The employee wrote 6 October; the receipt is dated 7 October 2026.',
    why: 'Receipt date differs from the date in the employee’s statement. It may be a typing error or a different trip.',
    suggested: ['Ask Aisyah Rahman which date is correct and edit the statement if needed.'],
    evidence: [{ label: 'Date', expected: '6 Oct 2026 (statement)', found: '7 Oct 2026 (receipt)' }], createdAt: ts(10, '09:05'),
  },
  {
    id: 'ISS-009', ruleCode: 'TOTAL_MISMATCH', typeLabel: 'Amount mismatch', severity: 'INFO', status: 'RESOLVED',
    docIds: [qtA.id, poA.id], title: 'Quotation total differed from the PO by RM 0.01',
    detected: 'QT-8841 grand total was read as RM 4,850.01.',
    why: 'Difference was within rounding tolerance after the quotation was re-read.',
    suggested: [], evidence: [{ label: 'Quotation total', expected: 'RM 4,850.00', found: 'RM 4,850.00' }], createdAt: ts(9, '09:41'),
    resolution: 'Re-extraction read the total correctly; no variance.',
  },
];

export const SEED_AUDIT: AuditEntry[] = [
  { id: 'A-1', timestamp: ts(9, '09:13'), actor: 'Docs Agent', actorKind: 'agent', action: 'Extracted 6 fields and 2 line items', entityId: invA.id },
  { id: 'A-2', timestamp: ts(9, '09:14'), actor: 'Purchasing Agent', actorKind: 'agent', action: 'Linked to PO-2026-0412 (explicit PO reference, 99%)', entityId: invA.id },
  { id: 'A-3', timestamp: ts(9, '09:40'), actor: 'Verify & Audit Agent', actorKind: 'agent', action: 'Raised ISS-001: unit price differs from PO', entityId: 'ISS-001' },
  { id: 'A-4', timestamp: ts(10, '16:41'), actor: 'Verify & Audit Agent', actorKind: 'agent', action: 'Raised ISS-003: duplicate file checksum', entityId: 'ISS-003' },
  { id: 'A-5', timestamp: ts(10, '16:55'), actor: REVIEWER, actorKind: 'human', action: 'Status changed', entityId: 'ISS-003', previous: 'OPEN', next: 'UNDER_REVIEW' },
  { id: 'A-6', timestamp: ts(9, '09:50'), actor: REVIEWER, actorKind: 'human', action: 'Status changed', entityId: 'ISS-009', previous: 'OPEN', next: 'RESOLVED' },
  { id: 'A-7', timestamp: ts(10, '08:40'), actor: 'Council of Agents', actorKind: 'agent', action: 'Suggested account 6020 Business Entertainment (78%)', entityId: 'CLM-101' },
  { id: 'A-8', timestamp: ts(7, '14:10'), actor: REVIEWER, actorKind: 'human', action: 'Claim approved', entityId: 'CLM-102', previous: 'PLAUSIBLE', next: 'APPROVED' },
  { id: 'A-9', timestamp: ts(8, '17:30'), actor: REVIEWER, actorKind: 'human', action: 'Status changed', entityId: invB.id, previous: 'MATCHED', next: 'VERIFIED' },
];
