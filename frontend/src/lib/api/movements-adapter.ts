/**
 * API → UI shape conversion for stock movements.
 *
 * The wire shape (``ApiMovement``) carries NUMERIC as strings, snake_case
 * keys, and machine-readable type codes. The UI's ``LedgerEntry`` is the
 * legacy seed shape that the existing ``LedgerTable`` renders. This
 * adapter is the only place the translation happens.
 *
 * Running balance is computed client-side over the rows we have. That's
 * accurate while the whole ledger fits in one page (≤500 rows). Beyond
 * that, the backend will need to compute it with a window function and
 * surface ``running_balance`` on each row — TODO for Chunk 6.
 */

import type { LedgerEntry } from '@/types/inventory';

import type { ApiMovement } from './movements';

function num(s: string | null | undefined): number {
  if (s == null || s === '') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 10); // YYYY-MM-DD
  } catch {
    return iso;
  }
}

/** "Jane Doe" → "JD"; nullable / blank input → ``null``. */
function initialsFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * Convert the API list (newest-first, paginated) to ``LedgerEntry[]``
 * with running balance. ``totalQtyOnHand`` is the live balance from
 * ``v_item_stock`` — we anchor the running balance to it so the most
 * recent row's ``balance`` matches what the snapshot card shows.
 *
 * If ``totalQtyOnHand`` isn't supplied, balance starts at zero on the
 * oldest row in the page — fine for short ledgers, misleading once
 * pagination kicks in.
 */
export function apiMovementsToLedgerEntries(
  apiRows: ApiMovement[],
  totalQtyOnHand?: number,
): LedgerEntry[] {
  // Build the set of "already reversed" originals — one pass through
  // the page lets the table disable the Reverse action on rows whose
  // counter has already been posted.
  const reversedOriginalIds = new Set<string>();
  for (const m of apiRows) {
    if (m.reversal_of_id) reversedOriginalIds.add(m.reversal_of_id);
  }

  // Walk newest-first, subtracting each delta to back-compute earlier
  // balances. That way row[0].balance always equals the live qty_on_hand.
  let runningBalance = totalQtyOnHand ?? 0;

  return apiRows.map((m) => {
    const delta = num(m.qty_delta);
    const qtyIn = delta > 0 ? num(m.qty_abs) : 0;
    const qtyOut = delta < 0 ? num(m.qty_abs) : 0;
    const balanceAfterRow = runningBalance;
    // Step back for the next iteration (older row).
    runningBalance -= delta;

    return {
      date: formatDate(m.performed_at),
      in: qtyIn,
      out: qtyOut,
      balance: balanceAfterRow,
      // For a unit-out (dispense) the "Location" column shows where it went —
      // the free-text destination. Every other row shows the storage location.
      location:
        m.movement_type === 'dispense'
          ? m.destination_text ?? m.from_location_code ?? '—'
          : m.to_location_code ?? m.from_location_code ?? '—',
      lot: m.lot_number ?? '—',
      exp: m.lot_expiration_date ?? '—',
      // ``initials`` is the compact form for the narrow ledger column —
      // ``actorName`` carries the full name for tooltips and the audit
      // timeline.
      initials: initialsFromName(m.performed_by_user_name) ?? '—',
      actorName: m.performed_by_user_name,
      reason: m.reason_code ?? m.notes ?? m.movement_type,
      movementId: m.id,
      movementType: m.movement_type,
      isReversal: m.reversal_of_id !== null,
      isReversed: reversedOriginalIds.has(m.id),
    };
  });
}
