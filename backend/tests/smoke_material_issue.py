"""Ad-hoc smoke test for the material-issue (debit-and-gone) write path.

Run from the project root after ``docker compose up`` and after applying the
``issue01`` migration:

    SMOKE_EMAIL=admin@cellready.dev SMOKE_PASSWORD=... \
        python backend/tests/smoke_material_issue.py

Verifies REQ-2026-08-04-TRX-001/002 and, just as importantly, the line between
Issue and Transfer that the client drew on 2026-08-13:

    Transfer → QC 1 › Freezer 1     still inventory, at a new node
    Issue    → QC 1                 gone from inventory

so the two are checked against each other rather than in isolation:

  * TRANSFER into a scrap location's freezer keeps TOTAL stock unchanged — the
    units move and stay tracked. A scrap location is still an ordinary location.
  * ISSUE to the location itself DROPS total stock, and leaves NOTHING at the
    destination (the critical assertion — "issued and also stored there" is the
    exact state the requirement rules out).
  * Issue to a SUB-LOCATION is refused (422 issue_target_not_location).
  * Issue to an unflagged location is refused (422 issue_target_not_scrap).
  * Transfer to the LOCATION is refused (422 node_not_storable) — the mirror of
    the case above, and together they are what makes the two destination sets
    disjoint.
  * Over-issuing is rejected (422 issue_exceeds_available).
  * Action-mismatch evidence is rejected (401).
  * A scrap location may be created with NO sub-types.

Needs a super admin (only they may create Storage locations) and at least one
item with >= 3 units at a single lot/location. Creates its own locations, named
with a "(smoke)" suffix; they are cheap to leave behind and are reused on re-run.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("SMOKE_BASE", "http://localhost:8000/v1")
# Creating a Storage location is super-admin-only (LOC-004), and this smoke
# creates its own, so the SUPER admin is the primary credential — same choice
# ``smoke_storage_template.py`` makes for the same reason.
EMAIL = os.environ.get("SMOKE_SA_EMAIL", "super.admin@cellready.dev")
PASSWORD = os.environ.get("SMOKE_SA_PASSWORD", "DevSuper_123!")
ISSUE_ACTION = "movement.material_issue"
TRANSFER_ACTION = "movement.transfer"

SCRAP_NAME = "QC Smoke Lab (smoke)"
NORMAL_NAME = "Normal Smoke Store (smoke)"
BARE_SCRAP_NAME = "Bare Scrap (smoke)"


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
    s, b = _req("GET", f"/issues/sources/{item_id}", token=token)
    assert s == 200, b
    return b  # type: ignore[return-value]


def _total_units(token: str, item_id: str) -> int:
    """Every tracked unit of the item, across every location.

    This is the number the requirement is about: a transfer must not change it,
    an issue must.
    """
    return sum(int(s["qty"]) for s in _sources(token, item_id))


def _storage_tree(token: str) -> list[dict]:
    s, b = _req("GET", "/location-nodes/freezer-tree", token=token)
    assert s == 200, b
    return b  # type: ignore[return-value]


def _find_category(token: str, name: str) -> dict | None:
    for room in _storage_tree(token):
        for child in room.get("children", []):
            if child.get("name") == name:
                return child
    return None


def _ensure_category(token: str, name: str, *, is_scrap: bool, groups: bool = True) -> dict:
    """Create the location if it isn't there; reuse it on a re-run."""
    existing = _find_category(token, name)
    if existing is not None:
        assert existing["is_scrap"] is is_scrap, (
            f"'{name}' already exists with is_scrap={existing['is_scrap']}; "
            f"the smoke expects {is_scrap}. Rename or remove it and re-run."
        )
        return existing
    s, b = _req(
        "POST",
        "/location-nodes/storage-categories",
        token=token,
        json_body={
            "name": name,
            "is_scrap": is_scrap,
            "shelf": groups,
            "refrigerator": False,
            "freezer": groups,
        },
    )
    assert s == 201, b
    return b


def _first_unit(token: str, category: dict) -> str | None:
    """A storage leaf inside the location — a unit under one of its groups.

    Created on demand: a freshly provisioned location has groups but no units,
    and a transfer needs somewhere real to land.
    """
    for group in category.get("children", []):
        s, b = _req("GET", f"/location-nodes/{group['id']}/children", token=token)
        assert s == 200, b
        if b:
            return b[0]["id"]
        s, b = _req(
            "POST",
            "/location-nodes",
            token=token,
            json_body={
                "node_type": "sub_location",
                "parent_id": group["id"],
                "code": "SMOKE-UNIT",
                "name": "Smoke Unit",
            },
        )
        if s == 201:
            return b["id"]
        if s == 409:  # already there under a different listing
            continue
        raise AssertionError((s, b))
    return None


def _find_issuable(token: str) -> tuple[dict, dict]:
    """An item with >= 3 units at one lot/location, plus that source row."""
    s, b = _req("GET", "/items?limit=200", token=token)
    assert s == 200, b
    items = b.get("items", b) if isinstance(b, dict) else b
    for it in items:
        for src in _sources(token, it["id"]):
            if src["qty"] >= 3:
                return it, src
    raise SystemExit(
        "No item has >=3 units at a single lot/location in dev. Receive and place "
        "some stock, then re-run this smoke."
    )


def _issue(token, *, sources, destination_node_id, action=ISSUE_ACTION):
    ev = _reauth(token, action)
    return _req(
        "POST",
        "/issues",
        token=token,
        json_body={
            "sources": sources,
            "destination_node_id": destination_node_id,
            "evidence_id": ev,
        },
    )


def _transfer(token, *, source, to_node_id, qty):
    ev = _reauth(token, TRANSFER_ACTION)
    return _req(
        "POST",
        "/allocations/transfer-multi",
        token=token,
        json_body={
            "sources": [
                {
                    "node_id": source["node_id"],
                    "lot_id": source["lot_id"],
                    "qty": qty,
                    "to_node_id": to_node_id,
                }
            ],
            "evidence_id": ev,
            "notes": "smoke transfer",
        },
    )


def main() -> int:
    token = _login()

    # --- The two locations under test ------------------------------------
    scrap = _ensure_category(token, SCRAP_NAME, is_scrap=True)
    normal = _ensure_category(token, NORMAL_NAME, is_scrap=False)
    print(f"==> scrap location:  {scrap['name']} ({scrap['id'][:8]}) is_scrap={scrap['is_scrap']}")
    print(f"==> normal location: {normal['name']} ({normal['id'][:8]})")

    # A scrap location may have NO sub-types — the location itself is the
    # destination, so there is nothing to put anywhere.
    bare = _ensure_category(token, BARE_SCRAP_NAME, is_scrap=True, groups=False)
    assert bare["is_scrap"] is True, bare
    assert not bare.get("children"), bare
    print("==> scrap location with no sub-types: created")

    # It must be offered as an issue destination, and the normal one must not.
    s, dests = _req("GET", "/issues/destinations", token=token)
    assert s == 200, dests
    dest_ids = {d["node_id"] for d in dests}
    assert scrap["id"] in dest_ids, dests
    assert normal["id"] not in dest_ids, dests
    print(f"==> /issues/destinations lists the scrap location only ({len(dests)} total)")

    item, pick = _find_issuable(token)
    total_before = _total_units(token, item["id"])
    print(f"==> item {item['item_number']}: {total_before} units tracked, source has {pick['qty']}")

    # --- TRANSFER into the scrap location's freezer ----------------------
    # A scrap location is still an ordinary location: stock moved into a unit
    # inside it stays tracked, and the TOTAL does not move.
    unit = _first_unit(token, scrap)
    if unit is not None:
        s, b = _transfer(token, source=pick, to_node_id=unit, qty=1)
        assert s == 201, b
        total_after_transfer = _total_units(token, item["id"])
        assert total_after_transfer == total_before, (total_after_transfer, total_before)
        print(f"==> transfer 1 into the scrap location's unit: total unchanged ({total_before})")
    else:
        print("==> (scrap location has no storage unit; transfer-in case skipped)")

    # --- Transfer to the LOCATION itself is refused ----------------------
    s, b = _transfer(token, source=pick, to_node_id=scrap["id"], qty=1)
    assert s == 422 and b.get("code") == "node_not_storable", (s, b)
    print("==> transfer to the location itself: 422 node_not_storable")

    # --- ISSUE to the location -------------------------------------------
    total_before_issue = _total_units(token, item["id"])
    live = next(s for s in _sources(token, item["id"]) if s["qty"] >= 2)
    s, b = _issue(
        token,
        sources=[{"node_id": live["node_id"], "lot_id": live["lot_id"], "qty": 2}],
        destination_node_id=scrap["id"],
    )
    assert s == 201, b
    assert b["total_qty"] == 2, b
    assert b["destination_node_id"] == scrap["id"], b
    assert b["destination_name"] == scrap["name"], b
    print(f"==> issue 2 to {b['destination_name']}: 201")

    # The whole point: the units left inventory.
    total_after_issue = _total_units(token, item["id"])
    assert total_after_issue == total_before_issue - 2, (total_after_issue, total_before_issue)
    print(f"==> total stock dropped: {total_before_issue} -> {total_after_issue}")

    # ...and did NOT land at the destination. If this ever fails, the material is
    # simultaneously issued and stored, which is the state TRX-001 forbids.
    s, allocs = _req("GET", f"/location-nodes/{scrap['id']}/allocations", token=token)
    assert s == 200, allocs
    assert allocs == [], allocs
    print("==> nothing allocated at the destination (debit-and-gone holds)")

    # The ledger records WHERE it went — "issued to QC 1" is a different
    # disposition from "issued to PD", so the destination has to survive.
    s, movements = _req(
        "GET", f"/allocations/movements?node_id={scrap['id']}", token=token
    )
    assert s == 200, movements
    issued = [m for m in movements if m["movement_type"] == "material_issue"]
    assert issued, movements
    assert issued[0]["to_location_node_id"] == scrap["id"], issued[0]
    assert issued[0]["qty_delta"] < 0, issued[0]
    print(f"==> ledger: {len(issued)} material_issue row(s) at the destination, qty_delta < 0")

    # --- The disposition log the location's page reads -------------------
    s, log = _req("GET", f"/issues/at/{scrap['id']}", token=token)
    assert s == 200, log
    assert log["total"] >= 1 and log["total_qty"] >= 2, log
    row = log["items"][0]
    # Positive magnitude, not the ledger's negative delta — "−2 units issued"
    # reads as a correction rather than a quantity.
    assert row["qty"] > 0, row
    assert row["item_number"], row
    assert row["issued_by"], row
    # The frozen path snapshot, so it still says where the material came from
    # after that shelf is renamed or removed.
    assert row["source_path"], row
    print(f"==> disposition log: {log['total']} row(s), {log['total_qty']} units, by {row['issued_by']}")

    # A TRANSFER into the location's own unit must NOT appear in the log — that
    # stock is still tracked, which is the opposite fact.
    if unit is not None:
        s, unit_log = _req("GET", f"/issues/at/{unit}", token=token)
        assert s == 200, unit_log
        assert unit_log["total"] == 0, unit_log
        print("==> the sub-location's own log is empty (a transfer is not an issue)")

    # A normal location has no log at all.
    s, nlog = _req("GET", f"/issues/at/{normal['id']}", token=token)
    assert s == 200 and nlog["total"] == 0, nlog
    print("==> a normal location's log is empty")

    # total / total_qty describe the WHOLE log, not the page.
    s, page = _req("GET", f"/issues/at/{scrap['id']}?limit=1&offset=0", token=token)
    assert s == 200, page
    assert len(page["items"]) == 1, page
    assert page["total"] == log["total"] and page["total_qty"] == log["total_qty"], page
    print("==> paging keeps the totals describing the whole log")

    # --- Issue to a SUB-LOCATION is refused ------------------------------
    if unit is not None:
        s, b = _issue(
            token,
            sources=[{"node_id": live["node_id"], "lot_id": live["lot_id"], "qty": 1}],
            destination_node_id=unit,
        )
        assert s == 422 and b.get("code") == "issue_target_not_location", (s, b)
        print("==> issue to a sub-location: 422 issue_target_not_location")

    # --- Issue to an UNFLAGGED location is refused -----------------------
    s, b = _issue(
        token,
        sources=[{"node_id": live["node_id"], "lot_id": live["lot_id"], "qty": 1}],
        destination_node_id=normal["id"],
    )
    assert s == 422 and b.get("code") == "issue_target_not_scrap", (s, b)
    print("==> issue to a normal location: 422 issue_target_not_scrap")

    # --- Over-issue rejected ---------------------------------------------
    # Above what is available but below MAX_QTY (1,000,000): a larger number
    # trips the schema's bound check first and the availability guard — the
    # thing under test — is never reached.
    live2 = next(s for s in _sources(token, item["id"]) if s["qty"] >= 1)
    s, b = _issue(
        token,
        sources=[
            {"node_id": live2["node_id"], "lot_id": live2["lot_id"], "qty": live2["qty"] + 1000}
        ],
        destination_node_id=scrap["id"],
    )
    assert s == 422 and b.get("code") == "issue_exceeds_available", (s, b)
    print("==> over-issue: 422 issue_exceeds_available")

    # --- Action-mismatch evidence rejected -------------------------------
    s, b = _issue(
        token,
        sources=[{"node_id": live2["node_id"], "lot_id": live2["lot_id"], "qty": 1}],
        destination_node_id=scrap["id"],
        action="movement.dispense",
    )
    assert s == 401 and b.get("code") == "reauth_evidence_action_mismatch", (s, b)
    print("==> wrong-action evidence: 401 action mismatch")

    print()
    print("ALL MATERIAL-ISSUE SMOKE TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
