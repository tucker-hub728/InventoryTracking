/**
 * The controlled location categories (REQ-2026-07-01-LOC-002).
 *
 * Mirrors the native ``app.location_category`` enum + the backend
 * ``LOCATION_CATEGORIES`` tuple — extending it requires a DB migration
 * (ALTER TYPE ... ADD VALUE). 2026-07-08: added Analytical Lab / Sterility Lab /
 * PD for the freezer import. Quarantine is intentionally de-scoped (LOC-005).
 */
export const LOCATION_CATEGORIES = [
  'Materials Management',
  'Lab',
  'QC',
  'Engineering',
  'PD Lab One',
  'PD Lab Two',
  'Analytical Lab',
  'Sterility Lab',
  'PD',
] as const;

export type LocationCategory = (typeof LOCATION_CATEGORIES)[number];
