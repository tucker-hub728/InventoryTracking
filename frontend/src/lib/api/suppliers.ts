/**
 * Supplier API surface — wraps ``/api/v1/suppliers``.
 *
 * Includes update + soft-delete (Chunk A). Every PATCH / DELETE writes
 * an ``audit.audit_events`` row server-side; the UI doesn't need to
 * do anything extra.
 */

import { api } from './client';

export interface Supplier {
  id: string;
  name: string;
  contact_email: string | null;
  phone: string | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface SupplierCreateInput {
  name: string;
  contact_email?: string | null;
  phone?: string | null;
  notes?: string | null;
  is_active?: boolean;
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
}

export const suppliersApi = {
  list: (opts?: { activeOnly?: boolean; signal?: AbortSignal }) =>
    api.get<Supplier[]>('/suppliers', {
      query: { active_only: opts?.activeOnly ?? true },
      signal: opts?.signal,
    }),

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
};
