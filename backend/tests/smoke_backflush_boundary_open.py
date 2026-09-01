"""Ad-hoc smoke test: kit leftovers may cross the LN2 boundary.

REQ-2026-08-13-LOC-004, resolved by the client on 2026-09-01. LOC-003 forced a
kit's leftovers back onto the same side of the liquid-nitrogen boundary as their
ORIGIN — material issued out of a tank had to go back into a tank, and material
issued from storage could not be returned into one. That half went in on
2026-08-20 to close a hole in the transfer rule (Issue is not a transfer, so
without it an LN2 vial could reach an ambient shelf via a kit with no transfer
event to catch).

The transfer rule itself is now withdrawn, so the hole it was plugging no longer
exists and this constraint goes with it. Keeping it would leave a second, hidden
wall: an operator allowed to *transfer* a vial from a tank to a freezer would
still be refused when handing the same vial back off the production floor.

    ticket:       "Remove this constraint. Assumption was made by CR team that
                   did not hold true upon challenge by Houston Team."
    Blane Larson: "The Cell Lines, Peptides and Testing Proteins are received and
                   stored in LN2 but need to be issued to a Freezer, Fridge or
                   Shelf to be consumed for Production, PD, QA or QC."

This file is the INVERSE of the ``smoke_backflush_origin.py`` it replaces: what
that script proved was refused, this one proves succeeds. The return destination
is still DEFAULTED to the line's source (``line.return_location_node_id =
line.source_location_node_id``), which is deliberate and unchanged — the ordinary
flow still puts material back where it came from. What is gone is the
ENFORCEMENT of that default, so an operator may now override it either way.

Still true and still asserted: a return must land on a PLACEABLE node
(``_require_placeable`` — a warehouse shelf, a freezer sub-location or an LN2
box), and a box destination still needs explicit free cells. Removing the
cold-chain rule must not have loosened either.

No migration — this exercises code only.

Run:

    docker exec cellready-backend python tests/smoke_backflush_boundary_open.py

Verifies, on a kit this script creates and cancels:
  * PERMITTED — an LN2-sourced line returns its leftovers to a non-LN2 storage
    leaf (freezer, fridge or shelf). This is the case LOC-003 refused with
    ``return_breaks_cold_chain``, and it is Blane's workflow.
  * PERMITTED — the same line returns leftovers to an LN2 box, with cells. Never
    blocked; asserted so the removal did not overshoot.
  * PERMITTED — a line sourced OUTSIDE LN2 returns into an LN2 box. This is the
    case LOC-003 refused with ``return_blocked_ln2_entry``. Skipped when no BOM
    component is stocked outside a box in this environment.
  * UNCHANGED — a return to a node that cannot hold stock is still refused
    (``node_not_placeable``), so the placeable check did not go with the rule.
  * UNCHANGED — cancelling the kit returns whatever is still on the floor.

NOTE — this MOVES REAL STOCK in dev, like every other smoke here. It creates its
own kit, issues into it, and cancels it at the end so the material goes back.
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


def _sign(token: str, action: str) -> str:
    s, b = _req(
        "POST", "/auth/reauth", token=token, json_body={"action": action, "password": PASSWORD}
    )
    assert s == 200, b
    return b["evidence_id"]


def _code(body: object) -> str:
    return body.get("code", "") if isinstance(body, dict) else ""


def _stock(token: str, item_id: str) -> list[dict]:
    s, b = _req("GET", f"/items/{item_id}/stock-locations", token=token)
    return b if s == 200 else []


def _free_cells(token: str, node_id: str, want: int = 1) -> list[dict]:
    """Up to ``want`` empty (row, col) coordinates in a box."""
    s, node = _req("GET", f"/location-nodes/{node_id}", token=token)
    if s != 200 or not node.get("grid_rows"):
        return []
    s, allocs = _req("GET", f"/location-nodes/{node_id}/allocations", token=token)
    taken = {
        (a.get("grid_row"), a.get("grid_col"))
        for a in (allocs if s == 200 else [])
        if a.get("is_active")
    }
    out: list[dict] = []
    for r in range(1, int(node["grid_rows"]) + 1):
        for c in range(1, int(node["grid_cols"]) + 1):
            if (r, c) not in taken:
                out.append({"grid_row": r, "grid_col": c})
                if len(out) == want:
                    return out
    return out


def main() -> int:
    token = _login()
    print("\n== find fixtures ==")

    # A built item and a production floor, both taken from an EXISTING kit so this
    # script does not need to know which item has a BOM or which areas are seeded
    # in this environment. A kit that exists is proof of a floor that works.
    s, kits = _req("GET", "/kits?limit=50", token=token)
    existing = (kits.get("items") if isinstance(kits, dict) else kits) or []
    built_item = None
    prod_node = None
    bom_items: list[str] = []
    for k in existing:
        s, detail = _req("GET", f"/kits/{k['id']}", token=token)
        if s == 200 and detail.get("production_location_node_id"):
            prod_node = detail["production_location_node_id"]
            built_item = detail.get("item_id")
            # The sample kit's lines ARE the built item's BOM components.
            bom_items = [ln["item_id"] for ln in detail.get("lines", []) if ln.get("item_id")]
            break
    check("a built item with a BOM exists (from an existing kit)", bool(built_item), existing[:1])
    check("a production area exists", prod_node is not None)

    s, targets = _req("GET", "/location-nodes/storage-targets", token=token)
    boxes = [n for n in targets if n["node_type"] == "box"]
    subs = [n for n in targets if n["node_type"] in ("sub_location", "shelf")]
    if not (built_item and prod_node and boxes and subs):
        print("\nFixtures missing — need a kit-able item, a production area,")
        print("an LN2 box and a non-LN2 storage leaf. Cannot run.")
        return 1

    # A BOM component stocked in an LN2 box: that box is the origin under test.
    # Restricted to the built item's OWN components — searching every item finds
    # whatever happens to be boxed and then 422s at issue time because the chosen
    # item is not on this kit at all.
    ln2_component = None
    out_component = None
    for comp in bom_items:
        for r in _stock(token, comp):
            if r["node_type"] == "box" and r.get("cells") and ln2_component is None:
                ln2_component = (comp, r)
            elif r["node_type"] in ("sub_location", "shelf") and int(r["qty"]) >= 1:
                if out_component is None:
                    out_component = (comp, r)
    check("a BOM component is stocked in an LN2 box", ln2_component is not None, bom_items)
    if ln2_component is None:
        print("  place one of this item's components into an LN2 box, then re-run")
        return 1
    comp_item, ln2_row = ln2_component
    shelf = subs[0]
    print(f"  built item : {built_item}")
    print(f"  production : {prod_node}")
    print(f"  LN2 source : {ln2_row['location']}")
    print(f"  non-LN2    : {shelf['name']}")
    print("  outside src: " + (out_component[1]["location"] if out_component else "(none)"))

    # Two vials if the box has them: one for the boundary-crossing return, one for
    # the return back into a box. One vial still exercises the case that matters.
    ln2_cells = ln2_row["cells"][:2]
    print(f"  issuing    : {len(ln2_cells)} vial(s) out of LN2")

    print("\n== create a kit and issue from LN2 ==")
    s, nxt = _req("GET", "/kits/next-number", token=token)
    kit_no = (nxt.get("kit_number") if isinstance(nxt, dict) else None) or "KIT-LOC004"
    s, kit = _req(
        "POST",
        "/kits",
        token=token,
        json_body={
            "kit_number": kit_no,
            "item_id": built_item,
            "target_qty": 1,
            "production_location_node_id": prod_node,
            "notes": "LOC-004 back-flush smoke",
        },
    )
    check("kit created", s == 201, f"{s} {kit}")
    if s != 201:
        return 1
    kit_id = kit["id"]

    def cancel(reason: str) -> tuple[int, object]:
        return _req(
            "POST",
            f"/kits/{kit_id}/cancel",
            token=token,
            json_body={"evidence_id": _sign(token, "kit.cancel"), "reason": reason},
        )

    line = next((ln for ln in kit.get("lines", []) if ln.get("item_id") == comp_item), None)
    if line is None:
        print("  the built item BOM has no line for the LN2-stocked component — cancelling")
        cancel("smoke cleanup")
        print("  pick a built item whose BOM includes the boxed component, then re-run")
        return 1

    # A second line, sourced OUTSIDE LN2, for the reverse-direction case. Only
    # when the environment happens to stock another component on a shelf.
    #
    # A ``consumed_in_kit`` line is EXCLUDED: media is discarded at close-out and
    # can never be handed back (KIT-003), so a return on one is refused by a
    # different rule entirely (``return_not_allowed_for_consumed``) and would
    # look like a cold-chain failure that is not one.
    out_line = None
    if out_component and out_component[0] != comp_item:
        out_line = next(
            (
                ln
                for ln in kit.get("lines", [])
                if ln.get("item_id") == out_component[0] and not ln.get("consumed_in_kit")
            ),
            None,
        )

    issue_lines = [
        {
            "line_id": line["id"],
            "sources": [
                {
                    "node_id": ln2_row["node_id"],
                    "lot_id": ln2_row["lot_id"],
                    "qty": len(ln2_cells),
                    "cell_allocation_ids": [c["allocation_id"] for c in ln2_cells],
                }
            ],
        }
    ]
    if out_line is not None:
        issue_lines.append(
            {
                "line_id": out_line["id"],
                "sources": [
                    {
                        "node_id": out_component[1]["node_id"],
                        "lot_id": out_component[1]["lot_id"],
                        "qty": 1,
                    }
                ],
            }
        )
    # Every other BOM line is issued at zero. A short issue is legal
    # (REQ-2026-07-22-KIT-007), but a line left out entirely still tries to move
    # its full need and 422s ``source_required``.
    named = {row["line_id"] for row in issue_lines}
    issue_lines += [
        {"line_id": ln["id"], "issued_qty": 0}
        for ln in kit.get("lines", [])
        if ln["id"] not in named
    ]

    s, b = _req("POST", f"/kits/{kit_id}/issue", token=token, json_body={"lines": issue_lines})
    check(
        f"issued {len(ln2_cells)} vial(s) out of the LN2 box to the floor",
        s in (200, 201),
        f"{s} {b}",
    )
    if s not in (200, 201):
        cancel("LOC-004 smoke cleanup")
        return 1

    def ret(line_id, node_id, cells=None):
        body: dict[str, object] = {"qty": 1, "return_location_node_id": node_id}
        if cells:
            body["return_cells"] = cells
        return _req("POST", f"/kits/{kit_id}/lines/{line_id}/return", token=token, json_body=body)

    # ── what did NOT change ─────────────────────────────────────────────────
    # Asserted BEFORE the returns below, while the line still holds material: an
    # empty line trips ``return_exceeds_on_floor`` first and would never reach
    # the placeable check.
    print("\n== UNCHANGED: a return must still land somewhere that holds stock ==")
    s, b = ret(line["id"], prod_node)
    check(
        "a return to the production floor is still refused",
        s == 422 and _code(b) == "node_not_placeable",
        f"{s} {b}",
    )

    # ── the requirement itself ──────────────────────────────────────────────
    print("\n== PERMITTED: LN2-sourced leftovers may leave LN2 ==")
    s, b = ret(line["id"], shelf["id"])
    check(f"back-flush to '{shelf['name']}' is permitted", s in (200, 201), f"{s} {b}")

    print("\n== PERMITTED: back to an LN2 box (unchanged) ==")
    if len(ln2_cells) < 2:
        skip("back-flush to an LN2 box", "only one vial was available to issue")
    else:
        dest_box = next((x for x in boxes if x["id"] != ln2_row["node_id"]), boxes[0])
        free = _free_cells(token, dest_box["id"], 1)
        check(f"'{dest_box['name']}' has a free cell", bool(free))
        if free:
            s, b = ret(line["id"], dest_box["id"], free)
            check(f"back-flush to '{dest_box['name']}' is permitted", s in (200, 201), f"{s} {b}")

    # ── the reverse direction ───────────────────────────────────────────────
    print("\n== PERMITTED: non-LN2-sourced leftovers may enter LN2 ==")
    if out_line is None:
        skip("shelf-sourced line returns into an LN2 box", "no BOM component stocked outside a box")
    else:
        dest_box = boxes[0]
        free = _free_cells(token, dest_box["id"], 1)
        if not free:
            skip("shelf-sourced line returns into an LN2 box", "no free cell in any box")
        else:
            s, b = ret(out_line["id"], dest_box["id"], free)
            check(
                f"a shelf-sourced line may return into '{dest_box['name']}'",
                s in (200, 201),
                f"{s} {b}",
            )

    print("\n== cleanup: cancel the kit ==")
    s, b = cancel("LOC-004 smoke cleanup")
    check("kit cancelled (any remaining floor stock returned)", s in (200, 201), f"{s} {b}")

    print(f"\n{STATS['passed']} passed, {len(FAILED)} failed, {len(SKIPPED)} skipped")
    for f in FAILED:
        print(f"  - FAIL {f}")
    for sk in SKIPPED:
        print(f"  - skip {sk}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
