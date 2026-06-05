/**
 * Customers API surface — wraps ``/api/v1/customers``.
 *
 * A customer has a name, optional contact + email, and links to many
 * products (the link set is sent as ``product_ids`` on create/update).
 */

import { api } from './client';
import type { LinkedRef } from './products';

export interface Customer {
  id: string;
  name: string;
  contact_person: string | null;
  email: string | null;
  created_at: string;
  updated_at: string;
  created_by_user_id: string;
  updated_by_user_id: string;
  products: LinkedRef[];
}

export interface CustomerCreateInput {
  name: string;
  contact_person?: string | null;
  email?: string | null;
  product_ids?: string[];
}

/**
 * Partial update. ``product_ids``, when present, REPLACES the linked set;
 * omit it to leave links unchanged, send ``[]`` to clear them.
 */
export interface CustomerUpdateInput {
  name?: string;
  contact_person?: string | null;
  email?: string | null;
  product_ids?: string[];
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
