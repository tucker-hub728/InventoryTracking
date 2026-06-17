/**
 * Products + materials API surface — wraps ``/api/v1/products``,
 * ``/api/v1/products/{id}/materials`` and ``/api/v1/product-materials``.
 *
 * A product is a name + a bill of materials (inventory items × qty per run).
 * NUMERIC fields come back as strings (Postgres NUMERIC → JSON string).
 */

import { api } from './client';

/** Lightweight ``{id, name}`` reference for list badges. */
export interface LinkedRef {
  id: string;
  name: string;
}

export interface Product {
  id: string;
  name: string;
  /** Unique code auto-derived from the name (uppercase slug). */
  sku: string;
  created_at: string;
  updated_at: string;
  created_by_user_id: string;
  updated_by_user_id: string;
  material_count: number;
  customers: LinkedRef[];
  /**
   * Qty of one inventory item consumed per production run — only present on
   * the inverse "products using this item" view (`usingItem`).
   */
  qty_per_run?: string | null;
}

export interface ProductMaterialInput {
  item_id: string;
  qty_per_run: number;
}

export interface ProductCreateInput {
  name: string;
  /** User-supplied, immutable, unique. */
  sku: string;
  materials?: ProductMaterialInput[];
}

export interface ProductUpdateInput {
  name?: string;
}

/** A BOM line joined to its inventory item's live stock. */
export interface ProductMaterial {
  id: string;
  item_id: string;
  item_number: string;
  item_name: string;
  uom_code: string;
  qty_per_run: string;
  qty_on_hand: string;
  /** Available = on-hand minus date-expired lots. What "Available" and the
   *  forecast coverage use; ``qty_on_hand`` is the physical total. */
  qty_available: string;
  status_code: 'available' | 'low_stock' | 'out_of_stock';
}

export interface MaterialCreateInput {
  item_id: string;
  qty_per_run: number;
}

export interface MaterialUpdateInput {
  qty_per_run: number;
}

export const productsApi = {
  list: (params: { q?: string | null } = {}, opts?: { signal?: AbortSignal }) =>
    api.get<Product[]>('/products', {
      query: { q: params.q ?? undefined },
      signal: opts?.signal,
    }),

  get: (id: string, opts?: { signal?: AbortSignal }) =>
    api.get<Product>(`/products/${id}`, { signal: opts?.signal }),

  create: (input: ProductCreateInput) =>
    api.post<Product>('/products', { json: input }),

  update: (id: string, input: ProductUpdateInput) =>
    api.patch<Product>(`/products/${id}`, { json: input }),

  remove: (id: string) => api.delete<Product>(`/products/${id}`),

  /** Products whose bill of materials uses the inventory item (UUID). */
  usingItem: (itemId: string, opts?: { signal?: AbortSignal }) =>
    api.get<Product[]>(`/items/${itemId}/products`, { signal: opts?.signal }),
};

export const materialsApi = {
  /** A product's required materials with live stock + status. */
  list: (productId: string, opts?: { signal?: AbortSignal }) =>
    api.get<ProductMaterial[]>(`/products/${productId}/materials`, {
      signal: opts?.signal,
    }),

  add: (productId: string, input: MaterialCreateInput) =>
    api.post<ProductMaterial>(`/products/${productId}/materials`, { json: input }),

  update: (materialId: string, input: MaterialUpdateInput) =>
    api.patch<ProductMaterial>(`/product-materials/${materialId}`, { json: input }),

  remove: (materialId: string) =>
    api.delete<ProductMaterial>(`/product-materials/${materialId}`),
};
