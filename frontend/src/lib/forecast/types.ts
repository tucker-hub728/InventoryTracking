/**
 * Forecast domain types + period helpers.
 *
 * A forecast entry is the planning unit from the SOT workbook ("MFG Schedule
 * and Forecast by Customer and Product (Runs)"): for a given product, customer
 * and month we record how many production *runs* are planned. Quarterly and
 * full-year views are roll-ups of those monthly run counts.
 *
 * Entries are persisted via the forecast API (``@/lib/api/forecast``) and saved
 * as an e-signed batch; this module holds the shared month / period vocabulary
 * used by the grid and the Forecast Impact tab.
 */

export const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** Period filter shared by the Forecast page and the Forecast Impact tab. */
export type PeriodKey = 'full' | 'q1' | 'q2' | 'q3' | 'q4';

export interface PeriodOption {
  key: PeriodKey;
  label: string;
  /** Months (0-based) the period covers. */
  months: number[];
}

export const PERIODS: readonly PeriodOption[] = [
  { key: 'full', label: 'Full year', months: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { key: 'q1', label: 'Q1 · Jan–Mar', months: [0, 1, 2] },
  { key: 'q2', label: 'Q2 · Apr–Jun', months: [3, 4, 5] },
  { key: 'q3', label: 'Q3 · Jul–Sep', months: [6, 7, 8] },
  { key: 'q4', label: 'Q4 · Oct–Dec', months: [9, 10, 11] },
] as const;

/** Months covered by a period key (defaults to the full year). */
export function periodMonths(key: PeriodKey): number[] {
  return (PERIODS.find((p) => p.key === key) ?? PERIODS[0]!).months;
}

/** Years offered in the year selector, centered on the current year. */
export function forecastYearOptions(current: number): number[] {
  return [current - 1, current, current + 1];
}
