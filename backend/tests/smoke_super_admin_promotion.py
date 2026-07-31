"""Ad-hoc smoke test for Super Admin promotion + role-grant audit logging.

Run from the project root after ``docker compose up``:

    python backend/tests/smoke_super_admin_promotion.py

Covers REQ-2026-07-31-ROL-005 … ROL-009:
  * promotion to super_admin is accepted for an eligible user (active, has
    accepted their invite, has logged in) — reversing the old "never grantable"
    behaviour where the request failed Pydantic validation with a 422
  * an ineligible user is rejected with a specific, machine-readable code
    (never logged in / not accepted / inactive), not a generic 422
  * ``can_be_promoted`` + ``promotion_blocked_reason`` are surfaced on the user
    read model so the UI can explain a missing Super Admin option
  * the invite flow still refuses super_admin (ROL-006)
  * the last *active* super admin can't demote or deactivate themselves
    (ROL-008), while a non-last super admin can be demoted normally
  * a suspended super admin doesn't count toward the lockout guard
  * every role change writes an audit row carrying grantor, grantee, and the
    old → new role diff (ROL-009)

The test promotes a scratch user and demotes it again, so it is re-runnable.
It never touches the seeded super admin's own role.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
import uuid

BASE = os.environ.get("SMOKE_BASE", "http://localhost:8000/v1")
# No credential is hardcoded here — this file is tracked. Export SMOKE_PASSWORD
# with the password you seeded the super admin with.
# NOTE: the email default is the super admin that exists today. After running
# scripts/purge_users.py + seed_super_admins.py it becomes superadmin@cellready.dev
# — export SMOKE_EMAIL, or update this line once the reset has happened.
EMAIL = os.environ.get("SMOKE_EMAIL") or "admin@cellready.dev"
PASSWORD = os.environ.get("SMOKE_PASSWORD", "")

FAILS: list[str] = []
_PASSED = [0]


def _req(
    method: str,
    path: str,
    *,
    token: str | None = None,
    json_body: dict | None = None,
) -> tuple[int, dict]:
    headers: dict[str, str] = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body: bytes | None = None
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


def _login() -> str:
    s, b = _req("POST", "/auth/login", json_body={"email": EMAIL, "password": PASSWORD})
    assert s == 200, b
    return b["access_token"]


def _code(body: dict) -> str:
    """The domain error code, wherever the handler nests it."""
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


def _users(token: str) -> list[dict]:
    s, b = _req("GET", "/users", token=token)
    assert s == 200, b
    return b


def _patch(token: str, user_id: str, **changes) -> tuple[int, dict]:
    return _req("PATCH", f"/users/{user_id}", token=token, json_body=changes)


def _audit_for(token: str, subject_id: str) -> list[dict]:
    """Audit rows for one user row, newest first. The list endpoint returns an
    ``{"items": [...]}`` envelope."""
    s, b = _req("GET", f"/audit/events?subject_id={subject_id}&limit=20", token=token)
    if s != 200:
        return []
    return b.get("items", []) if isinstance(b, dict) else b


def main() -> int:
    token = _login()
    users = _users(token)

    me = next((u for u in users if u["email"].lower() == EMAIL.lower()), None)
    assert me is not None, f"{EMAIL} not in the user directory"

    # ── 1. The read model exposes promotion eligibility ─────────────────────
    check(
        "user read model carries can_be_promoted",
        "can_be_promoted" in me and "promotion_blocked_reason" in me,
        sorted(me.keys()),
    )

    # ── 2. Invite still refuses super_admin (ROL-006) ───────────────────────
    s, b = _req(
        "POST",
        "/invitations",
        token=token,
        json_body={
            "email": f"smoke-{uuid.uuid4().hex[:8]}@cellready.test",
            "first_name": "Smoke",
            "last_name": "Test",
            "role": "super_admin",
        },
    )
    check("invite rejects super_admin", s == 422, (s, b))

    # ── 3. Pick a scratch target ────────────────────────────────────────────
    others = [u for u in users if u["id"] != me["id"] and u["role"] != "super_admin"]
    if not others:
        print("\nNo non-super-admin user to promote. Run scripts/seed_users.py first.")
        return 1

    eligible = [u for u in others if u.get("can_be_promoted")]
    ineligible = [u for u in others if not u.get("can_be_promoted")]

    # ── 4. Ineligible users are rejected with a specific code ───────────────
    if ineligible:
        target = ineligible[0]
        s, b = _patch(token, target["id"], role="super_admin")
        check(
            "ineligible user rejected with a specific code",
            s in (400, 422)
            and _code(b).startswith("promotion_target_"),
            (s, _code(b)),
        )
        check(
            "ineligible user carries a human-readable reason",
            bool(target.get("promotion_blocked_reason")),
            target.get("promotion_blocked_reason"),
        )
    else:
        print("  SKIP  no ineligible user available to test the rejection path")

    # ── 5. Promotion of an eligible user succeeds ───────────────────────────
    if not eligible:
        print(
            "\n  SKIP  no eligible user (needs accepted invite + a login). "
            "Promotion path not exercised."
        )
        print(f"\n{_PASSED[0]} passed, {len(FAILS)} failed")
        for f in FAILS:
            print(f"  - {f}")
        return 1 if FAILS else 0

    target = eligible[0]
    original_role = target["role"]

    s, b = _patch(token, target["id"], role="super_admin")
    check("eligible user promoted to super_admin", s == 200 and b["role"] == "super_admin", (s, b))

    # ── 6. The grant is audited with grantor + grantee + diff (ROL-009) ─────
    rows = _audit_for(token, target["id"])
    grant_row = next(
        (
            r
            for r in rows
            if (r.get("diff") or {}).get("role", {}).get("after") == "super_admin"
        ),
        None,
    )
    check("role grant wrote an audit row", grant_row is not None, rows[:2])
    if grant_row:
        diff = grant_row.get("diff") or {}
        check(
            "audit row records old → new role",
            diff.get("role", {}).get("before") == original_role
            and diff.get("role", {}).get("after") == "super_admin",
            diff,
        )
        check(
            "audit row records the grantor",
            str(grant_row.get("actor_user_id")) == str(me["id"]),
            (grant_row.get("actor_user_id"), me["id"]),
        )
        check(
            "super_admin grant is escalated to warning severity",
            grant_row.get("severity") == "warning",
            grant_row.get("severity"),
        )

    # ── 7. A super admin who isn't the last one can be demoted ─────────────
    # Allowed precisely because other active super admins still exist.
    s, b = _patch(token, target["id"], role=original_role)
    check(
        "non-last super admin can be demoted",
        s == 200 and b["role"] == original_role,
        (s, b),
    )

    # ── 8. The last *active* super admin is protected (ROL-008) ────────────
    # The dev stack seeds three super admins (dev / stage / prod), so nobody is
    # the last one by default. Suspend the others to create the condition, then
    # restore them in `finally` — the suspension also proves the count fix: those
    # rows are still role=super_admin, so if the guard counted suspended users it
    # would wave the self-demotion through.
    others = [
        u
        for u in _users(token)
        if u["role"] == "super_admin" and u["is_active"] and u["id"] != me["id"]
    ]
    try:
        for u in others:
            s, b = _patch(token, u["id"], is_active=False)
            assert s == 200, (u["email"], s, b)

        s, b = _patch(token, me["id"], role="admin")
        check(
            "last active super admin can't self-demote",
            s == 409 and _code(b) == "last_super_admin",
            (s, _code(b)),
        )
        s, b = _patch(token, me["id"], is_active=False)
        check(
            "last active super admin can't self-deactivate",
            s == 409 and _code(b) == "last_super_admin",
            (s, _code(b)),
        )
        check(
            "suspended super admins don't count toward the guard",
            len(others) > 0 and s == 409,
            f"{len(others)} suspended, last response {s}",
        )
    finally:
        for u in others:
            rs, rb = _patch(token, u["id"], is_active=True)
            if rs != 200:
                print(f"  WARN  could not reactivate {u['email']}: {rs} {rb}")

    # ── 9. Still a super admin, and still active, after those rejections ────
    fresh = next((u for u in _users(token) if u["id"] == me["id"]), None)
    check(
        "seeded super admin survived the guard tests",
        fresh is not None and fresh["role"] == "super_admin" and fresh["is_active"],
        fresh,
    )
    restored = [u for u in _users(token) if u["role"] == "super_admin" and u["is_active"]]
    check(
        "all super admins reactivated",
        len(restored) == len(others) + 1,
        f"{len(restored)} active, expected {len(others) + 1}",
    )

    print(f"\n{_PASSED[0]} passed, {len(FAILS)} failed")
    for f in FAILS:
        print(f"  - {f}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
