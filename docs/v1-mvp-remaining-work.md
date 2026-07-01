# CellReady IMS — v1 MVP Remaining Work

> Status snapshot as of **2026-05-29**.
> Companion to [`backend-data-structure-v1-mvp.md`](./backend-data-structure-v1-mvp.md)
> (the spec) — this doc tracks the **delta between spec and shipped code**.

---

## Legend

- ✅ **Shipped** — in `main` and exercised by smoke tests.
- 🟡 **Partial** — backend or frontend half is there; the other side or
  the polish layer is missing.
- ⛔ **Not started** — listed in spec, no code yet.
- 🔵 **v2 (deferred)** — explicitly out of v1 per the MVP doc; mentioned
  here only so the gap doesn't get re-asked.

---

## 1. Spec-required, still outstanding

These items appear in [`backend-data-structure-v1-mvp.md`](./backend-data-structure-v1-mvp.md)
and gate "v1 spec-complete" status.

### 1.1 ⛔ `app.settings` table (single-row global config)

**Spec ref:** §5.1.
**Why it matters:** Gates the `require_signature_on_stock_out` flag and
holds `org_name` for header / PDF branding. Without it, the
"require signature on stock-out" rule is hard-coded.

**Scope:**
- Alembic migration: `app.settings (id BOOL PK CHECK (id), org_name TEXT, require_signature_on_stock_out BOOL, …)`.
- Seed one row at migration time.
- `GET /v1/settings` + `PATCH /v1/settings` (admin only, audit-recorded).
- Read once at app startup; cache in-process; invalidate on PATCH.
- Frontend: simple "Org settings" admin page (label + toggle).

**Effort:** ~30 min.

---

### 1.2 ⛔ Audit hash chain (per-UTC-day tamper evidence)

**Spec ref:** §4 ERD (`audit_events.hash`).
**Why it matters:** Today the `audit.audit_events` table is append-only by
trigger but each row is independent — a privileged actor with DB access
could still drop a row and rewrite history. A per-day hash chain makes
silent deletion detectable.

**Scope:**
- Add `audit_events.hash TEXT NOT NULL` + `audit_events.prev_hash TEXT NULL`.
- On INSERT, compute `hash = sha256(prev_hash || canonical_row_json)`.
  `prev_hash` is the most recent hash for the same UTC day, or `NULL` for
  the first row of the day.
- A BEFORE INSERT trigger (DB-side) so the recorder can't accidentally
  skip it. Pure-Postgres `digest()` from `pgcrypto` (already enabled).
- Daily verification: `GET /v1/audit/verify?date=YYYY-MM-DD` walks the
  day's rows in order, recomputes the chain, and returns
  `{ verified: true, rows: N }` or the first row whose hash doesn't
  match.

**Effort:** 1–2 h.

---

### 1.3 🟡 Bootstrap super-admin enforcement

**Spec ref:** §5.3 ("Refuse to start if it doesn't exist").
**Status:** Lazy provisioning works (first `/auth/me` mirrors the Cognito
super-admin into `app.users`). But the app **does not fail-fast at
startup** when `SUPERADMIN_EMAIL` resolves to nothing — meaning a
mis-configured prod could come up with no admin and nobody would notice
until they tried to log in.

**Scope:**
- In `app/core/lifespan.py` startup hook: if `SUPERADMIN_EMAIL` is set,
  query Cognito user-pool for the user; refuse to start (exit non-zero)
  if not found.
- If unset, log a startup warning but proceed (dev convenience).

**Effort:** ~20 min.

---

## 2. Polish / demo-readiness gaps

Not in the v1 spec, but commonly expected from a regulated inventory app
before a customer demo.

### 2.1 🟡 Lot edit dialog (frontend)

**Status:** Backend PATCH/DELETE shipped with Chunk A (audit-recorded).
Suppliers / locations / items each got their edit dialog. Lots did not —
the lots table only supports create.

**Scope:** Mirror `item-edit-dialog.tsx` for lots (lot_number is
immutable; expiration_date / supplier_id / coa_url / notes are editable;
soft-delete refuses if `lot_has_movements`).

**Effort:** ~30 min.

---

### 2.2 ⛔ Audit log CSV export

**Why:** 21 CFR Part 11 inspections routinely ask for the audit log as a
file. Today it's only browsable in the UI.

**Scope:**
- `GET /v1/audit/events.csv?<same-filters>` streams rows as CSV (header:
  `occurred_at, actor_email, event_type, severity, subject_table,
  subject_label, action, signed`).
- Frontend: "Export CSV" button on the audit page that links to the URL
  with the current filter state.

**Effort:** ~45 min.

---

### 2.3 ⛔ Bulk Excel import for items

**Why:** Seed script (`scripts/sync-from-xlsx.py`) only regenerates the
SEED. A customer adding 200 new items shouldn't have to type them all.

**Scope:**
- `POST /v1/items/import` accepts `.xlsx`; parses with the same logic as
  the seed script; returns a row-by-row result summary.
- Frontend: drag-drop zone on the inventory page with a downloadable
  template + a dry-run preview.

**Effort:** 2 h. Could defer to v1.1.

---

### 2.4 ⛔ Pytest suite (backend)

**Status:** `backend/tests/smoke_*.py` files exist as one-shot scripts
(run manually). No `pytest.ini`, no fixtures, no CI gate.

**Scope:**
- Add `pytest.ini` + `conftest.py` with an async DB fixture.
- Migrate the smoke probes into proper pytest functions.
- GitHub Actions job that runs them on every PR.

**Effort:** 2–3 h. Pure investment — no user-visible change.

---

## 3. Already gated to v2 (no action needed in v1)

Per the MVP doc §2, these are **purely additive** in v2 and do not block
v1 release. All are disabled in the sidebar with a "WIP" pill + tooltip
so the customer doesn't trip into a half-built screen.

- 🔵 **LN2 Tanks** — UI scaffolding exists; backend has no
  `ln2_position_state` table yet. Disabled in nav.
- 🔵 **Kanban** — UI scaffolding exists; backend has no `workflow_*`
  tables yet. Disabled in nav.
- 🔵 **Users & Roles** — UI scaffolding exists; user/role CRUD endpoints
  return data but invitation flow + role grants are not wired. Disabled
  in nav.
- 🔵 **Granular RBAC** (`permissions`, `role_permissions`,
  `user_role_assignments`) — v1 uses `users.role` denorm. v2 adds the
  three tables additively.
- 🔵 **Purchase orders** (`purchase_orders`, `po_lines`).
- 🔵 **Forecast module** (`programs`, `item_program_demand`,
  `forecast_periods`, `forecast_demand`, `mfg_schedule`).
- 🔵 **Notifications** (`notification_subscriptions`,
  `notification_deliveries`).
- 🔵 **Idempotency keys** (`app.idempotency_keys`).
- 🔵 **Audit outbox + partitioning** (`app.outbox`,
  `audit_events_yYYYYmMM`).
- 🔵 **Activity feed / export jobs** (`audit.activity_feed`,
  `audit.export_jobs`).

---

## 4. What's done (for reference)

So when someone asks "what's already in":

### Backend (12 migrations on top of the boilerplate)
- ✅ Identity (roles + users + Cognito mirror)
- ✅ Inventory schema (items, suppliers)
- ✅ Suppliers seeded from workbook (72 rows)
- ✅ Locations + lots
- ✅ Stock movements + ledger view
- ✅ Append-only triggers (no `UPDATE` / `DELETE` / `TRUNCATE` on
  ledger or audit)
- ✅ Reauth events + signature S3 key
- ✅ Transfer paired-movement linkage
- ✅ Audit events table + recorder

### Frontend
- ✅ Auth (Cognito + session cookies)
- ✅ Inventory list / detail / edit
- ✅ Suppliers / UOMs / Locations admin pages (full CRUD with audit)
- ✅ Lots admin page (create + view; **edit dialog missing** — see §2.1)
- ✅ Movement wizard (receipt / dispense / discard / adjustment /
  transfer / reverse) with canvas e-signature
- ✅ Unified audit timeline on item detail (movements + edits with
  per-event icons + signature thumbnails)
- ✅ Audit log page with filters (search, subject, action, severity,
  date range) and side-drawer detail
- ✅ Movement detail side-drawer with full-size signature image
- ✅ Sidebar with disabled-module tooltips
- ✅ Light + dark theme with native date-picker icon visible in both

---

## 5. Suggested order of attack

If you want a strict "v1 spec-complete" milestone:

1. §1.3 bootstrap enforcement (20 min) — derisk prod.
2. §1.1 settings (30 min) — unlocks the signature-on-stock-out toggle.
3. §1.2 audit hash chain (1–2 h) — the only meaningful spec gap.
4. §2.1 lot edit dialog (30 min) — visible UX inconsistency.
5. §2.2 audit CSV export (45 min) — high-leverage for inspections.

Items §2.3 (bulk import) and §2.4 (pytest suite) are **investments**, not
blockers — defer to a v1.1 polish pass unless there's an inbound demo
where they matter.
