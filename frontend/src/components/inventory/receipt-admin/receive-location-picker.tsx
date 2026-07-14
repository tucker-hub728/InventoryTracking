'use client';

import * as React from 'react';

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { BoxGrid } from '@/components/locations/box-grid';
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
  /** Breadcrumb from the area root, e.g. "Materials Management › -20°C Freezer 1 › T90020B". */
  path: string;
}

export type AreaLeaves = Record<Area, StoreLeaf[]>;

export interface PlacementValue {
  area: Area;
  nodeId: string;
  nodeType: NodeType;
  /** Box cells (LN2 only); empty for a free leaf (freezer sub-location / shelf). */
  cells: ReceivePlacementCell[];
}

const AREA_ORDER: Area[] = ['ln2', 'freezer', 'warehouse'];
const AREA_LABEL: Record<Area, string> = {
  ln2: 'LN2',
  freezer: 'Freezer',
  warehouse: 'Warehouse',
};
const LEAF_NOUN: Record<Area, string> = {
  ln2: 'box',
  freezer: 'sub-location',
  warehouse: 'shelf',
};

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

export function ReceiveLocationPicker({
  qty,
  leaves,
  value,
  onChange,
  disabled,
}: {
  qty: number;
  leaves: AreaLeaves;
  value: PlacementValue | null;
  onChange: (v: PlacementValue | null) => void;
  disabled?: boolean;
}) {
  const [area, setArea] = React.useState<Area>(value?.area ?? 'ln2');
  const areaLeaves = leaves[area];
  const selectedId = value && value.area === area ? value.nodeId : '';
  const selectedLeaf = areaLeaves.find((l) => l.id === selectedId) ?? null;

  const pickLeaf = (id: string) => {
    const leaf = areaLeaves.find((l) => l.id === id);
    if (!leaf) {
      onChange(null);
      return;
    }
    onChange({ area, nodeId: id, nodeType: leaf.node.node_type, cells: [] });
  };

  const switchArea = (a: Area) => {
    setArea(a);
    // A selection belongs to one area — clear it when leaving that area.
    if (value && value.area !== a) onChange(null);
  };

  return (
    <div className="space-y-2">
      <Tabs value={area} onValueChange={(v) => switchArea(v as Area)}>
        <TabsList>
          {AREA_ORDER.map((a) => (
            <TabsTrigger key={a} value={a} disabled={disabled}>
              {AREA_LABEL[a]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {areaLeaves.length === 0 ? (
        <p className="rounded-md border border-border bg-surface px-3 py-2 text-xs text-text-3">
          No {LEAF_NOUN[area]}s available
          {area === 'freezer' ? ' — add sub-locations on the Freezers page first.' : '.'}
        </p>
      ) : (
        <>
          <SearchableSelect
            modal
            options={areaLeaves.map((l) => ({
              value: l.id,
              label: l.path,
              searchText: l.path,
            }))}
            value={selectedId}
            onChange={pickLeaf}
            placeholder={`Select a ${LEAF_NOUN[area]}…`}
            disabled={disabled}
          />
          {selectedLeaf && selectedLeaf.node.node_type === 'box' ? (
            <CellSelector
              box={selectedLeaf.node}
              qty={qty}
              value={value?.cells ?? []}
              onChange={(cells) =>
                onChange({ area, nodeId: selectedLeaf.id, nodeType: 'box', cells })
              }
            />
          ) : selectedLeaf ? (
            <p className="text-xs text-text-3">
              All {qty} unit{qty === 1 ? '' : 's'} will be placed at{' '}
              <span className="font-mono text-text-2">{selectedLeaf.node.name}</span>.
            </p>
          ) : null}
        </>
      )}
    </div>
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
          Select exactly {qty} empty cell{qty === 1 ? '' : 's'}
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
