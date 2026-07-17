/**
 * Pure state transitions for the Kitting / Reconciliation mock.
 *
 * Every quantity rule the docs state lives here rather than in a component, so
 * the seeded demo kits can be produced by replaying the very same functions the
 * UI calls. If the opening stock looks right, the maths is right.
 *
 * The accounting, end to end:
 *
 *   issue            on-hand −= qtyIssued            (Transaction Spec §2.1;
 *                                                     REQ-2026-07-09-TRX-001)
 *   additional issue on-hand −= qtyAdditional        (Transaction Spec §2.1)
 *   close-out        returned = issued + additional − used   (Table 3)
 *                    on-hand += returned  as `backflush`     (TRX-003)
 *                    parent on-hand += qtyMade               (§3.1)
 *
 * `used` needs no stock movement of its own — that material already left
 * on-hand at issue time. Consumables are issued and never reconciled
 * (REQ-2026-07-09-TRX-004); their quantity story ends at issue.
 */
import {
  BOM,
  baseStock,
  explodeBom,
  itemOf,
  type Kit,
  type KitEventType,
  type KitLine,
  type StockMap,
} from './reconciliation-data';

export interface AdjustmentRecord {
  id: string;
  at: string;
  itemId: string;
  location: string;
  systemQty: number;
  countedQty: number;
  /** counted − system. Negative = shrinkage. */
  variance: number;
  note: string;
  actor: string;
}

export interface ReconState {
  stock: StockMap;
  kits: Kit[];
  adjustments: AdjustmentRecord[];
  /** `${itemId}@${location}` entries whose expiry flag has been acknowledged. */
  acknowledged: string[];
  /** Separate counters — sharing one would let each event written bump the
   *  next kit's number, so kits would read KIT-0008, KIT-0017, KIT-0033… */
  kitSeq: number;
  eventSeq: number;
  adjSeq: number;
}

/** Thrown for a rule violation the UI should surface verbatim. */
export class ReconError extends Error {}

const clone = <T>(v: T): T => structuredClone(v);

const nowIso = () => new Date().toISOString();

function addStock(stock: StockMap, itemId: string, location: string, qty: number): void {
  (stock[itemId] ||= {});
  const next = (stock[itemId]![location] ?? 0) + qty;
  if (next < 0) {
    throw new ReconError(
      `${itemId} at ${location} would go negative (${next}). Check the issued quantity.`,
    );
  }
  stock[itemId]![location] = next;
}

function pushEvent(
  state: ReconState,
  kit: Kit,
  type: KitEventType,
  itemId: string,
  qtyDelta: number,
  location: string,
  note: string,
  actor: string,
  at: string,
): void {
  kit.events.push({
    id: `EV-${String(++state.eventSeq).padStart(5, '0')}`,
    at,
    type,
    itemId,
    qtyDelta,
    location,
    note,
    actor,
  });
}

export function findKit(state: ReconState, kitId: string): Kit {
  const kit = state.kits.find((k) => k.id === kitId);
  if (!kit) throw new ReconError(`Unknown kit ${kitId}`);
  return kit;
}

function findLine(kit: Kit, itemId: string): KitLine {
  const line = kit.lines.find((l) => l.itemId === itemId);
  if (!line) throw new ReconError(`${itemId} is not on kit ${kit.id}`);
  return line;
}

/** Total quantity a line has taken out of inventory. */
export function lineIssuedTotal(line: KitLine): number {
  return line.qtyIssued + line.qtyAdditional;
}

/** Table 3: Qty Returned to Inventory = Issued + Additional − Used. */
export function lineReturned(line: KitLine): number {
  if (line.isConsumable || line.qtyUsed === null) return 0;
  return lineIssuedTotal(line) - line.qtyUsed;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface CreateKitInput {
  parentItemId: string;
  buildQty: number;
  productionLocation: string;
  actor: string;
  at?: string;
}

export function createKit(prev: ReconState, input: CreateKitInput): ReconState {
  const state = clone(prev);
  const { parentItemId, buildQty, productionLocation, actor } = input;
  const at = input.at ?? nowIso();

  if (!BOM[parentItemId]?.length) {
    throw new ReconError(`${parentItemId} has no bill of materials, so it can't be kitted.`);
  }
  if (!Number.isInteger(buildQty) || buildQty < 1) {
    throw new ReconError('Build quantity must be a whole number of 1 or more.');
  }

  const id = `KIT-${String(++state.kitSeq).padStart(4, '0')}`;
  const kit: Kit = {
    id,
    parentItemId,
    buildQty,
    status: 'draft',
    productionLocation,
    lines: explodeBom(state.stock, parentItemId, buildQty),
    createdAt: at,
    createdBy: actor,
    issuedAt: null,
    closedAt: null,
    qtyMade: null,
    qtyScrapped: null,
    outputLocation: null,
    events: [],
  };
  // Default Qty Issued to Qty Needed — still a manual field, just pre-filled.
  for (const line of kit.lines) line.qtyIssued = line.qtyNeeded;

  state.kits.unshift(kit);
  pushEvent(
    state,
    kit,
    'created',
    parentItemId,
    0,
    productionLocation,
    `Kit opened to build ${buildQty} × ${parentItemId}`,
    actor,
    at,
  );
  return state;
}

export function setLineIssued(prev: ReconState, kitId: string, itemId: string, qty: number): ReconState {
  const state = clone(prev);
  const kit = findKit(state, kitId);
  if (kit.status !== 'draft') {
    throw new ReconError('Issued quantities can only be edited while the kit is a Draft.');
  }
  if (!Number.isFinite(qty) || qty < 0) throw new ReconError('Quantity must be 0 or more.');
  findLine(kit, itemId).qtyIssued = qty;
  return state;
}

export function setProductionLocation(prev: ReconState, kitId: string, location: string): ReconState {
  const state = clone(prev);
  const kit = findKit(state, kitId);
  if (kit.status !== 'draft') {
    throw new ReconError('The production location is fixed once material has been issued.');
  }
  kit.productionLocation = location;
  return state;
}

export function setLineSource(prev: ReconState, kitId: string, itemId: string, location: string): ReconState {
  const state = clone(prev);
  const kit = findKit(state, kitId);
  if (kit.status !== 'draft') throw new ReconError('The source location is fixed once issued.');
  const line = findLine(kit, itemId);
  line.sourceLocation = location;
  line.returnLocation = location;
  return state;
}

/** Shortages that would block an issue. */
export function issueShortages(state: ReconState, kit: Kit): { itemId: string; short: number }[] {
  const out: { itemId: string; short: number }[] = [];
  for (const line of kit.lines) {
    const have = state.stock[line.itemId]?.[line.sourceLocation] ?? 0;
    if (line.qtyIssued > have) out.push({ itemId: line.itemId, short: line.qtyIssued - have });
  }
  return out;
}

export function issueKit(prev: ReconState, kitId: string, actor: string, at = nowIso()): ReconState {
  const state = clone(prev);
  const kit = findKit(state, kitId);
  if (kit.status !== 'draft') throw new ReconError('Only a Draft kit can be issued.');
  if (kit.lines.every((l) => l.qtyIssued <= 0)) {
    throw new ReconError('Nothing to issue — every line is zero.');
  }

  const shortages = issueShortages(state, kit);
  if (shortages.length) {
    const detail = shortages.map((s) => `${s.itemId} (short ${s.short})`).join(', ');
    throw new ReconError(`Not enough stock at the source location: ${detail}.`);
  }

  for (const line of kit.lines) {
    if (line.qtyIssued <= 0) continue;
    addStock(state.stock, line.itemId, line.sourceLocation, -line.qtyIssued);
    pushEvent(
      state,
      kit,
      'issue',
      line.itemId,
      -line.qtyIssued,
      line.sourceLocation,
      `Issued ${line.qtyIssued} to ${kit.productionLocation}` +
        (line.isConsumable ? ' — consumable, terminal at issue' : ''),
      actor,
      at,
    );
  }

  kit.status = 'issued';
  kit.issuedAt = at;
  return state;
}

export function startProduction(prev: ReconState, kitId: string): ReconState {
  const state = clone(prev);
  const kit = findKit(state, kitId);
  if (kit.status !== 'issued') throw new ReconError('Only an Issued kit can start production.');
  kit.status = 'in_production';
  return state;
}

export function additionalIssue(
  prev: ReconState,
  kitId: string,
  itemId: string,
  qty: number,
  actor: string,
  at = nowIso(),
): ReconState {
  const state = clone(prev);
  const kit = findKit(state, kitId);
  if (kit.status !== 'issued' && kit.status !== 'in_production') {
    throw new ReconError('Additional material can only be issued to a kit that is in production.');
  }
  if (!Number.isFinite(qty) || qty <= 0) throw new ReconError('Quantity must be greater than 0.');

  const line = findLine(kit, itemId);
  const have = state.stock[itemId]?.[line.sourceLocation] ?? 0;
  if (qty > have) {
    throw new ReconError(`Only ${have} of ${itemId} on hand at ${line.sourceLocation}.`);
  }

  addStock(state.stock, itemId, line.sourceLocation, -qty);
  line.qtyAdditional += qty;
  if (kit.status === 'issued') kit.status = 'in_production';
  pushEvent(
    state,
    kit,
    'additional_issue',
    itemId,
    -qty,
    line.sourceLocation,
    `Additional ${qty} issued to ${kit.productionLocation} during production`,
    actor,
    at,
  );
  return state;
}

export function setLineUsed(prev: ReconState, kitId: string, itemId: string, qty: number | null): ReconState {
  const state = clone(prev);
  const kit = findKit(state, kitId);
  if (kit.status !== 'issued' && kit.status !== 'in_production') {
    throw new ReconError('Used quantities are entered while the kit is in production.');
  }
  const line = findLine(kit, itemId);
  if (line.isConsumable) {
    throw new ReconError(`${itemId} is a consumable — it is not reconciled against the kit.`);
  }
  if (qty !== null && (!Number.isFinite(qty) || qty < 0)) {
    throw new ReconError('Quantity must be 0 or more.');
  }
  line.qtyUsed = qty;
  return state;
}

export function setLineReturnLocation(
  prev: ReconState,
  kitId: string,
  itemId: string,
  location: string,
): ReconState {
  const state = clone(prev);
  const kit = findKit(state, kitId);
  if (kit.status === 'closed' || kit.status === 'cancelled') {
    throw new ReconError('This kit is closed.');
  }
  findLine(kit, itemId).returnLocation = location;
  return state;
}

export interface CloseOutInput {
  qtyMade: number;
  qtyScrapped: number;
  outputLocation: string;
  actor: string;
  at?: string;
}

/** Per-line close-out problems, keyed by item. Empty = ready to close. */
export function closeOutErrors(kit: Kit): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of kit.lines) {
    if (line.isConsumable) continue;
    if (line.qtyUsed === null) {
      out[line.itemId] = 'Enter the quantity used from the traveler.';
      continue;
    }
    const issued = lineIssuedTotal(line);
    if (line.qtyUsed > issued) {
      // Blocked by design: the operator records an explicit additional issue
      // instead, so the ledger shows where the extra material came from
      // (REQ-2026-07-09-TRX-003).
      out[line.itemId] =
        `Used exceeds issued by ${line.qtyUsed - issued}. Record an additional issue to cover it.`;
    }
  }
  return out;
}

/**
 * Post production output and reconcile in one commit.
 *
 * Deliberately atomic: REQ-2026-07-01-BFL-002 puts reconciliation *at the point
 * of transacting finished goods into their inventory location*, not at shipment
 * and not as a separate later step.
 */
export function closeOutKit(prev: ReconState, kitId: string, input: CloseOutInput): ReconState {
  const state = clone(prev);
  const kit = findKit(state, kitId);
  const at = input.at ?? nowIso();
  const { qtyMade, qtyScrapped, outputLocation, actor } = input;

  if (kit.status !== 'issued' && kit.status !== 'in_production') {
    throw new ReconError('Only a kit in production can be closed out.');
  }
  if (!Number.isInteger(qtyMade) || qtyMade < 0) {
    throw new ReconError('Quantity made must be a whole number of 0 or more.');
  }
  if (!Number.isInteger(qtyScrapped) || qtyScrapped < 0) {
    throw new ReconError('Quantity scrapped must be a whole number of 0 or more.');
  }
  if (qtyMade + qtyScrapped === 0) {
    throw new ReconError('Record what production yielded — made and scrapped cannot both be zero.');
  }
  if (!outputLocation) throw new ReconError('Choose a storage location for the finished quantity.');

  const errors = closeOutErrors(kit);
  const firstError = Object.entries(errors)[0];
  if (firstError) throw new ReconError(`${firstError[0]}: ${firstError[1]}`);

  // 1. Consumed material needs no movement — it left on-hand at issue. Record
  //    it so the kit ledger explains where the quantity went.
  for (const line of kit.lines) {
    if (line.isConsumable || !line.qtyUsed) continue;
    pushEvent(
      state,
      kit,
      'consume',
      line.itemId,
      0,
      kit.productionLocation,
      `${line.qtyUsed} consumed building ${kit.parentItemId}`,
      actor,
      at,
    );
  }

  // 2. Output into stock (Transaction Spec §3.1).
  if (qtyMade > 0) {
    addStock(state.stock, kit.parentItemId, outputLocation, qtyMade);
    pushEvent(
      state,
      kit,
      'output',
      kit.parentItemId,
      qtyMade,
      outputLocation,
      `${qtyMade} ${kit.parentItemId} produced and stocked`,
      actor,
      at,
    );
  }
  if (qtyScrapped > 0) {
    pushEvent(
      state,
      kit,
      'scrap',
      kit.parentItemId,
      0,
      kit.productionLocation,
      `${qtyScrapped} scrapped in production — not stocked`,
      actor,
      at,
    );
  }

  // 3. Backflush the leftovers (REQ-2026-07-09-TRX-003).
  for (const line of kit.lines) {
    const returned = lineReturned(line);
    if (returned <= 0) continue;
    addStock(state.stock, line.itemId, line.returnLocation, returned);
    pushEvent(
      state,
      kit,
      'backflush',
      line.itemId,
      returned,
      line.returnLocation,
      `Issued ${lineIssuedTotal(line)}, used ${line.qtyUsed}, backflushed ${returned}`,
      actor,
      at,
    );
  }

  kit.status = 'closed';
  kit.closedAt = at;
  kit.qtyMade = qtyMade;
  kit.qtyScrapped = qtyScrapped;
  kit.outputLocation = outputLocation;
  return state;
}

/**
 * Cancel a kit and return every issued product item to stock.
 *
 * This is the payoff of REQ-2026-07-09-TRX-002 — because material was never
 * bound to a production lot at kitting time, none of it is stranded. Consumables
 * stay consumed (TRX-004).
 */
export function cancelKit(prev: ReconState, kitId: string, reason: string, actor: string, at = nowIso()): ReconState {
  const state = clone(prev);
  const kit = findKit(state, kitId);
  if (kit.status === 'closed' || kit.status === 'cancelled') {
    throw new ReconError('This kit is already finalised.');
  }

  if (kit.status !== 'draft') {
    for (const line of kit.lines) {
      const issued = lineIssuedTotal(line);
      if (issued <= 0) continue;
      if (line.isConsumable) {
        pushEvent(
          state,
          kit,
          'consume',
          line.itemId,
          0,
          kit.productionLocation,
          `${issued} stays consumed — consumables are not adjusted after issue`,
          actor,
          at,
        );
        continue;
      }
      addStock(state.stock, line.itemId, line.returnLocation, issued);
      pushEvent(
        state,
        kit,
        'backflush',
        line.itemId,
        issued,
        line.returnLocation,
        `Kit cancelled — all ${issued} returned to inventory`,
        actor,
        at,
      );
    }
  }

  kit.status = 'cancelled';
  kit.closedAt = at;
  pushEvent(state, kit, 'cancel', kit.parentItemId, 0, kit.productionLocation, reason || 'Kit cancelled', actor, at);
  return state;
}

// ---------------------------------------------------------------------------
// Consumables reconciliation (Transaction Spec §4.3)
// ---------------------------------------------------------------------------

export interface AdjustCountInput {
  itemId: string;
  location: string;
  countedQty: number;
  note: string;
  actor: string;
  at?: string;
}

/**
 * Reconcile a Kanban/clean-room consumable by physical count.
 *
 * §4.3 says consumable stock "is not transacted out to a specific product so a
 * Reconciliation, or Backflush, function must handle the quantity transactions".
 * REQ-2026-07-09-TRX-004 says consumables are never quantity-adjusted *after
 * issue* — i.e. not per kit. A periodic count satisfies both: the quantity is
 * corrected against reality, not against a BOM.
 */
export function adjustCount(prev: ReconState, input: AdjustCountInput): ReconState {
  const state = clone(prev);
  const { itemId, location, countedQty, note, actor } = input;
  const at = input.at ?? nowIso();

  if (!Number.isInteger(countedQty) || countedQty < 0) {
    throw new ReconError('Counted quantity must be a whole number of 0 or more.');
  }
  const systemQty = state.stock[itemId]?.[location] ?? 0;
  const variance = countedQty - systemQty;
  if (variance === 0) throw new ReconError('Counted quantity matches the system — nothing to adjust.');

  addStock(state.stock, itemId, location, variance);
  state.adjustments.unshift({
    id: `ADJ-${String(++state.adjSeq).padStart(4, '0')}`,
    at,
    itemId,
    location,
    systemQty,
    countedQty,
    variance,
    note,
    actor,
  });
  return state;
}

export function acknowledgeExpiry(prev: ReconState, itemId: string, location: string): ReconState {
  const state = clone(prev);
  const key = `${itemId}@${location}`;
  if (!state.acknowledged.includes(key)) state.acknowledged.push(key);
  return state;
}

// ---------------------------------------------------------------------------
// Seeded demo kits
// ---------------------------------------------------------------------------

const OPERATOR = 'Jordan Okafor';
const OPERATOR_2 = 'Priya Raman';

/** Replays real transitions rather than hand-writing balances, so the opening
 *  stock can't drift out of step with the ledger. */
function seedKit(
  state: ReconState,
  spec: {
    parentItemId: string;
    buildQty: number;
    productionLocation: string;
    issued: Record<string, number>;
    additional?: Record<string, number>;
    used?: Record<string, number>;
    output?: { qtyMade: number; qtyScrapped: number; location: string };
    stopAt: 'draft' | 'in_production' | 'closed';
    actor: string;
    day: string;
  },
): ReconState {
  const at = (h: number) => `${spec.day}T${String(h).padStart(2, '0')}:00:00.000Z`;

  let s = createKit(state, {
    parentItemId: spec.parentItemId,
    buildQty: spec.buildQty,
    productionLocation: spec.productionLocation,
    actor: spec.actor,
    at: at(8),
  });
  const kitId = s.kits[0]!.id;

  for (const [itemId, qty] of Object.entries(spec.issued)) {
    s = setLineIssued(s, kitId, itemId, qty);
  }
  if (spec.stopAt === 'draft') return s;

  s = issueKit(s, kitId, spec.actor, at(9));
  s = startProduction(s, kitId);

  for (const [itemId, qty] of Object.entries(spec.additional ?? {})) {
    s = additionalIssue(s, kitId, itemId, qty, spec.actor, at(11));
  }
  for (const [itemId, qty] of Object.entries(spec.used ?? {})) {
    s = setLineUsed(s, kitId, itemId, qty);
  }
  if (spec.stopAt === 'in_production') return s;

  const out = spec.output!;
  return closeOutKit(s, kitId, {
    qtyMade: out.qtyMade,
    qtyScrapped: out.qtyScrapped,
    outputLocation: out.location,
    actor: spec.actor,
    at: at(16),
  });
}

/**
 * Opening state. Two closed AY kits give the FG kits a believable supply of
 * sub-assemblies — an AY only ever gets stock by being built (§3.1).
 */
export function buildInitialState(): ReconState {
  let s: ReconState = {
    stock: baseStock(),
    kits: [],
    adjustments: [],
    acknowledged: [],
    kitSeq: 7, // so the first seeded kit lands on KIT-0008
    eventSeq: 0,
    adjSeq: 0,
  };

  // AY-0441 Resuspension Media ×6 — feeds the FG-1002 draft.
  s = seedKit(s, {
    parentItemId: 'AY-0441',
    buildQty: 6,
    productionLocation: 'PD Lab One',
    issued: { 'CM-0001': 7, 'CM-0241': 6 },
    used: { 'CM-0001': 6, 'CM-0241': 6 },
    output: { qtyMade: 6, qtyScrapped: 0, location: 'Refrigerator' },
    stopAt: 'closed',
    actor: OPERATOR,
    day: '2026-07-06',
  });

  // AY-0443 Complete T Cell Media ×6. The CM-0029 line is Table 3 row 1 exactly:
  // needed 12, issued 15, used 12, backflushed 3.
  s = seedKit(s, {
    parentItemId: 'AY-0443',
    buildQty: 6,
    productionLocation: 'Clean Room 2',
    issued: { 'CM-0020': 6, 'CM-0029': 15, 'CM-0019': 6, 'CR-0292': 10, 'CR-0293': 6 },
    used: { 'CM-0020': 6, 'CM-0029': 12, 'CM-0019': 6, 'CR-0292': 6, 'CR-0293': 6 },
    output: { qtyMade: 6, qtyScrapped: 0, location: 'Refrigerator' },
    stopAt: 'closed',
    actor: OPERATOR,
    day: '2026-07-08',
  });

  // AY-0442 Mastermix — built 5, one scrapped, so yield reads 80%.
  s = seedKit(s, {
    parentItemId: 'AY-0442',
    buildQty: 5,
    productionLocation: 'Clean Room 2',
    issued: { 'CR-0347': 6, 'CM-0185': 5, 'NM-0006': 12 },
    used: { 'CR-0347': 5, 'CM-0185': 5, 'NM-0006': 11 },
    output: { qtyMade: 4, qtyScrapped: 1, location: 'Freezer 00225' },
    stopAt: 'closed',
    actor: OPERATOR_2,
    day: '2026-07-10',
  });

  // FG-1001 ×3, mid-production, consuming both sub-assemblies above. The
  // CM-0238 additional issue of 5 mirrors Table 3 row 2.
  s = seedKit(s, {
    parentItemId: 'FG-1001',
    buildQty: 3,
    productionLocation: 'Clean Room 1',
    issued: { 'AY-0443': 6, 'AY-0442': 3, 'CM-0238': 15, 'NM-0053': 60 },
    additional: { 'CM-0238': 5 },
    stopAt: 'in_production',
    actor: OPERATOR,
    day: '2026-07-15',
  });

  // FG-1002 ×3, still a Draft — nothing has moved.
  s = seedKit(s, {
    parentItemId: 'FG-1002',
    buildQty: 3,
    productionLocation: 'Clean Room 1',
    issued: { 'AY-0441': 3, 'CM-0231': 3, 'CM-0238': 6, 'NM-0052': 30 },
    stopAt: 'draft',
    actor: OPERATOR_2,
    day: '2026-07-17',
  });

  return s;
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

export interface ConsumableRow {
  itemId: string;
  location: string;
  systemQty: number;
}

export function consumableRows(state: ReconState): ConsumableRow[] {
  const rows: ConsumableRow[] = [];
  for (const [itemId, byLoc] of Object.entries(state.stock)) {
    if (!itemOf(itemId).isConsumable) continue;
    for (const [location, qty] of Object.entries(byLoc)) {
      if (qty <= 0) continue;
      rows.push({ itemId, location, systemQty: qty });
    }
  }
  return rows.sort(
    (a, b) => a.location.localeCompare(b.location) || a.itemId.localeCompare(b.itemId),
  );
}

export function kitYield(kit: Kit): number | null {
  if (kit.qtyMade === null || kit.qtyScrapped === null) return null;
  const total = kit.qtyMade + kit.qtyScrapped;
  if (total === 0) return null;
  return kit.qtyMade / total;
}
