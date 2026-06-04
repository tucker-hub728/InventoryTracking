/**
 * Movements API — wraps ``/api/v1/movements`` and the per-item
 * ``/items/{id}/ledger`` endpoint. Read-only in Chunk 2; write
 * endpoints (receipt / dispense / adjustment / transfer / discard /
 * reverse) land with Chunk 4+.
 *
 * Numeric fields are JSON strings (Postgres NUMERIC); the per-row
 * adapter (see ``movements-adapter.ts``) turns them into numbers
 * before the table renders.
 */

import { api } from './client';

export type MovementType =
  | 'receipt'
  | 'dispense'
  | 'adjustment'
  | 'discard'
  | 'transfer_out'
  | 'transfer_in';

/** Display labels — keep aligned with the backend ``MovementType`` enum. */
export const MOVEMENT_TYPE_LABEL: Record<MovementType, string> = {
  receipt: 'Receipt',
  dispense: 'Dispense',
  adjustment: 'Adjustment',
  discard: 'Discard',
  transfer_out: 'Transfer out',
  transfer_in: 'Transfer in',
};

/** Sign of the qty_delta enforced by each type — useful for the UI to colour the row. */
export const MOVEMENT_TYPE_SIGN: Record<MovementType, 'in' | 'out' | 'signed'> = {
  receipt: 'in',
  transfer_in: 'in',
  dispense: 'out',
  discard: 'out',
  transfer_out: 'out',
  adjustment: 'signed',
};

export interface ApiMovement {
  id: string;
  item_id: string;
  item_number: string | null;
  item_description: string | null;

  lot_id: string | null;
  lot_number: string | null;
  /** Lot expiry (ISO date) — surfaced in the ledger's Expiry column. */
  lot_expiration_date: string | null;

  from_location_id: string | null;
  from_location_code: string | null;
  from_location_name: string | null;

  to_location_id: string | null;
  to_location_code: string | null;
  to_location_name: string | null;

  movement_type: MovementType;
  /** Signed NUMERIC string — ``"+50"`` / ``"-3"``. */
  qty_delta: string;
  /** Unsigned NUMERIC string — what the operator entered. */
  qty_abs: string;

  reason_code: string | null;
  notes: string | null;
  reference: string | null;
  /** Free-text "where did it go" — set on unit-out (dispense) rows. */
  destination_text: string | null;

  reversal_of_id: string | null;
  /**
   * FK into ``audit.reauth_events`` — the audit viewer fetches the
   * canvas signature image via ``signatureImageUrl(reauth_evidence_id)``.
   * Null on pre-e-sign smoke rows; populated on every receipt /
   * dispense / discard / adjustment / transfer / reverse from Chunk 4+.
   */
  reauth_evidence_id: string | null;

  performed_by_user_id: string;
  /** Joined from ``app.users`` — used by the ledger "By" column and the
   *  audit-timeline movement rows. Null only for legacy rows whose
   *  performer was hard-deleted. */
  performed_by_user_name: string | null;
  performed_by_user_email: string | null;
  performed_at: string;
  created_at: string;
}

export interface ApiMovementListResponse {
  items: ApiMovement[];
  total: number;
  limit: number;
  offset: number;
}

export interface ListMovementsParams {
  itemId?: string;
  lotId?: string;
  locationId?: string;
  type?: MovementType;
  limit?: number;
  offset?: number;
}

export interface NewLotInput {
  lot_number: string;
  expiration_date?: string | null;
  manufacture_date?: string | null;
  vendor_id?: string | null;
  coa_url?: string | null;
  notes?: string | null;
}

export interface ReceiptInput {
  item_id: string;
  location_id: string;
  /** Decimal as a JSON number; backend parses to NUMERIC. Must be > 0. */
  qty: number;

  // Lot — exactly one of these two must be set.
  lot_id?: string;
  new_lot?: NewLotInput;

  /** UUID from the most recent ``authApi.reauth({action:'movement.receipt'})``. */
  evidence_id: string;
}

export interface DispenseInput {
  item_id: string;
  location_id: string;
  /** Required — you can't dispense without naming the lot. */
  lot_id: string;
  /** Must be > 0 and ≤ available at (lot, location). */
  qty: number;
  /** Free-text "where did it go". Required. */
  destination: string;

  /** UUID from ``authApi.reauth({action:'movement.dispense'})``. */
  evidence_id: string;
}

export interface DiscardInput {
  item_id: string;
  location_id: string;
  lot_id: string;
  /** Unsigned magnitude — backend stores as -qty on the row. */
  qty: number;
  /** Required — expired / damaged / contaminated / recalled / etc. */
  reason_code: string;
  notes?: string | null;
  reference?: string | null;
  /** UUID from ``authApi.reauth({action:'movement.discard'})``. */
  evidence_id: string;
}

export interface AdjustmentInput {
  item_id: string;
  location_id: string;
  lot_id: string;
  /** **Signed.** ``+5`` bumps the balance, ``-2`` reduces it. Zero is rejected. */
  qty_delta: number;
  /** Required — count_variance / opening_balance / write_down / etc. */
  reason_code: string;
  notes?: string | null;
  reference?: string | null;
  /** UUID from ``authApi.reauth({action:'movement.adjustment'})``. */
  evidence_id: string;
}

export interface TransferInput {
  item_id: string;
  lot_id: string;
  from_location_id: string;
  to_location_id: string;
  /** Must be > 0 and ≤ available at the source. Source ≠ destination. */
  qty: number;
  /** UUID from ``authApi.reauth({action:'movement.transfer'})``. */
  evidence_id: string;
}

/** Backend returns both legs so the UI can render the pair atomically. */
export interface TransferResponse {
  transfer_out: ApiMovement;
  transfer_in: ApiMovement;
}

export interface ReverseInput {
  reason_code: string;
  notes?: string | null;
  /** UUID from ``authApi.reauth({action:'movement.reverse'})``. */
  evidence_id: string;
}

/** Per-(lot, location) availability for the dispense picker. */
export interface StockByLotEntry {
  lot_id: string;
  lot_number: string;
  lot_status: 'quarantined' | 'released' | 'expired' | 'recalled';
  expiration_date: string | null;
  location_id: string;
  location_code: string;
  location_name: string;
  /** NUMERIC as string from the API. */
  qty_available: string;
  last_movement_at: string | null;
}

export const movementsApi = {
  list: (params: ListMovementsParams = {}, opts?: { signal?: AbortSignal }) =>
    api.get<ApiMovementListResponse>('/movements', {
      query: {
        item_id: params.itemId,
        lot_id: params.lotId,
        location_id: params.locationId,
        type: params.type,
        limit: params.limit,
        offset: params.offset,
      },
      signal: opts?.signal,
    }),

  /**
   * Per-item ledger. The backend 404s when the item doesn't exist
   * (instead of returning an empty list), so callers can distinguish
   * "no movements yet" from "wrong item ID."
   */
  listForItem: (
    itemId: string,
    params: { limit?: number; offset?: number } = {},
    opts?: { signal?: AbortSignal },
  ) =>
    api.get<ApiMovementListResponse>(`/items/${itemId}/ledger`, {
      query: { limit: params.limit, offset: params.offset },
      signal: opts?.signal,
    }),

  /**
   * Record a unit in (vendor → inventory). Requires a fresh
   * reauth evidence for ``action='movement.receipt'`` — see
   * ``useReauth`` for the UI helper that mints one.
   *
   * Returns the inserted movement row with joined item/lot/location
   * names, ready to slot into a ledger table.
   */
  receipt: (body: ReceiptInput) =>
    api.post<ApiMovement>('/movements/receipt', { json: body }),

  /**
   * Record a unit out (inventory → consumed). Requires
   * a fresh reauth evidence for ``action='movement.dispense'``.
   *
   * The backend rejects overdraws with a structured 422
   * (``code='dispense_exceeds_available'``).
   */
  dispense: (body: DispenseInput) =>
    api.post<ApiMovement>('/movements/dispense', { json: body }),

  /**
   * Record a stock discard (expired / damaged / contaminated). Distinct
   * movement_type from dispense so audit reports can separate the two.
   * Requires ``action='movement.discard'`` evidence. Overdraw → 422
   * ``discard_exceeds_available``.
   */
  discard: (body: DiscardInput) =>
    api.post<ApiMovement>('/movements/discard', { json: body }),

  /**
   * Record a signed adjustment (count variance, opening balance, etc.).
   * ``qty_delta`` is signed — positive bumps stock, negative reduces.
   * Zero rejected (``adjustment_zero_delta``). Negative overdraw →
   * ``adjustment_exceeds_available``. Requires
   * ``action='movement.adjustment'`` evidence.
   */
  adjustment: (body: AdjustmentInput) =>
    api.post<ApiMovement>('/movements/adjustment', { json: body }),

  /**
   * Record a two-leg transfer between locations. Writes ``transfer_out``
   * + ``transfer_in`` atomically; the response carries both rows so the
   * ledger UI can show the pair without a second fetch. Requires
   * ``action='movement.transfer'`` evidence. Same-location → 422
   * ``transfer_same_location``; overdraw → 422 ``transfer_exceeds_available``.
   */
  transfer: (body: TransferInput) =>
    api.post<TransferResponse>('/movements/transfer', { json: body }),

  /**
   * Reverse an existing ledger entry by writing a counter-movement. The
   * original stays put (ledger is append-only); the counter carries
   * ``reversal_of_id`` pointing at it. Transfer pairs reverse both
   * legs atomically and the response includes both counter rows.
   * Requires ``action='movement.reverse'`` evidence.
   *
   * Errors: ``movement_already_reversed`` (one reversal per original),
   * ``reversal_already_a_reversal`` (you can't reverse a reversal),
   * ``reversal_exceeds_available`` (destination has been mostly used up).
   */
  reverse: (movementId: string, body: ReverseInput) =>
    api.post<ApiMovement[]>(`/movements/${movementId}/reverse`, { json: body }),

  /**
   * Per-lot, per-location availability for one item. Powers the
   * dispense wizard's lot picker ("L-123 at LN2-A — 25 vials").
   * Only returns positive balances unless ``includeEmpty`` is set.
   */
  stockByLot: (
    itemId: string,
    params: { locationId?: string; includeEmpty?: boolean } = {},
    opts?: { signal?: AbortSignal },
  ) =>
    api.get<StockByLotEntry[]>(`/items/${itemId}/stock-by-lot`, {
      query: {
        location_id: params.locationId,
        include_empty: params.includeEmpty,
      },
      signal: opts?.signal,
    }),
};
