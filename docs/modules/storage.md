# Storage / LN2 Module — Data Structure & Implementation Contract

> **Route:** `/ln2` (page title **"Storage"**) · **Frontend entry:** `frontend/src/components/ln2/tank-map-client.tsx`
> **Status:** `draft 2026-06-04` — frontend model is live (in-memory demo); backend not yet built. This file is the contract to derive the backend from.

This module owns **physical storage mapping**: where each item/lot physically
lives, modelled as a uniform **`Location → Rack → Position`** layout. It started
as "LN2 tank mapping" (TSS §*LN2 Mapping*) and was **generalised** so the same
grid layout serves every storage kind — LN2 tanks, −80/−20 freezers, fridges,
cold rooms, incubators, lab benches, store rooms. `kind` only drives the header
label and switcher icon; the layout is identical for all kinds.

Shared design principles (idempotency, audit hash chain, `meta` vs `app` schema,
soft delete) live in [../backend-data-structure.md](../backend-data-structure.md)
and are referenced, not restated.

---

## 0. Reconciliation note (read first)

There are **three** descriptions of LN2/storage in this codebase. They disagree.
This file is the intended source of truth going forward:

| Source | Model | Disposition |
|--|--|--|
| **This frontend** (`ln2-data.ts`, `ln2.store.ts`) | `StorageLocation → Rack(rows×cols) → Position`, in-memory demo, no backend | **Authoritative for shape.** This doc formalises it. |
| `inventory.md §5` | LN2 as `ltree` nodes in `meta.locations` (`kind='ln2_tank'/'ln2_rack'/'ln2_position'`) + `app.ln2_position_state` + `app.ln2_assignment_events`; legacy `src/types/ln2.ts` (`col A..E / row 1..5`) | **Superseded** for racks/positions by this file (see §6). `meta.locations` row-per-location is kept; the per-rack/per-position **nodes** are replaced by explicit `storage_racks` / `storage_positions` tables. |
| `storage-module-state` memory (other branch) | `StorageRack`(meta)+`StoragePosition`(app), lot `quantity`/`consumed_qty`, stock-in/consume | **Not present in this branch.** Where it overlaps, this doc adopts compatible names so the branches can converge (see §99 Q4). |

The key new requirement driving this revision: **a rack is now defined as a
`rows × cols` grid** (e.g. `5 × 5`, `6 × 5`), not a single positions count.

---

## 1. Scope

**Owns**
- Rack definitions per location (name + grid shape `rows × cols`).
- Per-position current occupancy (binary `occupied` / `empty`, the lot/vial it
  holds, since-when).
- Append-only assignment history (assign / empty / move) to satisfy 21 CFR
  Part 11 traceability for cryogenic items.

**Deliberately does NOT own**
- The `meta.locations` row itself (name, kind, temperature, code) — owned by
  the Inventory module ([inventory.md §3.5](./inventory.md)). Storage adds racks
  **under** an existing location.
- Item / lot master data, quantities, expiry — owned by Inventory
  ([inventory.md §4](./inventory.md)). A position **references** a lot; it does
  not store item attributes.
- Electronic-signature records — shared `electronic_signatures` table lives in
  [inventory.md §8](./inventory.md); Storage emits sign-off events into it.

---

## 2. Spec-doc mapping

| Requirement (TSS / Stories) | Covered by |
|--|--|
| "assignment and reassignment of cryogenic items to tank positions" | `assign` / `move` events (§5, §6) |
| "status tracking for individual LN2 storage positions" | `storage_positions.status` (§4.3) |
| "electronic signoff for all status changes" (21 CFR Part 11) | sign-off hook on status/assign events (§6, [inventory.md §8](./inventory.md)) |
| Generalisation to all storage kinds | reuse of `meta.locations.kind` (§3) |

---

## 3. The current frontend model (authoritative shape)

Defined in `frontend/src/components/ln2/ln2-data.ts`. The backend tables in §4
are derived **1:1** from these TypeScript types.

```ts
type LocationKind =
  | 'LN2' | 'minus_80' | 'minus_20' | 'fridge'
  | 'cold_room' | 'room_temp' | 'incubator' | 'other';

interface StorageLocation {
  id: string;            // slug, e.g. 'ln2-tank-a'  → meta.locations
  name: string;          // 'LN2 Tank A'
  kind: LocationKind;    // drives header icon only
  detail: string;        // header sub-line, e.g. 'Vapor-phase · ~ -196 °C'
  racks: Rack[];
}

interface Rack {
  id: string;            // `${locationId}-R${NN}`
  name: string;          // 'Rack 01'
  rows: number;          // NEW — grid rows  (1..26)
  cols: number;          // NEW — grid cols  (1..26)
  positions: Position[]; // length === rows * cols, row-major
}

interface Position {
  id: string;            // `${rackId}-P${NN}`
  index: number;         // 1-based, row-major: (row-1)*cols + col
  status: 'Occupied' | 'Empty';   // binary — a slot is either filled or not
  item: InventoryItem | null;  // derived from lot on the backend
  lot: string | null;          // lot code; FK on the backend
  sinceMonths: number;         // derived from assigned_at on the backend
}
```

**Grid semantics (the new feature).** A rack is a `rows × cols` grid. Positions
are stored **row-major** (left→right, top→bottom). The display grid uses the
rack's own `cols` for its CSS columns (`rack-tile.tsx`), so a `6 × 5` rack
renders 6 columns. Total capacity of a rack is `rows * cols`.

---

## 4. Backend tables

### 4.1 `meta.locations` — already exists, unchanged

One row per storage location. Owned by Inventory ([§3.5](./inventory.md)). A
Storage location is simply a `meta.locations` row; `kind` ∈ the `LocationKind`
set above. Storage hangs racks off `locations.id`. No schema change required
here beyond what Inventory already ships.

### 4.2 `meta.storage_racks` — rack definitions (reference data)

Racks change rarely (created with the location, occasionally added). Master-ish →
`meta` schema, soft-deleted.

| Column | Type | Notes |
|--|--|--|
| `id` | `UUID PK DEFAULT gen_random_uuid()` | |
| `location_id` | `UUID NOT NULL FK → meta.locations(id)` | parent location |
| `code` | `TEXT NOT NULL` | stable handle, e.g. `R01`; unique per location |
| `name` | `TEXT NOT NULL` | display name, e.g. `Rack 01` |
| `rows` | `INT NOT NULL CHECK (rows BETWEEN 1 AND 26)` | grid rows |
| `cols` | `INT NOT NULL CHECK (cols BETWEEN 1 AND 26)` | grid columns |
| `position_order` | `INT NOT NULL DEFAULT 0` | sort order within the location |
| `is_active` | `BOOLEAN NOT NULL DEFAULT TRUE` | soft delete |
| `created_at` / `updated_at` | `TIMESTAMPTZ` | standard triggers |

- `UNIQUE (location_id, lower(code))` — no duplicate rack codes in a location.
- Capacity is **derived** (`rows * cols`), never stored.
- On insert, a trigger (or service) materialises `rows * cols` rows into
  `storage_positions` (see §6). **Racks cannot be edited** — `rows`/`cols` (and
  the materialised positions) are immutable after creation; to change a rack's
  grid, delete it and create a new one. Expose no rack PATCH endpoint. (§99 Q2)

### 4.3 `app.storage_positions` — one row per slot (current occupancy)

The materialised grid. Transactional → `app` schema.

| Column | Type | Notes |
|--|--|--|
| `id` | `UUID PK DEFAULT gen_random_uuid()` | |
| `rack_id` | `UUID NOT NULL FK → meta.storage_racks(id)` | parent rack |
| `row_idx` | `INT NOT NULL CHECK (row_idx >= 1)` | 1-based, ≤ rack.rows |
| `col_idx` | `INT NOT NULL CHECK (col_idx >= 1)` | 1-based, ≤ rack.cols |
| `seq` | `INT NOT NULL` | row-major index `(row_idx-1)*cols + col_idx`, 1..rows*cols |
| `label` | `TEXT NOT NULL` | human grid label, **column-letter + row-number** (col 3,row 2 → `C2`); matches legacy `types/ln2.ts` convention |
| `status` | `TEXT NOT NULL DEFAULT 'empty' CHECK (status IN ('empty','occupied'))` | binary — maps to frontend `PositionStatus` (lower-cased) |
| `lot_id` | `UUID NULL FK → app.lots(id)` | the lot/vial occupying the slot; NULL when empty |
| `assigned_at` | `TIMESTAMPTZ NULL` | when current occupant was placed; powers `sinceMonths` |
| `created_at` / `updated_at` | `TIMESTAMPTZ` | standard triggers |

- `UNIQUE (rack_id, row_idx, col_idx)` and `UNIQUE (rack_id, seq)` — no two slots
  share a coordinate.
- **Occupancy invariant:** `CHECK ((status = 'occupied') = (lot_id IS NOT NULL))`
  — a slot holds a lot exactly when it is `occupied`; an `empty` slot carries no
  `lot_id`. Status is **binary** — there are no intermediate `reserved` /
  `quarantine` states (those live on the lot, not the slot).
- **Item is derived,** not stored: `position → lot_id → app.lots.item_id`. The
  frontend `Position.item` is hydrated by the read endpoint via that join.
- One position = **one unit (vial)**. `lot_id` is traceability, not a quantity.
  (Aligns with the other-branch `consumed_qty` model — §99 Q4.)

### 4.4 `app.storage_assignment_events` — append-only history

Every mutation of a position is a row. Drives position history and feeds the
audit hash chain. Never updated or deleted.

| Column | Type | Notes |
|--|--|--|
| `id` | `UUID PK DEFAULT gen_random_uuid()` | |
| `position_id` | `UUID NOT NULL FK → app.storage_positions(id)` | the slot |
| `event_type` | `TEXT NOT NULL CHECK (event_type IN ('assign','move_out','move_in','empty'))` | status is binary, so assign/empty fully capture it |
| `from_status` | `TEXT NULL` | previous status |
| `to_status` | `TEXT NULL` | new status |
| `lot_id` | `UUID NULL FK → app.lots(id)` | lot involved (assign/move/empty) |
| `counterpart_position_id` | `UUID NULL FK → app.storage_positions(id)` | for `move_*`, the other slot |
| `signature_id` | `UUID NULL FK → app.electronic_signatures(id)` | set when the action required sign-off ([inventory.md §8](./inventory.md)) |
| `actor_id` | `UUID NOT NULL FK → identity users` | who did it |
| `occurred_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

- Indexed `(position_id, occurred_at DESC)` for the position-history panel.
- A `move` is **two** rows (`move_out` on source, `move_in` on destination)
  sharing `counterpart_position_id`, written in one transaction. The destination
  may be in a **different rack or location** (tank → tank, tank → fridge): a move
  is not constrained to the same location (§99 Q5).

---

## 5. Operations (API surface)

| Action | Endpoint (proposed) | Writes |
|--|--|--|
| List storage tree | `GET /v1/storage/locations` | reads locations + racks + positions (hydrated with lot/item) |
| Add location + racks | `POST /v1/storage/locations` | `meta.locations`, `meta.storage_racks`, materialises `storage_positions` |
| Add rack to location | `POST /v1/storage/locations/{id}/racks` | `storage_racks` + positions |
| Assign lot to slot | `POST /v1/storage/positions/{id}/assign` | position (status→occupied, lot_id, assigned_at) + `assign` event |
| Empty slot | `POST /v1/storage/positions/{id}/empty` | position (status→empty, lot_id NULL) + `empty` event |
| Move occupant | `POST /v1/storage/positions/{id}/move` | source + dest positions + 2 events; **dest may be any free slot, including another location** |

The "Add location" dialog (`location-add-dialog.tsx`) submits
`{ name, kind, detail, racks: [{ name, rows, cols }] }` → maps onto
`POST /v1/storage/locations`.

### 5.1 Bulk fill via unit-in / unit-out (§99 Q4)

> **Implemented 2026-06-04 as "unit in / unit out".** The movement ledger and the
> storage grid are now coupled in `app/inventory/{repository,routes}.py`
> (`fill_positions_for_lot` / `empty_positions_for_lot`). NB: the
> `consume` / lot `consumed_qty` idea below was **not** adopted — the
> `stock_movements` ledger stays the single source of truth for quantities (no
> qty columns on lots). A unit-out is a `dispense`; permanence/correction is
> handled by the ledger (reverse-movement), not a separate consume flow.

Unit-in originates from the **inventory item page** (`/inventory/{item}`) via the
**Record movement** action — *not* from the storage page. The operator selects a
**location**, a **lot**, and **units** `N`. The receipt then **fills the next `N`
empty positions** in that location, **one vial per position**, in row-major order
(rack `position_order`, then position `seq`); a unit-out (dispense) frees `N` of
the lot's occupied positions the same way. If the location has racks, capacity is
enforced (receipt → `not_enough_empty_positions`; dispense →
`not_enough_mapped_positions`); rack-less locations are ledger-only.

```
Stock in qty 12 → Rack 01 (25 positions)
  → positions 1‑12 become `occupied` (lot_id set), 13‑25 stay `empty`.
```

- One unit = one position. `N` is capped at `min(lot units remaining,
  location empty slots)`; the UI surfaces the cap.
- Each filled position writes an `assign` event (§4.4); the whole stock-in is one
  transaction and one ledger movement (cross-ref [inventory.md §4 ledger](./inventory.md)).
- **Consume** is the permanent stock-out counterpart (empties positions and bumps
  the lot's `consumed_qty`), distinct from `empty` (which only unmaps, reversible).
- Open sub-detail for that phase: whether the fill is scoped to one chosen **rack**
  or spills across the location's racks in order. The example above is single-rack;
  spilling is the natural generalisation. Confirm when building.

---

## 6. Triggers, constraints, invariants

1. **Grid materialisation** — inserting a `storage_racks` row creates exactly
   `rows * cols` `storage_positions` (status `empty`), with `seq`, `row_idx`,
   `col_idx`, `label` computed. Single transaction.
2. **Coordinate bounds** — trigger rejects positions with `row_idx > rack.rows`
   or `col_idx > rack.cols`.
3. **Occupancy invariant** — §4.3 `CHECK` keeps `status` and `lot_id` consistent.
4. **History on mutate** — any update to a `storage_positions` status/lot writes
   a `storage_assignment_events` row in the same transaction (trigger).
5. **Sign-off gate** — when the location requires signature on assign
   (configurable, [inventory.md §8](./inventory.md)), the assign/move/empty
   endpoint must attach a `signature_id` or the event is rejected.
6. **Supersedes `inventory.md §5`** — the `ln2_tank/ln2_rack/ln2_position` node
   kinds and `app.ln2_position_state` / `app.ln2_assignment_events` are replaced
   by §4.2–§4.4. `meta.locations` rows for tanks remain.

---

## 7. Sample queries

```sql
-- One rack's grid, hydrated with occupant + item (the RackTile data)
SELECT p.seq, p.row_idx, p.col_idx, p.label, p.status,
       l.lot_code, i.item_number, i.description,
       p.assigned_at
FROM   app.storage_positions p
LEFT   JOIN app.lots  l ON l.id = p.lot_id
LEFT   JOIN app.items i ON i.id = l.item_id
WHERE  p.rack_id = $1
ORDER  BY p.seq;

-- Location capacity rollup (the Stat cards: Capacity / Occupied / Empty)
SELECT r.location_id,
       COUNT(*)                                  AS capacity,
       COUNT(*) FILTER (WHERE p.status='occupied') AS occupied,
       COUNT(*) FILTER (WHERE p.status='empty')    AS empty
FROM   meta.storage_racks r
JOIN   app.storage_positions p ON p.rack_id = r.id
WHERE  r.location_id = $1 AND r.is_active
GROUP  BY r.location_id;
```

---

## 8. Seeder

Mirror `buildSeedLocations()` (`ln2-data.ts`): 3× LN2 tanks (6 racks each,
`5 × 5`), 1 fridge (3 racks), 1 lab bench + 1 store room (2 racks). Deterministic
status spread so demo data is stable. The seeder is the migration path's smoke
test before real Excel data lands.

---

## 9. Cross-module references

- **Inventory** ([inventory.md](./inventory.md)) — `meta.locations` (§3.5),
  `app.lots` / `app.items` (§4), electronic sign-off (§8), audit events
  (`inventory.ln2.assigned`, `inventory.ln2.removed`).
- **Audit logs** — assignment events feed `audit.audit_events` hash chain.

---

## §99 Open questions

1. ~~**Label convention.**~~ **Resolved 2026-06-04** — **column-letter +
   row-number** (`C2`) per legacy `types/ln2.ts`. No overflow fallback needed:
   `cols` is capped at 26, so the column letter is always `A`–`Z`. §4.3 reflects
   this.
2. ~~**Rack resize.**~~ **Resolved 2026-06-04** — racks **cannot be edited**.
   `rows`/`cols` (and the materialised positions) are immutable after creation;
   to change a rack's grid, delete it and create a new one. §4.2 reflects this.
3. ~~**Reserved semantics.**~~ **Resolved 2026-06-04** — position status is
   **binary** (`occupied` / `empty`); no `reserved` or `quarantine` slot states.
   Those concepts, if needed, live on the lot, not the slot.
4. ~~**Converge with other branch.**~~ **Implemented 2026-06-04 as unit-in /
   unit-out.** Recording a unit-in/out now bulk-fills / frees positions (§5.1)
   in one transaction with the ledger movement. The `stock_movements` ledger
   stays the single source of truth — the lot `quantity`/`consumed_qty` + a
   separate `consume` flow was **not** adopted.
5. ~~**Move across locations.**~~ **Resolved 2026-06-04** — **cross-location
   moves are allowed**: a vial can move from one tank to another (and, more
   generally, between any two positions in any locations). `move` validates the
   destination is a free slot; it does not constrain it to the same location.
   §4.4 / §5 reflect this.
