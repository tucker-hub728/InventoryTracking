"""Ad-hoc smoke test for the finance CSV export (RPT-001).

Runs against the DEV stack over real HTTP, after ``docker compose up``:

    docker compose exec -T backend python tests/smoke_finance_export.py

(Not collected by pytest — the filename is deliberately ``smoke_*``. It reads
whatever is in the dev database rather than seeding, so it asserts invariants
rather than exact numbers.)

Verifies:
  * the response really is a downloadable CSV — status, media type,
    ``Content-Disposition`` filename, and the UTF-8 BOM that stops Excel on
    Windows mojibake-ing the ``›`` breadcrumbs
  * **the reconciliation**: per item, the detail rows sum to the figures the
    item page shows. This is the assertion that matters — it is what lets
    finance trust a pivot over this file instead of retyping the screen.
  * quantities tie back to the ledger, and to the item drill-down's
    "Stock by location" tab
  * an unpriced lot exports a BLANK extended value, never ``0``
  * item-level columns never appear on detail rows (the double-count guard)
  * a ``read_only`` user — finance — can download it; an anonymous caller cannot
  * the download wrote an audit row

The reconciliation section is the part worth running by hand after any change
to valuation, receiving or allocations: the two sides are computed by different
code paths on purpose, so they only agree while the data is consistent.
"""

from __future__ import annotations

import csv
import io
import json
import sys
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from decimal import Decimal

from _smoke_creds import require_credentials

BASE = "http://localhost:8000/v1"

# Dev credentials. If login fails, check cognito-local is healthy —
# ``docker logs cellready-cognito`` — before assuming this feature is broken.
EMAIL, PASSWORD = require_credentials()

failures: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}{f' — {detail}' if detail else ''}")
    if not ok:
        failures.append(label)


def req(
    method: str, path: str, *, token: str | None = None, body: dict | None = None
) -> tuple[int, dict[str, str], bytes]:
    headers: dict[str, str] = {}
    data: bytes | None = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request) as resp:
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, {k.lower(): v for k, v in exc.headers.items()}, exc.read()


def dec(value: str | None) -> Decimal:
    return Decimal(value) if value else Decimal("0")


def main() -> int:
    status, _, body = req("POST", "/auth/login", body={"email": EMAIL, "password": PASSWORD})
    if status != 200:
        print(f"login failed ({status}) — is the stack up?\n{body[:400]!r}")
        return 1
    token = json.loads(body)["access_token"]

    print("\n── The response is a real download ──")
    status, headers, raw = req("GET", "/exports/inventory.csv", token=token)
    check("200 OK", status == 200, f"got {status}")
    if status != 200:
        print(raw[:600].decode("utf-8", "replace"))
        return 1
    check("text/csv", "text/csv" in headers.get("content-type", ""), headers.get("content-type", ""))
    disposition = headers.get("content-disposition", "")
    check("attachment filename", "attachment; filename=" in disposition, disposition)
    check("filename is timestamped", "cellready-inventory-" in disposition)
    check("UTF-8 BOM present", raw[:3] == b"\xef\xbb\xbf")
    check("CRLF line endings", b"\r\n" in raw)

    rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))))
    kinds = Counter(r["row_kind"] for r in rows)
    print(f"       {len(rows)} rows: {dict(kinds)}")
    check("has rows", len(rows) > 0)

    print("\n── Reconciliation: detail rows sum to what the item page shows ──")
    on_hand_value: dict[str, Decimal] = defaultdict(Decimal)
    on_order_value: dict[str, Decimal] = defaultdict(Decimal)
    on_hand_qty: dict[str, Decimal] = defaultdict(Decimal)
    item_level: dict[str, tuple[Decimal, Decimal, Decimal]] = {}
    for row in rows:
        item_id = row["item_id"]
        if row["row_kind"] == "on_hand":
            on_hand_value[item_id] += dec(row["extended_value_amount"])
            on_hand_qty[item_id] += dec(row["qty_on_hand"])
        elif row["row_kind"] == "on_order":
            on_order_value[item_id] += dec(row["extended_value_amount"])
        elif row["row_kind"] == "item_valuation":
            item_level[item_id] = (
                dec(row["item_ui_inv_value_amount"]),
                dec(row["item_ui_po_value_amount"]),
                dec(row["item_qty_on_hand_ledger"]),
            )

    bad_inv = [i for i, (iv, _, _) in item_level.items() if on_hand_value[i] != iv]
    bad_po = [i for i, (_, pv, _) in item_level.items() if on_order_value[i] != pv]
    bad_qty = [i for i, (_, _, q) in item_level.items() if on_hand_qty[i] != q]
    check("Σ on_hand value == item inv_value", not bad_inv, f"{len(bad_inv)} items differ")
    check("Σ on_order value == item po_value", not bad_po, f"{len(bad_po)} items differ")
    check("Σ on_hand qty == ledger on-hand", not bad_qty, f"{len(bad_qty)} items differ")
    for item_id in bad_qty[:3]:
        print(f"       {item_id}: csv {on_hand_qty[item_id]} vs ledger {item_level[item_id][2]}")

    print("\n── The rules that keep a cell from being misread ──")
    unpriced = [r for r in rows if r["has_unit_price"] == "false" and r["row_kind"] == "on_hand"]
    check(
        "unpriced stock exports blank, not 0",
        all(r["extended_value_amount"] == "" for r in unpriced),
        f"{len(unpriced)} unpriced rows",
    )
    detail = [r for r in rows if r["row_kind"] != "item_valuation"]
    check(
        "item-level columns blank on detail rows",
        all(r["item_ui_inv_value_amount"] == "" for r in detail),
    )
    check(
        "extended value blank on item_valuation rows",
        all(
            r["extended_value_amount"] == ""
            for r in rows
            if r["row_kind"] == "item_valuation"
        ),
    )
    check(
        "awaiting_release rows carry no location",
        all(
            r["location_node_id"] == ""
            for r in rows
            if r["row_kind"] == "awaiting_release"
        ),
    )
    synthetic = [r for r in rows if r["lot_number_is_synthetic"] == "true"]
    check(
        "synthetic flag matches the AUTO- prefix",
        all(r["lot_number"].startswith("AUTO-") for r in synthetic),
        f"{len(synthetic)} synthetic lots",
    )

    print("\n── Agrees with the item drill-down ──")
    sample = next((r for r in rows if r["row_kind"] == "on_hand"), None)
    if sample is None:
        check("stock-locations cross-check", True, "skipped — no on_hand rows in dev")
    else:
        item_id = sample["item_id"]
        _, _, drill = req("GET", f"/items/{item_id}/stock-locations", token=token)
        api_rows = json.loads(drill)
        from_api = {(r["lot_id"], r["node_id"], int(r["qty"])) for r in api_rows}
        from_csv = {
            (r["lot_id"], r["location_node_id"], int(r["qty_on_hand"]))
            for r in rows
            if r["row_kind"] == "on_hand" and r["item_id"] == item_id
        }
        check(
            "CSV (lot, node, qty) == /stock-locations",
            from_api == from_csv,
            f"csv {len(from_csv)} vs api {len(from_api)}",
        )

    print("\n── Access control ──")
    status, _, _ = req("GET", "/exports/inventory.csv")
    check("anonymous is rejected", status in (401, 403), f"got {status}")

    print("\n── The download is audited ──")
    status, _, audit = req(
        "GET", "/audit/events?subject_table=app.inventory_exports&limit=5", token=token
    )
    if status != 200:
        check("audit row written", False, f"audit query returned {status}")
    else:
        events = json.loads(audit).get("items", [])
        check("audit row written", len(events) > 0, f"{len(events)} export events")
        if events:
            latest = events[0]
            after = latest.get("after_state") or {}
            check("audit row carries a row_count", "row_count" in after, str(after))
            check(
                "audit row_count matches the file",
                after.get("row_count") == len(rows),
                f"{after.get('row_count')} vs {len(rows)}",
            )

    print("\n── The tabbed workbook ──")
    status, headers, xlsx = req("GET", "/exports/inventory.xlsx?title=Raw%20Materials", token=token)
    check("200 OK", status == 200, f"got {status}")
    if status == 200:
        check("xlsx media type", "spreadsheetml" in headers.get("content-type", ""))
        check("filename ends .xlsx", ".xlsx" in headers.get("content-disposition", ""))
        check("is a real zip container", xlsx[:2] == b"PK")
        try:
            import io as _io

            from openpyxl import load_workbook

            book = load_workbook(_io.BytesIO(xlsx))
            names = book.sheetnames
            print(f"       {len(names)} tabs: {names[0]!r} + {len(names) - 1} item tabs")
            check("first tab is the summary", names[0] == "Raw Materials", names[0])
            check("has item tabs", len(names) > 1, f"{len(names) - 1}")
            check("tab names are unique", len(set(names)) == len(names))
            check(
                "tab names are legal for Excel",
                all(len(n) <= 31 and not set(n) & set("[]:*?/\\") for n in names),
            )
            # Every item tab must correspond to a SKU on the summary, and every
            # linked SKU must have a tab — a link that lands nowhere is the
            # failure mode this structure invites.
            summary = book[names[0]]
            linked = {
                summary.cell(row=r, column=1).value
                for r in range(5, summary.max_row + 1)
                if summary.cell(row=r, column=1).hyperlink is not None
            }
            check(
                "every linked SKU has a tab",
                linked <= set(names),
                f"{len(linked - set(names))} dangling",
            )
            check(
                "every item tab is linked from the summary",
                set(names[1:]) <= linked,
                f"{len(set(names[1:]) - linked)} orphan tabs",
            )
        except ImportError:
            check("workbook inspected", False, "openpyxl not importable here")

    print()
    if failures:
        print(f"{len(failures)} CHECK(S) FAILED: {', '.join(failures)}")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
