import type { InventoryItem, LedgerEntry, LedgerMap } from '@/types/inventory';
import type { CategoryCode } from '@/config/inventory';
import { daysFromNow } from './utils';

export type ExpRisk = 'none' | 'soon' | 'imminent' | 'expired';

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

/**
 * Find the next available Item ID for a category prefix, padded to 4 digits.
 * Scans existing items for the highest numeric suffix on that prefix and
 * returns prefix + (max + 1).
 */
export function nextItemIdForCategory(
  code: CategoryCode,
  items: ReadonlyArray<Pick<InventoryItem, 'id'>>,
): string {
  let max = 0;
  for (const it of items) {
    if (!it.id.startsWith(`${code}-`)) continue;
    const n = Number(it.id.slice(code.length + 1));
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return `${code}-${String(max + 1).padStart(4, '0')}`;
}
