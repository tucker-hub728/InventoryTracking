import {
  Building2,
  Contact,
  Factory,
  FlaskConical,
  FlaskRound,
  History,
  Layers,
  LineChart,
  Package,
  Scale,
  Snowflake,
  Tags,
  Thermometer,
  Truck,
  Users,
  Warehouse,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { ResourceKey } from '@/types/auth';

export interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  /** Resource the user must be able to view. Omitted = always visible. */
  resource?: ResourceKey;
  /** Show the "WIP" pill but keep the row clickable — the module works well
   *  enough to use while it's still being built out. Use ``disabled`` instead
   *  when the page shouldn't be reachable at all. */
  comingSoon?: boolean;
  /** When true, the nav row renders muted, non-clickable, and exposes
   *  ``disabledReason`` via title + tooltip. Use for modules whose
   *  backend isn't ready yet (LN2, Kanban) — the link target stays in
   *  the config so re-enabling is a one-line flip. */
  disabled?: boolean;
  /** Short hover-text shown when ``disabled`` is true. */
  disabledReason?: string;
}

export interface NavSection {
  title: string;
  items: readonly NavItem[];
}

export const navSections: readonly NavSection[] = [
  {
    // One dedicated screen per tier, not a filter over a shared list
    // (REQ-2026-07-01-INV-001). The set is fixed at three
    // (REQ-2026-07-15-ITM-001).
    title: 'Inventory',
    items: [
      { id: 'inventory-cr', label: 'Raw Materials', href: '/inventory/cr', icon: FlaskConical, resource: 'inventory' },
      { id: 'inventory-ay', label: 'Sub-Assemblies', href: '/inventory/ay', icon: Layers, resource: 'inventory' },
      { id: 'inventory-fg', label: 'Finished Goods', href: '/inventory/fg', icon: Package, resource: 'inventory' },
    ],
  },
  {
    title: 'Operations',
    items: [
      { id: 'receiving', label: 'Receipt Admin', href: '/receiving', icon: Truck, resource: 'inventory' },
      // Tiers are seed-only for now (create / edit / delete hidden behind
      // ``TIER_ACTIONS_ENABLED``).
      { id: 'tiers', label: 'Tiers', href: '/tiers', icon: Tags, resource: 'inventory' },
      // Kitting / back-flush flow, wired to the real backend (Transaction Spec §2-§4).
      {
        id: 'reconciliation',
        label: 'Kitting',
        href: '/reconciliation',
        icon: Scale,
        resource: 'inventory',
      },
      {
        id: 'customers',
        label: 'Customers',
        href: '/customers',
        icon: Contact,
        resource: 'inventory',
      },
      {
        id: 'forecast',
        label: 'Planning',
        href: '/forecast',
        icon: LineChart,
        resource: 'inventory',
        disabled: true,
        disabledReason:
          'Planning is a work in progress — demand projections and reorder signals are not yet wired to the backend.',
      },
    ],
  },
  {
    // One row per room, in the order the client draws them: Materials
    // Management, Cold Storage, Analytical Lab, LN2, Production. Each room runs
    // the same three levels — room → location → sub-location, with stock landing
    // at the sub-location — and each has its own screen so a room's own layout
    // can differ (Materials Management is the only one with a warehouse in it).
    //
    // Rooms are matched to screens BY NODE CODE, never by position:
    // ``/location-nodes/freezer-tree`` returns every room. See
    // ``components/rooms/room-config.ts``.
    title: 'Locations',
    items: [
      // REQ-2026-07-15-LOC-005: Warehouse One is a location INSIDE the Materials
      // Management room, not a peer of it — so there is no top-level Warehouse
      // entry. It is a tab on this page, beside the Minus-20 Freezers.
      // /freezer and /warehouse redirect here.
      {
        id: 'materials-management',
        label: 'Materials Management',
        href: '/materials-management',
        icon: Warehouse,
        resource: 'inventory',
      },
      // LOC-002 renamed the Freezer category to Cold Storage, since the same
      // level also holds refrigerators: −20 °C, −80 °C and 2–8 °C. This is the
      // one room where a Super Admin adds a LOCATION as well as its units.
      {
        id: 'cold-storage',
        label: 'Cold Storage',
        href: '/cold-storage',
        icon: Thermometer,
        resource: 'inventory',
      },
      // PROVISIONAL room — LOC-005 supersedes REQ-2026-07-09-LOC-002, the only
      // requirement that placed freezers in the Analytical Lab, and does not
      // mention the room. Kept at the client's direction (2026-07-30) on the
      // strength of Q-2026-07-01-002's resolution and the equipment list
      // (T90020A, T90019D), pending an amendment that names it.
      {
        id: 'analytical-lab',
        label: 'Analytical Lab',
        href: '/analytical-lab',
        icon: FlaskRound,
        resource: 'inventory',
      },
      // The old combined /locations page now lives at /ln2 (redirect kept for
      // bookmarks). LN2 is the one area deeper than three levels:
      // tank → quadrant → rack → box grid (LOC-001).
      { id: 'ln2', label: 'LN2', href: '/ln2', icon: Snowflake, resource: 'inventory' },
      // The seeded production areas and the WIP currently on them (client
      // 2026-07-22). Material moves only through a kit's issue/close-out, but a
      // Super Admin may add an area — the second place a LOCATION is created.
      {
        id: 'production',
        label: 'Production',
        href: '/production',
        icon: Factory,
        resource: 'inventory',
      },
    ],
  },
  {
    title: 'Administration',
    items: [
      // Users & Roles — super_admin + admin can view the directory
      // (`users:view`), but inviting, editing and enabling/disabling members are
      // all super-admin-only.
      { id: 'users', label: 'Users & Roles', href: '/users', icon: Users, resource: 'users' },
      // Master data — viewer can read; admin/editor can create.
      // Page-level permission check enforces the write side.
      { id: 'suppliers', label: 'Suppliers', href: '/suppliers', icon: Building2, resource: 'inventory' },
      // { id: 'uoms', label: 'Units of measure', href: '/uoms', icon: Ruler, resource: 'inventory' },
      // { id: 'locations', label: 'Locations', href: '/locations', icon: MapPin, resource: 'inventory' },
      { id: 'audit', label: 'Audit log', href: '/audit', icon: History, resource: 'audit' },
    ],
  },
] as const;
