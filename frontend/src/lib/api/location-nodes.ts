/**
 * Location system API — wraps ``/api/v1/location-nodes`` and
 * ``/api/v1/allocations`` (Requirements v2 §4.1).
 *
 * LN2 hierarchy (REQ-2026-07-15-LOC-001): tank → quadrant (``tank_quadrant``,
 * at most four per tank) → rack → box. The **Box** is the grid-bearing leaf
 * (grid_rows × grid_cols); a lot is placed into a (grid_row, grid_col) cell.
 * Cassette / Cryo Box Rack used to sit between rack and box and are retired.
 * Materials Management runs room → location → sub-location alongside it. Only
 * ``box``, ``sub_location`` and ``shelf`` can hold a lot.
 *
 * Quantity events go to the GxP ledger: ``consume`` (dispense/discard) and
 * ``transfer`` are e-signed (pass an ``evidence_id`` from a reauth). ``place``
 * is quantity-neutral (audit only). A tank_quadrant may be dedicated to a
 * customer XOR a product (advisory; descendants inherit it).
 */

import { api } from './client';

export type NodeType =
  // LN2: tank → quadrant → rack → box (REQ-2026-07-15-LOC-001)
  | 'tank'
  | 'tank_quadrant'
  | 'rack'
  | 'box'
  // Freezer area: room → room_location → sub_location (free leaf)
  | 'room'
  | 'room_location'
  | 'sub_location'
  // Warehouse area: warehouse → shelf (free leaf)
  | 'warehouse'
  | 'shelf'
  | 'flat'
  // A named Kanban station inside a production area (LOC-006, consum01).
  // Created through its own super-admin route, never the generic create — so
  // it is absent from `CreatableNodeType` below.
  | 'kanban'
  // Retired (read-only — old rows only). Cassette / Cryo Box Rack sat between
  // Rack and Box until the client dropped them on 2026-07-29.
  | 'cassette'
  | 'cryo_box_rack'
  | 'cassette_rack'
  | 'sub_slot';

/** Node types the UI can create. Rooms, the warehouse and its shelves stay
 *  seed-managed — they are named by requirement, not by an operator.
 *
 *  A `room_location` — a Cold Storage group such as "2–8 °C Refrigerators" — is
 *  creatable by a Super Admin, since LOC-002 names groups the client has yet to
 *  supply (LOC-004).
 *
 *  `shelf` is deliberately NOT here. LOC-003 gates shelf CREATION on the Super
 *  Admin role rather than forbidding it, which reads like a capability — but
 *  LOC-005 fixes Warehouse One's contents at "sub-locations Shelf A through
 *  Shelf Z", a closed set with nothing to add (client 2026-07-30). Renaming a
 *  shelf is still allowed; that needs no entry here. */
export type CreatableNodeType =
  | 'tank'
  | 'tank_quadrant'
  | 'rack'
  | 'box'
  | 'room_location'
  | 'sub_location';

/**
 * REQ-2026-07-15-LOC-001: "four quadrants per tank". A hard cap, not a default —
 * the API enforces it on create AND on relocate (it counts siblings, which a DB
 * CHECK cannot do). Mirrored here only so the UI can explain a full tank before
 * the request is sent; the server stays authoritative, since it also counts
 * inactive quadrants the tree may not carry.
 */
export const MAX_QUADRANTS_PER_TANK = 4;

export type FlatCategory = 'kanban' | 'lab' | 'qc' | 'engineering' | 'materials' | 'production';
export type MovementType =
  | 'receipt'
  | 'dispense'
  | 'discard'
  | 'adjustment'
  | 'transfer_out'
  | 'transfer_in';

/** Human labels for each node level. */
export const NODE_TYPE_LABEL: Record<NodeType, string> = {
  tank: 'Tank',
  tank_quadrant: 'Quadrant',
  rack: 'Rack',
  box: 'Box',
  cassette: 'Cassette (retired)',
  cryo_box_rack: 'Cryo Box Rack (retired)',
  room: 'Room',
  room_location: 'Location',
  sub_location: 'Sub-location',
  warehouse: 'Warehouse',
  shelf: 'Shelf',
  flat: 'Flat location',
  kanban: 'Kanban',
  cassette_rack: 'Cassette Rack (legacy)',
  sub_slot: 'Sub-slot (legacy)',
};

export const FLAT_CATEGORY_LABEL: Record<FlatCategory, string> = {
  kanban: 'Kanban',
  lab: 'Lab',
  qc: 'QC',
  engineering: 'Engineering',
  materials: 'Materials',
  // Advisory production floors a kit is issued to (docs/modules/kitting.md §4.1).
  production: 'Production',
};

// 'kanban' is intentionally omitted — the Kanban flow was retired, so it is no
// longer offered when creating a flat location. The type/label are kept so any
// pre-existing kanban flat locations still render.
export const FLAT_CATEGORIES: [FlatCategory, ...FlatCategory[]] = [
  'lab',
  'qc',
  'engineering',
  'materials',
];

/**
 * Allowed child types for each level. Every level now has a single child type;
 * an empty array = leaf (the Box stores units in its grid cells). Cassette and
 * Cryo Box Rack are retired, so a Rack holds Boxes directly.
 */
export const CHILD_TYPES_OF: Record<NodeType, CreatableNodeType[]> = {
  tank: ['tank_quadrant'],
  tank_quadrant: ['rack'],
  rack: ['box'],
  box: [],
  cassette: [],
  cryo_box_rack: [],
  // Materials Management — a room holds Cold Storage locations (LOC-002), each
  // holding its equipment units. The warehouse and its shelves are seeded.
  room: ['room_location'],
  room_location: ['sub_location'],
  sub_location: [],
  // LOC-005 fixes Warehouse One's contents at Shelf A through Shelf Z — a closed
  // set, so nothing is creatable under it. Nothing hangs below a shelf either.
  warehouse: [],
  shelf: [],
  flat: [],
  // A Kanban is a leaf: consumables are issued INTO it, nothing hangs below.
  // It is also absent from CreatableNodeType — it has its own super-admin
  // route (POST /location-nodes/{area}/kanbans), not the generic create.
  kanban: [],
  cassette_rack: [],
  sub_slot: [],
};

/**
 * The inverse of {@link CHILD_TYPES_OF} — which node types a given type may
 * hang under. Drives the "move to" picker: a rack may be re-hung under any
 * quadrant, never onto a box. Empty = a root, which cannot be moved at all.
 */
export function parentTypesOf(type: NodeType): NodeType[] {
  return (Object.keys(CHILD_TYPES_OF) as NodeType[]).filter((parent) =>
    CHILD_TYPES_OF[parent].includes(type as CreatableNodeType),
  );
}

export interface LocationNode {
  id: string;
  parent_id: string | null;
  node_type: NodeType;
  flat_category: FlatCategory | null;
  code: string;
  name: string;
  is_active: boolean;
  notes: string | null;
  grid_rows: number | null;
  grid_cols: number | null;
  dedicated_customer_id: string | null;
  dedicated_product_id: string | null;
  inherited_customer_id: string | null;
  inherited_product_id: string | null;
  can_store: boolean;
  child_count: number;
  active_allocation_count: number;
  /** Full breadcrumb from the root (set on storage-targets; null elsewhere). */
  path: string | null;
  created_at: string;
  updated_at: string;
}

export interface NodeTree extends LocationNode {
  children: NodeTree[];
}

/**
 * Aggregate capacity + occupied across a subtree. A Box contributes
 * ``rows × cols`` capacity and its active-allocation count; containers sum
 * their descendants. Used for the hierarchy counts and the detail stat cards.
 */
export function subtreeStats(node: NodeTree): { capacity: number; occupied: number } {
  if (node.node_type === 'box') {
    return {
      capacity: (node.grid_rows ?? 0) * (node.grid_cols ?? 0),
      occupied: node.active_allocation_count,
    };
  }
  let capacity = 0;
  let occupied = 0;
  for (const child of node.children) {
    const s = subtreeStats(child);
    capacity += s.capacity;
    occupied += s.occupied;
  }
  return { capacity, occupied };
}

export interface Allocation {
  id: string;
  lot_id: string;
  lot_number: string | null;
  /** Item UUID — item detail URLs key on it, so links can go straight there. */
  item_id: string | null;
  item_number: string | null;
  location_node_id: string;
  location_name: string | null;
  location_node_type: NodeType | null;
  grid_row: number | null;
  grid_col: number | null;
  /** Whole units (integer). */
  qty: number;
  is_active: boolean;
  created_at: string;
}

export interface NodeMovement {
  id: string;
  lot_id: string | null;
  lot_number: string | null;
  /** Item UUID — see {@link Allocation.item_id}. */
  item_id: string | null;
  item_number: string | null;
  movement_type: MovementType;
  from_location_node_id: string | null;
  to_location_node_id: string | null;
  /** Whole units (integer); negative for out-bound. */
  qty_delta: number;
  notes: string | null;
  performed_by_user_id: string;
  performed_at: string;
}

export interface NodeCreateInput {
  node_type: CreatableNodeType;
  code: string;
  name: string;
  parent_id?: string | null;
  grid_rows?: number | null;
  grid_cols?: number | null;
  dedicated_customer_id?: string | null;
  dedicated_product_id?: string | null;
  notes?: string | null;
}

export interface GridUpdateInput {
  grid_rows: number;
  grid_cols: number;
}

export interface DedicationUpdateInput {
  dedicated_customer_id?: string | null;
  dedicated_product_id?: string | null;
}

export interface PlaceInput {
  lot_id: string;
  node_id: string;
  qty: number;
  grid_row?: number | null;
  grid_col?: number | null;
  override?: boolean;
  /** Unit-IN is e-signed (action movement.receipt). */
  evidence_id: string;
  /** Required comment (§3). */
  notes: string;
}

export interface PlaceBatchInput {
  lot_id: string;
  node_id: string;
  /** One unit is placed into each cell. */
  cells: { grid_row: number; grid_col: number }[];
  override?: boolean;
  /** Unit-IN is e-signed once for the whole batch (action movement.receipt). */
  evidence_id: string;
  /** Required comment (§3). */
  notes: string;
}

export interface TransferInput {
  allocation_id: string;
  to_node_id: string;
  qty: number;
  to_grid_row?: number | null;
  to_grid_col?: number | null;
  override?: boolean;
  evidence_id: string;
  /** Required comment (§3). */
  notes: string;
}

export interface ConsumeInput {
  allocation_id: string;
  /** The Flat location that consumed the unit (where it went). */
  to_node_id: string;
  qty: number;
  evidence_id: string;
  /** Required comment (§3). */
  notes: string;
}

export interface ConsumeBatchInput {
  /** Source allocations (one lot, one source node); each consumed in full. */
  allocation_ids: string[];
  /** The Flat location that consumed the units. */
  to_node_id: string;
  evidence_id: string;
  notes: string;
}

export interface TransferBatchInput {
  /** Source allocations (one lot, one source node) to draw units from. */
  allocation_ids: string[];
  to_node_id: string;
  /** Box destination: one cell per unit (quantity = cells.length). */
  to_cells?: { grid_row: number; grid_col: number }[];
  /** Flat destination: the number of units to move. */
  qty?: number;
  override?: boolean;
  evidence_id: string;
  notes: string;
}

/** One leg of a transfer: a quantity of one lot at one storage node, and the one
 *  destination it moves to. LN2 box sources carry the exact vial allocation ids;
 *  a box destination carries one cell per unit (``to_cells.length === qty``). */
export interface TransferSourceInput {
  node_id: string;
  lot_id: string;
  qty: number;
  cell_allocation_ids?: string[];
  to_node_id: string;
  to_cells?: { grid_row: number; grid_col: number }[];
}

/** Move ONE item's stock from several lots / locations, each to its own
 *  destination, signed once — the inventory-workspace transfer
 *  (REQ-2026-07-15-TRX-001 as refined 2026-07-22). The within-location path
 *  keeps using ``transfer`` / ``transferBatch``, which start from a known
 *  allocation and therefore have a single source and a single destination. */
export interface TransferMultiInput {
  sources: TransferSourceInput[];
  override?: boolean;
  evidence_id: string;
  notes: string;
}

export interface LotAvailability {
  lot_id: string;
  ordered_qty: number | null;
  /** Lifetime units placed (unit-in) for this lot. */
  placed: number;
  /** ordered_qty − placed; null when the lot has no ordered cap. */
  remaining: number | null;
}

export const locationNodesApi = {
  ln2Tree: (opts?: { activeOnly?: boolean; signal?: AbortSignal }) =>
    api.get<NodeTree[]>('/location-nodes/ln2-tree', {
      query: { active_only: opts?.activeOnly ?? true },
      signal: opts?.signal,
    }),

  freezerTree: (opts?: { activeOnly?: boolean; signal?: AbortSignal }) =>
    api.get<NodeTree[]>('/location-nodes/freezer-tree', {
      query: { active_only: opts?.activeOnly ?? true },
      signal: opts?.signal,
    }),

  warehouseTree: (opts?: { activeOnly?: boolean; signal?: AbortSignal }) =>
    api.get<NodeTree[]>('/location-nodes/warehouse-tree', {
      query: { active_only: opts?.activeOnly ?? true },
      signal: opts?.signal,
    }),

  flat: (opts?: { category?: FlatCategory; signal?: AbortSignal }) =>
    api.get<LocationNode[]>('/location-nodes/flat', {
      query: { flat_category: opts?.category },
      signal: opts?.signal,
    }),

  storageTargets: (opts?: { signal?: AbortSignal }) =>
    api.get<LocationNode[]>('/location-nodes/storage-targets', {
      signal: opts?.signal,
    }),

  get: (id: string, opts?: { signal?: AbortSignal }) =>
    api.get<LocationNode>(`/location-nodes/${id}`, { signal: opts?.signal }),

  nodeAllocations: (id: string, opts?: { signal?: AbortSignal }) =>
    api.get<Allocation[]>(`/location-nodes/${id}/allocations`, {
      signal: opts?.signal,
    }),

  create: (input: NodeCreateInput) => api.post<LocationNode>('/location-nodes', { json: input }),

  /** Add a Production area (admin) — a production-floor sub-location. The code is
   *  generated server-side from the name; rename later via {@link rename}. */
  createProductionArea: (name: string) =>
    api.post<LocationNode>('/location-nodes/production-areas', { json: { name } }),

  /** The Kanban stations inside a production area (LOC-006). Empty for an area
   *  that has none — the UI reads that as "a super admin must add one" rather
   *  than an error, since a consumable issue must target a Kanban. */
  kanbans: (areaId: string, opts?: { signal?: AbortSignal }) =>
    api.get<LocationNode[]>(`/location-nodes/${areaId}/kanbans`, { signal: opts?.signal }),

  /** Every Kanban, with `path` carrying its area ("Clean Room Four › Kanban 1").
   *  One breadcrumbed list for the issue dialog's destination picker. */
  allKanbans: (opts?: { signal?: AbortSignal }) =>
    api.get<LocationNode[]>('/location-nodes/kanbans', { signal: opts?.signal }),

  /** Add a Kanban to a production area — SUPER ADMIN only, same governance as
   *  shelves (LOC-003): two spellings of one physical bin split its register.
   *  Free-text name; the `KAN-` code is generated server-side. */
  createKanban: (areaId: string, name: string) =>
    api.post<LocationNode>(`/location-nodes/${areaId}/kanbans`, { json: { name } }),

  remove: (id: string) => api.delete<LocationNode>(`/location-nodes/${id}`),

  rename: (id: string, name: string) =>
    api.patch<LocationNode>(`/location-nodes/${id}`, { json: { name } }),

  /** Re-hang a node under a new parent (super-admin). The whole subtree comes
   *  along — nothing inside is re-placed and no stock moves. */
  move: (id: string, parentId: string) =>
    api.patch<LocationNode>(`/location-nodes/${id}/parent`, {
      json: { parent_id: parentId },
    }),

  updateGrid: (id: string, input: GridUpdateInput) =>
    api.put<LocationNode>(`/location-nodes/${id}/grid`, { json: input }),

  updateDedication: (id: string, input: DedicationUpdateInput) =>
    api.put<LocationNode>(`/location-nodes/${id}/dedication`, { json: input }),

  place: (input: PlaceInput) => api.post<Allocation>('/allocations/place', { json: input }),

  placeBatch: (input: PlaceBatchInput) =>
    api.post<Allocation[]>('/allocations/place-batch', { json: input }),

  transfer: (input: TransferInput) =>
    api.post<Allocation>('/allocations/transfer', { json: input }),

  consume: (input: ConsumeInput) => api.post<Allocation>('/allocations/consume', { json: input }),

  consumeBatch: (input: ConsumeBatchInput) =>
    api.post<Allocation[]>('/allocations/consume-batch', { json: input }),

  transferBatch: (input: TransferBatchInput) =>
    api.post<Allocation[]>('/allocations/transfer-batch', { json: input }),

  /** Multi-source transfer started from an item rather than a location — the
   *  destination allocations come back. */
  transferMulti: (input: TransferMultiInput) =>
    api.post<Allocation[]>('/allocations/transfer-multi', { json: input }),

  lotAvailability: (lotId: string, opts?: { signal?: AbortSignal }) =>
    api.get<LotAvailability>(`/allocations/lot-availability/${lotId}`, {
      signal: opts?.signal,
    }),

  /** Where stock is stored, from a partial LOT NUMBER, ITEM NUMBER or ITEM NAME
   *  — "where is this stock". One call, rather than resolving ids and then asking
   *  node by node. ``GET /lots`` cannot answer it: it filters only by item and
   *  status, and the item number is derived rather than stored. */
  searchAllocations: (query: string, opts?: { signal?: AbortSignal }) =>
    api.get<Allocation[]>('/allocations/search', {
      query: { q: query },
      signal: opts?.signal,
    }),

  lotAllocations: (lotId: string, opts?: { signal?: AbortSignal }) =>
    api.get<Allocation[]>(`/allocations/by-lot/${lotId}`, { signal: opts?.signal }),

  movements: (opts?: { lotId?: string; nodeId?: string; signal?: AbortSignal }) =>
    api.get<NodeMovement[]>('/allocations/movements', {
      query: { lot_id: opts?.lotId, node_id: opts?.nodeId },
      signal: opts?.signal,
    }),
};
