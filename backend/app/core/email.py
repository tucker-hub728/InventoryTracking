"""Outbound email for the invite flow.

The app owns the invitation email in every environment: it sends a single-use
**accept link** (the token in the link is the credential) over SMTP. In dev SMTP
points at maildev/mailpit; in prod at any provider. Cognito's own email is
always suppressed.

Kept dependency-free (stdlib ``smtplib``); the blocking send runs in a worker
thread so it never stalls the event loop, and a delivery failure is non-fatal
(the admin can still copy the accept link from the API response / UI).
"""

from __future__ import annotations

import asyncio
from email.message import EmailMessage

from app.core.config import get_settings
from app.core.logging import get_logger

log = get_logger(__name__)


def _build_invitation_message(
    *, to_email: str, display_name: str, accept_url: str
) -> EmailMessage:
    settings = get_settings()
    msg = EmailMessage()
    msg["Subject"] = "You've been invited to CellReady IMS"
    msg["From"] = settings.email_from
    msg["To"] = to_email

    body = (
        f"Hi {display_name or to_email},\n\n"
        "You've been invited to CellReady IMS. Click the secure link below to "
        "set your password and activate your account:\n\n"
        f"{accept_url}\n\n"
        f"This invitation expires in {settings.invite_ttl_days} days and the "
        "link can only be used once.\n\n"
        "If you weren't expecting this invitation you can ignore this email.\n"
    )
    msg.set_content(body)
    return msg


def _send_sync(msg: EmailMessage) -> None:
    import smtplib

    settings = get_settings()
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as smtp:
        if settings.smtp_use_tls:
            smtp.starttls()
        if settings.smtp_username and settings.smtp_password:
            smtp.login(settings.smtp_username, settings.smtp_password.get_secret_value())
        smtp.send_message(msg)


async def send_invitation_email(
    *, to_email: str, display_name: str, accept_url: str
) -> bool:
    """Send the accept-link invitation email over SMTP. Returns True on success.

    Best-effort: a delivery failure is logged and returns False rather than
    rolling back the invite — the identity + token already exist, so the admin
    can copy the accept link and share it manually. The blocking SMTP call runs
    in a worker thread.
    """
    msg = _build_invitation_message(
        to_email=to_email, display_name=display_name, accept_url=accept_url
    )
    try:
        await asyncio.to_thread(_send_sync, msg)
        log.info("email.invitation_sent", to=to_email)
        return True
    except Exception:  # noqa: BLE001 — never fail an invite on an email hiccup
        log.exception("email.invitation_failed", to=to_email)
        return False
