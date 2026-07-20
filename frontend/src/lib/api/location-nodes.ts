/**
 * Location system API — wraps ``/api/v1/location-nodes`` and
 * ``/api/v1/allocations`` (Requirements v2 §4.1).
 *
 * Hierarchy: tank_quadrant → rack → (cassette | cryo_box_rack) → box. The
 * **Box** is the grid-bearing leaf (grid_rows × grid_cols); a lot is placed
 * into a (grid_row, grid_col) cell. Cassette / Cryo Box Rack are navigation
 * containers. Flat operational locations store lots directly. Only ``box`` and
 * ``flat`` nodes can hold a lot.
 *
 * Quantity events go to the GxP ledger: ``consume`` (dispense/discard) and
 * ``transfer`` are e-signed (pass an ``evidence_id`` from a reauth). ``place``
 * is quantity-neutral (audit only). A tank_quadrant may be dedicated to a
 * customer XOR a product (advisory; descendants inherit it).
 */

import { api } from './client';

export type NodeType =
  | 'tank_quadrant'
  | 'rack'
  | 'cassette'
  | 'cryo_box_rack'
  | 'box'
  // Freezer area: room → room_location → sub_location (free leaf)
  | 'room'
  | 'room_location'
  | 'sub_location'
  // Warehouse area: warehouse → shelf (free leaf)
  | 'warehouse'
  | 'shelf'
  | 'flat'
  // Retired (read-only — old rows only):
  | 'cassette_rack'
  | 'sub_slot';

/** Node types the UI can create. Freezer rooms/locations and the warehouse are
 *  seed-managed; the only free leaf the UI creates is a freezer sub_location. */
export type CreatableNodeType =
  | 'tank_quadrant'
  | 'rack'
  | 'cassette'
  | 'cryo_box_rack'
  | 'box'
  | 'sub_location';

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
  tank_quadrant: 'Tank Quadrant',
  rack: 'Rack',
  cassette: 'Cassette',
  cryo_box_rack: 'Cryo Box Rack',
  box: 'Box',
  room: 'Room',
  room_location: 'Location',
  sub_location: 'Sub-location',
  warehouse: 'Warehouse',
  shelf: 'Shelf',
  flat: 'Flat location',
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
 * Allowed child types for each LN2 level. A Rack accepts EITHER a Cassette or a
 * Cryo Box Rack (the user picks); everything else has a single child type. An
 * empty array = leaf (no children — the Box stores units in its grid cells).
 */
export const CHILD_TYPES_OF: Record<NodeType, CreatableNodeType[]> = {
  tank_quadrant: ['rack'],
  rack: ['cassette', 'cryo_box_rack'],
  cassette: ['box'],
  cryo_box_rack: ['box'],
  box: [],
  // Freezer area — a Location holds sub-locations; rooms/warehouse are seeded.
  room: [],
  room_location: ['sub_location'],
  sub_location: [],
  warehouse: [],
  shelf: [],
  flat: [],
  cassette_rack: [],
  sub_slot: [],
};

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

  create: (input: NodeCreateInput) =>
    api.post<LocationNode>('/location-nodes', { json: input }),

  remove: (id: string) => api.delete<LocationNode>(`/location-nodes/${id}`),

  rename: (id: string, name: string) =>
    api.patch<LocationNode>(`/location-nodes/${id}`, { json: { name } }),

  updateGrid: (id: string, input: GridUpdateInput) =>
    api.put<LocationNode>(`/location-nodes/${id}/grid`, { json: input }),

  updateDedication: (id: string, input: DedicationUpdateInput) =>
    api.put<LocationNode>(`/location-nodes/${id}/dedication`, { json: input }),

  place: (input: PlaceInput) => api.post<Allocation>('/allocations/place', { json: input }),

  placeBatch: (input: PlaceBatchInput) =>
    api.post<Allocation[]>('/allocations/place-batch', { json: input }),

  transfer: (input: TransferInput) =>
    api.post<Allocation>('/allocations/transfer', { json: input }),

  consume: (input: ConsumeInput) =>
    api.post<Allocation>('/allocations/consume', { json: input }),

  consumeBatch: (input: ConsumeBatchInput) =>
    api.post<Allocation[]>('/allocations/consume-batch', { json: input }),

  transferBatch: (input: TransferBatchInput) =>
    api.post<Allocation[]>('/allocations/transfer-batch', { json: input }),

  lotAvailability: (lotId: string, opts?: { signal?: AbortSignal }) =>
    api.get<LotAvailability>(`/allocations/lot-availability/${lotId}`, {
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
