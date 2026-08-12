'use client';

import * as React from 'react';
import { Check, ChevronDown, ChevronRight, MapPin, Search } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { NODE_TYPE_LABEL, locationNodesApi, type NodeTree } from '@/lib/api/location-nodes';
import { cn } from '@/lib/utils';

/**
 * What a branch is FOR, which is the only distinction any caller draws: a place
 * stock is stored, or a floor a kit is issued to. It used to be one value per
 * fetch endpoint ('ln2' | 'cold' | 'warehouse'), but no caller ever filtered to
 * one of those — and since LOC-005 put Warehouse One inside the Materials
 * Management room, "warehouse" stopped being a top-level thing at all.
 */
export type LocationArea = 'storage' | 'production';

/** A node in the picker's unified forest. Synthetic group nodes wrap LN2 and
 *  Production; every other root is a real room. */
export interface PNode {
  id: string;
  name: string;
  /** The node's own code. Searchable, so "WH1-A" finds Shelf A. */
  code: string;
  nodeType: string;
  canStore: boolean;
  isGroup: boolean;
  area: LocationArea | null;
  /** Real breadcrumb (excludes any synthetic group), e.g. "Warehouse One › Shelf A". */
  path: string;
  children: PNode[];
}

export interface Forest {
  roots: PNode[];
  byId: Map<string, PNode>;
  parentOf: Map<string, string | null>;
  real: PNode[];
}

/**
 * Rooms come first, in the order the sidebar lists them, so the picker and the
 * navigation agree. Anything not named here sorts after, by name — a new room
 * appears without a code change.
 */
const ROOM_CODE_ORDER = ['STG', 'MM', 'CS', 'AL'];

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
  extraChildren: NodeTree[] = [],
): PNode {
  const path = [...prefix, n.name];
  const p: PNode = {
    id: n.id,
    name: n.name,
    code: n.code,
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
  p.children = [...extraChildren, ...n.children].map((c) =>
    convertTree(c, path, n.id, area, byId, parentOf, real),
  );
  return p;
}

/**
 * One tree that matches the real location model.
 *
 * The top level is the ROOMS — Materials Management, Cold Storage, the Analytical
 * Lab — each holding its own locations, with LN2 and Production as the two
 * synthetic groups for branches that live in no room.
 *
 * The grafting matters. The API serves one area's node types per endpoint, so
 * ``/freezer-tree`` returns a room WITHOUT the warehouse inside it and
 * ``/warehouse-tree`` returns that warehouse as a forest root of its own. Left
 * alone, Materials Management's two locations render under two different
 * top-level headings — which is what this picker used to do, and it stopped being
 * true when LOC-005 moved Warehouse One into the room. A warehouse carries its
 * ``parent_id``, so it is re-attached to the room it belongs to and the hierarchy
 * reads the way the structure diagram does.
 */
async function buildForest(): Promise<Forest> {
  const [ln2, rooms, warehouses, production, kanbans] = await Promise.all([
    locationNodesApi.ln2Tree(),
    locationNodesApi.freezerTree(),
    locationNodesApi.warehouseTree(),
    // Production floors — a kit's production location must be one of these
    // (Transaction_Spec §2). Root `flat` nodes, whose only children are Kanbans.
    locationNodesApi.flat({ category: 'production' }),
    // Kanban stations hang under a production area (LOC-006, consum01). They
    // are fetched separately because the flat endpoint returns roots only, and
    // grafted on below so an area renders as an expandable parent.
    locationNodesApi.allKanbans(),
  ]);
  const byId = new Map<string, PNode>();
  const parentOf = new Map<string, string | null>();
  const real: PNode[] = [];

  const kanbansByArea = new Map<string, NodeTree[]>();
  for (const k of kanbans) {
    if (!k.parent_id) continue;
    const asTree: NodeTree = { ...k, children: [] };
    kanbansByArea.set(k.parent_id, [...(kanbansByArea.get(k.parent_id) ?? []), asTree]);
  }

  const warehousesByRoom = new Map<string, NodeTree[]>();
  for (const w of warehouses) {
    const key = w.parent_id ?? '';
    warehousesByRoom.set(key, [...(warehousesByRoom.get(key) ?? []), w]);
  }

  const group = (id: string, name: string, area: LocationArea, children: PNode[]): PNode => {
    const g: PNode = {
      id,
      name,
      code: '',
      nodeType: 'group',
      canStore: false,
      isGroup: true,
      area,
      path: '',
      children,
    };
    byId.set(g.id, g);
    parentOf.set(g.id, null);
    children.forEach((c) => parentOf.set(c.id, g.id));
    return g;
  };

  // Rooms, warehouses grafted in ahead of the cold-storage groups so the order
  // matches the Materials Management page's tabs (Warehouse, then freezers).
  const roomNodes = [...rooms]
    .sort((a, b) => {
      const ai = ROOM_CODE_ORDER.indexOf(a.code);
      const bi = ROOM_CODE_ORDER.indexOf(b.code);
      if (ai !== bi) return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
      return a.name.localeCompare(b.name);
    })
    .map((room) =>
      convertTree(
        room,
        [],
        null,
        'storage',
        byId,
        parentOf,
        real,
        warehousesByRoom.get(room.id) ?? [],
      ),
    );

  // A warehouse whose room isn't in the room tree would otherwise vanish. Keep
  // it as its own root rather than dropping stock somewhere unreachable.
  const orphanWarehouses = warehouses
    .filter((w) => !w.parent_id || !rooms.some((r) => r.id === w.parent_id))
    .map((w) => convertTree(w, [], null, 'storage', byId, parentOf, real));

  const roots = [
    ...roomNodes,
    ...orphanWarehouses,
    group(
      'grp:ln2',
      'LN2',
      'storage',
      ln2.map((n) => convertTree(n, [], null, 'storage', byId, parentOf, real)),
    ),
    group(
      'grp:production',
      'Production',
      'production',
      production.map((n) =>
        convertTree(
          { ...n, children: [] },
          [],
          null,
          'production',
          byId,
          parentOf,
          real,
          kanbansByArea.get(n.id) ?? [],
        ),
      ),
    ),
  ].filter((r) => r.isGroup ? r.children.length > 0 : true);

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

/**
 * The shared location forest, once it has loaded. Null on the first render.
 *
 * The forest is cached at module scope, so many components may hold this without
 * costing more than one request. Anything that only needs to READ the tree —
 * resolving a node id to its address or its route — should use this rather than
 * fetching the four endpoints again.
 */
export function useLocationForest(): Forest | null {
  const [forest, setForest] = React.useState<Forest | null>(_cache);
  React.useEffect(() => {
    // Already cached — nothing to wait for.
    if (_cache) {
      setForest(_cache);
      return;
    }
    let alive = true;
    void loadForest().then((f) => alive && setForest(f));
    return () => {
      alive = false;
    };
  }, []);
  return forest;
}

/**
 * A node's ancestry, root first and the node itself last. Empty when the id
 * isn't in the forest — a node that was deleted, or one the current user's tree
 * doesn't include.
 */
export function nodeChain(forest: Forest, nodeId: string): PNode[] {
  const chain: PNode[] = [];
  let cur = forest.byId.get(nodeId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    const parentId = forest.parentOf.get(cur.id);
    cur = parentId ? forest.byId.get(parentId) : undefined;
  }
  return chain;
}

// ── The picker ───────────────────────────────────────────────────────────────

/** Default: the storage branches. 'production' is opt-in — a production floor is
 *  only ever valid as a kit's production location, never as a storage
 *  source, return or output. */
const ALL_AREAS: LocationArea[] = ['storage'];

export function LocationTreePicker({
  value,
  onChange,
  areas = ALL_AREAS,
  allowedNodeIds,
  excludeNodeTypes,
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
  /** Which branches to show. Default: storage. See {@link ALL_AREAS}. */
  areas?: ReadonlyArray<LocationArea>;
  /** If given, only these node ids are selectable AND the tree is pruned to the
   *  branches leading to them (e.g. locations holding an item). */
  allowedNodeIds?: ReadonlySet<string> | null;
  /** Node types to drop from the tree and from search, subtree and all. Use it
   *  when a branch is real but irrelevant to the flow — a kit is destined for a
   *  production area, so the Kanbans hanging under one are noise there. */
  excludeNodeTypes?: ReadonlyArray<string>;
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

  const excluded = React.useMemo(
    () => new Set(excludeNodeTypes ?? []),
    // A new array literal every render is the normal way this prop is passed, so
    // key the memo on the contents rather than the identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [(excludeNodeTypes ?? []).join(',')],
  );

  const isHidden = React.useCallback((n: PNode) => excluded.has(n.nodeType), [excluded]);

  const canPick = React.useCallback(
    (n: PNode) =>
      !n.isGroup &&
      !isHidden(n) &&
      selectable(n) &&
      (!allowedNodeIds || allowedNodeIds.has(n.id)),
    [selectable, allowedNodeIds, isHidden],
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
            (r) =>
              r.area &&
              areas.includes(r.area) &&
              !isHidden(r) &&
              (!visibleIds || visibleIds.has(r.id)),
          )
        : [],
    [forest, areas, visibleIds, isHidden],
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
              (n.name.toLowerCase().includes(q) ||
                n.code.toLowerCase().includes(q) ||
                n.path.toLowerCase().includes(q)),
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
                isHidden={isHidden}
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
  isHidden,
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
  isHidden: (n: PNode) => boolean;
  visibleIds: Set<string> | null;
  nodeQty?: Record<string, number>;
  onToggle: (id: string) => void;
  onPick: (id: string) => void;
}) {
  const children = node.children.filter(
    (c) => !isHidden(c) && (!visibleIds || visibleIds.has(c.id)),
  );
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
            // One style for everything you cannot pick. This used to give a
            // SYNTHETIC group (`grp:ln2`, `grp:production`) heavier, darker text
            // than a real room — but both kinds sit at the top level as
            // siblings, and both behave identically: expand to reveal children,
            // never selectable. The weight tracked whether the app stores a row
            // or synthesises it, which is invisible to whoever is reading the
            // list; all it did was make LN2 and Production look pickable when
            // they are not. Black is reserved for rows you can actually choose.
            className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-sm text-text-3"
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
            isHidden={isHidden}
            visibleIds={visibleIds}
            nodeQty={nodeQty}
            onToggle={onToggle}
            onPick={onPick}
          />
        ))}
    </>
  );
}
