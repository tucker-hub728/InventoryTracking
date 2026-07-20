'use client';

import * as React from 'react';
import { CheckCircle2 } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

import type { OutputDraft } from './kit-detail-client';
import { ItemCell, LocationSelect, NumberInput, QtyCell, RuleNote, Stat } from './recon-bits';
import { itemOf, type Kit } from './reconciliation-data';
import { lineIssuedTotal, lineReturned } from './reconciliation-engine';
import { useReconStore } from './reconciliation-store';

/** Where leftovers can go back to. Any real storage location will do — Table 3
 *  shows them differing per line (Shelf B, Tank 2/Cassette X, Shelf C). */
const RETURN_LOCATIONS = [
  'Refrigerator',
  'Freezer 00225',
  'Fridge 00227',
  'Rack A',
  'Rack B',
  'Rack C',
  'Rack D',
  'Rack F',
  'Rack G',
  'Rack H',
  'PD Lab',
  'Materials Management',
] as const;

/**
 * Kit close-out — Transaction Spec §3, Table 3.
 *
 * The whole invariant, per line:  Issued + Additional − Used = Returned.
 * Used may not exceed Issued + Additional; the operator records an explicit
 * additional issue instead, so the ledger always shows where material came from.
 */
export function KitCloseOutTab({
  kit,
  output,
  lineErrors,
  closeReady,
}: {
  kit: Kit;
  output: OutputDraft;
  lineErrors: Record<string, string>;
  closeReady: boolean;
}) {
  const setLineUsed = useReconStore((s) => s.setLineUsed);
  const setLineReturnLocation = useReconStore((s) => s.setLineReturnLocation);

  const closed = kit.status === 'closed';
  const cancelled = kit.status === 'cancelled';
  const editable = kit.status === 'issued' || kit.status === 'in_production';

  // Every kit line is a product item — consumables are never in a BOM, so they
  // never reach a kit (Transaction Spec §4.3). Kept as a filter so the intent
  // is explicit and the reconciliation math can't accidentally pick one up.
  const productLines = kit.lines.filter((l) => !l.isConsumable);

  const totalReturned = productLines.reduce((a, l) => a + lineReturned(l), 0);
  const pending = productLines.filter((l) => l.qtyUsed === null).length;

  if (kit.status === 'draft') {
    return (
      <Card className="p-4">
        <RuleNote>
          Close-out reconciles what was issued against what was actually used. Issue the kit first.
        </RuleNote>
      </Card>
    );
  }

  if (cancelled) {
    return (
      <Card className="p-4">
        <RuleNote>
          This kit was cancelled. Every issued product item was returned to inventory as a
          back-flush — nothing was stranded, because material is never bound to a production lot at
          kitting time (REQ-2026-07-09-TRX-002). See the Activity tab for the rows.
        </RuleNote>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat
          label="Lines to reconcile"
          value={productLines.length}
          hint="Product items — consumables aren't kitted"
        />
        <Stat
          label="Awaiting used qty"
          value={pending}
          tone={pending > 0 ? 'warning' : 'success'}
          hint={pending > 0 ? 'From the traveler' : 'All lines entered'}
        />
        <Stat label="To back-flush" value={totalReturned} tone="success" hint="Units returning to stock" />
        <Stat
          label="Status"
          value={closed ? 'Closed' : closeReady ? 'Ready' : 'Incomplete'}
          tone={closed ? 'success' : closeReady ? 'success' : 'warning'}
          hint={closed ? 'Reconciled and stocked' : 'Output posts with close-out'}
        />
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
                <th className="px-3 py-2 text-right font-medium">Qty needed</th>
                <th className="px-3 py-2 text-right font-medium">Qty issued</th>
                <th className="px-3 py-2 text-right font-medium">Additional</th>
                <th className="px-3 py-2 text-right font-medium">Qty used</th>
                <th className="px-3 py-2 text-right font-medium">Returned</th>
                <th className="px-3 py-2 font-medium">Inventory location</th>
              </tr>
            </thead>
            <tbody>
              {productLines.map((line) => {
                const err = lineErrors[line.itemId];
                const returned = lineReturned(line);
                const issuedTotal = lineIssuedTotal(line);
                return (
                  <React.Fragment key={line.itemId}>
                    <tr className={cn('border-b border-border/60', err && line.qtyUsed !== null && 'bg-danger-soft/30')}>
                      <td className="max-w-[300px] px-3 py-2">
                        <ItemCell itemId={line.itemId} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <QtyCell value={line.qtyNeeded} tone="muted" />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <QtyCell value={line.qtyIssued} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <QtyCell value={line.qtyAdditional || null} tone={line.qtyAdditional ? 'success' : 'muted'} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        {editable ? (
                          <NumberInput
                            aria-label={`Quantity used for ${line.itemId}`}
                            value={line.qtyUsed}
                            invalid={Boolean(err) && line.qtyUsed !== null}
                            onChange={(v) => setLineUsed(kit.id, line.itemId, v)}
                          />
                        ) : (
                          <QtyCell value={line.qtyUsed} />
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {line.qtyUsed === null ? (
                          <QtyCell value="—" tone="muted" />
                        ) : (
                          <QtyCell
                            value={returned}
                            tone={returned > 0 ? 'success' : 'muted'}
                            title={`${issuedTotal} issued − ${line.qtyUsed} used = ${returned}`}
                          />
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {returned > 0 ? (
                          editable ? (
                            <div className="w-44">
                              <LocationSelect
                                aria-label={`Return location for ${line.itemId}`}
                                value={line.returnLocation}
                                options={RETURN_LOCATIONS}
                                onChange={(v) => setLineReturnLocation(kit.id, line.itemId, v)}
                              />
                            </div>
                          ) : (
                            <span className="text-xs text-text-2">{line.returnLocation}</span>
                          )
                        ) : (
                          <span className="text-xs text-text-3">
                            {line.qtyUsed === null ? '—' : 'Nothing to return'}
                          </span>
                        )}
                      </td>
                    </tr>
                    {err && line.qtyUsed !== null && (
                      <tr className="border-b border-border/60 bg-danger-soft/30">
                        <td colSpan={7} className="px-3 pb-2 text-xs text-danger">
                          {err}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
            {productLines.length > 0 && (
              <tfoot>
                <tr className="border-t border-border text-xs">
                  <td className="px-3 py-2 font-medium text-text-2">Totals</td>
                  <td className="px-3 py-2 text-right">
                    <QtyCell value={productLines.reduce((a, l) => a + l.qtyNeeded, 0)} tone="muted" />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <QtyCell value={productLines.reduce((a, l) => a + l.qtyIssued, 0)} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <QtyCell value={productLines.reduce((a, l) => a + l.qtyAdditional, 0) || null} tone="muted" />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <QtyCell value={productLines.reduce((a, l) => a + (l.qtyUsed ?? 0), 0)} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <QtyCell value={totalReturned} tone="success" />
                  </td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Card>


      {closed && (
        <Card className="flex items-start gap-3 border-success/30 bg-success-soft/40 p-4">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" />
          <div className="text-sm">
            <div className="font-medium text-text">Kit closed</div>
            <p className="mt-1 text-xs text-text-2">
              {kit.qtyMade} × {itemOf(kit.parentItemId).id} stocked to {kit.outputLocation}
              {(kit.qtyScrapped ?? 0) > 0 && ` (${kit.qtyScrapped} scrapped)`}, and {totalReturned}{' '}
              unit{totalReturned === 1 ? '' : 's'} back-flushed to inventory. The sub-assembly is now
              available to be kitted into a finished good.
            </p>
          </div>
        </Card>
      )}

      {editable && !closeReady && (
        <RuleNote>
          {pending > 0 ? (
            <>
              {pending} line{pending === 1 ? '' : 's'} still need a used quantity.
            </>
          ) : Object.keys(lineErrors).length > 0 ? (
            <>
              A line uses more than was issued. Record an explicit additional issue on the Issue tab
              to cover it — that keeps the ledger honest about where the extra material came from
              (REQ-2026-07-09-TRX-003).
            </>
          ) : (
            <>
              Record the production output first — the finished quantity and the reconciliation post
              together.
            </>
          )}
        </RuleNote>
      )}

      {editable && closeReady && (
        <RuleNote>
          Closing will stock <span className="font-medium text-text">{output.qtyMade}</span> ×{' '}
          {kit.parentItemId} to {output.outputLocation}, back-flush{' '}
          <span className="font-medium text-text">{totalReturned}</span> unit
          {totalReturned === 1 ? '' : 's'} to inventory, and freeze the kit.
        </RuleNote>
      )}
    </div>
  );
}
