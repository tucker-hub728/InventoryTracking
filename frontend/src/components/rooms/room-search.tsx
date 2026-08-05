'use client';

/**
 * The search bar over a room's units.
 *
 * Same engine as the LN2 sidebar (``useHierarchySearch``), so one query reaches
 * everything the operator might know: a unit's name or code, a level keyword,
 * and — the one that answers "where is this stock" — a lot number, item number
 * or item name. The last three cannot come from the tree: a node carries an
 * occupancy count, never what is inside it, so they are resolved by
 * ``GET /allocations/search``.
 *
 * A room FILTERS rather than highlights, unlike the LN2 tree. There is no
 * hierarchy to lose here — a room is one flat grid of units — so showing only
 * the matches is the shorter answer, and the matched card carries the lot that
 * explains why it is there.
 */

import * as React from 'react';
import { Search, X } from 'lucide-react';

import { Input } from '@/components/ui/input';
import type { HierarchySearch } from '@/components/locations/use-hierarchy-search';

export function RoomSearch({
  value,
  onChange,
  found,
  noun,
  // Location is listed first: it is the coarsest thing you can look for, and
  // the box gave no hint it was searchable at all.
  placeholder = 'Location, unit, lot, or item…',
}: {
  value: string;
  onChange: (v: string) => void;
  found: HierarchySearch;
  /** Plural noun for the result line — "units", "shelves". */
  noun: string;
  placeholder?: string;
}) {
  return (
    // Pinned while the list scrolls (UI-002): on a 26-shelf warehouse the
    // search is the fastest way to a named target, and scrolling it off screen
    // means scrolling back up before you can use it.
    <div className="sticky top-[52px] z-20 -mx-6 mb-4 border-b border-border bg-bg px-6 py-3 sm:-mx-8 sm:px-8">
      <Input
        icon={Search}
        wrapperClassName="max-w-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={`Search ${noun}`}
        trailing={
          value ? (
            <button
              type="button"
              onClick={() => onChange('')}
              aria-label="Clear search"
              className="rounded p-0.5 text-text-3 hover:text-text"
            >
              <X size={13} />
            </button>
          ) : undefined
        }
      />
      {found.active && (
        <p className="mt-1.5 px-0.5 text-[11px] leading-relaxed text-text-3">
          {found.loading && found.matchCount === 0 ? (
            'Searching…'
          ) : found.matchCount === 0 ? (
            <>
              Nothing here matches <span className="text-text-2">“{value.trim()}”</span>
              {/* Found, but in another area — this page covers one room while the
                  lookup covers every location. Saying nothing exists would be a
                  different, wrong claim. */}
              {found.elsewhere > 0 && (
                <>
                  {' — '}
                  {found.elsewhere} unit{found.elsewhere === 1 ? '' : 's'} of it
                  {found.elsewhere === 1 ? ' is' : ' are'} stored elsewhere
                </>
              )}
            </>
          ) : (
            <>
              {/* "match", not the unit noun: a hit can be a location, a unit, a
                  lot or an item, and calling a matched location "1 unit" was
                  wrong as soon as locations became searchable. */}
              {found.matchCount} {found.matchCount === 1 ? 'match' : 'matches'}
              {found.lotNumbers.length > 0 && (
                <>
                  {' · '}
                  <span className="font-mono text-text-2">
                    {found.lotNumbers.slice(0, 2).join(', ')}
                    {found.lotNumbers.length > 2 && ` +${found.lotNumbers.length - 2}`}
                  </span>
                </>
              )}
              {found.elsewhere > 0 && <> · {found.elsewhere} more elsewhere</>}
            </>
          )}
        </p>
      )}
    </div>
  );
}
