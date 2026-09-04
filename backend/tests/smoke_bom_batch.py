"""Ad-hoc smoke test for the batched, single-signature BOM save.

Run from the project root after ``docker compose up``:

    SMOKE_EMAIL=you@example SMOKE_PASSWORD='…' \
        python backend/tests/smoke_bom_batch.py

Verifies (client decision 2026-07-28):
  * several lines are added under ONE signature (POST /items/{id}/bom/batch)
  * adds + re-quantify + remove commit together in one call
  * a save that would leave exactly ONE line is refused (422 bom_min_lines)
  * clearing the bill to zero lines IS allowed
  * an empty batch is refused (422 no_changes)
  * an invalid line rolls the whole batch back (nothing half-saved)
  * a finished good / consumable is still refused as a component
  * the signature is single-use (replay rejected) and action-bound
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

from _smoke_creds import require_credentials

BASE = "http://localhost:8000/v1"
EMAIL, PASSWORD = require_credentials()

SAVE_ACTION = "bom.save"

# [passed] — a list so ``check`` mutates without a ``global`` statement (same
# shape as smoke_kitting.py's _TALLY).
_PASSED = [0]
FAILS: list[str] = []


def check(label: str, condition: bool, detail: object = "") -> None:
    if condition:
        _PASSED[0] += 1
        print(f"  PASS  {label}")
    else:
        FAILS.append(label)
        print(f"  FAIL  {label}  {detail}")


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


def _reauth(token: str, action: str = SAVE_ACTION) -> str:
    s, b = _req(
        "POST", "/auth/reauth", token=token, json_body={"action": action, "password": PASSWORD}
    )
    assert s == 200, b
    return b["evidence_id"]


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


def _bom(token: str, item_id: str) -> list[dict]:
    s, b = _req("GET", f"/items/{item_id}/bom", token=token)
    assert s == 200, b
    return b["lines"]


def _save(token: str, item_id: str, *, adds=None, updates=None, deletes=None, action=SAVE_ACTION):
    payload = {
        "adds": adds or [],
        "updates": updates or [],
        "deletes": deletes or [],
        "evidence_id": _reauth(token, action),
        "reason": "smoke",
    }
    return _req("POST", f"/items/{item_id}/bom/batch", token=token, json_body=payload)


def main() -> int:
    token = _login()

    s, b = _req("GET", "/items?limit=200", token=token)
    assert s == 200, b
    items = b["items"]
    built = [i for i in items if i["tier_type"] in ("finished_good", "sub_assembly")]
    eligible = [i for i in items if i["tier_type"] != "finished_good" and not i["is_consumable"]]
    fgs = [i for i in items if i["tier_type"] == "finished_good"]
    consumables = [i for i in items if i["is_consumable"]]

    # Pick a built item whose BOM is empty so the smoke test doesn't disturb a
    # real bill, and three components it doesn't already use.
    parent = None
    for cand in built:
        if not _bom(token, cand["id"]):
            parent = cand
            break
    if parent is None:
        print("No built item with an empty BOM — cannot run non-destructively.")
        return 2
    comps = [i for i in eligible if i["id"] != parent["id"]][:3]
    if len(comps) < 3:
        print("Need at least 3 eligible components in the catalogue.")
        return 2

    print(f"\nParent: {parent['item_number']}  ({parent['tier_type']})")
    print(f"Components: {', '.join(c['item_number'] for c in comps)}\n")

    # 1. An empty batch is a no-op error, not a silent success.
    s, b = _save(token, parent["id"])
    check("empty batch rejected", s == 422 and _code(b) == "no_changes", (s, b))

    # 2. One line alone can't stand as a bill.
    s, b = _save(
        token,
        parent["id"],
        adds=[{"child_item_id": comps[0]["id"], "qty_per_unit": 2}],
    )
    check("single-line save rejected", s == 422 and _code(b) == "bom_min_lines", (s, b))
    check("nothing was written", _bom(token, parent["id"]) == [], "BOM not empty")

    # 3. Two lines, one signature.
    s, b = _save(
        token,
        parent["id"],
        adds=[
            {"child_item_id": comps[0]["id"], "qty_per_unit": 2},
            {"child_item_id": comps[1]["id"], "qty_per_unit": 5},
        ],
    )
    check("two lines saved under one signature", s == 200 and b.get("added") == 2, (s, b))
    lines = _bom(token, parent["id"])
    check("both lines persisted", len(lines) == 2, len(lines))
    qty_by_child = {ln["child_item_id"]: float(ln["qty_per_unit"]) for ln in lines}
    check("quantities stored", qty_by_child.get(comps[0]["id"]) == 2.0, qty_by_child)

    # 4. An invalid line rolls the whole batch back.
    line0 = next(ln for ln in lines if ln["child_item_id"] == comps[0]["id"])
    bad_child = fgs[0]["id"] if fgs else None
    if bad_child:
        s, b = _save(
            token,
            parent["id"],
            adds=[
                {"child_item_id": comps[2]["id"], "qty_per_unit": 1},
                {"child_item_id": bad_child, "qty_per_unit": 1},
            ],
            updates=[{"line_id": line0["id"], "qty_per_unit": 99}],
        )
        check(
            "finished good refused as component",
            s == 409 and _code(b) == "child_finished_good",
            (s, b),
        )
        after = _bom(token, parent["id"])
        check("bad batch rolled back — still 2 lines", len(after) == 2, len(after))
        check(
            "bad batch rolled back — qty untouched",
            float(next(ln for ln in after if ln["id"] == line0["id"])["qty_per_unit"]) == 2.0,
            after,
        )
    else:
        print("  SKIP  no finished good in catalogue for the rollback check")

    if consumables:
        s, b = _save(
            token,
            parent["id"],
            adds=[
                {"child_item_id": comps[2]["id"], "qty_per_unit": 1},
                {"child_item_id": consumables[0]["id"], "qty_per_unit": 1},
            ],
        )
        check(
            "consumable refused as component", s == 409 and _code(b) == "child_consumable", (s, b)
        )
    else:
        print("  SKIP  no consumable in catalogue")

    # 5. Add + re-quantify + remove, all in one signed call.
    line1 = next(ln for ln in lines if ln["child_item_id"] == comps[1]["id"])
    s, b = _save(
        token,
        parent["id"],
        adds=[{"child_item_id": comps[2]["id"], "qty_per_unit": 7}],
        updates=[{"line_id": line0["id"], "qty_per_unit": 4}],
        deletes=[line1["id"]],
    )
    check(
        "mixed batch applied",
        s == 200 and (b.get("added"), b.get("updated"), b.get("deleted")) == (1, 1, 1),
        (s, b),
    )
    lines = _bom(token, parent["id"])
    by_child = {ln["child_item_id"]: ln for ln in lines}
    check("still 2 lines after mixed batch", len(lines) == 2, len(lines))
    check("re-quantify applied", float(by_child[comps[0]["id"]]["qty_per_unit"]) == 4.0, lines)
    check("removal applied", comps[1]["id"] not in by_child, lines)
    check("addition applied", comps[2]["id"] in by_child, lines)

    # 6. Removing down to exactly one line is refused.
    s, b = _save(token, parent["id"], deletes=[by_child[comps[0]["id"]]["id"]])
    check("delete down to one rejected", s == 422 and _code(b) == "bom_min_lines", (s, b))
    check("BOM unchanged after refusal", len(_bom(token, parent["id"])) == 2, "changed")

    # 7. A line can't be both changed and removed.
    keep = by_child[comps[0]["id"]]["id"]
    s, b = _save(
        token,
        parent["id"],
        updates=[{"line_id": keep, "qty_per_unit": 3}],
        deletes=[keep],
    )
    check(
        "same line changed + removed rejected",
        s == 422 and _code(b) == "duplicate_line_change",
        (s, b),
    )

    # 8. Evidence is action-bound and single-use.
    s, b = _save(
        token,
        parent["id"],
        adds=[{"child_item_id": comps[1]["id"], "qty_per_unit": 1}],
        deletes=[keep],
        action="bom.create",
    )
    check("wrong-action evidence rejected", s == 401, (s, b))

    evidence = _reauth(token)
    body = {
        "adds": [],
        "updates": [{"line_id": keep, "qty_per_unit": 6}],
        "deletes": [],
        "evidence_id": evidence,
        "reason": "smoke replay",
    }
    s, b = _req("POST", f"/items/{parent['id']}/bom/batch", token=token, json_body=body)
    check("single re-quantify on an existing bill allowed", s == 200, (s, b))
    s, b = _req("POST", f"/items/{parent['id']}/bom/batch", token=token, json_body=body)
    check("signature replay rejected", s == 401, (s, b))

    # 9. Clearing the whole bill to zero is allowed.
    lines = _bom(token, parent["id"])
    s, b = _save(token, parent["id"], deletes=[ln["id"] for ln in lines])
    check("clearing the whole BOM allowed", s == 200 and b.get("deleted") == len(lines), (s, b))
    check("BOM is empty again", _bom(token, parent["id"]) == [], "not empty")

    print(f"\n{_PASSED[0]} passed, {len(FAILS)} failed")
    for f in FAILS:
        print(f"  - {f}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
