"""Ad-hoc smoke test for the kitting lifecycle.

Run against a running dev stack (from inside the backend container, or host if
:8000 is published):

    python backend/tests/smoke_kitting.py

Covers: create → issue → close-out (happy path), the ledger movement types,
the over-use guard, draft-only cancel, and the close-out e-sign replay guard.

The item / node ids below are dev-seed specific; if the dev DB is reset, update
them (a built item WITH a BOM, the PROD-CR1 node, an active shelf).
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

BASE = "http://localhost:8000/v1"
EMAIL = os.environ.get("SMOKE_EMAIL", "admin@cellready.local")
PASSWORD = os.environ.get("SMOKE_PASSWORD", "ChangeMe!Now123")

BUILT_ITEM_ID = "7537b141-efac-45e3-b129-fc67b0e26a79"  # AY-001 (4-child BOM)
PROD_NODE_ID = "358ad8b4-3d13-484b-ac8f-bcb7ce8f075c"  # PROD-CR1
OUTPUT_SHELF_ID = "33068349-5206-45a1-a0a8-800772cf4e33"  # WH1-A

# [passed, failed] — a list so ``check`` mutates without a ``global`` statement.
_TALLY = [0, 0]


def check(name: str, cond: bool, detail: object = "") -> None:
    if cond:
        _TALLY[0] += 1
        print(f"  PASS  {name}")
    else:
        _TALLY[1] += 1
        print(f"  FAIL  {name} — {detail}")


def _req(method, path, *, token=None, json_body=None):
    headers = {}
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
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return exc.code, json.loads(raw)
        except Exception:
            return exc.code, {"raw": raw.decode(errors="replace")}


def _login():
    s, b = _req("POST", "/auth/login", json_body={"email": EMAIL, "password": PASSWORD})
    assert s == 200, b
    return b["access_token"]


def _reauth(token, action):
    s, b = _req(
        "POST", "/auth/reauth", token=token, json_body={"action": action, "password": PASSWORD}
    )
    assert s == 200, b
    return b["evidence_id"]


def _create(token, qty=2):
    return _req(
        "POST",
        "/kits",
        token=token,
        json_body={
            "item_id": BUILT_ITEM_ID,
            "target_qty": qty,
            "production_location_node_id": PROD_NODE_ID,
        },
    )


def main() -> int:
    token = _login()

    print("== create ==")
    s, kit = _create(token)
    check("create kit -> 201", s == 201, (s, kit))
    if s != 201:
        print("Cannot proceed — update the dev ids at the top of this file.")
        return 1
    kit_id = kit["id"]
    check("status draft", kit["status"] == "draft", kit["status"])
    check("kit_number KIT-####", kit["kit_number"].startswith("KIT-"), kit["kit_number"])
    check("4 lines exploded from BOM", len(kit["lines"]) == 4, len(kit["lines"]))
    check(
        "each line has needed/issued",
        all(int(l["issued_qty"]) >= 1 for l in kit["lines"]),
        kit["lines"],
    )

    print("== create validation ==")
    s, b = _req(
        "POST",
        "/kits",
        token=token,
        json_body={
            "item_id": "00000000-0000-0000-0000-000000000000",
            "target_qty": 1,
            "production_location_node_id": PROD_NODE_ID,
        },
    )
    check(
        "unknown item -> 404 item_not_found", s == 404 and b.get("code") == "item_not_found", (s, b)
    )

    print("== issue ==")
    s, b = _req("POST", f"/kits/{kit_id}/issue", token=token)
    check("issue -> 200", s == 200, (s, b))
    check("status in_production", b.get("status") == "in_production", b.get("status"))
    s, act = _req("GET", f"/kits/{kit_id}/activity", token=token)
    kit_issue_rows = [r for r in act["items"] if r["movement_type"] == "kit_issue"]
    check("activity has kit_issue rows", len(kit_issue_rows) == 4, len(kit_issue_rows))
    check(
        "kit_issue deltas are negative",
        all(r["qty_delta"] < 0 for r in kit_issue_rows),
        kit_issue_rows,
    )

    print("== close-out (happy path, leftover backflush) ==")
    lines = kit["lines"]
    body_lines = [{"line_id": l["id"], "used_qty": max(0, int(l["issued_qty"]) - 1)} for l in lines]
    ev = _reauth(token, "kit.closeout")
    s, b = _req(
        "POST",
        f"/kits/{kit_id}/close-out",
        token=token,
        json_body={
            "good_qty": 2,
            "scrap_qty": 0,
            "output_location_node_id": OUTPUT_SHELF_ID,
            "lines": body_lines,
            "evidence_id": ev,
        },
    )
    check("close-out -> 200", s == 200, (s, b))
    check("status closed", b.get("status") == "closed", b.get("status"))
    check("good_qty 2", b.get("good_qty") == 2, b.get("good_qty"))
    check("returned_qty = 1 per line", all(l["returned_qty"] == 1 for l in b["lines"]), b["lines"])
    s, act = _req("GET", f"/kits/{kit_id}/activity", token=token)
    types = [r["movement_type"] for r in act["items"]]
    check(
        "activity has production_output (+)",
        any(
            r["movement_type"] == "production_output" and r["qty_delta"] == 2 for r in act["items"]
        ),
        types,
    )
    check(
        "activity has 4 backflush (+)",
        sum(1 for r in act["items"] if r["movement_type"] == "backflush") == 4,
        types,
    )

    print("== over-use guard ==")
    s, k2 = _create(token)
    _req("POST", f"/kits/{k2['id']}/issue", token=token)
    over = [{"line_id": l["id"], "used_qty": int(l["issued_qty"]) + 5} for l in k2["lines"]]
    ev2 = _reauth(token, "kit.closeout")
    s, b = _req(
        "POST",
        f"/kits/{k2['id']}/close-out",
        token=token,
        json_body={
            "good_qty": 1,
            "scrap_qty": 0,
            "output_location_node_id": OUTPUT_SHELF_ID,
            "lines": over,
            "evidence_id": ev2,
        },
    )
    check(
        "used > issued -> 422 used_exceeds_issued",
        s == 422 and b.get("code") == "used_exceeds_issued",
        (s, b),
    )

    print("== e-sign guards ==")
    s, b = _req(
        "POST",
        f"/kits/{k2['id']}/close-out",
        token=token,
        json_body={
            "good_qty": 1,
            "scrap_qty": 0,
            "output_location_node_id": OUTPUT_SHELF_ID,
            "lines": [{"line_id": l["id"], "used_qty": 0} for l in k2["lines"]],
            "evidence_id": ev,
        },
    )  # ev already consumed by the first close-out
    check(
        "replayed evidence -> 401 replayed",
        s == 401 and b.get("code") == "reauth_evidence_replayed",
        (s, b),
    )
    ev_wrong = _reauth(token, "movement.receipt")  # wrong action
    s, b = _req(
        "POST",
        f"/kits/{k2['id']}/close-out",
        token=token,
        json_body={
            "good_qty": 1,
            "scrap_qty": 0,
            "output_location_node_id": OUTPUT_SHELF_ID,
            "lines": [{"line_id": l["id"], "used_qty": 0} for l in k2["lines"]],
            "evidence_id": ev_wrong,
        },
    )
    check(
        "wrong-action evidence -> 401 mismatch",
        s == 401 and b.get("code") == "reauth_evidence_action_mismatch",
        (s, b),
    )

    print("== cancel (draft-only) ==")
    s, k3 = _create(token)
    s, b = _req("POST", f"/kits/{k3['id']}/cancel", token=token, json_body={})
    check("cancel draft -> 200 cancelled", s == 200 and b.get("status") == "cancelled", (s, b))
    # k2 is in_production → cancel must be rejected.
    s, b = _req("POST", f"/kits/{k2['id']}/cancel", token=token, json_body={})
    check(
        "cancel non-draft -> 422 draft_only",
        s == 422 and b.get("code") == "cancel_draft_only",
        (s, b),
    )

    print("== list + filter ==")
    s, b = _req("GET", "/kits?status=closed", token=token)
    check(
        "list closed -> 200, includes our kit",
        s == 200 and any(k["id"] == kit_id for k in b["items"]),
        s,
    )

    passed, failed = _TALLY
    print(f"\n{'ALL PASSED' if failed == 0 else str(failed) + ' FAILED'}  ({passed} passed)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
