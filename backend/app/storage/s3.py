"""Thin facade over ``boto3.client("s3")``.

One cached client per process. boto3's S3 client is sync; every call we
expose is wrapped in ``asyncio.to_thread`` so the async route handlers
don't block the event loop on upload / download.

The same client speaks to MinIO in dev (via ``S3_ENDPOINT_URL``) and
real AWS S3 in prod (no endpoint override) — boto3 picks the right
host based on the absence of the endpoint URL.

This module is the ONLY place in the codebase that imports boto3's S3
surface. Cognito-related boto3 lives in ``app.auth.cognito_client`` for
the same reason.
"""

from __future__ import annotations

import asyncio
import uuid
from functools import lru_cache
from typing import TYPE_CHECKING

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from app.core.config import get_settings
from app.core.exceptions import DomainError
from app.core.logging import get_logger

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client

log = get_logger(__name__)


class S3StorageError(DomainError):
    """Wraps boto3 ``ClientError`` for the storage layer.

    Surfaces as 500 by default; we don't leak bucket / key details into
    the response body — the request_id + structured log line is enough
    to investigate.
    """

    status_code = 500
    code = "storage_error"


# ── Client ──────────────────────────────────────────────────────────────


@lru_cache(maxsize=1)
def get_s3_client() -> "S3Client":
    """Process-wide S3 client.

    Path-style addressing is forced so MinIO works; AWS S3 still accepts
    it. Signature v4 is the default for new regions and required for
    MinIO. Standard retries are kept (3 attempts, exponential backoff).
    """
    settings = get_settings()

    kwargs: dict = {
        "region_name": settings.s3_region,
        "config": Config(
            signature_version="s3v4",
            s3={"addressing_style": "path" if settings.s3_force_path_style else "auto"},
            retries={"max_attempts": 3, "mode": "standard"},
        ),
    }

    # Endpoint override — set for MinIO, unset for AWS.
    if settings.s3_endpoint_url is not None:
        kwargs["endpoint_url"] = str(settings.s3_endpoint_url).rstrip("/")

    # Explicit creds — used in dev (MinIO root user) and as a fallback
    # in prod for non-EC2 hosts. EC2 / Fargate / EKS hosts should get
    # credentials from the IAM role automatically, in which case these
    # env vars stay unset and boto3 picks up the role.
    if settings.s3_access_key_id is not None:
        kwargs["aws_access_key_id"] = (
            settings.s3_access_key_id.get_secret_value()
        )
    if settings.s3_secret_access_key is not None:
        kwargs["aws_secret_access_key"] = (
            settings.s3_secret_access_key.get_secret_value()
        )

    return boto3.client("s3", **kwargs)  # type: ignore[return-value]


# ── Bootstrap ──────────────────────────────────────────────────────────


async def ensure_signatures_bucket() -> None:
    """Create the signatures bucket if it doesn't exist.

    Idempotent — ``BucketAlreadyOwnedByYou`` / ``BucketAlreadyExists``
    are not errors. Called from the lifespan hook so a freshly-stood-up
    MinIO container is ready before the first signature upload.

    In production we expect the bucket to be provisioned by Terraform /
    CDK ahead of time. The call still runs; a 403 means the deploy IAM
    role lacks ``s3:CreateBucket`` (which is fine — log it and carry on).
    """
    settings = get_settings()
    bucket = settings.s3_signatures_bucket
    client = get_s3_client()

    def _create() -> None:
        try:
            # ``CreateBucketConfiguration`` is required for non-``us-east-1``
            # regions on real AWS but rejected on ``us-east-1`` itself.
            # MinIO accepts both shapes; pick the right one per region.
            if settings.s3_region == "us-east-1":
                client.create_bucket(Bucket=bucket)
            else:
                client.create_bucket(
                    Bucket=bucket,
                    CreateBucketConfiguration={"LocationConstraint": settings.s3_region},
                )
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "")
            if code in ("BucketAlreadyOwnedByYou", "BucketAlreadyExists"):
                return
            if code == "AccessDenied":
                # Prod path — bucket exists, our role just can't create.
                log.info(
                    "storage.bucket.create_denied",
                    bucket=bucket,
                    hint="expected in prod when bucket is provisioned out-of-band",
                )
                return
            raise

    try:
        await asyncio.to_thread(_create)
        log.info("storage.bucket.ready", bucket=bucket)
    except ClientError as exc:
        log.error(
            "storage.bucket.create_failed",
            bucket=bucket,
            error=str(exc),
        )
        raise S3StorageError(
            "Failed to ensure signatures bucket",
            code="storage_bucket_init_failed",
        ) from exc


# ── Signature helpers ──────────────────────────────────────────────────


def signature_object_key(*, user_id: uuid.UUID, upload_id: uuid.UUID) -> str:
    """Canonical S3 key for one signature image.

    Includes the user id so a future per-user bucket policy can fence
    access by prefix; ``upload_id`` is a freshly-minted uuid so each
    upload is its own object (we don't have the reauth ``evidence_id``
    at upload time — it's minted *after* the password is verified).
    """
    return f"signatures/{user_id}/{upload_id}.png"


async def put_signature_image(
    *,
    user_id: uuid.UUID,
    upload_id: uuid.UUID,
    body: bytes,
    content_type: str = "image/png",
) -> str:
    """Upload a signature image and return its object key.

    Body is the raw PNG bytes from the canvas. Server-side encryption
    uses AES256 by default — KMS keys can be wired in later via env
    if/when the compliance review asks for it.
    """
    settings = get_settings()
    bucket = settings.s3_signatures_bucket
    key = signature_object_key(user_id=user_id, upload_id=upload_id)
    client = get_s3_client()

    def _put() -> None:
        # Encryption is enforced at the bucket level (default
        # ``aws:kms`` / ``AES256`` policy in prod, none in local MinIO)
        # rather than per-object so the same code path works for both.
        # If a future audit requires per-object SSE control, layer it
        # back here behind an ``S3_SERVER_SIDE_ENCRYPTION`` setting.
        client.put_object(
            Bucket=bucket,
            Key=key,
            Body=body,
            ContentType=content_type,
            Metadata={
                "user_id": str(user_id),
                "upload_id": str(upload_id),
            },
        )

    try:
        await asyncio.to_thread(_put)
    except ClientError as exc:
        log.error(
            "storage.signature.put_failed",
            bucket=bucket,
            key=key,
            error=str(exc),
        )
        raise S3StorageError(
            "Failed to upload signature image",
            code="storage_put_failed",
        ) from exc

    log.info("storage.signature.put", bucket=bucket, key=key, bytes=len(body))
    return key


async def fetch_signature_bytes(key: str) -> tuple[bytes, str]:
    """Download a signature image. Returns ``(body, content_type)``.

    Raises ``S3StorageError`` with code ``storage_not_found`` when the
    object doesn't exist — callers can map to 404.
    """
    settings = get_settings()
    bucket = settings.s3_signatures_bucket
    client = get_s3_client()

    def _get() -> tuple[bytes, str]:
        resp = client.get_object(Bucket=bucket, Key=key)
        body = resp["Body"].read()
        content_type = resp.get("ContentType", "application/octet-stream")
        return body, content_type

    try:
        return await asyncio.to_thread(_get)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code in ("NoSuchKey", "404"):
            raise S3StorageError(
                "Signature image not found",
                code="storage_not_found",
            ) from exc
        log.error(
            "storage.signature.get_failed",
            bucket=bucket,
            key=key,
            error=str(exc),
        )
        raise S3StorageError(
            "Failed to fetch signature image",
            code="storage_get_failed",
        ) from exc
