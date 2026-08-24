import {
  AlertTriangle,
  Boxes,
  Building2,
  Contact,
  Factory,
  FlaskConical,
  History,
  Layers,
  LineChart,
  MinusCircle,
  Package,
  Scale,
  Snowflake,
  Tags,
  Truck,
  Users,
  ShoppingCart,
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
  /** Key of a live count to show as a pill on the right of the row — the
   *  number of things on that page needing attention. The sidebar owns the
   *  fetching (see ``useNavCounts``); the config only says which badge a row
   *  wants, so adding one elsewhere never means touching the renderer. */
  badge?: NavBadgeKey;
}

/** Counts the sidebar knows how to fetch and render. */
export type NavBadgeKey = 'expiringConsumables' | 'reorderItems';

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
      // Visible to everyone with inventory:view, Read-Only included — the page
      // shows the taxonomy but hides every mutating control.
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
      // The cross-Kanban expiration feed (REQ-2026-07-01-LOC-008). Issuing
      // happens on a consumable's drill-down and the per-room register lives on
      // each production area's Kanban tab; this answers the one question that
      // spans rooms — "what needs a physical check?".
      {
        id: 'consumables',
        label: 'Expiring',
        href: '/consumables',
        icon: AlertTriangle,
        resource: 'inventory',
        // LOC-008 calls the alert a prompt for a physical check, and a prompt
        // nobody sees isn't one — the count belongs where an operator already
        // looks rather than only on the page itself.
        badge: 'expiringConsumables',
      },
      // Items that have reached their reorder threshold (PLN-001). Labelled
      // "Reorder", not "Planning", because the row below already carries that
      // word for the forecast screen and two identical labels in one section
      // is a coin toss for the user. This one names what it lists.
      {
        id: 'planning',
        label: 'Reorder',
        href: '/planning',
        icon: ShoppingCart,
        resource: 'inventory',
        // Same reasoning as the expiry badge: a warning nobody sees isn't one,
        // and the whole point of PLN-001 is catching the breach early.
        badge: 'reorderItems',
      },
      {
        id: 'forecast',
        label: 'Planning',
        href: '/forecast',
        icon: LineChart,
        resource: 'inventory',
        disabled: true,
        disabledReason:
          'Planning is a work in progress — demand projections are not yet wired to the backend. Reorder signals now live on their own screen above.',
      },
    ],
  },
  {
    // One row per room, in the order the client draws them: Storage, LN2,
    // Production. Storage runs room → category → group → unit; LN2 goes deeper
    // still; a Production area is a flat root with no room above it.
    //
    // Materials Management, Cold Storage and Analytical Lab were RETIRED
    // (2026-08-19, client-approved) in favour of Storage's generic template —
    // routes, components and seeds all deleted. Rooms are matched to screens BY
    // NODE CODE, never by position: ``/location-nodes/freezer-tree`` returns
    // every room.
    title: 'Locations',
    items: [
      // REQ-2026-08-04-LOC-001: the standard location template. Storage leads
      // the section because it is the room the three below it are being
      // replaced by — a new location is provisioned here, not there.
      //
      // Storage is the one area with FOUR levels: room → category → group →
      // unit, where the groups are the template's shelf / refrigerator /
      // freezer. See components/storage/storage-groups.ts.
      {
        id: 'storage',
        label: 'Storage',
        href: '/storage',
        icon: Boxes,
        resource: 'inventory',
      },
      // REQ-2026-08-04-TRX-001/002 — where material goes to LEAVE inventory
      // (PD, R&D, QC, scrap). Its own row since 2026-08-19, next to Storage
      // because that is where these used to live and where people will look.
      //
      // ⚠ These are ``storage_category`` rows in the STORAGE room carrying
      // ``is_scrap`` — this row opens a FILTERED VIEW of them, not a room of its
      // own. Debit-and-gone is a TRANSACTION, not a location type (the client
      // rejected a scrap-node model twice), and "issued AND stored" is
      // unrepresentable only because Issue and Transfer take DISJOINT
      // destination node types. Promote this to a real room and both go.
      {
        id: 'debit-and-gone',
        label: 'Debit-and-gone',
        href: '/debit-and-gone',
        icon: MinusCircle,
        resource: 'inventory',
      },
      // RETIRED 2026-08-19 (client-approved): Materials Management
      // (REQ-2026-07-15-LOC-005), Cold Storage (LOC-002) and the provisional
      // Analytical Lab each had a row here, deprecated since 2026-08-12. Storage
      // above now covers all three, so the rows, their routes, the /freezer and
      // /warehouse redirects into them, and their seed scripts are all deleted.
      //
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
