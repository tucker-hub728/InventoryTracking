"""Credentials for the smoke scripts — read from the environment, never stored.

Every smoke script used to carry a default login inline::

    EMAIL = os.environ.get("SMOKE_EMAIL", "someone@example")
    PASSWORD = os.environ.get("SMOKE_PASSWORD", "a-real-password")

which is a credential committed to the repository. That it was "only a dev
password" is not a mitigation: it is published the moment the repo is cloned,
mirrored into every fork and CI log, and — because the seed scripts used the
same pair — it was a working login on any box that had been seeded. A password
that exists in version control is a password that has to be treated as
compromised.

So there are no defaults here. A smoke run supplies its own credentials or it
does not run::

    SMOKE_EMAIL=you@example SMOKE_PASSWORD=... \\
        python backend/tests/smoke_consumables.py

The failure is deliberately loud and early — printed and ``SystemExit(2)``
before any HTTP call — because the alternative is a script that reaches the API
with an empty password and reports a confusing 401 that reads like a broken
endpoint rather than a missing variable.
"""

from __future__ import annotations

import os
import sys

#: Exit code for "you did not configure this", distinct from 1 = tests failed.
#: A CI job can tell a misconfigured run from a genuine regression.
EXIT_UNCONFIGURED = 2


def _read(prefix: str) -> tuple[str, str]:
    return (
        os.environ.get(f"{prefix}_EMAIL", "").strip(),
        os.environ.get(f"{prefix}_PASSWORD", ""),
    )


def require_credentials(prefix: str = "SMOKE") -> tuple[str, str]:
    """``(email, password)`` from ``<PREFIX>_EMAIL`` / ``<PREFIX>_PASSWORD``.

    Exits with a usage message when either is missing. Callers use this at
    import time, so the script stops before it does anything.
    """
    email, password = _read(prefix)
    if email and password:
        return email, password

    missing = [
        name
        for name, value in ((f"{prefix}_EMAIL", email), (f"{prefix}_PASSWORD", password))
        if not value
    ]
    script = os.path.basename(sys.argv[0]) or "the smoke script"
    print(f"REFUSING: {' and '.join(missing)} not set.", file=sys.stderr)
    print(
        f"\nThis script has no built-in login — credentials are never stored in\n"
        f"the repository. Supply them for the run:\n\n"
        f"    {prefix}_EMAIL=you@example {prefix}_PASSWORD='…' \\\n"
        f"        python backend/tests/{script}\n",
        file=sys.stderr,
    )
    raise SystemExit(EXIT_UNCONFIGURED)


def optional_credentials(prefix: str) -> tuple[str, str] | None:
    """Same, but ``None`` when unset — for the checks a script SKIPS rather than
    fails without (a second, higher-privileged account, say)."""
    email, password = _read(prefix)
    return (email, password) if email and password else None
