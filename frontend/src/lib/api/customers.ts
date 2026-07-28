/**
 * Customers API surface — wraps ``/api/v1/customers``.
 *
 * A customer is simple master data: a name, optional contact + email. Customers
 * are NOT linked to inventory items — a shipment names a customer at ship time.
 */

import { api } from './client';

export interface Customer {
  id: string;
  name: string;
  contact_person: string | null;
  email: string | null;
  created_at: string;
  updated_at: string;
  created_by_user_id: string;
  updated_by_user_id: string;
}

export interface CustomerCreateInput {
  name: string;
  contact_person?: string | null;
  email?: string | null;
}

/** Partial update. */
export interface CustomerUpdateInput {
  name?: string;
  contact_person?: string | null;
  email?: string | null;
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
