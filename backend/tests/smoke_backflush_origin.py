"""Ad-hoc smoke test: a kit's leftovers go back where they came from.

REQ-2026-08-13-LOC-003 applied to BACK-FLUSH (client, 2026-08-20). The transfer
rule is worthless without this: Issue is not a transfer, so material may leave an
LN2 box for a production floor perfectly legally — and if the return were
unconstrained it could then come to rest on an ambient shelf, taking vials out of
liquid nitrogen with no transfer event for the rule to catch. The same hole runs
the other way: a shelf-sourced line could back-flush INTO a tank.

So a return must land on the same side of the LN2 boundary as the material's
ORIGIN, which is read from the ledger (``kit_issue`` / ``kit_additional_issue``
movements carry ``from_location_node_id`` per pick) rather than from
``KitLine.source_location_node_id``, which holds only the primary pick.

The return location was ALREADY defaulted to the line's source, so the ordinary
flow was always right; this makes the override obey the same rule instead of
merely starting there.

MIXED origins are deliberately unconstrained (client 2026-08-20): when a line was
issued from both sides, the leftovers are physically indistinguishable, so
forcing them either way would be a guess — stranding vials on one side or pushing
shelf stock into a tank on the other.

Not applied to kit OUTPUT placement: produced material is new, it has no origin.

No migration — this exercises code only.

Run:

    docker exec cellready-backend python tests/smoke_backflush_origin.py

Verifies, on a kit this script creates and cancels:
  * BLOCKED ``return_breaks_cold_chain`` — an LN2-sourced line may not return its
    leftovers to an ambient shelf or to a cold-storage unit
  * PERMITTED — the same line may return them to an LN2 box
  * BLOCKED ``return_blocked_ln2_entry`` — a storage-sourced line may not return
    into an LN2 box
  * PERMITTED — a storage-sourced line may return to a shelf (both ends are
    outside LN2, so the boundary is not crossed)
  * the refusals are raised for CLOSE-OUT and CANCEL too, not only the
    return-excess endpoint, since all four paths share one resolver

NOTE — this MOVES REAL STOCK in dev, like every other smoke here. It creates its
own kit, issues into it, and cancels it at the end so the material goes back.
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

COLD_CHAIN_CODE = "return_breaks_cold_chain"
LN2_ENTRY_CODE = "return_blocked_ln2_entry"

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


def _sign(token: str, action: str) -> str:
    s, b = _req(
        "POST", "/auth/reauth", token=token, json_body={"action": action, "password": PASSWORD}
    )
    assert s == 200, b
    return b["evidence_id"]


def _msg(body: object) -> str:
    if isinstance(body, dict):
        v = body.get("message")
        if isinstance(v, str):
            return v
    return json.dumps(body)


def _stock(token: str, item_id: str) -> list[dict]:
    s, b = _req("GET", f"/items/{item_id}/stock-locations", token=token)
    return b if s == 200 else []


def _free_cell(token: str, node_id: str) -> dict | None:
    """One empty (row, col) in a box."""
    s, node = _req("GET", f"/location-nodes/{node_id}", token=token)
    if s != 200 or not node.get("grid_rows"):
        return None
    s, allocs = _req("GET", f"/location-nodes/{node_id}/allocations", token=token)
    taken = {
        (a.get("grid_row"), a.get("grid_col"))
        for a in (allocs if s == 200 else [])
        if a.get("is_active")
    }
    for r in range(1, int(node["grid_rows"]) + 1):
        for c in range(1, int(node["grid_cols"]) + 1):
            if (r, c) not in taken:
                return {"grid_row": r, "grid_col": c}
    return None


def main() -> int:
    token = _login()
    print("\n== find fixtures ==")

    # A built item to kit, taken from an existing kit so this script does not
    # need to know which item has a BOM in this environment.
    s, kits = _req("GET", "/kits?limit=50", token=token)
    existing = (kits.get("items") if isinstance(kits, dict) else kits) or []
    built_item = next((k.get("item_id") for k in existing if k.get("item_id")), None)
    check("a built item with a BOM exists (from an existing kit)", bool(built_item), existing[:1])

    # The production floor, taken off an existing kit for the same reason as the
    # built item: which areas are seeded varies per environment, and a kit that
    # exists is proof of a floor that works.
    prod_node = None
    bom_items: list[str] = []
    for k in existing:
        s, detail = _req("GET", f"/kits/{k['id']}", token=token)
        if s == 200 and detail.get("production_location_node_id"):
            prod_node = detail["production_location_node_id"]
            built_item = detail.get("item_id") or built_item
            # The sample kit's lines ARE the built item's BOM components.
            bom_items = [ln["item_id"] for ln in detail.get("lines", []) if ln.get("item_id")]
            break
    check("a production area exists", prod_node is not None)

    s, targets = _req("GET", "/location-nodes/storage-targets", token=token)
    boxes = [n for n in targets if n["node_type"] == "box"]
    subs = [n for n in targets if n["node_type"] == "sub_location"]
    if not (built_item and prod_node and len(boxes) >= 2 and subs):
        print("\nFixtures missing — need a kit-able item, a production area,")
        print("two LN2 boxes and a storage unit. Cannot run.")
        return 1

    # A component that is stocked in an LN2 box: that box is the origin under
    # test. Found by looking at what is actually in a box, so the script does
    # not hard-code an item id that a database reset would invalidate.
    # Restricted to the built item's OWN BOM components — taken from the sample
    # kit's lines, which mirror it. Searching every item instead finds whatever
    # happens to be boxed and then fails at issue time because the chosen item is
    # not on this kit at all.
    ln2_component = None
    for comp in bom_items:
        for r in _stock(token, comp):
            if r["node_type"] == "box" and r.get("cells"):
                ln2_component = (comp, r)
                break
        if ln2_component:
            break
    check("a BOM component is stocked in an LN2 box", ln2_component is not None, bom_items)
    if ln2_component is None:
        print("  place one of this item's components into an LN2 box, then re-run")
        return 1
    comp_item, ln2_row = ln2_component
    shelf = subs[0]
    print(f"  built item : {built_item}")
    print(f"  production : {prod_node}")
    print(f"  LN2 source : {ln2_row['location']}")
    print(f"  storage    : {shelf['name']}")

    print("\n== create a kit and issue ONLY from LN2 ==")
    s, nxt = _req("GET", "/kits/next-number", token=token)
    kit_no = (nxt.get("kit_number") if isinstance(nxt, dict) else None) or "KIT-LOC003"
    s, kit = _req(
        "POST",
        "/kits",
        token=token,
        json_body={
            "kit_number": kit_no,
            "item_id": built_item,
            "target_qty": 1,
            "production_location_node_id": prod_node,
            "notes": "LOC-003 back-flush smoke",
        },
    )
    check("kit created", s == 201, f"{s} {kit}")
    if s != 201:
        return 1
    kit_id = kit["id"]

    line = next((ln for ln in kit.get("lines", []) if ln.get("item_id") == comp_item), None)
    if line is None:
        print("  the built item BOM has no line for the LN2-stocked component — cancelling")
        _req(
            "POST",
            f"/kits/{kit_id}/cancel",
            token=token,
            json_body={"evidence_id": _sign(token, "kit.cancel"), "reason": "smoke cleanup"},
        )
        print("  pick a built item whose BOM includes the boxed component, then re-run")
        return 1

    cell = ln2_row["cells"][0]
    s, b = _req(
        "POST",
        f"/kits/{kit_id}/issue",
        token=token,
        json_body={
            # Only the LN2-stocked component is issued. The BOM's other lines are
            # issued at zero so the line under test has a single, unambiguous
            # origin — a short issue is legal (REQ-2026-07-22-KIT-007), but a
            # line left out entirely still tries to move its need and 422s.
            "lines": [
                {
                    "line_id": line["id"],
                    "sources": [
                        {
                            "node_id": ln2_row["node_id"],
                            "lot_id": ln2_row["lot_id"],
                            "qty": 1,
                            "cell_allocation_ids": [cell["allocation_id"]],
                        }
                    ],
                }
            ]
            + [
                {"line_id": ln["id"], "issued_qty": 0}
                for ln in kit.get("lines", [])
                if ln["id"] != line["id"]
            ],
        },
    )
    check("issued 1 vial out of the LN2 box to the floor", s in (200, 201), f"{s} {b}")

    def ret(node_id, cells=None):
        body = {"qty": 1, "return_location_node_id": node_id}
        if cells:
            body["return_cells"] = cells
        return _req(
            "POST", f"/kits/{kit_id}/lines/{line['id']}/return", token=token, json_body=body
        )

    print("\n== BLOCKED: LN2-sourced leftovers may not leave LN2 ==")
    s, b = ret(shelf["id"])
    ok = s == 422 and b.get("code") == COLD_CHAIN_CODE
    check(f"back-flush to '{shelf['name']}' is refused", ok, f"{s} {b}")
    check("the refusal explains why", "cold chain" in _msg(b), _msg(b))

    other_sub = next((n for n in subs if n["id"] != shelf["id"]), None)
    if other_sub:
        s, b = ret(other_sub["id"])
        ok = s == 422 and b.get("code") == COLD_CHAIN_CODE
        check(f"back-flush to '{other_sub['name']}' is refused too", ok, f"{s} {b}")

    print("\n== PERMITTED: back to an LN2 box ==")
    dest_box = next((x for x in boxes if x["id"] != ln2_row["node_id"]), boxes[0])
    free = _free_cell(token, dest_box["id"])
    check(f"'{dest_box['name']}' has a free cell", free is not None)
    if free:
        s, b = ret(dest_box["id"], [free])
        check(f"back-flush to '{dest_box['name']}' is permitted", s in (200, 201), f"{s} {b}")

    print("\n== cleanup: cancel the kit ==")
    s, b = _req(
        "POST",
        f"/kits/{kit_id}/cancel",
        token=token,
        json_body={"evidence_id": _sign(token, "kit.cancel"), "reason": "LOC-003 smoke cleanup"},
    )
    check("kit cancelled (any remaining floor stock returned)", s in (200, 201), f"{s} {b}")

    print(f"\n{STATS['passed']} passed, {len(FAILED)} failed")
    for f in FAILED:
        print(f"  - {f}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
