/**
 * Customers API surface — wraps ``/api/v1/customers``.
 *
 * A customer has a name, optional contact + email, and links to many
 * finished-good **items** (the link set is sent as ``item_ids`` on
 * create/update).
 */

import { api } from './client';

/** Lightweight ``{id, name}`` reference for list badges. */
export interface LinkedRef {
  id: string;
  name: string;
}

export interface Customer {
  id: string;
  name: string;
  contact_person: string | null;
  email: string | null;
  created_at: string;
  updated_at: string;
  created_by_user_id: string;
  updated_by_user_id: string;
  /** Linked finished-good items (label is "ITEM# · description"). */
  items: LinkedRef[];
}

export interface CustomerCreateInput {
  name: string;
  contact_person?: string | null;
  email?: string | null;
  item_ids?: string[];
}

/**
 * Partial update. ``item_ids``, when present, REPLACES the linked set;
 * omit it to leave links unchanged, send ``[]`` to clear them.
 */
export interface CustomerUpdateInput {
  name?: string;
  contact_person?: string | null;
  email?: string | null;
  item_ids?: string[];
}

export const customersApi = {
  list: (params: { q?: string | null } = {}, opts?: { signal?: AbortSignal }) =>
    api.get<Customer[]>('/customers', {
      query: { q: params.q ?? undefined },
      signal: opts?.signal,
    }),

  get: (id: string, opts?: { signal?: AbortSignal }) =>
    api.get<Customer>(`/customers/${id}`, { signal: opts?.signal }),

  create: (input: CustomerCreateInput) =>
    api.post<Customer>('/customers', { json: input }),

  update: (id: string, input: CustomerUpdateInput) =>
    api.patch<Customer>(`/customers/${id}`, { json: input }),

  remove: (id: string) => api.delete<Customer>(`/customers/${id}`),
};
