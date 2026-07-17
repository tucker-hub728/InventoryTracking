'use client';

import * as React from 'react';

import { Card } from '@/components/ui/card';

import type { OutputDraft } from './kit-detail-client';
import { ItemCell, LocationSelect, NumberInput, QtyCell, RuleNote, Stat } from './recon-bits';
import { itemOf, type Kit } from './reconciliation-data';
import { kitYield, lineIssuedTotal } from './reconciliation-engine';

/** Storage destinations for finished output. Real seed shelves plus the cold
 *  storage the seed's media/cell products actually live in. */
const OUTPUT_LOCATIONS = [
  'Refrigerator',
  'Freezer 00225',
  'Fridge 00227',
  'Rack A',
  'Rack B',
  'Rack C',
  'Rack D',
  'Materials Management',
] as const;

/**
 * Production output. Captures good units and scrap so yield and
 * consumed-per-good-unit can be read off per batch (REQ-2026-07-01-BFL-004).
 *
 * Nothing here commits on its own — output posts atomically with the close-out,
 * because reconciliation happens *at the point of transacting into inventory*
 * (REQ-2026-07-01-BFL-002).
 */
export function KitProductionTab({
  kit,
  output,
  onOutputChange,
}: {
  kit: Kit;
  output: OutputDraft;
  onOutputChange: (next: OutputDraft) => void;
}) {
  const parent = itemOf(kit.parentItemId);
  const closed = kit.status === 'closed' || kit.status === 'cancelled';
  const notStarted = kit.status === 'draft';

  const made = closed ? kit.qtyMade : output.qtyMade;
  const scrapped = closed ? kit.qtyScrapped : output.qtyScrapped;
  const location = closed ? kit.outputLocation : output.outputLocation;

  const total = (made ?? 0) + (scrapped ?? 0);
  const liveYield = closed ? kitYield(kit) : total > 0 ? (made ?? 0) / total : null;

  if (notStarted) {
    return (
      <Card className="p-4">
        <RuleNote>
          This kit is still a Draft. Issue the material first — production output is recorded once
          the build has actually run.
        </RuleNote>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Build target" value={kit.buildQty} hint={`${parent.id} planned`} />
        <Stat label="Good units" value={made ?? '—'} tone="success" hint="Added to stock" />
        <Stat label="Scrapped" value={scrapped ?? '—'} tone={(scrapped ?? 0) > 0 ? 'danger' : 'default'} hint="Not stocked" />
        <Stat
          label="Yield"
          value={liveYield === null ? '—' : `${Math.round(liveYield * 100)}%`}
          tone={liveYield === null ? 'default' : liveYield >= 1 ? 'success' : liveYield >= 0.8 ? 'warning' : 'danger'}
          hint={total > 0 ? `${made} good of ${total} built` : 'Enter output below'}
        />
      </div>

      <Card className="p-4">
        <div className="mb-3">
          <h2 className="text-sm font-medium text-text">Production output</h2>
          <p className="mt-0.5 text-xs text-text-3">
            {closed
              ? 'Posted when the kit was closed.'
              : 'What the build actually yielded. This posts to stock when you close the kit out.'}
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="qty-made" className="mb-1.5 block text-xs font-medium text-text-2">
              Quantity made (good units)
            </label>
            <NumberInput
              aria-label="Quantity made"
              value={made}
              disabled={closed}
              onChange={(v) => onOutputChange({ ...output, qtyMade: v })}
              className="h-8 w-full text-sm"
            />
          </div>
          <div>
            <label htmlFor="qty-scrap" className="mb-1.5 block text-xs font-medium text-text-2">
              Quantity scrapped
            </label>
            <NumberInput
              aria-label="Quantity scrapped"
              value={scrapped}
              disabled={closed}
              onChange={(v) => onOutputChange({ ...output, qtyScrapped: v })}
              className="h-8 w-full text-sm"
            />
          </div>
          <div>
            <label htmlFor="out-loc" className="mb-1.5 block text-xs font-medium text-text-2">
              Stock the output to
            </label>
            <LocationSelect
              aria-label="Output location"
              value={location || ''}
              options={OUTPUT_LOCATIONS}
              disabled={closed}
              onChange={(v) => onOutputChange({ ...output, outputLocation: v })}
              className="h-8 text-sm"
            />
          </div>
        </div>

        {!closed && (made ?? 0) + (scrapped ?? 0) !== kit.buildQty && (made ?? 0) + (scrapped ?? 0) > 0 && (
          <p className="mt-3 text-xs text-warning">
            Built {(made ?? 0) + (scrapped ?? 0)} against a target of {kit.buildQty}. That is allowed
            — the target is a plan, not a limit.
          </p>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-3">
          <h2 className="text-sm font-medium text-text">Material consumption</h2>
          <p className="mt-0.5 text-xs text-text-3">
            What the BOM expected against what was actually issued. Used quantities are entered on
            the Close-Out tab, from the traveler.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 text-right font-medium">BOM per unit</th>
                <th className="px-3 py-2 text-right font-medium">Issued</th>
                <th className="px-3 py-2 text-right font-medium">Used</th>
              </tr>
            </thead>
            <tbody>
              {kit.lines.map((line) => (
                <tr key={line.itemId} className="border-b border-border/60">
                  <td className="max-w-[320px] px-3 py-2">
                    <ItemCell itemId={line.itemId} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <QtyCell value={line.qtyPerUnit} tone="muted" />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <QtyCell value={lineIssuedTotal(line)} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    {line.qtyUsed === null ? (
                      <QtyCell value="—" tone="muted" title="Entered at close-out" />
                    ) : (
                      <QtyCell value={line.qtyUsed} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {!closed && (
        <RuleNote>
          Output and reconciliation commit together. REQ-2026-07-01-BFL-002 puts reconciliation at
          the point of transacting the finished quantity into its inventory location — not at
          shipment, and not as a later step. Fill in the Close-Out tab, then close the kit.
        </RuleNote>
      )}
    </div>
  );
}
