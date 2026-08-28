/**
 * Consumables / Kanban / expiration API client — `/v1/consumables`
 * (docs/modules/consumables.md).
 *
 * Three rules from the requirements shape this surface, and they explain why
 * some obvious endpoints are missing:
 *
 *  * a Kanban HOLDS a balance (KAN-001, 2026-08-27) — issuing moves stock onto
 *    the floor, it no longer spends it, and `kanbanBalance` is what it holds.
 *    This reverses the old "an issue is terminal for quantity" rule that stood
 *    here; see the module docstring in `app/consumables/routes.py` for why;
 *  * consumables are STILL never back-flushed (07-09 TRX-004) — there is no
 *    de-issue and no return. Acknowledging a depletion is not a return: stock
 *    only ever moves forward, stores → Kanban → consumed;
 *  * expiration keeps being tracked after the quantity is gone (TX Spec §4.3) —
 *    which is what the register below is.
 *
 * Three writes are e-signed (`evidence_id`), each under its OWN action verb so
 * a ticket minted for one can never be spent on another: the issue, closing out
 * an expiry check, and — since KAN-001 — acknowledging what a Kanban consumed.
 */
import { api } from './client';
import type { CellOption } from './kits';

/** How close to its expiry a row is. `null` = comfortably in date, or no date
 *  at all (07-09: "expiration flags apply only where a date exists"). */
export type ExpiryFlag = 'warn' | 'expired';

/** Transaction Spec §4.2's outcomes for a physical check. */
export type Disposition = 'consumed' | 'reworked' | 'retested' | 'discarded';

export const DISPOSITIONS: readonly Disposition[] = [
  'consumed',
  'reworked',
  'retested',
  'discarded',
];

export const DISPOSITION_LABEL: Record<Disposition, string> = {
  consumed: 'Consumed before expiry',
  reworked: 'Removed — reworked',
  retested: 'Removed — retested',
  discarded: 'Removed — discarded',
};

/** One issuable source — a consumable lot at a storage location. */
export interface ConsumableSource {
  lot_id: string;
  lot_number: string | null;
  expiration_date: string | null;
  node_id: string;
  /** Human path, e.g. "Warehouse One › Shelf B". */
  location: string;
  qty: number;
  /** An LN2 box source: the operator taps the exact vials and the quantity
   *  follows, same as a kit issue. Consumables usually sit on a shelf, but not
   *  always — CR-004 is stored in Tank 1 (client 2026-08-11). */
  is_grid: boolean;
  grid_rows: number | null;
  grid_cols: number | null;
  /** This lot's occupied positions in that box. Empty for a bulk source. */
  cells: CellOption[];
}

/** One source pick on an issue. Several may be sent at once when the operator
 *  empties a part-used lot before opening a fresh one — each becomes its own
 *  register row so the two expiry dates stay independent. */
export interface ConsumableSourceInput {
  node_id: string;
  lot_id: string;
  qty: number;
  /** Box sources only, and required for them: the exact vials to empty. `qty`
   *  must equal their count — the backend rejects a box source without them
   *  rather than draining the lot FIFO. */
  cell_allocation_ids?: string[];
}

export interface ConsumableIssueInput {
  sources: ConsumableSourceInput[];
  /** Always a Kanban node, never the production area itself. */
  kanban_node_id: string;
  evidence_id: string;
  notes?: string | null;
}

export interface IssueResultLine {
  lot_id: string;
  lot_number: string | null;
  qty: number;
  expiration_date: string | null;
}

export interface ConsumableIssueResult {
  item_id: string;
  item_number: string;
  total_qty: number;
  kanban_node_id: string;
  kanban_path: string;
  performed_at: string;
  lines: IssueResultLine[];
}

/** One row of the Kanban register. Everything here except the `cleared_*`
 *  fields is derived server-side from the ledger movement, so it cannot drift
 *  from what actually happened. */
export interface IssuedConsumable {
  id: string;
  item_id: string;
  item_number: string;
  item_description: string | null;
  lot_number: string | null;
  qty: number;
  kanban_node_id: string;
  kanban_name: string;
  kanban_path: string;
  issued_at: string;
  issued_by: string | null;
  expiration_date: string | null;
  flag: ExpiryFlag | null;
  /** Negative once past the date; null when there is no date to count to. */
  days_to_expiry: number | null;
  cleared_at: string | null;
  cleared_by: string | null;
  disposition: Disposition | null;
  clear_note: string | null;
}

/** A page of the register. Same envelope as the item list, so the shared
 *  paginator drives it unchanged. */
export interface IssuedConsumableList {
  items: IssuedConsumable[];
  total: number;
  limit: number;
  offset: number;
}

export interface AcknowledgeInput {
  disposition: Disposition;
  note?: string | null;
  /** E-signature minted for `consumable.expiry_check`, bound to the register
   *  row being closed out. */
  evidence_id: string;
}

export interface ExpiryPolicy {
  warn_days: number;
}

function qs(params: Record<string, string | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const consumablesApi = {
  /** Issuable stock for one consumable. 422 `item_not_consumable` if the item
   *  isn't flagged — a non-consumable goes to production on a kit instead. */
  sources: (itemId: string, opts?: { signal?: AbortSignal }) =>
    api.get<ConsumableSource[]>(`/consumables/sources/${itemId}`, { signal: opts?.signal }),

  /** The register. Without `kanbanNodeId` this spans every Kanban. */
  issued: (
    params: { kanbanNodeId?: string; itemId?: string; includeCleared?: boolean } = {},
    opts?: { signal?: AbortSignal },
  ) =>
    api.get<IssuedConsumable[]>(
      `/consumables/issued${qs({
        kanban_node_id: params.kanbanNodeId,
        item_id: params.itemId,
        include_cleared: params.includeCleared,
      })}`,
      { signal: opts?.signal },
    ),

  /** The alert feed — everything warning or expired, across all Kanbans.
   *  Paged server-side: the register only ever grows. */
  expiring: (
    params: { limit?: number; offset?: number } = {},
    opts?: { signal?: AbortSignal },
  ) =>
    api.get<IssuedConsumableList>(
      `/consumables/expiring${qs({
        limit: params.limit === undefined ? undefined : String(params.limit),
        offset: params.offset === undefined ? undefined : String(params.offset),
      })}`,
      { signal: opts?.signal },
    ),

  /** E-signed. Action verb: `movement.consumable_issue`. */
  issue: (input: ConsumableIssueInput) =>
    api.post<ConsumableIssueResult>('/consumables/issue', { json: input }),

  /** Clear a flag after the physical check. E-signed — action verb:
   *  `consumable.expiry_check`. */
  acknowledge: (issueId: string, input: AcknowledgeInput) =>
    api.post<IssuedConsumable>(`/consumables/${issueId}/acknowledge`, { json: input }),

  expiryPolicy: (opts?: { signal?: AbortSignal }) =>
    api.get<ExpiryPolicy>('/consumables/expiry-policy', { signal: opts?.signal }),

  setExpiryPolicy: (warnDays: number) =>
    api.put<ExpiryPolicy>('/consumables/expiry-policy', { json: { warn_days: warnDays } }),
};

/** The e-sign action verb the issue dialog must mint evidence for. */
export const CONSUMABLE_ISSUE_ACTION = 'movement.consumable_issue';

/** The e-sign action verb for closing out an expiry check. Separate from the
 *  issue verb on purpose: a signature made to issue stock is not a signature
 *  saying that stock was later discarded, and the backend refuses the swap. */
export const CONSUMABLE_EXPIRY_CHECK_ACTION = 'consumable.expiry_check';

/** The e-sign action verb for acknowledging what a Kanban consumed (KAN-001).
 *  A THIRD verb, for the same reason there is a second: this signature writes
 *  stock off the books. */
export const CONSUMABLE_CONSUMPTION_ACTION = 'consumable.consumption';

// ── Kanban restock loop (KAN-001) ──────────────────────────────────────
//
// A Kanban holds NO balance — an issue debits the stock immediately.
// So there is nothing here that reads a bin's contents; the loop is:
//
//     request restock  →  acknowledge what was used  →  issue the replenishment
//
// and only that last step moves stock, through the ordinary issue dialog.

export type RestockState = 'open' | 'fulfilled' | 'cancelled';

export const RESTOCK_STATE_LABEL: Record<RestockState, string> = {
  open: 'Open',
  fulfilled: 'Restocked',
  cancelled: 'Cancelled',
};

export interface RestockRequest {
  id: string;
  kanban_node_id: string;
  kanban_path: string;
  item_id: string;
  item_number: string;
  description: string | null;
  requested_qty: number | null;
  note: string | null;
  state: RestockState;
  requested_at: string;
  requested_by: string | null;
  closed_at: string | null;
  closed_by: string | null;
  /** What the operator confirmed was used. Null until fulfilled. Stored on the
   *  request: no stock moves at acknowledgment, so no ledger row carries it. */
  consumed_qty: number | null;
  /** How much has been issued into this Kanban since the request was raised —
   *  "has my restock arrived yet". NOT a bin balance; a Kanban holds none. */
  issued_since_qty: number;
}

export interface RestockRequestList {
  items: RestockRequest[];
  total: number;
}

export interface RestockRequestInput {
  kanban_node_id: string;
  item_id: string;
  /** Optional — "we're low" is a legitimate request. */
  requested_qty?: number | null;
  note?: string | null;
}

/** Closing a restock request. The signature IS the acknowledgment.
 *
 *  `qty` is optional and the UI does not ask for it. It was collected at first,
 *  on the reading that KAN-001's "marks the depleted quantity consumed" wanted
 *  a number — but the stock was already debited at issue, so nothing consumes
 *  that figure: no balance moves, no report reads it, nothing reconciles
 *  against it. What it did produce was an attestation reading "0 was used"
 *  whenever the request carried no quantity, which is a false sentence over a
 *  Part 11 signature. The field stays on the wire for an integration that has a
 *  real number to record. */
export interface AcknowledgeConsumptionInput {
  qty?: number | null;
  note?: string | null;
  evidence_id: string;
}

export const kanbanRestockApi = {
  /** `itemId` asks the other way round — every open request for one
   *  consumable, across all Kanbans. That is the item page's question: a
   *  request is raised on the floor and answered in stores, by different
   *  people on different screens. */
  listRequests: (
    params: {
      kanbanNodeId?: string;
      itemId?: string;
      state?: RestockState;
      limit?: number;
      offset?: number;
    } = {},
    opts?: { signal?: AbortSignal },
  ) =>
    api.get<RestockRequestList>(
      `/consumables/restock-requests${qs({
        kanban_node_id: params.kanbanNodeId,
        item_id: params.itemId,
        state: params.state,
        limit: params.limit === undefined ? undefined : String(params.limit),
        offset: params.offset === undefined ? undefined : String(params.offset),
      })}`,
      { signal: opts?.signal },
    ),

  /** Not e-signed: asking for more moves no stock and asserts nothing about
   *  material. Any consumable may be requested — the bin need not already hold
   *  it, which is the point of raising the ask. */
  createRequest: (input: RestockRequestInput) =>
    api.post<RestockRequest>('/consumables/restock-requests', { json: input }),

  cancelRequest: (requestId: string) =>
    api.post<RestockRequest>(`/consumables/restock-requests/${requestId}/cancel`, { json: {} }),

  /** E-signed (`consumable.consumption`). Records the figure and closes the
   *  request; moves no stock, because the units were debited at issue. */
  acknowledgeConsumption: (requestId: string, input: AcknowledgeConsumptionInput) =>
    api.post<RestockRequest>(
      `/consumables/restock-requests/${requestId}/acknowledge`,
      { json: input },
    ),
};
