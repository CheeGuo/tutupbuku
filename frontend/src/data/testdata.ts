/* ============================================================
   TRANSCRIBED TEST DATA — not imported by the app.
   Purchasing records transcribed from the six test chains in frontend/public/sample-docs/
   (quotation → PO → DO → invoice → payment advice → receipt); each `sourceUrl` points at its
   original PDF. Claims are illustrative. This was imported into Supabase once; the app reads
   Supabase only. Document ids depend on the order below, so keep it.
   ============================================================ */
import type { AuditEntry, Claim, DocLink, DocRecord, DocType, Field, Issue, LineItem } from '../types';
import { BST, F4, KOS, L4, REVIEWER, SAMPLE_DOCS_BASE, d, items, li, m, rm, t, totals } from './dummy';

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

/** A purchasing document whose original PDF lives in sample-docs/<folder>/<file>. Uploaded on the document's own date. */
function pdf(folder: string, file: string, docType: DocType, fields: Field[], lines: LineItem[], status: DocRecord['status'] = 'MATCHED'): DocRecord {
  const date = fields.find(f => f.key === 'date')?.value ?? '2026-10-09';
  const finance = docType === 'invoice' || docType === 'payment_advice' || docType === 'payment_receipt';
  return doc(docType, file, fields, lines, status,
    { sourceUrl: `${SAMPLE_DOCS_BASE}/${folder}/${file}`, uploadedAt: `${date}T09:00:00+08:00`, uploadedBy: finance ? 'Chong Mei Ling (finance)' : 'Lim Wei Jie (purchasing)' });
}

/* ---------- Chain 1 — BST, PO-0087: clean, fully paid and receipted ---------- */
const F1 = 'Chain1_BST_SFSB-PO-2026-0087';
const L1 = items([["Mild Steel Plate 6mm x 4' x 8' (S275JR)", 20, rm(520)], ["Mild Steel Plate 10mm x 4' x 8' (S275JR)", 10, rm(865)], ['Equal Angle Bar 50 x 50 x 5mm x 6m', 40, rm(68.5)]]);
const qt1 = pdf(F1, '01_Quotation_BST-QT-2608-0142.pdf', 'quotation', [t('quotation_no', 'Quotation number', 'BST-QT-2608-0142'), d('date', 'Date', '2026-08-03'), t('supplier', 'Supplier', BST), d('valid_until', 'Valid until', '2026-09-02'), t('payment_terms', 'Payment term', '30 Days'), ...totals(L1)], L1);
const po1 = pdf(F1, '02_PurchaseOrder_SFSB-PO-2026-0087.pdf', 'purchase_order', [t('po_no', 'PO number', 'SFSB-PO-2026-0087'), d('date', 'Date', '2026-08-07'), t('supplier', 'Supplier', BST), t('quotation_ref', 'Quotation ref.', 'BST-QT-2608-0142'), d('required_date', 'Required date', '2026-08-14'), t('payment_terms', 'Payment term', '30 Days'), ...totals(L1)], L1);
const do1 = pdf(F1, '03_DeliveryOrder_BST-DO-26-0517.pdf', 'delivery_order', [t('do_no', 'DO number', 'BST-DO-26-0517'), d('date', 'Date', '2026-08-14'), t('supplier', 'Supplier', BST), t('po_ref', 'PO number', 'SFSB-PO-2026-0087'), t('delivery_status', 'Delivery status', 'Delivered in full')], items(L1.map(l => [l.description, l.quantity, null])));
const inv1 = pdf(F1, '04_Invoice_BST-INV-26-0891.pdf', 'invoice', [t('invoice_no', 'Invoice number', 'BST-INV-26-0891'), d('date', 'Date', '2026-08-14'), t('supplier', 'Supplier', BST), t('po_ref', 'PO number', 'SFSB-PO-2026-0087'), t('do_ref', 'Delivery order', 'BST-DO-26-0517'), d('due_date', 'Due date', '2026-09-13'), t('payment_terms', 'Payment term', '30 Days'), ...totals(L1)], L1, 'VERIFIED');
const pa1 = pdf(F1, '05_PaymentAdvice_SFSB-PA-2026-0061.pdf', 'payment_advice', [t('advice_no', 'Payment advice number', 'SFSB-PA-2026-0061'), d('date', 'Date', '2026-09-10'), t('supplier', 'Supplier', BST), t('invoice_ref', 'Invoice number', 'BST-INV-26-0891'), t('po_ref', 'PO number', 'SFSB-PO-2026-0087'), m('amount', 'Amount', rm(23969)), t('payment_reference', 'Payment reference', 'IBG2609100458')], []);
const or1 = pdf(F1, '06_Receipt_BST-OR-26-0334.pdf', 'payment_receipt', [t('receipt_no', 'Receipt number', 'BST-OR-26-0334'), d('date', 'Date', '2026-09-11'), t('supplier', 'Supplier', BST), t('invoice_ref', 'Invoice number', 'BST-INV-26-0891'), t('po_ref', 'PO number', 'SFSB-PO-2026-0087'), m('amount', 'Amount', rm(23969)), t('payment_reference', 'Payment reference', 'IBG2609100458')], []);

/* ---------- Chain 2 — BST, PO-0094: clean, fully paid and receipted ---------- */
const F2 = 'Chain2_BST_SFSB-PO-2026-0094';
const L2 = items([['MS Square Hollow Section 50 x 50 x 2.0mm x 6m', 60, rm(72)], ['MS Pipe 2" Sch 40 x 6m', 25, rm(185)], ['I-Beam 150 x 75mm x 6m', 8, rm(640)]]);
const qt2 = pdf(F2, '01_Quotation_BST-QT-2608-0168.pdf', 'quotation', [t('quotation_no', 'Quotation number', 'BST-QT-2608-0168'), d('date', 'Date', '2026-08-24'), t('supplier', 'Supplier', BST), d('valid_until', 'Valid until', '2026-09-23'), t('payment_terms', 'Payment term', '30 Days'), ...totals(L2)], L2);
const po2 = pdf(F2, '02_PurchaseOrder_SFSB-PO-2026-0094.pdf', 'purchase_order', [t('po_no', 'PO number', 'SFSB-PO-2026-0094'), d('date', 'Date', '2026-08-27'), t('supplier', 'Supplier', BST), t('quotation_ref', 'Quotation ref.', 'BST-QT-2608-0168'), d('required_date', 'Required date', '2026-09-03'), t('payment_terms', 'Payment term', '30 Days'), ...totals(L2)], L2);
const do2 = pdf(F2, '03_DeliveryOrder_BST-DO-26-0563.pdf', 'delivery_order', [t('do_no', 'DO number', 'BST-DO-26-0563'), d('date', 'Date', '2026-09-03'), t('supplier', 'Supplier', BST), t('po_ref', 'PO number', 'SFSB-PO-2026-0094'), t('delivery_status', 'Delivery status', 'Delivered in full')], items(L2.map(l => [l.description, l.quantity, null])));
const inv2 = pdf(F2, '04_Invoice_BST-INV-26-0947.pdf', 'invoice', [t('invoice_no', 'Invoice number', 'BST-INV-26-0947'), d('date', 'Date', '2026-09-04'), t('supplier', 'Supplier', BST), t('po_ref', 'PO number', 'SFSB-PO-2026-0094'), t('do_ref', 'Delivery order', 'BST-DO-26-0563'), d('due_date', 'Due date', '2026-10-04'), t('payment_terms', 'Payment term', '30 Days'), ...totals(L2)], L2, 'VERIFIED');
const pa2 = pdf(F2, '05_PaymentAdvice_SFSB-PA-2026-0068.pdf', 'payment_advice', [t('advice_no', 'Payment advice number', 'SFSB-PA-2026-0068'), d('date', 'Date', '2026-10-01'), t('supplier', 'Supplier', BST), t('invoice_ref', 'Invoice number', 'BST-INV-26-0947'), t('po_ref', 'PO number', 'SFSB-PO-2026-0094'), m('amount', 'Amount', rm(15471.5)), t('payment_reference', 'Payment reference', 'IBG2610010217')], []);
const or2 = pdf(F2, '06_Receipt_BST-OR-26-0371.pdf', 'payment_receipt', [t('receipt_no', 'Receipt number', 'BST-OR-26-0371'), d('date', 'Date', '2026-10-02'), t('supplier', 'Supplier', BST), t('invoice_ref', 'Invoice number', 'BST-INV-26-0947'), t('po_ref', 'PO number', 'SFSB-PO-2026-0094'), m('amount', 'Amount', rm(15471.5)), t('payment_reference', 'Payment reference', 'IBG2610010217')], []);

/* ---------- Chain 3 — KOS, PO-0101: clean office-supplies purchase, paid and receipted ---------- */
const F3 = 'Chain3_KOS_SFSB-PO-2026-0101';
const L3 = items([['A4 Copier Paper 80gsm (5 reams/box)', 20, rm(62)], ['Lever Arch File A4, 3" spine', 50, rm(8.9)], ['Laser Toner Cartridge, Black (compatible)', 6, rm(189)], ['Whiteboard Marker, assorted (box of 12)', 10, rm(28.5)], ['Ballpoint Pen, Blue (box of 50)', 5, rm(32)]]);
const qt3 = pdf(F3, '01_Quotation_KOS-Q-26-0219.pdf', 'quotation', [t('quotation_no', 'Quotation number', 'KOS/Q/26/0219'), d('date', 'Date', '2026-09-08'), t('supplier', 'Supplier', KOS), d('valid_until', 'Valid until', '2026-10-08'), t('payment_terms', 'Payment term', '30 Days'), ...totals(L3)], L3);
const po3 = pdf(F3, '02_PurchaseOrder_SFSB-PO-2026-0101.pdf', 'purchase_order', [t('po_no', 'PO number', 'SFSB-PO-2026-0101'), d('date', 'Date', '2026-09-10'), t('supplier', 'Supplier', KOS), t('quotation_ref', 'Quotation ref.', 'KOS/Q/26/0219'), d('required_date', 'Required date', '2026-09-15'), t('payment_terms', 'Payment term', '30 Days'), ...totals(L3)], L3);
const do3 = pdf(F3, '03_DeliveryOrder_KOS-DO-26-0402.pdf', 'delivery_order', [t('do_no', 'DO number', 'KOS/DO/26/0402'), d('date', 'Date', '2026-09-15'), t('supplier', 'Supplier', KOS), t('po_ref', 'PO number', 'SFSB-PO-2026-0101'), t('delivery_status', 'Delivery status', 'Delivered in full')], items(L3.map(l => [l.description, l.quantity, null])));
const inv3 = pdf(F3, '04_Invoice_KOS-INV-26-0388.pdf', 'invoice', [t('invoice_no', 'Invoice number', 'KOS/INV/26/0388'), d('date', 'Date', '2026-09-15'), t('supplier', 'Supplier', KOS), t('po_ref', 'PO number', 'SFSB-PO-2026-0101'), t('do_ref', 'Delivery order', 'KOS/DO/26/0402'), d('due_date', 'Due date', '2026-10-15'), t('payment_terms', 'Payment term', '30 Days'), ...totals(L3)], L3, 'VERIFIED');
const pa3 = pdf(F3, '05_PaymentAdvice_SFSB-PA-2026-0072.pdf', 'payment_advice', [t('advice_no', 'Payment advice number', 'SFSB-PA-2026-0072'), d('date', 'Date', '2026-10-08'), t('supplier', 'Supplier', KOS), t('invoice_ref', 'Invoice number', 'KOS/INV/26/0388'), t('po_ref', 'PO number', 'SFSB-PO-2026-0101'), m('amount', 'Amount', rm(3590.4)), t('payment_reference', 'Payment reference', 'IBG2610080733')], []);
const or3 = pdf(F3, '06_Receipt_KOS-R-26-0291.pdf', 'payment_receipt', [t('receipt_no', 'Receipt number', 'KOS/R/26/0291'), d('date', 'Date', '2026-10-09'), t('supplier', 'Supplier', KOS), t('invoice_ref', 'Invoice number', 'KOS/INV/26/0388'), t('po_ref', 'PO number', 'SFSB-PO-2026-0101'), m('amount', 'Amount', rm(3590.4)), t('payment_reference', 'Payment reference', 'IBG2610080733')], []);

/* ---------- Chain 4 — BST, PO-0104: price variance. Quotation, PO and DO only; the invoice is the demo upload (DEMO_INVOICE_1019 in dummy.ts) ---------- */
const qt4 = pdf(F4, '01_Quotation_BST-QT-2609-0193.pdf', 'quotation', [t('quotation_no', 'Quotation number', 'BST-QT-2609-0193'), d('date', 'Date', '2026-09-14'), t('supplier', 'Supplier', BST), d('valid_until', 'Valid until', '2026-10-14'), t('payment_terms', 'Payment term', '30 Days'), ...totals(L4)], L4);
const po4 = pdf(F4, '02_PurchaseOrder_SFSB-PO-2026-0104.pdf', 'purchase_order', [t('po_no', 'PO number', 'SFSB-PO-2026-0104'), d('date', 'Date', '2026-09-17'), t('supplier', 'Supplier', BST), t('quotation_ref', 'Quotation ref.', 'BST-QT-2609-0193'), d('required_date', 'Required date', '2026-09-24'), t('payment_terms', 'Payment term', '30 Days'), ...totals(L4)], L4);
const do4 = pdf(F4, '03_DeliveryOrder_BST-DO-26-0611.pdf', 'delivery_order', [t('do_no', 'DO number', 'BST-DO-26-0611'), d('date', 'Date', '2026-09-24'), t('supplier', 'Supplier', BST), t('po_ref', 'PO number', 'SFSB-PO-2026-0104'), t('delivery_status', 'Delivery status', 'Delivered in full')], items(L4.map(l => [l.description, l.quantity, null])));

/* ---------- Chain 5 — BST, PO-0098: partial delivery (two DOs), two invoices, one payment each ---------- */
const F5 = 'Chain5_BST_SFSB-PO-2026-0098_PartialDelivery';
const PLATE8 = "Mild Steel Plate 8mm x 4' x 8' (S275JR)";
const L5 = items([[PLATE8, 30, rm(690)], ['Galvanised Pipe 1.5" x 6m', 40, rm(98)], ['Channel Bar C100 x 50mm x 6m', 20, rm(210)]]);
const L5a = items([[PLATE8, 18, rm(690)], ['Galvanised Pipe 1.5" x 6m', 40, rm(98)], ['Channel Bar C100 x 50mm x 6m', 20, rm(210)]]);
const L5b = items([[PLATE8, 12, rm(690)]]);
const qt5 = pdf(F5, '01_Quotation_BST-QT-2609-0175.pdf', 'quotation', [t('quotation_no', 'Quotation number', 'BST-QT-2609-0175'), d('date', 'Date', '2026-09-01'), t('supplier', 'Supplier', BST), d('valid_until', 'Valid until', '2026-10-01'), t('payment_terms', 'Payment term', '30 Days'), ...totals(L5)], L5);
const po5 = pdf(F5, '02_PurchaseOrder_SFSB-PO-2026-0098.pdf', 'purchase_order', [t('po_no', 'PO number', 'SFSB-PO-2026-0098'), d('date', 'Date', '2026-09-03'), t('supplier', 'Supplier', BST), t('quotation_ref', 'Quotation ref.', 'BST-QT-2609-0175'), d('required_date', 'Required date', '2026-09-10'), t('payment_terms', 'Payment term', '30 Days'), ...totals(L5)], L5);
const do5a = pdf(F5, '03a_DeliveryOrder_BST-DO-26-0588.pdf', 'delivery_order', [t('do_no', 'DO number', 'BST-DO-26-0588'), d('date', 'Date', '2026-09-10'), t('supplier', 'Supplier', BST), t('po_ref', 'PO number', 'SFSB-PO-2026-0098'), t('delivery_status', 'Delivery status', 'Partial delivery: balance of 12 pcs MS Plate 8mm to follow')], items(L5a.map(l => [l.description, l.quantity, null])));
const do5b = pdf(F5, '03b_DeliveryOrder_BST-DO-26-0612.pdf', 'delivery_order', [t('do_no', 'DO number', 'BST-DO-26-0612'), d('date', 'Date', '2026-09-24'), t('supplier', 'Supplier', BST), t('po_ref', 'PO number', 'SFSB-PO-2026-0098'), t('delivery_status', 'Delivery status', 'Final delivery: PO fully delivered')], items(L5b.map(l => [l.description, l.quantity, null])));
const inv5a = pdf(F5, '04a_Invoice_BST-INV-26-0968.pdf', 'invoice', [t('invoice_no', 'Invoice number', 'BST-INV-26-0968'), d('date', 'Date', '2026-09-10'), t('supplier', 'Supplier', BST), t('po_ref', 'PO number', 'SFSB-PO-2026-0098'), t('do_ref', 'Delivery order', 'BST-DO-26-0588'), d('due_date', 'Due date', '2026-10-10'), t('payment_terms', 'Payment term', '30 Days'), ...totals(L5a)], L5a, 'VERIFIED');
const inv5b = pdf(F5, '04b_Invoice_BST-INV-26-1012.pdf', 'invoice', [t('invoice_no', 'Invoice number', 'BST-INV-26-1012'), d('date', 'Date', '2026-09-24'), t('supplier', 'Supplier', BST), t('po_ref', 'PO number', 'SFSB-PO-2026-0098'), t('do_ref', 'Delivery order', 'BST-DO-26-0612'), d('due_date', 'Due date', '2026-10-24'), t('payment_terms', 'Payment term', '30 Days'), ...totals(L5b)], L5b, 'VERIFIED');
const pa5a = pdf(F5, '05a_PaymentAdvice_SFSB-PA-2026-0071.pdf', 'payment_advice', [t('advice_no', 'Payment advice number', 'SFSB-PA-2026-0071'), d('date', 'Date', '2026-10-07'), t('supplier', 'Supplier', BST), t('invoice_ref', 'Invoice number', 'BST-INV-26-0968'), t('po_ref', 'PO number', 'SFSB-PO-2026-0098'), m('amount', 'Amount', rm(22594)), t('payment_reference', 'Payment reference', 'IBG2610070392')], []);
const pa5b = pdf(F5, '05b_PaymentAdvice_SFSB-PA-2026-0073.pdf', 'payment_advice', [t('advice_no', 'Payment advice number', 'SFSB-PA-2026-0073'), d('date', 'Date', '2026-10-09'), t('supplier', 'Supplier', BST), t('invoice_ref', 'Invoice number', 'BST-INV-26-1012'), t('po_ref', 'PO number', 'SFSB-PO-2026-0098'), m('amount', 'Amount', rm(9108)), t('payment_reference', 'Payment reference', 'IBG2610090615')], []);
const or5a = pdf(F5, '06a_Receipt_BST-OR-26-0389.pdf', 'payment_receipt', [t('receipt_no', 'Receipt number', 'BST-OR-26-0389'), d('date', 'Date', '2026-10-08'), t('supplier', 'Supplier', BST), t('invoice_ref', 'Invoice number', 'BST-INV-26-0968'), t('po_ref', 'PO number', 'SFSB-PO-2026-0098'), m('amount', 'Amount', rm(22594)), t('payment_reference', 'Payment reference', 'IBG2610070392')], []);
const or5b = pdf(F5, '06b_Receipt_BST-OR-26-0394.pdf', 'payment_receipt', [t('receipt_no', 'Receipt number', 'BST-OR-26-0394'), d('date', 'Date', '2026-10-10'), t('supplier', 'Supplier', BST), t('invoice_ref', 'Invoice number', 'BST-INV-26-1012'), t('po_ref', 'PO number', 'SFSB-PO-2026-0098'), m('amount', 'Amount', rm(9108)), t('payment_reference', 'Payment reference', 'IBG2610090615')], []);

/* ---------- Chain 6 — KOS, PO-0097: partial deliveries (two DOs), one invoice, paid in two 50% instalments ---------- */
const F6 = 'Chain6_KOS_SFSB-PO-2026-0097_SplitPayment';
const WS = 'Office Workstation 1200mm L-shape with mobile pedestal';
const CHAIR = 'Ergonomic Mesh Office Chair, high back';
const CAB = '4-Drawer Steel Filing Cabinet';
const L6 = items([[WS, 8, rm(1150)], [CHAIR, 8, rm(385)], [CAB, 4, rm(620)]]);
const TERMS6 = '50% within 14 days, balance within 30 days';
const qt6 = pdf(F6, '01_Quotation_KOS-Q-26-0231.pdf', 'quotation', [t('quotation_no', 'Quotation number', 'KOS/Q/26/0231'), d('date', 'Date', '2026-08-28'), t('supplier', 'Supplier', KOS), d('valid_until', 'Valid until', '2026-09-27'), t('payment_terms', 'Payment term', TERMS6), ...totals(L6)], L6);
const po6 = pdf(F6, '02_PurchaseOrder_SFSB-PO-2026-0097.pdf', 'purchase_order', [t('po_no', 'PO number', 'SFSB-PO-2026-0097'), d('date', 'Date', '2026-09-01'), t('supplier', 'Supplier', KOS), t('quotation_ref', 'Quotation ref.', 'KOS/Q/26/0231'), d('required_date', 'Required date', '2026-09-18'), t('payment_terms', 'Payment term', TERMS6), ...totals(L6)], L6);
const do6a = pdf(F6, '03a_DeliveryOrder_KOS-DO-26-0395.pdf', 'delivery_order', [t('do_no', 'DO number', 'KOS/DO/26/0395'), d('date', 'Date', '2026-09-08'), t('supplier', 'Supplier', KOS), t('po_ref', 'PO number', 'SFSB-PO-2026-0097'), t('delivery_status', 'Delivery status', 'Partial delivery: 8 units workstation on back-order')], items([[CHAIR, 8, null], [CAB, 4, null], [WS, 0, null]]));
const do6b = pdf(F6, '03b_DeliveryOrder_KOS-DO-26-0411.pdf', 'delivery_order', [t('do_no', 'DO number', 'KOS/DO/26/0411'), d('date', 'Date', '2026-09-18'), t('supplier', 'Supplier', KOS), t('po_ref', 'PO number', 'SFSB-PO-2026-0097'), t('delivery_status', 'Delivery status', 'Final delivery: PO fully delivered')], items([[WS, 8, null]]));
const inv6 = pdf(F6, '04_Invoice_KOS-INV-26-0397.pdf', 'invoice', [t('invoice_no', 'Invoice number', 'KOS/INV/26/0397'), d('date', 'Date', '2026-09-18'), t('supplier', 'Supplier', KOS), t('po_ref', 'PO number', 'SFSB-PO-2026-0097'), t('do_ref', 'Delivery orders', 'KOS/DO/26/0395, KOS/DO/26/0411'), d('due_date', 'Due date', '2026-10-18'), t('payment_terms', 'Payment term', TERMS6), t('instalments', 'Instalments', '50% (RM 8,118.00) by 02 Oct 2026; balance by 18 Oct 2026'), ...totals(L6)], L6, 'VERIFIED');
const pa6a = pdf(F6, '05a_PaymentAdvice_SFSB-PA-2026-0069.pdf', 'payment_advice', [t('advice_no', 'Payment advice number', 'SFSB-PA-2026-0069'), d('date', 'Date', '2026-10-02'), t('supplier', 'Supplier', KOS), t('invoice_ref', 'Invoice number', 'KOS/INV/26/0397'), t('po_ref', 'PO number', 'SFSB-PO-2026-0097'), t('instalment', 'Instalment', '1st instalment (50%)'), m('amount', 'Amount', rm(8118)), t('payment_reference', 'Payment reference', 'IBG2610020148')], []);
const pa6b = pdf(F6, '05b_PaymentAdvice_SFSB-PA-2026-0074.pdf', 'payment_advice', [t('advice_no', 'Payment advice number', 'SFSB-PA-2026-0074'), d('date', 'Date', '2026-10-09'), t('supplier', 'Supplier', KOS), t('invoice_ref', 'Invoice number', 'KOS/INV/26/0397'), t('po_ref', 'PO number', 'SFSB-PO-2026-0097'), t('instalment', 'Instalment', '2nd and final instalment (50%)'), m('amount', 'Amount', rm(8118)), t('payment_reference', 'Payment reference', 'IBG2610090877')], []);
const or6a = pdf(F6, '06a_Receipt_KOS-R-26-0284.pdf', 'payment_receipt', [t('receipt_no', 'Receipt number', 'KOS/R/26/0284'), d('date', 'Date', '2026-10-03'), t('supplier', 'Supplier', KOS), t('invoice_ref', 'Invoice number', 'KOS/INV/26/0397'), t('po_ref', 'PO number', 'SFSB-PO-2026-0097'), t('instalment', 'Instalment', '1st instalment (50%)'), m('amount', 'Amount', rm(8118)), t('payment_reference', 'Payment reference', 'IBG2610020148')], []);
const or6b = pdf(F6, '06b_Receipt_KOS-R-26-0296.pdf', 'payment_receipt', [t('receipt_no', 'Receipt number', 'KOS/R/26/0296'), d('date', 'Date', '2026-10-10'), t('supplier', 'Supplier', KOS), t('invoice_ref', 'Invoice number', 'KOS/INV/26/0397'), t('po_ref', 'PO number', 'SFSB-PO-2026-0097'), t('instalment', 'Instalment', '2nd and final instalment (50%)'), m('amount', 'Amount', rm(8118)), t('payment_reference', 'Payment reference', 'IBG2610090877')], []);

/* ---------- Claim receipts (illustrative; no source PDFs) ---------- */
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

/* Pre-loaded set: chains 1, 5 and 6 in full; chain 2 files 01–05 (no receipt yet); chains 3 and 4 files 01–03
   (quotation, PO, DO). The rest are left for upload during the demo. */
export const SEED_DOCS: DocRecord[] = [
  qt1, po1, do1, inv1, pa1, or1,
  qt2, po2, do2, inv2, pa2,
  qt3, po3, do3,
  qt4, po4, do4,
  qt5, po5, do5a, do5b, inv5a, inv5b, pa5a, pa5b, or5a, or5b,
  qt6, po6, do6a, do6b, inv6, pa6a, pa6b, or6a, or6b,
  rcLunch, rcStationery, rcLounge, rcRide,
];

/** Transcribed but not pre-loaded (their PDFs are still in sample-docs): chain 2 receipt, chain 3 invoice, advice and receipt. */
export const NOT_PRELOADED: DocRecord[] = [or2, inv3, pa3, or3];

const link = (src: DocRecord, target: DocRecord, confidence: number, confirmedBy: string | null, relationship: DocLink['relationship'] = 'for_po'): DocLink =>
  ({ id: `LNK-${src.id}-${target.id}`, sourceId: src.id, targetId: target.id, relationship, confidence, confirmedBy });

const QT_REF = 'Quotation ref. on PO';
const PO_REF = 'Explicit PO reference';
const INV_REF = 'Invoice number on document';

/** Every document in a chain points at its PO; a payment advice also settles its invoice. */
const chainLinks = (po: DocRecord, quotes: DocRecord[], dos: DocRecord[], invs: DocRecord[], advices: [DocRecord, DocRecord][], receipts: DocRecord[]): DocLink[] => [
  ...quotes.map(q => link(q, po, 0.97, QT_REF)),
  ...dos.map(x => link(x, po, 0.99, PO_REF)),
  ...invs.map(x => link(x, po, 0.99, PO_REF)),
  ...advices.flatMap(([pa, inv]) => [link(pa, po, 0.99, PO_REF), link(pa, inv, 0.99, INV_REF, 'settles_invoice')]),
  ...receipts.map(x => link(x, po, 0.98, INV_REF)),
];

export const SEED_LINKS: DocLink[] = [
  ...chainLinks(po1, [qt1], [do1], [inv1], [[pa1, inv1]], [or1]),
  ...chainLinks(po2, [qt2], [do2], [inv2], [[pa2, inv2]], []),
  ...chainLinks(po3, [qt3], [do3], [], [], []),
  ...chainLinks(po4, [qt4], [do4], [], [], []),
  ...chainLinks(po5, [qt5], [do5a, do5b], [inv5a, inv5b], [[pa5a, inv5a], [pa5b, inv5b]], [or5a, or5b]),
  ...chainLinks(po6, [qt6], [do6a, do6b], [inv6], [[pa6a, inv6], [pa6b, inv6]], [or6a, or6b]),
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
    employeePurpose: 'Client dinner with Mr Lim to close the Borneo Steel Trading pricing.',
    categoryCode: '6020', categoryConfidence: 0.41, alternativeCodes: ['6040'],
    categoryReasoning: 'Possible entertainment, but the venue and items do not clearly match a business dinner. Low confidence.',
    standardizedDescription: 'Client entertainment with Mr Lim on 9 October 2026 at Neon Lounge Kuching, stated purpose: to close pricing with Borneo Steel Trading.',
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
    id: 'ISS-001', ruleCode: 'CLAIM_PURPOSE', typeLabel: 'Claim purpose concern', severity: 'HIGH', status: 'OPEN',
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
    id: 'ISS-002', ruleCode: 'CLAIM_DATE_MISMATCH', typeLabel: 'Claim date mismatch', severity: 'WARNING', status: 'OPEN',
    docIds: [rcRide.id], claimId: 'CLM-104', title: 'Taxi receipt is dated a day after the trip described',
    detected: 'The employee wrote 6 October; the receipt is dated 7 October 2026.',
    why: 'Receipt date differs from the date in the employee’s statement. It may be a typing error or a different trip.',
    suggested: ['Ask Aisyah Rahman which date is correct and edit the statement if needed.'],
    evidence: [{ label: 'Date', expected: '6 Oct 2026 (statement)', found: '7 Oct 2026 (receipt)' }], createdAt: ts(10, '09:05'),
  },
];

export const SEED_AUDIT: AuditEntry[] = [
  { id: 'A-4', timestamp: ts(10, '08:40'), actor: 'Council of Agents', actorKind: 'agent', action: 'Suggested account 6020 Business Entertainment (78%)', entityId: 'CLM-101' },
  { id: 'A-5', timestamp: ts(7, '14:10'), actor: REVIEWER, actorKind: 'human', action: 'Claim approved', entityId: 'CLM-102', previous: 'PLAUSIBLE', next: 'APPROVED' },
  { id: 'A-6', timestamp: '2026-09-10T16:30:00+08:00', actor: REVIEWER, actorKind: 'human', action: 'Status changed', entityId: inv1.id, previous: 'MATCHED', next: 'VERIFIED' },
  { id: 'A-7', timestamp: '2026-10-09T10:15:00+08:00', actor: 'Purchasing Agent', actorKind: 'agent', action: 'Matched 2 delivery orders and 2 payment advices to SFSB-PO-2026-0098', entityId: po5.id },
  { id: 'A-8', timestamp: '2026-10-09T11:05:00+08:00', actor: 'Purchasing Agent', actorKind: 'agent', action: 'Matched 2 instalment payment advices (50% + 50%) to KOS/INV/26/0397', entityId: inv6.id },
];
