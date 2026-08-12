'use client';

/**
 * "This room is being replaced" — the page-level half of the Deprecated tag.
 *
 * The sidebar pill says a room is on its way out; this says what replaces it and
 * where to go instead. Both are signposts only: Materials Management, Cold
 * Storage and the Analytical Lab are still in daily use and nothing inside them
 * changes (client, 2026-08-12). Deliberately not a warning tone — nothing is
 * wrong, and an alarm on a page someone uses every day is noise by the second
 * day.
 *
 * Dismissal is per-room and sticky, because the notice has nothing new to say on
 * the fiftieth visit. It is read in an EFFECT rather than during render: reading
 * ``localStorage`` while rendering makes the server and client disagree on the
 * first paint and React discards the tree. That costs one frame in which the
 * banner is hidden, which is the right way round — flashing it at someone who
 * dismissed it a month ago is worse than showing it a frame late.
 */

import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, Info, X } from 'lucide-react';

import { Button } from '@/components/ui/button';

const STORAGE_KEY_PREFIX = 'ims:deprecated-notice:';

export function DeprecationNotice({
  /** Stable id for the dismissal, per room — "cold-storage". */
  id,
  /** What replaces it, and where. */
  replacedBy = { label: 'Storage', href: '/storage' },
  children,
}: {
  id: string;
  replacedBy?: { label: string; href: string };
  children?: React.ReactNode;
}) {
  // Starts hidden; the effect below reveals it if it hasn't been dismissed.
  const [show, setShow] = React.useState(false);

  React.useEffect(() => {
    try {
      setShow(window.localStorage.getItem(`${STORAGE_KEY_PREFIX}${id}`) !== 'dismissed');
    } catch {
      // Private mode / storage disabled — show it rather than swallow it.
      setShow(true);
    }
  }, [id]);

  const dismiss = () => {
    setShow(false);
    try {
      window.localStorage.setItem(`${STORAGE_KEY_PREFIX}${id}`, 'dismissed');
    } catch {
      // Dismissal just won't stick. Not worth surfacing.
    }
  };

  if (!show) return null;

  return (
    <div className="border-b border-border bg-surface-2/60 px-6 py-2.5 sm:px-8">
      <div className="flex items-start gap-2.5">
        <Info size={15} className="mt-0.5 shrink-0 text-text-3" aria-hidden />
        <p className="flex-1 text-xs text-text-2">
          {children ?? (
            <>
              This area is being replaced by {replacedBy.label}. Everything here still
              works — new locations are set up in {replacedBy.label}.
            </>
          )}{' '}
          <Link
            href={replacedBy.href}
            className="inline-flex items-center gap-0.5 text-accent underline-offset-2 hover:underline"
          >
            Open {replacedBy.label}
            <ArrowRight size={12} aria-hidden />
          </Link>
        </p>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={dismiss}
          aria-label="Dismiss"
          className="-my-1 shrink-0"
        >
          <X size={14} />
        </Button>
      </div>
    </div>
  );
}
