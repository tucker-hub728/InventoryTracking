/**
 * Customers API surface — wraps ``/api/v1/customers``.
 *
 * A customer is simple master data: a name, optional contact + email. Customers
 * are NOT linked to inventory items — a shipment names a customer at ship time.
 */

import { api } from './client';
import { fetchAllRows } from './paging';

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
  /** Every matching customer. Every caller holds the whole list (pickers, the
   *  Customers page), so this walks the pages — the server's default page of
   *  500 would otherwise drop customer 501 without a word. 1000 is the
   *  server's ceiling on ``limit`` for this endpoint. */
  list: (
    params: { q?: string | null } = {},
    opts?: { signal?: AbortSignal },
  ): Promise<Customer[]> =>
    fetchAllRows(
      (page) =>
        api.get<Customer[]>('/customers', {
          query: { q: params.q ?? undefined, ...page },
          signal: opts?.signal,
        }),
      1000,
    ),

  get: (id: string, opts?: { signal?: AbortSignal }) =>
    api.get<Customer>(`/customers/${id}`, { signal: opts?.signal }),

  create: (input: CustomerCreateInput) =>
    api.post<Customer>('/customers', { json: input }),

  update: (id: string, input: CustomerUpdateInput) =>
    api.patch<Customer>(`/customers/${id}`, { json: input }),

  remove: (id: string) => api.delete<Customer>(`/customers/${id}`),
};
