/**
 * The rooms that have a screen of their own, and what each one lets you add.
 *
 * Every room runs the same three levels — room → location → sub-location, with
 * stock landing at the sub-location. What differs is who may add which level,
 * and that is a client rule rather than anything the schema enforces
 * (2026-07-30):
 *
 *   * **Cold Storage** adds LOCATIONS and sub-locations. It is where a new group
 *     is created — a 2–8 °C refrigerator group (REQ-2026-07-15-LOC-004, pending
 *     the client's list) or a minus-forty if one turns out to exist.
 *   * **Production** adds locations too — the areas a kit is transferred into
 *     (REQ-2026-07-22-LOC-002/003). It has its own page and its own endpoint,
 *     so it is not configured here.
 *   * **Every other room** adds SUB-LOCATIONS only: units into an existing
 *     freezer group, shelves into Warehouse One. Its set of locations is fixed
 *     by requirement — LOC-005 gives Materials Management exactly two peers, so
 *     an Add-location control there would invite a structure the requirement
 *     does not allow.
 *
 * Renaming follows the same rule: you may rename what that room could have
 * created. So a location is renameable on the Cold Storage page only, while
 * units and shelves are renameable in any room. Every one of these actions is
 * Super-Admin-only regardless (LOC-003 / LOC-006) — the API enforces it, and
 * these flags only decide whether a control is worth rendering at all.
 *
 * Deliberately a PLAIN module with no ``'use client'``: the route files are
 * server components and read ``code`` to build metadata. Same reasoning as
 * ``materials-management/mm-tabs.ts``.
 */
export interface RoomConfig {
  /** The room node's ``code``, as seeded. Rooms are resolved by code, never by
   *  position — ``/location-nodes/freezer-tree`` returns every room. */
  code: string;
  /** Sidebar and page-header label. */
  label: string;
  /** Route this room lives at, without a trailing slash. */
  href: string;
  subtitle: string;
  /** May a new LOCATION (a group) be created here? See the module docstring. */
  canAddLocation: boolean;
  /** Copy for the add-location dialog. Required when ``canAddLocation``. */
  addLocation?: {
    title: string;
    description: string;
    fieldLabel: string;
    placeholder: string;
  };
  /** Copy for the add-sub-location dialog, and the noun used in counts. */
  subLocation: {
    /** Singular, lower-case — "unit", "shelf". */
    noun: string;
    title: string;
    description: string;
    fieldLabel: string;
    placeholder: string;
  };
  /** Optional line under the toolbar describing what the room holds. Omitted
   *  where the units speak for themselves (client 2026-07-30). */
  hint?: string;
}

/**
 * Cold Storage (LOC-002) — the room whose locations are the unit-type groups:
 * minus-twenty, minus-eighty, and the two-to-eight refrigerators once the
 * client's list arrives.
 */
export const COLD_STORAGE_ROOM: RoomConfig = {
  code: 'CS',
  label: 'Cold Storage',
  href: '/cold-storage',
  subtitle:
    'Minus-20 and Minus-80 freezers, and the 2–8 °C refrigerators. Stock is placed from Receipt Admin.',
  canAddLocation: true,
  addLocation: {
    title: 'Add Cold Storage location',
    description:
      'A group inside Cold Storage — for example “2–8 °C Refrigerators”. Its units are added afterwards.',
    fieldLabel: 'Name',
    placeholder: 'e.g. 2–8 °C Refrigerators',
  },
  subLocation: {
    noun: 'unit',
    title: 'Add unit',
    description:
      "The equipment number is saved exactly as typed.",
    fieldLabel: 'Equipment number',
    placeholder: 'e.g. T90020E',
  },
};

/**
 * Analytical Lab — one −20 °C freezer (T90020A) and one −80 °C freezer
 * (T90019D), from the client's equipment list.
 *
 * PROVISIONAL. REQ-2026-07-15-LOC-005 supersedes REQ-2026-07-09-LOC-002, which
 * was the only requirement that placed a minus-twenty and a minus-eighty in the
 * Analytical Lab — and LOC-005 does not mention the room at all. What supports
 * it now is the resolution recorded against Q-2026-07-01-002 and the equipment
 * list naming both units. Kept at the client's direction (2026-07-30) pending an
 * amendment that names the room; its two locations are fixed, so nothing here
 * can add to them.
 */
export const ANALYTICAL_LAB_ROOM: RoomConfig = {
  code: 'AL',
  label: 'Analytical Lab',
  href: '/analytical-lab',
  subtitle: 'One −20 °C freezer and one −80 °C freezer. Stock is placed from Receipt Admin.',
  canAddLocation: false,
  subLocation: {
    noun: 'unit',
    title: 'Add unit',
    description:
      "The equipment number is saved exactly as typed.",
    fieldLabel: 'Equipment number',
    placeholder: 'e.g. T90019D',
  },
  hint: 'Nothing is modeled inside a unit — placement inside one is controlled by labeling.',
};

/** True iff a location in this room may be renamed — renaming follows adding. */
export function canRenameLocation(room: RoomConfig): boolean {
  return room.canAddLocation;
}
