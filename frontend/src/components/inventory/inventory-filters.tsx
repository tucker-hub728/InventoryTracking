'use client';

import * as React from 'react';
import { Download, Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useInventoryStore } from '@/stores/inventory.store';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { InventoryStatus } from '@/types/inventory';

interface InventoryFiltersProps {
  categories: string[];
  onExport?: () => void;
}

// Statuses that the backend can actually filter on (see
// ``v_item_stock.status_code``). Lot-driven statuses
// (Expiring / Quarantine / Expired) need lot-level rollups before
// they're meaningful at item level — they're omitted here rather
// than included as no-op options.
const STATUS_FILTER_OPTIONS: readonly InventoryStatus[] = [
  'Available',
  'Low stock',
  'Out of stock',
] as const;

export function InventoryFilters({ categories, onExport }: InventoryFiltersProps) {
  const query = useInventoryStore((s) => s.query);
  const status = useInventoryStore((s) => s.status);
  const category = useInventoryStore((s) => s.category);
  const setQuery = useInventoryStore((s) => s.setQuery);
  const setStatus = useInventoryStore((s) => s.setStatus);
  const setCategory = useInventoryStore((s) => s.setCategory);

  // Local input state for snappy typing; commit to store on debounce.
  const [local, setLocal] = React.useState(query);
  const debounced = useDebouncedValue(local, 180);
  React.useEffect(() => {
    if (debounced !== query) setQuery(debounced);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <Input
        icon={Search}
        placeholder="Search by name, ID, vendor, or lot…"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        wrapperClassName="min-w-[260px] flex-1 max-w-[560px]"
        aria-label="Search inventory"
      />

      <Select value={category} onValueChange={(v) => setCategory(v)}>
        <SelectTrigger
          className="w-[220px] [&>span]:min-w-0 [&>span]:truncate"
          aria-label="Filter by category"
        >
          <SelectValue placeholder="All categories" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All categories</SelectItem>
          {categories.map((c) => (
            <SelectItem key={c} value={c}>
              {c}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
        <SelectTrigger
          className="w-[160px] [&>span]:min-w-0 [&>span]:truncate"
          aria-label="Filter by status"
        >
          <SelectValue placeholder="All statuses" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All statuses</SelectItem>
          {STATUS_FILTER_OPTIONS.map((s) => (
            <SelectItem key={s} value={s}>
              {s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* <Button variant="default" size="md" onClick={onExport}>
        <Download size={14} /> Export
      </Button> */}
    </div>
  );
}
