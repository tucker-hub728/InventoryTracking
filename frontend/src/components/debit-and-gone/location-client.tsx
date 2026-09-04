'use client';

/**
 * One debit-and-gone location — the record of what has been issued to it.
 *
 * There is exactly one thing to show here, so there are no tabs. The location
 * holds nothing: every row in the panel below is material that LEFT controlled
 * inventory at the moment it was recorded.
 *
 * This used to be a tab on the Storage location page (``/storage/{id}/issued``),
 * beside sub-type tabs that were suppressed for a scrap location anyway. That URL
 * still works and lands here — see the redirect in ``StorageCategoryClient``.
 *
 * Deleting is offered and renaming is not restricted, but note what deletion does
 * NOT do: the ledger is append-only and still names this location, so the issue
 * history survives it. The confirm copy says so, because "nothing is lost" would
 * otherwise read as a promise about the record rather than about stock.
 */

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MinusCircle, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';

import { RenameNodeDialog } from '@/components/rooms/node-dialogs';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/sonner';
import { invalidateLocationForest } from '@/components/reconciliation/location-tree-picker';
import { ApiError } from '@/lib/api/client';
import { locationNodesApi, type NodeTree } from '@/lib/api/location-nodes';
import { STORAGE_ROOM_CODE } from '@/components/storage/storage-groups';
import { selectIsSuperAdmin, useAuthStore } from '@/stores/auth.store';

import { DEBIT_AND_GONE_HREF } from './debit-and-gone-client';
import { IssuedMaterialPanel } from './issued-material-panel';

export function DebitAndGoneLocationClient({ nodeId }: { nodeId: string }) {
  const router = useRouter();
  const isSuperAdmin = useAuthStore(selectIsSuperAdmin);
  const { confirm, confirmDialog } = useConfirm();

  const [location, setLocation] = React.useState<NodeTree | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loaded, setLoaded] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [renaming, setRenaming] = React.useState(false);

  const reload = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoadError(null);
      try {
        const rooms = await locationNodesApi.freezerTree({ signal });
        const room = rooms.find((r) => r.code === STORAGE_ROOM_CODE);
        setLocation((room?.children ?? []).find((c) => c.id === nodeId) ?? null);
        setLoaded(true);
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load this location.');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [nodeId],
  );

  React.useEffect(() => {
    const ctrl = new AbortController();
    void reload(ctrl.signal);
    return () => ctrl.abort();
  }, [reload]);

  // A storage location reached through a debit-and-gone URL. Not an error — a
  // stale link, or someone editing the address bar — so send it to the page that
  // does describe it rather than claiming it does not exist.
  React.useEffect(() => {
    if (loaded && !loadError && location && !location.is_scrap) {
      router.replace(`/storage/${location.id}`);
    }
  }, [loaded, loadError, location, router]);

  const remove = React.useCallback(async () => {
    if (!location) return;
    const ok = await confirm({
      title: `Delete ${location.name}?`,
      description:
        'It stores nothing, so no stock is affected. It disappears from the Issue ' +
        'destination picker, and nothing further can be issued to it. Material already ' +
        'issued here stays on the ledger and in the audit trail — only the location is ' +
        'removed.',
      confirmLabel: 'Delete location',
      destructive: true,
    });
    if (!ok) return;
    try {
      await locationNodesApi.remove(location.id);
      invalidateLocationForest();
      toast.success('Location deleted', { description: location.name });
      router.replace(DEBIT_AND_GONE_HREF);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : `Could not delete ${location.name}.`);
    }
  }, [location, confirm, router]);

  if (loaded && !loadError && !location) {
    return (
      <>
        <PageHeader title="Location not found" />
        <div className="px-6 py-5 sm:px-8">
          <div className="rounded-lg border border-border bg-bg-elev">
            <EmptyState
              title="This location no longer exists"
              hint="It may have been removed. Pick another from Debit-and-gone."
              action={
                <Button asChild variant="primary">
                  <Link href={DEBIT_AND_GONE_HREF}>Back to Debit-and-gone</Link>
                </Button>
              }
            />
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={location?.name ?? 'Location'}
        subtitle={
          loading ? undefined : (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-text-3">
              <Badge tone="warning">Issued material leaves inventory</Badge>
            </span>
          )
        }
        actions={
          isSuperAdmin && location ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" size="icon" aria-label="Location actions">
                  <MoreHorizontal size={15} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setRenaming(true)}>
                  <Pencil size={14} />
                  <span className="ml-2">Rename location</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => void remove()}
                  className="text-danger focus:text-danger"
                >
                  <Trash2 size={14} />
                  <span className="ml-2">Delete location</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : undefined
        }
      />

      <div className="px-6 py-5 sm:px-8">
        {loadError ? (
          <div className="rounded-lg border border-border bg-bg-elev">
            <EmptyState
              icon={MinusCircle}
              title="Couldn't load this location"
              hint={loadError}
              action={<Button onClick={() => void reload()}>Retry</Button>}
            />
          </div>
        ) : (
          location && (
            <IssuedMaterialPanel nodeId={location.id} locationName={location.name} />
          )
        )}
      </div>

      {renaming && location && (
        <RenameNodeDialog
          node={location}
          title="Rename location"
          description="The name of this location, everywhere it appears. Issues already recorded against it are unaffected."
          onClose={() => setRenaming(false)}
          onDone={() => {
            setRenaming(false);
            void reload();
          }}
        />
      )}
      {confirmDialog}
    </>
  );
}
