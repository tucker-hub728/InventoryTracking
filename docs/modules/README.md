# CellReady IMS — Backend Modules

Per-module backend data-structure docs. Each file is a contract: once
approved, Alembic migrations and SQLAlchemy models are derived from it 1:1.

The shared design principles, naming conventions, infra patterns
(idempotency, outbox, request tracing, hash chain, partitioning) live in
[../backend-data-structure.md](../backend-data-structure.md) — module
files reference those rather than re-stating them.

## Modules

| File | Scope | Status |
|--|--|--|
| [inventory.md](./inventory.md) | **Full Inventory Module** — items, lots, batches, balances, ledger, vendors, UOM, locations tree, **LN2 mapping** (tanks/racks/positions/state), **Kanban workflow** (stages, cards, transitions), **reorder + expiration notifications**, **21 CFR Part 11 electronic sign-off** | **finalised 2026-05-26** — questions 1–5 resolved, 6–10 still open |
| identity-access.md | Users, roles, permissions, role/user assignments, sessions, app settings, super-admin bootstrap | not yet split |
| purchase-orders.md | `purchase_orders`, `po_lines`, PO approval signatures | not yet split |
| forecast.md | `forecast_periods`, `forecast_demand`, `mfg_schedule`, allocations linking lots to manufacturing runs (powers `lots.status='reserved'`) | not yet split |
| audit-logs.md | `audit.audit_events` partitioning + hash chain, `audit.activity_feed`, `audit.export_jobs`, outbox | not yet split |

## What changed in this revision

The Inventory Module file now covers **everything** the
*Technical Software Specification* lists under inventory:

- ✅ Week 1 — item-level ledger and transaction management (§4)
- ✅ LN2 Mapping — cryogenic tank/rack/position assignment + status tracking (§5)
- ✅ Kanban — configurable lifecycle stages + drag/click transitions (§6)
- ✅ Inventory item reorder thresholds and notifications (§7)
- ✅ Inventory expiration thresholds and notifications (§7)
- ✅ 21 CFR Part 11 compliant electronic sign-off for status changes (§8)
- ✅ Data migration from `Demo Inventory Control.xlsx` (§11 seeder)

Previously these were sketched in separate files (`storage-ln2.md`,
`workflow-kanban.md`, `notifications.md`, `electronic-signatures.md`).
They are now consolidated into `inventory.md` as one contract, because
the spec doc scopes them all under the Inventory Module deliverable. The
`electronic_signatures` table is shared with non-inventory modules
(RBAC, PO approvals) — those modules will reference §8 of `inventory.md`
rather than re-defining the table.

## Conventions

- Each module file follows the same section structure:
  1. **Scope** — what it owns + what it deliberately doesn't
  2. **Excel / spec-doc mapping** — where each field comes from
  3. **Reference tables** (`meta` schema)
  4. **Core tables** with column-by-column Excel/spec mapping
  5. **Fields explicitly NOT stored** — prevents invented fields creeping back in
  6. **Triggers, constraints, invariants**
  7. **Sample queries** for the hot paths
  8. **Seeder**
  9. **Cross-module references**
  10. **§99 Open questions** — gated decisions before code

- The legacy [../backend-data-structure.md](../backend-data-structure.md)
  is the source of truth until each section is migrated into its module
  file. Module files take precedence on any disagreement.
