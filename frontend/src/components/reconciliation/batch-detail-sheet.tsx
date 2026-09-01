'use client';

import * as React from 'react';

import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { formatMoney } from '@/lib/utils';
import type { ApiKit, ApiKitBatch, ApiKitLine, KitLineIssuedFrom } from '@/lib/api/kits';

import { ItemCell, RuleNote, Stat, formatDateTime } from './recon-bits';

/**
 * How one finished lot was made, and what it cost (RPT-003).
 *
 * The drill-down behind a row of "Cost by finished lot": the components that
 * went into this specific batch, how much of each, at what unit cost, and what
 * that came to — so ``material_cost_amount`` is explainable line by line rather
 * than asserted. The line values sum to the batch total by construction.
 *
 * **On source lots.** The breakdown names components, not the lots they came
 * from, and that is not an omission. Cost is attributed as a moving weighted
 * average over what each kit line still holds, so a batch consumes *value from
 * a pool*: the system does not record which physical lot's units went into
 * which batch, and printing one here would be inventing a fact. What the
 * average is built from — the kit's issue history, with each lot's own price —
 * is shown below the breakdown so the blend can be checked by hand.
 */
export function BatchDetailSheet({
  batch,
  kit,
  onClose,
}: {
  batch: ApiKitBatch | null;
  kit: ApiKit;
  onClose: () => void;
}) {
  if (!batch) return null;
  const attempted = batch.good_qty + batch.scrap_qty;
  // Only the lines this batch actually drew on — a kit line it never touched
  // has nothing to say about this lot.
  const usedLineIds = new Set(batch.consumptions.map((c) => c.kit_line_id));
  const feedingLines = kit.lines.filter((l) => usedLineIds.has(l.id));
  const sourceRows = buildSourceRows(feedingLines);

  return (
    <Sheet open onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="sm:w-[680px]">
        <SheetHeader>
          <SheetTitle>
            {batch.output_lot_number ?? `Batch ${batch.batch_no} — no lot`}
          </SheetTitle>
          <p className="text-xs text-text-3">
            Batch {batch.batch_no} of {kit.kit_number} · {kit.item_number} ·{' '}
            {formatDateTime(batch.produced_at)}
            {batch.performed_by_name ? ` · ${batch.performed_by_name}` : ''}
          </p>
        </SheetHeader>

        <SheetBody>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Good" value={batch.good_qty} tone="success" />
            <Stat label="Scrap" value={batch.scrap_qty || '—'} />
            <Stat
              label="Material cost"
              value={batch.cost_is_complete ? formatMoney(batch.material_cost_amount) : '—'}
            />
            <Stat
              label="Per good unit"
              value={batch.cost_is_complete ? formatMoney(batch.unit_cost_amount) : '—'}
              hint={batch.cost_is_complete ? 'What the customer is charged' : undefined}
            />
          </div>

          {!batch.cost_is_complete && (
            <div className="mt-3">
              <RuleNote>
                One of the materials in this batch has no price recorded, so this lot has no
                cost. The figures are left blank rather than partial — a partial cost reads
                as a complete one, which is the worst outcome for a number that becomes an
                invoice.
              </RuleNote>
            </div>
          )}

          {batch.cost_is_complete && batch.scrap_qty > 0 && (
            <div className="mt-3">
              <RuleNote>
                {attempted} units were started and {batch.good_qty} came out good, so{' '}
                <strong>{formatMoney(batch.scrap_value_amount)}</strong> of the{' '}
                {formatMoney(batch.material_cost_amount)} went into units that failed.
                That is counted <strong>once</strong>, not added on top — the price per
                good unit is the whole {formatMoney(batch.material_cost_amount)} divided
                by {batch.good_qty}, so the loss is recovered from the customer rather
                than carried by us.
              </RuleNote>
            </div>
          )}

          <h3 className="mt-5 text-sm font-medium text-text">What went into it</h3>
          <p className="mt-0.5 text-xs text-text-3">
            These line values add up to the material cost.
          </p>
          <div className="mt-2 overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface/50 text-left text-[10px] uppercase tracking-wider text-text-3">
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Component</th>
                  <th className="px-3 py-2 text-right font-medium">Used</th>
                  <th className="px-3 py-2 text-right font-medium">Unit cost</th>
                  <th className="px-3 py-2 text-right font-medium">Value</th>
                </tr>
              </thead>
              <tbody>
                {batch.consumptions.map((c) => (
                  <tr key={c.kit_line_id} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2 tabular-nums text-text-3">{c.line_no ?? '—'}</td>
                    <td className="max-w-[220px] px-3 py-2">
                      <ItemCell
                        itemNumber={c.item_number}
                        description={c.description}
                        itemId={c.item_id}
                      />
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{c.qty}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-text-2">
                      {formatMoney(c.unit_cost_amount)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums">
                      {formatMoney(c.extended_value_amount)}
                    </td>
                  </tr>
                ))}
                {batch.consumptions.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-4 text-center text-xs text-text-3">
                      {batch.good_qty === 0 && batch.scrap_qty === 0
                        ? // The close-out's own finalising batch: everything was
                          // made in earlier batches, so this one consumed
                          // nothing and mints no lot. Not a missing record.
                          'This batch made nothing — the kit was finished in earlier batches, so no material was charged to it.'
                        : 'No component breakdown was recorded for this batch. Batches produced before cost tracking was added carry only their totals.'}
                    </td>
                  </tr>
                )}
              </tbody>
              {batch.consumptions.length > 0 && (
                <tfoot>
                  <tr className="border-t border-border bg-accent-soft font-semibold">
                    <td className="px-3 py-2 text-[11px] uppercase tracking-wide" colSpan={4}>
                      Material cost
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {batch.cost_is_complete ? formatMoney(batch.material_cost_amount) : '—'}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          <h3 className="mt-5 text-sm font-medium text-text">Lots this kit bought</h3>
          <p className="mt-0.5 text-xs text-text-3">
            Everything bought for the whole kit — not this batch alone.
          </p>
          <div className="mt-2 overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface/50 text-left text-[10px] uppercase tracking-wider text-text-3">
                  <th className="px-3 py-2 font-medium">Component</th>
                  <th className="px-3 py-2 font-medium">Lot</th>
                  <th className="px-3 py-2 text-right font-medium">Units</th>
                  <th className="px-3 py-2 text-right font-medium">Price</th>
                  <th className="px-3 py-2 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {sourceRows.map((r) => (
                  <tr key={r.key} className="border-b border-border/60 last:border-0">
                    {/* Only on the group's first row: repeating the component
                        beside each of its lots is the noise this replaced. */}
                    <td className="px-3 py-2 font-mono text-xs text-text-2">
                      {r.isFirst ? r.itemNumber : ''}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-text">
                      {r.lotNumber ?? 'No lot'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{r.qty}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-text-2">
                      {formatMoney(r.price)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {r.value === null ? '—' : formatMoney(String(r.value))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

/** One lot's total contribution to a component, after folding its pulls together. */
interface SourceLot {
  key: string;
  lotNumber: string | null;
  price: string | null;
  qty: number;
  /** How many separate issues drew on this lot — detail, not headline. */
  pulls: number;
  value: number | null;
}

/**
 * Fold a component's charges into one row per (lot, price).
 *
 * The raw list is one row per issue, so a kit fed over several days shows the
 * same lot five or six times. Nobody reads that: the question a reader actually
 * has is "which lots, how much of each, at what price", and the repetition
 * buries it. Grouping answers the question in as many rows as there are lots.
 *
 * Keyed by lot AND price because a lot's price is editable — if it changed
 * between two issues, those were genuinely different costs and merging them
 * would report a blend as a fact.
 */
function groupSourceLots(rows: KitLineIssuedFrom[]): SourceLot[] {
  const map = new Map<string, SourceLot>();
  for (const r of rows) {
    const key = `${r.lot_number ?? '—'}|${r.unit_price_amount ?? ''}`;
    const g = map.get(key) ?? {
      key,
      lotNumber: r.lot_number,
      price: r.unit_price_amount,
      qty: 0,
      pulls: 0,
      value: null,
    };
    g.qty += r.qty;
    g.pulls += 1;
    map.set(key, g);
  }
  return [...map.values()]
    .map((g) => ({ ...g, value: g.price === null ? null : Number(g.price) * g.qty }))
    .sort((a, b) => b.qty - a.qty);
}

/** One flat table row: a component, one of its lots, and what that lot cost. */
interface SourceRow extends SourceLot {
  itemNumber: string;
  /** First row of its component group — the only one that prints the name. */
  isFirst: boolean;
}

/**
 * Flatten every component's lots into one table.
 *
 * Grouped by (lot, price) first, so a lot pulled five times as the kit was
 * topped up is one row rather than five. That repetition is the whole reason
 * this exists: the reader's question is "which lot, how much, what did it
 * cost", and one row per issue event buries it.
 */
function buildSourceRows(lines: ApiKitLine[]): SourceRow[] {
  return lines.flatMap((line) =>
    groupSourceLots(line.sourced_from).map((g, i) => ({
      ...g,
      key: `${line.id}|${g.key}`,
      itemNumber: line.item_number,
      isFirst: i === 0,
    })),
  );
}
