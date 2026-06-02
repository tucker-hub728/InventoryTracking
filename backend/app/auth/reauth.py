"""E-signature backbone.

The reauth flow gives the system **fresh proof** that the user behind a
write request is really the user the cookie session claims they are. It
exists because 21 CFR Part 11 §11.200 requires a second-factor identity
check at the moment of each "GxP-significant" action — a stale session
cookie alone is not enough.

Flow (described once here so the rest of the codebase can stay terse):

    1. Frontend wizard collects the write payload.
    2. Before submitting, frontend calls ``POST /v1/auth/reauth``
       with ``{action, password, meaning?}``.
    3. Backend:
        a. Rate-limit check (failures in last 5 min for this user).
        b. Verify password via Cognito ``USER_PASSWORD_AUTH``.
        c. Write an ``audit.reauth_events`` row (success or failure).
        d. On success, return the row id + expiration to the caller.
    4. Frontend submits the actual write endpoint with
       ``X-Reauth-Evidence-Id`` (or a body field — TBD in Chunk 4).
    5. The write endpoint validates the evidence (Chunk 4 work) and
       marks it consumed so it can't be replayed.

This module owns steps 3a, 3b, 3c — the policy + audit-row write. The
route handler does input validation + step 3d (returning the response).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import cognito_client
from app.core.exceptions import (
    AuthenticationError,
    DomainError,
    RateLimitedError,
)
from app.core.logging import get_logger
from app.models.audit import ReauthConsumption, ReauthEvent

log = get_logger(__name__)


# ── Policy knobs ────────────────────────────────────────────────────────
# Surfaced as module constants so a future settings/env wiring is a
# one-liner and tests can monkey-patch them. Values picked from the
# Chunk 3 design proposal.

#: How long a successful evidence id stays valid. Long enough to compose
#: a wizard, short enough that a tab left open overnight can't replay.
REAUTH_TTL = timedelta(seconds=120)

#: How many failed attempts a single user can make before the next one
#: is rejected with 429. Reads ``audit.reauth_events`` directly so
#: there's no separate counter store to keep in sync.
RATE_LIMIT_MAX_FAILURES = 5

#: Sliding window for the failure count above.
RATE_LIMIT_WINDOW = timedelta(minutes=5)


ReauthFailureReason = Literal[
    "wrong_password", "user_disabled", "rate_limited", "cognito_error",
]


# ── Internal helpers ────────────────────────────────────────────────────


async def _count_recent_failures(
    db: AsyncSession, *, user_id: uuid.UUID
) -> int:
    """Number of failed reauth events for the user inside the sliding window."""
    since = datetime.now(UTC) - RATE_LIMIT_WINDOW
    stmt = (
        select(func.count())
        .select_from(ReauthEvent)
        .where(
            ReauthEvent.user_id == user_id,
            ReauthEvent.success.is_(False),
            ReauthEvent.created_at >= since,
        )
    )
    return int((await db.execute(stmt)).scalar_one())


async def _record_event(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    action: str,
    meaning: str | None,
    success: bool,
    failure_reason: ReauthFailureReason | None,
    ip_address: str | None,
    user_agent: str | None,
    signature_image_s3_key: str | None = None,
) -> ReauthEvent:
    """Insert an immutable audit row. Caller commits."""
    now = datetime.now(UTC)
    evt = ReauthEvent(
        user_id=user_id,
        action=action,
        meaning=meaning,
        success=success,
        failure_reason=failure_reason,
        ip_address=ip_address,
        user_agent=user_agent,
        # On failure rows ``expires_at`` is mostly cosmetic — a failed
        # event isn't usable as evidence — but the CHECK requires
        # ``expires_at > created_at`` so we always set it.
        expires_at=now + REAUTH_TTL,
        # Image key is only meaningful on success rows — we accept it
        # on either so audit rows persist what the operator saw even
        # when the password failed.
        signature_image_s3_key=signature_image_s3_key,
    )
    db.add(evt)
    await db.flush()
    return evt


def _cognito_failure_reason(exc: DomainError) -> ReauthFailureReason:
    """Translate a Cognito-translated ``DomainError`` into our failure enum.

    Falls back to message inspection because cognito-local doesn't
    return the typed Cognito error code (it returns the HTTP status
    "400" instead). Real Cognito always sets ``cognito_code`` to a
    typed name like ``NotAuthorizedException`` so the first check wins
    in prod; the message-substring fallback only fires in dev.
    """
    details = exc.details if isinstance(exc.details, dict) else {}
    cognito_code = str(details.get("cognito_code", ""))
    cognito_message = str(details.get("cognito_message", "")).lower()

    if cognito_code == "NotAuthorizedException":
        return "wrong_password"
    if cognito_code in ("UserNotConfirmedException", "PasswordResetRequiredException"):
        return "user_disabled"
    # cognito-local quirk: Code = "400", Message = "Invalid password" /
    # "Password attempts exceeded" / etc. Match on the human text since
    # it's the same string real Cognito returns.
    if "password" in cognito_message:
        return "wrong_password"
    if "disabled" in cognito_message or "not confirmed" in cognito_message:
        return "user_disabled"
    return "cognito_error"


# ── Public surface ──────────────────────────────────────────────────────


async def verify_password_and_issue_evidence(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    cognito_username: str,
    password: str,
    action: str,
    meaning: str | None,
    ip_address: str | None,
    user_agent: str | None,
    signature_image_s3_key: str | None = None,
) -> ReauthEvent:
    """Run the full reauth flow. Caller commits the session.

    On success returns the inserted ``ReauthEvent`` (the row id is the
    evidence). On any failure raises a domain exception **after** the
    audit row is written — so brute-force attempts always leave a trace
    even though the caller sees a 401 / 429.

    The caller is responsible for committing the session so the audit
    row is durable before we respond. If the request errors before
    commit (process crash, network drop), the row rolls back along with
    the failure path — that's acceptable because no harm was done.
    """

    # 1) Rate limit. We check *before* hitting Cognito so a flood of
    #    failures stops costing us Cognito quota.
    fails = await _count_recent_failures(db, user_id=user_id)
    if fails >= RATE_LIMIT_MAX_FAILURES:
        evt = await _record_event(
            db,
            user_id=user_id,
            action=action,
            meaning=meaning,
            success=False,
            failure_reason="rate_limited",
            ip_address=ip_address,
            user_agent=user_agent,
            signature_image_s3_key=signature_image_s3_key,
        )
        await db.commit()
        log.warning(
            "auth.reauth.rate_limited",
            user_id=str(user_id),
            action=action,
            recent_failures=fails,
        )
        raise RateLimitedError(
            "Too many failed re-authentication attempts; try again shortly",
            code="reauth_rate_limited",
            details={"retry_after_seconds": int(RATE_LIMIT_WINDOW.total_seconds())},
        )

    # 2) Cognito password check. ``sign_in`` already maps Cognito errors
    #    to our domain exceptions, so we just catch them.
    try:
        cognito_client.sign_in(email=cognito_username, password=password)
    except DomainError as exc:
        reason = _cognito_failure_reason(exc)
        await _record_event(
            db,
            user_id=user_id,
            action=action,
            meaning=meaning,
            success=False,
            failure_reason=reason,
            ip_address=ip_address,
            user_agent=user_agent,
            signature_image_s3_key=signature_image_s3_key,
        )
        await db.commit()
        log.info(
            "auth.reauth.failed",
            user_id=str(user_id),
            action=action,
            reason=reason,
        )
        # Always surface as 401 to the caller — we don't leak whether
        # the failure was wrong-password vs disabled-user, etc.
        raise AuthenticationError(
            "Re-authentication failed",
            code="reauth_failed",
        ) from exc

    # 3) Success — write the evidence row.
    evt = await _record_event(
        db,
        user_id=user_id,
        action=action,
        meaning=meaning,
        success=True,
        failure_reason=None,
        ip_address=ip_address,
        user_agent=user_agent,
        signature_image_s3_key=signature_image_s3_key,
    )
    await db.commit()
    log.info(
        "auth.reauth.succeeded",
        user_id=str(user_id),
        action=action,
        evidence_id=str(evt.id),
    )
    return evt


# ── Consumption (used by write endpoints) ───────────────────────────────


class ReauthEvidenceInvalid(AuthenticationError):
    """Catch-all for "the evidence is no good" — wrong user, wrong
    action, expired, already used, failed at issuance, simply missing.

    All flavours surface as 401 to the client with a per-case code so the
    UI can decide whether to re-prompt the user, show a session-expired
    message, or surface a "this was already submitted" warning.
    """

    code = "reauth_evidence_invalid"


async def consume_reauth_evidence(
    db: AsyncSession,
    *,
    evidence_id: uuid.UUID,
    user_id: uuid.UUID,
    expected_action: str,
    target_table: str,
    target_id: uuid.UUID,
) -> ReauthEvent:
    """Atomically validate ``evidence_id`` and mark it consumed.

    Called inside the same transaction as the write it authorises.
    Validity is checked in order of likelihood, then a row is inserted
    into ``audit.reauth_consumptions``. The unique PK on
    ``reauth_event_id`` is the replay guard: a concurrent second
    consume sees ``IntegrityError`` and rolls back with a 401 ``replayed``.

    The caller does NOT commit here — the wrapping route handler
    commits the whole receipt/movement/consumption tx together.
    """

    evt = (
        await db.execute(select(ReauthEvent).where(ReauthEvent.id == evidence_id))
    ).scalar_one_or_none()

    if evt is None:
        raise ReauthEvidenceInvalid(
            "Re-authentication evidence not found",
            code="reauth_evidence_not_found",
        )
    if not evt.success:
        # Failed reauth rows live in the table for forensic value but
        # are never valid evidence.
        raise ReauthEvidenceInvalid(
            "Re-authentication evidence is not valid",
            code="reauth_evidence_invalid",
        )
    if evt.user_id != user_id:
        # The evidence was issued for another user — don't leak that
        # detail; surface a generic invalid.
        log.warning(
            "auth.reauth.user_mismatch",
            evidence_id=str(evidence_id),
            evidence_user=str(evt.user_id),
            attempted_by=str(user_id),
        )
        raise ReauthEvidenceInvalid(
            "Re-authentication evidence is not valid",
            code="reauth_evidence_invalid",
        )
    if evt.action != expected_action:
        # Action mismatch — caller signed for X, tried to use it for Y.
        raise ReauthEvidenceInvalid(
            f"Evidence was issued for action '{evt.action}', not '{expected_action}'",
            code="reauth_evidence_action_mismatch",
        )
    if evt.expires_at < datetime.now(UTC):
        raise ReauthEvidenceInvalid(
            "Re-authentication evidence has expired; re-enter your password",
            code="reauth_evidence_expired",
        )

    # Insert the consumption row. PK = reauth_event_id, so a concurrent
    # consumption of the same evidence raises IntegrityError on flush.
    consumption = ReauthConsumption(
        reauth_event_id=evt.id,
        consumed_by_user_id=user_id,
        target_table=target_table,
        target_id=target_id,
    )
    db.add(consumption)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise ReauthEvidenceInvalid(
            "Re-authentication evidence has already been used",
            code="reauth_evidence_replayed",
        ) from exc

    return evt
