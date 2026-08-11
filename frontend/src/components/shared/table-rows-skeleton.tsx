import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export interface SkeletonColumn {
  /** Tailwind width class for the bar, e.g. ``'w-32'``. Sized to the real
   *  content so the placeholder reads as that column, not a generic block. */
  width?: string;
  /** Right-align, for a numeric or actions column. */
  align?: 'left' | 'right';
  /** Draw a pill instead of a bar — stands in for a badge. */
  pill?: boolean;
  /** A second, shorter bar underneath, for a two-line cell. */
  subWidth?: string;
}

interface Props {
  columns: readonly SkeletonColumn[];
  /** Placeholder rows to draw. */
  rows?: number;
  /** Cell padding, so the placeholder matches whichever table it sits in.
   *  Defaults to ``ui/table``'s ``TableCell``. */
  cellClassName?: string;
  /** Announced to screen readers while the data is in flight. */
  label?: string;
}

/**
 * Skeleton rows for the inside of a real ``<tbody>``.
 *
 * The point of putting them *inside* the actual table, rather than swapping the
 * whole table for a placeholder block, is that the header and the column widths
 * are the real ones — so nothing shifts sideways when the data lands. Same
 * approach the tier lists and the reconciliation table already use; this pulls
 * it into one component so every paged table gets the same density and the
 * widths stay declared next to the columns they stand for.
 *
 * Renders bare ``<tr>``/``<td>``, which is valid inside both ``ui/table``'s
 * ``TableBody`` and a plain ``<tbody>`` — the two kinds of table in this app.
 */
export function TableRowsSkeleton({
  columns,
  rows = 8,
  cellClassName = 'border-b border-border px-3.5 py-3 align-middle',
  label = 'Loading…',
}: Props) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r}>
          {columns.map((col, c) => (
            <td key={c} className={cellClassName}>
              <div className={cn('flex flex-col gap-1.5', col.align === 'right' && 'items-end')}>
                <Skeleton
                  className={cn(
                    col.pill ? 'h-5 rounded-full' : 'h-3.5',
                    col.width ?? 'w-24',
                  )}
                />
                {col.subWidth && <Skeleton className={cn('h-2.5', col.subWidth)} />}
              </div>
            </td>
          ))}
        </tr>
      ))}
      <tr>
        <td colSpan={columns.length}>
          <span className="sr-only" role="status">
            {label}
          </span>
        </td>
      </tr>
    </>
  );
}
