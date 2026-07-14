'use client';

import * as React from 'react';
import { Eye, LayoutGrid, Pencil, Plus, Snowflake } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { toast } from '@/components/ui/sonner';
import { NodeContentsSheet } from '@/components/locations/node-contents-sheet';
import { usePermission } from '@/hooks/use-permission';
import { ApiError } from '@/lib/api/client';
import { locationNodesApi, type NodeTree } from '@/lib/api/location-nodes';

/** A freezer 'Location' holds shelves (open-inventory) or freezer units. */
function isShelfLocation(loc: NodeTree): boolean {
  return /open|shelf/i.test(loc.name);
}

/** Sub-location noun by location kind — a shelf location holds "Shelves", a
 *  freezer location holds "Freezers". */
function subNoun(shelf: boolean): string {
  return shelf ? 'Shelf' : 'Freezer';
}
function subNounPlural(shelf: boolean): string {
  return shelf ? 'Shelves' : 'Freezers';
}

export function FreezerClient() {
  const canWrite = usePermission('inventory', 'create');
  const canTransfer = usePermission('inventory', 'sign');

  const [rooms, setRooms] = React.useState<NodeTree[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  // Active dialog / detail sheet.
  const [addTo, setAddTo] = React.useState<NodeTree | null>(null);
  const [renaming, setRenaming] = React.useState<NodeTree | null>(null);
  const [viewingId, setViewingId] = React.useState<string | null>(null);
  const [contents, setContents] = React.useState<
    { node: NodeTree; pathLabel: string } | null
  >(null);

  // Open a sub-location's contents (allocations + transfer). Closes the
  // location detail sheet so only one side-sheet is open at a time.
  const openContents = React.useCallback((node: NodeTree, pathLabel: string) => {
    setViewingId(null);
    setContents({ node, pathLabel });
  }, []);

  const reload = React.useCallback(async (signal?: AbortSignal) => {
    setLoadError(null);
    try {
      const tree = await locationNodesApi.freezerTree({ signal });
      setRooms(tree);
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load freezers.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const ctrl = new AbortController();
    void reload(ctrl.signal);
    return () => ctrl.abort();
  }, [reload]);

  // Live location behind the detail sheet (reflects reloads).
  const viewing = React.useMemo(() => {
    if (!viewingId) return null;
    for (const room of rooms) {
      const loc = room.children.find((l) => l.id === viewingId);
      if (loc) return { room, loc };
    }
    return null;
  }, [viewingId, rooms]);
  React.useEffect(() => {
    if (viewingId && !viewing && !loading) setViewingId(null);
  }, [viewingId, viewing, loading]);

  return (
    <>
      <PageHeader
        title="Freezers"
        subtitle="Rooms → locations → sub-locations. Units are placed from Receipt Admin."
      />

      <div className="px-6 py-6 sm:px-8">
        {loadError ? (
          <div className="rounded-lg border border-border bg-bg-elev">
            <EmptyState
              title="Couldn't load freezers"
              hint={loadError}
              action={<Button onClick={() => void reload()}>Retry</Button>}
            />
          </div>
        ) : loading ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-56 w-full rounded-lg" />
            ))}
          </div>
        ) : rooms.length === 0 ? (
          <div className="rounded-lg border border-border bg-bg-elev">
            <EmptyState title="No freezers yet" hint="Seed the freezer locations to get started." />
          </div>
        ) : (
          rooms.map((room) => (
            <section key={room.id} className="mb-9 last:mb-0">
              <div className="mb-3 flex items-center gap-2">
                <span className="size-2.5 rounded-full bg-accent" aria-hidden />
                <h2 className="text-sm font-semibold text-text">{room.name}</h2>
                <span className="text-xs text-text-3">
                  {room.children.length} location{room.children.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {room.children.map((loc) => (
                  <LocationCard
                    key={loc.id}
                    category={room.name}
                    loc={loc}
                    canWrite={canWrite}
                    onView={() => setViewingId(loc.id)}
                    onRename={() => setRenaming(loc)}
                    onAddSub={() => setAddTo(loc)}
                    onRenameSub={(sub) => setRenaming(sub)}
                    onOpenSub={(sub) =>
                      openContents(sub, `${room.name} › ${loc.name} › ${sub.name}`)
                    }
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      {/* Detail sheet */}
      <Sheet open={Boolean(viewing)} onOpenChange={(o) => !o && setViewingId(null)}>
        <SheetContent side="right">
          {viewing && (
            <>
              <SheetHeader>
                <SheetTitle>{viewing.loc.name}</SheetTitle>
                <SheetDescription>
                  {viewing.room.name} › {viewing.loc.name}
                </SheetDescription>
                <div className="mt-1 flex flex-wrap gap-2">
                  <Badge tone="neutral">
                    {viewing.loc.children.length} sub-location
                    {viewing.loc.children.length === 1 ? '' : 's'}
                  </Badge>
                  <Badge tone="accent">
                    {isShelfLocation(viewing.loc) ? 'shelf storage' : 'freezer storage'}
                  </Badge>
                </div>
              </SheetHeader>
              <SheetBody className="space-y-1">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-text-3">
                    {subNounPlural(isShelfLocation(viewing.loc))}
                  </p>
                  {canWrite && (
                    <Button
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      onClick={() => setAddTo(viewing.loc)}
                    >
                      <Plus size={13} /> Add {subNoun(isShelfLocation(viewing.loc))}
                    </Button>
                  )}
                </div>
                {viewing.loc.children.length === 0 ? (
                  <p className="py-8 text-center text-sm text-text-3">
                    No {subNounPlural(isShelfLocation(viewing.loc)).toLowerCase()} yet.
                  </p>
                ) : (
                  viewing.loc.children.map((sub) => (
                    <SubLocationRow
                      key={sub.id}
                      sub={sub}
                      shelf={isShelfLocation(viewing.loc)}
                      canWrite={canWrite}
                      onOpen={() =>
                        openContents(
                          sub,
                          `${viewing.room.name} › ${viewing.loc.name} › ${sub.name}`,
                        )
                      }
                      onRename={() => setRenaming(sub)}
                    />
                  ))
                )}
              </SheetBody>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Dialogs */}
      {addTo && (
        <AddSubLocationDialog
          location={addTo}
          shelf={isShelfLocation(addTo)}
          onClose={() => setAddTo(null)}
          onDone={() => {
            setAddTo(null);
            void reload();
          }}
        />
      )}
      {renaming && (
        <RenameNodeDialog
          node={renaming}
          onClose={() => setRenaming(null)}
          onDone={() => {
            setRenaming(null);
            void reload();
          }}
        />
      )}

      <NodeContentsSheet
        open={Boolean(contents)}
        onOpenChange={(o) => !o && setContents(null)}
        node={contents?.node ?? null}
        pathLabel={contents?.pathLabel ?? ''}
        badges={<Badge tone="accent">Freezer</Badge>}
        canTransfer={canTransfer}
        onChanged={() => void reload()}
      />
    </>
  );
}

// ── Location card ──────────────────────────────────────────────────────

function LocationCard({
  category,
  loc,
  canWrite,
  onView,
  onRename,
  onAddSub,
  onRenameSub,
  onOpenSub,
}: {
  category: string;
  loc: NodeTree;
  canWrite: boolean;
  onView: () => void;
  onRename: () => void;
  onAddSub: () => void;
  onRenameSub: (sub: NodeTree) => void;
  onOpenSub: (sub: NodeTree) => void;
}) {
  const shelf = isShelfLocation(loc);
  return (
    <div className="flex flex-col rounded-lg border border-border bg-bg-elev">
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <h3 className="text-base font-semibold text-text">{loc.name}</h3>
        <Badge tone="neutral">{category}</Badge>
      </div>

      <div className="flex-1 px-4 py-3">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-3">
          {subNounPlural(shelf)}
        </p>
        {loc.children.length === 0 ? (
          <p className="py-6 text-center text-sm text-text-3">
            No {subNounPlural(shelf).toLowerCase()} yet.
          </p>
        ) : (
          <div>
            {loc.children.map((sub) => (
              <SubLocationRow
                key={sub.id}
                sub={sub}
                shelf={shelf}
                canWrite={canWrite}
                onOpen={() => onOpenSub(sub)}
                onRename={() => onRenameSub(sub)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border px-4 py-3">
        <Button variant="default" className="h-8 px-2.5 text-xs" onClick={onView}>
          <Eye size={14} /> View
        </Button>
        {canWrite && (
          <>
            <Button variant="default" className="h-8 px-2.5 text-xs" onClick={onRename}>
              <Pencil size={14} /> Edit
            </Button>
            <Button variant="default" className="h-8 px-2.5 text-xs" onClick={onAddSub}>
              <Plus size={14} /> Add {subNoun(shelf)}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function SubLocationRow({
  sub,
  shelf,
  canWrite,
  onOpen,
  onRename,
}: {
  sub: NodeTree;
  shelf: boolean;
  canWrite: boolean;
  onOpen: () => void;
  onRename: () => void;
}) {
  const Icon = shelf ? LayoutGrid : Snowflake;
  return (
    <div className="flex items-center gap-2 border-b border-border/60 py-2 last:border-0">
      <button
        type="button"
        onClick={onOpen}
        title={`View contents of ${sub.name}`}
        className="flex min-w-0 flex-1 items-center gap-2 rounded text-left hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Icon size={14} className="shrink-0 text-text-3" aria-hidden />
        <span className="truncate font-mono text-sm">{sub.name}</span>
      </button>
      <span
        className="shrink-0 font-mono text-sm tabular-nums text-text-2"
        title="On-hand units"
      >
        {sub.active_allocation_count}
      </span>
      {canWrite && (
        <button
          type="button"
          title={`Rename ${sub.name}`}
          aria-label={`Rename ${sub.name}`}
          onClick={onRename}
          className="rounded p-1.5 text-text-3 transition-colors hover:bg-surface hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Pencil size={14} />
        </button>
      )}
    </div>
  );
}

// ── Dialogs ────────────────────────────────────────────────────────────

function AddSubLocationDialog({
  location,
  shelf,
  onClose,
  onDone,
}: {
  location: NodeTree;
  shelf: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    const c = code.trim();
    if (!c) {
      setError('A sub-location code is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await locationNodesApi.create({
        node_type: 'sub_location',
        code: c,
        name: c,
        parent_id: location.id,
      });
      toast.success(`${subNoun(shelf)} added`, { description: c });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'node_code_conflict') {
        setError(`“${c}” already exists in ${location.name}.`);
      } else {
        setError(
          err instanceof ApiError
            ? err.message
            : `Failed to add ${subNoun(shelf).toLowerCase()}.`,
        );
      }
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add {subNoun(shelf)}</DialogTitle>
          <DialogDescription>
            Under {location.name}. {shelf ? 'A shelf.' : 'A freezer unit (T-number).'}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="add-sub-code">Code</Label>
            <Input
              id="add-sub-code"
              autoFocus
              className="font-mono"
              placeholder={shelf ? 'e.g. Shelf D' : 'e.g. T90019A'}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={submit} disabled={busy}>
            {busy ? 'Adding…' : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameNodeDialog({
  node,
  onClose,
  onDone,
}: {
  node: NodeTree;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = React.useState(node.name);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    const n = name.trim();
    if (!n) {
      setError('A name is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await locationNodesApi.rename(node.id, n);
      toast.success('Renamed', { description: n });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to rename.');
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="rename-name">Name</Label>
            <Input
              id="rename-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
