'use client';

import * as React from 'react';
import { Check } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { Order } from '@/lib/api/receiving';

/**
 * How much of an Order has landed — as something you can scan, not decode.
 *
 * The cell this replaces printed `2/150 (1%)`. Three things were wrong with it.
 * The percentage is derived from the two numbers already on the row, so it
 * spends a third of the column restating them — and it restates them at the
 * exact resolution where a percentage stops meaning anything: `1%` and `2%`
 * are the same glance. Second, `0/3` and `0/150` render as equally sized,
 * equally urgent facts, when one of them is a receiver's afternoon and the
 * other is three boxes. Third — and this is the real cost — the number a
 * receiver actually acts on, *how much is still outstanding*, was never on the
 * row at all; they were left to subtract it themselves, per row, down the page.
 *
 * So: the meter carries the proportion (the job the percentage was doing, done
 * pre-attentively), and the text carries the remainder. Colour is reserved for
 * the states worth interrupting for — an over-receipt is amber because it needs
 * a reason on file; everything merely in-progress stays accent-blue and calm,
 * because in a receiving queue most rows are in progress and a column of amber
 * is a column of noise. Finished rows dim themselves: their work is done, so
 * they should stop competing for the eye with the rows that still need hands.
 *
 * The three slots are fixed-width so the meters line up as a single visual
 * column, which is what makes "which of these is nearly done" a glance rather
 * than a read.
 */

/**
 * A 48px meter renders 1% as half a pixel — indistinguishable from the 0%
 * track, which would erase the one distinction the column exists to make:
 * *something* arrived vs *nothing* has. Any non-zero receipt gets at least
 * this much fill, so "started" is never invisible. The meter is therefore
 * deliberately non-linear at the bottom end; the exact figures are one hover
 * away, and the alternative is a bar that lies by omission.
 */
const MIN_VISIBLE_FILL_PCT = 8;

type Phase = 'empty' | 'none' | 'partial' | 'complete' | 'over' | 'cancelled';

interface Props {
  order: Order;
}

export function ReceiveProgress({ order }: Props) {
  const ordered = order.total_ordered_qty;
  const received = order.total_received_qty;
  const outstanding = Math.max(0, ordered - received);
  // Over-receipt is a supported flow (it just demands a reason per line), so
  // the column has to be able to say "more arrived than we asked for" rather
  // than silently clamping to 100% and looking merely complete.
  const over = Math.max(0, received - ordered);

  const phase: Phase =
    order.status === 'cancelled'
      ? 'cancelled'
      : ordered <= 0
        ? 'empty'
        : over > 0
          ? 'over'
          : outstanding === 0
            ? 'complete'
            : received === 0
              ? 'none'
              : 'partial';

  const rawPct = ordered > 0 ? (received / ordered) * 100 : 0;
  const fillPct =
    received > 0 ? Math.max(MIN_VISIBLE_FILL_PCT, Math.min(100, rawPct)) : 0;

  // A line is done when its own receipts cover its own order. An over-received
  // line counts as complete here, which is what a receiver means by "that one
  // is handled".
  const linesDone = order.lines.filter(
    (line) => line.received_qty >= line.ordered_qty,
  ).length;

  // Dates are plain YYYY-MM-DD, so lexical max is chronological max.
  const lastReceipt = order.events.reduce<string | null>(
    (latest, event) =>
      latest === null || event.received_at > latest ? event.received_at : latest,
    null,
  );

  const showMeter = phase !== 'cancelled' && phase !== 'empty';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Not a button: nothing happens on click — the row already offers
            View, and a control that looks pressable but is not is worse than
            no affordance. tabIndex keeps the detail reachable by keyboard,
            which is the only reason a hover-only panel is acceptable at all. */}
        <span
          tabIndex={0}
          className="inline-flex items-center justify-end gap-2.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
        >
          <span
            className={cn(
              'w-16 shrink-0 text-right font-mono text-xs tabular-nums',
              phase === 'complete' || phase === 'cancelled'
                ? 'text-text-3'
                : 'text-text-2',
            )}
          >
            <span
              className={cn(
                phase === 'partial' || phase === 'over'
                  ? 'font-medium text-text'
                  : '',
              )}
            >
              {received}
            </span>
            <span className="text-text-3">/{ordered}</span>
          </span>

          {showMeter ? (
            <span
              role="progressbar"
              aria-valuenow={received}
              aria-valuemin={0}
              aria-valuemax={ordered}
              aria-label={`${received} of ${ordered} received`}
              className="h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-border"
            >
              <span
                className={cn(
                  'block h-full rounded-full transition-[width] duration-300',
                  phase === 'over'
                    ? 'bg-warning'
                    : phase === 'complete'
                      ? 'bg-success/40'
                      : 'bg-accent',
                )}
                style={{ width: `${fillPct}%` }}
              />
            </span>
          ) : (
            // Holds the column so the meters above and below stay in line.
            <span aria-hidden className="h-1.5 w-12 shrink-0" />
          )}

          <span className="w-[5.5rem] shrink-0 text-left text-xs">
            {phase === 'partial' && (
              <span className="text-text-2">
                <span className="font-medium tabular-nums text-text">
                  {outstanding}
                </span>{' '}
                left
              </span>
            )}
            {phase === 'none' && <span className="text-text-3">Not started</span>}
            {phase === 'complete' && (
              <span className="inline-flex items-center gap-1 text-text-3">
                <Check size={12} className="text-success" aria-hidden /> Complete
              </span>
            )}
            {phase === 'over' && (
              <span className="font-medium tabular-nums text-warning">
                +{over} over
              </span>
            )}
            {(phase === 'cancelled' || phase === 'empty') && (
              <span className="text-text-3">&mdash;</span>
            )}
          </span>
        </span>
      </TooltipTrigger>

      {/* Same reasoning as LocationPath: the default tooltip skin is inverted
          for one-line hints, and this is a structured panel that needs the
          app's normal text hierarchy to stay meaningful. */}
      <TooltipContent
        side="left"
        align="center"
        className="border-border bg-bg-elev p-0 text-text shadow-elev-sm"
      >
        <div className="px-3 py-2">
          <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-text-3">
            Receiving
          </p>
          <dl className="space-y-0.5 text-xs">
            <DetailRow label="Ordered" value={String(ordered)} />
            <DetailRow label="Received" value={String(received)} />
            {over > 0 ? (
              <DetailRow label="Over" value={`+${over}`} tone="warning" />
            ) : (
              <DetailRow
                label="Outstanding"
                value={String(outstanding)}
                tone={outstanding > 0 ? 'strong' : 'muted'}
              />
            )}
          </dl>
          <dl className="mt-2 space-y-0.5 border-t border-border pt-2 text-xs">
            <DetailRow
              label="Lines"
              value={`${linesDone} of ${order.lines.length} complete`}
            />
            <DetailRow
              label="Last receipt"
              value={lastReceipt ?? 'None yet'}
              tone={lastReceipt ? undefined : 'muted'}
            />
          </dl>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function DetailRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'strong' | 'muted' | 'warning';
}) {
  return (
    <div className="flex items-baseline justify-between gap-6 whitespace-nowrap">
      <dt className="text-text-3">{label}</dt>
      <dd
        className={cn(
          'tabular-nums',
          tone === 'strong' && 'font-medium text-text',
          tone === 'muted' && 'text-text-3',
          tone === 'warning' && 'font-medium text-warning',
          !tone && 'text-text-2',
        )}
      >
        {value}
      </dd>
    </div>
  );
}
