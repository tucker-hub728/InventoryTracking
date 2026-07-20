"""Derive the SKU from prefix+suffix; drop items.tier_id and item_prefixes.tone.

Follow-up to ``prefixes01`` with three client-requested changes (2026-07-20):

  1. **Derived SKU.** The item no longer stores a full ``item_number``. It stores
     only ``sku_suffix`` (the tail, e.g. ``001``); the displayed number is
     computed as ``<prefix code>-<suffix>``. Renaming a prefix (``PR`` → ``PRR``)
     therefore re-labels every item under it (``PR-0091`` → ``PRR-0091``) with no
     data change. Uniqueness moves to ``(prefix_id, sku_suffix)`` — prefix codes
     are globally unique, so the derived number stays unique.
  2. **No items.tier_id.** The tier is derived through the prefix
     (``item → prefix → tier``), so the redundant column and its composite FK go.
  3. **No item_prefixes.tone.** A prefix inherits its tier's colour.

Backfill splits each legacy ``item_number`` at its first ``-`` into the discarded
old prefix + the suffix (``AY-001`` → ``001``, ``PR-0091`` → ``0091``), keeping the
whole string when there's no ``-``. Collisions within a prefix (two legacy numbers
that reduce to the same tail) get a ``-2``/``-3`` disambiguator so the new unique
index holds.

Revision ID: prefixes02
Revises: prefixes01
"""

from __future__ import annotations

from alembic import op

revision: str = "prefixes02"
down_revision: str | None = "prefixes01"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    # ── 1. items.sku_suffix (add → back-fill → constrain) ────────────────
    op.execute("ALTER TABLE app.items ADD COLUMN sku_suffix text")
    # Strip the leading "<seg>-" (the old baked-in prefix), keep the whole string
    # when there's no dash, and disambiguate any within-prefix collisions.
    op.execute(
        """
        WITH resolved AS (
            SELECT i.id,
                   i.prefix_id,
                   CASE
                     WHEN char_length(trim(regexp_replace(i.item_number, '^[^-]+-', ''))) > 0
                       THEN regexp_replace(i.item_number, '^[^-]+-', '')
                     ELSE i.item_number
                   END AS s1
              FROM app.items i
        ),
        numbered AS (
            SELECT id, s1,
                   row_number() OVER (PARTITION BY prefix_id, s1 ORDER BY id) AS rn
              FROM resolved
        )
        UPDATE app.items i
           SET sku_suffix = CASE WHEN n.rn = 1 THEN n.s1
                                 ELSE n.s1 || '-' || n.rn END
          FROM numbered n
         WHERE n.id = i.id
        """
    )
    op.execute("ALTER TABLE app.items ALTER COLUMN sku_suffix SET NOT NULL")
    op.execute(
        "ALTER TABLE app.items ADD CONSTRAINT ck_items_ck_items_sku_suffix_not_blank "
        "CHECK (char_length(trim(sku_suffix)) > 0)"
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_items_prefix_suffix "
        "ON app.items (prefix_id, sku_suffix) WHERE deleted_at IS NULL"
    )

    # ── 3. Drop the old number + tier plumbing ───────────────────────────
    # The composite FK must go before the item_prefixes unique index it targets.
    op.execute("ALTER TABLE app.items DROP CONSTRAINT fk_items_prefix_item_prefixes")
    op.execute("ALTER TABLE app.items DROP CONSTRAINT fk_items_tier_id_item_tiers")
    op.execute("DROP INDEX app.uq_items_item_number")
    op.execute("DROP INDEX app.ix_items_item_number_prefix")
    op.execute("DROP INDEX app.ix_items_tier_id")
    op.execute("ALTER TABLE app.items DROP COLUMN item_number")
    op.execute("ALTER TABLE app.items DROP COLUMN tier_id")

    # ── 4. item_prefixes: drop tone + the now-unused composite-FK target ──
    op.execute("ALTER TABLE app.item_prefixes DROP CONSTRAINT uq_item_prefixes_id_tier")
    op.execute("ALTER TABLE app.item_prefixes DROP COLUMN tone")

    # ── 5. New simple prefix FK (composite is gone) ──────────────────────
    op.execute(
        "ALTER TABLE app.items "
        "ADD CONSTRAINT fk_items_prefix_id_item_prefixes "
        "FOREIGN KEY (prefix_id) REFERENCES app.item_prefixes (id) ON DELETE RESTRICT"
    )


def downgrade() -> None:
    # ── Restore items.tier_id ────────────────────────────────────────────
    op.execute("ALTER TABLE app.items ADD COLUMN tier_id uuid")
    op.execute(
        """
        UPDATE app.items i
           SET tier_id = p.tier_id
          FROM app.item_prefixes p
         WHERE p.id = i.prefix_id
        """
    )
    op.execute("ALTER TABLE app.items ALTER COLUMN tier_id SET NOT NULL")

    # ── Restore item_number = <code>-<suffix> ────────────────────────────
    op.execute("ALTER TABLE app.items ADD COLUMN item_number text")
    op.execute(
        """
        UPDATE app.items i
           SET item_number = p.code || '-' || i.sku_suffix
          FROM app.item_prefixes p
         WHERE p.id = i.prefix_id
        """
    )
    op.execute("ALTER TABLE app.items ALTER COLUMN item_number SET NOT NULL")

    # ── Restore item_prefixes.tone + composite-FK target ─────────────────
    op.execute(
        "ALTER TABLE app.item_prefixes ADD COLUMN tone text NOT NULL DEFAULT 'neutral'"
    )
    op.execute(
        """
        UPDATE app.item_prefixes p
           SET tone = t.tone
          FROM app.item_tiers t
         WHERE t.id = p.tier_id
        """
    )
    op.execute(
        "ALTER TABLE app.item_prefixes "
        "ADD CONSTRAINT uq_item_prefixes_id_tier UNIQUE (id, tier_id)"
    )

    # ── Swap the FKs / indexes back ──────────────────────────────────────
    op.execute("ALTER TABLE app.items DROP CONSTRAINT fk_items_prefix_id_item_prefixes")
    op.execute("DROP INDEX app.uq_items_prefix_suffix")
    op.execute(
        "ALTER TABLE app.items DROP CONSTRAINT ck_items_ck_items_sku_suffix_not_blank"
    )
    op.execute("ALTER TABLE app.items DROP COLUMN sku_suffix")

    op.execute(
        "CREATE UNIQUE INDEX uq_items_item_number "
        "ON app.items (item_number) WHERE deleted_at IS NULL"
    )
    op.execute(
        "CREATE INDEX ix_items_item_number_prefix "
        "ON app.items (SUBSTRING(item_number FROM 1 FOR 2))"
    )
    op.execute("CREATE INDEX ix_items_tier_id ON app.items (tier_id)")
    op.execute(
        "ALTER TABLE app.items "
        "ADD CONSTRAINT fk_items_tier_id_item_tiers "
        "FOREIGN KEY (tier_id) REFERENCES app.item_tiers (id) ON DELETE RESTRICT"
    )
    op.execute(
        """
        ALTER TABLE app.items
          ADD CONSTRAINT fk_items_prefix_item_prefixes
          FOREIGN KEY (prefix_id, tier_id)
          REFERENCES app.item_prefixes (id, tier_id) ON DELETE RESTRICT
        """
    )
