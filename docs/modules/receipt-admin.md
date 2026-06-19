# Receipt Admin Module — Backend Contract (v2)

> **Source of truth**
> - `temp/CellReady_Inventory_System_Technical_Requirements_v2.pdf`
>   (*Item / Vendor / Lot / Receipt Transaction model*, *Lot status rules*,
>   *Item→Vendor relation rules*, *Receipt Admin flow*, *Physical receipt
>   process*, *Edge case rules*, *Data consistency rules*, *Business
>   constraints*).
>
> Builds on the inventory contract in [inventory.md](./inventory.md) — items,
> lots, vendors, the append-only ledger (`app.stock_movements`), e-signatures
> (`audit.reauth_events`) and the audit trail (`audit.audit_events`). This file
> only describes the **Receipt Admin** additions; everything it doesn't mention
> is unchanged.

---

## 0. How v2 maps onto the existing flow

The v2 requirements describe a vendor-aware, two-step inbound process. Most of
the primitives already exist; v2 adds an **approved-vendor mapping**, a
**receipt-transaction header**, and **per-lot pricing / PO reference**. The
decisions taken (see commit / PR description) were:

| v2 requirement | Decision |
|--|--|
| Lot is source of truth for vendor / unit price / qty received | **Unit price + PO ref live on the lot**; **quantity stays ledger-derived** (the receipt movement *is* the quantity). No duplicated `received_qty` column — the GxP ledger remains the single balance authority. |
| Item has zero-or-more approved vendors | New join table `meta.item_approved_vendors`. `app.items.vendor_id` is **retained** as the optional *primary/default* vendor. |
| Unverified / not-previously-associated flags | Stored in a new `app.lots.metadata_` JSONB (`unverified_vendor_for_item`, `vendor_not_previously_associated_with_item`). Not status values (§ Lot status rules). |
| ON_ORDER → AVAILABLE intake with splitting | New **Receipt Admin** intake flow (`receipt_transactions` header + `/receiving` endpoints). The existing `POST /v1/movements/receipt` (goods-in-hand, single lot) is left untouched. |
| Category (optional) on Item | New nullable free-text `app.items.category` (no lookup table, no CHECK). Reverses the earlier "no category" decision ([inventory.md §99 Q1](./inventory.md)) specifically for v2. |

---

## 1. Domain entities (v2)

### 1.1 Item (additions)
- `category TEXT NULL` — free-form, optional. No lookup table, no CHECK.
- Approved vendors: zero-or-more, via `meta.item_approved_vendors`.
- `vendor_id` (existing) stays as the optional default vendor — it is **not**
  the source of truth for what a lot was sourced from (the lot is, §5).

### 1.2 Vendor
Unchanged shape (`meta.vendors`). A vendor can supply many items; price is
**never** stored globally per item — it is captured per lot at receipt (§5).

### 1.3 `meta.item_approved_vendors` — approved-vendor mapping

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `item_id` | `UUID FK → app.items(id) ON DELETE CASCADE` | |
| `vendor_id` | `UUID FK → meta.vendors(id) ON DELETE RESTRICT` | |
| `approval_status` | `TEXT NOT NULL` | `CHECK IN ('approved','pending')`. `pending` = added dynamically during a receipt (§ edge case 2). |
| `created_by_user_id` | `UUID FK → app.users(id)` | |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

`UNIQUE (item_id, vendor_id)`. Indexes: `(item_id)`, `(vendor_id)`.

**Rules**
- An item with one or more `approved` rows → only those vendors are
  *suggested* in the receipt UI.
- Receipt is **never blocked** by the approved list — any active vendor can be
  selected; if it isn't approved the lot is flagged `unverified_vendor_for_item`.
- A vendor created/added during receipt is inserted with
  `approval_status='pending'` only when the operator opts in.

### 1.4 `app.lots` (additions)

| col | type | notes |
|--|--|--|
| `unit_price_amount` | `NUMERIC(14,2) NULL` | price paid for this lot, captured at receipt (§ data consistency). |
| `po_reference` | `TEXT NULL` | manual PO text (§ business constraints). No PO system. |
| `metadata_` | `JSONB NOT NULL DEFAULT '{}'` | carries `unverified_vendor_for_item`, `vendor_not_previously_associated_with_item`, plus future QC/Hold/Rejected flags (§ lot status rules — **never** new statuses). |
| `receipt_transaction_id` | `UUID NULL FK → app.receipt_transactions(id)` | the intake that created this lot. |
| `parent_lot_id` | `UUID NULL FK → app.lots(id)` | split lineage — set on child lots produced when a receipt is split (§6). |

`vendor_id` stays **nullable at the column level** (historical / seeded lots
predate the mandatory-vendor rule), but the Receipt Admin intake path
**requires** a resolved vendor on every lot it creates.

### 1.5 `app.receipt_transactions` — inbound event header

Represents one "Receipt Transaction": an inbound processing event that creates
or updates lots and can split them.

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `status` | `TEXT NOT NULL DEFAULT 'open'` | `CHECK IN ('open','received','cancelled')`. `open` = lots created ON_ORDER; `received` = physical receipt confirmed; `cancelled` = abandoned before receipt. |
| `item_id` | `UUID FK → app.items(id)` | the item being received (one item per transaction; multiple vendors/lots allowed within it, § edge case 3). |
| `po_reference` | `TEXT NULL` | manual PO text, copied onto created lots unless overridden. |
| `notes` | `TEXT NULL` | |
| `created_by_user_id` | `UUID FK → app.users(id)` | |
| `received_by_user_id` | `UUID NULL FK → app.users(id)` | who confirmed the physical receipt. |
| `received_at` | `TIMESTAMPTZ NULL` | |
| `created_at`, `updated_at` | `TIMESTAMPTZ NOT NULL` | |

Indexes: `(item_id)`, `(status)`, `(created_at DESC)`.

---

## 2. Lot status rules (unchanged, restated for v2)

System statuses are **only** `ON_ORDER` and `AVAILABLE`
([inventory.py `LOT_STATUSES`](../../backend/app/models/inventory.py)). No
`quarantine`. QC / Hold / Rejected are represented as `metadata_` flags, never
as status values.

---

## 3. Item → Vendor resolution rules

At receipt time vendor selection is **mandatory**. Given the chosen vendor and
the item:

| Condition | Effect on the created lot's `metadata_` |
|--|--|
| Item has approved vendors, chosen vendor **is** approved | no flags |
| Item has approved vendors, chosen vendor is **not** approved | `unverified_vendor_for_item = true` |
| Vendor has **never** appeared on a prior lot for this item *and* isn't in the approved list | `vendor_not_previously_associated_with_item = true` |
| Item has **no** approved vendors at all | receipt still allowed; flags computed as above (typically `vendor_not_previously_associated_with_item = true` on first-ever sourcing) |

The two flags are independent and may both be set.

---

## 4. Receipt Admin flow (intake → ON_ORDER lots)

`POST /v1/receiving/transactions` — **not** e-signed (no stock moves yet; this
is a planning/order-intake step, gated on `inventory:create`).

**Steps (from v2 §4):**
1. **Select item** — `item_id`. 404 if unknown.
2. **Vendor resolution** — each lot line resolves a vendor:
   - `vendor_id` (existing vendor), **or**
   - `vendor_name` (free input). If no active vendor matches case-insensitively,
     a vendor is **created dynamically** (§ edge case 2). With
     `add_to_item_vendors=true`, an `item_approved_vendors` row is inserted with
     `approval_status='pending'`.
3. **Receipt entry** — per lot line: `lot_number`, `quantity` (ordered),
   `unit_price` (optional), `po_reference` (optional, falls back to the header),
   expiry / manufacture dates (optional).
4. **Lot creation** — one `app.lots` row per line:
   - `status='on_order'`, linked item + resolved vendor,
   - `unit_price_amount`, `po_reference`, computed `metadata_` flags (§3),
   - `receipt_transaction_id` = the new header.
   - **No ledger movement is posted** — the goods aren't physically in yet.

A single transaction may create multiple lots, each with exactly one vendor
(§ edge case 3). The header `status` starts `open`.

---

## 5. Physical receipt process (ON_ORDER → AVAILABLE, with split)

`POST /v1/receiving/transactions/{id}/receive` — **e-signed**
(`inventory:sign` + a fresh reauth ticket for `action='receipt.confirm'`,
consumed once, target = the transaction).

For each ON_ORDER lot in the transaction the operator submits one or more
**receive lines**. Per the v2 split rule, when received qty ≠ ordered qty the
line may split into multiple lots under the same item, **same or different
vendors**:

- `splits[0]` (no `lot_number` override) → received **into the original lot**:
  flip `on_order → available`, post a `+received_qty` `receipt` movement (to the
  destination location if one is given), set `unit_price`/`po_reference` if
  supplied.
- `splits[1..]` → **child lots**: a new `app.lots` row per split
  (`parent_lot_id` = original, own vendor / unit price / lot number,
  `status='available'`), each with its own `+received_qty` receipt movement.

All movements ride **one** e-signature (consumed against the transaction id) and
commit atomically — a failure rolls back the entire receipt. Destination is
**optional**: receiving records the quantity and flips the lot to `available`,
but no longer pins it to a physical location. Omit `location_id` (and any
per-split `location_id`) to receive without placing — the `receipt` movement is
posted with no `to_location_id` and the lot stays *unplaced* until it is mapped
to a node via the Location System (`/v1/locations/allocations/place`). On-hand
stays ledger-derived (`v_item_stock` sums per item, ignoring location), so an
unplaced receipt still counts as available stock. If a `location_id` *is*
supplied (per-split override allowed) and that location has racks, vials fill
positions exactly like
[`POST /v1/movements/receipt`](../../backend/app/inventory/routes.py) (one unit
= one vial = one position; capacity-checked).

On success the header flips to `received` (`received_at`, `received_by_user_id`
stamped).

---

## 6. Edge cases (v2 §6) — handling

| Case | Handling |
|--|--|
| **1. Vendor not in item mapping** | Receipt allowed; lot flagged `vendor_not_previously_associated_with_item=true` (and `unverified_vendor_for_item=true` if the item *has* an approved list). |
| **2. Unknown vendor added during receipt** | Vendor created dynamically from `vendor_name`; optionally added to the item's vendor list as `approval_status='pending'`. |
| **3. Multiple vendors in same receipt** | One transaction → multiple lots; each lot has exactly one vendor (enforced: each lot line resolves a single vendor). |
| **4. Price variance per vendor** | `unit_price_amount` captured **per lot** at receipt. No global item pricing is read or written by this flow. |
| **5. Item with no vendors defined** | Receipt allowed; vendor still mandatory per line. |

---

## 7. Data consistency & audit (v2 §7–§8)

- **Lot is the source of truth** for vendor used, unit price, and (via its
  receipt movements) quantity received. The item never stores transactional
  vendor pricing.
- **Vendor performance** is derived from lot history (`app.lots` joined to
  `app.stock_movements`), never cached on the item.
- **Audit trail** (`audit.audit_events` via `record_entity_change`) is written
  for:
  - vendor assignment / dynamic vendor creation / approved-vendor mapping
    changes,
  - receipt transaction creation and confirmation (`receipt adjustments`),
  - lot splitting (child-lot creation records `parent_lot_id` + the split in
    `context`).
- PO traceability is via the manual `po_reference` text only — no PO system
  integration (§ business constraints).

---

## 8. Endpoints summary

| Method | Path | Auth | Purpose |
|--|--|--|--|
| `GET` | `/v1/items/{item_id}/approved-vendors` | `inventory:view` | List approved/pending vendors for an item |
| `POST` | `/v1/items/{item_id}/approved-vendors` | `inventory:create` | Add a vendor mapping (approved/pending) |
| `DELETE` | `/v1/items/{item_id}/approved-vendors/{vendor_id}` | `inventory:create` | Remove a mapping |
| `POST` | `/v1/receiving/transactions` | `inventory:create` | Create intake → ON_ORDER lots |
| `GET` | `/v1/receiving/transactions` | `inventory:view` | List receipt transactions |
| `GET` | `/v1/receiving/transactions/{id}` | `inventory:view` | One transaction + its lots |
| `POST` | `/v1/receiving/transactions/{id}/receive` | `inventory:sign` | Physical receipt → AVAILABLE (+split), e-signed |
| `POST` | `/v1/receiving/transactions/{id}/cancel` | `inventory:create` | Cancel an `open` transaction |

---

## 9. Migration

`2026_06_18_1200-..._receipt_admin_v2` (down_revision `f4a5b6c7d8e9`). Adds:
`items.category`; `lots.unit_price_amount` / `po_reference` / `metadata_` /
`receipt_transaction_id` / `parent_lot_id`; `meta.item_approved_vendors`;
`app.receipt_transactions`. Reversible. **Not auto-applied** — run
`alembic upgrade head` against the target DB after review.

---

*End of Receipt Admin v2 contract.*
