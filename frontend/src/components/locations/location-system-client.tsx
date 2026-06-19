'use client';

import * as React from 'react';
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  Snowflake,
  Trash2,
} from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/sonner';
import { usePermission } from '@/hooks/use-permission';
import { ApiError } from '@/lib/api/client';
import {
  locationNodesApi,
  CHILD_TYPE_OF,
  FLAT_CATEGORY_LABEL,
  NODE_TYPE_LABEL,
  type FlatCategory,
  type LocationNode,
  type NodeTree,
} from '@/lib/api/location-nodes';

import { NodeCreateDialog } from './node-create-dialog';
import { NodeDetailSheet } from './node-detail-sheet';

type CreateMode =
  | { kind: 'ln2-root' }
  | { kind: 'child'; parent: LocationNode }
  | { kind: 'flat' }
  | null;

export function LocationSystemClient() {
  const canWrite = usePermission('inventory', 'create');

  const [tree, setTree] = React.useState<NodeTree[]>([]);
  const [flat, setFlat] = React.useState<LocationNode[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [createMode, setCreateMode] = React.useState<CreateMode>(null);
  const [detailNode, setDetailNode] = React.useState<LocationNode | null>(null);

  const reload = React.useCallback(
    async (signal?: AbortSignal, opts?: { silent?: boolean }) => {
      // Silent refresh keeps the rendered tree mounted (preserving each node's
      // expand/collapse state) instead of swapping it for the skeleton.
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

  const handleDelete = async (node: LocationNode) => {
    setDeletingId(node.id);
    try {
      await locationNodesApi.remove(node.id);
      toast.success('Location deactivated');
      await reload(undefined, { silent: true });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to delete.');
    } finally {
      setDeletingId(null);
    }
  };

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
    <>
      <PageHeader
        title="Locations"
        subtitle="Strict LN2 hierarchy (Tank Quadrant → Rack → Cassette/Box Rack → Box → Sub-slot) and flat operational locations. Only sub-slots and flat locations store lots."
      />

      <div className="px-6 py-5 sm:px-8">
        {loadError && (
          <p
            role="alert"
            className="mb-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger"
          >
            {loadError}
          </p>
        )}

        <Tabs defaultValue="ln2">
          <TabsList>
            <TabsTrigger value="ln2">LN2 hierarchy</TabsTrigger>
            <TabsTrigger value="flat">Flat locations</TabsTrigger>
          </TabsList>

          {/* ── LN2 ───────────────────────────────────────────────── */}
          <TabsContent value="ln2">
            <Card className="p-4">
              <div className="mb-4 flex items-center justify-between gap-3">
                <p className="text-sm text-text-3">
                  Build the tree top-down. Each level only accepts the correct
                  child type.
                </p>
                <div className="flex shrink-0 items-center gap-3">
                  {refreshing && (
                    <span className="flex items-center gap-1.5 text-xs text-text-3">
                      <Loader2 size={13} className="animate-spin" /> Updating…
                    </span>
                  )}
                  {canWrite && (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => setCreateMode({ kind: 'ln2-root' })}
                    >
                      <Plus size={14} /> Add Tank Quadrant
                    </Button>
                  )}
                </div>
              </div>

              {loading ? (
                <div className="space-y-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-9 w-full" />
                  ))}
                </div>
              ) : tree.length === 0 ? (
                <EmptyState
                  icon={Snowflake}
                  title="No LN2 hierarchy yet"
                  hint="Start by adding a Tank Quadrant, then drill down to racks, boxes and sub-slots."
                />
              ) : (
                <div className="space-y-0.5">
                  {tree.map((n, i) => (
                    <Ln2Node
                      key={n.id}
                      node={n}
                      depth={0}
                      isLast={i === tree.length - 1}
                      ancestry={[]}
                      canWrite={canWrite}
                      deletingId={deletingId}
                      onAddChild={(parent) => setCreateMode({ kind: 'child', parent })}
                      onDelete={handleDelete}
                      onSelect={setDetailNode}
                    />
                  ))}
                </div>
              )}
            </Card>
          </TabsContent>

          {/* ── Flat ──────────────────────────────────────────────── */}
          <TabsContent value="flat">
            <Card className="p-4">
              <div className="mb-4 flex items-center justify-between gap-3">
                <p className="text-sm text-text-3">
                  Operational areas — no hierarchy, direct lot assignment.
                </p>
                <div className="flex shrink-0 items-center gap-3">
                  {refreshing && (
                    <span className="flex items-center gap-1.5 text-xs text-text-3">
                      <Loader2 size={13} className="animate-spin" /> Updating…
                    </span>
                  )}
                  {canWrite && (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => setCreateMode({ kind: 'flat' })}
                    >
                      <Plus size={14} /> Add flat location
                    </Button>
                  )}
                </div>
              </div>

              {loading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-9 w-full" />
                  ))}
                </div>
              ) : flat.length === 0 ? (
                <EmptyState
                  title="No flat locations yet"
                  hint="Add Kanban / Lab / QC / Engineering / Materials locations."
                />
              ) : (
                <div className="space-y-4">
                  {[...flatByCategory.entries()].map(([cat, nodes]) => (
                    <div key={cat}>
                      <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-text-3">
                        {FLAT_CATEGORY_LABEL[cat]}
                      </p>
                      <div className="space-y-1">
                        {nodes.map((n) => (
                          <div
                            key={n.id}
                            className="flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2"
                          >
                            <button
                              type="button"
                              className="flex-1 text-left"
                              onClick={() => setDetailNode(n)}
                            >
                              <span className="text-sm">{n.name}</span>
                              {n.active_allocation_count > 0 && (
                                <Badge tone="accent" className="ml-2">
                                  {n.active_allocation_count} lot(s)
                                </Badge>
                              )}
                            </button>
                            {canWrite && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleDelete(n)}
                                disabled={deletingId === n.id}
                                aria-label="Delete location"
                              >
                                {deletingId === n.id ? (
                                  <Loader2 size={14} className="animate-spin" />
                                ) : (
                                  <Trash2 size={14} />
                                )}
                              </Button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </TabsContent>
        </Tabs>
      </div>

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

      <NodeDetailSheet
        node={detailNode}
        canWrite={canWrite}
        onOpenChange={(o) => !o && setDetailNode(null)}
        onChanged={() => void reload(undefined, { silent: true })}
      />
    </>
  );
}

// ── Recursive LN2 tree node ───────────────────────────────────────────

const INDENT = 22; // px width of each tree-guide column

function Ln2Node({
  node,
  depth,
  isLast,
  ancestry,
  canWrite,
  deletingId,
  onAddChild,
  onDelete,
  onSelect,
}: {
  node: NodeTree;
  depth: number;
  /** whether this node is the last among its siblings */
  isLast: boolean;
  /** for each ancestor (root→parent): does it have a following sibling (draw a continuing rail)? */
  ancestry: boolean[];
  canWrite: boolean;
  /** id of the node whose deletion is in flight, if any */
  deletingId: string | null;
  onAddChild: (parent: LocationNode) => void;
  onDelete: (node: LocationNode) => void;
  onSelect: (node: LocationNode) => void;
}) {
  const [open, setOpen] = React.useState(depth < 1);
  const childType = CHILD_TYPE_OF[node.node_type];
  const hasChildren = node.children.length > 0;
  const occupied = node.node_type === 'sub_slot' && node.active_allocation_count > 0;
  const mid = INDENT / 2;

  return (
    <div>
      <div className="group flex items-stretch">
        {/* Guide rails for every ancestor level */}
        {ancestry.map((hasMore, i) => (
          <span key={i} className="relative shrink-0" style={{ width: INDENT }}>
            {hasMore && (
              <span
                className="absolute inset-y-0 border-l border-border"
                style={{ left: mid }}
              />
            )}
          </span>
        ))}

        {/* Connector (elbow ├ / └) joining this node to its parent */}
        {depth > 0 && (
          <span className="relative shrink-0" style={{ width: INDENT }}>
            <span
              className="absolute top-0 h-1/2 border-l border-border"
              style={{ left: mid }}
            />
            {!isLast && (
              <span
                className="absolute bottom-0 h-1/2 border-l border-border"
                style={{ left: mid }}
              />
            )}
            <span
              className="absolute top-1/2 border-t border-border"
              style={{ left: mid, right: 0 }}
            />
          </span>
        )}

        {/* Row content */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1.5 group-hover:bg-surface">
          {hasChildren ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-label={open ? 'Collapse' : 'Expand'}
              aria-expanded={open}
              className="shrink-0 rounded text-text-3 hover:text-text"
            >
              {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            </button>
          ) : (
            <span className="inline-block w-[15px] shrink-0" />
          )}

          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
            onClick={() => onSelect(node)}
            disabled={node.node_type === 'sub_slot'}
          >
            <Badge tone={node.node_type === 'sub_slot' ? 'accent' : 'neutral'}>
              {NODE_TYPE_LABEL[node.node_type]}
            </Badge>
            <span className="truncate text-sm text-text-2">{node.name}</span>
            {node.node_type === 'sub_slot' && (
              <Badge tone={occupied ? 'warning' : 'success'}>
                {occupied ? 'Occupied' : 'Empty'}
              </Badge>
            )}
          </button>

          <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            {canWrite && childType && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onAddChild(node)}
                title={`Add ${NODE_TYPE_LABEL[childType]}`}
              >
                <Plus size={13} /> {NODE_TYPE_LABEL[childType]}
              </Button>
            )}
            {canWrite && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onDelete(node)}
                disabled={deletingId === node.id}
                aria-label="Delete node"
              >
                {deletingId === node.id ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Trash2 size={13} />
                )}
              </Button>
            )}
          </div>
        </div>
      </div>

      {open &&
        node.children.map((c, idx) => (
          <Ln2Node
            key={c.id}
            node={c}
            depth={depth + 1}
            isLast={idx === node.children.length - 1}
            ancestry={[...ancestry, !isLast]}
            canWrite={canWrite}
            deletingId={deletingId}
            onAddChild={onAddChild}
            onDelete={onDelete}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}
