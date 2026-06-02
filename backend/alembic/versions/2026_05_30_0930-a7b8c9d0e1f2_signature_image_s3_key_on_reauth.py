"""signature_image_s3_key_on_reauth

Add ``signature_image_s3_key`` to ``audit.reauth_events``. The column
points at an S3 object (e.g. ``signatures/<user_id>/<evidence_id>.png``)
that the audit viewer can fetch via a backend-proxied endpoint.

Nullable for two reasons:
  * Backwards compatibility — existing rows have no image.
  * Image capture is optional on the wire today. The frontend
    PasswordReauthDialog will start collecting one but won't block
    submission if the canvas is empty, so headless / API-only callers
    (e.g. tests) keep working.

The append-only trigger from migration ``2026_05_29_1300`` still
applies — once a row lands, this column can't be back-filled.

Revision ID: a7b8c9d0e1f2
Revises: f2a3b4c5d6e7
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "a7b8c9d0e1f2"
down_revision: str | None = "f2a3b4c5d6e7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "reauth_events",
        sa.Column("signature_image_s3_key", sa.Text(), nullable=True),
        schema="audit",
    )


def downgrade() -> None:
    op.drop_column("reauth_events", "signature_image_s3_key", schema="audit")
