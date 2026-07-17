/**
 * Mock catalogue, BOMs and locations for the Kitting / Reconciliation module.
 *
 * FRONTEND-ONLY. Nothing here talks to the backend — the module is a
 * click-through model of the kitting and back-flush flow described in
 * CellReady_Transaction_Spec_2026-07-01 §2–§4 and the SRS of 2026-07-01 §4.
 *
 * Item numbers, descriptions, suppliers, lots, expiry dates and storage
 * locations are lifted from the real seed so the screens read like the live
 * system. Two things are synthesised because the seed has no equivalent:
 *
 *   1. Finished goods. The seed carries no FG tier at all, so FG-1001/1002
 *      are invented from the cell-therapy outputs the seed implies.
 *   2. Tier semantics. The seed's ID prefixes are a false friend — its `CR-`
 *      items are tiered "Consumable / equipment" and its `AY-` items are
 *      "Assay / QC reference". Neither matches the doc meaning (CR = raw
 *      material, AY = sub-assembly). We remap by meaning, not by prefix.
 */
import { mockData } from '@/lib/mock-data';

/** Pinned so the demo reads the same on every load. The seed's expiry dates
 *  sit either side of this, which is what makes the expiry flags interesting. */
export const DEMO_TODAY = new Date('2026-07-17T09:00:00Z');

/** Items whose seed location is blank ("—") are parked here. */
const UNASSIGNED_LOCATION = 'Materials Management';

export type ItemTier = 'CR' | 'AY' | 'FG';

export type KitStatus = 'draft' | 'issued' | 'in_production' | 'closed' | 'cancelled';

export const KIT_STATUS_LABEL: Record<KitStatus, string> = {
  draft: 'Draft',
  issued: 'Issued',
  in_production: 'In Production',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

export const KIT_STATUS_TONE: Record<KitStatus, 'neutral' | 'accent' | 'success' | 'warning' | 'danger'> = {
  draft: 'neutral',
  issued: 'accent',
  in_production: 'warning',
  closed: 'success',
  cancelled: 'danger',
};

/**
 * Kit ledger event. Mirrors REQ-2026-07-09-TRX-003: a return posts as an
 * explicit `backflush`, never as a plain receipt, so the ledger self-explains
 * — issued 15, used 12, backflushed 3.
 */
export type KitEventType =
  | 'created'
  | 'issue'
  | 'additional_issue'
  | 'consume'
  | 'output'
  | 'scrap'
  | 'backflush'
  | 'cancel'
  | 'adjustment';

export const EVENT_LABEL: Record<KitEventType, string> = {
  created: 'Kit created',
  issue: 'Kit issue',
  additional_issue: 'Additional issue',
  consume: 'Consumed in production',
  output: 'Production output',
  scrap: 'Scrapped',
  backflush: 'Backflushed',
  cancel: 'Kit cancelled',
  adjustment: 'Count adjustment',
};

export interface KitEvent {
  id: string;
  at: string;
  type: KitEventType;
  itemId: string;
  /** Signed change to on-hand. 0 for events that record intent, not stock. */
  qtyDelta: number;
  location: string;
  note: string;
  actor: string;
}

export interface ReconItem {
  id: string;
  desc: string;
  tier: ItemTier;
  /** Blind-issued, expiry tracked, never reconciled (REQ-2026-07-09-TRX-004). */
  isConsumable: boolean;
  supplier: string;
  homeLocation: string;
  lot: string;
  /** ISO date, or null — expiry is optional at receipt (Amendment 3). */
  expires: string | null;
}

export interface BomLine {
  childId: string;
  qtyPerUnit: number;
}

export interface KitLine {
  itemId: string;
  qtyPerUnit: number;
  /** qtyPerUnit × buildQty. Explodes from the BOM. */
  qtyNeeded: number;
  /** Manual entry at issue time (Transaction Spec §2). */
  qtyIssued: number;
  /** Added mid-production via the edit function (Transaction Spec §2.1). */
  qtyAdditional: number;
  /** Entered at close-out from the traveler. null until close-out. */
  qtyUsed: number | null;
  sourceLocation: string;
  /** Defaults to sourceLocation, editable per line (Table 3's Inventory Location). */
  returnLocation: string;
  isConsumable: boolean;
}

export interface Kit {
  id: string;
  parentItemId: string;
  buildQty: number;
  status: KitStatus;
  productionLocation: string;
  lines: KitLine[];
  createdAt: string;
  createdBy: string;
  issuedAt: string | null;
  closedAt: string | null;
  /** Good units produced. */
  qtyMade: number | null;
  /** Units lost in production — drives yield (REQ-2026-07-01-BFL-004). */
  qtyScrapped: number | null;
  outputLocation: string | null;
  events: KitEvent[];
}

/** itemId → location → qty on hand. */
export type StockMap = Record<string, Record<string, number>>;

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

/** Where a kit is issued TO. Transaction Spec §2: location must move from
 *  storage to "the production or manufacturing location". */
export const PRODUCTION_LOCATIONS = [
  'Clean Room 1',
  'Clean Room 2',
  'Manufacturing Floor',
  'PD Lab One',
  'PD Lab Two',
] as const;

/** Consumable holding points reconciled by periodic count (Transaction Spec §4.3). */
export const CONSUMABLE_LOCATIONS = ['Kanban One', 'Kanban Two', 'Clean Room 1'] as const;

/** 'RACK H' / 'Rack  I' / '—' all arrive from the seed. Fold them together so
 *  one physical shelf doesn't split into three (the exact failure
 *  REQ-2026-07-15-LOC-003 restricts shelf creation to prevent). */
function normalizeLocation(raw: string): string {
  const s = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s || s === '—' || s === '-') return UNASSIGNED_LOCATION;
  const rack = /^rack ([a-z])$/i.exec(s);
  if (rack) return `Rack ${rack[1]!.toUpperCase()}`;
  const known = /^(pd lab|pd exp|em lab|qc lab|em)$/i.exec(s);
  if (known) return s.replace(/\b\w/g, (c) => c.toUpperCase());
  return s;
}

/** The seed carries "N/A", "—" and at least one impossible date ("11/31/29"). */
function parseExpiry(raw: string): string | null {
  const s = (raw ?? '').trim();
  if (!s || s === '—' || s === '-' || /^n\/?a$/i.test(s)) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return s;
}

/**
 * Consumable rule — curated by description, deliberately ignoring the seed's
 * tier column. The docs mean gloves and pipette tips (TRX-003); the seed's
 * "Consumable / equipment" tier holds CAR LV vector and G-Rex plates, which
 * are emphatically one-for-one product items (TRX-004).
 */
const CONSUMABLE_RE =
  /pipette tip|serological pipette|transfer pipette|conical centrifuge tube|glove|wiper|kimwipe|t\.i\.p\.s/i;

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

interface RawSeedItem {
  id: string;
  desc: string;
  supplier: string;
  qty: number;
  location: string;
  lot: string;
  expires: string;
  tier: string;
}

/** The seed is cast `as unknown as MockSeed` upstream, so its runtime rows do
 *  NOT match the `InventoryItem` type. Read the real shape. */
const rawItems = mockData.items as unknown as RawSeedItem[];

/** Finished goods. Nothing in the seed to borrow — these are invented. */
const SYNTHETIC_FG: ReconItem[] = [
  {
    id: 'FG-1001',
    desc: 'Selected T-Cells Frozen at 50 x 10e6 cell/mL',
    tier: 'FG',
    isConsumable: false,
    supplier: 'CellReady (built)',
    homeLocation: 'Freezer 00225',
    lot: '—',
    expires: '2027-06-30',
  },
  {
    id: 'FG-1002',
    desc: '20 mL Bag of 1.0e9 Frozen PBMC Cells',
    tier: 'FG',
    isConsumable: false,
    supplier: 'CellReady (built)',
    homeLocation: 'Freezer 00225',
    lot: '—',
    expires: '2027-09-30',
  },
];

/** Seed `AY-` items promoted to true sub-assemblies. Their descriptions really
 *  are formulations — AY-0443 "Complete T Cell Media, Closed, 1L" is built,
 *  not bought — even though the seed tiers them "Assay / QC reference". */
const SUB_ASSEMBLY_IDS = new Set(['AY-0441', 'AY-0442', 'AY-0443']);

function toReconItem(raw: RawSeedItem): ReconItem {
  const tier: ItemTier = SUB_ASSEMBLY_IDS.has(raw.id) ? 'AY' : 'CR';
  return {
    id: raw.id,
    desc: raw.desc,
    tier,
    isConsumable: tier === 'CR' && CONSUMABLE_RE.test(raw.desc),
    supplier: raw.supplier || '—',
    homeLocation: normalizeLocation(raw.location),
    lot: raw.lot || '—',
    expires: parseExpiry(raw.expires),
  };
}

export const ITEM_CATALOG: Record<string, ReconItem> = (() => {
  const out: Record<string, ReconItem> = {};
  for (const raw of rawItems) out[raw.id] = toReconItem(raw);
  for (const fg of SYNTHETIC_FG) out[fg.id] = fg;
  return out;
})();

export function itemOf(id: string): ReconItem {
  const it = ITEM_CATALOG[id];
  if (!it) throw new Error(`Unknown item ${id}`);
  return it;
}

// ---------------------------------------------------------------------------
// BOMs
// ---------------------------------------------------------------------------

/**
 * Curated multi-level BOMs over real seed items.
 *
 * A consumable can NEVER be a BOM component — "Consumables are not tracked
 * directly against an FG or AY BOM" (Transaction Spec §4.3). Consumables reach
 * production by a separate move to a Kanban/lab location and are reconciled by
 * periodic count on the Consumables tab, not through a kit. Every line below is
 * a one-for-one product item; the sanitiser at the bottom enforces the rule so
 * it holds structurally even if someone adds a consumable here by mistake.
 *
 * FG-1001 is the interesting one: it consumes two sub-assemblies, each with
 * its own BOM, which is the CR+AY → FG case from Transaction Spec §1.1 and
 * gives the availability-at-each-level view TechReq v2 §6 asks for.
 */
const RAW_BOM: Record<string, BomLine[]> = {
  'AY-0443': [
    { childId: 'CM-0020', qtyPerUnit: 1 }, // CLICK'S MEDIUM (EHAA)
    { childId: 'CM-0029', qtyPerUnit: 2 }, // 25% Human Serum Albumin
    { childId: 'CM-0019', qtyPerUnit: 1 }, // GLUTAMAX I 100X
    { childId: 'CR-0292', qtyPerUnit: 1 }, // Recombinant Human IL-7
    { childId: 'CR-0293', qtyPerUnit: 1 }, // Recombinant Human IL-15
  ],
  'AY-0442': [
    { childId: 'CR-0347', qtyPerUnit: 1 }, // CD19 CAR LV (VBM)
    { childId: 'CM-0185', qtyPerUnit: 1 }, // CliniMACS Tubing Set LS
    { childId: 'NM-0006', qtyPerUnit: 2 }, // DPBS
  ],
  'AY-0441': [
    { childId: 'CM-0001', qtyPerUnit: 1 }, // CryoStor CS10, 100 mL
    { childId: 'CM-0241', qtyPerUnit: 1 }, // Human Male AB Plasma-Derived Serum
  ],
  'FG-1001': [
    { childId: 'AY-0443', qtyPerUnit: 2 }, // Complete T Cell Media
    { childId: 'AY-0442', qtyPerUnit: 1 }, // Activation & Transduction Mastermix
    { childId: 'CM-0238', qtyPerUnit: 4 }, // CS50N Cryopreservation Bag
    { childId: 'NM-0053', qtyPerUnit: 20 }, // Cryogenic vials 1.8 mL
  ],
  'FG-1002': [
    { childId: 'AY-0441', qtyPerUnit: 1 }, // Resuspension Media
    { childId: 'CM-0231', qtyPerUnit: 1 }, // CryoStor CS10, 1000 mL Media Bag
    { childId: 'CM-0238', qtyPerUnit: 2 }, // CS50N Cryopreservation Bag
    { childId: 'NM-0052', qtyPerUnit: 10 }, // Cryogenic vials 2 mL
  ],
};

/** Drops any consumable that slips into a BOM (Transaction Spec §4.3) and
 *  flags it in development, so the "no consumables in a BOM" rule is enforced
 *  in one place rather than trusted to every author. */
function sanitizeBom(raw: Record<string, BomLine[]>): Record<string, BomLine[]> {
  const out: Record<string, BomLine[]> = {};
  for (const [parent, lines] of Object.entries(raw)) {
    out[parent] = lines.filter((line) => {
      if (ITEM_CATALOG[line.childId]?.isConsumable) {
        if (process.env.NODE_ENV !== 'production') {
          // eslint-disable-next-line no-console
          console.error(
            `BOM ${parent} lists consumable ${line.childId} — dropped. Consumables can't be BOM components (Transaction Spec §4.3).`,
          );
        }
        return false;
      }
      return true;
    });
  }
  return out;
}

export const BOM: Record<string, BomLine[]> = sanitizeBom(RAW_BOM);

/** Everything with a BOM can be kitted. Raw materials never can. */
export function buildableItems(): ReconItem[] {
  return Object.keys(BOM)
    .map((id) => itemOf(id))
    .sort((a, b) => (a.tier === b.tier ? a.id.localeCompare(b.id) : a.tier === 'FG' ? -1 : 1));
}

export function hasBom(itemId: string): boolean {
  return (BOM[itemId]?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Opening stock
// ---------------------------------------------------------------------------

/** Build quantity the top-ups are sized for, so a demo kit never dead-ends on
 *  a shortage the operator can't clear. */
const REFERENCE_BUILD_QTY = 12;

/**
 * Opening stock = real seed quantities, topped up ONLY for raw materials a
 * demo BOM actually consumes. AY and FG are deliberately left at zero: the
 * only way they gain stock is a kit producing them, per Transaction Spec §3.1.
 */
export function baseStock(): StockMap {
  const stock: StockMap = {};
  const add = (itemId: string, location: string, qty: number) => {
    (stock[itemId] ||= {});
    stock[itemId]![location] = (stock[itemId]![location] ?? 0) + qty;
  };

  for (const raw of rawItems) {
    const it = itemOf(raw.id);
    if (it.tier !== 'CR') continue; // AY stock is produced, never seeded
    if (raw.qty > 0) add(raw.id, it.homeLocation, raw.qty);
  }

  // Top up raw materials the demo BOMs need. Never reduces a real quantity.
  const required: Record<string, number> = {};
  for (const lines of Object.values(BOM)) {
    for (const line of lines) {
      const child = itemOf(line.childId);
      if (child.tier !== 'CR') continue;
      const need = line.qtyPerUnit * REFERENCE_BUILD_QTY;
      required[line.childId] = Math.max(required[line.childId] ?? 0, need);
    }
  }
  for (const [itemId, need] of Object.entries(required)) {
    const it = itemOf(itemId);
    const have = Object.values(stock[itemId] ?? {}).reduce((a, b) => a + b, 0);
    // 2× headroom leaves room for over-issue and additional issues.
    const target = need * 2;
    if (have < target) add(itemId, it.homeLocation, target - have);
  }

  // Consumable stock parked at the Kanban points, for the consumables tab.
  for (const raw of rawItems) {
    const it = itemOf(raw.id);
    if (!it.isConsumable || raw.qty <= 0) continue;
    add(raw.id, 'Kanban One', Math.max(2, Math.round(raw.qty * 0.1)));
  }
  add('NM-0034', 'Kanban Two', 40);
  add('NM-0051', 'Clean Room 1', 6);

  return stock;
}

export function onHandAt(stock: StockMap, itemId: string, location: string): number {
  return stock[itemId]?.[location] ?? 0;
}

export function onHandTotal(stock: StockMap, itemId: string): number {
  return Object.values(stock[itemId] ?? {}).reduce((a, b) => a + b, 0);
}

/** Location holding the most of an item — the sensible default source. */
export function bestSourceFor(stock: StockMap, itemId: string): string {
  const byLoc = stock[itemId] ?? {};
  let best = itemOf(itemId).homeLocation;
  let bestQty = -1;
  for (const [loc, qty] of Object.entries(byLoc)) {
    if (qty > bestQty) {
      best = loc;
      bestQty = qty;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// BOM explosion
// ---------------------------------------------------------------------------

/** Qty Needed comes from the BOM; Qty Issued is manual (Transaction Spec §2). */
export function explodeBom(stock: StockMap, parentItemId: string, buildQty: number): KitLine[] {
  const lines = BOM[parentItemId] ?? [];
  return lines.map((line) => {
    const child = itemOf(line.childId);
    const source = bestSourceFor(stock, line.childId);
    return {
      itemId: line.childId,
      qtyPerUnit: line.qtyPerUnit,
      qtyNeeded: line.qtyPerUnit * buildQty,
      qtyIssued: 0,
      qtyAdditional: 0,
      qtyUsed: null,
      sourceLocation: source,
      returnLocation: source,
      isConsumable: child.isConsumable,
    };
  });
}

/** Nested read-only view for the structure tree. A child AY is consumed from
 *  stock — it is NOT exploded into this kit (§3.1: an AY is built by its own
 *  earlier kit) — but its recipe is shown so availability reads at every level. */
export interface BomNode {
  item: ReconItem;
  qtyPerUnit: number;
  children: BomNode[];
}

export function bomTree(parentItemId: string, depth = 0): BomNode[] {
  if (depth > 4) return [];
  return (BOM[parentItemId] ?? []).map((line) => ({
    item: itemOf(line.childId),
    qtyPerUnit: line.qtyPerUnit,
    children: bomTree(line.childId, depth + 1),
  }));
}

// ---------------------------------------------------------------------------
// Expiry helpers
// ---------------------------------------------------------------------------

export type ExpiryState = 'none' | 'ok' | 'near' | 'expired';

const NEAR_EXPIRY_DAYS = 180;

export function expiryStateOf(item: ReconItem, now: Date = DEMO_TODAY): ExpiryState {
  if (!item.expires) return 'none';
  const exp = new Date(item.expires).getTime();
  const days = (exp - now.getTime()) / 86_400_000;
  if (days < 0) return 'expired';
  if (days <= NEAR_EXPIRY_DAYS) return 'near';
  return 'ok';
}

export const EXPIRY_TONE: Record<ExpiryState, 'neutral' | 'success' | 'warning' | 'danger'> = {
  none: 'neutral',
  ok: 'success',
  near: 'warning',
  expired: 'danger',
};

export const EXPIRY_LABEL: Record<ExpiryState, string> = {
  none: 'No expiry',
  ok: 'In date',
  near: 'Expiring',
  expired: 'Expired',
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}
