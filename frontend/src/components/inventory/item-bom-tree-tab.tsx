'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { useMinDuration } from '@/hooks/use-min-duration';
import { EmptyState } from '@/components/shared/empty-state';
import { TableSkeleton } from '@/components/shared/table-skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import { bomApi, type ApiBomLine } from '@/lib/api/bom';
import { TIER_TYPE_LABELS } from '@/lib/api/tiers';
import { ApiError } from '@/lib/api/client';
import { cn, formatNumber } from '@/lib/utils';
import type { BadgeTone } from '@/types/ui';
import type { InventoryStatus } from '@/types/inventory';

interface Props {
  itemId: string;
  itemNumber: string;
}

/**
 * Structure tab — the full multi-level BOM hierarchy for a Product, read-only
 * (the editor lives on the BOM tab). The whole tree is fetched in one nested
 * call (`?nested=true`) and rendered fully expanded, so the entire hierarchy is
 * visible on load; every line shows the child's tier, qty/unit, in-stock and
 * stock status, and sub-assemblies can still be collapsed by hand.
 */
export function ItemBomTreeTab({ itemId, itemNumber }: Props) {
  const [lines, setLines] = React.useState<ApiBomLine[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Held briefly — the fetch returns in ~20ms, too fast to see otherwise.
  const showSkeleton = useMinDuration(loading);

  React.useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    bomApi
      .forItem(itemId, { signal: ctrl.signal, nested: true })
      .then((bom) => {
        setLines(bom.lines);
      })
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Failed to load structure.');
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [itemId]);

  if (error) return <EmptyState title="Couldn't load structure" hint={error} />;
  if (showSkeleton) {
    return <TableSkeleton rows={5} columns={4} label="Loading structure…" />;
  }
  if (lines.length === 0) {
    return (
      <EmptyState
        title="No bill of materials yet"
        hint="Add components and sub-assemblies on the BOM tab to define this Product's structure."
      />
    );
  }

  return (
    <div className="space-y-3 p-4">
      <h3 className="text-sm font-semibold">{itemNumber} · structure</h3>

      {/* Column header — mirrors the BomNode row's right-aligned columns so
          labels line up: Qty / run, Available, Stock status. */}
      <div className="flex items-center gap-2 pr-2 text-[11px] uppercase tracking-wider text-text-3">
        <span className="flex-1">Item #</span>
        <span className="w-20 text-right">qty / run</span>
        <span className="w-20 text-right">available</span>
        <span className="w-28 text-right">stock status</span>
      </div>

      <ul className="space-y-0.5">
        {lines.map((l) => (
          <BomNode key={l.id} line={l} depth={0} />
        ))}
      </ul>
    </div>
  );
}

/** One tree row. Children arrive embedded in the nested payload, so the whole
 *  subtree is present up front and rendered open by default; the caret just
 *  collapses/expands what's already loaded. */
function BomNode({ line, depth }: { line: ApiBomLine; depth: number }) {
  const children = line.children ?? [];
  const hasChildren = line.child_has_bom && children.length > 0;
  // Open by default so the entire hierarchy shows on load.
  const [expanded, setExpanded] = React.useState(true);
  const toggle = () => setExpanded((e) => !e);

  // Stock status badge = the child's REAL stock status (same value the
  // inventory list shows) — for every tier, sub-assemblies included, since
  // those are stockable (REQ-2026-07-01-INV-003).
  const status: InventoryStatus =
    line.child_status_code === 'available'
      ? 'Available'
      : line.child_status_code === 'low_stock'
        ? 'Low stock'
        : 'Out of stock';

  return (
    <li>
      <div
        className="flex items-center gap-2 rounded-md py-1.5 pr-2 text-sm"
        style={{ paddingLeft: `${depth * 18 + 8}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={toggle}
            className="text-text-3 hover:text-text"
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="inline-block w-[14px]" aria-hidden />
        )}

        <span
          aria-hidden
          className={cn('size-2 shrink-0 rounded-full', dotClass(line.child_tier_tone))}
        />

        <span className="min-w-0 flex-1 truncate">
          <Link
            href={`/inventory/${line.child_item_number}/ledger`}
            className="font-mono text-xs text-accent hover:underline"
          >
            {line.child_item_number}
          </Link>{' '}
          <span className="text-text">{line.child_description}</span>
          <span className="ml-1.5 text-[10px] uppercase tracking-wide text-text-3">
            {TIER_TYPE_LABELS[line.child_tier_type]}
          </span>
        </span>

        <span className="w-20 text-right font-mono text-xs text-text-2">
          ×{formatNumber(Number(line.qty_per_unit))}
        </span>
        {/* Shown for every component, sub-assemblies included: a sub-assembly
            "shall itself be stockable as inventory" (REQ-2026-07-01-INV-003),
            so it has a real on-hand balance that kitting reads. */}
        <span className="w-20 text-right font-mono text-xs text-text-2">
          {formatNumber(Number(line.child_qty_available))}
        </span>
        <span className="flex w-28 justify-end">
          <StatusBadge status={status} />
        </span>
      </div>

      {expanded && hasChildren && (
        <ul className="space-y-0.5">
          {children.map((c) => (
            <BomNode key={c.id} line={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

function dotClass(tone: string): string {
  const t = tone as BadgeTone;
  switch (t) {
    case 'accent':
      return 'bg-accent';
    case 'success':
      return 'bg-success';
    case 'warning':
      return 'bg-warning';
    case 'danger':
      return 'bg-danger';
    default:
      return 'bg-text-3';
  }
}
