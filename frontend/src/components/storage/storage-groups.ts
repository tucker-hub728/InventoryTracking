/**
 * A Storage location's sub-types — the three kinds, and the URLs they live at.
 *
 * REQ-2026-08-04-LOC-001 named exactly three sub-types: "a configurable shelf,
 * refrigerator, and freezer". The 2026-08-13 amendment made them configurable
 * AFTER creation and allowed MORE THAN ONE of a kind — "an additional freezer
 * (e.g. minus-80 alongside minus-20)".
 *
 * So there are two things in this file, and keeping them apart is the design:
 *
 *   * {@link STORAGE_GROUPS} — the three KINDS you can add. A closed list; the
 *     requirement names these and only these.
 *   * {@link groupFor} — how to present one sub-type a location actually has.
 *     Open, because a location may hold several of a kind and the client names
 *     them.
 *
 * Storage is the one room with FOUR levels:
 *
 *     Storage              room              seeded, code STG
 *     └ Materials Mgmt     storage_category  the "location" the client names
 *       ├ Shelf            room_location     a sub-type — a tab. code SHF
 *       │ └ T123213B       sub_location      the equipment unit, stock lives here
 *       ├ Refrigerator     room_location     code REF
 *       ├ Minus-20 Freezer room_location     code FRZ    ┐ two of one KIND,
 *       └ Minus-80 Freezer room_location     code FRZ-2  ┘ told apart by NAME
 *
 * From the sub-type down that is exactly Cold Storage (`CS › Minus-20 Freezers ›
 * T90020B`), which is the point: its units are added with the same generic
 * create, the same dialog and the same copy. Storage is meant to replace the Cold
 * Storage structure later, and two spellings of one idea would make that harder,
 * not easier.
 *
 * Which sub-types a location has is simply WHICH GROUP NODES EXIST. There is no
 * flag and no stored set — a location is created with none, an unused sub-type is
 * an absent node, and an empty tab is a sub-type with no children. Nothing here
 * can drift out of step with the tree.
 *
 * Deliberately a PLAIN module with no ``'use client'``: the route files are
 * server components and call {@link isStorageSegment} to validate the URL
 * segment. Exporting from a client component hands the server a client
 * *reference*, and calling it throws at request time. Same reasoning as
 * ``materials-management/mm-tabs.ts`` and ``production/floor-tabs.ts``.
 */
import { Boxes, Refrigerator, Rows3, Snowflake } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** The Storage room's seeded code. Rooms are resolved BY CODE, never by
 *  position — ``/location-nodes/freezer-tree`` returns every room. */
export const STORAGE_ROOM_CODE = 'STG';

/** Where the room lives, without a trailing slash. */
export const STORAGE_HREF = '/storage';

/** How to present one sub-type: its tab, its icon, and the wording of the dialog
 *  that adds units to it. Derived from the node — never stored. */
export interface StorageGroup {
  /** The group node's ``code`` — its STABLE identity. The client may rename the
   *  sub-type ("Shelf" → "Racks"), so the code is what the URL and the tab
   *  lookup use; a rename must never break a link. */
  code: string;
  /** URL segment — the code, lower-cased. */
  segment: string;
  /** The noun for this sub-type's units, from its KIND — "Freezer" for both the
   *  minus-20 and the minus-80. Used by the Add button and the grid. Never render
   *  it in place of the node's own name; the client named that. */
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

/** One of the three KINDS. Carries the extra ``key`` the add payload sends, and
 *  the bare code the first sub-type of that kind takes. */
export interface TemplateGroup extends StorageGroup {
  key: 'shelf' | 'refrigerator' | 'freezer';
  code: 'SHF' | 'REF' | 'FRZ';
}

/**
 * The kinds of sub-type that can be added. Fixed at three — LOC-001 names
 * exactly these — and this order is the picker's and the tab strip's.
 *
 * NOT the sub-types a location has: a location starts with none and may end up
 * with several of one kind. Use {@link groupFor} to present an actual node.
 */
export const STORAGE_GROUPS: readonly TemplateGroup[] = [
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

/** The kinds, in picker / tab order. */
export const STORAGE_GROUP_KINDS = STORAGE_GROUPS.map((g) => g.key);

export type StorageGroupKind = TemplateGroup['key'];

/**
 * The disposition-log tab on a scrap location (REQ-2026-08-04-TRX-001/002).
 *
 * Not a StorageGroup, and deliberately not in {@link STORAGE_GROUPS}: every
 * entry there is backed by a real ``room_location`` node the client can rename,
 * switch off and put units into. This tab is backed by ledger history and holds
 * nothing. Adding a fake sub-type to get a tab would be modelling debit-and-gone
 * as a location sub-type, which is exactly what the client ruled out — it is a
 * transaction, and this tab shows the transactions.
 *
 * It appears only when the location's ``is_scrap`` is true.
 */
export const ISSUED_SEGMENT = 'issued';

/** The tab a bare category URL opens on. Not necessarily present — a location
 *  may have Shelf switched off — so callers fall back to its first sub-type. */
export const DEFAULT_GROUP_SEGMENT = STORAGE_GROUPS[0]!.segment;

/** The KIND a code belongs to — `FRZ` and `FRZ-2` are both freezers.
 *
 *  The base is everything before the first dash, so this survives a location
 *  gaining a fifth freezer without a change here. Codes are immutable (no
 *  endpoint changes one), so it can never go stale. */
export function kindForCode(code: string | null | undefined): TemplateGroup | undefined {
  if (!code) return undefined;
  const base = code.toUpperCase().split('-', 1)[0];
  return STORAGE_GROUPS.find((g) => g.code === base);
}

export function groupByKind(kind: StorageGroupKind): TemplateGroup {
  return STORAGE_GROUPS.find((g) => g.key === kind)!;
}

export function groupBySegment(segment: string | null | undefined): TemplateGroup | undefined {
  if (!segment) return undefined;
  return kindForCode(segment);
}

/** Neutral fallback for a code matching no kind. Should not occur — every
 *  sub-type is created through the kind picker — but a stray row must still get
 *  a tab rather than vanish, taking whatever stock it holds with it. */
const UNKNOWN_GROUP: Omit<StorageGroup, 'code' | 'segment'> = {
  defaultName: 'Unit',
  plural: 'units',
  icon: Boxes,
  addUnit: {
    title: 'Add unit',
    description: 'The equipment number is saved exactly as typed.',
    fieldLabel: 'Equipment number',
    placeholder: 'e.g. T123213B',
  },
};

/**
 * How to present ANY sub-type a location has — the one every screen should call.
 *
 * The icon and wording come from the sub-type's KIND, so the second freezer gets
 * the same snowflake and the same "Add freezer" as the first. Its own segment
 * comes from its own code, so `FRZ-2` is its own tab.
 *
 * The NAME is deliberately not consulted. "Minus-80 Freezer" is a label the
 * client typed; reading temperature out of it is exactly what LOC-001's
 * "regardless of temperature" and LOC-006 rule out.
 *
 * Never returns undefined: an unrecognised code is still a real node holding real
 * stock, and dropping it from the tab strip would hide that stock behind a URL
 * nothing links to.
 */
export function groupFor(node: { code: string }): StorageGroup {
  const kind = kindForCode(node.code);
  const base = kind ?? UNKNOWN_GROUP;
  return { ...base, code: node.code, segment: node.code.toLowerCase() };
}

/** `shf` | `ref` | `frz`, each optionally numbered — `frz-2`. */
const GROUP_SEGMENT_RE = new RegExp(
  `^(${STORAGE_GROUPS.map((g) => g.segment).join('|')})(-\\d+)?$`,
);

/** Does this URL segment have the SHAPE of a Storage tab?
 *
 *  Shape only — whether this particular location has that tab is a question
 *  about data the server component has not loaded, and the client redirects if
 *  not. It has to be a pattern rather than a list now that a location may hold
 *  several sub-types of a kind: a fixed list would bounce `/storage/{id}/frz-2`
 *  to the default tab on every refresh and every shared link. */
export function isStorageSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  return lower === ISSUED_SEGMENT || GROUP_SEGMENT_RE.test(lower);
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
