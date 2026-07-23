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
  ScrollText,
  Send,
  Undo2,
  X,
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

import { BoxCellPicker, useBoxGrid } from './cell-grid-picker';
import { LocationTreePicker } from './location-tree-picker';
import {
  LotSourcePicker,
  autoFillFifo,
  picksToSources,
  picksTotal,
  picksValid,
  type LotPick,
} from './lot-source-picker';
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
  { key: 'production', label: 'Production', hint: 'Adjust material on the floor' },
  { key: 'closeout', label: 'Close-Out', hint: 'Record output & reconcile' },
  { key: 'review', label: 'Review', hint: 'Confirm the batch, then produce or close' },
] as const;

// Four steps (client 2026-07-22): Issue → Production (adjust only) → Close-Out
// (record output + reconcile) → Review & Close (summary + e-signed close). The
// signature lives on the final Review step; Production no longer gates advance.
function stepModel(status: KitStatus): { completed: number; reachable: number; def: number } {
  switch (status) {
    case 'draft':
      return { completed: 0, reachable: 0, def: 0 };
    case 'issued':
      return { completed: 1, reachable: 3, def: 1 };
    case 'in_production':
      return { completed: 1, reachable: 3, def: 1 };
    case 'closed':
      return { completed: 4, reachable: 3, def: 3 };
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

/** One place a produced batch is stocked. A batch may be split across several
 *  (client 2026-07-23) when one LN2 box can't hold every unit — the rest go to
 *  another box, a freezer, or a shelf. A box row's quantity IS its picked
 *  ``cells``; a bulk row (shelf / freezer) carries a typed ``qty``. */
interface OutputDest {
  key: string;
  location_node_id: string;
  isBox: boolean;
  cells: string[];
  qty: number | null;
}

let _outputDestSeq = 0;
const emptyDest = (): OutputDest => ({
  key: `dest-${_outputDestSeq++}`,
  location_node_id: '',
  isBox: false,
  cells: [],
  qty: null,
});
/** Units this destination will place — cells for a box, the typed qty for bulk. */
const destPlaced = (d: OutputDest): number => (d.isBox ? d.cells.length : d.qty ?? 0);

/** The BOM need for a line, rounded up to whole units (matches the backend). */
const lineNeededQty = (l: ApiKitLine) => Math.ceil(Number(l.needed_qty));

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
  const [produceReauthOpen, setProduceReauthOpen] = React.useState(false);
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
  /** Operator-entered material used per component this batch (≥ recipe need). */
  const [used, setUsed] = React.useState<Record<string, number | null>>({});
  const [returnLoc, setReturnLoc] = React.useState<Record<string, string>>({});
  /** Where the produced OUTPUT is stocked — one or more destinations. A batch is
   *  split across several when one box can't hold every unit (client 2026-07-23);
   *  the common case is a single row. */
  const [outputDests, setOutputDests] = React.useState<OutputDest[]>([emptyDest()]);
  /** Close-out back-flush cells per line, when the return target is a box. */
  const [returnCells, setReturnCells] = React.useState<Record<string, string[]>>({});
  /** Whether each line's return destination resolved to a box (grid) node. */
  const [returnIsBox, setReturnIsBox] = React.useState<Record<string, boolean>>({});
  /** Per-line multi-lot issue picks — held locally, committed only on Issue. */
  const [linePicks, setLinePicks] = React.useState<Record<string, LotPick[]>>({});

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
        setReturnLoc(
          Object.fromEntries(
            k.lines.map((l) => [
              l.id,
              // Default to the source it was pulled from; still editable.
              l.source_location_node_id ?? l.return_location_node_id ?? '',
            ]),
          ),
        );
        // Pre-fill each line's issue with a FIFO split covering the need
        // (KIT-002 "default the issue quantity to the needed amount").
        setLinePicks(
          Object.fromEntries(
            k.lines.map((l) => [l.id, autoFillFifo(l.source_lots, lineNeededQty(l))]),
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
  // Output + back-flush may land on a shelf, freezer sub-location, or an LN2 box
  // (KIT-005) — a box only alongside an explicit free-cell selection.
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

  const run = async (fn: () => Promise<ApiKit>, ok: string, next?: number) => {
    setBusy(true);
    try {
      const k = await fn();
      setKit(k);
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

  // ── Produce / Close readiness (KIT-007 incremental production) ───────────
  // The Close-Out form (good/scrap/output/used) feeds BOTH a "Produce" batch
  // (make units, keep the kit open) and the final "Close". Good accumulates on
  // the kit across produce batches, so a Close with good 0 is valid once earlier
  // batches produced something (it just back-flushes the remainder and locks).
  const producingNow = (output.good_qty ?? 0) >= 1;
  const priorGood = kit.good_qty ?? 0;
  const expiryValid = !output.output_expiration_date || output.output_expiration_date >= todayStr();
  // The good units must be fully placed — across ONE or MORE destinations
  // (client 2026-07-23) when a box can't hold them all. Every row needs a
  // location and a positive quantity (a box row's qty is its picked cells), and
  // the quantities must sum to the good count.
  const outputPlaced = outputDests.reduce((s, d) => s + destPlaced(d), 0);
  const outputRowsFilled = outputDests.every(
    (d) => Boolean(d.location_node_id) && destPlaced(d) > 0,
  );
  const outputComplete = (output.good_qty ?? 0) >= 1 && outputRowsFilled && outputPlaced === (output.good_qty ?? 0);
  // The operator ENTERS the material used per component (client 2026-07-23). It
  // must be at least the recipe need — ceil(qty_per_unit × (good+scrap)); you
  // can't make N units with less than N units' worth — and no more than what's
  // on the floor. Leftover (= floor − used) back-flushes at close.
  const batchAttempt = (output.good_qty ?? 0) + (output.scrap_qty ?? 0);
  const lineNeed = (l: ApiKitLine) => Math.ceil(Number(l.qty_per_unit) * batchAttempt);
  const lineLeft = (l: ApiKitLine) => l.on_floor_qty - (used[l.id] ?? 0);
  const usedComplete = kit.lines.every((l) => used[l.id] !== null && used[l.id] !== undefined);
  const usedBelowNeed = kit.lines.some(
    (l) => used[l.id] != null && (used[l.id] as number) < lineNeed(l),
  );
  const usedOverFloor = kit.lines.some(
    (l) => used[l.id] != null && (used[l.id] as number) > l.on_floor_qty,
  );
  // Whether each line's back-flush destination resolved to a box (grid) node.
  const isBox = (lineId: string) => returnIsBox[lineId] === true;
  // A back-flush into a box needs one free cell per leftover unit (close only).
  const cellsIncomplete = kit.lines.some((l) => {
    const left = lineLeft(l);
    if (left <= 0) return false;
    return isBox(l.id) ? (returnCells[l.id]?.length ?? 0) !== left : false;
  });
  const usedValid = usedComplete && !usedBelowNeed && !usedOverFloor;
  // Produce a batch NOW (keep open): make ≥ 1, with output + valid used. No
  // back-flush, so no return-cell check.
  const produceReady =
    producingNow &&
    output.scrap_qty !== null &&
    expiryValid &&
    outputComplete &&
    usedValid;
  // Close (finalize): cumulative good (prior + this batch) ≥ 1. Output required
  // only if producing a final batch; a good-0 close just back-flushes the rest.
  const closeReady =
    priorGood + (output.good_qty ?? 0) >= 1 &&
    output.scrap_qty !== null &&
    expiryValid &&
    (producingNow ? outputComplete : true) &&
    usedValid &&
    !cellsIncomplete;
  // No recipe gating at issue (KIT-007): a short or even empty issue is allowed
  // — issue for a campaign up front, or assign at point of use and top up later.
  // The ONLY block is physical: a pick can't pull more of a lot than exists.
  const issueBlocked =
    editableDraft &&
    kit.lines.some((l) => !picksValid(l.source_lots, linePicks[l.id] ?? []));

  const onIssue = () =>
    void run(
      () =>
        kitsApi.issue(kit.id, {
          lines: kit.lines.map((l) => ({
            line_id: l.id,
            sources: picksToSources(linePicks[l.id] ?? []),
          })),
        }),
      'Material issued',
      1,
    );

  // Entering close-out: pre-fill each line's Used with the recipe need (the
  // minimum) and default the back-flush location to the source. Both editable.
  const enterCloseOut = () => {
    if (kit.status === 'issued' || kit.status === 'in_production') {
      const attempted = (output.good_qty ?? kit.target_qty) + (output.scrap_qty ?? 0);
      setUsed((prev) => {
        const next = { ...prev };
        for (const l of kit.lines) {
          if (next[l.id] == null) {
            next[l.id] = Math.ceil(Number(l.qty_per_unit) * attempted);
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

  // The produced units, mapped to the API's multi-destination `outputs` (one
  // entry per filled row; a box row sends its cells, a bulk row its qty).
  const buildOutputs = () =>
    outputDests
      .filter((d) => d.location_node_id && destPlaced(d) > 0)
      .map((d) => ({
        location_node_id: d.location_node_id,
        qty: destPlaced(d),
        cells: d.isBox ? d.cells.map(toCell) : [],
      }));

  const onCloseConfirmed = async (evidence: ReauthResponse) => {
    try {
      const k = await kitsApi.closeOut(kit.id, {
        good_qty: output.good_qty ?? 0,
        scrap_qty: output.scrap_qty ?? 0,
        outputs: (output.good_qty ?? 0) >= 1 ? buildOutputs() : [],
        output_expiration_date: output.output_expiration_date || null,
        lines: kit.lines.map((l) => ({
          line_id: l.id,
          used_qty: used[l.id] ?? 0,
          return_location_node_id: returnLoc[l.id] || null,
          return_cells: isBox(l.id) ? (returnCells[l.id] ?? []).map(toCell) : undefined,
        })),
        evidence_id: evidence.evidence_id,
        reason: evidence.comment ?? '',
      });
      setKit(k);
      setActiveStep(3);
      toast.success(`${k.kit_number} closed`, {
        description: `${k.good_qty} × ${k.item_number} stocked; leftovers back-flushed.`,
      });
    } catch (err) {
      toast.error('Close-out failed', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    }
  };

  // Produce a batch and KEEP the kit open (KIT-007). The operator's Used per
  // component is validated server-side (≥ need, ≤ floor). Does NOT back-flush or
  // lock. Afterwards the form resets for the next batch and we land on Review.
  const onProduceConfirmed = async (evidence: ReauthResponse) => {
    try {
      const k = await kitsApi.produce(kit.id, {
        good_qty: output.good_qty!,
        scrap_qty: output.scrap_qty ?? 0,
        outputs: buildOutputs(),
        output_expiration_date: output.output_expiration_date || null,
        lines: kit.lines.map((l) => ({ line_id: l.id, used_qty: used[l.id] as number })),
        evidence_id: evidence.evidence_id,
        reason: evidence.comment ?? '',
      });
      const made = output.good_qty ?? 0;
      setKit(k);
      // Reset the batch form for the next batch.
      setOutput((p) => ({
        good_qty: null,
        scrap_qty: 0,
        output_location_node_id: p.output_location_node_id,
        output_expiration_date: '',
      }));
      setOutputDests([emptyDest()]);
      setUsed(Object.fromEntries(k.lines.map((l) => [l.id, null])));
      setActiveStep(3);
      toast.success(`Produced ${made} × ${k.item_number}`, {
        description: `${k.good_qty} made so far — the kit is still open.`,
      });
    } catch (err) {
      toast.error('Could not produce', {
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
                // Production no longer gates advance (client 2026-07-22, KIT-007).
                // The only forward gate is Review: you can't jump to the signed
                // close until the output + reconciliation are complete.
                const gateBlocked = i === 3 && i > activeStep && !closeReady;
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
                          ? 'Enter the output and used quantities on Close-Out first'
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
            busy={busy}
            picks={linePicks}
            onPicksChange={(lineId, picks) =>
              setLinePicks((prev) => ({ ...prev, [lineId]: picks }))
            }
          />
        )}
        {activeStep === 1 && (
          <ProductionStep
            kit={kit}
            canWrite={canWrite}
            busy={busy}
            onIssueMore={(l) => setAddingTo(l)}
            onReturn={(l) => setReturningFrom(l)}
          />
        )}
        {activeStep === 2 && (
          <CloseOutStep
            kit={kit}
            output={output}
            onOutputChange={setOutput}
            outputAllowedIds={returnableIds}
            outputDests={outputDests}
            onOutputDests={(next) => {
              setOutputDests(next);
              // Keep the draft's primary location in sync for the Review summary.
              setOutput((o) => ({
                ...o,
                output_location_node_id: next[0]?.location_node_id ?? '',
              }));
            }}
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
          />
        )}
        {activeStep === 3 && (
          <ReviewStep
            kit={kit}
            output={output}
            used={used}
            returnLoc={returnLoc}
            nodeOptions={nodeOptions}
            prodName={prodName}
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
            produceReady,
            producingNow,
            issueBlocked,
            onIssue,
            onNext: () => setActiveStep((s) => Math.min(model.reachable, s + 1)),
            onProductionNext,
            onCloseOutNext: () => setActiveStep(3),
            onProduce: () => setProduceReauthOpen(true),
            onProduceAnother: enterCloseOut,
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
          setReturningFrom(null);
        }}
      />

      <PasswordReauthDialog
        open={reauthOpen}
        onOpenChange={setReauthOpen}
        action="kit.closeout"
        meaning={`I am closing kit ${kit.kit_number}: ${output.good_qty ?? 0} good this batch, and back-flushing the leftover.`}
        title="Sign this close-out"
        submitLabel="Close kit"
        commentPlaceholder="e.g. Batch record 2026-07-20"
        onConfirmed={onCloseConfirmed}
      />

      <PasswordReauthDialog
        open={produceReauthOpen}
        onOpenChange={setProduceReauthOpen}
        action="kit.produce"
        meaning={`I am producing ${output.good_qty ?? 0} × ${kit.item_number} for kit ${kit.kit_number}. The kit stays open to produce more.`}
        title="Sign this batch"
        submitLabel="Produce batch"
        commentPlaceholder="e.g. Batch record 2026-07-23"
        onConfirmed={onProduceConfirmed}
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
    produceReady: boolean;
    producingNow: boolean;
    issueBlocked: boolean;
    onIssue: () => void;
    onNext: () => void;
    onProductionNext: () => void;
    onCloseOutNext: () => void;
    onProduce: () => void;
    onProduceAnother: () => void;
    onClose: () => void;
  },
) {
  const open = kit.status === 'issued' || kit.status === 'in_production';
  const nextBtn = (onClick: () => void, disabled = false, title?: string) => (
    <Button variant="primary" onClick={onClick} disabled={ctx.busy || disabled} title={title}>
      Next: {STEPS[activeStep + 1]?.label} <ArrowRight size={14} />
    </Button>
  );
  // Step 0 — Issue.
  if (activeStep === 0) {
    if (kit.status === 'draft')
      return ctx.canWrite ? (
        <Button
          variant="primary"
          onClick={ctx.onIssue}
          disabled={ctx.busy || ctx.issueBlocked}
          title={ctx.issueBlocked ? 'A component pulls more than that lot holds' : undefined}
        >
          Issue material <ArrowRight size={14} />
        </Button>
      ) : (
        <span />
      );
    return model.reachable > 0 ? nextBtn(ctx.onNext) : <span />;
  }
  // Step 1 — Production (adjust only, no gate).
  if (activeStep === 1) return model.reachable > 1 ? nextBtn(ctx.onProductionNext) : <span />;
  // Step 2 — Close-Out: go to Review to confirm the batch, then produce/close
  // there. The button reads "Produce" when a batch is entered (it leads to the
  // Review-and-produce screen), or "Review & close" for a pure finalize.
  if (activeStep === 2 && open) {
    const finalize = !ctx.producingNow;
    const canAdvance = finalize ? ctx.closeReady : ctx.produceReady;
    return (
      <Button
        variant="primary"
        onClick={ctx.onCloseOutNext}
        disabled={ctx.busy || !canAdvance}
        title={canAdvance ? undefined : 'Enter the output and used quantities first'}
      >
        {finalize ? (
          <>
            Review &amp; close <ArrowRight size={14} />
          </>
        ) : (
          <>
            <FlaskConical size={14} /> Produce <ArrowRight size={14} />
          </>
        )}
      </Button>
    );
  }
  // Step 3 — Review: produce THIS batch (keep open) or the signed terminal close.
  if (activeStep === 3 && open)
    return (
      <div className="flex items-center gap-2">
        {ctx.producingNow ? (
          ctx.canSign && (
            <Button
              variant="primary"
              onClick={ctx.onProduce}
              disabled={ctx.busy || !ctx.produceReady}
              title={ctx.produceReady ? 'Make this batch and keep the kit open' : 'Fix the batch on Close-Out first'}
            >
              <FlaskConical size={14} /> Produce this batch
            </Button>
          )
        ) : (
          <Button variant="ghost" onClick={ctx.onProduceAnother} disabled={ctx.busy}>
            Produce another batch
          </Button>
        )}
        {ctx.canSign && (
          <Button
            variant={ctx.producingNow ? 'secondary' : 'primary'}
            onClick={ctx.onClose}
            disabled={!ctx.closeReady || ctx.busy}
            title={ctx.closeReady ? undefined : 'Enter the used quantities (and output, if producing a final batch) first'}
          >
            Sign &amp; close kit <ArrowRight size={14} />
          </Button>
        )}
      </div>
    );
  return <span />;
}

// ── Issue step ────────────────────────────────────────────────────────────

function IssueStep({
  kit,
  nodeOptions,
  editableDraft,
  busy,
  picks,
  onPicksChange,
}: {
  kit: ApiKit;
  nodeOptions: SelectOption[];
  editableDraft: boolean;
  busy: boolean;
  picks: Record<string, LotPick[]>;
  onPicksChange: (lineId: string, picks: LotPick[]) => void;
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

      {editableDraft ? (
        <div className="space-y-3">
          <p className="text-xs text-text-3">
            Pull each component up to its Needed amount. You can draw from several lots/shelves at
            once — <span className="text-text-2">Auto-fill FIFO</span> takes the earliest-expiry lots
            first, or set the quantities by hand. For an LN2 box, tap the exact vials. Then press{' '}
            <span className="text-text-2">Issue material</span> to commit.
          </p>
          {kit.lines.map((line) => {
            const needed = lineNeededQty(line);
            const linePickList = picks[line.id] ?? [];
            return (
              <Card key={line.id} className="p-4">
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <ItemCell
                    itemNumber={line.item_number}
                    description={line.description}
                    itemId={line.item_id}
                  />
                  <div className="flex items-center gap-4 text-xs">
                    <span className="text-text-3">
                      Needed <span className="font-mono text-text">{needed}</span>
                    </span>
                    <span className={cn('text-text-3', line.on_hand <= 0 && 'text-danger')}>
                      On hand <span className="font-mono text-text">{line.on_hand}</span>
                    </span>
                  </div>
                </div>
                <LotSourcePicker
                  itemNumber={line.item_number}
                  lots={line.source_lots}
                  needed={needed}
                  picks={linePickList}
                  onChange={(p) => onPicksChange(line.id, p)}
                  disabled={busy}
                />
              </Card>
            );
          })}
        </div>
      ) : (
        <Card className="p-4">
          <div className="mb-3">
            <h2 className="text-sm font-medium text-text">Issued to production</h2>
            <p className="mt-0.5 text-xs text-text-3">
              A snapshot of what was pulled at issue. Adjustments (issue more / return) and the
              produced output are handled on the next steps.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 text-right font-medium">Needed</th>
                  <th className="px-3 py-2 text-right font-medium">Issued</th>
                  <th className="px-3 py-2 font-medium">Pulled from</th>
                </tr>
              </thead>
              <tbody>
                {kit.lines.map((line) => (
                  <tr key={line.id} className="border-b border-border/60 align-top">
                    <td className="max-w-[280px] px-3 py-2.5">
                      <ItemCell
                        itemNumber={line.item_number}
                        description={line.description}
                        itemId={line.item_id}
                      />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <QtyCell value={Number(line.needed_qty)} title={`×${line.qty_per_unit} per unit`} />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <QtyCell value={line.issued_qty} />
                    </td>
                    <td className="px-3 py-2.5">
                      {line.issued_from.length ? (
                        <div className="flex flex-wrap gap-1.5">
                          {line.issued_from.map((f, idx) => (
                            <span
                              key={idx}
                              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface/60 px-2 py-0.5 text-[11px]"
                              title={f.location}
                            >
                              <span className="font-mono text-text">{f.lot_number ?? 'No lot'}</span>
                              <span className="text-text-3">·</span>
                              <span className="max-w-[160px] truncate text-text-3">{f.location}</span>
                              <span className="font-mono tabular-nums text-text-2">×{f.qty}</span>
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-text-3">
                          {nodeOptions.find((o) => o.value === line.source_location_node_id)?.label ??
                            '—'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <RuleNote>
        Issuing removes the quantity from the source lots immediately — kitted material stops
        counting as on hand. Adjust it on the Production step; reconcile and back-flush at close-out.
      </RuleNote>
    </div>
  );
}

// ── Production step ─────────────────────────────────────────────────────────

function ProductionStep({
  kit,
  canWrite,
  busy,
  onIssueMore,
  onReturn,
}: {
  kit: ApiKit;
  canWrite: boolean;
  busy: boolean;
  onIssueMore: (line: ApiKitLine) => void;
  onReturn: (line: ApiKitLine) => void;
}) {
  const editable = kit.status === 'issued' || kit.status === 'in_production';
  // Need is based on the planned target here — good/scrap are entered at
  // close-out now, so there's no dynamic need on this step (client 2026-07-22).
  const lineNeed = (l: ApiKitLine) => Math.ceil(Number(l.qty_per_unit) * kit.target_qty);
  const onFloorTotal = kit.lines.reduce((a, l) => a + l.on_floor_qty, 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Build target" value={kit.target_qty} hint={kit.item_number} />
        <Stat label="Components" value={kit.lines.length} hint="Staged on the floor" />
        <Stat label="On floor" value={onFloorTotal} hint="Total units in production" />
      </div>

      <Card className="p-4">
        <div className="mb-3">
          <h2 className="text-sm font-medium text-text">Material on the floor</h2>
          <p className="mt-0.5 text-xs text-text-3">
            Adjust what&apos;s staged in production — <span className="text-text-2">issue more</span>{' '}
            if a component runs short, or <span className="text-text-2">return</span> the surplus.
            Needed is for the planned {kit.target_qty} unit{kit.target_qty === 1 ? '' : 's'}; the
            produced output and final reconciliation happen at close-out.
          </p>
        </div>
        {!editable ? (
          <RuleNote>This kit is {kit.status} — there is nothing on the floor to adjust.</RuleNote>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 text-right font-medium">Needed</th>
                  <th className="px-3 py-2 text-right font-medium">Issued</th>
                  <th className="px-3 py-2 text-right font-medium">Additional</th>
                  <th className="px-3 py-2 text-right font-medium">Returned</th>
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
                    <tr key={line.id} className="border-b border-border/60">
                      <td className="max-w-[240px] px-3 py-2">
                        <ItemCell itemNumber={line.item_number} description={line.description} itemId={line.item_id} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <QtyCell value={need} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <QtyCell value={line.issued_qty} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <QtyCell
                          value={line.additional_issued_qty || null}
                          tone={line.additional_issued_qty ? 'success' : 'muted'}
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <QtyCell
                          value={line.early_returned_qty || null}
                          tone={line.early_returned_qty ? 'success' : 'muted'}
                          title="Already handed back to inventory"
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <QtyCell value={floor} />
                      </td>
                      <td className="px-3 py-2">
                        {short ? (
                          <span className="text-xs text-warning">Short {need - floor}</span>
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
                          disabled={!canWrite || busy}
                          onClick={() => onIssueMore(line)}
                        >
                          <Plus size={12} /> Issue more
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!canWrite || busy || floor <= 0}
                          title={
                            floor > 0
                              ? 'Return material to inventory'
                              : 'Nothing on the floor to return'
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
        )}
      </Card>

      <RuleNote>
        Nothing here is final — adjust freely. The produced output is recorded and the leftover
        back-flushed at close-out, in one signed step.
      </RuleNote>
    </div>
  );
}

// ── Output placement (single, or split across locations) ────────────────────

/**
 * Where a produced batch is stocked. The common case is ONE location; when a
 * chosen LN2 box can't hold every unit, "Add another location" lets the rest of
 * the good units go to another box, a freezer, or a shelf (client 2026-07-23).
 * All rows are ONE lot; the quantities must sum to ``good``.
 *
 * A box row picks cells (quantity follows the selection, capped at what's left);
 * a bulk row (shelf / freezer) takes a typed quantity. ``BoxCellPicker`` reports
 * whether a location is a box, so we swap the cell grid for a quantity input.
 */
function OutputPlacement({
  good,
  dests,
  onChange,
  allowedIds,
  required,
  reservedFor,
}: {
  good: number;
  dests: OutputDest[];
  onChange: (next: OutputDest[]) => void;
  allowedIds: Set<string>;
  required: boolean;
  /** Cells claimed by other box pickers in the form (back-flush lines / other
   *  split rows), keyed off this row's node — blocked so no two claim one cell. */
  reservedFor: (nodeId: string | undefined, own: string[]) => Set<string>;
}) {
  const placed = dests.reduce((s, d) => s + destPlaced(d), 0);
  const remaining = good - placed;
  const update = (key: string, patch: Partial<OutputDest>) =>
    onChange(dests.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <label className="text-xs font-medium text-text-2">
          Stock the output to {required && <span className="text-danger">*</span>}
        </label>
        {good > 0 && (
          <span
            className={cn(
              'font-mono text-xs tabular-nums',
              placed === good ? 'text-success' : 'text-text-3',
            )}
          >
            {placed} / {good} placed{remaining > 0 ? ` · ${remaining} to go` : ''}
          </span>
        )}
      </div>

      {dests.map((d, i) => {
        // This row's cap = the good count minus everything the OTHER rows hold.
        const cap = Math.max(0, good - (placed - destPlaced(d)));
        // A location already used by ANOTHER row is off the menu here — to put
        // more units in the same box you pick more cells in that box's own row,
        // not a second row (which the backend rejects as a duplicate anyway).
        const usedElsewhere = new Set(
          dests.filter((x) => x.key !== d.key).map((x) => x.location_node_id).filter(Boolean),
        );
        const rowAllowed = new Set([...allowedIds].filter((id) => !usedElsewhere.has(id)));
        return (
          <div key={d.key} className="rounded-lg border border-border bg-surface/40 p-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <LocationTreePicker
                  aria-label={`Output location ${i + 1}`}
                  value={d.location_node_id}
                  onChange={(v) =>
                    update(d.key, { location_node_id: v, isBox: false, cells: [], qty: null })
                  }
                  areas={['ln2', 'cold', 'warehouse']}
                  allowedNodeIds={rowAllowed}
                  showPath
                  placeholder="Warehouse, freezer, or LN2 box"
                />
              </div>
              {dests.length > 1 && (
                <button
                  type="button"
                  onClick={() => onChange(dests.filter((x) => x.key !== d.key))}
                  aria-label="Remove this location"
                  className="mt-1 grid size-8 shrink-0 place-items-center rounded-md text-text-3 transition-colors hover:bg-surface-2 hover:text-danger focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {d.location_node_id && (
              <div className="mt-2">
                {/* Box → pick cells (quantity follows, capped at what's left).
                    Renders nothing for a shelf / freezer and reports back so we
                    show a quantity input instead. */}
                <BoxCellPicker
                  nodeId={d.location_node_id}
                  qty={cap}
                  derive
                  value={d.cells}
                  onChange={(cells) => update(d.key, { cells })}
                  onResolved={(isBox) => {
                    if (isBox !== d.isBox) update(d.key, { isBox, cells: [], qty: null });
                  }}
                  reserved={reservedFor(d.location_node_id, d.cells)}
                />
                {!d.isBox && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-3">Quantity here</span>
                    <NumberInput
                      aria-label={`Quantity at location ${i + 1}`}
                      value={d.qty}
                      min={1}
                      onChange={(v) => update(d.key, { qty: v == null ? null : Math.min(v, cap) })}
                      className="h-8 w-20"
                    />
                    <span className="text-[11px] text-text-3">of {cap} left</span>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {required && good > 0 && placed !== good && (
        <p className="text-xs text-danger">
          {placed < good
            ? `Place all ${good} unit${good === 1 ? '' : 's'} — ${remaining} still to place.`
            : `Too many placed — remove ${placed - good}.`}
        </p>
      )}

      {remaining > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange([...dests, emptyDest()])}
        >
          <Plus size={14} /> Add another location
        </Button>
      )}
    </div>
  );
}

// ── Close-out step ──────────────────────────────────────────────────────────

function CloseOutStep({
  kit,
  output,
  onOutputChange,
  outputAllowedIds,
  outputDests,
  onOutputDests,
  used,
  onUsed,
  returnLoc,
  onReturnLoc,
  returnCells,
  onReturnCells,
  returnIsBox,
  onReturnIsBox,
  allowedIds,
}: {
  kit: ApiKit;
  output: OutputDraft;
  onOutputChange: (o: OutputDraft) => void;
  outputAllowedIds: Set<string>;
  outputDests: OutputDest[];
  onOutputDests: (next: OutputDest[]) => void;
  used: Record<string, number | null>;
  onUsed: (id: string, v: number | null) => void;
  returnLoc: Record<string, string>;
  onReturnLoc: (id: string, v: string) => void;
  returnCells: Record<string, string[]>;
  onReturnCells: (id: string, v: string[]) => void;
  returnIsBox: Record<string, boolean>;
  onReturnIsBox: (id: string, isBox: boolean) => void;
  allowedIds: Set<string>;
}) {
  const closed = kit.status === 'closed';
  const cancelled = kit.status === 'cancelled';
  const editable = kit.status === 'issued' || kit.status === 'in_production';
  // The produced output is entered HERE (KIT-005), then posted with either
  // "Produce" (keep open) or the signed close on the Review step.
  const goodQty = closed ? kit.good_qty : output.good_qty;
  const scrapQty = closed ? kit.scrap_qty : output.scrap_qty;
  const expiryBad = Boolean(output.output_expiration_date) && output.output_expiration_date < todayStr();
  // Good/scrap accumulate across produce batches (KIT-007). A good of 0 is only
  // valid at CLOSE once earlier batches already produced something.
  const priorGood = kit.good_qty ?? 0;
  const goodRequired = priorGood < 1; // must make ≥ 1 this batch if nothing made yet
  const producingNow = (goodQty ?? 0) >= 1;

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

  // The operator ENTERS Used per component (client 2026-07-23); Needed is the
  // recipe minimum ceil(qty_per_unit × (good+scrap)). Used must be ≥ Needed and
  // ≤ on-floor; the leftover (floor − used) back-flushes at close.
  const attempted = (goodQty ?? 0) + (scrapQty ?? 0);
  const lineNeed = (l: ApiKitLine) => Math.ceil(Number(l.qty_per_unit) * attempted);
  // Changing good/scrap re-syncs each line's Used to the recipe need, so the
  // Used column tracks the target (client 2026-07-23). The operator can still
  // override a line afterwards.
  const setBatch = (next: OutputDraft) => {
    onOutputChange(next);
    const att = (next.good_qty ?? 0) + (next.scrap_qty ?? 0);
    for (const l of kit.lines) {
      onUsed(l.id, Math.ceil(Number(l.qty_per_unit) * att));
    }
  };
  const usedOf = (l: ApiKitLine) => (editable ? used[l.id] : l.used_qty);
  const anyProblem =
    editable &&
    kit.lines.some((l) => {
      const u = used[l.id];
      return u == null || u < lineNeed(l) || u > l.on_floor_qty;
    });
  const consumeTotal = kit.lines.reduce((a, l) => a + (usedOf(l) ?? 0), 0);
  const leftTotal = kit.lines.reduce(
    (a, l) => a + Math.max(0, l.on_floor_qty - (usedOf(l) ?? 0)),
    0,
  );
  const yieldPct = attempted > 0 ? (goodQty ?? 0) / attempted : null;

  // Cells claimed by EVERY box picker in this form (the split-output rows AND
  // the back-flush lines), keyed by node. A cell taken by one picker is blocked
  // in the others so the produced output and a back-flush can share a box but
  // never the same physical position. Recomputed each render → reserves live.
  const claimedByNode = new Map<string, Set<string>>();
  const claimCells = (nodeId: string | undefined, keys: string[]) => {
    if (!nodeId || keys.length === 0) return;
    const set = claimedByNode.get(nodeId) ?? new Set<string>();
    keys.forEach((k) => set.add(k));
    claimedByNode.set(nodeId, set);
  };
  outputDests.forEach((d) => {
    if (d.isBox) claimCells(d.location_node_id, d.cells);
  });
  kit.lines.forEach((l) => {
    if (returnIsBox[l.id]) claimCells(returnLoc[l.id], returnCells[l.id] ?? []);
  });
  const reservedFor = (nodeId: string | undefined, own: string[]): Set<string> => {
    const all = nodeId ? claimedByNode.get(nodeId) : undefined;
    if (!all) return new Set();
    const ownSet = new Set(own);
    return new Set([...all].filter((k) => !ownSet.has(k)));
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Making (good)" value={goodQty ?? 0} tone="success" hint="This batch" />
        <Stat
          label="Scrapped"
          value={scrapQty ?? 0}
          tone={(scrapQty ?? 0) > 0 ? 'danger' : 'default'}
          hint="Consumed, no output"
        />
        <Stat
          label={editable ? 'Consumes' : 'Consumed'}
          value={consumeTotal}
          tone={anyProblem ? 'danger' : 'default'}
          hint={editable ? 'Material from the floor' : 'Total across batches'}
        />
        <Stat
          label="Left on floor"
          value={leftTotal}
          tone="success"
          hint={editable ? 'Back-flushes at close' : 'Back-flushed'}
        />
      </div>

      {/* Production output — entered here, posted by Produce (keep open) or Close. */}
      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-text">This batch</h2>
            <p className="mt-0.5 text-xs text-text-3">
              {closed
                ? 'Posted at close-out.'
                : priorGood > 0
                  ? `${priorGood} already produced. Enter the next batch, then Produce (keep open) or Sign & close.`
                  : 'What this batch yielded — post it with Produce (keep open) or Sign & close.'}
            </p>
          </div>
          {yieldPct !== null && (
            <span
              className={cn(
                'shrink-0 rounded-full px-2.5 py-1 text-xs font-medium',
                yieldPct >= 1
                  ? 'bg-success-soft text-success'
                  : yieldPct >= 0.8
                    ? 'bg-warning-soft text-warning'
                    : 'bg-danger-soft text-danger',
              )}
            >
              {Math.round(yieldPct * 100)}% yield
            </span>
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-2">Quantity made (good)</label>
            <NumberInput
              aria-label="Quantity made"
              value={goodQty}
              min={0}
              disabled={closed}
              invalid={!closed && goodRequired && (goodQty ?? 0) < 1}
              onChange={(v) => setBatch({ ...output, good_qty: v })}
              className="h-8 w-full"
            />
            {!closed && goodRequired && (goodQty ?? 0) < 1 ? (
              <p className="mt-1 text-xs text-danger">Must be at least 1 good unit.</p>
            ) : (
              !closed &&
              !goodRequired &&
              (goodQty ?? 0) < 1 && (
                <p className="mt-1 text-[11px] text-text-3">0 is fine — closing just back-flushes.</p>
              )
            )}
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-2">Quantity scrapped</label>
            <NumberInput
              aria-label="Quantity scrapped"
              value={scrapQty}
              disabled={closed}
              onChange={(v) => setBatch({ ...output, scrap_qty: v })}
              className="h-8 w-full"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-2">
              Expiry of the {kit.item_number}
            </label>
            <Input
              type="date"
              aria-label="Output expiry date"
              value={closed ? '' : output.output_expiration_date}
              min={todayStr()}
              disabled={closed}
              onChange={(e) => onOutputChange({ ...output, output_expiration_date: e.target.value })}
            />
            {!closed && expiryBad ? (
              <p className="mt-1 text-xs text-danger">Expiry can’t be in the past.</p>
            ) : (
              <p className="mt-1 text-[11px] text-text-3">Optional — carried onto the produced lot.</p>
            )}
          </div>
        </div>

        {/* Where the produced units go — one location, or SPLIT across several
            (client 2026-07-23) when one LN2 box can't hold every unit. */}
        {!closed ? (
          <div className="mt-4 border-t border-border pt-4">
            <OutputPlacement
              good={goodQty ?? 0}
              dests={outputDests}
              onChange={onOutputDests}
              allowedIds={outputAllowedIds}
              required={producingNow}
              reservedFor={reservedFor}
            />
          </div>
        ) : (
          kit.output_location_node_id && (
            <div className="mt-4 border-t border-border pt-4">
              <label className="mb-1.5 block text-xs font-medium text-text-2">Stocked the output to</label>
              <LocationTreePicker
                aria-label="Output location"
                value={kit.output_location_node_id}
                onChange={() => {}}
                areas={['ln2', 'cold', 'warehouse']}
                disabled
                showPath
              />
            </div>
          )
        )}
      </Card>

      {editable ? (
        <Card className="p-4">
          <div className="mb-3">
            <h2 className="text-sm font-medium text-text">Material this batch consumes</h2>
            <p className="mt-0.5 text-xs text-text-3">
              Enter how much of each component you used. It must be at least the recipe{' '}
              <span className="text-text-2">Needs</span> — making {attempted} unit
              {attempted === 1 ? '' : 's'} takes at least that much — and no more than what&apos;s on
              the floor. The leftover back-flushes when you <span className="text-text-2">close</span>.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                  <th className="px-3 py-2 font-medium">Component</th>
                  <th className="px-3 py-2 text-right font-medium">Per unit</th>
                  <th className="px-3 py-2 text-right font-medium">Needs</th>
                  <th className="px-3 py-2 text-right font-medium">On floor</th>
                  <th className="px-3 py-2 text-right font-medium">Used</th>
                  <th className="px-3 py-2 text-right font-medium">Left</th>
                  <th className="px-3 py-2 font-medium">Back-flush to (at close)</th>
                </tr>
              </thead>
              <tbody>
                {kit.lines.map((line) => {
                  const need = lineNeed(line);
                  const floor = line.on_floor_qty;
                  const u = used[line.id];
                  const left = floor - (u ?? 0);
                  const cantMake = need > floor; // even the minimum doesn't fit
                  const belowNeed = u != null && u < need;
                  const overFloor = u != null && u > floor;
                  const rowBad = cantMake || belowNeed || overFloor;
                  return (
                    <React.Fragment key={line.id}>
                      <tr className={cn('border-b border-border/60', rowBad && 'bg-danger-soft/30')}>
                        <td className="max-w-[240px] px-3 py-2">
                          <ItemCell itemNumber={line.item_number} description={line.description} itemId={line.item_id} />
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-text-2">
                          {Number(line.qty_per_unit)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <QtyCell value={need} tone={cantMake ? 'danger' : undefined} />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <QtyCell value={floor} tone={cantMake ? 'danger' : undefined} />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <NumberInput
                            aria-label={`Used for ${line.item_number}`}
                            value={u ?? null}
                            min={0}
                            invalid={belowNeed || overFloor || cantMake}
                            onChange={(v) => onUsed(line.id, v)}
                            className="w-16"
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          {u == null ? (
                            <span className="text-xs text-text-3">—</span>
                          ) : (
                            <QtyCell value={left} tone={left > 0 ? 'success' : 'muted'} />
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {left > 0 ? (
                            <div className="w-52">
                              <LocationTreePicker
                                aria-label={`Back-flush location for ${line.item_number}`}
                                value={returnLoc[line.id] ?? ''}
                                onChange={(v) => onReturnLoc(line.id, v)}
                                areas={['ln2', 'cold', 'warehouse']}
                                allowedNodeIds={allowedIds}
                                showPath
                              />
                            </div>
                          ) : (
                            <span className="text-xs text-text-3">Nothing left</span>
                          )}
                        </td>
                      </tr>
                      {(cantMake || belowNeed || overFloor) && (
                        <tr className="bg-danger-soft/30">
                          <td colSpan={7} className="px-3 pb-2 text-xs text-danger">
                            {cantMake
                              ? `Not enough on the floor — ${need} needed to make ${attempted}, only ${floor} here. Issue more first.`
                              : belowNeed
                                ? `Use at least ${need} to make ${attempted} unit${attempted === 1 ? '' : 's'}.`
                                : `Only ${floor} on the floor.`}
                          </td>
                        </tr>
                      )}
                      {/* Cryobox grid gets its own full-width row for the leftover. */}
                      {left > 0 && (
                        <tr
                          className={cn(
                            'border-b border-border/60',
                            returnIsBox[line.id] && 'bg-surface/40',
                          )}
                        >
                          <td colSpan={7} className={cn(returnIsBox[line.id] ? 'px-3 pb-3 pt-0' : 'p-0')}>
                            <div className="max-w-xl">
                              <BoxCellPicker
                                nodeId={returnLoc[line.id]}
                                qty={left}
                                value={returnCells[line.id] ?? []}
                                onChange={(v) => onReturnCells(line.id, v)}
                                onResolved={(isBox) => onReturnIsBox(line.id, isBox)}
                                reserved={reservedFor(returnLoc[line.id], returnCells[line.id] ?? [])}
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
      ) : (
        <Card className="p-4">
          <RuleNote>Posted — see the Review step for the full component summary.</RuleNote>
        </Card>
      )}

      {closed && (
        <Card className="flex items-start gap-3 border-success/30 bg-success-soft/40 p-4">
          <Check size={16} className="mt-0.5 shrink-0 text-success" />
          <div className="text-sm">
            <div className="font-medium text-text">Kit closed</div>
            <p className="mt-1 text-xs text-text-2">
              {kit.good_qty} × {kit.item_number} stocked
              {(kit.scrap_qty ?? 0) > 0 && ` (${kit.scrap_qty} scrapped)`}, and {leftTotal} unit
              {leftTotal === 1 ? '' : 's'} back-flushed to inventory.
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}

// ── Review & Close step ──────────────────────────────────────────────────────

function ReviewStep({
  kit,
  output,
  used,
  returnLoc,
  nodeOptions,
  prodName,
}: {
  kit: ApiKit;
  output: OutputDraft;
  used: Record<string, number | null>;
  returnLoc: Record<string, string>;
  nodeOptions: SelectOption[];
  /** Resolved production-floor name (production nodes aren't in nodeOptions). */
  prodName: string;
}) {
  const closed = kit.status === 'closed';
  // Good/scrap accumulate on the kit across produce batches (KIT-007).
  const producedSoFar = kit.good_qty ?? 0;
  const scrapSoFar = kit.scrap_qty ?? 0;
  const pendingGood = closed ? 0 : output.good_qty ?? 0; // a batch entered but not yet made
  const pendingScrap = closed ? 0 : output.scrap_qty ?? 0;
  const producingNow = pendingGood >= 1;
  const totalMade = producedSoFar + scrapSoFar;
  const yieldPct = totalMade > 0 ? producedSoFar / totalMade : null;
  const label = (id: string | null | undefined) =>
    id ? (nodeOptions.find((o) => o.value === id)?.label ?? '—') : '—';
  const outLoc = closed ? kit.output_location_node_id : output.output_location_node_id;
  // ``on_floor_qty`` already nets out cumulative used, so it is the material
  // still physically on the floor — which is exactly what back-flushes at close.
  const floorTotal = kit.lines.reduce((a, l) => a + l.on_floor_qty, 0);
  const usedTotal = kit.lines.reduce((a, l) => a + (l.used_qty ?? 0), 0);

  return (
    <div className="space-y-4">
      {/* Producing NOW — detail of the batch about to be made (the "Produce"
          button posts exactly this and keeps the kit open). */}
      {producingNow && (
        <Card className="border-accent/40 bg-accent-soft/15 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-accent">Producing now</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-3xl font-semibold text-text">{pendingGood}</span>
                <span className="text-text-3">×</span>
                <span className="font-mono text-lg text-text">{kit.item_number}</span>
                {pendingScrap > 0 && (
                  <span className="text-sm text-text-3">+ {pendingScrap} scrap</span>
                )}
              </div>
              <div className="mt-0.5 text-sm text-text-2">
                Stocking to <span className="text-text">{label(outLoc)}</span>
              </div>
            </div>
          </div>
          <div className="mt-3 overflow-x-auto rounded-md border border-border bg-bg-elev/50">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-text-3">
                  <th className="px-3 py-1.5 font-medium">Component</th>
                  <th className="px-3 py-1.5 text-right font-medium">Uses</th>
                  <th className="px-3 py-1.5 text-right font-medium">Left after</th>
                </tr>
              </thead>
              <tbody>
                {kit.lines.map((line) => {
                  const u = used[line.id] ?? 0;
                  return (
                    <tr key={line.id} className="border-b border-border/60 last:border-0">
                      <td className="px-3 py-1.5">
                        <span className="font-mono text-xs text-text">{line.item_number}</span>
                        <span className="ml-2 text-text-3">{line.description}</span>
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-text">{u}</td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-text-2">
                        {line.on_floor_qty - u}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-text-3">
            Press <span className="text-text-2">Produce this batch</span> to make these and keep the
            kit open, or <span className="text-text-2">Sign &amp; close</span> to make them and
            finish (the remainder back-flushes).
          </p>
        </Card>
      )}

      {/* Headline: cumulative production. */}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wider text-text-3">
                {closed ? 'Produced' : 'Produced so far'}
              </span>
              {!closed && (
                <Badge tone="warning" className="text-[10px]">
                  Kit open
                </Badge>
              )}
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-3xl font-semibold text-text">{producedSoFar}</span>
              {!closed && <span className="text-sm text-text-3">of {kit.target_qty} target</span>}
              <span className="text-text-3">·</span>
              <span className="font-mono text-lg text-text">{kit.item_number}</span>
            </div>
            <div className="mt-0.5 text-sm text-text-2">{kit.description}</div>
            {!closed && pendingGood > 0 && (
              <p className="mt-1 text-xs text-accent">
                Sign &amp; close will make {pendingGood} more, then finish the kit.
              </p>
            )}
          </div>
          {yieldPct !== null && (
            <div className="text-right">
              <div className="text-[11px] uppercase tracking-wider text-text-3">Yield</div>
              <div
                className={cn(
                  'text-3xl font-semibold',
                  yieldPct >= 1 ? 'text-success' : yieldPct >= 0.8 ? 'text-warning' : 'text-danger',
                )}
              >
                {Math.round(yieldPct * 100)}%
              </div>
              <div className="text-[11px] text-text-3">
                {producedSoFar} good · {scrapSoFar} scrap
              </div>
            </div>
          )}
        </div>
        <dl className="mt-4 grid gap-3 border-t border-border pt-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-[11px] uppercase tracking-wider text-text-3">Built at</dt>
            <dd className="mt-0.5 text-text-2">{prodName || 'Production floor'}</dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-wider text-text-3">Output stored to</dt>
            <dd className="mt-0.5 text-text-2">{label(outLoc)}</dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-wider text-text-3">
              {closed ? 'Consumed / returned' : 'Consumed / on floor'}
            </dt>
            <dd className="mt-0.5 text-text-2">
              <span className="font-mono">{usedTotal}</span> used ·{' '}
              <span className="font-mono">{floorTotal}</span>{' '}
              {closed ? 'back to stock' : 'still on floor'}
            </dd>
          </div>
        </dl>
      </Card>

      {/* Per-component summary. */}
      <Card className="p-4">
        <div className="mb-3">
          <h2 className="text-sm font-medium text-text">Component summary</h2>
          <p className="mt-0.5 text-xs text-text-3">
            {closed
              ? 'What the kit consumed and what returned to inventory.'
              : 'Consumed so far and what is still staged on the floor. Produce another batch, or sign & close to finish (the remainder back-flushes).'}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                <th className="px-3 py-2 font-medium">Component</th>
                <th className="px-3 py-2 font-medium">Issued from</th>
                <th className="px-3 py-2 text-right font-medium">Used</th>
                <th className="px-3 py-2 text-right font-medium">
                  {closed ? 'Back-flushed' : 'On floor'}
                </th>
                <th className="px-3 py-2 font-medium">
                  {closed ? 'Returned to' : 'Back-flushes to'}
                </th>
              </tr>
            </thead>
            <tbody>
              {kit.lines.map((line) => (
                <tr key={line.id} className="border-b border-border/60 align-top">
                  <td className="max-w-[220px] px-3 py-2.5">
                    <ItemCell itemNumber={line.item_number} description={line.description} itemId={line.item_id} />
                  </td>
                  <td className="px-3 py-2.5">
                    {line.issued_from.length ? (
                      <div className="flex flex-wrap gap-1">
                        {line.issued_from.map((f, idx) => (
                          <span
                            key={idx}
                            className="inline-flex items-center gap-1 rounded border border-border bg-surface/60 px-1.5 py-0.5 text-[11px]"
                            title={f.location}
                          >
                            <span className="font-mono text-text">{f.lot_number ?? 'No lot'}</span>
                            <span className="font-mono tabular-nums text-text-2">×{f.qty}</span>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-text-3">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <QtyCell value={line.used_qty ?? null} />
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <QtyCell
                      value={line.on_floor_qty || null}
                      tone={line.on_floor_qty ? 'success' : 'muted'}
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="text-xs text-text-2">
                      {line.on_floor_qty > 0
                        ? label(closed ? line.return_location_node_id : returnLoc[line.id])
                        : '—'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {closed ? (
        <Card className="flex items-start gap-3 border-success/30 bg-success-soft/40 p-4">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" />
          <div className="text-sm">
            <div className="font-medium text-text">Kit closed</div>
            <p className="mt-1 text-xs text-text-2">
              {producedSoFar} × {kit.item_number} stocked
              {scrapSoFar > 0 && ` (${scrapSoFar} scrapped)`}; {floorTotal} unit
              {floorTotal === 1 ? '' : 's'} back-flushed to inventory.
            </p>
          </div>
        </Card>
      ) : (
        <RuleNote>
          <span className="text-text-2">Produce another batch</span> to make more (the kit stays
          open), or <span className="text-text-2">Sign &amp; close</span> to finish — the{' '}
          {floorTotal} unit{floorTotal === 1 ? '' : 's'} still on the floor back-flush to inventory.
        </RuleNote>
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
  const [picks, setPicks] = React.useState<LotPick[]>([]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!line) return;
    // Start with one blank row — the operator adds lots/quantities directly.
    setPicks(line.source_lots.length ? autoFillFifo(line.source_lots, 0) : []);
  }, [line?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!line) return null;

  const issuedSoFar = lineIssuedTotal(line);
  const totalAvail = line.source_lots.reduce((a, l) => a + l.qty, 0);
  const adding = picksTotal(picks);
  const ready = adding > 0 && picksValid(line.source_lots, picks);

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const k = await kitsApi.additionalIssue(kit.id, line.id, {
        sources: picksToSources(picks),
      });
      toast.success('Additional material issued', {
        description: `${adding} × ${line.item_number}.`,
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
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Issue more to {kit.kit_number}</DialogTitle>
          <DialogDescription>
            Production needed extra material. Draw it from any lots or shelves — this posts as a
            separate additional issue and adds to what&apos;s on the floor.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {/* Component + at-a-glance numbers. */}
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-surface/50 p-3">
            <ItemCell itemNumber={line.item_number} description={line.description} itemId={line.item_id} />
            <div className="flex items-center gap-5 text-center">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-text-3">Issued</div>
                <div className="font-mono text-sm text-text">{issuedSoFar}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-text-3">In stock</div>
                <div className={cn('font-mono text-sm', totalAvail <= 0 ? 'text-danger' : 'text-text')}>
                  {totalAvail}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-text-3">Adding</div>
                <div className="font-mono text-sm font-semibold text-accent">{adding}</div>
              </div>
            </div>
          </div>

          <LotSourcePicker
            itemNumber={line.item_number}
            lots={line.source_lots}
            needed={0}
            picks={picks}
            onChange={setPicks}
            disabled={busy}
            modal
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || !ready}>
            <PackagePlus size={14} /> Issue {adding}
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
  // No recipe cap (KIT-007): you may hand back anything up to what's physically
  // on the floor, even below the BOM requirement. The only limit is arithmetic.
  const maxReturn = onFloor;
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
          <dl className="grid grid-cols-2 gap-2 text-center">
            <div className="rounded-md border border-border bg-bg-elev p-2" title="Everything here can be returned">
              <dt className="text-[11px] uppercase tracking-wider text-text-3">On floor</dt>
              <dd
                className={cn('mt-0.5 font-mono text-sm', onFloor <= 0 ? 'text-danger' : 'text-text')}
              >
                {onFloor}
              </dd>
            </div>
            <div className="rounded-md border border-border bg-bg-elev p-2">
              <dt className="text-[11px] uppercase tracking-wider text-text-3">Already returned</dt>
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
  /** Material this batch consumed (produce / close) — no stock movement backs it. */
  consumed: ApiKitAuditEvent['consumed'];
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
      consumed: ev.consumed ?? [],
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
      consumed: [],
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

        {node.consumed.length > 0 && (
          <div className="mt-2">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-text-3">
              Consumed this batch
            </p>
            <ul className="space-y-1.5">
              {node.consumed.map((c) => (
                <li
                  key={c.item_id}
                  className="flex items-center gap-2 rounded-md border border-border/70 bg-bg-elev px-2.5 py-1.5"
                >
                  <span className="w-11 shrink-0 text-right font-mono text-xs font-semibold tabular-nums text-danger">
                    −{c.qty}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-text-2">{c.item_number}</span>
                  <span className="truncate text-[11px] text-text-3">used to build</span>
                </li>
              ))}
            </ul>
          </div>
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
