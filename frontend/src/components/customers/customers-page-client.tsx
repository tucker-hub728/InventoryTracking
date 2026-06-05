'use client';

import * as React from 'react';
import { Pencil, Plus, Search, Trash2 } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/shared/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { toast } from '@/components/ui/sonner';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { usePermission } from '@/hooks/use-permission';
import { customersApi, type Customer } from '@/lib/api/customers';
import { ApiError } from '@/lib/api/client';

import { CustomerFormDialog } from './customer-form-dialog';

/**
 * Customers list — name, contact, email, and the products each customer
 * orders (linked from the customer form). Create / edit / delete inline.
 */
export function CustomersPageClient() {
  const canCreate = usePermission('inventory', 'create');

  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<Customer | null>(null);
  const [deleting, setDeleting] = React.useState<Customer | null>(null);

  const debounced = useDebouncedValue(query, 150);

  const load = React.useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await customersApi.list({}, { signal });
      setCustomers(rows);
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load customers.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const filtered = React.useMemo(() => {
    const q = debounced.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.contact_person ?? '').toLowerCase().includes(q) ||
        (c.email ?? '').toLowerCase().includes(q),
    );
  }, [customers, debounced]);

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await customersApi.remove(deleting.id);
      toast.success('Customer deleted', { description: deleting.name });
      setCustomers((prev) => prev.filter((c) => c.id !== deleting.id));
    } catch (err) {
      toast.error('Delete failed', {
        description: err instanceof ApiError ? err.message : 'Please try again.',
      });
    }
  };

  const handleSaved = (saved: Customer) => {
    setCustomers((prev) => {
      const exists = prev.some((c) => c.id === saved.id);
      return exists ? prev.map((c) => (c.id === saved.id ? saved : c)) : [saved, ...prev];
    });
    toast.success(editing ? 'Customer updated' : 'Customer created', {
      description: saved.name,
    });
  };

  return (
    <>
      <PageHeader
        title="Customers"
        subtitle="The customers who order your products."
        actions={
          canCreate ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={14} /> Add customer
            </Button>
          ) : undefined
        }
      />

      <div className="px-6 py-5 sm:px-8">
        <Card className="p-4">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="relative min-w-[260px] flex-1">
              <Search
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-3"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name, contact, or email"
                className="pl-9"
                aria-label="Search customers"
              />
            </div>
            <div className="text-xs text-text-3">
              {loading ? 'Loading…' : `${filtered.length} of ${customers.length}`}
            </div>
          </div>

          {loadError ? (
            <EmptyState
              title="Couldn't load customers"
              hint={loadError}
              action={<Button onClick={() => void load()}>Retry</Button>}
            />
          ) : !loading && customers.length === 0 ? (
            <EmptyState
              title="No customers yet"
              hint="Add a customer and link the products they order."
              action={
                canCreate ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus size={14} /> Add customer
                  </Button>
                ) : undefined
              }
            />
          ) : !loading && filtered.length === 0 ? (
            <EmptyState title="No customers match" hint="Try a different search." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                    <th className="px-3 py-2 font-medium">Customer</th>
                    <th className="px-3 py-2 font-medium">Contact</th>
                    <th className="px-3 py-2 font-medium">Email</th>
                    <th className="px-3 py-2 font-medium">Linked products</th>
                    {canCreate && <th className="px-3 py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((c) => (
                    <tr
                      key={c.id}
                      className="border-b border-border/60 transition-colors hover:bg-surface"
                    >
                      <td className="px-3 py-2.5 font-medium">{c.name}</td>
                      <td className="px-3 py-2.5 text-xs text-text-2">
                        {c.contact_person ?? <span className="text-text-3">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-text-2">
                        {c.email ?? <span className="text-text-3">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        {c.products.length === 0 ? (
                          <span className="text-text-3">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {c.products.map((p) => (
                              <Badge key={p.id} tone="neutral">
                                {p.name}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </td>
                      {canCreate && (
                        <td className="px-3 py-2.5">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              className="h-8 px-2"
                              onClick={() => setEditing(c)}
                              aria-label={`Edit ${c.name}`}
                            >
                              <Pencil size={14} />
                            </Button>
                            <Button
                              variant="ghost"
                              className="h-8 px-2 text-danger"
                              onClick={() => setDeleting(c)}
                              aria-label={`Delete ${c.name}`}
                            >
                              <Trash2 size={14} />
                            </Button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <CustomerFormDialog open={creating} onOpenChange={setCreating} onSaved={handleSaved} />
      <CustomerFormDialog
        open={editing !== null}
        onOpenChange={(o) => {
          if (!o) setEditing(null);
        }}
        customer={editing ?? undefined}
        onSaved={handleSaved}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
        title="Delete customer?"
        description={
          deleting ? (
            <>
              This soft-deletes <span className="font-medium">{deleting.name}</span>. It can be
              recreated later.
            </>
          ) : undefined
        }
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
      />
    </>
  );
}
