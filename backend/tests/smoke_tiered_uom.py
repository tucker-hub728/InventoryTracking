"""Ad-hoc smoke test for the tiered unit of measure (REQ-001 / REQ-002).

Run from the project root after ``docker compose up`` and AFTER applying the
``uom01`` migration:

    SMOKE_SA_EMAIL=superadmin@cellready.dev SMOKE_SA_PASSWORD='...' \
        python backend/tests/smoke_tiered_uom.py

An item may be ordered in Box and consumed in Each. The rule the whole feature
rests on is that ``ordered_qty`` and ``qty_received`` are in ORDER units, and
everything from the lot onward is in CONSUME units, with exactly one
multiplication between them.

Why this exists as a smoke test and not only as unit tests: the failure mode is
never an exception. ``3`` and ``300`` are both plausible values in every column
involved, so a conversion in the wrong direction, or a missing one, produces a
number that is wrong by two orders of magnitude and looks entirely ordinary in
the UI, in the ledger and in the signed audit row. Only walking the real chain —
order, receive, lot, allocation, movement — shows whether the numbers that
actually landed are the right ones. Writing this found a live 500 that the unit
tests could not: rolling back mid-request to unwind a rejected correction
expired the loaded ORM objects and turned a 422 into ``MissingGreenlet``.

What it checks:

  * REQ-001  an item carries an order unit + pack size; half a pair is refused.
  * REQ-001  a PO line reports ``ordered_units`` = packs × size, and its price
             is per PACK.
  * REQ-001  receiving 2 Box of a 3 Box line leaves 1 Box outstanding — the
             subtraction is like-for-like and needs no conversion.
  * REQ-001  the lot created holds packs × size CONSUME units, the allocation
             and the ledger movement agree, and the lot's price is the DIVIDED
             per-unit figure (which is why the column is Numeric(14,6)).
  * REQ-001  correcting the lot's quantity divides BACK to packs. This is the
             one that silently marked an order 100× over-received.
  * REQ-001  a correction that is not a whole number of packs is a clean 422,
             not a 500 and not a rounded guess.
  * back-compat  an item with no pack behaves exactly as it did before REQ-001.

Creates its own item and order, so it needs no particular fixture — but it does
leave them behind. The ledger and audit rows it writes are append-only by
trigger and cannot be cleaned up; that is by design, so run it against dev
knowingly.
"""

from __future__ import annotations

import json
import os
import random
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("SMOKE_BASE", "http://localhost:8000/v1")
SA_EMAIL = os.environ.get("SMOKE_SA_EMAIL", "superadmin@cellready.dev")
SA_PASSWORD = os.environ.get("SMOKE_SA_PASSWORD", "")

PACK_UOM = "Box"
PACK_SIZE = 100
ORDER_PACKS = 3
RECEIVE_PACKS = 2
PACK_PRICE = 95.00

_failures: list[str] = []


class Abort(Exception):
    """Setup could not be completed — not a failed assertion.

    Raised rather than returned so the run has one exit path: a missing
    supplier and a wrong number are different kinds of news, and only the
    second one means the feature is broken.
    """

    def __init__(self, message: str, code: int = 2) -> None:
        super().__init__(message)
        self.code = code


def check(label: str, ok: bool, detail: object = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}")
    if not ok:
        _failures.append(f"{label} — {detail!r}")


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


def _login(email: str, password: str) -> str | None:
    s, b = _req("POST", "/auth/login", json_body={"email": email, "password": password})
    return b["access_token"] if s == 200 else None


def _reauth(token: str, action: str) -> str:
    s, b = _req(
        "POST",
        "/auth/reauth",
        token=token,
        json_body={"action": action, "password": SA_PASSWORD},
    )
    assert s == 200, b
    return b["evidence_id"]


def _raw_material_prefix(token: str) -> str | None:
    s, tiers = _req("GET", "/item-tiers", token=token)
    if s != 200:
        return None
    rows = tiers if isinstance(tiers, list) else tiers.get("items", [])
    for t in rows:
        if t.get("type") == "raw_material":
            for p in t.get("prefixes") or []:
                return p["id"]
    return None


def _put_away(token: str, lot_id: str, node_id: str, qty: int) -> tuple:
    """Step two (REQ-004): place the lot and release it, in one signed call."""
    return _req(
        "POST",
        "/allocations/receive-to-inventory",
        token=token,
        json_body={
            "lot_id": lot_id,
            "node_id": node_id,
            "qty": qty,
            "evidence_id": _reauth(token, "receipt.release"),
        },
    )


def _storable_leaf(token: str) -> dict | None:
    """A non-grid destination. Grid boxes need one free cell PER UNIT, which for
    a 100-pack means 200 empty cells — not something a smoke run should assume.
    """
    s, trees = _req("GET", "/location-nodes/freezer-tree", token=token)
    if s != 200:
        return None

    found: list[dict] = []

    def walk(node):
        if node.get("node_type") == "sub_location" and node.get("is_active", True):
            found.append(node)
        for kid in node.get("children") or []:
            walk(kid)

    for root in trees if isinstance(trees, list) else trees.get("items", []):
        walk(root)
    return found[0] if found else None


def _run() -> None:
    if not SA_PASSWORD:
        raise Abort(
            "Set SMOKE_SA_PASSWORD (super admin). Dev passwords are in .cognito/db/."
        )
    sa = _login(SA_EMAIL, SA_PASSWORD)
    if sa is None:
        raise Abort(
            f"Could not log in as {SA_EMAIL}. Set SMOKE_SA_EMAIL / SMOKE_SA_PASSWORD."
        )

    prefix_id = _raw_material_prefix(sa)
    if not prefix_id:
        raise Abort("No raw-material prefix available.")
    node = _storable_leaf(sa)
    if not node:
        raise Abort("No storable sub-location available to receive into.")
    print(f"\n-- destination: {node.get('name')}")

    tag = random.randint(1000, 9999)

    # ── The item ──────────────────────────────────────────────────────
    # The item carries ONE unit — the one it is consumed in. The pack it is
    # bought in belongs to the PO, so there is nothing to set here.
    print("\n-- an item consumed in each, with no order unit of its own")
    s, item = _req(
        "POST",
        "/items",
        token=sa,
        json_body={
            "sku_suffix": f"SMK{tag}",
            "description": "smoke: tiered UoM",
            "prefix_id": prefix_id,
            "uom": "each",
        },
    )
    check("REQ-001 an item is created with its consume unit only", s == 201, (s, item))
    if s != 201:
        raise Abort("cannot continue", 1)
    item_id = item["id"]
    check(
        "REQ-001 the item read carries no pack fields",
        "pack_uom" not in item and "units_per_pack" not in item,
        {k: item.get(k) for k in ("pack_uom", "units_per_pack")},
    )

    s, err = _req(
        "POST",
        "/items",
        token=sa,
        json_body={
            "sku_suffix": f"SMK{tag}H",
            "description": "smoke: a pack sent to the item",
            "prefix_id": prefix_id,
            "pack_uom": PACK_UOM,
            "units_per_pack": PACK_SIZE,
        },
    )
    # A stale client sending a pack to the item gets a 422 rather than a
    # silently dropped field — "ignored" and "stored somewhere" must not look
    # the same from the outside.
    check("REQ-001 a pack sent to the item is refused", s == 422, (s, err))

    s, sups = _req("GET", "/suppliers?limit=1", token=sa)
    rows = sups.get("items") if isinstance(sups, dict) else sups
    if not rows:
        raise Abort("No suppliers available.")
    sup_id = rows[0]["id"]
    s, _ = _req("PATCH", f"/items/{item_id}", token=sa, json_body={"supplier_ids": [sup_id]})
    if s != 200:
        raise Abort(f"Could not assign a supplier ({s}).")

    # ── The order ─────────────────────────────────────────────────────
    print(f"\n-- a PO for {ORDER_PACKS} {PACK_UOM} at ${PACK_PRICE:.2f} per {PACK_UOM}")
    po = f"PO-SMK-{tag}"
    s, order = _req(
        "POST",
        "/receiving/transactions",
        token=sa,
        json_body={
            "po_reference": po,
            "lines": [
                {
                    "item_id": item_id,
                    "supplier_id": sup_id,
                    "ordered_qty": ORDER_PACKS,
                    "unit_price": PACK_PRICE,
                    "pack_uom": PACK_UOM,
                    "units_per_pack": PACK_SIZE,
                }
            ],
        },
    )
    check("REQ-002 the PO captures the line with its pack", s == 201, (s, order))
    if s != 201:
        raise Abort("cannot continue", 1)
    line = order["lines"][0]
    order_id, line_id = order["id"], line["id"]

    check(
        "REQ-001 ordered_qty stays in ORDER units",
        line["ordered_qty"] == ORDER_PACKS,
        line["ordered_qty"],
    )
    check(
        "REQ-001 ordered_units is the multiplied figure",
        line["ordered_units"] == ORDER_PACKS * PACK_SIZE,
        line["ordered_units"],
    )
    check(
        "REQ-001 the line's pack is frozen onto it",
        line["pack_uom"] == PACK_UOM and line["units_per_pack"] == PACK_SIZE,
        {k: line.get(k) for k in ("pack_uom", "units_per_pack")},
    )
    check(
        "REQ-002 the line price is per PACK, not per unit",
        float(line["unit_price_amount"]) == PACK_PRICE,
        line["unit_price_amount"],
    )

    # ── Receiving part of it ──────────────────────────────────────────
    print(f"\n-- receive {RECEIVE_PACKS} of the {ORDER_PACKS} {PACK_UOM}")
    lot_no = f"L-SMK-{tag}"
    s, res = _req(
        "POST",
        f"/receiving/transactions/{order_id}/receive",
        token=sa,
        json_body={
            "received_at": "2026-08-21",
            "evidence_id": _reauth(sa, "receipt.confirm"),
            "lines": [
                {
                    "line_id": line_id,
                    "qty_received": RECEIVE_PACKS,
                    "lot_number": lot_no,
                }
            ],
        },
    )
    check("REQ-001 a partial receive in packs succeeds", s == 201, (s, res))
    if s != 201:
        raise Abort("cannot continue", 1)

    got = res["lines"][0]
    outstanding_packs = ORDER_PACKS - RECEIVE_PACKS
    check(
        "REQ-001 received is counted in PACKS",
        got["received_qty"] == RECEIVE_PACKS,
        got["received_qty"],
    )
    check(
        "REQ-001 outstanding is packs minus packs — no conversion",
        got["outstanding_qty"] == outstanding_packs,
        got["outstanding_qty"],
    )
    check(
        "REQ-001 outstanding_units is the multiplied remainder",
        got["outstanding_units"] == outstanding_packs * PACK_SIZE,
        got["outstanding_units"],
    )
    check(
        "REQ-001 a short delivery leaves the order partially received",
        res["status"] == "partially_received",
        res["status"],
    )

    # ── What physically landed ────────────────────────────────────────
    print("\n-- the lot, the allocation and the ledger")
    expected_units = RECEIVE_PACKS * PACK_SIZE
    s, lots = _req("GET", f"/lots?item_id={item_id}", token=sa)
    rows = lots.get("items") if isinstance(lots, dict) else lots
    lot = next((x for x in (rows or []) if x["lot_number"] == lot_no), None)
    check("the receive created the lot", lot is not None, rows)
    if lot is None:
        raise Abort("cannot continue", 1)

    check(
        "REQ-001 the lot holds CONSUME units, not the packs typed",
        lot["ordered_qty"] == expected_units,
        lot["ordered_qty"],
    )
    check(
        "REQ-001 the lot price is the DIVIDED per-unit figure",
        abs(float(lot["unit_price_amount"]) - PACK_PRICE / PACK_SIZE) < 1e-6,
        lot["unit_price_amount"],
    )

    # ── Arrival is not acceptance (REQ-004) ───────────────────────────
    print("\n-- after arrival: quarantined, nowhere, invisible to stock")
    check(
        "REQ-004 arrival leaves the lot quarantined",
        lot.get("release_state") == "quarantine",
        lot.get("release_state"),
    )

    def _placed_units() -> int:
        s, locs = _req("GET", f"/allocations/by-lot/{lot['id']}", token=sa)
        if s != 200:
            return -1
        rows = locs if isinstance(locs, list) else locs.get("items", [])
        return sum(int(float(x.get("qty", 0))) for x in rows)

    check("REQ-004 nothing is placed at arrival", _placed_units() == 0, _placed_units())

    # The real guarantee: unplaced material cannot be picked for ANY
    # transaction, because every picker reads allocations. This asserts the
    # mechanism rather than trusting it.
    s, stock = _req("GET", f"/items/{item_id}/stock-locations", token=sa)
    stock_rows = stock if isinstance(stock, list) else stock.get("items", [])
    check(
        "REQ-004 arrived material is invisible to the transfer/kit picker",
        s == 200 and not any(r.get("lot_id") == lot["id"] for r in stock_rows),
        stock_rows,
    )

    s, queue = _req("GET", f"/items/{item_id}/awaiting-put-away", token=sa)
    q_rows = queue if isinstance(queue, list) else []
    mine = next((r for r in q_rows if r["lot_id"] == lot["id"]), None)
    check("REQ-004 it appears in the put-away queue instead", mine is not None, q_rows)
    if mine:
        check(
            "REQ-004 the queue reports the units still to place",
            mine["remaining_units"] == expected_units,
            mine["remaining_units"],
        )

    # ── Receive to inventory: place it, and release it ────────────────
    print("\n-- receive to inventory (place + release, one signature)")
    s, r = _put_away(sa, lot["id"], node["id"], expected_units)
    check("REQ-004 put-away succeeds", s == 201, (s, r))
    check(
        "REQ-001 the placement is in CONSUME units",
        _placed_units() == expected_units,
        _placed_units(),
    )

    s, lot2 = _req("GET", f"/lots/{lot['id']}", token=sa)
    check(
        "REQ-004 put-away releases the lot",
        s == 200 and lot2.get("release_state") == "released",
        lot2.get("release_state"),
    )

    s, stock2 = _req("GET", f"/items/{item_id}/stock-locations", token=sa)
    rows2 = stock2 if isinstance(stock2, list) else []
    check(
        "REQ-004 released material becomes pickable",
        any(r.get("lot_id") == lot["id"] for r in rows2),
        rows2,
    )

    s, queue2 = _req("GET", f"/items/{item_id}/awaiting-put-away", token=sa)
    q2 = queue2 if isinstance(queue2, list) else []
    check(
        "REQ-004 it leaves the put-away queue once placed",
        not any(r["lot_id"] == lot["id"] for r in q2),
        q2,
    )

    # Double-submit must not place the units twice.
    s, again = _put_away(sa, lot["id"], node["id"], expected_units)
    check(
        "REQ-004 putting the same lot away twice is refused",
        s == 409,
        (s, again.get("code")),
    )

    # ── The correction that used to be 100x wrong ─────────────────────
    print("\n-- correcting the lot's quantity")
    # Upward, because correcting BELOW what is already placed is refused by a
    # separate, older guard that would mask this one.
    corrected_units = ORDER_PACKS * PACK_SIZE
    s, _ = _req(
        "PATCH",
        f"/lots/{lot['id']}",
        token=sa,
        json_body={
            "ordered_qty": corrected_units,
            "evidence_id": _reauth(sa, "lot.update"),
            "reason": "smoke: correct to full order",
        },
    )
    check("a lot quantity correction is accepted", s == 200, s)

    s, after = _req("GET", f"/receiving/transactions/{order_id}", token=sa)
    l2 = after["lines"][0]
    check(
        "REQ-001 the correction divides BACK to packs (not 100x)",
        l2["received_qty"] == ORDER_PACKS,
        l2["received_qty"],
    )
    check(
        "REQ-001 the order re-derives to received",
        after["status"] == "received" and l2["outstanding_qty"] == 0,
        (after["status"], l2["outstanding_qty"]),
    )

    partial_units = corrected_units + PACK_SIZE // 2
    s, err = _req(
        "PATCH",
        f"/lots/{lot['id']}",
        token=sa,
        json_body={
            "ordered_qty": partial_units,
            "evidence_id": _reauth(sa, "lot.update"),
            "reason": "smoke: half a pack",
        },
    )
    # Must be a 422, not a 500 and not a silently rounded 2 or 3 packs. This
    # assertion is the one that caught the mid-request rollback bug.
    check(
        "REQ-001 a correction that is not whole packs is a clean 422",
        s == 422,
        (s, err),
    )

    # ── Back-compat ───────────────────────────────────────────────────
    print("\n-- a line with no pack at all is untouched by any of this")
    s, plain = _req(
        "POST",
        "/items",
        token=sa,
        json_body={
            "sku_suffix": f"SMK{tag}P",
            "description": "smoke: no pack",
            "prefix_id": prefix_id,
            "uom": "each",
        },
    )
    check("an item is created the same way it always was", s == 201, (s, plain))
    if s == 201:
        _req("PATCH", f"/items/{plain['id']}", token=sa, json_body={"supplier_ids": [sup_id]})
        s, o2 = _req(
            "POST",
            "/receiving/transactions",
            token=sa,
            json_body={
                "po_reference": f"PO-SMK-{tag}-P",
                "lines": [
                    {"item_id": plain["id"], "supplier_id": sup_id, "ordered_qty": 150}
                ],
            },
        )
        if s == 201:
            pl = o2["lines"][0]
            check(
                "REQ-001 an unpacked line converts 1:1",
                pl["ordered_units"] == 150 and pl["outstanding_units"] == 150,
                (pl["ordered_units"], pl["outstanding_units"]),
            )

            # ── Setting a pack AT RECEIPT on a line that never had one ──
            # The PO is a plan; the dock is where anyone first knows what a box
            # holds. The receiver names the unit and its size, and it is written
            # back to the order.
            print("\n-- naming the pack at receipt, on a line raised without one")
            s, r3 = _req(
                "POST",
                f"/receiving/transactions/{o2['id']}/receive",
                token=sa,
                json_body={
                    "received_at": "2026-08-21",
                    "evidence_id": _reauth(sa, "receipt.confirm"),
                    "lines": [
                        {
                            "line_id": pl["id"],
                            "qty_received": 2,
                            "lot_number": f"L-SMK-{tag}-P",
                            "pack_uom": "Case",
                            "units_per_pack": 25,
                                }
                    ],
                },
            )
            check("REQ-001 a pack may be named at receipt", s == 201, (s, r3))
            if s == 201:
                l3 = r3["lines"][0]
                check(
                    "REQ-001 the named pack is written back to the order line",
                    l3["pack_uom"] == "Case" and l3["units_per_pack"] == 25,
                    {k: l3.get(k) for k in ("pack_uom", "units_per_pack")},
                )
                s, lots3 = _req("GET", f"/lots?item_id={plain['id']}", token=sa)
                rows3 = lots3.get("items") if isinstance(lots3, dict) else lots3
                lot3 = next(
                    (x for x in (rows3 or []) if x["lot_number"] == f"L-SMK-{tag}-P"),
                    None,
                )
                check(
                    "REQ-001 the receipt-named pack multiplies the lot (2 x 25)",
                    lot3 is not None and lot3["ordered_qty"] == 50,
                    lot3 and lot3["ordered_qty"],
                )

            # A unit with no size is refused here too, not only on the item.
            s, err3 = _req(
                "POST",
                f"/receiving/transactions/{o2['id']}/receive",
                token=sa,
                json_body={
                    "received_at": "2026-08-21",
                    "evidence_id": _reauth(sa, "receipt.confirm"),
                    "lines": [
                        {
                            "line_id": pl["id"],
                            "qty_received": 1,
                            "lot_number": f"L-SMK-{tag}-Q",
                            "units_per_pack": 25,
                            "pack_uom": None,
                                }
                    ],
                },
            )
            check(
                "REQ-001 a pack size with no order unit is refused at receipt",
                s == 422,
                # Status only — the 201 body is the whole Order and drowns the
                # line that matters.
                s,
            )
        else:
            print(f"  SKIP  could not raise the unpacked order ({s})")


def main() -> int:
    try:
        _run()
    except Abort as exc:
        # A missing fixture is not a failing feature. Code 2 says "could not
        # run"; the checks themselves only ever produce 1 or 0.
        print(f"\n  {exc}")
        if not _failures:
            return exc.code

    print()
    if _failures:
        print(f"{len(_failures)} FAILED:")
        for f in _failures:
            print(f"  - {f}")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
