/**
 * Vendor API surface — wraps ``/api/v1/vendors``.
 *
 * Includes update + soft-delete (Chunk A). Every PATCH / DELETE writes
 * an ``audit.audit_events`` row server-side; the UI doesn't need to
 * do anything extra.
 */

import { api } from './client';

export interface Vendor {
  id: string;
  name: string;
  contact_email: string | null;
  phone: string | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface VendorCreateInput {
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
export interface VendorUpdateInput {
  name?: string;
  contact_email?: string | null;
  phone?: string | null;
  notes?: string | null;
  is_active?: boolean;
}

export const vendorsApi = {
  list: (opts?: { activeOnly?: boolean; signal?: AbortSignal }) =>
    api.get<Vendor[]>('/vendors', {
      query: { active_only: opts?.activeOnly ?? true },
      signal: opts?.signal,
    }),

  get: (id: string, opts?: { signal?: AbortSignal }) =>
    api.get<Vendor>(`/vendors/${id}`, { signal: opts?.signal }),

  create: (input: VendorCreateInput) =>
    api.post<Vendor>('/vendors', { json: input }),

  /** Partial update. Returns the updated row. */
  update: (id: string, input: VendorUpdateInput) =>
    api.patch<Vendor>(`/vendors/${id}`, { json: input }),

  /**
   * Soft delete (sets ``is_active=false``). Idempotent — calling
   * again on an already-inactive vendor returns the current state
   * without writing a second audit row. To reactivate, PATCH with
   * ``{ is_active: true }``.
   */
  deactivate: (id: string) => api.delete<Vendor>(`/vendors/${id}`),
};
