'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * Client-side pagination hook. Slices ``items`` into pages of ``pageSize`` and
 * keeps the current page in range as the list shrinks/grows.
 */
export function usePagination<T>(items: T[], pageSize = 10) {
  const [page, setPage] = React.useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));

  // Clamp when the underlying list changes (e.g. a row is removed/filtered).
  React.useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);

  return {
    page: safePage,
    setPage,
    pageCount,
    pageItems,
    total: items.length,
    rangeStart: items.length === 0 ? 0 : start + 1,
    rangeEnd: Math.min(start + pageSize, items.length),
  };
}

interface PaginationProps {
  page: number;
  pageCount: number;
  total: number;
  rangeStart: number;
  rangeEnd: number;
  onPageChange: (page: number) => void;
  /** Item noun for the summary, e.g. "member" -> "1–10 of 12 members". */
  noun?: string;
}

/** Prev/next pager with a "showing X–Y of Z" summary. Hidden when a single page. */
export function Pagination({
  page,
  pageCount,
  total,
  rangeStart,
  rangeEnd,
  onPageChange,
  noun = 'row',
}: PaginationProps) {
  if (pageCount <= 1) return null;
  const plural = total === 1 ? noun : `${noun}s`;

  return (
    <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs text-text-3">
      <span>
        {rangeStart}–{rangeEnd} of {total} {plural}
      </span>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft size={15} />
        </Button>
        <span className="px-1 tabular-nums text-text-2">
          {page} / {pageCount}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Next page"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight size={15} />
        </Button>
      </div>
    </div>
  );
}
