import {
  Boxes,
  Building2,
  History,
  KanbanSquare,
  Layers,
  MapPin,
  Ruler,
  Snowflake,
  Users,
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
    title: 'Operations',
    items: [
      { id: 'inventory', label: 'Inventory', href: '/inventory', icon: Boxes, resource: 'inventory' },
      {
        id: 'ln2',
        label: 'LN2 Tanks',
        href: '/ln2',
        icon: Snowflake,
        resource: 'inventory',
        disabled: true,
        disabledReason:
          'LN2 tank mapping is in active development — temperature streaming and position state are not yet wired to the backend.',
      },
      {
        id: 'kanban',
        label: 'Kanban',
        href: '/kanban',
        icon: KanbanSquare,
        resource: 'inventory',
        disabled: true,
        disabledReason:
          'Kanban workflow is in active development — board state and card transitions are not yet wired to the backend.',
      },
    ],
  },
  {
    title: 'Administration',
    items: [
      {
        id: 'users',
        label: 'Users & Roles',
        href: '/users',
        icon: Users,
        resource: 'users',
        disabled: true,
        disabledReason:
          'Users & Roles management is in active development — invitations, role grants, and the audit trail are not yet wired to the backend.',
      },
      // Master data — viewer can read; admin/editor can create.
      // Page-level permission check enforces the write side.
      { id: 'vendors', label: 'Vendors', href: '/vendors', icon: Building2, resource: 'inventory' },
      { id: 'uoms', label: 'Units of measure', href: '/uoms', icon: Ruler, resource: 'inventory' },
      { id: 'locations', label: 'Locations', href: '/locations', icon: MapPin, resource: 'inventory' },
      { id: 'lots', label: 'Lots', href: '/lots', icon: Layers, resource: 'inventory' },
      { id: 'audit', label: 'Audit log', href: '/audit', icon: History, resource: 'audit' },
    ],
  },
] as const;
