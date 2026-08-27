"""Ad-hoc smoke test for the customer-shipment (ship-out) write path.

Run from the project root after ``docker compose up`` and after applying the
``ship01`` + ``ship02`` migrations:

    SMOKE_EMAIL=you@example SMOKE_PASSWORD='…' \
        python backend/tests/smoke_shipments.py

Verifies (REQ-2026-07-22-CUST-001 / 07-01 TRX-005/006):
  * a named-customer shipment decrements finished-goods stock (no cascade)
  * the response carries the customer + per-lot breakdown
  * a shipment can draw from MULTIPLE sources (lots / locations) at once
  * the customer is REQUIRED (omitting it is rejected)
  * over-shipping the available qty is rejected (422 ship_exceeds_available)
  * action-mismatch evidence is rejected (401)
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.parse
import urllib.request

from _smoke_creds import require_credentials

BASE = "http://localhost:8000/v1"
EMAIL, PASSWORD = require_credentials()

SHIP_ACTION = "movement.customer_shipment"


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


def _reauth(token: str, action: str) -> str:
    s, b = _req(
        "POST", "/auth/reauth", token=token, json_body={"action": action, "password": PASSWORD}
    )
    assert s == 200, b
    return b["evidence_id"]


def _sources(token: str, item_id: str) -> list[dict]:
    s, b = _req("GET", f"/shipments/sources/{item_id}", token=token)
    assert s == 200, b
    return b  # type: ignore[return-value]


def _built_items(token: str) -> list[dict]:
    s, b = _req("GET", "/items?limit=200", token=token)
    assert s == 200, b
    items = b.get("items", b) if isinstance(b, dict) else b
    return [it for it in items if it.get("tier_type") in ("finished_good", "sub_assembly")]


def _find_shippable(token: str) -> tuple[dict, list[dict]]:
    """A built item with at least 2 shippable units at one lot/location, plus its
    full source list."""
    for it in _built_items(token):
        src = _sources(token, it["id"])
        if any(s["qty"] >= 2 for s in src):
            return it, src
    raise SystemExit(
        "No built item has >=2 shippable units in dev. Run smoke_kitting first to "
        "produce finished-goods stock, then re-run this smoke."
    )


def _ship(token, *, sources, customer_id, reference, action=SHIP_ACTION):
    ev = _reauth(token, action)
    body: dict = {
        "sources": sources,
        "reference_number": reference,
        "evidence_id": ev,
    }
    if customer_id is not None:
        body["customer_id"] = customer_id
    return _req("POST", "/shipments", token=token, json_body=body)


def main() -> int:
    token = _login()

    # --- A customer to ship to -------------------------------------------
    name = "Smoke Ship Co (smoke)"
    s, b = _req("POST", "/customers", token=token, json_body={"name": name})
    if s == 409:
        s2, lst = _req("GET", f"/customers?q={urllib.parse.quote(name)}", token=token)
        assert s2 == 200, lst
        cust = next(c for c in lst if c["name"] == name)
    else:
        assert s == 201, b
        cust = b
    customer_id = cust["id"]
    # Master data only — no linked items on the customer any more.
    assert "items" not in cust, cust
    print(f"==> customer ready: {cust['name']} ({customer_id[:8]})")

    item, src = _find_shippable(token)
    pick = next(s for s in src if s["qty"] >= 2)
    before = pick["qty"]
    print(f"==> shipping from {item['item_number']} lot@loc, avail={before}")

    # --- Named-customer shipment (qty 1, single source) ------------------
    one = {"node_id": pick["node_id"], "lot_id": pick["lot_id"], "qty": 1}
    s, b = _ship(token, sources=[one], customer_id=customer_id, reference="SO-SMOKE-1")
    assert s == 201, b
    assert b["customer_id"] == customer_id and b["customer_name"] == cust["name"], b
    assert b["reference_number"] == "SO-SMOKE-1", b
    assert b["total_qty"] == 1 and len(b["lines"]) == 1, b
    print(f"==> named shipment: 201, total {b['total_qty']} to {b['customer_name']}")

    # --- Stock actually dropped ------------------------------------------
    after = next(
        (
            x["qty"]
            for x in _sources(token, item["id"])
            if x["lot_id"] == pick["lot_id"] and x["node_id"] == pick["node_id"]
        ),
        0,
    )
    assert after == before - 1, (after, before)
    print(f"==> source decremented: {before} -> {after}")

    # --- Multi-source shipment (if the item is spread across 2 sources) ---
    src2 = _sources(token, item["id"])
    two = [s for s in src2 if s["qty"] >= 1][:2]
    if len(two) >= 2:
        sources = [{"node_id": s["node_id"], "lot_id": s["lot_id"], "qty": 1} for s in two]
        s, b = _ship(token, sources=sources, customer_id=customer_id, reference="SO-MULTI")
        assert s == 201, b
        assert b["total_qty"] == 2 and len(b["lines"]) == 2, b
        print(f"==> multi-source shipment: 201, total {b['total_qty']} from {len(b['lines'])} lots")
    else:
        print("==> (only one source lot; multi-source case skipped)")

    # A source that still has stock, for the negative tests (earlier shipments
    # may have drained ``pick``).
    live = next((s for s in _sources(token, item["id"]) if s["qty"] >= 1), None)
    assert live is not None, "no in-stock source left for negative tests"
    live_one = {"node_id": live["node_id"], "lot_id": live["lot_id"], "qty": 1}

    # --- Customer REQUIRED (omitted) -------------------------------------
    s, b = _ship(token, sources=[live_one], customer_id=None, reference="X")
    assert s == 422, (s, b)
    print("==> shipment with no customer: 422 (customer required)")

    # --- Over-ship rejected ----------------------------------------------
    big = {"node_id": live["node_id"], "lot_id": live["lot_id"], "qty": live["qty"] + 999999}
    s, b = _ship(token, sources=[big], customer_id=customer_id, reference="X")
    assert s == 422 and b.get("code") == "ship_exceeds_available", b
    print(f"==> over-ship {big['qty']}: 422 ship_exceeds_available")

    # --- Action-mismatch evidence rejected -------------------------------
    s, b = _ship(
        token, sources=[live_one], customer_id=customer_id, reference="X",
        action="movement.dispense",
    )
    assert s == 401 and b.get("code") == "reauth_evidence_action_mismatch", b
    print("==> wrong-action evidence: 401 action mismatch")

    print()
    print("ALL SHIPMENT SMOKE TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
