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

import { CellGridPicker } from '@/components/reconciliation/cell-grid-picker';
import { LocationTreePicker } from '@/components/reconciliation/location-tree-picker';
import type { CellOption } from '@/lib/api/kits';
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
  reservedCells,
  excludeNodeId,
  excludeLabel,
  ln2Source,
}: {
  qty: number;
  trees: AreaTrees;
  value: PlacementValue | null;
  onChange: (v: PlacementValue | null) => void;
  disabled?: boolean;
  /** Cells in THIS box already claimed by a sibling picker in the same form —
   *  ``"row:col"`` keys. The transfer dialog aims several rows at one box, and
   *  a claim exists only in the unsaved form until it is signed. */
  reservedCells?: Set<string>;
  /** A node this placement may NOT target — the location the stock is being
   *  moved OUT of. A transfer has to change location, so offering the source
   *  back as a destination only leads to "the destination is the location it is
   *  already in" after the operator has picked their cells (client 2026-08-17).
   *
   *  Dropped from the tree, not greyed: kitting's split-output picker already
   *  removes a location another row has taken, and one convention for "not a
   *  choice here" beats two. */
  excludeNodeId?: string;
  /** Name of {@link excludeNodeId}, for the note that says why it is missing. */
  excludeLabel?: string;
  /** REQ-2026-08-13-LOC-003 — the stock being moved is coming OUT of liquid
   *  nitrogen, so the only destination a transfer may offer is another LN2 box.
   *
   *  The server enforces this regardless (``transfer_blocked_cold_chain``); this
   *  prop is what stops the operator discovering it only AFTER signing, since
   *  the signature is collected before the request goes out.
   *
   *  The other two destinations LOC-003 permits are not transfers and so cannot
   *  appear in this picker at all: a production room is reached through Issue on
   *  a kit, and a customer through Ship. */
  ln2Source?: boolean;
}) {
  const selected = findNode(trees, value?.nodeId ?? '');

  // Everything storable EXCEPT the excluded node, and — when the source is in
  // LN2 — only the boxes. Passing the allow-list is what prunes the branch:
  // ``LocationTreePicker`` keeps only allowed nodes and the ancestors leading to
  // them. Null when nothing restricts the tree, so the ordinary whole-tree case
  // is untouched.
  const allowedNodeIds = React.useMemo(() => {
    if (!excludeNodeId && !ln2Source) return null;
    const ids = new Set<string>();
    for (const area of AREA_ORDER) {
      for (const leaf of collectLeaves(trees[area] ?? [])) {
        // Keyed on node TYPE, not on "a different box": moving vials between
        // cells of the box they are already in is a legitimate transfer and the
        // only way to reorganise a box, so ``box`` stays allowed even when it is
        // the source. ``excludeNodeId`` still removes the source where the
        // caller asks for that (a flat source cannot receive its own stock).
        if (ln2Source && leaf.node.node_type !== 'box') continue;
        ids.add(leaf.id);
      }
    }
    if (excludeNodeId) ids.delete(excludeNodeId);
    return ids;
  }, [trees, excludeNodeId, ln2Source]);

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
        allowedNodeIds={allowedNodeIds}
        showPath
        // Inside a Dialog, so the popover owns its own scroll-lock.
        modal
        disabled={disabled}
        placeholder="Choose where these units go…"
        emptyText={
          ln2Source
            ? 'No other LN2 box is available to move this material to.'
            : 'No storage locations are set up yet.'
        }
      />

      {selected && selected.node.node_type === 'box' ? (
        <CellSelector
          box={selected.node}
          qty={qty}
          value={value?.cells ?? []}
          reservedCells={reservedCells}
          onChange={(cells) =>
            onChange({ area: selected.area, nodeId: selected.node.id, nodeType: 'box', cells })
          }
        />
      ) : selected ? (
        <p className="text-xs text-text-3">
          All {qty} unit{qty === 1 ? '' : 's'} will be placed at{' '}
          <span className="font-mono text-text-2">{selected.node.name}</span>.
        </p>
      ) : ln2Source ? (
        // Most of the tree is missing and the operator did not remove it. Say
        // why, and name the actions that DO reach the other two destinations
        // LOC-003 permits — otherwise "the freezers are gone" reads as a bug.
        <p className="text-xs text-text-3">
          Moving out of liquid nitrogen
          {excludeLabel ? (
            <>
              {' '}
              (<span className="font-mono text-text-2">{excludeLabel}</span>)
            </>
          ) : null}
          , so only another LN2 box is offered — to keep the cold chain intact. To begin
          manufacturing with this material use <span className="text-text-2">Issue</span> on a kit;
          to send it to a customer use <span className="text-text-2">Ship</span>.
        </p>
      ) : excludeLabel ? (
        // Nothing chosen yet, and one location is missing from the tree. Say
        // which and why — an operator hunting for the box they are standing in
        // should not have to conclude it was deleted.
        <p className="text-xs text-text-3">
          Moving out of <span className="font-mono text-text-2">{excludeLabel}</span>, so it
          isn&apos;t offered as the destination.
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
  ln2Source,
}: {
  trees: AreaTrees;
  onChange: (leaf: NodeTree | null) => void;
  disabled?: boolean;
  /** REQ-2026-08-13-LOC-003 — the stock being moved is coming OUT of liquid
   *  nitrogen, so only another LN2 box may be offered. Same rule and same
   *  reasoning as {@link ReceiveLocationPicker}'s prop of the same name; this
   *  picker serves the LN2 page's own inline transfer panels, which is where an
   *  operator standing at a box actually moves vials from. */
  ln2Source?: boolean;
}) {
  const [nodeId, setNodeId] = React.useState('');

  const allowedNodeIds = React.useMemo(() => {
    if (!ln2Source) return null;
    const ids = new Set<string>();
    for (const area of AREA_ORDER) {
      for (const leaf of collectLeaves(trees[area] ?? [])) {
        if (leaf.node.node_type === 'box') ids.add(leaf.id);
      }
    }
    return ids;
  }, [trees, ln2Source]);

  const pick = (id: string) => {
    setNodeId(id);
    onChange(findNode(trees, id)?.node ?? null);
  };

  return (
    <>
      <LocationTreePicker
        aria-label="Destination"
        value={nodeId}
        onChange={pick}
        allowedNodeIds={allowedNodeIds}
        showPath
        disabled={disabled}
        placeholder="Choose a destination…"
        emptyText={
          ln2Source
            ? 'No other LN2 box is available to move this material to.'
            : 'No storage locations are set up yet.'
        }
      />
      {ln2Source ? (
        // Say why the freezers and shelves are missing, and name the actions
        // that DO reach the other two destinations LOC-003 permits.
        <p className="text-xs text-text-3">
          Moving out of liquid nitrogen, so only another LN2 box is offered — to keep the cold
          chain intact. To begin manufacturing with this material use{' '}
          <span className="text-text-2">Issue</span> on a kit; to send it to a customer use{' '}
          <span className="text-text-2">Ship</span>.
        </p>
      ) : null}
    </>
  );
}

/**
 * Free-cell picker for a box destination.
 *
 * Renders the SHARED {@link CellGridPicker} — the same compact grid kitting's
 * issue, split-output, back-flush and return-excess pickers use. It used to
 * render {@link BoxGrid}, the large lot-labelled grid, which meant the two
 * dialogs that go through here (Receive and Transfer) showed a different
 * control from every other cell-picking screen in the app for the same job
 * (client 2026-08-17). ``BoxGrid`` stays where it belongs: the LN2 location
 * page, where reading which lot sits in which position IS the task.
 *
 * The grid owns its own heading, counter, legend and occupancy summary, so the
 * only thing left here is the capacity warning — which is about this ROW, not
 * about the box, and has nowhere else to live.
 */
function CellSelector({
  box,
  qty,
  value,
  onChange,
  reservedCells,
}: {
  box: NodeTree;
  qty: number;
  value: ReceivePlacementCell[];
  onChange: (cells: ReceivePlacementCell[]) => void;
  reservedCells?: Set<string>;
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

  // Occupied cells in the shape the shared grid reads. ``expiration_date`` is
  // null because a destination grid never tints by expiry — that cue is for
  // choosing which vial to TAKE.
  const cells: CellOption[] = React.useMemo(
    () =>
      allocs
        .filter((a) => a.is_active && a.grid_row != null && a.grid_col != null)
        .map((a) => ({
          allocation_id: a.id,
          grid_row: a.grid_row as number,
          grid_col: a.grid_col as number,
          lot_id: a.lot_id,
          lot_number: a.lot_number,
          expiration_date: null,
        })),
    [allocs],
  );

  // How many cells this box can actually offer: the grid, minus what is stored
  // in it, minus what a sibling row of the same form has already claimed.
  const capacity = Math.max(
    0,
    (box.grid_rows ?? 0) * (box.grid_cols ?? 0) - cells.length - (reservedCells?.size ?? 0),
  );
  // The operator cannot finish this row here — say so, rather than leaving them
  // clicking at a grid that will not accept the last unit.
  const tooSmall = capacity < qty;

  return (
    <div className="space-y-1.5">
      {tooSmall && (
        <p className="rounded-md border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-[11px] text-warning">
          <span className="font-mono">{box.name}</span> has {capacity} free cell
          {capacity === 1 ? '' : 's'} but this row moves {qty}. Lower this row to{' '}
          {capacity} and add another move for the remaining {qty - capacity}, or pick a
          bigger destination.
        </p>
      )}
      <CellGridPicker
        mode="destination"
        rows={box.grid_rows ?? 1}
        cols={box.grid_cols ?? 1}
        cells={cells}
        value={value.map((c) => `${c.grid_row}:${c.grid_col}`)}
        max={qty}
        reserved={reservedCells}
        onChange={(keys) =>
          onChange(
            keys.map((k) => {
              const [row, col] = k.split(':');
              return { grid_row: Number(row), grid_col: Number(col) };
            }),
          )
        }
      />
    </div>
  );
}
