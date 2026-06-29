'use client';

import * as React from 'react';
import { Plus, Search } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/sonner';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/shared/empty-state';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { usePermission } from '@/hooks/use-permission';
import { vendorsApi, type Vendor } from '@/lib/api/vendors';
import { ApiError } from '@/lib/api/client';

import { VendorsTable } from './vendors-table';
import { VendorCreateDialog } from './vendor-create-dialog';
import { VendorEditDialog } from './vendor-edit-dialog';

export function VendorsPageClient() {
  const canCreate = usePermission('inventory', 'create');

  const [vendors, setVendors] = React.useState<Vendor[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<Vendor | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();

  const debounced = useDebouncedValue(query, 150);

  const load = React.useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      // Pull both active and inactive so the admin sees everything.
      const all = await vendorsApi.list({ activeOnly: false, signal });
      setVendors(all);
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load vendors.');
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
    if (!q) return vendors;
    return vendors.filter((v) =>
      v.name.toLowerCase().includes(q) ||
      (v.contact_email ?? '').toLowerCase().includes(q),
    );
  }, [vendors, debounced]);

  const handleCreated = (created: Vendor) => {
    // Insert sorted by name (case-insensitive) so the new row lands where the user expects.
    setVendors((prev) =>
      [...prev, created].sort((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
      ),
    );
    toast.success('Vendor added', { description: created.name });
  };

  const replaceVendor = (updated: Vendor): void => {
    setVendors((prev) =>
      prev
        .map((v) => (v.id === updated.id ? updated : v))
        .sort((a, b) =>
          a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
        ),
    );
  };

  const handleUpdated = (updated: Vendor): void => {
    replaceVendor(updated);
    toast.success('Vendor updated', { description: updated.name });
  };

  // Soft-delete (deactivate) — server idempotent, but we keep client-
  // side optimism honest by always re-reading the server response.
  const handleDeactivate = async (v: Vendor): Promise<void> => {
    if (!canCreate) return;
    const ok = await confirm({
      title: `Deactivate ${v.name}?`,
      description: 'It will be hidden from new item / lot pickers. You can reactivate it later.',
      confirmLabel: 'Deactivate',
      destructive: true,
    });
    if (!ok) return;
    setBusyId(v.id);
    try {
      const updated = await vendorsApi.deactivate(v.id);
      replaceVendor(updated);
      toast.success('Vendor deactivated', { description: updated.name });
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Failed to deactivate vendor.',
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleReactivate = async (v: Vendor): Promise<void> => {
    if (!canCreate) return;
    setBusyId(v.id);
    try {
      const updated = await vendorsApi.update(v.id, { is_active: true });
      replaceVendor(updated);
      toast.success('Vendor reactivated', { description: updated.name });
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Failed to reactivate vendor.',
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Vendors"
        subtitle="Master data for inventory item sourcing. Seeded from the workbook; admins add new vendors here."
        actions={
          canCreate ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={14} /> Add vendor
            </Button>
          ) : undefined
        }
      />

      <div className="px-6 py-5 sm:px-8">
        <Card className="p-4">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[220px]">
              <Search
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-3"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name or email"
                className="pl-9"
                aria-label="Search vendors"
              />
            </div>
            <div className="text-xs text-text-3">
              {loading ? 'Loading…' : `${filtered.length} of ${vendors.length}`}
            </div>
          </div>

          {loadError ? (
            <EmptyState
              title="Couldn't load vendors"
              hint={loadError}
              action={<Button onClick={() => void load()}>Retry</Button>}
            />
          ) : !loading && vendors.length === 0 ? (
            <EmptyState
              title="No vendors yet"
              hint="The seed migration usually populates this from the workbook. Add one manually below."
              action={
                canCreate ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus size={14} /> Add vendor
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <VendorsTable
              vendors={filtered}
              loading={loading}
              onEdit={canCreate ? (v) => setEditing(v) : undefined}
              onDeactivate={canCreate ? handleDeactivate : undefined}
              onReactivate={canCreate ? handleReactivate : undefined}
              busyId={busyId}
            />
          )}
        </Card>
      </div>

      <VendorCreateDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={handleCreated}
      />

      <VendorEditDialog
        open={editing !== null}
        onOpenChange={(o) => {
          if (!o) setEditing(null);
        }}
        vendor={editing}
        onUpdated={handleUpdated}
      />

      {confirmDialog}
    </>
  );
}
