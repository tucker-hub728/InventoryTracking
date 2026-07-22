'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronLeft,
  FlaskConical,
  PackagePlus,
  PackageSearch,
  Pencil,
  Plus,
  Save,
  ScrollText,
  Send,
  Undo2,
  XCircle,
  type LucideIcon,
} from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { toast } from '@/components/ui/sonner';
import { PasswordReauthDialog } from '@/components/shared/password-reauth-dialog';
import { usePermission } from '@/hooks/use-permission';
import type { ReauthResponse } from '@/lib/api/auth';
import { ApiError } from '@/lib/api/client';
import {
  kitsApi,
  type ApiKit,
  type ApiKitActivityRow,
  type ApiKitAuditEvent,
  type ApiKitLine,
  type CancelLineInput,
  type KitStatus,
  type KitUpdateInput,
  type ReturnCellInput,
} from '@/lib/api/kits';
import { locationNodesApi, type LocationNode } from '@/lib/api/location-nodes';
import { cn } from '@/lib/utils';

import { BoxCellPicker, CellGridPicker, useBoxGrid } from './cell-grid-picker';
import { LocationTreePicker } from './location-tree-picker';
import {
  ItemCell,
  KitStatusBadge,
  NumberInput,
  QtyCell,
  RuleNote,
  Stat,
  formatDateTime,
  type SelectOption,
} from './recon-bits';

const STEPS = [
  { key: 'issue', label: 'Issue', hint: 'Pull material to production' },
  { key: 'production', label: 'Production', hint: 'Record what was built' },
  { key: 'closeout', label: 'Close-Out', hint: 'Reconcile & back-flush' },
] as const;

function stepModel(status: KitStatus): { completed: number; reachable: number; def: number } {
  switch (status) {
    case 'draft':
      return { completed: 0, reachable: 0, def: 0 };
    case 'issued':
      return { completed: 1, reachable: 1, def: 1 };
    case 'in_production':
      return { completed: 1, reachable: 2, def: 1 };
    case 'closed':
      return { completed: 3, reachable: 2, def: 2 };
    case 'cancelled':
      return { completed: 0, reachable: 0, def: 0 };
    default:
      return { completed: 0, reachable: 0, def: 0 };
  }
}

const lineIssuedTotal = (l: ApiKitLine) => l.issued_qty + l.additional_issued_qty;

interface OutputDraft {
  good_qty: number | null;
  scrap_qty: number | null;
  output_location_node_id: string;
  /** Expiry of the produced lot — REQ-2026-07-01-INV-008. */
  output_expiration_date: string;
}

/** Draft edits for the Issue step — held locally and committed only when the
 *  Issue button is pressed (nothing is saved while the user types). */
interface LineDraft {
  issued_qty: number;
  source: string;
  /** LN2 only: allocation ids of the chosen cells. Drives issued_qty. */
  cells: string[];
}

const sourceOption = (line: ApiKitLine, source: string) =>
  line.source_options.find((o) => o.node_id === source);

const sourceQty = (line: ApiKitLine, source: string): number =>
  sourceOption(line, source)?.qty ?? 0;

/** A grid (LN2 box) source hands quantity control to the cell selection. */
const isGridSource = (line: ApiKitLine, source: string): boolean =>
  Boolean(sourceOption(line, source)?.is_grid);

/** `"3:2"` → `{ grid_row: 3, grid_col: 2 }` — CellGridPicker's destination key. */
const toCell = (key: string): ReturnCellInput => {
  const [r, c] = key.split(':');
  return { grid_row: Number(r ?? 0), grid_col: Number(c ?? 0) };
};

/** Today as a local `yyyy-mm-dd` — the earliest a produced lot may expire. */
const todayStr = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function KitDetailClient({ kitId }: { kitId: string }) {
  const canSign = usePermission('inventory', 'sign');
  const canWrite = usePermission('inventory', 'create');

  const [kit, setKit] = React.useState<ApiKit | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [nodes, setNodes] = React.useState<LocationNode[]>([]);
  const [activeStep, setActiveStep] = React.useState(0);
  const [busy, setBusy] = React.useState(false);

  const [activityOpen, setActivityOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  const [reauthOpen, setReauthOpen] = React.useState(false);
  const [addingTo, setAddingTo] = React.useState<ApiKitLine | null>(null);
  const [returningFrom, setReturningFrom] = React.useState<ApiKitLine | null>(null);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  // Cancel is e-signed: the reauth dialog is the final confirmation. For a
  // post-issue kit the return locations are collected first (pendingCancelLines).
  const [cancelReauthOpen, setCancelReauthOpen] = React.useState(false);
  const [pendingCancelLines, setPendingCancelLines] = React.useState<CancelLineInput[]>([]);

  const [output, setOutput] = React.useState<OutputDraft>({
    good_qty: null,
    scrap_qty: 0,
    output_location_node_id: '',
    output_expiration_date: '',
  });
  const [used, setUsed] = React.useState<Record<string, number | null>>({});
  const [returnLoc, setReturnLoc] = React.useState<Record<string, string>>({});
  /** Close-out back-flush cells per line, when the return target is a box. */
  const [returnCells, setReturnCells] = React.useState<Record<string, string[]>>({});
  /** Whether each line's return destination resolved to a box (grid) node. */
  const [returnIsBox, setReturnIsBox] = React.useState<Record<string, boolean>>({});
  const [lineDraft, setLineDraft] = React.useState<Record<string, LineDraft>>({});

  const load = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(null);
      try {
        const k = await kitsApi.get(kitId, { signal });
        setKit(k);
        setActiveStep(stepModel(k.status).def);
        setOutput((prev) => ({
          good_qty: k.good_qty ?? prev.good_qty ?? k.target_qty,
          scrap_qty: k.scrap_qty ?? prev.scrap_qty ?? 0,
          output_location_node_id:
            k.output_location_node_id ?? prev.output_location_node_id ?? '',
          output_expiration_date: prev.output_expiration_date ?? '',
        }));
        setUsed(Object.fromEntries(k.lines.map((l) => [l.id, l.used_qty])));
        setReturnLoc(
          Object.fromEntries(
            k.lines.map((l) => [
              l.id,
              // Default to the source it was pulled from; still editable.
              l.source_location_node_id ?? l.return_location_node_id ?? '',
            ]),
          ),
        );
        setLineDraft(
          Object.fromEntries(
            k.lines.map((l) => [
              l.id,
              { issued_qty: l.issued_qty, source: l.source_location_node_id ?? '', cells: [] },
            ]),
          ),
        );
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load the kit.');
      } finally {
        setLoading(false);
      }
    },
    [kitId],
  );

  React.useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    void locationNodesApi
      .storageTargets({ signal: ctrl.signal })
      .then(setNodes)
      .catch(() => setNodes([]));
    return () => ctrl.abort();
  }, [load]);

  const nodeOptions: SelectOption[] = React.useMemo(
    () => nodes.map((n) => ({ value: n.id, label: n.path ?? n.name })),
    [nodes],
  );
  // Output / back-flush place stock, so only free storage leaves (no box cells).
  const placeableOptions: SelectOption[] = React.useMemo(
    () =>
      nodes
        .filter((n) => n.node_type === 'shelf' || n.node_type === 'sub_location')
        .map((n) => ({ value: n.id, label: n.path ?? n.name })),
    [nodes],
  );
  const placeableIds = React.useMemo(
    () => new Set(placeableOptions.map((o) => o.value)),
    [placeableOptions],
  );
  // Returns may also land in an LN2 box, provided free cells are chosen (D3).
  const returnableIds = React.useMemo(
    () =>
      new Set(
        nodes
          .filter(
            (n) =>
              n.node_type === 'shelf' || n.node_type === 'sub_location' || n.node_type === 'box',
          )
          .map((n) => n.id),
      ),
    [nodes],
  );
  // The production location can be any node in the hierarchy (not just a
  // storage leaf), so resolve its name with a dedicated lookup.
  const [prodName, setProdName] = React.useState('');
  React.useEffect(() => {
    if (!kit) return;
    const ctrl = new AbortController();
    void locationNodesApi
      .get(kit.production_location_node_id, { signal: ctrl.signal })
      .then((n) => setProdName(n.name))
      .catch(() => setProdName(''));
    return () => ctrl.abort();
  }, [kit?.production_location_node_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist the current production figures (good/scrap/output) so the dynamic
  // "needed" is the same on the server as on screen before an issue-more/return
  // from the Production step. Returns whether it saved.
  const persistProduction = async (): Promise<boolean> => {
    try {
      const k = await kitsApi.saveProduction(kit!.id, {
        good_qty: output.good_qty,
        scrap_qty: output.scrap_qty,
        output_location_node_id: output.output_location_node_id || null,
      });
      setKit(k);
      return true;
    } catch (err) {
      toast.error('Could not save production figures', {
        description: err instanceof ApiError ? err.message : undefined,
      });
      return false;
    }
  };

  const run = async (fn: () => Promise<ApiKit>, ok: string, next?: number) => {
    setBusy(true);
    try {
      const k = await fn();
      setKit(k);
      setUsed(Object.fromEntries(k.lines.map((l) => [l.id, l.used_qty])));
      if (next !== undefined) setActiveStep(next);
      else setActiveStep(stepModel(k.status).def);
      toast.success(ok);
    } catch (err) {
      toast.error('Action failed', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  if (loading && !kit) {
    return (
      <>
        <PageHeader
          title="Loading kit…"
          crumbs={[{ label: 'Kitting', href: '/reconciliation' }]}
        />
        <div className="px-6 py-5 sm:px-8">
          <Card className="p-8 text-center text-sm text-text-3">Loading…</Card>
        </div>
      </>
    );
  }

  if (!kit) {
    return (
      <>
        <PageHeader
          title="Kit not found"
          crumbs={[{ label: 'Kitting', href: '/reconciliation' }]}
        />
        <div className="px-6 py-5 sm:px-8">
          <Card className="p-4">
            <EmptyState
              icon={PackageSearch}
              title={loadError ?? `No kit ${kitId}`}
              hint="It may have been removed."
              action={
                <Button asChild variant="primary">
                  <Link href="/reconciliation">Back to kits</Link>
                </Button>
              }
            />
          </Card>
        </div>
      </>
    );
  }

  const model = stepModel(kit.status);
  const editableDraft = kit.status === 'draft';
  const inProd = kit.status === 'issued' || kit.status === 'in_production';

  // Good units can never be zero — you must have produced something (Task 3).
  const goodValid = (output.good_qty ?? 0) >= 1;
  // The produced lot's expiry, when given, can't be in the past.
  const expiryValid = !output.output_expiration_date || output.output_expiration_date >= todayStr();
  const outputReady =
    goodValid &&
    output.scrap_qty !== null &&
    Boolean(output.output_location_node_id) &&
    expiryValid;
  // The output location is required — close-out places the produced quantity
  // there. Production also can't advance while any line is SHORT of its dynamic
  // need: the operator must issue more first (Task 2). A closed/cancelled kit is
  // read-only, so navigation stays open.
  const productionEditable = kit.status === 'issued' || kit.status === 'in_production';
  // Material on the floor + the Next gate use the SAVED production figures. The
  // operator must click Save (which logs ONE "Production recorded") for their
  // good/scrap to take effect — typing alone changes nothing, and issuing more
  // no longer records production (client 2026-07-22).
  const savedAttempted = (kit.good_qty ?? 0) + (kit.scrap_qty ?? 0);
  const savedEffTarget = savedAttempted > 0 ? savedAttempted : kit.target_qty;
  const materialShort = kit.lines.some(
    (l) => l.on_floor_qty < Math.ceil(Number(l.qty_per_unit) * savedEffTarget),
  );
  const productionDirty =
    output.good_qty !== kit.good_qty ||
    output.scrap_qty !== kit.scrap_qty ||
    (output.output_location_node_id || null) !== (kit.output_location_node_id || null);
  const productionReady =
    !productionEditable || (outputReady && !productionDirty && !materialShort);
  const usedComplete = kit.lines.every((l) => used[l.id] !== null && used[l.id] !== undefined);
  // Whether each line's chosen return destination turned out to be a box —
  // reported by BoxCellPicker, which resolves it from the Location System.
  // (The kit's source_options can't answer this: the operator may pick a box
  // this kit never pulled from, and it wouldn't be listed there.)
  const isBox = (lineId: string) => returnIsBox[lineId] === true;
  // A back-flush into a box needs one free cell per returned unit.
  const cellsIncomplete = kit.lines.some((l) => {
    const u = used[l.id];
    if (u == null) return false;
    const ret = l.on_floor_qty - u;
    if (ret <= 0) return false;
    return isBox(l.id) ? (returnCells[l.id]?.length ?? 0) !== ret : false;
  });
  // The cap is what is still on the floor — net of anything already returned.
  const overUse = kit.lines.filter(
    (l) => used[l.id] != null && (used[l.id] as number) > l.on_floor_qty,
  );
  // The close-out "needed" is driven by what the build actually yielded — good +
  // scrap — not the original target, so it updates live as those are entered.
  // (Backend yield gate: issued+additional must cover it, else issued_below_yield.)
  const attemptedTotal = (() => {
    const g = kit.status === 'closed' ? kit.good_qty : output.good_qty;
    const s = kit.status === 'closed' ? kit.scrap_qty : output.scrap_qty;
    return g == null && s == null ? null : (g ?? 0) + (s ?? 0);
  })();
  const lineNeeded = (l: ApiKitLine) =>
    attemptedTotal == null ? 0 : Math.ceil(Number(l.qty_per_unit) * attemptedTotal);
  // Task 5.1: used can never be below needed — that much material is required to
  // make the claimed output (backend code used_below_need). Blocks close-out.
  const underUse = kit.lines.filter(
    (l) => used[l.id] != null && (used[l.id] as number) < lineNeeded(l),
  );
  const closeReady =
    outputReady && usedComplete && overUse.length === 0 && underUse.length === 0 && !cellsIncomplete;
  // The hard issue gate (client 2026-07-22): every line must issue AT LEAST its
  // BOM need, from a source that physically holds the need — a short kit can't
  // be issued at all. Checked against the local draft (nothing is saved until
  // Issue is pressed) so the button disables before the server 422s.
  const issueBlocked =
    editableDraft &&
    kit.lines.some((l) => {
      const d = lineDraft[l.id];
      if (!d) return true;
      const needed = Number(l.needed_qty);
      if (!d.source) return true; // every line needs a source
      if (isGridSource(l, d.source)) {
        // For a box the quantity IS the cell count: must pick at least `needed`.
        return d.cells.length < needed;
      }
      // Bulk: issue ≥ need, and the source must hold ≥ need (and ≥ what's typed).
      if (d.issued_qty < needed) return true;
      if (sourceQty(l, d.source) < needed) return true;
      return d.issued_qty > sourceQty(l, d.source);
    });

  const onIssue = () =>
    void run(
      () =>
        kitsApi.issue(kit.id, {
          lines: kit.lines.map((l) => {
            const d = lineDraft[l.id];
            const grid = d?.source ? isGridSource(l, d.source) : false;
            return {
              line_id: l.id,
              // A box's quantity is the number of cells picked (D2).
              issued_qty: grid ? (d?.cells.length ?? 0) : (d?.issued_qty ?? l.issued_qty),
              source_location_node_id: (d?.source ?? l.source_location_node_id) || null,
              cell_allocation_ids: grid ? d?.cells : undefined,
            };
          }),
        }),
      'Material issued',
      1,
    );

  // Advancing to close-out no longer saves — the figures are already persisted
  // by the "Save production" button. Entering the step, pre-fill each line's
  // Used with its needed quantity (the material required to make the output) and
  // default the back-flush location to where it was pulled from, so the operator
  // only edits the exceptions (client 2026-07-22).
  const enterCloseOut = () => {
    if (kit.status === 'issued' || kit.status === 'in_production') {
      const attempted = (kit.good_qty ?? 0) + (kit.scrap_qty ?? 0);
      const eff = attempted > 0 ? attempted : kit.target_qty;
      setUsed((prev) => {
        const next = { ...prev };
        for (const l of kit.lines) {
          if (next[l.id] == null) {
            next[l.id] = Math.min(Math.ceil(Number(l.qty_per_unit) * eff), l.on_floor_qty);
          }
        }
        return next;
      });
      setReturnLoc((prev) => {
        const next = { ...prev };
        for (const l of kit.lines) {
          if (!next[l.id]) {
            next[l.id] = l.source_location_node_id ?? l.return_location_node_id ?? '';
          }
        }
        return next;
      });
    }
    setActiveStep(2);
  };
  const onProductionNext = enterCloseOut;

  const onCloseConfirmed = async (evidence: ReauthResponse) => {
    try {
      const k = await kitsApi.closeOut(kit.id, {
        good_qty: output.good_qty!,
        scrap_qty: output.scrap_qty!,
        output_location_node_id: output.output_location_node_id,
        output_expiration_date: output.output_expiration_date || null,
        lines: kit.lines.map((l) => ({
          line_id: l.id,
          used_qty: used[l.id] as number,
          return_location_node_id: returnLoc[l.id] || null,
          return_cells: isBox(l.id) ? (returnCells[l.id] ?? []).map(toCell) : undefined,
        })),
        evidence_id: evidence.evidence_id,
        reason: evidence.comment ?? '',
      });
      setKit(k);
      setActiveStep(2);
      toast.success(`${k.kit_number} closed`, {
        description: `${k.good_qty} × ${k.item_number} stocked; leftovers back-flushed.`,
      });
    } catch (err) {
      toast.error('Close-out failed', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    }
  };

  const onCancel = () => {
    // Cancelling is e-signed. A draft has moved nothing, so the signature IS the
    // confirmation. Post-issue, material must go somewhere specific — collect the
    // per-line return locations first (D1), then sign.
    if (editableDraft) {
      setPendingCancelLines([]);
      setCancelReauthOpen(true);
    } else {
      setCancelOpen(true);
    }
  };

  const onCancelConfirmed = async (evidence: ReauthResponse) => {
    try {
      const k = await kitsApi.cancel(kit.id, {
        evidence_id: evidence.evidence_id,
        reason: evidence.comment || undefined,
        lines: pendingCancelLines,
      });
      setKit(k);
      setActiveStep(stepModel(k.status).def);
      toast.success(`${k.kit_number} cancelled`);
    } catch (err) {
      toast.error('Could not cancel', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    }
  };

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Kitting', href: '/reconciliation' }, { label: kit.kit_number }]}
        title={kit.kit_number}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <KitStatusBadge status={kit.status} />
            <span>
              Building <span className="font-mono text-text">{kit.target_qty}</span> ×{' '}
              <span className="font-mono text-text">{kit.item_number}</span> — {kit.description}
            </span>
            <span className="text-text-3">· at {prodName || '…'}</span>
          </span>
        }
        actions={
          <>
            {canWrite && kit.status !== 'closed' && kit.status !== 'cancelled' && (
              <Button variant="secondary" onClick={() => setEditOpen(true)} disabled={busy}>
                <Pencil size={14} /> Edit
              </Button>
            )}
            <Button variant="secondary" onClick={() => setActivityOpen(true)}>
              <ScrollText size={14} /> Activity log
            </Button>
            {(editableDraft || inProd) && canWrite && (
              <Button variant="danger" onClick={() => void onCancel()} disabled={busy}>
                Cancel kit
              </Button>
            )}
          </>
        }
      />

      <div className="px-6 py-5 sm:px-8">
        {/* Stepper */}
        <Card className="mb-5 p-2 sm:p-3">
          <nav aria-label="Kit progress">
            <ol className="flex items-stretch">
              {STEPS.map((step, i) => {
                const isCurrent = i === activeStep;
                const isDone = i < model.completed;
                const isReachable = i <= model.reachable;
                // Same gate as the "Next: Close-Out" button — you can't jump
                // FORWARD to Close-Out until production is saved and every line
                // holds its need. Going back to Issue / Production stays open.
                const gateBlocked = i === 2 && i > activeStep && !productionReady;
                const clickable = isReachable && !gateBlocked;
                return (
                  <li key={step.key} className="flex flex-1 items-center last:flex-none">
                    <button
                      type="button"
                      disabled={!clickable}
                      onClick={() => clickable && (i === 2 ? enterCloseOut() : setActiveStep(i))}
                      aria-current={isCurrent ? 'step' : undefined}
                      title={
                        gateBlocked
                          ? 'Save the production figures and make sure no line is short first'
                          : undefined
                      }
                      className={cn(
                        'group flex items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:px-3',
                        clickable ? 'hover:bg-surface' : 'cursor-not-allowed opacity-50',
                      )}
                    >
                      <span
                        className={cn(
                          'flex size-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold transition-colors',
                          isCurrent && 'border-accent bg-accent text-white',
                          isDone && !isCurrent && 'border-success bg-success text-white',
                          !isCurrent && !isDone && 'border-border-strong bg-bg-elev text-text-3',
                        )}
                      >
                        {isDone && !isCurrent ? <Check size={16} /> : i + 1}
                      </span>
                      <span className="min-w-0">
                        <span
                          className={cn(
                            'block text-sm font-medium',
                            isCurrent || isDone ? 'text-text' : 'text-text-3',
                          )}
                        >
                          {step.label}
                        </span>
                        <span className="hidden text-xs text-text-3 sm:block">{step.hint}</span>
                      </span>
                    </button>
                    {i < STEPS.length - 1 && (
                      <span
                        className={cn(
                          'mx-1 h-px flex-1 sm:mx-2',
                          i < model.completed ? 'bg-success' : 'bg-border',
                        )}
                        aria-hidden
                      />
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
        </Card>

        {activeStep === 0 && (
          <IssueStep
            kit={kit}
            nodeOptions={nodeOptions}
            editableDraft={editableDraft}
            inProd={inProd}
            busy={busy}
            draft={lineDraft}
            onDraftChange={(lineId, patch) =>
              setLineDraft((prev) => {
                const cur = prev[lineId];
                // Changing the source invalidates any cell picks from the old one.
                const sourceChanged = patch.source !== undefined && patch.source !== cur?.source;
                const cells = patch.cells ?? (sourceChanged ? [] : (cur?.cells ?? []));
                return {
                  ...prev,
                  [lineId]: {
                    issued_qty: patch.issued_qty ?? cur?.issued_qty ?? 0,
                    source: patch.source ?? cur?.source ?? '',
                    cells,
                  },
                };
              })
            }
            onIssueMore={(line) => setAddingTo(line)}
            onReturn={(line) => setReturningFrom(line)}
          />
        )}
        {activeStep === 1 && (
          <ProductionStep
            kit={kit}
            output={output}
            onChange={setOutput}
            allowedIds={placeableIds}
            canWrite={canWrite}
            busy={busy}
            dirty={productionDirty}
            onSave={async () => {
              setBusy(true);
              if (await persistProduction()) toast.success('Production figures saved');
              setBusy(false);
            }}
            onIssueMore={(l) => setAddingTo(l)}
            onReturn={(l) => setReturningFrom(l)}
          />
        )}
        {activeStep === 2 && (
          <CloseOutStep
            kit={kit}
            used={used}
            onUsed={(id, v) => setUsed((u) => ({ ...u, [id]: v }))}
            returnLoc={returnLoc}
            onReturnLoc={(id, v) => {
              setReturnLoc((r) => ({ ...r, [id]: v }));
              // A new destination invalidates cells picked against the old one.
              setReturnCells((c) => ({ ...c, [id]: [] }));
            }}
            returnCells={returnCells}
            onReturnCells={(id, v) => setReturnCells((c) => ({ ...c, [id]: v }))}
            returnIsBox={returnIsBox}
            onReturnIsBox={(id, v) =>
              setReturnIsBox((m) => (m[id] === v ? m : { ...m, [id]: v }))
            }
            allowedIds={returnableIds}
            overUse={overUse}
            attemptedTotal={attemptedTotal}
            goodQty={kit.status === 'closed' ? kit.good_qty : output.good_qty}
            scrapQty={kit.status === 'closed' ? kit.scrap_qty : output.scrap_qty}
          />
        )}

        {/* Step footer — advance action always here */}
        <div className="mt-5 flex items-center justify-between gap-3 border-t border-border pt-4">
          <Button
            variant="ghost"
            disabled={activeStep === 0}
            onClick={() => setActiveStep((s) => Math.max(0, s - 1))}
          >
            <ChevronLeft size={14} /> Back
          </Button>
          {footerPrimary(kit, activeStep, model, {
            canWrite,
            canSign,
            busy,
            closeReady,
            issueBlocked,
            productionReady,
            onIssue,
            onNext: () => setActiveStep((s) => Math.min(model.reachable, s + 1)),
            onProductionNext,
            onClose: () => setReauthOpen(true),
          })}
        </div>
      </div>

      <AdditionalIssueDialog
        kit={kit}
        line={addingTo}
        onOpenChange={(o) => !o && setAddingTo(null)}
        onDone={(k) => {
          setKit(k);
          setAddingTo(null);
        }}
      />

      <CancelKitDialog
        kit={kit}
        open={cancelOpen}
        allowedIds={returnableIds}
        onOpenChange={setCancelOpen}
        onSubmit={(cancelLines) => {
          setCancelOpen(false);
          setPendingCancelLines(cancelLines);
          setCancelReauthOpen(true);
        }}
      />

      <ReturnExcessDialog
        kit={kit}
        line={returningFrom}
        allowedIds={returnableIds}
        onOpenChange={(o) => !o && setReturningFrom(null)}
        onDone={(k) => {
          setKit(k);
          setUsed(Object.fromEntries(k.lines.map((l) => [l.id, l.used_qty])));
          setReturningFrom(null);
        }}
      />

      <PasswordReauthDialog
        open={reauthOpen}
        onOpenChange={setReauthOpen}
        action="kit.closeout"
        meaning={`I am closing kit ${kit.kit_number}: ${output.good_qty} good, ${output.scrap_qty} scrapped, and back-flushing the leftover.`}
        title="Sign this close-out"
        submitLabel="Close kit"
        commentPlaceholder="e.g. Batch record 2026-07-20"
        onConfirmed={onCloseConfirmed}
      />

      <PasswordReauthDialog
        open={cancelReauthOpen}
        onOpenChange={setCancelReauthOpen}
        action="kit.cancel"
        meaning={
          editableDraft
            ? `I am cancelling draft kit ${kit.kit_number}. No material has moved.`
            : `I am cancelling kit ${kit.kit_number} and returning all material still on the floor to inventory.`
        }
        title="Sign this cancellation"
        submitLabel="Cancel kit"
        commentPlaceholder="e.g. Batch aborted — contamination"
        onConfirmed={onCancelConfirmed}
      />

      <ActivitySheet kitId={kit.id} kitNumber={kit.kit_number} open={activityOpen} onOpenChange={setActivityOpen} />
      <EditKitDialog kit={kit} open={editOpen} onOpenChange={setEditOpen} onDone={(k) => setKit(k)} />
    </>
  );
}

// ── Edit kit (name / target) ────────────────────────────────────────────────

function EditKitDialog({
  kit,
  open,
  onOpenChange,
  onDone,
}: {
  kit: ApiKit;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (kit: ApiKit) => void;
}) {
  const draft = kit.status === 'draft';
  const [name, setName] = React.useState(kit.kit_number);
  const [target, setTarget] = React.useState<number | null>(kit.target_qty);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setName(kit.kit_number);
      setTarget(kit.target_qty);
    }
  }, [open, kit.kit_number, kit.target_qty]);

  const nameChanged = name.trim() !== kit.kit_number;
  const targetChanged = draft && target !== null && target !== kit.target_qty;
  const ready =
    name.trim().length > 0 && (!draft || (target !== null && target > 0)) && (nameChanged || targetChanged);

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const input: KitUpdateInput = {};
      if (nameChanged) input.kit_number = name.trim();
      if (targetChanged) input.target_qty = target as number;
      const k = await kitsApi.update(kit.id, input);
      toast.success('Kit updated');
      onDone(k);
      onOpenChange(false);
    } catch (err) {
      toast.error('Could not update the kit', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit {kit.kit_number}</DialogTitle>
          <DialogDescription>
            Rename the kit{draft ? ' or change how many to build' : ''}.
            {draft ? '' : ' The target is locked once the kit is issued.'}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-2">Kit name</label>
            <Input aria-label="Kit name" value={name} onChange={(e) => setName(e.target.value)} />
            <p className="mt-1 text-[11px] text-text-3">Also names the produced lot. Must be unique.</p>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-2">
              Target quantity{' '}
              {!draft && <span className="font-normal text-text-3">(locked after issue)</span>}
            </label>
            <NumberInput
              aria-label="Target quantity"
              value={target}
              min={1}
              disabled={!draft}
              onChange={setTarget}
            />
            {targetChanged && (
              <p className="mt-1 text-[11px] text-text-3">
                Changing the target resets each line’s suggested issue quantity.
              </p>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || !ready}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function footerPrimary(
  kit: ApiKit,
  activeStep: number,
  model: { reachable: number },
  ctx: {
    canWrite: boolean;
    canSign: boolean;
    busy: boolean;
    closeReady: boolean;
    issueBlocked: boolean;
    productionReady: boolean;
    onIssue: () => void;
    onNext: () => void;
    onProductionNext: () => void;
    onClose: () => void;
  },
) {
  const next = (
    <Button variant="primary" onClick={ctx.onNext} disabled={ctx.busy}>
      Next: {STEPS[activeStep + 1]?.label} <ArrowRight size={14} />
    </Button>
  );
  if (activeStep === 0) {
    if (kit.status === 'draft')
      return ctx.canWrite ? (
        <Button
          variant="primary"
          onClick={ctx.onIssue}
          disabled={ctx.busy || ctx.issueBlocked}
          title={ctx.issueBlocked ? 'A line issues more than its source location holds' : undefined}
        >
          Issue material <ArrowRight size={14} />
        </Button>
      ) : (
        <span />
      );
    return model.reachable > 0 ? next : <span />;
  }
  if (activeStep === 1)
    return model.reachable > 1 ? (
      <Button
        variant="primary"
        onClick={ctx.onProductionNext}
        disabled={ctx.busy || !ctx.productionReady}
        title={
          ctx.productionReady
            ? undefined
            : 'Save the production figures, make sure no line is short, and choose the output location'
        }
      >
        Next: {STEPS[activeStep + 1]?.label} <ArrowRight size={14} />
      </Button>
    ) : (
      <span />
    );
  if (activeStep === 2 && (kit.status === 'issued' || kit.status === 'in_production'))
    return ctx.canSign ? (
      <Button
        variant="primary"
        onClick={ctx.onClose}
        disabled={!ctx.closeReady || ctx.busy}
        title={ctx.closeReady ? undefined : 'Enter output and used quantities first'}
      >
        Post output &amp; close kit <ArrowRight size={14} />
      </Button>
    ) : (
      <span />
    );
  return <span />;
}

// ── Issue step ────────────────────────────────────────────────────────────

function IssueStep({
  kit,
  nodeOptions,
  editableDraft,
  inProd,
  busy,
  draft,
  onDraftChange,
  onIssueMore,
  onReturn,
}: {
  kit: ApiKit;
  nodeOptions: SelectOption[];
  editableDraft: boolean;
  inProd: boolean;
  busy: boolean;
  draft: Record<string, LineDraft>;
  onDraftChange: (lineId: string, patch: Partial<LineDraft>) => void;
  onIssueMore: (line: ApiKitLine) => void;
  onReturn: (line: ApiKitLine) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Components" value={kit.lines.length} hint="BOM lines" />
        <Stat
          label="Needed"
          value={kit.lines.reduce((a, l) => a + Number(l.needed_qty), 0)}
          hint={`To build ${kit.target_qty}`}
        />
        <Stat label="Status" value={editableDraft ? 'Draft' : 'Issued'} hint={editableDraft ? 'Nothing moved yet' : 'Stock decremented'} />
      </div>

      <Card className="p-4">
        <div className="mb-3">
          <h2 className="text-sm font-medium text-text">Kit structure</h2>
          <p className="mt-0.5 text-xs text-text-3">
            {editableDraft
              ? 'Quantity Needed comes from the BOM. Quantity Issued is what you pull — it must be at least the Needed amount, and the source location must hold that much, or the kit can’t be issued. Edit, then press Issue material to commit.'
              : 'Issued and locked. Extra material during production goes through an additional issue.'}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 text-right font-medium">Needed</th>
                <th className="px-3 py-2 text-right font-medium">On hand</th>
                <th className="px-3 py-2 text-right font-medium">Issued</th>
                {!editableDraft && <th className="px-3 py-2 text-right font-medium">Additional</th>}
                {!editableDraft && <th className="px-3 py-2 text-right font-medium">Returned</th>}
                {!editableDraft && <th className="px-3 py-2 text-right font-medium">On floor</th>}
                <th className="px-3 py-2 font-medium">Source location</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {kit.lines.map((line) => {
                const d = draft[line.id] ?? {
                  issued_qty: line.issued_qty,
                  source: line.source_location_node_id ?? '',
                  cells: [],
                };
                const opt = line.source_options.find((o) => o.node_id === d.source);
                const grid = Boolean(opt?.is_grid);
                // Available at the chosen source: from the draft in edit mode,
                // from the server-derived value once issued.
                const hereQty = editableDraft
                  ? d.source
                    ? sourceQty(line, d.source)
                    : null
                  : line.source_available;
                const noSource = editableDraft && !d.source;
                const needed = Number(line.needed_qty);
                // A box can't be over-issued — quantity is the cell count — but
                // it can be under-picked (fewer cells than needed).
                const over =
                  editableDraft && Boolean(d.source) && !grid && d.issued_qty > sourceQty(line, d.source);
                const noCells = editableDraft && grid && d.cells.length === 0;
                // Hard gate (2026-07-22): issued ≥ need, and the source holds ≥ need.
                const belowNeed = editableDraft && !grid && d.issued_qty < needed;
                const gridBelowNeed = editableDraft && grid && d.cells.length < needed;
                const sourceShort =
                  editableDraft && Boolean(d.source) && !grid && sourceQty(line, d.source) < needed;
                const invalid =
                  over || noSource || noCells || belowNeed || gridBelowNeed || sourceShort;
                return (
                  <React.Fragment key={line.id}>
                  <tr className={cn('border-b border-border/60', invalid && 'bg-danger-soft/30')}>
                    <td className="max-w-[300px] px-3 py-2">
                      <ItemCell itemNumber={line.item_number} description={line.description} itemId={line.item_id} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <QtyCell value={Number(line.needed_qty)} title={`×${line.qty_per_unit} per unit`} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex flex-col items-end leading-tight">
                        <QtyCell
                          value={line.on_hand}
                          tone={line.on_hand <= 0 ? 'danger' : undefined}
                          title={`${line.on_hand} in stock across ${line.source_options.length} location${line.source_options.length === 1 ? '' : 's'}`}
                        />
                        {hereQty !== null && (
                          <span
                            className={cn(
                              'mt-0.5 text-[11px] tabular-nums',
                              over || sourceShort ? 'text-danger' : 'text-text-3',
                            )}
                          >
                            {hereQty} at source{sourceShort && ` · need ${needed}`}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {editableDraft ? (
                        grid ? (
                          // LN2: the quantity is however many cells were picked,
                          // so the input becomes a derived read-out (D2). Flags
                          // red when fewer cells than the BOM need are selected.
                          <div className="flex flex-col items-end leading-tight">
                            <QtyCell
                              value={d.cells.length}
                              tone={gridBelowNeed ? 'danger' : undefined}
                            />
                            {gridBelowNeed ? (
                              <span className="mt-0.5 text-[10px] text-danger">
                                pick {needed} cell{needed === 1 ? '' : 's'}
                              </span>
                            ) : (
                              <span className="mt-0.5 text-[10px] uppercase tracking-wide text-text-3">
                                from cells
                              </span>
                            )}
                          </div>
                        ) : (
                          <div className="flex flex-col items-end leading-tight">
                            <NumberInput
                              aria-label={`Issued for ${line.item_number}`}
                              value={d.issued_qty}
                              invalid={invalid}
                              onChange={(v) => onDraftChange(line.id, { issued_qty: v ?? 0 })}
                            />
                            {belowNeed && (
                              <span className="mt-0.5 text-[10px] text-danger">min {needed}</span>
                            )}
                          </div>
                        )
                      ) : (
                        <QtyCell value={line.issued_qty} />
                      )}
                    </td>
                    {!editableDraft && (
                      <td className="px-3 py-2 text-right">
                        <QtyCell
                          value={line.additional_issued_qty || null}
                          tone={line.additional_issued_qty ? 'success' : 'muted'}
                        />
                      </td>
                    )}
                    {!editableDraft && (
                      <td className="px-3 py-2 text-right">
                        <QtyCell
                          value={line.early_returned_qty || null}
                          tone={line.early_returned_qty ? 'success' : 'muted'}
                          title="Already handed back to inventory"
                        />
                      </td>
                    )}
                    {!editableDraft && (
                      <td className="px-3 py-2 text-right">
                        <QtyCell
                          value={line.on_floor_qty}
                          tone={line.on_floor_qty > 0 ? undefined : 'muted'}
                          title="Still at the production location"
                        />
                      </td>
                    )}
                    <td className="px-3 py-2">
                      {editableDraft ? (
                        <div className="w-56">
                          <LocationTreePicker
                            aria-label={`Source for ${line.item_number}`}
                            value={d.source}
                            onChange={(v) => onDraftChange(line.id, { source: v })}
                            allowedNodeIds={new Set(line.source_options.map((o) => o.node_id))}
                            nodeQty={Object.fromEntries(
                              line.source_options.map((o) => [o.node_id, o.qty]),
                            )}
                            showPath
                            placeholder={line.source_options.length ? 'Choose a location' : 'None in stock'}
                            emptyText="This item isn't in stock anywhere."
                          />
                          {noSource && (
                            <p className="mt-1 text-xs text-danger">Choose a source location.</p>
                          )}
                          {over && (
                            <p className="mt-1 text-xs text-danger">
                              Only {sourceQty(line, d.source)} at the chosen location.
                            </p>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-text-2">
                          {nodeOptions.find((o) => o.value === line.source_location_node_id)?.label ?? '—'}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {inProd && (
                        <>
                          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onIssueMore(line)}>
                            <Plus size={12} /> Issue more
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy || line.on_floor_qty <= 0}
                            title={
                              line.on_floor_qty > 0
                                ? 'Return excess to inventory'
                                : 'Nothing on the floor to return'
                            }
                            onClick={() => onReturn(line)}
                          >
                            <Undo2 size={12} /> Return
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                  {/* The cryobox grid gets its own full-width row. Nested in the
                      224px Source cell it overflowed and forced a scrollbar —
                      a 10×10 box needs ~320px.
                      Draft only: once issued the source is locked, and the
                      table also gains the Returned / On-floor columns, so the
                      colSpan below would be wrong too. */}
                  {editableDraft && grid && opt && (
                    <tr className="border-b border-border/60 bg-surface/40">
                      <td colSpan={7} className="px-3 pb-3 pt-1">
                        <div className="max-w-xl">
                          <p className="mb-2 text-xs text-text-2">
                            <span className="font-mono text-text">{line.item_number}</span> in{' '}
                            <span className="text-text">{opt.name}</span>
                          </p>
                          <CellGridPicker
                            mode="source"
                            rows={opt.grid_rows ?? 1}
                            cols={opt.grid_cols ?? 1}
                            cells={opt.cells}
                            value={d.cells}
                            onChange={(next) =>
                              onDraftChange(line.id, { cells: next, issued_qty: next.length })
                            }
                          />
                          {noCells && (
                            <p className="mt-1 text-xs text-danger">
                              Pick at least one vial, or set this line to another location.
                            </p>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <RuleNote>
        Issuing removes the quantity from the source location immediately — kitted material stops
        counting as on hand. Leftovers come back at close-out as a back-flush.
      </RuleNote>
    </div>
  );
}

// ── Production step ─────────────────────────────────────────────────────────

const OUTPUT_HINT = 'What the build yielded. This posts to stock when you close the kit out.';

function ProductionStep({
  kit,
  output,
  onChange,
  allowedIds,
  canWrite,
  busy,
  dirty,
  onSave,
  onIssueMore,
  onReturn,
}: {
  kit: ApiKit;
  output: OutputDraft;
  onChange: (o: OutputDraft) => void;
  allowedIds: Set<string>;
  canWrite: boolean;
  busy: boolean;
  /** Whether the entered figures differ from what's saved on the kit. */
  dirty: boolean;
  onSave: () => void;
  onIssueMore: (line: ApiKitLine) => void;
  onReturn: (line: ApiKitLine) => void;
}) {
  const closed = kit.status === 'closed' || kit.status === 'cancelled';
  const editable = kit.status === 'issued' || kit.status === 'in_production';
  const made = closed ? kit.good_qty : output.good_qty;
  const scrap = closed ? kit.scrap_qty : output.scrap_qty;
  const total = (made ?? 0) + (scrap ?? 0);
  const yieldPct = total > 0 ? (made ?? 0) / total : null;
  // "Material on the floor" reflects the SAVED figures, not what's being typed —
  // the operator commits with Save (which records production). Until then it
  // shows the last saved good+scrap, else the planned target (client 2026-07-22).
  const savedTotal = (kit.good_qty ?? 0) + (kit.scrap_qty ?? 0);
  const effTarget = savedTotal > 0 ? savedTotal : kit.target_qty;
  const lineNeed = (l: ApiKitLine) => Math.ceil(Number(l.qty_per_unit) * effTarget);
  // The Save button is enabled only when there are valid, unsaved changes.
  const expiryOk = !output.output_expiration_date || output.output_expiration_date >= todayStr();
  const canSaveNow =
    dirty && (output.good_qty ?? 0) >= 1 && Boolean(output.output_location_node_id) && expiryOk;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Build target" value={kit.target_qty} hint={kit.item_number} />
        <Stat label="Good units" value={made ?? '—'} tone="success" hint="Added to stock" />
        <Stat label="Scrapped" value={scrap ?? '—'} tone={(scrap ?? 0) > 0 ? 'danger' : 'default'} hint="Not stocked" />
        <Stat
          label="Yield"
          value={yieldPct === null ? '—' : `${Math.round(yieldPct * 100)}%`}
          tone={yieldPct === null ? 'default' : yieldPct >= 1 ? 'success' : yieldPct >= 0.8 ? 'warning' : 'danger'}
          hint={total > 0 ? `${made} good of ${total}` : 'Enter output'}
        />
      </div>

      <Card className="p-4">
        <div className="mb-3">
          <h2 className="text-sm font-medium text-text">Production output</h2>
          <p className="mt-0.5 text-xs text-text-3">{closed ? 'Posted at close-out.' : OUTPUT_HINT}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-2">Quantity made (good)</label>
            <NumberInput
              aria-label="Quantity made"
              value={made}
              min={1}
              disabled={closed}
              invalid={!closed && (made ?? 0) < 1}
              onChange={(v) => onChange({ ...output, good_qty: v })}
              className="h-8 w-full text-sm"
            />
            {!closed && (made ?? 0) < 1 && (
              <p className="mt-1 text-xs text-danger">
                Must be at least 1 — a kit has to yield some good units.
              </p>
            )}
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-2">Quantity scrapped</label>
            <NumberInput
              aria-label="Quantity scrapped"
              value={scrap}
              disabled={closed}
              onChange={(v) => onChange({ ...output, scrap_qty: v })}
              className="h-8 w-full text-sm"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-2">
              Expiry of the produced {kit.item_number}
            </label>
            <Input
              type="date"
              aria-label="Output expiry date"
              value={closed ? '' : output.output_expiration_date}
              min={todayStr()}
              disabled={closed}
              onChange={(e) => onChange({ ...output, output_expiration_date: e.target.value })}
            />
            {!closed && output.output_expiration_date && output.output_expiration_date < todayStr() ? (
              <p className="mt-1 text-xs text-danger">
                Expiry must be today or later — a produced lot can’t already be expired.
              </p>
            ) : (
              <p className="mt-1 text-xs text-text-3">
                Carried onto the produced lot so it appears in expiry reporting.
              </p>
            )}
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-2">
              Stock the output to <span className="text-danger">*</span>
            </label>
            <LocationTreePicker
              aria-label="Output location"
              value={(closed ? kit.output_location_node_id : output.output_location_node_id) ?? ''}
              onChange={(v) => onChange({ ...output, output_location_node_id: v })}
              areas={['cold', 'warehouse']}
              allowedNodeIds={allowedIds}
              disabled={closed}
              showPath
              placeholder="Choose a location"
            />
            {!closed && !output.output_location_node_id && (
              <p className="mt-1 text-xs text-danger">
                Required — the finished quantity is stocked here at close-out.
              </p>
            )}
          </div>
        </div>

        {!closed && (
          <div className="mt-4 flex items-center justify-end gap-3 border-t border-border pt-3">
            <span className={cn('text-xs', dirty ? 'text-warning' : 'text-success')}>
              {dirty ? 'Unsaved — save to record production and update the floor.' : 'Saved.'}
            </span>
            <Button variant="primary" size="sm" disabled={busy || !canSaveNow} onClick={onSave}>
              <Save size={13} /> Save production
            </Button>
          </div>
        )}
      </Card>

      {editable && (
        <Card className="p-4">
          <div className="mb-3">
            <h2 className="text-sm font-medium text-text">Material on the floor</h2>
            <p className="mt-0.5 text-xs text-text-3">
              Needed reflects the <span className="text-text-2">saved</span> output — {effTarget} unit
              {effTarget === 1 ? '' : 's'} × per-unit BOM. Each line must hold at least its need
              before close-out; issue more if short, return the surplus.
              {dirty && (
                <span className="font-medium text-warning"> Save your changes to update these.</span>
              )}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 text-right font-medium">Needed</th>
                  <th className="px-3 py-2 text-right font-medium">On floor</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Adjust</th>
                </tr>
              </thead>
              <tbody>
                {kit.lines.map((line) => {
                  const need = lineNeed(line);
                  const floor = line.on_floor_qty;
                  const short = floor < need;
                  const surplus = floor - need;
                  return (
                    <tr
                      key={line.id}
                      className={cn('border-b border-border/60', short && 'bg-danger-soft/30')}
                    >
                      <td className="max-w-[280px] px-3 py-2">
                        <ItemCell itemNumber={line.item_number} description={line.description} itemId={line.item_id} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <QtyCell value={need} tone={short ? 'danger' : undefined} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <QtyCell value={floor} />
                      </td>
                      <td className="px-3 py-2">
                        {short ? (
                          <span className="text-xs font-medium text-danger">
                            Short {need - floor} — issue more
                          </span>
                        ) : surplus > 0 ? (
                          <span className="text-xs text-text-3">Surplus {surplus}</span>
                        ) : (
                          <span className="text-xs text-success">Exact</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!canWrite}
                          onClick={() => onIssueMore(line)}
                        >
                          <Plus size={12} /> Issue more
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!canWrite || surplus <= 0}
                          title={
                            surplus > 0
                              ? 'Return the surplus to inventory'
                              : 'No surplus above the need to return'
                          }
                          onClick={() => onReturn(line)}
                        >
                          <Undo2 size={12} /> Return
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {!closed && (
        <RuleNote>
          Output and reconciliation commit together at close-out — the finished quantity is stocked
          and the leftover back-flushed in one signed step.
        </RuleNote>
      )}
    </div>
  );
}

// ── Close-out step ──────────────────────────────────────────────────────────

function CloseOutStep({
  kit,
  used,
  onUsed,
  returnLoc,
  onReturnLoc,
  returnCells,
  onReturnCells,
  returnIsBox,
  onReturnIsBox,
  allowedIds,
  overUse,
  attemptedTotal,
  goodQty,
  scrapQty,
}: {
  kit: ApiKit;
  used: Record<string, number | null>;
  onUsed: (id: string, v: number | null) => void;
  returnLoc: Record<string, string>;
  onReturnLoc: (id: string, v: string) => void;
  returnCells: Record<string, string[]>;
  onReturnCells: (id: string, v: string[]) => void;
  returnIsBox: Record<string, boolean>;
  onReturnIsBox: (id: string, isBox: boolean) => void;
  allowedIds: Set<string>;
  overUse: ApiKitLine[];
  /** good + scrap (null until entered) — drives the live close-out "needed". */
  attemptedTotal: number | null;
  goodQty: number | null;
  scrapQty: number | null;
}) {
  const closed = kit.status === 'closed';
  const cancelled = kit.status === 'cancelled';
  const editable = kit.status === 'issued' || kit.status === 'in_production';

  if (kit.status === 'draft') {
    return (
      <Card className="p-4">
        <RuleNote>Close-out reconciles issued vs. used. Issue the kit first.</RuleNote>
      </Card>
    );
  }
  if (cancelled) {
    return (
      <Card className="p-4">
        <RuleNote>This kit was cancelled — nothing was issued, so there is nothing to reconcile.</RuleNote>
      </Card>
    );
  }

  const returned = (l: ApiKitLine) => {
    const u = closed ? l.used_qty : used[l.id];
    if (u == null) return null;
    return l.on_floor_qty - u;
  };
  const totalReturned = kit.lines.reduce((a, l) => a + (returned(l) ?? 0), 0);
  const pending = kit.lines.filter((l) => (closed ? l.used_qty : used[l.id]) == null).length;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Good units" value={goodQty ?? 0} tone="success" hint="Produced & stocked" />
        <Stat
          label="Scrapped"
          value={scrapQty ?? 0}
          tone={(scrapQty ?? 0) > 0 ? 'danger' : 'default'}
          hint="Consumed, no output"
        />
        <Stat label="Awaiting used qty" value={pending} tone={pending > 0 ? 'warning' : 'success'} />
        <Stat label="To back-flush" value={totalReturned} tone="success" hint="Units returning to stock" />
      </div>

      <Card className="p-4">
        <div className="mb-3">
          <h2 className="text-sm font-medium text-text">Reconciliation</h2>
          <p className="mt-0.5 text-xs text-text-3">
            Enter Quantity Used from the traveler. Anything left over returns to inventory as an
            explicit back-flush. <span className="text-text-2">Needed</span> updates from what the
            build yielded — (good + scrap) × per-unit BOM.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 text-right font-medium">On floor</th>
                <th className="px-3 py-2 text-right font-medium">Needed</th>
                <th className="px-3 py-2 text-right font-medium">Used</th>
                <th className="px-3 py-2 text-right font-medium">Back-flushed</th>
                <th className="px-3 py-2 font-medium">Back-flush location</th>
              </tr>
            </thead>
            <tbody>
              {kit.lines.map((line) => {
                const over = overUse.some((l) => l.id === line.id);
                const ret = returned(line);
                // Live "needed" for this build's yield (good + scrap), rounded up
                // to whole units to match the backend. Flags red when it exceeds
                // what was issued (issue more) or when Used is below it (Task 5.1).
                const issuedTotal = lineIssuedTotal(line);
                const needed =
                  attemptedTotal == null ? null : Math.ceil(Number(line.qty_per_unit) * attemptedTotal);
                const needShort = needed != null && needed > issuedTotal;
                const u = editable ? used[line.id] : line.used_qty;
                const usedShort = needed != null && u != null && u < needed;
                return (
                  <React.Fragment key={line.id}>
                    <tr
                      className={cn(
                        'border-b border-border/60',
                        (over || needShort || usedShort) && 'bg-danger-soft/30',
                      )}
                    >
                      <td className="max-w-[300px] px-3 py-2">
                        <ItemCell itemNumber={line.item_number} description={line.description} itemId={line.item_id} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <QtyCell
                          value={line.on_floor_qty}
                          title={
                            line.early_returned_qty
                              ? `${lineIssuedTotal(line)} issued − ${line.early_returned_qty} already returned`
                              : undefined
                          }
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <QtyCell
                          value={needed}
                          tone={
                            needShort || usedShort ? 'danger' : needed == null ? 'muted' : undefined
                          }
                          title={
                            attemptedTotal == null
                              ? 'Enter good + scrap to compute'
                              : `${Number(line.qty_per_unit)} per unit × ${attemptedTotal} made (good + scrap)`
                          }
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        {editable ? (
                          <NumberInput
                            aria-label={`Used for ${line.item_number}`}
                            value={used[line.id] ?? null}
                            invalid={over || usedShort}
                            onChange={(v) => onUsed(line.id, v)}
                          />
                        ) : (
                          <QtyCell value={line.used_qty} />
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <QtyCell value={ret} tone={ret && ret > 0 ? 'success' : 'muted'} />
                      </td>
                      <td className="px-3 py-2">
                        {ret && ret > 0 ? (
                          <div className="w-56">
                            <LocationTreePicker
                              aria-label={`Return location for ${line.item_number}`}
                              value={
                                (editable ? returnLoc[line.id] : line.return_location_node_id) ?? ''
                              }
                              onChange={(v) => onReturnLoc(line.id, v)}
                              areas={['ln2', 'cold', 'warehouse']}
                              allowedNodeIds={allowedIds}
                              disabled={!editable}
                              showPath
                            />
                          </div>
                        ) : (
                          <span className="text-xs text-text-3">
                            {(closed ? line.used_qty : used[line.id]) == null ? '—' : 'Nothing to return'}
                          </span>
                        )}
                      </td>
                    </tr>
                    {over && (
                      <tr className="bg-danger-soft/30">
                        <td colSpan={6} className="px-3 pb-2 text-xs text-danger">
                          Used exceeds what is on the floor by{' '}
                          {(used[line.id] as number) - line.on_floor_qty}. Record an additional
                          issue to cover it.
                        </td>
                      </tr>
                    )}
                    {editable && needShort && !over && (
                      <tr className="bg-danger-soft/30">
                        <td colSpan={6} className="px-3 pb-2 text-xs text-danger">
                          Needs {needed} ({attemptedTotal} made × {Number(line.qty_per_unit)} per
                          unit) but only {issuedTotal} was issued. Record an additional issue before
                          closing out.
                        </td>
                      </tr>
                    )}
                    {editable && usedShort && !over && !needShort && (
                      <tr className="bg-danger-soft/30">
                        <td colSpan={6} className="px-3 pb-2 text-xs text-danger">
                          Used {u} is below the {needed} needed to make {attemptedTotal} unit
                          {attemptedTotal === 1 ? '' : 's'} — that much material is required to
                          produce the output.
                        </td>
                      </tr>
                    )}
                    {/* Full-width row for the cryobox grid — it doesn't fit the
                        224px Return-location cell without a scrollbar. */}
                    {editable && ret !== null && ret > 0 && (
                      <tr
                        className={cn(
                          'border-b border-border/60',
                          returnIsBox[line.id] && 'bg-surface/40',
                        )}
                      >
                        {/* The picker must stay mounted to resolve whether the
                            destination is a box, so collapse the padding rather
                            than the row when it turns out to be bulk. */}
                        <td
                          colSpan={6}
                          className={cn(returnIsBox[line.id] ? 'px-3 pb-3 pt-0' : 'p-0')}
                        >
                          <div className="max-w-xl">
                            <BoxCellPicker
                              nodeId={returnLoc[line.id]}
                              qty={ret}
                              value={returnCells[line.id] ?? []}
                              onChange={(v) => onReturnCells(line.id, v)}
                              onResolved={(isBox) => onReturnIsBox(line.id, isBox)}
                            />
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {closed && (
        <Card className="flex items-start gap-3 border-success/30 bg-success-soft/40 p-4">
          <Check size={16} className="mt-0.5 shrink-0 text-success" />
          <div className="text-sm">
            <div className="font-medium text-text">Kit closed</div>
            <p className="mt-1 text-xs text-text-2">
              {kit.good_qty} × {kit.item_number} stocked
              {(kit.scrap_qty ?? 0) > 0 && ` (${kit.scrap_qty} scrapped)`}, and {totalReturned} unit
              {totalReturned === 1 ? '' : 's'} back-flushed to inventory.
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}

// ── Additional issue dialog ─────────────────────────────────────────────────

function AdditionalIssueDialog({
  kit,
  line,
  onOpenChange,
  onDone,
}: {
  kit: ApiKit;
  line: ApiKitLine | null;
  onOpenChange: (open: boolean) => void;
  onDone: (kit: ApiKit) => void;
}) {
  const [qty, setQty] = React.useState<number | null>(1);
  const [cells, setCells] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!line) return;
    setQty(1);
    setCells([]);
  }, [line?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!line) return null;

  const issuedSoFar = lineIssuedTotal(line);
  const srcOption = line.source_options.find((o) => o.node_id === line.source_location_node_id);
  const available = line.source_available;
  // Same rule as the initial issue (D2): pulling from a box means picking
  // vials, and the quantity is however many you picked.
  const grid = Boolean(srcOption?.is_grid);
  const effectiveQty = grid ? cells.length : (qty ?? 0);
  const over = effectiveQty > available;
  const ready = effectiveQty > 0 && !over;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const k = await kitsApi.additionalIssue(kit.id, line.id, {
        qty: effectiveQty,
        cell_allocation_ids: grid ? cells : undefined,
      });
      toast.success('Additional material issued', {
        description: `${qty} × ${line.item_number}.`,
      });
      onDone(k);
    } catch (err) {
      toast.error('Could not issue', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={line !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Issue more to {kit.kit_number}</DialogTitle>
          <DialogDescription>
            Production needed extra {line.item_number}. This posts as a separate additional issue,
            pulled from the line&apos;s source location.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="rounded-md border border-border bg-surface p-3">
            <ItemCell itemNumber={line.item_number} description={line.description} itemId={line.item_id} />
          </div>
          <dl className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-md border border-border bg-bg-elev p-2">
              <dt className="text-[11px] uppercase tracking-wider text-text-3">Needed</dt>
              <dd className="mt-0.5 font-mono text-sm text-text">{Number(line.needed_qty)}</dd>
            </div>
            <div className="rounded-md border border-border bg-bg-elev p-2">
              <dt className="text-[11px] uppercase tracking-wider text-text-3">Issued</dt>
              <dd className="mt-0.5 font-mono text-sm text-text">{issuedSoFar}</dd>
            </div>
            <div className="rounded-md border border-border bg-bg-elev p-2">
              <dt className="text-[11px] uppercase tracking-wider text-text-3">At source</dt>
              <dd
                className={cn(
                  'mt-0.5 font-mono text-sm',
                  available <= 0 ? 'text-danger' : 'text-text',
                )}
              >
                {available}
              </dd>
            </div>
          </dl>
          <p className="text-xs text-text-3">
            Source: <span className="text-text-2">{srcOption?.path ?? srcOption?.name ?? '—'}</span>
          </p>
          {grid && srcOption ? (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-text-2">
                Pick the vials to pull
              </label>
              <CellGridPicker
                mode="source"
                rows={srcOption.grid_rows ?? 1}
                cols={srcOption.grid_cols ?? 1}
                cells={srcOption.cells}
                value={cells}
                onChange={setCells}
              />
              {cells.length === 0 && (
                <p className="mt-1 text-xs text-danger">Pick at least one vial.</p>
              )}
            </div>
          ) : (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-text-2">Issue now</label>
              <NumberInput
                aria-label="Additional quantity"
                value={qty}
                min={1}
                invalid={over}
                onChange={setQty}
              />
              {over && (
                <p className="mt-1 text-xs text-danger">
                  Only {available} available at the source location.
                </p>
              )}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || !ready}>
            Issue {effectiveQty}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Return excess dialog (REQ-2026-07-01-TRX-008) ───────────────────────────

function ReturnExcessDialog({
  kit,
  line,
  allowedIds,
  onOpenChange,
  onDone,
}: {
  kit: ApiKit;
  line: ApiKitLine | null;
  allowedIds: Set<string>;
  onOpenChange: (open: boolean) => void;
  onDone: (kit: ApiKit) => void;
}) {
  const [qty, setQty] = React.useState<number | null>(1);
  const [node, setNode] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [cells, setCells] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!line) return;
    setQty(line.on_floor_qty > 0 ? 1 : null);
    setNode(line.return_location_node_id ?? line.source_location_node_id ?? '');
    setReason('');
    setCells([]);
  }, [line?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Changing the destination invalidates cell picks made against the old box.
  React.useEffect(() => setCells([]), [node]);

  // Geometry + occupancy come from the LOCATION, not the kit's source options —
  // you can return into any box, including one this kit never pulled from.
  const { grid: destBox } = useBoxGrid(node || null);
  const destGrid = destBox !== null;

  if (!line) return null;

  const onFloor = line.on_floor_qty;
  // You may only return the SURPLUS above what's needed — the floor can never
  // drop below the build requirement (client 2026-07-22, Task 6). "needed" is
  // dynamic: (good+scrap)×BOM once production figures exist, else target×BOM.
  const attempted = (kit.good_qty ?? 0) + (kit.scrap_qty ?? 0);
  const effTarget = attempted > 0 ? attempted : kit.target_qty;
  const needed = Math.ceil(Number(line.qty_per_unit) * effTarget);
  const maxReturn = Math.max(0, onFloor - needed);
  // For an LN2 box the quantity is a consequence of the cells picked (like
  // issuing from a box), never typed. For a bulk shelf it's the typed number.
  const effectiveQty = destGrid ? cells.length : (qty ?? 0);
  const over = effectiveQty > maxReturn;
  const ready = Boolean(node && effectiveQty > 0 && !over);

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const k = await kitsApi.returnExcess(kit.id, line.id, {
        qty: effectiveQty,
        return_location_node_id: node,
        return_cells: destGrid ? cells.map(toCell) : undefined,
        reason: reason.trim() || null,
      });
      toast.success('Returned to inventory', {
        description: `${effectiveQty} × ${line.item_number} back in stock.`,
      });
      onDone(k);
    } catch (err) {
      toast.error('Could not return', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={line !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Return excess from {kit.kit_number}</DialogTitle>
          <DialogDescription>
            Hand unused material back to inventory without closing the kit. It posts as an
            explicit back-flush and returns without a lot assignment, so it is never stranded.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="rounded-md border border-border bg-surface p-3">
            <ItemCell itemNumber={line.item_number} description={line.description} itemId={line.item_id} />
          </div>
          <dl className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
            <div className="rounded-md border border-border bg-bg-elev p-2">
              <dt className="text-[11px] uppercase tracking-wider text-text-3">On floor</dt>
              <dd
                className={cn('mt-0.5 font-mono text-sm', onFloor <= 0 ? 'text-danger' : 'text-text')}
              >
                {onFloor}
              </dd>
            </div>
            <div className="rounded-md border border-border bg-bg-elev p-2">
              <dt className="text-[11px] uppercase tracking-wider text-text-3">Needed</dt>
              <dd className="mt-0.5 font-mono text-sm text-text">{needed}</dd>
            </div>
            <div className="rounded-md border border-border bg-bg-elev p-2" title="Surplus above needed">
              <dt className="text-[11px] uppercase tracking-wider text-text-3">Returnable</dt>
              <dd
                className={cn(
                  'mt-0.5 font-mono text-sm',
                  maxReturn > 0 ? 'text-success' : 'text-text-3',
                )}
              >
                {maxReturn}
              </dd>
            </div>
            <div className="rounded-md border border-border bg-bg-elev p-2">
              <dt className="text-[11px] uppercase tracking-wider text-text-3">Returned</dt>
              <dd className="mt-0.5 font-mono text-sm text-text">{line.early_returned_qty}</dd>
            </div>
          </dl>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-2">Return quantity</label>
            {destGrid ? (
              // LN2: quantity is set by the cells picked below — show it as a
              // read-out, not a typed field (mirrors issuing from a box).
              <div className="flex h-9 items-center justify-between rounded-md border border-border bg-bg-elev px-3">
                <span className="font-mono text-sm text-text">{effectiveQty}</span>
                <span className="text-[11px] uppercase tracking-wide text-text-3">
                  from {effectiveQty === 1 ? 'cell' : 'cells'} selected
                </span>
              </div>
            ) : (
              <>
                <NumberInput
                  aria-label="Return quantity"
                  value={qty}
                  min={1}
                  invalid={over}
                  onChange={setQty}
                />
                {over && (
                  <p className="mt-1 text-xs text-danger">You can return at most {maxReturn}.</p>
                )}
              </>
            )}
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-2">Return to</label>
            <LocationTreePicker
              aria-label="Return location"
              value={node}
              onChange={setNode}
              areas={['ln2', 'cold', 'warehouse']}
              allowedNodeIds={allowedIds}
              modal
              showPath
            />
            {/* Box destination: the cap is the surplus (on-floor − needed), and
                the quantity follows the selection (derive). */}
            <BoxCellPicker
              nodeId={node}
              qty={maxReturn}
              value={cells}
              onChange={setCells}
              derive
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-2">
              Reason <span className="text-text-3">(optional)</span>
            </label>
            <Input
              aria-label="Reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Over-pulled at staging"
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || !ready}>
            Return {effectiveQty}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Cancel dialog (per-line returns, D1) ────────────────────────────────────

function CancelKitDialog({
  kit,
  open,
  allowedIds,
  onOpenChange,
  onSubmit,
}: {
  kit: ApiKit;
  open: boolean;
  allowedIds: Set<string>;
  onOpenChange: (open: boolean) => void;
  /** Hand the chosen return locations back — the parent then collects the
   *  signature and posts the cancel. */
  onSubmit: (lines: CancelLineInput[]) => void;
}) {
  const lines = React.useMemo(() => kit.lines.filter((l) => l.on_floor_qty > 0), [kit.lines]);
  const [loc, setLoc] = React.useState<Record<string, string>>({});
  const [cells, setCells] = React.useState<Record<string, string[]>>({});

  // Default each line to where it was pulled from (D1).
  React.useEffect(() => {
    if (!open) return;
    setLoc(
      Object.fromEntries(
        lines.map((l) => [l.id, l.return_location_node_id ?? l.source_location_node_id ?? '']),
      ),
    );
    setCells({});
  }, [open, lines]);

  // Resolved per line by BoxCellPicker (from the Location System), because the
  // operator can return into a box this kit never pulled from.
  const [isBoxMap, setIsBoxMap] = React.useState<Record<string, boolean>>({});
  const ready = lines.every((l) => {
    const node = loc[l.id];
    if (!node) return false;
    return isBoxMap[l.id] ? (cells[l.id]?.length ?? 0) === l.on_floor_qty : true;
  });
  const totalUnits = lines.reduce((a, l) => a + l.on_floor_qty, 0);

  const submit = () => {
    if (!ready) return;
    onSubmit(
      lines.map((l) => ({
        line_id: l.id,
        return_location_node_id: loc[l.id] ?? '',
        return_cells: isBoxMap[l.id] ? (cells[l.id] ?? []).map(toCell) : undefined,
      })),
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Cancel {kit.kit_number}?</DialogTitle>
          <DialogDescription>
            {totalUnits} unit{totalUnits === 1 ? '' : 's'} still on the production floor will be
            returned to inventory as a back-flush. Choose where each component goes — each is
            pre-set to where it was pulled from. You’ll sign to confirm on the next step.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="max-h-[55vh] space-y-3 overflow-y-auto">
          {lines.map((line) => {
            const node = loc[line.id] ?? '';
            const picked = cells[line.id] ?? [];
            return (
              <div key={line.id} className="rounded-md border border-border bg-surface p-3">
                <div className="mb-2 flex items-start justify-between gap-3">
                  <ItemCell itemNumber={line.item_number} description={line.description} itemId={line.item_id} />
                  <span className="shrink-0 font-mono text-sm tabular-nums text-text">
                    {line.on_floor_qty}
                  </span>
                </div>
                <LocationTreePicker
                  aria-label={`Return location for ${line.item_number}`}
                  value={node}
                  onChange={(v) => {
                    setLoc((p) => ({ ...p, [line.id]: v }));
                    setCells((p) => ({ ...p, [line.id]: [] }));
                  }}
                  areas={['ln2', 'cold', 'warehouse']}
                  allowedNodeIds={allowedIds}
                  modal
                  showPath
                />
                <BoxCellPicker
                  nodeId={node}
                  qty={line.on_floor_qty}
                  value={picked}
                  onChange={(v) => setCells((p) => ({ ...p, [line.id]: v }))}
                  onResolved={(isBox) =>
                    setIsBoxMap((m) => (m[line.id] === isBox ? m : { ...m, [line.id]: isBox }))
                  }
                />
                {!node && <p className="mt-1 text-xs text-danger">Choose a return location.</p>}
              </div>
            );
          })}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Keep kit
          </Button>
          <Button variant="danger" onClick={submit} disabled={!ready}>
            Continue — return {totalUnits} &amp; sign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Activity timeline ───────────────────────────────────────────────────────

/** Visual config per kitting operation — the timeline dot's icon + colour. */
const OP_TIMELINE: Record<string, { label: string; Icon: LucideIcon; tone: string }> = {
  create: { label: 'Kit created', Icon: PackagePlus, tone: 'accent' },
  edit_line: { label: 'Draft edited', Icon: Pencil, tone: 'neutral' },
  issue: { label: 'Issued to production', Icon: Send, tone: 'accent' },
  additional_issue: { label: 'Additional issue', Icon: Plus, tone: 'warning' },
  early_return: { label: 'Excess returned', Icon: Undo2, tone: 'success' },
  production_draft: { label: 'Production recorded', Icon: FlaskConical, tone: 'neutral' },
  close_out: { label: 'Closed out', Icon: CheckCircle2, tone: 'success' },
  cancel: { label: 'Cancelled', Icon: XCircle, tone: 'danger' },
};

/** Fallback op for a movement with no matching audit event (legacy kits). */
const MTYPE_OP: Record<string, string> = {
  kit_issue: 'issue',
  kit_additional_issue: 'additional_issue',
  kit_return: 'early_return',
  backflush: 'close_out',
  production_output: 'close_out',
  kit_cancel_return: 'cancel',
};

const TONE_DOT: Record<string, string> = {
  accent: 'border-accent/40 bg-accent-soft text-accent',
  success: 'border-success/40 bg-success-soft text-success',
  warning: 'border-warning/45 bg-warning-soft text-warning',
  danger: 'border-danger/40 bg-danger-soft text-danger',
  neutral: 'border-border-strong bg-bg-elev text-text-2',
};

interface TimelineNode {
  key: string;
  time: string;
  operation: string;
  goodQty: number | null;
  scrapQty: number | null;
  outputLocation: string | null;
  outputExpiry: string | null;
  moves: ApiKitActivityRow[];
}

/** Fold the audit events + stock movements into one chronological timeline.
 *  Every movement shares its transaction's timestamp with the event that caused
 *  it (both use the DB's transaction clock), so we attach movements to events by
 *  equal time; any orphan movements (legacy kits with no events) become their
 *  own nodes. */
function buildTimeline(events: ApiKitAuditEvent[], moves: ApiKitActivityRow[]): TimelineNode[] {
  const byTime = new Map<number, ApiKitActivityRow[]>();
  for (const m of moves) {
    const t = new Date(m.performed_at).getTime();
    const bucket = byTime.get(t);
    if (bucket) bucket.push(m);
    else byTime.set(t, [m]);
  }

  const nodes: TimelineNode[] = [];
  const consumed = new Set<number>();
  for (const ev of events) {
    const t = new Date(ev.occurred_at).getTime();
    consumed.add(t);
    nodes.push({
      key: ev.id,
      time: ev.occurred_at,
      operation: ev.operation,
      goodQty: ev.good_qty,
      scrapQty: ev.scrap_qty,
      outputLocation: ev.output_location,
      outputExpiry: ev.output_expiration_date,
      moves: byTime.get(t) ?? [],
    });
  }
  // Orphan movement groups (no event) — keep them visible rather than dropping.
  for (const [t, group] of byTime) {
    const first = group[0];
    if (consumed.has(t) || !first) continue;
    nodes.push({
      key: `mv-${t}`,
      time: first.performed_at,
      operation: MTYPE_OP[first.movement_type] ?? 'issue',
      goodQty: null,
      scrapQty: null,
      outputLocation: null,
      outputExpiry: null,
      moves: group,
    });
  }
  // Oldest → newest: the kit's story reads top to bottom.
  nodes.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  return nodes;
}

function ActivitySheet({
  kitId,
  kitNumber,
  open,
  onOpenChange,
}: {
  kitId: string;
  kitNumber: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [rows, setRows] = React.useState<ApiKitActivityRow[] | null>(null);
  const [events, setEvents] = React.useState<ApiKitAuditEvent[]>([]);

  React.useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setRows(null);
    setEvents([]);
    void kitsApi
      .activity(kitId, { signal: ctrl.signal })
      .then((r) => {
        setRows(r.items);
        setEvents(r.events ?? []);
      })
      .catch(() => setRows([]));
    return () => ctrl.abort();
  }, [open, kitId]);

  const timeline = React.useMemo(
    () => (rows ? buildTimeline(events, rows) : []),
    [events, rows],
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:w-[640px]">
        <SheetHeader>
          <SheetTitle>Activity — {kitNumber}</SheetTitle>
          <p className="text-xs text-text-3">
            The kit’s full story, oldest first. Each step shows what happened and the exact stock it
            moved.
          </p>
        </SheetHeader>
        <SheetBody className="px-0 py-0">
          {rows === null ? (
            <p className="p-6 text-center text-xs text-text-3">Loading…</p>
          ) : timeline.length === 0 ? (
            <div className="p-6">
              <EmptyState title="Nothing yet" hint="Issuing the kit writes the first step." />
            </div>
          ) : (
            <ol className="px-5 py-4">
              {timeline.map((node, i) => (
                <TimelineItem key={node.key} node={node} last={i === timeline.length - 1} />
              ))}
            </ol>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function TimelineItem({ node, last }: { node: TimelineNode; last: boolean }) {
  const cfg = OP_TIMELINE[node.operation] ?? {
    label: node.operation,
    Icon: ScrollText,
    tone: 'neutral',
  };
  const { Icon } = cfg;
  const showYield =
    (node.operation === 'close_out' || node.operation === 'production_draft') &&
    (node.goodQty !== null || node.scrapQty !== null);

  return (
    <li className="relative flex gap-3.5 pb-5 last:pb-0">
      {/* Rail: connecting line behind the dot, drawn except on the last node. */}
      {!last && (
        <span
          aria-hidden
          className="absolute left-[15px] top-8 bottom-0 w-px bg-border"
        />
      )}
      <span
        className={cn(
          'relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border',
          TONE_DOT[cfg.tone] ?? TONE_DOT.neutral,
        )}
      >
        <Icon size={15} />
      </span>

      <div className="min-w-0 flex-1 pt-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <h3 className="text-sm font-medium text-text">{cfg.label}</h3>
          <time className="whitespace-nowrap text-[11px] tabular-nums text-text-3">
            {formatDateTime(node.time)}
          </time>
        </div>

        {showYield && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Badge tone="success">{node.goodQty ?? 0} good</Badge>
            {(node.scrapQty ?? 0) > 0 && <Badge tone="danger">{node.scrapQty} scrapped</Badge>}
          </div>
        )}

        {(node.outputLocation || node.outputExpiry) && (
          <dl className="mt-1.5 space-y-0.5 text-[11px]">
            {node.outputLocation && (
              <div className="flex gap-1.5">
                <dt className="text-text-3">Stocked to</dt>
                <dd className="font-medium text-text-2">{node.outputLocation}</dd>
              </div>
            )}
            {node.outputExpiry && (
              <div className="flex gap-1.5">
                <dt className="text-text-3">Expires</dt>
                <dd className="font-medium text-text-2">{node.outputExpiry}</dd>
              </div>
            )}
          </dl>
        )}

        {node.moves.length > 0 && (
          <ul className="mt-2 space-y-1.5">
            {node.moves.map((m) => (
              <li
                key={m.id}
                className="flex items-center gap-2 rounded-md border border-border/70 bg-bg-elev px-2.5 py-1.5"
              >
                <span
                  className={cn(
                    'w-11 shrink-0 text-right font-mono text-xs font-semibold tabular-nums',
                    m.qty_delta > 0 ? 'text-success' : 'text-danger',
                  )}
                >
                  {m.qty_delta > 0 ? `+${m.qty_delta}` : m.qty_delta}
                </span>
                <span className="shrink-0 font-mono text-xs text-text-2">{m.item_number}</span>
                <span className="truncate text-[11px] text-text-3" title={m.notes ?? undefined}>
                  {m.notes}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}
