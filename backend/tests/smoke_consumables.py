"""Ad-hoc smoke test for consumables → Kanban → expiration.

Run from the project root after ``docker compose up`` and after applying the
``consum01`` migration:

    SMOKE_EMAIL=admin@cellready.dev SMOKE_PASSWORD=... \
        python backend/tests/smoke_consumables.py

Verifies (REQ-2026-07-01-TRX-003 / LOC-006 / LOC-008, TX Spec §4, 07-09
TRX-001/004/006, PRC-003):

  * a Kanban can be created under a production area, and ONLY there
  * issuing a consumable decrements the source shelf and posts a
    ``consumable_issue`` ledger row into the Kanban
  * a multi-lot issue produces ONE REGISTER ROW PER SOURCE LOT, each keeping
    its own expiration date (the case a single collapsed record gets wrong)
  * a lot with NO expiration date never flags — the PRC-003 N/A path
  * the warn / expired boundaries land on the right side of the date
  * acknowledging clears the flag, records the disposition, and still reports
    where and when the material was issued (TRX-006)
  * acknowledging is E-SIGNED (client 2026-08-12): unsigned is rejected, an
    issue-verb signature cannot be spent on it, and a signature bound to one
    register row cannot close out another (VR-006)
  * a non-consumable item is rejected (it belongs on a kit)
  * the production area itself is rejected as a destination
  * a consumable issue is not reversible by any back-flush path (TRX-004)
  * action-mismatch evidence is rejected (401)
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import date, timedelta

BASE = "http://localhost:8000/v1"
EMAIL = os.environ.get("SMOKE_EMAIL", "admin@cellready.local")
PASSWORD = os.environ.get("SMOKE_PASSWORD", "ChangeMe!Now123")
ISSUE_ACTION = "movement.consumable_issue"
ACK_ACTION = "consumable.expiry_check"

# [passed, failed] — a list so ``check`` mutates without a ``global`` statement
# (same idiom as smoke_kitting.py).
TALLY = [0, 0]


def check(label: str, ok: bool, detail: object = "") -> None:
    if ok:
        TALLY[0] += 1
        print(f"  PASS  {label}")
    else:
        TALLY[1] += 1
        print(f"  FAIL  {label} :: {detail}")


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


def _reauth(
    token: str,
    action: str,
    *,
    record_table: str | None = None,
    record_id: str | None = None,
) -> str:
    """Mint one signature. ``record_*`` binds it to the row being signed about
    (VR-006); unbound evidence still passes the action check, which is what the
    older flows rely on."""
    body: dict[str, object] = {"action": action, "password": PASSWORD}
    if record_table and record_id:
        body["record_table"] = record_table
        body["record_id"] = record_id
    s, b = _req("POST", "/auth/reauth", token=token, json_body=body)
    assert s == 200, b
    return b["evidence_id"]


def _production_area(token: str) -> dict:
    """The first seeded production area. Flat locations have their own list
    endpoint — the collection route has no GET."""
    s, b = _req("GET", "/location-nodes/flat?flat_category=production", token=token)
    assert s == 200, b
    rows = b if isinstance(b, list) else b.get("items", [])
    areas = [n for n in rows if n.get("is_active")]
    assert areas, "no production areas seeded — run scripts/seed_production.py"
    return areas[0]


def _consumable_item(token: str) -> dict | None:
    """A consumable with stock. Falls back to seeding its own if dev has none.

    Deliberately self-seeding: the expiry boundaries below are only meaningful
    against dates this test controls. Depending on whatever happens to be on a
    shelf makes the run non-deterministic, and dev currently has exactly one
    consumable with no stock at all.
    """
    s, b = _req("GET", "/items?limit=200", token=token)
    assert s == 200, b
    rows = b if isinstance(b, list) else b.get("items", [])
    consumables = [it for it in rows if it.get("is_consumable")]
    if not consumables:
        return None
    # Enough headroom for every issue this run makes. Runs accumulate, so top up
    # rather than seed-once: an earlier run leaves part-drained lots behind.
    for it in consumables:
        s2, srcs = _req("GET", f"/consumables/sources/{it['id']}", token=token)
        if s2 == 200 and sum(r["qty"] for r in srcs) >= MIN_HEADROOM:
            it["_sources"] = srcs
            return it
    item = consumables[0]
    if _seed_stock(token, item["id"]):
        s2, srcs = _req("GET", f"/consumables/sources/{item['id']}", token=token)
        if s2 == 200 and srcs:
            item["_sources"] = srcs
            return item
    return None


#: One stable station the issue sections reuse, created on first run only.
#: Issued rows cannot be deleted afterwards (the ledger is append-only and the
#: FK is RESTRICT), so a fresh Kanban per run would accumulate forever in every
#: location picker in the app.
FIXTURE_KANBAN = "Smoke Register"


def _fixture_kanban(token: str, area_id: str) -> dict | None:
    """The stable Kanban for issue tests — reused across runs, created once."""
    s, rows = _req("GET", f"/location-nodes/{area_id}/kanbans", token=token)
    if s == 200:
        for k in rows:
            if k["name"] == FIXTURE_KANBAN:
                return k
    s, made = _req(
        "POST",
        f"/location-nodes/{area_id}/kanbans",
        token=token,
        json_body={"name": FIXTURE_KANBAN},
    )
    return made if s == 201 else None


def _sources(token: str, item_id: str) -> list[dict]:
    """Re-read issuable stock. Called before each section that issues, because
    every issue drains the list and a stale row 404s as ``no_stock_at_location``
    — which would read as a bug in the endpoint rather than in the test."""
    s, rows = _req("GET", f"/consumables/sources/{item_id}", token=token)
    return rows if s == 200 else []


def _shelf(token: str) -> str | None:
    """Any free-storage shelf to place seeded lots onto."""
    s, b = _req("GET", "/location-nodes/storage-targets", token=token)
    if s != 200:
        return None
    rows = b if isinstance(b, list) else []
    shelves = [n for n in rows if n.get("node_type") == "shelf" and n.get("is_active")]
    return shelves[0]["id"] if shelves else None


#: Four lots covering every branch of ``flag_for``. Offsets are relative to
#: today, so the run stays correct whenever it is executed.
#: Units seeded per lot, and the total the run needs before it will skip
#: seeding. One run issues ~8 units; the margin covers a re-run against
#: part-drained lots left by the previous one.
SEED_QTY = 20
MIN_HEADROOM = 12

SEED_LOTS: tuple[tuple[str, int | None], ...] = (
    ("EXPIRED", -5),  # past the date        → expired
    ("WARN", 7),  # inside the 30-day window → warn
    ("FUTURE", 900),  # far out              → no flag
    ("NODATE", None),  # no expiry at all    → never flags (PRC-003)
)


def _expected_flag(offset: int | None, warn_days: int) -> str | None:
    """What ``flag_for`` must return for a lot seeded ``offset`` days out.

    Mirrors the server rule deliberately rather than importing it — the test is
    over HTTP, so re-deriving here is what makes it a check rather than a
    tautology. Boundaries: today or earlier is expired; exactly ``warn_days``
    out is already warning.
    """
    if offset is None:
        return None
    if offset <= 0:
        return "expired"
    return "warn" if offset <= warn_days else None


def _seed_stock(token: str, item_id: str) -> bool:
    """Create one lot per SEED_LOTS entry and place 5 units of each on a shelf.

    Uses the real endpoints (lot create + e-signed placement), so the seeded
    stock is indistinguishable from received stock — no direct DB writes.
    """
    node_id = _shelf(token)
    if node_id is None:
        print("  SEED  no shelf to place onto — skipping seed")
        return False
    stamp = uuid.uuid4().hex[:6].upper()
    made = 0
    for label, offset in SEED_LOTS:
        body: dict = {"lot_number": f"SMOKE-{label}-{stamp}"}
        if offset is not None:
            body["expiration_date"] = (date.today() + timedelta(days=offset)).isoformat()
        s, lot = _req("POST", f"/items/{item_id}/lots", token=token, json_body=body)
        if s != 201:
            print(f"  SEED  lot {label} failed: {s} {lot}")
            continue
        ev = _reauth(token, "movement.receipt")
        s, res = _req(
            "POST",
            "/allocations/place",
            token=token,
            json_body={
                "lot_id": lot["id"],
                "node_id": node_id,
                "qty": SEED_QTY,
                "evidence_id": ev,
                "notes": "smoke_consumables seed",
            },
        )
        if s not in (200, 201):
            print(f"  SEED  place {label} failed: {s} {res}")
            continue
        made += 1
    print(f"  SEED  created {made}/{len(SEED_LOTS)} lots x{SEED_QTY} units on a shelf")
    return made > 0


def _non_consumable_item(token: str) -> dict | None:
    s, b = _req("GET", "/items?limit=200", token=token)
    assert s == 200, b
    rows = b if isinstance(b, list) else b.get("items", [])
    for it in rows:
        if not it.get("is_consumable"):
            return it
    return None


def main() -> int:
    token = _login()
    area = _production_area(token)
    print(f"\nProduction area: {area['name']} ({area['id']})")

    # ── 1. Kanban creation ─────────────────────────────────────────────
    #
    # The throwaway created here is DELETED at the end of this section: it only
    # exists to prove the create / duplicate / wrong-parent rules, and a Kanban
    # per run would otherwise pile up in every location picker in the app. The
    # sections that issue stock reuse one stable station instead (_fixture_kanban).
    print("\n[1] Kanban stations (LOC-006)")
    name = f"Smoke Kanban {uuid.uuid4().hex[:6]}"
    s, throwaway = _req(
        "POST", f"/location-nodes/{area['id']}/kanbans", token=token, json_body={"name": name}
    )
    check("create Kanban under a production area", s == 201, (s, throwaway))
    if s != 201:
        print("\ncannot continue without a Kanban")
        return 1
    check("node_type is 'kanban'", throwaway.get("node_type") == "kanban", throwaway)
    check("parented to the area", throwaway.get("parent_id") == area["id"], throwaway)
    check(
        "code derived from the name", str(throwaway.get("code", "")).startswith("KAN-"), throwaway
    )

    s, b = _req(
        "POST", f"/location-nodes/{area['id']}/kanbans", token=token, json_body={"name": name}
    )
    check("duplicate name in the same area rejected", s == 409, (s, b))

    # A Kanban may not hang off another Kanban, only off a production area.
    s, b = _req(
        "POST",
        f"/location-nodes/{throwaway['id']}/kanbans",
        token=token,
        json_body={"name": "Nope"},
    )
    check(
        "Kanban under a non-production parent rejected",
        s == 422 and b.get("code") == "parent_not_production_area",
        (s, b),
    )

    # Nothing was ever issued into it, so the delete is not blocked by ledger
    # history — which is exactly why the issue sections below use a stable one.
    s, _ = _req("POST", f"/location-nodes/{throwaway['id']}/delete", token=token)
    if s not in (200, 204):
        s, _ = _req("DELETE", f"/location-nodes/{throwaway['id']}", token=token)
    check("throwaway Kanban cleaned up", s in (200, 204), s)

    kanban = _fixture_kanban(token, area["id"])
    if kanban is None:
        print("\ncannot continue without the fixture Kanban")
        return 1
    print(f"  fixture station: {kanban['name']}")

    # ── 2. Issue ───────────────────────────────────────────────────────
    print("\n[2] Issue to Kanban (TRX-003, TX Spec §4)")
    item = _consumable_item(token)
    if item is None:
        print("  SKIP  no consumable item with stock — seed one to exercise the issue path")
        print(f"\n{TALLY[0]} passed, {TALLY[1]} failed (issue path skipped)")
        return 1 if TALLY[1] else 0

    sources = item["_sources"]
    print(f"  item {item.get('item_number')} — {len(sources)} source(s)")
    src = sources[0]
    before_qty = src["qty"]
    take = 1

    ev = _reauth(token, ISSUE_ACTION)
    s, res = _req(
        "POST",
        "/consumables/issue",
        token=token,
        json_body={
            "sources": [{"node_id": src["node_id"], "lot_id": src["lot_id"], "qty": take}],
            "kanban_node_id": kanban["id"],
            "evidence_id": ev,
        },
    )
    check("issue accepted", s == 201, (s, res))
    if s == 201:
        check("total qty echoed", res.get("total_qty") == take, res)
        check("destination is the Kanban", res.get("kanban_node_id") == kanban["id"], res)

    s, after = _req("GET", f"/consumables/sources/{item['id']}", token=token)
    now_qty = next(
        (
            r["qty"]
            for r in after
            if r["lot_id"] == src["lot_id"] and r["node_id"] == src["node_id"]
        ),
        0,
    )
    check(
        "source shelf decremented (terminal — 07-09 TRX-001)",
        now_qty == before_qty - take,
        f"{before_qty} → {now_qty}",
    )

    # ── 3. Register + expiration ───────────────────────────────────────
    print("\n[3] Register & expiration (§4.2/§4.3, LOC-008)")
    s, reg = _req("GET", f"/consumables/issued?kanban_node_id={kanban['id']}", token=token)
    check("register lists the issue", s == 200 and len(reg) >= 1, (s, reg))
    row = reg[0] if reg else {}
    check("register keeps the issued-to location", row.get("kanban_node_id") == kanban["id"], row)
    check("register keeps who issued it", bool(row.get("issued_by")), row)

    # The N/A path: a lot with no expiration must never carry a flag (PRC-003).
    if row.get("expiration_date") is None:
        check("no expiration date ⇒ no flag (PRC-003)", row.get("flag") is None, row)
        check("no expiration date ⇒ no countdown", row.get("days_to_expiry") is None, row)
    else:
        exp = date.fromisoformat(row["expiration_date"])
        days = (exp - date.today()).days
        s, pol = _req("GET", "/consumables/expiry-policy", token=token)
        warn = pol.get("warn_days", 30)
        expected = "expired" if days <= 0 else ("warn" if days <= warn else None)
        check(
            f"flag matches the date ({days}d out, warn at {warn}d)",
            row.get("flag") == expected,
            (row.get("flag"), expected),
        )

    # Whatever the seeded dates are, /expiring must never return a dateless row.
    s, feed_page = _req("GET", "/consumables/expiring?limit=200", token=token)
    check("expiring feed returns 200", s == 200, (s, feed_page))
    exp_rows = feed_page.get("items", []) if isinstance(feed_page, dict) else []
    check(
        "expiring feed excludes dateless rows (07-09)",
        all(r.get("expiration_date") is not None for r in exp_rows),
        [r for r in exp_rows if r.get("expiration_date") is None],
    )
    check(
        "expiring feed excludes cleared rows",
        all(r.get("cleared_at") is None for r in exp_rows),
        [r for r in exp_rows if r.get("cleared_at")],
    )

    # ── 3a. Pagination ─────────────────────────────────────────────────
    #
    # Paged in SQL, so the checks that matter are that `total` counts the whole
    # match set (not the page) and that two pages do not overlap — the classic
    # bug where LIMIT is applied after de-duplication and rows go missing.
    print("\n[3a] Pagination")
    total = feed_page.get("total", 0) if isinstance(feed_page, dict) else 0
    check("feed reports a total", isinstance(total, int) and total >= len(exp_rows), feed_page)
    check("total counts the whole match set, not the page", total >= len(exp_rows), total)
    if total >= 2:
        s, p1 = _req("GET", "/consumables/expiring?limit=1&offset=0", token=token)
        s2, p2 = _req("GET", "/consumables/expiring?limit=1&offset=1", token=token)
        check("page 1 returns exactly one row", s == 200 and len(p1["items"]) == 1, p1)
        check("page 2 returns exactly one row", s2 == 200 and len(p2["items"]) == 1, p2)
        check(
            "pages do not overlap",
            p1["items"][0]["id"] != p2["items"][0]["id"],
            (p1["items"][0]["id"], p2["items"][0]["id"]),
        )
        check("total is stable across pages", p1["total"] == p2["total"] == total, (p1, p2))
        check("limit / offset echoed", p2["limit"] == 1 and p2["offset"] == 1, p2)
        # Walking every page must yield each row exactly once.
        seen: list[str] = []
        for off in range(0, total, 5):
            s3, pg = _req("GET", f"/consumables/expiring?limit=5&offset={off}", token=token)
            if s3 == 200:
                seen.extend(r["id"] for r in pg["items"])
        check(
            "walking all pages yields every row once",
            len(seen) == len(set(seen)) == total,
            len(seen),
        )
    else:
        print("  SKIP  fewer than 2 flagged rows to page over")
    s, bad = _req("GET", "/consumables/expiring?limit=0", token=token)
    check("limit below 1 rejected", s == 422, (s, bad))
    s, bad = _req("GET", "/consumables/expiring?limit=9999", token=token)
    check("limit above the cap rejected", s == 422, (s, bad))

    # ── 3b. Every branch of the flag, on dates this test controls ──────
    #
    # One unit of each seeded lot into a fresh Kanban, so each of the four
    # cases is asserted directly rather than depending on whichever lot the
    # register happened to return first.
    print("\n[3b] Flag boundaries (LOC-008 vs TX Spec §4.2)")
    # The same fixture station — rows from earlier runs sit alongside, which is
    # harmless: each assertion looks its lot up by SEED_LOTS label, and every
    # copy of a given label carries the same expiry and so the same flag.
    boundary_kanban = kanban
    fresh = _sources(token, item["id"])
    seeded = [
        r for r in fresh if str(r.get("lot_number", "")).startswith("SMOKE-") and r["qty"] > 0
    ]
    if seeded:
        s, pol = _req("GET", "/consumables/expiry-policy", token=token)
        warn = pol.get("warn_days", 30)
        for src_row in seeded:
            ev = _reauth(token, ISSUE_ACTION)
            _req(
                "POST",
                "/consumables/issue",
                token=token,
                json_body={
                    "sources": [
                        {"node_id": src_row["node_id"], "lot_id": src_row["lot_id"], "qty": 1}
                    ],
                    "kanban_node_id": boundary_kanban["id"],
                    "evidence_id": ev,
                },
            )
        s, brows = _req(
            "GET", f"/consumables/issued?kanban_node_id={boundary_kanban['id']}", token=token
        )
        by_label = {}
        for r in brows:
            for label, _ in SEED_LOTS:
                if f"-{label}-" in (r.get("lot_number") or ""):
                    by_label[label] = r
        # Derived from the LIVE warn window, never hard-coded. ``warn_days`` is
        # a setting an admin can change from the UI, and pinning the WARN lot to
        # "warn" made this fail the moment someone set the window to 3 days —
        # a correct app reported as a broken one.
        expected = {label: _expected_flag(offset, warn) for label, offset in SEED_LOTS}
        for label, want in expected.items():
            r = by_label.get(label)
            if r is None:
                check(f"{label} lot present in the register", False, sorted(by_label))
                continue
            check(
                f"{label} lot flags {want!r} (warn window {warn}d)",
                r.get("flag") == want,
                {"flag": r.get("flag"), "exp": r.get("expiration_date")},
            )
        nodate = by_label.get("NODATE")
        if nodate:
            check(
                "dateless lot has no countdown either (PRC-003)",
                nodate.get("days_to_expiry") is None,
                nodate,
            )
        # The alert feed must contain exactly the two flagged ones.
        s, feed = _req("GET", "/consumables/expiring?limit=200", token=token)
        feed_lots = {r.get("lot_number") for r in feed.get("items", [])}
        for label, want in expected.items():
            r = by_label.get(label)
            if not r:
                continue
            in_feed = r.get("lot_number") in feed_lots
            check(
                f"{label} lot {'is' if want else 'is NOT'} in the expiring feed",
                in_feed == (want is not None),
                {"in_feed": in_feed, "want": want},
            )
    else:
        print("  SKIP  no seeded SMOKE- lots to pin the boundaries against")

    # ── 4. Multi-lot issue keeps per-lot expirations ───────────────────
    print("\n[4] Multi-lot issue → one register row per lot")
    multi = [r for r in _sources(token, item["id"]) if r["qty"] > 0]
    if len(multi) >= 2:
        a, b_ = multi[0], multi[1]
        ev = _reauth(token, ISSUE_ACTION)
        s, res = _req(
            "POST",
            "/consumables/issue",
            token=token,
            json_body={
                "sources": [
                    {"node_id": a["node_id"], "lot_id": a["lot_id"], "qty": 1},
                    {"node_id": b_["node_id"], "lot_id": b_["lot_id"], "qty": 1},
                ],
                "kanban_node_id": kanban["id"],
                "evidence_id": ev,
            },
        )
        check("multi-lot issue accepted", s == 201, (s, res))
        if s == 201:
            check("one result line per lot", len(res.get("lines", [])) == 2, res)
            s, reg2 = _req("GET", f"/consumables/issued?kanban_node_id={kanban['id']}", token=token)
            lots = {r["lot_number"] for r in reg2}
            check(
                "each source lot has its own register row",
                len(reg2) >= 3 and len(lots) >= 2,
                {"rows": len(reg2), "lots": lots},
            )
    else:
        print("  SKIP  item has only one source lot")

    # ── 5. Acknowledge ─────────────────────────────────────────────────
    print("\n[5] Acknowledge (TRX-006 / §4.2, e-signed)")
    target = reg[0]["id"] if reg else None
    if target:
        # Unsigned no longer gets in (client 2026-08-12) — the disposition is an
        # attributable statement about material, so it carries a signature.
        s, unsigned = _req(
            "POST",
            f"/consumables/{target}/acknowledge",
            token=token,
            json_body={"disposition": "discarded", "note": "unsigned"},
        )
        check("unsigned acknowledge rejected", s == 422, (s, unsigned))

        # A signature minted to ISSUE stock must not be spendable on the
        # statement that the same stock was later discarded.
        s, wrong_verb = _req(
            "POST",
            f"/consumables/{target}/acknowledge",
            token=token,
            json_body={
                "disposition": "discarded",
                "evidence_id": _reauth(token, ISSUE_ACTION),
            },
        )
        check("issue signature rejected on acknowledge", s in (401, 403), (s, wrong_verb))

        # VR-006: a signature bound to ANOTHER register row cannot close this
        # one out, even with the right verb.
        other = next((r["id"] for r in reg if r["id"] != target), None)
        if other:
            s, wrong_row = _req(
                "POST",
                f"/consumables/{target}/acknowledge",
                token=token,
                json_body={
                    "disposition": "discarded",
                    "evidence_id": _reauth(
                        token,
                        ACK_ACTION,
                        record_table="app.consumable_issues",
                        record_id=other,
                    ),
                },
            )
            check(
                "signature bound to another row rejected (VR-006)",
                s in (401, 403)
                and wrong_row.get("code") == "reauth_evidence_record_mismatch",
                (s, wrong_row),
            )
        else:
            print("  SKIP  only one open register row — no VR-006 pair to test")

        s, ack = _req(
            "POST",
            f"/consumables/{target}/acknowledge",
            token=token,
            json_body={
                "disposition": "discarded",
                "note": "smoke check",
                "evidence_id": _reauth(
                    token,
                    ACK_ACTION,
                    record_table="app.consumable_issues",
                    record_id=target,
                ),
            },
        )
        check("acknowledge accepted", s == 200, (s, ack))
        if s == 200:
            check("flag cleared", ack.get("flag") is None, ack)
            check("disposition recorded", ack.get("disposition") == "discarded", ack)
            check("cleared_by recorded", bool(ack.get("cleared_by")), ack)
            check(
                "still reports where it was issued (TRX-006)",
                bool(ack.get("kanban_path")) and bool(ack.get("issued_at")),
                ack,
            )
        s, again = _req(
            "POST",
            f"/consumables/{target}/acknowledge",
            token=token,
            json_body={
                "disposition": "consumed",
                "evidence_id": _reauth(token, ACK_ACTION),
            },
        )
        check(
            "double acknowledge rejected",
            s == 422 and again.get("code") == "already_acknowledged",
            (s, again),
        )
        s, reg3 = _req("GET", f"/consumables/issued?kanban_node_id={kanban['id']}", token=token)
        check(
            "cleared row leaves the open register",
            all(r["id"] != target for r in reg3),
            reg3,
        )
        s, reg4 = _req(
            "GET",
            f"/consumables/issued?kanban_node_id={kanban['id']}&include_cleared=true",
            token=token,
        )
        check(
            "cleared row still readable with include_cleared",
            any(r["id"] == target for r in reg4),
            reg4,
        )

    # An UNFLAGGED row can be closed out too (client 2026-08-10). §4.2's first
    # clearing condition is "consumed before its expiration date", which happens
    # before anything warns — nothing in LOC-008 / TRX-006 ties the action to a
    # raised flag, and the UI used to hide the control on these rows.
    s, open_rows = _req("GET", f"/consumables/issued?kanban_node_id={kanban['id']}", token=token)
    unflagged = next((r for r in open_rows if r.get("flag") is None), None)
    if unflagged:
        s, ack2 = _req(
            "POST",
            f"/consumables/{unflagged['id']}/acknowledge",
            token=token,
            json_body={
                "disposition": "consumed",
                "note": "used up early",
                "evidence_id": _reauth(token, ACK_ACTION),
            },
        )
        check("unflagged row can be acknowledged", s == 200, (s, ack2))
        if s == 200:
            check("unflagged ack records 'consumed'", ack2.get("disposition") == "consumed", ack2)
    else:
        print("  SKIP  no unflagged row to close out")

    # ── 6. Guards ──────────────────────────────────────────────────────
    print("\n[6] Guards")
    nc = _non_consumable_item(token)
    if nc:
        s, b = _req("GET", f"/consumables/sources/{nc['id']}", token=token)
        check(
            "non-consumable rejected by sources",
            s == 422 and b.get("code") == "item_not_consumable",
            (s, b),
        )

    # Re-read: the sections above have been drawing stock down, and a stale row
    # would 404 before the guard under test is ever reached.
    live = [r for r in _sources(token, item["id"]) if r["qty"] > 0]
    src = live[0] if live else src

    ev = _reauth(token, ISSUE_ACTION)
    s, b = _req(
        "POST",
        "/consumables/issue",
        token=token,
        json_body={
            "sources": [{"node_id": src["node_id"], "lot_id": src["lot_id"], "qty": 1}],
            # The production area itself — always rejected (client 2026-08-10).
            "kanban_node_id": area["id"],
            "evidence_id": ev,
        },
    )
    check(
        "production area rejected as destination",
        s == 422 and b.get("code") == "destination_not_kanban",
        (s, b),
    )

    ev = _reauth(token, ISSUE_ACTION)
    s, b = _req(
        "POST",
        "/consumables/issue",
        token=token,
        json_body={
            "sources": [{"node_id": src["node_id"], "lot_id": src["lot_id"], "qty": 10**6}],
            "kanban_node_id": kanban["id"],
            "evidence_id": ev,
        },
    )
    check("over-issue rejected", s in (400, 422), (s, b))

    # Wrong action verb — the signature must be minted for THIS operation.
    ev = _reauth(token, "movement.customer_shipment")
    s, b = _req(
        "POST",
        "/consumables/issue",
        token=token,
        json_body={
            "sources": [{"node_id": src["node_id"], "lot_id": src["lot_id"], "qty": 1}],
            "kanban_node_id": kanban["id"],
            "evidence_id": ev,
        },
    )
    check("action-mismatch evidence rejected", s in (401, 403), (s, b))

    # TRX-004: there is no path that puts an issued consumable back.
    s, b = _req("GET", "/openapi.json")
    paths = list(b.get("paths", {})) if s == 200 else []
    check(
        "no de-issue / back-flush endpoint for consumables (TRX-004)",
        not [p for p in paths if "consumable" in p and ("return" in p or "backflush" in p)],
        [p for p in paths if "consumable" in p],
    )

    print(f"\n{TALLY[0]} passed, {TALLY[1]} failed")
    return 1 if TALLY[1] else 0


if __name__ == "__main__":
    sys.exit(main())
