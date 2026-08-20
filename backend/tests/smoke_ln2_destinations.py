"""Ad-hoc smoke test: permitted destinations for a transfer OUT of LN2.

REQ-2026-08-13-LOC-003 (SRS Consolidated Amendment 9+10, rev. 2026-08-18): a
transfer out of liquid-nitrogen storage is constrained to a defined set of
destinations — "another LN2 location; a production room ...; and customer
shipment" — and "transfer to an unlisted or ambient destination (such as a
general warehouse shelf) shall remain blocked to preserve cold-chain integrity".

Only the FIRST of those three is a transfer, which is why this file asserts one
permitted transfer destination and not three:

  * a production room is reached by the KITTING ISSUE flow (a production area is
    a ``flat`` node and cannot hold an allocation at all), and
  * a customer shipment is ``POST /shipments``, which posts a movement with no
    destination node.

Both already accept an LN2 box as their source and are deliberately untouched —
this script proves the second of them still works (see "not a transfer" below),
so that a future guard placed in the shared drain cannot break it unnoticed.

No migration — this exercises code only.

Run from the project root after ``docker compose up``:

    SMOKE_EMAIL=admin.user@cellready.dev SMOKE_PASSWORD='DevAdmin_123!' \
        python backend/tests/smoke_ln2_destinations.py

or, with no Python on the host:

    docker exec cellready-backend python tests/smoke_ln2_destinations.py

Verifies:
  * BLOCKED with code ``transfer_blocked_cold_chain`` — LN2 box → an ambient
    warehouse shelf (the requirement's own example), on all three endpoints
    ``/transfer``, ``/transfer-batch`` and ``/transfer-multi``
  * BLOCKED — LN2 box → a Cold Storage unit (−20/−80). A freezer is not LN2, not
    a production room and not a customer, so it is "unlisted"; the requirement
    blocks "unlisted OR ambient", not merely ambient. Client-confirmed
    2026-08-20 as the literal reading. This is the ONLY case where the two
    readings differ, so it is asserted explicitly rather than left implied.
  * the refusal names the actions that DO reach the other permitted
    destinations, so an operator who picked the wrong action is redirected
  * PERMITTED — LN2 box → another LN2 box
  * PERMITTED — vials rearranged between cells of the SAME box. The rule is
    keyed on destination TYPE, not on "another node": ``/transfer-batch`` has no
    same-node guard and the LN2 page offers the current box as a destination, so
    a literal reading of the word "another" would destroy the only way to
    reorganise a box. Regression guard.
  * UNAFFECTED — a non-LN2 source (a freezer unit) may still transfer to an
    ambient shelf. The rule constrains transfers OUT of LN2 only.
  * UNAFFECTED — moves INTO an LN2 box still work. The requirement is
    one-directional; a symmetric reading would break receipt put-away and kit
    back-flush of leftovers.
  * PER LEG, not per request — one multi-source signature carrying an LN2 leg
    and a shelf leg is refused for the LN2 leg and names it ("Source N: ...")
  * NOT A TRANSFER, so untouched — a material issue (debit-and-gone) still
    draws from an LN2 box, proving the guard did not leak into the shared drain
    ``loc_repo.draw_lot_at_node``, which transfer-multi shares with issue and
    customer shipment. Issue is a real 4th exit from a box that LOC-003 does not
    mention; leaving it legal is the client's 2026-08-20 decision, RAISED as a
    gap. If they extend the rule, this check flips to a blocked case.

NOTE — this script MOVES REAL STOCK in the dev database, like every other smoke
here. It is idempotent: it reuses the vials it previously parked in a box rather
than seeding more. Be aware that seeding is a ONE-WAY trip by design — once
units are in a box, LOC-003 is exactly what stops this script putting them back
in the freezer. It moves ``SEED_UNITS`` vials the first time it runs.
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
TRANSFER_ACTION = "movement.transfer"
ISSUE_ACTION = "movement.material_issue"

#: Vials parked in the LN2 box the first time this runs. Kept tiny: the rule
#: under test is what prevents moving them back out to the freezer.
SEED_UNITS = 4

#: The refusal LOC-003 introduces. Deliberately NOT ``node_not_storable``: that
#: code means "you picked a location, not a storage place" and its message tells
#: the operator to pick the shelf inside — exactly the wrong advice here. It is
#: also the code smoke_material_issue.py asserts to prove the Issue and Transfer
#: destination sets are disjoint, and reusing it would destroy that proof.
COLD_CHAIN_CODE = "transfer_blocked_cold_chain"

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


def _sign(token: str, action: str = TRANSFER_ACTION) -> str:
    s, b = _req(
        "POST", "/auth/reauth", token=token, json_body={"action": action, "password": PASSWORD}
    )
    assert s == 200, b
    return b["evidence_id"]


def _code(body: object) -> str:
    """The ValidationError code out of an error envelope, however it is nested."""
    if isinstance(body, dict):
        for key in ("code", "detail", "error"):
            v = body.get(key)
            if isinstance(v, str) and key == "code":
                return v
            if isinstance(v, dict):
                inner = _code(v)
                if inner:
                    return inner
    return ""


def _message(body: object) -> str:
    if isinstance(body, dict):
        for key in ("message", "detail", "error"):
            v = body.get(key)
            if isinstance(v, str):
                return v
            if isinstance(v, dict):
                inner = _message(v)
                if inner:
                    return inner
    return json.dumps(body)


def _stock(token: str, item_id: str) -> list[dict]:
    s, b = _req("GET", f"/items/{item_id}/stock-locations", token=token)
    assert s == 200, b
    return b  # type: ignore[return-value]


def _all_stock(token: str) -> list[tuple[str, dict]]:
    """Every (item_id, stock row) in the system, so the script can find its own
    fixtures instead of hard-coding ids that differ per environment."""
    s, b = _req("GET", "/items?limit=200", token=token)
    assert s == 200, b
    items = b.get("items", b) if isinstance(b, dict) else b
    rows: list[tuple[str, dict]] = []
    for it in items:
        for r in _stock(token, it["id"]):
            rows.append((it["id"], r))
    return rows


def _node(token: str, node_id: str) -> dict:
    s, b = _req("GET", f"/location-nodes/{node_id}", token=token)
    assert s == 200, b
    return b


def _free_cells(row: dict, want: int, *, avoid: set[tuple[int, int]] = frozenset()) -> list[dict]:
    """``want`` empty (row, col) coordinates in a box, as transfer payload cells."""
    taken = {(c["grid_row"], c["grid_col"]) for c in row.get("cells", [])} | set(avoid)
    out = []
    for r in range(1, (row.get("grid_rows") or 0) + 1):
        for c in range(1, (row.get("grid_cols") or 0) + 1):
            if (r, c) not in taken:
                out.append({"grid_row": r, "grid_col": c})
                if len(out) == want:
                    return out
    return out


def main() -> int:
    token = _login()
    print("\n== discover fixtures ==")

    s, targets = _req("GET", "/location-nodes/storage-targets", token=token)
    assert s == 200, targets
    boxes = [n for n in targets if n["node_type"] == "box"]
    subs = [n for n in targets if n["node_type"] == "sub_location"]
    check("at least two LN2 boxes exist", len(boxes) >= 2, [n["code"] for n in boxes])

    # An ambient shelf and a cold unit are BOTH ``sub_location`` — the Storage
    # template models a warehouse shelf as a unit under a shelf-KIND group, not
    # as the retired ``shelf`` node type. The parent group's code is the only
    # thing that tells them apart (SHF vs FRZ/REF); temperature is deliberately
    # not modelled on a node.
    ambient, cold = None, None
    for n in subs:
        parent = _node(token, n["parent_id"]) if n.get("parent_id") else {}
        base = (parent.get("code") or "").split("-")[0]
        if base == "SHF" and ambient is None:
            ambient = (n, parent)
        elif base in ("FRZ", "REF") and cold is None:
            cold = (n, parent)
    check("an ambient warehouse shelf exists", ambient is not None, [n["code"] for n in subs])
    check("a cold-storage unit exists", cold is not None, [n["code"] for n in subs])
    if not (len(boxes) >= 2 and ambient and cold):
        print("\nFixtures missing — cannot run. Seed a Storage location with a")
        print("shelf group and a freezer group, and two LN2 boxes, then re-run.")
        return 1
    box_a, box_b = boxes[0], boxes[1]
    shelf_node, shelf_group = ambient
    cold_node, cold_group = cold
    print(f"  box A      : {box_a['code']}")
    print(f"  box B      : {box_b['code']}")
    print(f"  ambient    : {shelf_group['name']} › {shelf_node['name']}")
    print(f"  cold       : {cold_group['name']} › {cold_node['name']}")

    print("\n== seed: a move INTO LN2 is unaffected by LOC-003 ==")
    rows = _all_stock(token)
    in_box_a = [(i, r) for i, r in rows if r["node_id"] == box_a["id"] and r["qty"] > 0]
    if in_box_a:
        item_id, box_row = in_box_a[0]
        print(f"  reusing {box_row['qty']} unit(s) already in {box_a['code']}")
        check("seeding is idempotent (reused existing LN2 stock)", True)
    else:
        seed_src = next(
            (
                (i, r)
                for i, r in rows
                if not r["is_grid"] and r["qty"] >= SEED_UNITS and r["node_id"] != box_a["id"]
            ),
            None,
        )
        if seed_src is None:
            print("  no non-LN2 stock to seed from — cannot run")
            return 1
        item_id, src_row = seed_src
        box_meta = _node(token, box_a["id"])
        cells = _free_cells(
            {"cells": [], "grid_rows": box_meta["grid_rows"], "grid_cols": box_meta["grid_cols"]},
            SEED_UNITS,
        )
        s, b = _req(
            "POST",
            "/allocations/transfer-multi",
            token=token,
            json_body={
                "sources": [
                    {
                        "node_id": src_row["node_id"],
                        "lot_id": src_row["lot_id"],
                        "qty": SEED_UNITS,
                        "to_node_id": box_a["id"],
                        "to_cells": cells,
                    }
                ],
                "evidence_id": _sign(token),
                "notes": "LOC-003 smoke: seed LN2 stock",
            },
        )
        check("freezer unit → LN2 box is permitted (into LN2 is unaffected)", s == 201, b)
        if s != 201:
            return 1
        box_row = next(r for _i, r in _all_stock(token) if r["node_id"] == box_a["id"])

    box_row = next(r for i, r in _all_stock(token) if r["node_id"] == box_a["id"] and i == item_id)
    check("the LN2 box reports a grid", box_row["is_grid"] is True, box_row)
    cells_in_a = sorted(box_row["cells"], key=lambda c: (c["grid_row"], c["grid_col"]))
    check("the LN2 box holds vials to move", len(cells_in_a) >= 2, len(cells_in_a))
    if len(cells_in_a) < 2:
        return 1

    def blocked(label, path, body):
        s, b = _req("POST", path, token=token, json_body=body)
        ok = s == 422 and _code(b) == COLD_CHAIN_CODE
        check(label, ok, f"{s} {b}")
        return b

    print("\n== BLOCKED: out of LN2 to an unlisted or ambient destination ==")
    one = cells_in_a[0]
    b = blocked(
        "/transfer      LN2 box → ambient warehouse shelf",
        "/allocations/transfer",
        {
            "allocation_id": one["allocation_id"],
            "to_node_id": shelf_node["id"],
            "qty": 1,
            "evidence_id": _sign(token),
        },
    )
    msg = _message(b)
    check("the refusal names the shelf", shelf_node["name"] in msg, msg)
    check("the refusal redirects to Issue (production room)", "Issue" in msg, msg)
    check("the refusal redirects to Ship (customer shipment)", "Ship" in msg, msg)

    blocked(
        "/transfer-batch LN2 box → ambient warehouse shelf",
        "/allocations/transfer-batch",
        {
            "allocation_ids": [one["allocation_id"]],
            "to_node_id": shelf_node["id"],
            "qty": 1,
            "evidence_id": _sign(token),
        },
    )
    blocked(
        "/transfer-multi LN2 box → ambient warehouse shelf",
        "/allocations/transfer-multi",
        {
            "sources": [
                {
                    "node_id": box_a["id"],
                    "lot_id": box_row["lot_id"],
                    "qty": 1,
                    "to_node_id": shelf_node["id"],
                    "cell_allocation_ids": [one["allocation_id"]],
                }
            ],
            "evidence_id": _sign(token),
        },
    )
    blocked(
        "/transfer      LN2 box → cold storage unit (unlisted, not ambient)",
        "/allocations/transfer",
        {
            "allocation_id": one["allocation_id"],
            "to_node_id": cold_node["id"],
            "qty": 1,
            "evidence_id": _sign(token),
        },
    )

    print("\n== PERMITTED: another LN2 location ==")
    box_b_meta = _node(token, box_b["id"])
    b_rows = [r for _i, r in _all_stock(token) if r["node_id"] == box_b["id"]]
    b_taken = {(c["grid_row"], c["grid_col"]) for r in b_rows for c in r.get("cells", [])}
    dest_b = _free_cells(
        {"cells": [], "grid_rows": box_b_meta["grid_rows"], "grid_cols": box_b_meta["grid_cols"]},
        1,
        avoid=b_taken,
    )
    s, b = _req(
        "POST",
        "/allocations/transfer",
        token=token,
        json_body={
            "allocation_id": one["allocation_id"],
            "to_node_id": box_b["id"],
            "qty": 1,
            "to_grid_row": dest_b[0]["grid_row"],
            "to_grid_col": dest_b[0]["grid_col"],
            "evidence_id": _sign(token),
        },
    )
    check("LN2 box → another LN2 box is permitted", s == 201, b)

    print("\n== PERMITTED: rearranging vials inside ONE box ==")
    # The requirement says "another LN2 location". Keying the rule on that word
    # would block this — the only way to reorganise a box.
    still = [c for c in cells_in_a if c["allocation_id"] != one["allocation_id"]]
    a_meta = _node(token, box_a["id"])
    fresh_a = next(r for _i, r in _all_stock(token) if r["node_id"] == box_a["id"])
    free_a = _free_cells(
        {
            "cells": fresh_a.get("cells", []),
            "grid_rows": a_meta["grid_rows"],
            "grid_cols": a_meta["grid_cols"],
        },
        1,
    )
    s, b = _req(
        "POST",
        "/allocations/transfer",
        token=token,
        json_body={
            "allocation_id": still[0]["allocation_id"],
            "to_node_id": box_a["id"],
            "qty": 1,
            "to_grid_row": free_a[0]["grid_row"],
            "to_grid_col": free_a[0]["grid_col"],
            "evidence_id": _sign(token),
        },
    )
    check("cell → cell inside the same box is permitted", s == 201, b)

    print("\n== UNAFFECTED: a non-LN2 source ==")
    non_ln2 = next(
        (
            (i, r)
            for i, r in _all_stock(token)
            if not r["is_grid"] and r["qty"] >= 1 and r["node_id"] != shelf_node["id"]
        ),
        None,
    )
    if non_ln2 is None:
        check("a non-LN2 source exists to test with", False)
    else:
        _i, src = non_ln2
        s, b = _req(
            "POST",
            "/allocations/transfer-multi",
            token=token,
            json_body={
                "sources": [
                    {
                        "node_id": src["node_id"],
                        "lot_id": src["lot_id"],
                        "qty": 1,
                        "to_node_id": shelf_node["id"],
                    }
                ],
                "evidence_id": _sign(token),
                "notes": "LOC-003 smoke: non-LN2 source is not governed",
            },
        )
        check("freezer unit → ambient shelf still works (rule is LN2-only)", s == 201, b)

    print("\n== PER LEG, not per request ==")
    fresh_a = next(r for _i, r in _all_stock(token) if r["node_id"] == box_a["id"])
    ln2_cell = fresh_a["cells"][0]
    shelf_rows = [r for _i, r in _all_stock(token) if r["node_id"] == shelf_node["id"]]
    if not shelf_rows:
        check("a shelf row exists for the mixed-leg case", False)
    else:
        s, b = _req(
            "POST",
            "/allocations/transfer-multi",
            token=token,
            json_body={
                "sources": [
                    {
                        "node_id": shelf_node["id"],
                        "lot_id": shelf_rows[0]["lot_id"],
                        "qty": 1,
                        "to_node_id": cold_node["id"],
                    },
                    {
                        "node_id": box_a["id"],
                        "lot_id": fresh_a["lot_id"],
                        "qty": 1,
                        "to_node_id": shelf_node["id"],
                        "cell_allocation_ids": [ln2_cell["allocation_id"]],
                    },
                ],
                "evidence_id": _sign(token),
            },
        )
        ok = s == 422 and _code(b) == COLD_CHAIN_CODE
        check("a mixed signature is refused for its LN2 leg", ok, f"{s} {b}")
        check("the refusal names the offending leg", "Source 2" in _message(b), _message(b))

    print("\n== NOT A TRANSFER, so untouched: material issue out of LN2 ==")
    # The guard must not have leaked into ``loc_repo.draw_lot_at_node``, which
    # transfer-multi SHARES with material issue and customer shipment. A rule
    # placed there could only say "nothing may leave a box" (it gets no
    # destination argument), which would break both.
    #
    # This also pins the scope boundary the client chose on 2026-08-20: LOC-003
    # names three permitted destinations and does not mention Issue, so
    # debit-and-gone out of LN2 stays legal. It is a real 4th exit from a box and
    # the cold-chain rationale arguably covers it — RAISED WITH THE CLIENT. If
    # they extend the rule, this check flips to a blocked case.
    fresh_a = next(r for _i, r in _all_stock(token) if r["node_id"] == box_a["id"])
    s, cats = _req("GET", "/issues/destinations", token=token)
    scrap = cats if s == 200 and isinstance(cats, list) else []
    if not scrap:
        print("  (no debit-and-gone location on file — skipped)")
        print("  create one with is_scrap=true to cover this case")
    else:
        cell = fresh_a["cells"][0]
        s, b = _req(
            "POST",
            "/issues",
            token=token,
            json_body={
                "sources": [
                    {
                        "node_id": box_a["id"],
                        "lot_id": fresh_a["lot_id"],
                        "qty": 1,
                        "cell_allocation_ids": [cell["allocation_id"]],
                    }
                ],
                "destination_node_id": scrap[0]["node_id"],
                "evidence_id": _sign(token, ISSUE_ACTION),
                "notes": "LOC-003 smoke: Issue is not a transfer",
            },
        )
        check(
            f"issuing out of an LN2 box to '{scrap[0]['name']}' still works",
            s in (200, 201),
            f"{s} {b}",
        )

    print(f"\n{STATS['passed']} passed, {len(FAILED)} failed")
    for f in FAILED:
        print(f"  - {f}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
