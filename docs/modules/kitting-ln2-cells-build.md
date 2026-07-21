# Kitting — LN2 cell selection & per-line returns · BUILD PLAN (`kitting04`)

> **Status:** `plan 2026-07-21` — scope agreed, **not yet implemented**.
> **Builds on:** [`kitting-wip-build.md`](kitting-wip-build.md) (`kitting03`, applied). Parent: [`kitting.md`](kitting.md).

---

## 1. Why

Three gaps, all confirmed against the dev database on 2026-07-21.

**G1 — LN2 is picked by the box, not the vial.** `item_stock_by_node` groups allocations by
`location_node_id`, so a cryobox collapses to a single number (*Box Cassette 007 · 8*). The operator
picks the box and a quantity; `allocations_for_item_at_node` then drains cells FIFO by expiry. Nobody
chooses which vials leave, and nobody sees which ones did.

**G2 — Material cannot be returned into LN2 at all.** `_require_placeable` allows only `shelf` and
`sub_location`, so back-flush and cancel reject a box outright. LN2-sourced material has nowhere
correct to go back to.

**G3 — Cancel never asks where the stock goes.** It silently returns each line to
`return_location_node_id ?? source_location_node_id`. That is a sensible default but a poor one to
apply invisibly to a destructive, irreversible action.

### The governing fact

```
node_type    | allocs | gridded | max_qty
box          |     19 |      19 |       1     ← every cell holds exactly ONE unit
shelf        |     65 |       0 |     270
sub_location |      4 |       0 |      15
flat         |      3 |       0 |       3
```

A **cryobox cell is one vial of one lot**, enforced by `uq_lot_allocations_cell`
— `UNIQUE (location_node_id, grid_row, grid_col) WHERE is_active AND grid_row IS NOT NULL`.
So for LN2, *quantity is a consequence of which cells you picked*, never a number you type. Shelves
are the opposite: bulk quantity, no grid. **Every screen below has to switch behaviour on that.**

---

## 2. Decisions locked (user, 2026-07-21)

| # | Decision |
|--|--|
| D1 | **Cancel asks per line**, with each line's picker pre-selected to the location it was pulled from. |
| D2 | **Issue from LN2 = visual grid, click cells.** Issued qty equals the number of cells selected — it is not typed. |
| D3 | **Returns into LN2 are allowed, and the operator picks the free cells** (not auto-assigned). |
| **D4** | **Cells are how you choose; the BOX is what you record and display.** Once cells are picked, every downstream surface — kit line, ledger, activity log, movement row — names the **location (box)**, never a cell coordinate. |
| **D5** | **The LN2 tank hierarchy is left exactly as built.** No restructuring in this work. |

### 2.1 Spec verification (2026-07-21) — why D4 matters

Checked before building. Two findings, and D4 is what resolves the first:

**The client's own kit reconciliation table** (`Transaction_Spec` §2, Table 3) records LN2 as
**`Tank 2, Cassette X`** — a *location name*, never a cell coordinate. `REQ-2026-07-15-LOC-001`
likewise models LN2 as three levels ending at **rack**, and its note calls the earlier flat grid a
mistake that *"did not capture the quadrant layer"*. Read alone, that argues against cell-level
kitting entirely.

**D4 reconciles it.** The conflict was only ever about *what gets recorded*, not *how the operator
chooses*. Physically an operator pulls specific vials, so the picker works at cell level; the system
then records and displays the box, exactly as the client's table does. This costs no schema change —
`stock_movements.to/from_location_node_id` already points at the **box**, and the cell lives on the
`lot_allocations` row (§B5). So the ledger and activity log stay spec-shaped for free.

**Second finding — noted, NOT acted on (D5).** The built LN2 tree is
`tank_quadrant → rack / cryo_box_rack → cassette → box(grid)`, with no distinct `tank` node, versus
`REQ-2026-07-15-LOC-001`'s `tank → quadrant → rack`. That divergence pre-dates this work and is a
question for the client; this build neither depends on it nor deepens it.

---

## 3. Model

Nothing about the WIP model changes. Issue still moves material source → production node, returns
still move the original lot back (`kitting03`). What changes is **which allocation rows** are chosen,
and **who chooses them**.

```
BULK  (shelf / sub_location / flat)   type a quantity  → FIFO by expiry across lots
GRID  (box)                           pick N cells     → those exact allocation rows, qty 1 each
```

**The production node stays bulk.** A production floor is a `flat` node with no grid, so material
issued from 6 different cryobox cells lands as ordinary bulk WIP on the floor. That is correct and
intentional: on the bench the vials are out of the box. It does mean a vial's original cell is *not*
reserved while the kit is open — hence D3 (the operator picks the destination cells on the way back),
not an automatic return-to-origin.

---

## 4. Backend

### B1 · Per-node stock must expose cells
`item_stock_by_node` currently returns `{item: {node: qty}}`. Add a parallel
`item_cells_by_node(session, item_ids) -> {item: {node: [{allocation_id, grid_row, grid_col, lot_id, lot_number, expiration_date}]}}`
for grid nodes only. The existing bulk map is unchanged, so nothing that reads it breaks.

`KitLineSourceOption` gains `is_grid: bool` and `cells: list[CellOption]` (empty for bulk nodes).

### B2 · Issue accepts explicit cells
`IssueLineInput` gains `cell_allocation_ids: list[str] = []`.

- **Empty** → today's behaviour (bulk, FIFO). Unchanged for shelves.
- **Non-empty** → `issued_qty` must equal `len(cell_allocation_ids)` (422 `cell_count_mismatch`),
  every id must be an active allocation of that item at that node (422 `invalid_cell`), and
  `_move_to_production` consumes *those* rows instead of walking FIFO.

### B3 · Placement into a grid node
`_require_placeable` grows to accept `box` **only when** the caller supplies target cells.
New `ReturnCellInput {grid_row, grid_col}`; `ReturnExcessRequest` and the new cancel payload carry
`return_cells: list[ReturnCellInput]`.

Guards: cell count must equal the returned quantity; each target cell must be free
(`uq_lot_allocations_cell` is the backstop, but we check first for a clean 422 `cell_occupied`);
the cell must be inside the box's `rows × cols`.

### B4 · Cancel takes a per-line payload
`CancelRequest` gains `lines: list[CancelLineInput]` where
`CancelLineInput {line_id, return_location_node_id, return_cells?}`.

- Omitted entirely → current behaviour preserved (returns to source). The smoke test and any
  script-driven cancel keep working.
- Supplied → must cover **every** line with `on_floor > 0` (422 `cancel_lines_missing`), so the UI
  can never silently drop a component.

### B5 · Movement rows
Unchanged. One `backflush` per lot drawn, `from = production node`, `to = the box`. For a grid return
the `to_location_node_id` is the box; the cell lives on the `lot_allocations` row, exactly as the
Location System already does it.

---

## 5. Frontend

### F1 · `CellGridPicker` (new, `components/reconciliation/`)
Renders a box's `rows × cols` as a grid. Two modes:

| Mode | Cells shown | Click target | Reads |
|--|--|--|--|
| `source` | occupied cells, with lot + expiry on hover | select a vial to pull | earliest-expiry cells flagged so FIFO stays the easy path |
| `destination` | free cells, occupied ones disabled | choose where a vial lands | count needed vs. count chosen |

Selected count is always shown against the target (`4 of 6 selected`). Reuses `LocationTreePicker`
for choosing *which box*; the grid appears beneath once a grid node is selected.

### F2 · Issue step
When a line's chosen source is a grid node, the Issued number input becomes **read-only and derived**
— it displays the selected-cell count. Bulk sources keep the editable number input exactly as today.
This is the visible consequence of D2 and needs to read as deliberate, not broken: label it
*"set by cell selection"*.

### F3 · Return dialog
After picking the return location, if it is a box, show `CellGridPicker` in `destination` mode.
The Return button stays disabled until `cells.length === qty`.

### F4 · Cancel dialog (replaces the `useConfirm` call)
A real dialog, not a confirm: one row per line with `on_floor > 0`, each with quantity (fixed, read
-only), a location picker pre-set to its source, and the grid picker when that location is a box.
Keeps the "N units will be returned" warning. Draft cancel keeps the simple confirm — nothing moved.

---

## 6. Test plan

Extends `smoke_kitting.py` + a BFF suite.

1. Source options mark a box `is_grid` with its occupied cells; a shelf stays bulk.
2. Issue with explicit cells consumes **exactly those** allocation rows (assert by id).
3. `issued_qty ≠ len(cells)` → 422 `cell_count_mismatch`.
4. A cell id not at that node → 422 `invalid_cell`.
5. Bulk issue with no cells still works (regression — shelves unchanged).
6. Return into a box places into the chosen cells; `lot_allocations` shows the right `grid_row/col`.
7. Return into an occupied cell → 422 `cell_occupied`.
8. Cancel with a per-line payload returns each line to its own chosen location.
9. Cancel covering only some lines → 422 `cancel_lines_missing`.
10. Cancel with no payload still returns to source (regression).
11. Round trip: pull 3 vials from a box, cancel, return to 3 different cells — box total unchanged,
    lot identity and expiry preserved.

---

## 7. Risks

- **Grid returns can deadlock a cancel** if a box has filled up while the kit was open. The operator
  can pick any other box (the picker is not restricted to the origin), so this is a UX prompt, not a
  dead end — but the error copy has to say that.
- **`issued_qty` becoming derived** is the one behaviour change existing users will feel. Bulk lines
  are untouched, so it is scoped to LN2.
- **Concurrency**: two operators returning into the same cell. `uq_lot_allocations_cell` makes the
  loser fail at the DB, and we surface it as `cell_occupied` rather than a 500.

## 8. Out of scope

- Re-arranging cells within a box (Location System's job).
- Reserving the origin cell for the duration of a kit — deliberately not done, see §3.
- Grid selection for `production_output` placement: an AY/FG is bulk-placed to a shelf today, and
  nothing in the spec asks for a box there.
