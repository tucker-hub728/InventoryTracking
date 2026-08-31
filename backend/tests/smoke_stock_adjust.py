"""Ad-hoc smoke test for the stock adjustment — the counting correction.

REQ-2026-08-13-CTL-002: an error is corrected by a transaction carrying an
explanatory comment and visible in the ledger, not by a silent edit. For a
counting discrepancy that transaction is ``POST /v1/allocations/adjust``: the
shelf holds 58 where the record says 60, so one signed ``adjustment`` moves the
``(lot × location)`` balance and the ledger row names the location.

No migration — ``adjustment`` has been in ``MOVEMENT_TYPES`` since the first
ledger migration, exempt from both the sign and the location CHECK (``issue01``).

Run from the project root after ``docker compose up``:

    SMOKE_EMAIL=you@example SMOKE_PASSWORD='…' \
        python backend/tests/smoke_stock_adjust.py

Verifies:
  * adjusting OUT lowers the (lot × location) balance by exactly the quantity
  * adjusting IN raises it back, so the pair is a round trip
  * the ledger row carries THIS location — an OUT names it as the source and an
    IN as the destination, and neither leaves it blank (the defect that sent the
    first CTL-002 attempt back)
  * the operator's signature comment reaches ``stock_movements.notes``
  * signing without a comment is accepted and leaves the note clean
  * the lot's ``ordered_qty`` is untouched: this corrects what is on the shelf,
    never what arrived
  * rejections: overdraw, zero quantity, stray cells on a flat location,
    a ticket minted for a different action, a replayed ticket
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

ADJUST_ACTION = "movement.adjustment"

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


def _sign(token: str, action: str = ADJUST_ACTION) -> str:
    s, b = _req(
        "POST",
        "/auth/reauth",
        token=token,
        json_body={"action": action, "password": PASSWORD},
    )
    assert s == 200, b
    return b["evidence_id"]


def _stock(token: str, item_id: str) -> list[dict]:
    s, b = _req("GET", f"/items/{item_id}/stock-locations", token=token)
    assert s == 200, b
    return b  # type: ignore[return-value]


def _ledger(token: str, item_id: str) -> list[dict]:
    s, b = _req("GET", f"/items/{item_id}/ledger", token=token)
    if s != 200:
        return []
    return b.get("items", b) if isinstance(b, dict) else b


def _find_flat_source(token: str) -> tuple[dict, dict]:
    """An item with stock at a FLAT location — a box would make the quantity a
    consequence of cell selection, which is its own smoke."""
    s, items = _req("GET", "/items?limit=200", token=token)
    assert s == 200, items
    rows = items.get("items", items) if isinstance(items, dict) else items
    for item in rows:
        for row in _stock(token, item["id"]):
            if not row.get("is_grid") and row.get("qty", 0) >= 2:
                return item, row
    print("!! no item has 2+ units at a flat location — place some stock first")
    sys.exit(2)


def main() -> None:
    token = _login()
    item, row = _find_flat_source(token)
    lot_id, node_id, start = row["lot_id"], row["node_id"], int(row["qty"])
    print(f"\n== {item['item_number']} · lot {row.get('lot_number')} @ {row['location']} ({start}) ==")

    def balance() -> int:
        for r in _stock(token, item["id"]):
            if r["lot_id"] == lot_id and r["node_id"] == node_id:
                return int(r["qty"])
        return 0

    def lot_ordered() -> int | None:
        s, b = _req("GET", f"/lots/{lot_id}", token=token)
        return b.get("ordered_qty") if s == 200 else None

    ordered_before = lot_ordered()

    # --- Out ------------------------------------------------------------
    print("\n-- adjust out 1 --")
    ev = _sign(token)
    s, b = _req(
        "POST",
        "/allocations/adjust",
        token=token,
        json_body={
            "lot_id": lot_id,
            "node_id": node_id,
            "direction": "out",
            "qty": 1,
            # The signature's comment reaches the API in the payload, the way
            # every signed dialog forwards it (``notes: evidence.comment``) —
            # the server does not read it off the ticket.
            "notes": "Cycle count — one vial broken in handling",
            "evidence_id": ev,
        },
    )
    check("out accepted", s == 201, b)
    check("qty_delta is negative", b.get("qty_delta") == -1, b)
    check("balance reported", b.get("qty_at_node") == start - 1, b)
    check("balance really moved", balance() == start - 1, balance())

    led = _ledger(token, item["id"])
    out_row = next((m for m in led if m.get("id") == b.get("movement_id")), None)
    check("ledger row exists", out_row is not None, b.get("movement_id"))
    if out_row:
        check("typed adjustment", out_row.get("movement_type") == "adjustment", out_row)
        # The whole point: an adjustment that names no location reads as stock
        # from nowhere. Out names this node as the source.
        check(
            "out names THIS location as source",
            out_row.get("from_location_node_id") == node_id,
            out_row,
        )
        check("out has no destination", out_row.get("to_location_node_id") is None, out_row)
        check(
            "signature comment reached the ledger",
            "broken in handling" in (out_row.get("notes") or ""),
            out_row.get("notes"),
        )

    # --- In (round trip, no comment) ------------------------------------
    print("\n-- adjust in 1, unsigned comment --")
    ev = _sign(token)
    s, b = _req(
        "POST",
        "/allocations/adjust",
        token=token,
        json_body={
            "lot_id": lot_id,
            "node_id": node_id,
            "direction": "in",
            "qty": 1,
            "evidence_id": ev,
        },
    )
    check("in accepted", s == 201, b)
    check("qty_delta is positive", b.get("qty_delta") == 1, b)
    check("round trip restored the balance", balance() == start, balance())

    led = _ledger(token, item["id"])
    in_row = next((m for m in led if m.get("id") == b.get("movement_id")), None)
    if in_row:
        check(
            "in names THIS location as destination",
            in_row.get("to_location_node_id") == node_id,
            in_row,
        )
        check("in has no source", in_row.get("from_location_node_id") is None, in_row)
        # The comment is optional on every e-signature (client 2026-06-29), so
        # a blank one must leave the note clean rather than trailing a dash.
        check(
            "no comment leaves a clean note",
            not (in_row.get("notes") or "").rstrip().endswith("—"),
            in_row.get("notes"),
        )

    # --- The lot itself is untouched ------------------------------------
    check(
        "lot ordered_qty untouched",
        lot_ordered() == ordered_before,
        (ordered_before, lot_ordered()),
    )

    # --- Rejections -----------------------------------------------------
    print("\n-- rejections --")
    ev = _sign(token)
    s, b = _req(
        "POST",
        "/allocations/adjust",
        token=token,
        json_body={
            "lot_id": lot_id,
            "node_id": node_id,
            "direction": "out",
            "qty": start + 1000,
            "evidence_id": ev,
        },
    )
    check("overdraw rejected", s in (409, 422), (s, b))
    check("named for the action", b.get("code") == "adjust_exceeds_available", b)

    ev = _sign(token)
    s, b = _req(
        "POST",
        "/allocations/adjust",
        token=token,
        json_body={
            "lot_id": lot_id,
            "node_id": node_id,
            "direction": "out",
            "qty": 0,
            "evidence_id": ev,
        },
    )
    check("zero quantity rejected", s == 422, (s, b))

    ev = _sign(token)
    s, b = _req(
        "POST",
        "/allocations/adjust",
        token=token,
        json_body={
            "lot_id": lot_id,
            "node_id": node_id,
            "direction": "out",
            "qty": 1,
            "cell_allocation_ids": ["00000000-0000-0000-0000-000000000000"],
            "evidence_id": ev,
        },
    )
    check("cells on a flat location rejected", s == 422, (s, b))

    ev = _sign(token, "movement.transfer")
    s, b = _req(
        "POST",
        "/allocations/adjust",
        token=token,
        json_body={
            "lot_id": lot_id,
            "node_id": node_id,
            "direction": "out",
            "qty": 1,
            "evidence_id": ev,
        },
    )
    check("ticket for another action rejected", s in (400, 401, 403, 409, 422), (s, b))
    check("named as an action mismatch", b.get("code") == "reauth_evidence_action_mismatch", b)

    ev = _sign(token)
    body = {
        "lot_id": lot_id,
        "node_id": node_id,
        "direction": "out",
        "qty": 1,
        "evidence_id": ev,
    }
    s, _ = _req("POST", "/allocations/adjust", token=token, json_body=body)
    assert s == 201
    s, b = _req("POST", "/allocations/adjust", token=token, json_body=body)
    check("replayed signature rejected", s in (400, 401, 403, 409, 422), (s, b))
    check("named as a replay", b.get("code") == "reauth_evidence_replayed", b)

    # Leave the balance as we found it.
    ev = _sign(token)
    _req(
        "POST",
        "/allocations/adjust",
        token=token,
        json_body={
            "lot_id": lot_id,
            "node_id": node_id,
            "direction": "in",
            "qty": 1,
            "evidence_id": ev,
        },
    )
    check("balance restored on exit", balance() == start, balance())

    print(f"\n{STATS['passed']} passed, {len(FAILED)} failed")
    if FAILED:
        for label in FAILED:
            print(f"  - {label}")
        sys.exit(1)


if __name__ == "__main__":
    main()
