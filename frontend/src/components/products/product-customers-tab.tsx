'use client';

import * as React from 'react';

import { EmptyState } from '@/components/shared/empty-state';
import { customersApi, type Customer } from '@/lib/api/customers';
import { ApiError } from '@/lib/api/client';

/**
 * Customers tab on a product — the customers linked to this product, with their
 * contact person and email. Loads the full customer records (the product's
 * ``customers`` only carries id + name) and filters to those linked here.
 */
export function ProductCustomersTab({ productId }: { productId: string }) {
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    customersApi
      .list({}, { signal: ctrl.signal })
      .then((rows) => {
        if (ctrl.signal.aborted) return;
        setCustomers(rows.filter((c) => c.products.some((p) => p.id === productId)));
      })
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Failed to load customers.');
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [productId]);

  if (error) {
    return (
      <div className="p-4">
        <EmptyState title="Couldn't load customers" hint={error} />
      </div>
    );
  }
  if (loading && customers.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-text-3" role="status">
        Loading customers…
      </div>
    );
  }
  if (customers.length === 0) {
    return (
      <div className="p-4">
        <EmptyState
          title="No customers linked"
          hint="Link this product to customers from the Customers page."
        />
      </div>
    );
  }

  return (
    <div className="space-y-3 p-4">
      <p className="text-xs text-text-3">
        {customers.length} customer{customers.length === 1 ? '' : 's'} ordering this product
      </p>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface text-left text-[11px] uppercase tracking-wider text-text-3">
              <th className="px-4 py-2.5 font-medium">Customer</th>
              <th className="px-4 py-2.5 font-medium">Contact person</th>
              <th className="px-4 py-2.5 font-medium">Email</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.id} className="border-b border-border/60 last:border-0 hover:bg-surface">
                <td className="px-4 py-2.5 font-medium text-text">{c.name}</td>
                <td className="px-4 py-2.5 text-text-2">{c.contact_person || '—'}</td>
                <td className="px-4 py-2.5">
                  {c.email ? (
                    <a href={`mailto:${c.email}`} className="text-accent hover:underline">
                      {c.email}
                    </a>
                  ) : (
                    <span className="text-text-3">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
