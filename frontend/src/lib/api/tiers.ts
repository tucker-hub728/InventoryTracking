/**
 * Item-tiers API surface — wraps ``/api/v1/item-tiers``.
 *
 * Tiers carry a ``type`` that decides how the system treats their items for
 * BOMs, kitting, debiting and planning. Create / update / delete are
 * electronically signed: each carries an ``evidence_id`` + ``reason``.
 */

import { api } from './client';

/** The three tiers, fixed by REQ-2026-07-15-ITM-001. Admin-added prefixes live
 *  inside one of these and never constitute a fourth tier. */
export type TierType = 'raw_material' | 'sub_assembly' | 'finished_good';
export type TierTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

/** Tiers whose items are manufactured rather than bought — i.e. the tiers that
 *  may carry a bill of materials (Transaction Spec §1.1: only AY and FG appear
 *  on the left of a BOM rule). */
export const BUILT_TIER_TYPES: readonly TierType[] = ['sub_assembly', 'finished_good'];

/** True when a tier's items are built from a BOM rather than purchased. */
export function isBuiltTier(type: string | null | undefined): boolean {
  return type === 'sub_assembly' || type === 'finished_good';
}

/** Human labels for the three tiers. */
export const TIER_TYPE_LABELS: Record<TierType, string> = {
  raw_material: 'Raw Material',
  sub_assembly: 'Sub-Assembly',
  finished_good: 'Finished Good',
};

export interface ApiTier {
  id: string;
  name: string;
  /** Item-number type prefix (e.g. ``CR``) that fronts every SKU here. */
  prefix: string;
  type: TierType;
  tone: string;
  is_seeded: boolean;
  item_count: number;
  created_at: string;
  updated_at: string;
}

export interface TierCreateInput {
  name: string;
  prefix: string;
  type: TierType;
  tone: TierTone;
  evidence_id: string;
  reason: string;
}

export interface TierUpdateInput {
  name?: string;
  prefix?: string;
  tone?: TierTone;
  evidence_id: string;
  reason: string;
}

export interface TierDeleteInput {
  evidence_id: string;
  reason: string;
}

export const tiersApi = {
  list: (opts?: { signal?: AbortSignal }) =>
    api.get<ApiTier[]>('/item-tiers', { signal: opts?.signal }),

  get: (id: string, opts?: { signal?: AbortSignal }) =>
    api.get<ApiTier>(`/item-tiers/${id}`, { signal: opts?.signal }),

  create: (input: TierCreateInput) =>
    api.post<ApiTier>('/item-tiers', { json: input }),

  update: (id: string, input: TierUpdateInput) =>
    api.patch<ApiTier>(`/item-tiers/${id}`, { json: input }),

  /** DELETE with a body (evidence + reason) — soft-deletes the tier. */
  remove: (id: string, input: TierDeleteInput) =>
    api.delete<ApiTier>(`/item-tiers/${id}`, { json: input }),
};
