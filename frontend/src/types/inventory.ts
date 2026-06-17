export type InventoryStatus =
  | 'Available'
  | 'Low stock'
  | 'Expiring'
  | 'Quarantine'
  | 'Expired'
  | 'Out of stock';

export interface InventoryItem {
  /** Human-readable item number (e.g. ``CM-0001``). What URLs key on. */
  id: string;
  /** Backend UUID. Needed for endpoints that take an item_id (ledger, …). */
  uuid: string;
  desc: string;
  vendor: string;
  lead: number;
  invValue: number;
  poValue: number;
  qty: number;
  months: number | null;
  poNote: string;
  poDue: string;
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
  location: string;
  /** Storage-location UUID backing the ``location`` cell, when it maps to a
   *  real location. ``null`` for free-text dispense destinations (which aren't
   *  storage locations). Lets the ledger deep-link to that location's /ln2 tab. */
  locationId?: string | null;
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
