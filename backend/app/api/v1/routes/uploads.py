"""Upload endpoints.

Currently exposes only ``POST /v1/uploads/signature`` — the canvas image
the operator draws inside the e-signature dialog. The frontend uploads
through this endpoint (not directly to S3) for three reasons:

  1. S3 credentials never reach the browser.
  2. No CORS configuration on MinIO / S3 required.
  3. We can validate MIME / size / origin server-side before bytes
     hit the bucket.

Returns ``{ key, content_type, size }``. The caller then passes
``key`` to ``POST /v1/auth/reauth`` as ``signature_image_s3_key``.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, File, Path, UploadFile, status
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentDbUserDep
from app.core.exceptions import NotFoundError, ValidationError
from app.db.session import get_session
from app.models.audit import ReauthEvent
from app.security.permissions import RequirePermission
from app.storage import (
    S3StorageError,
    fetch_signature_bytes,
    put_signature_image,
)

router = APIRouter(prefix="/uploads", tags=["uploads"])


# Hard cap to keep one bad upload from filling the bucket. A signature
# canvas at 800×400 px exports well under 100 KB; 2 MB leaves room
# for high-DPI screens and the occasional whiteboard photo.
_MAX_SIGNATURE_BYTES = 2 * 1024 * 1024
_ALLOWED_CONTENT_TYPES: frozenset[str] = frozenset(
    {"image/png", "image/jpeg", "image/webp"}
)


@router.post(
    "/signature",
    summary="Upload a signature image; returns the S3 key.",
    status_code=status.HTTP_201_CREATED,
)
async def upload_signature(
    current: CurrentDbUserDep,
    file: Annotated[UploadFile, File(description="Signature image (PNG/JPEG/WebP)")],
) -> dict:
    """Receive a multipart upload and stash it in S3.

    Auth: any authenticated user (we don't gate on a write permission
    here — the eventual write endpoint enforces ``inventory:sign`` and
    the upload is useless without a successful reauth pairing).
    """
    content_type = file.content_type or "application/octet-stream"
    if content_type not in _ALLOWED_CONTENT_TYPES:
        raise ValidationError(
            f"Unsupported signature content type: {content_type}",
            code="signature_invalid_type",
            details={"allowed": sorted(_ALLOWED_CONTENT_TYPES)},
        )

    # Read the full body. Signature canvases are tiny (KB range) so we
    # don't bother streaming. The cap below catches anyone trying.
    body = await file.read()
    if len(body) == 0:
        raise ValidationError(
            "Signature image is empty",
            code="signature_empty",
        )
    if len(body) > _MAX_SIGNATURE_BYTES:
        raise ValidationError(
            f"Signature image exceeds {_MAX_SIGNATURE_BYTES // 1024} KB",
            code="signature_too_large",
        )

    upload_id = uuid.uuid4()
    key = await put_signature_image(
        user_id=current.id,
        upload_id=upload_id,
        body=body,
        content_type=content_type,
    )
    return {
        "key": key,
        "content_type": content_type,
        "size": len(body),
    }


# ── Signature fetch (used by the audit viewer) ─────────────────────────


@router.get(
    "/signature/{evidence_id}",
    summary="Stream the signature image for one reauth evidence row.",
    responses={
        200: {"content": {"image/png": {}}},
        404: {"description": "No signature on file for this evidence id."},
    },
)
async def get_signature_for_evidence(
    current: CurrentDbUserDep,
    evidence_id: Annotated[uuid.UUID, Path()],
    db: Annotated[AsyncSession, Depends(get_session)],
    # Both the signer and any user with the audit-view permission can
    # see the image. The permission isn't defined yet — once the audit
    # module ships, swap ``inventory:view`` for ``audit:view``.
    _viewer: None = Depends(RequirePermission("inventory", "view")),
) -> Response:
    """Look up the reauth row, then stream the S3 object behind its key.

    404 in three cases:
      * evidence id doesn't exist
      * row exists but no signature_image_s3_key was attached
      * S3 has lost the object (operator deleted, lifecycle policy, etc.)
    """
    row = (
        await db.execute(select(ReauthEvent).where(ReauthEvent.id == evidence_id))
    ).scalar_one_or_none()
    if row is None or row.signature_image_s3_key is None:
        raise NotFoundError(
            f"No signature on file for evidence {evidence_id}",
            code="signature_not_found",
        )

    # Authorization: signer themselves OR any user with audit-view
    # permission (currently gated as ``inventory:view`` until the
    # audit module ships its own permission).
    # ``_viewer`` already enforced ``inventory:view``; the row-owner
    # exception is implicit in the same check today and gets tightened
    # later.
    _ = current  # silence "unused" — kept on the signature for future per-user gating

    try:
        body, content_type = await fetch_signature_bytes(row.signature_image_s3_key)
    except S3StorageError as exc:
        if exc.code == "storage_not_found":
            raise NotFoundError(
                f"Signature object missing in storage for evidence {evidence_id}",
                code="signature_not_found",
            ) from exc
        raise

    return Response(
        content=body,
        media_type=content_type,
        headers={
            # Browser caching is fine because the object is immutable
            # (append-only audit row + immutable S3 key).
            "Cache-Control": "private, max-age=31536000, immutable",
        },
    )
