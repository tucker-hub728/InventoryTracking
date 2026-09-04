'use client';

import * as React from 'react';
import { PackageCheck, ShoppingCart } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { RouteTabs, type RouteTab } from '@/components/shared/route-tabs';

export const PLANNING_TABS = {
  order: '/planning/order',
  on_order: '/planning/on-order',
  awaiting: '/planning/awaiting',
} as const;

interface PlanningShellContext {
  /** Reported by whichever tab just fetched — every response carries all three
   *  totals, so the tab strip can label the tabs you are not on without extra
   *  requests. */
  setTotals: (totals: { order: number; onOrder: number; awaiting: number }) => void;
}

const Ctx = React.createContext<PlanningShellContext>({ setTotals: () => {} });

export const usePlanningShell = (): PlanningShellContext => React.useContext(Ctx);

/**
 * Chrome shared by the two Reorder tabs, which are two routes rather than two
 * panels (the house pattern — see ``RouteTabs``).
 *
 * Routes rather than local state for the usual reason: a tab held in component
 * state has no address, so a refresh drops you back on the first one and there
 * is no link to send a colleague. It also gives each tab its own query string,
 * which matters here — the two lists page independently and would otherwise
 * fight over one ``?page=``.
 *
 * The counts come from the child rather than being fetched here. Every reorder
 * response already carries both totals, so a fetch in the shell would be a
 * second identical round trip whose answer could disagree with the rows on
 * screen.
 */
export function PlanningShell({ children }: { children: React.ReactNode }) {
  const [totals, setTotals] = React.useState<{
    order: number;
    onOrder: number;
    awaiting: number;
  } | null>(null);

  const ctx = React.useMemo<PlanningShellContext>(
    () => ({ setTotals: (t) => setTotals(t) }),
    [],
  );

  const tabs: readonly RouteTab[] = React.useMemo(
    () => [
      // Both labels are the action, phrased the same way, so the pair reads as
      // one choice rather than two unrelated headings. "To receive" is the
      // project's name for this step everywhere — the requirement, the
      // /receive-to-inventory endpoint and the dialog all use it.
      {
        href: PLANNING_TABS.order,
        label: 'To order',
        // Undefined until the first response — a "0" that turns into "12" a
        // moment later reads as a bug.
        count: totals?.order,
      },
      {
        // The middle stage. Its whole job is to stop an item that is already
        // bought from sitting under a heading that says buy it.
        href: PLANNING_TABS.on_order,
        label: 'On order',
        count: totals?.onOrder,
      },
      {
        href: PLANNING_TABS.awaiting,
        label: 'To receive',
        count: totals?.awaiting,
      },
    ],
    [totals],
  );

  return (
    <Ctx.Provider value={ctx}>
      <PageHeader
        title="Reorder"
        crumbs={[{ label: 'Reorder' }]}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-3">
            <span className="flex items-center gap-1.5">
              <ShoppingCart size={13} className="text-warning" />
              Items at or below their reorder threshold
            </span>
            {/* Only mentioned once something is actually waiting — a permanent
                "0 awaiting release" would be noise on most days. */}
            {totals !== null && totals.awaiting > 0 && (
              <span className="flex items-center gap-1.5 text-accent">
                <PackageCheck size={13} />
                {totals.awaiting.toLocaleString()} already on site
              </span>
            )}
          </span>
        }
      />
      <div className="px-6 pt-4 sm:px-8">
        <RouteTabs tabs={tabs} label="Reorder groups" />
      </div>
      {children}
    </Ctx.Provider>
  );
}
