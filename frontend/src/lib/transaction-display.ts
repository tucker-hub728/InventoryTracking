/**
 * Single source of truth for how a transaction *type* is presented — badge
 * colour + label — so it looks identical everywhere it appears (the
 * transactions table, the transaction detail sheet, and an item's recent
 * transactions). Case-insensitive: the API returns UPPERCASE types.
 */

import type { BadgeTone } from '@/types/ui';

export function transactionTypeTone(type: string): BadgeTone {
  switch (type.toLowerCase()) {
    case 'receipt':
      return 'success';
    case 'transfer':
      return 'accent';
    default:
      return 'neutral';
  }
}

/** "RECEIPT" | "receipt" -> "Receipt". */
export function transactionTypeLabel(type: string): string {
  return type ? type.charAt(0).toUpperCase() + type.slice(1).toLowerCase() : type;
}
