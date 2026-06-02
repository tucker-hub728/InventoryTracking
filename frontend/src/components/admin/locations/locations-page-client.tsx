'use client';

import * as React from 'react';
import { Plus, Search } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/sonner';
import { EmptyState } from '@/components/shared/empty-state';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { usePermission } from '@/hooks/use-permission';
import { locationsApi, type Location } from '@/lib/api/locations';
import { ApiError } from '@/lib/api/client';

import { LocationsTable } from './locations-table';
import { LocationCreateDialog } from './location-create-dialog';
import { LocationEditDialog } from './location-edit-dialog';

export function LocationsPageClient() {
  const canCreate = usePermission('inventory', 'create');

  const [locations, setLocations] = React.useState<Location[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<Location | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const debounced = useDebouncedValue(query, 150);

  const load = React.useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      // Pull both active and inactive so admins see everything.
      const all = await locationsApi.list({ activeOnly: false, signal });
      setLocations(all);
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load locations.');
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
    if (!q) return locations;
    return locations.filter(
      (l) =>
        l.code.toLowerCase().includes(q) ||
        l.name.toLowerCase().includes(q) ||
        l.kind.toLowerCase().includes(q),
    );
  }, [locations, debounced]);

  const handleCreated = (created: Location) => {
    // Insert sorted (kind, then code) so the new row lands where the user expects.
    setLocations((prev) =>
      [...prev, created].sort((a, b) =>
        a.kind === b.kind
          ? a.code.toLowerCase().localeCompare(b.code.toLowerCase())
          : a.kind.localeCompare(b.kind),
      ),
    );
    toast.success('Location added', { description: `${created.code} · ${created.name}` });
  };

  const replaceLocation = (updated: Location): void => {
    setLocations((prev) =>
      prev
        .map((l) => (l.id === updated.id ? updated : l))
        .sort((a, b) =>
          a.kind === b.kind
            ? a.code.toLowerCase().localeCompare(b.code.toLowerCase())
            : a.kind.localeCompare(b.kind),
        ),
    );
  };

  const handleUpdated = (updated: Location): void => {
    replaceLocation(updated);
    toast.success('Location updated', {
      description: `${updated.code} · ${updated.name}`,
    });
  };

  const handleDeactivate = async (l: Location): Promise<void> => {
    if (!canCreate) return;
    if (!window.confirm(
      `Deactivate ${l.code}? It will be hidden from movement pickers — historic movements continue to resolve.`,
    )) {
      return;
    }
    setBusyId(l.id);
    try {
      const updated = await locationsApi.deactivate(l.id);
      replaceLocation(updated);
      toast.success('Location deactivated', {
        description: `${updated.code} · ${updated.name}`,
      });
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Failed to deactivate location.',
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleReactivate = async (l: Location): Promise<void> => {
    if (!canCreate) return;
    setBusyId(l.id);
    try {
      const updated = await locationsApi.update(l.id, { is_active: true });
      replaceLocation(updated);
      toast.success('Location reactivated', {
        description: `${updated.code} · ${updated.name}`,
      });
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Failed to reactivate location.',
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Locations"
        subtitle="Storage positions — freezers, LN2 tanks, fridges, benches. Movements FK to these."
        actions={
          canCreate ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={14} /> Add location
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
                placeholder="Search by code, name, or kind"
                className="pl-9"
                aria-label="Search locations"
              />
            </div>
            <div className="text-xs text-text-3">
              {loading ? 'Loading…' : `${filtered.length} of ${locations.length}`}
            </div>
          </div>

          {loadError ? (
            <EmptyState
              title="Couldn't load locations"
              hint={loadError}
              action={<Button onClick={() => void load()}>Retry</Button>}
            />
          ) : !loading && locations.length === 0 ? (
            <EmptyState
              title="No locations yet"
              hint="Add your first storage location so movements have somewhere to land."
              action={
                canCreate ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus size={14} /> Add location
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <LocationsTable
              locations={filtered}
              loading={loading}
              onEdit={canCreate ? (l) => setEditing(l) : undefined}
              onDeactivate={canCreate ? handleDeactivate : undefined}
              onReactivate={canCreate ? handleReactivate : undefined}
              busyId={busyId}
            />
          )}
        </Card>
      </div>

      <LocationCreateDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={handleCreated}
      />

      <LocationEditDialog
        open={editing !== null}
        onOpenChange={(o) => {
          if (!o) setEditing(null);
        }}
        location={editing}
        onUpdated={handleUpdated}
      />
    </>
  );
}
