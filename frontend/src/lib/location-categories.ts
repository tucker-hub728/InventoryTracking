/**
 * The controlled location categories (REQ-2026-07-01-LOC-002).
 *
 * The picker offers exactly these six; the backend column stays free-text so
 * the list can be extended later without a migration (LOC-002 / ADM-001).
 * Quarantine is intentionally de-scoped (LOC-005).
 */
export const LOCATION_CATEGORIES = [
  'Materials Management',
  'Lab',
  'QC',
  'Engineering',
  'PD Lab One',
  'PD Lab Two',
] as const;

export type LocationCategory = (typeof LOCATION_CATEGORIES)[number];
