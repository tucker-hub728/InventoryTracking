'use client';

import * as React from 'react';
import { ChevronDown, ChevronRight, Loader2, Plus, Search, X } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePermission } from '@/hooks/use-permission';
import { ApiError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import {
  locationNodesApi,
  subtreeStats,
  type LocationNode,
  type NodeTree,
} from '@/lib/api/location-nodes';

import { NodeCreateDialog } from './node-create-dialog';
import { useHierarchySearch, type StockHit } from './use-hierarchy-search';
import { NodeDetailPanel, NODE_ICON } from './node-detail-panel';

// ``flat`` operational locations are retired — this view shows only the LN2
// storage hierarchy now.
type CreateMode =
  | { kind: 'ln2-root' }
  | { kind: 'child'; parent: LocationNode }
  | null;

/** The address bar for a cascade: `/ln2/{tank}/{quadrant}/{rack}/{box}`. */
function ln2Href(chain: NodeTree[]): string {
  return chain.length ? `/ln2/${chain.map((n) => n.id).join('/')}` : '/ln2';
}

export function LocationSystemClient({
  initialPath = [],
}: {
  /** Node-id chain from the URL. Only the last one drives selection. */
  initialPath?: string[];
}) {
  const canWrite = usePermission('inventory', 'create');

  const [tree, setTree] = React.useState<NodeTree[]>([]);
  const [loading, setLoading] = React.useState(true);
  // Distinct from `!loading`: proves the tree actually arrived.
  const [loaded, setLoaded] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [createMode, setCreateMode] = React.useState<CreateMode>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(
    initialPath.at(-1) ?? null,
  );
  const [search, setSearch] = React.useState('');

  const reload = React.useCallback(
    async (signal?: AbortSignal, opts?: { silent?: boolean }) => {
      if (opts?.silent) setRefreshing(true);
      else setLoading(true);
      setLoadError(null);
      try {
        const t = await locationNodesApi.ln2Tree({ signal });
        setTree(t);
        setLoaded(true);
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load locations.');
      } finally {
        // An ABORTED request must not clear `loading`: `return` inside the catch
        // still runs this block, and React StrictMode mounts, aborts and
        // remounts in development. Clearing it here would leave loading=false
        // with an empty tree, and the "selection vanished" guard below would
        // then wipe a deep-linked selection on every refresh.
        if (!signal?.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [],
  );

  React.useEffect(() => {
    const ctrl = new AbortController();
    void reload(ctrl.signal);
    return () => ctrl.abort();
  }, [reload]);

  // Index the tree: id → node and id → parent, for selection + breadcrumb.
  const { byId, parentOf } = React.useMemo(() => {
    const byId = new Map<string, NodeTree>();
    const parentOf = new Map<string, string | null>();
    const walk = (n: NodeTree, parent: string | null) => {
      byId.set(n.id, n);
      parentOf.set(n.id, parent);
      n.children.forEach((c) => walk(c, n.id));
    };
    tree.forEach((r) => walk(r, null));
    return { byId, parentOf };
  }, [tree]);

  /** Root → node breadcrumb chain, or [] if the id isn't in the tree. */
  const chainOf = React.useCallback(
    (id: string | null): NodeTree[] => {
      if (!id || !byId.has(id)) return [];
      const chain: NodeTree[] = [];
      let cur: string | null = id;
      while (cur) {
        const n = byId.get(cur);
        if (!n) break;
        chain.unshift(n);
        cur = parentOf.get(cur) ?? null;
      }
      return chain;
    },
    [byId, parentOf],
  );

  // Resolve the selected node (LN2 tree) + its breadcrumb path.
  const { selectedNode, path } = React.useMemo(
    () => ({
      selectedNode: selectedId ? (byId.get(selectedId) ?? null) : null,
      path: chainOf(selectedId),
    }),
    [selectedId, byId, chainOf],
  );

  /**
   * Select a node and mirror the whole cascade in the address bar.
   *
   * ``history.pushState`` rather than a router navigation: the ids live in a
   * dynamic route segment, and changing one remounts the page subtree — which
   * would refetch the tree and collapse the sidebar on every click.
   */
  const select = React.useCallback(
    (id: string | null, { replace = false } = {}) => {
      setSelectedId(id);
      if (typeof window === 'undefined') return;
      const url = ln2Href(chainOf(id));
      if (window.location.pathname === url) return;
      if (replace) window.history.replaceState(null, '', url);
      else window.history.pushState(null, '', url);
    },
    [chainOf],
  );

  // Back/Forward walk the entries pushed above — re-read the id from the URL
  // rather than trusting our own state.
  React.useEffect(() => {
    const onPop = () => {
      const parts = window.location.pathname.split('/').filter(Boolean);
      // /ln2/{tank}/{quadrant}/… — the last segment is the selection.
      setSelectedId(parts.length > 1 ? decodeURIComponent(parts.at(-1)!) : null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // A stale or deleted id shouldn't strand the page on a URL that shows
  // nothing. Gated on `loaded`, not `!loading` — the node can't be judged
  // missing until the tree it would live in has actually arrived. Replaced,
  // not pushed: a dead link should not become a Back target.
  React.useEffect(() => {
    if (selectedId && !byId.has(selectedId) && loaded) {
      select(null, { replace: true });
    }
  }, [selectedId, byId, loaded, select]);

  // Ancestors of the selection. The sidebar collapses anything below depth 2,
  // so without this a deep link to a box would select it while leaving it
  // hidden inside a shut rack — selected, highlighted, and invisible.
  const selectionPath = React.useMemo(
    () => new Set(path.slice(0, -1).map((n) => n.id)),
    [path],
  );

  const found = useHierarchySearch(tree, search);

  // Open for the selection AND for anything a search turned up — a match inside
  // a shut rack has the same problem a deep-linked selection had.
  const expandedIds = React.useMemo(
    () => new Set([...selectionPath, ...found.revealIds]),
    [selectionPath, found.revealIds],
  );

  // Once the tree lands, canonicalise the URL — a deep link that named only the
  // box, or listed a stale ancestor chain, becomes the full current cascade.
  React.useEffect(() => {
    if (!loaded || !selectedNode) return;
    const url = ln2Href(path);
    if (window.location.pathname !== url) window.history.replaceState(null, '', url);
  }, [loaded, selectedNode, path]);

  return (
    <div className="flex h-[calc(100vh-52px)] min-h-0">
      {/* ── Sidebar: storage hierarchy ───────────────────────────────── */}
      <aside className="flex w-[290px] shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex items-center justify-between px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-3">
            Storage hierarchy
          </p>
          {canWrite && (
            <button
              type="button"
              title="Add tank"
              onClick={() => setCreateMode({ kind: 'ln2-root' })}
              className="rounded p-1 text-text-3 hover:bg-bg-elev hover:text-text"
            >
              <Plus size={15} />
            </button>
          )}
        </div>

        {/* Search. Matches are highlighted in place and their ancestors opened —
            never filtered out — so a hit keeps the structure that says where it
            is. See ``use-hierarchy-search.ts`` for what a query matches. */}
        <div className="px-3 pb-2">
          <Input
            icon={Search}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Tank, rack, box, lot…"
            aria-label="Search the storage hierarchy"
            trailing={
              search ? (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                  className="rounded p-0.5 text-text-3 hover:text-text"
                >
                  <X size={13} />
                </button>
              ) : undefined
            }
          />
          {found.active && (
            <p className="mt-1.5 px-0.5 text-[11px] leading-relaxed text-text-3">
              {found.loading && found.matchCount === 0 ? (
                'Searching…'
              ) : found.matchCount === 0 ? (
                <>
                  Nothing here matches{' '}
                  <span className="text-text-2">“{search.trim()}”</span>
                  {/* Found, but not in LN2 — say so rather than claim nothing
                      exists. This tree covers one area; the lookup covers all. */}
                  {found.elsewhere > 0 && (
                    <>
                      {' — '}
                      {found.elsewhere} unit{found.elsewhere === 1 ? '' : 's'} of it
                      {found.elsewhere === 1 ? ' is' : ' are'} stored outside LN2
                    </>
                  )}
                </>
              ) : (
                <>
                  {found.matchCount} match{found.matchCount === 1 ? '' : 'es'}
                  {/* Only what was found IN THIS TREE. Counting the endpoint's
                      full result read "1 match · holding L-301-04, PL-301-04" —
                      two lots named, one row lit. */}
                  {found.lotNumbers.length > 0 && (
                    <>
                      {' · '}
                      <span className="font-mono text-text-2">
                        {found.lotNumbers.slice(0, 2).join(', ')}
                        {found.lotNumbers.length > 2 && ` +${found.lotNumbers.length - 2}`}
                      </span>
                    </>
                  )}
                  {found.itemNumbers.length > 0 && (
                    <>
                      {' · '}
                      <span className="font-mono text-text-2">
                        {found.itemNumbers.slice(0, 2).join(', ')}
                        {found.itemNumbers.length > 2 &&
                          ` +${found.itemNumbers.length - 2}`}
                      </span>
                    </>
                  )}
                  {found.elsewhere > 0 && (
                    <>
                      {' · '}
                      {found.elsewhere} more outside LN2
                    </>
                  )}
                </>
              )}
            </p>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {loading ? (
            <div className="space-y-2 px-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-7 w-full" />
              ))}
            </div>
          ) : tree.length === 0 ? (
            <p className="px-3 py-6 text-sm text-text-3">
              No tanks yet. Use + to add one, then add up to four quadrants inside it.
            </p>
          ) : (
            <>
              {tree.map((n) => (
                <TreeRow
                  key={n.id}
                  node={n}
                  depth={0}
                  selectedId={selectedId}
                  expandedIds={expandedIds}
                  matchIds={found.matchIds}
                  stockAt={found.stockAt}
                  codeAt={found.codeAt}
                  pathIds={found.revealIds}
                  onSelect={select}
                />
              ))}
            </>
          )}
        </div>

        {/* Legend */}
        <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-[11px] text-text-3">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-accent" /> Occupied
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm border border-border" /> Empty
          </span>
          {refreshing && (
            <span className="ml-auto flex items-center gap-1 text-text-3">
              <Loader2 size={11} className="animate-spin" /> Updating
            </span>
          )}
        </div>
      </aside>

      {/* ── Detail panel ─────────────────────────────────────────────── */}
      <main className="min-w-0 flex-1 overflow-y-auto">
        {loadError && (
          <p
            role="alert"
            className="m-4 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger"
          >
            {loadError}
          </p>
        )}
        {selectedNode ? (
          <NodeDetailPanel
            node={selectedNode}
            path={path}
            canWrite={canWrite}
            onSelectChild={select}
            onAddChild={(parent) => setCreateMode({ kind: 'child', parent })}
            onRemoved={() => {
              select(null, { replace: true });
              void reload(undefined, { silent: true });
            }}
            onChanged={() => void reload(undefined, { silent: true })}
          />
        ) : loading ? (
          // Nothing yet — on a deep link the selection exists but the tree it
          // resolves against hasn't arrived, and flashing "Select a location"
          // at someone who just selected one reads as though it was lost.
          <div className="space-y-3 p-6">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-8">
            <EmptyState
              title="Select a location"
              hint="Pick a tank, quadrant, rack or box from the hierarchy to see its contents."
            />
          </div>
        )}
      </main>

      {createMode && (
        <NodeCreateDialog
          open
          onOpenChange={(o) => !o && setCreateMode(null)}
          mode={createMode}
          onCreated={() => {
            setCreateMode(null);
            void reload(undefined, { silent: true });
          }}
        />
      )}
    </div>
  );
}

// ── Recursive sidebar tree row ─────────────────────────────────────────

function TreeRow({
  node,
  depth,
  selectedId,
  expandedIds,
  matchIds,
  stockAt,
  codeAt,
  pathIds,
  onSelect,
}: {
  node: NodeTree;
  depth: number;
  selectedId: string | null;
  /** Ancestors of the selection and of any search match — these rows open. */
  expandedIds: Set<string>;
  /** Nodes the current search matched. Empty when not searching. */
  matchIds: Set<string>;
  /** Stock found at a node, for rows matched by lot / item rather than by name. */
  stockAt: Map<string, StockHit>;
  /** Code of a row that matched on its code but not its name — see the hook. */
  codeAt: Map<string, string>;
  /** Ancestors of a match — tinted so the path down to it is traceable. */
  pathIds: Set<string>;
  onSelect: (id: string) => void;
}) {
  const onSelectedPath = expandedIds.has(node.id);
  const [open, setOpen] = React.useState(depth < 2 || onSelectedPath);
  // Reveal the selection when it moves into this branch — on a refresh of a
  // deep link, or when the detail panel jumps to a child. Only forces open as
  // the row BECOMES on-path, so a manual collapse afterwards still sticks.
  React.useEffect(() => {
    if (onSelectedPath) setOpen(true);
  }, [onSelectedPath]);
  const hasChildren = node.children.length > 0;
  const Icon = NODE_ICON[node.node_type];
  const stats = subtreeStats(node);
  const selected = selectedId === node.id;
  const isMatch = matchIds.has(node.id);
  // Set only when the row matched because of what's INSIDE it — the name gives
  // no clue then, so the lot number is shown in place of the occupancy count.
  const stock = stockAt.get(node.id);
  // An ancestor of a match: tinted so the trail from tank to box is followable.
  const onMatchPath = pathIds.has(node.id) && !isMatch;
  const matchedCode = codeAt.get(node.id);

  // Bring a deep-linked selection into view. Once, on mount only: scrolling on
  // every selection change would yank the list under someone who is clicking
  // through it, and a row they clicked is on screen already.
  const rowRef = React.useRef<HTMLDivElement>(null);
  const didScroll = React.useRef(false);
  React.useEffect(() => {
    if (selected && !didScroll.current) {
      didScroll.current = true;
      rowRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [selected]);

  return (
    <div>
      <div
        ref={rowRef}
        className={cn(
          'group flex items-center gap-1 rounded-md pr-2',
          // Selection wins over a match: you can only have selected one thing,
          // and losing track of it inside a set of highlights would be worse.
          // Below that, a match is solid and its ancestors are a fainter tint of
          // the same colour — so the trail from the tank down to the box reads as
          // one thing, and you can see WHERE the hit is, not just that it exists.
          selected
            ? 'bg-warning/10'
            : isMatch
              ? 'bg-accent/10 ring-1 ring-inset ring-accent/30'
              : onMatchPath
                ? 'bg-accent/[0.06]'
                : 'hover:bg-bg-elev',
        )}
        style={{ paddingLeft: depth * 14 }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? 'Collapse' : 'Expand'}
            className="shrink-0 rounded p-1 text-text-3 hover:text-text"
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="inline-block w-[22px] shrink-0" />
        )}
        <button
          type="button"
          onClick={() => {
            onSelect(node.id);
            // Selecting only ever OPENS. Toggling here meant a second click on
            // the row you were already looking at hid its contents, so picking
            // a node twice collapsed the thing you were trying to see.
            // Collapsing belongs to the chevron alone.
            if (hasChildren) setOpen(true);
          }}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
        >
          <Icon size={14} className="shrink-0 text-text-3" />
          <OverflowTooltip
            label={node.name}
            className={cn(
              'text-sm',
              selected
                ? 'font-medium text-text-1'
                : isMatch
                  ? 'font-medium text-accent'
                  : onMatchPath
                    ? 'text-text-1'
                    : 'text-text-2',
            )}
          />
          {stock ? (
            // What was found inside. Lots name the exact stock; the item number
            // is the fallback for a lot with no number of its own.
            <span
              title={
                [
                  stock.lots.length ? `Holds ${stock.lots.join(', ')}` : null,
                  stock.items.length ? `Item ${stock.items.join(', ')}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || undefined
              }
              className="ml-auto shrink-0 truncate rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] text-accent"
            >
              {(stock.lots[0] ?? stock.items[0] ?? '')}
              {stock.lots.length > 1 && ` +${stock.lots.length - 1}`}
            </span>
          ) : matchedCode ? (
            // Matched on its code, not its name. Shown because a code drifts from
            // the name — rename leaves it alone — so the row would otherwise look
            // like a result that has nothing to do with the query.
            <span
              title={`Code ${matchedCode}`}
              className="ml-auto shrink-0 truncate rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] text-text-3"
            >
              {matchedCode}
            </span>
          ) : (
            <span className="ml-auto shrink-0 font-mono text-[11px] text-text-3">
              {stats.occupied}/{stats.capacity}
            </span>
          )}
        </button>
      </div>
      {open &&
        hasChildren &&
        node.children.map((c) => (
          <TreeRow
            key={c.id}
            node={c}
            depth={depth + 1}
            selectedId={selectedId}
            expandedIds={expandedIds}
            matchIds={matchIds}
            stockAt={stockAt}
            codeAt={codeAt}
            pathIds={pathIds}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}

// ── Overflow-aware label ───────────────────────────────────────────────

/**
 * A truncating label that reveals its full text in a tooltip on hover, but
 * only when the text is actually clipped. Names that fit show no tooltip, so
 * we don't add hover noise to the common (short-name) case.
 */
function OverflowTooltip({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setTruncated(el.scrollWidth > el.clientWidth);
    check();
    // Re-measure once layout settles and once the web font swaps in: a font
    // swap changes the text's intrinsic width without resizing the flex-sized
    // box, so the ResizeObserver alone would miss it and a clipped name would
    // wrongly show no tooltip.
    const raf = requestAnimationFrame(check);
    let cancelled = false;
    document.fonts?.ready.then(() => {
      if (!cancelled) check();
    });
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(check);
      ro.observe(el);
    }
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [label]);

  // If truncation is lost while the tooltip is open (e.g. the row widens under
  // the pointer), drop the controlled-open state so re-showing needs a fresh
  // hover rather than popping back instantly.
  React.useEffect(() => {
    if (!truncated) setOpen(false);
  }, [truncated]);

  return (
    <Tooltip open={open && truncated} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <span ref={ref} className={cn('min-w-0 flex-1 truncate', className)}>
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" align="start" className="max-w-[260px] break-words">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
