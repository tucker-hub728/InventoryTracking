import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface Props {
  /** Placeholder rows to draw. */
  rows?: number;
  /** Cells per row. One cell flexes to fill, standing in for the name column. */
  columns?: number;
  /** Zero-based index of the cell that flexes (default 1, the second). */
  flexColumn?: number;
  className?: string;
  /** Announced to screen readers while the data is in flight. */
  label?: string;
}

/**
 * Row-shaped loading placeholder for a list or table panel.
 *
 * Deliberately generic: the detail tabs render their headers inside child
 * components, so an exact column-width match isn't reachable without threading
 * a ``loading`` prop through each one. This conveys "rows are coming" at the
 * right density instead. Where the header *is* to hand (the tier list pages),
 * skeleton cells go straight into the real table so the columns can't shift.
 */
export function TableSkeleton({
  rows = 6,
  columns = 5,
  flexColumn = 1,
  className,
  label = 'Loading…',
}: Props) {
  return (
    <div className={cn('divide-y divide-border', className)}>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-4 py-3.5">
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton
              key={c}
              className={cn('h-4', c === flexColumn ? 'flex-1' : 'w-20 shrink-0')}
            />
          ))}
        </div>
      ))}
      <span className="sr-only" role="status">
        {label}
      </span>
    </div>
  );
}
