import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Claim, DocLink, DocRecord, DocType, Field, Issue, LineItem, Severity } from '../types';
import { CHART_OF_ACCOUNTS } from '../data/dummy';
import { allocIds, useData } from '../state/store';
import { TYPE_CONFIG, chainOf, docAmount, docDate, docNumber, docParty, fieldDisplay, lineTotal } from './docs';
import { formatDate, formatMoney } from './format';
import { checkInvoice, type Comparison, type IssueDraft } from './verify';

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

export type Card =
  | { type: 'extract'; title: string; fields: { label: string; value: string; low?: boolean }[]; lines: { item: string; qty: number; unit: string; total: string }[]; sample: boolean }
  | { type: 'links'; title: string; basis: string; confirmed: boolean; chain: { label: string; no: string; here?: boolean }[] }
  | { type: 'compare'; po: string; rows: Comparison[] }
  | { type: 'claim'; purpose: string; plausibility: 'PLAUSIBLE' | 'NEEDS_REVIEW'; findings: string[]; category: string; confidence: number; reasoning: string; description: string }
  | { type: 'findings'; items: { severity: Severity; title: string; typeLabel: string }[]; human: boolean }
  | { type: 'saved'; lines: string[] };

export type Msg =
  | { id: string; kind: 'user'; text: string; files: string[] }
  | { id: string; kind: 'agent'; text: string; to?: string; action?: string; hash?: string }
  | { id: string; kind: 'quick'; options: { id: string; label: string }[]; used?: boolean }
  | { id: string; kind: 'steps'; steps: { label: string; state: 'done' | 'running' | 'queued' }[] }
  | { id: string; kind: 'card'; card: Card };

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

async function sha256(file: File) {
  try { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16); }
  catch { return `unhashed-${file.size}`; }
}

const t = (key: string, label: string, value: string, confidence = 0.97): Field => ({ key, label, kind: 'text', value, confidence });
const d = (key: string, label: string, value: string, confidence = 0.97): Field => ({ key, label, kind: 'date', value, confidence });
const m = (key: string, label: string, sen: number, confidence = 0.98): Field => ({ key, label, kind: 'money', value: '', sen, confidence });
const li = (id: string, description: string, quantity: number, unitSen: number | null): LineItem => ({ id, description, quantity, unitSen, totalSen: lineTotal(quantity, unitSen) });

/* ---------------- prepared sample extractions ---------------- */
interface Sample { fields: Field[]; lines: LineItem[]; poRef: string | null }
function purchasingSample(type: DocType, intent: Intent | null): Sample {
  if (type === 'invoice') {
    if (intent === 'match') return { poRef: 'PO-2026-0419', lines: [li('l1', 'Packing tape 48mm', 200, 600)],
      fields: [t('invoice_no', 'Invoice number', 'INV-BP-21044'), d('date', 'Date', '2026-10-10'), t('supplier', 'Supplier', 'Borneo Packaging Sdn Bhd'), d('due_date', 'Due date', '2026-11-09'), t('payment_terms', 'Payment term', 'Net 30'), m('grand_total', 'Grand total', 120000)] };
    if (intent === 'compare') return { poRef: 'PO-2026-0412', lines: [li('l1', 'Hydraulic hose assembly', 40, 11000), li('l2', 'Pressure gauge 0–10 bar', 10, 8500)],
      fields: [t('invoice_no', 'Invoice number', 'INV-77188'), d('date', 'Date', '2026-10-10'), t('supplier', 'Supplier', 'Teknik Mesra Sdn Bhd'), d('due_date', 'Due date', '2026-11-09'), t('payment_terms', 'Payment term', 'Net 30'), m('grand_total', 'Grand total', 529000)] };
    return { poRef: null, lines: [li('l1', 'Desk lamp, LED', 4, 32000)],
      fields: [t('invoice_no', 'Invoice number', 'INV-SOH-5530'), d('date', 'Date', '2026-10-09', 0.6), t('supplier', 'Supplier', 'Sarawak Office Hub'), d('due_date', 'Due date', '2026-11-08'), t('payment_terms', 'Payment term', 'Net 30'), m('grand_total', 'Grand total', 128000)] };
  }
  if (type === 'delivery_order') return { poRef: 'PO-2026-0419', lines: [li('l1', 'Packing tape 48mm', 200, null)],
    fields: [t('do_no', 'DO number', 'DO-3402'), d('date', 'Date', '2026-10-08'), t('supplier', 'Supplier', 'Borneo Packaging Sdn Bhd'), t('delivery_status', 'Delivery status', 'Delivered')] };
  if (type === 'payment_advice') return { poRef: 'PO-2026-0419', lines: [],
    fields: [t('advice_no', 'Payment advice number', 'PA-0110'), d('date', 'Date', '2026-10-10'), t('supplier', 'Supplier', 'Borneo Packaging Sdn Bhd'), m('amount', 'Amount', 120000), t('payment_reference', 'Payment reference', 'PO-2026-0419')] };
  if (type === 'payment_receipt') return { poRef: 'PO-2026-0419', lines: [],
    fields: [t('receipt_no', 'Receipt number', 'PR-0044'), d('date', 'Date', '2026-10-10'), t('supplier', 'Supplier', 'Borneo Packaging Sdn Bhd'), m('amount', 'Amount', 120000)] };
  if (type === 'quotation') return { poRef: 'PO-2026-0419', lines: [li('l1', 'Packing tape 48mm', 200, 600)],
    fields: [t('quotation_no', 'Quotation number', 'QT-9002'), d('date', 'Date', '2026-09-28'), t('supplier', 'Supplier', 'Borneo Packaging Sdn Bhd'), m('grand_total', 'Grand total', 120000)] };
  return { poRef: null, lines: [li('l1', 'Desk lamp, LED', 4, 32000)],
    fields: [t('po_no', 'PO number', 'PO-2026-0431'), d('date', 'Date', '2026-10-09'), t('supplier', 'Supplier', 'Sarawak Office Hub'), m('grand_total', 'Grand total', 128000)] };
}
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
  const alcohol = /beer|wine|whisky|liquor|tower|cocktail/.test(items);
  const venue = /\broom\b|lounge|karaoke/.test(`${items} ${docParty(receipt).toLowerCase()}`);
  const food = /set|lunch|dinner|meal|platter|drink|fish|rice|dessert/.test(items) && !alcohol;
  const transport = /ride|taxi/.test(items); const supplies = /paper|toner|ink|cartridge/.test(items);
  const wants: 'meal' | 'transport' | 'supplies' | null = /lunch|dinner|meal|treat|client|entertain/.test(p) ? 'meal' : /taxi|grab|ride|airport|travel/.test(p) ? 'transport' : /paper|toner|stationery|print|ink|office/.test(p) ? 'supplies' : null;
  const findings: string[] = []; let plausibility: 'PLAUSIBLE' | 'NEEDS_REVIEW' = 'PLAUSIBLE'; let severity: Severity | null = null;
  if (purpose.trim().length < 12) { plausibility = 'NEEDS_REVIEW'; severity = 'WARNING'; findings.push('The stated purpose is too short to check against the receipt.'); }
  else if (wants === 'meal') {
    if (alcohol || venue) { plausibility = 'NEEDS_REVIEW'; severity = 'HIGH'; findings.push(`The stated purpose is a meal, but the receipt lists ${alcohol ? 'alcohol' : 'a venue charge'}${venue ? ' and a room/venue charge' : ''} rather than a meal.`); }
    else if (food) findings.push('Receipt items are food and drink, consistent with a meal.');
    else { plausibility = 'NEEDS_REVIEW'; severity = 'WARNING'; findings.push('Receipt items do not clearly show a meal.'); }
  } else if (wants === 'transport') { if (transport) findings.push('Receipt is a ride, consistent with the stated travel.'); else { plausibility = 'NEEDS_REVIEW'; severity = 'WARNING'; findings.push('Receipt items do not show transport.'); } }
  else if (wants === 'supplies') { if (supplies) findings.push('Receipt items are office supplies, consistent with the stated purpose.'); else { plausibility = 'NEEDS_REVIEW'; severity = 'WARNING'; findings.push('Receipt items do not show office supplies.'); } }
  else { plausibility = 'NEEDS_REVIEW'; severity = 'WARNING'; findings.push('The purpose does not say what kind of expense this is, so it cannot be tested against the receipt.'); }
  const attendees = /\bwith ([A-Z][^,.;]*?)(?= to | for | about |[,.;]|$)/.exec(purpose)?.[1]?.trim();
  if (wants === 'meal') findings.push(attendees ? `Attendees stated by the employee: ${attendees}.` : 'No attendees were stated and none were assumed.');
  const dm = new RegExp(`(\\d{1,2})\\s+(${MONTHS.join('|')})`, 'i').exec(purpose);
  let dateMismatch: string | null = null;
  if (dm) { const [, day, month] = dm; const rd = docDate(receipt); if (Number(rd.slice(8)) !== Number(day) || MONTHS[Number(rd.slice(5, 7)) - 1] !== month.toLowerCase()) { dateMismatch = `Statement: ${day} ${month}; receipt: ${formatDate(rd)}.`; findings.push(`Receipt date differs from the date in the statement (${dateMismatch}).`); } }
  findings.push('A receipt cannot independently prove that a business purpose or meeting took place.');
  let categoryCode: string | null = wants === 'meal' ? (attendees || /client/.test(p) ? '6020' : '6040') : wants === 'transport' ? '6030' : wants === 'supplies' ? '6010' : null;
  let confidence = categoryCode === '6020' ? 0.78 : categoryCode === '6040' ? 0.55 : categoryCode === '6030' ? 0.88 : categoryCode === '6010' ? 0.93 : 0;
  if (plausibility === 'NEEDS_REVIEW' && categoryCode) confidence = Math.min(confidence, 0.41);
  const account = CHART_OF_ACCOUNTS.find(a => a.code === categoryCode);
  const reasoning = account ? `Suggested from the stated purpose and receipt items${plausibility === 'NEEDS_REVIEW' ? '; low confidence because the receipt does not clearly support the purpose' : ''}. Subject to company policy.` : 'No account could be suggested from the information given.';
  const kind = wants === 'meal' ? (/dinner/.test(p) ? 'Business dinner' : /lunch/.test(p) ? 'Business lunch' : 'Business meal') : wants === 'transport' ? 'Ride-hailing' : wants === 'supplies' ? 'Office supplies purchase' : 'Expense';
  const clause = /\b(?:to|for)\s+(.+?)[.]?$/i.exec(purpose)?.[1];
  const description = `${kind}${attendees ? ` with ${attendees}` : ''} on ${longDate(docDate(receipt))} at ${docParty(receipt)}${clause ? `, ${/^(to|for)\b/i.test(clause) ? '' : 'to '}${clause}` : ''}.`;
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
  const flow = useRef<Flow>({ intent: null, stage: 'idle' });
  const pendingFile = useRef<File | null>(null);
  const add = useCallback((msg: Msg) => setMessages(items => [...items, msg]), []);
  const say = useCallback((text: string, extra: Partial<Extract<Msg, { kind: 'agent' }>> = {}) => add({ id: uid(), kind: 'agent', text, ...extra }), [add]);
  const setStage = (i: number, s: StageState) => setStages(cur => cur.map((x, k) => (k === i ? s : x)));
  const touch = () => setStamp(Date.now());

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

  const run = useCallback(async (file: File) => {
    const intent = flow.current.intent; const purpose = flow.current.purpose ?? '';
    flow.current = { ...flow.current, stage: 'processing' }; setBusy(true); setStages(DEMO_STAGES.map(() => 'queued'));
    const claims = intent === 'claim' || intent === 'dinner';
    const labels = claims ? ['Receive the receipt', 'Read merchant, date and amount', 'Check purpose, suggest account', 'Verify and look for issues', 'Save the claim'] : ['Receive the document', 'Read the fields', 'Link to purchase order', 'Verify prices, quantities and duplicates', 'Save the record'];
    const stepsId = uid();
    const steps = (done: number) => ({ id: stepsId, kind: 'steps' as const, steps: labels.map((label, i) => ({ label, state: i < done ? 'done' as const : i === done ? 'running' as const : 'queued' as const })) });
    add(steps(0)); const update = (done: number) => setMessages(items => items.map(x => x.id === stepsId ? steps(done) : x));
    const advance = async (i: number) => { setStage(i, 'completed'); if (i < 4) setStage(i + 1, 'running'); update(i + 1); await sleep(650); };
    try {
      setStage(0, 'running'); touch();
      const hash = await sha256(file); await sleep(500); await advance(0);
      const { docs, links, claims: allClaims, issues } = data.latest.current;
      const draftIssues: { draft: IssueDraft; docIds?: string[] }[] = [];
      const newDocIds = allocIds('DOC', docs.map(x => x.id), 1);
      const issueIds = (n: number) => allocIds('ISS', issues.map(x => x.id), n);
      const base = { filename: file.name, hash, version: 1, uploadedAt: new Date().toISOString(), uploadedBy: claims ? 'Demo employee' : 'You (demo user)' };
      const dupFile = docs.find(x => x.hash === hash && x.status !== 'REJECTED');

      if (claims) {
        const kind = pickReceipt(intent, purpose, file.name);
        const tpl = RECEIPTS[kind];
        const receipt: DocRecord = { id: newDocIds[0], docType: 'claim_receipt', flow: 'claims', status: 'EXTRACTED', fields: tpl.fields, lines: tpl.lines, ...base };
        add({ id: uid(), kind: 'card', card: { type: 'extract', title: 'Read from the receipt', sample: true, fields: tpl.fields.map(f => ({ label: f.label, value: fieldDisplay(f), low: (f.confidence ?? 1) < 0.7 })), lines: tpl.lines.map(l => ({ item: l.description, qty: l.quantity, unit: l.unitSen === null ? '—' : formatMoney(l.unitSen), total: l.totalSen === null ? '—' : formatMoney(l.totalSen) })) } });
        await advance(1);
        const a = analyseClaim(purpose, receipt);
        add({ id: uid(), kind: 'card', card: { type: 'claim', purpose, plausibility: a.plausibility, findings: a.findings, category: CHART_OF_ACCOUNTS.find(x => x.code === a.categoryCode) ? `${a.categoryCode} · ${CHART_OF_ACCOUNTS.find(x => x.code === a.categoryCode)!.name}` : 'No suggestion', confidence: a.confidence, reasoning: a.reasoning, description: a.description } });
        await advance(2);
        const claimId = allocIds('CLM', allClaims.map(x => x.id), 1)[0];
        const sum = tpl.lines.reduce((s, l) => s + (l.totalSen ?? 0), 0);
        if (Math.abs(sum - (docAmount(receipt) ?? 0)) > 1) draftIssues.push({ draft: { ruleCode: 'TOTAL_MISMATCH', typeLabel: 'Amount mismatch', severity: 'WARNING', docIds: [receipt.id], claimId, title: 'Receipt lines do not add up to the total', detected: 'Sum of line totals differs from the receipt total.', why: 'Totals must add up within rounding tolerance.', suggested: ['Compare with the receipt image.'], evidence: [{ label: 'Sum of lines', expected: formatMoney(sum), found: formatMoney(docAmount(receipt) ?? 0) }] } });
        if (a.severity) draftIssues.push({ draft: { ruleCode: 'CLAIM_PURPOSE', typeLabel: 'Claim purpose concern', severity: a.severity, docIds: [receipt.id], claimId, title: a.severity === 'HIGH' ? 'Stated purpose is not supported by the receipt' : 'Stated purpose cannot be confirmed from the receipt', detected: a.findings[0], why: 'Receipt contents do not clearly support the stated business purpose. A receipt cannot prove a business meeting.', suggested: ['Ask the employee for attendees and the business reason.', 'Approve or reject in Review.'], evidence: [{ label: 'Stated purpose', found: purpose || '(none)' }, { label: 'Receipt items', found: tpl.lines.map(l => l.description).join(', ') }, { label: 'Amount', found: formatMoney(docAmount(receipt) ?? 0) }] } });
        if (a.dateMismatch) draftIssues.push({ draft: { ruleCode: 'CLAIM_DATE_MISMATCH', typeLabel: 'Claim date mismatch', severity: 'WARNING', docIds: [receipt.id], claimId, title: 'Receipt date differs from the date in the statement', detected: a.dateMismatch, why: 'The receipt date differs from the employee’s statement; it may be a typing error or a different trip.', suggested: ['Ask the employee which date is correct.'], evidence: [{ label: 'Date', found: a.dateMismatch }] } });
        const dup = docs.find(x => x.docType === 'claim_receipt' && x.status !== 'REJECTED' && (dupFile?.id === x.id || (docParty(x) === docParty(receipt) && docDate(x) === docDate(receipt) && docAmount(x) === docAmount(receipt))));
        if (dup) draftIssues.push({ draft: { ruleCode: 'DUPLICATE_FILE', typeLabel: 'Possible duplicate', severity: 'WARNING', docIds: [receipt.id, dup.id], claimId, title: `Receipt looks the same as ${docNumber(dup)}`, detected: 'Same merchant, date and amount (or the same file) already exists.', why: 'Duplicate receipts risk a double claim.', suggested: ['Keep one record and mark the other as the duplicate.'], evidence: [{ label: 'Merchant · date · amount', expected: `${docParty(dup)} · ${formatDate(docDate(dup))} · ${formatMoney(docAmount(dup) ?? 0)}`, found: `${docParty(receipt)} · ${formatDate(docDate(receipt))} · ${formatMoney(docAmount(receipt) ?? 0)}` }] } });
        const ids = issueIds(draftIssues.length);
        const created: Issue[] = draftIssues.map((x, n) => ({ ...x.draft, id: ids[n], status: 'OPEN', createdAt: new Date().toISOString() }));
        const claim: Claim = { id: claimId, employee: 'Demo employee', receiptDocId: receipt.id, employeePurpose: purpose, categoryCode: a.categoryCode, categoryConfidence: a.confidence, alternativeCodes: [], categoryReasoning: a.reasoning, standardizedDescription: a.description, findings: a.findings, status: a.plausibility };
        add({ id: uid(), kind: 'card', card: { type: 'findings', items: created.map(c => ({ severity: c.severity, title: c.title, typeLabel: c.typeLabel })), human: true } });
        await advance(3);
        data.commit({ docs: [receipt], links: [], claims: [claim], issues: created, note: `Claim ${claimId} created from chat`, entityId: claimId }, 'Claims Verification Agent');
        add({ id: uid(), kind: 'card', card: { type: 'saved', lines: [`Claim ${claimId} saved as Pending. Receipt ${docNumber(receipt)} is in Documents.`, created.length ? `${created.length} issue${created.length === 1 ? '' : 's'} raised in Action Items → Issues.` : 'No issues were raised.', 'Human review is required: the claim is waiting in Action Items → Review for an approve or reject decision.'] } });
        await advance(4);
        say('Done. I did not approve anything on your behalf.');
      } else {
        const type = docTypeFor(file.name);
        const sample = purchasingSample(type, intent);
        const doc: DocRecord = { id: newDocIds[0], docType: type, flow: 'purchasing', status: 'EXTRACTED', fields: sample.fields, lines: sample.lines, ...base };
        add({ id: uid(), kind: 'card', card: { type: 'extract', title: `Read from the ${TYPE_CONFIG[type].label.toLowerCase()}`, sample: true, fields: sample.fields.map(f => ({ label: f.label, value: fieldDisplay(f), low: (f.confidence ?? 1) < 0.7 })), lines: sample.lines.map(l => ({ item: l.description, qty: l.quantity, unit: l.unitSen === null ? '—' : formatMoney(l.unitSen), total: l.totalSen === null ? '—' : formatMoney(l.totalSen) })) } });
        await advance(1);
        let po: DocRecord | null = null; let basis = ''; let confirmed = false; let confidence = 0; let comparison: Comparison[] = []; let checkIssues: IssueDraft[] = [];
        if (type === 'invoice') { const c = checkInvoice(doc, docs, links, sample.poRef); ({ po, basis, confirmed, confidence, comparison } = c); checkIssues = c.issues; }
        else if (type !== 'purchase_order') {
          po = docs.find(x => x.docType === 'purchase_order' && sample.poRef && docNumber(x) === sample.poRef && x.status !== 'REJECTED') ?? null;
          if (po) { basis = `explicit PO reference ${sample.poRef}`; confirmed = true; confidence = 0.99; }
          else checkIssues.push({ ruleCode: 'MISSING_PO', typeLabel: 'Missing purchase order', severity: 'WARNING', docIds: [doc.id], title: `${TYPE_CONFIG[type].label} ${docNumber(doc)} has no purchase order`, detected: 'The referenced PO has not been uploaded.', why: 'A missing document is not proof of an invalid purchase.', suggested: ['Link an existing PO or record an approved non-PO purchase.'], evidence: [{ label: 'PO reference', found: sample.poRef ?? 'None' }] });
        }
        const sameNo = type === 'purchase_order' ? docs.find(x => x.docType === 'purchase_order' && docNumber(x) === docNumber(doc)) : null;
        const dup = dupFile ?? sameNo;
        if (dup && !checkIssues.some(i => i.ruleCode === 'DUPLICATE_INVOICE')) checkIssues.push({ ruleCode: 'DUPLICATE_FILE', typeLabel: 'Possible duplicate', severity: 'WARNING', docIds: [doc.id, dup.id], title: `${file.name} matches ${docNumber(dup)} already on file`, detected: dupFile ? 'The uploaded file has the same checksum as an existing file.' : 'A PO with the same number already exists.', why: 'Duplicate files and numbers risk double posting.', suggested: ['Keep one record and mark the other as the duplicate.'], evidence: [{ label: 'File checksum', expected: dup.hash, found: hash }] });
        for (const f of sample.fields.filter(x => (x.confidence ?? 1) < 0.7)) checkIssues.push({ ruleCode: 'EXTRACTION_UNCERTAIN', typeLabel: 'Extraction uncertainty', severity: 'INFO', docIds: [doc.id], fieldKey: f.key, title: `${f.label} on ${docNumber(doc)} was hard to read`, detected: `Read as ${fieldDisplay(f)} with ${Math.round((f.confidence ?? 0) * 100)}% confidence.`, why: 'Low-confidence extraction is shown for confirmation rather than assumed correct.', suggested: ['Compare with the source and confirm or correct it.'], evidence: [{ label: f.label, found: fieldDisplay(f), note: `Confidence ${Math.round((f.confidence ?? 0) * 100)}%` }] });
        const poChain = po ? chainOf(po.id, docs, links) : [];
        add({ id: uid(), kind: 'card', card: { type: 'links', title: po ? `Linked to ${docNumber(po)}` : type === 'purchase_order' ? 'Purchase order — anchor of a new chain' : 'No purchase order found', basis: po ? `${Math.round(confidence * 100)}% · ${basis}${confirmed ? '' : ' · proposed, needs confirmation'}` : 'Kept as an unmatched record. It was not rejected.', confirmed,
          chain: [...poChain.map(x => ({ label: TYPE_CONFIG[x.docType].label, no: docNumber(x) })), ...(po && !poChain.some(x => x.id === po!.id) ? [] : []), { label: TYPE_CONFIG[type].label, no: docNumber(doc), here: true }] } });
        await advance(2);
        if (comparison.length && po) add({ id: uid(), kind: 'card', card: { type: 'compare', po: docNumber(po), rows: comparison } });
        const ids = issueIds(checkIssues.length);
        const created: Issue[] = checkIssues.map((x, n) => ({ ...x, id: ids[n], status: 'OPEN', createdAt: new Date().toISOString() }));
        add({ id: uid(), kind: 'card', card: { type: 'findings', items: created.map(c => ({ severity: c.severity, title: c.title, typeLabel: c.typeLabel })), human: created.length > 0 } });
        await advance(3);
        const link: DocLink[] = po && type !== 'purchase_order' && !created.some(c => c.ruleCode === 'AMBIGUOUS_PO_MATCH') ? [{ id: `LNK-${doc.id}-${po.id}`, sourceId: doc.id, targetId: po.id, relationship: 'for_po', confidence, confirmedBy: confirmed ? 'Explicit PO reference' : null }] : [];
        const status = type === 'invoice' ? (created.length ? 'NEEDS_REVIEW' : 'VERIFIED') : created.length ? 'NEEDS_REVIEW' : link.length ? 'MATCHED' : 'EXTRACTED';
        data.commit({ docs: [{ ...doc, status }], links: link, claims: [], issues: created, note: `${TYPE_CONFIG[type].label} ${docNumber(doc)} processed from chat`, entityId: doc.id }, 'Purchasing Agent');
        add({ id: uid(), kind: 'card', card: { type: 'saved', lines: [`${TYPE_CONFIG[type].label} ${docNumber(doc)} saved${po ? ` under ${docNumber(po)}` : type === 'purchase_order' ? '' : ' as an unmatched record'}.`, type === 'invoice' ? (created.length ? 'Status: needs review. It cannot be exported as a verified invoice until its issues are resolved.' : 'Status: verified — no open issues, so it is eligible for the verified-invoice export.') : `Status: ${status.toLowerCase().replace('_', ' ')}.`, created.length ? `${created.length} issue${created.length === 1 ? '' : 's'} raised in Action Items → Issues.` : 'No issues were raised.'] } });
        await advance(4);
        say('Done. You can resolve any issues in Action Items whenever you are ready.');
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
    if (f.stage === 'ask_file') {
      if (files[0]) { void run(files[0]); return; }
      say('I still need the file. Use the paperclip to attach it, then send.'); return;
    }
    const t = clean.toLowerCase();
    const claimish = /claim|receipt|expense|reimburs/.test(t); const purchasish = /invoice|quotation|purchase order|\bpo\b|delivery order|payment|supplier/.test(t);
    if (files.length && !claimish && !purchasish) {
      flow.current = { intent: null, stage: 'ask_file' };
      add({ id: uid(), kind: 'quick', options: [{ id: 'claim', label: 'An expense claim receipt' }, { id: 'process', label: 'A purchasing document' }] });
      pendingFile.current = files[0]; return;
    }
    if (claimish && !purchasish) { flow.current = { intent: 'claim', stage: 'ask_purpose' }; setStages(DEMO_STAGES.map((_, i) => (i === 0 ? 'waiting' : 'queued'))); touch();
      if (files[0]) pendingFile.current = files[0];
      say('What was the expense for? Please give the business purpose and any attendees.'); return; }
    if (purchasish) { flow.current = { intent: /match/.test(t) ? 'match' : /check|compare/.test(t) ? 'compare' : 'process', stage: 'ask_file' }; setStages(DEMO_STAGES.map((_, i) => (i === 0 ? 'waiting' : 'queued'))); touch();
      if (files[0]) { void run(files[0]); return; }
      say('Attach the document with the paperclip and I will process it.'); return; }
    say('I can submit an expense claim or process a purchasing document. Pick one of the suggestions, or describe what you want to do. You can also ask me to prepare the month-end review pack.');
  }, [add, busy, run, say]);

  const choose = useCallback((msgId: string, optionId: string) => {
    setMessages(items => items.map(x => (x.id === msgId && x.kind === 'quick' ? { ...x, used: true } : x)));
    const file = pendingFile.current; pendingFile.current = null;
    if (optionId === 'claim') { flow.current = { intent: 'claim', stage: 'ask_purpose' }; say('What was the expense for? Please give the business purpose and any attendees. I will use the receipt you attached.'); pendingFile.current = file; }
    else { flow.current = { intent: 'process', stage: 'ask_file' }; if (file) void run(file); }
  }, [run, say]);

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
