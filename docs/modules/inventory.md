# Inventory Module — Backend Data Structure

> **Sources of truth**
> - `temp/Demo Inventory Control.xlsx`
>   (`Component Inventory Tracker` master sheet + per-item `XX-XXXX` ledger sheets)
> - `temp/Technical Software Specification.docx.pdf` — sections:
>   *Week 1 Inventory Module*, *LN2 Mapping*, *Kanban*,
>   *Inventory Item Reorder Thresholds and Notifications*,
>   *Inventory Expiration Thresholds and Notifications*
> - `temp/Stories.docx.pdf` — section 2 *Inventory Management Requirements*
>
> Shared infra (audit partitioning, outbox, idempotency, hash chain,
> tracing, retention) lives in [../backend-data-structure.md](../backend-data-structure.md).
> This file is the **complete inventory-module contract**.

---

## 1. Scope

Everything the spec doc lists under the Inventory Module is owned here.
Where a table is referenced by other modules (e.g. `users`, `audit_events`),
its **definition** lives elsewhere and we only describe how Inventory uses
it.

**Owned by this module (defined in this file):**

| Concern | Table(s) |
|--|--|
| Item master | `app.items` |
| Lot lifecycle | `app.lots` |
| Physical placement | `app.item_batches` |
| Movement ledger | `app.ledger_entries` |
| Denormalised balances | `app.item_balances` |
| Per-program demand snapshot (Excel cols N–AB) | `app.item_program_demand` |
| Suppliers | `meta.suppliers` |
| ~~Units of measure~~ | ~~`meta.units_of_measure`~~ — REMOVED (v2 §8) |
| Locations (incl. LN2 tree) | `meta.locations` |
| LN2 position state | `app.ln2_position_state`, `app.ln2_assignment_events` |
| Kanban stages | `meta.workflow_stages` |
| Kanban cards / lifecycle | `app.workflow_cards`, `app.workflow_transitions` |
| Notification kinds | `meta.notification_kinds` |
| Notification subscriptions | `app.notification_subscriptions` |
| Notification deliveries | `app.notification_deliveries` |
| Inventory item watch list (per-item subscription overrides) | `app.item_watch_subscriptions` |
| Electronic sign-off (inventory actions) | `app.electronic_signatures` *(shared table, defined here because every regulated inventory action uses it)* |

**Referenced but defined elsewhere:**

- `app.users` → `identity-access.md` (not yet split)
- `audit.audit_events` → `audit-logs.md` (not yet split)
- `app.purchase_orders`, `app.po_lines` → `purchase-orders.md` (not yet split)
- `meta.programs` → `forecast.md` (not yet split; FK'd from `item_program_demand`)

**Deliberately out of scope:**

- Forecast / Months-on-Hand math (consumes `item_program_demand`; lives
  in `forecast.md`)
- Quarantine — **deferred from v1** (§99 Q3); no quarantine status, no
  quarantine workflow card, no quarantines table
- Reservation against manufacturing runs — the `lots.status = 'reserved'`
  value exists (§4.2) but the allocations table linking lots to runs is
  owned by `forecast.md`
- Email/SMS delivery transport (`notifications.md` cross-module concern);
  Inventory emits notification rows, the notifications worker delivers them

---

## 2. Excel + spec-doc fidelity

Every column on `app.items` and `app.ledger_entries` must map to a real
Excel column or be marked derived. LN2 / Kanban / Notification tables
map to spec-doc sections, not Excel. Nothing in this file is invented:
fields not in either source are gated by an open question in §99.

For categories, location free-form names, and "reason" on the ledger see
§3.1 / §3.5 / §4.5 — those were invented in earlier revisions and have
been removed.

---

## 3. Reference tables (`meta` schema)

### 3.1 `item_number` is free-form — **no category / prefix tables**

Excel has no category column. Existing item numbers happen to share four
2-letter prefixes (`CM-`, `NM-`, `CR-`, `AY-`), but those are convention,
not constraint. Previously assigned labels ("Cell-therapy media /
reagent", etc.) were our interpretation and are removed.

**Decision (§99 Q1 resolved):** no `meta.categories` table, no
`meta.item_prefixes` table, **no CHECK constraint** on `item_number`.
Whatever the user types in the New-item dialog becomes the item number;
`UNIQUE` is the only backend rule.

The list view may still surface a "prefix" filter, but it is **derived
at query time** from whatever prefixes exist in the data, not validated
against a fixed list.

### 3.2 `meta.inventory_statuses`

Excel stores no item-level status. Status is **derived** from
`qty_on_hand` and `reorder_threshold`. Three values:

| col | type | notes |
|--|--|--|
| `code` | `TEXT PK` | `available`, `low_stock`, `out_of_stock` |
| `label` | `TEXT NOT NULL` | |
| `tone` | `TEXT NOT NULL` | UI badge tone (`success`, `warning`, `neutral`) |

Derivation in function `compute_inventory_status(item_id)`:

| Condition | Status |
|--|--|
| `qty_on_hand = 0` | `out_of_stock` |
| `qty_on_hand <= reorder_threshold` | `low_stock` |
| else | `available` |

`expired` is **lot-level**, not item-level (§4.2). The list view may
roll up "has an expired lot" as a UI hint but it is never a value on
this table. Quarantine deferred from v1 (§99 Q3).

### 3.3 `meta.suppliers`

Sourced **directly from Excel master sheet col C `Supplier`** (header row
49, data rows 50+). 73 distinct supplier names in the current workbook —
e.g. `Fisher Scientific`, `Miltenyi`, `Thermo Fisher Scientific`,
`Valley Biomedical`, `R&D Systems, Inc.`, `Irvine Scientific (fuji film)`,
`VWR`, `Wilson Wolf`, `OriGen Biomedical`, `Hardy Diagnostics`,
`Fresenius Kabi`, `Millipore Sigma`, etc.

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `name` | `TEXT NOT NULL` | `UNIQUE WHERE deleted_at IS NULL` |
| `contact_email` | `CITEXT NULL` | |
| `phone` | `TEXT NULL` | |
| `address` | `JSONB NOT NULL DEFAULT '{}'::jsonb` | |
| `is_active` | `BOOL NOT NULL DEFAULT TRUE` | |
| `notes` | `TEXT NULL` | |
| `created_at`, `updated_at`, `deleted_at` | | |

**Important:** seeder skips blank supplier strings. Excel rows with
`supplier = ''` create no `meta.suppliers` row, and the items they belong
to get `supplier_id = NULL`. This is the root cause of the empty
`<Select.Item />` bug already fixed in
[../../src/components/inventory/new-item-dialog.tsx](../../src/components/inventory/new-item-dialog.tsx).

> **Note:** the per-item ledger sheets (`XX-XXXX` template) do **not**
> have a supplier column — only the master `Component Inventory Tracker`
> sheet does. If you opened a `CM-0001` / `NM-0237` / etc. tab and saw
> no supplier, that's why.

### 3.4 ~~`meta.units_of_measure`~~ — REMOVED

**Dropped entirely (v2 §8 · migration `b7c8d9e0f1a2`, 2026-06-23).** UOM was
removed together with the package/price columns — quantities are whole units
and there is no unit-of-measure lookup table.

Default `unit`.

### 3.5 `meta.locations` — hierarchical (incl. LN2 tree)

The Excel ledger has free-form location strings (`Fridge 00227`,
`FRZ-A-02`, `PD LAB`, …). The spec doc's *LN2 Mapping* section requires
structured cryogenic storage (tanks → racks → positions). One unified
hierarchy serves both: a closure-friendly tree backed by `ltree`.

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `parent_id` | `UUID NULL FK → meta.locations(id)` | |
| `path` | `LTREE NOT NULL` | enables `WHERE path <@ 'site_A.frz.A.02'` |
| `code` | `TEXT NOT NULL` | last segment (`A-02`, `Rack D`, `Pos C3`) |
| `name` | `TEXT NOT NULL` | human label |
| `kind` | `TEXT NOT NULL` | `CHECK kind IN ('site','room','freezer','shelf','ln2_tank','ln2_rack','ln2_position','generic')` |
| `temperature_c` | `NUMERIC(5,2) NULL` | nominal temp where applicable |
| `capacity_units` | `INT NULL` | for ln2_position (typically 1 vial slot) and ln2_rack (typically 25 = 5×5) |
| `metadata` | `JSONB NOT NULL DEFAULT '{}'::jsonb` | freeform attrs (color, grid coords) |
| `is_active` | `BOOL NOT NULL DEFAULT TRUE` | |
| `created_at`, `updated_at` | | |

Indexes: `GIST(path)`, `(parent_id)`, `(kind)`, `(kind, parent_id)`.

**Why `ltree`:** smaller than a closure table, and the two hot queries
("everything under rack D", "ancestor chain for breadcrumbs") are O(log n)
via `<@` and `@>`.

LN2 hierarchy looks like:

```
site_main.cryo.tank_lN2A                  kind=ln2_tank
└── rack_a                                 kind=ln2_rack    capacity=25
    ├── pos_a1, pos_a2, … pos_a5           kind=ln2_position capacity=1
    ├── pos_b1 … pos_b5
    ├── pos_c1 … pos_c5
    ├── pos_d1 … pos_d5
    └── pos_e1 … pos_e5
```

Non-cryogenic locations live in the same tree:

```
site_main.frz_a.shelf_02                  kind=shelf
site_main.fridge_00227                    kind=generic
site_main.pd_lab                          kind=generic
```

### 3.6 `meta.workflow_stages` — Kanban columns

Spec doc says "configurable columns representing inventory lifecycle
stages". Stages are reorder-able and renamable; only `is_terminal` is a
semantic flag (terminal stages close the card).

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `code` | `TEXT UNIQUE NOT NULL` | stable key (`low_stock`, `review`, …); UI uses `label` |
| `label` | `TEXT NOT NULL` | human-editable |
| `tone` | `TEXT NOT NULL` | `success`, `warning`, `accent`, `neutral`, `danger` |
| `sort_order` | `INT NOT NULL DEFAULT 0` | column order on the board |
| `is_terminal` | `BOOL NOT NULL DEFAULT FALSE` | terminal stage closes the card |
| `requires_signature` | `BOOL NOT NULL DEFAULT FALSE` | regulated stages need e-signoff to enter |
| `is_active` | `BOOL NOT NULL DEFAULT TRUE` | inactive stages hidden from the board |

Seed (6 stages, frontend default — admins can rename/reorder/add):

| code | label | tone | terminal | signature |
|--|--|--|--|--|
| `low_stock` | Low Stock Detected | warning | no | no |
| `review` | Needs Review | warning | no | no |
| `pending` | Pending Approval | accent | no | **yes** |
| `ordered` | Ordered | accent | no | no |
| `received` | Received | success | no | **yes** |
| `closed` | Closed | neutral | **yes** | no |

### 3.7 `meta.notification_kinds`

Spec doc lists two distinct notification triggers under the Inventory
Module: reorder threshold + expiration threshold. Defined as a reference
table so admins can toggle/relabel without a migration.

| col | type | notes |
|--|--|--|
| `code` | `TEXT PK` | `reorder_threshold`, `expiration_warning`, `expiration_imminent`, `lot_recalled`, `low_stock_to_kanban` |
| `label` | `TEXT NOT NULL` | |
| `description` | `TEXT NULL` | |
| `default_channel` | `TEXT NOT NULL CHECK (default_channel IN ('in_app','email','both'))` | |
| `is_active` | `BOOL NOT NULL DEFAULT TRUE` | |

Seed: 5 rows above.

---

## 4. Core inventory tables (`app` schema)

### 4.1 `app.items` — master tracker (one row per Excel row 50+)

Columns map **1:1** to the `Component Inventory Tracker` header row 49.

| col | type | maps to Excel | notes |
|--|--|--|--|
| `id` | `UUID PK` | — | internal |
| `item_number` | `TEXT NOT NULL` | col B `Item # (MIN)` | free-form, user-supplied. `UNIQUE (item_number) WHERE deleted_at IS NULL`. **No prefix CHECK** (§3.1) |
| `description` | `TEXT NOT NULL` | col A `Item Description` | |
| `supplier_id` | `UUID FK → meta.suppliers` | col C `Supplier` | nullable for unsourced items (blank supplier in Excel) |
| `avg_lead_days` | `INT NULL` | col D `Average Lead Times (Days)` | |
| `reorder_threshold` | `NUMERIC(14,3) NOT NULL DEFAULT 0` | col M `MUST HAVE INVENTORY LEVEL` | drives `reorder_threshold` notification (§6) and `low_stock` Kanban card creation (§5) |
| ~~`unit_price_amount`~~ | — | col AC `Unit Price` | **REMOVED (v2 §8 · migration `b7c8d9e0f1a2`, 2026-06-23).** Unit price now lives on the **lot** (`app.lots.unit_price_amount`) and order lines; item inv $ / PO $ are derived (Σ qty × lot unit price). |
| ~~`units_per_package`~~ | — | col AD `Units Per package configuration` | **REMOVED (v2 §8).** No package-configuration concept — variable package sizes make package-level pricing impractical; **track unit price only**. |
| ~~`price_per_package_amount`~~ | — | col AE `Price Per Package configuration` | **REMOVED (v2 §8).** No separate packaging-configuration price. |
| ~~`uom_code`~~ | — | — | **REMOVED (migration `b7c8d9e0f1a2`).** `meta.units_of_measure` dropped entirely; quantities are whole units. |
| `po_note` | `TEXT NULL` | col I `Comment/ Note on Outstanding POs` | |
| `po_due_text` | `TEXT NULL` | col J `PO Due Date(s)` | free-form on master sheet; structured POs live in `purchase_orders` |
| `must_order_flag` | `BOOL NOT NULL DEFAULT FALSE` | col L `Must Order` | |
| `last_updated_on` | `DATE NULL` | col AF `Date Updated` | the workbook's own "Date Updated" column; surfaced as the `Updated` column in the list. Distinct from the row's `updated_at` |
| `expiry_warning_days` | `INT NULL` | — | per-item override for the expiration-warning lead time (see §6.2); falls back to `app.settings.default_expiry_warning_days` |
| `notes` | `TEXT NULL` | — | |
| `metadata` | `JSONB NOT NULL DEFAULT '{}'::jsonb` | — | |
| `row_version` | `INT NOT NULL DEFAULT 1` | — | optimistic locking |
| `created_at`, `updated_at`, `deleted_at` | | | |
| `created_by_user_id`, `updated_by_user_id` | | | |

**Indexes:**
- `UNIQUE (item_number) WHERE deleted_at IS NULL`
- `(supplier_id)`
- Generated column `item_prefix TEXT GENERATED ALWAYS AS (CASE WHEN position('-' IN item_number) > 0 THEN split_part(item_number, '-', 1) ELSE NULL END) STORED`, indexed for the optional prefix-group filter — a convenience derivation, not a constraint
- `GIN (to_tsvector('english', description))` — search bar
- `(updated_at DESC)`, `(last_updated_on DESC)` — recently-changed list

**Fields explicitly NOT stored on `items`:**

| Field | Why omitted |
|--|--|
| `category_id` / `category` | Excel has no category column; prefix is a derived convenience only (§3.1) |
| `location`, `lot`, `expires` | Per-receipt, not per-item. Live on `lots` and `item_batches`; detail page shows them as "latest batch" via join |
| `status` (enum value column) | Derived from `qty_on_hand` + `reorder_threshold` (§3.2) |
| `qty_on_hand` | Derived from ledger sum; cached in `item_balances` (§4.4) |
| `inv_value_amount` (Excel col E) | Derived (`qty_on_hand × unit_price_amount`); cached in `item_balances` |
| `po_value_amount` (Excel col F) | Derived from open `purchase_orders`; cached |
| `qty_on_order` (Excel col K) | Derived from open `purchase_orders`; cached |
| `months_on_hand` (Excel col H) | Derived from selected forecast demand ÷ `qty_on_hand`; cached |

### 4.2 `app.lots`

A lot is a manufacturer-issued batch identifier with an expiration.

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `item_id` | `UUID FK → app.items` | direct FK; no materials layer (§99 Q5) |
| `lot_number` | `TEXT NOT NULL` | per-item ledger col F `Lot Number` |
| `expires_on` | `DATE NULL` | col G `Expiration` |
| `received_on` | `DATE NULL` | earliest `Units In` row for this lot |
| `status` | `TEXT NOT NULL` | `CHECK status IN ('active','reserved','expired','consumed','recalled')` — quarantine removed (§99 Q3); 5-value enum (§99 Q4) |
| `coa_url` | `TEXT NULL` | certificate of analysis (S3) |
| `metadata` | `JSONB NOT NULL DEFAULT '{}'::jsonb` | |
| `created_at`, `updated_at` | | |

`UNIQUE (item_id, lot_number)`.
Indexes: `(item_id, expires_on)`, `(status)`.

**Status transitions:**

| From → To | Trigger | Sign-off |
|--|--|--|
| `active → expired` | nightly job when `expires_on < CURRENT_DATE` | system actor, no signature |
| `active → reserved` | allocation against a manufacturing run (owned by `forecast.md`) | unsigned; allocation row carries the trail |
| `reserved → active` | allocation released | unsigned |
| `reserved → consumed` | balance hits zero via ledger stock-out | inherits the ledger entry's signature |
| `active → consumed` | balance hits zero via ledger stock-out | inherits the ledger entry's signature |
| `* → recalled` | manual supplier-recall action | **signed** (`electronic_signatures` row required) |

### 4.3 `app.item_batches` — physical placement

A `batch` is `(item, lot, location)`. The Excel per-item sheet allows up
to four such batches separated by subtotal rows. Modelling this lets us
say "20 of lot X at FRZ-A-03 and 15 of lot X at PD LAB".

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `item_id` | `UUID FK` | |
| `lot_id` | `UUID FK` | |
| `location_id` | `UUID FK → meta.locations` | |
| `opened_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | first entry posted |
| `closed_at` | `TIMESTAMPTZ NULL` | set when balance returns to zero |
| `balance_units` | `NUMERIC(14,3) NOT NULL DEFAULT 0` | denormalised running balance |

`UNIQUE (item_id, lot_id, location_id) WHERE closed_at IS NULL` —
prevents two simultaneous open batches for the same triple.

Indexes: `(item_id)`, `(lot_id)`, `(location_id)`.

### 4.4 `app.item_balances` — denormalised snapshot

Without this, the inventory list would do a sum-and-group over millions
of rows on every page load.

| col | type | notes |
|--|--|--|
| `item_id` | `UUID PK FK` | |
| `qty_on_hand` | `NUMERIC(14,3) NOT NULL DEFAULT 0` | sum of open `item_batches.balance_units` |
| `qty_on_order` | `NUMERIC(14,3) NOT NULL DEFAULT 0` | sum of open `po_lines (qty_ordered - qty_received)` |
| `inv_value_amount` | `NUMERIC(14,2) NOT NULL DEFAULT 0` | `qty_on_hand × items.unit_price_amount` |
| `po_value_amount` | `NUMERIC(14,2) NOT NULL DEFAULT 0` | sum of open PO line amounts |
| `months_on_hand` | `NUMERIC(8,2) NULL` | `qty_on_hand ÷ selected 4-qtr demand`; `NULL` when demand = 0 (replaces Excel's `#DIV/0!`) |
| `status_code` | `TEXT NOT NULL` | from `compute_inventory_status` (§3.2) |
| `earliest_lot_expires_on` | `DATE NULL` | min `lots.expires_on` for active lots; powers the "Exp. Risk" hint |
| `last_movement_at` | `TIMESTAMPTZ NULL` | for the `Updated` column |
| `recalculated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | sanity / reseed marker |

**Refresh strategy:**
- Triggers on `ledger_entries`, `purchase_orders`, `lots(status)` keep
  it up.
- `pg_cron` daily 03:00 UTC full-recompute. Drift logs an
  `inventory.integrity_drift` audit event and writes the fix.

### 4.5 `app.ledger_entries` — append-only

Source of truth for `qty_on_hand`. Columns map **1:1** to the per-item
ledger sheet template (`XX-XXXX`): `Date`, `Units In`, `Units Out`,
`Balance`, `Location`, `Lot Number`, `Expiration`, `Initials`. Location
/ Lot / Expiration resolve via `batch_id → item_batches → lots`; the
FKs are denormalised onto this row for query speed.

| col | type | maps to Excel | notes |
|--|--|--|--|
| `id` | `UUID PK` | — | |
| `batch_id` | `UUID FK → app.item_batches` | — | resolves Location + Lot + Expiration in one hop |
| `item_id` | `UUID NOT NULL` | sheet header | denormalised; FK still enforced |
| `lot_id` | `UUID NOT NULL` | col F `Lot Number` | denormalised |
| `location_id` | `UUID NOT NULL` | col E `Location` | denormalised |
| `direction` | `TEXT NOT NULL CHECK (direction IN ('in','out','adjust'))` | implied by which of B/C is populated | |
| `qty_in` | `NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (qty_in >= 0)` | col B `Units In` | |
| `qty_out` | `NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (qty_out >= 0)` | col C `Units Out` | |
| `balance_after` | `NUMERIC(14,3) NOT NULL` | col D `Balance` | invariant: batch balance after this row |
| `occurred_on` | `DATE NOT NULL` | col A `Date` | business date |
| `occurred_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | — | system insert time |
| `initials` | `TEXT NOT NULL` | col H `Initials` | quick display label (denorm of `users.initials`) |
| `entered_by_user_id` | `UUID FK → app.users` | — | who clicked Submit |
| `signature_id` | `UUID FK → app.electronic_signatures NULL` | — | every signed transaction links here; **reason lives on the signature, not here** |
| `source` | `TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','import','adjustment','system'))` | — | |
| `import_batch_id` | `UUID NULL` | — | links to the bulk import job |
| `external_ref` | `TEXT NULL` | — | e.g. PO line ID, manufacturing run ID |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | — | |

**Fields explicitly NOT on `ledger_entries`:**

| Field | Why omitted |
|--|--|
| `reason_code` / `reason_note` | **Excel ledger has no reason column.** The 21 CFR Part 11 "reason for action" lives on `electronic_signatures.reason` |
| `meta.movement_reasons` | No such reference table |
| `is_signed` (boolean) | Derived from `signature_id IS NOT NULL` |

**DB-level rules:**

- `CHECK ((direction='in' AND qty_in>0 AND qty_out=0) OR (direction='out' AND qty_out>0 AND qty_in=0) OR (direction='adjust'))`
- `REVOKE UPDATE, DELETE ON app.ledger_entries FROM app_rw_role` — the API role can only `INSERT`/`SELECT`. Corrections happen by posting a compensating `adjust` entry (GxP property)
- `CHECK (occurred_on <= CURRENT_DATE + INTERVAL '1 day')` — no future-dated entries (timezone fudge only)

**Indexes:**
- `(item_id, occurred_on DESC, created_at DESC)` — item detail ledger query
- `(batch_id, occurred_on)` — per-batch running totals
- `(occurred_at DESC)` — system-wide activity
- `(entered_by_user_id, created_at DESC)` — user activity feed
- `(signature_id) WHERE signature_id IS NOT NULL` — find signed movements

### 4.6 `app.item_program_demand` — Excel cols N–AB

Physically in the master sheet but conceptually **forecast** data
(driven by `Select:` checkboxes in rows 3–38 that pick which quarters
sum into Months-on-Hand). Inventory reads from this table only for the
`item_balances.months_on_hand` derivation; the Forecast module owns its
lifecycle (see `forecast.md`).

| col | type | notes |
|--|--|--|
| `item_id` | `UUID FK` | |
| `program_id` | `UUID FK → meta.programs` | |
| `units` | `NUMERIC(14,3) NOT NULL DEFAULT 0` | col N / Q / T / W / Z |
| `ext_units` | `NUMERIC(14,3) NOT NULL DEFAULT 0` | col O / R / U / X / AA |
| `ext_value_amount` | `NUMERIC(14,2) NOT NULL DEFAULT 0` | col P / S / V / Y / AB |
| `created_at`, `updated_at` | | |
| PK | `(item_id, program_id)` | |

---

## 5. LN2 mapping

> **⚠️ Superseded for racks/positions (2026-06-04).** The rack/position model
> below — `ln2_rack`/`ln2_position` nodes in `meta.locations` +
> `app.ln2_position_state` — is **replaced** by explicit `meta.storage_racks` /
> `app.storage_positions` tables in [storage.md](./storage.md). In the
> authoritative model a rack is a `rows × cols` grid and **position status is
> binary `occupied` / `empty`** (no `reserved` / `out_of_service`). The
> `meta.locations` row-per-tank is retained. This section is kept for history;
> follow `storage.md` when building.

From the spec doc:
> "The system will support assignment and reassignment of cryogenic
> items to tank positions. The system will also allow status tracking
> for individual LN2 storage positions."

### 5.1 Position hierarchy

Modelled inside `meta.locations` (§3.5) with three dedicated `kind`
values: `ln2_tank`, `ln2_rack`, `ln2_position`. A tank typically has
multiple racks; a rack is typically 5×5 = 25 positions; each position
holds capacity 1 vial slot by default.

The current frontend types (`src/types/ln2.ts`) map onto this:
- `Tank` ↔ `meta.locations` row with `kind='ln2_tank'`
- `TankRack` ↔ child row with `kind='ln2_rack'`, `capacity_units = 25`
- `TankPosition` ↔ child row with `kind='ln2_position'`, `capacity_units = 1`
- `position.col`/`row` (A1..E5) → `metadata.col`, `metadata.row` JSONB fields, plus a `code` like `A1`

### 5.2 `app.ln2_position_state` — current occupancy

The mutable "what's here right now" overlay on top of the
`meta.locations` position row.

| col | type | notes |
|--|--|--|
| `location_id` | `UUID PK FK → meta.locations` | must reference a row with `kind='ln2_position'` (CHECK trigger) |
| `status` | `TEXT NOT NULL CHECK (status IN ('empty','occupied'))` | binary — `reserved` / `out_of_service` / `quarantine` dropped; see [storage.md §4.3](./storage.md) |
| `current_batch_id` | `UUID FK → app.item_batches NULL` | when occupied; NULL when empty |
| `current_lot_id` | `UUID FK → app.lots NULL` | denorm of `batches.lot_id` for cheap display |
| `current_item_id` | `UUID FK → app.items NULL` | denorm |
| `vial_count` | `INT NOT NULL DEFAULT 0 CHECK (vial_count >= 0)` | current # vials in this position; usually 1 but boxes/cassettes vary |
| `since` | `TIMESTAMPTZ NULL` | when current occupant was placed |
| `updated_by_user_id` | `UUID FK` | |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `row_version` | `INT NOT NULL DEFAULT 1` | optimistic locking |

Indexes: `(status)`, `(current_item_id)`, `(current_lot_id)`,
`(current_batch_id)`.

**Constraints:**
- `CHECK ((status = 'occupied') = (current_batch_id IS NOT NULL))` —
  occupied iff there's a batch
- Trigger `tg_ln2_position_state_kind` rejects updates where the linked
  `meta.locations.kind` is not `ln2_position`

### 5.3 `app.ln2_assignment_events` — append-only history

Every assign / reassign / remove is a row. Drives the position-history
panel and the audit trail. Append-only like the ledger.

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `location_id` | `UUID FK → meta.locations` | the position |
| `event_kind` | `TEXT NOT NULL CHECK (event_kind IN ('assigned','reassigned','removed','status_changed'))` | |
| `from_batch_id` | `UUID FK → app.item_batches NULL` | NULL on first assignment |
| `to_batch_id` | `UUID FK → app.item_batches NULL` | NULL on removal |
| `from_status` | `TEXT NULL` | for `status_changed` |
| `to_status` | `TEXT NULL` | |
| `vial_count_change` | `INT NOT NULL DEFAULT 0` | |
| `actor_user_id` | `UUID FK → app.users` | |
| `signature_id` | `UUID FK → app.electronic_signatures NULL` | required when the originating action is regulated |
| `occurred_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `notes` | `TEXT NULL` | |

`REVOKE UPDATE, DELETE FROM app_rw_role`.

Indexes: `(location_id, occurred_at DESC)`, `(to_batch_id)`,
`(from_batch_id)`.

### 5.4 Triggers

1. Updating `app.ln2_position_state` writes a row to
   `app.ln2_assignment_events` in the same transaction.
2. When an `app.ledger_entries` row brings a batch's balance to zero
   AND that batch was assigned to a position, the trigger sets the
   position state back to `empty` and emits a `removed` event.

---

## 6. Kanban workflow

From the spec doc:
> "The system will include a Kanban board view (or equivalent) enabling
> visual workflow management of inventory status. The Kanban board will
> have configurable columns representing inventory lifecycle stages, and
> drag-and-drop or click-based status transitions for individual
> inventory items."

### 6.1 `app.workflow_cards`

A card is **not** the same as an item — one item can have many cards over
its lifetime ("low-stock event in March", "expiration event in August").
This separates board state from item state cleanly.

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `item_id` | `UUID FK → app.items` | |
| `stage_id` | `UUID FK → meta.workflow_stages` | current stage |
| `priority` | `TEXT NOT NULL CHECK (priority IN ('critical','high','medium','low'))` | |
| `opened_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `closed_at` | `TIMESTAMPTZ NULL` | set when stage is terminal |
| `opened_reason` | `TEXT NOT NULL` | `auto_low_stock`, `manual`, `expiry_warning`, `recall_review`, … |
| `assignee_user_id` | `UUID FK NULL` | |
| `linked_po_id` | `UUID FK → app.purchase_orders NULL` | populated when stage = `ordered` and PO created |
| `linked_lot_id` | `UUID FK → app.lots NULL` | populated for expiry / recall cards |
| `notes` | `TEXT NULL` | |
| `created_at`, `updated_at` | | |

Indexes: `(stage_id, priority DESC, opened_at)` — board ordering;
`(item_id, closed_at)` — "any open card for this item?"

**Auto-creation:** the `tg_item_balances_low_stock_card` trigger on
`app.item_balances` opens a card with `opened_reason='auto_low_stock'`
when `status_code` transitions to `low_stock` and no open card exists
for that item.

### 6.2 `app.workflow_transitions` — append-only

One row per stage change. Drives the timeline shown in the card sheet.

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `card_id` | `UUID FK` | |
| `from_stage_id` | `UUID FK NULL` | NULL on first transition |
| `to_stage_id` | `UUID FK` | |
| `transitioned_by_user_id` | `UUID FK` | |
| `signature_id` | `UUID FK NULL` | required when the **target** stage's `requires_signature = TRUE` |
| `comment` | `TEXT NULL` | |
| `transitioned_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

`REVOKE UPDATE, DELETE FROM app_rw_role`.

Trigger `tg_workflow_card_stage_signature` rejects an `UPDATE` on
`app.workflow_cards.stage_id` where the target stage's
`requires_signature = TRUE` and no `signature_id` is provided on the
companion `app.workflow_transitions` row.

---

## 7. Notifications

From the spec doc:
> "The system will include time for inventory item reorder thresholds
> and notifications… send notifications to designated personnel when
> inventory items reach their reorder thresholds, ensuring timely
> replenishment of stock."
>
> "The system will include time for inventory expiration thresholds and
> notifications… send notifications to designated personnel when
> inventory items approach their expiration dates."

### 7.1 What triggers a notification

| `notification_kind.code` | Trigger | Source field |
|--|--|--|
| `reorder_threshold` | `item_balances.status_code` transitions to `low_stock` | `items.reorder_threshold` |
| `expiration_warning` | `lots.expires_on` is N days away (default 30, per-item override `items.expiry_warning_days`) | `lots.expires_on` |
| `expiration_imminent` | `lots.expires_on` is N days away (default 7) | `lots.expires_on` |
| `lot_recalled` | `lots.status` transitions to `recalled` | manual signed action |
| `low_stock_to_kanban` | Companion of `reorder_threshold` — notifies the workflow assignee that a card was opened | `workflow_cards.opened_reason='auto_low_stock'` |

### 7.2 `app.notification_subscriptions`

Per-user opt-in to a notification kind, with a delivery channel.

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `user_id` | `UUID FK → app.users` | |
| `kind_code` | `TEXT FK → meta.notification_kinds` | |
| `channel` | `TEXT NOT NULL CHECK (channel IN ('in_app','email','both'))` | |
| `is_active` | `BOOL NOT NULL DEFAULT TRUE` | |
| `created_at`, `updated_at` | | |

`UNIQUE (user_id, kind_code) WHERE is_active = TRUE`.

### 7.3 `app.item_watch_subscriptions` — per-item overrides

Lets a user watch one specific item without subscribing globally
(e.g. "ping me when *this* reagent gets low").

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `user_id` | `UUID FK` | |
| `item_id` | `UUID FK` | |
| `kinds` | `TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]` | subset of `notification_kinds.code` |
| `channel` | `TEXT NOT NULL CHECK (channel IN ('in_app','email','both'))` | |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

`UNIQUE (user_id, item_id)`.

### 7.4 `app.notification_deliveries`

The actual outbox of notifications to render in the bell / send to
email. Triggers populate it; a worker fans out to the chosen channel.

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `user_id` | `UUID FK → app.users` | recipient |
| `kind_code` | `TEXT FK → meta.notification_kinds` | |
| `subject_table` | `TEXT NOT NULL` | `items` / `lots` / `workflow_cards` |
| `subject_id` | `UUID NOT NULL` | |
| `body` | `JSONB NOT NULL` | rendered title + detail + link |
| `channel` | `TEXT NOT NULL` | resolved at creation time |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `delivered_at` | `TIMESTAMPTZ NULL` | when worker sent it (email) or first seen (in-app) |
| `read_at` | `TIMESTAMPTZ NULL` | |
| `dismissed_at` | `TIMESTAMPTZ NULL` | |

Indexes:
- `(user_id, read_at NULLS FIRST, created_at DESC)` — bell ordering
- `(delivered_at) WHERE delivered_at IS NULL` — worker queue
- `(subject_table, subject_id, created_at DESC)` — "all alerts for this item"

Retention: 90 days; older rows purged daily.

### 7.5 Triggers

1. `tg_item_balances_notify_low_stock` — after `status_code` transition
   to `low_stock`, fan out a `notification_deliveries` row per active
   subscription to `reorder_threshold` plus everyone watching the item.
2. `tg_lots_notify_expiring` — daily `pg_cron` job at 02:00 UTC scans
   lots whose `expires_on` is within the per-item warning window and
   emits `expiration_warning` / `expiration_imminent` rows.
3. `tg_lots_notify_recall` — on `lots.status` transition to `recalled`,
   fan out `lot_recalled` to all active subscribers and item watchers.

---

## 8. Electronic sign-off (21 CFR Part 11)

The signatures table is **shared** across modules (used by RBAC, PO
approvals, etc.), but is defined here because every regulated inventory
action depends on it. Other modules reference this section.

### 8.1 `app.electronic_signatures`

One row per signed action. Decoupled from `ledger_entries` because
signing also applies to non-ledger actions (lot recall, workflow
transitions to signed stages, item edits).

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `signer_user_id` | `UUID FK → app.users` | |
| `signed_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `intent` | `TEXT NOT NULL` | `record_movement`, `recall_lot`, `transition_workflow_stage`, `edit_item`, `approve_po` |
| `subject_table` | `TEXT NOT NULL` | polymorphic target (`ledger_entries`, `lots`, `workflow_cards`, `items`, `purchase_orders`) |
| `subject_id` | `UUID NOT NULL` | |
| `reason` | `TEXT NOT NULL` | **required per 21 CFR Part 11 §11.50** — this is the sole "reason for action" home (§4.5) |
| `username_attempted` | `CITEXT NOT NULL` | what the user typed |
| `password_verified_at` | `TIMESTAMPTZ NOT NULL` | when re-entry passed |
| `mfa_verified_at` | `TIMESTAMPTZ NULL` | when MFA enabled |
| `signature_image_url` | `TEXT NULL` | drawn signature stored in object storage |
| `signature_hash` | `TEXT NOT NULL` | SHA-256 of (signer_user_id, subject, reason, timestamp, signature_image_bytes) |
| `client_ip` | `INET NULL` | |
| `user_agent` | `TEXT NULL` | |

Indexes: `(subject_table, subject_id)`, `(signer_user_id, signed_at DESC)`.

`REVOKE UPDATE, DELETE` from the app role. **Signed = forever.**

### 8.2 Where inventory requires sign-off

| Action | Required? | Trigger / enforcement |
|--|--|--|
| Stock-out ledger entry (`direction='out'`) | **yes** (toggle in `app.settings.require_signature_on_stock_out`) | trigger `tg_ledger_require_signature_on_out` |
| Stock-in ledger entry (`direction='in'`) | configurable, default **yes** for regulated reagents | same trigger reads a per-item flag (future, gated by §99 Q6) |
| Adjustment ledger entry (`direction='adjust'`) | **always yes** | trigger rejects unsigned adjusts |
| Lot recall (`lots.status → 'recalled'`) | **yes** | trigger `tg_lots_require_recall_signature` |
| Workflow transition to a stage with `requires_signature=TRUE` | **yes** | trigger `tg_workflow_card_stage_signature` |
| LN2 position assignment / reassignment | **configurable** per-tank (`meta.locations.metadata.requires_signature_on_assign`); default **no** | trigger `tg_ln2_assignment_signature` |

---

## 9. Triggers & invariants (consolidated)

DB-level invariants for the inventory module:

1. **Ledger immutability** — `REVOKE UPDATE, DELETE … FROM app_rw_role`
   on `app.ledger_entries`, `app.ln2_assignment_events`,
   `app.workflow_transitions`, `app.electronic_signatures`.
2. **`item_number` uniqueness only** — `UNIQUE` partial index; no CHECK
   on the prefix (§3.1).
3. **Ledger balance integrity** — `tg_ledger_update_batch_balance` after
   each `INSERT` updates `item_batches.balance_units` and
   `item_balances.qty_on_hand` in the same transaction.
4. **Sign-off required for sensitive events** — triggers in §8.2.
5. ~~**Package-price invariant**~~ — **REMOVED (v2 §8 · migration
   `b7c8d9e0f1a2`).** There is no `price_per_package_amount` /
   `units_per_package` and no `tg_items_check_pkg_price` trigger: the
   system tracks **unit price only** (on lots / order lines), with no
   packaging-configuration price.
6. **Soft-delete sweep** — partial unique indexes
   (`WHERE deleted_at IS NULL`) so unique constraints release the value
   on logical delete.
7. **No future-dated `occurred_on`** — `CHECK (occurred_on <= CURRENT_DATE + INTERVAL '1 day')`.
8. **Lot auto-expiry** — `pg_cron` daily 02:30 sets `lots.status='expired'`
   where `expires_on < CURRENT_DATE AND status='active'`; emits
   `inventory.lot.expired` audit event per flip.
9. **Low-stock Kanban auto-card** — `tg_item_balances_low_stock_card`
   opens a `workflow_cards` row on `status_code → low_stock`.
10. **LN2 position kind guard** — `tg_ln2_position_state_kind` rejects
    state rows whose location is not `kind='ln2_position'`.
11. **LN2 occupancy invariant** — `CHECK ((status='occupied') = (current_batch_id IS NOT NULL))`.
12. **Low-stock notification fan-out** — `tg_item_balances_notify_low_stock`.
13. **Daily expiry notification scan** — `pg_cron` 02:00 emits
    `expiration_warning` / `expiration_imminent` deliveries.

---

## 10. Hot-path queries

### 10.1 Inventory list (paginated, filtered, sorted)

```sql
SELECT i.id,
       i.item_number,
       i.item_prefix,                     -- generated column
       i.description,
       v.name AS supplier,
       i.avg_lead_days,
       i.reorder_threshold,
       -- unit_price_amount / units_per_package REMOVED (v2 §8) — valuation
       -- now comes from lots (b.inv_value_amount below), not the item
       i.last_updated_on,
       b.qty_on_hand,
       b.qty_on_order,
       b.inv_value_amount,
       b.months_on_hand,
       b.status_code,
       b.earliest_lot_expires_on,
       b.last_movement_at
FROM   app.items        i
LEFT   JOIN meta.suppliers v ON v.id = i.supplier_id
LEFT   JOIN app.item_balances b ON b.item_id = i.id
WHERE  i.deleted_at IS NULL
  AND  ($1::text IS NULL OR b.status_code = $1)
  AND  ($2::text IS NULL OR i.item_prefix = $2)
  AND  ($3::text IS NULL OR i.description ILIKE '%' || $3 || '%')
ORDER  BY i.item_number
LIMIT  $4 OFFSET $5;
```

### 10.2 Item detail ledger (reason via signature)

```sql
SELECT l.occurred_on,
       l.qty_in,
       l.qty_out,
       l.balance_after,
       loc.code        AS location,
       lot.lot_number,
       lot.expires_on,
       u.initials,
       sig.reason      AS signed_reason,
       sig.signed_at,
       l.signature_id IS NOT NULL AS is_signed
FROM   app.ledger_entries          l
JOIN   meta.locations              loc ON loc.id = l.location_id
JOIN   app.lots                    lot ON lot.id = l.lot_id
JOIN   app.users                   u   ON u.id   = l.entered_by_user_id
LEFT   JOIN app.electronic_signatures sig ON sig.id = l.signature_id
WHERE  l.item_id = $1
ORDER  BY l.occurred_on DESC, l.created_at DESC
LIMIT  100;
```

### 10.3 LN2 rack view (positions in a rack with occupants)

```sql
SELECT pos.id           AS position_id,
       pos.code         AS position_code,
       pos.metadata->>'row' AS row,
       pos.metadata->>'col' AS col,
       st.status,
       st.vial_count,
       it.item_number,
       it.description,
       lot.lot_number,
       lot.expires_on
FROM   meta.locations pos
LEFT   JOIN app.ln2_position_state st ON st.location_id = pos.id
LEFT   JOIN app.items it   ON it.id  = st.current_item_id
LEFT   JOIN app.lots  lot  ON lot.id = st.current_lot_id
WHERE  pos.parent_id = $1            -- rack id
  AND  pos.kind = 'ln2_position'
ORDER  BY pos.metadata->>'col', (pos.metadata->>'row')::int;
```

### 10.4 Kanban board

```sql
SELECT s.code           AS stage_code,
       s.label          AS stage_label,
       s.tone,
       s.sort_order,
       c.id             AS card_id,
       c.priority,
       c.opened_at,
       c.opened_reason,
       i.item_number,
       i.description,
       v.name           AS supplier,
       b.qty_on_hand,
       b.qty_on_order,
       i.reorder_threshold
FROM   meta.workflow_stages s
LEFT   JOIN app.workflow_cards  c ON c.stage_id = s.id AND c.closed_at IS NULL
LEFT   JOIN app.items           i ON i.id = c.item_id
LEFT   JOIN meta.suppliers        v ON v.id = i.supplier_id
LEFT   JOIN app.item_balances   b ON b.item_id = c.item_id
WHERE  s.is_active = TRUE
ORDER  BY s.sort_order, c.priority DESC, c.opened_at;
```

### 10.5 Unread notifications for a user

```sql
SELECT d.id,
       d.kind_code,
       k.label          AS kind_label,
       d.subject_table,
       d.subject_id,
       d.body,
       d.created_at
FROM   app.notification_deliveries d
JOIN   meta.notification_kinds k ON k.code = d.kind_code
WHERE  d.user_id = $1
  AND  d.read_at IS NULL
  AND  d.dismissed_at IS NULL
ORDER  BY d.created_at DESC
LIMIT  50;
```

---

## 11. Seeder

A single command, e.g.
`python -m app.seed --source xlsx --file "Demo Inventory Control.xlsx"`.
Idempotent: re-running with the same xlsx is a no-op.

1. **Reference rows** — `meta.inventory_statuses` (3),
   `meta.units_of_measure`, `meta.notification_kinds` (5),
   `meta.workflow_stages` (6, seeded from `KANBAN_STAGES` constant).
2. **Locations tree** — seed a baseline `meta.locations` (site →
   freezers, fridges, PD lab, LN2 tanks → racks → positions). Extract
   distinct location strings from per-item ledger col E and create
   `kind='generic'` rows for any unmatched.
3. **Suppliers** — upsert `meta.suppliers` from master sheet col C. **Skip
   blank supplier strings** (the empty-supplier rows in Excel).
4. **Items** — upsert `app.items` from master sheet (rows 50+). Map
   each column per §4.1. No prefix validation (§3.1). Reject only on
   missing `item_number` / duplicate.
5. **Per-item ledger sheets** — for each `CM-####`, `NM-####`, … sheet:
   1. Upsert `app.lots` for each distinct `Lot Number`.
   2. Upsert `app.item_batches` for each `(item, lot, location)` triple.
   3. Insert `app.ledger_entries` for each populated row. **No reason
      column** (§4.5). Idempotency key:
      `(item_id, occurred_on, qty_in, qty_out, lot_id, location_id, initials, source='import')`.
   4. Historical imports are unsigned by default (`signature_id = NULL`).
6. **Balances recompute** — full pass to populate `app.item_balances`.
7. **Audit** — write one `audit.audit_events` row per import
   (`event_type='inventory.import.completed'`).

---

## 12. Cross-module references

**Reads from:**

| Other module | What it uses |
|--|--|
| `identity-access.md` (users) | `entered_by_user_id`, `created_by_user_id`, `updated_by_user_id`, `signer_user_id`, `assignee_user_id` |
| `purchase-orders.md` | `qty_on_order`, `po_value_amount` derivation; `workflow_cards.linked_po_id` |
| `forecast.md` (programs) | `item_program_demand.program_id`; allocations table for `lots.status='reserved'` |

**Writes to:**

| Other module | Events |
|--|--|
| `audit-logs.md` (`audit.audit_events`) | `inventory.item.created`, `inventory.item.edited`, `inventory.movement.signed`, `inventory.lot.expired`, `inventory.lot.recalled`, `inventory.ln2.assigned`, `inventory.ln2.removed`, `inventory.workflow.transitioned`, `inventory.import.completed`, `inventory.integrity_drift` |
| `notifications.md` worker | `notification_deliveries` rows for `reorder_threshold`, `expiration_warning`, `expiration_imminent`, `lot_recalled`, `low_stock_to_kanban` |

---

## 99. Open questions

Resolved questions are struck through.

1. ~~**Item-prefix list location.**~~ **Resolved 2026-05-26:** free-form
   `item_number`; no category table, no prefix CHECK, no lookup. Whatever
   the user types is stored. `UNIQUE` is the only backend rule. `item_prefix`
   generated column for convenience filtering only.
2. ~~**`price_per_package_amount` storage.**~~ **Superseded 2026-06-11
   (v2 §8):** no package-configuration price. Package/UOM columns dropped
   (migration `b7c8d9e0f1a2`); **track unit price only** — variable package
   sizes make package-level pricing impractical.
3. ~~**Quarantine model.**~~ **Resolved 2026-05-26:** deferred from v1.
   No `lots.status='quarantine'`, no quarantine workflow card, no
   quarantines table.
4. ~~**Lot status enum.**~~ **Resolved 2026-05-26:** 5 values —
   `active`, `reserved`, `expired`, `consumed`, `recalled`.
5. ~~**Materials layer.**~~ **Resolved 2026-05-26:** no. `lots.item_id`
   is a direct FK; one lot belongs to one item.

**Still open:**

6. **Sign-off scope for stock-in.** Spec doc requires "electronic
   sign-off for all status changes" but doesn't enumerate which ledger
   directions count. Current default: signed `out` and `adjust`,
   unsigned `in` (supplier receipts). Confirm, or expand to all
   directions, or make per-item / per-category configurable?
7. **Default expiration warning lead times.** Spec doc says "approach
   their expiration dates" without specifying days. Proposed: 30 days
   for `expiration_warning`, 7 days for `expiration_imminent`. Per-item
   override on `items.expiry_warning_days`. Confirm thresholds.
8. **Kanban stage wording.** Current seed (`low_stock`, `review`,
   `pending`, `ordered`, `received`, `closed`) is from the existing
   frontend. The spec doc calls them "configurable" but doesn't
   enumerate. Renames pre-launch are free; post-launch require care.
   Confirm.
9. **LN2 vial count semantics.** A position holds 1 box / cassette /
   single vial depending on the tank type. The frontend types call it
   `vialCount`. Confirm we want `vial_count INT` on
   `ln2_position_state` or a more generic `unit_count` to handle
   non-vial cryo storage.
10. **Notification channels.** v1 supports `in_app` and `email`. Any
    requirement for SMS, Slack, or webhook? Affects the
    `notification_deliveries.channel` CHECK and the worker fan-out.

---

*End of Inventory Module spec.* Resolve questions 6–10, then this file
drives Alembic migrations + the corresponding frontend type changes.
