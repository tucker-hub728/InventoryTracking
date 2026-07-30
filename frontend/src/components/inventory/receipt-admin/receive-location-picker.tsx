'use client';

/**
 * Where received units go.
 *
 * This used to be a Location dropdown (LN2 / Freezer / Warehouse) followed by one
 * dropdown per hierarchy level. Each was individually correct and the set was
 * useless: a quadrant's only legal child type is a rack, so a level's dropdown
 * could only ever list one kind of thing, stripped of the context that tells you
 * which one you want. Picking "LN2" then a tank then a quadrant then a rack then
 * a box meant five controls to name one shelf.
 *
 * It now uses the same {@link LocationTreePicker} kitting uses — one popover, the
 * real hierarchy, search, only storage leaves selectable. Same component, same
 * tree, same behaviour in both modules.
 *
 * The logic around it is unchanged: a box still needs exactly ``qty`` cells
 * chosen in its grid, a free leaf takes all the units, and the request still
 * carries only ``node_id`` + ``cells``. ``PlacementValue.area`` is UI-only — it
 * is never sent — and is now derived from which tree the chosen node came from
 * rather than from a dropdown the operator had to set first.
 */

import * as React from 'react';

import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { BoxGrid } from '@/components/locations/box-grid';
import { LocationTreePicker } from '@/components/reconciliation/location-tree-picker';
import {
  locationNodesApi,
  type Allocation,
  type NodeTree,
  type NodeType,
} from '@/lib/api/location-nodes';
import type { ReceivePlacementCell } from '@/lib/api/receiving';

export type Area = 'ln2' | 'freezer' | 'warehouse';

export interface StoreLeaf {
  id: string;
  node: NodeTree;
  /** Breadcrumb from the area root, e.g. "Materials Management › Minus-20 Freezers › T90020B". */
  path: string;
}

/** Full location trees per area. Retained so callers can resolve a chosen node
 *  to its full {@link NodeTree} — the picker itself loads its own forest. */
export type AreaTrees = Record<Area, NodeTree[]>;

/** @deprecated flattened-leaf shape kept for any external callers. */
export type AreaLeaves = Record<Area, StoreLeaf[]>;

export interface PlacementValue {
  area: Area;
  nodeId: string;
  nodeType: NodeType;
  /** Box cells (LN2 only); empty for a free leaf (freezer sub-location / shelf). */
  cells: ReceivePlacementCell[];
}

const AREA_ORDER: Area[] = ['ln2', 'freezer', 'warehouse'];

/** Flatten a tree to its storage leaves, each with a breadcrumb path. */
export function collectLeaves(roots: NodeTree[]): StoreLeaf[] {
  const out: StoreLeaf[] = [];
  const walk = (n: NodeTree, prefix: string[]) => {
    const path = [...prefix, n.name];
    if (n.can_store) out.push({ id: n.id, node: n, path: path.join(' › ') });
    n.children.forEach((c) => walk(c, path));
  };
  roots.forEach((r) => walk(r, []));
  return out;
}

/** True when a placement is fully specified for a received quantity. */
export function placementComplete(
  v: PlacementValue | null | undefined,
  qty: number,
): boolean {
  if (!v || !v.nodeId) return false;
  if (v.nodeType === 'box') return v.cells.length === qty;
  return true;
}

/**
 * Resolve a node id against the loaded trees — the full node, and which area it
 * came from.
 *
 * The tree picker hands back an id; the cell grid needs the node's
 * ``grid_rows``/``grid_cols`` and its type, so the node has to be looked up.
 * ``area`` falls out of whichever tree held it.
 */
function findNode(trees: AreaTrees, id: string): { node: NodeTree; area: Area } | null {
  if (!id) return null;
  for (const area of AREA_ORDER) {
    const stack = [...(trees[area] ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.id === id) return { node: n, area };
      stack.push(...n.children);
    }
  }
  return null;
}

export function ReceiveLocationPicker({
  qty,
  trees,
  value,
  onChange,
  disabled,
}: {
  qty: number;
  trees: AreaTrees;
  value: PlacementValue | null;
  onChange: (v: PlacementValue | null) => void;
  disabled?: boolean;
}) {
  const selected = findNode(trees, value?.nodeId ?? '');

  const pick = (nodeId: string) => {
    const found = findNode(trees, nodeId);
    if (!found) {
      onChange(null);
      return;
    }
    // A new destination starts with no cells — the previous box's coordinates
    // mean nothing in a different box.
    onChange({
      area: found.area,
      nodeId: found.node.id,
      nodeType: found.node.node_type,
      cells: [],
    });
  };

  return (
    <div className="space-y-2">
      <LocationTreePicker
        aria-label="Destination"
        value={value?.nodeId ?? ''}
        onChange={pick}
        showPath
        // Inside a Dialog, so the popover owns its own scroll-lock.
        modal
        disabled={disabled}
        placeholder="Choose where these units go…"
        emptyText="No storage locations are set up yet."
      />

      {selected && selected.node.node_type === 'box' ? (
        <CellSelector
          box={selected.node}
          qty={qty}
          value={value?.cells ?? []}
          onChange={(cells) =>
            onChange({ area: selected.area, nodeId: selected.node.id, nodeType: 'box', cells })
          }
        />
      ) : selected ? (
        <p className="text-xs text-text-3">
          All {qty} unit{qty === 1 ? '' : 's'} will be placed at{' '}
          <span className="font-mono text-text-2">{selected.node.name}</span>.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Destination picker that emits the chosen storage leaf (or null) — same tree,
 * without the box-cell grid, because the caller renders its own cell / quantity
 * UI. Used by the inline transfer flows in the location detail panel.
 */
export function LocationLeafPicker({
  trees,
  onChange,
  disabled,
}: {
  trees: AreaTrees;
  onChange: (leaf: NodeTree | null) => void;
  disabled?: boolean;
}) {
  const [nodeId, setNodeId] = React.useState('');

  const pick = (id: string) => {
    setNodeId(id);
    onChange(findNode(trees, id)?.node ?? null);
  };

  return (
    <LocationTreePicker
      aria-label="Destination"
      value={nodeId}
      onChange={pick}
      showPath
      disabled={disabled}
      placeholder="Choose a destination…"
      emptyText="No storage locations are set up yet."
    />
  );
}

function CellSelector({
  box,
  qty,
  value,
  onChange,
}: {
  box: NodeTree;
  qty: number;
  value: ReceivePlacementCell[];
  onChange: (cells: ReceivePlacementCell[]) => void;
}) {
  const [allocs, setAllocs] = React.useState<Allocation[]>([]);

  React.useEffect(() => {
    const ctrl = new AbortController();
    locationNodesApi
      .nodeAllocations(box.id, { signal: ctrl.signal })
      .then(setAllocs)
      .catch(() => {
        /* occupied cells just won't render as blocked; backend still guards */
      });
    return () => ctrl.abort();
  }, [box.id]);

  const selectedSet = new Set(value.map((c) => `${c.grid_row}:${c.grid_col}`));
  const complete = value.length === qty;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-text-3">
          Select exactly {qty} empty cell{qty === 1 ? '' : 's'} in{' '}
          <span className="font-mono text-text-2">{box.name}</span>
        </span>
        <span className={cn('font-mono', complete ? 'text-success' : 'text-text-3')}>
          {value.length}/{qty}
        </span>
      </div>
      <div className="overflow-x-auto rounded-md border border-border bg-bg-elev p-2">
        <BoxGrid
          rows={box.grid_rows ?? 1}
          cols={box.grid_cols ?? 1}
          allocations={allocs}
          selectedCells={selectedSet}
          onSelectCell={({ row, col, occupant }) => {
            if (occupant) return;
            const key = `${row}:${col}`;
            if (selectedSet.has(key)) {
              onChange(value.filter((c) => !(c.grid_row === row && c.grid_col === col)));
            } else {
              if (value.length >= qty) {
                toast.error(`Select exactly ${qty} cell${qty === 1 ? '' : 's'} for this line.`);
                return;
              }
              onChange([...value, { grid_row: row, grid_col: col }]);
            }
          }}
        />
      </div>
    </div>
  );
}
