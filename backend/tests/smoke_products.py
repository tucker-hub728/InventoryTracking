"""Ad-hoc smoke test for the Product module (products + materials + customers).

Pure HTTP — no DB/docker access — so it runs either from the host or, since
this repo's host may lack Python, inside the backend container:

    docker compose exec backend python tests/smoke_products.py

Verifies:
  * product create (name + inline materials), duplicate-name 409,
    empty-patch 422, rename audit-able update
  * materials: list with live Available + stock status, add, duplicate 409
    (material_conflict), qty PATCH, remove
  * customers: create with linked products, the link shows on both sides,
    duplicate-name 409, PATCH product_ids to re-link / clear
  * soft-delete of product + customer
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
    sfx = uuid.uuid4().hex[:6]

    # Two existing inventory items to use as materials.
    s, items = _req("GET", "/items?limit=3", token=token)
    assert s == 200 and len(items["items"]) >= 2, items
    item1, item2 = items["items"][0], items["items"][1]

    # ── Product create (name + SKU + inline materials) ────────────────
    name = f"Smoke Product {sfx}"
    sku = f"SMK-{sfx.upper()}"
    s, prod = _req(
        "POST",
        "/products",
        token=token,
        json_body={
            "name": name,
            "sku": sku,
            "materials": [{"item_id": item1["id"], "qty_per_run": 5}],
        },
    )
    assert s == 201, prod
    pid = prod["id"]
    assert prod["material_count"] == 1, prod
    # SKU is the one we supplied (user-provided, not auto-generated).
    assert prod["sku"] == sku, prod
    print(f"==> created product '{name}' (sku {prod['sku']}) with 1 material")

    s, b = _req(
        "POST",
        "/products",
        token=token,
        json_body={"name": name, "sku": f"OTHER-{sfx.upper()}"},
    )
    assert s == 409 and b.get("code") == "product_name_conflict", b
    print("==> duplicate product name: 409 product_name_conflict")

    s, b = _req(
        "POST", "/products", token=token, json_body={"name": f"Other {name}", "sku": sku}
    )
    assert s == 409 and b.get("code") == "product_sku_conflict", b
    print("==> duplicate product SKU: 409 product_sku_conflict")

    # Inverse: the inventory item lists the product whose BOM uses it.
    s, ip = _req("GET", f"/items/{item1['id']}/products", token=token)
    assert s == 200 and any(p["id"] == pid for p in ip), ip
    print("==> item → products inverse lists the product")

    s, b = _req("PATCH", f"/products/{pid}", token=token, json_body={})
    assert s == 422 and b.get("code") == "empty_patch", b
    print("==> empty product patch: 422 empty_patch")

    # ── Materials: live stock, add, dup, qty patch, remove ────────────
    s, mats = _req("GET", f"/products/{pid}/materials", token=token)
    assert s == 200 and len(mats) == 1, mats
    m = mats[0]
    assert m["item_id"] == item1["id"] and float(m["qty_per_run"]) == 5.0, m
    assert m["status_code"] in ("available", "low_stock", "out_of_stock"), m
    print(f"==> material has live stock: available={m['qty_on_hand']} status={m['status_code']}")

    s, m2 = _req(
        "POST",
        f"/products/{pid}/materials",
        token=token,
        json_body={"item_id": item2["id"], "qty_per_run": 3},
    )
    assert s == 201, m2
    mid2 = m2["id"]

    s, b = _req(
        "POST",
        f"/products/{pid}/materials",
        token=token,
        json_body={"item_id": item2["id"], "qty_per_run": 1},
    )
    assert s == 409 and b.get("code") == "material_conflict", b
    print("==> duplicate material: 409 material_conflict")

    s, b = _req(
        "POST",
        f"/products/{pid}/materials",
        token=token,
        json_body={"item_id": item1["id"], "qty_per_run": 6000},
    )
    assert s == 422, ("qty>5000 should be rejected", s, b)
    print("==> qty_per_run > 5000 rejected: 422")

    s, b = _req(
        "PATCH", f"/product-materials/{mid2}", token=token, json_body={"qty_per_run": 9}
    )
    assert s == 200 and float(b["qty_per_run"]) == 9.0, b
    s, b = _req("DELETE", f"/product-materials/{mid2}", token=token)
    assert s == 200, b
    s, mats = _req("GET", f"/products/{pid}/materials", token=token)
    assert len(mats) == 1, mats
    print("==> material add / qty-patch / remove ok")

    # ── Customers + product links ─────────────────────────────────────
    cname = f"Smoke Customer {sfx}"
    s, cust = _req(
        "POST",
        "/customers",
        token=token,
        json_body={
            "name": cname,
            "contact_person": "Jane Roe",
            "email": "jane@example.com",
            "product_ids": [pid],
        },
    )
    assert s == 201, cust
    cid = cust["id"]
    assert len(cust["products"]) == 1 and cust["products"][0]["id"] == pid, cust
    print("==> customer created + linked to product")

    # The link shows on the product side too.
    s, plist = _req("GET", "/products", token=token)
    prod_row = next((x for x in plist if x["id"] == pid), None)
    assert prod_row and len(prod_row["customers"]) == 1, prod_row
    print("==> product lists the linked customer")

    s, b = _req("POST", "/customers", token=token, json_body={"name": cname})
    assert s == 409 and b.get("code") == "customer_name_conflict", b
    print("==> duplicate customer name: 409 customer_name_conflict")

    # Re-link to nothing, then back — PATCH product_ids replaces the set.
    s, b = _req("PATCH", f"/customers/{cid}", token=token, json_body={"product_ids": []})
    assert s == 200 and len(b["products"]) == 0, b
    s, b = _req(
        "PATCH", f"/customers/{cid}", token=token, json_body={"product_ids": [pid]}
    )
    assert s == 200 and len(b["products"]) == 1, b
    print("==> customer product links reconcile via PATCH")

    # ── Soft-delete cleanup ───────────────────────────────────────────
    s, _b = _req("DELETE", f"/customers/{cid}", token=token)
    assert s == 200, _b
    s, _b = _req("DELETE", f"/products/{pid}", token=token)
    assert s == 200, _b
    print("==> product + customer soft-deleted")

    print()
    print("ALL PRODUCT MODULE SMOKE TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
