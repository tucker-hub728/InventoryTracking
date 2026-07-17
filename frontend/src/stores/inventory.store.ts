'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import { DEFAULT_PAGE_SIZE } from '@/config/inventory';
import { ApiError } from '@/lib/api/client';
import {
  itemsApi,
  type ApiItemStatus,
  type ApiSortField,
  type ApiSortDirection,
  type ItemCreateInput,
} from '@/lib/api/items';
import { apiItemToInventoryItem } from '@/lib/api/items-adapter';
import type { InventoryItem, InventoryStatus } from '@/types/inventory';

/**
 * Inventory store — owns both **filter state** (what the user is asking
 * for) and **server data** (what the backend returned). Keeping them in
 * one store makes the contract obvious: mutate a filter, call
 * ``fetch()``, components re-render off the new data. The previous
 * version held only filters and let components join against mockData
 * directly — that pattern doesn't survive a real API.
 *
 * Persistence: only filters land in localStorage. Server data is
 * intentionally not persisted — a fresh ``fetch()`` runs on every mount
 * so the user can't see stale rows from a previous session.
 */

// ── Public types ───────────────────────────────────────────────────────

export type SortKey = 'id' | 'desc' | 'lastUpdated';
export type SortDir = 'asc' | 'desc';

// API sort fields that map cleanly. Other UI sort keys (qty, status,
// supplier, etc.) are computed/derived and not backend-sortable yet —
// they fall back to ``item_number``.
const SORT_KEY_TO_API: Partial<Record<SortKey, ApiSortField>> = {
  id: 'item_number',
  desc: 'description',
  lastUpdated: 'updated_at',
};

// Frontend display label → backend ``v_item_stock.status_code``. Only
// the three statuses the view actually computes are mapped here.
// Lot-driven statuses (Expiring / Quarantine / Expired) need lot data
// rolled up to item level before they can filter at all — until then
// they're omitted from the dropdown rather than silently no-op.
const STATUS_CODE_BY_LABEL: Partial<Record<InventoryStatus, ApiItemStatus>> = {
  Available: 'available',
  'Low stock': 'low_stock',
  'Out of stock': 'out_of_stock',
};

interface FilterState {
  query: string;
  /** UI display label. Forwarded to the API only when it maps to a
   *  status the backend view can compute (see ``STATUS_CODE_BY_LABEL``). */
  status: InventoryStatus | 'all';
  /** Item-tier id filter, or 'all'. */
  tierId: string | 'all';
  sortKey: SortKey;
  sortDir: SortDir;
  page: number;
  pageSize: number;
}

interface DataState {
  /** Current page of items, already in UI shape. */
  items: InventoryItem[];
  /** Total matching rows on the server, across all pages. */
  total: number;
  /** True while the active list fetch is in flight. */
  loading: boolean;
  /** Human-readable failure for the last fetch, or null if OK. */
  loadError: string | null;
  /** True while a create is in flight. Used to disable the dialog button. */
  createPending: boolean;
  /** Bumped on every successful fetch. Useful for ``useEffect`` deps. */
  fetchId: number;
}

interface InventoryStore extends FilterState, DataState {
  // Filter mutators (signature preserved from the previous version so
  // existing components don't need to change).
  setQuery: (q: string) => void;
  setStatus: (s: InventoryStatus | 'all') => void;
  setTier: (c: string | 'all') => void;
  setSort: (key: SortKey, dir?: SortDir) => void;
  toggleSort: (key: SortKey) => void;
  setPage: (p: number) => void;
  setPageSize: (n: number) => void;
  resetFilters: () => void;

  // Server actions.
  /** Refetch using the current filter / sort / pagination state. */
  fetch: (opts?: { signal?: AbortSignal }) => Promise<void>;
  /**
   * Fetch a single item by its human-readable number (URL form). Returns
   * ``null`` when the backend 404s (item doesn't exist / was archived);
   * re-throws everything else so the caller can surface a real error.
   * Does *not* mutate any store slice — the detail page is its own scope.
   */
  fetchOne: (
    itemNumber: string,
    opts?: { signal?: AbortSignal },
  ) => Promise<InventoryItem | null>;
  /** Create an item, refetch the list, and return the created row. */
  create: (input: ItemCreateInput) => Promise<InventoryItem>;
}

const initialFilters: FilterState = {
  query: '',
  status: 'all',
  tierId: 'all',
  sortKey: 'id',
  sortDir: 'asc',
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
};

const initialData: DataState = {
  items: [],
  total: 0,
  loading: false,
  loadError: null,
  createPending: false,
  fetchId: 0,
};

function describeError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export const useInventoryStore = create<InventoryStore>()(
  persist(
    (set, get) => ({
      ...initialFilters,
      ...initialData,

      // ── Filter mutators ────────────────────────────────────────────
      setQuery: (query) => set({ query, page: 1 }),
      setStatus: (status) => set({ status, page: 1 }),
      setTier: (tierId) => set({ tierId, page: 1 }),
      setSort: (sortKey, sortDir) => set({ sortKey, sortDir: sortDir ?? 'asc', page: 1 }),
      toggleSort: (sortKey) => {
        const cur = get();
        if (cur.sortKey === sortKey) {
          set({ sortDir: cur.sortDir === 'asc' ? 'desc' : 'asc' });
        } else {
          set({ sortKey, sortDir: 'asc' });
        }
      },
      setPage: (page) => set({ page }),
      setPageSize: (pageSize) => set({ pageSize, page: 1 }),
      resetFilters: () => set(initialFilters),

      // ── Server actions ─────────────────────────────────────────────
      fetch: async (opts) => {
        const s = get();
        set({ loading: true, loadError: null });

        const apiSort: ApiSortField = SORT_KEY_TO_API[s.sortKey] ?? 'item_number';
        const apiDirection = s.sortDir as ApiSortDirection;
        const statusCode =
          s.status === 'all'
            ? undefined
            : STATUS_CODE_BY_LABEL[s.status];

        try {
          const resp = await itemsApi.list(
            {
              q: s.query.trim() || undefined,
              status: statusCode,
              tier_id: s.tierId === 'all' ? undefined : s.tierId,
              sort: apiSort,
              direction: apiDirection,
              limit: s.pageSize,
              offset: (s.page - 1) * s.pageSize,
            },
            { signal: opts?.signal },
          );
          set((prev) => ({
            items: resp.items.map(apiItemToInventoryItem),
            total: resp.total,
            loading: false,
            loadError: null,
            fetchId: prev.fetchId + 1,
          }));
        } catch (err) {
          if ((err as DOMException)?.name === 'AbortError') {
            // Caller cancelled — don't surface as an error.
            return;
          }
          set({
            loading: false,
            loadError: describeError(err, 'Failed to load inventory.'),
          });
        }
      },

      fetchOne: async (itemNumber, opts) => {
        try {
          const row = await itemsApi.getByNumber(itemNumber, { signal: opts?.signal });
          return apiItemToInventoryItem(row);
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) return null;
          throw err;
        }
      },

      create: async (input) => {
        set({ createPending: true });
        try {
          const created = await itemsApi.create(input);
          // Refetch to keep ordering / pagination consistent with the
          // backend — the new row may or may not land on the current
          // page depending on sort + filter. Refetch is cheap and avoids
          // splicing logic that has to mirror server sort exactly.
          set({ createPending: false });
          await get().fetch();
          return apiItemToInventoryItem(created);
        } catch (err) {
          set({ createPending: false });
          throw err;
        }
      },
    }),
    {
      name: 'ims:inventory-filters',
      storage: createJSONStorage(() => localStorage),
      // Persist ONLY the filter slice. Server data + transient state
      // is intentionally rehydrated from the network on mount so the
      // user can't see stale rows.
      partialize: (s): FilterState => ({
        query: s.query,
        status: s.status,
        tierId: s.tierId,
        sortKey: s.sortKey,
        sortDir: s.sortDir,
        page: s.page,
        pageSize: s.pageSize,
      }),
    },
  ),
);

// Convenience selectors — keep components terse.
export const selectInventoryLoading = (s: InventoryStore) => s.loading;
export const selectInventoryItems = (s: InventoryStore) => s.items;
export const selectInventoryTotal = (s: InventoryStore) => s.total;
