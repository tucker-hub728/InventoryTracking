# Finance CSV export (RPT-001)

> The system shall provide a CSV export (full data dump) for finance, who apply
> their own downstream math; the export is the current-state, full-column
> output.
>
> — CellReady SRS Consolidated Amendment 9+10 by Release (Aug 13, 2026;
> v2 rev. Blane Larson Aug 18, 2026)

Two representations of the **same rows**, both gated on `inventory:view`, both
audited, neither e-signed:

| Endpoint | Shape | Who uses it |
|---|---|---|
| `GET /v1/exports/inventory.xlsx` | Tabbed workbook — a summary tab matching the screen, then one tab per item | The **Export** button |
| `GET /v1/exports/inventory.csv` | One flat sheet, all 55 columns | No button. The exact-decimal reconciliation artefact, and RPT-001 as literally written |

Both are built by the same `_gather()` in `routes.py`, so they cannot disagree
about the data — only about layout.

> **The workbook is a deviation from RPT-001**, which says "CSV export (full
> data dump) … full-column output". The client asked for tabs on 2026-08-25
> after seeing the flat file. The CSV is kept unchanged alongside it so the
> requirement is still satisfiable, and so there is always an artefact with
> exact decimals to reconcile against (the workbook writes `Decimal` as
> `float`, which is a real precision change even if it is safe at these
> magnitudes).

### Workbook structure

* **Tab 1** — the tier summary: SKU, Name, Consumable, On hand, UoM, Stock
  status, Awaiting release, On order, Inventory $, On PO $, Reorder at,
  Updated. Each SKU is an internal hyperlink to that item's tab.
* **Tabs 2…N** — one per item that has stock, an arrival, or an open order. A
  header block of that item's facts and totals, then its detail rows. An item
  with none of those gets a summary line but **no tab** (it would be empty) and
  its SKU stays plain text rather than becoming a link that lands nowhere.

Sheet names are the item number, subject to Excel's rules: ≤ 31 characters,
none of `[ ] : * ? / \`, unique case-insensitively. Collisions get a `~2`
suffix rather than being truncated into each other.

Numbers and dates are written as **native Excel types** with display formats,
not as strings — the main reason to ship a workbook at all, since finance can
sum and sort without a text-to-columns pass. The blank-not-zero rule still
holds: an unpriced lot is a genuinely empty cell.

The button lives on each tier page (`/inventory/cr`, `/ay`, `/fg`) beside the
filter pills and is scoped to that tier plus the current search box. It is
**not** scoped by the filter pill — a "full data dump" that silently dropped
rows because *Below reorder* happened to be selected is the kind of thing
finance discovers a quarter later.

## The shape: four row kinds in one file

The client chose one row per (lot × location). Three facts finance needs do not
live at that grain, so each gets its own `row_kind` and its own columns, blank
on the others:

| `row_kind` | one row per | quantity column | money column |
|---|---|---|---|
| `on_hand` | active allocation, grouped to (lot × location) | `qty_on_hand` | `extended_value_amount` |
| `awaiting_release` | lot that arrived but is not yet received to inventory | `qty_awaiting_release` | `extended_value_amount` |
| `on_order` | open order line with quantity outstanding | `qty_on_order` / `qty_on_order_packs` | `extended_value_amount` |
| `item_valuation` | item (always, even with no stock) | `item_qty_*` | `item_ui_inv_value_amount`, `item_ui_po_value_amount` |

Every money and quantity column is populated on **exactly one** row kind, so
`SUM(...) GROUP BY row_kind` is always meaningful and nothing double-counts.
Filter to one kind before summing.

**Always filter by `row_kind` before you sum anything.** A `SUM` over the whole
`extended_value_amount` column adds on-hand stock, unplaced arrivals and
unfilled purchase orders into a number that means nothing.

## Reconciling against the app

The detail rows and the item page are computed by different code paths on
purpose — one from allocations, one from the movement ledger. They agree while
the data is consistent, and the file carries both so you can check rather than
take it on faith:

```
SUM(extended_value_amount) WHERE row_kind='on_hand'  GROUP BY item_id
    == item_ui_inv_value_amount  (on that item's row_kind='item_valuation' row)

SUM(extended_value_amount) WHERE row_kind='on_order' GROUP BY item_id
    == item_ui_po_value_amount
```

`backend/tests/smoke_finance_export.py` asserts both against live data.

Three legitimate reasons the first equality can break:

1. **Unpriced lots.** A lot with no `unit_price_amount` contributes nothing to
   either side. Detectable: `has_unit_price = false`.
2. **Work in progress.** Material issued to an open kit sits on a production
   node. The export excludes production nodes and the ledger has already
   debited it, so both sides agree — but that material is in the building and
   neither number shows it. Open question with the client.
3. **A real data-integrity bug** — an allocation with no matching ledger
   movement, or the reverse. That is what this reconciliation is for.

`awaiting_release` is in neither total by design, which is why it is its own
row kind (see below).

## Columns that are misread without their companion

| Column | Companion | What the companion prevents |
|---|---|---|
| `extended_value_amount` | `has_unit_price`, `value_basis` | A blank is "no price recorded". It is **never** `0` — a zero would say the stock is worthless when what we know is nothing. |
| `lot_number` | `lot_number_is_synthetic` | `AUTO-20260821-2` is a machine-minted placeholder meaning *no supplier lot number was captured*, not a vendor batch. |
| `lot_release_state` | `release_state_applies` | An empty cell means *no release workflow applies* — the normal case for every consumable and raw material — not "not released". The most misreadable column in the file. |
| `is_expired` | `has_expiration_date` | `false` can mean "in date" or "no date was ever recorded". |
| `qty_on_order` | `qty_on_order_packs`, `units_per_pack` | `qty_on_order` is in consume units; the price is per **order** unit. Divide the wrong pair and the unit price looks wrong by a factor of `units_per_pack`. |

**The two price columns are separate on purpose.** `unit_price_per_consume_unit`
($0.95/Each) and `unit_price_per_order_unit` ($95.00/Box) never share a header.
One `unit_price` column carrying both is a 100× error that reads as plausible.

## Things worth knowing before you do arithmetic

- **Values are unrounded.** A per-consume-unit price carries 6 decimal places
  because "$95.00 over a pack of 3" does not divide evenly. Round at the end of
  your calculation, not per row — rounding each row then summing gives a
  different total.
- **Inventory value includes expired stock.** It follows `qty_on_hand`, matching
  the item page. Use `is_expired` to exclude it if your policy differs.
- **Quantities are in consume units** (`uom`) everywhere except
  `qty_on_order_packs`. A blank `uom` means nobody recorded one; the quantity is
  still in consume units.
- **`awaiting_release` rows have no location** — that is what "arrived, not yet
  received to inventory" means. This stock is on site and paid for but is in
  neither the on-hand total nor the item page's Inventory $. Whether it is an
  asset at month-end is a finance policy call; the file gives you the quantity,
  the price and the PO so you can make it.
- **Free-text cells beginning with `=`, `+`, `-`, `@` or a tab are prefixed with
  an apostrophe.** That is a CSV-injection guard (Excel would otherwise execute
  them as formulas). Strip the leading `'` if you are matching on exact text.
- **`export_generated_at`** is the same value on every row — the as-of stamp,
  and it also names the file.

## Implementation notes

- `backend/app/exports/` — `csv_writer.py` (column contract + formatting),
  `rows.py` (row builders), `repository.py` (five bulk queries), `routes.py`.
- The on-hand query mirrors `kit_repo.item_stock_by_node_lot` predicate for
  predicate, so the export cannot disagree with the item drill-down's
  "Stock by location" tab.
- On-order reuses `inv_repo.outstanding_order_units_expr()` — the same
  expression `compute_item_valuations` uses — so the per-line rows sum to the
  item-level total *by construction* rather than by coincidence.
- Whole `Response`, not `StreamingResponse`: the BFF proxy buffers the body
  anyway, a streaming response would hold a pool connection for its lifetime,
  and an error mid-stream becomes a truncated file that claims success.
- The BFF proxy forwards `Content-Disposition` (added for this) but deliberately
  not `Content-Length` — undici decompresses gzip transparently, so the upstream
  length would be the compressed count and would truncate the body.
- Auditing: one `audit.audit_events` row per download, subject table
  `app.inventory_exports`, carrying row count and byte count. This honours
  `docs/backend-data-structure.md` §10.8 without building the `audit.export_jobs`
  table specced there — its `file_url` / `completed_at` columns describe an
  async job writing to object storage, and this system has neither.
- `MAX_EXPORT_ROWS = 250_000` is an OOM backstop, not a page size; overflow is a
  422, never a silent truncation.
- `openpyxl` was added to the backend runtime dependencies for the workbook.
- **Known duplication:** the summary tab's "Awaiting release beats Low stock"
  rule now exists in three places — `summary_status_label` in
  `xlsx_writer.py`, `coveredByArrivals` in
  `frontend/src/components/shared/stock-status-badge.tsx`, and
  `_covered_by_arrivals` in `backend/app/planning/repository.py` (a SQL
  expression, so not callable on plain values). Worth collapsing; recorded here
  rather than left silent.
- **Dev-environment trap:** the backend runs `uvicorn --reload`. A reload
  cannot complete while a long-lived SSE connection is open, and the
  notifications bell holds one per browser tab — so editing a backend file with
  the app open in a browser wedges the API (health times out; Postgres shows
  only a couple of connections, so it is *not* pool exhaustion). Fix:
  `docker restart cellready-backend`.

## Open questions for the client

1. Is `awaiting_release` stock an asset at month-end?
2. Should WIP on production floors appear at all? Today it is invisible in both
   the export and the item page.
3. Exact or 2dp per row for `extended_value_amount`? Currently exact.
4. Should the button export the current tier (today) or the whole catalogue?
5. Should there be a separate `inventory:export` permission? Today anyone who
   can view inventory can take a priced copy off-system. `audit:export` already
   exists in `PERM_MATRIX` unused, if a split is ever wanted.
6. The file carries supplier names, PO references and unit prices and lands
   unencrypted in a Downloads folder. Within the client's data-classification
   policy?
