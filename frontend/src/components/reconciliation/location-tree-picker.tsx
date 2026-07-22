'use client';

import * as React from 'react';
import { Check, ChevronDown, ChevronRight, MapPin, Search } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { NODE_TYPE_LABEL, locationNodesApi, type NodeTree } from '@/lib/api/location-nodes';
import { cn } from '@/lib/utils';

export type LocationArea = 'ln2' | 'cold' | 'warehouse' | 'production';

/** A node in the picker's unified forest. Synthetic group nodes wrap each area. */
export interface PNode {
  id: string;
  name: string;
  nodeType: string;
  canStore: boolean;
  isGroup: boolean;
  area: LocationArea | null;
  /** Real breadcrumb (excludes the synthetic group), e.g. "Warehouse One › Shelf A". */
  path: string;
  children: PNode[];
}

interface Forest {
  roots: PNode[];
  byId: Map<string, PNode>;
  parentOf: Map<string, string | null>;
  real: PNode[];
}

const AREA_LABEL: Record<LocationArea, string> = {
  ln2: 'LN2',
  cold: 'Freezers',
  warehouse: 'Warehouse',
  production: 'Production / Lab',
};

// ── Cached forest (fetched once, shared across all picker instances) ─────────

let _cache: Forest | null = null;
let _inflight: Promise<Forest> | null = null;

function convertTree(
  n: NodeTree,
  prefix: string[],
  parentId: string | null,
  area: LocationArea,
  byId: Map<string, PNode>,
  parentOf: Map<string, string | null>,
  real: PNode[],
): PNode {
  const path = [...prefix, n.name];
  const p: PNode = {
    id: n.id,
    name: n.name,
    nodeType: n.node_type,
    canStore: n.can_store,
    isGroup: false,
    area,
    path: path.join(' › '),
    children: [],
  };
  byId.set(n.id, p);
  parentOf.set(n.id, parentId);
  real.push(p);
  p.children = n.children.map((c) => convertTree(c, path, n.id, area, byId, parentOf, real));
  return p;
}

async function buildForest(): Promise<Forest> {
  const [ln2, freezer, warehouse, production] = await Promise.all([
    locationNodesApi.ln2Tree(),
    locationNodesApi.freezerTree(),
    locationNodesApi.warehouseTree(),
    // Production/lab floors (Clean Room 1/2, Manufacturing Floor, PD Lab
    // One/Two) — a kit's production location must be one of these
    // (Transaction_Spec §2). They are root `flat` nodes, so they have no
    // children of their own.
    locationNodesApi.flat({ category: 'production' }),
  ]);
  const byId = new Map<string, PNode>();
  const parentOf = new Map<string, string | null>();
  const real: PNode[] = [];

  // `flatten` drops the single building level (e.g. "Warehouse One") so the
  // storage leaves sit directly under the area group — Warehouse › Shelf A.
  const group = (area: LocationArea, trees: NodeTree[], flatten = false): PNode => {
    const roots = trees.map((n) => convertTree(n, [], null, area, byId, parentOf, real));
    const children = flatten ? roots.flatMap((r) => r.children) : roots;
    const g: PNode = {
      id: `grp:${area}`,
      name: AREA_LABEL[area],
      nodeType: 'group',
      canStore: false,
      isGroup: true,
      area,
      path: '',
      children,
    };
    byId.set(g.id, g);
    parentOf.set(g.id, null);
    // Re-parent the promoted leaves onto the group so pruning/ancestry walks
    // skip the removed building level.
    children.forEach((c) => parentOf.set(c.id, g.id));
    return g;
  };

  const roots = [
    group('ln2', ln2),
    group('cold', freezer),
    group('warehouse', warehouse, true),
    group(
      'production',
      production.map((n) => ({ ...n, children: [] })),
    ),
  ].filter((g) => g.children.length > 0);
  return { roots, byId, parentOf, real };
}

function loadForest(): Promise<Forest> {
  if (_cache) return Promise.resolve(_cache);
  if (!_inflight)
    _inflight = buildForest().then((f) => {
      _cache = f;
      return f;
    });
  return _inflight;
}

/** Drop the cache so the next mount refetches (call after a location edit). */
export function invalidateLocationForest() {
  _cache = null;
  _inflight = null;
}

// ── The picker ───────────────────────────────────────────────────────────────

const ALL_AREAS: LocationArea[] = ['ln2', 'cold', 'warehouse'];

export function LocationTreePicker({
  value,
  onChange,
  areas = ALL_AREAS,
  allowedNodeIds,
  nodeQty,
  // Storage leaves, plus production floors (which are `flat` nodes, so
  // `can_store` is false even though a kit legitimately targets them).
  selectable = (n) => n.canStore || n.area === 'production',
  showPath = false,
  disabled,
  placeholder = 'Choose a location',
  emptyText = 'No locations available.',
  modal = false,
  className,
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (id: string) => void;
  /** Which area groups to show. Default: the three storage areas — 'production'
   *  is opt-in, since production floors are only valid as a kit's production
   *  location, never as a storage source/return/output. */
  areas?: ReadonlyArray<LocationArea>;
  /** If given, only these node ids are selectable AND the tree is pruned to the
   *  branches leading to them (e.g. locations holding an item). */
  allowedNodeIds?: ReadonlySet<string> | null;
  /** Optional per-node quantity to show next to a pickable node. */
  nodeQty?: Record<string, number>;
  /** Which nodes may be picked. Default: storage leaves. */
  selectable?: (node: PNode) => boolean;
  showPath?: boolean;
  disabled?: boolean;
  placeholder?: string;
  emptyText?: string;
  modal?: boolean;
  className?: string;
  'aria-label'?: string;
}) {
  const [forest, setForest] = React.useState<Forest | null>(_cache);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    let alive = true;
    void loadForest().then((f) => alive && setForest(f));
    return () => {
      alive = false;
    };
  }, []);

  const canPick = React.useCallback(
    (n: PNode) =>
      !n.isGroup && selectable(n) && (!allowedNodeIds || allowedNodeIds.has(n.id)),
    [selectable, allowedNodeIds],
  );

  // When restricted to specific nodes, prune the tree to just the branches
  // leading to them (allowed nodes + their ancestors).
  const visibleIds = React.useMemo(() => {
    if (!forest || !allowedNodeIds) return null;
    const vis = new Set<string>();
    for (const id of allowedNodeIds) {
      let cur: string | null = id;
      while (cur && !vis.has(cur)) {
        vis.add(cur);
        cur = forest.parentOf.get(cur) ?? null;
      }
    }
    return vis;
  }, [forest, allowedNodeIds]);

  const visibleRoots = React.useMemo(
    () =>
      forest
        ? forest.roots.filter(
            (r) => r.area && areas.includes(r.area) && (!visibleIds || visibleIds.has(r.id)),
          )
        : [],
    [forest, areas, visibleIds],
  );

  const selected = forest?.byId.get(value) ?? null;

  React.useEffect(() => {
    if (!open || !forest) return;
    // With pruning, open every visible branch so the available spots show at once.
    const next = new Set<string>(visibleIds ? [...visibleIds] : visibleRoots.map((r) => r.id));
    let cur: string | null = value;
    while (cur) {
      next.add(cur);
      cur = forest.parentOf.get(cur) ?? null;
    }
    setExpanded(next);
    setQuery('');
  }, [open, forest, value, visibleRoots, visibleIds]);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
  };
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const q = query.trim().toLowerCase();
  const searchHits =
    forest && q
      ? forest.real
          .filter(
            (n) =>
              n.area &&
              areas.includes(n.area) &&
              canPick(n) &&
              (n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)),
          )
          .slice(0, 60)
      : [];

  const triggerLabel = selected
    ? showPath && selected.path
      ? selected.path
      : selected.name
    : placeholder;

  return (
    <Popover open={open} onOpenChange={setOpen} modal={modal}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled || !forest}
          aria-label={ariaLabel}
          className={cn(
            'flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border-strong bg-bg-elev px-2.5 text-sm text-text shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
        >
          <span className={cn('flex min-w-0 items-center gap-1.5', !selected && 'text-text-3')}>
            <MapPin size={13} className="shrink-0 text-text-3" aria-hidden />
            <span className="truncate text-left">{forest ? triggerLabel : 'Loading…'}</span>
          </span>
          <ChevronDown size={14} className="shrink-0 text-text-3" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] p-0">
        <div className="border-b border-border p-2">
          <Input
            autoFocus
            icon={Search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search locations…"
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-1" role="tree" aria-label={ariaLabel}>
          {!forest ? (
            <p className="px-2 py-6 text-center text-xs text-text-3">Loading…</p>
          ) : visibleRoots.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-text-3">{emptyText}</p>
          ) : q ? (
            searchHits.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-text-3">No matches.</p>
            ) : (
              searchHits.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  role="option"
                  aria-selected={n.id === value}
                  onClick={() => pick(n.id)}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface',
                    n.id === value && 'bg-surface',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-text">{n.name}</span>
                    <span className="block truncate text-xs text-text-3">{n.path}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {nodeQty?.[n.id] != null && (
                      <span className="font-mono text-xs tabular-nums text-text-2">{nodeQty[n.id]}</span>
                    )}
                    {n.id === value && <Check size={14} className="text-accent" />}
                  </span>
                </button>
              ))
            )
          ) : (
            visibleRoots.map((r) => (
              <TreeRow
                key={r.id}
                node={r}
                depth={0}
                value={value}
                expanded={expanded}
                canPick={canPick}
                visibleIds={visibleIds}
                nodeQty={nodeQty}
                onToggle={toggle}
                onPick={pick}
              />
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TreeRow({
  node,
  depth,
  value,
  expanded,
  canPick,
  visibleIds,
  nodeQty,
  onToggle,
  onPick,
}: {
  node: PNode;
  depth: number;
  value: string;
  expanded: Set<string>;
  canPick: (n: PNode) => boolean;
  visibleIds: Set<string> | null;
  nodeQty?: Record<string, number>;
  onToggle: (id: string) => void;
  onPick: (id: string) => void;
}) {
  const children = visibleIds
    ? node.children.filter((c) => visibleIds.has(c.id))
    : node.children;
  const hasChildren = children.length > 0;
  const isOpen = expanded.has(node.id);
  const pickable = canPick(node);
  const isSelected = node.id === value;

  return (
    <>
      <div
        className={cn('flex items-center gap-1 rounded pr-1 hover:bg-surface', isSelected && 'bg-surface')}
        style={{ paddingLeft: depth * 14 }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={isOpen ? `Collapse ${node.name}` : `Expand ${node.name}`}
            onClick={() => onToggle(node.id)}
            className="rounded p-0.5 text-text-3 hover:text-text"
          >
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="w-[18px] shrink-0" aria-hidden />
        )}
        {pickable ? (
          <button
            type="button"
            role="treeitem"
            aria-selected={isSelected}
            onClick={() => onPick(node.id)}
            className="flex min-w-0 flex-1 items-center justify-between gap-2 py-1 text-left text-sm"
          >
            <span className="truncate text-text">{node.name}</span>
            <span className="flex shrink-0 items-center gap-1.5">
              {nodeQty?.[node.id] != null ? (
                <span className="font-mono text-xs tabular-nums text-text-2">{nodeQty[node.id]}</span>
              ) : (
                <span className="text-[10px] uppercase tracking-wide text-text-3">
                  {NODE_TYPE_LABEL[node.nodeType as keyof typeof NODE_TYPE_LABEL] ?? node.nodeType}
                </span>
              )}
              {isSelected && <Check size={14} className="text-accent" />}
            </span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => hasChildren && onToggle(node.id)}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-sm',
              node.isGroup ? 'font-medium text-text-2' : 'text-text-3',
            )}
          >
            <span className="truncate">{node.name}</span>
          </button>
        )}
      </div>
      {isOpen &&
        children.map((c) => (
          <TreeRow
            key={c.id}
            node={c}
            depth={depth + 1}
            value={value}
            expanded={expanded}
            canPick={canPick}
            visibleIds={visibleIds}
            nodeQty={nodeQty}
            onToggle={onToggle}
            onPick={onPick}
          />
        ))}
    </>
  );
}
