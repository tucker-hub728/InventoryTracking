'use client';

import * as React from 'react';
import { Download } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { ApiError } from '@/lib/api/client';
import { exportsApi } from '@/lib/api/exports';
import { kitsApi, type ApiKitListItem } from '@/lib/api/kits';
import { saveBlob, timestampedFilename } from '@/lib/download';

const ALL_KITS = '__all__';

/**
 * The kit-cost CSV download (RPT-003).
 *
 * The client did not want a report — *"a data dump of all the information
 * captured over a date range into a .CSV file"* — so this offers **scope
 * only**: which kit, which dates. Never how much.
 *
 * There used to be an "Include" picker offering three detail levels, and it
 * defaulted to the narrowest of them: two of the six row kinds. So the button
 * most people pressed quietly produced the *least* data, which is the opposite
 * of what was asked for (2026-09-03) —
 *
 *     "we just need all raw data, we don't need Include […] since the client
 *     wants every raw detail, so we are going to give that"
 *
 * The endpoint still accepts ``row_kinds`` for a caller that wants a subset;
 * omitting it means all six, so this component simply never sends it.
 *
 * ``kitId`` pins it to one kit and hides the picker, so the button on a kit's
 * own page exports that kit the way the inventory Export button exports the
 * tier you are looking at.
 */
export function KitCostExportButton({
  kitId,
  kitNumber,
  label = 'Export costs',
}: {
  /** Pin to one kit — the picker is hidden and this is always the scope. */
  kitId?: string;
  kitNumber?: string;
  label?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const today = React.useMemo(() => new Date(), []);
  const [from, setFrom] = React.useState(() => isoDate(addDays(today, -30)));
  const [to, setTo] = React.useState(() => isoDate(today));
  const [pickedKit, setPickedKit] = React.useState(ALL_KITS);
  const [kits, setKits] = React.useState<ApiKitListItem[]>([]);

  // Only when the picker is actually shown, and only once it is opened — the
  // kit list is a page-sized request and most exports never touch it.
  React.useEffect(() => {
    if (kitId || !open || kits.length > 0) return;
    const ctrl = new AbortController();
    void kitsApi
      .list({ limit: 200 }, { signal: ctrl.signal })
      .then((r) => setKits(r.items))
      .catch(() => setKits([]));
    return () => ctrl.abort();
  }, [kitId, open, kits.length]);

  const kitOptions = React.useMemo(
    () => [
      { value: ALL_KITS, label: 'All kits', searchText: 'all kits' },
      ...kits.map((k) => ({
        value: k.id,
        label: `${k.kit_number} · ${k.item_number}`,
        // The description too, so "buffer" finds the kit without knowing its
        // number — the operator remembers what they built, not KIT-0289.
        searchText: `${k.kit_number} ${k.item_number} ${k.description ?? ''}`,
      })),
    ],
    [kits],
  );

  const scopedKitId = kitId ?? (pickedKit === ALL_KITS ? undefined : pickedKit);

  async function run() {
    setBusy(true);
    try {
      const { blob, filename } = await exportsApi.kitCostsCsv({
        occurredFrom: from ? `${from}T00:00:00` : undefined,
        // The range is HALF-OPEN server-side, so the chosen end date goes as the
        // start of the NEXT day. Sending `${to}T00:00:00` would silently drop
        // everything that happened on the day the user picked — the same
        // conversion the audit filters make.
        occurredTo: to ? `${isoDate(addDays(new Date(`${to}T00:00:00`), 1))}T00:00:00` : undefined,
        kitId: scopedKitId,
        // No ``rowKinds``: the endpoint defaults to all six. Every issue,
        // every return, every component's contribution, every finished lot,
        // every shipment, and the per-kit totals.
      });
      const name = filename ?? timestampedFilename('cellready-kit-costs', 'csv');
      saveBlob(blob, name);
      toast.success('Cost export downloaded', { description: name });
      setOpen(false);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Failed to export. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="secondary">
          <Download size={14} /> {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3">
        <p className="text-sm font-medium text-text">Export material cost</p>
        <p className="mt-0.5 text-[11px] text-text-3">
          {kitNumber
            ? `What ${kitNumber} cost to build, as a spreadsheet.`
            : 'What each finished lot cost to build, as a spreadsheet.'}
        </p>

        {!kitId && (
          <label className="mt-3 block">
            <span className="text-[11px] uppercase tracking-wider text-text-3">Kit</span>
            <SearchableSelect
              options={kitOptions}
              value={pickedKit}
              onChange={setPickedKit}
              placeholder="All kits"
              searchPlaceholder="Search kit or item…"
              aria-label="Kit to export"
              modal
            />
          </label>
        )}

        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-text-3">From</span>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-text-3">To</span>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>

        <p className="mt-3 text-[11px] text-text-3">
          Every row captured in this range: material issues and returns, what each
          component contributed, finished lots, shipments, and a total per kit.
        </p>

        <Button
          variant="primary"
          className="mt-3 w-full"
          disabled={busy || !from || !to || from > to}
          onClick={() => void run()}
        >
          {busy ? 'Preparing…' : 'Download spreadsheet'}
        </Button>
        {from > to && (
          <p className="mt-1 text-[11px] text-danger">The From date must come first.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** ``YYYY-MM-DD`` in LOCAL time — matches what `<input type="date">` reads and
 *  writes. `toISOString()` would shift the day for anyone west of UTC. */
function isoDate(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}
