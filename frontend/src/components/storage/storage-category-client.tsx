'use client';

/**
 * One Storage location, and the units inside each of its sub-types.
 *
 * The tabs ARE the location's groups — real ``room_location`` nodes, one per
 * sub-type switched on (REQ-2026-08-04-LOC-001). A group with nothing in it is
 * an empty tab, not a missing one; a sub-type that was never switched on has no
 * tab at all.
 *
 * From the tab body down this is the Cold Storage page: the units are
 * ``sub_location`` nodes rendered by the same ``StorageLeafGrid``, added by the
 * same ``AddNodeDialog``, renamed by the same ``RenameNodeDialog`` and opened
 * into the same ``NodeContentsSheet``. That is deliberate — Storage is meant to
 * replace the Cold Storage structure, and it should not feel like a different
 * product on the way there.
 *
 * The open panel is reflected in the URL (``/storage/{id}/{tab}/{nodeId}``) so a
 * refresh or a shared link reopens the same unit — but clicking a unit is NOT a
 * router navigation. It rewrites the address bar with
 * ``window.history.pushState`` and opens the panel from local state. Routing
 * would change a dynamic segment's value, and changing a dynamic segment's key
 * unmounts the page subtree and mounts a fresh one — throwing away the loaded
 * tree and refetching it on every click. Same reasoning as ``RoomClient`` and
 * the Materials Management page.
 */

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MinusCircle, MoreHorizontal, Pencil, Plus, Settings2, Trash2 } from 'lucide-react';

import { NodeContentsSheet } from '@/components/locations/node-contents-sheet';
import { useHierarchySearch } from '@/components/locations/use-hierarchy-search';
import { AddNodeDialog, RenameNodeDialog } from '@/components/rooms/node-dialogs';
import { RoomSearch } from '@/components/rooms/room-search';
import { StorageLeafGrid } from '@/components/rooms/storage-leaf-grid';
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
import { usePermission } from '@/hooks/use-permission';
import { ApiError } from '@/lib/api/client';
import { locationNodesApi, type NodeTree } from '@/lib/api/location-nodes';
import { selectIsSuperAdmin, useAuthStore } from '@/stores/auth.store';
import { cn } from '@/lib/utils';

import { ConfigureGroupsDialog } from './configure-groups-dialog';
import { IssuedMaterialPanel } from './issued-material-panel';
import {
  ISSUED_SEGMENT,
  STORAGE_HREF,
  STORAGE_ROOM_CODE,
  groupByCode,
  storageHref,
  type StorageGroup,
} from './storage-groups';

export function StorageCategoryClient({
  categoryId,
  segment,
  nodeId,
}: {
  categoryId: string;
  /** Which sub-type's tab is open, from the URL. */
  segment: string;
  /** A unit whose contents panel should be open on first paint (from the URL).
   *  After that the panel is driven by local state. */
  nodeId?: string;
}) {
  const router = useRouter();
  const canTransfer = usePermission('inventory', 'sign');
  const isSuperAdmin = useAuthStore(selectIsSuperAdmin);

  const [category, setCategory] = React.useState<NodeTree | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loaded, setLoaded] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [addTo, setAddTo] = React.useState<{ group: NodeTree; tpl: StorageGroup } | null>(null);
  const [renaming, setRenaming] = React.useState<NodeTree | null>(null);
  const [configuring, setConfiguring] = React.useState(false);
  const { confirm, confirmDialog } = useConfirm();

  const [openId, setOpenId] = React.useState<string | undefined>(nodeId);
  const [search, setSearch] = React.useState('');

  const reload = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoadError(null);
      try {
        const rooms = await locationNodesApi.freezerTree({ signal });
        const room = rooms.find((r) => r.code === STORAGE_ROOM_CODE);
        setCategory((room?.children ?? []).find((c) => c.id === categoryId) ?? null);
        setLoaded(true);
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load this location.');
      } finally {
        // An ABORTED request must not clear `loading` — StrictMode's
        // mount/abort/remount would otherwise leave loading=false with no data
        // and the guards below would fire against an empty tree.
        if (!signal?.aborted) setLoading(false);
      }
    },
    [categoryId],
  );

  React.useEffect(() => {
    const ctrl = new AbortController();
    void reload(ctrl.signal);
    return () => ctrl.abort();
  }, [reload]);

  const groups = React.useMemo(() => category?.children ?? [], [category]);
  /** The tabs: this location's groups, each paired with its template entry.
   *  Anything without a recognised code is skipped rather than rendered as a
   *  nameless tab — it would have no icon, no copy and no segment. */
  const tabs = React.useMemo(
    () =>
      groups
        .map((group) => ({ group, tpl: groupByCode(group.code) }))
        .filter((t): t is { group: NodeTree; tpl: StorageGroup } => t.tpl !== undefined),
    [groups],
  );

  const active = React.useMemo(
    () => tabs.find((t) => t.tpl.segment === segment.toLowerCase()) ?? null,
    [tabs, segment],
  );

  /** A scrap location (TRX-001/002) gets one extra tab: what has been ISSUED to
   *  it. Not a group — it is backed by ledger history, holds nothing, and has no
   *  node behind it. See ISSUED_SEGMENT for why it is not a StorageGroup. */
  const isScrap = Boolean(category?.is_scrap);
  const issuedActive = isScrap && segment.toLowerCase() === ISSUED_SEGMENT;
  /** Is the URL pointing at a tab this location actually has? Both kinds count —
   *  the redirect below fires only when NEITHER does. */
  const onKnownTab = Boolean(active) || issuedActive;

  /** Open/close the unit panel and keep the address bar in step, without routing. */
  const setOpen = React.useCallback(
    (id: string | undefined, { replace = false } = {}) => {
      setOpenId(id);
      const url = storageHref(categoryId, segment, id);
      if (typeof window === 'undefined' || window.location.pathname === url) return;
      if (replace) window.history.replaceState(null, '', url);
      else window.history.pushState(null, '', url);
    },
    [categoryId, segment],
  );

  // Back/Forward move through the entries pushed above, so re-read the id from
  // the address bar rather than trusting our own state.
  React.useEffect(() => {
    const onPop = () => {
      const parts = window.location.pathname.split('/').filter(Boolean);
      // /storage/{categoryId}/{segment}/{nodeId?}
      setOpenId(parts.length >= 4 ? decodeURIComponent(parts[3]!) : undefined);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // A segment this location doesn't have — a stale link, a sub-type switched off
  // since, or the route's default `shf` landing on a scrap location that has no
  // shelf. Send it to the first tab it DOES have, falling back to the Issued tab
  // when there are no sub-types at all: a scrap location is allowed to have
  // none, and before this that case reached "This location has no sub-types"
  // with its actual contents one un-linked URL away. Replace, don't push: a dead
  // link should not become a history entry to go Back to. Gated on `loaded`,
  // since a tab cannot be judged missing until the tree has arrived.
  React.useEffect(() => {
    if (!loaded || loadError || !category || onKnownTab) return;
    if (tabs.length > 0) {
      router.replace(storageHref(categoryId, tabs[0]!.tpl.segment));
    } else if (isScrap) {
      router.replace(storageHref(categoryId, ISSUED_SEGMENT));
    }
  }, [loaded, loadError, category, onKnownTab, tabs, isScrap, categoryId, router]);

  // Search the whole location at once — the units live two levels down, so a
  // per-tab box would make you retype the query for every sub-type.
  const forest = React.useMemo(() => (category ? [category] : []), [category]);
  const found = useHierarchySearch(forest, search);

  const selected = React.useMemo<{ node: NodeTree; path: string } | null>(() => {
    if (!openId) return null;
    for (const { group } of tabs) {
      const unit = (group.children ?? []).find((u) => u.id === openId);
      if (unit) {
        return { node: unit, path: `${category?.name ?? ''} › ${group.name} › ${unit.name}` };
      }
    }
    return null;
  }, [openId, tabs, category]);

  React.useEffect(() => {
    if (openId && !selected && loaded && !loadError) {
      setOpen(undefined, { replace: true });
    }
  }, [openId, selected, loaded, loadError, setOpen]);

  /** Remove one empty unit. The card only offers this when it holds nothing, and
   *  the API refuses it regardless — this is the confirmation, not the rule. */
  const deleteUnit = React.useCallback(
    async (unit: NodeTree) => {
      const ok = await confirm({
        title: `Delete ${unit.name}?`,
        description:
          'It holds nothing, so nothing is lost. It disappears from this tab and from ' +
          'every destination picker. Ledger history that already names it is unaffected.',
        confirmLabel: 'Delete',
        destructive: true,
      });
      if (!ok) return;
      try {
        await locationNodesApi.remove(unit.id);
        invalidateLocationForest();
        toast.success('Deleted', { description: unit.name });
        // A deep link to the unit we just removed would re-open onto nothing.
        if (openId === unit.id) setOpen(undefined, { replace: true });
        void reload();
      } catch (err) {
        toast.error(
          err instanceof ApiError ? err.message : `Could not delete ${unit.name}.`,
        );
      }
    },
    [confirm, openId, setOpen, reload],
  );

  /** Remove the whole location. Its empty sub-type groups go with it — they came
   *  from the template rather than by hand (LOC-001), so making someone switch
   *  all three off first would be ceremony. */
  const deleteCategory = React.useCallback(async () => {
    if (!category) return;
    const unitCount = tabs.reduce((sum, t) => sum + (t.group.children ?? []).length, 0);
    if (unitCount > 0) {
      toast.error('This location still holds units', {
        description: 'Remove them from each tab first, then delete the location.',
      });
      return;
    }
    const ok = await confirm({
      title: `Delete ${category.name}?`,
      description: [
        tabs.length > 0
          ? `This also removes its ${tabs.length} empty sub-${tabs.length === 1 ? 'type' : 'types'} (${tabs
              .map((t) => t.group.name)
              .join(', ')}). Nothing is stored in them.`
          : 'It holds nothing, so nothing is lost.',
        // "Nothing is lost" is only true of STOCK. A scrap location's real
        // content is its issue history, and deleting the location does not
        // delete that — the ledger is append-only and still names it. Saying so
        // is what stops this reading as "and the record goes too".
        isScrap
          ? 'Material already issued here stays on the ledger and in the audit trail; only the location is removed.'
          : null,
      ]
        .filter(Boolean)
        .join(' '),
      confirmLabel: 'Delete location',
      destructive: true,
    });
    if (!ok) return;
    try {
      await locationNodesApi.remove(category.id);
      invalidateLocationForest();
      toast.success('Location deleted', { description: category.name });
      router.replace(STORAGE_HREF);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : `Could not delete ${category.name}.`,
      );
    }
  }, [category, tabs, isScrap, confirm, router]);

  const missing = loaded && !loadError && !category;

  /** Everything in the location, not just the open tab — the header speaks for
   *  the whole place, so switching tabs must not change what it says. */
  const totals = React.useMemo(() => {
    let units = 0;
    let stock = 0;
    for (const { group } of tabs) {
      const leaves = group.children ?? [];
      units += leaves.length;
      stock += leaves.reduce((sum, l) => sum + l.active_allocation_count, 0);
    }
    return { units, stock };
  }, [tabs]);

  /**
   * Hand-rolled rather than ``<RouteTabs>``, which matches ``pathname === href``
   * exactly — a deep-linked unit adds a fourth segment and would deactivate
   * every tab. Lives in the header's own tab slot so the title, the summary and
   * the tabs read as one block under a single rule, instead of two stacked bars.
   */
  const tabStrip = (
    <div className="scroll-strip -mx-6 px-6 sm:-mx-8 sm:px-8">
      <nav
        className="inline-flex items-center justify-start gap-1"
        // Not "sub-types": on a scrap location the last tab is a disposition
        // record, not a place, and naming the whole strip after the other kind
        // misdescribes it to anyone reading by screen reader.
        aria-label={`${category?.name ?? 'Location'} sections`}
      >
        {tabs.map(({ group, tpl }) => {
          const isActive = active?.tpl.segment === tpl.segment;
          const count = (group.children ?? []).length;
          const Icon = tpl.icon;
          return (
            <Link
              key={tpl.segment}
              href={storageHref(categoryId, tpl.segment)}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                '-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3.5 py-2.5 text-sm font-normal text-text-2 transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                isActive && 'border-text font-medium text-text',
              )}
            >
              <Icon size={14} className={isActive ? 'text-accent' : 'text-text-3'} />
              {/* The group's OWN name — the client may have renamed it. */}
              {group.name}
              {/* A count pill only once there is something to count. A "0"
                  badge on every empty tab is noise that trains people to stop
                  reading the numbers that matter. */}
              {count > 0 && (
                <span
                  className={cn(
                    'rounded-full px-1.5 text-[11px] tabular-nums',
                    isActive ? 'bg-accent/15 text-accent' : 'bg-surface-2 text-text-3',
                  )}
                >
                  {count}
                </span>
              )}
            </Link>
          );
        })}
        {/* The disposition log, on a scrap location only. Last in the strip and
            visually separated: the tabs before it are places that HOLD things,
            this one is history of things that left, and sitting it flush among
            them would invite reading it as a fourth sub-type. */}
        {isScrap && (
          <Link
            key={ISSUED_SEGMENT}
            href={storageHref(categoryId, ISSUED_SEGMENT)}
            aria-current={issuedActive ? 'page' : undefined}
            className={cn(
              '-mb-px ml-1 inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent border-l border-l-border pl-4 pr-3.5 py-2.5 text-sm font-normal text-text-2 transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              issuedActive && 'border-b-text font-medium text-text',
            )}
          >
            <MinusCircle
              size={14}
              className={issuedActive ? 'text-warning' : 'text-text-3'}
            />
            Issued
          </Link>
        )}
      </nav>
    </div>
  );

  if (missing) {
    return (
      <>
        {/* No crumb here either — the empty state below already offers the one
            way out, and a breadcrumb back to Storage would be the same link
            twice. */}
        <PageHeader title="Location not found" />
        <div className="px-6 py-5 sm:px-8">
          <div className="rounded-lg border border-border bg-bg-elev">
            <EmptyState
              title="This location no longer exists"
              hint="It may have been removed. Pick another from Storage."
              action={
                <Button asChild variant="primary">
                  <Link href={STORAGE_HREF}>Back to Storage</Link>
                </Button>
              }
            />
          </div>
        </div>
      </>
    );
  }

  const units = active ? (active.group.children ?? []) : [];

  return (
    <>
      <PageHeader
        title={category?.name ?? 'Location'}
        // No breadcrumb: a single "Storage" crumb above the title restated the
        // sidebar row that is already highlighted, and cost a line of vertical
        // space on every visit (client, 2026-08-12). What replaces it is a
        // subtitle that actually says something — what this location holds.
        subtitle={
          loading ? undefined : (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-text-3">
              {/* On a scrap location this comes FIRST. What happens to material
                  sent here changes the meaning of everything else on the page,
                  so it cannot be a footnote after the unit count. */}
              {isScrap && (
                <Badge tone="warning">Issued material leaves inventory</Badge>
              )}
              <span>
                {totals.units > 0
                  ? `${totals.units} ${totals.units === 1 ? 'unit' : 'units'} across ${tabs.length} ${
                      tabs.length === 1 ? 'sub-type' : 'sub-types'
                    }${totals.stock > 0 ? ` · ${totals.stock} on hand` : ''}`
                  : tabs.length === 0
                    ? 'No storage sub-types'
                    : `${tabs.length} ${tabs.length === 1 ? 'sub-type' : 'sub-types'}, nothing added yet`}
              </span>
            </span>
          )
        }
        tabs={tabStrip}
        actions={
          isSuperAdmin && category ? (
            <div className="flex items-center gap-2">
              {/* The page's main verb, promoted out of the grid's toolbar. It
                  was previously only reachable below three stat cards, which
                  put the one thing you came here to do furthest down. */}
              {active && (
                <Button type="button" variant="primary" onClick={() => setAddTo(active)}>
                  <Plus size={15} />
                  <span className="ml-1.5">Add {active.tpl.defaultName.toLowerCase()}</span>
                </Button>
              )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" size="icon" aria-label="Location actions">
                  <MoreHorizontal size={15} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setRenaming(category)}>
                  <Pencil size={14} />
                  <span className="ml-2">Rename location</span>
                </DropdownMenuItem>
                {/* LOC-001: "The client may rename these" — the sub-types, not
                    just the location. Scoped to the OPEN tab and labelled with
                    its current name, so this and the item above can't be
                    confused for each other.
                    A rename cannot break anything that points here: the tab's
                    URL segment comes from the group's immutable code, never its
                    name. */}
                {active && (
                  <DropdownMenuItem onSelect={() => setRenaming(active.group)}>
                    <Pencil size={14} />
                    <span className="ml-2">Rename “{active.group.name}”</span>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => setConfiguring(true)}>
                  <Settings2 size={14} />
                  <span className="ml-2">Configure sub-types…</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  // Not disabled when occupied: a greyed row with no explanation
                  // is a dead end. It stays clickable and says what to clear.
                  onSelect={() => void deleteCategory()}
                  className="text-danger focus:text-danger"
                >
                  <Trash2 size={14} />
                  <span className="ml-2">Delete location</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            </div>
          ) : undefined
        }
      />

      <div className="px-6 py-5 sm:px-8">
        {loadError ? (
          <div className="rounded-lg border border-border bg-bg-elev">
            <EmptyState
              title="Couldn't load this location"
              hint={loadError}
              action={<Button onClick={() => void reload()}>Retry</Button>}
            />
          </div>
        ) : (
          <>
            {/* Only once there is something to search. A search box over zero
                units is a control that cannot succeed, and it was the first
                thing on the page. Hidden on the Issued tab too: it searches the
                UNIT tree, and no row of the disposition log is in it — a query
                there would silently match nothing. */}
            {totals.units > 0 && !issuedActive && (
              <RoomSearch
                value={search}
                onChange={setSearch}
                found={found}
                noun="units"
                placeholder="Unit, lot, or item…"
              />
            )}
            {issuedActive ? (
              // The disposition log. Not searched by RoomSearch above — that
              // searches the location's UNIT tree, and none of these rows are in
              // it; the panel pages server-side instead.
              <IssuedMaterialPanel
                nodeId={categoryId}
                locationName={category?.name ?? 'this location'}
              />
            ) : active ? (
              units.length === 0 && !loading && !found.active ? (
                // A dedicated empty state instead of the grid's three zero stat
                // tiles. "SHELVES 0 / OCCUPIED 0 of 0 / UNITS ON HAND 0 across
                // all shelves" is three ways of saying nothing is here, above an
                // empty grid — so the tab that most needs a way forward gave the
                // least. This says it once and offers the action.
                <EmptyTab
                  tpl={active.tpl}
                  groupName={active.group.name}
                  canManage={isSuperAdmin}
                  onAdd={() => setAddTo(active)}
                />
              ) : (
                <StorageLeafGrid
                  leaves={units}
                  loading={loading}
                  noun={active.tpl.defaultName.toLowerCase()}
                  nounPlural={active.tpl.plural}
                  mono
                  selectedId={openId}
                  canManage={isSuperAdmin}
                  hideSearch
                  // The header carries the numbers and the Add button now, so the
                  // grid renders cards only — no stat row, no second toolbar.
                  compact
                  filterTo={found.active ? found.matchIds : null}
                  stockAt={found.stockAt}
                  emptyTitle={`No ${active.tpl.plural} match`}
                  emptyHint="Try a different search."
                  onOpen={(leaf) => setOpen(leaf.id)}
                  onRename={(leaf) => setRenaming(leaf)}
                  onDelete={(leaf) => void deleteUnit(leaf)}
                />
              )
            ) : (
              // Only reachable for the instant before the redirect above, or if
              // the location somehow has no groups at all. On a SCRAP location
              // that is a legitimate configuration rather than a misconfigured
              // one — the location itself is the destination — so it is told a
              // different story, pointing at the tab that does have content.
              !loading && (
                <div className="rounded-lg border border-border bg-bg-elev">
                  {isScrap ? (
                    <EmptyState
                      icon={MinusCircle}
                      title="This location has no storage sub-types"
                      hint="Material is issued to the location itself. See the Issued tab for what has been sent here."
                      action={
                        <Button asChild variant="primary">
                          <Link href={storageHref(categoryId, ISSUED_SEGMENT)}>
                            View issued material
                          </Link>
                        </Button>
                      }
                    />
                  ) : (
                    <EmptyState
                      title="This location has no sub-types"
                      hint={
                        isSuperAdmin
                          ? 'Switch one on from the ⋯ menu.'
                          : 'A Super Admin configures its sub-types.'
                      }
                    />
                  )}
                </div>
              )
            )}
          </>
        )}
      </div>

      <NodeContentsSheet
        open={Boolean(selected)}
        onOpenChange={(o) => !o && setOpen(undefined)}
        node={selected?.node ?? null}
        pathLabel={selected?.path ?? ''}
        badges={<Badge tone="accent">Storage</Badge>}
        canTransfer={canTransfer}
        onChanged={() => void reload()}
      />

      {addTo && (
        <AddNodeDialog
          title={addTo.tpl.addUnit.title}
          description={`Under ${addTo.group.name}. ${addTo.tpl.addUnit.description}`}
          fieldLabel={addTo.tpl.addUnit.fieldLabel}
          placeholder={addTo.tpl.addUnit.placeholder}
          nodeType="sub_location"
          parent={addTo.group}
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
          // Three different things open this dialog — the location, the open
          // sub-type, and a unit — so it says which one, and what a rename does
          // and doesn't touch. LOC-001 grants the sub-type rename; the reassuring
          // half is that nothing depends on these names.
          title={
            renaming.id === category?.id
              ? 'Rename location'
              : renaming.node_type === 'room_location'
                ? 'Rename sub-type'
                : 'Rename unit'
          }
          description={
            renaming.node_type === 'room_location'
              ? 'The name on this tab. Its units and their stock are untouched, and links to them keep working.'
              : renaming.id === category?.id
                ? 'The name of this location, everywhere it appears.'
                : 'The equipment number, saved exactly as typed.'
          }
          onClose={() => setRenaming(null)}
          onDone={() => {
            setRenaming(null);
            void reload();
          }}
        />
      )}
      {configuring && category && (
        <ConfigureGroupsDialog
          category={category}
          onClose={() => setConfiguring(false)}
          onDone={() => {
            setConfiguring(false);
            void reload();
          }}
        />
      )}
      {confirmDialog}
    </>
  );
}

/**
 * A sub-type with nothing in it yet.
 *
 * The template creates every tab empty by design (LOC-001 — "the client may
 * leave any unused"), so this is the FIRST thing anyone sees on a new location,
 * three times over. It replaced three stat tiles reading zero above an empty
 * grid, which spent the most space on the state with the least to say.
 *
 * The example equipment number is the useful part: LOC-006 keeps a unit's
 * identifier free text the system never parses, so the only thing that makes
 * the format clear is showing one.
 */
function EmptyTab({
  tpl,
  groupName,
  canManage,
  onAdd,
}: {
  tpl: StorageGroup;
  /** The group's own name, which the client may have renamed off the default. */
  groupName: string;
  canManage: boolean;
  onAdd: () => void;
}) {
  const Icon = tpl.icon;
  return (
    <div className="rounded-lg border border-dashed border-border bg-bg-elev">
      <div className="flex flex-col items-center px-6 py-14 text-center">
        <span className="mb-4 grid size-12 place-items-center rounded-full bg-surface-2 text-text-3">
          <Icon size={22} />
        </span>
        <p className="text-sm font-medium text-text">No {tpl.plural} in {groupName} yet</p>
        <p className="mt-1.5 max-w-sm text-xs text-text-2">
          {canManage ? (
            <>
              Add one by its equipment number — for example{' '}
              <span className="font-mono text-text">
                {tpl.addUnit.placeholder.replace(/^e\.g\.\s*/, '')}
              </span>
              . It is saved exactly as typed, and stock is placed into it from
              Receipt Admin.
            </>
          ) : (
            <>A Super Admin adds {tpl.plural} here. Stock is then placed into them from Receipt Admin.</>
          )}
        </p>
        {canManage && (
          <Button type="button" variant="primary" onClick={onAdd} className="mt-5">
            <Plus size={15} />
            <span className="ml-1.5">Add {tpl.defaultName.toLowerCase()}</span>
          </Button>
        )}
      </div>
    </div>
  );
}
