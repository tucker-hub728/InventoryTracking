"""Regression smoke: close-out back-flush into an LN2 box must land IN the cells.

Run from the project root against a running dev stack:

    SMOKE_EMAIL=admin@cellready.dev SMOKE_PASSWORD=... \
        python backend/tests/smoke_kitting_backflush_cells.py

The bug (found 2026-07-28, reported from the UI): the close-out back-flush
validated the operator's chosen cells and then called ``_return_to_inventory``
WITHOUT passing them. ``return_cells`` defaulted to ``None``, so the grid branch
never ran and the units landed in the box as ONE cell-less allocation — right
quantity, right node, no vial position. The box's unit map stayed empty and
Contents showed the item with a "—" cell.

The other three return paths (return-excess ×2, cancel) always passed the cells,
so only close-out was affected — and nothing in ``smoke_kitting.py`` back-flushed
into a grid node, which is why 92 passing checks missed it.

Covers:
  * close-out back-flush into a box creates one allocation PER CHOSEN CELL
  * each returned unit carries the grid_row/grid_col the operator picked
  * no cell-less allocation is left behind in the box
  * the ledger still records ONE backflush row for the lot (cells are placement,
    not separate movements — kitting.md §4.3 D4)
  * a box target with the wrong number of cells is still rejected
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

# Same dev-seed ids as smoke_kitting.py — a well-stocked 2-child sub-assembly,
# the production node, and a shelf for the produced output.
BUILT_ITEM_ID = "94f6f76d-b1e1-4a7b-88d9-ce094ae8259c"  # AS-TEST-001
PROD_NODE_ID = "358ad8b4-3d13-484b-ac8f-bcb7ce8f075c"  # Clean Room 1
OUTPUT_SHELF_ID = "33068349-5206-45a1-a0a8-800772cf4e33"  # Shelf A

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


def _allocations(token, node_id):
    s, b = _req("GET", f"/location-nodes/{node_id}/allocations", token=token)
    assert s == 200, b
    return b


def _free_cells(token, box, want):
    """``want`` free (row, col) positions in ``box``, in reading order."""
    taken = {
        (a["grid_row"], a["grid_col"])
        for a in _allocations(token, box["id"])
        if a["grid_row"] is not None
    }
    rows, cols = int(box["grid_rows"]), int(box["grid_cols"] or 1)
    free = [(r, c) for r in range(1, rows + 1) for c in range(1, cols + 1) if (r, c) not in taken]
    return free[:want]


def _pick_box(token):
    """An active LN2 box with enough free cells for the test."""
    s, targets = _req("GET", "/location-nodes/storage-targets", token=token)
    assert s == 200, targets
    for node in targets:
        if node.get("node_type") != "box" or not node.get("grid_rows"):
            continue
        if len(_free_cells(token, node, 3)) >= 3:
            return node
    return None


def _create_and_issue(token, extra):
    """A kit issued with ``extra`` units per line beyond the need, so close-out
    has a leftover to back-flush."""
    s, b = _req("GET", "/kits/next-number", token=token)
    assert s == 200, b
    s, kit = _req(
        "POST",
        "/kits",
        token=token,
        json_body={
            "kit_number": b["kit_number"],
            "item_id": BUILT_ITEM_ID,
            "target_qty": 1,
            "production_location_node_id": PROD_NODE_ID,
        },
    )
    assert s == 201, kit

    lines = []
    for line in kit["lines"]:
        want = int(round(float(line["needed_qty"]))) + extra
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
        if rem > 0:
            return None, f"not enough stock for line {line['line_no']}"
        lines.append({"line_id": line["id"], "sources": picks})

    s, issued = _req("POST", f"/kits/{kit['id']}/issue", token=token, json_body={"lines": lines})
    assert s == 200, issued
    return issued, None


def main() -> int:
    token = _login()

    box = _pick_box(token)
    if box is None:
        print("No LN2 box with 3+ free cells on this dev DB — cannot run.")
        return 2
    print(f"\nBox: {box['name']} ({box['grid_rows']}x{box['grid_cols']})\n")

    # ── The regression: back-flush a leftover into chosen cells ────────────
    print("== close-out back-flush into an LN2 box ==")
    kit, err = _create_and_issue(token, extra=2)
    if kit is None:
        print(f"  SKIP  {err}")
        return 2

    target = kit["lines"][0]
    leftover = int(target["issued_qty"]) - int(round(float(target["needed_qty"])))
    cells = _free_cells(token, box, leftover)
    check(f"kit issued with a leftover of {leftover}", leftover >= 1, target)

    before = {a["id"] for a in _allocations(token, box["id"])}

    close_lines = []
    for ln in kit["lines"]:
        entry = {"line_id": ln["id"], "used_qty": int(round(float(ln["needed_qty"])))}
        if ln["id"] == target["id"]:
            entry["return_location_node_id"] = box["id"]
            entry["return_cells"] = [{"grid_row": r, "grid_col": c} for r, c in cells]
        close_lines.append(entry)

    s, closed = _req(
        "POST",
        f"/kits/{kit['id']}/close-out",
        token=token,
        json_body={
            "good_qty": 1,
            "scrap_qty": 0,
            "outputs": [{"location_node_id": OUTPUT_SHELF_ID, "qty": 1, "cells": []}],
            "output_expiration_date": "2030-01-01",
            "output_lot_number": f"{kit['kit_number']}-BFC",
            "lines": close_lines,
            "evidence_id": _reauth(token, "kit.closeout"),
            "reason": "backflush-cells regression",
        },
    )
    check("close-out -> 200 closed", s == 200 and closed.get("status") == "closed", (s, closed))

    # ── What actually landed in the box ───────────────────────────────────
    new_allocs = [a for a in _allocations(token, box["id"]) if a["id"] not in before]
    check(
        f"one allocation per chosen cell ({leftover} expected)",
        len(new_allocs) == leftover,
        [(a["grid_row"], a["grid_col"], a["qty"]) for a in new_allocs],
    )
    landed = {(a["grid_row"], a["grid_col"]) for a in new_allocs}
    check(
        "units landed in exactly the cells picked",
        landed == set(cells),
        {"picked": set(cells), "landed": landed},
    )
    check(
        "no cell-less allocation left in the box (the bug)",
        all(a["grid_row"] is not None for a in new_allocs),
        [a for a in new_allocs if a["grid_row"] is None],
    )
    check(
        "each cell holds exactly one unit",
        all(int(a["qty"]) == 1 for a in new_allocs),
        [a["qty"] for a in new_allocs],
    )

    # ── The ledger is unchanged: one row per lot, not one per cell ────────
    s, activity = _req("GET", f"/kits/{kit['id']}/activity", token=token)
    assert s == 200, activity
    # ``items`` are the kit's stock_movements rows; the activity row carries the
    # component's item_id (not the line id), so match the returned component.
    backflushes = [
        m
        for m in activity["items"]
        if m["movement_type"] == "backflush" and m["item_id"] == target["item_id"]
    ]
    check(
        "ledger records ONE backflush row for the lot, not one per cell",
        len(backflushes) == 1,
        len(backflushes),
    )
    check(
        "the backflush row carries the full quantity",
        backflushes and int(backflushes[0]["qty_delta"]) == leftover,
        backflushes,
    )

    # ── The count guard still bites ───────────────────────────────────────
    print("\n== cell-count guard ==")
    kit2, err = _create_and_issue(token, extra=2)
    if kit2 is None:
        print(f"  SKIP  {err}")
    else:
        t2 = kit2["lines"][0]
        left2 = int(t2["issued_qty"]) - int(round(float(t2["needed_qty"])))
        one_cell = _free_cells(token, box, 1)
        s, b = _req(
            "POST",
            f"/kits/{kit2['id']}/close-out",
            token=token,
            json_body={
                "good_qty": 1,
                "scrap_qty": 0,
                "outputs": [{"location_node_id": OUTPUT_SHELF_ID, "qty": 1, "cells": []}],
                "output_expiration_date": "2030-01-01",
                "output_lot_number": f"{kit2['kit_number']}-BFC2",
                "lines": [
                    {
                        "line_id": ln["id"],
                        "used_qty": int(round(float(ln["needed_qty"]))),
                        **(
                            {
                                "return_location_node_id": box["id"],
                                "return_cells": [
                                    {"grid_row": one_cell[0][0], "grid_col": one_cell[0][1]}
                                ],
                            }
                            if ln["id"] == t2["id"]
                            else {}
                        ),
                    }
                    for ln in kit2["lines"]
                ],
                "evidence_id": _reauth(token, "kit.closeout"),
                "reason": "cell count guard",
            },
        )
        check(
            f"1 cell for a {left2}-unit return -> 422 cell_count_mismatch",
            s == 422,
            (s, b),
        )
        _req(
            "POST",
            f"/kits/{kit2['id']}/cancel",
            token=token,
            json_body={"evidence_id": _reauth(token, "kit.cancel"), "reason": "cleanup"},
        )

    passed, failed = _TALLY
    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
