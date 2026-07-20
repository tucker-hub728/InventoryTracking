# Item Prefixes — Data Structure Spec

Status: **implemented** on branch `feature/inventory-requirements-v3` (migration
`prefixes01`, not yet applied to any DB — run + verify locally). Backend + frontend
land together; typecheck / ruff / next-lint all clean.

Requirements: REQ-2026-07-09-ITM-001..004, REQ-2026-07-15-ITM-001..003.

## Model in one line

Three **fixed tiers** (raw material / sub-assembly / finished good). Each tier
owns **many admin-managed prefixes**. Every item is assigned **exactly one
prefix**, and that prefix always lives inside the item's tier. A prefix never
creates a fourth tier — so kitting, debiting and planning always know how to
treat an item.

```
item_tiers (3, fixed)
   └── item_prefixes (many per tier, admin-managed)     ← NEW table
          └── items (one prefix per item)               ← items.prefix_id NEW
```

## Decisions locked (2026-07-20)

1. **Item→tier link:** item stores BOTH `prefix_id` and `tier_id`; a composite
   FK guarantees the prefix belongs to that tier. (Minimal refactor; existing
   tier joins/reads keep working.)
2. **item_number:** `prefix_id` is a separate, mandatory, structured column
   (the filtering criterion). `item_number` stays **free-form text** — no
   physical prefix-string enforcement.
3. **Admin UI:** prefixes are managed **nested inside the existing Tier admin**
   (each tier row expands to its prefix list), not a separate screen.

## Changes vs. today

- **`app.item_tiers`** — DROP the single `prefix` column (moves to the new
  table). Everything else unchanged; still exactly 3 rows, `type` immutable.
- **`app.item_prefixes`** — NEW table (below).
- **`app.items`** — ADD `prefix_id NOT NULL`; keep `tier_id`; add composite FK.

## New table: `app.item_prefixes`

| column | type | notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `tier_id` | uuid FK → `app.item_tiers(id)` ON DELETE RESTRICT | which of the 3 tiers |
| `code` | text NOT NULL | e.g. `CR`, `AY`, `FG`, `DR`, `4`. Trimmed + upper-cased, non-blank, max 8 |
| `label` | text NULL | optional human name, e.g. "Drug Finished Good" |
| `is_default` | bool NOT NULL default FALSE | the prefix pre-filled when this tier is chosen on the item-create form (ITM-002) |
| `is_seeded` | bool NOT NULL default FALSE | seeded CR/AY/FG — rename/recolour allowed, delete blocked |
| `tone` | text NOT NULL default `'neutral'` | cosmetic; may inherit tier tone in UI |
| `created_at` / `updated_at` | timestamptz | `now()`, `onupdate=now()` |
| `deleted_at` | timestamptz NULL | soft-delete |
| `created_by_user_id` / `updated_by_user_id` | uuid FK → `app.users(id)` RESTRICT | nullable for the system seed, set by app writes |

Constraints / indexes:

- `CHECK (char_length(trim(code)) > 0)` — `ck_item_prefixes_code_not_blank`
- Partial-unique `LOWER(code)` WHERE `deleted_at IS NULL` — code globally unique
  among live rows (`uq_item_prefixes_code`).
- Partial-unique `(tier_id)` WHERE `is_default AND deleted_at IS NULL` —
  **exactly one default prefix per tier** (`uq_item_prefixes_default_per_tier`).
- Composite key `UNIQUE (id, tier_id)` (`uq_item_prefixes_id_tier`) — the target
  of the items composite FK below.
- `ix_item_prefixes_tier_id`.

## `app.items` changes

```sql
ALTER TABLE app.items ADD COLUMN prefix_id uuid;                 -- backfilled, then NOT NULL
ALTER TABLE app.items
  ADD CONSTRAINT fk_items_prefix
  FOREIGN KEY (prefix_id, tier_id)
  REFERENCES app.item_prefixes (id, tier_id) ON DELETE RESTRICT; -- prefix ∈ item's tier, guaranteed
```

- `prefix_id` NOT NULL after backfill.
- `item_number` unchanged (free-form, uniqueness index only).
- Add `ix_items_prefix_id`.
- Read model exposes `prefix_code` / `prefix_label` alongside the existing
  `tier_type` for tab filtering.

## Migration `prefixes01` (forward-additive)

1. Create `app.item_prefixes`.
2. Seed one prefix per tier from each tier's current `item_tiers.prefix`
   (`is_seeded = TRUE`, `is_default = TRUE`, same tone; `*_by_user_id` NULL).
3. `UPDATE app.items SET prefix_id = <that tier's seed prefix>` (every existing
   item's tier has exactly one prefix today, so the mapping is unambiguous).
4. `ALTER COLUMN prefix_id SET NOT NULL`; add composite FK + `ix_items_prefix_id`.
5. Drop `app.item_tiers.prefix` (and its unique index / not-blank CHECK).

Reversible: down-migration re-adds `item_tiers.prefix` from each tier's default
prefix, drops `items.prefix_id`, drops `item_prefixes`.

## API surface

- **Prefix CRUD** nested under the tier routes (e-signed, mirroring tier
  create/update/delete): `GET/POST /v1/item-tiers/{tier_id}/prefixes` and
  `PATCH/DELETE /v1/item-tiers/{tier_id}/prefixes/{prefix_id}`. Reauth actions
  `prefix.create` / `prefix.update` / `prefix.delete`. Delete blocked when
  `is_seeded`, in use, or it's the tier's default. Setting a new default clears
  the previous default in the same tier; un-defaulting the only default is
  rejected (the create form always needs a pre-fill).
- **`TierRead`** — drop `prefix`; add `prefixes: [{id, code, label, is_default,
  is_seeded, tone}]` (the tier's live prefixes).
- **`ItemCreate` / `ItemUpdate`** — add required `prefix_id`. `tier_id` is derived
  from the chosen prefix server-side (composite FK still validates consistency).
- **`ItemRead`** — add `prefix_id`, `prefix_code`, `prefix_label`.

## Create-item flow (UI)

select tier → prefix dropdown scoped to that tier, pre-selecting the tier's
`is_default` prefix → user may override to any other prefix **in that tier** →
`prefix_id` saved. A value is always required (ITM-002).

## Deliberately out of scope for this change

- No auto-generation / format enforcement of the `item_number` string.
- No new tiers ever (the 3 are fixed; enforced by `item_tiers.type` CHECK).
- QP-02 (client part-numbering doc) supplies the *initial* real prefix set;
  seeding beyond CR/AY/FG is a data task, not a schema change.
