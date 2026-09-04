'use client';

import * as React from 'react';
import { ArrowRight, ClipboardList } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shared/empty-state';
import { Label } from '@/components/ui/label';
import { NumberedPagination } from '@/components/ui/numbered-pagination';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AcknowledgeConsumptionAction } from '@/components/consumables/acknowledge-consumption-action';
import { ApiError } from '@/lib/api/client';
import {
  kanbanRestockApi,
  RESTOCK_STATE_LABEL,
  type RestockRequest,
  type RestockState,
} from '@/lib/api/consumables';
import { formatDate, formatNumber } from '@/lib/utils';
import { LocationPath } from '@/components/locations/location-path';

const STATE_TONE: Record<RestockState, 'warning' | 'success' | 'neutral'> = {
  open: 'warning',
  fulfilled: 'success',
  cancelled: 'neutral',
};

/**
 * "Restock requests" tab — every ask raised against this consumable (KAN-001).
 *
 * A tab AND a banner, which is worth explaining because the sibling
 * `AwaitingPutAwayBanner` argues against tabs for this shape of thing. That
 * argument is about a to-do being hidden behind a click, and it still holds:
 * the banner above the tabs is what makes an open request impossible to miss.
 *
 * What it does not cover is the rest of the story. A request has a life —
 * raised, partly issued against, acknowledged with a figure, or withdrawn — and
 * that history is a legitimate per-item view, the same shape as the Unit Ledger
 * and paged for the same reason. So the two split by job: the banner is the
 * PROMPT and stays one line; this is the RECORD.
 *
 * Only consumables get the tab, which is not a special case but the existing
 * rule — ``tabsForItem`` already varies by tier and by ``is_consumable``, and a
 * non-consumable cannot be issued to a Kanban.
 */
export function ItemRestockRequestsTab({
  itemId,
  canSign,
  onIssue,
  onChanged,
  reloadKey,
}: {
  itemId: string;
  canSign: boolean;
  /** Opens the header's Issue dialog aimed at the Kanban that asked. */
  onIssue?: (prefill: { kanbanNodeId: string; qty: number | null }) => void;
  /** Tell the page a request changed, so the banner above the tabs re-reads. */
  onChanged?: () => void;
  /** Bumped by the page when something ELSE changed a request — an issue made
   *  from the header or the banner. Refetches in place; never remounts. */
  reloadKey?: number;
}) {
  /**
   * A switch, not a two-segment control.
   *
   * "Open | All" as segments implies two peer views of equal standing, and it
   * reads as a question the user has to answer before the table means
   * anything. It is not: open requests are what anyone comes here for, and
   * closed ones are context you occasionally want as well. A switch says that
   * — there is a default, and you are adding to it — in a control a third the
   * width, and it leaves the header room for the count that actually helps.
   */
  const [showClosed, setShowClosed] = React.useState(false);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(15);
  const [rows, setRows] = React.useState<RestockRequest[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  /** Bumped after an acknowledgment made HERE. The page is told too
   *  (``onChanged``) so the banner above the tabs re-reads — the request it is
   *  counting has just been answered. */
  const [seq, setSeq] = React.useState(0);
  const reload = React.useCallback(() => {
    setSeq((s) => s + 1);
    onChanged?.();
  }, [onChanged]);

  React.useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    kanbanRestockApi
      .listRequests(
        {
          itemId,
          state: showClosed ? undefined : 'open',
          limit: pageSize,
          offset: (page - 1) * pageSize,
        },
        { signal: ctl.signal },
      )
      .then((res) => {
        setRows(res.items);
        setTotal(res.total);
        setError(null);
      })
      .catch((err) => {
        if (ctl.signal.aborted) return;
        setError(err instanceof ApiError ? err.message : 'Failed to load restock requests.');
      })
      .finally(() => {
        if (!ctl.signal.aborted) setLoading(false);
      });
    return () => ctl.abort();
  }, [itemId, showClosed, page, pageSize, seq, reloadKey]);

  // Narrowing the set must reset the page, or turning the switch off while on
  // page 3 lands past the end and the table reads as empty.
  const changeShowClosed = (v: boolean) => {
    setShowClosed(v);
    setPage(1);
  };
  const changePageSize = (n: number) => {
    setPageSize(n);
    setPage(1);
  };

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    // ``p-4`` because each tab owns its own padding here — the shell renders
    // the panel flush (see ``ItemStockLocationsTab``, same wrapper). Without it
    // the toolbar sits hard against the tab bar above and the table below.
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="flex items-center gap-2">
          <Switch id="restock-show-closed" checked={showClosed} onCheckedChange={changeShowClosed} />
          <Label htmlFor="restock-show-closed" className="cursor-pointer text-xs text-text-2">
            Include closed
          </Label>
        </span>
        {total > 0 && (
          <span className="text-xs text-text-3">
            {formatNumber(total)} {showClosed ? 'request' : 'open request'}
            {total === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {error ? (
        <p className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
          {error}
        </p>
      ) : loading && rows.length === 0 ? (
        <p className="py-8 text-center text-xs text-text-3">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={showClosed ? 'No restock requests yet' : 'No open restock requests'}
          hint={
            showClosed
              ? 'A request is raised from a production floor’s Kanban tab when a bin runs low.'
              : 'Nothing is waiting on stores for this consumable.'
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          {/* ``table-fixed`` with explicit widths, so the layout does not depend
              on what is IN the cells.

              With the browser's default auto layout the columns were measured
              from content, so switching "Include closed" on — which adds a
              closed date, a signer and a used figure into Status — silently
              re-proportioned every other column. The table appeared to jump
              because the filter changed the widest string in a cell, which is
              not a thing the reader asked to change.

              Kanban is left unsized on purpose: under ``table-fixed`` the one
              column without a width absorbs whatever is left, so it takes the
              slack instead of a percentage guessed here. It used to need that
              slack for a full room › station path; the cell now renders only
              the station and keeps the path in its hover panel, so the slack is
              simply where the spare width goes rather than a requirement. */}
          {/* The fixed widths total 48rem; below this the Kanban column would
              be crushed to nothing, so the wrapper scrolls instead. */}
          <Table className="w-full min-w-[64rem] table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead>Kanban</TableHead>
                <TableHead className="w-[9.5rem]">Asked</TableHead>
                <TableHead className="w-[7rem] text-right">Requested</TableHead>
                <TableHead className="w-[7.5rem] text-right">Issued since</TableHead>
                {/* No "Used" column. It is only ever set on a CLOSED request,
                    so in the default view — open requests — it was an em dash
                    in every row, a column earning its width by being empty.
                    The figure moved into Status, beside the closure it
                    describes, rather than being dropped: it is the only record
                    of what an operator said was consumed and exists nowhere
                    else in the system. */}
                <TableHead className="w-[10rem]">Status</TableHead>
                {/* Wide enough for Issue + Acknowledge side by side; the
                    buttons cannot shrink, so a percentage would clip them on a
                    narrow viewport instead of scrolling. */}
                <TableHead className="w-[14rem]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="align-top">
                    {/* The station, with its room one hover away. This used to
                        print the whole room › station path and truncate it,
                        which clipped the station name — the half that says
                        which bin this request is about. */}
                    <LocationPath nodeId={r.kanban_node_id} path={r.kanban_path} />
                    {/* Clamped to one line with the full text on hover. A note
                        is free text an operator typed at a bin; left to wrap it
                        sets the height of every other cell in the row, and one
                        long one turns the table into a wall. */}
                    {r.note && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="mt-1 block max-w-[22rem] truncate text-xs text-text-3">
                            “{r.note}”
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-sm">{r.note}</TooltipContent>
                      </Tooltip>
                    )}
                  </TableCell>
                  <TableCell className="align-top whitespace-nowrap text-xs text-text-3">
                    {formatDate(r.requested_at)}
                    {r.requested_by && <span className="mt-0.5 block">by {r.requested_by}</span>}
                  </TableCell>
                  {/* An em dash, never 0 — a request may legitimately carry no
                      quantity ("we're low"), and a zero would read as somebody
                      having asked for none. */}
                  <TableCell className="align-top text-right tabular-nums">
                    {r.requested_qty === null ? (
                      <span className="text-text-3">—</span>
                    ) : (
                      formatNumber(r.requested_qty)
                    )}
                  </TableCell>
                  <TableCell className="align-top text-right tabular-nums">
                    {r.issued_since_qty > 0 ? (
                      <span className="text-success">{formatNumber(r.issued_since_qty)}</span>
                    ) : (
                      <span className="text-text-3">—</span>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    <Badge tone={STATE_TONE[r.state]}>{RESTOCK_STATE_LABEL[r.state]}</Badge>
                    {/* What the operator SAID was used, sitting with the
                        closure it belongs to. Deliberately NOT reconciled
                        against "Issued since": nothing counts what is
                        physically in the bin, so the two are separate
                        statements and putting them in one arithmetic would
                        invent a balance. */}
                    {r.consumed_qty !== null && (
                      <span className="mt-1 block whitespace-nowrap text-xs text-text-2">
                        {formatNumber(r.consumed_qty)} used
                      </span>
                    )}
                    {r.closed_at && (
                      <span className="mt-0.5 block whitespace-nowrap text-xs text-text-3">
                        {formatDate(r.closed_at)}
                        {r.closed_by && <> by {r.closed_by}</>}
                      </span>
                    )}
                  </TableCell>
                  {/* Both halves of what you can do to an open request, in the
                      order they happen: send more, or close it out. The same
                      pair the production floor's Kanban tab offers — the
                      request is answered from whichever screen you are on, so
                      neither may be a subset of the other. */}
                  <TableCell className="align-top text-right">
                    {r.state === 'open' && canSign && (
                      <span className="flex justify-end gap-1.5">
                        {onIssue && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              onIssue({ kanbanNodeId: r.kanban_node_id, qty: r.requested_qty })
                            }
                          >
                            Issue <ArrowRight size={13} />
                          </Button>
                        )}
                        <AcknowledgeConsumptionAction request={r} onDone={reload} />
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {total > 0 && (
        <NumberedPagination
          page={page}
          pageCount={pageCount}
          pageSize={pageSize}
          total={total}
          startIdx={(page - 1) * pageSize}
          rowsOnPage={rows.length}
          onPageChange={setPage}
          onPageSizeChange={changePageSize}
          noun="request"
        />
      )}
    </div>
  );
}
