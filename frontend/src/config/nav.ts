import {
  Building2,
  Contact,
  FlaskConical,
  History,
  LineChart,
  Refrigerator,
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
  /** Show a "Soon" pill — feature isn't wired to a backend yet. */
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
    title: 'Inventory',
    items: [
      { id: 'inventory-cr', label: 'Raw Materials', href: '/inventory/cr', icon: FlaskConical, resource: 'inventory' },
    ],
  },
  {
    title: 'Operations',
    items: [
      { id: 'receiving', label: 'Receipt Admin', href: '/receiving', icon: Truck, resource: 'inventory' },
      { id: 'categories', label: 'Categories', href: '/categories', icon: Tags, resource: 'inventory' },
      { id: 'customers', label: 'Customers', href: '/customers', icon: Contact, resource: 'inventory' },
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
    ],
  },
  {
    title: 'Administration',
    items: [
      // Users & Roles — invite users, change roles, enable/disable (super_admin
      // + admin per the `users` permission bucket). The invite dialog is wired
      // to the backend; the directory list is the next wiring step.
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
