/* ============================================================
   TutupBuku domain types (see TutupBuku_Project_Context.md §8–9).
   Money is integer sen. Dates are date-only ISO strings.
   Documents / Issues pages run on DUMMY data until a backend exists.
   ============================================================ */

export type DocType =
  | 'quotation' | 'purchase_order' | 'delivery_order' | 'invoice'
  | 'payment_advice' | 'payment_receipt' | 'claim_receipt' | 'unclassified';

export type DocStatus = 'UPLOADED' | 'EXTRACTED' | 'MATCHED' | 'NEEDS_REVIEW' | 'VERIFIED' | 'REJECTED' | 'PROCESSING' | 'NEEDS_CONFIGURATION' | 'FAILED';

export type FieldKind = 'text' | 'date' | 'money';

export interface Field {
  key: string;
  label: string;
  kind: FieldKind;
  value: string;      // text / ISO date; money fields keep their display-free decimal in `sen`
  sen?: number;
  confidence?: number; // 0..1 from the (dummy) Docs Agent
  sourceRefs?: SourceRef[];
}

export interface LineItem {
  id: string;
  description: string;
  quantity: number;
  unitSen: number | null;
  totalSen: number | null;
}

export interface DocRecord {
  id: string;
  docType: DocType;
  flow: 'purchasing' | 'claims';
  filename: string;
  fields: Field[];
  lines: LineItem[];
  status: DocStatus;
  hash: string;
  version: number;
  uploadedAt: string;
  uploadedBy: string;
  note?: string;
  rawStatus?: string;
  sourceRefs?: SourceRef[];
  agentResults?: Record<string, { status?: string; summary?: string; data?: Record<string, unknown> }>;
  inputVersion?: number;
  analysisVersion?: number;
  purpose?: string;
}

export interface SourceRef { documentId?: string; page?: number; row?: number; line?: number; field?: string; quote?: string; kind?: string }

export type LinkState = 'confirmed' | 'proposed';

/** Simplified document_links: a source document attached to a purchase-order document. */
export interface DocLink {
  id: string;
  sourceId: string;
  targetId: string;          // the PO document (or an invoice, for payments)
  relationship: 'for_po' | 'settles_invoice';
  confidence: number | null;
  confirmedBy: string | null;
}

export interface Account { code: string; name: string }

/** PLAUSIBLE and NEEDS_REVIEW are both "Pending" for the reviewer; only APPROVED is exportable. */
export type ClaimStatus = 'PLAUSIBLE' | 'NEEDS_REVIEW' | 'APPROVED' | 'REJECTED';

export interface Claim {
  id: string;
  employee: string;
  receiptDocId: string;
  employeePurpose: string;
  categoryCode: string | null;
  categoryConfidence: number;
  categoryReasoning: string;
  alternativeCodes: string[];
  standardizedDescription: string;
  findings: string[];          // Claims Verification Agent notes
  status: ClaimStatus;
  decision?: { by: string; at: string; reason?: string };
}

export type Severity = 'INFO' | 'WARNING' | 'HIGH';
export type IssueStatus = 'OPEN' | 'UNDER_REVIEW' | 'RESOLVED' | 'DISMISSED';

export interface EvidenceRow { label: string; expected?: string; found?: string; note?: string }

export interface Issue {
  id: string;
  ruleCode: string;
  typeLabel: string;
  title: string;
  severity: Severity;
  status: IssueStatus;
  docIds: string[];
  claimId?: string;
  fieldKey?: string;         // EXTRACTION_UNCERTAIN: which field of docIds[0]
  candidateIds?: string[];   // AMBIGUOUS_PO_MATCH: PO documents to choose from
  detected: string;
  why: string;
  suggested: string[];
  evidence: EvidenceRow[];
  createdAt: string;
  resolution?: string;
  sourceRefs?: SourceRef[];
  rawStatus?: string;
}

export interface IntakeJob {
  id: string;
  documentId: string;
  status: 'queued' | 'processing' | 'completed' | 'needs_review' | 'needs_configuration' | 'failed' | string;
  events: { eventId?: string; event_id?: string; timestamp?: string; createdAt?: string; agent?: string; state?: string; summary?: string; payload?: Record<string, unknown> }[];
  inputVersion?: number;
  runId?: string;
  createdAt?: string;
  updatedAt?: string;
  error?: { code?: string; message?: string } | null;
  summary?: string;
}

export interface WorkspaceMasterData {
  chartOfAccounts: { code: string; label?: string; name?: string; active?: boolean }[];
  suppliers: { id?: string; legalName: string; registrationNumber?: string; active?: boolean }[];
  buyerProfile: { legalName: string; registrationNumber?: string } | null;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  actor: string;
  actorKind: 'human' | 'agent';
  action: string;
  entityId: string;
  previous?: string;
  next?: string;
}

export interface Toast { id: number; message: string; tone: 'info' | 'success' | 'error' }
