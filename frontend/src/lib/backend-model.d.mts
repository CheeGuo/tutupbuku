import type { Account, AuditEntry, Claim, DocLink, DocRecord, Issue } from '../types';

export interface BackendProjection {
  docs: DocRecord[];
  links: DocLink[];
  claims: Claim[];
  issues: Issue[];
  audit: AuditEntry[];
  masterData: Record<string, unknown> & { chartOfAccounts: Account[] };
}

export function projectBackendRecords(input?: {
  documents?: Array<Record<string, any>>;
  issues?: Array<Record<string, any>>;
  jobs?: Array<Record<string, any>>;
  masterData?: Record<string, any>;
  email?: string;
}): BackendProjection;
