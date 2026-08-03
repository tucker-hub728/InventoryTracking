"""esignimg01: drop the e-signature image column

The client's decision (2026-08-03) is that an electronic signature in this
system is the password re-authentication — nothing is drawn, and no signature
image is shown anywhere. This removes the last trace of the canvas image:
``audit.reauth_events.signature_image_s3_key``.

**This is compliant, not a weakening.** 21 CFR Part 11 §11.200(a)(1) requires a
non-biometric electronic signature to use at least two distinct identification
components — here the session identity plus the password re-entered at sign
time. §11.50 requires the signed record to carry the signer's name, the date
and time, and the meaning of the signing; all three live on this row
(``user_id`` → the actor, ``created_at``, ``action`` / ``meaning``). A drawn
image was never a Part 11 requirement, and this table remains append-only and
trigger-protected.

**Why dropping the column is safe here.** The feature was never reachable in
the shipped UI: every signing flow used the password-only dialog, the canvas
component was imported by no page, and the upload endpoint was never called.
The column was NULL on every row in the development database (0 of 150 reauth
events carried a key), which is what made a destructive drop acceptable rather
than a soft retirement.

**Operators: check before you run this.** If any environment DID capture
signature images, this column is the only pointer to those objects and dropping
it orphans them. Verify first, and export if the count is non-zero:

    SELECT count(*) FROM audit.reauth_events WHERE signature_image_s3_key IS NOT NULL;

``downgrade`` re-adds the column, but it comes back NULL — the S3 keys
themselves are not recoverable from the database. That is a deliberate
one-way door, agreed with the client.

Revision ID: esignimg01
Revises: seedadmin01
Create Date: 2026-08-03 10:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "esignimg01"
down_revision: str | None = "seedadmin01"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The append-only triggers on this table block UPDATE / DELETE / TRUNCATE,
    # which are DML. ALTER TABLE is DDL and is not intercepted by them, so the
    # column drop proceeds without touching the immutability guarantee for the
    # rows themselves.
    op.drop_column("reauth_events", "signature_image_s3_key", schema="audit")


def downgrade() -> None:
    # Restores the shape, NOT the data — see the module docstring. Nullable so
    # existing rows are valid immediately.
    op.add_column(
        "reauth_events",
        sa.Column("signature_image_s3_key", sa.Text(), nullable=True),
        schema="audit",
    )
