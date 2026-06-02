/**
 * Units-of-measure API — read only.
 *
 * New units land via migration, not API, because items FK to ``code``
 * and ad-hoc additions would defeat that contract.
 */

import { api } from './client';

export interface UnitOfMeasure {
  code: string;
  label: string;
  is_discrete: boolean;
}

export const uomsApi = {
  list: (opts?: { signal?: AbortSignal }) =>
    api.get<UnitOfMeasure[]>('/uoms', { signal: opts?.signal }),
};
