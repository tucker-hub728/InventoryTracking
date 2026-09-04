import { type ReactNode } from 'react';
import type { Metadata } from 'next';

import { KitDetailClient } from '@/components/reconciliation/kit-detail-client';

interface LayoutProps {
  children: ReactNode;
  params: Promise<{ id: string }>;
}

// The route segment is the kit's UUID, meaningless as a tab title — the shell
// renders the real kit number in the page header once it loads.
export function generateMetadata(): Metadata {
  return { title: 'Kit · Kitting' };
}

/**
 * The kit wizard lives in the LAYOUT, and the step segments are its state.
 *
 * Same shape as ``inventory/[id]/layout.tsx``: a shell in the layout so it
 * survives navigation between segments, thin pages underneath. The one
 * difference is that the shell here renders the step content itself rather than
 * through ``children``, and that difference is load-bearing.
 *
 * The four steps are not independent views. They share one mutable draft — the
 * batch quantities, the material used per component, the output destinations,
 * the live lot-number check — which the operator builds up across steps and
 * which must not reset when they step back to check something. A layout keeps
 * its state across child navigations; a page does not. Rendering the steps from
 * the page would put that draft in the page and lose it on every step change,
 * so the pages are route markers and the shell reads the segment to know which
 * step is showing.
 */
export default async function KitDetailLayout(props: LayoutProps) {
  const params = await props.params;
  return (
    <KitDetailClient kitId={params.id}>{props.children}</KitDetailClient>
  );
}
