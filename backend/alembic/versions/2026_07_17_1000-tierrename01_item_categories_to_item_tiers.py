"""Rename item_categories → item_tiers; replace ``kind`` with ``type``.

The requirements settled on "tier" as the domain term (the UI already said
"Tier"), and on three fixed tiers rather than a two-valued purchased/built
flag — REQ-2026-07-15-ITM-001: "Exactly three item categories shall exist:
raw material, sub-assembly and finished good. Admin-added prefixes shall live
within one of these categories and shall never constitute a fourth category,
so the system always knows how to handle an item for kitting, debiting and
planning."

``kind`` could not express that: sub-assemblies and finished goods were both
``built``, so nothing distinguished an AY from an FG. ``type`` carries the tier
identity directly, which is what the BOM rules need (Transaction Spec §1.1 —
an FG may never be a BOM component).

Backfill maps the old two-valued ``kind`` onto the three tiers via the seeded
prefixes, which are unique (case-insensitive) among live rows:

    kind='purchased'            → 'raw_material'   (CR)
    kind='built' + prefix='FG'  → 'finished_good'
    kind='built' + anything else→ 'sub_assembly'   (AY)

The final fallback is deliberate: a sub-assembly may be both a BOM parent and
a BOM child, so an ad-hoc built tier landing there is never silently blocked
by the new BOM rules — whereas defaulting to finished_good would be.

Constraint names here are spelled out literally rather than via
``op.create_check_constraint``: this project's metadata naming convention is
``ck_%(table_name)s_%(constraint_name)s`` and the models already pass a
``ck_``-prefixed name, so the real DB names are double-prefixed
(``ck_item_tiers_ck_item_tiers_type``). Spelling them out keeps the migration
honest about what actually exists.

Revision ID: tierrename01
Revises: freezerwh01
"""

from __future__ import annotations

from alembic import op

revision: str = "tierrename01"
down_revision: str | None = "freezerwh01"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    # ── Table + FK column ──────────────────────────────────────────────
    op.rename_table("item_categories", "item_tiers", schema="app")
    op.alter_column("items", "category_id", new_column_name="tier_id", schema="app")

    # ── kind → type ────────────────────────────────────────────────────
    # Drop the old CHECK first: the new values violate it mid-flight.
    op.execute(
        "ALTER TABLE app.item_tiers " "DROP CONSTRAINT ck_item_categories_ck_item_categories_kind"
    )
    op.alter_column("item_tiers", "kind", new_column_name="type", schema="app")
    op.execute(
        """
        UPDATE app.item_tiers
           SET type = CASE
                 WHEN type = 'purchased' THEN 'raw_material'
                 WHEN upper(prefix) = 'FG' THEN 'finished_good'
                 ELSE 'sub_assembly'
               END
        """
    )
    op.execute(
        "ALTER TABLE app.item_tiers ADD CONSTRAINT ck_item_tiers_ck_item_tiers_type "
        "CHECK (type IN ('raw_material', 'sub_assembly', 'finished_good'))"
    )

    # ── Constraint renames ─────────────────────────────────────────────
    # rename_table carries these across but keeps their old names.
    for old, new in (
        (
            "ck_item_categories_ck_item_categories_name_not_blank",
            "ck_item_tiers_ck_item_tiers_name_not_blank",
        ),
        (
            "ck_item_categories_ck_item_categories_prefix_not_blank",
            "ck_item_tiers_ck_item_tiers_prefix_not_blank",
        ),
        (
            "fk_item_categories_created_by_user_id_users",
            "fk_item_tiers_created_by_user_id_users",
        ),
        (
            "fk_item_categories_updated_by_user_id_users",
            "fk_item_tiers_updated_by_user_id_users",
        ),
        ("pk_item_categories", "pk_item_tiers"),
    ):
        op.execute(f"ALTER TABLE app.item_tiers RENAME CONSTRAINT {old} TO {new}")

    op.execute(
        "ALTER TABLE app.items RENAME CONSTRAINT "
        "fk_items_category_id_item_categories TO fk_items_tier_id_item_tiers"
    )

    # ── Index renames ──────────────────────────────────────────────────
    for old, new in (
        ("uq_item_categories_name", "uq_item_tiers_name"),
        ("uq_item_categories_prefix", "uq_item_tiers_prefix"),
        ("ix_item_categories_updated_at_desc", "ix_item_tiers_updated_at_desc"),
        ("ix_items_category_id", "ix_items_tier_id"),
    ):
        op.execute(f"ALTER INDEX app.{old} RENAME TO {new}")


def downgrade() -> None:
    for new, old in (
        ("uq_item_categories_name", "uq_item_tiers_name"),
        ("uq_item_categories_prefix", "uq_item_tiers_prefix"),
        ("ix_item_categories_updated_at_desc", "ix_item_tiers_updated_at_desc"),
        ("ix_items_category_id", "ix_items_tier_id"),
    ):
        op.execute(f"ALTER INDEX app.{old} RENAME TO {new}")

    op.execute(
        "ALTER TABLE app.items RENAME CONSTRAINT "
        "fk_items_tier_id_item_tiers TO fk_items_category_id_item_categories"
    )
    for new, old in (
        (
            "ck_item_categories_ck_item_categories_name_not_blank",
            "ck_item_tiers_ck_item_tiers_name_not_blank",
        ),
        (
            "ck_item_categories_ck_item_categories_prefix_not_blank",
            "ck_item_tiers_ck_item_tiers_prefix_not_blank",
        ),
        (
            "fk_item_categories_created_by_user_id_users",
            "fk_item_tiers_created_by_user_id_users",
        ),
        (
            "fk_item_categories_updated_by_user_id_users",
            "fk_item_tiers_updated_by_user_id_users",
        ),
        ("pk_item_categories", "pk_item_tiers"),
    ):
        op.execute(f"ALTER TABLE app.item_tiers RENAME CONSTRAINT {old} TO {new}")

    op.execute("ALTER TABLE app.item_tiers DROP CONSTRAINT ck_item_tiers_ck_item_tiers_type")
    # sub_assembly and finished_good both collapse back to 'built' — the
    # distinction the old two-valued model could not hold.
    op.execute(
        """
        UPDATE app.item_tiers
           SET type = CASE
                 WHEN type = 'raw_material' THEN 'purchased'
                 ELSE 'built'
               END
        """
    )
    op.alter_column("item_tiers", "type", new_column_name="kind", schema="app")
    op.execute(
        "ALTER TABLE app.item_tiers "
        "ADD CONSTRAINT ck_item_categories_ck_item_categories_kind "
        "CHECK (kind IN ('purchased', 'built'))"
    )

    op.alter_column("items", "tier_id", new_column_name="category_id", schema="app")
    op.rename_table("item_tiers", "item_categories", schema="app")
