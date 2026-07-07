/**
 * Transactions API — wraps ``/v1/transactions`` (via the BFF proxy).
 *
 * Two write paths: Receipt (goods in) and Transfer (between locations).
 * Both post a header + one-or-more lines; the lines drive the stock
 * upsert server-side.
 */

import { api } from './client';
import { unwrapList, type ListEnvelope } from './helpers';

export type TransactionType = 'receipt' | 'transfer';

export interface ApiTransactionListRow {
  id: string;
  transaction_no: string;
  transaction_type: string;
  transaction_date: string;
  reference_no: string | null;
  notes: string | null;
  created_by: string;
  created_by_name: string | null;
  line_count: number;
  created_at: string;
}

export interface ApiTransactionLine {
  id: string;
  item_id: string;
  item_code: string | null;
  item_name: string | null;
  from_location_id: string | null;
  from_location_name: string | null;
  to_location_id: string | null;
  to_location_name: string | null;
  lot_number: string | null;
  expiry_date: string | null;
  quantity: string | number;
  unit_of_measure: string;
}

export interface ApiTransactionDetail {
  id: string;
  transaction_no: string;
  transaction_type: string;
  transaction_date: string;
  reference_no: string | null;
  notes: string | null;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  lines: ApiTransactionLine[];
}

export interface ListTransactionsParams {
  type?: TransactionType;
  item_id?: string | null;
  location_id?: string | null;
  limit?: number;
  offset?: number;
}

export interface ReceiptLineInput {
  item_id: string;
  to_location_id: string;
  quantity: number;
  lot_number?: string | null;
  expiry_date?: string | null;
}

export interface ReceiptCreateInput {
  reference_no?: string | null;
  notes?: string | null;
  lines: ReceiptLineInput[];
}

export interface TransferLineInput {
  item_id: string;
  from_location_id: string;
  to_location_id: string;
  quantity: number;
  lot_number?: string | null;
}

export interface TransferCreateInput {
  reference_no?: string | null;
  notes?: string | null;
  lines: TransferLineInput[];
}

export const transactionsApi = {
  list: async (
    params: ListTransactionsParams = {},
    opts?: { signal?: AbortSignal },
  ): Promise<ListEnvelope<ApiTransactionListRow>> => {
    const resp = await api.get<
      ApiTransactionListRow[] | ListEnvelope<ApiTransactionListRow>
    >('/transactions', {
      query: {
        type: params.type,
        item_id: params.item_id ?? undefined,
        location_id: params.location_id ?? undefined,
        limit: params.limit,
        offset: params.offset,
      },
      signal: opts?.signal,
    });
    return unwrapList(resp);
  },

  get: (id: string, opts?: { signal?: AbortSignal }) =>
    api.get<ApiTransactionDetail>(`/transactions/${id}`, { signal: opts?.signal }),

  receipt: (input: ReceiptCreateInput) =>
    api.post<ApiTransactionDetail>('/transactions/receipt', { json: input }),

  transfer: (input: TransferCreateInput) =>
    api.post<ApiTransactionDetail>('/transactions/transfer', { json: input }),
};
