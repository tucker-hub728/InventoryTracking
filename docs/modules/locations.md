# Locations / Storage Hierarchy — Backend Table Brief (v2, §4.1)

> **Source of truth**: `temp/CellReady_Inventory_System_Technical_Requirements_v2.pdf` §4.1 (LN2 Tank Storage Hierarchy).
> **Status (2026-06-22)**: backend **implemented + migration `a9b0c1d2e3f4` APPLIED** to the dev DB (via docker; dev head now `a9b0c1d2e3f4`; seed location data wiped per decision). **Frontend implemented** too — grid visualization (`box-grid.tsx`), cassette/cryo-box-rack create + box grid dims + quadrant dedication, cell placement, e-signed transfer/consume, resize. tsc + eslint clean; backend reloaded healthy with new routes live.
> Builds on the existing Location System (`app/models/locations.py`, migrations `d6e7f8a9b0c1` → `f8a9b0c1d2e3`) and the GxP ledger (`app.stock_movements`, `app/models/inventory.py`). This file describes only the **v2 hierarchy** deltas; anything it doesn't mention is unchanged.

---

## 0. Decisions driving this work (user-confirmed, 2026-06-22)

| Fork | Decision |
|--|--|
| Cassette vs Cryo Box Rack | **Two distinct node types** — split today's single `cassette_rack`. |
| Cassette / Cryo Box Rack role | **Pure container / navigation levels — no grid of their own.** They simply hold Boxes. |
| Where the grid lives | On the **Box**. |
| Box grid shape | **Depends on its parent**: Box under a **Cassette** → `1 × N` (single column); Box under a **Cryo Box Rack** → free `R × C`. |
| What a sub-slot is | A `(row, col)` **cell of the Box's grid** — holds one item (lot/vial/bag) directly. |
| Cell representation | **Coordinate on the allocation** (`grid_row`, `grid_col`) — no per-cell node. |
| Cell quantity | **1 cell = 1 unit** (`qty = 1`): one vial/bag/unit per cell. |
| Lots per Box | **Multiple lots allowed in one Box** — each cell is independent. |
| Leaf storage nodes | **`box`** and **`flat`** (the only nodes that can hold a lot). Cassette/Cryo Box Rack are nav-only. |
| Grid dimensions | **Set at creation, resizable later** — never below the highest occupied row/col. |
| Quadrant dedication | **Customer XOR product, advisory** — inherited by descendants, placement *not* blocked. |
| **Movement tables** | **`allocation_movements` is DROPPED.** Quantity changes (consume / transfer) go to the existing **`stock_movements`** ledger. `lot_allocations` is the **only new table** (current placement state). |
| **consume** | A real unit-out → posts a `stock_movements` dispense/discard row (on-hand drops, reconciles) **and is e-signed** (`inventory:sign` + reauth). |
| **transfer** | Cell→cell → `stock_movements` `transfer_out`/`transfer_in` pair, using **new node FK columns** on `stock_movements`. |
| **place** | Quantity-neutral → `lot_allocations` row + `audit.audit_events` only (no ledger row). |

### Resulting hierarchy

```
Tank Quadrant ─▶ Rack ─▶ ┌─ Cassette       ─▶ Box (1 × N grid)  ─┐
                         └─ Cryo Box Rack  ─▶ Box (R × C grid)  ─┘
                                                  │
                                                  └─▶ Sub-slot = (row, col) cell  ← item placed here

flat  (Kanban / Lab / QC / Engineering / Materials)  — unchanged, parent-less leaf
```

Only **Box** and **flat** store inventory. `sub_slot` is no longer a node — it's a coordinate on the allocation. Legacy `cassette_rack` / `sub_slot` enum values are retired (kept for existing rows, not creatable — see §5).

### Why only one new table

| Concern | Answer | Owned by |
|--|--|--|
| "How much of this lot exists?" (balance) | append-only, immutable, **location-agnostic** ledger | `app.stock_movements` (existing) |
| "What's in cell B3 *right now*?" (placement state) | mutable current-state table + partial-unique index for one-unit-per-cell | **`app.lot_allocations`** (new — can't be done on an immutable log) |
| "What happened to this unit?" (history) | quantity events in the ledger; placement events in the generic audit trail | `stock_movements` + `audit.audit_events` |

`allocation_movements` is removed because its `consume` row was a quantity change kept *outside* the ledger (the source of the known "node stock won't reconcile" gap), and its `place`/`transfer` rows are net-zero noise in a balance ledger. Folding quantity into `stock_movements` is both simpler and more correct.

---

## 1. `meta.location_nodes` — changes

### 1.1 Node taxonomy

| Constant | Before | After |
|--|--|--|
| LN2 levels | `tank_quadrant → rack → cassette_rack → box → sub_slot` | `tank_quadrant → rack → (cassette \| cryo_box_rack) → box` |
| `PARENT_OF` | single parent per type | `cassette → rack`, `cryo_box_rack → rack`, **`box → {cassette, cryo_box_rack}`**. `cassette_rack`/`sub_slot` removed. |
| `STORAGE_NODE_TYPES` (`can_store`) | `{sub_slot, flat}` | **`{box, flat}`** |
| `node_type` CHECK enum | `…, cassette_rack, box, sub_slot, flat` | **add** `cassette, cryo_box_rack`; **keep** `box, flat`; **keep** legacy `cassette_rack, sub_slot` in the enum (existing rows) but no longer creatable |

> `PARENT_OF[box]` now allows a **set** of parent types. The route's parent-type check changes from "exact type" to "type ∈ allowed set" — fail-fast, no auto-correct.

### 1.2 New columns — grid dimensions (on the **Box**)

| col | type | notes |
|--|--|--|
| `grid_rows` | `SMALLINT NULL` | rows in the Box's grid |
| `grid_cols` | `SMALLINT NULL` | cols; **= 1 when the Box sits under a Cassette** |

**Table CHECKs** (node-local):
- `(node_type = 'box') = (grid_rows IS NOT NULL AND grid_cols IS NOT NULL)`
- `grid_rows IS NULL OR grid_rows >= 1`; same for `grid_cols`

**Op-layer rule** (needs the parent's type): Box under a `cassette` ⇒ `grid_cols` must be 1; under `cryo_box_rack` ⇒ free `R × C`. **Resize** (`PUT /v1/location-nodes/{id}/grid`) rejected if new dims fall below the max occupied row/col of that Box's active allocations.

### 1.3 New columns — quadrant dedication (advisory)

| col | type | notes |
|--|--|--|
| `dedicated_customer_id` | `UUID NULL FK → app.customers(id) ON DELETE RESTRICT` | |
| `dedicated_product_id` | `UUID NULL FK → app.products(id) ON DELETE RESTRICT` | |

**Table CHECKs**: exclusive (`NOT (both set)`); quadrant-only (`both NULL OR node_type='tank_quadrant'`).
**Behaviour**: set on create or `PUT …/dedication`; descendants **inherit** the nearest quadrant's value (resolved into `inherited_*` on the detail GET for the UI badge). Placement is **never blocked** (advisory).

---

## 2. `app.lot_allocations` — changes (the only new-table footprint)

Current placement state: a lot mapped to a `(row, col)` cell of a Box. New position columns:

| col | type | notes |
|--|--|--|
| `grid_row` | `SMALLINT NULL` | 1-based row within the parent Box's grid |
| `grid_col` | `SMALLINT NULL` | 1-based col; always 1 for a Box under a Cassette |

**Constraints**:
- Table CHECK: `(grid_row IS NULL) = (grid_col IS NULL)` — both or neither.
- **Single-occupancy + manual placement + gaps**: partial unique index
  `uq_lot_allocations_cell ON (location_node_id, grid_row, grid_col) WHERE is_active AND grid_row IS NOT NULL`.
- **Op-layer rules**:
  - Place into a `box` ⇒ `grid_row`/`grid_col` required, in `1..grid_rows`/`1..grid_cols`, `qty = 1`.
  - Place into a `flat` ⇒ `grid_row`/`grid_col` NULL, `qty > 0`.
  - `override` + `inventory:sign` to place into an occupied cell.

### 2.1 Placement-capacity rules (two independent caps)

1. **Grid capacity (per Box)** — `grid_rows × grid_cols` cells (`4×4` = 16), each single-occupancy. Cells may hold **different lots**.
2. **Lot available quantity** — `SUM(qty)` of a lot's active allocations **≤ the lot's available on-hand** (the `/receiving`-confirmed received qty, ledger-derived via `v_item_stock`). *Unplaced remaining = available − already placed*; each placement decrements it. Received 16 ⇒ ≤ 16 placeable.

Both enforced at the op layer at place/transfer time. A lot with received qty 16 fills one `4×4` Box exactly.

---

## 3. `app.stock_movements` — changes (absorbs location quantity events)

Add node references so the GxP ledger can express node placement/transfer:

| col | type | notes |
|--|--|--|
| `from_location_node_id` | `UUID NULL FK → meta.location_nodes(id) ON DELETE RESTRICT` | source Box/flat for transfer / dispense |
| `to_location_node_id` | `UUID NULL FK → meta.location_nodes(id) ON DELETE RESTRICT` | destination Box/flat for transfer / receipt |

- These mirror the existing `from_location_id`/`to_location_id` (legacy `meta.locations`); the relaxed `ck_movements_locations` check is widened to also accept the node columns (re-introduces, cleanly, what was reverted in `e7f8a9b0c1d2`).
- `(grid_row/grid_col)` cell coordinates for a movement are **not** duplicated onto `stock_movements`; the cell lives on `lot_allocations`. The ledger records the lot/qty/node + e-sign; the allocation records the exact cell.

**Event → ledger mapping**

| Location event | `stock_movements` effect | E-sign | qty |
|--|--|--|--|
| **place** (assign received unit to a cell) | *none* (net-zero; not a quantity event) — `lot_allocations` + `audit_events` only | no (log-only, `inventory:create`) | — |
| **transfer** (cell → cell) | `transfer_out` + `transfer_in` pair (`paired_movement_id`), carrying `from_/to_location_node_id` | yes (existing transfer path) | net-zero (−q / +q) |
| **consume** (pull unit out) | `dispense` (or `discard` for scrap) row, `qty_delta < 0`, `from_location_node_id` set, `destination_text` optional | **yes** (`inventory:sign` + reauth) | on-hand drops |

No change to `MOVEMENT_TYPES`, the immutability triggers, or `v_item_stock`.

---

## 4. Dropped table

`app.allocation_movements` (created in `d6e7f8a9b0c1`) is **dropped**. Its responsibilities move to `stock_movements` (quantity events) and `audit.audit_events` (place/transfer/consume audit trail).

---

## 5. Migration

New revision (down_revision = current head **`f8a9b0c1d2e3`**). Adds: `location_nodes.grid_rows`/`grid_cols`/`dedicated_customer_id`/`dedicated_product_id` + CHECKs; `lot_allocations.grid_row`/`grid_col` + cell CHECK + partial unique index; `stock_movements.from_location_node_id`/`to_location_node_id` + widened `ck_movements_locations`. Updates the `node_type` enum CHECK to allow `cassette`/`cryo_box_rack`. **Drops** `app.allocation_movements`. Reversible. **Not auto-applied** — run `alembic upgrade head` after review (per [[verify-before-migrate]]).

> **Existing data (decided 2026-06-22)**: the seeded `cassette_rack`/`box`/`sub_slot` nodes, their `lot_allocations`, and the `allocation_movements` rows on the **dev DB are wiped** and re-entered under the new model — no data-migration of old placements. One-time dev cleanup run alongside the upgrade (touches only Location System rows).

---

## 6. Not covered here (next, for confirmation)

- API/endpoint signatures (`/grid`, `/dedication`, place-at-cell, transfer, consume payloads).
- The custom grid **visualization UI** (§4.1 nav view, item/lot # at lowest level, click-through) — frontend, separate brief.
- Wiring **unit-OUT / Record Movement** screens to nodes (the legacy `locations`-based dispense picker) so node-placed stock reconciles end-to-end.
- Whether dedication should ever flip to *enforced* later (currently advisory).

---

*End of Locations v2 hierarchy backend brief.*
