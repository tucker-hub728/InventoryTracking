'use client';

/**
 * Relocate a location — and everything inside it — to a different place in the
 * cascade (REQ-2026-07-22-LOC-004, "re-cascadeable by the client").
 *
 * Called "Relocate", never "Move". Transfer already owns the word move — it
 * moves STOCK between locations ("14 units will move to Box 2"). This moves a
 * LOCATION and no stock at all: a lot allocation points at its box's id, never
 * at a path, so a rack relocated to another quadrant carries its boxes and their
 * vials with it and every address beneath recomputes on its own. That is the
 * cascade part, and it is why the two operations must not share a verb.
 *
 * The destination is the real hierarchy, not a flat list of legal parents. The
 * flat version was technically correct and useless: a quadrant's only legal
 * parent type is a tank, so the dropdown could only ever list tanks, stripped of
 * the context that tells you which one you want.
 *
 * Showing the hierarchy is not the same as showing all of it. Two rules keep it
 * short (client 2026-07-30, after the first version rendered thirty-odd rows):
 *
 *   1. **Nothing below a destination.** Once a branch reaches a node of the
 *      allowed parent type, its contents can never themselves be destinations —
 *      relocating a Box, every Box row is unreachable noise. Those subtrees are
 *      pruned, not collapsed: there is nothing in them to open.
 *   2. **Collapsed by default.** Only the branch holding the current parent is
 *      open, so you land looking at where the thing is now and its siblings.
 *      A collapsed branch says how many destinations are inside it, so an empty
 *      tank can be skipped without opening it.
 *
 * Every node still renders in one of three states — selectable, blocked with the
 * reason, or context you navigate past — and the blocked reasons mirror the API's
 * guards one-for-one (``PATCH /location-nodes/{id}/parent``), so the dialog can
 * only ever refuse what the server would refuse. If a guard changes there, change
 * ``classify`` here.
 */

import * as React from 'react';
import {
  AlertCircle,
  ArrowRight,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Search,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api/client';
import { invalidateLocationForest } from '@/components/reconciliation/location-tree-picker';
import {
  MAX_QUADRANTS_PER_TANK,
  NODE_TYPE_LABEL,
  locationNodesApi,
  parentTypesOf,
  subtreeStats,
  type NodeTree,
} from '@/lib/api/location-nodes';

/** Why a right-type node still cannot take this one. */
type Blocked =
  | { state: 'selectable' }
  | { state: 'current' }
  | { state: 'context' }
  | { state: 'blocked'; reason: string };

/** The pruned destination tree — see rule 1 in the module docstring. */
interface TNode {
  node: NodeTree;
  status: Blocked;
  children: TNode[];
  /** Selectable destinations in this subtree, including this node. */
  available: number;
}

interface Row {
  node: NodeTree;
  depth: number;
  status: Blocked;
  available: number;
  hasChildren: boolean;
  expanded: boolean;
}

function buildTree(forest: NodeTree[], moving: NodeTree, allowedTypes: string[]): TNode[] {
  const insideMoving = new Set<string>();
  const markInside = (n: NodeTree) => {
    insideMoving.add(n.id);
    n.children.forEach(markInside);
  };
  markInside(moving);

  const classify = (n: NodeTree): Blocked => {
    if (n.id === moving.id) return { state: 'context' };
    // Wrong type is context — structure you navigate past, not a rejected
    // candidate. Marking every tank "wrong type" would be noise.
    if (!allowedTypes.includes(n.node_type)) return { state: 'context' };
    // A same-type descendant. Unreachable while every level has exactly one
    // legal parent type — a box is never a quadrant — but the API guards it and
    // so does this, so a future self-nesting level cannot orphan a branch.
    if (insideMoving.has(n.id)) {
      return { state: 'blocked', reason: 'inside what you’re relocating' };
    }
    if (n.id === moving.parent_id) return { state: 'current' };
    if (!n.is_active) return { state: 'blocked', reason: 'inactive' };
    // Sibling code clash — the destination's own uniqueness rule, applied
    // exactly as it would be on create.
    if (n.children.some((c) => c.code.toLowerCase() === moving.code.toLowerCase())) {
      // The clash is on ``code``, but the reason is phrased with the NAME: a
      // code is machine identity and is shown nowhere in the UI, so quoting one
      // here would name something the reader cannot see anywhere else.
      return { state: 'blocked', reason: `already contains “${moving.name}”` };
    }
    // REQ-2026-07-15-LOC-001: four quadrants per tank, a hard cap. Counted here
    // over the loaded tree; the API counts it authoritatively, inactive included.
    if (moving.node_type === 'tank_quadrant') {
      const quadrants = n.children.filter((c) => c.node_type === 'tank_quadrant').length;
      if (quadrants >= MAX_QUADRANTS_PER_TANK) {
        return {
          state: 'blocked',
          reason: `already has all ${MAX_QUADRANTS_PER_TANK} quadrants`,
        };
      }
    }
    return { state: 'selectable' };
  };

  const build = (n: NodeTree): TNode => {
    const status = classify(n);
    // Rule 1: a destination's contents, and the moving node's own contents,
    // can never be destinations. Prune rather than collapse — there is nothing
    // inside worth opening.
    const prune = allowedTypes.includes(n.node_type) || n.id === moving.id;
    const children = prune ? [] : n.children.map(build);
    const available =
      (status.state === 'selectable' ? 1 : 0) +
      children.reduce((sum, c) => sum + c.available, 0);
    return { node: n, status, children, available };
  };

  return forest.map(build);
}

/** Ids on the path from a root down to (and including) ``targetId``. */
function pathTo(tree: TNode[], targetId: string | null): Set<string> {
  const out = new Set<string>();
  if (!targetId) return out;
  const walk = (n: TNode, trail: string[]): boolean => {
    const here = [...trail, n.node.id];
    if (n.node.id === targetId) {
      here.forEach((id) => out.add(id));
      return true;
    }
    return n.children.some((c) => walk(c, here));
  };
  tree.forEach((r) => walk(r, []));
  return out;
}

/** Rows to render, honouring which branches are open. */
function flatten(tree: TNode[], expanded: Set<string>, depth = 0): Row[] {
  const rows: Row[] = [];
  for (const t of tree) {
    const isOpen = expanded.has(t.node.id);
    rows.push({
      node: t.node,
      depth,
      status: t.status,
      available: t.available,
      hasChildren: t.children.length > 0,
      expanded: isOpen,
    });
    if (isOpen) rows.push(...flatten(t.children, expanded, depth + 1));
  }
  return rows;
}

/** Every row, ignoring expansion — the pool a search filters. */
function flattenAll(tree: TNode[], depth = 0): Row[] {
  const rows: Row[] = [];
  for (const t of tree) {
    rows.push({
      node: t.node,
      depth,
      status: t.status,
      available: t.available,
      hasChildren: false,
      expanded: false,
    });
    rows.push(...flattenAll(t.children, depth + 1));
  }
  return rows;
}

/**
 * Rows matching a query, plus each match's ancestors and descendants.
 *
 * Ancestors so a match three levels down keeps the path that explains where it
 * is; descendants so a matched tank still shows what is inside it. ``rows`` is
 * depth-ordered from a pre-order walk, so one forward pass does both:
 * ``stack[d]`` holds the row index of the current node at depth ``d``, and
 * ``matchDepth`` is the depth of the matched subtree we are inside (-1 = none).
 */
function filterRows(rows: Row[], query: string): Row[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;

  const hit = (r: Row) =>
    r.node.name.toLowerCase().includes(q) || r.node.code.toLowerCase().includes(q);

  const keep = new Array<boolean>(rows.length).fill(false);
  const stack: number[] = [];
  let matchDepth = -1;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    stack[r.depth] = i;
    // Coming back up to or past the matched node's depth leaves its subtree.
    if (matchDepth >= 0 && r.depth <= matchDepth) matchDepth = -1;

    if (hit(r)) {
      keep[i] = true;
      for (let d = 0; d < r.depth; d++) keep[stack[d]!] = true;
      if (matchDepth < 0) matchDepth = r.depth;
    } else if (matchDepth >= 0) {
      // Strictly below the match — the check above already closed the subtree.
      keep[i] = true;
    }
  }
  return rows.filter((_, i) => keep[i]);
}

export function RelocateDialog({
  open,
  onOpenChange,
  node,
  forest,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** The location being relocated. */
  node: NodeTree;
  /** The whole area tree it lives in, roots first — rendered as the destination. */
  forest: NodeTree[];
  onDone: () => void;
}) {
  const [target, setTarget] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);

  const allowedTypes = React.useMemo(() => parentTypesOf(node.node_type), [node]);
  const tree = React.useMemo(
    () => buildTree(forest, node, allowedTypes),
    [forest, node, allowedTypes],
  );

  // Clear the form on each opening. Deliberately keyed on ``open`` alone: the
  // caller refetches the cascade as the dialog opens, so ``tree`` changes a beat
  // later — resetting on that too would wipe a selection the operator had already
  // made.
  React.useEffect(() => {
    if (!open) return;
    setTarget('');
    setQuery('');
  }, [open]);

  // Open the branch the node currently sits in, and nothing else — landing on
  // "here is where it is, and here are its neighbours" beats landing on
  // everything. Applied once per opening, on the first non-empty tree, so a
  // cascade that arrives after the dialog does still gets its default expansion
  // without overriding what the operator has opened since.
  const seeded = React.useRef(false);
  React.useEffect(() => {
    if (!open) {
      seeded.current = false;
      return;
    }
    if (seeded.current || tree.length === 0) return;
    seeded.current = true;
    setExpanded(pathTo(tree, node.parent_id));
  }, [open, tree, node.parent_id]);

  const searching = query.trim().length > 0;
  const visible = React.useMemo(
    () =>
      searching
        ? filterRows(flattenAll(tree), query)
        : flatten(tree, expanded),
    [searching, tree, query, expanded],
  );

  const totalAvailable = tree.reduce((sum, t) => sum + t.available, 0);
  const inside = subtreeStats(node);
  const childCount = node.children.length;

  const findTarget = (id: string): NodeTree | null => {
    const walk = (ts: TNode[]): NodeTree | null => {
      for (const t of ts) {
        if (t.node.id === id) return t.node;
        const hit = walk(t.children);
        if (hit) return hit;
      }
      return null;
    };
    return walk(tree);
  };
  const targetNode = target ? findTarget(target) : null;

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await locationNodesApi.move(node.id, target);
      // Relocating rewrites every address beneath this node, so the cached
      // destination tree in Receipt Admin / kitting is now wrong, not just stale.
      invalidateLocationForest();
      toast.success(`${node.name} relocated`, {
        description: targetNode ? `Now in ${targetNode.name}` : undefined,
      });
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to relocate.');
    } finally {
      setBusy(false);
    }
  };

  const parentLabel = allowedTypes.map((t) => NODE_TYPE_LABEL[t].toLowerCase()).join(' or ');
  // The node's name usually already carries its type ("Box 1.1.1"), so prefixing
  // the type label produced "Relocate Box Box 1.1.1". The type sits on its own
  // line instead.
  const currentPath = React.useMemo(() => {
    const ids = pathTo(tree, node.parent_id);
    const names: string[] = [];
    const walk = (ts: TNode[]) => {
      for (const t of ts) {
        if (ids.has(t.node.id)) {
          names.push(t.node.name);
          walk(t.children);
        }
      }
    };
    walk(tree);
    return names.join(' › ');
  }, [tree, node.parent_id]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-lg flex-col">
        <DialogHeader>
          <DialogTitle>Relocate {node.name}</DialogTitle>
          <DialogDescription>
            <span className="mb-1 block text-[11px] uppercase tracking-wide text-text-3">
              {NODE_TYPE_LABEL[node.node_type]}
              {currentPath && ` · currently in ${currentPath}`}
            </span>
            Everything inside comes along
            {childCount > 0 &&
              ` — ${childCount} ${NODE_TYPE_LABEL[node.children[0]!.node_type].toLowerCase()}${
                childCount === 1 ? '' : 's'
              }`}
            {inside.occupied > 0 &&
              ` and ${inside.occupied} stored unit${inside.occupied === 1 ? '' : 's'}`}
            . No stock is moved, and past ledger entries keep the address they were
            recorded with.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex min-h-0 flex-col gap-3">
          {totalAvailable === 0 && (
            <div className="flex items-start gap-2.5 rounded-lg border border-border bg-bg-elev p-3.5">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-text-3" aria-hidden />
              <p className="text-xs text-text-2">
                Nowhere to put this yet — every {parentLabel} is either full, already holds
                something called “{node.name}”, or is where it already sits. Open the
                branches below to see which.
              </p>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Input
              icon={Search}
              placeholder="Search the cascade…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search destinations"
            />
            {!searching && totalAvailable > 0 && (
              <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-text-3">
                {totalAvailable} available
              </span>
            )}
          </div>

          <div
            role="radiogroup"
            aria-label="Destination"
            className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-bg-elev p-1.5"
          >
            {visible.length === 0 ? (
              <p className="px-2.5 py-6 text-center text-sm text-text-3">
                {searching ? `Nothing matches “${query}”.` : 'No locations to show.'}
              </p>
            ) : (
              visible.map((row) => (
                <DestinationRow
                  key={row.node.id}
                  row={row}
                  selected={row.node.id === target}
                  searching={searching}
                  onSelect={() => setTarget(row.node.id)}
                  onToggle={() => toggle(row.node.id)}
                />
              ))
            )}
          </div>

          {targetNode && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-accent/30 bg-accent-soft px-3.5 py-2.5 text-xs">
              <span className="font-medium text-text">{node.name}</span>
              <ArrowRight size={13} className="text-text-3" aria-hidden />
              <span className="font-medium text-accent">{targetNode.name}</span>
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={save} disabled={busy || !target}>
            {busy ? 'Relocating…' : 'Relocate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DestinationRow({
  row,
  selected,
  searching,
  onSelect,
  onToggle,
}: {
  row: Row;
  selected: boolean;
  /** During a search the tree is flat, so expand/collapse is meaningless. */
  searching: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const { node, depth, status, available, hasChildren, expanded } = row;
  const selectable = status.state === 'selectable';
  // Indent by depth so the cascade is legible; capped so a deep node doesn't
  // push its own name off the edge on a narrow dialog.
  const indent = Math.min(depth, 4) * 14;

  const chevron =
    hasChildren && !searching ? (
      <button
        type="button"
        aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
        aria-expanded={expanded}
        onClick={onToggle}
        className="rounded p-0.5 text-text-3 transition-colors hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
    ) : (
      <span className="w-[18px] shrink-0" aria-hidden />
    );

  const label = (
    <>
      <span className={cn('truncate', selectable ? 'font-medium text-text' : 'text-text-2')}>
        {node.name}
      </span>
      <span className="shrink-0 text-[11px] uppercase tracking-wide text-text-3">
        {NODE_TYPE_LABEL[node.node_type]}
      </span>
    </>
  );

  const note =
    status.state === 'current'
      ? 'where it is now'
      : status.state === 'blocked'
        ? status.reason
        : null;

  // Every branch you can't pick says what is inside it, so an empty one is
  // skippable without opening it — and a childless one ("Tank 4", a quadrant with
  // no racks) doesn't read as though it might still hide something. Omitted only
  // while a branch is open, where the contents speak for themselves.
  const summary =
    !searching && status.state === 'context' && !(hasChildren && expanded)
      ? available > 0
        ? `${available} available`
        : 'none available'
      : null;

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 rounded pr-2',
        selectable && 'hover:bg-surface',
        selected && 'bg-accent-soft',
      )}
      style={{ paddingLeft: indent + 4 }}
    >
      {chevron}
      {selectable ? (
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          onClick={onSelect}
          title={`Relocate into ${node.name}`}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {selected ? (
            <Check size={13} className="shrink-0 text-accent" aria-hidden />
          ) : (
            <span className="w-3 shrink-0" aria-hidden />
          )}
          {label}
        </button>
      ) : (
        // Not a choice, so not a radio. Clicking still opens the branch, which is
        // the only thing this row can usefully do.
        <button
          type="button"
          onClick={hasChildren && !searching ? onToggle : undefined}
          disabled={!hasChildren || searching}
          title={note ?? undefined}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            (!hasChildren || searching) && 'cursor-default',
          )}
        >
          {status.state === 'blocked' ? (
            <Ban size={12} className="shrink-0 text-text-3/70" aria-hidden />
          ) : (
            <span className="w-3 shrink-0" aria-hidden />
          )}
          {label}
        </button>
      )}
      {note && <span className="shrink-0 text-[11px] text-text-3">{note}</span>}
      {summary && (
        <span className="shrink-0 text-[11px] tabular-nums text-text-3">{summary}</span>
      )}
    </div>
  );
}
