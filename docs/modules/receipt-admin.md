# Receipt Admin / Orders Module — Backend Contract (v3)

> **Source of truth**
> - `temp/CellReady_Inventory_System_Technical_Requirements_v2.pdf` (original
>   Item / Supplier / Lot / Receipt model).
> - Client requirement updates 2026-06-29: rename "receipt" → **"Order"**;
>   **multiple items per Order**; lot details captured **at receive, not
>   intake**; **partial receipts**; **blanket Orders** with **multiple dated
>   receipts**; delete an Order; drop e-sign on editing an un-received Order.
>
> Builds on [inventory.md](./inventory.md) — items, lots, the append-only ledger
> (`app.stock_movements`), assigned suppliers (`meta.item_suppliers`), e-signatures
> (`audit.reauth_events`) and the audit trail (`audit.audit_events`). This file
> describes only the **Order** (Receipt Admin) additions; everything it doesn't
> mention is unchanged.

---

> **This module is now the single Order system.** The earlier standalone
> Purchase Orders design (`docs/modules/purchase-orders.md`) is folded in here —
> blanket/partial/multi-receipt are part of Receipt Admin, not a separate
> module. "Order" is a UI-only rename; backend routes/tables keep the
> `receipt_*` names.

---

## 0. v3 decisions (2026-06-29)

| Topic | Decision |
|--|--|
| Terminology | "receipt" → **"Order"** in the **UI only**. Routes (`/v1/receiving`), tables (`app.receipt_transactions`), and API fields keep their names. |
| Multiple items per Order | **Yes.** A new `app.receipt_transaction_lines` table — one row per item. The header no longer carries `item_id`. |
| Lot details at intake | **Removed.** Intake captures no `lot_number`, `manufacture_date`, or `expiration_date`. Those are entered **at receive**. |
| Lot creation | Lots are created **only at a receive event** (one lot per `line × event`), never at intake. |
| Partial receipts | Tracked **per line**: `outstanding = ordered_qty − Σ received`. Received is **ledger/row-derived** (summed from `receipt_event_lines`), never stored. |
| Blanket Orders | Header `is_blanket` + `valid_from`/`valid_to`. Drawn down by **many dated receive events** until every line is fully received. |
| Supplier | **Per line** (`receipt_transaction_lines.supplier_id`), restricted to the item's `meta.item_suppliers`. Header has no supplier → an Order may span suppliers. |
| Over-receipt | **Allowed, no reason required** — a draw may exceed the line's outstanding quantity. (The `over_receipt_reason` column is retained but no longer collected.) |
| E-signature | **Receiving only** (reauth + mandatory comment). Creating/**editing an un-received Order** is plain `inventory:create` — no reauth. |
| Order number | User-entered `po_reference`; **unique** across non-deleted Orders. |
| Delete | **Soft-delete** (`deleted_at`), allowed **only while the Order is not yet received** (no ledger/stock impact). |
| Status | Derived: `open → partially_received → received`, or `cancelled`. **No `closed`/early-close state** (cancel covers abandonment). |

---

## 1. Domain entities (v3)

### 1.1 `app.receipt_transactions` — Order header

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `po_reference` | `TEXT NOT NULL` | user-entered Order #. **Unique** (partial-unique index where `deleted_at IS NULL`). (Was nullable in v2; the UI already required it.) |
| `is_blanket` | `BOOLEAN NOT NULL DEFAULT false` | **NEW.** Blanket vs. standard — informational; the receive loop is identical. |
| `status` | `TEXT NOT NULL DEFAULT 'open'` | **Widened CHECK:** `('open','partially_received','received','cancelled')`. Derived on every receive/cancel — never hand-set. |
| `valid_from` | `DATE NULL` | **NEW.** Blanket window start. |
| `valid_to` | `DATE NULL` | **NEW.** Blanket window end. `CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)`. |
| `notes` | `TEXT NULL` | |
| `created_by_user_id` | `UUID FK → app.users` | |
| `received_by_user_id`, `received_at` | (existing) | stamped on the **final** receive that completes the Order. |
| `deleted_at` | `TIMESTAMPTZ NULL` | **NEW.** Soft delete. |
| `created_at`, `updated_at` | `TIMESTAMPTZ NOT NULL` | |

- **REMOVED:** `item_id` (moves to lines, §1.2).
- Indexes: `(status)`, `(created_at DESC)`, partial-unique on `po_reference`
  where `deleted_at IS NULL`.

### 1.2 `app.receipt_transaction_lines` — one item on the Order (NEW)

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `receipt_transaction_id` | `UUID FK → app.receipt_transactions(id) ON DELETE CASCADE` | |
| `line_no` | `INTEGER NOT NULL` | 1-based display order. |
| `item_id` | `UUID FK → app.items(id) ON DELETE RESTRICT` | |
| `supplier_id` | `UUID FK → meta.suppliers(id) ON DELETE RESTRICT` | **must be in the item's `meta.item_suppliers`** (service-validated, like today). |
| `ordered_qty` | `INTEGER NOT NULL` | `CHECK (ordered_qty > 0)`. Whole units. |
| `unit_price_amount` | `NUMERIC(14,2) NULL` | agreed price; copied onto the lot at receive. |
| `created_at`, `updated_at` | `TIMESTAMPTZ NOT NULL` | |

**No `UNIQUE (receipt_transaction_id, item_id)`** — the *same* item may appear
on several lines of one Order, each with its **own supplier / price** (split
sourcing; e.g. legacy Order `PO-B-001` ordered `TEST-001` from both Acme and
Wilson Wolf). Supplier is per line, so item-per-Order is intentionally **not**
unique. Indexes: `(receipt_transaction_id)`, `(item_id)`.
**`ordered_qty` is locked once any receive line references the line** (409;
service-enforced).

### 1.3 `app.receipt_events` — one dated receive event (NEW)

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `receipt_transaction_id` | `UUID FK → app.receipt_transactions(id) ON DELETE RESTRICT` | |
| `received_at` | `DATE NOT NULL` | the delivery date (blanket "multiple dates"). |
| `received_by_user_id` | `UUID FK → app.users` | |
| `reauth_event_id` | `UUID FK → audit.reauth_events(id) ON DELETE RESTRICT` | the e-signature authorising this receive (one ticket per event). |
| `notes` | `TEXT NULL` | |
| `created_at` | `TIMESTAMPTZ NOT NULL` | |

Indexes: `(receipt_transaction_id)`, `(received_at DESC)`.

### 1.4 `app.receipt_event_lines` — qty received this delivery, per Order line (NEW)

| col | type | notes |
|--|--|--|
| `id` | `UUID PK` | |
| `receipt_event_id` | `UUID FK → app.receipt_events(id) ON DELETE CASCADE` | |
| `receipt_transaction_line_id` | `UUID FK → app.receipt_transaction_lines(id) ON DELETE RESTRICT` | |
| `qty_received` | `INTEGER NOT NULL` | `CHECK (qty_received > 0)`. |
| `over_receipt_reason` | `TEXT NULL` | required (service-enforced) only when this draw pushes the line past `ordered_qty`. |
| `lot_id` | `UUID FK → app.lots(id) ON DELETE RESTRICT` | the lot this draw created (§3). |

`UNIQUE (receipt_event_id, receipt_transaction_line_id)`.
Indexes: `(receipt_event_id)`, `(receipt_transaction_line_id)`, `(lot_id)`.

### 1.5 `app.lots` (changes)

- **NEW** `receipt_transaction_line_id UUID NULL FK → receipt_transaction_lines`
  — the Order line a lot was received against (replaces the conceptual link the
  old `receipt_transaction_id` gave). `receipt_transaction_id` is retained for
  back-compat / direct reads.
- `lot_number`, `manufacture_date`, `expiration_date` are now populated **at
  receive**, not intake.
- `supplier_id`, `unit_price_amount`, `ordered_qty` still live on the lot (set at
  receive from the line, with optional per-split override).

---

## 2. Derived quantities & status (never stored)

```
received(line)     = Σ receipt_event_lines.qty_received WHERE line = line.id
outstanding(line)  = max(0, line.ordered_qty − received(line))

Order.status (recomputed on every receive / cancel):
   no receive events on any line                  → 'open'
   some received, ≥1 line still outstanding > 0    → 'partially_received'
   every line outstanding = 0                      → 'received'   (auto; stamps received_at/by)
   cancelled / soft-deleted before any receive     → 'cancelled'
```

On-hand per item stays ledger-derived via `app.v_item_stock` (unchanged) — a
different total from Order "received" (order fulfilment vs. physical stock).

---

## 3. Flow

### 3.1 Intake — create an Order (`POST /v1/receiving/transactions`, NOT e-signed)
1. Header: `po_reference`, optional `is_blanket` + `valid_from`/`valid_to`, notes.
2. One or more **item lines**: `item_id`, `supplier_id` (∈ item_suppliers),
   `ordered_qty`, optional `unit_price`.
3. **No lots created**, no stock moves. Status `open`.

### 3.2 Edit Order (`PATCH …/transactions/{id}`, NOT e-signed, un-received only)
Edit header + lines (add/remove items, change supplier/qty/price). `ordered_qty`
locked on a line once it has any received qty. UI title: **"Edit Order"**.

### 3.3 Receive — a dated receive event (`POST …/transactions/{id}/receive`, **e-signed**)
One reauth ticket (`action='receipt.confirm'`, consumed once) covers the whole
event. Body = `received_at` + per-line draws. For each submitted line:
1. resolve the Order line; compute `outstanding`; if `qty_received >
   outstanding` require `over_receipt_reason` (else 409);
2. create one `app.lots` row (`status='available'`, `item_id`, `supplier_id` and
   `unit_price_amount` from the line unless overridden, `ordered_qty` from the
   line, `po_reference` from the header, **`lot_number` + `manufacture_date` +
   `expiration_date` entered now**, `receipt_transaction_line_id` = the line);
3. insert the `receipt_event_lines` row (`lot_id`).

A line omitted from the event simply isn't drawn this delivery. All lots for one
event commit atomically under the single e-signature. Recompute Order status
(§2). Quantity/placement still flow through the Location System `place` step —
receive records the lot, not its physical location (unchanged from v2).

> Lines may be received across **many** events on **many** dates (blanket /
> partial). The Order stays `partially_received` until every line's outstanding
> hits 0, then auto-flips to `received`.

### 3.4 Delete Order (`DELETE …/transactions/{id}`, NOT e-signed)
Soft-delete (`deleted_at`), **allowed only when no receive event exists** (still
`open`). Cascades a soft state to its lines. Received Orders cannot be deleted
(preserves the ledger). The existing `cancel` action remains for marking an
un-received Order abandoned without deleting it.

---

## 4. One lot per (line × event)

Each receive draw mints a **new** `app.lots` row — every dated delivery is a
distinct physical batch (own lot number, expiry, manufacture date, price). Lots
are never merged across events. Example — a blanket Order, 3 items, 3 deliveries:

```
                 EVENT R1 (Feb 10)  EVENT R2 (May 5)  EVENT R3 (Sep 20)
line vials 1000  +300 VIAL-A        +400 VIAL-B       +300 VIAL-C   → 1000/1000 ✓
line canes  200    —                +120 CANE-A       + 80 CANE-B   →  200/200  ✓
line gloves  50  + 50 GLOVE-A         —    (done)        —          →   50/50   ✓
Order status:    partially_received  partially_received  received
```

Reading a row = that item's partial-receipt history; reading a column = one
dated `receipt_event` and the lots it created.

---

## 5. Endpoints

| Method | Path | Auth | Purpose |
|--|--|--|--|
| `POST` | `/v1/receiving/transactions` | `inventory:create` | Create Order header + item lines (multi-item) |
| `GET` | `/v1/receiving/transactions` | `inventory:view` | List Orders (derived status + % received) |
| `GET` | `/v1/receiving/transactions/{id}` | `inventory:view` | One Order: lines (with outstanding) + receive history |
| `PATCH` | `/v1/receiving/transactions/{id}` | `inventory:create` | Edit un-received Order (header + lines) |
| `POST` | `/v1/receiving/transactions/{id}/receive` | `inventory:sign` | Record one dated receive event (partial, multi-line) — e-signed |
| `POST` | `/v1/receiving/transactions/{id}/cancel` | `inventory:create` | Cancel an un-received Order (keeps the record) |
| `DELETE` | `/v1/receiving/transactions/{id}` | `inventory:create` | Soft-delete an un-received Order |

Receive body:

```jsonc
// POST /v1/receiving/transactions/{id}/receive
{
  "received_at": "2026-05-05",
  "evidence_id": "…",              // reauth ticket, action='receipt.confirm', consumed once
  "lines": [
    { "line_id": "…", "qty_received": 400, "lot_number": "VIAL-B",
      "manufacture_date": "2026-04-01", "expiration_date": "2027-04-01",
      "unit_price_amount": null },
    { "line_id": "…", "qty_received": 210, "lot_number": "CANE-B",
      "over_receipt_reason": "Supplier shipped full pallet" }   // exceeds outstanding
  ]
}
```

---

## 6. Item → Supplier resolution (unchanged)

Supplier on a line is **mandatory** and must be one of the item's `meta.item_suppliers`.
No on-the-fly supplier creation. (The v2 unverified/not-previously-associated
flags were already dropped, migration `b0c1d2e3f4a5`.)

---

## 7. Audit (`audit.audit_events` via `record_entity_change`)

Written for: Order create/edit, line add/remove, each receive event (the
`receipt_events` row + the lots/movements it created, split detail in
`context`), cancel, and delete. Receive events additionally carry the
reauth evidence id, consistent with existing receive auditing.

---

## 8. Migration

New revision `orders_multi_item_v3` (down_revision `c8d9e0f1a2b3`). Adds
`receipt_transaction_lines`, `receipt_events`, `receipt_event_lines`;
`lots.receipt_transaction_line_id`; `receipt_transactions.is_blanket /
valid_from / valid_to / deleted_at`; widens the status CHECK; drops the header
`item_id` (after backfill). **Backfill (per 2026-06-29 decision "convert to one
line each, keep lot"):** for each existing `receipt_transaction`, create one
`receipt_transaction_line` **per existing lot** (carrying that lot's
`item`/`supplier`/`ordered_qty`/`unit_price`) and set the lot's
`receipt_transaction_line_id`. Already-`received` transactions keep their lots
linked to lines (no synthetic event). Reversible. **Not auto-applied** — exact
backfill SQL is reviewed and run manually against the target DB.

---

## 9. Resolved decisions (2026-06-29)

1. **Order # (`po_reference`) is unique** across non-deleted Orders
   (partial-unique index where `deleted_at IS NULL`). Existing dev rows are
   checked for duplicates before the constraint is added.
2. **End-states = `cancelled` + soft-delete only.** No `closed`/early-close
   state — `cancel` covers abandoning an un-received Order while keeping the
   record; `delete` soft-removes an un-received Order entirely.
3. **Backfill = one line per existing lot** (lossless — preserves per-lot
   supplier/qty/price on multi-lot intakes); the lot is relinked via
   `receipt_transaction_line_id`.

---

*End of Receipt Admin / Orders v3 contract.*
