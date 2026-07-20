'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronRight, FlaskConical, Plus, RotateCcw } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';

import { NewKitDialog } from './new-kit-dialog';
import { ItemCell, KitStatusBadge, RuleNote } from './recon-bits';
import { KIT_STATUS_LABEL, formatDate, itemOf, type KitStatus } from './reconciliation-data';
import { kitYield, lineIssuedTotal } from './reconciliation-engine';
import { useReconStore } from './reconciliation-store';

const STATUS_FILTERS: (KitStatus | 'all')[] = [
  'all',
  'draft',
  'issued',
  'in_production',
  'closed',
  'cancelled',
];

export function ReconciliationPageClient() {
  const kits = useReconStore((s) => s.kits);
  const resetDemo = useReconStore((s) => s.resetDemo);
  const [filter, setFilter] = React.useState<KitStatus | 'all'>('all');
  const [creating, setCreating] = React.useState(false);

  const visible = React.useMemo(
    () => (filter === 'all' ? kits : kits.filter((k) => k.status === filter)),
    [kits, filter],
  );

  const counts = React.useMemo(() => {
    const out: Record<string, number> = { all: kits.length };
    for (const k of kits) out[k.status] = (out[k.status] ?? 0) + 1;
    return out;
  }, [kits]);

  return (
    <>
      <PageHeader
        title="Kitting & Reconciliation"
        subtitle="Gather material for a build, issue it to production, then reconcile what was actually used and back-flush the rest."
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                resetDemo();
                toast.success('Demo reset', { description: 'Kits and stock are back to the seeded story.' });
              }}
            >
              <RotateCcw size={14} /> Reset demo
            </Button>
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={14} /> New kit
            </Button>
          </>
        }
      />

      <div className="px-6 py-5 sm:px-8">
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {STATUS_FILTERS.map((s) => {
            const n = counts[s] ?? 0;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setFilter(s)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors',
                  filter === s
                    ? 'border-accent bg-accent-soft font-medium text-accent'
                    : 'border-border bg-bg-elev text-text-2 hover:bg-surface',
                )}
              >
                {s === 'all' ? 'All' : KIT_STATUS_LABEL[s]}
                <span className="font-mono tabular-nums text-text-3">{n}</span>
              </button>
            );
          })}
        </div>

            <Card className="p-4">
              {visible.length === 0 ? (
                <EmptyState
                  icon={FlaskConical}
                  title="No kits here"
                  hint={
                    filter === 'all'
                      ? 'Open a kit to start gathering material for a build.'
                      : `No kits are ${KIT_STATUS_LABEL[filter as KitStatus].toLowerCase()}.`
                  }
                  action={
                    <Button variant="primary" onClick={() => setCreating(true)}>
                      <Plus size={14} /> New kit
                    </Button>
                  }
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                        <th className="px-3 py-2 font-medium">Kit</th>
                        <th className="px-3 py-2 font-medium">Building</th>
                        <th className="px-3 py-2 text-right font-medium">Build qty</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                        <th className="px-3 py-2 font-medium">Production location</th>
                        <th className="px-3 py-2 text-right font-medium">Lines</th>
                        <th className="px-3 py-2 text-right font-medium">Issued</th>
                        <th className="px-3 py-2 text-right font-medium">Yield</th>
                        <th className="px-3 py-2 font-medium">Opened</th>
                        <th className="px-3 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((kit) => {
                        const parent = itemOf(kit.parentItemId);
                        const issued = kit.lines.reduce((a, l) => a + lineIssuedTotal(l), 0);
                        const y = kitYield(kit);
                        return (
                          <tr
                            key={kit.id}
                            className="border-b border-border/60 transition-colors hover:bg-surface"
                          >
                            <td className="px-3 py-2.5">
                              <Link
                                href={`/reconciliation/${kit.id}`}
                                className="rounded-sm font-mono text-xs font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                              >
                                {kit.id}
                              </Link>
                            </td>
                            <td className="max-w-[280px] px-3 py-2.5">
                              <ItemCell itemId={parent.id} />
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums">
                              {kit.buildQty}
                            </td>
                            <td className="px-3 py-2.5">
                              <KitStatusBadge status={kit.status} />
                            </td>
                            <td className="px-3 py-2.5 text-xs text-text-2">
                              {kit.productionLocation}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-text-3">
                              {kit.lines.length}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums">
                              {issued || '—'}
                            </td>
                            <td className="px-3 py-2.5 text-right">
                              {y === null ? (
                                <span className="text-xs text-text-3">—</span>
                              ) : (
                                <Badge tone={y >= 1 ? 'success' : y >= 0.8 ? 'warning' : 'danger'}>
                                  {Math.round(y * 100)}%
                                </Badge>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-xs text-text-3">
                              {formatDate(kit.createdAt)}
                            </td>
                            <td className="px-3 py-2.5 text-right">
                              <Button variant="ghost" size="icon-sm" asChild>
                                <Link href={`/reconciliation/${kit.id}`} aria-label={`Open ${kit.id}`}>
                                  <ChevronRight size={14} />
                                </Link>
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

        <div className="mt-3">
          <RuleNote>
            A kit moves Draft → Issued → In Production → Closed. Issuing decrements the source
            location straight away, so kitted material stops counting as on hand
            (REQ-2026-07-09-TRX-001). Nothing is bound to a production lot at kitting time, which is
            why a cancelled kit can always hand its material back (REQ-2026-07-09-TRX-002).
          </RuleNote>
        </div>
      </div>

      <NewKitDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
