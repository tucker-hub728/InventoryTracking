'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, Check, ChevronDown, ChevronLeft, PackageSearch, ScrollText } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm-dialog';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';

import { KitCloseOutTab } from './kit-closeout-tab';
import { KitIssueTab } from './kit-issue-tab';
import { KitProductionTab } from './kit-production-tab';
import { KitStructureTab } from './kit-structure-tab';
import { KitStatusBadge, QtyCell } from './recon-bits';
import { EVENT_LABEL, formatDateTime, itemOf, type Kit, type KitStatus } from './reconciliation-data';
import { closeOutErrors } from './reconciliation-engine';
import { useReconStore } from './reconciliation-store';

const ACTOR = 'Jordan Okafor';

/** Output staged on the Production step, committed by Close-Out. */
export interface OutputDraft {
  qtyMade: number | null;
  qtyScrapped: number | null;
  outputLocation: string;
}

const STEPS = [
  { key: 'issue', label: 'Issue', hint: 'Pull material to production' },
  { key: 'production', label: 'Production', hint: 'Record what was built' },
  { key: 'closeout', label: 'Close-Out', hint: 'Reconcile & back-flush' },
] as const;

/**
 * Where the kit sits on the Issue → Production → Close-Out track, derived from
 * its status:
 *  - completed: how many steps are fully done (drives the green checks)
 *  - reachable: the furthest step the operator may open
 *  - def:       the step to land on for this status
 */
function stepModel(status: KitStatus, issued: boolean): { completed: number; reachable: number; def: number } {
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
      return issued ? { completed: 1, reachable: 2, def: 2 } : { completed: 0, reachable: 0, def: 0 };
    default:
      return { completed: 0, reachable: 0, def: 0 };
  }
}

export function KitDetailClient({ kitId }: { kitId: string }) {
  const kit = useReconStore((s) => s.kits.find((k) => k.id === kitId));
  const issueKit = useReconStore((s) => s.issueKit);
  const startProduction = useReconStore((s) => s.startProduction);
  const closeOut = useReconStore((s) => s.closeOutKit);
  const cancel = useReconStore((s) => s.cancelKit);

  const { confirm, confirmDialog } = useConfirm();
  const [activityOpen, setActivityOpen] = React.useState(false);
  // Start on the step that matches the kit's status (no flash of step 1), then
  // the effect below keeps it in sync as the status advances.
  const [activeStep, setActiveStep] = React.useState(() =>
    kit ? stepModel(kit.status, Boolean(kit.issuedAt)).def : 0,
  );

  const [output, setOutput] = React.useState<OutputDraft>({
    qtyMade: null,
    qtyScrapped: 0,
    outputLocation: '',
  });

  // Seed the output form from the kit once it exists / when it closes.
  React.useEffect(() => {
    if (!kit) return;
    setOutput((prev) => ({
      qtyMade: kit.qtyMade ?? prev.qtyMade ?? kit.buildQty,
      qtyScrapped: kit.qtyScrapped ?? prev.qtyScrapped ?? 0,
      outputLocation: kit.outputLocation ?? prev.outputLocation ?? itemOf(kit.parentItemId).homeLocation,
    }));
  }, [kit?.id, kit?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Snap to the step that matches the kit's status whenever the status moves.
  React.useEffect(() => {
    if (!kit) return;
    setActiveStep(stepModel(kit.status, Boolean(kit.issuedAt)).def);
  }, [kit?.id, kit?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!kit) {
    return (
      <>
        <PageHeader title="Kit not found" crumbs={[{ label: 'Kitting & Reconciliation', href: '/reconciliation' }]} />
        <div className="px-6 py-5 sm:px-8">
          <Card className="p-4">
            <EmptyState
              icon={PackageSearch}
              title={`No kit ${kitId}`}
              hint="It may have been reset. Kits in this module live in memory only."
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

  const parent = itemOf(kit.parentItemId);
  const lineErrors = closeOutErrors(kit);
  const model = stepModel(kit.status, Boolean(kit.issuedAt));
  const outputReady =
    output.qtyMade !== null &&
    output.qtyScrapped !== null &&
    output.qtyMade + output.qtyScrapped > 0 &&
    Boolean(output.outputLocation);
  const closeReady = Object.keys(lineErrors).length === 0 && outputReady;

  const onIssue = () => {
    if (issueKit(kit.id, ACTOR)) {
      // Issuing lands the kit on the production floor — move it straight into
      // production so the next step is ready.
      startProduction(kit.id);
      toast.success('Material issued', {
        description: `Source locations decremented; material is at ${kit.productionLocation}. Now record production.`,
      });
      setActiveStep(1);
    } else {
      toast.error('Could not issue', { description: useReconStore.getState().lastError ?? undefined });
    }
  };

  const onClose = () => {
    if (!closeReady) {
      setActiveStep(outputReady ? 2 : 1);
      toast.error('Not ready to close', {
        description: outputReady
          ? 'Some lines still need a used quantity.'
          : 'Record what production yielded first.',
      });
      return;
    }
    const ok = closeOut(kit.id, {
      qtyMade: output.qtyMade!,
      qtyScrapped: output.qtyScrapped!,
      outputLocation: output.outputLocation,
      actor: ACTOR,
    });
    if (ok) {
      toast.success(`${kit.id} closed`, {
        description: `${output.qtyMade} × ${kit.parentItemId} stocked to ${output.outputLocation}; leftovers back-flushed.`,
      });
      setActiveStep(2);
    } else {
      toast.error('Close-out failed', { description: useReconStore.getState().lastError ?? undefined });
    }
  };

  const onCancel = async () => {
    const issuedAnything = kit.status !== 'draft';
    const ok = await confirm({
      title: `Cancel ${kit.id}?`,
      destructive: true,
      confirmLabel: 'Cancel kit',
      cancelLabel: 'Keep kit',
      description: issuedAnything ? (
        <>
          Every issued product item returns to inventory as a back-flush. Nothing is stranded,
          because material is never bound to a production lot at kitting time. Consumables stay
          consumed — they are not adjusted after issue.
        </>
      ) : (
        'This kit is still a Draft, so no material has moved.'
      ),
    });
    if (!ok) return;
    if (cancel(kit.id, 'Cancelled from the kit screen', ACTOR)) {
      toast.success(`${kit.id} cancelled`, {
        description: issuedAnything ? 'Issued product items returned to inventory.' : undefined,
      });
    } else {
      toast.error('Could not cancel', { description: useReconStore.getState().lastError ?? undefined });
    }
  };

  const canCancel = kit.status === 'draft' || kit.status === 'issued' || kit.status === 'in_production';

  // The single forward action for the current step. Whatever it is — issue,
  // continue, or close — it always renders in the footer, in the same spot.
  const footerPrimary: { label: string; onClick: () => void } | null =
    activeStep === 0
      ? kit.status === 'draft'
        ? { label: 'Issue material', onClick: onIssue }
        : model.reachable > 0
          ? { label: `Next: ${STEPS[1]!.label}`, onClick: () => setActiveStep(1) }
          : null
      : activeStep === 1
        ? model.reachable > 1
          ? { label: `Next: ${STEPS[2]!.label}`, onClick: () => setActiveStep(2) }
          : null
        : activeStep === 2 && kit.status === 'in_production'
          ? { label: 'Post output & close kit', onClick: onClose }
          : null;

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Kitting & Reconciliation', href: '/reconciliation' }, { label: kit.id }]}
        title={kit.id}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <KitStatusBadge status={kit.status} />
            <span>
              Building <span className="font-mono text-text">{kit.buildQty}</span> ×{' '}
              <span className="font-mono text-text">{parent.id}</span> — {parent.desc}
            </span>
            <span className="text-text-3">· at {kit.productionLocation}</span>
          </span>
        }
        actions={
          <>
            <Button variant="secondary" onClick={() => setActivityOpen(true)}>
              <ScrollText size={14} /> Activity log
              <span className="ml-1 font-mono text-xs text-text-3">{kit.events.length}</span>
            </Button>
            {canCancel && (
              <Button variant="danger" onClick={() => void onCancel()}>
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
                const needsAttention =
                  step.key === 'closeout' &&
                  kit.status === 'in_production' &&
                  Object.keys(lineErrors).length > 0;
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
                            'flex items-center gap-1.5 text-sm font-medium',
                            isCurrent || isDone ? 'text-text' : 'text-text-3',
                          )}
                        >
                          {step.label}
                          {needsAttention && (
                            <span className="size-1.5 rounded-full bg-warning" aria-hidden />
                          )}
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

        {/* Active step */}
        {activeStep === 0 && (
          <div className="space-y-4">
            <KitIssueTab kit={kit} actor={ACTOR} />
            <StructureDisclosure kit={kit} />
          </div>
        )}
        {activeStep === 1 && (
          <KitProductionTab kit={kit} output={output} onOutputChange={setOutput} />
        )}
        {activeStep === 2 && (
          <KitCloseOutTab kit={kit} output={output} lineErrors={lineErrors} closeReady={closeReady} />
        )}

        {/* Step navigation — the advance action always lives here, at the bottom. */}
        <div className="mt-5 flex items-center justify-between gap-3 border-t border-border pt-4">
          <Button
            variant="ghost"
            disabled={activeStep === 0}
            onClick={() => setActiveStep((s) => Math.max(0, s - 1))}
          >
            <ChevronLeft size={14} /> Back
          </Button>
          {footerPrimary ? (
            <Button variant="primary" onClick={footerPrimary.onClick}>
              {footerPrimary.label} <ArrowRight size={14} />
            </Button>
          ) : (
            <span />
          )}
        </div>
      </div>

      <ActivitySheet kit={kit} open={activityOpen} onOpenChange={setActivityOpen} />
      {confirmDialog}
    </>
  );
}

/** Collapsible full BOM tree, tucked under the Issue step so the multi-level
 *  view (TechReq v2 §6) stays available without crowding the issue table. */
function StructureDisclosure({ kit }: { kit: Kit }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-surface"
      >
        <span className="text-sm font-medium text-text">Full bill of materials &amp; availability</span>
        <ChevronDown size={16} className={cn('text-text-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="border-t border-border p-4">
          <KitStructureTab kit={kit} />
        </div>
      )}
    </Card>
  );
}

/** Kit ledger in a slide-out panel. Not a step — a supporting audit view,
 *  reachable from the header on any step. */
function ActivitySheet({
  kit,
  open,
  onOpenChange,
}: {
  kit: Kit;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const events = [...kit.events].reverse();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:w-[720px]">
        <SheetHeader>
          <SheetTitle>Activity log — {kit.id}</SheetTitle>
          <p className="text-xs text-text-3">
            Every quantity movement this kit caused. A return posts as an explicit{' '}
            <span className="font-medium text-text-2">Backflushed</span> row, never a plain receipt, so
            the ledger reads back as: issued 15, used 12, backflushed 3.
          </p>
        </SheetHeader>
        <SheetBody className="px-0 py-0">
          {events.length === 0 ? (
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
                  <th className="px-3 py-2.5 font-medium">Location</th>
                  <th className="px-4 py-2.5 font-medium">By</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-b border-border/60 align-top last:border-0">
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-text-3">
                      {formatDateTime(e.at)}
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={cn(
                          'text-xs font-medium',
                          e.type === 'backflush' && 'text-success',
                          e.type === 'issue' && 'text-text',
                          e.type === 'additional_issue' && 'text-warning',
                          e.type === 'output' && 'text-success',
                          e.type === 'cancel' && 'text-danger',
                          e.type === 'scrap' && 'text-danger',
                        )}
                      >
                        {EVENT_LABEL[e.type]}
                      </span>
                      <span className="mt-0.5 block text-xs text-text-3">{e.note}</span>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs">{e.itemId}</td>
                    <td className="px-3 py-2.5 text-right">
                      {e.qtyDelta === 0 ? (
                        <QtyCell value="—" tone="muted" title="No stock movement — recorded for the audit trail" />
                      ) : (
                        <QtyCell
                          value={e.qtyDelta > 0 ? `+${e.qtyDelta}` : String(e.qtyDelta)}
                          tone={e.qtyDelta > 0 ? 'success' : 'danger'}
                        />
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-text-2">{e.location}</td>
                    <td className="px-4 py-2.5 text-xs text-text-3">{e.actor}</td>
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
