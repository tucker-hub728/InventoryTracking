'use client';

import * as React from 'react';
import {
  ArrowRightLeft,
  Box,
  Boxes,
  ChevronRight,
  Container,
  Maximize2,
  Minus,
  Package,
  Plus,
  Server,
  ShieldCheck,
  Tag,
  Trash2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { PasswordReauthDialog } from '@/components/shared/password-reauth-dialog';
import { ApiError } from '@/lib/api/client';
import { lotsApi, type Lot } from '@/lib/api/lots';
import { customersApi } from '@/lib/api/customers';
import { productsApi } from '@/lib/api/products';
import type { ReauthResponse } from '@/lib/api/auth';
import { cn } from '@/lib/utils';
import {
  locationNodesApi,
  subtreeStats,
  CHILD_TYPES_OF,
  NODE_TYPE_LABEL,
  type Allocation,
  type LocationNode,
  type NodeMovement,
  type NodeTree,
  type NodeType,
} from '@/lib/api/location-nodes';

import { BoxGrid, rowLabel } from './box-grid';

export const NODE_ICON: Record<NodeType, LucideIcon> = {
  tank_quadrant: Boxes,
  rack: Server,
  cassette: Container,
  cryo_box_rack: Boxes,
  box: Box,
  flat: Package,
  cassette_rack: Container,
  sub_slot: Box,
};

/** Plural noun for a node's children, used in the "N boxes" header. */
function childUnit(nodeType: NodeType, n: number): string {
  const label =
    nodeType === 'tank_quadrant'
      ? 'rack'
      : nodeType === 'rack'
        ? 'container'
        : 'box';
  return `${label}${n === 1 ? '' : 's'}`;
}

type Pending =
  | { kind: 'place'; lotId: string; nodeId: string; gridRow: number | null; gridCol: number | null; qty: number; notes: string }
  | { kind: 'transfer'; allocation: Allocation; toNodeId: string; toRow: number | null; toCol: number | null; notes: string }
  | { kind: 'consume'; allocation: Allocation; toNodeId: string; notes: string }
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
  onRemoved,
  onChanged,
}: Props) {
  const Icon = NODE_ICON[node.node_type];
  const isBox = node.node_type === 'box';
  const isFlat = node.node_type === 'flat';
  const isQuadrant = node.node_type === 'tank_quadrant';
  const isContainerWithKids = !isBox && !isFlat;
  const stats = subtreeStats(node);
  const gridRows = node.grid_rows ?? 0;
  const gridCols = node.grid_cols ?? 0;
  const childType = CHILD_TYPES_OF[node.node_type];

  const [allocations, setAllocations] = React.useState<Allocation[]>([]);
  const [lots, setLots] = React.useState<Lot[]>([]);
  const [targets, setTargets] = React.useState<LocationNode[]>([]);
  const [consumedHere, setConsumedHere] = React.useState<NodeMovement[]>([]);
  const [dedName, setDedName] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const [cell, setCell] = React.useState<{ row: number; col: number; occupant: Allocation | null } | null>(null);
  const [placeLot, setPlaceLot] = React.useState('');
  const [placeQty, setPlaceQty] = React.useState(isBox ? '1' : '');
  const [placeNotes, setPlaceNotes] = React.useState('');
  const [showResize, setShowResize] = React.useState(false);
  const [showDedicate, setShowDedicate] = React.useState(false);

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
        lotsApi.list({ limit: 500 }),
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
          mv.filter(
            (m) =>
              m.movement_type === 'dispense' && m.to_location_node_id === node.id,
          ),
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

  React.useEffect(() => {
    setCell(null);
    setPlaceLot('');
    setPlaceQty(isBox ? '1' : '');
    setPlaceNotes('');
    setShowResize(false);
    setShowDedicate(false);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

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
        else if (prodId) setDedName((await productsApi.get(prodId, { signal: ctrl.signal })).name);
      } catch {
        setDedName(null);
      }
    })();
    return () => ctrl.abort();
  }, [node.dedicated_customer_id, node.dedicated_product_id, node.inherited_customer_id, node.inherited_product_id]);

  const remove = async () => {
    setBusy(true);
    try {
      await locationNodesApi.remove(node.id);
      toast.success('Removed');
      onRemoved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to remove.');
    } finally {
      setBusy(false);
    }
  };

  // Place = unit-IN: e-signed (action movement.receipt) + required comment.
  const openPlaceSign = (opts?: { row?: number; col?: number }) => {
    if (!placeLot) return;
    const qty = isBox ? 1 : Number(placeQty);
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error('Enter a quantity greater than 0');
      return;
    }
    if (!placeNotes.trim()) {
      toast.error('A comment is required.');
      return;
    }
    setPending({
      kind: 'place',
      lotId: placeLot,
      nodeId: node.id,
      gridRow: opts?.row ?? null,
      gridCol: opts?.col ?? null,
      qty,
      notes: placeNotes.trim(),
    });
    setShowReauth(true);
  };

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
          notes: pending.notes,
        });
        toast.success('Placed');
        setPlaceLot('');
        setPlaceNotes('');
      } else if (pending.kind === 'transfer') {
        await locationNodesApi.transfer({
          allocation_id: pending.allocation.id,
          to_node_id: pending.toNodeId,
          qty: Number(pending.allocation.qty) || 1,
          to_grid_row: pending.toRow,
          to_grid_col: pending.toCol,
          evidence_id: evidence.evidence_id,
          notes: pending.notes,
        });
        toast.success('Transferred');
      } else {
        await locationNodesApi.consume({
          allocation_id: pending.allocation.id,
          to_node_id: pending.toNodeId,
          qty: Number(pending.allocation.qty),
          evidence_id: evidence.evidence_id,
          notes: pending.notes,
        });
        toast.success('Consumed');
      }
      setPending(null);
      setCell(null);
      await reload();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Operation failed.');
    } finally {
      setBusy(false);
    }
  };

  const reauthAction =
    pending?.kind === 'transfer'
      ? 'movement.transfer'
      : pending?.kind === 'place'
        ? 'movement.receipt'
        : 'movement.dispense';
  const attestation =
    pending?.kind === 'place'
      ? `I attest this placement (unit-in) of ${pending.qty} unit(s) is accurate.`
      : pending?.kind === 'transfer'
        ? `I attest this transfer of lot ${pending.allocation.lot_number ?? ''} is accurate.`
        : pending?.kind === 'consume'
          ? `I attest this consumption (unit-out) of lot ${pending.allocation.lot_number ?? ''} is accurate.`
          : '';

  const utilisation = stats.capacity > 0 ? Math.round((stats.occupied / stats.capacity) * 100) : 0;

  return (
    <div className="min-w-0 flex-1 px-6 py-5 sm:px-8">
      {/* Breadcrumb */}
      <nav className="mb-3 flex flex-wrap items-center gap-1 text-xs text-text-3">
        {path.map((p, i) => (
          <React.Fragment key={p.id}>
            {i > 0 && <ChevronRight size={12} className="opacity-60" />}
            <span className={cn(i === path.length - 1 && 'font-medium text-text-2')}>
              {p.name}
            </span>
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
              <h2 className="text-xl font-semibold text-text-1">{node.name}</h2>
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
            {isBox && (
              <Button size="sm" variant="ghost" onClick={() => setShowResize((v) => !v)}>
                <Maximize2 size={14} /> Resize
              </Button>
            )}
            {isQuadrant && (
              <Button size="sm" variant="ghost" onClick={() => setShowDedicate((v) => !v)}>
                <Tag size={14} /> Edit / dedicate
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={remove} disabled={busy}>
              <Trash2 size={14} /> Remove
            </Button>
          </div>
        )}
      </div>

      {/* Stat cards */}
      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {isFlat ? (
          <Stat label="Occupied" value={`${stats.occupied}`} />
        ) : (
          <>
            <Stat label={isBox ? 'Sub-slots' : 'Capacity'} value={`${stats.capacity}`} />
            <Stat label="Occupied" value={`${stats.occupied}`} dot />
            <UtilStat pct={utilisation} />
          </>
        )}
      </div>

      {/* Inline resize / dedication editors */}
      {isBox && showResize && (
        <ResizeControl
          node={node}
          onDone={() => {
            setShowResize(false);
            onChanged();
          }}
        />
      )}
      {isQuadrant && showDedicate && (
        <DedicationControl
          node={node}
          onDone={() => {
            setShowDedicate(false);
            onChanged();
          }}
        />
      )}

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
                {childType.length === 1
                  ? `Add ${childUnit(node.node_type, 1)}`
                  : 'Add container'}
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

      {/* ── Box: vial map + contents ─────────────────────────────────── */}
      {isBox && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-border bg-bg-elev p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium text-text-2">
                Vial map · {gridRows}×{gridCols}
              </p>
              <span className="text-xs text-text-3">Click a position to place or move</span>
            </div>
            <BoxGrid
              rows={gridRows}
              cols={gridCols}
              allocations={allocations}
              selected={cell ? { row: cell.row, col: cell.col } : null}
              onSelectCell={(c) => {
                setCell(c);
                setPlaceLot('');
              }}
            />
            {/* Selected-cell action area */}
            {cell && (
              <div className="mt-3 rounded-md border border-border bg-surface p-3">
                <p className="mb-2 text-xs font-medium text-text-2">
                  Cell {rowLabel(cell.row)}
                  {cell.col}
                </p>
                {cell.occupant ? (
                  <AllocationActions
                    allocation={cell.occupant}
                    targets={targets}
                    canWrite={canWrite}
                    onTransfer={(p) => {
                      setPending({ kind: 'transfer', ...p });
                      setShowReauth(true);
                    }}
                    onConsume={(p) => {
                      setPending({ kind: 'consume', ...p });
                      setShowReauth(true);
                    }}
                  />
                ) : canWrite ? (
                  <div className="space-y-2">
                    <div className="space-y-1">
                      <Label className="text-xs">Lot (one vial)</Label>
                      <LotSelect lots={lots} value={placeLot} onChange={setPlaceLot} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">
                        Comment <span className="text-danger">*</span>
                      </Label>
                      <Input
                        placeholder="Reason for this placement"
                        value={placeNotes}
                        onChange={(e) => setPlaceNotes(e.target.value)}
                      />
                    </div>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy || !placeLot}
                      onClick={() => openPlaceSign({ row: cell.row, col: cell.col })}
                    >
                      <ShieldCheck size={13} /> Sign &amp; place
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-text-3">Empty cell.</p>
                )}
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
                        onClick={() =>
                          a.grid_row != null && a.grid_col != null
                            ? setCell({ row: a.grid_row, col: a.grid_col, occupant: a })
                            : undefined
                        }
                      >
                        <span className="w-8 shrink-0 font-mono text-xs text-text-3">
                          {a.grid_row != null && a.grid_col != null
                            ? `${rowLabel(a.grid_row)}${a.grid_col}`
                            : '—'}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-text-1">
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

      {/* ── Flat: place + contents ───────────────────────────────────── */}
      {isFlat && (
        <div className="space-y-4">
          {canWrite && (
            <div className="rounded-lg border border-border bg-bg-elev p-4">
              <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-text-2">
                <Package size={15} /> Place a lot here (unit-in)
              </p>
              <div className="space-y-2">
                <div className="flex items-end gap-2">
                  <div className="flex-1 space-y-1">
                    <Label className="text-xs">Lot</Label>
                    <LotSelect lots={lots} value={placeLot} onChange={setPlaceLot} />
                  </div>
                  <div className="w-24 space-y-1">
                    <Label className="text-xs">Qty</Label>
                    <Input
                      type="number"
                      min={0}
                      step="1"
                      value={placeQty}
                      onChange={(e) => setPlaceQty(e.target.value)}
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">
                    Comment <span className="text-danger">*</span>
                  </Label>
                  <Input
                    placeholder="Reason for this placement"
                    value={placeNotes}
                    onChange={(e) => setPlaceNotes(e.target.value)}
                  />
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => openPlaceSign()}
                  disabled={busy || !placeLot}
                >
                  <ShieldCheck size={13} /> Sign &amp; place
                </Button>
              </div>
            </div>
          )}
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
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <span className="text-sm text-text-1">{a.item_number ?? '—'}</span>
                        <span className="ml-2 font-mono text-xs text-accent">
                          {a.lot_number ?? a.lot_id.slice(0, 8)}
                        </span>
                        <span className="ml-2 font-mono text-xs text-text-3">qty {a.qty}</span>
                      </div>
                    </div>
                    <AllocationActions
                      allocation={a}
                      targets={targets}
                      canWrite={canWrite}
                      onTransfer={(p) => {
                        setPending({ kind: 'transfer', ...p });
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
                  Consumed here{' '}
                  <span className="text-text-3">· {consumedHere.length}</span>
                </p>
                <p className="text-xs text-text-3">
                  Units used up at this location (out of inventory).
                </p>
              </div>
              <ul className="divide-y divide-border">
                {consumedHere.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-center gap-3 px-4 py-2.5 text-sm"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-text-1">
                        {m.item_number ?? '—'}
                      </span>
                      <span className="block truncate text-xs text-text-3">
                        {m.lot_number ?? '—'} ·{' '}
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
        signatureRequired={false}
        onConfirmed={(evidence) => {
          setShowReauth(false);
          void runSigned(evidence);
        }}
        title={
          pending?.kind === 'transfer'
            ? 'Sign this transfer'
            : pending?.kind === 'place'
              ? 'Sign this placement'
              : 'Sign this removal'
        }
        submitLabel="Sign & record"
      />
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
      <p className="mt-1 font-mono text-2xl text-text-1">
        {value}
        {dot && <span className="ml-1 align-middle text-accent">•</span>}
      </p>
    </div>
  );
}

function UtilStat({ pct }: { pct: number }) {
  return (
    <div className="rounded-lg border border-border bg-bg-elev px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-text-3">Utilisation</p>
      <p className="mt-1 font-mono text-2xl text-text-1">{pct}%</p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface">
        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(pct, 100)}%` }} />
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
      className="rounded-lg border border-border bg-surface p-3 text-left transition-colors hover:border-accent/50 hover:bg-surface/80"
    >
      <div className="mb-3 flex items-center gap-2">
        <span className="flex size-9 items-center justify-center rounded-md border border-border bg-bg-elev text-text-2">
          <Icon size={16} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-text-1">{child.name}</span>
          <span className="block truncate text-xs text-text-3">{subtitle}</span>
        </span>
      </div>
      <div className="flex items-center justify-between text-xs text-text-3">
        <span>{s.occupied} occupied</span>
        <span>{pct}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-elev">
        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </button>
  );
}

// ── Lot select ──────────────────────────────────────────────────────────

function LotSelect({
  lots,
  value,
  onChange,
}: {
  lots: Lot[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue placeholder="Select lot" />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {lots.map((l) => (
          <SelectItem key={l.id} value={l.id}>
            <span className="font-mono text-xs">{l.lot_number}</span>
            {l.item_number && <span className="ml-2 text-text-3">{l.item_number}</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ── Allocation actions (transfer / consume) ─────────────────────────────

function AllocationActions({
  allocation,
  targets,
  canWrite,
  onTransfer,
  onConsume,
}: {
  allocation: Allocation;
  targets: LocationNode[];
  canWrite: boolean;
  onTransfer: (p: {
    allocation: Allocation;
    toNodeId: string;
    toRow: number | null;
    toCol: number | null;
    notes: string;
  }) => void;
  onConsume: (p: { allocation: Allocation; toNodeId: string; notes: string }) => void;
}) {
  const [mode, setMode] = React.useState<'none' | 'transfer' | 'consume'>('none');
  const [toNode, setToNode] = React.useState('');
  const [toRow, setToRow] = React.useState('');
  const [toCol, setToCol] = React.useState('');
  const [notes, setNotes] = React.useState('');

  const destNode = targets.find((t) => t.id === toNode) ?? null;
  const destIsBox = destNode?.node_type === 'box';
  // Consume records the Flat location that used the unit.
  const flatTargets = targets.filter((t) => t.node_type === 'flat');

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
          <Button size="sm" variant="ghost" onClick={() => setMode('transfer')}>
            <ArrowRightLeft size={13} /> Transfer
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode('consume')}>
            <Minus size={13} /> Consume
          </Button>
        </div>
      </div>
    );
  }

  const submit = () => {
    if (!notes.trim()) {
      toast.error('A comment is required.');
      return;
    }
    if (mode === 'transfer') {
      if (!toNode) {
        toast.error('Pick a destination.');
        return;
      }
      if (destIsBox && (!toRow || !toCol)) {
        toast.error('Pick a destination cell (row & column).');
        return;
      }
      onTransfer({
        allocation,
        toNodeId: toNode,
        toRow: destIsBox ? Number(toRow) : null,
        toCol: destIsBox ? Number(toCol) : null,
        notes: notes.trim(),
      });
    } else {
      if (!toNode) {
        toast.error('Pick the Flat location that consumed it.');
        return;
      }
      onConsume({ allocation, toNodeId: toNode, notes: notes.trim() });
    }
  };

  return (
    <div className="space-y-2">
      {mode === 'transfer' && (
        <>
          <div className="space-y-1">
            <Label className="text-xs">Destination</Label>
            <Select value={toNode} onValueChange={setToNode}>
              <SelectTrigger>
                <SelectValue placeholder="Storage target" />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {targets.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    <span>{t.name}</span>
                    <span className="ml-2 text-text-3">{NODE_TYPE_LABEL[t.node_type]}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {destIsBox && (
            <div className="flex items-end gap-2">
              <div className="w-20 space-y-1">
                <Label className="text-xs">Row</Label>
                <Input type="number" min={1} step="1" value={toRow} onChange={(e) => setToRow(e.target.value)} className="font-mono" />
              </div>
              <div className="w-20 space-y-1">
                <Label className="text-xs">Col</Label>
                <Input type="number" min={1} step="1" value={toCol} onChange={(e) => setToCol(e.target.value)} className="font-mono" />
              </div>
            </div>
          )}
        </>
      )}

      {mode === 'consume' && (
        <div className="space-y-1">
          <Label className="text-xs">Consumed at (Flat location)</Label>
          <Select value={toNode} onValueChange={setToNode}>
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

      <div className="space-y-1">
        <Label className="text-xs">
          Comment <span className="text-danger">*</span>
        </Label>
        <Input placeholder="Reason for this action" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      <div className="flex gap-2">
        <Button size="sm" variant="primary" onClick={submit}>
          <ShieldCheck size={13} /> {mode === 'transfer' ? 'Sign & move' : 'Sign & remove'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setMode('none')}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ── Resize a box's grid ─────────────────────────────────────────────────

function ResizeControl({ node, onDone }: { node: NodeTree; onDone: () => void }) {
  const [rows, setRows] = React.useState(String(node.grid_rows ?? 1));
  const [cols, setCols] = React.useState(String(node.grid_cols ?? 1));
  const [busy, setBusy] = React.useState(false);

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
    <div className="mb-5 flex items-end gap-2 rounded-lg border border-border bg-bg-elev p-4">
      <div className="w-24 space-y-1">
        <Label className="text-xs">Rows</Label>
        <Input type="number" min={1} step="1" value={rows} onChange={(e) => setRows(e.target.value)} className="font-mono" />
      </div>
      <div className="w-24 space-y-1">
        <Label className="text-xs">Cols</Label>
        <Input type="number" min={1} step="1" value={cols} onChange={(e) => setCols(e.target.value)} className="font-mono" />
      </div>
      <Button size="sm" variant="primary" onClick={save} disabled={busy}>
        Save
      </Button>
    </div>
  );
}

// ── Quadrant dedication editor ──────────────────────────────────────────

function DedicationControl({ node, onDone }: { node: NodeTree; onDone: () => void }) {
  const [kind, setKind] = React.useState<'none' | 'customer' | 'product'>(
    node.dedicated_customer_id ? 'customer' : node.dedicated_product_id ? 'product' : 'none',
  );
  const [target, setTarget] = React.useState(
    node.dedicated_customer_id ?? node.dedicated_product_id ?? '',
  );
  const [customers, setCustomers] = React.useState<{ id: string; name: string }[]>([]);
  const [products, setProducts] = React.useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    const ctrl = new AbortController();
    Promise.all([
      customersApi.list({}, { signal: ctrl.signal }).catch(() => []),
      productsApi.list({}, { signal: ctrl.signal }).catch(() => []),
    ]).then(([cs, ps]) => {
      setCustomers(cs);
      setProducts(ps);
    });
    return () => ctrl.abort();
  }, []);

  const save = async () => {
    if (kind !== 'none' && !target) {
      toast.error(`Pick a ${kind}.`);
      return;
    }
    setBusy(true);
    try {
      await locationNodesApi.updateDedication(node.id, {
        dedicated_customer_id: kind === 'customer' ? target : null,
        dedicated_product_id: kind === 'product' ? target : null,
      });
      toast.success('Dedication updated');
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to update dedication.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-5 space-y-2 rounded-lg border border-border bg-bg-elev p-4">
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
            <Label className="text-xs">{kind === 'customer' ? 'Customer' : 'Product'}</Label>
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
        <Button size="sm" variant="primary" onClick={save} disabled={busy}>
          Save
        </Button>
      </div>
      <p className="text-xs text-text-3">
        Advisory only — descendants inherit it; placement is never blocked.
      </p>
    </div>
  );
}
