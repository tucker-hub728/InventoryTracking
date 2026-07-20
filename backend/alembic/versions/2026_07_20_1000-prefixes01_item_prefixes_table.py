"""Split the item prefix out of item_tiers into app.item_prefixes.

Until now a tier owned a single ``prefix`` column (one type code per tier). The
requirements settled on many prefixes per tier (REQ-2026-07-15-ITM-002 — the
finished-good tier may carry a distinct prefix for drug finished goods vs. other
build aids, added through the admin prefix list) while keeping exactly three
fixed tiers (REQ-2026-07-15-ITM-001). A prefix now lives *inside* a tier and
never constitutes a fourth tier.

This migration:

  1. creates ``app.item_prefixes`` (many per tier, admin-managed);
  2. seeds one prefix per live tier from that tier's current ``prefix`` (marked
     ``is_default`` + carrying the tier's ``is_seeded`` protection);
  3. adds ``app.items.prefix_id`` and back-fills it from each item's tier's seed
     prefix (every existing item's tier has exactly one prefix, so the mapping
     is unambiguous), then makes it NOT NULL;
  4. ties ``items(prefix_id, tier_id)`` to ``item_prefixes(id, tier_id)`` with a
     composite FK, so "the item's prefix belongs to the item's tier" is a DB
     invariant, not just a route check;
  5. drops ``app.item_tiers.prefix`` (and its unique index / not-blank CHECK).

Constraint / index names are spelled out literally to match this project's
naming convention (``ck_%(table_name)s_%(constraint_name)s`` double-prefixes the
model's already-``ck_``-prefixed names), keeping the migration honest about the
real DB names — same approach as ``tierrename01``.

Revision ID: prefixes01
Revises: bomqty01
"""

from __future__ import annotations

from alembic import op

revision: str = "prefixes01"
down_revision: str | None = "bomqty01"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    # ── 1. app.item_prefixes ───────────────────────────────────────────
    op.execute(
        """
        CREATE TABLE app.item_prefixes (
            id uuid NOT NULL DEFAULT gen_random_uuid(),
            tier_id uuid NOT NULL,
            code text NOT NULL,
            label text,
            is_default boolean NOT NULL DEFAULT FALSE,
            is_seeded boolean NOT NULL DEFAULT FALSE,
            tone text NOT NULL DEFAULT 'neutral',
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            deleted_at timestamptz,
            created_by_user_id uuid,
            updated_by_user_id uuid,
            CONSTRAINT pk_item_prefixes PRIMARY KEY (id),
            CONSTRAINT uq_item_prefixes_id_tier UNIQUE (id, tier_id),
            CONSTRAINT ck_item_prefixes_ck_item_prefixes_code_not_blank
                CHECK (char_length(trim(code)) > 0),
            CONSTRAINT fk_item_prefixes_tier_id_item_tiers
                FOREIGN KEY (tier_id) REFERENCES app.item_tiers (id)
                ON DELETE RESTRICT,
            CONSTRAINT fk_item_prefixes_created_by_user_id_users
                FOREIGN KEY (created_by_user_id) REFERENCES app.users (id)
                ON DELETE RESTRICT,
            CONSTRAINT fk_item_prefixes_updated_by_user_id_users
                FOREIGN KEY (updated_by_user_id) REFERENCES app.users (id)
                ON DELETE RESTRICT
        )
        """
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_item_prefixes_code "
        "ON app.item_prefixes (lower(code)) WHERE deleted_at IS NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_item_prefixes_default_per_tier "
        "ON app.item_prefixes (tier_id) WHERE is_default AND deleted_at IS NULL"
    )
    op.execute(
        "CREATE INDEX ix_item_prefixes_tier_id ON app.item_prefixes (tier_id)"
    )

    # ── 2. Seed one prefix per live tier from its current prefix ────────
    # The tier's prefixes are unique among live rows (uq_item_tiers_prefix), so
    # lower(code) is unique too. The seed prefix inherits the tier's is_seeded
    # protection and becomes that tier's default.
    op.execute(
        """
        INSERT INTO app.item_prefixes (tier_id, code, is_default, is_seeded, tone)
        SELECT id, upper(prefix), TRUE, is_seeded, tone
          FROM app.item_tiers
         WHERE deleted_at IS NULL
        """
    )

    # ── 3. items.prefix_id (nullable → back-fill → NOT NULL) ────────────
    op.execute("ALTER TABLE app.items ADD COLUMN prefix_id uuid")
    op.execute(
        """
        UPDATE app.items i
           SET prefix_id = p.id
          FROM app.item_prefixes p
         WHERE p.tier_id = i.tier_id
        """
    )
    # Orphan safety net: a soft-deleted tier referenced only by soft-deleted
    # items got no prefix in step 2 (only live tiers were seeded), which would
    # leave those rows NULL and break the NOT NULL below. Seed a SOFT-DELETED
    # prefix from the tier's own code for any such tier — the unique index on
    # ``code`` ignores deleted rows, so it can't collide with a live prefix, and
    # the composite FK doesn't care about ``deleted_at``.
    op.execute(
        """
        INSERT INTO app.item_prefixes
              (tier_id, code, is_default, is_seeded, tone, deleted_at)
        SELECT DISTINCT t.id, upper(t.prefix), FALSE, t.is_seeded, t.tone, now()
          FROM app.item_tiers t
          JOIN app.items i ON i.tier_id = t.id
         WHERE i.prefix_id IS NULL
           AND NOT EXISTS (
                 SELECT 1 FROM app.item_prefixes p WHERE p.tier_id = t.id
               )
        """
    )
    op.execute(
        """
        UPDATE app.items i
           SET prefix_id = p.id
          FROM app.item_prefixes p
         WHERE p.tier_id = i.tier_id AND i.prefix_id IS NULL
        """
    )
    op.execute("ALTER TABLE app.items ALTER COLUMN prefix_id SET NOT NULL")

    # ── 4. Composite FK: prefix must belong to the item's tier ──────────
    op.execute(
        """
        ALTER TABLE app.items
          ADD CONSTRAINT fk_items_prefix_item_prefixes
          FOREIGN KEY (prefix_id, tier_id)
          REFERENCES app.item_prefixes (id, tier_id) ON DELETE RESTRICT
        """
    )
    op.execute("CREATE INDEX ix_items_prefix_id ON app.items (prefix_id)")

    # ── 5. Drop the old single prefix off the tier ─────────────────────
    op.execute("DROP INDEX app.uq_item_tiers_prefix")
    op.execute(
        "ALTER TABLE app.item_tiers "
        "DROP CONSTRAINT ck_item_tiers_ck_item_tiers_prefix_not_blank"
    )
    op.execute("ALTER TABLE app.item_tiers DROP COLUMN prefix")


def downgrade() -> None:
    # ── Restore the single prefix column on the tier ───────────────────
    op.execute("ALTER TABLE app.item_tiers ADD COLUMN prefix text")
    op.execute(
        """
        UPDATE app.item_tiers t
           SET prefix = p.code
          FROM app.item_prefixes p
         WHERE p.tier_id = t.id AND p.is_default AND p.deleted_at IS NULL
        """
    )
    # Any tier that somehow has no default prefix gets a placeholder so the
    # NOT NULL + not-blank CHECK below still hold.
    op.execute(
        "UPDATE app.item_tiers SET prefix = 'XX' "
        "WHERE prefix IS NULL OR char_length(trim(prefix)) = 0"
    )
    op.execute("ALTER TABLE app.item_tiers ALTER COLUMN prefix SET NOT NULL")
    op.execute(
        "ALTER TABLE app.item_tiers "
        "ADD CONSTRAINT ck_item_tiers_ck_item_tiers_prefix_not_blank "
        "CHECK (char_length(trim(prefix)) > 0)"
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_item_tiers_prefix "
        "ON app.item_tiers (lower(prefix)) WHERE deleted_at IS NULL"
    )

    # ── Drop items.prefix_id + the item_prefixes table ─────────────────
    op.execute(
        "ALTER TABLE app.items DROP CONSTRAINT fk_items_prefix_item_prefixes"
    )
    op.execute("DROP INDEX app.ix_items_prefix_id")
    op.execute("ALTER TABLE app.items DROP COLUMN prefix_id")
    op.execute("DROP TABLE app.item_prefixes")
