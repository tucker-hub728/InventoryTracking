"""Ad-hoc smoke test: 422 responses say WHICH field and WHY.

Every dialog in the app renders ``ApiError.message``. That message used to be
the constant "Request payload failed validation." for every schema failure, so
a rename rejected for being 300 characters long told the operator only that
something, somewhere, was wrong — with the offending field still on screen in
front of them.

The handler now phrases the failure (``app/api/errors.py``), which fixes every
form at once rather than per dialog.

    SMOKE_EMAIL=admin.user@cellready.dev SMOKE_PASSWORD='DevAdmin_123!' \
        python backend/tests/smoke_validation_messages.py
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("SMOKE_BASE", "http://localhost:8000/v1")
EMAIL = os.environ.get("SMOKE_EMAIL", "admin.user@cellready.dev")
PASSWORD = os.environ.get("SMOKE_PASSWORD", "DevAdmin_123!")

STATS = {"passed": 0}
FAILED: list[str] = []


def check(label: str, cond: bool, detail: object = "") -> None:
    if cond:
        STATS["passed"] += 1
        print(f"  ok   {label}")
    else:
        FAILED.append(label)
        print(f"  FAIL {label}: {detail}")


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


def _login() -> str:
    s, b = _req("POST", "/auth/login", json_body={"email": EMAIL, "password": PASSWORD})
    assert s == 200, b
    return b["access_token"]


def main() -> int:
    token = _login()
    print("==> logged in")

    s, tree = _req("GET", "/location-nodes/ln2-tree", token=token)
    assert s == 200, tree
    node_id = tree[0]["id"] if tree else None
    if not node_id:
        print("!! no LN2 tank in dev to rename")
        return 1

    print("\n-- the case that prompted this: a name that is far too long")
    s, b = _req(
        "PATCH", f"/location-nodes/{node_id}", token=token, json_body={"name": "T90019SD " * 40}
    )
    msg = b.get("message", "")
    check("still a 422", s == 422, (s, b))
    check("no longer the generic sentence", "failed validation" not in msg, msg)
    check("names the field", "Name" in msg, msg)
    check("gives the limit", "128" in msg, msg)
    check("says what the rule is", "at most" in msg and "characters" in msg, msg)
    print(f"       → {msg}")

    print("\n-- a missing required field")
    s, b = _req("POST", "/location-nodes", token=token, json_body={"node_type": "rack"})
    msg = b.get("message", "")
    check("missing field reported as required", s == 422 and "required" in msg.lower(), (s, msg))
    print(f"       → {msg}")

    print("\n-- a blank name (our own trim validator, not a Pydantic constraint)")
    s, b = _req("PATCH", f"/location-nodes/{node_id}", token=token, json_body={"name": "   "})
    msg = b.get("message", "")
    check("custom validator text surfaces", s == 422 and len(msg) > 0, (s, msg))
    check("'Value error,' prefix stripped", "Value error" not in msg, msg)
    print(f"       → {msg}")

    print("\n-- a nested field inside a list (transfer sources)")
    s, b = _req(
        "POST",
        "/allocations/transfer-multi",
        token=token,
        json_body={
            "sources": [
                {
                    "node_id": node_id,
                    "lot_id": node_id,
                    "qty": -5,
                    "to_node_id": node_id,
                }
            ],
            "evidence_id": "x",
            "notes": "",
        },
    )
    msg = b.get("message", "")
    check("nested list field is located for the reader", s == 422 and "Qty" in msg, (s, msg))
    check("row number is 1-based", "Sources 1" in msg, msg)
    print(f"       → {msg}")

    print("\n-- the full error list is still there for debugging")
    check(
        "details.errors preserved",
        isinstance(b.get("details", {}).get("errors"), list),
        b.get("details"),
    )

    print(f"\n==> {STATS['passed']} passed, {len(FAILED)} failed")
    for f in FAILED:
        print(f"    - {f}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
