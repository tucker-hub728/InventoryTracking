"""Ad-hoc smoke test for adjustment + discard write paths.

Run from the project root after ``docker compose up``:

    python backend/tests/smoke_adjust_discard.py

Verifies:
  * adjustment (+) bumps the lot/location balance
  * adjustment (-) reduces it
  * adjustment 0 is rejected
  * adjustment that would overdraw is rejected
  * discard reduces the balance and creates a movement_type=discard row
  * discard overdraw rejected
  * action-mismatch evidence rejected on each
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

from _smoke_creds import require_credentials

BASE = "http://localhost:8000/v1"
EMAIL, PASSWORD = require_credentials()

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
    s, b = _req(
        "POST", "/auth/login", json_body={"email": EMAIL, "password": PASSWORD}
    )
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
    s, b = _req("GET", f"/items/{item_id}/stock-by-lot", token=token)
    assert s == 200, b
    return b  # type: ignore[return-value]


def main() -> int:
    token = _login()
    item = _item_by_number(token, "CM-0002")
    sbl = _stock_by_lot(token, item["id"])
    assert sbl, "CM-0002 has no positive stock — run smoke_s3 or the receipt flow first"
    pick = sbl[0]
    lot_id = pick["lot_id"]
    loc_id = pick["location_id"]
    avail_before = float(pick["qty_available"])
    print(f"==> CM-0002 picked lot/loc: avail={avail_before}")

    # --- Adjustment +3 ----------------------------------------------------
    ev = _reauth(token, "movement.adjustment")
    s, b = _req(
        "POST",
        "/movements/adjustment",
        token=token,
        json_body={
            "item_id": item["id"],
            "location_id": loc_id,
            "lot_id": lot_id,
            "qty_delta": "3",
            "reason_code": "count_variance",
            "notes": "found 3 extra",
            "evidence_id": ev,
        },
    )
    assert s == 201, b
    assert b["movement_type"] == "adjustment", b
    from decimal import Decimal as _D
    assert _D(b["qty_delta"]) == _D("3"), b
    assert _D(b["qty_abs"]) == _D("3"), b
    print(f"==> adjustment +3: 201 (movement {b['id'][:8]})")

    # --- Adjustment -2 ----------------------------------------------------
    ev = _reauth(token, "movement.adjustment")
    s, b = _req(
        "POST",
        "/movements/adjustment",
        token=token,
        json_body={
            "item_id": item["id"],
            "location_id": loc_id,
            "lot_id": lot_id,
            "qty_delta": "-2",
            "reason_code": "count_variance",
            "evidence_id": ev,
        },
    )
    assert s == 201, b
    assert _D(b["qty_delta"]) == _D("-2"), b
    print("==> adjustment -2: 201")

    # --- Adjustment 0 → 422 -----------------------------------------------
    ev = _reauth(token, "movement.adjustment")
    s, b = _req(
        "POST",
        "/movements/adjustment",
        token=token,
        json_body={
            "item_id": item["id"],
            "location_id": loc_id,
            "lot_id": lot_id,
            "qty_delta": "0",
            "reason_code": "count_variance",
            "evidence_id": ev,
        },
    )
    assert s == 422 and b.get("code") == "adjustment_zero_delta", b
    print("==> adjustment 0: 422 adjustment_zero_delta")

    # --- Adjustment overdraw → 422 ---------------------------------------
    ev = _reauth(token, "movement.adjustment")
    s, b = _req(
        "POST",
        "/movements/adjustment",
        token=token,
        json_body={
            "item_id": item["id"],
            "location_id": loc_id,
            "lot_id": lot_id,
            "qty_delta": "-9999",
            "reason_code": "count_variance",
            "evidence_id": ev,
        },
    )
    assert s == 422 and b.get("code") == "adjustment_exceeds_available", b
    print("==> adjustment -9999: 422 adjustment_exceeds_available")

    # --- Action mismatch on adjustment -----------------------------------
    ev = _reauth(token, "movement.receipt")  # wrong action
    s, b = _req(
        "POST",
        "/movements/adjustment",
        token=token,
        json_body={
            "item_id": item["id"],
            "location_id": loc_id,
            "lot_id": lot_id,
            "qty_delta": "1",
            "reason_code": "count_variance",
            "evidence_id": ev,
        },
    )
    assert s == 401 and b.get("code") == "reauth_evidence_action_mismatch", b
    print("==> adjustment with movement.receipt evidence: 401 action mismatch")

    # --- Discard 1 vial (expired) ----------------------------------------
    ev = _reauth(token, "movement.discard")
    s, b = _req(
        "POST",
        "/movements/discard",
        token=token,
        json_body={
            "item_id": item["id"],
            "location_id": loc_id,
            "lot_id": lot_id,
            "qty": "1",
            "reason_code": "expired",
            "evidence_id": ev,
        },
    )
    assert s == 201, b
    assert b["movement_type"] == "discard", b
    assert _D(b["qty_delta"]) == _D("-1"), b
    print(f"==> discard 1: 201 (movement {b['id'][:8]})")

    # --- Discard overdraw → 422 -------------------------------------------
    ev = _reauth(token, "movement.discard")
    s, b = _req(
        "POST",
        "/movements/discard",
        token=token,
        json_body={
            "item_id": item["id"],
            "location_id": loc_id,
            "lot_id": lot_id,
            "qty": "999999",
            "reason_code": "expired",
            "evidence_id": ev,
        },
    )
    assert s == 422 and b.get("code") == "discard_exceeds_available", b
    print("==> discard 999999: 422 discard_exceeds_available")

    # --- Action mismatch on discard --------------------------------------
    ev = _reauth(token, "movement.dispense")
    s, b = _req(
        "POST",
        "/movements/discard",
        token=token,
        json_body={
            "item_id": item["id"],
            "location_id": loc_id,
            "lot_id": lot_id,
            "qty": "1",
            "reason_code": "damaged",
            "evidence_id": ev,
        },
    )
    assert s == 401 and b.get("code") == "reauth_evidence_action_mismatch", b
    print("==> discard with movement.dispense evidence: 401 action mismatch")

    # --- Final balance sanity --------------------------------------------
    sbl2 = _stock_by_lot(token, item["id"])
    row = next(
        (r for r in sbl2 if r["lot_id"] == lot_id and r["location_id"] == loc_id),
        None,
    )
    assert row is not None
    expected = avail_before + 3 - 2 - 1  # adj +3, adj -2, discard -1
    got = float(row["qty_available"])
    assert abs(got - expected) < 0.001, (got, expected)
    print(f"==> final balance: {avail_before} +3 -2 -1 = {expected} [match]")

    print()
    print("ALL ADJUST/DISCARD SMOKE TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
