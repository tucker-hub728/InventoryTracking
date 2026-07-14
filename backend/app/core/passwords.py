"""Server-side password-policy enforcement.

Cognito enforces the user-pool password policy in production, but we validate
here too so the rule holds regardless of the identity backend (notably
``cognito-local``, which does NOT enforce the policy). Mirrors the production
Cognito pool policy: min 12 chars with an upper, a lower, a digit and a symbol.
"""

from __future__ import annotations

import re

from app.core.exceptions import ValidationError

MIN_LENGTH = 12

_RULES = (
    (re.compile(r"[A-Z]"), "an uppercase letter"),
    (re.compile(r"[a-z]"), "a lowercase letter"),
    (re.compile(r"\d"), "a number"),
    (re.compile(r"[^A-Za-z0-9]"), "a symbol"),
)

_REQUIREMENT = (
    "Password must be at least 12 characters and include an uppercase letter, "
    "a lowercase letter, a number and a symbol."
)


def validate_password_strength(password: str) -> None:
    """Raise :class:`ValidationError` (422) if ``password`` is too weak.

    A single generic message is returned so the caller can surface it verbatim;
    we don't enumerate exactly which class is missing beyond the requirement.
    """
    ok = len(password) >= MIN_LENGTH and all(rx.search(password) for rx, _ in _RULES)
    if not ok:
        raise ValidationError(_REQUIREMENT, code="invalid_password")
