export type InventoryStatus =
  | 'Available'
  | 'Low stock'
  | 'Expiring'
  | 'Quarantine'
  | 'Expired'
  | 'Out of stock';

export type ItemKind = 'purchased' | 'built';

export interface InventoryItem {
  /** Human-readable item number (e.g. ``CM-0001``). What URLs key on. */
  id: string;
  /** Backend UUID. Needed for endpoints that take an item_id (ledger, …). */
  uuid: string;
  desc: string;
  /** Category (requirements v2 §6). ``categoryKind`` drives the Type column. */
  categoryId: string;
  categoryName: string;
  categoryKind: ItemKind;
  categoryTone: string;
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
  mustOrder: number;
  /** Per-item near-expiry window (days) driving the ledger expiry colours. */
  nearExpiryThresholdDays: number;
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
  exp: string;
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
