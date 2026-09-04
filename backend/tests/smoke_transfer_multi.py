"""Ad-hoc smoke test for the inventory-workspace transfer.

REQ-2026-07-15-TRX-001, as refined by the 2026-07-22 amendment: a transfer can
be started from the item drill-down rather than from a location, so it draws
from as many (lot × location) sources as the item is spread across and the
operator signs ONCE. No migration — this exercises code only.

Run from the project root after ``docker compose up``:

    SMOKE_EMAIL=you@example SMOKE_PASSWORD='…' \
        python backend/tests/smoke_transfer_multi.py

Verifies:
  * GET /items/{id}/stock-locations answers for EVERY tier (not just built ones)
  * a multi-source transfer moves every source and lands it at ITS destination
  * each leg names its own destination, so one signature can send stock to
    several places at once — including a box and a shelf in the same request
  * exactly ONE signature covers the move, and the ledger gets a transfer
    out/in pair PER LEG, each recording its own from/to
  * lots never merge: one allocation per (destination, lot)
  * a box destination takes exactly as many cells as that leg's quantity
  * rejections: same location, mixed items, over-quantity, stray cells on a
    flat destination, missing cells on a box, two legs on one cell, replayed
    signature
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

# A dict rather than a counter + ``global`` — mutating it needs no declaration.
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


def _stock(token: str, item_id: str) -> list[dict]:
    s, b = _req("GET", f"/items/{item_id}/stock-locations", token=token)
    assert s == 200, b
    return b  # type: ignore[return-value]


def _leg(row, qty, to_node_id, to_cells=None):
    """One transfer leg: units of a lot at a location, and where they go."""
    leg = {"node_id": row["node_id"], "lot_id": row["lot_id"], "qty": qty, "to_node_id": to_node_id}
    if to_cells is not None:
        leg["to_cells"] = to_cells
    return leg


def _transfer(token, *, sources, evidence=None):
    body = {
        "sources": sources,
        "evidence_id": evidence or _sign(token),
        "notes": "smoke transfer",
    }
    return _req("POST", "/allocations/transfer-multi", token=token, json_body=body)


def _leaves(token: str, tree: str) -> list[dict]:
    """Flatten one area tree to its storage leaves, with breadcrumb paths."""
    s, b = _req("GET", f"/location-nodes/{tree}", token=token)
    assert s == 200, b
    out: list[dict] = []

    def walk(n, prefix):
        path = [*prefix, n["name"]]
        if n.get("can_store"):
            out.append({**n, "path": " › ".join(path)})
        for c in n.get("children", []):
            walk(c, path)

    for root in b:
        walk(root, [])
    return out


def _stocked_items(token: str) -> list[tuple[dict, list[dict]]]:
    """Every item that is stocked somewhere, with its stock rows."""
    s, b = _req("GET", "/items?limit=200", token=token)
    assert s == 200, b
    items = b.get("items", b) if isinstance(b, dict) else b
    out = []
    for it in items:
        rows = _stock(token, it["id"])
        if rows:
            out.append((it, rows))
    return out


def main() -> int:
    token = _login()
    print("==> logged in")

    # ── The new read endpoint serves every tier ──────────────────────────
    print("\n-- GET /items/{id}/stock-locations")
    stocked = _stocked_items(token)
    check("at least one item is stocked somewhere", bool(stocked), "seed some stock first")
    if not stocked:
        return 1

    tiers = {it.get("tier_type") for it, _ in stocked}
    print(f"  ({len(stocked)} stocked items across tiers {sorted(t or '?' for t in tiers)})")

    s, b = _req("GET", "/items/00000000-0000-0000-0000-000000000000/stock-locations", token=token)
    check("unknown item 404s", s == 404, (s, b))

    # ── Pick a subject: prefer an item spread over 2+ locations ──────────
    multi = [(it, rows) for it, rows in stocked if len({r["node_id"] for r in rows}) >= 2]
    item, rows = (multi or stocked)[0]
    # Only bulk (non-box) sources — a box source needs explicit vial ids, which
    # the dedicated box case below covers.
    bulk = [r for r in rows if not r["is_grid"]]
    if not bulk:
        print("!! no bulk (non-box) source in dev — skipping the flat-destination cases")
        return 1
    print(f"\n-- subject: {item['item_number']} ({len(rows)} stock rows)")

    # ── Multi-source transfer, signed once ───────────────────────────────
    print("\n-- multi-source transfer → flat destination")
    picks = bulk[:2]
    # Destinations = warehouse shelves we are not drawing from. Scoped to the
    # picks (not every stocked node) so repeated runs reuse the same shelves
    # instead of walking down the alphabet and leaving a trail behind them.
    pick_nodes = {r["node_id"] for r in picks}
    warehouse = [leaf for leaf in _leaves(token, "warehouse-tree") if leaf["id"] not in pick_nodes]
    check("found a warehouse destination outside the sources", bool(warehouse))
    if not warehouse:
        return 1
    dest = warehouse[0]
    print(f"   destination: {dest['path']}")

    sources = [_leg(r, 1, dest["id"]) for r in picks]
    moved = len(sources)
    before = {(r["lot_id"], r["node_id"]): r["qty"] for r in rows}

    s, b = _transfer(token, sources=sources)
    check(f"{moved}-source transfer accepted", s == 201, (s, b))
    if s != 201:
        return 1
    check(
        "one destination allocation per (destination, lot) — lots never merge",
        len(b) == len({p["lot_id"] for p in picks}),
        b,
    )
    check(
        "every destination allocation is at the target node",
        all(a["location_node_id"] == dest["id"] for a in b),
        b,
    )

    after_rows = _stock(token, item["id"])
    after = {(r["lot_id"], r["node_id"]): r["qty"] for r in after_rows}
    for p in picks:
        key = (p["lot_id"], p["node_id"])
        check(
            f"source {p['lot_id'][:8]}@{p['node_id'][:8]} decremented by 1",
            after.get(key, 0) == before[key] - 1,
            (before[key], after.get(key, 0)),
        )
    landed = sum(r["qty"] for r in after_rows if r["node_id"] == dest["id"])
    check(f"{moved} unit(s) landed at the destination", landed >= moved, landed)

    # ── The ledger: a pair per source, all under one signature ───────────
    print("\n-- ledger")
    s, mv = _req("GET", f"/movements?item_id={item['id']}&limit=50", token=token)
    check("movements readable", s == 200, (s, mv))
    entries = mv.get("items", mv) if isinstance(mv, dict) else mv
    outs = [m for m in entries if m["movement_type"] == "transfer_out"][:moved]
    ins = [m for m in entries if m["movement_type"] == "transfer_in"][:moved]
    check(f"{moved} transfer_out row(s) posted", len(outs) == moved, len(outs))
    check(f"{moved} transfer_in row(s) posted", len(ins) == moved, len(ins))
    evidences = {m.get("reauth_evidence_id") for m in outs + ins}
    check("all legs share ONE signature", len(evidences) == 1, evidences)

    # ── Rejections ───────────────────────────────────────────────────────
    # Re-pick from LIVE stock: the transfer above drew the picks down, and one
    # of the cases below consumes a unit too, so a stale row would 404 on a
    # depleted source instead of hitting the rule under test.
    print("\n-- rejections")
    # …and NOT the row sitting at ``dest`` — the transfer above put stock there,
    # so it now appears in the stock list and would trip the same-location guard
    # before any of the rules under test.
    candidates = [r for r in after_rows if not r["is_grid"] and r["node_id"] != dest["id"]]
    probe = next(
        (r for r in candidates if r["qty"] >= 2),
        next(iter(candidates), None),
    )
    check("a bulk source with stock remains for the rejection cases", probe is not None)
    if probe is None:
        return 1
    one = [_leg(probe, 1, dest["id"])]

    s, b = _transfer(token, sources=[_leg(probe, 1, probe["node_id"])])
    check(
        "source == destination rejected",
        s == 422 and b.get("code") == "transfer_same_location",
        (s, b),
    )

    s, b = _transfer(token, sources=[_leg(probe, 1, dest["id"], [{"grid_row": 1, "grid_col": 1}])])
    check(
        "cells on a flat destination rejected",
        s == 422 and b.get("code") == "cells_not_allowed",
        (s, b),
    )

    s, b = _transfer(token, sources=[_leg(probe, 10_000, dest["id"])])
    check(
        "over-quantity rejected",
        s == 422 and b.get("code") == "transfer_exceeds_available",
        (s, b),
    )

    other = next(
        (r for it2, rows2 in stocked if it2["id"] != item["id"] for r in rows2 if not r["is_grid"]),
        None,
    )
    if other is None:
        print("  (skip) mixed_items — only one stocked item in dev")
    else:
        s, b = _transfer(token, sources=[*one, _leg(other, 1, dest["id"])])
        check("two different items rejected", s == 422 and b.get("code") == "mixed_items", (s, b))

    ev = _sign(token)
    s, b = _transfer(token, sources=one, evidence=ev)
    check("a fresh signature is accepted", s == 201, (s, b))
    s, b = _transfer(token, sources=one, evidence=ev)
    check("replayed signature rejected", s in (401, 422), (s, b))

    s, b = _transfer(token, sources=one, evidence=_sign(token, "movement.dispense"))
    check("wrong-action signature rejected", s in (401, 422), (s, b))

    # ── Each leg names its OWN destination (client 2026-08-05) ───────────
    print("\n-- per-leg destinations")
    # Sources must not already sit on the two shelves used as destinations —
    # earlier runs pile stock onto them, and a source there trips the
    # same-location guard before the rule under test is reached.
    a, c = warehouse[0], warehouse[1]
    dest_nodes = {a["id"], c["id"]}
    live = _stock(token, item["id"])
    two_bulk = [
        r for r in live if not r["is_grid"] and r["qty"] >= 1 and r["node_id"] not in dest_nodes
    ][:2]
    if len(two_bulk) < 2 or len(warehouse) < 2:
        print("  (skip) need 2 bulk sources off the destination shelves")
    else:
        split = [_leg(two_bulk[0], 1, a["id"]), _leg(two_bulk[1], 1, c["id"])]
        s, b = _transfer(token, sources=split)
        check("two legs to two DIFFERENT shelves accepted", s == 201, (s, b))
        if s == 201:
            landed = {x["location_node_id"] for x in b}
            check(
                "stock landed at both destinations, not one",
                landed == {a["id"], c["id"]},
                landed,
            )
            s, mv = _req("GET", f"/movements?item_id={item['id']}&limit=10", token=token)
            entries = mv.get("items", mv) if isinstance(mv, dict) else mv
            ins = [m for m in entries if m["movement_type"] == "transfer_in"][:2]
            check(
                "the two in-legs record two different destinations",
                len({m.get("to_location_node_id") for m in ins}) == 2,
                [m.get("to_location_node_path") for m in ins],
            )
            check(
                "both legs still share ONE signature",
                len({m.get("reauth_evidence_id") for m in ins}) == 1,
                ins,
            )

    # ── ONE source split across two destinations ─────────────────────────
    # The case that forced this: a shelf holds 5 units and the box the operator
    # wants only has 4 free cells, so the same lot × location has to appear on
    # two legs going to two places.
    print("\n-- one source split across destinations")
    split_src = next(
        (
            r
            for r in _stock(token, item["id"])
            if not r["is_grid"]
            and r["qty"] >= 2
            and r["node_id"] not in {w["id"] for w in warehouse[:2]}
        ),
        None,
    )
    if split_src is None or len(warehouse) < 2:
        print("  (skip) need a bulk source with 2+ units and 2 spare shelves")
    else:
        avail = split_src["qty"]
        a, c = warehouse[0], warehouse[1]
        s, b = _transfer(token, sources=[_leg(split_src, 1, a["id"]), _leg(split_src, 1, c["id"])])
        check("same lot × location on two legs accepted", s == 201, (s, b))
        if s == 201:
            now = _stock(token, item["id"])
            left = next(
                (
                    r["qty"]
                    for r in now
                    if r["lot_id"] == split_src["lot_id"] and r["node_id"] == split_src["node_id"]
                ),
                0,
            )
            check("the split drew BOTH legs from the one source", left == avail - 2, (avail, left))
            check(
                "the two legs landed at the two different shelves",
                {x["location_node_id"] for x in b} == {a["id"], c["id"]},
                b,
            )
        # …and the split still can't take more than the source physically holds.
        s, b = _transfer(
            token,
            sources=[_leg(split_src, avail, a["id"]), _leg(split_src, 1, c["id"])],
        )
        check(
            "a split that exceeds the source is rejected",
            s in (404, 422),
            (s, b),
        )

    # ── Box destination: a leg's cell count must equal its own qty ───────
    print("\n-- box destination")
    # The source is a bulk shelf, so any box is a valid destination for it —
    # the same-location guard only bites when the source sits in that very box.
    ln2 = [leaf for leaf in _leaves(token, "ln2-tree") if leaf.get("grid_rows")]
    fat = next((r for r in _stock(token, item["id"]) if not r["is_grid"] and r["qty"] >= 2), None)
    box = next((leaf for leaf in ln2 if fat and leaf["id"] != fat["node_id"]), None)
    if box is None or fat is None:
        print("  (skip) need an LN2 box and a bulk source holding 2+ units")
    else:
        s, b = _transfer(token, sources=[_leg(fat, 2, box["id"], [{"grid_row": 1, "grid_col": 1}])])
        check(
            "1 cell for 2 units rejected",
            s == 422 and b.get("code") == "dest_count_mismatch",
            (s, b),
        )
        s, b = _transfer(token, sources=[_leg(fat, 2, box["id"])])
        check(
            "box destination without cells rejected",
            s == 422 and b.get("code") == "dest_cells_required",
            (s, b),
        )
        s, occupied = _req("GET", f"/location-nodes/{box['id']}/allocations", token=token)
        taken = {(a["grid_row"], a["grid_col"]) for a in occupied} if s == 200 else set()
        free = [
            {"grid_row": r, "grid_col": c}
            for r in range(1, int(box["grid_rows"]) + 1)
            for c in range(1, int(box["grid_cols"]) + 1)
            if (r, c) not in taken
        ][:3]
        if len(free) < 3:
            print("  (skip) box has fewer than 3 free cells")
        else:
            # Two legs aiming at the SAME cell must be refused before the DB's
            # unique index has to catch it.
            clash = [_leg(fat, 1, box["id"], [free[0]]), _leg(fat, 1, box["id"], [free[0]])]
            s, b = _transfer(token, sources=clash)
            check(
                "two legs on one cell rejected",
                s == 422 and "distinct" in json.dumps(b).lower(),
                (s, b),
            )

            s, b = _transfer(token, sources=[_leg(fat, 2, box["id"], free[:2])])
            check("2 units → 2 vials accepted", s == 201, (s, b))
            check("one allocation per vial", s == 201 and len(b) == 2, b)
            if s == 201:
                check(
                    "each vial holds exactly one unit",
                    all(a["qty"] == 1 and a["grid_row"] is not None for a in b),
                    b,
                )

            # Mixed destinations in ONE signature: a vial into the box, a unit
            # onto a shelf — the case per-leg destinations exist for.
            # Two DISTINCT bulk rows — a lot × location may appear only once per
            # request, so one row cannot feed both legs.
            spare = [*_stock(token, item["id"]), None, None]
            bulk_spare = [r for r in spare if r and not r["is_grid"] and r["qty"] >= 1]
            fat2, fat3 = ([*bulk_spare, None, None])[0], ([*bulk_spare, None, None])[1]
            if fat2 is None or fat3 is None or fat3["node_id"] == dest["id"]:
                print("  (skip) need two distinct bulk sources for the mixed case")
            else:
                s, occupied = _req("GET", f"/location-nodes/{box['id']}/allocations", token=token)
                taken = {(a["grid_row"], a["grid_col"]) for a in occupied} if s == 200 else set()
                cell = next(
                    (
                        {"grid_row": r, "grid_col": c}
                        for r in range(1, int(box["grid_rows"]) + 1)
                        for c in range(1, int(box["grid_cols"]) + 1)
                        if (r, c) not in taken
                    ),
                    None,
                )
                mixed = [
                    _leg(fat2, 1, box["id"], [cell]),
                    _leg(fat3, 1, dest["id"]),
                ]
                s, b = _transfer(token, sources=mixed)
                check("box AND shelf destinations in one signature", s == 201, (s, b))
                if s == 201:
                    check(
                        "one allocation in the box, one on the shelf",
                        {x["location_node_id"] for x in b} == {box["id"], dest["id"]},
                        b,
                    )

    print(f"\n==> {STATS['passed']} passed, {len(FAILED)} failed")
    for f in FAILED:
        print(f"    - {f}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
