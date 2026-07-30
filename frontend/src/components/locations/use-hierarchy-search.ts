'use client';

/**
 * Search the storage hierarchy by name, code, level, lot number, item number or
 * item name.
 *
 * Three of those are answered from the tree already in memory, so they are
 * instant and cost nothing:
 *
 *   name   "Box 1.1.1", "2.1.2"     — substring, case-insensitive
 *   code   "TANK-2-Q1-R1-B1"        — substring, case-insensitive
 *   level  "box", "rack", "quad"    — a level's own label, so one word finds
 *                                     every node at that level
 *
 * The other three answer "where is this stock", and none can come from the tree:
 * a node carries an occupancy COUNT, never what is inside it. They are resolved
 * by ``GET /allocations/search`` (added for this), debounced, one request per
 * settled query rather than one per node.
 *
 * Matches are reported, never filtered. The caller keeps the whole tree on
 * screen, highlights ``matchIds``, tints ``revealIds`` and opens them, so a match
 * three levels down is visible AND traceable — you can follow the tint from the
 * tank down to the box rather than just seeing a lit-up leaf.
 *
 * Stock can also be somewhere this tree does not cover. This searches LN2 only,
 * while the endpoint spans every area, so a lot on a warehouse shelf comes back
 * and has no row to highlight. Those are counted in ``elsewhere`` and reported
 * separately — the first version folded them into the summary, which read
 * "1 match · holding L-301-04, PL-301-04": two lots named, one row lit.
 */

import * as React from 'react';

import { NODE_TYPE_LABEL, locationNodesApi, type NodeTree } from '@/lib/api/location-nodes';

/** A stock lookup is a request, so wait for typing to settle. */
const STOCK_DEBOUNCE_MS = 250;
/** Below this, a query matches too much to be worth a round trip. */
const MIN_STOCK_QUERY = 2;
/** Level keywords need two characters ("bo" → Box); one would match everything. */
const MIN_LEVEL_QUERY = 2;

/** What the search found at one node. */
export interface StockHit {
  lots: string[];
  items: string[];
}

export interface HierarchySearch {
  /** A query is present. */
  active: boolean;
  /** Nodes that matched. */
  matchIds: Set<string>;
  /** Ancestors of matches — tint and open these so a match is traceable. */
  revealIds: Set<string>;
  /** Stock found at a node, for the ones matched by lot / item. */
  stockAt: Map<string, StockHit>;
  /** Code of a node that matched on its CODE but not its name.
   *
   *  Worth surfacing because a code drifts from the name: it is generated from
   *  the name at creation and rename deliberately leaves it alone (it is the
   *  stable identifier behind ``uq_location_nodes_parent_code``). So a tank
   *  renamed to "Tank 3" can still carry ``TANK-2-43IQS`` and match "TANK-2" —
   *  correct, but baffling unless the row shows why it is there. */
  codeAt: Map<string, string>;
  matchCount: number;
  /** Distinct lot numbers found IN THIS TREE. */
  lotNumbers: string[];
  /** Distinct item numbers found IN THIS TREE. */
  itemNumbers: string[];
  /** Allocations that matched but sit outside this tree (other storage areas). */
  elsewhere: number;
  /** A stock lookup is in flight. */
  loading: boolean;
}

const EMPTY: HierarchySearch = {
  active: false,
  matchIds: new Set(),
  revealIds: new Set(),
  stockAt: new Map(),
  codeAt: new Map(),
  matchCount: 0,
  lotNumbers: [],
  itemNumbers: [],
  elsewhere: 0,
  loading: false,
};

type LocalHit = 'name' | 'code' | 'level' | null;

/** How this node matched on its own name, code, or level label — if at all. */
function matchesLocally(node: NodeTree, q: string): LocalHit {
  if (node.name.toLowerCase().includes(q)) return 'name';
  if (node.code.toLowerCase().includes(q)) return 'code';
  if (q.length >= MIN_LEVEL_QUERY) {
    const level = NODE_TYPE_LABEL[node.node_type]?.toLowerCase() ?? '';
    // startsWith, not includes: "rack" should not also drag in every "Cryo Box
    // Rack" style label through a mid-word hit.
    if (level.startsWith(q)) return 'level';
  }
  return null;
}

/** Distinct, sorted, nulls dropped. */
function distinct(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))].sort();
}

export function useHierarchySearch(tree: NodeTree[], query: string): HierarchySearch {
  const q = query.trim().toLowerCase();

  // Every matching allocation, whatever area it is in. Partitioned against this
  // tree below.
  const [stock, setStock] = React.useState<
    { nodeId: string; lot: string | null; item: string | null }[]
  >([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (q.length < MIN_STOCK_QUERY) {
      setStock([]);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      locationNodesApi
        .searchAllocations(q, { signal: ctrl.signal })
        .then((allocs) =>
          setStock(
            allocs.map((a) => ({
              nodeId: a.location_node_id,
              lot: a.lot_number ?? null,
              item: a.item_number ?? null,
            })),
          ),
        )
        .catch(() => {
          // A failed lookup degrades to name/code/level only, which still works.
          setStock([]);
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setLoading(false);
        });
    }, STOCK_DEBOUNCE_MS);

    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  return React.useMemo(() => {
    if (!q) return EMPTY;

    // Which of the stock hits are in THIS tree.
    const inTree = new Set<string>();
    const collectIds = (n: NodeTree) => {
      inTree.add(n.id);
      n.children.forEach(collectIds);
    };
    tree.forEach(collectIds);

    const stockAt = new Map<string, StockHit>();
    let elsewhere = 0;
    for (const s of stock) {
      if (!inTree.has(s.nodeId)) {
        elsewhere += 1;
        continue;
      }
      const hit = stockAt.get(s.nodeId) ?? { lots: [], items: [] };
      if (s.lot && !hit.lots.includes(s.lot)) hit.lots.push(s.lot);
      if (s.item && !hit.items.includes(s.item)) hit.items.push(s.item);
      stockAt.set(s.nodeId, hit);
    }

    const matchIds = new Set<string>();
    const revealIds = new Set<string>();
    const codeAt = new Map<string, string>();

    const walk = (node: NodeTree, ancestors: string[]) => {
      const how = matchesLocally(node, q);
      if (how || stockAt.has(node.id)) {
        matchIds.add(node.id);
        // Only when the NAME didn't match — otherwise the row already explains
        // itself and the code would be clutter.
        if (how === 'code') codeAt.set(node.id, node.code);
        ancestors.forEach((id) => revealIds.add(id));
      }
      const here = [...ancestors, node.id];
      node.children.forEach((c) => walk(c, here));
    };
    tree.forEach((n) => walk(n, []));

    const hits = [...stockAt.values()];
    return {
      active: true,
      matchIds,
      revealIds,
      stockAt,
      codeAt,
      matchCount: matchIds.size,
      lotNumbers: distinct(hits.flatMap((h) => h.lots)),
      itemNumbers: distinct(hits.flatMap((h) => h.items)),
      elsewhere,
      loading,
    };
  }, [q, tree, stock, loading]);
}
