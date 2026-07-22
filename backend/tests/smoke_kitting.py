"""Ad-hoc smoke test for the kitting lifecycle.

Run against a running dev stack (from inside the backend container, or host if
:8000 is published):

    python backend/tests/smoke_kitting.py

Covers: create → issue → return excess → close-out (happy path), the ledger
movement types, the over-use guard, cancel (draft + post-issue), and the
close-out e-sign replay guard.

Reflects kitting03 (docs/modules/kitting-wip-build.md): issue MOVES material to
the production node, excess can be returned mid-production (TRX-008), and
cancelling an in-production kit returns everything.

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

# A well-stocked 2-child sub-assembly (qty_per_unit 1): both components have a
# single node holding far more than a small build needs, so the 2026-07-22 hard
# issue gate (issued ≥ need AND source holds ≥ need for EVERY line) is satisfied.
BUILT_ITEM_ID = "94f6f76d-b1e1-4a7b-88d9-ce094ae8259c"  # AS-TEST-001 (2-child BOM)
BOM_LINES = 2
# An UNstocked built item (AY-001, qty_per_unit 21, no component stock anywhere)
# — used to prove the hard gate blocks issuing a kit that can't be covered.
UNSTOCKED_ITEM_ID = "7537b141-efac-45e3-b129-fc67b0e26a79"  # AY-001
PROD_NODE_ID = "358ad8b4-3d13-484b-ac8f-bcb7ce8f075c"  # Clean Room 1 (production)
OUTPUT_SHELF_ID = "33068349-5206-45a1-a0a8-800772cf4e33"  # Shelf A

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


def _cancel(token, kit_id, lines=None, reason=None):
    """Cancel is e-signed (client 2026-07-22) — reauth for a kit.cancel evidence
    and post it with the request."""
    body = {"evidence_id": _reauth(token, "kit.cancel")}
    if reason is not None:
        body["reason"] = reason
    if lines is not None:
        body["lines"] = lines
    return _req("POST", f"/kits/{kit_id}/cancel", token=token, json_body=body)


def _create(token, qty=2, kit_number=None):
    # The kit name is operator-supplied now (it also names the produced lot),
    # so ask the API for a free suggestion unless the caller pins one.
    if kit_number is None:
        s, b = _req("GET", "/kits/next-number", token=token)
        assert s == 200, b
        kit_number = b["kit_number"]
    return _req(
        "POST",
        "/kits",
        token=token,
        json_body={
            "kit_number": kit_number,
            "item_id": BUILT_ITEM_ID,
            "target_qty": qty,
            "production_location_node_id": PROD_NODE_ID,
        },
    )


def _issue(token, kit, extra=0):
    """Issue a draft kit, pointing every line at a source that holds ENOUGH of
    the component. Under the 2026-07-22 hard gate a kit can only be issued when
    every line is fully covered — issued ≥ the BOM need AND the source holds ≥
    the need. ``extra`` issues a surplus above the need so there is something to
    return / reconcile (the return cap now forbids dropping below needed). The
    draft (issued qty + source) is committed in this one call."""
    lines = []
    for line in kit["lines"]:
        options = sorted(line["source_options"], key=lambda o: -o["qty"])
        best = options[0] if options else None
        entry = {
            "line_id": line["id"],
            "issued_qty": int(line["issued_qty"]) + extra,
            "source_location_node_id": best["node_id"] if best else None,
        }
        if best and best.get("is_grid"):
            # An LN2 box is picked cell by cell, and the quantity follows the
            # selection rather than being typed (kitting04 / D2).
            cells = best["cells"][: entry["issued_qty"]]
            entry["cell_allocation_ids"] = [c["allocation_id"] for c in cells]
            entry["issued_qty"] = len(cells)
        lines.append(entry)
    return _req("POST", f"/kits/{kit['id']}/issue", token=token, json_body={"lines": lines})


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
    check(f"{BOM_LINES} lines exploded from BOM", len(kit["lines"]) == BOM_LINES, len(kit["lines"]))
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
            "kit_number": "SMOKE-BAD-ITEM",
            "item_id": "00000000-0000-0000-0000-000000000000",
            "target_qty": 1,
            "production_location_node_id": PROD_NODE_ID,
        },
    )
    check(
        "unknown item -> 404 item_not_found", s == 404 and b.get("code") == "item_not_found", (s, b)
    )
    # The kit name is unique and operator-supplied; reusing a live one is a 409.
    s, dupe = _create(token, kit_number=kit["kit_number"])
    check(
        "duplicate kit name -> 409 kit_number_conflict",
        s == 409 and dupe.get("code") == "kit_number_conflict",
        (s, dupe),
    )
    # Names are reserved for life (cancelling does NOT free one), so derive a
    # fresh one per run rather than reusing a fixed literal.
    s, suggestion = _req("GET", "/kits/next-number", token=token)
    batch_name = f"SMOKE-{suggestion['kit_number']}"
    s, named = _create(token, kit_number=batch_name)
    check(
        "free-text kit name accepted",
        s == 201 and named["kit_number"] == batch_name,
        (s, named.get("kit_number")),
    )
    _cancel(token, named['id'])

    print("== hard gates (client 2026-07-22) ==")
    # (a) issued < needed on any line blocks the whole issue.
    s, gk = _create(token)
    low = []
    for i, line in enumerate(gk["lines"]):
        opts = sorted(line["source_options"], key=lambda o: -o["qty"])
        low.append(
            {
                "line_id": line["id"],
                # Starve line 1 below its need; the rest get a valid quantity.
                "issued_qty": 0 if i == 0 else int(line["issued_qty"]),
                "source_location_node_id": opts[0]["node_id"] if opts else None,
            }
        )
    s, b = _req("POST", f"/kits/{gk['id']}/issue", token=token, json_body={"lines": low})
    check(
        "issue below need -> 422 issued_below_need",
        s == 422 and b.get("code") == "issued_below_need",
        (s, b),
    )
    _cancel(token, gk['id'])

    # (b) source can't cover the need -> blocked, even at issued == needed.
    s, sug = _req("GET", "/kits/next-number", token=token)
    s, ak = _req(
        "POST",
        "/kits",
        token=token,
        json_body={
            "kit_number": f"SMOKE-SRC-{sug['kit_number']}",
            "item_id": UNSTOCKED_ITEM_ID,
            "target_qty": 1,
            "production_location_node_id": PROD_NODE_ID,
        },
    )
    check("create unstocked kit -> 201", s == 201, (s, ak))
    sb = [
        {
            "line_id": line["id"],
            "issued_qty": int(line["issued_qty"]),  # = ceil(need); passes the need check
            "source_location_node_id": OUTPUT_SHELF_ID,  # holds none of this component
        }
        for line in ak["lines"]
    ]
    s, b = _req("POST", f"/kits/{ak['id']}/issue", token=token, json_body={"lines": sb})
    check(
        "issue from empty source -> 422 source_below_need",
        s == 422 and b.get("code") == "source_below_need",
        (s, b),
    )
    _cancel(token, ak['id'])

    # (c) close-out claiming more output than the material issued could yield.
    s, yk = _create(token)
    s, yk = _issue(token, yk)
    check("yield-gate kit issued", s == 200, (s, yk))
    evy = _reauth(token, "kit.closeout")
    s, b = _req(
        "POST",
        f"/kits/{yk['id']}/close-out",
        token=token,
        json_body={
            "good_qty": 999,  # far more than issued/BOM could produce
            "scrap_qty": 0,
            "output_location_node_id": OUTPUT_SHELF_ID,
            "lines": [{"line_id": line["id"], "used_qty": 0} for line in yk["lines"]],
            "evidence_id": evy,
        },
    )
    check(
        "close-out beyond yield -> 422 issued_below_yield",
        s == 422 and b.get("code") == "issued_below_yield",
        (s, b),
    )
    _cancel(token, yk['id'], reason="gate test")

    # (d) return can't drop the floor below the need (Task 6). Issue a surplus,
    # then try to return more than the surplus.
    s, rk = _create(token)
    s, rk = _issue(token, rk, extra=2)  # need + 2 surplus per line
    check("return-gate kit issued", s == 200, (s, rk))
    rgl = rk["lines"][0]
    needed = int(round(float(rgl["needed_qty"])))
    s, b = _req(
        "POST",
        f"/kits/{rk['id']}/lines/{rgl['id']}/return",
        token=token,
        # on_floor = need + 2; returning need+2 would leave the floor at 0 < need.
        json_body={"qty": rgl["on_floor_qty"], "return_location_node_id": OUTPUT_SHELF_ID},
    )
    check(
        "return below need -> 422 return_below_need",
        s == 422 and b.get("code") == "return_below_need",
        (s, b),
    )
    # Returning exactly the surplus (2) is allowed — floor lands on the need.
    s, b = _req(
        "POST",
        f"/kits/{rk['id']}/lines/{rgl['id']}/return",
        token=token,
        json_body={"qty": rgl["on_floor_qty"] - needed, "return_location_node_id": OUTPUT_SHELF_ID},
    )
    check("return surplus down to need -> 200", s == 200, (s, b))

    # (e) close-out can't record used below the need (Task 5.1).
    ev_ub = _reauth(token, "kit.closeout")
    s, b = _req(
        "POST",
        f"/kits/{rk['id']}/close-out",
        token=token,
        json_body={
            "good_qty": 1,
            "scrap_qty": 0,
            "output_location_node_id": OUTPUT_SHELF_ID,
            "lines": [{"line_id": line["id"], "used_qty": 0} for line in rk["lines"]],
            "evidence_id": ev_ub,
        },
    )
    check(
        "used below need -> 422 used_below_need",
        s == 422 and b.get("code") == "used_below_need",
        (s, b),
    )
    _cancel(token, rk['id'], reason="gate test")

    print("== issue ==")
    # Issue a surplus (need + 3) so there is something to return / reconcile —
    # the return cap now forbids the floor dropping below the need.
    s, b = _issue(token, kit, extra=3)
    check("issue -> 200", s == 200, (s, b))
    check("status in_production", b.get("status") == "in_production", b.get("status"))
    kit = b  # issue commits the draft, so re-read the committed lines
    s, act = _req("GET", f"/kits/{kit_id}/activity", token=token)
    kit_issue_rows = [r for r in act["items"] if r["movement_type"] == "kit_issue"]
    # One row per LOT drawn (FIFO by expiry), so ≥ one per line that actually
    # issued. A component with no available stock issues nothing.
    issued_lines = sum(1 for line in kit["lines"] if line["issued_qty"] > 0)
    check(
        "activity has kit_issue rows",
        len(kit_issue_rows) >= issued_lines > 0,
        (len(kit_issue_rows), issued_lines),
    )
    check(
        "kit_issue deltas are negative",
        all(r["qty_delta"] < 0 for r in kit_issue_rows),
        kit_issue_rows,
    )
    # kitting03: the material MOVES to the production floor (Transaction_Spec §2).
    check(
        "kit_issue moves source -> production node",
        all(
            r["from_location_node_id"] and r["to_location_node_id"] == PROD_NODE_ID
            for r in kit_issue_rows
        ),
        [(r["from_location_node_id"], r["to_location_node_id"]) for r in kit_issue_rows],
    )
    check(
        "on_floor_qty == issued + additional",
        all(
            l["on_floor_qty"] == l["issued_qty"] + l["additional_issued_qty"] for l in kit["lines"]
        ),
        [(l["on_floor_qty"], l["issued_qty"]) for l in kit["lines"]],
    )

    print("== return excess (REQ-2026-07-01-TRX-008) ==")
    rline = next(line for line in kit["lines"] if line["on_floor_qty"] > 0)
    s, b = _req(
        "POST",
        f"/kits/{kit_id}/lines/{rline['id']}/return",
        token=token,
        json_body={
            "qty": 1,
            "return_location_node_id": OUTPUT_SHELF_ID,
            "reason": "over-pulled",
        },
    )
    check("return 1 -> 200", s == 200, (s, b))
    rl = next(x for x in b["lines"] if x["id"] == rline["id"])
    check("early_returned_qty == 1", rl["early_returned_qty"] == 1, rl["early_returned_qty"])
    check(
        "on_floor reduced by the return",
        rl["on_floor_qty"] == rline["on_floor_qty"] - 1,
        (rline["on_floor_qty"], rl["on_floor_qty"]),
    )
    s, b = _req(
        "POST",
        f"/kits/{kit_id}/lines/{rline['id']}/return",
        token=token,
        json_body={"qty": 999999, "return_location_node_id": OUTPUT_SHELF_ID},
    )
    check(
        "over-return -> 422 return_exceeds_on_floor",
        s == 422 and b.get("code") == "return_exceeds_on_floor",
        (s, b),
    )
    s, act_r = _req("GET", f"/kits/{kit_id}/activity", token=token)
    check(
        "manual return posts kit_return",
        any(r["movement_type"] == "kit_return" for r in act_r["items"]),
        [r["movement_type"] for r in act_r["items"]],
    )
    s, kit = _req("GET", f"/kits/{kit_id}", token=token)

    print("== close-out (happy path, leftover backflush) ==")
    lines = kit["lines"]
    # Reconcile against what is still ON THE FLOOR (net of the return above).
    body_lines = [
        {"line_id": l["id"], "used_qty": max(0, int(l["on_floor_qty"]) - 1)} for l in lines
    ]
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
    # used = on_floor − 1, so every line that had material back-flushes exactly 1.
    check(
        "returned_qty = 1 per issued line",
        all(l["returned_qty"] == 1 for l in b["lines"] if l["issued_qty"] > 0),
        [(l["issued_qty"], l["returned_qty"]) for l in b["lines"]],
    )
    s, act = _req("GET", f"/kits/{kit_id}/activity", token=token)
    types = [r["movement_type"] for r in act["items"]]
    check(
        "activity has production_output (+)",
        any(
            r["movement_type"] == "production_output" and r["qty_delta"] == 2 for r in act["items"]
        ),
        types,
    )
    # kitting05 — the three return events are now distinct types, so the
    # close-out rows are `backflush` ONLY; the mid-production return above is
    # `kit_return` and must not be counted here.
    check(
        "close-out posts backflush rows (+)",
        sum(1 for r in act["items"] if r["movement_type"] == "backflush") >= 1,
        types,
    )
    check(
        "the mid-production return stayed a separate type",
        any(r["movement_type"] == "kit_return" for r in act["items"])
        and not any(
            r["movement_type"] == "backflush" and "Returned" in (r["notes"] or "")
            for r in act["items"]
        ),
        types,
    )
    check(
        "returns move production -> return node",
        all(
            r["from_location_node_id"] == PROD_NODE_ID and r["to_location_node_id"]
            for r in act["items"]
            if r["movement_type"] in ("backflush", "kit_return")
        ),
        types,
    )
    # The audit-trail feed (full-snapshot events) must carry good/scrap — the
    # stock ledger above never records scrap (client 2026-07-22).
    events = act.get("events", [])
    check("activity exposes audit events", len(events) >= 1, len(events))
    close_ev = next((e for e in events if e.get("operation") == "close_out"), None)
    check(
        "close_out event carries good/scrap",
        close_ev is not None and close_ev["good_qty"] == 2 and close_ev["scrap_qty"] == 0,
        close_ev,
    )
    ops = {e.get("operation") for e in events}
    check(
        "activity logged create + issue + close_out",
        {"create", "issue", "close_out"} <= ops,
        ops,
    )

    print("== over-use guard ==")
    s, k2 = _create(token)
    s, k2 = _issue(token, k2)
    check("second kit issued", s == 200, (s, k2))
    over = [{"line_id": l["id"], "used_qty": int(l["on_floor_qty"]) + 5} for l in k2["lines"]]
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
            "lines": [
                {"line_id": l["id"], "used_qty": int(l["on_floor_qty"])} for l in k2["lines"]
            ],
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
            "lines": [
                {"line_id": l["id"], "used_qty": int(l["on_floor_qty"])} for l in k2["lines"]
            ],
            "evidence_id": ev_wrong,
        },
    )
    check(
        "wrong-action evidence -> 401 mismatch",
        s == 401 and b.get("code") == "reauth_evidence_action_mismatch",
        (s, b),
    )

    print("== cancel (draft + post-issue) ==")
    s, k3 = _create(token)
    s, b = _cancel(token, k3['id'])
    check("cancel draft -> 200 cancelled", s == 200 and b.get("status") == "cancelled", (s, b))
    s, act3 = _req("GET", f"/kits/{k3['id']}/activity", token=token)
    check("draft cancel writes no movements", len(act3["items"]) == 0, len(act3["items"]))

    # kitting03 resolves the deferred §99.8: cancelling an in-production kit is
    # now allowed and hands every unit on the floor back (TRX-008), so nothing
    # is stranded. k2 is in_production.
    s, b = _cancel(token, k2['id'], reason="abandoned")
    check(
        "cancel in-production -> 200 cancelled",
        s == 200 and b.get("status") == "cancelled",
        (s, b),
    )
    check(
        "post-issue cancel returns everything (on_floor == 0)",
        all(l["on_floor_qty"] == 0 for l in b["lines"]),
        [l["on_floor_qty"] for l in b["lines"]],
    )
    s, act2 = _req("GET", f"/kits/{k2['id']}/activity", token=token)
    # kitting05: a cancellation posts its own type, never `backflush` — the
    # ledger has to say the material came back because the kit was abandoned.
    check(
        "cancel posts kit_cancel_return (not backflush)",
        any(r["movement_type"] == "kit_cancel_return" for r in act2["items"])
        and not any(r["movement_type"] == "backflush" for r in act2["items"]),
        [r["movement_type"] for r in act2["items"]],
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
