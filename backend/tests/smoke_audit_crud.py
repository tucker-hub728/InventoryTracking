"""Ad-hoc smoke test for the audit + master-data CRUD round-trip.

Run from the project root after ``docker compose up``:

    python backend/tests/smoke_audit_crud.py

Verifies:
  * vendor PATCH writes an audit row with the right diff
  * vendor PATCH with no fields → 422 empty_patch
  * vendor PATCH duplicate name → 409 vendor_name_conflict
  * vendor DELETE soft-deletes (is_active=false) + writes audit row
  * vendor DELETE on already-inactive → idempotent (no new audit row)
  * location PATCH + DELETE round-trip
  * item PATCH (description) writes audit row
  * item DELETE rejected when stock > 0 (item_has_stock)
  * lot PATCH (status quarantined → released) is e-signed: writes audit
    row with signature + reason; un-signed edit → 422; replayed
    evidence → 401 reauth_evidence_replayed
  * lot DELETE rejected when lot has movements (lot_has_movements)
  * audit row is immutable — direct UPDATE on the DB raises
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
import uuid

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
    """Mint a fresh single-use e-signature evidence id for ``action``."""
    s, b = _req(
        "POST",
        "/auth/reauth",
        token=token,
        json_body={"action": action, "password": PASSWORD},
    )
    assert s == 200, b
    return b["evidence_id"]


def _audit_rows_for(subject_table: str, subject_id: str) -> list[dict]:
    """Read audit rows directly from Postgres via the backend container."""
    import subprocess

    sql = (
        "SELECT id::text, event_type, action, severity, diff::text, "
        "subject_label, occurred_at::text "
        "FROM audit.audit_events "
        f"WHERE subject_table = '{subject_table}' AND subject_id = '{subject_id}' "
        "ORDER BY occurred_at;"
    )
    out = subprocess.check_output(
        [
            "docker", "compose", "exec", "-T", "postgres",
            "psql", "-U", "cellready", "-d", "cellready_ims",
            "-At", "-F", "|", "-c", sql,
        ],
        text=True,
    )
    rows: list[dict] = []
    for line in out.strip().splitlines():
        if not line:
            continue
        parts = line.split("|")
        rows.append({
            "id": parts[0],
            "event_type": parts[1],
            "action": parts[2],
            "severity": parts[3],
            "diff": json.loads(parts[4]) if parts[4] else None,
            "subject_label": parts[5],
            "occurred_at": parts[6],
        })
    return rows


def main() -> int:
    token = _login()

    # ── VENDORS ───────────────────────────────────────────────────────
    suffix = uuid.uuid4().hex[:8]
    s, b = _req(
        "POST",
        "/vendors",
        token=token,
        json_body={"name": f"Smoke Vendor {suffix}", "notes": "initial"},
    )
    assert s == 201, b
    vid = b["id"]
    print(f"==> created vendor {vid[:8]} '{b['name']}'")

    # Empty patch → 422
    s, b = _req("PATCH", f"/vendors/{vid}", token=token, json_body={})
    assert s == 422 and b.get("code") == "empty_patch", b
    print("==> empty patch: 422 empty_patch")

    # Real patch → audit row written
    s, b = _req(
        "PATCH",
        f"/vendors/{vid}",
        token=token,
        json_body={"notes": "edited", "phone": "+1 555 0100"},
    )
    assert s == 200, b
    assert b["notes"] == "edited", b
    assert b["phone"] == "+1 555 0100", b
    print("==> patched vendor: notes + phone")

    rows = _audit_rows_for("meta.vendors", vid)
    update_rows = [r for r in rows if r["action"] == "updated"]
    assert update_rows, rows
    diff = update_rows[-1]["diff"]
    assert "notes" in diff and diff["notes"]["before"] == "initial", diff
    assert "phone" in diff and diff["phone"]["before"] is None, diff
    print(f"==> audit row written, diff fields = {sorted(diff.keys())}")

    # Duplicate name → 409
    # Create a second vendor and try to rename the first to its name.
    s, other = _req(
        "POST",
        "/vendors",
        token=token,
        json_body={"name": f"Smoke Vendor Other {suffix}"},
    )
    assert s == 201, other
    s, b = _req(
        "PATCH",
        f"/vendors/{vid}",
        token=token,
        json_body={"name": other["name"]},
    )
    assert s == 409 and b.get("code") == "vendor_name_conflict", b
    print("==> rename to taken name: 409 vendor_name_conflict")

    # DELETE → is_active=false + audit row
    s, b = _req("DELETE", f"/vendors/{vid}", token=token)
    assert s == 200, b
    assert b["is_active"] is False, b
    rows2 = _audit_rows_for("meta.vendors", vid)
    delete_rows = [r for r in rows2 if r["action"] == "deleted"]
    assert delete_rows and delete_rows[-1]["severity"] == "warning", delete_rows
    print("==> soft-deleted vendor + audit (severity=warning)")

    # Idempotent: second DELETE → 200, no new audit row
    s, b = _req("DELETE", f"/vendors/{vid}", token=token)
    assert s == 200 and b["is_active"] is False, b
    rows3 = _audit_rows_for("meta.vendors", vid)
    assert len(rows3) == len(rows2), (len(rows3), len(rows2))
    print("==> idempotent DELETE: no extra audit row")

    # ── LOCATIONS ─────────────────────────────────────────────────────
    s, locs = _req("GET", "/locations", token=token)
    assert s == 200 and locs, locs
    loc = locs[0]
    lid = loc["id"]
    s, b = _req(
        "PATCH",
        f"/locations/{lid}",
        token=token,
        json_body={"notes": f"audited at {suffix}"},
    )
    assert s == 200, b
    rows = _audit_rows_for("meta.locations", lid)
    assert any(r["action"] == "updated" for r in rows), rows
    print(f"==> patched location {loc['code']} + audit")

    # ── ITEMS ─────────────────────────────────────────────────────────
    s, items = _req("GET", "/items?limit=200", token=token)
    assert s == 200, items
    # Pick an item with stock so we can test the can't-delete-with-stock guard.
    with_stock = next(
        (i for i in items["items"] if float(i["qty_on_hand"]) > 0),
        None,
    )
    assert with_stock, "need an item with positive stock"
    iid = with_stock["id"]
    inum = with_stock["item_number"]
    orig_desc = with_stock["description"]

    # PATCH description → audit row
    s, b = _req(
        "PATCH",
        f"/items/{iid}",
        token=token,
        json_body={"description": f"{orig_desc} [smoke {suffix}]"},
    )
    assert s == 200, b
    print(f"==> patched item {inum} description")

    # DELETE rejected because stock > 0
    s, b = _req("DELETE", f"/items/{iid}", token=token)
    assert s == 422 and b.get("code") == "item_has_stock", b
    print("==> delete-with-stock blocked: 422 item_has_stock")

    rows = _audit_rows_for("app.items", iid)
    assert any(r["action"] == "updated" for r in rows), rows
    last_update = [r for r in rows if r["action"] == "updated"][-1]
    assert "description" in last_update["diff"], last_update["diff"]
    print("==> item audit row recorded description change")

    # Revert to keep the dataset tidy across re-runs.
    s, _ = _req(
        "PATCH",
        f"/items/{iid}",
        token=token,
        json_body={"description": orig_desc},
    )
    assert s == 200

    # ── LOTS ──────────────────────────────────────────────────────────
    s, lots = _req("GET", f"/items/{iid}/lots", token=token)
    assert s == 200 and lots, lots
    # Find a lot whose status we can flip.
    lot = lots[0]
    lot_id_ = lot["id"]
    orig_status = lot["status"]
    target_status = "quarantined" if orig_status != "quarantined" else "released"

    # Lot edits are e-signed (21 CFR Part 11): mint evidence + reason.
    ev = _reauth(token, "lot.update")
    s, b = _req(
        "PATCH",
        f"/lots/{lot_id_}",
        token=token,
        json_body={
            "status": target_status,
            "notes": f"smoke {suffix}",
            "evidence_id": ev,
            "reason": "Smoke test status correction",
        },
    )
    assert s == 200 and b["status"] == target_status, b
    print(f"==> patched lot {lot['lot_number']} status {orig_status}->{target_status}")

    # Un-signed lot edit (no evidence_id) is rejected at the schema edge.
    s, b = _req(
        "PATCH",
        f"/lots/{lot_id_}",
        token=token,
        json_body={"status": orig_status},
    )
    assert s == 422, b
    print("==> un-signed lot edit rejected: 422")

    # Replaying the just-consumed evidence is rejected.
    s, b = _req(
        "PATCH",
        f"/lots/{lot_id_}",
        token=token,
        json_body={
            "status": orig_status,
            "evidence_id": ev,
            "reason": "replay attempt",
        },
    )
    assert s == 401 and b.get("code") == "reauth_evidence_replayed", b
    print("==> replayed lot-edit evidence rejected: 401 reauth_evidence_replayed")

    # DELETE: lots that have movements can't be soft-deleted.
    s, b = _req("DELETE", f"/lots/{lot_id_}", token=token)
    assert s == 422 and b.get("code") == "lot_has_movements", b
    print("==> delete lot with movements blocked: 422 lot_has_movements")

    # Revert (signed, like any other lot edit).
    ev = _reauth(token, "lot.update")
    s, _ = _req(
        "PATCH",
        f"/lots/{lot_id_}",
        token=token,
        json_body={
            "status": orig_status,
            "evidence_id": ev,
            "reason": "Revert smoke-test change",
        },
    )
    assert s == 200

    # ── AUDIT IMMUTABILITY ────────────────────────────────────────────
    import subprocess

    out = subprocess.run(
        [
            "docker", "compose", "exec", "-T", "postgres",
            "psql", "-U", "cellready", "-d", "cellready_ims",
            "-c", "UPDATE audit.audit_events SET severity = 'danger' WHERE 1=2;",
        ],
        capture_output=True,
        text=True, check=False,
    )
    # The UPDATE matches no rows so the trigger doesn't fire — but a
    # non-zero match would. Try one that matches.
    out2 = subprocess.run(
        [
            "docker", "compose", "exec", "-T", "postgres",
            "psql", "-U", "cellready", "-d", "cellready_ims",
            "-c",
            (
                "DO $$ BEGIN "
                "UPDATE audit.audit_events SET severity = 'danger' "
                "WHERE id = (SELECT id FROM audit.audit_events LIMIT 1); "
                "RAISE EXCEPTION 'expected trigger to fire'; "
                "EXCEPTION WHEN OTHERS THEN "
                "RAISE NOTICE 'trigger fired: %', SQLERRM; "
                "END $$;"
            ),
        ],
        capture_output=True,
        text=True, check=False,
    )
    combined = (out2.stdout + out2.stderr).lower()
    assert "audit.audit_events is append-only" in combined, combined
    print("==> immutability trigger fires on UPDATE attempt")

    print()
    print("ALL AUDIT/CRUD SMOKE TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
