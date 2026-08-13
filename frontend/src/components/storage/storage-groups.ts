/**
 * The standard location template — its three sub-types, and the URLs they live at.
 *
 * REQ-2026-08-04-LOC-001: a new location is provisioned "from a standard template
 * that automatically includes a configurable shelf, refrigerator, and freezer",
 * which the client may rename and may leave unused.
 *
 * Storage is the one room with FOUR levels:
 *
 *     Storage            room              seeded, code STG
 *     └ Materials Mgmt   storage_category  the "location" the client names
 *       ├ Shelf          room_location     a template GROUP — a tab
 *       │ └ T123213B     sub_location      the equipment unit, stock lives here
 *       ├ Refrigerator   room_location
 *       └ Freezer        room_location
 *
 * From the group down that is exactly Cold Storage (`CS › Minus-20 Freezers ›
 * T90020B`), which is the point: the group's units are added with the same
 * generic create, the same dialog and the same copy. Storage is meant to replace
 * the Cold Storage structure later, and two spellings of one idea would make
 * that harder, not easier.
 *
 * Which sub-types a location uses is simply WHICH GROUP NODES EXIST. There is no
 * flag and no stored set — an unused sub-type is an absent node, and an empty tab
 * is a group with no children. Nothing here can drift out of step with the tree.
 *
 * Deliberately a PLAIN module with no ``'use client'``: the route files are
 * server components and read {@link GROUP_SEGMENTS} to validate the URL segment.
 * Exporting an array from a client component hands the server a client
 * *reference*, and `.includes()` on it throws at request time. Same reasoning as
 * ``materials-management/mm-tabs.ts`` and ``production/floor-tabs.ts``.
 */
import { Refrigerator, Rows3, Snowflake } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** The Storage room's seeded code. Rooms are resolved BY CODE, never by
 *  position — ``/location-nodes/freezer-tree`` returns every room. */
export const STORAGE_ROOM_CODE = 'STG';

/** Where the room lives, without a trailing slash. */
export const STORAGE_HREF = '/storage';

export interface StorageGroup {
  /** The API field on the create / configure payloads. */
  key: 'shelf' | 'refrigerator' | 'freezer';
  /** The group node's ``code`` — its STABLE identity. The client may rename the
   *  group ("Shelf" → "Racks"), so the code is what the URL and the tab lookup
   *  use; a rename must never break a link. */
  code: 'SHF' | 'REF' | 'FRZ';
  /** URL segment — the code, lower-cased. */
  segment: 'shf' | 'ref' | 'frz';
  /** The name the group is created with. The client may change it, so this is
   *  only ever a default — never render it in place of the node's own name. */
  defaultName: string;
  /** Plural, for counts and empty states. */
  plural: string;
  icon: LucideIcon;
  /** Copy for the add-unit dialog. Matches Cold Storage's wording, because it is
   *  the same action on the same node type (LOC-006: the equipment number is
   *  free text the system never parses, validates or decomposes). */
  addUnit: {
    title: string;
    description: string;
    fieldLabel: string;
    placeholder: string;
  };
}

/** Fixed at three — LOC-001 names exactly these. Order is TAB order. */
export const STORAGE_GROUPS: readonly StorageGroup[] = [
  {
    key: 'shelf',
    code: 'SHF',
    segment: 'shf',
    defaultName: 'Shelf',
    plural: 'shelves',
    icon: Rows3,
    addUnit: {
      title: 'Add shelf',
      description: 'The equipment number is saved exactly as typed.',
      fieldLabel: 'Equipment number',
      placeholder: 'e.g. T123213B',
    },
  },
  {
    key: 'refrigerator',
    code: 'REF',
    segment: 'ref',
    defaultName: 'Refrigerator',
    plural: 'refrigerators',
    icon: Refrigerator,
    addUnit: {
      title: 'Add refrigerator',
      description: 'The equipment number is saved exactly as typed.',
      fieldLabel: 'Equipment number',
      placeholder: 'e.g. T123213C',
    },
  },
  {
    key: 'freezer',
    code: 'FRZ',
    segment: 'frz',
    defaultName: 'Freezer',
    plural: 'freezers',
    icon: Snowflake,
    addUnit: {
      title: 'Add freezer',
      description: 'The equipment number is saved exactly as typed.',
      fieldLabel: 'Equipment number',
      placeholder: 'e.g. T123213D',
    },
  },
] as const;

export const GROUP_SEGMENTS: readonly string[] = STORAGE_GROUPS.map((g) => g.segment);

/**
 * The disposition-log tab on a scrap location (REQ-2026-08-04-TRX-001/002).
 *
 * Not a StorageGroup, and deliberately not in {@link STORAGE_GROUPS}: every
 * entry there is backed by a real ``room_location`` node the client can rename,
 * switch off and put units into. This tab is backed by ledger history and holds
 * nothing. Adding a fake fourth group to get a fourth tab would be modelling
 * debit-and-gone as a location sub-type, which is exactly what the client ruled
 * out — it is a transaction, and this tab shows the transactions.
 *
 * It appears only when the location's ``is_scrap`` is true.
 */
export const ISSUED_SEGMENT = 'issued';

/** Every segment the ``/storage/{id}/{tab}`` route accepts. The route validates
 *  the SHAPE of the URL; whether this particular location has that tab is a
 *  question about data the server component has not loaded, and the client
 *  redirects if not. */
export const STORAGE_SEGMENTS: readonly string[] = [...GROUP_SEGMENTS, ISSUED_SEGMENT];

/** The tab a bare category URL opens on. Not necessarily present — a location
 *  may have Shelf switched off — so callers fall back to its first group. */
export const DEFAULT_GROUP_SEGMENT = STORAGE_GROUPS[0]!.segment;

/** The template group a node's code identifies, or undefined for anything else.
 *  Codes are immutable (no endpoint changes one), so this can never go stale. */
export function groupByCode(code: string | null | undefined): StorageGroup | undefined {
  if (!code) return undefined;
  const upper = code.toUpperCase();
  return STORAGE_GROUPS.find((g) => g.code === upper);
}

export function groupBySegment(segment: string | null | undefined): StorageGroup | undefined {
  if (!segment) return undefined;
  const lower = segment.toLowerCase();
  return STORAGE_GROUPS.find((g) => g.segment === lower);
}

/**
 * URL for a Storage location, optionally deep-linked to one unit's contents.
 *
 *     /storage/{categoryId}/{segment}          the tab
 *     /storage/{categoryId}/{segment}/{nodeId} …with a unit's panel open
 */
export function storageHref(categoryId: string, segment: string, nodeId?: string): string {
  const base = `${STORAGE_HREF}/${categoryId}/${segment}`;
  return nodeId ? `${base}/${nodeId}` : base;
}
