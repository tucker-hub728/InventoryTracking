"""Ad-hoc smoke test: location sub-types (REQ-2026-08-04-LOC-001/004, amended 2026-08-13).

LOC-001 named three sub-types — "a configurable shelf, refrigerator, and freezer"
— and LOC-004 made them admin-configurable. The 2026-08-13 amendment then made
them configurable AFTER creation and allowed MORE THAN ONE of a kind: "an
additional freezer (e.g. minus-80 alongside minus-20)".

So a location is now CREATED BARE and its sub-types are added afterwards, one
kind at a time, each under a name the client chooses. There are still only the
three kinds; what tells two freezers apart is the name, and the server numbers
their codes (``FRZ``, then ``FRZ-2``).

The sub-types are REAL NODES, not a stored flag — a location's are simply the
``room_location`` children it has. So this test asserts the structure, not a
setting: removing a sub-type soft-deletes its node, and adding it back by name
revives that same node.

Storage is the only room with four levels (room → location → sub-type → unit), so
the parentage rules get exercised here too.

    SMOKE_SA_EMAIL=… SMOKE_SA_PASSWORD=… python backend/tests/smoke_storage_template.py

Verifies:
  * a new location is created with NO sub-types
  * the three kinds are added afterwards, and come back in kind order
  * a location may be given only some of the kinds
  * units are added to a sub-type with the ordinary create route (as Cold Storage)
  * removing a sub-type while it holds units is refused (409)
  * …and succeeds once the unit is gone
  * adding it back revives the SAME node, not a duplicate under a new code
  * a location can hold TWO freezers at once, told apart only by name (LOC-001)
  * a second freezer is numbered within its kind (FRZ-2) and sorts beside the first
  * an unnamed add gets a numbered default name rather than colliding
  * an equipment number is unique across BOTH freezers, "regardless of temperature"
  * a code is never reused within a kind after a sub-type is removed
  * a duplicate sub-type name on one location is refused (409)
  * an unknown kind is refused — there are only three
  * a DEBIT-AND-GONE location takes no sub-types at all (422), removal still works
  * a location may be left with NO sub-types (it is created that way)
  * every location lands in ONE Storage room, created on demand if absent
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
    # Deliberately NOT required to exist. The room is created by the server on
    # the first create, so this test also covers the cold-start path on a
    # database that has never seen Storage.
    storage = next((r for r in rooms if r.get("code", "").upper() == "STG"), None)
    print(f"==> Storage room: {'present' if storage else 'absent — will be created on demand'}")
    other = next((r for r in rooms if r.get("code", "").upper() in ("CS", "MM", "AL")), None)

    # Everything this test makes, in CREATION order. Cleanup walks it backwards,
    # which is also the only order that works: ``delete_node`` refuses a node that
    # still has children, so a category cannot go until its groups have, and a
    # group cannot go until its units have.
    created: list[str] = []
    run = {"n": 1}

    def make_category(name: str, **extra):
        for _ in range(60):
            payload = {"name": f"{name} {run['n']}", **extra}
            s, b = _req(
                "POST",
                "/location-nodes/storage-categories",
                token=token,
                json_body=payload,
            )
            if s == 409:
                run["n"] += 1
                continue
            return s, b
        return 0, {"raw": "ran out of suffixes"}

    def set_groups(cat_id: str, *, keep: list[dict], add: tuple = ()):
        """PATCH the sub-type list to exactly ``keep`` + ``add``.

        The payload is DECLARATIVE (LOC-001): kept sub-types go by id, new ones
        by KIND (optionally with a name), and anything not listed is removed. It
        replaced three booleans, which could not express two freezers.

        ``add`` entries are either a kind (``"freezer"``, taking the kind's
        default name) or a ``(kind, name)`` pair.
        """
        entries: list[dict] = [{"id": g["id"]} for g in keep]
        for a in add:
            entries.append({"kind": a[0], "name": a[1]} if isinstance(a, tuple) else {"kind": a})
        return _req(
            "PATCH",
            f"/location-nodes/{cat_id}/storage-groups",
            token=token,
            json_body={"groups": entries},
        )

    def add_unit(parent_id: str, name: str):
        return _req(
            "POST",
            "/location-nodes",
            token=token,
            json_body={
                "node_type": "sub_location",
                "parent_id": parent_id,
                "code": name,
                "name": name,
            },
        )

    print("\n-- a new location is created BARE")
    s, cat = make_category("Smoke Location")
    check("a category is created", s == 201, (s, cat))
    if s != 201:
        print("==> cannot continue without a category")
        return 1
    created.append(cat["id"])
    check(
        "it has NO sub-types — they are added afterwards (LOC-001)",
        cat.get("children") == [],
        cat.get("children"),
    )
    check("the category's code is derived from its name", cat["code"].startswith("STG-"), cat["code"])

    print("\n-- the three kinds are added afterwards")
    s, cat = set_groups(cat["id"], keep=[], add=("shelf", "refrigerator", "freezer"))
    check("all three kinds are added in one save", s == 200, (s, cat))
    groups = cat.get("children", []) if s == 200 else []
    created.extend(g["id"] for g in groups)
    check("the location now has three sub-types", len(groups) == 3, groups)
    check(
        "in KIND order — Shelf, Refrigerator, Freezer",
        [g["code"] for g in groups] == ["SHF", "REF", "FRZ"],
        [g["code"] for g in groups],
    )
    check(
        "each carries its kind's default name",
        [g["name"] for g in groups] == ["Shelf", "Refrigerator", "Freezer"],
        [g["name"] for g in groups],
    )

    print("\n-- a location may be given only some of the kinds")
    s, partial = make_category("Smoke Partial")
    if s == 201:
        created.append(partial["id"])
        s, partial = set_groups(partial["id"], keep=[], add=("shelf", "freezer"))
        check("two kinds are added", s == 200, (s, partial))
        created.extend(g["id"] for g in partial.get("children", []))
        check(
            "only those two exist",
            [g["code"] for g in partial.get("children", [])] == ["SHF", "FRZ"],
            [g["code"] for g in partial.get("children", [])],
        )

    print("\n-- units go in with the ordinary create route (as Cold Storage)")
    shelf = next(g for g in groups if g["code"] == "SHF")
    ref = next(g for g in groups if g["code"] == "REF")
    frz = next(g for g in groups if g["code"] == "FRZ")
    unit_name = f"SMKT{run['n']}0001A"
    s, unit = add_unit(shelf["id"], unit_name)
    check("an equipment unit is added to a sub-type", s == 201, (s, unit))
    if s == 201:
        created.append(unit["id"])

    print("\n-- a sub-type holding units cannot be removed (LOC-004)")
    s, b = set_groups(cat["id"], keep=[ref, frz])
    check(
        "removing a sub-type with units is refused",
        s == 409 and b.get("code") == "storage_group_in_use",
        (s, b),
    )
    check("the refusal names how many units", "1 unit" in b.get("message", ""), b.get("message"))

    print("\n-- …and succeeds once the unit is gone")
    if unit.get("id"):
        s, _ = _req("DELETE", f"/location-nodes/{unit['id']}", token=token)
        check("the unit is removed", s in (200, 204), s)
    s, b = set_groups(cat["id"], keep=[ref, frz])
    check("the empty sub-type is removed", s == 200, (s, b))
    check(
        "and disappears from the category",
        s == 200 and [g["code"] for g in b.get("children", [])] == ["REF", "FRZ"],
        [g["code"] for g in b.get("children", [])] if s == 200 else b,
    )

    print("\n-- adding it back revives the SAME node")
    # By KIND + NAME, not by id: a removed sub-type has no id the client can send
    # (the list only carries the live ones), so re-adding is an add that the
    # server recognises. If it created a fresh node instead, the old one's code
    # would be orphaned and every link built from it would break.
    s, b = set_groups(cat["id"], keep=[ref, frz], add=(("shelf", shelf["name"]),))
    check("the sub-type comes back", s == 200, (s, b))
    revived = next((g for g in b.get("children", []) if g["code"] == "SHF"), None) if s == 200 else None
    check(
        "it is the SAME node, not a second one with that name",
        revived is not None and revived["id"] == shelf["id"],
        (revived or {}).get("id"),
    )

    print("\n-- a location can hold TWO freezers at once (LOC-001)")
    # The requirement's own example, and the case three booleans could not
    # express: "an additional freezer (e.g. minus-80 alongside minus-20)".
    s, b = set_groups(
        cat["id"], keep=[shelf, ref, frz], add=(("freezer", "Smoke Minus-80 Freezer"),)
    )
    check("a fourth sub-type is added", s == 200, (s, b))
    kids = b.get("children", []) if s == 200 else []
    extra = next((g for g in kids if g["name"] == "Smoke Minus-80 Freezer"), None)
    if extra:
        created.append(extra["id"])
    check("the location now has four sub-types", len(kids) == 4, [g["name"] for g in kids])
    check(
        "the second freezer is numbered within its KIND — FRZ-2",
        extra is not None and extra["code"] == "FRZ-2",
        (extra or {}).get("code"),
    )
    check(
        "and sorts beside the first freezer, not at the end",
        [g["code"] for g in kids] == ["SHF", "REF", "FRZ", "FRZ-2"],
        [g["code"] for g in kids],
    )

    print("\n-- an equipment number is unique across BOTH freezers")
    # LOC-001's second sentence: "freezers are identified by unique equipment
    # number regardless of temperature". Nothing in the code knows either of
    # these sub-types is a freezer — the guard is that a ``sub_location`` name is
    # unique installation-wide, whatever it hangs under.
    shared_name = f"SMKT{run['n']}0002A"
    s, in_20 = add_unit(frz["id"], shared_name)
    check("the number goes into the minus-20 freezer", s == 201, (s, in_20))
    if s == 201:
        created.append(in_20["id"])
    if extra:
        s, b = add_unit(extra["id"], shared_name)
        check(
            "the SAME number is refused in the minus-80 freezer",
            s == 409 and b.get("code") == "node_name_conflict",
            (s, b),
        )

    print("\n-- an unnamed add gets a numbered default rather than colliding")
    # "Freezer" is taken, so a bare ``{"kind": "freezer"}`` must not fail on the
    # sibling-name index — the Add button offers no name field until you type one.
    s, b = set_groups(cat["id"], keep=[shelf, ref, frz, extra], add=("freezer",))
    auto = (
        next((g for g in b.get("children", []) if g["code"] == "FRZ-3"), None) if s == 200 else None
    )
    if auto:
        created.append(auto["id"])
    check("a third unnamed freezer is accepted", s == 200, (s, b))
    check(
        "and is named 'Freezer 2' — the kind's name, numbered past the live one",
        auto is not None and auto["name"] == "Freezer 2",
        (auto or {}).get("name"),
    )

    print("\n-- two sub-types cannot share a name")
    s, b = set_groups(cat["id"], keep=[shelf, ref, frz], add=(("freezer", frz["name"]),))
    check(
        "adding a name the location already uses is refused",
        s == 409 and b.get("code") == "node_name_conflict",
        (s, b),
    )
    s, b = set_groups(
        cat["id"],
        keep=[shelf, ref, frz],
        add=(("shelf", "Dup Name"), ("freezer", "dup name")),
    )
    check("nor two new sub-types with one name, case-insensitively", s == 422, (s, b))

    print("\n-- a code is never reused within a kind")
    # ``uq_location_nodes_parent_code`` is partial on ``is_active``, so a removed
    # FRZ-2 would NOT stop a new freezer taking that code — and a link to
    # /storage/{cat}/frz-2 minted earlier would then open a different sub-type.
    # The sequence only ever goes up.
    if extra:
        s, b = set_groups(cat["id"], keep=[shelf, ref, frz])
        check("the added freezers are removed", s == 200, (s, b))
        s, b = set_groups(cat["id"], keep=[shelf, ref, frz], add=(("freezer", "Smoke Later Freezer"),))
        later = (
            next((g for g in b.get("children", []) if g["name"] == "Smoke Later Freezer"), None)
            if s == 200
            else None
        )
        if later:
            created.append(later["id"])
        check(
            "the next freezer is FRZ-4, not FRZ-2 again",
            later is not None and later["code"] == "FRZ-4",
            (later or {}).get("code"),
        )

    print("\n-- a debit-and-gone location takes NO sub-types (client 2026-08-19)")
    # It is a DISPOSITION, not a place: material issued there leaves inventory, so
    # it has nowhere to put anything. The UI already suppressed its tabs and hid
    # its Configure entry, but the old create dialog left its three switches on
    # behind the debit-and-gone choice and sent them anyway — which is how live
    # scrap locations ended up carrying three sub-type nodes no screen rendered
    # and no control could remove. The server refuses them now.
    s, scrap = make_category("Smoke Scrap", is_scrap=True)
    check("a debit-and-gone location is created", s == 201, (s, scrap))
    if s == 201:
        created.append(scrap["id"])
        check("it is flagged", scrap.get("is_scrap") is True, scrap.get("is_scrap"))
        check("and starts with no sub-types", scrap.get("children") == [], scrap.get("children"))
        s, b = set_groups(scrap["id"], keep=[], add=("shelf",))
        check(
            "adding a sub-type to it is refused",
            s == 422 and b.get("code") == "storage_groups_scrap",
            (s, b),
        )
        check(
            "and the refusal explains why, not just that",
            "leaves inventory" in b.get("message", ""),
            b.get("message"),
        )
        # Removal stays legal — that is the path that clears out the sub-types
        # live scrap locations were given before this rule.
        s, b = set_groups(scrap["id"], keep=[])
        check("an empty list is still accepted on one", s == 200, (s, b))

    print("\n-- the shape is enforced")
    # On ``partial``, not ``cat``: cat's freezer still holds the equipment number
    # from the section above, so emptying cat would be refused for a reason that
    # has nothing to do with what this checks.
    s, b = set_groups(partial["id"], keep=[])
    check(
        # Legal now: a location is CREATED with none, so refusing to return to
        # zero would make the first save a one-way door.
        "a location may be left with no sub-types",
        s == 200 and b.get("children") == [],
        (s, b.get("children")),
    )
    s, b = _req(
        "PATCH",
        f"/location-nodes/{cat['id']}/storage-groups",
        token=token,
        json_body={"groups": [{"id": shelf["id"], "name": "Renamed Here"}]},
    )
    check("an entry cannot carry both id and name (rename has its own route)", s == 422, (s, b))
    s, b = _req(
        "PATCH",
        f"/location-nodes/{cat['id']}/storage-groups",
        token=token,
        json_body={"groups": [{"kind": "icebox"}]},
    )
    check("an unknown kind is refused — there are only three", s == 422, (s, b))
    s, b = _req(
        "PATCH",
        f"/location-nodes/{cat['id']}/storage-groups",
        token=token,
        json_body={"groups": [{"id": cat["id"]}]},
    )
    check(
        "keeping a sub-type that isn't on this location is refused",
        s == 422 and b.get("code") == "storage_group_not_found",
        (s, b),
    )

    # "A category cannot be created in the wrong room" used to be checked here by
    # POSTing at the Analytical Lab's id. The route no longer takes a room id at
    # all — the server resolves the one Storage room — so that case is now
    # unrepresentable rather than merely rejected, and there is nothing to assert.
    #
    # What replaces it is the invariant that made it safe to drop: however many
    # locations are created, they all land in ONE room, and no second Storage
    # room appears alongside it.
    s, all_rooms = _req("GET", "/location-nodes/freezer-tree", token=token)
    stg_rooms = [r for r in all_rooms if r.get("code", "").upper() == "STG"] if s == 200 else []
    check("there is exactly one Storage room", len(stg_rooms) == 1, len(stg_rooms))
    check(
        "and every location created so far is inside it",
        len(stg_rooms) == 1
        and all(
            cid in [c["id"] for c in stg_rooms[0].get("children", [])]
            for cid in (cat["id"], partial.get("id"))
            if cid
        ),
        None,
    )
    if other is not None:
        # The other rooms are exempt from the template (LOC-002 / LOC-003) and
        # must not have grown a category as a side effect.
        s, other_now = _req("GET", f"/location-nodes/{other['id']}/children", token=token)
        check(
            f"{other['name']} has no Storage categories",
            s == 200
            and not any(n.get("node_type") == "storage_category" for n in other_now),
            [n.get("node_type") for n in (other_now if s == 200 else [])],
        )

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
    s, doomed = make_category("Smoke Doomed")
    if s == 201:
        s, doomed = set_groups(doomed["id"], keep=[], add=("shelf",))
    if s not in (200, 201):
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
        s, again = make_category("Smoke Cascade")
        if s == 201:
            s, again = set_groups(
                again["id"], keep=[], add=("shelf", "refrigerator", "freezer")
            )
        if s == 200:
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

    # The other half of the same change: a sub-type is looked up by NAME including
    # inactive rows, so that adding one back revives the node it had rather than
    # making a second one. Now that a name is only unique among live siblings,
    # that lookup has to be ordered — live first, then newest — or it would revive
    # whichever row the planner happened to return.
    #
    # On its OWN category, deliberately. Run against the shared one, this failed
    # for a reason that had nothing to do with reviving: the section above leaves
    # a unit in the freezer sub-type, so removing it was correctly refused and the
    # revive never ran. A check whose result depends on what an earlier section
    # left behind is not testing what it claims to.
    print("\n-- re-adding a sub-type still returns the node it had")
    s, probe = make_category("Smoke Revive")
    if s == 201:
        created.append(probe["id"])
        s, probe = set_groups(probe["id"], keep=[], add=("shelf", "freezer"))
    if s != 200:
        check("a category could be created for the revive case", False, (s, probe))
    else:
        created.extend(g["id"] for g in probe.get("children", []))
        probe_shelf = next(g for g in probe["children"] if g["code"] == "SHF")
        frz_before = next((g for g in probe["children"] if g["code"] == "FRZ"), None)
        # A unit goes in and comes out again first, so the sub-type being revived
        # is one that has actually been USED — the case where its node identity
        # matters, because ledger rows and links already name it.
        #
        # SMKV, not SMKR: the reuse section above leaves an SMKR unit live, and a
        # sub_location name is unique INSTALLATION-wide, so the two would collide
        # in a way that has nothing to do with what this section tests.
        parked_name = f"SMKV{run['n']}0001A"
        s, parked = add_unit(frz_before["id"], parked_name) if frz_before else (0, {})
        check("a unit is parked in the freezer sub-type", s == 201, (s, parked))
        if s == 201:
            created.append(parked["id"])
            # It has to be EMPTY to be removable — the point here is the revive,
            # not the in-use guard, which has its own section above.
            s, _ = _req("DELETE", f"/location-nodes/{parked['id']}", token=token)
            check("…and taken out again so the sub-type can be removed", s in (200, 204), s)
        b: dict = {}
        if frz_before is not None:
            # Off…
            s, b = set_groups(probe["id"], keep=[probe_shelf])
            check("the freezer sub-type is removed", s == 200, (s, b))
            # …and on again, as the same KIND under the name it had.
            if s == 200:
                s, b = set_groups(
                    probe["id"], keep=[probe_shelf], add=(("freezer", frz_before["name"]),)
                )
        frz_after = next((g for g in b.get("children", []) if g["code"] == "FRZ"), None)
        check(
            "off then on brings back the SAME sub-type node",
            s == 200
            and frz_before is not None
            and frz_after is not None
            and frz_after["id"] == frz_before["id"],
            (s, (frz_after or {}).get("id")),
        )
        check(
            "and does not leave a second sub-type with that code",
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
            "/location-nodes/storage-categories",
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
            # A VALID payload, deliberately: the body is validated before the
            # route runs, so a malformed one would 422 and never reach the
            # permission check this is here to prove.
            json_body={"groups": [{"kind": "freezer", "name": "Smoke Forbidden Sub-type"}]},
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
