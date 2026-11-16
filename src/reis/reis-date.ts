/** REIS requires dates (cus_birth_date, issue_date, expiry_date, valid_until) as YYYY-MM-DD. */
const REIS_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** REIS payload fields that carry dates. */
export const REIS_DATE_FIELDS = [
  'cus_birth_date',
  'issue_date',
  'expiry_date',
  'valid_until',
] as const;

/** True only for a real calendar date in strict YYYY-MM-DD form (rejects 2023-02-31). */
export function isReisDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = REIS_DATE_PATTERN.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** Returns the names of date fields present in the payload that are not valid REIS dates. */
export function findInvalidReisDates(payload: object): string[] {
  const record = payload as Record<string, unknown>;
  return REIS_DATE_FIELDS.filter((f) => record[f] !== undefined && !isReisDate(record[f]));
}
