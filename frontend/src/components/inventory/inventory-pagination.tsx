'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useInventoryStore } from '@/stores/inventory.store';
import { PAGE_SIZE_OPTIONS } from '@/config/inventory';
import { cn } from '@/lib/utils';

interface Props {
  total: number;
  startIdx: number;
  rowsOnPage: number;
  pageCount: number;
}

export function InventoryPagination({ total, startIdx, rowsOnPage, pageCount }: Props) {
  const page = useInventoryStore((s) => s.page);
  const pageSize = useInventoryStore((s) => s.pageSize);
  const setPage = useInventoryStore((s) => s.setPage);
  const setPageSize = useInventoryStore((s) => s.setPageSize);

  const pages = React.useMemo(() => {
    if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
    const set = new Set<number>([1, pageCount, page, page - 1, page + 1]);
    if (page <= 3) [2, 3, 4].forEach((n) => set.add(n));
    if (page >= pageCount - 2) [pageCount - 1, pageCount - 2, pageCount - 3].forEach((n) => set.add(n));
    const ordered = [...set].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b);
    const out: Array<number | '…'> = [];
    ordered.forEach((p, i) => {
      const prev = ordered[i - 1];
      if (prev !== undefined && p - prev > 1) out.push('…');
      out.push(p);
    });
    return out;
  }, [pageCount, page]);

  return (
    <nav
      aria-label="Pagination"
      className="mt-3 flex flex-wrap items-center justify-between gap-3"
    >
      <div className="text-xs text-text-3">
        {total === 0 ? (
          'No items'
        ) : (
          <>
            Showing{' '}
            <strong className="text-text-2">
              {startIdx + 1}–{startIdx + rowsOnPage}
            </strong>{' '}
            of <strong className="text-text-2">{total.toLocaleString()}</strong> items
          </>
        )}
      </div>

      <div className="flex items-center gap-3">
        <label className="inline-flex items-center gap-2 text-xs text-text-3">
          Rows per page
          <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
            <SelectTrigger className="h-7 w-[78px] text-xs" aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <div className="inline-flex gap-1">
          <Button
            size="icon-sm"
            variant="default"
            onClick={() => setPage(Math.max(1, page - 1))}
            disabled={page === 1}
            aria-label="Previous page"
          >
            <ChevronLeft size={13} />
          </Button>
          {pages.map((p, i) =>
            p === '…' ? (
              <span
                key={`e${i}`}
                className="grid h-7 min-w-7 place-items-center text-xs text-text-3"
                aria-hidden
              >
                …
              </span>
            ) : (
              <button
                key={p}
                type="button"
                onClick={() => setPage(p)}
                aria-current={p === page ? 'page' : undefined}
                className={cn(
                  'h-7 min-w-7 rounded-md border px-2 text-xs font-medium transition-colors',
                  p === page
                    ? 'cursor-default border-text bg-text text-bg'
                    : 'border-border-strong bg-bg-elev text-text-2 hover:bg-surface',
                )}
              >
                {p}
              </button>
            ),
          )}
          <Button
            size="icon-sm"
            variant="default"
            onClick={() => setPage(Math.min(pageCount, page + 1))}
            disabled={page === pageCount}
            aria-label="Next page"
          >
            <ChevronRight size={13} />
          </Button>
        </div>
      </div>
    </nav>
  );
}
