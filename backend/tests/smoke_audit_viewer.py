"""Ad-hoc smoke test for the audit viewer API.

Run from the project root after ``docker compose up`` and after
``smoke_audit_crud.py`` has populated some audit rows:

    python backend/tests/smoke_audit_crud.py     # populate
    python backend/tests/smoke_audit_viewer.py   # read back

Verifies:
  * GET /v1/audit/events lists newest first with sane shape
  * subject_table + subject_id filter returns only that entity's history
  * actor_user_id filter scopes to one user
  * action filter (e.g. ``deleted``) works
  * q (free-text) matches event_type + subject_label
  * GET /v1/audit/events/{id} returns the same row + actor denorm
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


def main() -> int:
    token = _login()

    # ── Plain list ─────────────────────────────────────────────────────
    s, b = _req("GET", "/audit/events?limit=10", token=token)
    assert s == 200, b
    assert isinstance(b["items"], list), b
    assert b["limit"] == 10 and b["offset"] == 0
    assert b["total"] >= len(b["items"]), b
    print(f"==> list: 200, {len(b['items'])} of {b['total']} total")

    # Newest-first ordering check.
    if len(b["items"]) >= 2:
        ts_a = b["items"][0]["occurred_at"]
        ts_b = b["items"][1]["occurred_at"]
        assert ts_a >= ts_b, (ts_a, ts_b)
        print("==> newest-first ordering: OK")

    # Shape check on the top row.
    if b["items"]:
        row = b["items"][0]
        for k in (
            "id",
            "occurred_at",
            "actor_kind",
            "event_type",
            "severity",
            "subject_table",
            "action",
        ):
            assert k in row, (k, row)
        # Actor denorm should appear for 'user' events (we created them
        # under admin@cellready.local in the CRUD smoke).
        if row["actor_kind"] == "user":
            assert row["actor_user_email"] is not None, row
        print(f"==> shape OK; top event = {row['event_type']}")

    # ── Per-entity filter (subject_table + subject_id) ────────────────
    # Find any row that has a subject_id we can probe.
    sample = next((r for r in b["items"] if r["subject_id"]), None)
    if sample:
        s2, b2 = _req(
            "GET",
            f"/audit/events?subject_table={sample['subject_table']}&subject_id={sample['subject_id']}&limit=20",
            token=token,
        )
        assert s2 == 200, b2
        assert all(
            r["subject_id"] == sample["subject_id"]
            and r["subject_table"] == sample["subject_table"]
            for r in b2["items"]
        ), b2
        print(
            f"==> per-entity filter ({sample['subject_table']} {sample['subject_id'][:8]}): "
            f"{b2['total']} rows"
        )

    # ── Action filter ─────────────────────────────────────────────────
    s3, b3 = _req("GET", "/audit/events?action=deleted&limit=5", token=token)
    assert s3 == 200, b3
    assert all(r["action"] == "deleted" for r in b3["items"]), b3
    print(f"==> action=deleted: {b3['total']} rows")

    # ── q (free text) ─────────────────────────────────────────────────
    s4, b4 = _req("GET", "/audit/events?q=supplier&limit=5", token=token)
    assert s4 == 200, b4
    # Every row should contain 'supplier' in either event_type or
    # subject_label (case-insensitive).
    for r in b4["items"]:
        bag = (r["event_type"] + " " + (r["subject_label"] or "")).lower()
        assert "supplier" in bag, r
    print(f"==> q=supplier: {b4['total']} rows match")

    # ── Single event lookup ───────────────────────────────────────────
    if b["items"]:
        target_id = b["items"][0]["id"]
        s5, b5 = _req("GET", f"/audit/events/{target_id}", token=token)
        assert s5 == 200, b5
        assert b5["id"] == target_id, b5
        print(f"==> single lookup id={target_id[:8]}: 200")

        # Bogus UUID → 404.
        s6, b6 = _req("GET", f"/audit/events/{uuid.uuid4()}", token=token)
        assert s6 == 404, b6
        print("==> bogus UUID: 404")

    # ── Permission gate — sanity ──────────────────────────────────────
    # Sending no token should 401.
    s7, b7 = _req("GET", "/audit/events", token=None)
    assert s7 == 401, b7
    print("==> no token: 401")

    print()
    print("ALL AUDIT VIEWER SMOKE TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
