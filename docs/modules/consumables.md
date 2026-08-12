# Consumables, Kanban & Expiration

Requirements: `REQ-2026-07-01-TRX-003`, `LOC-006`, `LOC-007`, `LOC-008`;
Transaction Spec 2026-07-01 §4; `REQ-2026-07-09-TRX-001/004/006`, `PRC-003`;
`REQ-2026-07-08-INV-004` as amended 2026-07-09.

Migration: `consum01`. Backend: `app/consumables/`. Smoke:
`backend/tests/smoke_consumables.py`.

## 1. The model in one paragraph

A consumable is an ordinary CR item with `items.is_consumable = true` — **not** a
fourth item category (`REQ-2026-07-15-ITM-001` allows exactly three). It is
received to a shelf like anything else. A separate transaction issues a quantity
of it to a **Kanban**: a named location inside a production area. At issue the
units leave inventory permanently, and an `app.consumable_issues` row starts
tracking their expiration wherever they now sit.

```
CR item (is_consumable)
  → receive to a shelf            (existing receiving flow, expiration OPTIONAL)
  → POST /v1/consumables/issue    (e-signed, terminal, multi-lot)
      · stock_movements: consumable_issue   shelf → Kanban, qty_delta < 0
      · consumable_issues: one row PER SOURCE LOT, carrying its expiration
  → the register flags it as the date approaches / passes
  → POST /v1/consumables/{id}/acknowledge  after the physical check (e-signed)
```

## 2. Kanban is a node, not a flag or a tab

`LOC-006` says a Kanban is "representable as a **named location**". Client
decision 2026-08-10: it is a **child of a production area**, so Clean Room Five
can hold "Kanban 1" and "Kanban 2" as separate, separately-countable places.

```
Production
  └── Clean Room Five        flat, flat_category='production'
        ├── Kanban 1         kanban          ← consumables land here
        └── Kanban 2         kanban
```

* `PARENT_OF['kanban'] = ('flat',)`; the route additionally requires the parent
  be `flat_category='production'`, since `flat` also matches legacy Lab/QC nodes.
* **Not** in `ROOT_NODE_TYPES` → the existing root-parentage CHECK forces every
  Kanban to have a parent. Nothing new was needed to enforce that.
* **Not** in `STORAGE_NODE_TYPES` → a Kanban holds no lot allocations. It is an
  *address*, not a balance. This is the whole of the Option A/B switch (§5).
* Created by **Super Admin only**, `POST /v1/location-nodes/{id}/kanbans`, free
  text name, `KAN-<slug>` code. Same rationale as `LOC-003`'s shelf
  restriction: "Kanban1" beside "Kanban 1" silently splits one bin's register.
* `consum01` seeds one "Kanban 1" per existing production area, so an upgraded
  environment can issue immediately.

> ⚠️ `flat_category = 'kanban'` already exists in the enum from the original
> July-1 reading of LOC-006. It is **dead and must stay dead** — a `flat` node is
> forced to be a root, so a flat/kanban node could never hang inside a room.

## 3. Why `app.consumable_issues` exists — and why it is only six columns

**The issue itself does not need this table.** `stock_movements` already records
item, lot, qty, from-shelf, to-Kanban, who and when, and the expiry is reachable
through `movement.lot_id → lots.expiration_date`.

What the ledger cannot hold is the **flag state** — cleared / by whom / with
what disposition — which `LOC-008` and `TRX-006` require and which changes after
the fact. Three ways to avoid the table, and why each fails:

| Idea | Problem |
|---|---|
| Update the movement when the flag clears | The ledger is append-only |
| Post a second "cleared" movement | Not a stock change; a zero-qty row breaks the sign CHECK, and every read would pair rows to recover state |
| Put the flag on the lot | Wrong grain — one lot issued to three Kanbans needs three independent checks |

So the table holds the flag and nothing else:

```
id · movement_id (UNIQUE) · cleared_at · cleared_by_user_id · disposition · clear_note
```

Everything factual is read through `movement_id`. Nothing is copied, so nothing
can drift — the movement is append-only, so a copy could never legitimately
differ from it anyway. The expiry in particular is read live, so correcting a
lot's date immediately corrects the Kanban's alert instead of leaving the room
flagged against a date nobody believes.

`movement_id` is **UNIQUE**: one flag per movement. A multi-lot issue posts one
movement per source lot, so it gets one flag per lot — which is what lets two
lots with different expiries be checked and cleared independently (`TRX-003`
drops per-lot traceability, but §4.2 still tracks the expiry of a *specific
issued quantity*).

## 4. Expiration

No sweep, no scheduler — a flag is a pure function of the lot's expiry, today,
and the configured lead time, so storing it would only create a second thing
that can be wrong. `flag_for()` computes it on read; the register query joins
`app.lots` for the date, with a partial index (`cleared_at IS NULL`) narrowing
to rows still awaiting a check.

| State | Condition |
|---|---|
| *(none)* | no date, or more than `warn_days` out |
| `warn` | within `warn_days` of the date (TX Spec §4.2, "approaching") |
| `expired` | on or past the date (`LOC-008`) |

**A NULL date never flags.** `REQ-2026-07-08-INV-004` as amended on 07-09 makes
expiration optional at receiving and states "expiration flags apply only where a
date exists". Enforced in SQL, not in a UI branch, so `PRC-003`'s N/A path holds
across every flow.

`warn_days` is a setting (`app.app_settings`, default 30), because the documents
genuinely conflict — `LOC-008` alerts only once past the date, §4.2 wants a
warning as it approaches, and 07-09 gives no number. **Open question for the
client.** Deliberately *not* shared with Planning's "expiring within a year"
horizon (`PLN-003`): different screen, different question.

Clearing captures §4.2's outcomes — `consumed | reworked | retested |
discarded` — plus who and when. The flag clears; the record does not, so the
register keeps answering *where and when* the material was issued, which is what
TRX-006 requires the acknowledgment to show.

**E-signed** (client 2026-08-12), action `consumable.expiry_check`. It was built
unsigned on the reading that 07-09 `TRX-006` asks for "a simple acknowledgment"
and no quantity moves. The disposition is what overturned that: "discarded" /
"consumed before its date" is an attributable statement about what became of
material, and it is the **only** record of that outcome anywhere — the ledger
stopped at the issue, and nothing else ever writes it. Part 11 §11.200 wants the
person behind such a statement re-identified as they make it. "Simple" is
honoured as *one step, no quantities to reconcile*, which the dialog still is:
pick the outcome, sign, done.

Two properties worth keeping when this code is touched:

* the verb is **not** the issue verb. A ticket minted to move stock into a
  Kanban must not be spendable on the claim that the same stock was later
  discarded;
* the signature is bound to the **register row** (`app.consumable_issues`,
  VR-006) — with several flagged rows open at once, an unbound ticket would
  close out whichever one the next request named.

The signature's optional comment IS `clear_note`, the same trade the issue
dialog makes — one place to explain yourself, not two free-text boxes back to
back. Evidence is consumed last, so a replay rolls the clearing back with it.

## 5. Open requirement conflict — read before changing behaviour

`REQ-2026-07-01-LOC-006` says Kanban stock "shall remain visible in inventory
(not immediately consumed)" and be "written off only when a restock card is
returned". `REQ-2026-07-09-TRX-001/004` say issue is terminal and consumables
are never quantity-adjusted afterwards. **These contradict each other**, and
LOC-006 was never listed in any amendment's §2 modification table, so by the
documents' own change-control rule (`PRC-001`) it is still a live Must.

The client chose the July 9 behaviour on 2026-08-10 (**Option A**). This belongs
on the beta cover page as a deviation, not buried here.

**Option B**, if the client later wants live Kanban on-hand, is a contained
change and the code is shaped for it:

1. add `kanban` to `STORAGE_NODE_TYPES`;
2. write a unit-IN allocation at the Kanban alongside the existing movement;
3. wire a count → variance → adjustment path.

The issue transaction, the register and the expiration engine are unchanged
either way. That is why Kanbans are real nodes rather than a UI grouping.

## 6. What is deliberately absent

* **No de-issue / back-flush for consumables** (`TRX-004`). The smoke asserts no
  such endpoint exists.
* **No consumable on a kit BOM** (§4.3 — "consumables are not tracked directly
  against an FG or AY BOM"). A non-consumable bound for production is a kit
  issue; the issue endpoint rejects a non-consumable item explicitly.
* **No Kanban→Kanban transfer.** Undefined in the requirements; not built.
* **No live Kanban balance** — see §5.

## 7. Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/consumables/sources/{item_id}` | `inventory:view` | Issuable lot × location |
| GET | `/v1/consumables/issued` | `inventory:view` | The register; filters by Kanban / item |
| GET | `/v1/consumables/expiring` | `inventory:view` | Cross-Kanban alert feed |
| GET/PUT | `/v1/consumables/expiry-policy` | `view` / `edit` | `warn_days` |
| POST | `/v1/consumables/issue` | `inventory:sign` | **E-signed** `movement.consumable_issue` |
| POST | `/v1/consumables/{id}/acknowledge` | `inventory:sign` | **E-signed** `consumable.expiry_check`, bound to the register row |
| POST | `/v1/location-nodes/{id}/kanbans` | `inventory:create` + **super admin** | Add a Kanban |

Route order matters: every literal path is declared before `/{issue_id}/…`, or
FastAPI shadows it and 422s on "expiring" not being a UUID.

`GET /v1/location-nodes/{id}/kanbans` (view) lists an area's stations — it feeds
both the issue dialog's destination picker and the floor's Kanban tab.

## 8. Where it lives in the UI

| Surface | File | Notes |
|---|---|---|
| Issue to Kanban | `components/inventory/issue-to-kanban-dialog.tsx` | On the CR drill-down, next to Transfer. Only for `is_consumable`; reuses `LotSourcePicker` for multi-lot |
| Kanban tab | `components/production/kanban-panel.tsx` | Fourth tab on a production floor, grouped apart from the three kit-state tabs |
| Add kanban | same file | Super-admin only, mirrors the "Add area" button |
| Acknowledge | `components/consumables/acknowledge-dialog.tsx`, used by both | Restates where/when issued (TRX-006), then `PasswordReauthDialog` |
| Expiring feed | `app/(app)/consumables/page.tsx` | Cross-area alert list + the warning-period setting |

Two UI notes worth keeping:

* the Kanban tab is **not** a fourth kit state, so `floor-tabs.ts` carries a
  `kind` discriminator and the tab strip draws a rule before it;
* the tab shows issued records and their expiry, **not** an on-hand balance —
  under Option A there is no balance to show (§5). That is where an Option B
  quantity column would slot in.

Adding a movement type means touching **four** lists, not one: `MOVEMENT_TYPES`
(model), the `MovementType` literal in `app/inventory/schemas.py`, and the
frontend union in `lib/api/movements.ts` plus every `Record<MovementType, …>`
that keys off it. `app/locations/schemas.py` now re-exports the canonical
literal rather than keeping a third hand-maintained copy — it used to list only
six types, which already broke node history for production floors.
