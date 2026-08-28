'use client';

/**
 * One customer — who they are, and everything that has ever been shipped to them.
 *
 * The page answers two questions, which is why it has two tabs rather than one
 * long table:
 *
 *   * **By item** — "how much of what have we sent them?" A rollup, no paging.
 *   * **Shipments** — "what left, and when?" The dated history, server-paged.
 *
 * The one thing this page must never do is read like a holding. Every figure on
 * it counts stock that LEFT the system at the moment it was recorded — a
 * ``customer_shipment`` has no destination location by the ``ship01`` CHECK — so
 * a customer named beside "1,240 units" would otherwise read as a balance they
 * are keeping for CellReady. The band says so in words, exactly as the
 * disposition log does for a debit-and-gone location.
 *
 * Read-only throughout (CUST-003). The only writable thing here is the customer's
 * own master data — name, contact, email — behind the Edit button, and per
 * CUST-002 there is deliberately no address among them: shipping is driven by
 * the sales order, and only light contact info is retained.
 *
 * The shell loads the customer AND the by-item rollup, then hands the rollup to
 * the tab through context: the summary band needs the same figures the first tab
 * renders, and fetching them twice would show two spinners for one answer. The
 * Shipments tab pages its own data, since the shell has no business holding a
 * page cursor.
 */

import * as React from 'react';
import Link from 'next/link';
import { Pencil, PackageX } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { RouteTabs, type RouteTab } from '@/components/shared/route-tabs';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/sonner';
import { usePermission } from '@/hooks/use-permission';
import { ApiError } from '@/lib/api/client';
import { customersApi, type Customer } from '@/lib/api/customers';
import { shipmentsApi, type CustomerShippedItems } from '@/lib/api/shipments';

import { CustomerFormDialog } from './customer-form-dialog';

export const CUSTOMERS_HREF = '/customers';

/** Date + time, for a single recorded action. */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Date only — for "last shipped", where the minute is noise. */
export function formatDay(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}

interface ShellContext {
  customer: Customer | null;
  /** The by-item rollup, shared with the first tab so it is fetched once. */
  shipped: CustomerShippedItems | null;
  shippedLoading: boolean;
  shippedError: string | null;
  reloadShipped: () => void;
}

const Ctx = React.createContext<ShellContext>({
  customer: null,
  shipped: null,
  shippedLoading: true,
  shippedError: null,
  reloadShipped: () => {},
});

export const useCustomerDetail = (): ShellContext => React.useContext(Ctx);

/**
 * One figure in the summary band.
 *
 * Every stat is exactly two lines — label over value — so the row aligns on both.
 * An explanatory line under a single stat is what broke that: the band aligns its
 * items on one edge, so the one taller block shifted its label and value out of
 * line with the rest of the row. Anything a figure needs to explain goes in
 * ``title`` and stays out of the layout.
 */
function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div title={title}>
      <div className="text-[10px] font-medium uppercase tracking-wider text-text-3">{label}</div>
      <div className="mt-0.5 font-mono text-xl tabular-nums text-text">{value}</div>
    </div>
  );
}

export function CustomerDetailShell({
  customerId,
  children,
}: {
  customerId: string;
  children: React.ReactNode;
}) {
  const canManage = usePermission('inventory', 'create');

  const [customer, setCustomer] = React.useState<Customer | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [notFound, setNotFound] = React.useState(false);
  const [editing, setEditing] = React.useState(false);

  const [shipped, setShipped] = React.useState<CustomerShippedItems | null>(null);
  const [shippedLoading, setShippedLoading] = React.useState(true);
  const [shippedError, setShippedError] = React.useState<string | null>(null);
  const [shippedReload, setShippedReload] = React.useState(0);

  React.useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setLoadError(null);
    setNotFound(false);
    customersApi
      .get(customerId, { signal: ctrl.signal })
      .then(setCustomer)
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        // A deleted or mistyped id is not an error worth a red box — the empty
        // state below sends them back to the list instead.
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
        else setLoadError(err instanceof ApiError ? err.message : 'Failed to load this customer.');
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [customerId]);

  React.useEffect(() => {
    const ctrl = new AbortController();
    setShippedLoading(true);
    setShippedError(null);
    shipmentsApi
      .shippedItems(customerId, { signal: ctrl.signal })
      .then(setShipped)
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setShippedError(
          err instanceof ApiError ? err.message : 'Failed to load the shipping history.',
        );
      })
      .finally(() => {
        // An aborted request must not clear `loading` — StrictMode's
        // mount/abort/remount would otherwise paint an empty band as final.
        if (!ctrl.signal.aborted) setShippedLoading(false);
      });
    return () => ctrl.abort();
  }, [customerId, shippedReload]);

  const ctx = React.useMemo<ShellContext>(
    () => ({
      customer,
      shipped,
      shippedLoading,
      shippedError,
      reloadShipped: () => setShippedReload((n) => n + 1),
    }),
    [customer, shipped, shippedLoading, shippedError],
  );

  const tabs: readonly RouteTab[] = React.useMemo(
    () => [
      {
        href: `/customers/${customerId}`,
        label: 'By item',
        count: shipped?.items.length,
      },
      {
        href: `/customers/${customerId}/shipments`,
        label: 'Shipments',
        count: shipped?.shipment_count,
      },
    ],
    [customerId, shipped],
  );

  if (notFound) {
    return (
      <>
        <PageHeader title="Customer not found" crumbs={[{ label: 'Customers', href: CUSTOMERS_HREF }]} />
        <div className="px-6 py-5 sm:px-8">
          <div className="rounded-lg border border-border bg-bg-elev">
            <EmptyState
              title="This customer no longer exists"
              hint="It may have been deleted. Shipments already recorded to it stay on the ledger."
              action={
                <Button asChild variant="primary">
                  <Link href={CUSTOMERS_HREF}>Back to customers</Link>
                </Button>
              }
            />
          </div>
        </div>
      </>
    );
  }

  if (loadError) {
    return (
      <>
        <PageHeader title="Customer" crumbs={[{ label: 'Customers', href: CUSTOMERS_HREF }]} />
        <div className="px-6 py-5 sm:px-8">
          <div className="rounded-lg border border-border bg-bg-elev">
            <EmptyState
              title="Couldn’t load this customer"
              hint={loadError}
              action={
                <Button asChild>
                  <Link href={CUSTOMERS_HREF}>Back to customers</Link>
                </Button>
              }
            />
          </div>
        </div>
      </>
    );
  }

  // Contact details, not an address: CUST-002 keeps the shipping address off the
  // customer record on purpose — it belongs to the sales order.
  const contactBits = [customer?.contact_person, customer?.email].filter(Boolean) as string[];

  return (
    <>
      <PageHeader
        title={customer?.name ?? (loading ? 'Loading…' : 'Customer')}
        crumbs={[{ label: 'Customers', href: CUSTOMERS_HREF }, { label: customer?.name ?? '…' }]}
        subtitle={
          contactBits.length > 0 ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {contactBits.map((bit, i) => (
                <React.Fragment key={bit}>
                  {i > 0 && (
                    <span aria-hidden className="text-text-3">
                      ·
                    </span>
                  )}
                  <span>{bit}</span>
                </React.Fragment>
              ))}
            </span>
          ) : (
            <span className="text-text-3">No contact details recorded.</span>
          )
        }
        actions={
          canManage && customer ? (
            <Button variant="ghost" onClick={() => setEditing(true)}>
              <Pencil size={14} /> Edit
            </Button>
          ) : undefined
        }
        tabs={<RouteTabs tabs={tabs} label="Customer history" />}
      />

      <div className="space-y-4 px-6 py-5 sm:px-8">
        {/* The figures first, as figures. "1,240 units" beside a customer name
            reads as a BALANCE THEY HOLD unless something says otherwise, which
            is the single most damaging way to misread this page — so the caption
            carries the correction rather than trusting the column headings. */}
        <div className="rounded-lg border border-border bg-bg-elev px-4 py-3">
          {shippedLoading && shipped === null ? (
            <div className="flex flex-wrap gap-x-8 gap-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-24" />
              ))}
            </div>
          ) : shippedError ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-text-2">{shippedError}</p>
              <Button onClick={() => setShippedReload((n) => n + 1)}>Retry</Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
              <Stat label="Units shipped" value={(shipped?.total_qty ?? 0).toLocaleString()} />
              <Stat
                label="Shipments"
                value={(shipped?.shipment_count ?? 0).toLocaleString()}
                title="Signed ship actions. One shipment drawn from several lots counts once."
              />
              <Stat label="Items" value={(shipped?.items.length ?? 0).toLocaleString()} />
              <Stat
                label="Last shipped"
                value={formatDay(
                  // The rollup is ordered by quantity, not by date, so the most
                  // recent shipment can sit on any row.
                  shipped?.items.reduce<string | null>(
                    (latest, r) =>
                      r.last_shipped_at && (!latest || r.last_shipped_at > latest)
                        ? r.last_shipped_at
                        : latest,
                    null,
                  ) ?? null,
                )}
              />
              <p className="ml-auto max-w-sm text-xs text-text-3">
                A record of what <span className="text-warning">left inventory</span> for{' '}
                {customer?.name ?? 'this customer'} — not stock held on their behalf. The history is
                read-only; a correction is a new ledger entry.
              </p>
            </div>
          )}
        </div>

        <Ctx.Provider value={ctx}>{children}</Ctx.Provider>
      </div>

      {customer && (
        <CustomerFormDialog
          open={editing}
          onOpenChange={setEditing}
          customer={customer}
          onSaved={(saved) => {
            setCustomer(saved);
            toast.success('Customer updated', { description: saved.name });
          }}
        />
      )}
    </>
  );
}

/** Shared empty state for a customer nothing has ever been shipped to. */
export function NeverShippedEmptyState({ customerName }: { customerName: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-elev">
      <EmptyState
        icon={PackageX}
        title={`Nothing shipped to ${customerName} yet`}
        hint={
          'Shipments appear here once a finished good is shipped out. Ship from the item’s page — ' +
          'open the item and choose Ship to customer.'
        }
      />
    </div>
  );
}
