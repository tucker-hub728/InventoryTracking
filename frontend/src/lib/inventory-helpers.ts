import type { InventoryItem, LedgerEntry, LedgerMap } from '@/types/inventory';
import type { BadgeTone } from '@/types/ui';
import { daysFromNow } from './utils';

export type ExpRisk = 'none' | 'soon' | 'imminent' | 'expired';

export interface ExpiryStatus {
  label: string;
  tone: BadgeTone;
}

/**
 * Classify a lot's expiry date against a near-expiry threshold (in days),
 * for the colour-coded indicators on the inventory unit ledger:
 *
 *   - already past expiry        → "Expired"     (red / danger)
 *   - within ``thresholdDays``   → "Near expiry" (amber / warning)
 *   - further out                → "OK"          (green / success)
 *
 * "Expires today" (0 days) counts as *near expiry*, not expired — the lot
 * is still usable that day. Returns ``null`` when there's no usable date,
 * so the caller renders no badge.
 */
export function expiryStatus(
  exp: string | null | undefined,
  thresholdDays: number,
): ExpiryStatus | null {
  const days = daysFromNow(exp);
  if (days === null) return null;
  if (days < 0) return { label: 'Expired', tone: 'danger' };
  if (days <= thresholdDays) return { label: 'Near expiry', tone: 'warning' };
  return { label: 'OK', tone: 'success' };
}

/** Classify expiry urgency for badges/sorting. */
export function expRisk(item: InventoryItem): ExpRisk {
  const days = daysFromNow(item.expires);
  if (days === null) return 'none';
  if (days < 0) return 'expired';
  if (days <= 14) return 'imminent';
  if (days <= 60) return 'soon';
  return 'none';
}

/** Human label for status — currently identity, but a centralizing seam. */
export function statusDisplay(status: InventoryItem['status']): string {
  return status;
}

/** Find the most recent ledger entry's date for an item, or null. */
export function lastUpdated(itemId: string, ledgers: LedgerMap): string | null {
  const bucket = ledgers[itemId];
  if (!bucket || bucket.entries.length === 0) return null;
  return bucket.entries[0]?.date ?? null;
}

/** Sum of all stock-in units in a ledger. */
export function totalIn(entries: LedgerEntry[] | undefined): number {
  return entries?.reduce((s, e) => s + (e.in ?? 0), 0) ?? 0;
}

/** Sum of all stock-out units in a ledger. */
export function totalOut(entries: LedgerEntry[] | undefined): number {
  return entries?.reduce((s, e) => s + (e.out ?? 0), 0) ?? 0;
}
