"""rename_vendor_to_supplier

Terminology change (client directive, 2026-07-01): "Vendor" becomes
"Supplier" throughout the product — including the database. This migration
renames the schema objects so the DB matches the renamed ORM / API:

Tables (schema ``meta``)
  * ``meta.vendors``       → ``meta.suppliers``
  * ``meta.item_vendors``  → ``meta.item_suppliers``

Columns
  * ``app.lots.vendor_id``                     → ``supplier_id``
  * ``meta.item_suppliers.vendor_id``          → ``supplier_id``
  * ``app.receipt_transaction_lines.vendor_id``→ ``supplier_id``

Indexes / constraints / trigger are renamed to their ``supplier`` analogues
so a future ``alembic revision --autogenerate`` produces no churn.

This is a pure rename: no data is created, moved or dropped. Foreign keys
track the referenced table by identity, so renaming ``meta.vendors`` keeps
every FK valid automatically — only the constraint *names* are refreshed.

The ``suppliers`` primary key was originally created from an inline
``primary_key=True`` (no explicit name), so its current name is unknown
(``vendors_pkey`` vs ``pk_vendors``); it is renamed via a catalog lookup so
this migration cannot fail on a name mismatch.

Revision ID: f7a8b9c0d1e2
Revises: e0f1a2b3c4d5
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "f7a8b9c0d1e2"
down_revision: str | None = "e0f1a2b3c4d5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _rename_pk(table_fqn: str, new_name: str) -> None:
    """Rename ``table_fqn``'s primary-key constraint to ``new_name``.

    Looks the current name up in ``pg_constraint`` so it works whether the
    PK is ``vendors_pkey`` (Postgres default) or ``pk_vendors`` (naming
    convention). A no-op if it is already ``new_name``.
    """
    # Both args are hardcoded table/constraint names from the call sites below,
    # never user input — the f-string is not an injection vector.
    op.execute(
        f"""
        DO $$
        DECLARE pkname text;
        BEGIN
          SELECT conname INTO pkname
            FROM pg_constraint
           WHERE conrelid = '{table_fqn}'::regclass AND contype = 'p';
          IF pkname IS NOT NULL AND pkname <> '{new_name}' THEN
            EXECUTE format(
              'ALTER TABLE {table_fqn} RENAME CONSTRAINT %I TO %I',
              pkname, '{new_name}'
            );
          END IF;
        END $$;
        """  # noqa: S608
    )


def upgrade() -> None:
    # 1) Tables -----------------------------------------------------------
    op.execute("ALTER TABLE meta.vendors RENAME TO suppliers")
    op.execute("ALTER TABLE meta.item_vendors RENAME TO item_suppliers")

    # 2) Columns ----------------------------------------------------------
    op.execute("ALTER TABLE app.lots RENAME COLUMN vendor_id TO supplier_id")
    op.execute(
        "ALTER TABLE meta.item_suppliers RENAME COLUMN vendor_id TO supplier_id"
    )
    op.execute(
        "ALTER TABLE app.receipt_transaction_lines "
        "RENAME COLUMN vendor_id TO supplier_id"
    )

    # 3) Indexes ----------------------------------------------------------
    op.execute("ALTER INDEX meta.uq_vendors_name RENAME TO uq_suppliers_name")
    op.execute("ALTER INDEX meta.ix_vendors_active RENAME TO ix_suppliers_active")
    op.execute("ALTER INDEX app.ix_lots_vendor_id RENAME TO ix_lots_supplier_id")
    op.execute(
        "ALTER INDEX meta.ix_item_vendors_item_id "
        "RENAME TO ix_item_suppliers_item_id"
    )
    op.execute(
        "ALTER INDEX meta.ix_item_vendors_vendor_id "
        "RENAME TO ix_item_suppliers_supplier_id"
    )

    # 4) Constraints ------------------------------------------------------
    _rename_pk("meta.suppliers", "pk_suppliers")
    _rename_pk("meta.item_suppliers", "pk_item_suppliers")
    op.execute(
        "ALTER TABLE meta.item_suppliers "
        "RENAME CONSTRAINT uq_item_vendors_item_vendor "
        "TO uq_item_suppliers_item_supplier"
    )
    op.execute(
        "ALTER TABLE meta.item_suppliers "
        "RENAME CONSTRAINT fk_item_vendors_item_id_items "
        "TO fk_item_suppliers_item_id_items"
    )
    op.execute(
        "ALTER TABLE meta.item_suppliers "
        "RENAME CONSTRAINT fk_item_vendors_vendor_id_vendors "
        "TO fk_item_suppliers_supplier_id_suppliers"
    )
    op.execute(
        "ALTER TABLE meta.item_suppliers "
        "RENAME CONSTRAINT fk_item_vendors_created_by_users "
        "TO fk_item_suppliers_created_by_users"
    )
    op.execute(
        "ALTER TABLE app.lots "
        "RENAME CONSTRAINT fk_lots_vendor_id_vendors "
        "TO fk_lots_supplier_id_suppliers"
    )
    op.execute(
        "ALTER TABLE app.receipt_transaction_lines "
        "RENAME CONSTRAINT fk_receipt_transaction_lines_vendor_id "
        "TO fk_receipt_transaction_lines_supplier_id"
    )

    # 5) Trigger ----------------------------------------------------------
    op.execute(
        "ALTER TRIGGER tg_vendors_touch_updated_at ON meta.suppliers "
        "RENAME TO tg_suppliers_touch_updated_at"
    )


def downgrade() -> None:
    # Reverse of upgrade(), in the opposite order.
    op.execute(
        "ALTER TRIGGER tg_suppliers_touch_updated_at ON meta.suppliers "
        "RENAME TO tg_vendors_touch_updated_at"
    )

    op.execute(
        "ALTER TABLE app.receipt_transaction_lines "
        "RENAME CONSTRAINT fk_receipt_transaction_lines_supplier_id "
        "TO fk_receipt_transaction_lines_vendor_id"
    )
    op.execute(
        "ALTER TABLE app.lots "
        "RENAME CONSTRAINT fk_lots_supplier_id_suppliers "
        "TO fk_lots_vendor_id_vendors"
    )
    op.execute(
        "ALTER TABLE meta.item_suppliers "
        "RENAME CONSTRAINT fk_item_suppliers_created_by_users "
        "TO fk_item_vendors_created_by_users"
    )
    op.execute(
        "ALTER TABLE meta.item_suppliers "
        "RENAME CONSTRAINT fk_item_suppliers_supplier_id_suppliers "
        "TO fk_item_vendors_vendor_id_vendors"
    )
    op.execute(
        "ALTER TABLE meta.item_suppliers "
        "RENAME CONSTRAINT fk_item_suppliers_item_id_items "
        "TO fk_item_vendors_item_id_items"
    )
    op.execute(
        "ALTER TABLE meta.item_suppliers "
        "RENAME CONSTRAINT uq_item_suppliers_item_supplier "
        "TO uq_item_vendors_item_vendor"
    )
    _rename_pk("meta.item_suppliers", "pk_item_vendors")
    _rename_pk("meta.suppliers", "pk_vendors")

    op.execute(
        "ALTER INDEX meta.ix_item_suppliers_supplier_id "
        "RENAME TO ix_item_vendors_vendor_id"
    )
    op.execute(
        "ALTER INDEX meta.ix_item_suppliers_item_id "
        "RENAME TO ix_item_vendors_item_id"
    )
    op.execute("ALTER INDEX app.ix_lots_supplier_id RENAME TO ix_lots_vendor_id")
    op.execute("ALTER INDEX meta.ix_suppliers_active RENAME TO ix_vendors_active")
    op.execute("ALTER INDEX meta.uq_suppliers_name RENAME TO uq_vendors_name")

    op.execute(
        "ALTER TABLE app.receipt_transaction_lines "
        "RENAME COLUMN supplier_id TO vendor_id"
    )
    op.execute(
        "ALTER TABLE meta.item_suppliers RENAME COLUMN supplier_id TO vendor_id"
    )
    op.execute("ALTER TABLE app.lots RENAME COLUMN supplier_id TO vendor_id")

    op.execute("ALTER TABLE meta.item_suppliers RENAME TO item_vendors")
    op.execute("ALTER TABLE meta.suppliers RENAME TO vendors")
