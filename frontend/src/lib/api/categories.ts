/**
 * Item-categories API surface — wraps ``/api/v1/item-categories``.
 *
 * Categories carry a ``kind`` (purchased / built) that decides whether their
 * items can have a BOM ("Product"). Create / update / delete are electronically
 * signed: each carries an ``evidence_id`` + ``reason``.
 */

import { api } from './client';

export type CategoryKind = 'purchased' | 'built';
export type CategoryTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface ApiCategory {
  id: string;
  name: string;
  /** Item-number type prefix (e.g. ``CR``) that fronts every SKU here. */
  prefix: string;
  kind: CategoryKind;
  tone: string;
  is_seeded: boolean;
  item_count: number;
  created_at: string;
  updated_at: string;
}

export interface CategoryCreateInput {
  name: string;
  prefix: string;
  kind: CategoryKind;
  tone: CategoryTone;
  evidence_id: string;
  reason: string;
}

export interface CategoryUpdateInput {
  name?: string;
  prefix?: string;
  tone?: CategoryTone;
  evidence_id: string;
  reason: string;
}

export interface CategoryDeleteInput {
  evidence_id: string;
  reason: string;
}

export const categoriesApi = {
  list: (opts?: { signal?: AbortSignal }) =>
    api.get<ApiCategory[]>('/item-categories', { signal: opts?.signal }),

  get: (id: string, opts?: { signal?: AbortSignal }) =>
    api.get<ApiCategory>(`/item-categories/${id}`, { signal: opts?.signal }),

  create: (input: CategoryCreateInput) =>
    api.post<ApiCategory>('/item-categories', { json: input }),

  update: (id: string, input: CategoryUpdateInput) =>
    api.patch<ApiCategory>(`/item-categories/${id}`, { json: input }),

  /** DELETE with a body (evidence + reason) — soft-deletes the category. */
  remove: (id: string, input: CategoryDeleteInput) =>
    api.delete<ApiCategory>(`/item-categories/${id}`, { json: input }),
};
