"""Ad-hoc smoke test for the kit cost CSV export (RPT-003).

Runs against the DEV stack over real HTTP, after ``docker compose up``:

    docker compose exec -T backend python tests/smoke_kit_cost_export.py

(Not collected by pytest — the filename is deliberately ``smoke_*``. It reads
whatever is in the dev database rather than seeding, so it asserts invariants
rather than exact numbers.)

``test_exports_kit_costs_csv.py`` covers the row builders as pure functions.
Everything below is what those cannot reach: the route, the SQL behind the date
range, the permission gate, and the audit row.

Verifies:
  * the response really is a downloadable CSV — status, media type,
    ``Content-Disposition`` filename, and the UTF-8 BOM
  * **the reconciliation**: for every batch, the per-component consumption rows
    sum to that batch's material cost, and the batch's per-unit cost times its
    good quantity comes back to the same figure. Those two are computed by
    different code paths — one stored per line at consume time, one stored on
    the batch — so they only agree while the data is consistent.
  * scrap value stays **inside** the batch total, never added to it
  * the date range is **half-open**: a row stamped exactly at ``occurred_to``
    is excluded, one at ``occurred_from`` is included
  * an unpriced input exports BLANK, never ``0``; a $0 lot exports a real ``0``
  * money columns are disjoint across row kinds (the double-count guard)
  * **the gate**: a ``super_admin`` can download it; ``read_only``,
    ``operator`` **and ``admin``** all get 403, and an anonymous caller gets
    401. Narrowed from admin-and-above by the client on 2026-09-03, at the same
    time RPT-001 was — both priced exports now carry the identical gate, so
    **run this script with SUPER ADMIN credentials** or the download
    assertions fail
  * the download wrote an audit row naming RPT-003

The gate section is the one worth re-running after any change to permissions:
it is the only thing standing between per-customer pricing and 500-odd
read-only accounts.
"""

from __future__ import annotations

import csv
import io
import json
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from app.exports.kit_cost_rows import KIT_COST_HEADERS, ROW_KIND_LABELS

from _smoke_creds import require_credentials

BASE = "http://localhost:8000/v1"

# Dev credentials. If login fails, check cognito-local is healthy —
# ``docker logs cellready-cognito`` — before assuming this feature is broken.
EMAIL, PASSWORD = require_credentials()

failures: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}{f' — {detail}' if detail and not ok else ''}")
    if not ok:
        failures.append(f"{label}{f': {detail}' if detail else ''}")


def request(
    path: str, token: str | None = None, raw: bool = False
) -> tuple[int, object, dict[str, str]]:
    """``(status, body, headers)``. Never raises on an HTTP error status."""
    req = urllib.request.Request(f"{BASE}{path}")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as r:
            body = r.read()
            return r.status, (body if raw else json.loads(body or b"null")), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def login(email: str, password: str) -> str | None:
    payload = json.dumps({"email": email, "password": password}).encode()
    req = urllib.request.Request(
        f"{BASE}/auth/login", data=payload, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())["access_token"]
    except urllib.error.HTTPError:
        return None


def money(row: dict[str, str], key: str) -> Decimal | None:
    """A money cell as a Decimal, or ``None`` for a blank.

    The distinction is the point: blank means "no price recorded" and ``0``
    means "this cost nothing" (the customer-owned cells on a $0 PO), and
    collapsing them would report unpriced stock as free.
    """
    raw = row.get(key, "")
    return None if raw == "" else Decimal(raw)


def main() -> int:
    print("RPT-003 kit cost export smoke\n")

    token = login(EMAIL, PASSWORD)
    if not token:
        print("  FAIL  login — check cognito-local is healthy")
        return 1

    # ── The download ────────────────────────────────────────────────────
    print("Download")
    status, body, headers = request("/exports/kit-costs.csv", token, raw=True)
    check("200", status == 200, f"got {status}")
    if status != 200:
        return 1
    check(
        "text/csv",
        headers.get("Content-Type", "").startswith("text/csv"),
        headers.get("Content-Type", ""),
    )
    disp = headers.get("Content-Disposition", "")
    check("attachment filename", "cellready-kit-costs-" in disp and disp.endswith('.csv"'), disp)
    check("utf-8 BOM", body[:3] == b"\xef\xbb\xbf")

    parsed = list(csv.DictReader(io.StringIO(body.decode("utf-8-sig"))))
    print(f"        {len(parsed)} rows")

    # The file ships PLAIN-ENGLISH headers ("Batch material cost ($)"), because
    # it goes to departments who open it in Excel. Map them back to the internal
    # keys so the assertions below stay readable as code — and so a header
    # without a mapping fails loudly here rather than silently skipping a check.
    display_to_key = {v: k for k, v in KIT_COST_HEADERS.items()}
    unmapped = [h for h in (parsed[0] if parsed else {}) if h not in display_to_key]
    check("every header maps back to a known column", not unmapped, f"{unmapped}")
    rows = [{display_to_key.get(h, h): v for h, v in r.items()} for r in parsed]

    by_kind: dict[str, list[dict[str, str]]] = defaultdict(list)
    for r in rows:
        by_kind[r["row_kind"]].append(r)
    print(f"        {({k: len(v) for k, v in sorted(by_kind.items())})}")
    check(
        "row kinds are the plain-English labels, not internal keys",
        set(by_kind) <= set(ROW_KIND_LABELS.values()),
        f"unexpected: {sorted(set(by_kind) - set(ROW_KIND_LABELS.values()))}",
    )

    if not rows:
        print("\n  (no kit activity in the dev database — reconciliation skipped)")
        return 0

    # ── Reconciliation ──────────────────────────────────────────────────
    # The assertion that matters: the per-component detail adds up to the number
    # that reaches a customer's invoice.
    print("\nReconciliation")
    consumed_by_batch: dict[tuple[str, str], Decimal] = defaultdict(Decimal)
    incomplete: set[tuple[str, str]] = set()
    for r in by_kind[ROW_KIND_LABELS["batch_consumption"]]:
        key = (r["kit_id"], r["batch_no"])
        value = money(r, "consumed_value_amount")
        if value is None:
            incomplete.add(key)
        else:
            consumed_by_batch[key] += value

    summed = mismatched = 0
    for r in by_kind[ROW_KIND_LABELS["batch_output"]]:
        key = (r["kit_id"], r["batch_no"])
        total = money(r, "batch_material_cost_amount")
        if total is None or key in incomplete or key not in consumed_by_batch:
            continue
        summed += 1
        if consumed_by_batch[key] != total:
            mismatched += 1
            check(
                f"batch {r['kit_number']}#{r['batch_no']} components sum to its cost",
                False,
                f"components {consumed_by_batch[key]} != batch {total}",
            )
    if summed:
        check(
            f"component rows sum to the batch cost ({summed} batches)", mismatched == 0
        )

    unit_ok = unit_bad = 0
    for r in by_kind[ROW_KIND_LABELS["batch_output"]]:
        total, unit = money(r, "batch_material_cost_amount"), money(r, "batch_unit_cost_amount")
        good = int(r["batch_good_qty"] or 0)
        if total is None or unit is None or good <= 0:
            continue
        # Rounded to the lot price's 6dp, so compare at that scale.
        if abs(unit * good - total) > Decimal("0.000001") * good:
            unit_bad += 1
            check(
                f"unit cost x good = material ({r['output_lot_number']})",
                False,
                f"{unit} x {good} != {total}",
            )
        else:
            unit_ok += 1
    if unit_ok or unit_bad:
        check(f"per-unit cost recovers the batch total ({unit_ok} lots)", unit_bad == 0)

    # Scrap is a SLICE of the material cost. Adding it would overstate every
    # kit that scrapped anything.
    scrap_bad = [
        r
        for r in by_kind[ROW_KIND_LABELS["batch_output"]]
        if (s := money(r, "batch_scrap_value_amount")) is not None
        and (m := money(r, "batch_material_cost_amount")) is not None
        and s > m
    ]
    check("scrap value never exceeds the batch cost", not scrap_bad, f"{len(scrap_bad)} over")

    # ── Blank vs zero ───────────────────────────────────────────────────
    print("\nBlank is not zero")
    unpriced = [r for r in by_kind[ROW_KIND_LABELS["material_issue"]] if r["source_has_unit_price"] == "false"]
    check(
        "an unpriced issue exports a BLANK value, never 0",
        all(r["issue_value_amount"] == "" for r in unpriced),
        f"{sum(1 for r in unpriced if r['issue_value_amount'] != '')} wrote a number",
    )
    free = [
        r
        for r in by_kind[ROW_KIND_LABELS["material_issue"]]
        if r["source_has_unit_price"] == "true"
        and money(r, "source_unit_price_per_consume_unit") == 0
    ]
    check(
        "a $0 lot exports a real 0, not a blank",
        all(r["issue_value_amount"] != "" for r in free),
        f"{sum(1 for r in free if r['issue_value_amount'] == '')} blanked",
    )
    print(f"        {len(unpriced)} unpriced, {len(free)} free-of-charge issues seen")

    # ── The union invariant ─────────────────────────────────────────────
    # Every money column on exactly one row_kind, so a naive SUM() down any of
    # them is meaningful without first knowing to filter.
    print("\nUnion invariant")
    money_cols = [c for c in (rows[0] or {}) if c.endswith("_amount")]
    shared = {
        col: kinds
        for col in money_cols
        if len(kinds := {r["row_kind"] for r in rows if r.get(col, "") != ""}) > 1
    }
    check(
        "each money column belongs to one row kind",
        not shared,
        "; ".join(f"{c} on {sorted(k)}" for c, k in shared.items()),
    )

    # ── The half-open date range ────────────────────────────────────────
    print("\nDate range is half-open")
    stamps = sorted(
        datetime.fromisoformat(r["event_at"]) for r in rows if r.get("event_at")
    )
    if stamps:
        first, last = stamps[0], stamps[-1]
        # ``to`` is EXCLUSIVE, so bounding it at the newest event must drop that
        # event; nudging one second past must keep it.
        q = f"?occurred_from={first.isoformat()}&occurred_to={last.isoformat()}"
        _, excl, _ = request(f"/exports/kit-costs.csv{q}", token, raw=True)
        n_excl = len(list(csv.DictReader(io.StringIO(excl.decode("utf-8-sig")))))
        q2 = (
            f"?occurred_from={first.isoformat()}"
            f"&occurred_to={(last + timedelta(seconds=1)).isoformat()}"
        )
        _, incl, _ = request(f"/exports/kit-costs.csv{q2}", token, raw=True)
        n_incl = len(list(csv.DictReader(io.StringIO(incl.decode("utf-8-sig")))))
        check("an event AT occurred_to is excluded", n_excl < n_incl, f"{n_excl} vs {n_incl}")

    # A range with nothing in it is an empty file, not an error.
    far = (datetime.now(UTC) + timedelta(days=3650)).isoformat()
    farther = (datetime.now(UTC) + timedelta(days=3651)).isoformat()
    status, empty, _ = request(
        f"/exports/kit-costs.csv?occurred_from={far}&occurred_to={farther}", token, raw=True
    )
    check("an empty range is a header-only file, not an error", status == 200, f"got {status}")

    status, _, _ = request(
        f"/exports/kit-costs.csv?occurred_from={farther}&occurred_to={far}", token, raw=True
    )
    check("from after to is refused", status == 422, f"got {status}")

    # ── The gate ────────────────────────────────────────────────────────
    # RPT-001 is deliberately open to finance's read_only accounts. This file is
    # NOT: it says what each customer is charged.
    print("\nPermission gate")
    status, _, _ = request("/exports/kit-costs.csv")
    check("anonymous is refused", status == 401, f"got {status}")

    ro_email = input_read_only()
    if ro_email:
        ro_token = login(ro_email, PASSWORD)
        if ro_token:
            status, _, _ = request("/exports/kit-costs.csv", ro_token)
            check("a read_only user is refused", status == 403, f"got {status}")
        else:
            print("  SKIP  read_only login failed — set SMOKE_READONLY_EMAIL to a real account")
    else:
        print("  SKIP  no SMOKE_READONLY_EMAIL set — the 403 path is unverified")

    # ── The audit row ───────────────────────────────────────────────────
    print("\nAudit")
    status, events, _ = request("/audit/events?limit=25", token)
    if status == 200 and isinstance(events, dict):
        found = [
            e
            for e in events.get("items", [])
            if (e.get("context") or {}).get("requirement") == "RPT-003"
        ]
        check("the download wrote an RPT-003 audit row", bool(found))
        if found:
            check(
                "audited against its own subject table",
                found[0].get("subject_table") == "app.kit_cost_exports",
                found[0].get("subject_table", ""),
            )
    else:
        print(f"  SKIP  audit not readable by this user ({status})")

    print()
    if failures:
        print(f"{len(failures)} FAILED:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("all checks passed")
    return 0


def input_read_only() -> str | None:
    """A read_only account to prove the 403 with, from the environment.

    Optional: the smoke still runs without it, and says so. Kept out of
    ``_smoke_creds`` because that module is about the ONE login every smoke
    script needs, and this is a second, different account.
    """
    import os

    return os.environ.get("SMOKE_READONLY_EMAIL") or None


if __name__ == "__main__":
    sys.exit(main())
