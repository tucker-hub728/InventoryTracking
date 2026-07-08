"""``/v1/locations`` routes.

Week-1 reset (2026-07-06): a flat, self-referencing location list. A
location is a top-level location or a shelf sub-location under one; writes
are NOT e-signed. Reads require ``locations:view``; create / edit require
``locations:create`` / ``locations:edit``.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, status

from app.api.deps import DBSession
from app.core.exceptions import ConflictError, NotFoundError, ValidationError
from app.locations import repository as loc_repo
from app.locations.schemas import (
    LocationContentRow,
    LocationContents,
    LocationCreate,
    LocationOverview,
    LocationRead,
    LocationUpdate,
    ShelfOverview,
)
from app.models.locations import Location
from app.security.permissions import RequirePermission

router = APIRouter(prefix="/locations", tags=["locations"])


def _parse_uuid(value: str, *, field: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError as exc:
        raise ValidationError(f"{field} is not a valid UUID", code=f"invalid_{field}") from exc


def _to_read(location: Location, parent_name: str | None) -> LocationRead:
    return LocationRead(
        id=str(location.id),
        location_name=location.location_name,
        location_type=location.location_type,
        parent_location_id=(
            str(location.parent_location_id) if location.parent_location_id else None
        ),
        parent_name=parent_name,
        is_active=location.is_active,
        created_at=location.created_at,
        updated_at=location.updated_at,
    )


async def _resolve_parent(
    db: DBSession, parent_location_id: str, *, child_id: uuid.UUID | None = None
) -> Location:
    """Validate a parent reference and return the parent row.

    Enforces the two-level rule (LOC-003): the parent must itself be a
    top-level location — a shelf cannot own sub-shelves.
    """
    parent_uuid = _parse_uuid(parent_location_id, field="parent_location_id")
    if child_id is not None and parent_uuid == child_id:
        raise ValidationError("A location cannot be its own parent", code="invalid_parent")
    parent = await loc_repo.get_location(db, parent_uuid)
    if parent is None:
        raise NotFoundError(f"Parent location {parent_location_id} not found")
    if parent.parent_location_id is not None:
        raise ValidationError(
            "A shelf cannot have sub-locations — locations are two levels "
            "(location → shelf) only",
            code="parent_not_top_level",
        )
    return parent


@router.get(
    "",
    response_model=list[LocationRead],
    summary="List locations",
    dependencies=[Depends(RequirePermission("locations", "view"))],
)
async def list_locations(
    db: DBSession,
    active: Annotated[bool | None, Query()] = None,
    parent_id: Annotated[uuid.UUID | None, Query()] = None,
) -> list[LocationRead]:
    rows = await loc_repo.list_locations(db, active=active, parent_id=parent_id)
    return [_to_read(loc, parent_name) for loc, parent_name in rows]


@router.get(
    "/overview",
    response_model=list[LocationOverview],
    summary="Top-level locations grouped for the by-category view, with "
    "rolled-up on-hand + distinct-lot counts and their shelves",
    dependencies=[Depends(RequirePermission("locations", "view"))],
)
async def locations_overview(db: DBSession) -> list[LocationOverview]:
    locs = await loc_repo.list_all(db)
    stock = await loc_repo.all_stock_min(db)

    # Direct (non-rolled-up) aggregates per location.
    qty: dict[uuid.UUID, Decimal] = defaultdict(lambda: Decimal(0))
    lots: dict[uuid.UUID, set[str]] = defaultdict(set)
    for location_id, lot_number, quantity in stock:
        qty[location_id] += quantity
        if lot_number:
            lots[location_id].add(lot_number)

    children: dict[uuid.UUID, list[Location]] = defaultdict(list)
    tops: list[Location] = []
    for loc in locs:
        if loc.parent_location_id is None:
            tops.append(loc)
        else:
            children[loc.parent_location_id].append(loc)

    overview: list[LocationOverview] = []
    for top in tops:
        kids = children.get(top.id, [])
        roll_qty = qty[top.id] + sum((qty[k.id] for k in kids), Decimal(0))
        roll_lots: set[str] = set(lots[top.id])
        for k in kids:
            roll_lots |= lots[k.id]
        overview.append(
            LocationOverview(
                id=str(top.id),
                location_name=top.location_name,
                location_type=top.location_type,
                is_active=top.is_active,
                on_hand=roll_qty,
                distinct_lots=len(roll_lots),
                children=[
                    ShelfOverview(
                        id=str(k.id),
                        location_name=k.location_name,
                        location_type=k.location_type,
                        parent_location_id=str(top.id),
                        is_active=k.is_active,
                        on_hand=qty[k.id],
                        distinct_lots=len(lots[k.id]),
                    )
                    for k in kids
                ],
            )
        )
    return overview


@router.get(
    "/{location_id}/contents",
    response_model=LocationContents,
    summary="Items and lots physically stored in a location (incl. its shelves)",
    dependencies=[Depends(RequirePermission("locations", "view"))],
)
async def get_location_contents(
    db: DBSession,
    location_id: Annotated[uuid.UUID, Path()],
) -> LocationContents:
    loc = await loc_repo.get_location(db, location_id)
    if loc is None:
        raise NotFoundError(f"Location {location_id} not found")
    # This location + its shelves — so a top-level card shows its whole holdings.
    ids = [location_id, *await loc_repo.child_ids(db, location_id)]
    rows = await loc_repo.location_contents(db, ids)
    return LocationContents(
        rows=[
            LocationContentRow(
                location_id=str(r.location_id),
                location_name=r.location_name,
                item_id=str(r.item_id),
                item_code=r.item_code,
                item_name=r.item_name,
                lot_number=r.lot_number,
                expiry_date=r.expiry_date,
                quantity_available=r.quantity_available,
                unit_of_measure=r.unit_of_measure,
            )
            for r in rows
        ]
    )


@router.get(
    "/{location_id}",
    response_model=LocationRead,
    summary="Get one location",
    dependencies=[Depends(RequirePermission("locations", "view"))],
)
async def get_location(
    db: DBSession,
    location_id: Annotated[uuid.UUID, Path()],
) -> LocationRead:
    row = await loc_repo.get_location_row(db, location_id)
    if row is None:
        raise NotFoundError(f"Location {location_id} not found")
    loc, parent_name = row
    return _to_read(loc, parent_name)


@router.post(
    "",
    response_model=LocationRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create a location",
    dependencies=[Depends(RequirePermission("locations", "create"))],
)
async def create_location(
    db: DBSession,
    payload: LocationCreate,
) -> LocationRead:
    parent: Location | None = None
    if payload.parent_location_id is not None:
        parent = await _resolve_parent(db, payload.parent_location_id)
        # A shelf lives in the same category as its parent (LOC-003).
        if parent.location_type != payload.location_type:
            raise ValidationError(
                "A shelf's category must match its parent location",
                code="category_mismatch",
            )

    loc = await loc_repo.create_location(
        db,
        location_name=payload.location_name,
        location_type=payload.location_type,
        parent_location_id=parent.id if parent else None,
        is_active=payload.is_active,
    )
    # Load server-side defaults (created_at / updated_at) before the sync
    # serializer touches them — a lazy load there raises MissingGreenlet.
    await db.refresh(loc)
    parent_name = parent.location_name if parent else None
    response = _to_read(loc, parent_name)
    await db.commit()
    return response


@router.patch(
    "/{location_id}",
    response_model=LocationRead,
    summary="Update a location (location_code is immutable)",
    dependencies=[Depends(RequirePermission("locations", "edit"))],
)
async def update_location(
    db: DBSession,
    location_id: Annotated[uuid.UUID, Path()],
    payload: LocationUpdate,
) -> LocationRead:
    loc = await loc_repo.get_location(db, location_id)
    if loc is None:
        raise NotFoundError(f"Location {location_id} not found")

    data = payload.model_dump(exclude_unset=True)
    if "location_name" in data and data["location_name"] is not None:
        loc.location_name = data["location_name"]
    if "location_type" in data and data["location_type"] is not None:
        loc.location_type = data["location_type"]
    if "parent_location_id" in data:
        raw_parent = data["parent_location_id"]
        if raw_parent is None:
            loc.parent_location_id = None
        else:
            parent = await _resolve_parent(db, raw_parent, child_id=location_id)
            # Keep the two-level rule: a location that has shelves can't itself
            # become a shelf.
            if await loc_repo.count_children(db, location_id) > 0:
                raise ValidationError(
                    "A location with sub-locations cannot become a shelf",
                    code="has_children",
                )
            if parent.location_type != loc.location_type:
                raise ValidationError(
                    "A shelf's category must match its parent location",
                    code="category_mismatch",
                )
            loc.parent_location_id = parent.id
    if "is_active" in data and data["is_active"] is not None:
        loc.is_active = data["is_active"]

    await db.flush()
    await db.refresh(loc)
    parent_name: str | None = None
    if loc.parent_location_id is not None:
        parent = await loc_repo.get_location(db, loc.parent_location_id)
        parent_name = parent.location_name if parent else None
    response = _to_read(loc, parent_name)
    await db.commit()
    return response


@router.delete(
    "/{location_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a location (only when empty — no shelves, stock, or history)",
    dependencies=[Depends(RequirePermission("locations", "delete"))],
)
async def delete_location(
    db: DBSession,
    location_id: Annotated[uuid.UUID, Path()],
) -> None:
    """Hard delete, allowed only when the location is empty. Blocked (409) if
    it has shelves, on-hand stock, or is referenced by any transaction line —
    matching the greyed-out Delete in the UI and the ON DELETE RESTRICT FKs."""
    loc = await loc_repo.get_location(db, location_id)
    if loc is None:
        raise NotFoundError(f"Location {location_id} not found")

    if await loc_repo.count_children(db, location_id) > 0:
        raise ConflictError(
            "This location has sub-locations — delete them first",
            code="location_has_children",
        )
    if await loc_repo.location_has_stock(db, location_id):
        raise ConflictError(
            "This location still holds stock — move or consume it first",
            code="location_has_stock",
        )
    if await loc_repo.location_has_txn_lines(db, location_id):
        raise ConflictError(
            "This location is referenced by transaction history and cannot be deleted",
            code="location_referenced",
        )

    await loc_repo.delete_location(db, loc)
    await db.commit()
