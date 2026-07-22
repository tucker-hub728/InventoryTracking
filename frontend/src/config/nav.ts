import {
  Building2,
  Contact,
  Factory,
  FlaskConical,
  History,
  Layers,
  LineChart,
  Package,
  Refrigerator,
  Scale,
  Snowflake,
  Tags,
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
        disabled: true,
        disabledReason: 'Customers is a work in progress.',
      },
      {
        id: 'forecast',
        label: 'Forecast',
        href: '/forecast',
        icon: LineChart,
        resource: 'inventory',
        disabled: true,
        disabledReason:
          'Forecasting is a work in progress — demand projections and reorder signals are not yet wired to the backend.',
      },
    ],
  },
  {
    title: 'Locations',
    items: [
      // The old combined /locations page now lives at /ln2 (redirect kept for
      // bookmarks). Freezer + Warehouse are the new per-area sections.
      { id: 'ln2', label: 'LN2', href: '/ln2', icon: Snowflake, resource: 'inventory' },
      { id: 'freezer', label: 'Freezers', href: '/freezer', icon: Refrigerator, resource: 'inventory' },
      { id: 'warehouse', label: 'Warehouse', href: '/warehouse', icon: Warehouse, resource: 'inventory' },
      // View-only: the 5 seeded production floors and the WIP currently on them
      // (client 2026-07-22). Material moves only through a kit's issue/close-out.
      { id: 'production', label: 'Production', href: '/production', icon: Factory, resource: 'inventory' },
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
