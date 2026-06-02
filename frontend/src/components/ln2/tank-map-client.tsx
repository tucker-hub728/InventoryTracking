'use client';

import * as React from 'react';
import { Download, Plus, Search, Snowflake } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { usePermission } from '@/hooks/use-permission';
import { toast } from '@/components/ui/sonner';
import {
  LN2_TANKS,
  LN2_RACKS_PER_TANK,
  POSITION_TONE,
  buildLN2Map,
  type LN2Map,
  type LN2Tank,
  type PositionInfo,
} from './ln2-data';
import { RackTile } from './rack-tile';
import { PositionSheet } from './position-sheet';

export function TankMapClient() {
  const base = React.useMemo(buildLN2Map, []);
  // Local overrides for demo edits. Each entry replaces the deterministic
  // value for that key; a real app would push these to /positions/{id}.
  const [overrides, setOverrides] = React.useState<Record<string, PositionInfo>>({});
  const map: LN2Map = React.useMemo(
    () => (Object.keys(overrides).length ? { ...base, ...overrides } : base),
    [base, overrides],
  );
  const [tank, setTank] = React.useState<LN2Tank>('A');
  const [openPos, setOpenPos] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const debounced = useDebouncedValue(query, 150);
  const canEdit = usePermission('inventory', 'edit');

  const updatePosition = React.useCallback(
    (key: string, patch: Partial<PositionInfo>) => {
      setOverrides((prev) => {
        const current = prev[key] ?? base[key];
        if (!current) return prev;
        return { ...prev, [key]: { ...current, ...patch } };
      });
    },
    [base],
  );

  const tankStats = React.useMemo(() => {
    const stats: Record<LN2Tank, { total: number; occupied: number; reserved: number; quarantine: number; empty: number }> = {
      A: { total: 0, occupied: 0, reserved: 0, quarantine: 0, empty: 0 },
      B: { total: 0, occupied: 0, reserved: 0, quarantine: 0, empty: 0 },
      C: { total: 0, occupied: 0, reserved: 0, quarantine: 0, empty: 0 },
    };
    for (const k of Object.keys(map)) {
      const tankId = k.split('-')[1] as LN2Tank;
      const info = map[k]!;
      stats[tankId].total += 1;
      if (info.status === 'Occupied') stats[tankId].occupied += 1;
      else if (info.status === 'Reserved') stats[tankId].reserved += 1;
      else if (info.status === 'Quarantine') stats[tankId].quarantine += 1;
      else stats[tankId].empty += 1;
    }
    return stats;
  }, [map]);

  const matched = React.useMemo(() => {
    const result = new Set<string>();
    const q = debounced.trim().toLowerCase();
    if (!q) return result;
    for (const k of Object.keys(map)) {
      const info = map[k]!;
      if (k.toLowerCase().includes(q)) result.add(k);
      else if (
        info.item &&
        `${info.item.id} ${info.item.desc} ${info.lot ?? ''}`.toLowerCase().includes(q)
      )
        result.add(k);
    }
    return result;
  }, [map, debounced]);

  const stats = tankStats[tank];

  return (
    <>
      <PageHeader
        title="LN2 Tanks"
        subtitle={`Cryogenic position management · ${Object.keys(map).length} positions across ${LN2_TANKS.length} tanks`}
        actions={
          <>
            <Button onClick={() => toast.info('Export queued')}>
              <Download size={14} /> Export map
            </Button>
            {canEdit && (
              <Button variant="primary">
                <Plus size={14} /> Assign position
              </Button>
            )}
          </>
        }
      />

      <div className="px-6 py-5 sm:px-8">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Tabs value={tank} onValueChange={(v) => setTank(v as LN2Tank)}>
            <TabsList className="border-b-0">
              {LN2_TANKS.map((t) => (
                <TabsTrigger key={t} value={t} className="gap-2">
                  <Snowflake size={12} aria-hidden />
                  Tank {t}
                  <span className="font-mono text-[10px] text-text-3">
                    {tankStats[t].occupied}/{tankStats[t].total}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Input
            icon={Search}
            placeholder="Search position, item, or lot…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            wrapperClassName="w-[280px]"
            aria-label="Search positions"
          />
          {matched.size > 0 && (
            <div className="text-xs text-text-2">
              <span className="font-medium text-accent">{matched.size}</span>{' '}
              match{matched.size === 1 ? '' : 'es'}
            </div>
          )}
        </div>

        <ul className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat label="Capacity" value={stats.total} />
          <Stat label="Occupied" value={stats.occupied} variant="accent" />
          <Stat label="Reserved" value={stats.reserved} variant="warning" />
          <Stat label="Quarantine" value={stats.quarantine} variant="danger" />
          <Stat label="Empty" value={stats.empty} variant="muted" />
        </ul>

        <div className="mb-3 flex flex-wrap gap-4 text-[11px] text-text-2">
          {(['Occupied', 'Reserved', 'Quarantine', 'Empty'] as const).map((s) => (
            <div key={s} className="inline-flex items-center gap-1.5">
              <span className={cn('size-2.5 rounded-sm', POSITION_TONE[s].legend)} aria-hidden />
              {s}
            </div>
          ))}
        </div>

        <Card className="p-4 sm:p-5">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: LN2_RACKS_PER_TANK }).map((_, i) => (
              <RackTile
                key={i + 1}
                tank={tank}
                rackNum={i + 1}
                map={map}
                highlight={matched}
                onSelect={setOpenPos}
              />
            ))}
          </div>
        </Card>
      </div>

      <PositionSheet
        posKey={openPos}
        map={map}
        onClose={() => setOpenPos(null)}
        onUpdate={updatePosition}
      />
    </>
  );
}

function Stat({
  label,
  value,
  variant = 'default',
}: {
  label: string;
  value: number;
  variant?: 'default' | 'accent' | 'warning' | 'danger' | 'muted';
}) {
  return (
    <li className="rounded-md border border-border bg-bg-elev p-3 shadow-elev-sm">
      <div className="text-[11px] font-medium uppercase tracking-wider text-text-3">{label}</div>
      <div
        className={cn(
          'mt-1 font-mono text-xl font-semibold leading-none tracking-tight',
          variant === 'accent' && 'text-accent',
          variant === 'warning' && 'text-warning',
          variant === 'danger' && 'text-danger',
          variant === 'muted' && 'text-text-3',
        )}
      >
        {value}
      </div>
    </li>
  );
}
