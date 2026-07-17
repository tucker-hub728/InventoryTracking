# CellReady IMS — Backend Data Structure (Proposal)

> Target stack: **FastAPI · SQLAlchemy 2.x · Alembic · PostgreSQL 16+**.
> Seeding via a small idempotent seeder (factory-boy / custom) that reads
> `Demo Inventory Control.xlsx` through the same logic as
> `scripts/sync-from-xlsx.py`.
>
> Audience: senior backend engineer review. This document is a contract — once
> approved, Alembic migrations and SQLAlchemy models are derived from it 1:1.

---

## 1. Design principles

These are the rules every table below obeys. They are non-negotiable for a
21 CFR Part 11 / GxP-style inventory system.

1. **Excel + spec doc are the source of truth for the domain shape.**
   `Demo Inventory Control.xlsx` defines the inventory fields; the
   Technical Software Spec defines the surrounding modules (RBAC, Kanban,
   LN2, expiration / reorder notifications, 21 CFR Part 11 sign-off). We
   do **not** invent fields, statuses, or grouping concepts that the
   workbook and spec doc don't already imply. Anything not derivable from
   those sources is called out explicitly (see §4.1) and gated by an open
   question.
2. **Append-only audit.** Anything that touches inventory state is an event,
   not an in-place mutation. The current view is derived from the event log,
   or kept in a denormalised snapshot table that is regenerable from events.
3. **No hard deletes for regulated data.** `deleted_at TIMESTAMPTZ` on
   operational tables; the audit log and ledger never delete.
4. **Time-ordered, opaque IDs.** Primary keys are `UUIDv7` (16 bytes, B-tree
   friendly because the leading bits are the millisecond timestamp). Avoids
   enumeration leaks and is distributed-friendly when we shard later. Use
   `uuid7()` (extension `pg_uuidv7` or app-generated).
5. **Single-organisation by design.** No multi-tenant scaffolding. A super
   admin manages all users, items, and audit data globally. Row-level
   scoping is by user/role, not by tenant.
6. **Numeric money.** All currency in `NUMERIC(14,2)`. Never `FLOAT`.
7. **Time is UTC `TIMESTAMPTZ`.** Local time is a presentation concern.
8. **Optimistic concurrency.** Mutable rows carry `row_version INT NOT NULL
   DEFAULT 1`; the API requires `If-Match` and bumps on write.
9. **Foreign-key integrity is enforced**, with deliberate cascade choices:
   - `ON DELETE RESTRICT` for anything an audit row points at.
   - `ON DELETE CASCADE` only for app-owned child rows (e.g. PO lines).
10. **Reference tables, not enums.** Status / role lookups live in real
    tables, so non-engineers can add values without a migration. Where a
    strict closed set is required (e.g. ledger direction, item prefix), use
    a `CHECK` constraint, not a Postgres `ENUM` (changing enum members is
    migration-hostile).
11. **Logs are tiered, partitioned, and bounded.** See §10. The biggest
    operational risk for this system is unbounded log growth, so the design
    addresses it explicitly.

---

## 2. Naming & convention

| Concern | Choice |
|--|--|
| Table names | `snake_case`, plural (`items`, `ledger_entries`) |
| Column names | `snake_case`; booleans prefixed `is_` / `has_` |
| PK column | always `id UUID DEFAULT uuid7() PRIMARY KEY` |
| FK column | `<table_singular>_id` (`item_id`, `lot_id`) |
| Timestamps | `created_at`, `updated_at`, `deleted_at` |
| Authorship | `created_by_user_id`, `updated_by_user_id` |
| Money | `NUMERIC(14,2)`, suffix `_amount` or `_price` |
| Quantity | `NUMERIC(14,3)` (not `INT` — partial units, expressed in `units_of_measure`) |
| Soft delete | `deleted_at TIMESTAMPTZ NULL` + partial unique indexes `WHERE deleted_at IS NULL` |
| Indexes | `ix_<table>_<col>` for single, `ix_<table>_<col1>_<col2>` for composite |
| Constraints | `ck_<table>_<rule>`, `uq_<table>_<cols>` |
| Schemas | `app` (operational), `audit` (immutable log), `meta` (reference data), `archive` (detached partitions) |

---

## 3. ER overview (textual)

```
   ┌──────────┐ ┌───────────┐  ┌────────────┐      ┌─────────────┐
   │ users    │ │ suppliers   │  │ programs   │      │  locations  │
   │ roles    │ │           │  │ (IDP-023…) │      │ (tree)      │
   │ permissions             └────────────┘      └─────┬────────┘
   └────┬─────┘                                          │
        │   role_permissions                             │
        │   user_role_assignments                  ┌─────▼──────┐
        │                                          │ ln2_tanks  │
   ┌────▼──────────────────┐                       │ positions  │
   │       items           │                       └─────┬──────┘
   │ (master tracker)      │                             │
   │ item_number prefix    │                             │
   │ ∈ {CM,NM,CR,AY}       │                             │
   └─┬────────┬────────────┘                             │
     │        │                                          │
     │        └──► purchase_orders → po_lines            │
     │                                                   │
     ▼                                                   │
   lots  (lot_number, expires_on, status)                │
     │                                                   │
     ▼                                                   │
   item_batches  (item × lot × location)  ─────────────► │
     │
     ▼
   ledger_entries  (in/out movements; append-only;
                    NO reason column — matches Excel)
     │
     ▼
   electronic_signatures  (the only place "reason for
                            action" is stored, per 21 CFR Part 11)

   workflow_cards ──► workflow_transitions
   forecast_periods ──► forecast_demand, mfg_schedule

   audit.audit_events  (PARTITIONED BY RANGE (occurred_at), monthly)
   audit.notification_feed (short-retention activity stream)
```

---

## 4. Reference / lookup tables (`meta` schema)

Small, slowly-changing. Seeded from migrations; editable via admin UI later.

### 4.1 Item prefix — **no `meta.categories` table**

The Excel workbook **does not have a "category" column**. The only signal of
grouping is the 2-letter prefix on `item_number` (`CM-0001`, `NM-0237`,
`CR-0472`, `AY-0454`). The labels we previously assigned to those prefixes
("Cell-therapy media / reagent", etc.) were our interpretation, not data
from the client, and are removed.

Decision: **no `meta.categories` table**. The prefix is enforced as a
`CHECK` constraint directly on `app.items.item_number` (see §6.1) and is
the only "grouping" exposed to the UI. If a future spec adds true
categorisation, we re-introduce the table then — no schema regret because
nothing currently joins to it.

The allowed prefix set is configured in one place:

```sql
ALTER TABLE app.items
  ADD CONSTRAINT ck_items_item_number_prefix
  CHECK (substring(item_number FROM 1 FOR 3) IN ('CM-','NM-','CR-','AY-'));
```

If non-engineers must add new prefixes without a migration, promote this
to a tiny `meta.item_prefixes(code TEXT PK, sort_order INT, is_active BOOL)`
table — see open question §17.1.

### 4.2 `meta.inventory_statuses`

The Excel workbook does not store a status enum on items — status is
**derived** from quantity, threshold, and the lots' expiration dates. We
expose the three derivable values only:

| col | type | notes |
|--|--|--|
| `code` | `TEXT PK` | `available`, `low_stock`, `out_of_stock` |
| `label` | `TEXT NOT NULL` | |
| `tone` | `TEXT NOT NULL` | UI badge tone (`success`, `warning`, `neutral`) |

Derivation (computed in `compute_inventory_status(item_id)` — see §6.5):

| Condition | Status |
|--|--|
| `qty_on_hand = 0` | `out_of_stock` |
| `qty_on_hand <= reorder_threshold` | `low_stock` |
| else | `available` |

**Expiration is a lot-level concern**, not an item-level status. A lot
that is past `expires_on` carries `lots.status = 'expired'` (§6.3) — the
item rolls that up only as a UI hint, not as its own status value.
**`quarantine` is a lot-level status too** (§6.3). Neither belongs in
this table.

Why a table not enum: should the spec ever add a fourth derivable item-
level value (e.g. `expiring_soon` if the UI starts showing it on the list
view), we add a row, not a migration.

### 4.3 ~~`meta.units_of_measure`~~ — REMOVED

**Dropped entirely (v2 §8 · migration `b7c8d9e0f1a2`, 2026-06-23).** UOM was
removed along with the package/price columns; quantities are whole units and
there is no unit-of-measure lookup.

### 4.4 `meta.locations`

Hierarchical (closure table or `ltree`). Covers everything from a freezer
down to a single LN2 position.

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `parent_id` | `UUID NULL FK → meta.locations(id)` | |
| `path` | `LTREE NOT NULL` | enables `WHERE path <@ 'site_A.frz.A.02'` |
| `code` | `TEXT NOT NULL` | last segment (`A-02`, `Rack D`) |
| `name` | `TEXT NOT NULL` | human label |
| `kind` | `TEXT NOT NULL CHECK (kind IN ('site','room','freezer','shelf','ln2_tank','ln2_rack','ln2_position','generic'))` | |
| `temperature_c` | `NUMERIC(5,2) NULL` | optional |
| `capacity_units` | `INT NULL` | for positions |
| `metadata` | `JSONB NOT NULL DEFAULT '{}'::jsonb` | freeform attrs |
| `is_active` | `BOOL NOT NULL DEFAULT TRUE` | |

Indexes: `GIST(path)`, `(parent_id)`, `(kind)`.

Why `ltree` over closure: smaller; common ancestor lookups via `<@` and `@>`
are O(log n); fits 99% of "show all positions under this rack" queries.

### 4.5 `meta.suppliers`

`id`, `name UNIQUE`, `contact_email`, `phone`, `address JSONB`,
`is_active`, `notes`.

Seeded from the 74 distinct suppliers in the workbook.

### 4.6 `meta.programs`

The columns N–AB in the master tracker are per-program demand. One row per
program: `code` (`IDP-023`, `G-CART`, `NEW-SKU-1`…), `label`, `customer`,
`is_active`.

### 4.7 `meta.workflow_stages`

The Kanban stages (`low_stock`, `review`, `pending`, `ordered`, `received`,
`closed`). `id`, `code UNIQUE`, `label`, `tone`, `sort_order`, `is_terminal`.

---

## 5. Identity & access (`app` schema)

### 5.1 `app.settings`

A single-row table for global application config. Used for things like
"is signature required on stock-out?" and "default movement reasons enabled".

| col | type | notes |
|--|--|--|
| `id` | `BOOL PRIMARY KEY DEFAULT TRUE CHECK (id)` | enforces exactly one row |
| `org_name` | `TEXT NOT NULL` | display name (e.g. "CellReady") |
| `require_signature_on_stock_out` | `BOOL NOT NULL DEFAULT TRUE` | |
| `require_mfa` | `BOOL NOT NULL DEFAULT FALSE` | |
| `settings` | `JSONB NOT NULL DEFAULT '{}'::jsonb` | free-form |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `updated_by_user_id` | `UUID FK` | |

### 5.2 `app.users`

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `email` | `CITEXT NOT NULL` | case-insensitive |
| `full_name` | `TEXT NOT NULL` | |
| `initials` | `TEXT NOT NULL` | shown on signatures |
| `password_hash` | `TEXT NULL` | Argon2id; `NULL` for SSO-only |
| `mfa_secret` | `TEXT NULL` | encrypted at app layer (KMS) |
| `mfa_enabled` | `BOOL NOT NULL DEFAULT FALSE` | |
| `status` | `TEXT NOT NULL CHECK (status IN ('active','invited','suspended'))` | |
| `last_active_at` | `TIMESTAMPTZ NULL` | denormalised; updated by session worker, not on every request |
| `invited_at`, `invited_by_user_id` | invite trail | |
| `accepted_invite_at` | | |
| `created_at`, `updated_at`, `deleted_at` | | |

Constraints:
- `UNIQUE (lower(email)) WHERE deleted_at IS NULL`
- `CHECK (password_hash IS NOT NULL OR external_idp IS NOT NULL)` (when SSO added)

The `super_admin` role is bootstrapped at seed time and cannot be revoked
from itself (a trigger refuses the last `super_admin` user being suspended
or losing the role).

### 5.3 `app.roles`

`id`, `code UNIQUE` (`super_admin`, `admin`, `editor`, `viewer`), `name`,
`description`, `is_system BOOL` (system roles can't be deleted or have
their `code` mutated).

| role | scope |
|--|--|
| `super_admin` | full access; manages users, roles, settings, audit exports; bypass of standard sign-off requirements forbidden (must still e-sign regulated actions) |
| `admin` | user management + all inventory actions |
| `editor` | inventory create/edit/sign; no user management |
| `viewer` | read-only; can view audit log if granted |

### 5.4 `app.permissions`

`id`, `resource TEXT` (`inventory`, `users`, `audit`), `action TEXT`
(`view`, `create`, `edit`, `delete`, `sign`, `export`). `UNIQUE (resource, action)`.

### 5.5 `app.role_permissions`

`role_id`, `permission_id`, `PRIMARY KEY (role_id, permission_id)`.

### 5.6 `app.user_role_assignments`

`user_id`, `role_id`, `granted_at`, `granted_by_user_id`, `revoked_at NULL`,
`PRIMARY KEY (user_id, role_id, granted_at)`.

Append-only: revocation sets `revoked_at`. Lets us answer "what role did
Amelia have on 2026-02-13?" without a separate history table.

### 5.7 `app.sessions`

`id`, `user_id`, `created_at`, `expires_at`, `last_seen_at`, `ip_inet INET`,
`user_agent TEXT`, `revoked_at NULL`.

Use a hashed token; never store the raw bearer.

Index: `(user_id, revoked_at)`, `(expires_at)` for the cleanup job.

---

## 6. Inventory core (`app` schema)

### 6.1 `app.items`  — master tracker (one row per Excel row 50+)

Columns map **1:1** to the `Component Inventory Tracker` master sheet,
header row 49. Anything below that the Excel does not have is called out
under "Fields explicitly NOT stored on `items`".

| col | type | maps to Excel | notes |
|--|--|--|--|
| `id` | `UUID PK` | — | internal |
| `item_number` | `TEXT NOT NULL` | col B `Item # (MIN)` | e.g. `NM-0237`. `UNIQUE (item_number) WHERE deleted_at IS NULL`. Prefix CHECK enforces `CM-/NM-/CR-/AY-` (§4.1). |
| `description` | `TEXT NOT NULL` | col A `Item Description` | |
| `supplier_id` | `UUID FK → meta.suppliers` | col C `Supplier` | nullable for unsourced items |
| `avg_lead_days` | `INT NULL` | col D `Average Lead Times (Days)` | |
| `reorder_threshold` | `NUMERIC(14,3) NOT NULL DEFAULT 0` | col M `MUST HAVE INVENTORY LEVEL` | |
| ~~`unit_price_amount`~~ | — | col AC `Unit Price` | **REMOVED (v2 §8 · migration `b7c8d9e0f1a2`, 2026-06-23).** Unit price now lives on the **lot** (`app.lots.unit_price_amount`) and order lines; item inv $ / PO $ are derived (Σ qty × lot unit price). |
| ~~`units_per_package`~~ | — | col AD `Units Per package configuration` | **REMOVED (v2 §8).** No package-configuration concept — variable package sizes make package-level pricing impractical; **track unit price only**. |
| ~~`price_per_package_amount`~~ | — | col AE `Price Per Package configuration` | **REMOVED (v2 §8).** No separate packaging-configuration price. |
| ~~`uom_code`~~ | — | — | **REMOVED (migration `b7c8d9e0f1a2`).** `meta.units_of_measure` dropped entirely; quantities are whole units. |
| `po_note` | `TEXT NULL` | col I `Comment/ Note on Outstanding POs` | |
| `po_due_text` | `TEXT NULL` | col J `PO Due Date(s)` | free-form on the master sheet; structured POs live in `purchase_orders` |
| `must_order_flag` | `BOOL NOT NULL DEFAULT FALSE` | col L `Must Order` | |
| `last_updated_on` | `DATE NULL` | col AF `Date Updated` | the workbook's own "Date Updated" column; preserved for source-of-truth comparison and surfaced as the `Updated` column in the inventory list. Distinct from the row's `updated_at`. |
| `notes` | `TEXT NULL` | — | |
| `metadata` | `JSONB NOT NULL DEFAULT '{}'::jsonb` | — | future-proof |
| `row_version` | `INT NOT NULL DEFAULT 1` | — | optimistic locking |
| `created_at`, `updated_at`, `deleted_at` | | | |
| `created_by_user_id`, `updated_by_user_id` | | | |

Indexes:
- `UNIQUE (item_number) WHERE deleted_at IS NULL`
- `(supplier_id)`
- `(substring(item_number FROM 1 FOR 2))` — for the prefix-group filter in the list view (or use a generated column `item_prefix` if the planner needs it)
- `GIN (to_tsvector('english', description))` — for the search bar
- `(updated_at DESC)`, `(last_updated_on DESC)` — recently-changed list

**Fields explicitly NOT stored on `items` (matches Excel + spec doc):**

| Field | Why omitted |
|--|--|
| `tier_id` / `tier` | Excel has no tier column; the 2-letter prefix is the only grouping signal (§4.1) |
| `location`, `lot`, `expires` | Per-receipt, not per-item. Live on `lots` and `item_batches`; the inventory detail page shows them as "latest batch" via a join |
| `status` (enum value column) | Derived from `qty_on_hand` + `reorder_threshold` (§4.2); not stored |
| `qty_on_hand` | Derived from the ledger sum; cached in `app.item_balances` (§6.5) |
| `inv_value_amount` | Derived (= `qty_on_hand` × `unit_price_amount`); cached in `app.item_balances` |
| `po_value_amount` | Derived from open `purchase_orders`; cached in `app.item_balances` |
| `months_on_hand` (Excel col H) | Derived from forecast demand ÷ `qty_on_hand`; cached in `app.item_balances` |

### 6.2 `app.item_program_demand` — Excel cols N–AB

Per-program SKU breakdown. These columns are physically in the
`Component Inventory Tracker` sheet but are conceptually **forecast** data
(driven by the `Select:` checkboxes in rows 3–38 that pick which forecast
quarters are summed into Months-on-Hand). They live next to `items` only
because the workbook collocates them.

| col | type | notes |
|--|--|--|
| `item_id` | `UUID FK` | |
| `program_id` | `UUID FK → meta.programs` | |
| `units` | `NUMERIC(14,3) NOT NULL DEFAULT 0` | col N / Q / T / W / Z |
| `ext_units` | `NUMERIC(14,3) NOT NULL DEFAULT 0` | col O / R / U / X / AA |
| `ext_value_amount` | `NUMERIC(14,2) NOT NULL DEFAULT 0` | col P / S / V / Y / AB |
| `created_at`, `updated_at` | | |
| PK | `(item_id, program_id)` | |

This table is the **current snapshot** of selected demand per (item,
program). The full per-period history lives in `app.forecast_demand`
(§9.2). The Inventory module reads from this table only for the
"Months on Hand" derivation; the Forecast module owns its lifecycle.

### 6.3 `app.lots`

A lot is a manufacturer-issued batch identifier with an expiration. A given
item can have many lots over time.

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `item_id` | `UUID FK` | |
| `lot_number` | `TEXT NOT NULL` | |
| `expires_on` | `DATE NULL` | |
| `received_on` | `DATE NULL` | first time we saw it |
| `status` | `TEXT NOT NULL CHECK (status IN ('active','quarantine','expired','consumed','recalled'))` | |
| `coa_url` | `TEXT NULL` | certificate of analysis |
| `metadata` | `JSONB NOT NULL DEFAULT '{}'::jsonb` | |
| `created_at`, `updated_at` | | |

`UNIQUE (item_id, lot_number)`.
Index: `(item_id, expires_on)`, `(status)`.

### 6.4 `app.item_batches` — Excel "batch rows" inside per-item sheets

A `batch` is `(item, lot, location)`. Each Excel per-item sheet holds up to
four such batches, with subtotal rows separating them. Modelling this
explicitly lets us correctly express "20 units of lot X at FRZ-A-03 and 15
of lot X at PD LAB" — the current TS shape can't.

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `item_id` | `UUID FK` | |
| `lot_id` | `UUID FK` | |
| `location_id` | `UUID FK → meta.locations` | |
| `opened_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | first entry posted |
| `closed_at` | `TIMESTAMPTZ NULL` | set when balance returns to zero |
| `balance_units` | `NUMERIC(14,3) NOT NULL DEFAULT 0` | denormalised running balance (also derivable from ledger sum, but expensive at scale) |
| PK | `id` | |

`UNIQUE (item_id, lot_id, location_id) WHERE closed_at IS NULL`
prevents two simultaneous open batches for the same triple.

Index: `(item_id)`, `(lot_id)`, `(location_id)`.

### 6.5 `app.item_balances` — denormalised snapshot

A small table holding the current totals per item, updated by a trigger on
`ledger_entries`. Kept because dashboards / KPIs would otherwise need a
sum-and-group over millions of rows.

| col | type | notes |
|--|--|--|
| `item_id` | `UUID PK FK` | |
| `qty_on_hand` | `NUMERIC(14,3) NOT NULL DEFAULT 0` | |
| `qty_on_order` | `NUMERIC(14,3) NOT NULL DEFAULT 0` | from `purchase_orders` |
| `inv_value_amount` | `NUMERIC(14,2) NOT NULL DEFAULT 0` | |
| `po_value_amount` | `NUMERIC(14,2) NOT NULL DEFAULT 0` | |
| `status_code` | `TEXT NOT NULL` | computed |
| `last_movement_at` | `TIMESTAMPTZ NULL` | for `Updated` column in the table |
| `recalculated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | sanity / reseed marker |

Refresh strategy:
- Triggers on `ledger_entries`, `purchase_orders`, `lots(status)` keep it up.
- A periodic job (`pg_cron` daily 03:00) full-recomputes from source. If
  values drift it logs an `integrity_drift` audit event and writes the fix.

### 6.6 `app.ledger_entries` — **append-only**

Every inventory movement is one row. This is the source of truth.

Columns map **1:1** to the per-item ledger sheet template (`XX-XXXX`):
`Date`, `Units In`, `Units Out`, `Balance`, `Location`, `Lot Number`,
`Expiration`, `Initials`. Location / Lot / Expiration are stored on the
joined `item_batches` / `lots` rows (not duplicated here) — see denorm
note below.

| col | type | maps to Excel | notes |
|--|--|--|--|
| `id` | `UUID PK` | — | |
| `batch_id` | `UUID FK → app.item_batches` | — | resolves Location + Lot + Expiration in one hop |
| `item_id` | `UUID NOT NULL` | sheet header `Item Number` | denormalised for query speed; FK still enforced |
| `lot_id` | `UUID NOT NULL` | col F `Lot Number` | denormalised |
| `location_id` | `UUID NOT NULL` | col E `Location` | denormalised |
| `direction` | `TEXT NOT NULL CHECK (direction IN ('in','out','adjust'))` | implied by which of cols B/C is populated | |
| `qty_in` | `NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (qty_in >= 0)` | col B `Units In` | |
| `qty_out` | `NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (qty_out >= 0)` | col C `Units Out` | |
| `balance_after` | `NUMERIC(14,3) NOT NULL` | col D `Balance` | invariant: batch balance after this row |
| `occurred_on` | `DATE NOT NULL` | col A `Date` | the business date |
| `occurred_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | — | the system insert time |
| `initials` | `TEXT NOT NULL` | col H `Initials` | quick display label (denorm of `users.initials`) |
| `entered_by_user_id` | `UUID FK → app.users` | — | who clicked Submit |
| `signature_id` | `UUID FK → app.electronic_signatures NULL` | — | every signed transaction links here; reason-for-action lives on the signature row, not here |
| `source` | `TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','import','adjustment','system'))` | — | |
| `import_batch_id` | `UUID NULL` | — | links to the bulk import job that created it |
| `external_ref` | `TEXT NULL` | — | e.g. PO line ID, manufacturing run ID |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | — | |

**Fields explicitly NOT on `ledger_entries`:**

- `reason_code` / `reason_note` — **the Excel ledger has no reason column**.
  Adding one would diverge from the workbook. The 21 CFR Part 11
  "reason for action" requirement is satisfied by the corresponding row
  on `app.electronic_signatures` (§6.7), which is the regulated record.
  This also avoids two parallel "reason" fields drifting out of sync.
- `meta.movement_reasons` — no such reference table; nothing references it.

**Hard rules enforced at the DB level:**
- `CHECK ((direction='in' AND qty_in>0 AND qty_out=0) OR (direction='out' AND qty_out>0 AND qty_in=0) OR (direction='adjust'))`
- `REVOKE UPDATE, DELETE ON app.ledger_entries FROM app_rw_role` — the API role can only `INSERT`/`SELECT`. Corrections happen by posting a compensating `adjust` entry. This is the GxP property.

**Indexes:**
- `(item_id, occurred_on DESC, created_at DESC)` — main query (item detail ledger)
- `(batch_id, occurred_on)` — per-batch totals
- `(occurred_at DESC)` — system-wide activity
- `(entered_by_user_id, created_at DESC)` — user activity feed

### 6.7 `app.electronic_signatures` — 21 CFR Part 11

One row per signed action. Decoupled from `ledger_entries` because signing
also applies to non-ledger actions (role changes, item edits, PO approvals).

**`reason` lives here and only here.** The Excel ledger has no reason
column; the regulated "reason for action" required by 21 CFR Part 11 §11.50
is captured on the signature row that the ledger entry links to. The
`Record Stock Movement` UI collects "reason" as part of the sign-off step,
not as a ledger field.

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `signer_user_id` | `UUID FK → app.users` | |
| `signed_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `intent` | `TEXT NOT NULL` | e.g. `record_movement`, `approve_po`, `change_role`, `release_quarantine` |
| `subject_table` | `TEXT NOT NULL` | polymorphic target |
| `subject_id` | `UUID NOT NULL` | |
| `reason` | `TEXT NOT NULL` | required per 21 CFR Part 11 §11.50 |
| `username_attempted` | `CITEXT NOT NULL` | what the user typed |
| `password_verified_at` | `TIMESTAMPTZ NOT NULL` | when the re-entry passed |
| `mfa_verified_at` | `TIMESTAMPTZ NULL` | when MFA enabled |
| `signature_image_url` | `TEXT NULL` | drawn signature stored in object storage |
| `signature_hash` | `TEXT NOT NULL` | SHA-256 of (signer_user_id, subject, reason, timestamp, signature_image_bytes) |
| `client_ip` | `INET NULL` | |
| `user_agent` | `TEXT NULL` | |

Indexes: `(subject_table, subject_id)`, `(signer_user_id, signed_at DESC)`.

`REVOKE UPDATE, DELETE` from app role. Signed = forever.

### 6.8 Purchase orders

`app.purchase_orders` — `id`, `supplier_id`, `po_number UNIQUE`,
`status` (`draft`/`sent`/`partial`/`received`/`closed`/`cancelled`),
`ordered_at`, `expected_at`, `closed_at`, `total_amount`, `currency`,
`approval_signature_id NULL`, audit cols.

`app.po_lines` — `id`, `po_id`, `item_id`, `qty_ordered`, `qty_received`,
`unit_price_amount`, `expected_at`, `lot_received_id NULL`.

Index: `(po_id)`, `(item_id, status)`.

---

## 7. Storage layout (LN2 + general)

Modelled via `meta.locations` (§4.4) for the tree, with a thin overlay:

### 7.1 `app.ln2_position_state`

For LN2 positions specifically (kind=`ln2_position`), track what's there.

| col | type | notes |
|--|--|--|
| `location_id` | `UUID PK FK → meta.locations` | |
| `status` | `TEXT NOT NULL CHECK (status IN ('empty','occupied','reserved','quarantine'))` | |
| `current_batch_id` | `UUID FK → app.item_batches NULL` | when occupied |
| `since` | `TIMESTAMPTZ NULL` | |
| `updated_by_user_id` | `UUID FK` | |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `row_version` | `INT NOT NULL DEFAULT 1` | |

Position moves are events in `app.ln2_position_events` (see audit §10) so we
preserve "who put what where, when, and signed by whom".

---

## 8. Workflow / Kanban

### 8.1 `app.workflow_cards`

A workflow card is a *separate* concept from an item — one item can have
multiple cards over time ("low stock event in March", "expiration event in
August"). This is closer to how the business actually uses the board.

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `item_id` | `UUID FK` | |
| `stage_id` | `UUID FK → meta.workflow_stages` | current stage |
| `priority` | `TEXT NOT NULL CHECK (priority IN ('critical','high','medium','low'))` | |
| `opened_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `closed_at` | `TIMESTAMPTZ NULL` | terminal stage |
| `opened_reason` | `TEXT NOT NULL` | `auto_low_stock`, `manual`, `expiry_warning`, … |
| `assignee_user_id` | `UUID FK NULL` | |
| `linked_po_id` | `UUID FK NULL` | |
| `notes` | `TEXT NULL` | |
| `created_at`, `updated_at` | | |

Index: `(stage_id, priority DESC, opened_at)` — board ordering.

### 8.2 `app.workflow_transitions` — append-only

One row per stage change. Drives the audit-style timeline in the card sheet.

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `card_id` | `UUID FK` | |
| `from_stage_id` | `UUID FK NULL` | NULL on the first transition |
| `to_stage_id` | `UUID FK` | |
| `transitioned_by_user_id` | `UUID FK` | |
| `signature_id` | `UUID FK NULL` | when a stage requires sign-off |
| `comment` | `TEXT NULL` | |
| `transitioned_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

---

## 9. Forecast & mfg schedule

(Sheets `Component Inventory Tracker` top block + `Mfg. Schedule & Forecast`.)

### 9.1 `app.forecast_periods`

`id`, `code` (`FY24Q2`, `FY24Q3`, …), `period_start`, `period_end`,
`is_active`.

### 9.2 `app.forecast_demand`

`item_id`, `program_id`, `period_id`, `units NUMERIC(14,3)`.
PK `(item_id, program_id, period_id)`.

### 9.3 `app.mfg_schedule`

`id`, `program_id`, `month` (`DATE`, always 1st of month), `units`.
Index `(program_id, month)`.

---

## 10. Logs & audit — the high-volume part

This is the hardest part of the design and the one that **does not work** if
treated naively. Two pieces:

1. **Regulated audit (must keep, must be tamper-evident, queryable):**
   `audit.audit_events`.
2. **System / app diagnostic logs (debug, info, error, telemetry):**
   **NOT in Postgres.** Goes to OpenSearch / Grafana Loki / Datadog. Beyond
   the scope of this DB design.

### 10.1 `audit.audit_events` — schema

```
audit.audit_events (
  id                 UUID         PRIMARY KEY DEFAULT uuid7(),
  occurred_at        TIMESTAMPTZ  NOT NULL,
  actor_user_id      UUID         NULL,           -- NULL = system
  actor_kind         TEXT         NOT NULL CHECK (actor_kind IN ('user','system','integration')),
  event_type         TEXT         NOT NULL,       -- 'inventory.movement.signed', 'user.role.granted', …
  severity           TEXT         NOT NULL CHECK (severity IN ('info','warning','danger')),
  subject_table      TEXT         NOT NULL,
  subject_id         UUID         NULL,
  subject_label      TEXT         NULL,           -- denorm for cheap display (e.g. "NM-0237 · Lot W23490")
  action             TEXT         NOT NULL,       -- 'create','update','delete','sign','view_export','login'
  before_state       JSONB        NULL,           -- only meaningful fields, not whole row
  after_state        JSONB        NULL,
  diff               JSONB        NULL,           -- precomputed key-by-key delta
  context            JSONB        NOT NULL DEFAULT '{}'::jsonb,  -- request_id, ip, user_agent, idempotency_key
  signature_id       UUID         NULL,           -- if this event was signed
  prev_hash          TEXT         NULL,           -- hash chain
  hash               TEXT         NOT NULL,       -- sha256 of (prev_hash, id, occurred_at, event_type, subject_*, after_state)
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
```

Notes:

- `PRIMARY KEY (id, occurred_at)` is required because partitioned tables
  need the partition key in the PK.
- `hash` + `prev_hash` form a **tamper-evident chain** keyed on
  `occurred_at::date` (one chain per UTC day).
  A nightly verifier walks the day's chain and posts an `audit.integrity_ok`
  or `audit.integrity_break` event. This addresses the "trust the log"
  requirement without requiring an external WORM store on day 1.
- `before_state` / `after_state` store only the **business-relevant** fields,
  not the whole row. Otherwise audit grows by 10× the operational data.
- `event_type` uses dotted namespacing (`domain.entity.action[.modifier]`),
  so retention / dashboards can group with `LIKE 'inventory.%'`.

### 10.2 Partitioning

Monthly RANGE partitions on `occurred_at`. Two-step lifecycle:

| Age | Storage | Indexes |
|--|--|--|
| 0–3 months ("hot") | Default tablespace, all indexes live | full query indexes |
| 3–24 months ("warm") | Same DB, secondary indexes dropped except `(occurred_at, event_type)` and `(subject_table, subject_id)` | reduced |
| 24+ months ("cold") | Detached partition; either `pg_dump`ed to S3 as Parquet via `pg_parquet`, or moved to `archive` schema on cheap disk |
| 10y+ | Deleted iff retention policy allows; for GxP, never |

Automation: `pg_partman` or a thin custom function `audit.create_next_month_partition()` run by `pg_cron` on the 25th.

### 10.3 Indexes (per partition)

Hot partitions get:
- `(occurred_at DESC)`
- `(subject_table, subject_id, occurred_at DESC)` — the "show me everything that happened to item X" query
- `(actor_user_id, occurred_at DESC)` — user activity feed
- `(event_type, occurred_at DESC)` — admin dashboards / alert rules
- `GIN (context jsonb_path_ops)` — for ad-hoc support queries on `request_id`, `idempotency_key`, etc.

Warm partitions: keep `(occurred_at)`, `(subject_table, subject_id)` only.
Drop the rest — they're rebuildable if anyone ever needs them.

### 10.4 Permissions on `audit.audit_events`

- App role (`app_rw_role`): `INSERT`, `SELECT`. **No** `UPDATE`/`DELETE`.
- Audit-export role (`audit_export_role`): `SELECT` only.
- Migration role: `ALL`, used only by Alembic.

This is enforced in Postgres, not in the app — defence in depth.

### 10.5 Write path

Naïve: every endpoint inserts into `audit_events` synchronously.
Problem: a chatty endpoint can double its latency and tie up connection-pool
slots on the audit write.

Better: **outbox pattern**.

```
1. Request handler does its operational work + INSERTs into `app.outbox`
   (same transaction).
2. A background worker (FastAPI BackgroundTasks for v1, a real worker
   later — Arq, Celery, or a Postgres LISTEN/NOTIFY consumer) drains
   `app.outbox` and inserts batches into `audit.audit_events`.
3. The worker uses `INSERT … RETURNING id` with idempotency via
   `outbox.idempotency_key`.
```

`app.outbox`:

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `payload` | `JSONB NOT NULL` | |
| `attempts` | `INT NOT NULL DEFAULT 0` | |
| `last_error` | `TEXT NULL` | |
| `processed_at` | `TIMESTAMPTZ NULL` | |

Index `(processed_at, created_at) WHERE processed_at IS NULL`.

Once `processed_at IS NOT NULL` for > 24h, the row is purged. Outbox is not
the audit trail; it's a delivery buffer.

### 10.6 What we **do not** put in the audit table

To keep volume sane:
- **Page views / read-only "viewed item" events** — keep in a separate,
  short-retention table `audit.activity_feed` (30-day retention, dropped on
  partition rotation).
- **HTTP access logs** — go to the reverse proxy / OpenSearch.
- **Periodic health pings** — never written.
- **Debug-level application logs** — never.

### 10.7 `audit.activity_feed` — soft activity (30d)

Smaller schema, same partitioning model but **weekly** partitions with
**4-week retention**. Drives the in-app notification panel.

```
audit.activity_feed (
  id            UUID PRIMARY KEY DEFAULT uuid7(),
  occurred_at   TIMESTAMPTZ NOT NULL,
  user_id       UUID NOT NULL,
  kind          TEXT NOT NULL,     -- 'item.viewed','search.performed','export.previewed'
  subject_id    UUID NULL,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb
) PARTITION BY RANGE (occurred_at);
```

### 10.8 Audit exports

Every export (CSV, PDF) is itself an auditable event written **before** the
file is streamed back. Use `audit.export_jobs`:

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `requested_by_user_id` | `UUID FK` | |
| `requested_at` | `TIMESTAMPTZ NOT NULL` | |
| `filter` | `JSONB NOT NULL` | exact query |
| `format` | `TEXT NOT NULL CHECK (format IN ('csv','pdf','jsonl'))` | |
| `row_count` | `BIGINT NULL` | |
| `bytes` | `BIGINT NULL` | |
| `signature_id` | `UUID FK NULL` | required for full audit exports |
| `completed_at` | `TIMESTAMPTZ NULL` | |
| `file_url` | `TEXT NULL` | object storage, signed URL with TTL |

---

## 11. Notifications

### 11.1 `app.notification_subscriptions`

`user_id`, `kind` (`expiry_warning`, `low_stock`, `signed_movement_for_my_item`),
`channel` (`in_app`, `email`), `is_active`.

### 11.2 `app.notification_deliveries`

`id`, `subscription_id`, `notification_kind`, `subject_id`, `created_at`,
`read_at NULL`, `dismissed_at NULL`, `body JSONB`.

Index `(user_id, read_at NULLS FIRST, created_at DESC)`.

Retention: 90 days (handled in the same partition style as the activity
feed, or via a delete-by-date job — volume is small enough).

---

## 12. Idempotency & request tracing

### 12.1 `app.idempotency_keys`

| col | type | notes |
|--|--|--|
| `key` | `TEXT PK` | client-supplied, scoped per (user, endpoint) |
| `user_id` | `UUID FK` | |
| `endpoint` | `TEXT NOT NULL` | |
| `request_hash` | `TEXT NOT NULL` | guard against same key + different body |
| `response_status` | `INT NULL` | |
| `response_body` | `JSONB NULL` | replayed on duplicate |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `expires_at` | `TIMESTAMPTZ NOT NULL` | |

Index `(expires_at)` for the cleanup job.

Required for `POST /movements`, `POST /signatures`, anything that mutates.

### 12.2 Request IDs

Every request gets a `request_id UUID` from middleware. It's:
- echoed back in the `X-Request-Id` response header,
- stored in `audit_events.context->>request_id`,
- written into structured app logs (which live outside Postgres).

This is how you trace a single user click through the app, the API, the
database write, and the audit chain.

---

## 13. Triggers, constraints, invariants

A short list of invariants we enforce in the DB, not the app:

1. **Ledger immutability** — `REVOKE UPDATE, DELETE … FROM app_rw_role` on
   `ledger_entries`, `electronic_signatures`, `audit.audit_events`,
   `workflow_transitions`.
2. **Item-number prefix is constrained** — `CHECK` constraint on
   `app.items.item_number` enforces `substring(item_number FROM 1 FOR 3)
   IN ('CM-','NM-','CR-','AY-')` (§4.1). No category FK to validate against
   — the prefix *is* the grouping.
3. **Ledger balance integrity** — trigger
   `tg_ledger_update_batch_balance` after each `INSERT` updates
   `item_batches.balance_units` and `item_balances.qty_on_hand`. Within the
   same transaction.
4. **Signature required for sensitive events** — trigger on
   `ledger_entries` rejects `INSERT` where `direction='out'` and
   `signature_id IS NULL` (toggled via `app.settings.require_signature_on_stock_out`).
5. ~~**Package-price invariant**~~ — **REMOVED (v2 §8 · migration
   `b7c8d9e0f1a2`).** No `price_per_package_amount` / `units_per_package`
   columns and no `tg_items_check_pkg_price` trigger remain: the system
   tracks **unit price only** (on lots / order lines), with no
   packaging-configuration price.
6. **Soft-delete sweep** — partial unique indexes everywhere
   (`WHERE deleted_at IS NULL`) so the unique constraint releases the value
   when the row is logically deleted, but the row is preserved.
7. **No future-dated `occurred_on`** — `CHECK (occurred_on <= CURRENT_DATE + INTERVAL '1 day')`.
8. **Hash chain** — trigger
   `tg_audit_events_chain` computes `prev_hash` from the most recent
   committed row for `occurred_at::date` (UTC day) and seals `hash` before
   write.

---

## 14. Migration & seeding

### 14.1 Alembic

- One migration per logical change. No squashes that lose history.
- `alembic_version` lives in `public`; the app's own tables in their
  dedicated schemas (`app`, `audit`, `meta`, `archive`).
- Reversible (`downgrade`) for all migrations until they are explicitly
  marked **irreversible** (e.g. dropping a partition). Mark with a comment.
- Migrations never touch user data except through INSERT/UPDATE of
  *reference* tables. Operational backfills go in a separate
  `scripts/backfill_*.py` so they can be rerun and reviewed.

### 14.2 Seeder

A single command, e.g. `python -m app.seed --source xlsx --file "Demo Inventory Control.xlsx"`. Steps:

1. Upsert reference rows: `meta.inventory_statuses` (3 rows),
   `meta.units_of_measure`, baseline `meta.workflow_stages`,
   `meta.locations`, and `meta.programs` (one row per program header on
   the master sheet). No `meta.categories` — prefix is constrained on the
   item row itself (§4.1).
2. Upsert `meta.suppliers` (74 rows; skip blank suppliers, do not create a
   `''` supplier — this also fixes the empty-string `Select.Item` issue in
   the current frontend).
3. Upsert `app.items` (≈300 rows). Map columns by the §6.1 table; reject
   rows whose `item_number` doesn't match the prefix CHECK rather than
   silently inventing a category.
4. For each per-item Excel sheet (`CM-0001`, `NM-0003`, …):
   1. Upsert `app.lots` for each distinct lot.
   2. Upsert `app.item_batches` for each `(item, lot, location)` triple.
   3. Insert `app.ledger_entries` for each populated row (no reason
      column — see §6.6). Idempotency via
      `(item_id, occurred_on, qty_in, qty_out, lot_id, location_id, initials, source='import')`.
   4. Insert an `app.electronic_signatures` row per ledger entry **only if**
      the import is configured to back-fill signatures; by default historical
      imports are unsigned and flagged `source='import'`.
5. Recompute `app.item_balances` from the ledger.
6. Write one `audit.audit_events` row per import
   (`event_type='inventory.import.completed'`).

Idempotent: re-running the seeder with the same xlsx is a no-op.

Library choice: don't pull in a heavy seeder framework. A 200-line
`app/seed.py` using SQLAlchemy ORM `INSERT ... ON CONFLICT DO UPDATE` plus
the existing `scripts/sync-from-xlsx.py` extractor is plenty. If we later
want generated demo data (e.g. for staging that's bigger than prod),
add `factory-boy` then.

---

## 15. Volume estimates & sizing

Working numbers, used to validate partitioning thresholds:

| Source | Rows / year (estimate) |
|--|--|
| `ledger_entries` (300 items, ~30 entries/item/year) | ~9k |
| `electronic_signatures` (per signed ledger entry + approvals) | ~12k |
| `workflow_cards` + `workflow_transitions` | ~10k |
| `audit.audit_events` (10× the operational rate) | ~250k |
| `audit.activity_feed` | ~2M (high, but 30-day retention → ~170k at any moment) |
| `notification_deliveries` | ~50k |

At 10× scale (multi-facility, multi-program), `audit_events` reaches ~3M /
year. With monthly partitioning + warm-index pruning, that's roughly
**400 MB / year** of audit data — fine in-place for 10y, trivial to ship
to S3 Parquet for archival.

### Concrete recommendations
- Postgres 16+. Use `pg_partman` for monthly audit partitions.
- Enable `pg_stat_statements`, `pg_trgm`, `ltree`, `citext`,
  `pg_uuidv7` (or accept app-generated UUIDv7).
- `shared_buffers` = 25 % of RAM, `work_mem` = 16 MB to start. The audit
  ingestion path is sequential inserts and doesn't need much tuning.
- Backup: nightly logical (`pg_dump --schema=app,meta`) + continuous WAL.
  Audit partitions get a separate retention policy in your backup tool.
- Read replica: enable once the dashboard starts hitting the audit schema.

---

## 16. Sample hot-path queries

**Inventory list (paginated, filtered, sorted):**

```sql
SELECT i.id,
       i.item_number,
       substring(i.item_number FROM 1 FOR 2) AS prefix,  -- CM/NM/CR/AY
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
       b.last_movement_at
FROM   app.items        i
LEFT   JOIN meta.suppliers v ON v.id = i.supplier_id
LEFT   JOIN app.item_balances b ON b.item_id = i.id
WHERE  i.deleted_at IS NULL
  AND  ($1::text IS NULL OR b.status_code = $1)
  AND  ($2::text IS NULL OR i.item_number LIKE $2 || '-%')  -- prefix filter
  AND  ($3::text IS NULL OR i.description ILIKE '%' || $3 || '%')
ORDER  BY i.item_number
LIMIT  $4 OFFSET $5;
```

**Item detail ledger (newest first) — reason comes from the linked
signature, not the ledger row:**

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

**Audit history for an item (last 24 months, joins across partitions):**

```sql
SELECT a.occurred_at, a.event_type, a.severity,
       a.actor_user_id, u.full_name AS actor_name,
       a.action, a.subject_label, a.diff, a.signature_id
FROM   audit.audit_events a
LEFT   JOIN app.users u ON u.id = a.actor_user_id
WHERE  a.subject_table = 'items'
  AND  a.subject_id    = $1
  AND  a.occurred_at  >= now() - interval '24 months'
ORDER  BY a.occurred_at DESC
LIMIT  200;
```

Postgres will prune partitions automatically given the
`occurred_at >= now() - interval '24 months'` predicate.

---

## 17. Open questions / decisions still owed

These are the spots where you should weigh in before I generate models.

1. **Item-prefix list location.** Hardcoded `CHECK` constraint on
   `app.items.item_number` (current proposal, §4.1) or a tiny
   `meta.item_prefixes(code, sort_order, is_active)` table that lets a
   super-admin add a 5th prefix without a migration? The Excel only uses
   the four prefixes today; the CHECK constraint is simpler and matches
   "no invented concepts". Default: CHECK constraint.
2. **Quarantine workflow.** The Excel has no `quarantine` signal at the
   item level. We treat it as a **lot-level** status (`lots.status =
   'quarantine'`) plus a workflow card; placing a lot under quarantine is
   a signed action that writes an `audit_events` row and updates the lot.
   Confirm this scope (vs. a separate `quarantines` table).
3. **Lot vs. material vs. SKU.** Right now `items` is the SKU. Are there
   cases where two `item_numbers` share a single physical lot? (Catalogue
   updates, repackaging?) If yes, a `materials` table sits between `items`
   and `lots`. The Excel suggests no — skip it for v1.
4. ~~**`price_per_package_amount` storage.**~~ **Superseded 2026-06-11
   (v2 §8):** no package-configuration price. The package/UOM columns were
   dropped (migration `b7c8d9e0f1a2`) and pricing consolidated onto the lot
   — **track unit price only**, since variable package sizes make
   package-level pricing impractical.
5. **Hash chain scope.** Per-UTC-day is my default. The alternative is one
   global chain, which makes any out-of-order insert a problem. Day scoping
   is operationally friendlier; please confirm.
6. **Outbox processor.** Background tasks via `asyncio` inside the FastAPI
   process are fine for v1 but will starve the request loop under load.
   Recommend `arq` (Redis-backed) when daily audit volume > ~10k.
7. **Signature image storage.** S3-style object store (recommended) or
   `BYTEA` in `electronic_signatures`? S3 keeps the DB small; you'll need a
   signed-URL service. I'd start with S3.
8. **Retention of `activity_feed` / soft logs.** 30 days is my default.
   Confirm or relax. This is the only knob that materially affects DB size.
9. **Kanban stage list.** The spec doc calls the stages "configurable" but
   doesn't enumerate them. Current proposal seeds six stages
   (`low_stock → review → pending → ordered → received → closed`) into
   `meta.workflow_stages`. Confirm wording before migration; renames are
   free pre-launch, painful after.

---

## 18. What we keep out of v1

Listing explicitly so they're not surprises later.

- Full event sourcing on items (kept the `item_balances` denorm; we can
  recompute but we are not streaming events into a separate store).
- A separate read model / CQRS database.
- Time-series TSDB for sensor data (LN2 tank temperature feeds).
- Webhook deliveries to external systems.

All of these slot in cleanly without schema changes when needed.

---

*End of document.* Once you've reviewed and we agree on the open questions
in §17, I'll generate the Alembic migration + SQLAlchemy models in a single
PR.
