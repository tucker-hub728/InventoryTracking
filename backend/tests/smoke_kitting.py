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
OUTPUT_SHELF_B_ID = "30c3c9ab-318c-4126-b6e8-2f6699626693"  # Shelf B (split output)

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
    """Issue a draft kit covering ``needed + extra`` per line, filling across the
    component's lots FIFO (multi-source). Robust to fragmented dev stock — it
    gathers from as many lots as it takes, rather than one node."""
    lines = []
    for line in kit["lines"]:
        want = int(line["issued_qty"]) + extra
        picks, rem = [], want
        for lot in line["source_lots"]:
            if rem <= 0:
                break
            if lot.get("is_grid"):
                cell_ids = [c["allocation_id"] for c in lot["cells"][:rem]]
                if not cell_ids:
                    continue
                picks.append(
                    {
                        "node_id": lot["node_id"],
                        "lot_id": lot["lot_id"],
                        "qty": len(cell_ids),
                        "cell_allocation_ids": cell_ids,
                    }
                )
                rem -= len(cell_ids)
            else:
                take = min(rem, int(lot["qty"]))
                if take <= 0:
                    continue
                picks.append({"node_id": lot["node_id"], "lot_id": lot["lot_id"], "qty": take})
                rem -= take
        lines.append({"line_id": line["id"], "sources": picks})
    return _req("POST", f"/kits/{kit['id']}/issue", token=token, json_body={"lines": lines})


def _issue_multi(token, kit, extra=0):
    """Issue with the multi-source ``sources[]`` shape (KIT-003): for each line,
    cover the need FIFO across its ``source_lots``, splitting when one lot can't
    fully satisfy it. Exercises the per-lot pick path shared by issue and
    additional-issue."""
    lines = []
    for line in kit["lines"]:
        need = int(round(float(line["needed_qty"]))) + extra
        picks = []
        remaining = need
        for lot in line["source_lots"]:  # backend returns these FIFO-ordered
            if remaining <= 0:
                break
            if lot.get("is_grid"):
                cell_ids = [c["allocation_id"] for c in lot["cells"][:remaining]]
                if not cell_ids:
                    continue
                picks.append(
                    {
                        "node_id": lot["node_id"],
                        "lot_id": lot["lot_id"],
                        "qty": len(cell_ids),
                        "cell_allocation_ids": cell_ids,
                    }
                )
                remaining -= len(cell_ids)
            else:
                take = min(remaining, int(lot["qty"]))
                if take <= 0:
                    continue
                picks.append({"node_id": lot["node_id"], "lot_id": lot["lot_id"], "qty": take})
                remaining -= take
        lines.append({"line_id": line["id"], "sources": picks})
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

    print("== KIT-007: recipe gates removed, physical guards stay ==")
    # (a) A SHORT issue is now ALLOWED (no issued_below_need). Starve line 1 to 1.
    s, sk = _create(token)
    short = []
    for i, line in enumerate(sk["lines"]):
        opts = sorted(line["source_options"], key=lambda o: -o["qty"])
        short.append(
            {
                "line_id": line["id"],
                "issued_qty": 1 if i == 0 else int(line["issued_qty"]),
                "source_location_node_id": opts[0]["node_id"] if opts else None,
            }
        )
    s, b = _req("POST", f"/kits/{sk['id']}/issue", token=token, json_body={"lines": short})
    check(
        "short issue now allowed -> 200 in_production",
        s == 200 and b.get("status") == "in_production",
        (s, b),
    )
    _cancel(token, sk["id"], reason="kit007")

    # (b) PHYSICAL guard STAYS: you still can't pull from a source that holds none.
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
            "issued_qty": int(line["issued_qty"]),
            "source_location_node_id": OUTPUT_SHELF_ID,  # holds none of this component
        }
        for line in ak["lines"]
    ]
    s, b = _req("POST", f"/kits/{ak['id']}/issue", token=token, json_body={"lines": sb})
    check(
        "issue beyond available stock -> 422 insufficient_source_stock",
        s == 422 and b.get("code") == "insufficient_source_stock",
        (s, b),
    )
    _cancel(token, ak["id"])

    # (c) Used must be ≥ recipe need (client 2026-07-23): to make N you need N
    # units' worth. yk has need=2 on the floor (qty_per_unit 1, target 2).
    s, yk = _create(token)
    s, yk = _issue(token, yk)
    check("used-bound test kit issued", s == 200, (s, yk))
    s, b = _req(
        "POST",
        f"/kits/{yk['id']}/close-out",
        token=token,
        json_body={
            "good_qty": 5,  # needs 5 per line, but we only enter 2 used
            "scrap_qty": 0,
            "output_location_node_id": OUTPUT_SHELF_ID,
            "output_lot_number": f"{yk['kit_number']}-1",
            "lines": [{"line_id": ln["id"], "used_qty": 2} for ln in yk["lines"]],
            "evidence_id": _reauth(token, "kit.closeout"),
        },
    )
    check(
        "used below need -> 422 used_below_need",
        s == 422 and b.get("code") == "used_below_need",
        (s, b),
    )
    # Fits when used matches good's need (good=2 -> need 2, used 2 ≤ floor 2).
    s, b = _req(
        "POST",
        f"/kits/{yk['id']}/close-out",
        token=token,
        json_body={
            "good_qty": 2,
            "scrap_qty": 0,
            "output_location_node_id": OUTPUT_SHELF_ID,
            "output_lot_number": f"{yk['kit_number']}-1",
            "lines": [{"line_id": ln["id"], "used_qty": 2} for ln in yk["lines"]],
            "evidence_id": _reauth(token, "kit.closeout"),
        },
    )
    check("close good=2 used=2 -> 200 closed", s == 200 and b.get("status") == "closed", (s, b))

    # (d) Manual return (TRX-008) stays uncapped: hand back EVERYTHING on the floor.
    s, rk = _create(token)
    s, rk = _issue(token, rk, extra=2)
    check("return-test kit issued", s == 200, (s, rk))
    rgl = rk["lines"][0]
    s, b = _req(
        "POST",
        f"/kits/{rk['id']}/lines/{rgl['id']}/return",
        token=token,
        json_body={"qty": rgl["on_floor_qty"], "return_location_node_id": OUTPUT_SHELF_ID},
    )
    check("return all on-floor now allowed -> 200", s == 200, (s, b))
    rl = next(x for x in b["lines"] if x["id"] == rgl["id"])
    check("floor dropped to 0 after full return", rl["on_floor_qty"] == 0, rl["on_floor_qty"])

    # PHYSICAL guard STAYS: can't return more than is on the floor.
    s, b = _req(
        "POST",
        f"/kits/{rk['id']}/lines/{rgl['id']}/return",
        token=token,
        json_body={"qty": 999999, "return_location_node_id": OUTPUT_SHELF_ID},
    )
    check(
        "over-return -> 422 return_exceeds_on_floor",
        s == 422 and b.get("code") == "return_exceeds_on_floor",
        (s, b),
    )
    _cancel(token, rk["id"], reason="return test")

    # (e) Per-lot return (client 2026-07-24): the operator picks WHICH on-floor
    # lot to hand back and where (like issue), via ``sources[]``. Units keep their
    # origin lot.
    s, prk = _create(token)
    s, prk = _issue(token, prk, extra=2)
    check("per-lot-return kit issued", s == 200, (s, prk))
    prl = prk["lines"][0]
    check(
        "line exposes on_floor_lots",
        len(prl.get("on_floor_lots", [])) >= 1,
        prl.get("on_floor_lots"),
    )
    lot0 = prl["on_floor_lots"][0]
    s, b = _req(
        "POST",
        f"/kits/{prk['id']}/lines/{prl['id']}/return",
        token=token,
        json_body={
            "sources": [
                {"lot_id": lot0["lot_id"], "qty": 1, "return_location_node_id": OUTPUT_SHELF_ID}
            ],
            "reason": "per-lot",
        },
    )
    check("per-lot return -> 200", s == 200, (s, b))
    rl2 = next(x for x in b["lines"] if x["id"] == prl["id"])
    check(
        "per-lot return incremented early_returned",
        rl2["early_returned_qty"] == 1,
        rl2["early_returned_qty"],
    )
    after0 = next((lt for lt in rl2["on_floor_lots"] if lt["lot_id"] == lot0["lot_id"]), None)
    check(
        "picked lot's floor qty dropped by 1",
        (after0["qty"] if after0 else 0) == lot0["qty"] - 1,
        (lot0["qty"], after0),
    )
    s, b = _req(
        "POST",
        f"/kits/{prk['id']}/lines/{prl['id']}/return",
        token=token,
        json_body={
            "sources": [
                {"lot_id": lot0["lot_id"], "qty": 999999, "return_location_node_id": OUTPUT_SHELF_ID}
            ]
        },
    )
    check(
        "per-lot over-return -> 422",
        s == 422 and b.get("code") in ("return_exceeds_on_floor", "return_exceeds_lot_on_floor"),
        (s, b),
    )
    _cancel(token, prk["id"], reason="per-lot return test")

    print("== issue ==")
    # Re-fetch so source_lots are current (other kits moved stock since create),
    # then issue a surplus (need + 3) so there is leftover to back-flush.
    s, kit = _req("GET", f"/kits/{kit_id}", token=token)
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
    pre_floor = {l["id"]: int(l["on_floor_qty"]) for l in lines}
    # good=2, qty_per_unit=1 -> need 2 per line; enter used=2, the rest back-flushes.
    body_lines = [
        {"line_id": l["id"], "used_qty": 2, "return_location_node_id": OUTPUT_SHELF_ID}
        for l in lines
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
            "output_lot_number": f"{kit['kit_number']}-1",
            "lines": body_lines,
            "evidence_id": ev,
        },
    )
    check("close-out -> 200", s == 200, (s, b))
    check("status closed", b.get("status") == "closed", b.get("status"))
    check("good_qty 2", b.get("good_qty") == 2, b.get("good_qty"))
    # BOM-computed: 2 consumed per line, so each back-flushes (on_floor − 2).
    check(
        "returned_qty = on_floor − 2 per line",
        all(l["returned_qty"] == pre_floor[l["id"]] - 2 for l in b["lines"]),
        [(pre_floor[l["id"]], l["returned_qty"]) for l in b["lines"]],
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

    print("== capacity guard ==")
    s, k2 = _create(token)
    s, k2 = _issue(token, k2)
    check("second kit issued", s == 200, (s, k2))
    floor2 = int(k2["lines"][0]["on_floor_qty"])
    ev2 = _reauth(token, "kit.closeout")
    s, b = _req(
        "POST",
        f"/kits/{k2['id']}/close-out",
        token=token,
        json_body={
            "good_qty": floor2 + 5,  # needs floor+5 per line
            "scrap_qty": 0,
            "output_location_node_id": OUTPUT_SHELF_ID,
            "output_lot_number": f"{k2['kit_number']}-1",
            "lines": [{"line_id": ln["id"], "used_qty": floor2} for ln in k2["lines"]],
            "evidence_id": ev2,
        },
    )
    check(
        "close good beyond floor's worth -> 422 used_below_need",
        s == 422 and b.get("code") == "used_below_need",
        (s, b),
    )
    ev3 = _reauth(token, "kit.closeout")
    s, b = _req(
        "POST",
        f"/kits/{k2['id']}/close-out",
        token=token,
        json_body={
            "good_qty": 1,
            "scrap_qty": 0,
            "output_location_node_id": OUTPUT_SHELF_ID,
            "output_lot_number": f"{k2['kit_number']}-1",
            "lines": [{"line_id": ln["id"], "used_qty": floor2 + 5} for ln in k2["lines"]],
            "evidence_id": ev3,
        },
    )
    check(
        "used beyond floor -> 422 used_exceeds_issued",
        s == 422 and b.get("code") == "used_exceeds_issued",
        (s, b),
    )

    print("== e-sign guards ==")
    # good=1 used=1 fits, so validation passes and the evidence check runs. `ev`
    # was already consumed by the happy-path close.
    valid_lines = [{"line_id": ln["id"], "used_qty": 1} for ln in k2["lines"]]
    s, b = _req(
        "POST",
        f"/kits/{k2['id']}/close-out",
        token=token,
        json_body={
            "good_qty": 1,
            "scrap_qty": 0,
            "output_location_node_id": OUTPUT_SHELF_ID,
            "output_lot_number": f"{k2['kit_number']}-1",
            "lines": valid_lines,
            "evidence_id": ev,
        },
    )
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
            "output_lot_number": f"{k2['kit_number']}-1",
            "lines": valid_lines,
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

    print("== multi-source issue (KIT-003) ==")
    s, mk = _create(token)
    check("multi-source: source_lots present on lines", all(l.get("source_lots") for l in mk["lines"]), mk["lines"])
    s, mk = _issue_multi(token, mk)
    check("multi-source issue -> 200", s == 200, (s, mk))
    check("multi-source status in_production", mk.get("status") == "in_production", mk.get("status"))
    check(
        "multi-source issued >= needed per line",
        all(int(l["issued_qty"]) >= int(round(float(l["needed_qty"]))) for l in mk["lines"]),
        [(l["issued_qty"], l["needed_qty"]) for l in mk["lines"]],
    )
    check(
        "multi-source on_floor == issued + additional",
        all(l["on_floor_qty"] == l["issued_qty"] + l["additional_issued_qty"] for l in mk["lines"]),
        [(l["on_floor_qty"], l["issued_qty"]) for l in mk["lines"]],
    )
    s, act_m = _req("GET", f"/kits/{mk['id']}/activity", token=token)
    check(
        "multi-source posts kit_issue rows",
        sum(1 for r in act_m["items"] if r["movement_type"] == "kit_issue") >= 1,
        [r["movement_type"] for r in act_m["items"]],
    )
    # The post-issue snapshot (issued_from) must name the lot(s) each line pulled.
    check(
        "issued_from populated per issued line",
        all(len(l.get("issued_from") or []) >= 1 for l in mk["lines"] if l["issued_qty"] > 0),
        [(l["item_number"], l.get("issued_from")) for l in mk["lines"]],
    )
    # Additional issue via the same multi-source shape (KIT-004): pull 1 more of
    # line 1 from whatever lot currently holds it.
    ml = mk["lines"][0]
    src_lot = next((lot for lot in ml["source_lots"] if not lot.get("is_grid") and lot["qty"] > 0), None)
    if src_lot is not None:
        s, mk2 = _req(
            "POST",
            f"/kits/{mk['id']}/lines/{ml['id']}/additional-issue",
            token=token,
            json_body={
                "sources": [{"node_id": src_lot["node_id"], "lot_id": src_lot["lot_id"], "qty": 1}]
            },
        )
        check("multi-source additional issue -> 200", s == 200, (s, mk2))
        ml2 = next(x for x in mk2["lines"] if x["id"] == ml["id"])
        check(
            "additional issue incremented additional_issued_qty",
            ml2["additional_issued_qty"] == ml["additional_issued_qty"] + 1,
            (ml["additional_issued_qty"], ml2["additional_issued_qty"]),
        )
    _cancel(token, mk["id"], reason="multi-source smoke")

    print("== incremental produce (KIT-007) ==")
    s, pk = _create(token, qty=3)
    s, pk = _issue(token, pk)  # issue needed (3) per line
    check("produce-test kit issued", s == 200, (s, pk))
    evp = _reauth(token, "kit.produce")
    # Produce a batch of 2 — operator enters used=2 per line (need for 2). This
    # batch carries its OWN expiry; the close batch below gets a different one, to
    # prove per-batch lots keep independent shelf lives (client 2026-07-23).
    produce_exp = "2098-11-30"
    s, b = _req(
        "POST",
        f"/kits/{pk['id']}/produce",
        token=token,
        json_body={
            "good_qty": 2,
            "scrap_qty": 0,
            "output_location_node_id": OUTPUT_SHELF_ID,
            "output_expiration_date": produce_exp,
            "output_lot_number": f"{pk['kit_number']}-1",
            "lines": [{"line_id": ln["id"], "used_qty": 2} for ln in pk["lines"]],
            "evidence_id": evp,
        },
    )
    check("produce batch -> 200 still open", s == 200 and b.get("status") == "in_production", (s, b))
    check("good accumulated = 2", b.get("good_qty") == 2, b.get("good_qty"))
    check(
        "on_floor reduced to 1 (issued 3 − used 2)",
        all(l["on_floor_qty"] == 1 for l in b["lines"]),
        [l["on_floor_qty"] for l in b["lines"]],
    )
    # Used-bound guard: to make 2 you need used ≥ 2, but only 1 is left.
    evp2 = _reauth(token, "kit.produce")
    s, bad = _req(
        "POST",
        f"/kits/{pk['id']}/produce",
        token=token,
        json_body={
            "good_qty": 2,  # need 2 per line; enter used 1 (all that's left)
            "scrap_qty": 0,
            "output_location_node_id": OUTPUT_SHELF_ID,
            # A fresh, unused number so the lot check passes and we reach the
            # used_below_need guard (the request fails, so this lot is never minted).
            "output_lot_number": f"{pk['kit_number']}-x",
            "lines": [{"line_id": ln["id"], "used_qty": 1} for ln in b["lines"]],
            "evidence_id": evp2,
        },
    )
    check(
        "produce beyond floor's worth -> 422 used_below_need",
        s == 422 and bad.get("code") == "used_below_need",
        (s, bad),
    )
    # Close with a final batch of 1 (used 1 per line) → cumulative 3. A DIFFERENT
    # expiry than the produce batch above — each batch is its own lot with its own
    # shelf life (client 2026-07-23; REQ-2026-07-01-INV-008).
    close_exp = "2099-12-31"
    evc = _reauth(token, "kit.closeout")
    s, b = _req(
        "POST",
        f"/kits/{pk['id']}/close-out",
        token=token,
        json_body={
            "good_qty": 1,
            "scrap_qty": 0,
            "output_location_node_id": OUTPUT_SHELF_ID,
            "output_expiration_date": close_exp,
            "output_lot_number": f"{pk['kit_number']}-2",
            "lines": [{"line_id": ln["id"], "used_qty": 1} for ln in b["lines"]],
            "evidence_id": evc,
        },
    )
    check("close after produce -> 200 closed", s == 200 and b.get("status") == "closed", (s, b))
    check("cumulative good = 3 (2 batch + 1 close)", b.get("good_qty") == 3, b.get("good_qty"))
    # Two per-batch lots — each named by the OPERATOR-ENTERED output_lot_number
    # (client 2026-07-24; here f"{kit_number}-1"/"-2") — each carrying its OWN
    # expiry, NOT a single shared/last-wins value.
    s, lots = _req("GET", f"/lots?item_id={BUILT_ITEM_ID}&limit=500", token=token)
    b1 = next((lt for lt in lots if lt.get("lot_number") == f"{pk['kit_number']}-1"), None)
    b2 = next((lt for lt in lots if lt.get("lot_number") == f"{pk['kit_number']}-2"), None)
    check("produce batch minted the entered lot (…-1)", b1 is not None, [lt.get("lot_number") for lt in lots])
    check("close batch minted the entered lot (…-2)", b2 is not None, [lt.get("lot_number") for lt in lots])
    check(
        "per-batch lots keep independent expiries",
        b1 is not None
        and b2 is not None
        and b1.get("expiration_date") == produce_exp
        and b2.get("expiration_date") == close_exp,
        [(b1 or {}).get("expiration_date"), (b2 or {}).get("expiration_date")],
    )
    s, act_p = _req("GET", f"/kits/{pk['id']}/activity", token=token)
    ev_ops = {e.get("operation") for e in act_p.get("events", [])}
    check("activity logged produce + close_out", {"produce", "close_out"} <= ev_ops, ev_ops)
    # Each produce batch records what it CONSUMED (no stock movement backs it), so
    # the timeline can show partial-produce consumption, not just the close total.
    prod_ev = next((e for e in act_p.get("events", []) if e.get("operation") == "produce"), {})
    consumed = prod_ev.get("consumed") or []
    check(
        "produce event carries per-component consumed",
        len(consumed) == BOM_LINES and all(c.get("qty", 0) > 0 and c.get("item_number") for c in consumed),
        consumed,
    )

    print("== split output across locations (LN2/freezer/shelf overflow) ==")
    s, sk = _create(token, qty=3)
    s, sk = _issue(token, sk)  # issue 3 per line
    check("split-test kit issued", s == 200, (s, sk))
    # good=3 split across TWO shelves: 2 on Shelf A + 1 on Shelf B, one batch/lot.
    ev = _reauth(token, "kit.produce")
    s, b = _req(
        "POST",
        f"/kits/{sk['id']}/produce",
        token=token,
        json_body={
            "good_qty": 3,
            "scrap_qty": 0,
            "outputs": [
                {"location_node_id": OUTPUT_SHELF_ID, "qty": 2},
                {"location_node_id": OUTPUT_SHELF_B_ID, "qty": 1},
            ],
            "output_lot_number": f"{sk['kit_number']}-1",
            "lines": [{"line_id": ln["id"], "used_qty": 3} for ln in sk["lines"]],
            "evidence_id": ev,
        },
    )
    check("split produce -> 200", s == 200 and b.get("good_qty") == 3, (s, b))
    # The one batch lot must have allocations on BOTH shelves (2 + 1).
    s, lots = _req("GET", f"/lots?item_id={BUILT_ITEM_ID}&limit=500", token=token)
    blot = next((lt for lt in lots if lt.get("lot_number") == f"{sk['kit_number']}-1"), None)
    check("split batch minted one lot", blot is not None, [lt.get("lot_number") for lt in lots])
    s, alloc_a = _req("GET", f"/location-nodes/{OUTPUT_SHELF_ID}/allocations", token=token)
    s, alloc_b = _req("GET", f"/location-nodes/{OUTPUT_SHELF_B_ID}/allocations", token=token)
    on_a = sum(a["qty"] for a in alloc_a if blot and a.get("lot_id") == blot["id"])
    on_b = sum(a["qty"] for a in alloc_b if blot and a.get("lot_id") == blot["id"])
    check("split placed 2 on Shelf A", on_a == 2, on_a)
    check("split placed 1 on Shelf B", on_b == 1, on_b)
    # Quantities must sum to good — a short split is rejected.
    ev2 = _reauth(token, "kit.produce")
    s, bad = _req(
        "POST",
        f"/kits/{sk['id']}/produce",
        token=token,
        json_body={
            "good_qty": 3,
            "scrap_qty": 0,
            "outputs": [{"location_node_id": OUTPUT_SHELF_ID, "qty": 2}],
            "output_lot_number": f"{sk['kit_number']}-2",
            "lines": [{"line_id": ln["id"], "used_qty": 3} for ln in b["lines"]],
            "evidence_id": ev2,
        },
    )
    check("split qty mismatch -> 422", s == 422 and bad.get("code") == "output_qty_mismatch", (s, bad))
    # The same location twice is rejected (combine the quantities instead).
    ev3 = _reauth(token, "kit.produce")
    s, dup = _req(
        "POST",
        f"/kits/{sk['id']}/produce",
        token=token,
        json_body={
            "good_qty": 2,
            "scrap_qty": 0,
            "outputs": [
                {"location_node_id": OUTPUT_SHELF_ID, "qty": 1},
                {"location_node_id": OUTPUT_SHELF_ID, "qty": 1},
            ],
            "output_lot_number": f"{sk['kit_number']}-3",
            "lines": [{"line_id": ln["id"], "used_qty": 2} for ln in b["lines"]],
            "evidence_id": ev3,
        },
    )
    check("split duplicate node -> 422", s == 422 and dup.get("code") == "output_duplicate_node", (s, dup))
    _cancel(token, sk["id"], reason="split-output smoke")

    print("== operator-entered produced lot number (client 2026-07-24) ==")
    s, ck = _create(token, qty=3)
    s, ck = _issue(token, ck)  # issue needed (3) per line
    check("lotno-test kit issued", s == 200, (s, ck))
    custom_lot = f"SMOKE-LOTNO-{ck['kit_number']}"
    # (a) Producing with good ≥ 1 but no lot number is rejected.
    s, b = _req(
        "POST",
        f"/kits/{ck['id']}/produce",
        token=token,
        json_body={
            "good_qty": 2,
            "scrap_qty": 0,
            "output_location_node_id": OUTPUT_SHELF_ID,
            "lines": [{"line_id": ln["id"], "used_qty": 2} for ln in ck["lines"]],
            "evidence_id": _reauth(token, "kit.produce"),
        },
    )
    check(
        "produce without lot number -> 422 output_lot_number_required",
        s == 422 and b.get("code") == "output_lot_number_required",
        (s, b),
    )
    # (b) An operator-entered number is honored VERBATIM (not an auto suffix).
    s, b = _req(
        "POST",
        f"/kits/{ck['id']}/produce",
        token=token,
        json_body={
            "good_qty": 2,
            "scrap_qty": 0,
            "output_location_node_id": OUTPUT_SHELF_ID,
            "output_lot_number": custom_lot,
            "lines": [{"line_id": ln["id"], "used_qty": 2} for ln in ck["lines"]],
            "evidence_id": _reauth(token, "kit.produce"),
        },
    )
    check("produce with entered lot -> 200", s == 200 and b.get("good_qty") == 2, (s, b))
    s, lots = _req("GET", f"/lots?item_id={BUILT_ITEM_ID}&limit=500", token=token)
    check(
        "produced lot carries the entered number verbatim",
        any(lt.get("lot_number") == custom_lot for lt in lots),
        [lt.get("lot_number") for lt in lots][:20],
    )
    check(
        "no auto {kit_number}-N lot minted (auto scheme retired)",
        not any(lt.get("lot_number") == f"{ck['kit_number']}-1" for lt in lots),
        [lt.get("lot_number") for lt in lots][:20],
    )
    # (c) Reusing an existing lot number is rejected (global uniqueness).
    s, b = _req(
        "POST",
        f"/kits/{ck['id']}/produce",
        token=token,
        json_body={
            "good_qty": 1,
            "scrap_qty": 0,
            "output_location_node_id": OUTPUT_SHELF_ID,
            "output_lot_number": custom_lot,
            "lines": [{"line_id": ln["id"], "used_qty": 1} for ln in ck["lines"]],
            "evidence_id": _reauth(token, "kit.produce"),
        },
    )
    check(
        "duplicate lot number -> 422 output_lot_number_taken",
        s == 422 and b.get("code") == "output_lot_number_taken",
        (s, b),
    )
    # (d) A good=0 close needs NO lot number (nothing is minted) — cumulative good
    #     is already 2 from the produce above, so it just back-flushes and locks.
    s, b = _req(
        "POST",
        f"/kits/{ck['id']}/close-out",
        token=token,
        json_body={
            "good_qty": 0,
            "scrap_qty": 0,
            "lines": [{"line_id": ln["id"], "used_qty": 0} for ln in ck["lines"]],
            "evidence_id": _reauth(token, "kit.closeout"),
        },
    )
    check(
        "good=0 close without lot number -> 200 closed",
        s == 200 and b.get("status") == "closed",
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
