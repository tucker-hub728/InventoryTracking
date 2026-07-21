# Kitting — WIP at Production + Returns · BUILD PLAN (`kitting03`)

> **Status:** `BUILT 2026-07-21` — migration `kitting03` **applied on dev**; backend + frontend complete; `smoke_kitting.py` **33/33** and the §9 BFF suite **22/22**. Supersedes the sketch in [`kitting.md`](kitting.md) §10.1.
> **Why:** the shipped build violates `CellReady_Transaction_Spec_2026-07-01` §2 and leaves `REQ-2026-07-01-TRX-008` unbuilt. See [`kitting.md`](kitting.md) §0.3a for the full correction and how the wrong model got in.
> **Parent doc:** [`kitting.md`](kitting.md) — table design, lifecycle, ERD. This doc is the delivery plan only.

---

## 1. What's wrong today

| # | Defect | Client requirement violated |
|--|--|--|
| D1 | Issued material goes **nowhere** (`kit_issue.to_location = NULL`). It leaves inventory and exists only as numbers on the kit. | `Transaction_Spec` §2: *"Location must be updated from the storage location an item was originally assigned to the production or manufacturing location it is moved to for kitting."* |
| D2 | The production location picker offers **warehouse shelves**, because the picker's `Flat` area was dropped. Operators pick "Warehouse One › Shelf A" as a production floor. | Same — a shelf is not a production or manufacturing location. |
| D3 | **No way to return material** from an in-production kit. Cancel is draft-only; close-out rejects zero output. Material is strandable. | `REQ-2026-07-01-TRX-008` (Must): *"admin/manual transaction to return excess items back into inventory … without assigning them to a lot number, so returned stock is never stranded."* |

---

## 2. Decisions locked (user, 2026-07-21)

1. **TRX-008 scope = partial return + post-issue cancel.** A per-line "Return to inventory" action available any time the kit is in production, *and* cancelling an in-production kit returns everything. This also resolves [`kitting.md`](kitting.md) §99.8 (deferred post-issue cancel).
2. **Production locations are the existing `flat_category='production'` nodes.** All five are already seeded and active — `PROD-CR1` Clean Room 1, `PROD-CR2` Clean Room 2, `PROD-MFG` Manufacturing Floor, `PROD-PD1` PD Lab One, `PROD-PD2` PD Lab Two. **No new locations are created.** They are simply made reachable again in the picker, and the production picker is restricted to *only* them.
3. **Returns move the material back on its ORIGINAL lot** — the allocation is *moved*, not re-minted. *(Revised 2026-07-21 after testing: an earlier draft of this decision minted a fresh unassigned lot, which **silently dropped the expiry date** — material expiring 2026-08-22 returned with `expiration_date = NULL`, so it would never trigger expiry alerting. That is unacceptable in a GMP system and the client PDF explicitly requires expiry alerting to cover all storage locations.)*
   This still satisfies TRX-008: nothing is stranded, because the lot is the material's own **incoming** lot — always live, always ours. TRX-008 forbids binding material to a *production* lot and never requires an operator to assign one; it does not require discarding the incoming lot. Only the **production output** mints a new lot, which is correct — that item was just manufactured.

---

## 3. The model

```
ISSUE          Shelf A  ──(kit_issue, −qty)──▶  PD Lab One        available ↓, WIP ↑
RETURN (any)   PD Lab One ──(backflush, +qty)──▶  Shelf A         available ↑, WIP ↓
CLOSE-OUT      used      → WIP ↓, no movement (already left available at issue)
               leftover  ──(backflush, +qty)──▶  return node
               output    ──(production_output, +good)──▶ output node
```

### 3.1 Two balances, deliberately different

| Balance | Source | Includes WIP? |
|--|--|--|
| **Available on-hand** (`v_item_stock`) | `SUM(qty_delta)` | **No** — `kit_issue` is negative, so it drops at issue. This is what satisfies TRX-001 (50 → 25). |
| **Physical placement** (`lot_allocations`) | per-node rows | **Yes** — the production node holds rows until close-out. This is what satisfies `Transaction_Spec` §2. |

> ⚠ **These two deliberately diverge by the WIP amount while kits are open.** That is correct, not a bug. Any future reconciliation check must compare `v_item_stock` against allocations **excluding production nodes**.

### 3.2 Material at a production node is fungible

Allocations at a production node are **not tagged by kit**. If two kits issue CR-003 into Clean Room 1, the node simply holds the total. That is fine and requires no attribution, because:

- `kit_lines` is the authority for *how much this kit owes back*;
- material is never lot-bound at kitting (TRX-002), so any lot may be drawn when draining;
- each kit only ever removes what it put in, so the total is conserved.

### 3.3 Per-line quantity invariant

```
on_floor = issued_qty + additional_issued_qty − early_returned_qty
leftover = on_floor − used_qty                (computed at close-out)
```

At close-out, `used + leftover = on_floor`, so the kit's contribution to the production node always drains to zero.

---

## 4. Part A — Locations (no migration)

**A1.** `location-tree-picker.tsx` gains a `'production'` area, labelled **"Production / Lab"**, sourced from `locationNodesApi.flat({ category: 'production' })`. `LocationArea` becomes `'ln2' | 'cold' | 'warehouse' | 'production'`. These are root `flat` nodes, so the area group holds them directly (no nesting).

**A2.** `new-kit-dialog.tsx` → `areas={['production']}`. **The production location can now only be a real production/lab floor.** Fixes D2.

**A3.** Production nodes are valid **only** as a kit's production location. They remain invalid for source / output / return, which stay storage leaves (`shelf`, `sub_location`) via `_require_placeable`.

---

## 5. Part B — Migration `kitting03`

`down_revision = "kitting02"`. Forward-only (ledger is append-only), same rationale as `kitting02`.

> **Gotcha:** CHECK names are double-prefixed by the naming convention (`name="ck_kits_x"` → `ck_kits_ck_kits_x`). Use **short** names in `op.*` calls.

**B1. Relax `ck_movements_locations`** so the kit types may set both ends:

| type | before | after |
|--|--|--|
| `kit_issue` | `to` must be NULL | `from` **and** `to` both NOT NULL |
| `kit_additional_issue` | `to` must be NULL | `from` **and** `to` both NOT NULL |
| `backflush` | `from` must be NULL | `from` **and** `to` both NOT NULL |
| `production_output` | unchanged (`to` only) | unchanged |

`ck_movements_type` and `ck_movements_type_sign` are **untouched** — signs do not change, so `v_item_stock` math and every existing on-hand test still hold.

**B2. Add `app.kit_lines.early_returned_qty`** `INTEGER NOT NULL DEFAULT 0` — material handed back *before* close-out (TRX-008). Check `>= 0`.

**B3. Replace `ck_kit_lines_no_overuse`** →
`used_qty IS NULL OR used_qty <= issued_qty + additional_issued_qty − early_returned_qty`

**B4. Add `ck_kit_lines_return_le_issued`** →
`early_returned_qty <= issued_qty + additional_issued_qty`

**No `lot_allocations` change** — verified 2026-07-21: it has no node-type constraint, and its only unique index (`uq_lot_allocations_cell`) is partial on `grid_row IS NOT NULL`, so grid-less production nodes accept multiple allocations already.

---

## 6. Part C — Backend

### C1. `_consume_from_source` → `_move_to_production`
Reduce the source allocation FIFO (by expiry, then age) **and** create an allocation at `kit.production_location_node_id` on the **same lot** (retaining the source lot is not a TRX-002 violation — TRX-002 forbids binding to the *production output* lot). Movement gains `to_location_node_id = production node`.

Applies to **issue** and **additional issue**. The existing `insufficient_source_stock` 422 guard is unchanged.

### C2. New — `POST /kits/{id}/lines/{line_id}/return` (TRX-008)
Return excess from the floor back to inventory. Allowed while `issued` / `in_production`.

- Body: `{ qty, return_location_node_id }`. `qty > 0`.
- Guard: `qty <= on_floor` → else 422 `return_exceeds_on_floor`.
- `_require_placeable(return_location_node_id)` — a storage leaf.
- Reduce the production-node allocation by `qty` (FIFO) and re-allocate the **same lot** at the return node, so expiry and every other lot attribute survive the round trip.
- Write one `backflush` movement **per lot drawn**: `+qty`, `from = production node`, `to = return node`, `lot_id = the original lot` (TRX-003 — an explicit back-flush, never a plain receipt).
- `line.early_returned_qty += qty`.
- **Not e-signed** (consistent with issue / additional issue; only close-out is signed).
- Permission: `inventory:create`.

### C3. Post-issue cancel (resolves §99.8)
`POST /kits/{id}/cancel` now also accepts `issued` / `in_production`:

- For each line, return **all** `on_floor` to `return_location_node_id ?? source_location_node_id` using the same mechanics as C2 (original lot moved back, `backflush` movement).
- `status → cancelled`, `closed_at/by` set.
- Draft cancel is unchanged (no movements).
- **Not e-signed** (matches the existing cancel).

### C4. Close-out — drain the production node
Per line: reduce the production allocation by `used_qty` (**no movement** — it already left `v_item_stock` at issue), then move `leftover` back to the return node **on its original lot**, with a `backflush` movement carrying `from = production node`.
`production_output` is unchanged. Still one atomic, e-signed transaction.

### C5. Available-balance guard
`item_stock_by_node` must **exclude `flat_category='production'` nodes**, so WIP is never offered as an issue source or counted as available. `v_item_stock` is untouched.

### C6. Schema/read changes
`KitLineRead` gains `early_returned_qty` and `on_floor_qty` (derived). `returned_qty` keeps its meaning — the close-out leftover — but is now computed from `on_floor`.

---

## 7. Part D — Frontend

| Where | Change |
|--|--|
| `location-tree-picker.tsx` | `'production'` area (A1) |
| `new-kit-dialog.tsx` | `areas={['production']}` (A2) |
| `kit-detail-client.tsx` — Issue step | New **On floor** column; per-line **"Return"** action (dialog: qty + return location, capped at `on_floor`) |
| `kit-detail-client.tsx` — header | **Cancel kit** now shown for in-production kits, with a confirm that states how much will be returned |
| `kit-detail-client.tsx` — Close-out | "Issued" column reads `on_floor`; over-use message accounts for early returns |
| `kits.ts` | `returnLine()`, `early_returned_qty`, `on_floor_qty`; `cancel()` unchanged in shape |

---

## 8. Part E — In-flight kits (no backfill script)

Kits currently `issued` / `in_production` were issued under the withdrawn model, so their material has **no allocation anywhere**. Per the TRX-008 decision: **drain them first, then migrate.** On dev these are throwaway test kits, so soft-delete/cancel is fine. The new post-issue cancel (C3) is the general-purpose tool for this on any environment — but note it can only return material that *has* an allocation, so for pre-migration kits the material must be re-placed by an admin adjustment, or the kits abandoned.

**Dev plan:** soft-delete the open test kits before applying `kitting03`.

---

## 9. Test plan (must all pass before "done")

**Backend smoke (extend `smoke_kitting.py`):**
1. Issue → allocation appears at the production node with exactly `issued_qty`; source drops by the same.
2. Issue → `kit_issue` movement has `from = source`, `to = production` (D1 fixed).
3. Available on-hand drops by `issued_qty` (TRX-001 still holds).
4. `item_stock_by_node` does **not** list the production node (C5).
5. Partial return 3 of 15 → production allocation −3, return node +3 on a new lot, `backflush` movement, `early_returned_qty = 3`.
6. Return more than `on_floor` → 422.
7. Close-out: `used + leftover = on_floor`; production node allocation for the kit reaches **zero**.
8. Over-use guard respects early returns (`used > on_floor` → 422).
9. Post-issue cancel returns everything; production node drains to zero; status `cancelled`.
10. Draft cancel still writes no movements.
11. E-sign still required for close-out only.

**Frontend:** `tsc --noEmit` + `next lint` clean; BFF click-through create → issue → partial return → close-out.

---

## 10. Out of scope

- Consumable Kanban reconciliation (SRS §4.3) — unchanged, still deferred.
- FG → customer shipment (TRX-005/006).
- Lot genealogy through kitting — explicitly *not* wanted (SRS §4, TRX-008).
- Re-issuing returned material automatically — a return puts stock back on a shelf; re-issuing is a normal new issue.
