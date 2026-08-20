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
  * BLOCKED with code ``transfer_blocked_ln2_entry`` — a cold-storage unit or an
    ambient shelf → an LN2 box. **This half is a client addition of 2026-08-20,
    beyond LOC-003 as written**, making LN2 a CLOSED SET: if material cannot be
    transferred out to a shelf, it cannot be transferred in from one either. It
    carries its own error code so the two halves stay separable if the client
    withdraws it.
  * UNAFFECTED — put-away into an LN2 box still works. That is how a tank is
    legitimately stocked, and it is not a transfer. Note the accepted
    consequence: because put-away is capped at the lot's ``ordered_qty``, units
    already placed elsewhere can now never reach LN2 at all.
  * UNAFFECTED — a transfer with neither end in LN2 (freezer → ambient shelf).
    The rule governs only moves that CROSS the boundary.
  * PER LEG, not per request — a multi-source signature whose second leg is
    illegal is refused naming that leg ("Source 2: ..."), and its legal first leg
    is not applied either: every leg is validated before anything is written
  * NOT A TRANSFER, so untouched — a material issue (debit-and-gone) still
    draws from an LN2 box, proving the guard did not leak into the shared drain
    ``loc_repo.draw_lot_at_node``, which transfer-multi shares with issue and
    customer shipment. Issue is a real 4th exit from a box that LOC-003 does not
    mention; leaving it legal is the client's 2026-08-20 decision, RAISED as a
    gap. If they extend the rule, this check flips to a blocked case.

NOTE — this script MOVES REAL STOCK in the dev database, like every other smoke
here, and each run permanently costs the fixture box two vials: one moved to the
second box, one issued to a scrap location. It therefore TOPS THE BOX UP to
``SEED_UNITS`` on every run rather than only seeding when empty, which is what
keeps it runnable indefinitely.

Topping up is done by PUT-AWAY (``/allocations/place``), because a transfer into
LN2 is precisely what the closed-set half now refuses — and it is a ONE-WAY trip
by design: once units are in a box, this rule is exactly what stops the script
putting them back in the freezer. Put-away is capped at the lot's
``ordered_qty``, so if every lot is at its cap the script says so and stops
rather than reporting a false failure.
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
RECEIPT_ACTION = "movement.receipt"

#: Vials parked in the LN2 box the first time this runs. Kept tiny: the rule
#: under test is what prevents moving them back out to the freezer.
SEED_UNITS = 4

#: The refusal LOC-003 introduces. Deliberately NOT ``node_not_storable``: that
#: code means "you picked a location, not a storage place" and its message tells
#: the operator to pick the shelf inside — exactly the wrong advice here. It is
#: also the code smoke_material_issue.py asserts to prove the Issue and Transfer
#: destination sets are disjoint, and reusing it would destroy that proof.
COLD_CHAIN_CODE = "transfer_blocked_cold_chain"

#: The mirror half (client 2026-08-20): LN2 is a closed set, so a transfer may
#: not carry material INTO it from outside either. Its own code, so that if the
#: client withdraws the addition the two halves stay separable in the tests too.
LN2_ENTRY_CODE = "transfer_blocked_ln2_entry"

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


def _occupied(token: str, node_id: str) -> list[dict]:
    """Every occupied cell in a box, ACROSS ALL LOTS.

    A box holds one lot per cell but may hold several lots, so the cells of one
    ``/stock-locations`` row are not the cells of the box. Reading a single row
    and calling the rest free picks a cell another lot is sitting in, which the
    server then rejects with ``cell_occupied`` — a test failure that looks like a
    rule failure and is not.
    """
    return [c for _i, r in _all_stock(token) if r["node_id"] == node_id for c in r.get("cells", [])]


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
    # Prefer a box that ALREADY holds stock as the source. Which box comes first
    # depends on what exists in the environment, and picking an empty one sends
    # the run down the seeding path for no reason — a path that can legitimately
    # fail when every lot is already at its ordered cap.
    stocked_box_ids = {r["node_id"] for _i, r in _all_stock(token) if r["is_grid"] and r["qty"] > 0}
    boxes.sort(key=lambda n: n["id"] not in stocked_box_ids)
    box_a, box_b = boxes[0], boxes[1]
    shelf_node, shelf_group = ambient
    cold_node, cold_group = cold
    print(f"  box A      : {box_a['code']}")
    print(f"  box B      : {box_b['code']}")
    print(f"  ambient    : {shelf_group['name']} › {shelf_node['name']}")
    print(f"  cold       : {cold_group['name']} › {cold_node['name']}")

    print("\n== seed LN2 stock ==")

    # Seeded by PUT-AWAY, not by transfer — a transfer INTO LN2 is exactly what
    # the closed-set half of the rule now refuses. Put-away is the legitimate
    # way a tank is stocked and is deliberately untouched.
    #
    # TOPPED UP, not merely seeded-if-empty. Each run permanently costs the box
    # two vials — one moved to box B, one issued to a scrap location — so a
    # "reuse whatever is there" rule drains the fixture after a couple of runs
    # and then fails on its own leftovers. Bring the box up to SEED_UNITS every
    # time instead, and it stays runnable indefinitely.
    def biggest_row_in_box_a():
        candidates = [
            (i, r) for i, r in _all_stock(token) if r["node_id"] == box_a["id"] and r["qty"] > 0
        ]
        # A box may hold more than one lot; work with whichever holds most cells
        # so the cell list and the lot id below always agree.
        return max(candidates, key=lambda t: len(t[1].get("cells", [])), default=None)

    have = biggest_row_in_box_a()
    short = SEED_UNITS - (len(have[1]["cells"]) if have else 0)
    if short <= 0:
        item_id, box_row = have  # type: ignore[misc]
        print(f"  {box_row['qty']} unit(s) already in {box_a['code']} — no top-up needed")
        check("the fixture box is stocked", True)
    else:
        # Put-away is capped at the lot's ``ordered_qty``, so pick a lot that
        # still has headroom. Prefer the lot already in the box, so the box does
        # not sprout a second lot on every run.
        rows = _all_stock(token)
        ordered = ([have] if have else []) + [(i, r) for i, r in rows if not r["is_grid"]]
        seed_src = None
        for i, r in ordered:
            if r["qty"] <= 0:
                continue
            s, avail = _req("GET", f"/allocations/lot-availability/{r['lot_id']}", token=token)
            remaining = avail.get("remaining") if s == 200 else None
            if remaining is None or remaining >= short:
                seed_src = (i, r)
                break
        if seed_src is None:
            print(f"  {box_a['code']} is {short} vial(s) short and every lot is at its")
            print("  ordered cap — receive a lot into an LN2 box, then re-run")
            return 1
        item_id, src_row = seed_src
        box_meta = _node(token, box_a["id"])
        # Occupied cells across EVERY lot in the box, not just the row being
        # topped up: a box holds one lot per cell but may hold several lots, and
        # counting only one row's cells picks a cell another lot is sitting in.
        occupied = _occupied(token, box_a["id"])
        cells = _free_cells(
            {
                "cells": occupied,
                "grid_rows": box_meta["grid_rows"],
                "grid_cols": box_meta["grid_cols"],
            },
            short,
        )
        placed = 0
        for cell in cells:
            s, b = _req(
                "POST",
                "/allocations/place",
                token=token,
                json_body={
                    "lot_id": src_row["lot_id"],
                    "node_id": box_a["id"],
                    "qty": 1,
                    "grid_row": cell["grid_row"],
                    "grid_col": cell["grid_col"],
                    "evidence_id": _sign(token, RECEIPT_ACTION),
                    "notes": "LOC-003 smoke: top up LN2 stock by put-away",
                },
            )
            if s != 201:
                print(f"  put-away stopped after {placed}: {b}")
                break
            placed += 1
        check(
            "put-away into an LN2 box still works (how a tank is stocked)",
            placed == short,
            f"placed {placed} of {short}",
        )
        item_id = seed_src[0]

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
            "cells": _occupied(token, box_a["id"]),
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

    print("\n== BLOCKED: into LN2 from outside it (closed set) ==")
    # Client addition 2026-08-20, beyond LOC-003 as written. The mirror of the
    # rule above: if material cannot be transferred OUT to a shelf, it cannot be
    # transferred IN from one either.
    box_b_meta = _node(token, box_b["id"])
    for label, src_node in (("cold storage unit", cold_node), ("ambient shelf", shelf_node)):
        src_rows = [r for _i, r in _all_stock(token) if r["node_id"] == src_node["id"]]
        if not src_rows:
            check(f"stock exists at the {label} to test with", False)
            continue
        s, b = _req(
            "POST",
            "/allocations/transfer-multi",
            token=token,
            json_body={
                "sources": [
                    {
                        "node_id": src_node["id"],
                        "lot_id": src_rows[0]["lot_id"],
                        "qty": 1,
                        "to_node_id": box_b["id"],
                        "to_cells": _free_cells(
                            {
                                "cells": [],
                                "grid_rows": box_b_meta["grid_rows"],
                                "grid_cols": box_b_meta["grid_cols"],
                            },
                            1,
                            avoid={
                                (c["grid_row"], c["grid_col"])
                                for r in [
                                    x for _i, x in _all_stock(token) if x["node_id"] == box_b["id"]
                                ]
                                for c in r.get("cells", [])
                            },
                        ),
                    }
                ],
                "evidence_id": _sign(token),
            },
        )
        ok = s == 422 and _code(b) == LN2_ENTRY_CODE
        check(f"{label} → LN2 box is refused", ok, f"{s} {b}")
        if ok:
            check(
                f"the {label} refusal explains how a tank IS stocked",
                "received" in _message(b) and "kit" in _message(b),
                _message(b),
            )

    print("\n== UNAFFECTED: neither end is LN2 ==")
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
                "notes": "LOC-003 smoke: neither end is LN2, so not governed",
            },
        )
        check("freezer unit → ambient shelf still works (boundary not crossed)", s == 201, b)

    print("\n== PER LEG, not per request ==")
    # Both legs are drawn from the same box so the request cannot trip
    # ``mixed_items`` first — a multi-source transfer must be one item, and which
    # items sit where varies per environment. Leg 1 is legal, leg 2 is not; the
    # refusal has to name leg 2 specifically rather than rejecting "the request".
    fresh_a = next(r for _i, r in _all_stock(token) if r["node_id"] == box_a["id"])
    if len(fresh_a["cells"]) < 2:
        check("the box holds two vials for the per-leg case", False, len(fresh_a["cells"]))
    else:
        b_meta = _node(token, box_b["id"])
        b_taken = {
            (c["grid_row"], c["grid_col"])
            for _i, r in _all_stock(token)
            if r["node_id"] == box_b["id"]
            for c in r.get("cells", [])
        }
        s, b = _req(
            "POST",
            "/allocations/transfer-multi",
            token=token,
            json_body={
                "sources": [
                    {
                        "node_id": box_a["id"],
                        "lot_id": fresh_a["lot_id"],
                        "qty": 1,
                        "to_node_id": box_b["id"],
                        "to_cells": _free_cells(
                            {
                                "cells": [],
                                "grid_rows": b_meta["grid_rows"],
                                "grid_cols": b_meta["grid_cols"],
                            },
                            1,
                            avoid=b_taken,
                        ),
                        "cell_allocation_ids": [fresh_a["cells"][0]["allocation_id"]],
                    },
                    {
                        "node_id": box_a["id"],
                        "lot_id": fresh_a["lot_id"],
                        "qty": 1,
                        "to_node_id": shelf_node["id"],
                        "cell_allocation_ids": [fresh_a["cells"][1]["allocation_id"]],
                    },
                ],
                "evidence_id": _sign(token),
            },
        )
        ok = s == 422 and _code(b) == COLD_CHAIN_CODE
        check("a signature carrying one illegal leg is refused", ok, f"{s} {b}")
        check("the refusal names the offending leg", "Source 2" in _message(b), _message(b))
        # And the legal leg must NOT have been applied — validation runs over
        # every leg before anything is written.
        after = next(
            (r for _i, r in _all_stock(token) if r["node_id"] == box_a["id"]),
            {"qty": -1},
        )
        check("the legal leg was not applied either", after["qty"] == fresh_a["qty"], after["qty"])

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
