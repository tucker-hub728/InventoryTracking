import type { SearchableSelectOption } from '@/components/ui/searchable-select';
import type { ApiItem } from '@/lib/api/items';
import type { ApiLocation } from '@/lib/api/locations';

export function itemOptions(items: ApiItem[]): SearchableSelectOption[] {
  return items.map((i) => ({
    value: i.id,
    label: `${i.item_code} · ${i.item_name}`,
    searchText: `${i.item_code} ${i.item_name}`,
  }));
}

export function locationOptions(locations: ApiLocation[]): SearchableSelectOption[] {
  return locations.map((l) => ({
    value: l.id,
    label: `${l.location_name} · ${l.location_type}`,
    searchText: `${l.location_name} ${l.location_type}`,
  }));
}
