"""Object storage facade.

This package wraps boto3's S3 client behind an async-friendly surface so
the rest of the app never has to import boto3 directly. The same module
talks to MinIO in dev and real AWS S3 in prod — only the endpoint URL
and credential source differ between environments.
"""

from app.storage.s3 import (
    S3StorageError,
    ensure_signatures_bucket,
    fetch_signature_bytes,
    get_s3_client,
    put_signature_image,
    signature_object_key,
)

__all__ = [
    "S3StorageError",
    "ensure_signatures_bucket",
    "fetch_signature_bytes",
    "get_s3_client",
    "put_signature_image",
    "signature_object_key",
]
