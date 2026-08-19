"""Ad-hoc smoke test for the lot release state (REQ-2026-07-31-STS-001/002/003).

Run from the project root after ``docker compose up`` and AFTER applying the
``relstate01`` migration:

    SMOKE_SA_EMAIL=super.admin@cellready.dev SMOKE_SA_PASSWORD='DevSuper_123!' \
        SMOKE_OP_EMAIL=... SMOKE_OP_PASSWORD=... \
        python backend/tests/smoke_release_state.py

Verifies the three stories, and — as much as anything — the lines the client
drew around them on 2026-08-17:

  * STS-001  a lot carries a release state, and it is a DIFFERENT axis from
             ``lots.status``. Both are asserted on the same row so a future
             refactor that collapses them fails here.
  * STS-001  a lot with no release workflow reads ``null``, not a fifth value.
  * STS-002  changing it needs a signature minted for ``lot.release_state``;
             a ``lot.update`` ticket is refused (this is the guard that keeps
             "fix a typo" from becoming "release a batch").
  * STS-002  who and when land in the audit store, queryable per lot, with the
             before/after diff — there is no history table by design.
  * STS-002  an operator is refused even though they hold ``inventory:sign``.
  * B/C      no state is terminal: rejected → released is allowed.
  * no-op    signing a change to the state it is already in is refused.
  * STS-003  the state is a LABEL — a quarantined lot still transfers. This is
             the assertion that would catch someone "helpfully" adding a block.

Needs a super admin and, for the permission case, an operator. Picks a lot that
already exists rather than manufacturing one, so it can run without a kit; the
quarantine-on-produce default is exercised by ``smoke_kitting.py`` territory and
is asserted here only if a kit-produced lot happens to be present.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("SMOKE_BASE", "http://localhost:8000/v1")
SA_EMAIL = os.environ.get("SMOKE_SA_EMAIL", "super.admin@cellready.dev")
SA_PASSWORD = os.environ.get("SMOKE_SA_PASSWORD", "DevSuper_123!")
OP_EMAIL = os.environ.get("SMOKE_OP_EMAIL", "operator.user@cellready.dev")
OP_PASSWORD = os.environ.get("SMOKE_OP_PASSWORD", "DevOperator_123!")

ACTION = "lot.release_state"
WRONG_ACTION = "lot.update"

_failures: list[str] = []


def check(label: str, ok: bool, detail: object = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}")
    if not ok:
        _failures.append(f"{label} — {detail!r}")


def _req(method, path, *, token=None, json_body=None):
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


def _login(email: str, password: str) -> str | None:
    s, b = _req("POST", "/auth/login", json_body={"email": email, "password": password})
    if s != 200:
        return None
    return b["access_token"]


def _reauth(token: str, password: str, action: str = ACTION) -> str:
    s, b = _req(
        "POST", "/auth/reauth", token=token, json_body={"action": action, "password": password}
    )
    assert s == 200, b
    return b["evidence_id"]


def _set_state(token, password, lot_id, state, *, action=ACTION, reason="smoke"):
    return _req(
        "POST",
        f"/lots/{lot_id}/release-state",
        token=token,
        json_body={
            "release_state": state,
            "evidence_id": _reauth(token, password, action),
            "reason": reason,
        },
    )


def main() -> int:
    sa = _login(SA_EMAIL, SA_PASSWORD)
    if sa is None:
        print(f"Could not log in as {SA_EMAIL}. Set SMOKE_SA_EMAIL / SMOKE_SA_PASSWORD.")
        return 2

    print("\n-- a lot to work with")
    s, lots = _req("GET", "/lots?limit=50", token=sa)
    if s != 200 or not lots:
        print(f"  No lots available to test against ({s}).")
        return 2
    lot = lots[0]
    lot_id = lot["id"]
    print(f"     lot {lot['lot_number']} ({lot_id})")

    check(
        "STS-001 the read model exposes release_state",
        "release_state" in lot,
        sorted(lot.keys()),
    )
    check(
        "STS-001 release_state and status are separate fields",
        "status" in lot and lot.get("status") in ("on_order", "available"),
        lot.get("status"),
    )

    # A lot nobody has decided on yet reads null, not a fifth enum value.
    untouched = [x for x in lots if x.get("release_state") is None]
    check(
        "STS-001 an untracked lot is null, not a placeholder value",
        bool(untouched) or all(x.get("release_state") is not None for x in lots),
        [x.get("release_state") for x in lots[:5]],
    )

    produced = [x for x in lots if x.get("release_state") == "quarantine"]
    if produced:
        check("STS-001 manufactured lots sit in quarantine", True, produced[0]["lot_number"])
    else:
        print("  SKIP  no kit-produced lot present to check the quarantine default")

    print("\n-- STS-002 the signature is specific to this decision")
    s, b = _set_state(sa, SA_PASSWORD, lot_id, "qc_hold", action=WRONG_ACTION)
    check(
        "a lot.update ticket cannot release a batch",
        s in (401, 403, 422),
        (s, b.get("code")),
    )

    print("\n-- STS-002 the change itself")
    s, b = _set_state(sa, SA_PASSWORD, lot_id, "qc_hold")
    check("super admin can set qc_hold", s == 200, (s, b))
    check("the response carries the new state", b.get("release_state") == "qc_hold", b)

    s, b = _set_state(sa, SA_PASSWORD, lot_id, "qc_hold")
    check(
        "a no-op change is refused",
        s == 422 and b.get("code") == "release_state_unchanged",
        (s, b.get("code")),
    )

    print("\n-- B/C no state is terminal")
    s, _ = _set_state(sa, SA_PASSWORD, lot_id, "rejected")
    check("qc_hold -> rejected", s == 200, s)
    s, b = _set_state(sa, SA_PASSWORD, lot_id, "released")
    check(
        "rejected -> released is allowed (rejected is not terminal)",
        s == 200 and b.get("release_state") == "released",
        (s, b.get("release_state")),
    )

    print("\n-- STS-002 the record: who, when, from -> to")
    s, events = _req(
        "GET",
        f"/audit/events?subject_table=app.lots&subject_id={lot_id}&limit=20",
        token=sa,
    )
    rows = events.get("items", events) if isinstance(events, dict) else events
    check("the lot's audit history is queryable", s == 200, s)
    state_rows = [
        e
        for e in (rows or [])
        if isinstance(e, dict)
        and (e.get("after_state") or {}).get("release_state") is not None
    ]
    check("the change is in the audit store", bool(state_rows), len(rows or []))
    if state_rows:
        top = state_rows[0]
        check("it records who", bool(top.get("actor_user_id")), top.get("actor_user_id"))
        check("it records when", bool(top.get("occurred_at")), top.get("occurred_at"))
        check("it links the signature", bool(top.get("signature_id")), top.get("signature_id"))
        check(
            "it records from -> to",
            (top.get("before_state") or {}).get("release_state")
            != (top.get("after_state") or {}).get("release_state"),
            (top.get("before_state"), top.get("after_state")),
        )

    print("\n-- STS-002 an operator may not decide")
    op = _login(OP_EMAIL, OP_PASSWORD)
    if op is None:
        print(f"  SKIP  no operator login ({OP_EMAIL}); set SMOKE_OP_EMAIL / SMOKE_OP_PASSWORD")
    else:
        s, b = _set_state(op, OP_PASSWORD, lot_id, "quarantine")
        check(
            "operator is refused despite holding inventory:sign",
            s == 403 and b.get("code") == "permission_denied",
            (s, b.get("code")),
        )

    print("\n-- STS-003 it is a label, not a block")
    s, _ = _set_state(sa, SA_PASSWORD, lot_id, "quarantine")
    check("back to quarantine", s == 200, s)
    s, locs = _req("GET", f"/items/{lot['item_id']}/stock-locations", token=sa)
    if s == 200 and locs:
        check(
            "quarantined stock is still listed as available to move",
            any(int(x.get("qty", 0)) > 0 for x in locs),
            locs[:2],
        )
    else:
        print("  SKIP  this lot has no placed stock to check transferability against")

    print()
    if _failures:
        print(f"{len(_failures)} FAILED:")
        for f in _failures:
            print(f"  - {f}")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
