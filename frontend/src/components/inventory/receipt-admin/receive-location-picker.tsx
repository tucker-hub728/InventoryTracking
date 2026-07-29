'use client';

import * as React from 'react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { BoxGrid } from '@/components/locations/box-grid';
import {
  locationNodesApi,
  NODE_TYPE_LABEL,
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

/** Full location trees per area — the picker walks them level by level. */
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

/** Sentinel key for the top cascade level in the picks map. */
const ROOT_KEY = '__root__';

const AREA_ORDER: Area[] = ['ln2', 'freezer', 'warehouse'];
const AREA_LABEL: Record<Area, string> = {
  ln2: 'LN2',
  freezer: 'Freezer',
  warehouse: 'Warehouse',
};
/** Extra hint shown when an area has no storage targets at all. */
const AREA_EMPTY_HINT: Record<Area, string> = {
  ln2: '',
  freezer: ' — add sub-locations on the Freezers page first.',
  warehouse: '',
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

/** Label for a cascade level, e.g. "Quadrant" or "Rack". Joins with " / " when
 *  a level accepts more than one node type — nothing does today, but the
 *  Phase 2 configurable cascade can reintroduce that. */
function levelLabel(options: NodeTree[]): string {
  const types = Array.from(new Set(options.map((o) => o.node_type)));
  return types.map((t) => NODE_TYPE_LABEL[t]).join(' / ');
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

interface CascadeStep {
  parentKey: string;
  options: NodeTree[];
  value: string;
}

interface ResolvedCascade {
  /** Full resolved path, root → deepest selected node. */
  chain: NodeTree[];
  /** Visible dropdown levels (collapsed single-option levels are omitted). */
  steps: CascadeStep[];
  /** The deepest selected node, whether or not it can store. */
  deepest: NodeTree | null;
  /** The chosen storage leaf, or null while only a container is selected. */
  leaf: NodeTree | null;
  /** A container was drilled into but has nothing to store in. */
  deadEnd: boolean;
}

/**
 * Walk the area tree from the user's picks. When ``collapseSingles`` is set the
 * lone option at a level is auto-selected and hidden (used for the single
 * Warehouse); otherwise every level is shown as a dropdown even if it has one
 * option, so LN2 / Freezer keep their full hierarchy.
 */
function resolveCascade(
  roots: NodeTree[],
  picks: Record<string, string>,
  collapseSingles: boolean,
): ResolvedCascade {
  const chain: NodeTree[] = [];
  const steps: CascadeStep[] = [];
  let options = roots;
  let parentKey = ROOT_KEY;
  while (options.length > 0) {
    const pickedId = picks[parentKey];
    const explicit = pickedId ? options.find((o) => o.id === pickedId) ?? null : null;

    // Collapse a single un-picked option (Warehouse only): auto-select + hide.
    if (collapseSingles && options.length === 1 && !explicit && options[0]) {
      const only = options[0];
      chain.push(only);
      if (only.can_store || only.children.length === 0) break;
      options = only.children;
      parentKey = only.id;
      continue;
    }

    steps.push({ parentKey, options, value: explicit?.id ?? '' });
    if (!explicit) break;
    chain.push(explicit);
    if (explicit.can_store || explicit.children.length === 0) break;
    options = explicit.children;
    parentKey = explicit.id;
  }

  const deepest = chain[chain.length - 1] ?? null;
  const leaf = deepest?.can_store ? deepest : null;
  const deadEnd = Boolean(deepest && !deepest.can_store && deepest.children.length === 0);
  return { chain, steps, deepest, leaf, deadEnd };
}

/**
 * The shared cascade UI: a Location dropdown (LN2 / Freezer / Warehouse) plus
 * one dropdown per visible hierarchy level, and the empty / dead-end notes. The
 * caller owns the state and passes down the resolved ``steps``.
 */
function CascadeControls({
  area,
  roots,
  steps,
  deadEnd,
  deepest,
  onArea,
  onPick,
  disabled,
  modal,
}: {
  area: Area;
  roots: NodeTree[];
  steps: CascadeStep[];
  deadEnd: boolean;
  deepest: NodeTree | null;
  onArea: (a: Area) => void;
  onPick: (parentKey: string, id: string) => void;
  disabled?: boolean;
  /** True inside a Dialog (modal popover); false for page-level inline use. */
  modal?: boolean;
}) {
  return (
    <>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Location">
          <Select value={area} onValueChange={(v) => onArea(v as Area)} disabled={disabled}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AREA_ORDER.map((a) => (
                <SelectItem key={a} value={a}>
                  {AREA_LABEL[a]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {roots.length > 0 &&
          steps.map((step) => (
            <Field key={step.parentKey} label={levelLabel(step.options)}>
              <SearchableSelect
                modal={modal}
                options={step.options.map((n) => ({
                  value: n.id,
                  label: n.name,
                  searchText: `${n.name} ${n.code}`,
                }))}
                value={step.value}
                onChange={(id) => onPick(step.parentKey, id)}
                placeholder={`Select a ${levelLabel(step.options)}…`}
                disabled={disabled}
              />
            </Field>
          ))}
      </div>

      {roots.length === 0 ? (
        <p className="rounded-md border border-border bg-surface px-3 py-2 text-xs text-text-3">
          No locations available in {AREA_LABEL[area]}
          {AREA_EMPTY_HINT[area] || '.'}
        </p>
      ) : deadEnd ? (
        <p className="rounded-md border border-border bg-surface px-3 py-2 text-xs text-text-3">
          <span className="font-mono text-text-2">{deepest?.name}</span> has no storage
          sub-locations yet.
        </p>
      ) : null}
    </>
  );
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
  const [area, setArea] = React.useState<Area>(value?.area ?? 'ln2');
  // Explicit user picks within the current area: parent node id (or the
  // ``ROOT_KEY`` sentinel for the top level) → the chosen child's id.
  const [picks, setPicks] = React.useState<Record<string, string>>({});

  const roots = trees[area];
  const { steps, deepest, leaf, deadEnd } = resolveCascade(roots, picks, area === 'warehouse');
  const leafId = leaf?.id ?? '';

  // Push the resolved leaf up to the parent. Keyed on the leaf + area only, so
  // cell edits (which change ``value`` but not the leaf) never clobber cells.
  React.useEffect(() => {
    if (leaf) {
      if (value?.area !== area || value?.nodeId !== leaf.id) {
        onChange({ area, nodeId: leaf.id, nodeType: leaf.node_type, cells: [] });
      }
    } else if (value && value.area === area) {
      onChange(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leafId, area]);

  const switchArea = (a: Area) => {
    if (a === area) return;
    setArea(a);
    setPicks({});
    // A selection belongs to one area — clear it when leaving that area.
    if (value) onChange(null);
  };

  return (
    <div className="space-y-2">
      <CascadeControls
        area={area}
        roots={roots}
        steps={steps}
        deadEnd={deadEnd}
        deepest={deepest}
        onArea={switchArea}
        onPick={(parentKey, id) => setPicks((prev) => ({ ...prev, [parentKey]: id }))}
        disabled={disabled}
        modal
      />

      {leaf && leaf.node_type === 'box' ? (
        <CellSelector
          box={leaf}
          qty={qty}
          value={value?.cells ?? []}
          onChange={(cells) => onChange({ area, nodeId: leaf.id, nodeType: 'box', cells })}
        />
      ) : leaf ? (
        <p className="text-xs text-text-3">
          All {qty} unit{qty === 1 ? '' : 's'} will be placed at{' '}
          <span className="font-mono text-text-2">{leaf.name}</span>.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Destination picker that emits the chosen storage leaf (or null). Same
 * Location → hierarchy cascade as {@link ReceiveLocationPicker}, but without the
 * box-cell grid — the caller renders its own cell / quantity UI. Used by the
 * inline transfer flows in the location detail panel.
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
  const [area, setArea] = React.useState<Area>('ln2');
  const [picks, setPicks] = React.useState<Record<string, string>>({});

  const roots = trees[area];
  const { steps, deepest, leaf, deadEnd } = resolveCascade(roots, picks, area === 'warehouse');
  const leafId = leaf?.id ?? '';

  // Report the resolved leaf (or null) to the caller whenever it changes.
  React.useEffect(() => {
    onChange(leaf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leafId, area]);

  const switchArea = (a: Area) => {
    if (a === area) return;
    setArea(a);
    setPicks({});
  };

  return (
    <div className="space-y-2">
      <CascadeControls
        area={area}
        roots={roots}
        steps={steps}
        deadEnd={deadEnd}
        deepest={deepest}
        onArea={switchArea}
        onPick={(parentKey, id) => setPicks((prev) => ({ ...prev, [parentKey]: id }))}
        disabled={disabled}
      />
    </div>
  );
}

/** A small labelled wrapper so each cascade dropdown reads clearly. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <span className="block text-[11px] font-medium uppercase tracking-wide text-text-3">
        {label}
      </span>
      {children}
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
