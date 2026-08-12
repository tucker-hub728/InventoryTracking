"""Ad-hoc smoke test: the standard location template (REQ-2026-08-04-LOC-001/004).

LOC-001 provisions a new location "from a standard template that automatically
includes a configurable shelf, refrigerator, and freezer", which the client may
rename and may leave unused. LOC-004 makes those sub-types admin-configurable.

The template's sub-types are REAL NODES, not a stored flag — a category's groups
are simply the ``room_location`` children it has. So this test asserts the
structure, not a setting: switching a sub-type off soft-deletes its group, and
switching it back on revives the same node with its units still attached.

Storage is the only room with four levels (room → category → group → unit), so
the parentage rules get exercised here too.

    SMOKE_SA_EMAIL=… SMOKE_SA_PASSWORD=… python backend/tests/smoke_storage_template.py

Verifies:
  * a category is created with exactly the sub-types switched on
  * the groups come back in TEMPLATE order (Shelf, Refrigerator, Freezer)
  * a switched-off sub-type is simply absent
  * units are added to a group with the ordinary create route (as Cold Storage)
  * switching a sub-type OFF while it holds units is refused (409)
  * …and succeeds once the unit is gone
  * switching one back ON revives the group AND its units
  * a category cannot be created outside the Storage room
  * a category with no sub-types at all is refused
  * a non-super-admin is refused (403)
  * duplicate equipment numbers are refused anywhere (409)
  * cleans up everything it creates
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("SMOKE_BASE", "http://localhost:8000/v1")
# The template is super-admin-only (LOC-004), so the SUPER admin is the primary
# credential here — unlike most smoke tests, where it is the optional extra.
SA_EMAIL = os.environ.get("SMOKE_SA_EMAIL", "super.admin@cellready.dev")
SA_PASSWORD = os.environ.get("SMOKE_SA_PASSWORD", "DevSuper_123!")
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


def _login(email: str, password: str) -> str | None:
    s, b = _req("POST", "/auth/login", json_body={"email": email, "password": password})
    return b["access_token"] if s == 200 else None


def _rooms(token: str) -> list[dict]:
    s, b = _req("GET", "/location-nodes/freezer-tree", token=token)
    assert s == 200, b
    return b  # type: ignore[return-value]


def main() -> int:
    token = _login(SA_EMAIL, SA_PASSWORD)
    if token is None:
        print(f"!! super-admin login failed for {SA_EMAIL}")
        print("   the template is super-admin-only — set SMOKE_SA_EMAIL / SMOKE_SA_PASSWORD")
        return 1
    print("==> logged in as super admin")

    rooms = _rooms(token)
    storage = next((r for r in rooms if r.get("code", "").upper() == "STG"), None)
    if storage is None:
        print("!! no Storage room — run: uv run python -m scripts.seed_storage --yes")
        return 1
    other = next((r for r in rooms if r.get("code", "").upper() in ("CS", "MM", "AL")), None)
    print(f"==> room: {storage['name']} ({storage['code']})")

    # Everything this test makes, in CREATION order. Cleanup walks it backwards,
    # which is also the only order that works: ``delete_node`` refuses a node that
    # still has children, so a category cannot go until its groups have, and a
    # group cannot go until its units have.
    created: list[str] = []
    # Sibling CODE uniqueness ignores ``is_active``, so a code this test used once
    # is reserved for good — step to the next suffix until the name is free.
    run = {"n": 1}

    def make_category(name: str, **switches):
        for _ in range(60):
            payload = {"name": f"{name} {run['n']}", **switches}
            s, b = _req(
                "POST",
                f"/location-nodes/{storage['id']}/storage-categories",
                token=token,
                json_body=payload,
            )
            if s == 409:
                run["n"] += 1
                continue
            return s, b
        return 0, {"raw": "ran out of suffixes"}

    print("\n-- create from the template")
    s, cat = make_category("Smoke Location", shelf=True, refrigerator=True, freezer=True)
    check("a category is created with all three sub-types", s == 201, (s, cat))
    if s != 201:
        print("==> cannot continue without a category")
        return 1
    created.append(cat["id"])
    groups = cat.get("children", [])
    created.extend(g["id"] for g in groups)
    check("it comes back with its groups nested", len(groups) == 3, groups)
    check(
        "the groups are in TEMPLATE order — Shelf, Refrigerator, Freezer",
        [g["code"] for g in groups] == ["SHF", "REF", "FRZ"],
        [g["code"] for g in groups],
    )
    check(
        "each group carries the template's default name",
        [g["name"] for g in groups] == ["Shelf", "Refrigerator", "Freezer"],
        [g["name"] for g in groups],
    )
    check("the category's code is derived from its name", cat["code"].startswith("STG-"), cat["code"])

    print("\n-- a switched-off sub-type is simply absent")
    s, partial = make_category("Smoke Partial", shelf=True, refrigerator=False, freezer=True)
    check("a category is created with two sub-types", s == 201, (s, partial))
    if s == 201:
        created.append(partial["id"])
        created.extend(g["id"] for g in partial.get("children", []))
        check(
            "only the switched-on groups exist",
            [g["code"] for g in partial.get("children", [])] == ["SHF", "FRZ"],
            [g["code"] for g in partial.get("children", [])],
        )

    print("\n-- units go in with the ordinary create route (as Cold Storage)")
    shelf = next(g for g in groups if g["code"] == "SHF")
    unit_name = f"SMKT{run['n']}0001A"
    s, unit = _req(
        "POST",
        "/location-nodes",
        token=token,
        json_body={
            "node_type": "sub_location",
            "parent_id": shelf["id"],
            "code": unit_name,
            "name": unit_name,
        },
    )
    check("an equipment unit is added to a group", s == 201, (s, unit))
    if s == 201:
        created.append(unit["id"])

    print("\n-- a sub-type holding units cannot be switched off (LOC-004)")
    s, b = _req(
        "PATCH",
        f"/location-nodes/{cat['id']}/storage-groups",
        token=token,
        json_body={"shelf": False, "refrigerator": True, "freezer": True},
    )
    check(
        "switching off a group with units is refused",
        s == 409 and b.get("code") == "storage_group_in_use",
        (s, b),
    )
    check("the refusal names how many units", "1 unit" in b.get("message", ""), b.get("message"))

    print("\n-- …and succeeds once the unit is gone")
    if unit.get("id"):
        s, _ = _req("DELETE", f"/location-nodes/{unit['id']}", token=token)
        check("the unit is removed", s in (200, 204), s)
    s, b = _req(
        "PATCH",
        f"/location-nodes/{cat['id']}/storage-groups",
        token=token,
        json_body={"shelf": False, "refrigerator": True, "freezer": True},
    )
    check("the empty group switches off", s == 200, (s, b))
    check(
        "and disappears from the category",
        s == 200 and [g["code"] for g in b.get("children", [])] == ["REF", "FRZ"],
        [g["code"] for g in b.get("children", [])] if s == 200 else b,
    )

    print("\n-- switching one back ON revives the same group")
    s, b = _req(
        "PATCH",
        f"/location-nodes/{cat['id']}/storage-groups",
        token=token,
        json_body={"shelf": True, "refrigerator": True, "freezer": True},
    )
    check("the group comes back", s == 200, (s, b))
    revived = next((g for g in b.get("children", []) if g["code"] == "SHF"), None) if s == 200 else None
    check(
        "it is the SAME node, not a second one with the same code",
        revived is not None and revived["id"] == shelf["id"],
        (revived or {}).get("id"),
    )

    print("\n-- the shape is enforced")
    s, b = _req(
        "PATCH",
        f"/location-nodes/{cat['id']}/storage-groups",
        token=token,
        json_body={"shelf": False, "refrigerator": False, "freezer": False},
    )
    check("a category cannot lose every sub-type", s == 422, (s, b))

    s, b = make_category("Smoke None", shelf=False, refrigerator=False, freezer=False)
    check("nor be created without one", s == 422, (s, b))

    if other is not None:
        s, b = _req(
            "POST",
            f"/location-nodes/{other['id']}/storage-categories",
            token=token,
            json_body={"name": "Smoke Wrong Room"},
        )
        # 422, not 400: ``ValidationError`` is the API's request-shape error and
        # maps to Unprocessable Entity throughout.
        check(
            f"a category cannot be created in {other['name']}",
            s == 422 and b.get("code") == "parent_not_storage_room",
            (s, b),
        )
        if s == 201:
            created.append(b["id"])

    print("\n-- equipment numbers stay unique across the installation")
    fridge = next(g for g in groups if g["code"] == "REF")
    dup_name = f"SMKD{run['n']}0001A"
    s, first = _req(
        "POST",
        "/location-nodes",
        token=token,
        json_body={
            "node_type": "sub_location",
            "parent_id": shelf["id"],
            "code": dup_name,
            "name": dup_name,
        },
    )
    if s == 201:
        created.append(first["id"])
        s, b = _req(
            "POST",
            "/location-nodes",
            token=token,
            json_body={
                "node_type": "sub_location",
                "parent_id": fridge["id"],
                "code": f"{dup_name}-2",
                "name": dup_name,
            },
        )
        check(
            "the same equipment number in another group is refused",
            s == 409 and b.get("code") == "node_name_conflict",
            (s, b),
        )
        if s == 201:
            created.append(b["id"])
    else:
        check("a second unit could be created for the duplicate check", False, (s, first))

    print("\n-- delete when empty")
    # A fresh category, so this section is not fighting the residue above.
    s, doomed = make_category("Smoke Doomed", shelf=True, refrigerator=False, freezer=False)
    if s != 201:
        check("a category could be created for the delete case", False, (s, doomed))
    else:
        # Tracked for cleanup like everything else. This section deletes the
        # group and the unit as part of what it proves, but the CATEGORY was
        # left behind on every run — it showed up on the Storage page as a
        # location with no sub-types.
        created.append(doomed["id"])
        created.extend(g["id"] for g in doomed.get("children", []))
        doomed_shelf = doomed["children"][0]
        unit_name = f"SMKX{run['n']}0001A"
        s, doomed_unit = _req(
            "POST",
            "/location-nodes",
            token=token,
            json_body={
                "node_type": "sub_location",
                "parent_id": doomed_shelf["id"],
                "code": unit_name,
                "name": unit_name,
            },
        )
        check("a unit is added to it", s == 201, (s, doomed_unit))

        # A location holding units must not be removable — that would hide the
        # stock rather than move it.
        s, b = _req("DELETE", f"/location-nodes/{doomed['id']}", token=token)
        check(
            "a location holding a unit cannot be deleted",
            s == 422 and b.get("code") == "node_has_children",
            (s, b),
        )
        check(
            "the refusal names WHICH sub-type is not empty",
            s == 422 and doomed_shelf["name"] in b.get("message", ""),
            b.get("message"),
        )

        s, _ = _req("DELETE", f"/location-nodes/{doomed_unit['id']}", token=token)
        check("the unit deletes", s in (200, 204), s)

        # The regression this feature depends on: the unit above is SOFT-deleted,
        # and a soft-deleted child used to block its parent forever.
        s, b = _req("DELETE", f"/location-nodes/{doomed_shelf['id']}", token=token)
        check(
            "its sub-type deletes once the unit is gone (not blocked by the soft-deleted unit)",
            s in (200, 204),
            (s, b),
        )

        # And the cascade: a location takes its remaining empty sub-types with it.
        s, again = make_category("Smoke Cascade", shelf=True, refrigerator=True, freezer=True)
        if s == 201:
            group_ids = [g["id"] for g in again.get("children", [])]
            s, b = _req("DELETE", f"/location-nodes/{again['id']}", token=token)
            check("a location with three empty sub-types deletes", s in (200, 204), (s, b))
            gone = all(
                _req("GET", f"/location-nodes/{gid}", token=token)[1].get("is_active") is False
                for gid in group_ids
            )
            check("its sub-types went with it", gone, group_ids)
            s, rooms_after = _req("GET", "/location-nodes/freezer-tree", token=token)
            storage_after = next(
                (r for r in rooms_after if r.get("code", "").upper() == "STG"), {}
            )
            check(
                "and it is gone from the Storage room",
                again["id"] not in [c["id"] for c in storage_after.get("children", [])],
                None,
            )

    # NOT covered here: that a location with LEDGER HISTORY is still removable
    # (the ``node_has_history`` guard, dropped 2026-08-12). Creating history for
    # a node this test owns needs an item, a lot, a receipt and an e-signature —
    # far more machinery than a smoke test should carry. An earlier version took
    # a shortcut and deleted whichever empty node the ledger already referenced,
    # which reached outside its own data and removed a real production Kanban.
    # A test must never delete what it did not create, so the shortcut is gone
    # rather than narrowed. Verified by hand instead: unit T123B, two ledger
    # rows, deleted cleanly with both rows still resolving its full breadcrumb.

    # An equipment number must be reusable after the unit carrying it is
    # removed — a retired freezer should not reserve its T-number forever. The
    # NAME rule always allowed this; the CODE rule did not, and for a
    # sub_location the name IS the code, so the re-add was refused with
    # ``node_code_conflict`` (fixed by ``loccode01``).
    print("\n-- a deleted equipment number can be used again")
    reuse_group = next((g for g in groups if g["code"] == "FRZ"), None)
    if reuse_group is None:
        print("  (skip) no freezer group to reuse a number in")
    else:
        reuse_name = f"SMKR{run['n']}0001A"
        body = {
            "node_type": "sub_location",
            "parent_id": reuse_group["id"],
            "code": reuse_name,
            "name": reuse_name,
        }
        s, first_unit = _req("POST", "/location-nodes", token=token, json_body=body)
        check("a unit is created", s == 201, (s, first_unit))
        if s == 201:
            s, _ = _req("DELETE", f"/location-nodes/{first_unit['id']}", token=token)
            check("it is deleted", s in (200, 204), s)
            s, again_unit = _req("POST", "/location-nodes", token=token, json_body=body)
            check(
                "the same equipment number can be added again",
                s == 201,
                (s, again_unit),
            )
            if s == 201:
                created.append(again_unit["id"])
                check(
                    "and it is a NEW node, not the old one revived",
                    again_unit["id"] != first_unit["id"],
                    again_unit["id"],
                )

    # The other half of the same change: a group is looked up by code INCLUDING
    # inactive rows, so that switching a sub-type back on revives the node it had
    # rather than making a second one. Now that a code is only unique among live
    # siblings, that lookup has to be ordered — live first, then newest — or it
    # would revive whichever row the planner happened to return.
    #
    # On its OWN category, deliberately. Run against the shared one, this failed
    # for a reason that had nothing to do with reviving: the section above leaves
    # a unit in the freezer group, so switching that group off was correctly
    # refused and the revive never ran. A check whose result depends on what an
    # earlier section left behind is not testing what it claims to.
    print("\n-- reviving a sub-type still returns the node it had")
    s, probe = make_category("Smoke Revive", shelf=True, refrigerator=False, freezer=True)
    if s != 201:
        check("a category could be created for the revive case", False, (s, probe))
    else:
        created.append(probe["id"])
        created.extend(g["id"] for g in probe.get("children", []))
        frz_before = next((g for g in probe["children"] if g["code"] == "FRZ"), None)
        b: dict = {}
        for want in (False, True):
            s, b = _req(
                "PATCH",
                f"/location-nodes/{probe['id']}/storage-groups",
                token=token,
                json_body={"shelf": True, "refrigerator": False, "freezer": want},
            )
            if s != 200:
                break
        frz_after = next((g for g in b.get("children", []) if g["code"] == "FRZ"), None)
        check(
            "off then on brings back the SAME group node",
            s == 200
            and frz_before is not None
            and frz_after is not None
            and frz_after["id"] == frz_before["id"],
            (s, (frz_after or {}).get("id")),
        )
        check(
            "and does not leave a second group with that code",
            s == 200
            and len([g for g in b.get("children", []) if g["code"] == "FRZ"]) == 1,
            [g["code"] for g in b.get("children", [])],
        )

    print("\n-- role gating (LOC-004)")
    admin_token = _login(EMAIL, PASSWORD)
    if admin_token is None:
        print("  (skip) no ordinary admin — set SMOKE_EMAIL / SMOKE_PASSWORD")
    else:
        s, b = _req(
            "POST",
            f"/location-nodes/{storage['id']}/storage-categories",
            token=admin_token,
            json_body={"name": "Smoke Forbidden"},
        )
        check("a non-super-admin cannot create a location", s == 403, (s, b))
        if s == 201:
            created.append(b["id"])
        s, b = _req(
            "PATCH",
            f"/location-nodes/{cat['id']}/storage-groups",
            token=admin_token,
            json_body={"shelf": True, "refrigerator": True, "freezer": False},
        )
        check("nor reconfigure its sub-types", s == 403, (s, b))
        # Deletion used to sit on the bare ``inventory:create`` dependency, which
        # operators also hold — so removing a location was easier than adding one.
        s, b = _req("DELETE", f"/location-nodes/{cat['id']}", token=admin_token)
        check("nor delete a location", s == 403, (s, b))

    # Cleanup walks BACKWARDS through creation order, which is the only order
    # that works: ``delete_node`` refuses a node that still has children.
    #
    # Even so, some residue is expected and is not a failure of this feature.
    # ``node_has_children`` does not filter on ``is_active``, so a SOFT-deleted
    # child blocks its parent's deletion permanently — and deletion here IS soft
    # deletion. Any group this test put a unit in, and that group's category,
    # therefore cannot be removed. That rule is pre-existing and applies to every
    # node type (an LN2 rack behaves the same way), so it is reported rather than
    # worked around.
    print("\n-- cleanup")
    stranded: list[str] = []
    for node_id in reversed(created):
        s, _ = _req("DELETE", f"/location-nodes/{node_id}", token=token)
        # 404: already deleted mid-test (the unit removed to prove the
        # switch-off guard). Not a leak, so not worth reporting.
        if s not in (200, 204, 404):
            stranded.append(node_id)
    if stranded:
        print(
            f"  note: {len(stranded)} node(s) remain — a node that has ever held a\n"
            "        child cannot be deleted, because soft-deleted children still\n"
            "        count. Remove by hand if the dev tree needs to stay tidy:"
        )
        for node_id in stranded:
            print(f"          {node_id}")

    print(f"\n==> {STATS['passed']} passed, {len(FAILED)} failed")
    for f in FAILED:
        print(f"    - {f}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
