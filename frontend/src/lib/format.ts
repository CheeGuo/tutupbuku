/* Formatting helpers — en-MY display conventions.
   Money is integer sen. Dates are date-only ISO strings. */

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Format integer sen as RM 1,234.56 (no floating point). */
export function formatMoney(sen: number): string {
  const sign = sen < 0 ? '-' : '';
  const abs = Math.abs(sen);
  return `${sign}RM ${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

/** Plain decimal for CSV / inputs: 1234.56 */
export function decimalFromSen(sen: number): string {
  const sign = sen < 0 ? '-' : '';
  const abs = Math.abs(sen);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Parse a user-entered decimal amount into sen. Returns null if invalid. */
export function parseAmountToSen(input: string): number | null {
  const trimmed = input.trim().replace(/,/g, '').replace(/^RM/i, '').trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 100 + (m[3] ? parseInt(m[3].padEnd(2, '0'), 10) : 0));
}

/** Validate a real Gregorian date without timezone conversion or rollover. */
export function isDateOnly(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= days[m - 1];
}

/** '2026-09-14' -> '14 Sep 2026' (no timezone conversion). */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'Not supplied';
  if (!isDateOnly(iso)) return 'Invalid date';
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS_SHORT[m - 1]} ${y}`;
}

/** Timestamp with offset -> '10 Oct 2026, 09:42' in Asia/Kuala_Lumpur. */
export function formatTimestamp(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-MY', {
      timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** NEEDS_REVIEW -> Needs review */
export function humanStatus(status: string): string {
  const text = status.replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
