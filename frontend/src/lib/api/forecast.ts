/**
 * Forecast API surface — wraps ``/api/v1/forecasts``.
 *
 * A forecast entry is one planning cell: product (optionally a customer) ×
 * year × month → runs. The grid is saved as a signed *batch* of changes
 * (``runs = 0`` deletes a cell), carrying the e-signature ``evidence_id`` from
 * ``POST /v1/auth/reauth`` (action ``forecast.save``).
 *
 * The backend stores months as 1–12; this client maps to/from the grid's
 * 0-based month index so component code stays unchanged.
 */

import { api } from './client';

/** UI-facing entry — ``month`` is 0-based (Jan = 0). */
export interface ForecastEntry {
  id: string;
  productId: string;
  productSku: string;
  productName: string;
  /** null = a product-level ("Unassigned") forecast. */
  customerId: string | null;
  customerName: string | null;
  year: number;
  month: number; // 0-11
  runs: number;
}

/** Wire shape (snake_case, month 1-12). */
interface ApiForecastEntry {
  id: string;
  product_id: string;
  product_sku: string;
  product_name: string;
  customer_id: string | null;
  customer_name: string | null;
  year: number;
  month: number; // 1-12
  runs: number;
}

/** One upsert/delete in a batch save. ``runs = 0`` deletes the cell. */
export interface ForecastChange {
  productId: string;
  customerId: string | null;
  year: number;
  month: number; // 0-11
  runs: number;
}

export interface ForecastSaveResult {
  upserted: number;
  deleted: number;
}

function fromApi(e: ApiForecastEntry): ForecastEntry {
  return {
    id: e.id,
    productId: e.product_id,
    productSku: e.product_sku,
    productName: e.product_name,
    customerId: e.customer_id,
    customerName: e.customer_name,
    year: e.year,
    month: e.month - 1,
    runs: e.runs,
  };
}

export const forecastApi = {
  list: (
    params: { year: number; productId?: string | null; customerId?: string | null },
    opts?: { signal?: AbortSignal },
  ): Promise<ForecastEntry[]> =>
    api
      .get<ApiForecastEntry[]>('/forecasts', {
        query: {
          year: params.year,
          product_id: params.productId ?? undefined,
          customer_id: params.customerId ?? undefined,
        },
        signal: opts?.signal,
      })
      .then((rows) => rows.map(fromApi)),

  save: (input: {
    changes: ForecastChange[];
    evidenceId: string;
  }): Promise<ForecastSaveResult> =>
    api.put<ForecastSaveResult>('/forecasts', {
      json: {
        evidence_id: input.evidenceId,
        changes: input.changes.map((c) => ({
          product_id: c.productId,
          customer_id: c.customerId,
          year: c.year,
          month: c.month + 1,
          runs: c.runs,
        })),
      },
    }),
};
