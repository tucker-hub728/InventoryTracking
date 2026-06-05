"""product_sku

Add ``app.products.sku`` — a unique code derived from the product name at
creation time (uppercase slug; deduped). Backfills existing rows: live
products get a clean deduped slug, soft-deleted rows get their UUID (they
are hidden anyway). NOT NULL + partial-unique among live rows.

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
"""

from __future__ import annotations

import re
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "e5f6a7b8c9d0"
down_revision: str | None = "d4e5f6a7b8c9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _slug(name: str) -> str:
    base = re.sub(r"[^A-Za-z0-9]+", "-", name or "").strip("-").upper()
    return base or "PRODUCT"


def upgrade() -> None:
    op.add_column("products", sa.Column("sku", sa.Text(), nullable=True), schema="app")

    conn = op.get_bind()
    # Live rows → clean, deduped slug of the name.
    live = conn.execute(
        sa.text(
            "SELECT id, name FROM app.products "
            "WHERE deleted_at IS NULL AND sku IS NULL ORDER BY created_at"
        )
    ).fetchall()
    taken: set[str] = set()
    for rid, name in live:
        base = _slug(name)
        sku = base
        n = 2
        while sku.lower() in taken:
            sku = f"{base}-{n}"
            n += 1
        taken.add(sku.lower())
        conn.execute(
            sa.text("UPDATE app.products SET sku = :sku WHERE id = :id"),
            {"sku": sku, "id": rid},
        )
    # Soft-deleted rows → UUID (hidden; only needs to be non-null + unique).
    conn.execute(
        sa.text(
            "UPDATE app.products SET sku = id::text "
            "WHERE deleted_at IS NOT NULL AND sku IS NULL"
        )
    )

    op.alter_column("products", "sku", nullable=False, schema="app")
    op.create_index(
        "uq_products_sku",
        "products",
        [sa.text("lower(sku)")],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
        schema="app",
    )


def downgrade() -> None:
    op.drop_index("uq_products_sku", table_name="products", schema="app")
    op.drop_column("products", "sku", schema="app")
