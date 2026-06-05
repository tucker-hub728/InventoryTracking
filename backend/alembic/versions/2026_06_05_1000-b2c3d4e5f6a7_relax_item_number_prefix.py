"""relax_item_number_prefix

Relax the ``app.items.item_number`` prefix constraints so the catalogue
can use any short grouping code (e.g. ``MR-0001``, ``PI-0003``,
``OE-0012``) — not just the original ``CM`` / ``NM`` / ``CR`` / ``AY`` set.

Week 2 makes "category" a free-form code the operator types at product
creation; that code becomes the item-number prefix. The original two
CHECKs hard-coded the four legacy prefixes:

  * ``ck_items_item_number_prefix`` — ``LIKE 'CM-%' OR 'NM-%' OR …``
  * ``ck_items_item_number_format`` — ``~ '^(CM|NM|CR|AY)-[0-9]+$'``

Both are replaced by a single shape check that accepts any
``^[A-Z][A-Z0-9]{1,7}-[0-9]+$`` number (a 2–8 character, letter-led
prefix, a dash, then digits). Every existing CM/NM/CR/AY item is a
strict subset of that pattern, so no current row is invalidated.

Reversible: ``downgrade`` restores the two original CHECKs verbatim. It
will fail if any item carrying a non-legacy prefix exists at that point
(expected — you cannot un-ring the bell; this is a dev-only concern).

Revision ID: b2c3d4e5f6a7
Revises: a2b3c4d5e6f7
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op


revision: str = "b2c3d4e5f6a7"
down_revision: str | None = "a2b3c4d5e6f7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# The original four-prefix whitelist (restored verbatim on downgrade).
_LEGACY_PREFIXES: tuple[str, ...] = ("CM-", "NM-", "CR-", "AY-")

# New relaxed shape: 2–8 char, letter-led code · dash · 1+ digits.
_RELAXED_FORMAT = "item_number ~ '^[A-Z][A-Z0-9]{1,7}-[0-9]+$'"


def upgrade() -> None:
    # Drop the two legacy prefix CHECKs and replace with one generic
    # shape check. The partial-unique index + format are unchanged in
    # spirit — only the accepted prefix set widens.
    op.drop_constraint(
        "ck_items_item_number_prefix", "items", schema="app", type_="check"
    )
    op.drop_constraint(
        "ck_items_item_number_format", "items", schema="app", type_="check"
    )
    op.create_check_constraint(
        "ck_items_item_number_format", "items", _RELAXED_FORMAT, schema="app"
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_items_item_number_format", "items", schema="app", type_="check"
    )
    prefix_check = " OR ".join(
        f"item_number LIKE '{p}%'" for p in _LEGACY_PREFIXES
    )
    op.create_check_constraint(
        "ck_items_item_number_prefix", "items", prefix_check, schema="app"
    )
    op.create_check_constraint(
        "ck_items_item_number_format",
        "items",
        "item_number ~ '^(CM|NM|CR|AY)-[0-9]+$'",
        schema="app",
    )
