'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  ArrowRightLeft,
  Box,
  Boxes,
  ChevronDown,
  ChevronRight,
  Container,
  Maximize2,
  MoveRight,
  Package,
  Plus,
  Search,
  Server,
  ShieldCheck,
  Tag,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { toast } from '@/components/ui/sonner';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { PasswordReauthDialog } from '@/components/shared/password-reauth-dialog';
import { ItemLink } from '@/components/inventory/item-link';
import { LotLink } from '@/components/inventory/lot-link';
import { ApiError } from '@/lib/api/client';
import { lotsApi, type Lot } from '@/lib/api/lots';
import { customersApi } from '@/lib/api/customers';
import { itemsApi } from '@/lib/api/items';
import { isBuiltTier } from '@/lib/api/tiers';
import type { ReauthResponse } from '@/lib/api/auth';
import { cn } from '@/lib/utils';
import {
  locationNodesApi,
  parentTypesOf,
  subtreeStats,
  CHILD_TYPES_OF,
  NODE_TYPE_LABEL,
  type Allocation,
  type LocationNode,
  type LotAvailability,
  type NodeMovement,
  type NodeTree,
  type NodeType,
} from '@/lib/api/location-nodes';
import { selectIsSuperAdmin, useAuthStore } from '@/stores/auth.store';

import {
  LocationLeafPicker,
  type AreaTrees,
} from '@/components/inventory/receipt-admin/receive-location-picker';

import { BoxGrid, rowLabel } from './box-grid';

export const NODE_ICON: Record<NodeType, LucideIcon> = {
  tank: Container,
  tank_quadrant: Boxes,
  rack: Server,
  box: Box,
  // Retired LN2 levels — no longer creatable, kept so legacy rows still render.
  cassette: Container,
  cryo_box_rack: Boxes,
  // Freezer / warehouse nodes don't render in this (LN2) panel, but the map
  // must cover every NodeType.
  room: Container,
  room_location: Container,
  sub_location: Box,
  warehouse: Package,
  shelf: Box,
  flat: Package,
  cassette_rack: Container,
  sub_slot: Box,
};

// Unit-in (placing stock into an LN2 box cell) is disabled here — units are
// placed only from Receipt Admin (at receive). Empty cells are inert and the
// placement panel is hidden. Flip to re-enable the in-page placement flow.
const LN2_UNIT_IN_ENABLED = false;

/** Plural noun for a node's children, used in the "N boxes" header. */
function childUnit(nodeType: NodeType, n: number): string {
  const label =
    nodeType === 'tank'
      ? 'quadrant'
      : nodeType === 'tank_quadrant'
        ? 'rack'
        : nodeType === 'rack'
          ? 'box'
          : 'box';
  return `${label}${n === 1 ? '' : 's'}`;
}

// NOTE: the action's rationale ("notes") is no longer collected here — it is
// captured once, as a required comment, inside the e-sign dialog and read back
// from the signature evidence (``evidence.comment``) at submit time.
type Pending =
  | {
      kind: 'place';
      lotId: string;
      nodeId: string;
      gridRow: number | null;
      gridCol: number | null;
      qty: number;
    }
  | { kind: 'place-batch'; lotId: string; nodeId: string; cells: { row: number; col: number }[] }
  | {
      kind: 'transfer-batch';
      allocationIds: string[];
      toNodeId: string;
      toCells: { grid_row: number; grid_col: number }[] | null;
      qty: number | null;
      count: number;
    }
  | { kind: 'consume-batch'; allocationIds: string[]; toNodeId: string; count: number }
  | { kind: 'consume'; allocationId: string; toNodeId: string; qty: number }
  | null;

interface Props {
  node: NodeTree;
  /** Breadcrumb ancestry, root → selected (inclusive). */
  path: NodeTree[];
  canWrite: boolean;
  onSelectChild: (id: string) => void;
  onAddChild: (parent: LocationNode) => void;
  onRemoved: () => void;
  onChanged: () => void;
}

export function NodeDetailPanel({
  node,
  path,
  canWrite,
  onSelectChild,
  onAddChild,
  onChanged,
}: Props) {
  const Icon = NODE_ICON[node.node_type];
  const isBox = node.node_type === 'box';
  const isFlat = node.node_type === 'flat';
  const isContainerWithKids = !isBox && !isFlat;
  const stats = subtreeStats(node);
  const gridRows = node.grid_rows ?? 0;
  const gridCols = node.grid_cols ?? 0;
  const childType = CHILD_TYPES_OF[node.node_type];

  const [allocations, setAllocations] = React.useState<Allocation[]>([]);
  const [lots, setLots] = React.useState<Lot[]>([]);
  const [targets, setTargets] = React.useState<LocationNode[]>([]);
  // Full area trees for the cascading transfer-destination picker.
  const [trees, setTrees] = React.useState<AreaTrees | null>(null);
  const [consumedHere, setConsumedHere] = React.useState<NodeMovement[]>([]);
  const [dedName, setDedName] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  // Empty box cells multi-selected for batch placement (``"row:col"`` keys).
  const [selectedCells, setSelectedCells] = React.useState<Set<string>>(new Set());
  // Occupied box cells multi-selected for batch unit-out (one lot at a time).
  const [selectedOccupied, setSelectedOccupied] = React.useState<Set<string>>(new Set());
  const [batchLotId, setBatchLotId] = React.useState<string | null>(null);
  // The allocation whose full details are shown in the side sheet.
  const [detailAlloc, setDetailAlloc] = React.useState<Allocation | null>(null);
  const [placeLot, setPlaceLot] = React.useState('');
  const [placeAvail, setPlaceAvail] = React.useState<LotAvailability | null>(null);
  const [placeQty, setPlaceQty] = React.useState(isBox ? '1' : '');
  const [showResize, setShowResize] = React.useState(false);
  const [showEdit, setShowEdit] = React.useState(false);
  const [showMove, setShowMove] = React.useState(false);
  // Re-hanging a node is super-admin-only (LOC-004, enforced by the API).
  const isSuperAdmin = useAuthStore(selectIsSuperAdmin);
  // Which LN2 nodes could legally become this node's parent. Empty for a root.
  const movableTo = React.useMemo(() => {
    const allowed = parentTypesOf(node.node_type);
    if (allowed.length === 0 || !trees?.ln2) return [];
    const out: NodeTree[] = [];
    const walk = (n: NodeTree) => {
      if (allowed.includes(n.node_type) && n.id !== node.parent_id) out.push(n);
      n.children.forEach(walk);
    };
    trees.ln2.forEach(walk);
    // Never offer this node or anything inside it — that would detach the
    // branch from every root. The API refuses it too.
    const inside = new Set<string>();
    const mark = (n: NodeTree) => {
      inside.add(n.id);
      n.children.forEach(mark);
    };
    mark(node);
    return out.filter((n) => !inside.has(n.id));
  }, [node, trees]);
  // Bumped after each successful action so open inline forms remount shut.
  const [opSeq, setOpSeq] = React.useState(0);

  const [pending, setPending] = React.useState<Pending>(null);
  const [showReauth, setShowReauth] = React.useState(false);

  const reload = React.useCallback(async () => {
    if (!node.can_store) {
      setAllocations([]);
      return;
    }
    setLoading(true);
    try {
      const [allocs, lotList, tgts] = await Promise.all([
        locationNodesApi.nodeAllocations(node.id),
        // Only available lots can be placed — on-order lots aren't received yet.
        lotsApi.list({ limit: 500, status: 'available' }),
        locationNodesApi.storageTargets(),
      ]);
      setAllocations(allocs);
      setLots(lotList);
      setTargets(tgts.filter((t) => t.id !== node.id));
      // A flat location shows what was consumed at it (ledger dispenses whose
      // destination is this node). The stock is used up — this is history.
      if (node.node_type === 'flat') {
        const mv = await locationNodesApi.movements({ nodeId: node.id });
        setConsumedHere(
          mv.filter((m) => m.movement_type === 'dispense' && m.to_location_node_id === node.id),
        );
      } else {
        setConsumedHere([]);
      }
    } catch {
      /* surfaced per-action */
    } finally {
      setLoading(false);
    }
  }, [node.id, node.can_store, node.node_type]);

  // Load the destination trees once — they feed the transfer cascade picker.
  React.useEffect(() => {
    const ctrl = new AbortController();
    Promise.all([
      locationNodesApi.ln2Tree({ signal: ctrl.signal }),
      locationNodesApi.freezerTree({ signal: ctrl.signal }),
      locationNodesApi.warehouseTree({ signal: ctrl.signal }),
    ])
      .then(([ln2, freezer, warehouse]) => setTrees({ ln2, freezer, warehouse }))
      .catch(() => {
        /* the picker shows an empty state if the trees can't load */
      });
    return () => ctrl.abort();
  }, []);

  React.useEffect(() => {
    setSelectedCells(new Set());
    setSelectedOccupied(new Set());
    setBatchLotId(null);
    setDetailAlloc(null);
    setPlaceLot('');
    setPlaceQty(isBox ? '1' : '');
    setShowResize(false);
    setShowEdit(false);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  // Remaining-to-place for the currently picked lot (unit-in cap preview).
  React.useEffect(() => {
    if (!placeLot) {
      setPlaceAvail(null);
      return;
    }
    const ctrl = new AbortController();
    locationNodesApi
      .lotAvailability(placeLot, { signal: ctrl.signal })
      .then(setPlaceAvail)
      .catch(() => setPlaceAvail(null));
    return () => ctrl.abort();
  }, [placeLot]);

  // Resolve (inherited) dedication name for the header badge.
  React.useEffect(() => {
    const custId = node.dedicated_customer_id ?? node.inherited_customer_id;
    const prodId = node.dedicated_product_id ?? node.inherited_product_id;
    if (!custId && !prodId) {
      setDedName(null);
      return;
    }
    const ctrl = new AbortController();
    (async () => {
      try {
        if (custId) setDedName((await customersApi.get(custId, { signal: ctrl.signal })).name);
        else if (prodId) {
          const it = await itemsApi.get(prodId, { signal: ctrl.signal });
          setDedName(`${it.item_number} · ${it.description}`);
        }
      } catch {
        setDedName(null);
      }
    })();
    return () => ctrl.abort();
  }, [
    node.dedicated_customer_id,
    node.dedicated_product_id,
    node.inherited_customer_id,
    node.inherited_product_id,
  ]);

  // Batch place = one lot into N selected box cells (1 unit each), signed once.
  const openBatchPlaceSign = () => {
    if (!placeLot || selectedCells.size === 0) return;
    const cells = [...selectedCells].map((k) => {
      const [r, c] = k.split(':');
      return { row: Number(r), col: Number(c) };
    });
    setPending({
      kind: 'place-batch',
      lotId: placeLot,
      nodeId: node.id,
      cells,
    });
    setShowReauth(true);
  };

  // Toggle an empty box cell in/out of the batch placement selection.
  const toggleCell = (row: number, col: number) => {
    setSelectedCells((prev) => {
      const next = new Set(prev);
      const key = `${row}:${col}`;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Box grid click: empty cell → batch placement; occupied cell → batch
  // unit-out (single lot — a different lot is blocked).
  const handleSelectCell = (c: { row: number; col: number; occupant: Allocation | null }) => {
    const key = `${c.row}:${c.col}`;
    if (c.occupant) {
      // Switching to unit-out mode — drop any placement selection.
      setSelectedCells(new Set());
      setPlaceLot('');
      if (selectedOccupied.has(key)) {
        const next = new Set(selectedOccupied);
        next.delete(key);
        setSelectedOccupied(next);
        if (next.size === 0) setBatchLotId(null);
        return;
      }
      if (selectedOccupied.size > 0 && batchLotId && c.occupant.lot_id !== batchLotId) {
        toast.error('A batch must be a single lot.');
        return;
      }
      const next = new Set(selectedOccupied);
      next.add(key);
      setSelectedOccupied(next);
      setBatchLotId(c.occupant.lot_id);
    } else {
      // Empty cell: unit-in is done only from Receipt Admin, so LN2 cells are
      // not selectable for placement here. Clear any unit-out selection only.
      setSelectedOccupied(new Set());
      setBatchLotId(null);
      setPlaceLot('');
      if (LN2_UNIT_IN_ENABLED) toggleCell(c.row, c.col);
    }
  };

  // The allocations behind the currently multi-selected occupied cells.
  const selectedOutAllocs = React.useMemo(
    () =>
      allocations.filter(
        (a) =>
          a.is_active &&
          a.grid_row != null &&
          a.grid_col != null &&
          selectedOccupied.has(`${a.grid_row}:${a.grid_col}`),
      ),
    [allocations, selectedOccupied],
  );

  const runSigned = async (evidence: ReauthResponse) => {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.kind === 'place') {
        await locationNodesApi.place({
          lot_id: pending.lotId,
          node_id: pending.nodeId,
          qty: pending.qty,
          grid_row: pending.gridRow,
          grid_col: pending.gridCol,
          evidence_id: evidence.evidence_id,
          notes: evidence.comment ?? '',
        });
        toast.success('Placed');
        setPlaceLot('');
      } else if (pending.kind === 'place-batch') {
        await locationNodesApi.placeBatch({
          lot_id: pending.lotId,
          node_id: pending.nodeId,
          cells: pending.cells.map((c) => ({ grid_row: c.row, grid_col: c.col })),
          evidence_id: evidence.evidence_id,
          notes: evidence.comment ?? '',
        });
        toast.success(`Placed ${pending.cells.length} unit(s)`);
        setPlaceLot('');
        setSelectedCells(new Set());
      } else if (pending.kind === 'transfer-batch') {
        await locationNodesApi.transferBatch({
          allocation_ids: pending.allocationIds,
          to_node_id: pending.toNodeId,
          to_cells: pending.toCells ?? undefined,
          qty: pending.qty ?? undefined,
          evidence_id: evidence.evidence_id,
          notes: evidence.comment ?? '',
        });
        toast.success(`Transferred ${pending.count} unit(s)`);
        setSelectedOccupied(new Set());
        setBatchLotId(null);
      } else if (pending.kind === 'consume-batch') {
        await locationNodesApi.consumeBatch({
          allocation_ids: pending.allocationIds,
          to_node_id: pending.toNodeId,
          evidence_id: evidence.evidence_id,
          notes: evidence.comment ?? '',
        });
        toast.success(`Consumed ${pending.count} unit(s)`);
        setSelectedOccupied(new Set());
        setBatchLotId(null);
      } else {
        // Single-allocation partial consume (flat location, chosen qty).
        await locationNodesApi.consume({
          allocation_id: pending.allocationId,
          to_node_id: pending.toNodeId,
          qty: pending.qty,
          evidence_id: evidence.evidence_id,
          notes: evidence.comment ?? '',
        });
        toast.success(`Consumed ${pending.qty} unit(s)`);
      }
      // Bump so any open inline action form (transfer/consume) remounts shut.
      setOpSeq((n) => n + 1);
      setPending(null);
      await reload();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Operation failed.');
    } finally {
      setBusy(false);
    }
  };

  const reauthAction =
    pending?.kind === 'transfer-batch'
      ? 'movement.transfer'
      : pending?.kind === 'place' || pending?.kind === 'place-batch'
        ? 'movement.receipt'
        : 'movement.dispense';
  const attestation =
    pending?.kind === 'place'
      ? `I attest this placement (unit-in) of ${pending.qty} unit(s) is accurate.`
      : pending?.kind === 'place-batch'
        ? `I attest this placement (unit-in) of ${pending.cells.length} unit(s) is accurate.`
        : pending?.kind === 'transfer-batch'
          ? `I attest this transfer (unit-out) of ${pending.count} unit(s) is accurate.`
          : pending?.kind === 'consume-batch'
            ? `I attest this consumption (unit-out) of ${pending.count} unit(s) is accurate.`
            : pending?.kind === 'consume'
              ? `I attest this consumption (unit-out) of ${pending.qty} unit(s) is accurate.`
              : '';

  const utilisation = stats.capacity > 0 ? Math.round((stats.occupied / stats.capacity) * 100) : 0;
  // Occupied = holds units (its own, or a descendant's). Blocks remove/resize.
  const isOccupied = isFlat ? node.active_allocation_count > 0 : stats.occupied > 0;

  // Would the current placement exceed the lot's remaining-to-place cap?
  const placingCount = isBox ? selectedCells.size : Number(placeQty) || 0;
  const overPlaceCap = placeAvail?.remaining != null && placingCount > placeAvail.remaining;

  return (
    <div className="min-w-0 flex-1 px-6 py-5 sm:px-8">
      {/* Breadcrumb */}
      <nav className="mb-3 flex flex-wrap items-center gap-1 text-xs text-text-3">
        {path.map((p, i) => (
          <React.Fragment key={p.id}>
            {i > 0 && <ChevronRight size={12} className="opacity-60" />}
            <span className={cn(i === path.length - 1 && 'font-medium text-text-2')}>{p.name}</span>
          </React.Fragment>
        ))}
      </nav>

      {/* Header */}
      <div className="mb-5 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-lg border border-border bg-surface text-text-2">
            <Icon size={20} />
          </span>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-text-1 text-xl font-semibold">{node.name}</h2>
              <Badge tone="neutral">{NODE_TYPE_LABEL[node.node_type]}</Badge>
              {isBox && gridRows > 0 && (
                <Badge tone="neutral">
                  {gridRows}×{gridCols}
                </Badge>
              )}
              {dedName && (
                <Badge tone="accent">
                  <Tag size={11} className="mr-1 inline" />
                  {dedName}
                </Badge>
              )}
            </div>
          </div>
        </div>
        {canWrite && (
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setShowEdit(true)}>
              <Tag size={14} /> Edit
            </Button>
            {isBox && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowResize(true)}
                disabled={isOccupied}
                title={isOccupied ? 'Box is occupied — empty it before resizing' : undefined}
              >
                <Maximize2 size={14} /> Resize
              </Button>
            )}
            {/* Re-hang this node under a different parent (LOC-004). Hidden for
                roots, which have nothing to hang under, and for non-super-admins
                — the API refuses either way. */}
            {isSuperAdmin && movableTo.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setShowMove(true)}>
                <MoveRight size={14} /> Move
              </Button>
            )}
            {/* Remove is hidden for now. */}
          </div>
        )}
      </div>

      {/* Stat cards */}
      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {isFlat ? (
          <Stat label="Occupied" value={`${node.active_allocation_count}`} />
        ) : (
          <>
            <Stat label={isBox ? 'Sub-slots' : 'Capacity'} value={`${stats.capacity}`} />
            <Stat label="Occupied" value={`${stats.occupied}`} dot />
            <UtilStat pct={utilisation} />
          </>
        )}
      </div>

      {/* ── Container with children (quadrant / rack / cassette / cryo box rack) ── */}
      {isContainerWithKids && (
        <div className="rounded-lg border border-border bg-bg-elev">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-sm font-medium text-text-2">
              {node.children.length} {childUnit(node.node_type, node.children.length)}
            </p>
            {canWrite && childType.length > 0 && (
              <Button size="sm" variant="secondary" onClick={() => onAddChild(node)}>
                <Plus size={14} />{' '}
                {childType.length === 1 ? `Add ${childUnit(node.node_type, 1)}` : 'Add container'}
              </Button>
            )}
          </div>
          {node.children.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-text-3">
              Nothing here yet. Add a {childUnit(node.node_type, 1)} to get started.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {node.children.map((child) => (
                <ChildCard key={child.id} child={child} onClick={() => onSelectChild(child.id)} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Box: unit map + contents ─────────────────────────────────── */}
      {isBox && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-border bg-bg-elev p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium text-text-2">
                Unit map · {gridRows}×{gridCols}
              </p>
              <span className="text-xs text-text-3">Click a unit to move</span>
            </div>
            <BoxGrid
              rows={gridRows}
              cols={gridCols}
              allocations={allocations}
              selectedCells={selectedCells}
              selectedOccupied={selectedOccupied}
              onSelectCell={handleSelectCell}
            />
            {/* Batch unit-out (transfer / consume) for the selected units. */}
            {canWrite && selectedOutAllocs.length > 0 && (
              <div className="mt-3">
                <BatchOutPanel
                  selected={selectedOutAllocs}
                  targets={targets}
                  trees={trees}
                  busy={busy}
                  onClear={() => {
                    setSelectedOccupied(new Set());
                    setBatchLotId(null);
                  }}
                  onTransfer={(p) => {
                    setPending({ kind: 'transfer-batch', ...p });
                    setShowReauth(true);
                  }}
                  onConsume={(p) => {
                    setPending({ kind: 'consume-batch', ...p });
                    setShowReauth(true);
                  }}
                />
              </div>
            )}
            {/* Batch placement into empty cells — disabled: unit-in is done
                only from Receipt Admin. */}
            {canWrite && LN2_UNIT_IN_ENABLED && selectedCells.size > 0 && (
              <div className="mt-3 rounded-md border border-border bg-surface p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-medium text-text-2">
                    Placing into {selectedCells.size} {selectedCells.size === 1 ? 'cell' : 'cells'}
                  </p>
                  <button
                    type="button"
                    className="text-xs text-text-3 hover:text-accent"
                    onClick={() => setSelectedCells(new Set())}
                  >
                    Clear
                  </button>
                </div>
                <p className="mb-2 font-mono text-[11px] text-text-3">
                  {[...selectedCells]
                    .map((k) => {
                      const [r, c] = k.split(':');
                      return `${rowLabel(Number(r))}${c}`;
                    })
                    .sort()
                    .join(', ')}
                </p>
                <div className="space-y-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Lot (one unit per cell)</Label>
                    <LotCombobox lots={lots} value={placeLot} onChange={setPlaceLot} />
                    <RemainingHint avail={placeAvail} selecting={selectedCells.size} />
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy || !placeLot || overPlaceCap}
                    onClick={openBatchPlaceSign}
                  >
                    <ShieldCheck size={13} /> Sign &amp; place {selectedCells.size}{' '}
                    {selectedCells.size === 1 ? 'unit' : 'units'}
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border bg-bg-elev">
            <div className="border-b border-border px-4 py-3">
              <p className="text-sm font-medium text-text-2">
                Contents <span className="text-text-3">· {allocations.length} placed</span>
                {loading && <span className="ml-2 text-text-3">loading…</span>}
              </p>
            </div>
            {allocations.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-text-3">Nothing placed yet.</p>
            ) : (
              <ul className="max-h-[28rem] divide-y divide-border overflow-y-auto">
                {[...allocations]
                  .sort((a, b) => cellSort(a) - cellSort(b))
                  .map((a) => (
                    <li key={a.id}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface"
                        onClick={() => setDetailAlloc(a)}
                        title="View details"
                      >
                        <span className="w-8 shrink-0 font-mono text-xs text-text-3">
                          {a.grid_row != null && a.grid_col != null
                            ? `${rowLabel(a.grid_row)}${a.grid_col}`
                            : '—'}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="text-text-1 block truncate text-sm">
                            {a.item_number ?? '—'}
                          </span>
                          <span className="block truncate text-xs text-text-3">
                            {a.lot_number ?? a.lot_id.slice(0, 8)}
                          </span>
                        </span>
                        <ChevronRight size={15} className="shrink-0 text-text-3" />
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* ── Flat: contents ───────────────────────────────────────────── */}
      {/* NOTE: the "Place a lot here (unit-in)" form is hidden for now. */}
      {isFlat && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-bg-elev">
            <div className="border-b border-border px-4 py-3">
              <p className="text-sm font-medium text-text-2">
                Contents <span className="text-text-3">· {allocations.length}</span>
              </p>
            </div>
            {allocations.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-text-3">Nothing stored here.</p>
            ) : (
              <ul className="divide-y divide-border">
                {allocations.map((a) => (
                  <li key={a.id} className="px-4 py-3">
                    <button
                      type="button"
                      className="mb-2 flex w-full items-center justify-between gap-2 text-left hover:opacity-80"
                      onClick={() => setDetailAlloc(a)}
                      title="View details"
                    >
                      <div className="min-w-0">
                        <span className="text-text-1 text-sm">{a.item_number ?? '—'}</span>
                        <span className="ml-2 font-mono text-xs text-accent">
                          {a.lot_number ?? a.lot_id.slice(0, 8)}
                        </span>
                        <span className="ml-2 font-mono text-xs text-text-3">qty {a.qty}</span>
                      </div>
                      <ChevronRight size={15} className="shrink-0 text-text-3" />
                    </button>
                    <AllocationActions
                      key={`${a.id}-${opSeq}`}
                      allocation={a}
                      trees={trees}
                      canWrite={canWrite}
                      consumeAtNodeId={node.id}
                      onTransfer={(p) => {
                        setPending({ kind: 'transfer-batch', ...p });
                        setShowReauth(true);
                      }}
                      onConsume={(p) => {
                        setPending({ kind: 'consume', ...p });
                        setShowReauth(true);
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>

          {consumedHere.length > 0 && (
            <div className="rounded-lg border border-border bg-bg-elev">
              <div className="border-b border-border px-4 py-3">
                <p className="text-sm font-medium text-text-2">
                  Consumed here <span className="text-text-3">· {consumedHere.length}</span>
                </p>
                <p className="text-xs text-text-3">
                  Units used up at this location (out of inventory).
                </p>
              </div>
              <ul className="divide-y divide-border">
                {consumedHere.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="text-text-1 block truncate">
                        <ItemLink itemNumber={m.item_number} itemId={m.item_id} />
                      </span>
                      <span className="block truncate text-xs text-text-3">
                        <LotLink lotId={m.lot_id} lotNumber={m.lot_number} /> ·{' '}
                        {new Date(m.performed_at).toISOString().slice(0, 10)}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-xs text-warning">
                      −{Math.abs(m.qty_delta)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <PasswordReauthDialog
        open={showReauth}
        onOpenChange={(o) => {
          setShowReauth(o);
          if (!o) setPending(null);
        }}
        action={reauthAction}
        meaning={attestation}
        commentPlaceholder={
          pending?.kind === 'transfer-batch'
            ? 'Reason for this transfer'
            : pending?.kind === 'place' || pending?.kind === 'place-batch'
              ? 'Reason for this placement'
              : 'Reason for this removal'
        }
        onConfirmed={(evidence) => {
          setShowReauth(false);
          void runSigned(evidence);
        }}
        title={
          pending?.kind === 'transfer-batch'
            ? 'Sign this transfer'
            : pending?.kind === 'place' || pending?.kind === 'place-batch'
              ? 'Sign this placement'
              : 'Sign this removal'
        }
        submitLabel="Sign & record"
      />

      <AllocationDetailSheet
        allocation={detailAlloc}
        locationName={node.name}
        onClose={() => setDetailAlloc(null)}
      />

      <EditDialog
        open={showEdit}
        onOpenChange={setShowEdit}
        node={node}
        onDone={() => {
          setShowEdit(false);
          onChanged();
        }}
      />
      <MoveDialog
        open={showMove}
        onOpenChange={setShowMove}
        node={node}
        candidates={movableTo}
        onDone={() => {
          setShowMove(false);
          onChanged();
        }}
      />
      {isBox && (
        <ResizeDialog
          open={showResize}
          onOpenChange={setShowResize}
          node={node}
          onDone={() => {
            setShowResize(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

/** Sort key so contents list reads row-major (A1, A2, …). */
function cellSort(a: Allocation): number {
  if (a.grid_row == null || a.grid_col == null) return Number.MAX_SAFE_INTEGER;
  return a.grid_row * 1000 + a.grid_col;
}

// ── Stat cards ──────────────────────────────────────────────────────────

function Stat({ label, value, dot }: { label: string; value: string; dot?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-bg-elev px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-text-3">{label}</p>
      <p className="text-text-1 mt-1 font-mono text-2xl">
        {value}
        {dot && <span className="ml-1 align-middle text-accent">•</span>}
      </p>
    </div>
  );
}

function UtilStat({ pct }: { pct: number }) {
  return (
    <div className="rounded-lg border border-border bg-bg-elev px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-text-3">Utilization</p>
      <p className="text-text-1 mt-1 font-mono text-2xl">{pct}%</p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface">
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    </div>
  );
}

// ── Child card ──────────────────────────────────────────────────────────

function ChildCard({ child, onClick }: { child: NodeTree; onClick: () => void }) {
  const Icon = NODE_ICON[child.node_type];
  const s = subtreeStats(child);
  const pct = s.capacity > 0 ? Math.round((s.occupied / s.capacity) * 100) : 0;
  const subtitle =
    child.node_type === 'box'
      ? `${(child.grid_rows ?? 0) * (child.grid_cols ?? 0)} sub-slots`
      : `${child.children.length} ${childUnit(child.node_type, child.children.length)}`;

  return (
    <button
      type="button"
      onClick={onClick}
      className="hover:border-accent/50 hover:bg-surface/80 rounded-lg border border-border bg-surface p-3 text-left transition-colors"
    >
      <div className="mb-3 flex items-center gap-2">
        <span className="flex size-9 items-center justify-center rounded-md border border-border bg-bg-elev text-text-2">
          <Icon size={16} />
        </span>
        <span className="min-w-0">
          <span className="text-text-1 block truncate text-sm font-semibold">{child.name}</span>
          <span className="block truncate text-xs text-text-3">{subtitle}</span>
        </span>
      </div>
      <div className="flex items-center justify-between text-xs text-text-3">
        <span>{s.occupied} occupied</span>
        <span>{pct}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-elev">
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    </button>
  );
}

// ── Lot select ──────────────────────────────────────────────────────────

/** Searchable lot picker — filters by lot number or item number. */
function LotCombobox({
  lots,
  value,
  onChange,
}: {
  lots: Lot[];
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const selected = lots.find((l) => l.id === value) ?? null;

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return lots;
    return lots.filter((l) => `${l.lot_number} ${l.item_number ?? ''}`.toLowerCase().includes(q));
  }, [lots, query]);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 text-sm"
        >
          <span className={cn('truncate', !selected && 'text-text-3')}>
            {selected ? (
              <>
                <span className="font-mono text-xs">{selected.lot_number}</span>
                {selected.item_number && (
                  <span className="ml-2 text-text-3">{selected.item_number}</span>
                )}
              </>
            ) : (
              'Select lot'
            )}
          </span>
          <ChevronDown size={14} className="shrink-0 text-text-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-[18rem]"
      >
        <div className="border-b border-border p-2">
          <Input
            autoFocus
            icon={Search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search lots…"
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-text-3">No matches.</p>
          ) : (
            filtered.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => {
                  onChange(l.id);
                  setOpen(false);
                  setQuery('');
                }}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface',
                  l.id === value && 'bg-surface',
                )}
              >
                <span className="text-text-1 truncate font-mono text-xs">{l.lot_number}</span>
                {l.item_number && (
                  <span className="ml-2 shrink-0 text-text-3">{l.item_number}</span>
                )}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Shared unit-out types + helpers ──────────────────────────────────────

interface TransferOutPayload {
  allocationIds: string[];
  toNodeId: string;
  toCells: { grid_row: number; grid_col: number }[] | null;
  qty: number | null;
  count: number;
}
interface ConsumeOutPayload {
  allocationIds: string[];
  toNodeId: string;
  count: number;
}
/** Single-allocation partial consume (flat location, chosen qty). */
interface SingleConsumePayload {
  allocationId: string;
  toNodeId: string;
  qty: number;
}

/** ``"row:col"`` keys → cell objects for the transfer-batch payload. */
function cellsFromSet(set: Set<string>): { grid_row: number; grid_col: number }[] {
  return [...set].map((k) => {
    const [r, c] = k.split(':');
    return { grid_row: Number(r), grid_col: Number(c) };
  });
}

/** Slide-over with the full details of a placed allocation + its lot. */
function AllocationDetailSheet({
  allocation,
  locationName,
  onClose,
}: {
  allocation: Allocation | null;
  locationName: string;
  onClose: () => void;
}) {
  const [lot, setLot] = React.useState<Lot | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!allocation) return;
    setLot(null);
    setLoading(true);
    const ctrl = new AbortController();
    lotsApi
      .get(allocation.lot_id, { signal: ctrl.signal })
      .then(setLot)
      .catch(() => setLot(null))
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [allocation]);

  const cell =
    allocation?.grid_row != null && allocation?.grid_col != null
      ? `${rowLabel(allocation.grid_row)}${allocation.grid_col}`
      : null;

  return (
    <Sheet open={allocation != null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="sm:w-[440px]">
        {allocation && (
          <>
            <SheetHeader>
              <SheetTitle>{allocation.item_number ?? 'Item'}</SheetTitle>
              <SheetDescription>
                lot {allocation.lot_number ?? allocation.lot_id.slice(0, 8)}
              </SheetDescription>
            </SheetHeader>
            <SheetBody className="space-y-4">
              <section className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-text-3">
                  Placement
                </p>
                <DetailRow label="Location" value={locationName} />
                <DetailRow label="Cell" value={cell ?? '—'} />
                <DetailRow label="Quantity" value={`${allocation.qty}`} />
                <DetailRow label="Status" value={allocation.is_active ? 'Active' : 'Inactive'} />
                <DetailRow
                  label="Placed"
                  value={new Date(allocation.created_at).toISOString().slice(0, 10)}
                />
              </section>
              <section className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-text-3">Lot</p>
                {loading ? (
                  <p className="text-xs text-text-3">Loading…</p>
                ) : lot ? (
                  <>
                    <DetailRow
                      label="Lot number"
                      value={
                        // The full lot is already loaded here, so the owning
                        // order is known up front — link it directly rather
                        // than resolving on click like <LotLink> has to.
                        lot.receipt_transaction_id ? (
                          <Link
                            href={`/receiving/${lot.receipt_transaction_id}`}
                            className="text-accent underline-offset-2 hover:underline"
                            title="Open the receiving order for this lot"
                          >
                            {lot.lot_number}
                          </Link>
                        ) : (
                          lot.lot_number
                        )
                      }
                    />
                    <DetailRow
                      label="Item"
                      value={<ItemLink itemNumber={lot.item_number} itemId={lot.item_id} />}
                    />
                    <DetailRow label="Status" value={lot.status} />
                    <DetailRow label="Supplier" value={lot.supplier_name ?? '—'} />
                    <DetailRow label="PO reference" value={lot.po_reference ?? '—'} />
                    <DetailRow
                      label="Ordered qty"
                      value={lot.ordered_qty == null ? '—' : `${lot.ordered_qty}`}
                    />
                    <DetailRow label="Manufactured" value={lot.manufacture_date ?? '—'} />
                    <DetailRow label="Expires" value={lot.expiration_date ?? '—'} />
                  </>
                ) : (
                  <p className="text-xs text-text-3">Lot details unavailable.</p>
                )}
              </section>
            </SheetBody>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-text-3">{label}</span>
      <span className="text-text-1 text-right text-sm">{value}</span>
    </div>
  );
}

/** Remaining-to-place hint shown under a lot picker (unit-in cap preview). */
function RemainingHint({ avail, selecting }: { avail: LotAvailability | null; selecting: number }) {
  if (!avail) return null;
  if (avail.remaining == null) {
    return <p className="text-[11px] text-text-3">No ordered cap · {avail.placed} placed so far</p>;
  }
  const over = selecting > avail.remaining;
  return (
    <p className={cn('text-[11px]', over ? 'text-danger' : 'text-text-3')}>
      {avail.remaining} of {avail.ordered_qty} remaining to place
      {selecting > 0 && ` · placing ${selecting}`}
      {over && ' · exceeds remaining'}
    </p>
  );
}

/** A target box's grid, used to click destination cells for a transfer. */
function DestGridPicker({
  node,
  value,
  onChange,
  max,
}: {
  node: LocationNode;
  value: Set<string>;
  onChange: (s: Set<string>) => void;
  max: number;
}) {
  const [allocs, setAllocs] = React.useState<Allocation[]>([]);
  React.useEffect(() => {
    let cancelled = false;
    locationNodesApi
      .nodeAllocations(node.id)
      .then((a) => {
        if (!cancelled) setAllocs(a);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [node.id]);

  return (
    <div className="rounded-md border border-border bg-bg-elev p-2">
      <BoxGrid
        rows={node.grid_rows ?? 0}
        cols={node.grid_cols ?? 0}
        allocations={allocs}
        selectedCells={value}
        onSelectCell={(c) => {
          if (c.occupant) return;
          const key = `${c.row}:${c.col}`;
          const next = new Set(value);
          if (next.has(key)) {
            next.delete(key);
          } else {
            if (next.size >= max) {
              toast.error(`Select at most ${max} cell(s).`);
              return;
            }
            next.add(key);
          }
          onChange(next);
        }}
      />
    </div>
  );
}

// ── Allocation actions (single flat allocation: transfer / consume) ───────

function AllocationActions({
  allocation,
  trees,
  canWrite,
  consumeAtNodeId,
  onTransfer,
  onConsume,
}: {
  allocation: Allocation;
  trees: AreaTrees | null;
  canWrite: boolean;
  /** The location that consumes the unit — fixed to the current flat node. */
  consumeAtNodeId: string;
  onTransfer: (p: TransferOutPayload) => void;
  onConsume: (p: SingleConsumePayload) => void;
}) {
  const [mode, setMode] = React.useState<'none' | 'transfer' | 'consume'>('none');
  const [destNode, setDestNode] = React.useState<NodeTree | null>(null);
  const [qty, setQty] = React.useState('1');
  const [destCells, setDestCells] = React.useState<Set<string>>(new Set());

  const available = Number(allocation.qty) || 0;
  const destIsBox = destNode?.node_type === 'box';

  const reset = () => {
    setMode('none');
    setDestNode(null);
    setQty('1');
    setDestCells(new Set());
  };

  if (!canWrite) {
    return (
      <p className="text-xs text-text-3">
        {allocation.item_number ?? ''} · lot {allocation.lot_number ?? ''}
      </p>
    );
  }

  if (mode === 'none') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-text-3">
          {allocation.item_number ?? ''} · lot {allocation.lot_number ?? ''}
        </span>
        <div className="ml-auto flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setQty('1');
              setMode('transfer');
            }}
          >
            <ArrowRightLeft size={13} /> Transfer
          </Button>
        </div>
      </div>
    );
  }

  const submit = () => {
    if (mode === 'transfer') {
      if (!destNode) {
        toast.error('Pick a destination.');
        return;
      }
      if (destIsBox) {
        if (destCells.size === 0) {
          toast.error('Select destination cell(s) in the grid.');
          return;
        }
        if (destCells.size > available) {
          toast.error(`At most ${available} cell(s).`);
          return;
        }
        onTransfer({
          allocationIds: [allocation.id],
          toNodeId: destNode.id,
          toCells: cellsFromSet(destCells),
          qty: null,
          count: destCells.size,
        });
      } else {
        const k = Number(qty);
        if (!Number.isFinite(k) || k <= 0 || k > available) {
          toast.error(`Enter a quantity between 1 and ${available}.`);
          return;
        }
        onTransfer({
          allocationIds: [allocation.id],
          toNodeId: destNode.id,
          toCells: null,
          qty: k,
          count: k,
        });
      }
    } else {
      // Consume a chosen quantity, recorded at the current flat location.
      const k = Number(qty);
      if (!Number.isFinite(k) || k <= 0 || k > available) {
        toast.error(`Enter a quantity between 1 and ${available}.`);
        return;
      }
      onConsume({
        allocationId: allocation.id,
        toNodeId: consumeAtNodeId,
        qty: k,
      });
    }
  };

  return (
    <div className="space-y-2">
      {mode === 'transfer' && (
        <>
          <div className="space-y-1">
            <Label className="text-xs">Destination</Label>
            {trees ? (
              <LocationLeafPicker
                trees={trees}
                onChange={(leaf) => {
                  setDestNode(leaf);
                  setDestCells(new Set());
                }}
              />
            ) : (
              <p className="text-xs text-text-3">Loading locations…</p>
            )}
          </div>
          {destIsBox && destNode ? (
            <div className="space-y-1">
              <Label className="text-xs">
                Destination cells — click up to {available} ({destCells.size} chosen)
              </Label>
              <DestGridPicker
                node={destNode}
                value={destCells}
                onChange={setDestCells}
                max={available}
              />
            </div>
          ) : destNode ? (
            <div className="w-24 space-y-1">
              <Label className="text-xs">Qty (max {available})</Label>
              <Input
                type="number"
                min={1}
                max={available}
                step="1"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                className="font-mono"
              />
            </div>
          ) : null}
        </>
      )}

      {mode === 'consume' && (
        <div className="space-y-1">
          <Label className="text-xs">Units to consume (max {available})</Label>
          <Input
            type="number"
            min={1}
            max={available}
            step="1"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className="w-24 font-mono"
          />
          <p className="text-[11px] text-text-3">
            Used up here (out of inventory) at this location.
          </p>
        </div>
      )}

      <div className="flex gap-2">
        <Button size="sm" variant="primary" onClick={submit}>
          <ShieldCheck size={13} /> {mode === 'transfer' ? 'Sign & move' : 'Sign & remove'}
        </Button>
        <Button size="sm" variant="ghost" onClick={reset}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ── Batch unit-out panel (box multi-select: transfer / consume) ───────────

function BatchOutPanel({
  selected,
  targets,
  trees,
  busy,
  onTransfer,
  onConsume,
  onClear,
}: {
  selected: Allocation[];
  /** Flat locations for the (currently unreachable) consume flow. */
  targets: LocationNode[];
  trees: AreaTrees | null;
  busy: boolean;
  onTransfer: (p: TransferOutPayload) => void;
  onConsume: (p: ConsumeOutPayload) => void;
  onClear: () => void;
}) {
  const count = selected.length;
  const ids = selected.map((a) => a.id);
  const lotLabel = selected[0]?.lot_number ?? selected[0]?.lot_id.slice(0, 8) ?? '';

  const [mode, setMode] = React.useState<'none' | 'transfer' | 'consume'>('none');
  // Transfer destination (cascade leaf); ``consumeNode`` is the flat location id
  // for the consume flow.
  const [destNode, setDestNode] = React.useState<NodeTree | null>(null);
  const [consumeNode, setConsumeNode] = React.useState('');
  const [destCells, setDestCells] = React.useState<Set<string>>(new Set());

  const destIsBox = destNode?.node_type === 'box';
  const flatTargets = targets.filter((t) => t.node_type === 'flat');

  const reset = () => {
    setMode('none');
    setDestNode(null);
    setConsumeNode('');
    setDestCells(new Set());
  };

  const submit = () => {
    if (mode === 'transfer') {
      if (!destNode) {
        toast.error('Pick a destination.');
        return;
      }
      if (destIsBox) {
        if (destCells.size !== count) {
          toast.error(`Select exactly ${count} destination cell(s).`);
          return;
        }
        onTransfer({
          allocationIds: ids,
          toNodeId: destNode.id,
          toCells: cellsFromSet(destCells),
          qty: null,
          count,
        });
      } else {
        onTransfer({
          allocationIds: ids,
          toNodeId: destNode.id,
          toCells: null,
          qty: count,
          count,
        });
      }
    } else {
      if (!consumeNode) {
        toast.error('Pick the Flat location that consumed it.');
        return;
      }
      onConsume({ allocationIds: ids, toNodeId: consumeNode, count });
    }
  };

  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-text-2">
          {count} {count === 1 ? 'unit' : 'units'} of lot{' '}
          <span className="font-mono text-accent">{lotLabel}</span> selected
        </p>
        <button type="button" className="text-xs text-text-3 hover:text-accent" onClick={onClear}>
          Clear
        </button>
      </div>

      {mode === 'none' ? (
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setMode('transfer')}>
            <ArrowRightLeft size={13} /> Transfer
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {mode === 'transfer' && (
            <>
              <div className="space-y-1">
                <Label className="text-xs">Destination</Label>
                {trees ? (
                  <LocationLeafPicker
                    trees={trees}
                    onChange={(leaf) => {
                      setDestNode(leaf);
                      setDestCells(new Set());
                    }}
                  />
                ) : (
                  <p className="text-xs text-text-3">Loading locations…</p>
                )}
              </div>
              {destIsBox && destNode ? (
                <div className="space-y-1">
                  <Label className="text-xs">
                    Destination cells — pick exactly {count} ({destCells.size} chosen)
                  </Label>
                  <DestGridPicker
                    node={destNode}
                    value={destCells}
                    onChange={setDestCells}
                    max={count}
                  />
                </div>
              ) : destNode ? (
                <p className="text-xs text-text-3">
                  {count} unit(s) will move to {destNode.name}.
                </p>
              ) : null}
            </>
          )}

          {mode === 'consume' && (
            <div className="space-y-1">
              <Label className="text-xs">Consumed at (Flat location)</Label>
              <Select value={consumeNode} onValueChange={setConsumeNode}>
                <SelectTrigger>
                  <SelectValue placeholder="Lab / Kanban / Materials" />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {flatTargets.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex gap-2">
            <Button size="sm" variant="primary" disabled={busy} onClick={submit}>
              <ShieldCheck size={13} />{' '}
              {mode === 'transfer' ? `Sign & move ${count}` : `Sign & remove ${count}`}
            </Button>
            <Button size="sm" variant="ghost" onClick={reset}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Re-hang a node under a different parent (dialog) ─────────────────────

/**
 * Move a node — and everything inside it — to a new parent (LOC-004).
 *
 * Only the parent changes. Nothing inside is re-placed and no stock moves: a
 * lot allocation points at its box's id, never at a path, so every address
 * beneath recomputes on its own. That is the "cascade" part.
 */
function MoveDialog({
  open,
  onOpenChange,
  node,
  candidates,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  node: NodeTree;
  /** Nodes that may legally become the parent — right type, not inside this one. */
  candidates: NodeTree[];
  onDone: () => void;
}) {
  const [target, setTarget] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) setTarget('');
  }, [open]);

  const inside = subtreeStats(node).occupied;

  const save = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await locationNodesApi.move(node.id, target);
      toast.success(`${node.name} moved`);
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to move.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Move {node.name}</DialogTitle>
          <DialogDescription>
            Everything inside comes along
            {inside > 0 ? ` — including ${inside} stored unit${inside === 1 ? '' : 's'}` : ''}.
            Past ledger entries keep the address they were recorded with.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">New parent</Label>
            <SearchableSelect
              value={target}
              onChange={setTarget}
              placeholder="Choose where it should hang…"
              aria-label="New parent"
              // Lives inside a Dialog, so the popover must own its scroll-lock.
              modal
              options={candidates.map((c) => ({
                value: c.id,
                label: `${c.name} · ${NODE_TYPE_LABEL[c.node_type]}`,
                searchText: `${c.name} ${c.code}`,
              }))}
            />
            {candidates.length === 0 && (
              <p className="text-xs text-text-3">
                Nowhere to move this — no other {NODE_TYPE_LABEL[node.node_type].toLowerCase()}{' '}
                parent exists yet.
              </p>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={save} disabled={busy || !target}>
            {busy ? 'Moving…' : 'Move'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Resize a box's grid (dialog) ─────────────────────────────────────────

function ResizeDialog({
  open,
  onOpenChange,
  node,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  node: NodeTree;
  onDone: () => void;
}) {
  const [rows, setRows] = React.useState(String(node.grid_rows ?? 1));
  // Columns are freely editable: the single-column lock belonged to a box under
  // a cassette, and the cassette level is retired (client 2026-07-29). A box now
  // hangs off a rack and carries whatever grid it is given.
  const [cols, setCols] = React.useState(String(node.grid_cols ?? 1));
  const [busy, setBusy] = React.useState(false);

  // Reset the inputs whenever the dialog (re)opens for a node.
  React.useEffect(() => {
    if (open) {
      setRows(String(node.grid_rows ?? 1));
      setCols(String(node.grid_cols ?? 1));
    }
  }, [open, node.grid_rows, node.grid_cols]);

  const save = async () => {
    const r = Number(rows);
    const c = Number(cols);
    if (!Number.isInteger(r) || r < 1 || !Number.isInteger(c) || c < 1) {
      toast.error('Rows and columns must be whole numbers ≥ 1.');
      return;
    }
    setBusy(true);
    try {
      await locationNodesApi.updateGrid(node.id, { grid_rows: r, grid_cols: c });
      toast.success('Grid resized');
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to resize.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Resize {node.name}</DialogTitle>
          <DialogDescription>
            The grid can&apos;t shrink below its highest occupied cell.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex items-end gap-2">
            <div className="w-24 space-y-1">
              <Label className="text-xs">Rows</Label>
              <Input
                type="number"
                min={1}
                step="1"
                value={rows}
                onChange={(e) => setRows(e.target.value)}
                className="font-mono"
              />
            </div>
            <span className="pb-2 text-text-3">×</span>
            <div className="w-24 space-y-1">
              <Label className="text-xs">Cols</Label>
              <Input
                type="number"
                min={1}
                step="1"
                value={cols}
                onChange={(e) => setCols(e.target.value)}
                className="font-mono"
              />
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={save} disabled={busy}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Node editor dialog (rename any node; dedicate quadrants) ──────────────

function EditDialog({
  open,
  onOpenChange,
  node,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  node: NodeTree;
  onDone: () => void;
}) {
  const isQuadrant = node.node_type === 'tank_quadrant';
  const [name, setName] = React.useState(node.name);
  const [kind, setKind] = React.useState<'none' | 'customer' | 'product'>(
    node.dedicated_customer_id ? 'customer' : node.dedicated_product_id ? 'product' : 'none',
  );
  const [target, setTarget] = React.useState(
    node.dedicated_customer_id ?? node.dedicated_product_id ?? '',
  );
  const [customers, setCustomers] = React.useState<{ id: string; name: string }[]>([]);
  const [products, setProducts] = React.useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = React.useState(false);

  // Reset the form to the node's current values each time the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    setName(node.name);
    setKind(
      node.dedicated_customer_id ? 'customer' : node.dedicated_product_id ? 'product' : 'none',
    );
    setTarget(node.dedicated_customer_id ?? node.dedicated_product_id ?? '');
  }, [open, node.name, node.dedicated_customer_id, node.dedicated_product_id]);

  React.useEffect(() => {
    if (!open || !isQuadrant) return;
    const ctrl = new AbortController();
    Promise.all([
      customersApi.list({}, { signal: ctrl.signal }).catch(() => []),
      itemsApi
        .list({ limit: 200 }, { signal: ctrl.signal })
        .then((resp) =>
          resp.items
            .filter((i) => isBuiltTier(i.tier_type))
            .map((i) => ({ id: i.id, name: `${i.item_number} · ${i.description}` })),
        )
        .catch(() => []),
    ]).then(([cs, ps]) => {
      setCustomers(cs);
      setProducts(ps);
    });
    return () => ctrl.abort();
  }, [open, isQuadrant]);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error('Name is required.');
      return;
    }
    if (isQuadrant && kind !== 'none' && !target) {
      toast.error(`Pick a ${kind}.`);
      return;
    }
    setBusy(true);
    try {
      if (trimmed !== node.name) {
        await locationNodesApi.rename(node.id, trimmed);
      }
      if (isQuadrant) {
        await locationNodesApi.updateDedication(node.id, {
          dedicated_customer_id: kind === 'customer' ? target : null,
          dedicated_product_id: kind === 'product' ? target : null,
        });
      }
      toast.success('Saved');
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit {NODE_TYPE_LABEL[node.node_type]}</DialogTitle>
          <DialogDescription>
            Rename this node{isQuadrant ? ' and set its dedication.' : '.'}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">
              Name <span className="text-danger">*</span>
            </Label>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          {isQuadrant && (
            <div className="space-y-2">
              <p className="flex items-center gap-1.5 text-sm font-medium text-text-2">
                <Tag size={15} /> Quadrant dedication
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <div className="w-40 space-y-1">
                  <Label className="text-xs">Type</Label>
                  <Select
                    value={kind}
                    onValueChange={(v) => {
                      setKind(v as 'none' | 'customer' | 'product');
                      setTarget('');
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Not dedicated</SelectItem>
                      <SelectItem value="customer">Customer</SelectItem>
                      <SelectItem value="product">Product</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {kind !== 'none' && (
                  <div className="w-56 space-y-1">
                    <Label className="text-xs">
                      {kind === 'customer' ? 'Customer' : 'Product'}
                    </Label>
                    <Select value={target} onValueChange={setTarget}>
                      <SelectTrigger>
                        <SelectValue placeholder={`Select ${kind}`} />
                      </SelectTrigger>
                      <SelectContent className="max-h-72">
                        {(kind === 'customer' ? customers : products).map((o) => (
                          <SelectItem key={o.id} value={o.id}>
                            {o.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
              <p className="text-xs text-text-3">
                Advisory only — descendants inherit it; placement is never blocked.
              </p>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={save} disabled={busy}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
