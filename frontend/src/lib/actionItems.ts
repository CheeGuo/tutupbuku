import type { Claim, Issue } from '../types';
import { useData } from '../state/store';
import { useExecution } from './execution';

export type Item = Issue & { live?: boolean };
export const isActive = (i: Issue) => i.status === 'OPEN' || i.status === 'UNDER_REVIEW';
export const isPending = (c: Claim) => c.status === 'PLAUSIBLE' || c.status === 'NEEDS_REVIEW';

/** The one place Action Items are counted, so the nav badge and the page tabs always agree. */
export function useActionItems() {
  const data = useData();
  const { run } = useExecution();
  // The month-end run's findings are ordinary action items; the run id is kept only as provenance.
  const liveItems: Item[] = run ? [
    ...(run.input_issues || []).map((x): Item => ({ id: `RUN-${x.id}`, ruleCode: 'RUN_INPUT', typeLabel: 'Blocked input', title: x.message, severity: 'HIGH', status: 'OPEN', docIds: [], live: true,
      detected: x.message, why: `The run stopped on this input. Location: ${x.location}.`, suggested: [x.required_action], evidence: x.source_refs.map(r => ({ label: 'Source', found: r })), createdAt: run.started_at })),
    ...(run.matching?.exceptions || []).map((x): Item => ({ id: `RUN-${x.exception_id}`, ruleCode: 'RUN_EXCEPTION', typeLabel: 'Bank-row match', title: x.title, severity: 'WARNING', status: 'OPEN', docIds: [], live: true,
      detected: x.reason, why: `Reported by the month-end run for bank row ${x.bank_row_id} (priority ${x.priority}).`, suggested: [x.required_action], evidence: x.source_refs.map(r => ({ label: 'Source', found: r })), createdAt: run.started_at })),
  ] : [];
  const items: Item[] = [...data.issues, ...liveItems];
  const activeCount = items.filter(isActive).length;
  const pendingCount = data.claims.filter(isPending).length;
  return { items, activeCount, pendingCount, total: activeCount + pendingCount };
}
