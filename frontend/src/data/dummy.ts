/* ============================================================
   Runtime constants and helpers used by the app.
   No records live here: the app shows only what it retrieves from Supabase
   (state/store.tsx → retrieveRecords). The transcribed test records that were
   imported into Supabase are in data/testdata.ts, which the app never imports.
   ============================================================ */
import type { Account, Field, LineItem } from '../types';

export const SAMPLE_COMPANY = 'Sarawak Fabrication Sdn Bhd';
export const REVIEWER = 'You (finance reviewer)';
export const SAMPLE_DOCS_BASE = '/sample-docs';

export const t = (key: string, label: string, value: string, confidence = 0.97): Field => ({ key, label, kind: 'text', value, confidence });
export const d = (key: string, label: string, value: string, confidence = 0.97): Field => ({ key, label, kind: 'date', value, confidence });
export const m = (key: string, label: string, sen: number, confidence = 0.98): Field => ({ key, label, kind: 'money', value: '', sen, confidence });
export const li = (id: string, description: string, quantity: number, unitSen: number | null): LineItem =>
  ({ id, description, quantity, unitSen, totalSen: unitSen === null ? null : Math.round(quantity * unitSen) });

/** RM amount → integer sen. */
export const rm = (amount: number) => Math.round(amount * 100);
export const items = (rows: [string, number, number | null][]): LineItem[] => rows.map(([desc, qty, unit], i) => li(`l${i + 1}`, desc, qty, unit));
const subtotal = (lines: LineItem[]) => lines.reduce((sum, l) => sum + (l.totalSen ?? 0), 0);
/** Quotation / PO / invoice totals: 10% Sales Tax on the line subtotal, exactly as printed on the PDFs. */
export const totals = (lines: LineItem[]): Field[] => {
  const tax = Math.round(subtotal(lines) * 0.1);
  return [m('tax', 'Sales tax (10%)', tax), m('grand_total', 'Grand total', subtotal(lines) + tax)];
};

export const BST = 'Borneo Steel Trading Sdn Bhd';
export const KOS = 'Kenyalang Office Supplies Sdn Bhd';

/* ---------- Chain 4 — BST, PO-0104: price variance. The invoice (flat bar at RM120.00 vs RM100.00) arrives via the Live Execution demo upload ---------- */
export const F4 = 'Chain4_BST_SFSB-PO-2026-0104_PriceVariance';
export const L4 = items([['Mild Steel Flat Bar 50 x 6mm x 6m', 30, rm(100)], ['Mild Steel Round Bar 16mm x 6m', 50, rm(45)], ["Chequered Plate 4.5mm x 4' x 8'", 6, rm(410)]]);
const L4inv = items([['Mild Steel Flat Bar 50 x 6mm x 6m', 30, rm(120)], ['Mild Steel Round Bar 16mm x 6m', 50, rm(45)], ["Chequered Plate 4.5mm x 4' x 8'", 6, rm(410)]]);
/** BST-INV-26-1019 is the demo upload for Live Execution. When this file is attached the agent reads
    these values (transcribed from the PDF, no OCR is connected), links it to SFSB-PO-2026-0104 and finds the price variance. */
export const DEMO_INVOICE_1019 = {
  fileMatch: /1019/,
  poRef: 'SFSB-PO-2026-0104',
  sourceUrl: `${SAMPLE_DOCS_BASE}/${F4}/04_Invoice_BST-INV-26-1019.pdf`,
  fields: [t('invoice_no', 'Invoice number', 'BST-INV-26-1019'), d('date', 'Date', '2026-09-25'), t('supplier', 'Supplier', BST), t('po_ref', 'PO number', 'SFSB-PO-2026-0104'), t('do_ref', 'Delivery order', 'BST-DO-26-0611'), d('due_date', 'Due date', '2026-10-25'), t('payment_terms', 'Payment term', '30 Days'), ...totals(L4inv)],
  lines: L4inv,
};

export const CHART_OF_ACCOUNTS: Account[] = [
  { code: '6010', name: 'Office Supplies & Stationery', useWhen: 'Consumables used in the office: paper, ink, toner, pens, files, small desk items.' },
  { code: '6020', name: 'Business Entertainment', useWhen: 'Meals, coffee or drinks with someone outside the company: client, customer, prospect, supplier, partner, investor, or a meeting for a deal or collaboration. A discussion or meeting with named people not stated as staff counts as this.' },
  { code: '6030', name: 'Travel & Transport', useWhen: 'Getting somewhere for work: Grab/taxi, fuel, toll, parking, flights, trains, e.g. a ride to a customer site or the airport. The purpose of the trip does not change this account.' },
  { code: '6040', name: 'Staff Welfare', useWhen: 'Spending that benefits employees only: team meals, staff refreshments, birthday or farewell treats, overtime meals. No outside guest present.' },
  { code: '6050', name: 'Software & Subscriptions', useWhen: 'Software licences, SaaS plans, cloud services, app or online subscriptions.' },
  { code: '6060', name: 'Telecommunications', useWhen: 'Phone, mobile and internet: any bill, reload or plan from a telco (Maxis, Digi, CelcomDigi, Unifi, TM, U Mobile, Yes, Hotlink, Tune Talk, Time), broadband, fibre, postpaid or data plans.' },
];
