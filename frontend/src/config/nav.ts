import { ArrowLeftRight, Boxes, MapPin, Users } from 'lucide-react';
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
  /** Render the row muted + non-clickable with a tooltip reason. */
  disabled?: boolean;
  /** Short hover-text shown when ``disabled`` is true. */
  disabledReason?: string;
}

export interface NavSection {
  title: string;
  items: readonly NavItem[];
}

/**
 * Week-1 nav — exactly four sections, gated by the new roles.
 *
 *  - Raw Materials / Locations / Transactions → operational (operators
 *    see them; admins too).
 *  - Users → admin-only (operators lack ``users:view``).
 */
export const navSections: readonly NavSection[] = [
  {
    title: 'Operations',
    items: [
      { id: 'inventory', label: 'Raw Materials', href: '/inventory/cr', icon: Boxes, resource: 'items' },
      { id: 'locations', label: 'Locations', href: '/locations', icon: MapPin, resource: 'locations' },
      {
        id: 'transactions',
        label: 'Transactions',
        href: '/transactions',
        icon: ArrowLeftRight,
        resource: 'transactions',
      },
    ],
  },
  {
    title: 'Administration',
    items: [
      { id: 'users', label: 'Users', href: '/users', icon: Users, resource: 'users' },
    ],
  },
] as const;
