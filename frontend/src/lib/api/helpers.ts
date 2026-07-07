/**
 * Small shared helpers for the API clients.
 */

/** Coerce a Postgres NUMERIC (which serialises to a JSON string) or a
 *  plain number into a number. Returns 0 for null/undefined/NaN. */
export function toNum(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** List envelope shape some endpoints wrap their rows in. */
export interface ListEnvelope<T> {
  items: T[];
  total: number;
  limit?: number;
  offset?: number;
}

/**
 * Normalise a list response that may come back either as a bare array or
 * as a ``{ items, total }`` envelope, into a consistent envelope.
 */
export function unwrapList<T>(resp: T[] | ListEnvelope<T>): ListEnvelope<T> {
  if (Array.isArray(resp)) {
    return { items: resp, total: resp.length };
  }
  return {
    items: resp?.items ?? [],
    total: resp?.total ?? resp?.items?.length ?? 0,
  };
}
