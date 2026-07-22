import { PageHeader } from '@/components/shared/page-header';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Instant loading UI for a kit while its data is fetched — shown during the
 * navigation into `/reconciliation/[id]` (App Router streams this until the
 * page is ready), so clicking a kit feels immediate instead of frozen.
 */
export default function KitDetailLoading() {
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Kitting', href: '/reconciliation' }]}
        title="Loading kit…"
      />
      <div className="space-y-4 px-6 py-5 sm:px-8">
        {/* Stepper */}
        <Card className="flex items-center gap-6 p-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-1 items-center gap-3">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-2.5 w-28" />
              </div>
            </div>
          ))}
        </Card>

        {/* Stat row */}
        <div className="grid gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="space-y-2 p-4">
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-6 w-12" />
            </Card>
          ))}
        </div>

        {/* Table */}
        <Card className="space-y-3 p-4">
          <Skeleton className="h-4 w-32" />
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-10" />
              <Skeleton className="h-4 w-10" />
              <Skeleton className="h-4 w-40" />
            </div>
          ))}
        </Card>
      </div>
    </>
  );
}
