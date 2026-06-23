'use client';

import * as React from 'react';
import { ChevronDown, ChevronRight, Loader2, Plus } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermission } from '@/hooks/use-permission';
import { ApiError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import {
  locationNodesApi,
  subtreeStats,
  FLAT_CATEGORY_LABEL,
  type FlatCategory,
  type LocationNode,
  type NodeTree,
} from '@/lib/api/location-nodes';

import { NodeCreateDialog } from './node-create-dialog';
import { NodeDetailPanel, NODE_ICON } from './node-detail-panel';

type CreateMode =
  | { kind: 'ln2-root' }
  | { kind: 'child'; parent: LocationNode }
  | { kind: 'flat' }
  | null;

/** Wrap a flat LocationNode as a childless NodeTree for the detail panel. */
function asTree(n: LocationNode): NodeTree {
  return { ...n, children: [] };
}

export function LocationSystemClient() {
  const canWrite = usePermission('inventory', 'create');

  const [tree, setTree] = React.useState<NodeTree[]>([]);
  const [flat, setFlat] = React.useState<LocationNode[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [createMode, setCreateMode] = React.useState<CreateMode>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const reload = React.useCallback(
    async (signal?: AbortSignal, opts?: { silent?: boolean }) => {
      if (opts?.silent) setRefreshing(true);
      else setLoading(true);
      setLoadError(null);
      try {
        const [t, f] = await Promise.all([
          locationNodesApi.ln2Tree({ signal }),
          locationNodesApi.flat({ signal }),
        ]);
        setTree(t);
        setFlat(f);
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load locations.');
      } finally {
        setLoading(false);
        setRefreshing(false);
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

  const flatById = React.useMemo(() => {
    const m = new Map<string, LocationNode>();
    flat.forEach((n) => m.set(n.id, n));
    return m;
  }, [flat]);

  // Resolve the selected node (LN2 tree or flat) + its breadcrumb path.
  const { selectedNode, path } = React.useMemo(() => {
    if (!selectedId) return { selectedNode: null as NodeTree | null, path: [] as NodeTree[] };
    const ln2 = byId.get(selectedId);
    if (ln2) {
      const chain: NodeTree[] = [];
      let cur: string | null = selectedId;
      while (cur) {
        const n = byId.get(cur);
        if (!n) break;
        chain.unshift(n);
        cur = parentOf.get(cur) ?? null;
      }
      return { selectedNode: ln2, path: chain };
    }
    const fl = flatById.get(selectedId);
    if (fl) {
      const wrapped = asTree(fl);
      return { selectedNode: wrapped, path: [wrapped] };
    }
    return { selectedNode: null, path: [] };
  }, [selectedId, byId, parentOf, flatById]);

  // Drop the selection if the node disappeared (e.g. after delete).
  React.useEffect(() => {
    if (selectedId && !byId.has(selectedId) && !flatById.has(selectedId) && !loading) {
      setSelectedId(null);
    }
  }, [selectedId, byId, flatById, loading]);

  const flatByCategory = React.useMemo(() => {
    const m = new Map<FlatCategory, LocationNode[]>();
    for (const n of flat) {
      if (!n.flat_category) continue;
      const arr = m.get(n.flat_category) ?? [];
      arr.push(n);
      m.set(n.flat_category, arr);
    }
    return m;
  }, [flat]);

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
              title="Add tank quadrant"
              onClick={() => setCreateMode({ kind: 'ln2-root' })}
              className="rounded p-1 text-text-3 hover:bg-bg-elev hover:text-text"
            >
              <Plus size={15} />
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {loading ? (
            <div className="space-y-2 px-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-7 w-full" />
              ))}
            </div>
          ) : tree.length === 0 && flat.length === 0 ? (
            <p className="px-3 py-6 text-sm text-text-3">
              No locations yet. Use + to add a tank quadrant.
            </p>
          ) : (
            <>
              {tree.map((n) => (
                <TreeRow
                  key={n.id}
                  node={n}
                  depth={0}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                />
              ))}

              {/* Flat locations */}
              <div className="mt-3 flex items-center justify-between px-3 pb-1 pt-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-text-3">
                  Flat locations
                </p>
                {canWrite && (
                  <button
                    type="button"
                    title="Add flat location"
                    onClick={() => setCreateMode({ kind: 'flat' })}
                    className="rounded p-0.5 text-text-3 hover:bg-bg-elev hover:text-text"
                  >
                    <Plus size={13} />
                  </button>
                )}
              </div>
              {[...flatByCategory.entries()].map(([cat, nodes]) => (
                <div key={cat} className="mb-1">
                  <p className="px-3 py-1 text-[10px] uppercase tracking-wide text-text-3/70">
                    {FLAT_CATEGORY_LABEL[cat]}
                  </p>
                  {nodes.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => setSelectedId(n.id)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm',
                        selectedId === n.id
                          ? 'bg-warning/10 font-medium text-text-1'
                          : 'text-text-2 hover:bg-bg-elev',
                      )}
                    >
                      <span className="truncate">{n.name}</span>
                      <span className="ml-auto font-mono text-xs text-text-3">
                        {n.active_allocation_count}
                      </span>
                    </button>
                  ))}
                </div>
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
            onSelectChild={setSelectedId}
            onAddChild={(parent) => setCreateMode({ kind: 'child', parent })}
            onRemoved={() => {
              setSelectedId(null);
              void reload(undefined, { silent: true });
            }}
            onChanged={() => void reload(undefined, { silent: true })}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-8">
            <EmptyState
              title="Select a location"
              hint="Pick a quadrant, rack, container, box or flat location from the hierarchy to see its contents."
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
  onSelect,
}: {
  node: NodeTree;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(depth < 2);
  const hasChildren = node.children.length > 0;
  const Icon = NODE_ICON[node.node_type];
  const stats = subtreeStats(node);
  const selected = selectedId === node.id;

  return (
    <div>
      <div
        className={cn(
          'group flex items-center gap-1 rounded-md pr-2',
          selected ? 'bg-warning/10' : 'hover:bg-bg-elev',
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
            if (hasChildren) setOpen((v) => !v);
          }}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
        >
          <Icon size={14} className="shrink-0 text-text-3" />
          <span
            className={cn(
              'truncate text-sm',
              selected ? 'font-medium text-text-1' : 'text-text-2',
            )}
          >
            {node.name}
          </span>
          <span className="ml-auto shrink-0 font-mono text-[11px] text-text-3">
            {stats.occupied}/{stats.capacity}
          </span>
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
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}
