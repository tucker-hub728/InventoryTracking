'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Check,
  ChevronLeft,
  PackageSearch,
  Plus,
  ScrollText,
  Undo2,
} from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useConfirm } from '@/components/ui/confirm-dialog';
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
  MOVEMENT_TYPE_LABEL,
  kitsApi,
  type ApiKit,
  type ApiKitActivityRow,
  type ApiKitLine,
  type KitStatus,
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

export function KitDetailClient({ kitId }: { kitId: string }) {
  const canSign = usePermission('inventory', 'sign');
  const canWrite = usePermission('inventory', 'create');
  const { confirm, confirmDialog } = useConfirm();

  const [kit, setKit] = React.useState<ApiKit | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [nodes, setNodes] = React.useState<LocationNode[]>([]);
  const [activeStep, setActiveStep] = React.useState(0);
  const [busy, setBusy] = React.useState(false);

  const [activityOpen, setActivityOpen] = React.useState(false);
  const [reauthOpen, setReauthOpen] = React.useState(false);
  const [addingTo, setAddingTo] = React.useState<ApiKitLine | null>(null);
  const [returningFrom, setReturningFrom] = React.useState<ApiKitLine | null>(null);
  const [cancelOpen, setCancelOpen] = React.useState(false);

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
          crumbs={[{ label: 'Kitting & Reconciliation', href: '/reconciliation' }]}
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
          crumbs={[{ label: 'Kitting & Reconciliation', href: '/reconciliation' }]}
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

  const outputReady =
    output.good_qty !== null &&
    output.scrap_qty !== null &&
    output.good_qty + output.scrap_qty > 0 &&
    Boolean(output.output_location_node_id);
  // The output location is required — close-out places the produced quantity
  // there — so the Production step can't be left until it's chosen. A closed or
  // cancelled kit is read-only, so navigation stays open.
  const productionEditable = kit.status === 'issued' || kit.status === 'in_production';
  const productionReady = !productionEditable || Boolean(output.output_location_node_id);
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
  const closeReady = outputReady && usedComplete && overUse.length === 0 && !cellsIncomplete;
  // Task 2: can't issue more than the chosen source location holds — checked
  // against the local draft (nothing is saved until Issue is pressed).
  const issueBlocked =
    editableDraft &&
    kit.lines.some((l) => {
      const d = lineDraft[l.id];
      if (!d || d.issued_qty <= 0) return false;
      if (!d.source) return true; // a line that issues needs a source
      // For a box, quantity IS the cell count, so the only failure mode is
      // picking nothing; bulk sources are capped by what the location holds.
      if (isGridSource(l, d.source)) return d.cells.length === 0;
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

  // Production step: persist good/scrap/output when advancing to close-out, so
  // the figures survive a reload (the signed commit is still close-out).
  const onProductionNext = () => {
    if (kit.status === 'issued' || kit.status === 'in_production') {
      void run(
        () =>
          kitsApi.saveProduction(kit.id, {
            good_qty: output.good_qty,
            scrap_qty: output.scrap_qty,
            output_location_node_id: output.output_location_node_id || null,
          }),
        'Production saved',
        2,
      );
    } else {
      setActiveStep(2);
    }
  };

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

  const onCancel = async () => {
    // A draft has moved nothing, so a plain confirm is honest. Post-issue,
    // material has to go somewhere specific — that needs a real dialog (D1).
    if (!editableDraft) {
      setCancelOpen(true);
      return;
    }
    const ok = await confirm({
      title: `Cancel ${kit.kit_number}?`,
      destructive: true,
      confirmLabel: 'Cancel kit',
      cancelLabel: 'Keep kit',
      description: 'This kit is a draft, so no material has moved.',
    });
    if (!ok) return;
    void run(() => kitsApi.cancel(kit.id), `${kit.kit_number} cancelled`);
  };

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Kitting & Reconciliation', href: '/reconciliation' }, { label: kit.kit_number }]}
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
                return (
                  <li key={step.key} className="flex flex-1 items-center last:flex-none">
                    <button
                      type="button"
                      disabled={!isReachable}
                      onClick={() => setActiveStep(i)}
                      aria-current={isCurrent ? 'step' : undefined}
                      className={cn(
                        'group flex items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:px-3',
                        isReachable ? 'hover:bg-surface' : 'cursor-not-allowed opacity-50',
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
          <ProductionStep kit={kit} output={output} onChange={setOutput} allowedIds={placeableIds} />
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
        onDone={(k) => {
          setCancelOpen(false);
          setKit(k);
          setActiveStep(stepModel(k.status).def);
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

      <ActivitySheet kitId={kit.id} kitNumber={kit.kit_number} open={activityOpen} onOpenChange={setActivityOpen} />
      {confirmDialog}
    </>
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
        title={ctx.productionReady ? undefined : 'Choose where to stock the output first'}
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
          label="Total issued"
          value={kit.lines.reduce((a, l) => a + lineIssuedTotal(l), 0)}
          hint="Units out of storage"
        />
        <Stat label="Status" value={editableDraft ? 'Draft' : 'Issued'} hint={editableDraft ? 'Nothing moved yet' : 'Stock decremented'} />
      </div>

      <Card className="p-4">
        <div className="mb-3">
          <h2 className="text-sm font-medium text-text">Kit structure</h2>
          <p className="mt-0.5 text-xs text-text-3">
            {editableDraft
              ? 'Quantity Needed comes from the BOM. Quantity Issued is what you pull — edit it, then press Issue material to commit.'
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
                <th className="px-3 py-2 text-right font-medium">Additional</th>
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
                const noSource = editableDraft && d.issued_qty > 0 && !d.source;
                // A box can't be over-issued — quantity is the cell count — but
                // it can be under-picked (zero cells chosen).
                const over =
                  editableDraft && Boolean(d.source) && !grid && d.issued_qty > sourceQty(line, d.source);
                const noCells = editableDraft && grid && d.cells.length === 0;
                const invalid = over || noSource || noCells;
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
                              over ? 'text-danger' : 'text-text-3',
                            )}
                          >
                            {hereQty} at source
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {editableDraft ? (
                        grid ? (
                          // LN2: the quantity is however many cells were picked,
                          // so the input becomes a derived read-out (D2).
                          <div className="flex flex-col items-end leading-tight">
                            <QtyCell
                              value={d.cells.length}
                              tone={d.cells.length === 0 ? 'danger' : undefined}
                            />
                            <span className="mt-0.5 text-[10px] uppercase tracking-wide text-text-3">
                              from cells
                            </span>
                          </div>
                        ) : (
                          <NumberInput
                            aria-label={`Issued for ${line.item_number}`}
                            value={d.issued_qty}
                            invalid={invalid}
                            onChange={(v) => onDraftChange(line.id, { issued_qty: v ?? 0 })}
                          />
                        )
                      ) : (
                        <QtyCell value={line.issued_qty} />
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <QtyCell
                        value={line.additional_issued_qty || null}
                        tone={line.additional_issued_qty ? 'success' : 'muted'}
                      />
                    </td>
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
}: {
  kit: ApiKit;
  output: OutputDraft;
  onChange: (o: OutputDraft) => void;
  allowedIds: Set<string>;
}) {
  const closed = kit.status === 'closed' || kit.status === 'cancelled';
  const made = closed ? kit.good_qty : output.good_qty;
  const scrap = closed ? kit.scrap_qty : output.scrap_qty;
  const total = (made ?? 0) + (scrap ?? 0);
  const yieldPct = total > 0 ? (made ?? 0) / total : null;

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
              disabled={closed}
              onChange={(v) => onChange({ ...output, good_qty: v })}
              className="h-8 w-full text-sm"
            />
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
              disabled={closed}
              onChange={(e) => onChange({ ...output, output_expiration_date: e.target.value })}
            />
            <p className="mt-1 text-xs text-text-3">
              Carried onto the produced lot so it appears in expiry reporting.
            </p>
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
      </Card>

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
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Lines to reconcile" value={kit.lines.length} />
        <Stat label="Awaiting used qty" value={pending} tone={pending > 0 ? 'warning' : 'success'} />
        <Stat label="To back-flush" value={totalReturned} tone="success" hint="Units returning to stock" />
      </div>

      <Card className="p-4">
        <div className="mb-3">
          <h2 className="text-sm font-medium text-text">Reconciliation</h2>
          <p className="mt-0.5 text-xs text-text-3">
            Enter Quantity Used from the traveler. Anything left over returns to inventory as an
            explicit back-flush.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 text-right font-medium">On floor</th>
                <th className="px-3 py-2 text-right font-medium">Used</th>
                <th className="px-3 py-2 text-right font-medium">Returned</th>
                <th className="px-3 py-2 font-medium">Return location</th>
              </tr>
            </thead>
            <tbody>
              {kit.lines.map((line) => {
                const over = overUse.some((l) => l.id === line.id);
                const ret = returned(line);
                return (
                  <React.Fragment key={line.id}>
                    <tr className={cn('border-b border-border/60', over && 'bg-danger-soft/30')}>
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
                        {editable ? (
                          <NumberInput
                            aria-label={`Used for ${line.item_number}`}
                            value={used[line.id] ?? null}
                            invalid={over}
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
                        <td colSpan={5} className="px-3 pb-2 text-xs text-danger">
                          Used exceeds what is on the floor by{' '}
                          {(used[line.id] as number) - line.on_floor_qty}. Record an additional
                          issue to cover it.
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
                          colSpan={5}
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
  const over = (qty ?? 0) > onFloor;
  const cellsReady = !destGrid || cells.length === (qty ?? 0);
  const ready = Boolean(qty && qty > 0 && !over && node && cellsReady);

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const k = await kitsApi.returnExcess(kit.id, line.id, {
        qty: qty as number,
        return_location_node_id: node,
        return_cells: destGrid
          ? cells.map(toCell)
          : undefined,
        reason: reason.trim() || null,
      });
      toast.success('Returned to inventory', {
        description: `${qty} × ${line.item_number} back in stock.`,
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
          <dl className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-md border border-border bg-bg-elev p-2">
              <dt className="text-[11px] uppercase tracking-wider text-text-3">Issued</dt>
              <dd className="mt-0.5 font-mono text-sm text-text">{lineIssuedTotal(line)}</dd>
            </div>
            <div className="rounded-md border border-border bg-bg-elev p-2">
              <dt className="text-[11px] uppercase tracking-wider text-text-3">Returned</dt>
              <dd className="mt-0.5 font-mono text-sm text-text">{line.early_returned_qty}</dd>
            </div>
            <div className="rounded-md border border-border bg-bg-elev p-2">
              <dt className="text-[11px] uppercase tracking-wider text-text-3">On floor</dt>
              <dd
                className={cn('mt-0.5 font-mono text-sm', onFloor <= 0 ? 'text-danger' : 'text-text')}
              >
                {onFloor}
              </dd>
            </div>
          </dl>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-2">Return quantity</label>
            <NumberInput
              aria-label="Return quantity"
              value={qty}
              min={1}
              invalid={over}
              onChange={setQty}
            />
            {over && (
              <p className="mt-1 text-xs text-danger">Only {onFloor} on the production floor.</p>
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
            <BoxCellPicker nodeId={node} qty={qty ?? 0} value={cells} onChange={setCells} />
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
            Return {qty ?? 0}
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
  onDone,
}: {
  kit: ApiKit;
  open: boolean;
  allowedIds: Set<string>;
  onOpenChange: (open: boolean) => void;
  onDone: (kit: ApiKit) => void;
}) {
  const lines = React.useMemo(() => kit.lines.filter((l) => l.on_floor_qty > 0), [kit.lines]);
  const [loc, setLoc] = React.useState<Record<string, string>>({});
  const [cells, setCells] = React.useState<Record<string, string[]>>({});
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  // Default each line to where it was pulled from (D1).
  React.useEffect(() => {
    if (!open) return;
    setLoc(
      Object.fromEntries(
        lines.map((l) => [l.id, l.return_location_node_id ?? l.source_location_node_id ?? '']),
      ),
    );
    setCells({});
    setReason('');
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

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const k = await kitsApi.cancel(kit.id, {
        reason: reason.trim() || null,
        lines: lines.map((l) => {
          const node = loc[l.id] ?? '';
          return {
            line_id: l.id,
            return_location_node_id: node,
            return_cells: isBoxMap[l.id] ? (cells[l.id] ?? []).map(toCell) : undefined,
          };
        }),
      });
      toast.success(`${k.kit_number} cancelled`, {
        description: `${totalUnits} unit${totalUnits === 1 ? '' : 's'} returned to inventory.`,
      });
      onDone(k);
    } catch (err) {
      toast.error('Could not cancel', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Cancel {kit.kit_number}?</DialogTitle>
          <DialogDescription>
            {totalUnits} unit{totalUnits === 1 ? '' : 's'} still on the production floor will be
            returned to inventory as a back-flush. Choose where each component goes — each is
            pre-set to where it was pulled from. This cannot be undone.
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
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-2">
              Reason <span className="text-text-3">(optional)</span>
            </label>
            <Input
              aria-label="Cancellation reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Batch aborted — contamination"
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Keep kit
          </Button>
          <Button variant="danger" onClick={() => void submit()} disabled={busy || !ready}>
            Cancel kit &amp; return {totalUnits}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Activity sheet ──────────────────────────────────────────────────────────

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

  React.useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setRows(null);
    void kitsApi
      .activity(kitId, { signal: ctrl.signal })
      .then((r) => setRows(r.items))
      .catch(() => setRows([]));
    return () => ctrl.abort();
  }, [open, kitId]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:w-[720px]">
        <SheetHeader>
          <SheetTitle>Activity log — {kitNumber}</SheetTitle>
          <p className="text-xs text-text-3">
            Every quantity movement this kit caused. A return posts as an explicit{' '}
            <span className="font-medium text-text-2">Backflushed</span> row, never a plain receipt.
          </p>
        </SheetHeader>
        <SheetBody className="px-0 py-0">
          {rows === null ? (
            <p className="p-6 text-center text-xs text-text-3">Loading…</p>
          ) : rows.length === 0 ? (
            <div className="p-6">
              <EmptyState title="Nothing yet" hint="Issuing the kit writes the first rows." />
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-bg-elev">
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                  <th className="px-4 py-2.5 font-medium">When</th>
                  <th className="px-3 py-2.5 font-medium">Transaction</th>
                  <th className="px-3 py-2.5 font-medium">Item</th>
                  <th className="px-3 py-2.5 text-right font-medium">Qty</th>
                  <th className="px-4 py-2.5 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className="border-b border-border/60 align-top last:border-0">
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-text-3">
                      {formatDateTime(e.performed_at)}
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge
                        tone={
                          e.movement_type === 'backflush' ||
                          e.movement_type === 'kit_return' ||
                          e.movement_type === 'production_output'
                            ? 'success'
                            : e.movement_type === 'kit_additional_issue' ||
                                e.movement_type === 'kit_cancel_return'
                              ? 'warning'
                              : 'neutral'
                        }
                      >
                        {MOVEMENT_TYPE_LABEL[e.movement_type] ?? e.movement_type}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs">{e.item_number}</td>
                    <td className="px-3 py-2.5 text-right">
                      <QtyCell
                        value={e.qty_delta > 0 ? `+${e.qty_delta}` : String(e.qty_delta)}
                        tone={e.qty_delta > 0 ? 'success' : 'danger'}
                      />
                    </td>
                    <td className="px-4 py-2.5 text-xs text-text-3">{e.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
