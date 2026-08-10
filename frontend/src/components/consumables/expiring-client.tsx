'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, Settings2, ShieldCheck } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { NumberedPagination } from '@/components/ui/numbered-pagination';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { ItemLink } from '@/components/inventory/item-link';
import { LocationLink } from '@/components/locations/location-link';
import { AcknowledgeDialog } from '@/components/consumables/acknowledge-dialog';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import { consumablesApi, type IssuedConsumable } from '@/lib/api/consumables';
import { usePermission } from '@/hooks/use-permission';

/**
 * Consumables approaching or past their expiration, across every Kanban
 * (REQ-2026-07-01-LOC-008 — "raise an automated expiration alert … prompting a
 * physical check", with a user able to clear the flag).
 *
 * Cross-area on purpose: "what needs checking?" should not mean opening nine
 * clean rooms one at a time. Per-room detail lives on each floor's Kanban tab.
 *
 * Nothing here is swept or scheduled — the backend derives each flag on read
 * from the lot's expiry, today, and the configured lead time.
 */
export function ExpiringClient() {
  const canEdit = usePermission('inventory', 'edit');

  const [rows, setRows] = React.useState<IssuedConsumable[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(25);
  const [warnDays, setWarnDays] = React.useState<number | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [ack, setAck] = React.useState<IssuedConsumable | null>(null);
  const [policyOpen, setPolicyOpen] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);

  const reload = React.useCallback(() => setReloadKey((k) => k + 1), []);

  // A page-size change returns to page 1 — otherwise you can be stranded on a
  // page that no longer exists.
  React.useEffect(() => setPage(1), [pageSize]);

  React.useEffect(() => {
    const ctrl = new AbortController();
    setLoadError(null);
    Promise.all([
      consumablesApi.expiring(
        { limit: pageSize, offset: (page - 1) * pageSize },
        { signal: ctrl.signal },
      ),
      consumablesApi.expiryPolicy({ signal: ctrl.signal }),
    ])
      .then(([list, policy]) => {
        setRows(list.items);
        setTotal(list.total);
        setWarnDays(policy.warn_days);
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load the alerts.');
      });
    return () => ctrl.abort();
  }, [reloadKey, page, pageSize]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const startIdx = (page - 1) * pageSize;

  // Acknowledging the last row on the final page would otherwise leave you on
  // an empty page.
  React.useEffect(() => {
    if (rows && total > 0 && page > pageCount) setPage(pageCount);
  }, [rows, total, page, pageCount]);

  // Expired first within the page. Server-side ordering is already
  // earliest-expiry-first, so this only groups what is on screen — the counts
  // in the subtitle are per page, not per register.
  const expired = (rows ?? []).filter((r) => r.flag === 'expired');
  const warning = (rows ?? []).filter((r) => r.flag === 'warn');

  return (
    <>
      <PageHeader
        title="Expiring consumables"
        crumbs={[{ label: 'Expiring consumables' }]}
        subtitle={
          <span className="flex items-center gap-2 text-xs text-text-3">
            <AlertTriangle size={13} className="text-warning" />
            {/* Whole-register count, not this page's — the paginator below says
                which slice is on screen. */}
            {total} need{total === 1 ? 's' : ''} a physical check
            {warnDays !== null && <> · warning {warnDays} days ahead</>}
          </span>
        }
        actions={
          canEdit && (
            <Button onClick={() => setPolicyOpen(true)}>
              <Settings2 size={14} /> Warning period
            </Button>
          )
        }
      />

      <div className="px-6 py-5 sm:px-8">
        <Card className="min-w-0 overflow-hidden">
          {loadError ? (
            <EmptyState icon={AlertTriangle} title="Couldn't load the alerts" hint={loadError} />
          ) : rows === null ? (
            <p className="p-6 text-center text-xs text-text-3">Loading…</p>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title="Nothing needs a check"
              hint="Consumables issued to a Kanban appear here as they approach their expiration date. Anything received without a date never raises a flag."
            />
          ) : (
            <ul className="divide-y divide-border">
              {[...expired, ...warning].map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm"
                >
                  <Badge tone={r.flag === 'expired' ? 'danger' : 'warning'} className="gap-1">
                    <AlertTriangle size={11} />
                    {r.flag === 'expired' ? 'Expired' : `${r.days_to_expiry}d left`}
                  </Badge>
                  <ItemLink itemId={r.item_id} itemNumber={r.item_number} />
                  <span className="text-text-3">×{r.qty}</span>
                  {r.lot_number && (
                    <span className="font-mono text-[11px] text-text-3">Lot {r.lot_number}</span>
                  )}
                  {/* The whole breadcrumb is the link: both halves lead to the
                      same place — that room's Kanban tab — and this list is
                      cross-area, so the room name is the part that orients you. */}
                  <LocationLink
                    nodeId={r.kanban_node_id}
                    name={r.kanban_path}
                    path={r.kanban_path}
                    className="text-xs"
                  />
                  {r.expiration_date && (
                    <span className="text-[11px] text-text-3">
                      {new Date(r.expiration_date).toLocaleDateString()}
                    </span>
                  )}
                  <span className="ml-auto text-[11px] text-text-3">
                    issued {new Date(r.issued_at).toLocaleDateString()}
                    {r.issued_by && <> by {r.issued_by}</>}
                  </span>
                  {canEdit && (
                    <button
                      type="button"
                      className="text-[11px] text-accent hover:underline"
                      onClick={() => setAck(r)}
                    >
                      Acknowledge
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {!loadError && total > 0 && (
            <div className="border-t border-border px-4 py-3">
              <NumberedPagination
                page={page}
                pageCount={pageCount}
                pageSize={pageSize}
                total={total}
                startIdx={startIdx}
                rowsOnPage={rows?.length ?? 0}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
                noun="alert"
              />
            </div>
          )}
        </Card>

        <p className="mt-3 text-xs text-text-3">
          A consumable is checked in the room it was issued to. Clearing a flag records what
          happened to it and keeps the issue on the{' '}
          <Link href="/production" className="text-accent hover:underline">
            production area&apos;s
          </Link>{' '}
          Kanban tab.
        </p>
      </div>

      <AcknowledgeDialog row={ack} onOpenChange={(o) => !o && setAck(null)} onDone={reload} />
      <WarnDaysDialog
        open={policyOpen}
        onOpenChange={setPolicyOpen}
        current={warnDays}
        onSaved={reload}
      />
    </>
  );
}


/**
 * How many days ahead a consumable starts warning.
 *
 * A setting rather than a constant because the requirements genuinely
 * disagree: LOC-008 alerts only once stock is past its date, Transaction Spec
 * §4.2 wants a warning as it approaches, and the July 9 amendment never gives a
 * number. Zero means "only once expired" — the literal LOC-008 reading.
 */
function WarnDaysDialog({
  open,
  onOpenChange,
  current,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: number | null;
  onSaved: () => void;
}) {
  const [value, setValue] = React.useState('30');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setValue(String(current ?? 30));
      setError(null);
      setBusy(false);
    }
  }, [open, current]);

  const n = Number(value);
  const valid = Number.isInteger(n) && n >= 0 && n <= 3650;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await consumablesApi.setExpiryPolicy(n);
      toast.success('Warning period updated', {
        description: n === 0 ? 'Alerts only once expired' : `Warning ${n} days ahead`,
      });
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save the setting.');
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Expiration warning period</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="text-xs text-text-3">
            How many days before its expiration date a consumable starts warning. Set 0 to
            flag only once it has expired.
          </p>
          <div className="space-y-1.5">
            <label htmlFor="warn-days" className="text-xs font-medium text-text-2">
              Days ahead
            </label>
            <Input
              id="warn-days"
              type="number"
              min={0}
              max={3650}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
            {!valid && <p className="text-xs text-danger">Enter a whole number, 0–3650.</p>}
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!valid || busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
