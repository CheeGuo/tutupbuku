import type { Claim, Issue } from '../types';
import { useData } from '../state/store';

export type Item = Issue & { live?: boolean };
export const isActive = (i: Issue) => i.status === 'OPEN' || i.status === 'UNDER_REVIEW';
export const isPending = (c: Claim) => c.status === 'PLAUSIBLE' || c.status === 'NEEDS_REVIEW';

/** The one place Action Items are counted, so the nav badge and the page tabs always agree. */
export function useActionItems() {
  const data = useData();
  // Month-end run findings (fixture bank rows) stay on the run's own review screen, not here.
  const items: Item[] = data.issues;
  const activeCount = items.filter(isActive).length;
  const pendingCount = data.claims.filter(isPending).length;
  return { items, activeCount, pendingCount, total: activeCount + pendingCount };
}
