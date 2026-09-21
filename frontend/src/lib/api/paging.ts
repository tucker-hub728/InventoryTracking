/**
 * Fetch EVERY row of a paged list endpoint.
 *
 * For pickers and other screens that hold a whole list in memory (a searchable
 * select, a client-side filter). A single ``limit: 200`` request looks complete
 * until the table grows past 200 — then the extra rows silently vanish and the
 * picker says "No matching items" for a SKU that exists. That shipped twice, so
 * there is no number here to outgrow: these walk the pages until the end.
 *
 * ``pageSize`` must not exceed the endpoint's ``le=`` ceiling (larger 422s) —
 * each ``listAll`` wrapper pins it next to the endpoint it calls.
 *
 * Never call an endpoint's ``list`` with a fixed ``limit`` to mean "all rows".
 */

/** Hard stop against a misbehaving endpoint (e.g. one that ignores offset). */
const MAX_PAGES = 1000;

/** Enveloped endpoints — ``{ items, total }``. Stops at ``total``. */
export async function fetchAllPages<T>(
  fetchPage: (page: { limit: number; offset: number }) => Promise<{ items: T[]; total: number }>,
  pageSize: number,
): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await fetchPage({ limit: pageSize, offset: rows.length });
    rows.push(...page.items);
    if (page.items.length === 0 || rows.length >= page.total) break;
  }
  return rows;
}

/** Bare-array endpoints (no ``total``). Stops at the first short page. */
export async function fetchAllRows<T>(
  fetchPage: (page: { limit: number; offset: number }) => Promise<T[]>,
  pageSize: number,
): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await fetchPage({ limit: pageSize, offset: rows.length });
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}
