'use client';

import * as React from 'react';
import { ArrowRight, ClipboardList } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { kanbanRestockApi, type RestockRequest } from '@/lib/api/consumables';
import { usePermission } from '@/hooks/use-permission';
import { formatNumber } from '@/lib/utils';
import { LocationPath } from '@/components/locations/location-path';

/**
 * Open restock requests for THIS consumable, on the item page (KAN-001).
 *
 * The restock loop has two ends and they are two different people:
 *
 *     the floor          notices a bin is low  →  raises a request
 *     whoever holds stock                      →  issues the replenishment
 *
 * Without this the second half has no prompt. The request was visible only on
 * the production floor's Kanban tab — the screen the person who *answers* it
 * has no reason to open — so an ask could sit there indefinitely while the item
 * page showed plenty of stock and nothing to do.
 *
 * **The PROMPT, not the record.** This is one line and stays one line whatever
 * the count; the reading happens in the "Restock requests" tab
 * (:mod:`item-restock-requests-tab`), which is paged and carries the history.
 *
 * The first cut listed every request here, and the Unit Ledger started further
 * down the page the busier the item got — the surface grew exactly when what
 * sat under it mattered most. Splitting prompt from record fixes that
 * permanently rather than by capping a height: a dozen bins asking looks the
 * same as two.
 *
 * The single-request case still acts from here, because it is the whole story.
 * Sending somebody to a tab to read one row is a click that answers a question
 * they have already been asked.
 *
 * Warning-toned, unlike the sibling :mod:`awaiting-put-away-banner`, and
 * deliberately — material waiting to be shelved is the ordinary path and
 * colouring it would put a yellow strip on most items most of the time, whereas
 * an open request means somebody on a production floor is waiting. Like that
 * banner, it disappears completely at zero.
 */
export function RestockRequestBanner({
  itemId,
  isConsumable,
  reloadKey,
  onIssue,
  onViewAll,
}: {
  itemId: string;
  /** Only a consumable can be issued to a Kanban, so only a consumable can
   *  have one of these. Skips the request entirely otherwise. */
  isConsumable: boolean;
  /** Bumped by the host after an issue, so a fulfilled ask disappears. */
  reloadKey?: number;
  /** Open the Issue dialog, pre-aimed at the Kanban that asked. */
  onIssue: (request: RestockRequest) => void;
  /** Go to the Restock requests tab — where several are read and answered. */
  onViewAll: () => void;
}) {
  const canSign = usePermission('inventory', 'sign');
  const [rows, setRows] = React.useState<RestockRequest[]>([]);

  React.useEffect(() => {
    if (!isConsumable) {
      setRows([]);
      return;
    }
    const ctl = new AbortController();
    kanbanRestockApi
      .listRequests({ itemId, state: 'open', limit: 50 }, { signal: ctl.signal })
      .then((res) => setRows(res.items))
      .catch(() => {
        // Silent: this is an additive surface. Failing to load it must not
        // break the item page.
      });
    return () => ctl.abort();
  }, [itemId, isConsumable, reloadKey]);

  if (rows.length === 0) return null;

  const asked = rows.reduce((n, r) => n + (r.requested_qty ?? 0), 0);
  const single = rows.length === 1 ? rows[0] : null;

  return (
    <div className="mb-4 overflow-hidden rounded-md border border-border bg-surface-2">
      {/* Identical to ``AwaitingPutAwayBanner`` down to the panel: same neutral
          surface, same icon-then-``text-sm``-clause-then-``text-xs``-detail
          structure, only the NUMBER emphasised. The two appear together on a
          consumable mid-receipt and have to read as one family.

          This was a tinted warning panel first, on the argument that an open
          request is owed work while material waiting to be shelved is routine.
          The client saw the two stacked and read the difference as an
          inconsistency rather than a signal, which is the answer that settles
          it: a distinction nobody receives is not a distinction. The icon
          colour still carries it — amber here, accent there — which is the same
          amount of signal the sibling banner uses on the same neutral panel. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2">
        <span className="flex min-w-0 items-center gap-2 text-sm">
          <ClipboardList size={15} className="shrink-0 text-warning" />
          <span className="text-text">
            <span className="font-medium tabular-nums">{rows.length}</span> open restock
            request{rows.length === 1 ? '' : 's'}
          </span>

          <span className="min-w-0 text-xs text-text-3">
          {single ? (
            // One request: name the bin, since that IS the whole story here.
            // The bin's NAME — the full address mid-sentence was four words of
            // room prefix before the one word that identifies it. Not linked:
            // this clause sits in muted banner detail, and an accent link here
            // would outshout the banner's own action button.
            <>
              · <LocationPath path={single.kanban_path} />
              {single.requested_qty !== null && (
                <>, {formatNumber(single.requested_qty)} asked for</>
              )}
              {/* The one fact that stops a second person issuing the same
                  request again, having seen no trace of the first. */}
              {single.issued_since_qty > 0 && (
                <span className="text-success">
                  {' '}
                  · {formatNumber(single.issued_since_qty)} already issued
                </span>
              )}
            </>
          ) : (
            // Only stated when somebody actually counted. A request may carry
            // no quantity at all — "we're low" is legitimate — and printing
            // "0 units asked for" would invent a number nobody gave.
            asked > 0 && (
              <>
                · {formatNumber(asked)} unit{asked === 1 ? '' : 's'} asked for
              </>
            )
          )}
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-2">
          {/* One request: act from here — it is the whole story, and sending
              somebody to a tab to read one row is a click that answers a
              question they have already been asked. */}
          {single && canSign && (
            <Button size="sm" variant="secondary" onClick={() => onIssue(single)}>
              Issue to this Kanban <ArrowRight size={13} />
            </Button>
          )}
          {/* Several: the tab is the right home. The banner stays ONE LINE
              whatever the count — it used to list every request, which pushed
              the Unit Ledger further down the busier the item got, so the
              surface grew exactly when what sat under it mattered most. */}
          {!single && (
            <Button size="sm" variant="secondary" onClick={onViewAll}>
              Review all <ArrowRight size={13} />
            </Button>
          )}
        </span>
      </div>
    </div>
  );
}
