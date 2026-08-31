import type { LotReleaseState } from '@/lib/api/lots';

export type InventoryStatus =
  | 'Available'
  | 'Low stock'
  | 'Expiring'
  | 'Quarantine'
  | 'Expired'
  | 'Out of stock';

import type { TierType } from '@/lib/api/tiers';

export type { TierType };

export interface InventoryItem {
  /** Human-readable item number (e.g. ``CM-0001``). What URLs key on. */
  id: string;
  /** Backend UUID. Needed for endpoints that take an item_id (ledger, …). */
  uuid: string;
  desc: string;
  /** Free-text unit of measure (each, mL, box …). Empty string when unset. */
  uom: string;
  /** Blind-consumed with no per-lot traceability when true. */
  isConsumable: boolean;
  /** Tier (requirements v2 §6). ``tierType`` drives the Type column. */
  tierId: string;
  tierName: string;
  tierType: TierType;
  tierTone: string;
  /** The item's type prefix (REQ-2026-07-09-ITM-001) — the tab/filter criterion. */
  prefixId: string;
  prefixCode: string;
  prefixLabel: string | null;
  supplier: string;
  lead: number;
  invValue: number;
  poValue: number;
  /** Physical on-hand (includes expired). Ledger balances reconcile to this. */
  qty: number;
  /** Available = on-hand minus date-expired units. Used for the Units count,
   *  reorder and forecasting; expired stock stays counted in ``qty``. */
  qtyAvailable: number;
  months: number | null;
  onOrder: number;
  /** Arrived, not yet received to inventory. Drives the "Awaiting release" badge. */
  qtyAwaitingRelease: number;
  mustOrder: number;
  /** Per-item near-expiry window (days) driving the ledger expiry colours. */
  nearExpiryThresholdDays: number;
  /** Direct BOM components. Always 0 for a raw material; on a built tier, 0
   *  means the recipe hasn't been defined yet. */
  bomLineCount: number;
  location: string;
  lot: string;
  expires: string;
  threshold: number;
  status: InventoryStatus;
  /** ISO timestamp of the most recent row mutation. From ``items.updated_at``. */
  updatedAt: string | null;
}

export interface LedgerEntry {
  date: string;
  in: number;
  out: number;
  balance: number;
  /** Node name shown in the Location cell (e.g. "Box 01" / a flat name). */
  location: string;
  /** Storage node UUID behind the cell, if any. */
  locationId?: string | null;
  /** Full hierarchy breadcrumb for the cell's tooltip (e.g. "Q1 › R01 › C01 › Box 01"). */
  locationPath?: string | null;
  lot: string;
  /** Lot UUID behind the cell — drives the link to the originating order. */
  lotId?: string | null;
  exp: string;
  /** The LOT's release state as it is now — carried on the row only so the
   *  per-lot subtotal can show it. Never rendered against an individual
   *  movement: a movement is a past event and this is the present state. */
  lotReleaseState?: LotReleaseState | null;
  /** Decimal (string). The LOT's per-unit price as it is NOW (RPT-003).
   *
   *  Carried on the row for the same reason as `lotReleaseState`, and with the
   *  same rule: it is present state, not history — prices stay editable after
   *  receive and nothing records what one was on the day of a movement. So it
   *  is rendered on the per-lot subtotal only, never against a movement.
   *
   *  `null` means no price recorded, which is NOT `0`. */
  lotUnitPrice?: string | null;
  initials: string;
  /** Full ``app.users.full_name`` of the operator who recorded the row.
   *  Rendered in the ledger "By" column and the audit-timeline movement
   *  row. ``null`` only for legacy smoke rows that pre-date the joined
   *  serializer. */
  actorName: string | null;
  reason: string;
  /** Backend movement UUID — required for the row-action reverse button. */
  movementId?: string;
  /** Underlying movement_type, for tooltips + the reverse attestation copy. */
  movementType?: string;
  /** Kit that caused this row, when there is one — drives the AY/FG ledger's
   *  Transaction chip ("Made KIT-0034"). A transaction reference only; SRS §7
   *  excludes finished-good → component-lot traceability. */
  kitNumber?: string | null;
  kitId?: string | null;
  /** Customer shipment (CUST-001 / TRX-005): the named customer the finished
   *  good left inventory to (null = catalog / unassigned), and the reference /
   *  tracking number. Set only on ``customer_shipment`` rows.
   *
   *  The id is carried alongside the name so the column can link to that
   *  customer's shipping history. It can be null while the name is not —
   *  the ledger is append-only and outlives the master data it names. */
  customerName?: string | null;
  customerId?: string | null;
  referenceNumber?: string | null;
  /** True if this row is itself a reversal of an earlier row. */
  isReversal?: boolean;
  /** True if a later row already reverses this one (one reversal per original). */
  isReversed?: boolean;
}

export interface LedgerBucket {
  location: string;
  lots: string[];
  exp: string;
  entries: LedgerEntry[];
}

export type LedgerMap = Record<string, LedgerBucket>;

export interface Signoff {
  id: string;
  user: string;
  initials: string;
  role: string;
  action: string;
  direction: 'in' | 'out';
  units: number;
  lot: string;
  date: string;
  reason: string;
  signature: string;
}

export interface InventoryFilters {
  query: string;
  status: InventoryStatus | 'all';
  sortKey: keyof InventoryItem | 'lastUpdated';
  sortDir: 'asc' | 'desc';
  page: number;
  pageSize: number;
}
