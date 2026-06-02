'use client';

import * as React from 'react';
import {
  Boxes,
  FlaskConical,
  Plus,
  Refrigerator,
  Search,
  Snowflake,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { usePermission } from '@/hooks/use-permission';
import type { LocationKind } from '@/lib/api/locations';
import { useLN2Store } from '@/stores/ln2.store';
import { POSITION_TONE, computeStats } from './ln2-data';
import { RackTile } from './rack-tile';
import { PositionSheet, type PositionSelection } from './position-sheet';
import { LocationAddDialog } from './location-add-dialog';

/** Icon per location kind — keeps the switcher readable at a glance. */
const KIND_ICON: Record<LocationKind, LucideIcon> = {
  LN2: Snowflake,
  minus_80: Snowflake,
  minus_20: Snowflake,
  fridge: Refrigerator,
  cold_room: Refrigerator,
  room_temp: FlaskConical,
  incubator: FlaskConical,
  other: Boxes,
};

export function TankMapClient() {
  const locations = useLN2Store((s) => s.locations);
  const updatePosition = useLN2Store((s) => s.updatePosition);

  const [activeId, setActiveId] = React.useState<string>(locations[0]?.id ?? '');
  const [selected, setSelected] = React.useState<{ rackKey: string; positionId: string } | null>(
    null,
  );
  const [addOpen, setAddOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const debounced = useDebouncedValue(query, 150);
  const canEdit = usePermission('inventory', 'edit');

  // Keep the active tab valid as locations are added/removed.
  const activeLoc = locations.find((l) => l.id === activeId) ?? locations[0];
  React.useEffect(() => {
    if (activeLoc && activeLoc.id !== activeId) setActiveId(activeLoc.id);
  }, [activeLoc, activeId]);

  const stats = React.useMemo(
    () => (activeLoc ? computeStats(activeLoc) : null),
    [activeLoc],
  );

  // Positions matching the search query (highlighted in the grid).
  const matched = React.useMemo(() => {
    const result = new Set<string>();
    const q = debounced.trim().toLowerCase();
    if (!q || !activeLoc) return result;
    for (const rack of activeLoc.racks) {
      for (const pos of rack.positions) {
        if (
          pos.id.toLowerCase().includes(q) ||
          rack.name.toLowerCase().includes(q) ||
          (pos.item &&
            `${pos.item.id} ${pos.item.desc} ${pos.lot ?? ''}`.toLowerCase().includes(q))
        ) {
          result.add(pos.id);
        }
      }
    }
    return result;
  }, [activeLoc, debounced]);

  // Resolve the current selection into a full object for the sheet.
  const selection: PositionSelection | null = React.useMemo(() => {
    if (!selected || !activeLoc) return null;
    const rack = activeLoc.racks.find((r) => r.id === selected.rackKey);
    const position = rack?.positions.find((p) => p.id === selected.positionId);
    if (!rack || !position) return null;
    return {
      locationId: activeLoc.id,
      locationName: activeLoc.name,
      rackKey: rack.id,
      rackName: rack.name,
      position,
    };
  }, [selected, activeLoc]);

  if (!activeLoc || !stats) {
    return (
      <>
        <PageHeader title="Storage" subtitle="No locations yet" />
        <div className="px-6 py-5 sm:px-8">
          <Button variant="primary" onClick={() => setAddOpen(true)}>
            <Plus size={14} /> Add location
          </Button>
        </div>
        <LocationAddDialog open={addOpen} onOpenChange={setAddOpen} onCreated={setActiveId} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Storage"
        subtitle={`Position management · ${locations.length} location${locations.length === 1 ? '' : 's'}`}
        actions={
          canEdit && (
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              <Plus size={14} /> Add location
            </Button>
          )
        }
      />

      <div className="px-6 py-5 sm:px-8">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Tabs value={activeLoc.id} onValueChange={setActiveId}>
            <TabsList className="flex-wrap border-b-0">
              {locations.map((loc) => {
                const Icon = KIND_ICON[loc.kind];
                const s = computeStats(loc);
                return (
                  <TabsTrigger key={loc.id} value={loc.id} className="gap-2">
                    <Icon size={12} aria-hidden />
                    {loc.name}
                    <span className="font-mono text-[10px] text-text-3">
                      {s.occupied}/{s.total}
                    </span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
          <Input
            icon={Search}
            placeholder="Search position, item, lot, or rack…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            wrapperClassName="w-[280px]"
            aria-label="Search positions"
          />
          {matched.size > 0 && (
            <div className="text-xs text-text-2">
              <span className="font-medium text-accent">{matched.size}</span> match
              {matched.size === 1 ? '' : 'es'}
            </div>
          )}
        </div>

        <div className="mb-4 flex items-baseline gap-2">
          <h2 className="text-sm font-semibold tracking-tight">{activeLoc.name}</h2>
          <span className="text-xs text-text-3">{activeLoc.detail}</span>
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
            {activeLoc.racks.map((rack) => (
              <RackTile
                key={rack.id}
                rack={rack}
                highlight={matched}
                onSelectPosition={(rackKey, positionId) => setSelected({ rackKey, positionId })}
              />
            ))}
          </div>
        </Card>
      </div>

      <PositionSheet
        selection={selection}
        onClose={() => setSelected(null)}
        onUpdate={(patch) => {
          if (selection) {
            updatePosition(selection.locationId, selection.rackKey, selection.position.id, patch);
          }
        }}
      />

      <LocationAddDialog open={addOpen} onOpenChange={setAddOpen} onCreated={setActiveId} />
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
