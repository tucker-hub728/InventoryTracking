"""Ad-hoc smoke test: sibling location names are unique (REQ-2026-07-15-LOC-003).

"Shelf creation is restricted to the Super Admin role … Rationale: prevent
duplicate/ad-hoc shelf names that split one physical spot into two and corrupt
planning reorder points." Role alone never enforced that — a Super Admin could
create two identically named shelves, and dev had three such pairs.

Enforced in the application on BOTH create and rename; migration ``locname01``
adds the matching partial unique index for non-root nodes.

    SMOKE_EMAIL=admin.user@cellready.dev SMOKE_PASSWORD='DevAdmin_123!' \
        python backend/tests/smoke_location_name_unique.py

Verifies:
  * a second sibling with the same name is rejected (409 node_name_conflict)
  * the check is case- and whitespace-insensitive
  * renaming onto a sibling's name is rejected too
  * renaming a node to its OWN name still works (it must not block itself)
  * the same name IS allowed under a DIFFERENT parent
  * cleans up everything it creates
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("SMOKE_BASE", "http://localhost:8000/v1")
EMAIL = os.environ.get("SMOKE_EMAIL", "admin.user@cellready.dev")
PASSWORD = os.environ.get("SMOKE_PASSWORD", "DevAdmin_123!")

STATS = {"passed": 0}
FAILED: list[str] = []


def check(label: str, cond: bool, detail: object = "") -> None:
    if cond:
        STATS["passed"] += 1
        print(f"  ok   {label}")
    else:
        FAILED.append(label)
        print(f"  FAIL {label}: {detail}")


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


def _tanks(token: str) -> list[dict]:
    s, b = _req("GET", "/location-nodes/ln2-tree", token=token)
    assert s == 200, b
    return b  # type: ignore[return-value]


def main() -> int:
    token = _login()
    print("==> logged in")

    # A quadrant makes a good parent: racks are cheap to create and delete, and
    # the LN2 tree always has one in dev.
    tanks = _tanks(token)
    quadrants = [q for t in tanks for q in t.get("children", [])]
    if len(quadrants) < 2:
        print("!! need two LN2 quadrants in dev to test the cross-parent case")
        return 1
    parent_a, parent_b = quadrants[0], quadrants[1]
    print(f"==> parents: {parent_a['name']} / {parent_b['name']}")

    created: list[str] = []
    # Deleting a node SOFT-deletes it, and sibling-CODE uniqueness (unlike the
    # name rule) ignores ``is_active`` — so a code this test used once is
    # reserved for good. Listing the children doesn't reveal them either, since
    # that endpoint returns only active nodes. So: try a prefix, and step to the
    # next one when the code (NOT the name) comes back as taken.
    run = {"n": 1}

    def make_rack(parent_id: str, name: str, slot: str):
        for _ in range(60):
            s, b = _req(
                "POST",
                "/location-nodes",
                token=token,
                json_body={
                    "node_type": "rack",
                    "parent_id": parent_id,
                    "code": f"SMK{run['n']}-{slot}",
                    "name": name,
                },
            )
            if s == 409 and b.get("code") == "node_code_conflict":
                run["n"] += 1
                continue
            return s, b
        return 409, {"code": "node_code_conflict", "message": "ran out of smoke prefixes"}

    print("\n-- create")
    s, first = make_rack(parent_a["id"], "Smoke Rack Zeta", "Z1")
    check("first rack created", s == 201, (s, first))
    if s != 201:
        return 1
    created.append(first["id"])

    s, b = make_rack(parent_a["id"], "Smoke Rack Zeta", "Z2")
    check(
        "same name under the same parent rejected",
        s == 409 and b.get("code") == "node_name_conflict",
        (s, b),
    )
    if s == 201:
        created.append(b["id"])

    s, b = make_rack(parent_a["id"], "  smoke rack ZETA  ", "Z3")
    check(
        "case / whitespace variations rejected too",
        s == 409 and b.get("code") == "node_name_conflict",
        (s, b),
    )
    if s == 201:
        created.append(b["id"])

    # The rule is about telling siblings apart, so a different parent is fine —
    # "Shelf A" exists in more than one room by design.
    s, other = make_rack(parent_b["id"], "Smoke Rack Zeta", "Z4")
    check("same name under a DIFFERENT parent allowed", s == 201, (s, other))
    if s == 201:
        created.append(other["id"])

    print("\n-- rename")
    s, second = make_rack(parent_a["id"], "Smoke Rack Omega", "O1")
    check("second rack created", s == 201, (s, second))
    if s == 201:
        created.append(second["id"])

        s, b = _req(
            "PATCH",
            f"/location-nodes/{second['id']}",
            token=token,
            json_body={"name": "Smoke Rack Zeta"},
        )
        check(
            "renaming onto a sibling's name rejected",
            s == 409 and b.get("code") == "node_name_conflict",
            (s, b),
        )

        # The exclude-self case: without it, every rename would collide with the
        # node doing the renaming.
        s, b = _req(
            "PATCH",
            f"/location-nodes/{second['id']}",
            token=token,
            json_body={"name": "Smoke Rack Omega"},
        )
        check("renaming a node to its OWN name still works", s == 200, (s, b))

        s, b = _req(
            "PATCH",
            f"/location-nodes/{second['id']}",
            token=token,
            json_body={"name": "Smoke Rack Omega II"},
        )
        check("renaming to a free name works", s == 200, (s, b))

    # ── Storage UNITS are unique installation-wide, not just per parent ──
    # Their name is the client's equipment number (LOC-006) / shelf letter
    # (LOC-005), so it names one physical object wherever it is hung.
    print("\n-- storage units: unique everywhere, not just among siblings")
    # Creating a Cold Storage unit is Super-Admin-only (LOC-006), and that check
    # runs before the name check — so with an ordinary admin this case gets a
    # 403 and proves nothing. Supply a super admin to exercise it:
    #   SMOKE_SA_EMAIL=… SMOKE_SA_PASSWORD=… python …
    sa_email = os.environ.get("SMOKE_SA_EMAIL")
    sa_password = os.environ.get("SMOKE_SA_PASSWORD")
    sa_token = None
    if sa_email and sa_password:
        s, b = _req("POST", "/auth/login", json_body={"email": sa_email, "password": sa_password})
        if s == 200:
            sa_token = b["access_token"]
        else:
            print(f"  !! super-admin login failed ({s}) — falling back")
    s, rooms = _req("GET", "/location-nodes/freezer-tree", token=token)
    groups = [g for r in (rooms if s == 200 else []) for g in r.get("children", [])]
    hosts = [g for g in groups if g.get("children")]
    if sa_token is None:
        print(
            "  (skip) needs a SUPER ADMIN — set SMOKE_SA_EMAIL / SMOKE_SA_PASSWORD.\n"
            "         Cold Storage creation is super-admin-only, so an admin token\n"
            "         is refused before the name rule is ever reached."
        )
    elif len(hosts) < 2:
        print("  (skip) need two freezer groups holding units")
    else:
        # Cleanup below reuses this token; the super admin can delete what it made.
        token = sa_token
        donor, elsewhere = hosts[0], hosts[1]
        taken = donor["children"][0]["name"]
        print(f"       reusing '{taken}' (in {donor['name']}) under {elsewhere['name']}")
        s, b = _req(
            "POST",
            "/location-nodes",
            token=token,
            json_body={
                "node_type": "sub_location",
                "parent_id": elsewhere["id"],
                "code": f"SMKU{run['n']}-1",
                "name": taken,
            },
        )
        check(
            "a unit name already used under ANOTHER parent is rejected",
            s == 409 and b.get("code") == "node_name_conflict",
            (s, b),
        )
        check(
            "the message says where the existing one is",
            s == 409 and donor["name"] in b.get("message", ""),
            b.get("message"),
        )
        if s == 201:
            created.append(b["id"])

    print("\n-- cleanup")
    for node_id in reversed(created):
        s, _ = _req("DELETE", f"/location-nodes/{node_id}", token=token)
        if s not in (200, 204):
            print(f"  !! could not delete {node_id[:8]} ({s}) — remove it by hand")

    print(f"\n==> {STATS['passed']} passed, {len(FAILED)} failed")
    for f in FAILED:
        print(f"    - {f}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
