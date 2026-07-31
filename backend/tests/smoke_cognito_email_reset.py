"""Ad-hoc smoke test for the Cognito email-change and password-reset flows.

Run from the project root after ``docker compose up``:

    python backend/tests/smoke_cognito_email_reset.py

Covers:
  * super admin changes a member's email; the member can then sign in with the
    NEW address, and their Cognito ``sub`` (and so ``app.users.id``) is unchanged
  * the email change is audited with the old → new address and the actor
  * changing to an address another member already uses is rejected (``email_taken``)
  * an invalid address shape is rejected before Cognito is touched
  * ``/auth/forgot-password`` answers identically for a real address, an unknown
    address, and a deactivated account — no member enumeration
  * ``/auth/reset-password`` with a wrong code fails, and with the real code
    succeeds and the new password works at login
  * a weak password is rejected on the policy, not by Cognito

The reset code is scraped from the cognito-local container log, which is where
cognito-local prints it because it cannot send mail. That makes this test
local-only by nature; against real Cognito the code goes to the inbox.

Creates and deletes its own scratch users, so it is re-runnable.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
import uuid

BASE = os.environ.get("SMOKE_BASE", "http://localhost:8000/v1")
# No credential is hardcoded here — this file is tracked. See the note in
# smoke_super_admin_promotion.py about the email default after an auth reset.
EMAIL = os.environ.get("SMOKE_EMAIL") or "admin@cellready.dev"
PASSWORD = os.environ.get("SMOKE_PASSWORD", "")
COGNITO_CONTAINER = os.environ.get("SMOKE_COGNITO_CONTAINER", "cellready-cognito")

SCRATCH_PW = "ScratchPass!2026x"
NEW_PW = "BrandNewPass!2026x"

FAILS: list[str] = []
_PASSED = [0]


def _req(method, path, *, token=None, json_body=None) -> tuple[int, dict]:
    headers: dict[str, str] = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = None
    if json_body is not None:
        body = json.dumps(json_body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return exc.code, json.loads(raw)
        except Exception:
            return exc.code, {"raw": raw.decode(errors="replace")}


def _code_of(body: dict) -> str:
    if not isinstance(body, dict):
        return ""
    for key in ("code", "error_code"):
        if key in body:
            return str(body[key])
    detail = body.get("detail")
    if isinstance(detail, dict):
        return str(detail.get("code", ""))
    return ""


def check(label: str, ok: bool, ctx: object = "") -> None:
    if ok:
        _PASSED[0] += 1
        print(f"  PASS  {label}")
    else:
        FAILS.append(label)
        print(f"  FAIL  {label}  {ctx}")


def _login(email: str, password: str) -> tuple[int, dict]:
    return _req("POST", "/auth/login", json_body={"email": email, "password": password})


def _sub_of(token: str) -> str | None:
    s, b = _req("GET", "/auth/me", token=token)
    return b.get("sub") if s == 200 else None


def _latest_reset_code() -> str | None:
    """Scrape the most recent confirmation code from the cognito-local log.

    cognito-local can't send mail, so it prints the code in a box:
        │   Code:        075272                     │
    """
    try:
        out = subprocess.run(
            ["docker", "logs", COGNITO_CONTAINER, "--tail", "400"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except Exception as exc:  # pragma: no cover - environment dependent
        print(f"  NOTE  could not read {COGNITO_CONTAINER} logs: {exc}")
        return None
    blob = (out.stdout or "") + (out.stderr or "")
    codes = re.findall(r"Code:\s*(\d{4,8})", blob)
    return codes[-1] if codes else None


def main() -> int:
    s, b = _login(EMAIL, PASSWORD)
    assert s == 200, b
    token = b["access_token"]

    tag = uuid.uuid4().hex[:8]
    old_email = f"smoke-{tag}@cellready.test"
    new_email = f"smoke-{tag}-moved@cellready.test"

    # ── Set up a scratch member ─────────────────────────────────────────────
    # Created straight in Cognito with a known permanent password, the way
    # scripts/seed_users.py does. The invite flow can't be used here: the backend
    # never sees the temporary password (Cognito mails it directly), so a test
    # can't complete the challenge. The app.users row materialises lazily on the
    # first /auth/me.
    from app.auth import cognito_client

    cognito_client.admin_create_user(email=old_email, name="Smoke Scratch", role="read_only")
    cognito_client.admin_set_user_password(email=old_email, password=SCRATCH_PW, permanent=True)

    s, b = _login(old_email, SCRATCH_PW)
    check("scratch member can sign in with the old address", s == 200, (s, b))
    sub_before = _sub_of(b.get("access_token", "")) if s == 200 else None

    # /auth/me above provisioned the local mirror, so the member is now listed.
    users = _req("GET", "/users", token=token)[1]
    target = next((u for u in users if u["email"] == old_email), None)
    assert target is not None, "scratch user missing from the directory"

    # ── 1. Reject an address another member already holds ──────────────────
    s, b = _req("PATCH", f"/users/{target['id']}", token=token, json_body={"email": EMAIL})
    check("duplicate email rejected", s == 409 and _code_of(b) == "email_taken", (s, _code_of(b)))

    # ── 2. Reject a malformed address before Cognito is touched ────────────
    s, b = _req("PATCH", f"/users/{target['id']}", token=token, json_body={"email": "not-an-email"})
    check("malformed email rejected", s == 422, (s, _code_of(b)))

    # ── 3. Change the email ────────────────────────────────────────────────
    s, b = _req("PATCH", f"/users/{target['id']}", token=token, json_body={"email": new_email})
    check("email changed", s == 200 and b.get("email") == new_email, (s, b))

    s, b = _login(new_email, SCRATCH_PW)
    check("member signs in with the NEW address", s == 200, (s, b))
    sub_after = _sub_of(b.get("access_token", "")) if s == 200 else None
    check(
        "cognito sub unchanged by the email move",
        sub_before is not None and sub_before == sub_after,
        (sub_before, sub_after),
    )

    rows = _req("GET", f"/audit/events?subject_id={target['id']}&limit=20", token=token)[1]
    rows = rows.get("items", []) if isinstance(rows, dict) else rows
    email_row = next(
        (r for r in rows if (r.get("diff") or {}).get("email", {}).get("after") == new_email),
        None,
    )
    check("email change wrote an audit row", email_row is not None, rows[:1])
    if email_row:
        check(
            "audit row records old → new email",
            (email_row.get("diff") or {}).get("email", {}).get("before") == old_email,
            email_row.get("diff"),
        )

    # ── 4. forgot-password does not reveal who has an account ──────────────
    real = _req("POST", "/auth/forgot-password", json_body={"email": new_email})
    unknown = _req("POST", "/auth/forgot-password", json_body={"email": f"nobody-{tag}@nowhere.test"})
    check(
        "forgot-password answers identically for known and unknown addresses",
        real[0] == unknown[0] == 200 and real[1] == unknown[1],
        (real, unknown),
    )

    # ── 5. Wrong code is rejected ──────────────────────────────────────────
    s, b = _req(
        "POST",
        "/auth/reset-password",
        json_body={"email": new_email, "code": "000000", "password": NEW_PW},
    )
    check("wrong reset code rejected", s in (400, 401, 422), (s, _code_of(b)))

    # ── 6. Weak password rejected on our policy ────────────────────────────
    s, b = _req(
        "POST",
        "/auth/reset-password",
        json_body={"email": new_email, "code": "000000", "password": "weak"},
    )
    check("weak password rejected", s == 422, (s, _code_of(b)))

    # ── 7. Real code completes the reset ───────────────────────────────────
    _req("POST", "/auth/forgot-password", json_body={"email": new_email})
    code = _latest_reset_code()
    if code is None:
        print("  SKIP  no reset code found in the cognito-local log")
    else:
        s, b = _req(
            "POST",
            "/auth/reset-password",
            json_body={"email": new_email, "code": code, "password": NEW_PW},
        )
        check("reset with the emailed code succeeds", s == 200, (s, b))
        s, b = _login(new_email, NEW_PW)
        check("member signs in with the new password", s == 200, (s, b))
        s, b = _login(new_email, SCRATCH_PW)
        check("old password no longer works", s != 200, (s, b))

    # ── 8. A deactivated account can't start a reset ───────────────────────
    _req("PATCH", f"/users/{target['id']}", token=token, json_body={"is_active": False})
    off = _req("POST", "/auth/forgot-password", json_body={"email": new_email})
    check(
        "deactivated account gets the same generic answer",
        off[0] == 200 and off[1] == real[1],
        off,
    )

    # ── Clean up the scratch identity ──────────────────────────────────────
    for addr in (new_email, old_email):
        with contextlib.suppress(Exception):  # best-effort teardown
            cognito_client.admin_delete_user(email=addr)

    print(f"\n{_PASSED[0]} passed, {len(FAILS)} failed")
    for f in FAILS:
        print(f"  - {f}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
