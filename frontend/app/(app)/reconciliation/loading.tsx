import { PageHeader } from '@/components/shared/page-header';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const COLS = ['Kit', 'Building', 'Status', 'Built vs target', 'Scrapped', 'Production location', 'Stock the output to', 'Opened', ''];

/**
 * Instant loading UI for the Kitting list — streamed during navigation into
 * `/reconciliation` so the table appears as a skeleton immediately instead of a
 * blank page while the kits are fetched.
 */
export default function KittingLoading() {
  return (
    <>
      <PageHeader
        title="Kitting"
        subtitle="Gather material for a build, issue it to production, then reconcile what was actually used and back-flush the rest."
      />

      <div className="px-6 py-5 sm:px-8">
        {/* Search + filter bar */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Skeleton className="h-9 w-full max-w-xs" />
          <Skeleton className="h-9 w-48" />
        </div>

        <Card className="p-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-3">
                  {COLS.map((c, i) => (
                    <th key={i} className="px-3 py-2 font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 10 }).map((_, i) => (
                  <tr key={i} className="border-b border-border/60">
                    <td className="px-3 py-3"><Skeleton className="h-3.5 w-16" /></td>
                    <td className="px-3 py-3"><Skeleton className="h-3.5 w-28" /></td>
                    <td className="px-3 py-3"><Skeleton className="h-5 w-24 rounded-full" /></td>
                    <td className="px-3 py-3"><Skeleton className="h-3.5 w-20" /></td>
                    <td className="px-3 py-3"><Skeleton className="ml-auto h-3.5 w-8" /></td>
                    <td className="px-3 py-3"><Skeleton className="h-3.5 w-32" /></td>
                    <td className="px-3 py-3"><Skeleton className="h-3.5 w-32" /></td>
                    <td className="px-3 py-3"><Skeleton className="h-3.5 w-16" /></td>
                    <td className="px-3 py-3"><Skeleton className="ml-auto h-4 w-4" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
