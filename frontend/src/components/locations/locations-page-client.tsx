'use client';

import * as React from 'react';
import { MapPin, Plus, Pencil, Trash2, Layers } from 'lucide-react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { usePermission } from '@/hooks/use-permission';
import { ApiError } from '@/lib/api/client';
import {
  locationsApi,
  type ApiLocation,
  type ApiLocationOverview,
  type ApiShelfOverview,
} from '@/lib/api/locations';
import { toNum } from '@/lib/api/helpers';
import { LOCATION_CATEGORIES } from '@/lib/location-categories';
import { LocationFormDialog } from './location-form-dialog';

type DialogState =
  | { kind: 'add' }
  | { kind: 'add-sub'; parentId: string }
  | { kind: 'edit'; id: string }
  | null;

export function LocationsPageClient() {
  const canCreate = usePermission('locations', 'create');
  const canEdit = usePermission('locations', 'edit');
  const canDelete = usePermission('locations', 'delete');
  const { confirm, confirmDialog } = useConfirm();

  const [overview, setOverview] = React.useState<ApiLocationOverview[]>([]);
  const [flat, setFlat] = React.useState<ApiLocation[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<DialogState>(null);
  // The full-page spinner shows only on first load; create/update/delete do a
  // silent background refresh so the cards update in place.
  const initialized = React.useRef(false);

  const load = React.useCallback(async (signal?: AbortSignal) => {
    if (!initialized.current) setLoading(true);
    setError(null);
    try {
      const [ov, list] = await Promise.all([
        locationsApi.overview({ signal }),
        locationsApi.list({}, { signal }),
      ]);
      setOverview(ov);
      setFlat(list);
      initialized.current = true;
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      setError(err instanceof ApiError ? err.message : 'Failed to load locations.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const stats = React.useMemo(() => {
    const categories = new Set(flat.map((l) => l.location_type));
    return { total: flat.length, categories: categories.size };
  }, [flat]);

  // Group top-level locations by category, ordered by the canonical list.
  const grouped = React.useMemo(() => {
    const byCat = new Map<string, ApiLocationOverview[]>();
    for (const loc of overview) {
      const arr = byCat.get(loc.location_type) ?? [];
      arr.push(loc);
      byCat.set(loc.location_type, arr);
    }
    const ordered = [...LOCATION_CATEGORIES.filter((c) => byCat.has(c)), ...[...byCat.keys()].filter((c) => !LOCATION_CATEGORIES.includes(c as never))];
    return ordered.map((cat) => ({ category: cat, locations: byCat.get(cat)! }));
  }, [overview]);

  const handleDelete = async (id: string, name: string, blocked: boolean, blockReason?: string) => {
    if (blocked) {
      toast.error(blockReason ?? 'This location can’t be deleted while it’s in use.');
      return;
    }
    const ok = await confirm({
      title: `Delete ${name}?`,
      description: 'This permanently removes the location. Only empty locations can be deleted.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await locationsApi.remove(id);
      toast.success(`${name} deleted`);
      void load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Delete failed.');
    }
  };

  const dialogNode = dialog && (
    <LocationFormDialog
      open
      onOpenChange={(o) => {
        if (!o) setDialog(null);
      }}
      mode={dialog.kind === 'edit' ? 'edit' : 'create'}
      location={dialog.kind === 'edit' ? flat.find((l) => l.id === dialog.id) : undefined}
      presetParent={
        dialog.kind === 'add-sub' ? flat.find((l) => l.id === dialog.parentId) : undefined
      }
      allLocations={flat}
      onSaved={() => {
        setDialog(null);
        void load();
      }}
    />
  );

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Locations"
        subtitle="Controlled location list with shelf sub-locations."
        actions={
          canCreate ? (
            <Button variant="primary" onClick={() => setDialog({ kind: 'add' })}>
              <Plus size={15} /> Add Location
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-6 px-6 py-5 sm:px-8">
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <StatCard icon={MapPin} label="Total locations" value={String(stats.total)} hint="Locations + shelves" />
          <StatCard
            icon={Layers}
            label="Categories used"
            value={`${stats.categories}`}
            hint={`of ${LOCATION_CATEGORIES.length} defined`}
          />
        </section>

        {error ? (
          <EmptyState title="Couldn't load locations" hint={error} />
        ) : loading ? (
          <div className="px-5 py-16 text-center text-sm text-text-3">Loading…</div>
        ) : overview.length === 0 ? (
          <EmptyState icon={MapPin} title="No locations" hint="Add your first location." />
        ) : (
          <div className="space-y-8">
            {grouped.map(({ category, locations }) => (
              <section key={category}>
                <div className="mb-3 flex items-center gap-2">
                  <span className="size-2 rounded-full bg-accent" aria-hidden />
                  <h2 className="text-sm font-semibold">{category}</h2>
                </div>
                <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
                  {locations.map((loc) => (
                    <LocationCard
                      key={loc.id}
                      loc={loc}
                      canEdit={canEdit}
                      canCreate={canCreate}
                      canDelete={canDelete}
                      onEdit={(id) => setDialog({ kind: 'edit', id })}
                      onAddSub={(parentId) => setDialog({ kind: 'add-sub', parentId })}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      {dialogNode}
      {confirmDialog}
    </div>
  );
}

function LocationCard({
  loc,
  canEdit,
  canCreate,
  canDelete,
  onEdit,
  onAddSub,
  onDelete,
}: {
  loc: ApiLocationOverview;
  canEdit: boolean;
  canCreate: boolean;
  canDelete: boolean;
  onEdit: (id: string) => void;
  onAddSub: (parentId: string) => void;
  onDelete: (id: string, code: string, blocked: boolean, reason?: string) => void;
}) {
  const hasChildren = loc.children.length > 0;
  const hasStock = toNum(loc.on_hand) > 0;
  const deleteBlocked = hasChildren || hasStock;
  const blockReason = hasChildren
    ? 'Delete its sub-locations first.'
    : hasStock
      ? 'Move or consume its stock first.'
      : undefined;

  return (
    <div className="flex flex-col rounded-lg border border-border bg-bg-elev p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium">{loc.location_name}</div>
        </div>
        <Badge tone="neutral">{loc.location_type}</Badge>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Metric label="On-hand qty" value={toNum(loc.on_hand).toLocaleString()} />
        <Metric label="Distinct lots" value={String(loc.distinct_lots)} />
      </div>

      {hasChildren && (
        <div className="mt-4">
          <div className="mb-1.5 text-[11px] uppercase tracking-wider text-text-3">Sub-locations</div>
          <div className="divide-y divide-border rounded-md border border-border">
            {loc.children.map((shelf) => (
              <ShelfRow
                key={shelf.id}
                shelf={shelf}
                canEdit={canEdit}
                canDelete={canDelete}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {canEdit && (
          <Button size="sm" variant="secondary" onClick={() => onEdit(loc.id)}>
            <Pencil size={13} /> Edit
          </Button>
        )}
        {canCreate && (
          <Button size="sm" variant="secondary" onClick={() => onAddSub(loc.id)}>
            <Plus size={13} /> Add Sub-Location
          </Button>
        )}
        {canDelete && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-danger disabled:opacity-40"
            disabled={deleteBlocked}
            title={deleteBlocked ? blockReason : undefined}
            onClick={() => onDelete(loc.id, loc.location_name, deleteBlocked, blockReason)}
          >
            <Trash2 size={13} /> Delete
          </Button>
        )}
      </div>
    </div>
  );
}

function ShelfRow({
  shelf,
  canEdit,
  canDelete,
  onEdit,
  onDelete,
}: {
  shelf: ApiShelfOverview;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: (id: string) => void;
  onDelete: (id: string, code: string, blocked: boolean, reason?: string) => void;
}) {
  const hasStock = toNum(shelf.on_hand) > 0;
  const blockReason = hasStock ? 'Move or consume its stock first.' : undefined;
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <MapPin size={13} className="text-text-3" />
        <span>{shelf.location_name}</span>
      </div>
      <div className="flex items-center gap-1">
        <span className="mr-1 text-xs tabular-nums text-text-3">
          {toNum(shelf.on_hand).toLocaleString()}
        </span>
        {canEdit && (
          <Button size="icon-sm" variant="ghost" aria-label="Edit shelf" onClick={() => onEdit(shelf.id)}>
            <Pencil size={13} />
          </Button>
        )}
        {canDelete && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Delete shelf"
            className="text-danger disabled:opacity-40"
            disabled={hasStock}
            title={blockReason}
            onClick={() => onDelete(shelf.id, shelf.location_name, hasStock, blockReason)}
          >
            <Trash2 size={13} />
          </Button>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-2 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wider text-text-3">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof MapPin;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-elev px-4 py-3.5">
      <div className="flex items-start justify-between">
        <div className="text-[11px] uppercase tracking-wider text-text-3">{label}</div>
        <Icon size={16} className="text-text-3" />
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-text-3">{hint}</div>
    </div>
  );
}
