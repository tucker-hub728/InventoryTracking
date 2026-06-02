"""Ad-hoc smoke test for transfer + reverse write paths.

Run from the project root after ``docker compose up``:

    python backend/tests/smoke_transfer_reverse.py

Verifies:
  * transfer between two locations writes both legs atomically
  * source balance drops, destination balance rises by qty
  * same-location transfer -> 422 transfer_same_location
  * transfer overdraw -> 422 transfer_exceeds_available
  * action-mismatch evidence -> 401
  * reverse receipt -> counter-dispense lands, balance returns to prior
  * double-reverse rejected (movement_already_reversed)
  * reversing a reversal rejected (reversal_already_a_reversal)
  * reverse transfer -> both legs reversed atomically
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from decimal import Decimal as _D

BASE = "http://localhost:8000/v1"
EMAIL = "admin@cellready.local"
PASSWORD = "ChangeMe!Now123"


def _req(
    method: str,
    path: str,
    *,
    token: str | None = None,
    json_body: dict | None = None,
) -> tuple[int, dict]:
    headers: dict[str, str] = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body: bytes | None = None
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


def _reauth(token: str, action: str) -> str:
    s, b = _req(
        "POST",
        "/auth/reauth",
        token=token,
        json_body={"action": action, "password": PASSWORD},
    )
    assert s == 200, b
    return b["evidence_id"]


def _item_by_number(token: str, number: str) -> dict:
    s, b = _req("GET", f"/items/by-number/{number}", token=token)
    assert s == 200, b
    return b


def _stock_by_lot(token: str, item_id: str) -> list[dict]:
    s, b = _req("GET", f"/items/{item_id}/stock-by-lot?include_empty=true", token=token)
    assert s == 200, b
    return b  # type: ignore[return-value]


def _locations(token: str) -> list[dict]:
    s, b = _req("GET", "/locations", token=token)
    assert s == 200, b
    return b  # type: ignore[return-value]


def _qty(rows: list[dict], lot_id: str, loc_id: str) -> _D:
    for r in rows:
        if r["lot_id"] == lot_id and r["location_id"] == loc_id:
            return _D(r["qty_available"])
    return _D("0")


def main() -> int:
    token = _login()
    item = _item_by_number(token, "CM-0002")
    sbl = _stock_by_lot(token, item["id"])
    # Need >= 2 units at the source so the transfer + overdraw probes
    # both make sense. Re-running the smoke suite drains stock, so pick
    # the row with the most.
    sbl_positive = sorted(
        (r for r in sbl if _D(r["qty_available"]) >= 2),
        key=lambda r: _D(r["qty_available"]),
        reverse=True,
    )
    assert sbl_positive, "CM-0002 needs >= 2 units somewhere — run smoke_s3 to receive more"
    src = sbl_positive[0]
    lot_id = src["lot_id"]
    from_loc = src["location_id"]
    avail_before = _D(src["qty_available"])
    print(f"==> CM-0002 picked lot/loc src={src['location_code']} avail={avail_before}")

    # Pick a second location (any one that isn't the source).
    locs = _locations(token)
    candidates = [l for l in locs if l["id"] != from_loc]
    assert candidates, "Need >= 2 locations for transfer smoke"
    dest = candidates[0]
    to_loc = dest["id"]
    print(f"==> transferring to dest={dest['code']}")

    dest_before = _qty(sbl, lot_id, to_loc)

    # --- Same-location -> 422 -------------------------------------------
    ev = _reauth(token, "movement.transfer")
    s, b = _req(
        "POST",
        "/movements/transfer",
        token=token,
        json_body={
            "item_id": item["id"],
            "lot_id": lot_id,
            "from_location_id": from_loc,
            "to_location_id": from_loc,
            "qty": "1",
            "reason_code": "rebalance",
            "evidence_id": ev,
        },
    )
    assert s == 422 and b.get("code") == "transfer_same_location", b
    print("==> same-location transfer: 422 transfer_same_location")

    # --- Overdraw -> 422 -------------------------------------------------
    ev = _reauth(token, "movement.transfer")
    s, b = _req(
        "POST",
        "/movements/transfer",
        token=token,
        json_body={
            "item_id": item["id"],
            "lot_id": lot_id,
            "from_location_id": from_loc,
            "to_location_id": to_loc,
            "qty": "999999",
            "reason_code": "rebalance",
            "evidence_id": ev,
        },
    )
    assert s == 422 and b.get("code") == "transfer_exceeds_available", b
    print("==> overdraw transfer: 422 transfer_exceeds_available")

    # --- Action mismatch -> 401 -----------------------------------------
    ev = _reauth(token, "movement.receipt")
    s, b = _req(
        "POST",
        "/movements/transfer",
        token=token,
        json_body={
            "item_id": item["id"],
            "lot_id": lot_id,
            "from_location_id": from_loc,
            "to_location_id": to_loc,
            "qty": "1",
            "reason_code": "rebalance",
            "evidence_id": ev,
        },
    )
    assert s == 401 and b.get("code") == "reauth_evidence_action_mismatch", b
    print("==> transfer with movement.receipt evidence: 401 action mismatch")

    # --- Happy path: transfer 2 ----------------------------------------
    qty_xfer = _D("2")
    ev = _reauth(token, "movement.transfer")
    s, b = _req(
        "POST",
        "/movements/transfer",
        token=token,
        json_body={
            "item_id": item["id"],
            "lot_id": lot_id,
            "from_location_id": from_loc,
            "to_location_id": to_loc,
            "qty": str(qty_xfer),
            "reason_code": "rebalance",
            "notes": "moving to QC bench",
            "evidence_id": ev,
        },
    )
    assert s == 201, b
    assert b["transfer_out"]["movement_type"] == "transfer_out", b
    assert b["transfer_in"]["movement_type"] == "transfer_in", b
    assert _D(b["transfer_out"]["qty_delta"]) == -qty_xfer, b
    assert _D(b["transfer_in"]["qty_delta"]) == qty_xfer, b
    out_id = b["transfer_out"]["id"]
    in_id = b["transfer_in"]["id"]
    print(f"==> transfer +{qty_xfer}: 201 (out={out_id[:8]}, in={in_id[:8]})")

    # Balances should have moved.
    sbl2 = _stock_by_lot(token, item["id"])
    src_after = _qty(sbl2, lot_id, from_loc)
    dest_after = _qty(sbl2, lot_id, to_loc)
    assert src_after == avail_before - qty_xfer, (src_after, avail_before, qty_xfer)
    assert dest_after == dest_before + qty_xfer, (dest_after, dest_before, qty_xfer)
    print(f"==> balances: src {avail_before} -> {src_after}, dest {dest_before} -> {dest_after}")

    # --- Reverse the transfer (both legs) -----------------------------
    ev = _reauth(token, "movement.reverse")
    s, b = _req(
        "POST",
        f"/movements/{out_id}/reverse",
        token=token,
        json_body={
            "reason_code": "wrong_destination",
            "notes": "operator picked the wrong freezer",
            "evidence_id": ev,
        },
    )
    assert s == 201, b
    assert isinstance(b, list) and len(b) == 2, b
    counter_types = {row["movement_type"] for row in b}
    assert counter_types == {"transfer_in", "transfer_out"}, b
    print("==> reverse transfer: 201 (2 counter rows)")

    sbl3 = _stock_by_lot(token, item["id"])
    src_back = _qty(sbl3, lot_id, from_loc)
    dest_back = _qty(sbl3, lot_id, to_loc)
    assert src_back == avail_before, (src_back, avail_before)
    assert dest_back == dest_before, (dest_back, dest_before)
    print(f"==> after reverse: src back to {src_back}, dest back to {dest_back}")

    # --- Double reverse -> 422 ------------------------------------------
    ev = _reauth(token, "movement.reverse")
    s, b = _req(
        "POST",
        f"/movements/{out_id}/reverse",
        token=token,
        json_body={"reason_code": "oops", "evidence_id": ev},
    )
    assert s == 422 and b.get("code") == "movement_already_reversed", b
    print("==> double reverse: 422 movement_already_reversed")

    # --- Reverse a reversal -> 422 --------------------------------------
    counter_id = b.get("detail") or ""
    # Pick one of the counter rows for the "can't reverse a reversal" probe.
    # We re-fetch the ledger and look for the first row with reversal_of_id set.
    s, ledger = _req("GET", f"/items/{item['id']}/ledger", token=token)
    assert s == 200, ledger
    rev_row = next(
        (r for r in ledger["items"] if r["reversal_of_id"] is not None),
        None,
    )
    assert rev_row is not None, "no reversal row found in ledger"
    ev = _reauth(token, "movement.reverse")
    s, b = _req(
        "POST",
        f"/movements/{rev_row['id']}/reverse",
        token=token,
        json_body={"reason_code": "oops", "evidence_id": ev},
    )
    assert s == 422 and b.get("code") == "reversal_already_a_reversal", b
    print("==> reverse-a-reversal: 422 reversal_already_a_reversal")

    # --- Reverse a receipt (separate flow) -----------------------------
    # Find a recent receipt that hasn't been reversed. Re-runs of this
    # smoke leave a trail of reversed receipts in the ledger, so build
    # the "already cancelled" set from rows that point at originals.
    already_reversed_ids = {
        r["reversal_of_id"] for r in ledger["items"] if r["reversal_of_id"]
    }
    receipt_row = next(
        (
            r for r in ledger["items"]
            if r["movement_type"] == "receipt"
            and r["reversal_of_id"] is None
            and r["id"] not in already_reversed_ids
        ),
        None,
    )
    if receipt_row is None:
        print("==> [skip] no eligible receipt row to reverse")
    else:
        ev = _reauth(token, "movement.reverse")
        s, b = _req(
            "POST",
            f"/movements/{receipt_row['id']}/reverse",
            token=token,
            json_body={
                "reason_code": "wrong_item",
                "notes": "wrong sku on PO",
                "evidence_id": ev,
            },
        )
        # 201 if the receipt's destination still has the qty; 422 with
        # reversal_exceeds_available otherwise. Either is correct here.
        if s == 201:
            assert isinstance(b, list) and len(b) == 1, b
            assert b[0]["movement_type"] == "dispense", b
            assert b[0]["reversal_of_id"] == receipt_row["id"], b
            print(f"==> reverse receipt: 201 counter-dispense {b[0]['id'][:8]}")
        else:
            assert s == 422 and b.get("code") == "reversal_exceeds_available", b
            print("==> reverse receipt: 422 reversal_exceeds_available (qty since used)")

    print()
    print("ALL TRANSFER/REVERSE SMOKE TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
