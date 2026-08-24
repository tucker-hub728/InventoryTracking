'use client';

import * as React from 'react';
import { ChevronDown, PackageCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { PutAwayDialog } from '@/components/inventory/receipt-admin/put-away-dialog';
import { itemsApi, type ApiAwaitingPutAway } from '@/lib/api/items';
import { usePermission } from '@/hooks/use-permission';
import { cn, formatDate, formatNumber } from '@/lib/utils';

/**
 * Material that has arrived for this item but has not been put away (REQ-004).
 *
 * A banner rather than a tab, deliberately. This is a **to-do**, not a
 * category: a tab would sit there empty most of the time, making a temporary
 * state look like a permanent kind of stock, and it would hide the one thing
 * somebody needs to act on behind a click. A banner is visible from whichever
 * tab you are on and disappears completely at zero — the interface gets simpler
 * exactly when there is nothing to do.
 *
 * It is also the ONLY place this material appears on the item page. Nothing has
 * been placed yet, so there is no allocation and no ledger movement: on-hand,
 * the Unit Ledger and every transfer / kit / issue picker are all derived from
 * those and cannot see it. That is the point of the design — arrived is not
 * available — but it does mean that without this banner the stock would be
 * invisible, which is why it sits above the tabs rather than inside one.
 */
export function AwaitingPutAwayBanner({
  itemId,
  itemNumber,
  itemDescription,
  onPlaced,
}: {
  itemId: string;
  itemNumber?: string | null;
  itemDescription?: string | null;
  /** Fired after a put-away so the host can refetch stock, ledger and totals. */
  onPlaced?: () => void;
}) {
  const canSign = usePermission('inventory', 'sign');
  const [rows, setRows] = React.useState<ApiAwaitingPutAway[]>([]);
  const [expanded, setExpanded] = React.useState(false);
  const [target, setTarget] = React.useState<ApiAwaitingPutAway | null>(null);

  const load = React.useCallback(
    (signal?: AbortSignal) => {
      itemsApi
        .awaitingPutAway(itemId, { signal })
        .then(setRows)
        .catch(() => {
          // Silent: this is an additive surface. Failing to load it must not
          // break the item page, and an error banner about material that may
          // not exist would be worse than showing nothing.
        });
    },
    [itemId],
  );

  React.useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const totalUnits = rows.reduce((n, r) => n + r.remaining_units, 0);

  // The whole component vanishes when there is nothing waiting.
  if (rows.length === 0) return null;

  return (
    <>
      {/* Neutral, not a warning. Material arriving and waiting to be shelved is
          the ordinary path — every receipt passes through it — so styling it as
          an alert would put a yellow strip on most items most of the time and
          teach people to ignore the colour that should mean "stop". The house
          neutral panel (border-border / bg-surface-2) is the same one the order
          totals use; the accent icon gives it presence without alarm. */}
      <div className="mb-4 rounded-md border border-border bg-surface-2">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2">
          <span className="flex min-w-0 items-center gap-2 text-sm">
            <PackageCheck size={15} className="shrink-0 text-accent" />
            <span className="text-text">
              <span className="font-medium tabular-nums">
                {formatNumber(totalUnits)}
              </span>{' '}
              unit{totalUnits === 1 ? '' : 's'} awaiting release
            </span>
            <span className="text-xs text-text-3">
              · {rows.length} lot{rows.length === 1 ? '' : 's'} arrived, not yet
              placed
            </span>
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? 'Hide' : 'Show'}
            <ChevronDown
              size={14}
              className={cn('transition-transform', expanded && 'rotate-180')}
            />
          </Button>
        </div>

        {expanded && (
          <ul className="border-t border-border px-3 py-2">
            {rows.map((r) => (
              <li
                key={r.lot_id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5 text-xs"
              >
                <span className="min-w-0">
                  <span className="break-all font-mono text-accent">
                    {r.lot_number}
                  </span>
                  <span className="ml-2 text-text-3">
                    {r.received_at ? `arrived ${formatDate(r.received_at)}` : ''}
                    {r.po_reference ? ` · ${r.po_reference}` : ''}
                    {r.supplier_name ? ` · ${r.supplier_name}` : ''}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="tabular-nums text-text-2">
                    {formatNumber(r.remaining_units)}
                    {/* Only worth saying when an earlier partial put-away
                        already shelved some of it. */}
                    {r.remaining_units !== r.received_units && (
                      <span className="text-text-3">
                        {' '}
                        of {formatNumber(r.received_units)}
                      </span>
                    )}
                  </span>
                  {canSign && (
                    // The project's name for this step, everywhere: the
                    // requirement calls it the receive-to-inventory step, the
                    // endpoint is /receive-to-inventory, and the dialog it
                    // opens is titled the same. "Put away" was a synonym that
                    // appeared nowhere else.
                    <Button size="sm" onClick={() => setTarget(r)}>
                      Receive to inventory
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <PutAwayDialog
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        lot={target}
        itemNumber={itemNumber}
        itemDescription={itemDescription}
        onDone={() => {
          setTarget(null);
          load();
          onPlaced?.();
        }}
      />
    </>
  );
}
