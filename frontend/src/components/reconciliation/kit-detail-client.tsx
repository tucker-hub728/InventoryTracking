'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, PackageSearch } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';

import { KitCloseOutTab } from './kit-closeout-tab';
import { KitIssueTab } from './kit-issue-tab';
import { KitProductionTab } from './kit-production-tab';
import { KitStructureTab } from './kit-structure-tab';
import { KitStatusBadge, QtyCell } from './recon-bits';
import { EVENT_LABEL, formatDateTime, itemOf, type Kit } from './reconciliation-data';
import { closeOutErrors } from './reconciliation-engine';
import { useReconStore } from './reconciliation-store';

const ACTOR = 'Jordan Okafor';

/** Output staged on the Production tab, committed by Close-Out. */
export interface OutputDraft {
  qtyMade: number | null;
  qtyScrapped: number | null;
  outputLocation: string;
}

export function KitDetailClient({ kitId }: { kitId: string }) {
  const kit = useReconStore((s) => s.kits.find((k) => k.id === kitId));
  const issueKit = useReconStore((s) => s.issueKit);
  const startProduction = useReconStore((s) => s.startProduction);
  const closeOut = useReconStore((s) => s.closeOutKit);
  const cancel = useReconStore((s) => s.cancelKit);

  const { confirm, confirmDialog } = useConfirm();
  const [tab, setTab] = React.useState('structure');

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
  const outputReady =
    output.qtyMade !== null &&
    output.qtyScrapped !== null &&
    output.qtyMade + output.qtyScrapped > 0 &&
    Boolean(output.outputLocation);
  const closeReady = Object.keys(lineErrors).length === 0 && outputReady;

  const onIssue = () => {
    if (issueKit(kit.id, ACTOR)) {
      toast.success('Material issued', {
        description: `Source locations decremented; material is at ${kit.productionLocation}.`,
      });
      setTab('production');
    } else {
      toast.error('Could not issue', { description: useReconStore.getState().lastError ?? undefined });
    }
  };

  const onClose = () => {
    if (!closeReady) {
      setTab(outputReady ? 'closeout' : 'production');
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
      setTab('closeout');
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

  const actions = (
    <>
      {(kit.status === 'draft' || kit.status === 'issued' || kit.status === 'in_production') && (
        <Button variant="danger" onClick={() => void onCancel()}>
          Cancel kit
        </Button>
      )}
      {kit.status === 'draft' && (
        <Button variant="primary" onClick={onIssue}>
          Issue material <ArrowRight size={14} />
        </Button>
      )}
      {kit.status === 'issued' && (
        <Button
          variant="primary"
          onClick={() => {
            startProduction(kit.id);
            setTab('production');
          }}
        >
          Start production <ArrowRight size={14} />
        </Button>
      )}
      {kit.status === 'in_production' && (
        <Button variant="primary" onClick={onClose} title={closeReady ? undefined : 'Finish the close-out grid first'}>
          Post output &amp; close kit <ArrowRight size={14} />
        </Button>
      )}
    </>
  );

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
        actions={actions}
      />

      <div className="px-6 py-5 sm:px-8">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="structure">Structure</TabsTrigger>
            <TabsTrigger value="issue">Issue</TabsTrigger>
            <TabsTrigger value="production">Production</TabsTrigger>
            <TabsTrigger value="closeout">
              Close-Out
              {kit.status === 'in_production' && Object.keys(lineErrors).length > 0 && (
                <span className="ml-1 size-1.5 rounded-full bg-warning" aria-hidden />
              )}
            </TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>

          <TabsContent value="structure">
            <KitStructureTab kit={kit} />
          </TabsContent>
          <TabsContent value="issue">
            <KitIssueTab kit={kit} actor={ACTOR} onIssue={onIssue} />
          </TabsContent>
          <TabsContent value="production">
            <KitProductionTab kit={kit} output={output} onOutputChange={setOutput} />
          </TabsContent>
          <TabsContent value="closeout">
            <KitCloseOutTab kit={kit} output={output} lineErrors={lineErrors} onClose={onClose} closeReady={closeReady} />
          </TabsContent>
          <TabsContent value="activity">
            <ActivityTab kit={kit} />
          </TabsContent>
        </Tabs>
      </div>

      {confirmDialog}
    </>
  );
}

function ActivityTab({ kit }: { kit: Kit }) {
  const events = [...kit.events].reverse();
  return (
    <Card className="p-4">
      <div className="mb-3">
        <h2 className="text-sm font-medium text-text">Kit ledger</h2>
        <p className="mt-0.5 text-xs text-text-3">
          Every quantity movement this kit caused. A return posts as an explicit{' '}
          <span className="font-medium text-text-2">Backflushed</span> row, never a plain receipt, so
          the ledger reads back as: issued 15, used 12, backflushed 3.
        </p>
      </div>
      {events.length === 0 ? (
        <EmptyState title="Nothing yet" hint="Issuing the kit writes the first rows." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Transaction</th>
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 text-right font-medium">Qty</th>
                <th className="px-3 py-2 font-medium">Location</th>
                <th className="px-3 py-2 font-medium">Detail</th>
                <th className="px-3 py-2 font-medium">By</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-b border-border/60 last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-text-3">
                    {formatDateTime(e.at)}
                  </td>
                  <td className="px-3 py-2">
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
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{e.itemId}</td>
                  <td className="px-3 py-2 text-right">
                    {e.qtyDelta === 0 ? (
                      <QtyCell value="—" tone="muted" title="No stock movement — recorded for the audit trail" />
                    ) : (
                      <QtyCell
                        value={e.qtyDelta > 0 ? `+${e.qtyDelta}` : String(e.qtyDelta)}
                        tone={e.qtyDelta > 0 ? 'success' : 'danger'}
                      />
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-text-2">{e.location}</td>
                  <td className="px-3 py-2 text-xs text-text-3">{e.note}</td>
                  <td className="px-3 py-2 text-xs text-text-3">{e.actor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
