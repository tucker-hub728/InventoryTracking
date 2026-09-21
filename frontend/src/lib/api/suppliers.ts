/**
 * Supplier API surface — wraps ``/api/v1/suppliers``.
 *
 * Includes update + soft-delete (Chunk A). Every PATCH / DELETE writes
 * an ``audit.audit_events`` row server-side; the UI doesn't need to
 * do anything extra.
 */

import { api } from './client';
import { fetchAllPages } from './paging';

export interface Supplier {
  id: string;
  name: string;
  contact_email: string | null;
  phone: string | null;
  is_active: boolean;
  notes: string | null;
  /** Order-to-delivery days (PLN-001). `null` means it has not been recorded —
   *  which is NOT zero. The reorder screen treats it as unknown and says so;
   *  zero would read as same-day delivery and suppress the early warning. */
  lead_time_days: number | null;
  created_at: string;
  updated_at: string;
}

export interface SupplierCreateInput {
  name: string;
  contact_email?: string | null;
  phone?: string | null;
  notes?: string | null;
  is_active?: boolean;
  lead_time_days?: number | null;
}

/**
 * Partial update payload. Only set the fields you want to change.
 * Omit a field to leave it alone; send ``null`` to clear a nullable
 * field. Empty objects (no fields) are rejected with 422 ``empty_patch``.
 */
export interface SupplierUpdateInput {
  name?: string;
  contact_email?: string | null;
  phone?: string | null;
  notes?: string | null;
  is_active?: boolean;
  lead_time_days?: number | null;
}

export interface ListSuppliersParams {
  /** Hide deactivated suppliers. Ignored when ``isActive`` is given. */
  activeOnly?: boolean;
  /** true = the Active tab, false = the Deactivated tab. */
  isActive?: boolean;
  /** Free-text over name + contact email. */
  q?: string;
  limit?: number;
  offset?: number;
}

export interface SupplierListResponse {
  items: Supplier[];
  total: number;
  limit: number;
  offset: number;
  /** Unfiltered per-tab counts, so the tab strip can label both tabs. */
  active_total: number;
  inactive_total: number;
}

export const suppliersApi = {
  list: (params: ListSuppliersParams = {}, opts?: { signal?: AbortSignal }) =>
    api.get<SupplierListResponse>('/suppliers', {
      query: {
        active_only: params.activeOnly ?? true,
        is_active: params.isActive,
        q: params.q,
        limit: params.limit,
        offset: params.offset,
      },
      signal: opts?.signal,
    }),

  /**
   * Every supplier, unpaged — for pickers that render the whole list in a
   * searchable select and would otherwise silently show only the first page.
   * Walks every page — a single ``limit: 500`` request dropped supplier 501.
   * 500 is the server's ceiling on ``limit`` for this endpoint.
   */
  listAll: (opts?: { activeOnly?: boolean; signal?: AbortSignal }) =>
    fetchAllPages(
      (page) =>
        api.get<SupplierListResponse>('/suppliers', {
          query: { active_only: opts?.activeOnly ?? true, ...page },
          signal: opts?.signal,
        }),
      500,
    ),

  get: (id: string, opts?: { signal?: AbortSignal }) =>
    api.get<Supplier>(`/suppliers/${id}`, { signal: opts?.signal }),

  create: (input: SupplierCreateInput) =>
    api.post<Supplier>('/suppliers', { json: input }),

  /** Partial update. Returns the updated row. */
  update: (id: string, input: SupplierUpdateInput) =>
    api.patch<Supplier>(`/suppliers/${id}`, { json: input }),

  /**
   * Soft delete (sets ``is_active=false``). Idempotent — calling
   * again on an already-inactive supplier returns the current state
   * without writing a second audit row. To reactivate, PATCH with
   * ``{ is_active: true }``.
   */
  deactivate: (id: string) => api.delete<Supplier>(`/suppliers/${id}`),

  /**
   * The SECOND delete step — stamps ``deleted_at`` and takes the supplier off
   * every screen, including the Deactivated tab, releasing its name for re-use.
   *
   * Only reachable for a supplier that is ALREADY deactivated and that nothing
   * references; the server refuses otherwise and names what is holding it.
   * Super-admin only, and e-signed (action ``supplier.delete``) because it is
   * one-way in the UI — there is no un-delete screen by design.
   *
   * The row itself is never removed: items, lots and order lines FK to it, and
   * the audit trail keeps resolving the name on historic records.
   */
  remove: (id: string, evidenceId: string) =>
    api.post<Supplier>(`/suppliers/${id}/delete`, {
      json: { evidence_id: evidenceId },
    }),
};
