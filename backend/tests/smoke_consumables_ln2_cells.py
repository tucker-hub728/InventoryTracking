"""Regression smoke: issuing a consumable that is stored in an LN2 box.

Run from the project root after ``docker compose up``:

    SMOKE_EMAIL=admin@cellready.dev SMOKE_PASSWORD=... \
        python backend/tests/smoke_consumables_ln2_cells.py

The bug (client 2026-08-11): the Issue-to-Kanban dialog assumed a consumable
always sits on a shelf — "gloves live on a shelf, not in a cryo vial position" —
so it flattened every source to ``is_grid: false`` and showed a plain quantity
box. CR-004 stored in Tank 1 is the counter-example. The operator typed a number
and the backend drained the lot's cells FIFO, emptying vial positions nobody had
pulled, while the kitting Issue step showed a real grid for the very same lot.

Verifies:

  * ``/consumables/sources`` marks a box source ``is_grid`` and carries its
    dimensions plus THIS LOT's occupied cells (the part that was missing)
  * a box holding two lots offers each row only its own vials
  * issuing with ``cell_allocation_ids`` empties EXACTLY those cells and leaves
    the lot's other vials in place
  * ``qty`` must equal the number of cells (422 ``cell_count_mismatch``)
  * a box source with NO cells is refused (422 ``cells_required``) rather than
    silently drained FIFO — this is the behaviour that used to lose vials
  * cells from another lot in the same box are refused (422 ``invalid_cell``)
  * the register row still records lot + quantity; per the client the vial
    positions are deliberately NOT named there
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from datetime import date, timedelta

BASE = "http://localhost:8000/v1"
EMAIL = os.environ.get("SMOKE_EMAIL", "admin@cellready.local")
PASSWORD = os.environ.get("SMOKE_PASSWORD", "ChangeMe!Now123")

ISSUE_ACTION = "movement.consumable_issue"

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


def _pick_box(token, want):
    """An active LN2 box with ``want`` free cells."""
    s, targets = _req("GET", "/location-nodes/storage-targets", token=token)
    assert s == 200, targets
    for node in targets:
        if node.get("node_type") != "box" or not node.get("grid_rows"):
            continue
        if len(_free_cells(token, node, want)) >= want:
            return node
    return None


def _consumable_item(token):
    s, b = _req("GET", "/items?limit=200", token=token)
    assert s == 200, b
    rows = b if isinstance(b, list) else b.get("items", [])
    for it in rows:
        if it.get("is_consumable"):
            return it
    return None


def _kanban(token):
    """Any existing Kanban station — the destination is not what this tests."""
    s, b = _req("GET", "/location-nodes/kanbans", token=token)
    if s != 200 or not b:
        return None
    return b[0]


def _seed_into_box(token, item_id, box, cells, label):
    """One lot, one unit per cell — how a box is really stocked (qty 1 per cell,
    ``uq_lot_allocations_cell``). Returns the lot id."""
    stamp = uuid.uuid4().hex[:6].upper()
    s, lot = _req(
        "POST",
        f"/items/{item_id}/lots",
        token=token,
        json_body={
            "lot_number": f"SMOKE-LN2-{label}-{stamp}",
            "expiration_date": (date.today() + timedelta(days=400)).isoformat(),
        },
    )
    assert s == 201, lot
    for row, col in cells:
        ev = _reauth(token, "movement.receipt")
        s, res = _req(
            "POST",
            "/allocations/place",
            token=token,
            json_body={
                "lot_id": lot["id"],
                "node_id": box["id"],
                "qty": 1,
                "grid_row": row,
                "grid_col": col,
                "evidence_id": ev,
                "notes": "smoke_consumables_ln2_cells seed",
            },
        )
        assert s in (200, 201), (s, res)
    return lot["id"]


def _source_row(token, item_id, lot_id, node_id):
    s, rows = _req("GET", f"/consumables/sources/{item_id}", token=token)
    assert s == 200, rows
    for r in rows:
        if r["lot_id"] == lot_id and r["node_id"] == node_id:
            return r
    return None


def main() -> int:
    token = _login()

    item = _consumable_item(token)
    if item is None:
        print("No consumable item on this dev DB — cannot run.")
        return 2
    kanban = _kanban(token)
    if kanban is None:
        print("No Kanban station on this dev DB — cannot run.")
        return 2
    # 3 vials of the lot under test + 1 of a second lot sharing the box.
    box = _pick_box(token, 4)
    if box is None:
        print("No LN2 box with 4+ free cells on this dev DB — cannot run.")
        return 2

    print(f"\nItem: {item['item_number']}   Box: {box['name']} "
          f"({box['grid_rows']}x{box['grid_cols']})   Kanban: {kanban['name']}\n")

    free = _free_cells(token, box, 4)
    lot_id = _seed_into_box(token, item["id"], box, free[:3], "A")
    other_lot_id = _seed_into_box(token, item["id"], box, free[3:4], "B")

    # ── 1. The source row describes a box, not a shelf ──────────────────
    print("== sources: a box source carries its grid ==")
    row = _source_row(token, item["id"], lot_id, box["id"])
    check("box source is listed", row is not None, "lot not in /consumables/sources")
    if row is None:
        print(f"\n{_TALLY[0]} passed, {_TALLY[1]} failed")
        return 1
    check("is_grid is set", row.get("is_grid") is True, row)
    check(
        "grid dimensions match the box",
        (row.get("grid_rows"), row.get("grid_cols"))
        == (int(box["grid_rows"]), int(box["grid_cols"])),
        (row.get("grid_rows"), row.get("grid_cols")),
    )
    cells = row.get("cells") or []
    check("one cell per seeded vial", len(cells) == 3, [(c["grid_row"], c["grid_col"]) for c in cells])
    check(
        "cells are the positions seeded",
        sorted((c["grid_row"], c["grid_col"]) for c in cells) == sorted(free[:3]),
        (sorted((c["grid_row"], c["grid_col"]) for c in cells), sorted(free[:3])),
    )
    check(
        "only THIS lot's vials are offered",
        all(c["lot_id"] == lot_id for c in cells),
        [c["lot_id"] for c in cells],
    )
    other = _source_row(token, item["id"], other_lot_id, box["id"])
    check(
        "the box's other lot is a separate row with its own vial",
        other is not None and len(other.get("cells") or []) == 1,
        other,
    )

    # ── 2. Refusals that protect the physical box ───────────────────────
    print("\n== a box source must name its vials ==")
    ev = _reauth(token, ISSUE_ACTION)
    s, b = _req(
        "POST",
        "/consumables/issue",
        token=token,
        json_body={
            "sources": [{"node_id": box["id"], "lot_id": lot_id, "qty": 2}],
            "kanban_node_id": kanban["id"],
            "evidence_id": ev,
        },
    )
    check("no cells ⇒ 422 (not a silent FIFO drain)", s == 422, (s, b))
    check("code is cells_required", b.get("code") == "cells_required", b)

    ev = _reauth(token, ISSUE_ACTION)
    s, b = _req(
        "POST",
        "/consumables/issue",
        token=token,
        json_body={
            "sources": [
                {
                    "node_id": box["id"],
                    "lot_id": lot_id,
                    "qty": 3,
                    "cell_allocation_ids": [cells[0]["allocation_id"]],
                }
            ],
            "kanban_node_id": kanban["id"],
            "evidence_id": ev,
        },
    )
    check("qty ≠ cell count ⇒ 422", s == 422, (s, b))
    check("code is cell_count_mismatch", b.get("code") == "cell_count_mismatch", b)

    ev = _reauth(token, ISSUE_ACTION)
    s, b = _req(
        "POST",
        "/consumables/issue",
        token=token,
        json_body={
            "sources": [
                {
                    "node_id": box["id"],
                    "lot_id": lot_id,
                    "qty": 1,
                    "cell_allocation_ids": [other["cells"][0]["allocation_id"]],
                }
            ],
            "kanban_node_id": kanban["id"],
            "evidence_id": ev,
        },
    )
    check("another lot's vial ⇒ 422", s == 422, (s, b))
    check("code is invalid_cell", b.get("code") == "invalid_cell", b)

    # ── 3. The issue empties exactly the chosen vials ───────────────────
    print("\n== issuing empties the tapped vials only ==")
    chosen = sorted(cells, key=lambda c: (c["grid_row"], c["grid_col"]))[:2]
    chosen_pos = {(c["grid_row"], c["grid_col"]) for c in chosen}
    kept_pos = {(c["grid_row"], c["grid_col"]) for c in cells} - chosen_pos

    ev = _reauth(token, ISSUE_ACTION)
    s, res = _req(
        "POST",
        "/consumables/issue",
        token=token,
        json_body={
            "sources": [
                {
                    "node_id": box["id"],
                    "lot_id": lot_id,
                    "qty": len(chosen),
                    "cell_allocation_ids": [c["allocation_id"] for c in chosen],
                }
            ],
            "kanban_node_id": kanban["id"],
            "evidence_id": ev,
            "notes": "smoke: LN2 vials",
        },
    )
    check("issue accepted", s == 201, (s, res))
    check("quantity is the vial count", res.get("total_qty") == len(chosen), res)

    live = {
        (a["grid_row"], a["grid_col"])
        for a in _allocations(token, box["id"])
        if a["grid_row"] is not None and a["lot_id"] == lot_id
    }
    check("tapped vials are gone", not (chosen_pos & live), sorted(chosen_pos & live))
    check("untapped vial of the same lot survives", kept_pos <= live, (sorted(kept_pos), sorted(live)))
    other_live = {
        (a["grid_row"], a["grid_col"])
        for a in _allocations(token, box["id"])
        if a["grid_row"] is not None and a["lot_id"] == other_lot_id
    }
    check("the other lot's vial is untouched", len(other_live) == 1, sorted(other_live))

    after = _source_row(token, item["id"], lot_id, box["id"])
    check(
        "sources now offers only the remaining vial",
        after is not None and len(after.get("cells") or []) == len(kept_pos),
        after,
    )

    # ── 4. The register: lot + qty, no vial detail (client's choice) ────
    print("\n== register ==")
    s, reg = _req(
        "GET", f"/consumables/issued?kanban_node_id={kanban['id']}&item_id={item['id']}", token=token
    )
    check("register lists the issue", s == 200 and len(reg) >= 1, (s, reg))
    if s == 200 and reg:
        newest = reg[0]
        check("register records the quantity", newest.get("qty") == len(chosen), newest)
        check("register records the lot", bool(newest.get("lot_number")), newest)
        check(
            "register does NOT name vial positions (deliberate)",
            "grid_row" not in newest and "cells" not in newest,
            sorted(newest),
        )

    print(f"\n{_TALLY[0]} passed, {_TALLY[1]} failed")
    return 0 if _TALLY[1] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
