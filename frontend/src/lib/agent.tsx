import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Claim, DocLink, DocRecord, DocType, Field, Issue, LineItem, Severity } from '../types';
import { CHART_OF_ACCOUNTS, DEMO_INVOICE_1019 } from '../data/dummy';
import { allocIds, useData } from '../state/store';
import { TYPE_CONFIG, chainOf, docAmount, docDate, docNumber, docParty, field, fieldDisplay, lineTotal, poIdOf, repriceInvoice } from './docs';
import { formatDate, formatMoney, humanStatus } from './format';
import { checkInvoice, type Comparison, type IssueDraft } from './verify';
import { request } from './worker-request';

/* Demo agent for the claim and purchasing workflows in Live Execution.
   NOT connected to a backend or OCR: file reading uses PREPARED sample extractions (disclosed in the chat).
   Everything after extraction is real code over the shared record store: arithmetic, PO matching,
   duplicate detection, price/quantity comparison, purpose-vs-receipt rules, persistence and issue creation. */

export type Intent = 'claim' | 'dinner' | 'process' | 'match' | 'compare';
export const STARTERS: { id: Intent; group: 'Claims' | 'Purchasing'; label: string }[] = [
  { id: 'claim', group: 'Claims', label: 'Submit an employee expense claim' },
  { id: 'dinner', group: 'Claims', label: 'Submit a business dinner claim with a receipt' },
  { id: 'process', group: 'Purchasing', label: 'Upload and process a supplier invoice' },
  { id: 'match', group: 'Purchasing', label: 'Match an invoice to its purchase order' },
  { id: 'compare', group: 'Purchasing', label: 'Check a purchase order against an invoice' },
];

export type StageState = 'queued' | 'running' | 'completed' | 'waiting' | 'failed';
export const DEMO_STAGES = ['Receive', 'Read', 'Match', 'Verify', 'Save'] as const;

/** The record's status as shown on its document card; HELD = not saved, waiting for the user's decision. */
export type CardStatus = DocRecord['status'] | 'HELD' | 'PENDING';

export type Card =
  | { type: 'extract'; title: string; fields: { label: string; value: string; low?: boolean }[]; lines: { item: string; qty: number; unit: string; total: string }[]; sample: boolean;
      docLabel?: string; number?: string; party?: string; file?: string; pdf?: string; amounts?: { label: string; value: string; total?: boolean; low?: boolean }[];
      status?: CardStatus; statusNote?: string; warnings?: string[]; source?: 'pdf_text' | 'ocr' }
  | { type: 'links'; title: string; basis: string; confirmed: boolean; chain: { label: string; no: string; here?: boolean }[] }
  | { type: 'compare'; po: string; rows: Comparison[] }
  | { type: 'claim'; purpose: string; plausibility: 'PLAUSIBLE' | 'NEEDS_REVIEW'; findings: string[]; category: string; confidence: number; reasoning: string; description: string }
  | { type: 'findings'; items: { id?: string; severity: Severity; title: string; typeLabel: string }[]; human: boolean }
  | { type: 'council'; purpose: string; result: CouncilResult }
  | { type: 'saved'; lines: string[]; hideActionItems?: boolean }
  | { type: 'alert'; title: string; lines: string[] }
  | { type: 'lookup'; query: string; poId: string; poNo: string; supplier: string; date: string; total: string; chain: { id: string; label: string; no: string; date: string; amount: string; status: string; pdf?: string; hit: boolean }[]; issues: { severity: Severity; title: string; status: string }[] }
  | { type: 'fix'; title: string; rows: { item: string; from: string; to: string }[]; lines: string[] };

/** The record the agent is holding back until the user picks Fix now or Review later. Kept on the message so it survives a reload. */
export interface FixContext { stepsId: string; cardId?: string; invoiceNo: string; poNo: string; varianceId: string; prices: Record<string, number>; bundle: { doc: DocRecord; links: DocLink[]; issues: Issue[] } }

export type Msg =
  | { id: string; kind: 'user'; text: string; files: string[] }
  | { id: string; kind: 'agent'; text: string; to?: string; action?: string; hash?: string }
  | { id: string; kind: 'quick'; options: { id: string; label: string }[]; used?: boolean; prompt?: string; ctx?: FixContext }
  | { id: string; kind: 'steps'; steps: { label: string; state: 'done' | 'running' | 'queued' }[] }
  | { id: string; kind: 'card'; card: Card };

const TOTAL_KEYS = new Set(['grand_total', 'total', 'amount']);
/** The document card shown after reading a file: number, party and status in the header, then facts, lines and totals. */
function docCard(doc: DocRecord, title: string, sample = true, warnings: string[] = [], source?: ReadDocument['source']): Extract<Card, { type: 'extract' }> {
  const number = docNumber(doc); const party = docParty(doc);
  const low = (f: Field) => (f.confidence ?? 1) < 0.7;
  const money = doc.fields.filter(f => f.kind === 'money');
  const priced = doc.lines.filter(l => l.totalSen !== null);
  type Amount = NonNullable<Extract<Card, { type: 'extract' }>['amounts']>[number];
  const subtotal: Amount[] = priced.length && money.some(f => f.key === 'tax') ? [{ label: 'Subtotal', value: formatMoney(priced.reduce((s, l) => s + (l.totalSen ?? 0), 0)) }] : [];
  const amounts: Amount[] = [...subtotal, ...money.map(f => ({ label: f.label, value: fieldDisplay(f), total: TOTAL_KEYS.has(f.key), low: low(f) }))]
    .sort((a, b) => Number(Boolean(a.total)) - Number(Boolean(b.total)));
  return {
    type: 'extract', title, sample, warnings, source, docLabel: TYPE_CONFIG[doc.docType].label, number, party, file: doc.filename, pdf: doc.sourceUrl,
    fields: doc.fields.filter(f => f.kind !== 'money' && fieldDisplay(f) !== number && fieldDisplay(f) !== party).map(f => ({ label: f.label, value: fieldDisplay(f), low: low(f) })),
    amounts,
    lines: doc.lines.map(l => ({ item: l.description, qty: l.quantity, unit: l.unitSen === null ? '—' : formatMoney(l.unitSen), total: l.totalSen === null ? '—' : formatMoney(l.totalSen) })),
    status: 'EXTRACTED', statusNote: 'Fields read from the document',
  };
}

interface Flow { intent: Intent | null; stage: 'ask_purpose' | 'ask_file' | 'processing' | 'idle'; purpose?: string }
export interface ChatSummary { id: string; title: string; at: string; count: number; current: boolean }
interface Chat { id: string; at: string; messages: Msg[]; flow: Flow }
const CHATS_KEY = 'tutupbuku.chats.v1';
const blank = (): Chat => ({ id: Math.random().toString(36).slice(2, 10), at: new Date().toISOString(), messages: [], flow: { intent: null, stage: 'idle' } });
// A reload cannot resume a half-finished step animation, so a step that was running is shown as not done.
const settle = (m: Msg): Msg => (m.kind === 'steps' ? { ...m, steps: m.steps.map(x => (x.state === 'running' ? { ...x, state: 'queued' as const } : x)) } : m);
function loadChats(): { chats: Chat[]; activeId: string } {
  let saved: Chat[] = [];
  try { const raw = window.localStorage.getItem(CHATS_KEY); if (raw) { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) saved = parsed.filter((c: Chat) => c && Array.isArray(c.messages)).map((c: Chat) => ({ ...c, messages: c.messages.map(settle) })); } } catch { /* history unavailable */ }
  const fresh = blank();
  return { chats: [...saved, fresh], activeId: fresh.id };   // every visit starts a new chat; earlier ones are in History
}
const titleOf = (c: Chat) => { const first = c.messages.find(m => m.kind === 'user') as Extract<Msg, { kind: 'user' }> | undefined; return (first?.text || first?.files[0] || 'New chat').slice(0, 70); };
const stagesFor = (messages: Msg[]): StageState[] => {
  const last = [...messages].reverse().find(m => m.kind === 'steps') as Extract<Msg, { kind: 'steps' }> | undefined;
  return DEMO_STAGES.map(() => (last && last.steps.every(x => x.state === 'done') ? 'completed' : 'queued'));
};

interface AgentApi {
  chats: ChatSummary[]; activeId: string; newChat: () => void; openChat: (id: string) => void; deleteChat: (id: string) => void;
  messages: Msg[]; stages: StageState[]; busy: boolean; active: boolean; stamp: number;
  startIntent: (id: Intent) => void;
  send: (text: string, files: File[]) => void;
  reply: (prompt: string, text: string, link?: { to?: string; hash?: string; action: string }) => void;
  choose: (msgId: string, optionId: string) => void;
}
const Ctx = createContext<AgentApi | null>(null);
const sleep = (ms: number) => new Promise(r => window.setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 10);

export async function sha256(file: File) {
  try { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16); }
  catch { return `unhashed-${file.size}`; }
}

const t = (key: string, label: string, value: string, confidence = 0.97): Field => ({ key, label, kind: 'text', value, confidence });
const d = (key: string, label: string, value: string, confidence = 0.97): Field => ({ key, label, kind: 'date', value, confidence });
const m = (key: string, label: string, sen: number, confidence = 0.98): Field => ({ key, label, kind: 'money', value: '', sen, confidence });
const li = (id: string, description: string, quantity: number, unitSen: number | null): LineItem => ({ id, description, quantity, unitSen, totalSen: lineTotal(quantity, unitSen) });

/* ---------------- prepared sample extractions ---------------- */
/** A document read from the file itself by the backend (/api/extract: PDF text layer, classified and parsed). */
export interface ReadDocument { doc_type: DocType; fields: Field[]; lines: LineItem[]; warnings: string[]; source?: 'pdf_text' | 'ocr' }
type ReadResult = { ok: true; doc: ReadDocument } | { ok: false; error: string };

/** Send the file to the backend to be read: a PDF's text layer, or OCR (Tesseract) for a photo or scan. */
export async function readDocument(file: File): Promise<ReadResult> {
  if (!/\.(pdf|jpe?g|png|webp|gif|bmp|tiff?)$/i.test(file.name)) return { ok: false, error: 'only PDFs and images can be read' };
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const doc = await request<ReadDocument>('/api/extract', { filename: file.name, content_base64: btoa(binary) });
    return { ok: true, doc };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** The claim council's answer (backend tutupbuku/council.py): 3 members, anonymous peer ranking, chairman. */
export interface CouncilOpinion { member: string; name: string; recommendation: 'approve' | 'reject' | 'needs_info'; account_code: string | null; confidence: 'high' | 'medium' | 'low'; reasoning: string; concerns: string[] }
export interface CouncilResult {
  council_id: string; opinions: CouncilOpinion[]; agreement: 'unanimous' | 'majority' | 'split'; notes: string[]; calls: number; seconds: number;
  reviews: { member: string; name: string; ranking: string[]; critique: string; ranked_own_first?: boolean }[];
  ranking: { response: string; member: string; average_position: number | null; votes: number }[];
  chair: { recommendation: CouncilOpinion['recommendation']; account_code: string | null; confidence: CouncilOpinion['confidence']; reasoning: string; standard_description: string; question_for_reviewer: string; source?: 'chair' | 'computed' };
}

/** Ask the claim council through the backend. It takes 7 gateway calls, so it can run for a minute or two. */
async function runCouncil(employee: string, purpose: string, receipt: DocRecord): Promise<{ ok: true; result: CouncilResult } | { ok: false; error: string }> {
  const money = (sen: number | null) => (sen === null ? '' : (sen / 100).toFixed(2));
  const claim = { employee, purpose, receipt: { merchant: docParty(receipt), date: docDate(receipt), total_myr: money(docAmount(receipt)), tax_myr: money(field(receipt, 'tax')?.sen ?? null), reference: docNumber(receipt),
    items: receipt.lines.map(l => ({ description: l.description, quantity: l.quantity, total_myr: money(l.totalSen) })) } };
  try {
    const result = await request<CouncilResult>('/api/claims/council', { claim, accounts: CHART_OF_ACCOUNTS });
    if (!result || !Array.isArray(result.opinions) || !result.chair) return { ok: false, error: 'the service returned an invalid council response' };
    return { ok: true, result };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

const CONFIDENCE_SCORE = { high: 0.9, medium: 0.7, low: 0.45 } as const;
/** Turn the council's answer into the claim's suggestion; the deterministic date check is kept. */
function fromCouncil(c: CouncilResult, rules: ClaimAnalysis): ClaimAnalysis {
  const concerns = [...new Set(c.opinions.flatMap(o => o.concerns))];
  const rec = c.chair.recommendation;
  return {
    plausibility: rec === 'approve' && c.agreement !== 'split' ? 'PLAUSIBLE' : 'NEEDS_REVIEW',
    severity: rec === 'reject' ? 'HIGH' : rec === 'needs_info' || c.agreement === 'split' ? 'WARNING' : null,
    findings: [...(c.chair.question_for_reviewer ? [c.chair.question_for_reviewer] : []), ...concerns, ...(rules.dateMismatch ? [rules.dateMismatch] : [])].slice(0, 6),
    categoryCode: c.chair.account_code, confidence: CONFIDENCE_SCORE[c.chair.confidence], reasoning: c.chair.reasoning,
    description: c.chair.standard_description || rules.description, dateMismatch: rules.dateMismatch,
  };
}

interface Sample { fields: Field[]; lines: LineItem[]; poRef: string | null }
function purchasingSample(type: DocType, intent: Intent | null): Sample {
  if (type === 'invoice') {
    if (intent === 'match') return { poRef: 'SFSB-PO-2026-0101', lines: [li('l1', 'Ballpoint Pen, Blue (box of 50)', 5, 3200)],
      fields: [t('invoice_no', 'Invoice number', 'KOS/INV/26/0412'), d('date', 'Date', '2026-10-10'), t('supplier', 'Supplier', 'Kenyalang Office Supplies Sdn Bhd'), d('due_date', 'Due date', '2026-11-09'), t('payment_terms', 'Payment term', '30 Days'), m('grand_total', 'Grand total', 16000)] };
    if (intent === 'compare') return { poRef: 'SFSB-PO-2026-0087', lines: [li('l1', "Mild Steel Plate 6mm x 4' x 8' (S275JR)", 20, 54000), li('l2', 'Equal Angle Bar 50 x 50 x 5mm x 6m', 40, 6850)],
      fields: [t('invoice_no', 'Invoice number', 'BST-INV-26-1031'), d('date', 'Date', '2026-10-10'), t('supplier', 'Supplier', 'Borneo Steel Trading Sdn Bhd'), d('due_date', 'Due date', '2026-11-09'), t('payment_terms', 'Payment term', '30 Days'), m('grand_total', 'Grand total', 1354000)] };
    return { poRef: null, lines: [li('l1', 'Desk lamp, LED', 4, 32000)],
      fields: [t('invoice_no', 'Invoice number', 'INV-SOH-5530'), d('date', 'Date', '2026-10-09', 0.6), t('supplier', 'Supplier', 'Sarawak Office Hub'), d('due_date', 'Due date', '2026-11-08'), t('payment_terms', 'Payment term', '30 Days'), m('grand_total', 'Grand total', 128000)] };
  }
  if (type === 'delivery_order') return { poRef: 'SFSB-PO-2026-0101', lines: [li('l1', 'Ballpoint Pen, Blue (box of 50)', 5, null)],
    fields: [t('do_no', 'DO number', 'KOS/DO/26/0415'), d('date', 'Date', '2026-10-08'), t('supplier', 'Supplier', 'Kenyalang Office Supplies Sdn Bhd'), t('delivery_status', 'Delivery status', 'Delivered in full')] };
  if (type === 'payment_advice') return { poRef: 'SFSB-PO-2026-0101', lines: [],
    fields: [t('advice_no', 'Payment advice number', 'SFSB-PA-2026-0080'), d('date', 'Date', '2026-10-10'), t('supplier', 'Supplier', 'Kenyalang Office Supplies Sdn Bhd'), m('amount', 'Amount', 16000), t('payment_reference', 'Payment reference', 'SFSB-PO-2026-0101')] };
  if (type === 'payment_receipt') return { poRef: 'SFSB-PO-2026-0101', lines: [],
    fields: [t('receipt_no', 'Receipt number', 'KOS/R/26/0302'), d('date', 'Date', '2026-10-10'), t('supplier', 'Supplier', 'Kenyalang Office Supplies Sdn Bhd'), m('amount', 'Amount', 16000)] };
  if (type === 'quotation') return { poRef: 'SFSB-PO-2026-0101', lines: [li('l1', 'Ballpoint Pen, Blue (box of 50)', 5, 3200)],
    fields: [t('quotation_no', 'Quotation number', 'KOS/Q/26/0240'), d('date', 'Date', '2026-09-28'), t('supplier', 'Supplier', 'Kenyalang Office Supplies Sdn Bhd'), m('grand_total', 'Grand total', 16000)] };
  return { poRef: null, lines: [li('l1', 'Desk lamp, LED', 4, 32000)],
    fields: [t('po_no', 'PO number', 'SFSB-PO-2026-0131'), d('date', 'Date', '2026-10-09'), t('supplier', 'Supplier', 'Sarawak Office Hub'), m('grand_total', 'Grand total', 128000)] };
}
/** A file whose name says it is a supplier document is treated as purchasing without asking. */
const looksPurchasing = (name: string) => /invoice|quotation|purchase[ _-]?order|delivery[ _-]?order|payment[ _-]?advice|\b(bst|kos|sfsb)[-_/]|\binv[-_]|\bpo[-_]|\bdo[-_]/i.test(name);
function docTypeFor(name: string): DocType {
  const n = name.toLowerCase();
  if (/quot|\bqt\b|qt-/.test(n)) return 'quotation';
  if (/purchase|\bpo\b|po-/.test(n)) return 'purchase_order';
  if (/deliver|\bdo\b|do-/.test(n)) return 'delivery_order';
  if (/advice|remit/.test(n)) return 'payment_advice';
  if (/receipt|payment/.test(n)) return 'payment_receipt';
  return 'invoice';
}

type ReceiptKind = 'dinner' | 'lunch' | 'ride' | 'stationery' | 'lounge';
const RECEIPTS: Record<ReceiptKind, { fields: Field[]; lines: LineItem[] }> = {
  dinner: { fields: [t('receipt_ref', 'Receipt reference', 'SK-77310'), d('date', 'Date', '2026-10-09'), t('merchant', 'Merchant', 'Selera Kuching Seafood'), m('total', 'Total', 28640)],
    lines: [li('l1', 'Seafood set menu', 4, 5800), li('l2', 'Soft drinks', 4, 450), li('l3', 'Steamed fish', 1, 3640)] },
  lunch: { fields: [t('receipt_ref', 'Receipt reference', 'EC-004302'), d('date', 'Date', '2026-10-08'), t('merchant', 'Merchant', 'Example Cafe'), m('total', 'Total', 8650), m('tax', 'Service tax', 490, 0.9)],
    lines: [li('l1', 'Set lunch', 3, 2400), li('l2', 'Iced drinks', 3, 600), li('l3', 'Dessert platter', 1, 1000)] },
  ride: { fields: [t('receipt_ref', 'Receipt reference', 'GRB-B1042'), d('date', 'Date', '2026-10-10'), t('merchant', 'Merchant', 'Grab'), m('total', 'Total', 4200)], lines: [li('l1', 'Ride Kuching City – Airport', 1, 4200)] },
  stationery: { fields: [t('receipt_ref', 'Receipt reference', 'KSC-88231'), d('date', 'Date', '2026-10-10'), t('merchant', 'Merchant', 'Kuching Stationery Centre'), m('total', 'Total', 9650)],
    lines: [li('l1', 'A4 paper, ream', 3, 1590), li('l2', 'Ink cartridge', 1, 4880)] },
  lounge: { fields: [t('receipt_ref', 'Receipt reference', 'NL-20977'), d('date', 'Date', '2026-10-10'), t('merchant', 'Merchant', 'Neon Lounge Kuching'), m('total', 'Total', 38800)],
    lines: [li('l1', 'Private room, 2 hrs', 1, 12000), li('l2', 'Beer tower', 2, 9800), li('l3', 'Bar snacks platter', 1, 7200)] },
};
function pickReceipt(intent: Intent | null, purpose: string, filename: string): ReceiptKind {
  const text = `${filename} ${purpose}`.toLowerCase();
  if (/lounge|\bbar\b|beer|karaoke/.test(filename.toLowerCase())) return 'lounge';
  if (/grab|taxi|ride|airport/.test(text)) return 'ride';
  if (/stationery|paper|toner|ink|print/.test(text)) return 'stationery';
  if (intent === 'dinner' || /dinner/.test(text)) return 'dinner';
  return 'lunch';
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const longDate = (iso: string) => `${Number(iso.slice(8))} ${MONTHS[Number(iso.slice(5, 7)) - 1].replace(/^./, c => c.toUpperCase())} ${iso.slice(0, 4)}`;
interface ClaimAnalysis { plausibility: 'PLAUSIBLE' | 'NEEDS_REVIEW'; findings: string[]; severity: Severity | null; categoryCode: string | null; confidence: number; reasoning: string; description: string; dateMismatch: string | null }
function analyseClaim(purpose: string, receipt: DocRecord): ClaimAnalysis {
  const p = purpose.toLowerCase();
  const items = receipt.lines.map(l => l.description.toLowerCase()).join(' | ');
  const seen = `${items} ${docParty(receipt).toLowerCase()}`;
  const alcohol = /beer|wine|whisky|liquor|tower|cocktail/.test(items);
  const venue = /\broom\b|lounge|karaoke/.test(seen);
  const food = /set|lunch|dinner|meal|platter|drink|fish|rice|dessert|coffee|kopi|latte|espresso|americano|cappuccino|mocha|\btea\b|cake|croissant|sandwich|cafe|café|restaurant|kopitiam|bakery|zus|starbucks/.test(seen) && !alcohol;
  const transport = /\bride|taxi|grab|\btrip|\bfare\b|toll|parking|fuel|petrol|diesel|flight/.test(seen); const supplies = /paper|toner|ink|cartridge/.test(items);
  // Who benefited decides between entertainment and staff welfare; the receipt decides the kind of expense.
  const attendees = /\bwith ((?:(?!\b(?:to|for|about|regarding|on|at)\b)[^,.;])+)/i.exec(purpose)?.[1]?.trim();
  const STAFF = /\bstaff|\bteam\b|employee|colleague|department|\bmy (?:manager|boss|supervisor)|\bhr\b|birthday|farewell|appreciation|overtime/;
  const staff = STAFF.test(p);
  // Anyone named who is not stated as staff is treated as an outside guest.
  const external = /client|customer|prospect|partner|supplier|vendor|investor|collaborat|\bdeal\b|pitch/.test(p) || /\bfrom [A-Z]/.test(purpose) || (!!attendees && !STAFF.test(attendees.toLowerCase()));
  const meeting = /meeting|\bmeet\b|\bmet\b|discuss|catch ?up|consult|negotiat|presentation|briefing/.test(p);
  // A telco merchant or bill decides the account on its own, whatever else the purpose says.
  const TELCO = /\bmaxis\b|\bdigi\b|celcom|\bunifi\b|telekom|\btm ?net\b|u ?mobile|\byes ?[45]g\b|ytl comm|hotlink|tune ?talk|redone|\bxox\b|time ?dotcom|time (?:fibre|internet)|\btelco\b|telecom|phone bill|mobile bill|internet bill|wifi bill|postpaid|prepaid|\breload\b|broadband|\bfibre\b|data plan/;
  const telco = TELCO.test(seen) || TELCO.test(p);
  const wants: 'meal' | 'transport' | 'supplies' | 'telco' | null =
    telco ? 'telco'
    : /taxi|grab|\bride\b|airport|travel|site visit|\bsite\b|parking|toll|petrol|fuel|mileage|flight/.test(p) ? 'transport'
    : /lunch|dinner|breakfast|brunch|meal|coffee|\btea\b|drinks|treat|entertain|makan/.test(p) ? 'meal'
    : /paper|toner|stationery|print|ink|office suppl/.test(p) ? 'supplies'
    : (external || staff || meeting) ? (transport ? 'transport' : supplies ? 'supplies' : 'meal') : null;
  const findings: string[] = []; let plausibility: 'PLAUSIBLE' | 'NEEDS_REVIEW' = 'PLAUSIBLE'; let severity: Severity | null = null;
  if (purpose.trim().length < 12) { plausibility = 'NEEDS_REVIEW'; severity = 'WARNING'; findings.push('The stated purpose is too short to check against the receipt.'); }
  else if (wants === 'meal') {
    if (alcohol || venue) { plausibility = 'NEEDS_REVIEW'; severity = 'HIGH'; findings.push(`The stated purpose is a meal, but the receipt lists ${alcohol ? 'alcohol' : 'a venue charge'}${venue ? ' and a room/venue charge' : ''} rather than a meal.`); }
    else if (food) findings.push('Receipt items are food and drink, consistent with a meal.');
    else { plausibility = 'NEEDS_REVIEW'; severity = 'WARNING'; findings.push('Receipt items do not clearly show a meal.'); }
  } else if (wants === 'transport') { if (transport) findings.push('Receipt is a ride, consistent with the stated travel.'); else { plausibility = 'NEEDS_REVIEW'; severity = 'WARNING'; findings.push('Receipt items do not show transport.'); } }
  else if (wants === 'supplies') { if (supplies) findings.push('Receipt items are office supplies, consistent with the stated purpose.'); else { plausibility = 'NEEDS_REVIEW'; severity = 'WARNING'; findings.push('Receipt items do not show office supplies.'); } }
  else if (wants === 'telco') { if (TELCO.test(seen)) findings.push(`The receipt is from a telco or for a phone/internet service (${docParty(receipt)}).`); else { plausibility = 'NEEDS_REVIEW'; severity = 'WARNING'; findings.push('The purpose mentions a telco or phone/internet bill, but the receipt does not show one.'); } }
  else { plausibility = 'NEEDS_REVIEW'; severity = 'WARNING'; findings.push('The purpose does not say what kind of expense this is, so it cannot be tested against the receipt.'); }
  if (wants === 'meal') findings.push(attendees ? `Attendees stated by the employee: ${attendees}.` : 'No attendees were stated and none were assumed.');
  const dm = new RegExp(`(\\d{1,2})\\s+(${MONTHS.join('|')})`, 'i').exec(purpose);
  let dateMismatch: string | null = null;
  if (dm) { const [, day, month] = dm; const rd = docDate(receipt); if (Number(rd.slice(8)) !== Number(day) || MONTHS[Number(rd.slice(5, 7)) - 1] !== month.toLowerCase()) { dateMismatch = `Statement: ${day} ${month}; receipt: ${formatDate(rd)}.`; findings.push(`Receipt date differs from the date in the statement (${dateMismatch}).`); } }
  findings.push('A receipt cannot independently prove that a business purpose or meeting took place.');
  const categoryCode: string | null = wants === 'meal' ? (external ? '6020' : '6040') :wants === 'transport' ? '6030' : wants === 'supplies' ? '6010' : wants === 'telco' ? '6060' : null;
  let confidence = categoryCode === '6060' ? 0.92 :categoryCode === '6020' ? (food ? 0.85 : 0.7) : categoryCode === '6040' ? (staff ? 0.8 : 0.5) : categoryCode === '6030' ? 0.88 : categoryCode === '6010' ? 0.93 : 0;
  if (plausibility === 'NEEDS_REVIEW' && categoryCode) confidence = Math.min(confidence, 0.41);
  if (wants === 'meal' && !external && !staff && !attendees) findings.push('Nobody was named, so it is unclear whether this was a client meal or a staff meal.');
  const account = CHART_OF_ACCOUNTS.find(a => a.code === categoryCode);
  const why = categoryCode === '6020' ? (attendees && !/client|customer|prospect|partner|supplier|vendor|investor/.test(p) ? `a meeting with ${attendees}, who is not stated as staff` : 'a meal or drinks with someone outside the company') : categoryCode === '6040' ? (staff ? 'a meal for staff only' : 'a meal with no outside guest named') : categoryCode === '6030' ? 'transport, whatever the trip was for' : categoryCode === '6010' ? 'office consumables' : categoryCode === '6060' ? 'a phone, mobile or internet charge from a telco' : '';
  const reasoning = account ? `Suggested because this looks like ${why}${plausibility === 'NEEDS_REVIEW' ? '; low confidence because the receipt does not clearly support the purpose' : ''}. Subject to company policy.` : 'No account could be suggested from the information given.';
  const kind = wants === 'meal' ? (/dinner/.test(p) ? 'Business dinner' : /lunch/.test(p) ? 'Business lunch' : /coffee/.test(p) ? 'Coffee meeting' : meeting ? 'Business meeting' : categoryCode === '6040' ? 'Staff meal' : 'Business meal') : wants === 'transport' ? 'Ride-hailing' : wants === 'supplies' ? 'Office supplies purchase' : wants === 'telco' ? 'Telecommunications charge' : 'Expense';
  const clause = /\b((?:to|for)\s+.+?)[.]?$/i.exec(purpose)?.[1];
  const description = `${kind}${attendees ? ` with ${attendees}` : ''} on ${longDate(docDate(receipt))} at ${docParty(receipt)}${clause ? `, ${clause}` : ''}.`;
  return { plausibility, findings, severity, categoryCode, confidence, reasoning, description, dateMismatch };
}

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const data = useData();
  const [store, setStore] = useState(loadChats);
  const activeRef = useRef(store.activeId);
  activeRef.current = store.activeId;
  const messages = (store.chats.find(c => c.id === store.activeId) ?? store.chats[0]).messages;
  // Appends always go to the chat that is active; switching chats is blocked while the agent is working.
  const setMessages = useCallback((fn: (items: Msg[]) => Msg[]) => setStore(st => ({ ...st, chats: st.chats.map(c => (c.id === activeRef.current ? { ...c, messages: fn(c.messages) } : c)) })), []);
  const [stages, setStages] = useState<StageState[]>(DEMO_STAGES.map(() => 'queued'));
  const [busy, setBusy] = useState(false);
  const [stamp, setStamp] = useState(0);
  const messagesRef = useRef<Msg[]>(messages);
  messagesRef.current = messages;
  const flow = useRef<Flow>({ intent: null, stage: 'idle' });
  const pendingFile = useRef<File | null>(null);
  const add = useCallback((msg: Msg) => setMessages(items => [...items, msg]), []);
  const say = useCallback((text: string, extra: Partial<Extract<Msg, { kind: 'agent' }>> = {}) => add({ id: uid(), kind: 'agent', text, ...extra }), [add]);
  const setStage = (i: number, s: StageState) => setStages(cur => cur.map((x, k) => (k === i ? s : x)));
  const touch = () => setStamp(Date.now());
  /** Move the document card's status along as the steps finish. */
  const setCardStatus = (id: string | undefined, status: CardStatus, statusNote: string) => id && setMessages(items => items.map(x =>
    (x.id === id && x.kind === 'card' && x.card.type === 'extract' ? { ...x, card: { ...x.card, status, statusNote } } : x)));

  useEffect(() => {
    try {
      const keep = store.chats.filter(c => c.messages.length).map(c => (c.id === store.activeId ? { ...c, flow: flow.current } : c));
      window.localStorage.setItem(CHATS_KEY, JSON.stringify(keep.slice(-40)));
    } catch { /* storage unavailable: history lasts for this session only */ }
  }, [store]);

  const switchTo = (id: string, chats: Chat[]) => {
    const target = chats.find(c => c.id === id)!;
    flow.current = target.flow.stage === 'processing' ? { ...target.flow, stage: 'idle' } : target.flow;
    pendingFile.current = null;
    activeRef.current = id;
    setStore({ chats, activeId: id });
    setStages(stagesFor(target.messages));
    touch();
  };
  const withFlow = (chats: Chat[]) => chats.map(c => (c.id === store.activeId ? { ...c, flow: flow.current } : c));
  const newChat = () => {
    if (busy) return;
    if (!messages.length) return;
    const fresh = blank();
    switchTo(fresh.id, [...withFlow(store.chats), fresh]);
  };
  const openChat = (id: string) => { if (busy || id === store.activeId || !store.chats.some(c => c.id === id)) return; switchTo(id, withFlow(store.chats)); };
  const deleteChat = (id: string) => {
    if (busy) return;
    const rest = store.chats.filter(c => c.id !== id);
    if (id !== store.activeId) { setStore({ ...store, chats: rest }); return; }
    const fresh = blank(); switchTo(fresh.id, [...rest, fresh]);
  };

  const run = useCallback(async (file: File, pre?: ReadResult) => {
    const intent = flow.current.intent; const purpose = flow.current.purpose ?? '';
    flow.current = { ...flow.current, stage: 'processing' }; setBusy(true); setStages(DEMO_STAGES.map(() => 'queued'));
    // Duplicate checks compare against the saved records; say so when they could not be loaded instead of passing silently.
    if (!data.storage.ok) say(`Warning: your saved records could not be loaded from Supabase${data.storage.message ? ` (${data.storage.message})` : ''}. I cannot check this file for duplicates, and nothing will be saved until the connection is back. Use Retry on the Documents page when you are online.`);
    const claims = intent === 'claim' || intent === 'dinner';
    const labels = claims ? ['Receive the receipt', 'Read merchant, date and amount', 'Claim council: 3 members, peer review, chairman', 'Verify and look for issues', 'Save the claim'] : ['Receive the document', 'Read the fields', 'Link to purchase order', 'Verify prices, quantities and duplicates', 'Save the record'];
    const stepsId = uid();
    const steps = (done: number) => ({ id: stepsId, kind: 'steps' as const, steps: labels.map((label, i) => ({ label, state: i < done ? 'done' as const : i === done ? 'running' as const : 'queued' as const })) });
    add(steps(0)); const update = (done: number) => setMessages(items => items.map(x => x.id === stepsId ? steps(done) : x));
    // advance(i) finishes step i and then lets step i+1 "work" for a realistic while before its result is shown.
    const STEP_MS = [0, 3600, 2800, 3200, 1800];
    const advance = async (i: number) => { setStage(i, 'completed'); if (i < 4) setStage(i + 1, 'running'); update(i + 1); await sleep(i < 4 ? Math.round(STEP_MS[i + 1] * (0.85 + Math.random() * 0.3)) : 700); };
    try {
      // Saved records are never deleted by a new upload: uploading the same invoice again is flagged as a duplicate
      // by the checks, and Fix now / Review later refuses to save an invoice number that is already on file.
      setStage(0, 'running'); touch();
      await sleep(900);
      const hash = await sha256(file); await sleep(1400); await advance(0);
      const { docs, links, claims: allClaims, issues } = data.latest.current;
      const draftIssues: { draft: IssueDraft; docIds?: string[] }[] = [];
      const newDocIds = allocIds('DOC', docs.map(x => x.id), 1);
      const issueIds = (n: number) => allocIds('ISS', issues.map(x => x.id), n);
      const base = { filename: file.name, hash, version: 1, uploadedAt: new Date().toISOString(), uploadedBy: claims ? 'Demo employee' : 'You (demo user)' };
      const dupFile = docs.find(x => x.hash === hash && x.status !== 'REJECTED');

      if (claims) {
        // Read the receipt itself (OCR for photos, text for PDFs); prepared sample values only when that is impossible.
        const read = pre ?? await readDocument(file);
        const real = read.ok && read.doc.doc_type === 'claim_receipt' ? read.doc : null;
        const tpl = real ? { fields: real.fields, lines: real.lines } : RECEIPTS[pickReceipt(intent, purpose, file.name)];
        if (!real && !pre) say(`I could not read the receipt itself (${read.ok ? 'it reads as a purchasing document' : read.error}), so I am using prepared sample values.`);
        const receipt: DocRecord = { id: newDocIds[0], docType: 'claim_receipt', flow: 'claims', status: 'EXTRACTED', fields: tpl.fields, lines: tpl.lines, ...base };
        const cardId = uid();
        add({ id: cardId, kind: 'card', card: docCard(receipt, 'Read from the receipt', !real, real?.warnings ?? [], real?.source) });
        await advance(1);
        const rules = analyseClaim(purpose, receipt);   // deterministic: date mismatch, and the fallback when the council is unreachable
        setCardStatus(cardId, 'EXTRACTED', 'Receipt read · the claim council is reviewing it');
        const council = await runCouncil('Demo employee', purpose, receipt);
        const a: ClaimAnalysis = council.ok ? fromCouncil(council.result, rules) : rules;
        if (council.ok) add({ id: uid(), kind: 'card', card: { type: 'council', purpose, result: council.result } });
        else {
          say(`The claim council could not be reached (${council.error}), so I used the built-in rule check instead.`);
          add({ id: uid(), kind: 'card', card: { type: 'claim', purpose, plausibility: a.plausibility, findings: a.findings, category: CHART_OF_ACCOUNTS.find(x => x.code === a.categoryCode) ? `${a.categoryCode} · ${CHART_OF_ACCOUNTS.find(x => x.code === a.categoryCode)!.name}` : 'No suggestion', confidence: a.confidence, reasoning: a.reasoning, description: a.description } });
        }
        setCardStatus(cardId, 'EXTRACTED', a.plausibility === 'PLAUSIBLE' ? 'Receipt supports the stated purpose' : 'Purpose needs a closer look');
        await advance(2);
        const claimId = allocIds('CLM', allClaims.map(x => x.id), 1)[0];
        const sum = tpl.lines.reduce((s, l) => s + (l.totalSen ?? 0), 0);
        if (Math.abs(sum - (docAmount(receipt) ?? 0)) > 1) draftIssues.push({ draft: { ruleCode: 'TOTAL_MISMATCH', typeLabel: 'Amount mismatch', severity: 'WARNING', docIds: [receipt.id], claimId, title: 'Receipt lines do not add up to the total', detected: 'Sum of line totals differs from the receipt total.', why: 'Totals must add up within rounding tolerance.', suggested: ['Compare with the receipt image.'], evidence: [{ label: 'Sum of lines', expected: formatMoney(sum), found: formatMoney(docAmount(receipt) ?? 0) }] } });
        if (a.severity) draftIssues.push({ draft: { ruleCode: 'CLAIM_PURPOSE', typeLabel: 'Claim purpose concern', severity: a.severity, docIds: [receipt.id], claimId, title: a.severity === 'HIGH' ? 'Stated purpose is not supported by the receipt' : 'Stated purpose cannot be confirmed from the receipt', detected: a.findings[0] ?? a.reasoning, why: council.ok ? `Claim council (${council.result.agreement}): ${council.result.chair.reasoning}` : 'Receipt contents do not clearly support the stated business purpose. A receipt cannot prove a business meeting.', suggested: ['Ask the employee for attendees and the business reason.', 'Approve or reject in Review.'], evidence: [{ label: 'Stated purpose', found: purpose || '(none)' }, { label: 'Receipt items', found: tpl.lines.map(l => l.description).join(', ') }, { label: 'Amount', found: formatMoney(docAmount(receipt) ?? 0) }] } });
        for (const f of receipt.fields.filter(x => (x.confidence ?? 1) < 0.7)) draftIssues.push({ draft: { ruleCode: 'EXTRACTION_UNCERTAIN', typeLabel: 'Extraction uncertainty', severity: 'INFO', docIds: [receipt.id], claimId, fieldKey: f.key, title: `${f.label} on the receipt was hard to read`, detected: `Read as ${fieldDisplay(f)} with ${Math.round((f.confidence ?? 0) * 100)}% confidence.`, why: 'A value OCR is unsure of is shown for confirmation rather than assumed correct.', suggested: ['Compare with the receipt and confirm or correct it.'], evidence: [{ label: f.label, found: fieldDisplay(f), note: `Confidence ${Math.round((f.confidence ?? 0) * 100)}%` }] } });
        if (a.dateMismatch) draftIssues.push({ draft: { ruleCode: 'CLAIM_DATE_MISMATCH', typeLabel: 'Claim date mismatch', severity: 'WARNING', docIds: [receipt.id], claimId, title: 'Receipt date differs from the date in the statement', detected: a.dateMismatch, why: 'The receipt date differs from the employee’s statement; it may be a typing error or a different trip.', suggested: ['Ask the employee which date is correct.'], evidence: [{ label: 'Date', found: a.dateMismatch }] } });
        const dup = docs.find(x => x.docType === 'claim_receipt' && x.status !== 'REJECTED' && (dupFile?.id === x.id || (docParty(x) === docParty(receipt) && docDate(x) === docDate(receipt) && docAmount(x) === docAmount(receipt))));
        if (dup) draftIssues.push({ draft: { ruleCode: 'DUPLICATE_FILE', typeLabel: 'Possible duplicate', severity: 'WARNING', docIds: [receipt.id, dup.id], claimId, title: `Receipt looks the same as ${docNumber(dup)}`, detected: 'Same merchant, date and amount (or the same file) already exists.', why: 'Duplicate receipts risk a double claim.', suggested: ['Keep one record and mark the other as the duplicate.'], evidence: [{ label: 'Merchant · date · amount', expected: `${docParty(dup)} · ${formatDate(docDate(dup))} · ${formatMoney(docAmount(dup) ?? 0)}`, found: `${docParty(receipt)} · ${formatDate(docDate(receipt))} · ${formatMoney(docAmount(receipt) ?? 0)}` }] } });
        const ids = issueIds(draftIssues.length);
        const created: Issue[] = draftIssues.map((x, n) => ({ ...x.draft, id: ids[n], status: 'OPEN', createdAt: new Date().toISOString() }));
        const claim: Claim = { id: claimId, employee: 'Demo employee', receiptDocId: receipt.id, employeePurpose: purpose, categoryCode: a.categoryCode, categoryConfidence: a.confidence,
          alternativeCodes: council.ok ? [...new Set(council.result.opinions.map(o => o.account_code).filter((c): c is string => Boolean(c) && c !== a.categoryCode))] : [], categoryReasoning: a.reasoning, standardizedDescription: a.description, findings: a.findings, status: a.plausibility };
        add({ id: uid(), kind: 'card', card: { type: 'findings', items: created.map(c => ({ id: c.id, severity: c.severity, title: c.title, typeLabel: c.typeLabel })), human: true } });
        setCardStatus(cardId, 'EXTRACTED', created.length ? `${created.length} issue${created.length === 1 ? '' : 's'} found · saving` : 'No issues found · saving');
        await advance(3);
        data.commit({ docs: [receipt], links: [], claims: [claim], issues: created, note: `Claim ${claimId} created from chat`, entityId: claimId }, 'Claims Verification Agent');
        setCardStatus(cardId, 'PENDING', `Claim ${claimId} saved · waiting for approval`);
        add({ id: uid(), kind: 'card', card: { type: 'saved', lines: [`Claim ${claimId} saved as Pending. Receipt ${docNumber(receipt)} is in Documents.`, created.length ? `${created.length} issue${created.length === 1 ? '' : 's'} raised for the reviewer.` : 'No issues were raised.', 'A reviewer, not the person who submitted it, approves or rejects this claim.'], hideActionItems: true } });
        await advance(4);
        say('Done. This claim now waits for a reviewer to approve or reject it.');
      } else {
        // Read the file itself first (PDF text layer). Only when that is impossible fall back to a prepared sample.
        const read = pre ?? await readDocument(file);
        const real = read.ok ? read.doc : null;
        const type = real?.doc_type ?? docTypeFor(file.name);
        const known = type === 'invoice' && DEMO_INVOICE_1019.fileMatch.test(file.name) ? DEMO_INVOICE_1019 : null;
        const sample: Sample = real ? { fields: real.fields, lines: real.lines, poRef: real.fields.find(f => f.key === 'po_ref')?.value ?? null } : known ?? purchasingSample(type, intent);
        const doc: DocRecord = { id: newDocIds[0], docType: type, flow: 'purchasing', status: 'EXTRACTED', fields: sample.fields, lines: sample.lines, ...base, ...(known && !real ? { sourceUrl: known.sourceUrl } : {}) };
        if (!real && !pre) say(`I could not read the file itself (${read.ok ? '' : read.error}), so I am using prepared sample values for this ${TYPE_CONFIG[type].label.toLowerCase()}.`);
        const cardId = uid();
        add({ id: cardId, kind: 'card', card: { ...docCard(doc, `Read from the ${TYPE_CONFIG[type].label.toLowerCase()}`, !real, real?.warnings ?? [], real?.source), statusNote: type === 'purchase_order' ? 'Fields read · checking for duplicates' : 'Fields read · finding the purchase order' } });
        await advance(1);
        let po: DocRecord | null = null; let basis = ''; let confirmed = false; let confidence = 0; let comparison: Comparison[] = []; let checkIssues: IssueDraft[] = [];
        if (type === 'invoice') { const c = checkInvoice(doc, docs, links, sample.poRef); ({ po, basis, confirmed, confidence, comparison } = c); checkIssues = c.issues; }
        // A quotation comes before its PO, so a quotation without one is normal, not a warning.
        else if (type !== 'purchase_order') {
          po = docs.find(x => x.docType === 'purchase_order' && sample.poRef && docNumber(x) === sample.poRef && x.status !== 'REJECTED') ?? null;
          if (po) { basis = `explicit PO reference ${sample.poRef}`; confirmed = true; confidence = 0.99; }
          else if (type !== 'quotation') checkIssues.push({ ruleCode: 'MISSING_PO', typeLabel: 'Missing purchase order', severity: 'WARNING', docIds: [doc.id], title: `${TYPE_CONFIG[type].label} ${docNumber(doc)} has no purchase order`, detected: 'The referenced PO has not been uploaded.', why: 'A missing document is not proof of an invalid purchase.', suggested: ['Link an existing PO or record an approved non-PO purchase.'], evidence: [{ label: 'PO reference', found: sample.poRef ?? 'None' }] });
        }
        const sameNo = type === 'purchase_order' ? docs.find(x => x.docType === 'purchase_order' && docNumber(x) === docNumber(doc)) : null;
        const dup = dupFile ?? sameNo;
        if (dup && !checkIssues.some(i => i.ruleCode === 'DUPLICATE_INVOICE')) checkIssues.push({ ruleCode: 'DUPLICATE_FILE', typeLabel: 'Possible duplicate', severity: 'WARNING', docIds: [doc.id, dup.id], title: `${file.name} matches ${docNumber(dup)} already on file`, detected: dupFile ? 'The uploaded file has the same checksum as an existing file.' : 'A PO with the same number already exists.', why: 'Duplicate files and numbers risk double posting.', suggested: ['Keep one record and mark the other as the duplicate.'], evidence: [{ label: 'File checksum', expected: dup.hash, found: hash }] });
        for (const f of sample.fields.filter(x => (x.confidence ?? 1) < 0.7)) checkIssues.push({ ruleCode: 'EXTRACTION_UNCERTAIN', typeLabel: 'Extraction uncertainty', severity: 'INFO', docIds: [doc.id], fieldKey: f.key, title: `${f.label} on ${docNumber(doc)} was hard to read`, detected: `Read as ${fieldDisplay(f)} with ${Math.round((f.confidence ?? 0) * 100)}% confidence.`, why: 'Low-confidence extraction is shown for confirmation rather than assumed correct.', suggested: ['Compare with the source and confirm or correct it.'], evidence: [{ label: f.label, found: fieldDisplay(f), note: `Confidence ${Math.round((f.confidence ?? 0) * 100)}%` }] });
        const poChain = po ? chainOf(po.id, docs, links) : [];
        add({ id: uid(), kind: 'card', card: { type: 'links', title: po ? `Linked to ${docNumber(po)}` : type === 'purchase_order' ? 'Purchase order — anchor of a new chain' : 'No purchase order found', basis: po ? `${Math.round(confidence * 100)}% · ${basis}${confirmed ? '' : ' · proposed, needs confirmation'}` : 'Kept as an unmatched record. It was not rejected.', confirmed,
          chain: [...poChain.map(x => ({ label: TYPE_CONFIG[x.docType].label, no: docNumber(x) })), ...(po && !poChain.some(x => x.id === po!.id) ? [] : []), { label: TYPE_CONFIG[type].label, no: docNumber(doc), here: true }] } });
        if (po) setCardStatus(cardId, 'MATCHED', `Linked to ${docNumber(po)} · verifying`);
        else setCardStatus(cardId, 'EXTRACTED', type === 'purchase_order' ? 'New purchase order · verifying' : 'No purchase order found · verifying');
        await advance(2);
        if (comparison.length && po) add({ id: uid(), kind: 'card', card: { type: 'compare', po: docNumber(po), rows: comparison } });
        const ids = issueIds(checkIssues.length);
        const created: Issue[] = checkIssues.map((x, n) => ({ ...x, id: ids[n], status: 'OPEN', createdAt: new Date().toISOString() }));
        add({ id: uid(), kind: 'card', card: { type: 'findings', items: created.map(c => ({ id: c.id, severity: c.severity, title: c.title, typeLabel: c.typeLabel })), human: created.length > 0 } });
        setCardStatus(cardId, created.length ? 'NEEDS_REVIEW' : po ? 'MATCHED' : 'EXTRACTED', created.length ? `${created.length} issue${created.length === 1 ? '' : 's'} found · saving` : 'All checks passed · saving');
        await advance(3);
        const link: DocLink[] = po && type !== 'purchase_order' && !created.some(c => c.ruleCode === 'AMBIGUOUS_PO_MATCH') ? [{ id: `LNK-${doc.id}-${po.id}`, sourceId: doc.id, targetId: po.id, relationship: 'for_po', confidence, confirmedBy: confirmed ? 'Explicit PO reference' : null }] : [];
        const variance = created.find(c => c.ruleCode === 'PRICE_VARIANCE');
        if (variance && po && type === 'invoice') {
          // Report the error in the conversation and hold the record: nothing is saved (and no Action Item exists) until the user chooses.
          const prices: Record<string, number> = {};
          const rows = comparison.filter(c => c.flags.includes('Price differs'));
          for (const l of doc.lines) { const pl = po.lines.find(x => x.description === l.description); if (pl && pl.unitSen !== null && l.unitSen !== null && pl.unitSen !== l.unitSen) prices[l.id] = pl.unitSen; }
          const grand = docAmount(doc); const poTotal = docAmount(po);
          add({ id: uid(), kind: 'card', card: { type: 'alert', title: `Invoice ${docNumber(doc)} does not match ${docNumber(po)}`, lines: [
            ...rows.map(r => `${r.item}: invoice price ${formatMoney(r.invUnit ?? 0)}, but the PO says ${formatMoney(r.poUnit ?? 0)}.`),
            ...(grand !== null && poTotal !== null && grand !== poTotal ? [`Invoice total ${formatMoney(grand)} against ${formatMoney(poTotal)} on the PO: ${formatMoney(Math.abs(grand - poTotal))} ${grand > poTotal ? 'more' : 'less'}, including sales tax.`] : []),
            'Nothing is saved yet. Fix it now to save a corrected record, or review it later to save it as needs review and add it to Action Items.'] } });
          add({ id: uid(), kind: 'quick', prompt: 'Do you want to fix this now, or review it later?', options: [{ id: 'fix_now', label: 'Fix now' }, { id: 'review_later', label: 'Review later' }],
            ctx: { stepsId, cardId, invoiceNo: docNumber(doc), poNo: docNumber(po), varianceId: variance.id, prices, bundle: { doc: { ...doc, status: 'NEEDS_REVIEW' }, links: link, issues: created } } });
          setStage(4, 'waiting');
          setCardStatus(cardId, 'HELD', 'Price differs from the PO · not saved yet');
        } else {
          const status = type === 'invoice' ? (created.length ? 'NEEDS_REVIEW' : 'VERIFIED') : created.length ? 'NEEDS_REVIEW' : link.length ? 'MATCHED' : 'EXTRACTED';
          data.commit({ docs: [{ ...doc, status }], links: link, claims: [], issues: created, note: `${TYPE_CONFIG[type].label} ${docNumber(doc)} processed from chat`, entityId: doc.id }, 'Purchasing Agent');
          setCardStatus(cardId, status, created.length ? `Saved · ${created.length} issue${created.length === 1 ? '' : 's'} in Action Items` : po ? `Saved under ${docNumber(po)}` : 'Saved');
          add({ id: uid(), kind: 'card', card: { type: 'saved', lines: [`${TYPE_CONFIG[type].label} ${docNumber(doc)} saved${po ? ` under ${docNumber(po)}` : type === 'purchase_order' ? '' : ' as an unmatched record'}.`, type === 'invoice' ? (created.length ? 'Status: needs review. It cannot be exported as a verified invoice until its issues are resolved.' : 'Status: verified — no open issues, so it is eligible for the verified-invoice export.') : `Status: ${status.toLowerCase().replace('_', ' ')}.`, created.length ? `${created.length} issue${created.length === 1 ? '' : 's'} raised in Action Items → Issues.` : 'No issues were raised.'] } });
          await advance(4);
          await advance(4);
          say('Done. You can resolve any issues in Action Items whenever you are ready.');
        }
      }
    } catch (e) {
      setStages(cur => cur.map(s => (s === 'running' ? 'failed' : s)));
      say(`I could not finish: ${(e as Error).message}. Nothing was saved.`);
    } finally { flow.current = { intent: null, stage: 'idle' }; setBusy(false); touch(); }
  }, [add, data, say]);

  const startIntent = useCallback((id: Intent) => {
    if (busy) return;
    const label = STARTERS.find(s => s.id === id)!.label;
    add({ id: uid(), kind: 'user', text: label, files: [] });
    setStages(DEMO_STAGES.map((_, i) => (i === 0 ? 'waiting' : 'queued'))); touch();
    if (id === 'claim' || id === 'dinner') {
      flow.current = { intent: id, stage: 'ask_purpose' };
      say(id === 'dinner' ? 'Happy to. Before you attach the receipt: who was the dinner with, which company, and what was the business purpose?' : 'Happy to. What was the expense for? Please give the business purpose in your own words, and name any attendees or companies if relevant.');
    } else {
      flow.current = { intent: id, stage: 'ask_file' };
      say(id === 'match' ? 'Attach the supplier invoice (PDF or image). I will look for its purchase order and compare them.' : id === 'compare' ? 'Attach the invoice you want checked. I will compare each line with its purchase order.' : 'Attach the supplier invoice (PDF or image) with the paperclip. You can also attach a quotation, purchase order, delivery order or payment document.');
    }
  }, [add, busy, say]);

  const send = useCallback((text: string, attached: File[]) => {
    if (busy) return;
    const clean = text.trim();
    // A receipt attached before the purpose was given is used as soon as the purpose arrives.
    const files = !attached.length && flow.current.stage === 'ask_purpose' && pendingFile.current ? [pendingFile.current] : attached;
    if (flow.current.stage === 'ask_purpose') pendingFile.current = null;
    add({ id: uid(), kind: 'user', text: clean, files: attached.map(f => f.name) });
    const f = flow.current;
    if (f.stage === 'ask_purpose') {
      flow.current = { ...f, stage: 'ask_file', purpose: clean };
      if (files[0]) { void run(files[0]); return; }
      setStages(DEMO_STAGES.map((_, i) => (i === 0 ? 'waiting' : 'queued')));
      say('Thanks, I have noted that. Now attach the receipt (photo or PDF) with the paperclip.'); return;
    }
    if (!files.length) {
      // "Find SFSB-PO-2026-0104": any saved purchasing document number mentioned in the message is looked up and shown with its whole chain.
      const lower = clean.toLowerCase();
      const { docs, links, issues } = data.latest.current;
      const hits = docs.filter(x => x.flow === 'purchasing' && x.status !== 'REJECTED' && docNumber(x) && lower.includes(docNumber(x).toLowerCase()));
      const refLike = clean.match(/\b[A-Za-z]{2,5}[-/][A-Za-z0-9]{1,5}(?:[-/][A-Za-z0-9]{1,6}){1,3}\b/g)?.filter(r => /\d{3,}/.test(r)) ?? [];
      if (hits.length || (refLike.length && /find|search|show|look|where|open|display|status|check|get/.test(lower))) {
        flow.current = { intent: null, stage: 'idle' };
        void (async () => {
          setBusy(true); setStages(DEMO_STAGES.map((_, i) => (i === 0 ? 'running' : 'queued'))); touch();
          try {
            say(hits.length ? 'Looking that up in your saved records…' : 'Searching your saved records…');
            await sleep(1600);
            if (!hits.length) { say(`I could not find ${refLike.join(', ')} in your saved documents. Check the number, or upload the document and I will process it.`); return; }
            const poIds = [...new Set(hits.map(h => poIdOf(h, links) ?? h.id))].slice(0, 3);
            for (const poId of poIds) {
              const po = docs.find(x => x.id === poId)!;
              const chain = po.docType === 'purchase_order' ? chainOf(po.id, docs.filter(x => x.status !== 'REJECTED'), links) : [po];
              const ids = new Set(chain.map(x => x.id));
              add({ id: uid(), kind: 'card', card: { type: 'lookup', query: clean, poId: po.id, poNo: docNumber(po), supplier: docParty(po), date: docDate(po) ? formatDate(docDate(po)) : '—',
                total: docAmount(po) !== null ? formatMoney(docAmount(po)!) : '—',
                chain: chain.map(x => ({ id: x.id, label: TYPE_CONFIG[x.docType].label, no: docNumber(x), date: docDate(x) ? formatDate(docDate(x)) : '—', amount: docAmount(x) !== null ? formatMoney(docAmount(x)!) : '—', status: humanStatus(x.status), pdf: x.sourceUrl, hit: hits.some(h => h.id === x.id) })),
                issues: issues.filter(i => (i.status === 'OPEN' || i.status === 'UNDER_REVIEW') && i.docIds.some(id => ids.has(id))).map(i => ({ severity: i.severity, title: i.title, status: i.status })) } });
              await sleep(500);
            }
            say(poIds.length > 1 ? `Found ${poIds.length} matching purchase orders.` : 'That is everything on file for it. Ask me about another document number whenever you like.');
          } finally { setStages(DEMO_STAGES.map(() => 'queued')); setBusy(false); touch(); }
        })();
        return;
      }
    }
    if (f.stage === 'ask_file') {
      if (files[0]) { void run(files[0]); return; }
      say('I still need the file. Use the paperclip to attach it, then send.'); return;
    }
    const t = clean.toLowerCase();
    const claimish = /claim|receipt|expense|reimburs/.test(t); const purchasish = /invoice|quotation|purchase order|\bpo\b|delivery order|payment|supplier/.test(t);
    if (files.length && !claimish && !purchasish) {
      // Read the file first and let its content decide what it is; ask only when it cannot be read.
      const file = files[0];
      void (async () => {
        setBusy(true); touch();
        const read = await readDocument(file);
        setBusy(false);
        if (read.ok && read.doc.doc_type === 'claim_receipt') {
          // A receipt: the message sent with it is the employee's purpose; without one, ask for it.
          const merchant = read.doc.fields.find(f => f.key === 'merchant')?.value;
          const total = read.doc.fields.find(f => f.key === 'total');
          const what = `a receipt${merchant ? ` from ${merchant}` : ''}${total?.sen != null ? ` for ${formatMoney(total.sen)}` : ''}`;
          if (clean) {
            flow.current = { intent: 'claim', stage: 'ask_file', purpose: clean };
            say(`I read ${what}, so I am treating this as an expense claim with your message as the purpose.`);
            void run(file, read); return;
          }
          flow.current = { intent: 'claim', stage: 'ask_purpose' };
          pendingFile.current = file;
          setStages(DEMO_STAGES.map((_, i) => (i === 0 ? 'waiting' : 'queued'))); touch();
          say(`I read ${what}. What was the business purpose? Name any attendees or companies if relevant.`); return;
        }
        if (read.ok) {
          const no = read.doc.fields.find(f => ['quotation_no', 'po_no', 'do_no', 'invoice_no', 'advice_no', 'receipt_no'].includes(f.key))?.value;
          flow.current = { intent: 'process', stage: 'ask_file' };
          say(`I read the file: it is a ${TYPE_CONFIG[read.doc.doc_type].label.toLowerCase()}${no ? ` (${no})` : ''}${read.doc.fields.find(f => f.key === 'supplier') ? ` from ${read.doc.fields.find(f => f.key === 'supplier')!.value}` : ''}. Processing it now.`);
          void run(file, read); return;
        }
        if (looksPurchasing(file.name)) {
          flow.current = { intent: 'process', stage: 'ask_file' };
          say(`I could not read the file itself (${read.error}). The file name says it is a supplier ${TYPE_CONFIG[docTypeFor(file.name)].label.toLowerCase()}, so I will process it as one.`);
          void run(file, read); return;
        }
        flow.current = { intent: null, stage: 'ask_file' };
        add({ id: uid(), kind: 'quick', prompt: `I could not read this file automatically (${read.error}). What are you sending?`, options: [{ id: 'claim', label: 'An expense claim receipt' }, { id: 'process', label: 'A purchasing document' }] });
        pendingFile.current = file;
      })();
      return;
    }
    if (claimish && !purchasish && files[0] && clean.split(/\s+/).length >= 4) {
      // "Claim for coffee with Mr Lim…" plus the receipt: the message already states the purpose.
      flow.current = { intent: 'claim', stage: 'ask_file', purpose: clean };
      void run(files[0]); return;
    }
    if (claimish && !purchasish) { flow.current = { intent: 'claim', stage: 'ask_purpose' }; setStages(DEMO_STAGES.map((_, i) => (i === 0 ? 'waiting' : 'queued'))); touch();
      if (files[0]) pendingFile.current = files[0];
      say('What was the expense for? Please give the business purpose and any attendees.'); return; }
    if (purchasish) { flow.current = { intent: /match/.test(t) ? 'match' : /check|compare/.test(t) ? 'compare' : 'process', stage: 'ask_file' }; setStages(DEMO_STAGES.map((_, i) => (i === 0 ? 'waiting' : 'queued'))); touch();
      if (files[0]) { void run(files[0]); return; }
      say('Attach the document with the paperclip and I will process it.'); return; }
    // Anything the sample flows do not handle goes to the real WorkBuddy main agent (backend -> ngrok gateway).
    const history = messagesRef.current
      .filter((m): m is Extract<Msg, { kind: 'user' | 'agent' }> => m.kind === 'user' || m.kind === 'agent')
      .slice(-6).map(m => ({ role: m.kind, text: m.text }));
    void (async () => {
      setBusy(true); setStages(DEMO_STAGES.map((_, i) => (i === 0 ? 'running' : 'queued'))); touch();
      try {
        const body = await request<{ reply?: unknown }>('/api/chat', { message: clean, history });
        if (typeof body?.reply !== 'string' || !body.reply.trim()) throw new Error('The WorkBuddy agent returned an empty or invalid reply.');
        say(body.reply);
      } catch (error) {
        say(`The WorkBuddy agent could not answer: ${error instanceof Error ? error.message : 'The service is unavailable.'}`);
      } finally { setStages(DEMO_STAGES.map(() => 'queued')); setBusy(false); touch(); }
    })();
  }, [add, busy, run, say]);

  const choose = useCallback((msgId: string, optionId: string) => {
    const picked = messagesRef.current.find(x => x.id === msgId);
    setMessages(items => items.map(x => (x.id === msgId && x.kind === 'quick' ? { ...x, used: true } : x)));
    if ((optionId === 'fix_now' || optionId === 'review_later') && picked?.kind === 'quick' && picked.ctx?.bundle) {
      const ctx = picked.ctx; const { doc, links, issues } = ctx.bundle;
      const already = data.latest.current.docs.some(x => x.docType === 'invoice' && x.status !== 'REJECTED' && docNumber(x) === ctx.invoiceNo);
      if (already) { say(`${ctx.invoiceNo} is already saved, so I did not save it again. You can find it in Documents, and any open issue is in Action Items.`, { to: '/issues', action: 'Open Action Items' }); return; }
      const finish = () => { setMessages(items => items.map(x => (x.id === ctx.stepsId && x.kind === 'steps' ? { ...x, steps: x.steps.map(st => ({ ...st, state: 'done' as const })) } : x))); setStage(4, 'completed'); };
      add({ id: uid(), kind: 'user', text: optionId === 'fix_now' ? 'Fix now' : 'Review later', files: [] });
      void (async () => {
        setBusy(true); touch();
        try {
          await sleep(1200);
          if (optionId === 'review_later') {
            data.commit({ docs: [doc], links, claims: [], issues, note: `Invoice ${ctx.invoiceNo} saved for later review from chat`, entityId: doc.id }, 'Purchasing Agent');
            finish();
            setCardStatus(ctx.cardId, 'NEEDS_REVIEW', `Saved under ${ctx.poNo} · price issue in Action Items`);
            add({ id: uid(), kind: 'card', card: { type: 'saved', lines: [`Invoice ${ctx.invoiceNo} saved as needs review under ${ctx.poNo}.`, `${issues.length} issue${issues.length === 1 ? '' : 's'} added to Action Items → Issues.`, 'It cannot be exported as a verified invoice until the price mismatch is resolved.'] } });
            say('No problem. It is waiting in Action Items for you whenever you are ready.', { to: '/issues', action: 'Open Action Items' });
            return;
          }
          await sleep(1800);   // applying the correction and re-checking against the PO
          const fixed = repriceInvoice(doc, ctx.prices);
          const kept = issues.filter(i => i.id !== ctx.varianceId);
          const fixedDoc: DocRecord = { ...doc, lines: fixed.lines, fields: fixed.fields, status: kept.length ? 'NEEDS_REVIEW' : 'EXTRACTED' };
          data.commit({ docs: [fixedDoc], links, claims: [], issues: kept, note: `Invoice ${ctx.invoiceNo} saved after correcting unit price(s) to the PO price (chat)`, entityId: doc.id }, 'Purchasing Agent');
          finish();
          setCardStatus(ctx.cardId, kept.length ? 'NEEDS_REVIEW' : 'VERIFIED', kept.length ? `Price corrected · ${kept.length} other issue${kept.length === 1 ? '' : 's'} open` : `Price corrected · saved under ${ctx.poNo}`);
          const before = docAmount(doc); const after = docAmount(fixedDoc);
          add({ id: uid(), kind: 'card', card: { type: 'fix', title: 'Fixed: price now matches the purchase order',
            rows: doc.lines.filter(l => ctx.prices[l.id] !== undefined).map(l => ({ item: l.description, from: `${formatMoney(l.unitSen ?? 0)} each`, to: `${formatMoney(ctx.prices[l.id])} each` })),
            lines: [
              ...(before !== null && after !== null ? [`Invoice total corrected from ${formatMoney(before)} to ${formatMoney(after)}.`] : []),
              kept.length ? `Saved under ${ctx.poNo}. ${kept.length} other issue${kept.length === 1 ? '' : 's'} still need attention in Action Items.` : `Re-check against ${ctx.poNo} passed. The record is saved and verified, and nothing was added to Action Items.`,
              'The supplier’s original invoice still shows the old price, so consider asking the supplier for a credit note or a corrected invoice.'] } });
          say(kept.length ? 'The remaining issues are in Action Items.' : 'All done. Nothing else needs your attention for this invoice.', kept.length ? { to: '/issues', action: 'Open Action Items' } : {});
        } finally { setBusy(false); touch(); }
      })();
      return;
    }
    const file = pendingFile.current; pendingFile.current = null;
    if (optionId === 'claim') { flow.current = { intent: 'claim', stage: 'ask_purpose' }; say('What was the expense for? Please give the business purpose and any attendees. I will use the receipt you attached.'); pendingFile.current = file; }
    else { flow.current = { intent: 'process', stage: 'ask_file' }; if (file) void run(file); }
  }, [run, say, add, data, setMessages]);

  const reply = useCallback((prompt: string, text: string, link?: { to?: string; hash?: string; action: string }) => {
    add({ id: uid(), kind: 'user', text: prompt, files: [] });
    say(text, link ? { to: link.to, hash: link.hash, action: link.action } : {});
  }, [add, say]);

  const chats = useMemo<ChatSummary[]>(() => store.chats.filter(c => c.messages.length).map(c => ({ id: c.id, title: titleOf(c), at: c.at, count: c.messages.length, current: c.id === store.activeId })).reverse(), [store]);
  const api = useMemo<AgentApi>(() => ({ chats, activeId: store.activeId, newChat, openChat, deleteChat, messages, stages, busy, active: messages.length > 0, stamp, startIntent, send, reply, choose }), [store, chats, messages, stages, busy, stamp, startIntent, send, reply, choose]);   // eslint-disable-line react-hooks/exhaustive-deps
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useAgent() {
  const v = useContext(Ctx);
  if (!v) throw new Error('AgentProvider is required.');
  return v;
}
