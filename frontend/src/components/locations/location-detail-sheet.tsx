'use client';

import * as React from 'react';
import Link from 'next/link';
import { MapPin } from 'lucide-react';

import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError } from '@/lib/api/client';
import {
  locationsApi,
  type ApiLocationContentRow,
  type ApiLocationOverview,
} from '@/lib/api/locations';
import { toNum } from '@/lib/api/helpers';

interface Props {
  /** The location whose card was opened; null closes the sheet. */
  location: ApiLocationOverview | null;
  onOpenChange: (open: boolean) => void;
}

export function LocationDetailSheet({ location, onOpenChange }: Props) {
  const [rows, setRows] = React.useState<ApiLocationContentRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!location) {
      setRows([]);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    locationsApi
      .contents(location.id, { signal: ctrl.signal })
      .then((res) => setRows(res.rows))
      .catch((err) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Failed to load contents.');
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [location]);

  return (
    <Sheet open={location !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>{location?.location_name ?? 'Location'}</SheetTitle>
          <SheetDescription>{location?.location_type ?? ''}</SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-6">
          {location && (
            <>
              <dl className="grid grid-cols-3 gap-4 text-sm">
                <Field label="Status">
                  <Badge tone={location.is_active ? 'success' : 'neutral'} dot>
                    {location.is_active ? 'Active' : 'Inactive'}
                  </Badge>
                </Field>
                <Field label="On-hand">{toNum(location.on_hand).toLocaleString()}</Field>
                <Field label="Distinct lots">{location.distinct_lots}</Field>
              </dl>

              {location.children.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold">Sub-locations</h3>
                  <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                    {location.children.map((shelf) => (
                      <div
                        key={shelf.id}
                        className="flex items-center justify-between px-3 py-2 text-sm"
                      >
                        <span className="inline-flex items-center gap-2">
                          <MapPin size={13} className="text-text-3" />
                          {shelf.location_name}
                        </span>
                        <span className="text-xs tabular-nums text-text-3">
                          {toNum(shelf.on_hand).toLocaleString()} · {shelf.distinct_lots} lots
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <h3 className="mb-2 text-sm font-semibold">Stored items &amp; lots</h3>
                {loading ? (
                  <div className="py-10 text-center text-sm text-text-3">Loading…</div>
                ) : error ? (
                  <div className="py-10 text-center text-sm text-danger">{error}</div>
                ) : rows.length === 0 ? (
                  <div className="rounded-lg border border-border py-10 text-center text-sm text-text-3">
                    Nothing stored here yet.
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-lg border border-border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Item</TableHead>
                          <TableHead>Location</TableHead>
                          <TableHead>Lot</TableHead>
                          <TableHead className="text-right">Qty</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map((r, i) => (
                          <TableRow key={`${r.location_id}-${r.item_id}-${r.lot_number ?? 'nolot'}-${i}`}>
                            <TableCell>
                              <Link
                                href={`/inventory/cr/${r.item_id}`}
                                className="font-mono text-xs text-accent hover:underline"
                              >
                                {r.item_code}
                              </Link>
                              <div className="text-xs text-text-3">{r.item_name}</div>
                            </TableCell>
                            <TableCell className="text-text-2">{r.location_name}</TableCell>
                            <TableCell className="font-mono text-xs">
                              {r.lot_number ?? <span className="text-text-3">—</span>}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {toNum(r.quantity_available).toLocaleString()}{' '}
                              <span className="text-text-3">{r.unit_of_measure}</span>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-text-3">{label}</dt>
      <dd className="mt-1 text-text">{children}</dd>
    </div>
  );
}
