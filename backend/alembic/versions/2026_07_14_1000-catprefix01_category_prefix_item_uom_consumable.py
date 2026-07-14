"""category_prefix_item_uom_consumable

Requirements v3 item-numbering + raw-material intake (2026-07-14).

* ``app.item_categories.prefix`` — NEW NOT-NULL. The item-number type prefix
  (``CR`` / ``AY`` / ``FG``) that drives per-tier filtering and the auto-prefixed
  SKU on the item-create forms (REQ-2026-07-09-ITM-001/002). Unique
  (case-insensitive) among live categories.
* ``app.items.uom`` — NEW nullable free-text unit of measure (each, mL, box …).
* ``app.items.is_consumable`` — NEW NOT-NULL boolean. Consumables are
  blind-consumed to manufacturing with no per-lot traceability
  (REQ-2026-07-01-TRX-003).

Re-seeds the item categories down to the **three** canonical tiers the client
runs today (the ``restore01`` seed put five in): Raw Materials (CR, purchased),
Sub-Assemblies (AY, built) and Finished Goods (FG, built). Categories are
seed-only for now; CRUD lands later.

The reconcile is FK-safe: existing items on a retired seeded category are moved
to the matching canonical tier by ``kind`` (purchased → Raw Materials, built →
Finished Goods) before the empty category is dropped. Per the ``restore01``
philosophy this data is disposable — the point of the move is only to keep the
migration from failing on a dev DB that already has items.

Revision ID: catprefix01
Revises: restore01
Create Date: 2026-07-14 10:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "catprefix01"
down_revision: str | None = "restore01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The three canonical tiers: (name, prefix, kind, tone). CR is purchased
# (bought as-is); AY / FG are built ("Product", may carry a BOM).
_SEED_CATEGORIES = (
    ("Raw Materials", "CR", "purchased", "neutral"),
    ("Sub-Assemblies", "AY", "built", "accent"),
    ("Finished Goods", "FG", "built", "success"),
)
_TARGET_NAMES = tuple(name for name, *_ in _SEED_CATEGORIES)


def upgrade() -> None:
    # ── New columns ────────────────────────────────────────────────────
    op.add_column(
        "item_categories",
        sa.Column("prefix", sa.Text(), nullable=True),
        schema="app",
    )
    op.add_column(
        "items",
        sa.Column("uom", sa.Text(), nullable=True),
        schema="app",
    )
    op.add_column(
        "items",
        sa.Column(
            "is_consumable",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("FALSE"),
        ),
        schema="app",
    )

    # ── Ensure the 3 canonical categories exist (upsert by live name) ──
    # A seeded category may already carry the target name (e.g. the
    # restore01 "Sub-Assemblies"); update it in place rather than colliding
    # on ``uq_item_categories_name``.
    for name, prefix, kind, tone in _SEED_CATEGORIES:
        op.execute(
            sa.text(
                """
                UPDATE app.item_categories
                SET prefix = :prefix, kind = :kind, tone = :tone, is_seeded = TRUE
                WHERE lower(name) = lower(:name) AND deleted_at IS NULL
                """
            ).bindparams(name=name, prefix=prefix, kind=kind, tone=tone)
        )
        op.execute(
            sa.text(
                """
                INSERT INTO app.item_categories (name, prefix, kind, tone, is_seeded)
                SELECT :name, :prefix, :kind, :tone, TRUE
                WHERE NOT EXISTS (
                    SELECT 1 FROM app.item_categories
                    WHERE lower(name) = lower(:name) AND deleted_at IS NULL
                )
                """
            ).bindparams(name=name, prefix=prefix, kind=kind, tone=tone)
        )

    # ── Reassign items off retired seeded categories, then drop them ───
    # Purchased tiers fold into Raw Materials (CR); built tiers into
    # Finished Goods (FG). Sub-Assemblies is a keeper and is excluded.
    op.execute(
        sa.text(
            """
            UPDATE app.items i
            SET category_id = tgt.id
            FROM app.item_categories old
            JOIN app.item_categories tgt
              ON tgt.name = CASE
                   WHEN old.kind = 'purchased' THEN 'Raw Materials'
                   ELSE 'Finished Goods'
                 END
             AND tgt.deleted_at IS NULL
            WHERE i.category_id = old.id
              AND old.is_seeded = TRUE
              AND old.deleted_at IS NULL
              AND old.name NOT IN :keep
            """
        ).bindparams(sa.bindparam("keep", value=_TARGET_NAMES, expanding=True))
    )
    op.execute(
        sa.text(
            """
            DELETE FROM app.item_categories
            WHERE is_seeded = TRUE
              AND deleted_at IS NULL
              AND name NOT IN :keep
            """
        ).bindparams(sa.bindparam("keep", value=_TARGET_NAMES, expanding=True))
    )

    # ── Back-fill stray non-seeded prefixes, then lock the column down ─
    op.execute(
        r"""
        UPDATE app.item_categories
        SET prefix = upper(left(regexp_replace(name, '[^A-Za-z0-9]', '', 'g'), 3))
        WHERE prefix IS NULL
        """
    )
    op.execute(
        "UPDATE app.item_categories SET prefix = 'XX' "
        "WHERE prefix IS NULL OR char_length(trim(prefix)) = 0"
    )
    op.alter_column("item_categories", "prefix", nullable=False, schema="app")
    op.create_check_constraint(
        "ck_item_categories_prefix_not_blank",
        "item_categories",
        "char_length(trim(prefix)) > 0",
        schema="app",
    )
    op.create_index(
        "uq_item_categories_prefix",
        "item_categories",
        [sa.text("lower(prefix)")],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
        schema="app",
    )


def downgrade() -> None:
    # Schema-only reversal. The category-row reconcile is intentionally not
    # undone — re-splitting the three tiers back into five and re-homing items
    # is neither well-defined nor useful (the restore chain is one-way anyway).
    op.drop_index(
        "uq_item_categories_prefix", table_name="item_categories", schema="app"
    )
    op.drop_constraint(
        "ck_item_categories_prefix_not_blank",
        "item_categories",
        schema="app",
        type_="check",
    )
    op.drop_column("items", "is_consumable", schema="app")
    op.drop_column("items", "uom", schema="app")
    op.drop_column("item_categories", "prefix", schema="app")
