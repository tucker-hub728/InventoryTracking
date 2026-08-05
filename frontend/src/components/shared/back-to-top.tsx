'use client';

import * as React from 'react';
import { ArrowUp } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Return to the top of a long page (REQ-2026-07-15-UI-002 — "long location and
 * inventory lists shall remain navigable without excessive scrolling").
 *
 * Appears only once there is enough scrolled past to be worth undoing, so it
 * never covers content on a page that fits. Sits above the content but below
 * dialogs (z-30), and clears the bottom-right corner where row actions live.
 */
export function BackToTop({ showAfter = 600 }: { showAfter?: number }) {
  const [show, setShow] = React.useState(false);

  React.useEffect(() => {
    const onScroll = () => setShow(window.scrollY > showAfter);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [showAfter]);

  return (
    <button
      type="button"
      aria-hidden={!show}
      tabIndex={show ? 0 : -1}
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      className={cn(
        'fixed bottom-5 right-5 z-30 inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-elev px-3.5 py-2 text-xs font-medium text-text-2 shadow-elev-sm transition-all hover:border-accent/50 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        show ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0',
      )}
    >
      <ArrowUp size={14} aria-hidden /> Top
    </button>
  );
}
