'use client';

import * as React from 'react';
import { BellOff, ClipboardCheck } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';

import { ExpiryBadge, ItemCell, NumberInput, QtyCell, RuleNote, Stat } from './recon-bits';
import {
  CONSUMABLE_LOCATIONS,
  expiryStateOf,
  formatDate,
  formatDateTime,
  itemOf,
} from './reconciliation-data';
import { consumableRows } from './reconciliation-engine';
import { useReconStore } from './reconciliation-store';

const ACTOR = 'Jordan Okafor';

/**
 * Consumables / Kanban reconciliation.
 *
 * This is where the two documents are reconciled. Transaction Spec §4.3 says
 * consumable stock "is not transacted out to a specific product so a
 * Reconciliation, or Backflush, function must handle the quantity
 * transactions". REQ-2026-07-09-TRX-004 says consumables are "never
 * quantity-adjusted after issue" — meaning never adjusted *per kit*, against a
 * BOM. A periodic physical count satisfies both: the quantity is corrected
 * against reality rather than against a build.
 */
export function ConsumablesReconClient() {
  const state = useReconStore();
  const adjustCount = useReconStore((s) => s.adjustCount);
  const acknowledgeExpiry = useReconStore((s) => s.acknowledgeExpiry);

  const [location, setLocation] = React.useState<string>(CONSUMABLE_LOCATIONS[0]);
  const [counts, setCounts] = React.useState<Record<string, number | null>>({});

  const rows = React.useMemo(
    () => consumableRows(state).filter((r) => r.location === location),
    [state, location],
  );

  const locationsInUse = React.useMemo(() => {
    const all = new Set<string>(CONSUMABLE_LOCATIONS);
    for (const r of consumableRows(state)) all.add(r.location);
    return [...all].sort();
  }, [state]);

  const flagged = rows.filter((r) => {
    const s = expiryStateOf(itemOf(r.itemId));
    return (s === 'expired' || s === 'near') && !state.acknowledged.includes(`${r.itemId}@${r.location}`);
  });

  const post = (itemId: string, systemQty: number) => {
    const counted = counts[itemId];
    if (counted === null || counted === undefined) {
      toast.error('Enter a counted quantity first.');
      return;
    }
    if (counted === systemQty) {
      toast.info('No variance', { description: 'The count matches the system — nothing to adjust.' });
      return;
    }
    const ok = adjustCount({
      itemId,
      location,
      countedQty: counted,
      note: 'Periodic consumable count',
      actor: ACTOR,
    });
    if (ok) {
      const variance = counted - systemQty;
      toast.success('Count adjusted', {
        description: `${itemId} at ${location}: ${systemQty} → ${counted} (${variance > 0 ? '+' : ''}${variance}).`,
      });
      setCounts((c) => ({ ...c, [itemId]: null }));
    } else {
      toast.error('Adjustment failed', { description: useReconStore.getState().lastError ?? undefined });
    }
  };

  const totalUnits = rows.reduce((a, r) => a + r.systemQty, 0);

  return (
    <div className="space-y-4">
      <RuleNote>
        Consumables are issued blind and never reconciled against a kit — once at a Kanban or
        clean-room location the quantity is considered consumed, but the expiry date is still tracked
        (Transaction Spec §4.2–§4.3). The quantity is corrected here instead, by periodic physical
        count.
      </RuleNote>

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Location" value={location} hint="Consumable holding point" />
        <Stat label="Lines" value={rows.length} hint="Distinct consumables here" />
        <Stat label="Units on system" value={totalUnits} hint="Before counting" />
        <Stat
          label="Expiry flags"
          value={flagged.length}
          tone={flagged.length > 0 ? 'warning' : 'success'}
          hint={flagged.length ? 'Need a physical check' : 'Nothing flagged'}
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {locationsInUse.map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => setLocation(l)}
            className={cn(
              'rounded-md border px-2.5 py-1 text-xs transition-colors',
              location === l
                ? 'border-accent bg-accent-soft font-medium text-accent'
                : 'border-border bg-bg-elev text-text-2 hover:bg-surface',
            )}
          >
            {l}
          </button>
        ))}
      </div>

      <Card className="p-4">
        <div className="mb-3">
          <h2 className="text-sm font-medium text-text">Physical count</h2>
          <p className="mt-0.5 text-xs text-text-3">
            Count what is physically at {location} and post the variance. This is the only quantity
            transaction a consumable gets after issue.
          </p>
        </div>

        {rows.length === 0 ? (
          <EmptyState
            icon={ClipboardCheck}
            title={`No consumables at ${location}`}
            hint="Issue a kit with consumable lines, or pick another location."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 text-right font-medium">System qty</th>
                  <th className="px-3 py-2 text-right font-medium">Counted</th>
                  <th className="px-3 py-2 text-right font-medium">Variance</th>
                  <th className="px-3 py-2 font-medium">Expires</th>
                  <th className="px-3 py-2 font-medium">Expiry</th>
                  <th className="px-3 py-2 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const counted = counts[r.itemId] ?? null;
                  const variance = counted === null ? null : counted - r.systemQty;
                  const item = itemOf(r.itemId);
                  const expState = expiryStateOf(item);
                  const ackKey = `${r.itemId}@${r.location}`;
                  const acked = state.acknowledged.includes(ackKey);
                  const needsAck = (expState === 'expired' || expState === 'near') && !acked;
                  return (
                    <tr key={r.itemId} className="border-b border-border/60">
                      <td className="max-w-[320px] px-3 py-2">
                        <ItemCell itemId={r.itemId} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <QtyCell value={r.systemQty} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <NumberInput
                          aria-label={`Counted quantity for ${r.itemId}`}
                          value={counted}
                          onChange={(v) => setCounts((c) => ({ ...c, [r.itemId]: v }))}
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        {variance === null ? (
                          <QtyCell value="—" tone="muted" />
                        ) : (
                          <QtyCell
                            value={variance > 0 ? `+${variance}` : String(variance)}
                            tone={variance === 0 ? 'muted' : variance > 0 ? 'success' : 'danger'}
                          />
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-text-2">{formatDate(item.expires)}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <ExpiryBadge itemId={r.itemId} />
                          {acked && (
                            <Badge tone="neutral" title="Flag cleared by acknowledgment">
                              acked
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1">
                          {needsAck && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                acknowledgeExpiry(r.itemId, r.location);
                                toast.success('Expiry flag cleared', {
                                  description: `${r.itemId} was issued to ${r.location}. Acknowledged by ${ACTOR}.`,
                                });
                              }}
                              title="Clear the flag with a simple acknowledgment (REQ-2026-07-09-TRX-006)"
                            >
                              <BellOff size={12} /> Acknowledge
                            </Button>
                          )}
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={variance === null || variance === 0}
                            onClick={() => post(r.itemId, r.systemQty)}
                          >
                            Post
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-3">
          <h2 className="text-sm font-medium text-text">Adjustment history</h2>
          <p className="mt-0.5 text-xs text-text-3">
            Every count correction, across all locations.
          </p>
        </div>
        {state.adjustments.length === 0 ? (
          <p className="py-6 text-center text-xs text-text-3">
            No adjustments yet. Post a count above to see one here.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 font-medium">Location</th>
                  <th className="px-3 py-2 text-right font-medium">System</th>
                  <th className="px-3 py-2 text-right font-medium">Counted</th>
                  <th className="px-3 py-2 text-right font-medium">Variance</th>
                  <th className="px-3 py-2 font-medium">By</th>
                </tr>
              </thead>
              <tbody>
                {state.adjustments.map((a) => (
                  <tr key={a.id} className="border-b border-border/60 last:border-0">
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-text-3">
                      {formatDateTime(a.at)}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{a.itemId}</td>
                    <td className="px-3 py-2 text-xs text-text-2">{a.location}</td>
                    <td className="px-3 py-2 text-right">
                      <QtyCell value={a.systemQty} tone="muted" />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <QtyCell value={a.countedQty} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <QtyCell
                        value={a.variance > 0 ? `+${a.variance}` : String(a.variance)}
                        tone={a.variance > 0 ? 'success' : 'danger'}
                      />
                    </td>
                    <td className="px-3 py-2 text-xs text-text-3">{a.actor}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
