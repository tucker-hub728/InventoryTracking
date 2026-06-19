/**
 * Location system API — wraps ``/api/v1/location-nodes`` and
 * ``/api/v1/allocations`` (Requirements v2 §5–§13).
 *
 * Strict LN2 hierarchy (tank_quadrant → rack → cassette_rack → box →
 * sub_slot) + flat operational locations. Only sub_slot / flat nodes can
 * hold a lot; placement creates allocation records; transfers/consumption
 * are logged in an append-only movement history.
 */

import { api } from './client';

export type NodeType =
  | 'tank_quadrant'
  | 'rack'
  | 'cassette_rack'
  | 'box'
  | 'sub_slot'
  | 'flat';

export type FlatCategory = 'kanban' | 'lab' | 'qc' | 'engineering' | 'materials';
export type MovementKind = 'place' | 'transfer' | 'consume';

/** Human labels for each node level. */
export const NODE_TYPE_LABEL: Record<NodeType, string> = {
  tank_quadrant: 'Tank Quadrant',
  rack: 'Rack',
  cassette_rack: 'Cassette / Box Rack',
  box: 'Box',
  sub_slot: 'Sub-slot',
  flat: 'Flat location',
};

export const FLAT_CATEGORY_LABEL: Record<FlatCategory, string> = {
  kanban: 'Kanban',
  lab: 'Lab',
  qc: 'QC',
  engineering: 'Engineering',
  materials: 'Materials',
};

export const FLAT_CATEGORIES: FlatCategory[] = [
  'kanban',
  'lab',
  'qc',
  'engineering',
  'materials',
];

/** The single allowed child type for each LN2 level (null = leaf / no children). */
export const CHILD_TYPE_OF: Record<NodeType, NodeType | null> = {
  tank_quadrant: 'rack',
  rack: 'cassette_rack',
  cassette_rack: 'box',
  box: 'sub_slot',
  sub_slot: null,
  flat: null,
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
  can_store: boolean;
  child_count: number;
  active_allocation_count: number;
  created_at: string;
  updated_at: string;
}

export interface NodeTree extends LocationNode {
  children: NodeTree[];
}

export interface Allocation {
  id: string;
  lot_id: string;
  lot_number: string | null;
  item_number: string | null;
  location_node_id: string;
  location_name: string | null;
  location_node_type: NodeType | null;
  /** NUMERIC → string. */
  qty: string;
  is_active: boolean;
  created_at: string;
}

export interface AllocationMovement {
  id: string;
  lot_id: string;
  lot_number: string | null;
  movement_kind: MovementKind;
  from_node_id: string | null;
  from_node_name: string | null;
  to_node_id: string | null;
  to_node_name: string | null;
  qty: string;
  notes: string | null;
  performed_by_user_id: string;
  performed_at: string;
}

export interface NodeCreateInput {
  node_type: NodeType;
  code: string;
  name: string;
  parent_id?: string | null;
  flat_category?: FlatCategory | null;
  notes?: string | null;
}

export interface PlaceInput {
  lot_id: string;
  node_id: string;
  qty: number;
  override?: boolean;
  notes?: string | null;
}

export interface TransferInput {
  allocation_id: string;
  to_node_id: string;
  qty: number;
  override?: boolean;
  notes?: string | null;
}

export interface ConsumeInput {
  allocation_id: string;
  qty: number;
  notes?: string | null;
}

export const locationNodesApi = {
  ln2Tree: (opts?: { activeOnly?: boolean; signal?: AbortSignal }) =>
    api.get<NodeTree[]>('/location-nodes/ln2-tree', {
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

  place: (input: PlaceInput) => api.post<Allocation>('/allocations/place', { json: input }),

  transfer: (input: TransferInput) =>
    api.post<Allocation>('/allocations/transfer', { json: input }),

  consume: (input: ConsumeInput) =>
    api.post<Allocation>('/allocations/consume', { json: input }),

  lotAllocations: (lotId: string, opts?: { signal?: AbortSignal }) =>
    api.get<Allocation[]>(`/allocations/by-lot/${lotId}`, { signal: opts?.signal }),

  movements: (opts?: { lotId?: string; nodeId?: string; signal?: AbortSignal }) =>
    api.get<AllocationMovement[]>('/allocations/movements', {
      query: { lot_id: opts?.lotId, node_id: opts?.nodeId },
      signal: opts?.signal,
    }),
};
