"""Ad-hoc smoke test: the LN2 transfer boundary is OPEN.

REQ-2026-08-13-LOC-004 (SRS Consolidated Amendment 9+10, rev. 2026-08-18),
resolved by the client on 2026-09-01. LOC-003 constrained a transfer out of
liquid nitrogen to another LN2 box, and the client's 2026-08-20 addition mirrored
it so LN2 was a CLOSED SET. Both are now WITHDRAWN:

  * ticket: "Remove this constraint. Assumption was made by CR team that did not
    hold true upon challenge by Houston Team."
  * ticket: "Preservation of Cold Chain authority shall be the responsibility of
    the team, not limited to the software."
  * Blane Larson: "We are going to need to remove the LN2 restrictions. The Cell
    Lines, Peptides and Testing Proteins are received and stored in LN2 but need
    to be issued to a Freezer, Fridge or Shelf to be consumed for Production, PD,
    QA or QC."

So this file is the INVERSE of the ``smoke_ln2_destinations.py`` it replaces:
every case that script proved was refused, this one proves succeeds. It exists to
stop the rule being reintroduced by accident — the guard was threaded through
three transfer endpoints and two pickers, and a partial revival would be silent.

Blane's word "issued" is a TRANSFER here, not an Issue: a Freezer/Fridge/Shelf is
a ``sub_location``/``shelf`` and can hold an allocation, whereas Issue is
debit-and-gone to a scrap ``storage_category``. The two destination sets are
deliberately disjoint, which is unchanged and still asserted below.

The confirmation pop-up and the narrow "non-drug-product materials only"
exception were both DEFERRED TO VER 2.0 by the client, so neither is built and
neither is tested here. Crossing the boundary is recorded and e-signed exactly
like any other transfer, which is the audit trail the requirement asks for.

No migration — this exercises code only.

Run from the project root after ``docker compose up``:

    SMOKE_EMAIL=you@example SMOKE_PASSWORD=... \
        python backend/tests/smoke_ln2_boundary_open.py

or, with no Python on the host:

    docker exec cellready-backend python tests/smoke_ln2_boundary_open.py

Verifies:
  * PERMITTED — LN2 box to a non-LN2 storage leaf, on all three transfer
    endpoints ``/transfer``, ``/transfer-batch`` and ``/transfer-multi``. This is
    Blane's case: cell lines and peptides leaving a tank for a freezer, fridge or
    shelf so Production/PD/QA/QC can consume them.
  * PERMITTED — LN2 box to an AMBIENT warehouse shelf, the requirement's own
    example of what LOC-003 blocked, when the environment has one. Skipped rather
    than failed where no shelf-kind group exists (dev has only freezer groups).
  * PERMITTED — a non-LN2 leaf back to an LN2 box. This half also fixes a real
    defect LOC-003 introduced: receive-to-inventory is capped at the lot's
    ``ordered_qty``, so a transfer was the ONLY route into a tank for units
    already placed elsewhere, and closing it stranded them outside LN2 forever.
  * PERMITTED — LN2 box to another LN2 box, and vials rearranged between cells of
    the SAME box. Never blocked; asserted so the removal did not overshoot.
  * PERMITTED — ONE signature carrying an LN2 leg AND a non-LN2 leg. The old
    per-leg refusal is gone; both legs must now apply. Replaces the "Source 2:"
    case.
  * UNAFFECTED — a transfer with neither end in LN2.
  * UNAFFECTED — put-away into an LN2 box, still how a tank is stocked at receipt.
  * STILL DISJOINT — a material issue (debit-and-gone) out of an LN2 box works,
    and a transfer may still not target a scrap location. Removing the cold-chain
    rule must not have blurred Issue and Transfer into each other.

NOTE — this script MOVES REAL STOCK in the dev database, like every other smoke
here. Unlike its predecessor it is SELF-HEALING: because transfers back into LN2
are legal again, every vial it moves out of the box is moved back in at the end.
That is itself a proof of the reverse direction, so the cleanup and the assertion
are the same step. Only the material issue is permanent (one vial per run), and
the box is topped up by put-away when it runs low.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

from _smoke_creds import require_credentials

BASE = os.environ.get("SMOKE_BASE", "http://localhost:8000/v1")
EMAIL, PASSWORD = require_credentials()

TRANSFER_ACTION = "movement.transfer"
ISSUE_ACTION = "movement.material_issue"
RECEIPT_ACTION = "movement.receipt"

#: Vials the fixture box is topped up to. The script needs four in hand: three
#: for the one-per-endpoint cases and one for the mixed-leg signature.
SEED_UNITS = 6

#: The LN2 hierarchy, mirroring the backend's ``LN2_LEVELS``. Only ``box`` can
#: hold stock, but the whole cascade is listed so a future storable level is
#: classified as "inside LN2" too.
LN2_TYPES = {"tank", "tank_quadrant", "rack", "box"}

STATS = {"passed": 0}
FAILED: list[str] = []
SKIPPED: list[str] = []


def check(label: str, cond: bool, detail: object = "") -> None:
    if cond:
        STATS["passed"] += 1
        print(f"  ok   {label}")
    else:
        FAILED.append(label)
        print(f"  FAIL {label}: {detail}")


def skip(label: str, why: str) -> None:
    SKIPPED.append(f"{label} ({why})")
    print(f"  skip {label}: {why}")


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


def _free_cells(token: str, node_id: str, want: int) -> list[dict]:
    """``want`` empty (row, col) coordinates in a box, as transfer payload cells."""
    meta = _node(token, node_id)
    taken = {(c["grid_row"], c["grid_col"]) for c in _occupied(token, node_id)}
    out = []
    for r in range(1, (meta.get("grid_rows") or 0) + 1):
        for c in range(1, (meta.get("grid_cols") or 0) + 1):
            if (r, c) not in taken:
                out.append({"grid_row": r, "grid_col": c})
                if len(out) == want:
                    return out
    return out


def _box_row(token: str, box_id: str, item_id: str | None) -> dict | None:
    if item_id is None:
        return None
    return next(
        (r for i, r in _all_stock(token) if r["node_id"] == box_id and i == item_id),
        None,
    )


def _cells_in(token: str, box_id: str, item_id: str | None) -> list[dict]:
    row = _box_row(token, box_id, item_id)
    return sorted((row or {}).get("cells", []), key=lambda c: (c["grid_row"], c["grid_col"]))


def main() -> int:
    token = _login()
    print("\n== discover fixtures ==")

    s, targets = _req("GET", "/location-nodes/storage-targets", token=token)
    assert s == 200, targets
    boxes = [n for n in targets if n["node_type"] == "box"]
    outside = [n for n in targets if n["node_type"] not in LN2_TYPES]
    check("at least one LN2 box exists", len(boxes) >= 1, [n["code"] for n in targets])
    check(
        "at least one non-LN2 storage leaf exists",
        len(outside) >= 1,
        [n["code"] for n in targets],
    )
    if not boxes or not outside:
        print("\nFixtures missing — cannot run. Seed an LN2 box and a Storage")
        print("sub-location (freezer, refrigerator or shelf), then re-run.")
        return 1

    # An ambient shelf and a cold unit are BOTH ``sub_location`` — the Storage
    # template models a warehouse shelf as a unit under a shelf-KIND group, not as
    # the retired ``shelf`` node type. The parent group's code is the only thing
    # that tells them apart (SHF vs FRZ/REF); temperature is deliberately not
    # modelled on a node. The rule is gone for both, so the ambient case is a
    # bonus assertion rather than something this script needs to run.
    ambient, cold = None, None
    for n in outside:
        parent = _node(token, n["parent_id"]) if n.get("parent_id") else {}
        base = (parent.get("code") or "").split("-")[0]
        if base == "SHF" and ambient is None:
            ambient = n
        elif base in ("FRZ", "REF") and cold is None:
            cold = n
    out_node = cold or ambient or outside[0]
    box_a = boxes[0]
    box_b = boxes[1] if len(boxes) > 1 else None
    print(f"  box      {box_a['code']}")
    print(f"  outside  {out_node['code']}" + ("" if cold else "  (no cold unit found)"))
    print("  ambient  " + (ambient["code"] if ambient else "(none — SHF cases will skip)"))
    print("  box 2    " + (box_b["code"] if box_b else "(none — box-to-box cases will skip)"))

    # ── top the fixture box up by PUT-AWAY ──────────────────────────────────
    # Still the way a tank is stocked at receipt, and still not a transfer.
    print("\n== UNAFFECTED: put-away into an LN2 box ==")
    stocked = [(i, r) for i, r in _all_stock(token) if r["node_id"] == box_a["id"]]
    item_id: str | None = stocked[0][0] if stocked else None
    have = sum(int(r["qty"]) for _i, r in stocked)
    if have >= SEED_UNITS:
        check(f"the fixture box already holds {have} vial(s)", True)
    else:
        short = SEED_UNITS - have
        # A lot of the item already in the box, or any lot at all on a first run.
        seed_src = next(
            (
                (i, r)
                for i, r in _all_stock(token)
                if r["node_id"] != box_a["id"]
                and int(r["qty"]) >= 1
                and (item_id is None or i == item_id)
            ),
            None,
        )
        if seed_src is None:
            check("a lot exists to seed the fixture box from", False, "no stock anywhere")
            return 1
        item_id = seed_src[0]
        placed = 0
        capped = False
        for cell in _free_cells(token, box_a["id"], short):
            s, b = _req(
                "POST",
                "/allocations/place",
                token=token,
                json_body={
                    "lot_id": seed_src[1]["lot_id"],
                    "node_id": box_a["id"],
                    "qty": 1,
                    "grid_row": cell["grid_row"],
                    "grid_col": cell["grid_col"],
                    "evidence_id": _sign(token, RECEIPT_ACTION),
                    "notes": "LOC-004 smoke: top up LN2 stock by put-away",
                },
            )
            if s != 201:
                capped = _code(b) == "place_exceeds_ordered"
                print(f"  put-away stopped after {placed}: {b}")
                break
            placed += 1
        if placed == short:
            check("put-away into an LN2 box still works (how a tank is stocked)", True)
        elif capped:
            # Every unit of this lot is already placed SOMEWHERE, so receipt
            # put-away has nothing left to give — which is exactly the state
            # LOC-003 made unrecoverable, because a transfer was the only other
            # route into a tank. Seeding by transfer is therefore both the fix
            # for the fixture and a proof of the rule's removal.
            skip("put-away into an LN2 box", "the seed lot is at its ordered_qty cap")
            print("  seeding by TRANSFER instead — the route LOC-003 had closed")
            still = short - placed
            free = _free_cells(token, box_a["id"], still)
            src = next(
                (
                    r
                    for i, r in _all_stock(token)
                    if i == item_id
                    and r["node_id"] != box_a["id"]
                    and r["node_type"] not in LN2_TYPES
                    and int(r["qty"]) >= 1
                ),
                None,
            )
            if src is None or not free:
                check("a non-LN2 lot exists to transfer into the box", False, "none found")
                return 1
            qty = min(still, int(src["qty"]), len(free))
            s, b = _req(
                "POST",
                "/allocations/transfer-multi",
                token=token,
                json_body={
                    "sources": [
                        {
                            "node_id": src["node_id"],
                            "lot_id": src["lot_id"],
                            "qty": qty,
                            "to_node_id": box_a["id"],
                            "to_cells": free[:qty],
                        }
                    ],
                    "evidence_id": _sign(token),
                    "notes": "LOC-004 smoke: seed the box by transfer — un-stranding placed stock",
                },
            )
            check(f"non-LN2 leaf -> LN2 box seeded {qty} vial(s) by transfer", s == 201, b)
        else:
            check(
                "put-away into an LN2 box still works (how a tank is stocked)",
                False,
                f"placed {placed} of {short}",
            )

    row = _box_row(token, box_a["id"], item_id)
    cells = _cells_in(token, box_a["id"], item_id)
    if row is None or len(cells) < 4:
        check("the LN2 box holds four vials to move", False, f"{len(cells)} in hand")
        return 1
    check("the LN2 box reports a grid", row["is_grid"] is True, row)
    lot_id = row["lot_id"]
    #: Node ids this run took vials OUT to, one entry per vial, so the cleanup at
    #: the end knows exactly how many to bring home.
    moved_out: list[str] = []

    # ── the requirement itself ──────────────────────────────────────────────
    print("\n== PERMITTED: out of LN2 to a freezer, fridge or shelf ==")
    s, b = _req(
        "POST",
        "/allocations/transfer",
        token=token,
        json_body={
            "allocation_id": cells[0]["allocation_id"],
            "to_node_id": out_node["id"],
            "qty": 1,
            "evidence_id": _sign(token),
            "notes": "LOC-004 smoke: out of LN2 via /transfer",
        },
    )
    check("/transfer       LN2 box -> non-LN2 storage leaf", s == 201, b)
    if s == 201:
        moved_out.append(out_node["id"])

    s, b = _req(
        "POST",
        "/allocations/transfer-batch",
        token=token,
        json_body={
            "allocation_ids": [cells[1]["allocation_id"]],
            "to_node_id": out_node["id"],
            "qty": 1,
            "evidence_id": _sign(token),
            "notes": "LOC-004 smoke: out of LN2 via /transfer-batch",
        },
    )
    check("/transfer-batch LN2 box -> non-LN2 storage leaf", s == 201, b)
    if s == 201:
        moved_out.append(out_node["id"])

    s, b = _req(
        "POST",
        "/allocations/transfer-multi",
        token=token,
        json_body={
            "sources": [
                {
                    "node_id": box_a["id"],
                    "lot_id": lot_id,
                    "qty": 1,
                    "to_node_id": out_node["id"],
                    "cell_allocation_ids": [cells[2]["allocation_id"]],
                }
            ],
            "evidence_id": _sign(token),
            "notes": "LOC-004 smoke: out of LN2 via /transfer-multi",
        },
    )
    check("/transfer-multi LN2 box -> non-LN2 storage leaf", s == 201, b)
    if s == 201:
        moved_out.append(out_node["id"])

    # The requirement's own example of what LOC-003 blocked.
    spare = _cells_in(token, box_a["id"], item_id)
    if ambient is None:
        skip("LN2 box -> ambient warehouse shelf", "no shelf-kind (SHF) group here")
    elif ambient["id"] == out_node["id"]:
        check("LN2 box -> ambient warehouse shelf (covered above)", True)
    elif not spare:
        skip("LN2 box -> ambient warehouse shelf", "no vial left in the box")
    else:
        s, b = _req(
            "POST",
            "/allocations/transfer",
            token=token,
            json_body={
                "allocation_id": spare[0]["allocation_id"],
                "to_node_id": ambient["id"],
                "qty": 1,
                "evidence_id": _sign(token),
                "notes": "LOC-004 smoke: out of LN2 to an ambient shelf",
            },
        )
        check("/transfer       LN2 box -> ambient warehouse shelf", s == 201, b)
        if s == 201:
            moved_out.append(ambient["id"])

    # ── never blocked; asserted so the removal did not overshoot ────────────
    print("\n== PERMITTED: inside LN2 (unchanged) ==")
    spare = _cells_in(token, box_a["id"], item_id)
    if box_b is None:
        skip("LN2 box -> another LN2 box", "only one box in this environment")
    elif not spare:
        skip("LN2 box -> another LN2 box", "no vial left in the box")
    else:
        dest = _free_cells(token, box_b["id"], 1)
        s, b = _req(
            "POST",
            "/allocations/transfer",
            token=token,
            json_body={
                "allocation_id": spare[0]["allocation_id"],
                "to_node_id": box_b["id"],
                "qty": 1,
                "to_grid_row": dest[0]["grid_row"],
                "to_grid_col": dest[0]["grid_col"],
                "evidence_id": _sign(token),
            },
        )
        check("LN2 box -> another LN2 box", s == 201, b)

    spare = _cells_in(token, box_a["id"], item_id)
    free_a = _free_cells(token, box_a["id"], 1)
    if not spare or not free_a:
        skip("cell -> cell inside the same box", "no free cell or no vial")
    else:
        s, b = _req(
            "POST",
            "/allocations/transfer",
            token=token,
            json_body={
                "allocation_id": spare[0]["allocation_id"],
                "to_node_id": box_a["id"],
                "qty": 1,
                "to_grid_row": free_a[0]["grid_row"],
                "to_grid_col": free_a[0]["grid_col"],
                "evidence_id": _sign(token),
            },
        )
        check("cell -> cell inside the same box", s == 201, b)

    # ── the mixed signature: what used to be refused "Source 2: ..." ────────
    print("\n== PERMITTED: one signature crossing the boundary and not ==")
    spare = _cells_in(token, box_a["id"], item_id)
    out_rows = [r for i, r in _all_stock(token) if r["node_id"] == out_node["id"] and i == item_id]
    free_back = _free_cells(token, box_a["id"], 1)
    if not spare or not out_rows or not free_back:
        skip("mixed-leg signature", "need a vial in the box, one outside it, and a free cell")
    else:
        s, b = _req(
            "POST",
            "/allocations/transfer-multi",
            token=token,
            json_body={
                "sources": [
                    {
                        "node_id": box_a["id"],
                        "lot_id": lot_id,
                        "qty": 1,
                        "to_node_id": out_node["id"],
                        "cell_allocation_ids": [spare[0]["allocation_id"]],
                    },
                    {
                        "node_id": out_node["id"],
                        "lot_id": out_rows[0]["lot_id"],
                        "qty": 1,
                        "to_node_id": box_a["id"],
                        "to_cells": free_back,
                    },
                ],
                "evidence_id": _sign(token),
                "notes": "LOC-004 smoke: an LN2 leg and a non-LN2 leg, one signature",
            },
        )
        check("a signature carrying an LN2 leg AND a non-LN2 leg applies both", s == 201, b)

    # ── unaffected: neither end is LN2 ──────────────────────────────────────
    print("\n== UNAFFECTED: neither end is LN2 ==")
    other_out = next((n for n in outside if n["id"] != out_node["id"]), None)
    src_rows = [r for i, r in _all_stock(token) if r["node_id"] == out_node["id"] and i == item_id]
    if other_out is None or not src_rows:
        skip("non-LN2 -> non-LN2", "need two non-LN2 leaves and stock on one of them")
    else:
        s, b = _req(
            "POST",
            "/allocations/transfer-multi",
            token=token,
            json_body={
                "sources": [
                    {
                        "node_id": out_node["id"],
                        "lot_id": src_rows[0]["lot_id"],
                        "qty": 1,
                        "to_node_id": other_out["id"],
                    }
                ],
                "evidence_id": _sign(token),
                "notes": "LOC-004 smoke: boundary not crossed",
            },
        )
        check("non-LN2 leaf -> another non-LN2 leaf", s == 201, b)
        if s == 201 and out_node["id"] in moved_out:
            # The vial is still out of LN2, just somewhere else — retarget the
            # cleanup so it is still brought home.
            moved_out.remove(out_node["id"])
            moved_out.append(other_out["id"])

    # ── Issue and Transfer are still disjoint ───────────────────────────────
    print("\n== STILL DISJOINT: Issue is not a Transfer ==")
    s, cats = _req("GET", "/issues/destinations", token=token)
    scrap = cats if s == 200 and isinstance(cats, list) else []
    if not scrap:
        skip("issue out of an LN2 box", "no debit-and-gone location on file")
        skip("a transfer may not target a scrap location", "no debit-and-gone location on file")
    else:
        spare = _cells_in(token, box_a["id"], item_id)
        if not spare:
            skip("issue out of an LN2 box", "no vial left in the box")
        else:
            s, b = _req(
                "POST",
                "/issues",
                token=token,
                json_body={
                    "sources": [
                        {
                            "node_id": box_a["id"],
                            "lot_id": lot_id,
                            "qty": 1,
                            "cell_allocation_ids": [spare[0]["allocation_id"]],
                        }
                    ],
                    "destination_node_id": scrap[0]["node_id"],
                    "evidence_id": _sign(token, ISSUE_ACTION),
                    "notes": "LOC-004 smoke: Issue is not a transfer",
                },
            )
            check(
                f"issuing out of an LN2 box to '{scrap[0]['name']}' still works",
                s in (200, 201),
                f"{s} {b}",
            )
        # The property that makes "issued AND stored" unrepresentable is
        # structural — a transfer takes a storage node, an issue takes a scrap
        # location, and no node is both — and it must survive the cold-chain
        # removal untouched.
        spare = _cells_in(token, box_a["id"], item_id)
        if not spare:
            skip("a transfer may not target a scrap location", "no vial left in the box")
        else:
            s, b = _req(
                "POST",
                "/allocations/transfer",
                token=token,
                json_body={
                    "allocation_id": spare[0]["allocation_id"],
                    "to_node_id": scrap[0]["node_id"],
                    "qty": 1,
                    "evidence_id": _sign(token),
                },
            )
            check(
                "a transfer to a debit-and-gone location is still refused",
                s == 422 and _code(b) == "node_not_storable",
                f"{s} {b}",
            )
            if s == 422:
                check(
                    "that refusal still points the operator at Issue",
                    "Issue" in _message(b),
                    _message(b),
                )

    # ── put it back: the reverse direction, and the fixture cleanup ─────────
    print("\n== PERMITTED: back INTO LN2 (also the cleanup) ==")
    if not moved_out:
        skip("non-LN2 leaf -> LN2 box", "nothing was moved out to move back")
    for node_id in dict.fromkeys(moved_out):
        rows = [r for i, r in _all_stock(token) if r["node_id"] == node_id and i == item_id]
        if not rows:
            skip(f"return from {node_id[:8]} into the LN2 box", "no stock left there")
            continue
        qty = min(int(rows[0]["qty"]), moved_out.count(node_id))
        free = _free_cells(token, box_a["id"], qty)
        if len(free) < qty:
            skip(f"return {qty} vial(s) into the LN2 box", "not enough free cells")
            continue
        s, b = _req(
            "POST",
            "/allocations/transfer-multi",
            token=token,
            json_body={
                "sources": [
                    {
                        "node_id": node_id,
                        "lot_id": rows[0]["lot_id"],
                        "qty": qty,
                        "to_node_id": box_a["id"],
                        "to_cells": free,
                    }
                ],
                "evidence_id": _sign(token),
                "notes": "LOC-004 smoke: back into LN2 — the half that un-strands placed stock",
            },
        )
        check(f"non-LN2 leaf -> LN2 box ({qty} vial(s) returned)", s == 201, b)

    print(f"\n{STATS['passed']} passed, {len(FAILED)} failed, {len(SKIPPED)} skipped")
    for f in FAILED:
        print(f"  - FAIL {f}")
    for sk in SKIPPED:
        print(f"  - skip {sk}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
