"""``/v1/item-tiers`` and BOM routes (``/v1/items/{id}/bom``, …).

Reads require ``inventory:view``. Writes require ``inventory:sign`` and are
electronically signed — every create/update/delete consumes a fresh reauth
ticket and records the reason on the audit row, mirroring lot edits.
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, status
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentDbUserDep, DBSession
from app.audit import record_entity_change
from app.auth.reauth import consume_reauth_evidence
from app.catalog import repository as cat_repo
from app.catalog.schemas import (
    BomLineCreate,
    BomLineDelete,
    BomLineRead,
    BomLineUpdate,
    ItemBomResponse,
    TierCreate,
    TierDelete,
    TierRead,
    TierUpdate,
    WhereUsedRead,
)
from app.core.exceptions import ConflictError, NotFoundError, ValidationError
from app.inventory import repository as inv_repo
from app.models.inventory import BUILT_TIER_TYPES, BomLine, ItemTier
from app.security.permissions import RequirePermission

tiers_router = APIRouter(prefix="/item-tiers", tags=["tiers"])
bom_router = APIRouter(tags=["bom"])


# ── Helpers ────────────────────────────────────────────────────────────


def _parse_uuid_or_422(value: str, *, field: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError as exc:
        raise ValidationError(
            f"{field} is not a valid UUID", code=f"invalid_{field}"
        ) from exc


def _tier_to_read(cat: ItemTier, item_count: int) -> TierRead:
    return TierRead(
        id=str(cat.id),
        name=cat.name,
        prefix=cat.prefix,
        type=cat.type,  # type: ignore[arg-type]
        tone=cat.tone,
        is_seeded=cat.is_seeded,
        item_count=item_count,
        created_at=cat.created_at,
        updated_at=cat.updated_at,
    )


def _bom_line_to_read(line: BomLine, *, child_has_bom: bool) -> BomLineRead:
    """Serialise a BOM line. ``child_qty_available`` is the child's real
    available stock (on-hand minus expired) and ``child_status_code`` its real
    stock status — the same numbers the inventory list shows."""
    child = line.child_item
    stock = child.stock if child else None
    qty_on_hand = stock.qty_on_hand if stock else Decimal("0")
    qty_available = stock.qty_available if stock else Decimal("0")
    status_code = stock.status_code if stock else "out_of_stock"
    cat = child.tier if child else None
    return BomLineRead(
        id=str(line.id),
        parent_item_id=str(line.parent_item_id),
        child_item_id=str(line.child_item_id),
        child_item_number=child.item_number if child else "",
        child_description=child.description if child else "",
        child_tier_name=cat.name if cat else "",
        child_tier_type=cat.type if cat else "raw_material",  # type: ignore[arg-type]
        child_tier_tone=cat.tone if cat else "neutral",
        qty_per_unit=line.qty_per_unit,
        child_qty_on_hand=qty_on_hand,
        child_qty_available=qty_available,
        child_status_code=status_code,  # type: ignore[arg-type]
        child_has_bom=child_has_bom,
        created_at=line.created_at,
        updated_at=line.updated_at,
    )


async def _line_read(db: DBSession, line: BomLine) -> BomLineRead:
    """Serialise one BOM line (child stock from the item's own v_item_stock)."""
    have_bom = await inv_repo.items_with_bom(db, [line.child_item_id])
    return _bom_line_to_read(line, child_has_bom=line.child_item_id in have_bom)


# Defensive ceiling on how deep the nested-BOM walk recurses. BOM cycles are
# rejected at create time, so the graph is a DAG; this only guards against a
# pathological chain (and pairs with the ancestor-path check below).
_MAX_BOM_DEPTH = 20


async def _build_bom_subtree(
    db: DBSession,
    parent_item_id: uuid.UUID,
    ancestors: frozenset[uuid.UUID],
    depth: int,
) -> list[BomLineRead]:
    """Recursively serialise a parent's BOM lines, embedding each built child's
    own lines in ``children``. ``ancestors`` is the chain from the root down to
    (and including) this parent, so a would-be cycle stops expanding instead of
    looping forever."""
    lines = await cat_repo.list_bom_lines(db, parent_item_id)
    if not lines:
        return []
    have_bom = await inv_repo.items_with_bom(db, [ln.child_item_id for ln in lines])
    reads: list[BomLineRead] = []
    for ln in lines:
        child_has_bom = ln.child_item_id in have_bom
        read = _bom_line_to_read(ln, child_has_bom=child_has_bom)
        if (
            child_has_bom
            and depth < _MAX_BOM_DEPTH
            and ln.child_item_id not in ancestors
        ):
            read.children = await _build_bom_subtree(
                db,
                ln.child_item_id,
                ancestors | {ln.child_item_id},
                depth + 1,
            )
        reads.append(read)
    return reads


# ── Tiers ─────────────────────────────────────────────────────────


@tiers_router.get(
    "",
    response_model=list[TierRead],
    summary="List item tiers",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_tiers(db: DBSession) -> list[TierRead]:
    cats = await cat_repo.list_tiers(db)
    counts = await cat_repo.tier_item_counts(db, [c.id for c in cats])
    return [_tier_to_read(c, counts.get(c.id, 0)) for c in cats]


@tiers_router.get(
    "/{tier_id}",
    response_model=TierRead,
    summary="Get one item tier",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def get_tier(
    db: DBSession, tier_id: Annotated[uuid.UUID, Path()]
) -> TierRead:
    cat = await cat_repo.get_tier(db, tier_id)
    if cat is None:
        raise NotFoundError(f"Tier {tier_id} not found")
    counts = await cat_repo.tier_item_counts(db, [cat.id])
    return _tier_to_read(cat, counts.get(cat.id, 0))


@tiers_router.post(
    "",
    response_model=TierRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create an item tier (e-signed)",
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def create_tier(
    db: DBSession, current: CurrentDbUserDep, payload: TierCreate
) -> TierRead:
    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")
    if (await cat_repo.get_tier_by_name(db, payload.name)) is not None:
        raise ConflictError(
            f"Tier '{payload.name}' already exists", code="tier_name_conflict"
        )
    if (await cat_repo.get_tier_by_prefix(db, payload.prefix)) is not None:
        raise ConflictError(
            f"Prefix '{payload.prefix}' is already in use",
            code="tier_prefix_conflict",
        )
    try:
        cat = await cat_repo.create_tier(
            db,
            name=payload.name,
            prefix=payload.prefix,
            tier_type=payload.type,
            tone=payload.tone,
            created_by_user_id=current.id,
        )
    except IntegrityError as exc:
        await db.rollback()
        msg = str(exc.orig).lower() if exc.orig else str(exc).lower()
        if "uq_item_tiers_prefix" in msg:
            raise ConflictError(
                f"Prefix '{payload.prefix}' is already in use",
                code="tier_prefix_conflict",
            ) from exc
        raise ConflictError(
            f"Tier '{payload.name}' already exists", code="tier_name_conflict"
        ) from exc

    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="created",
        subject_table="app.item_tiers",
        subject_id=cat.id,
        subject_label=cat.name,
        before=None,
        after=cat_repo.tier_to_audit_snapshot(cat),
        context={"reason": payload.reason},
        signature_id=evidence_uuid,
    )
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="tier.create",
        target_table="app.item_tiers",
        target_id=cat.id,
    )
    result = _tier_to_read(cat, 0)
    await db.commit()
    return result


@tiers_router.patch(
    "/{tier_id}",
    response_model=TierRead,
    summary="Update an item tier (e-signed). Kind is immutable.",
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def update_tier(
    db: DBSession,
    current: CurrentDbUserDep,
    tier_id: Annotated[uuid.UUID, Path()],
    payload: TierUpdate,
) -> TierRead:
    patch = payload.model_dump(exclude_unset=True)
    evidence_uuid = _parse_uuid_or_422(str(patch.pop("evidence_id")), field="evidence_id")
    reason = patch.pop("reason", "")
    if not patch:
        raise ValidationError("No fields to update", code="empty_patch")

    cat = await cat_repo.get_tier(db, tier_id)
    if cat is None:
        raise NotFoundError(f"Tier {tier_id} not found")

    new_name = patch.get("name")
    if new_name is not None:
        clash = await cat_repo.get_tier_by_name(db, str(new_name))
        if clash is not None and clash.id != cat.id:
            raise ConflictError(
                f"Tier '{new_name}' already exists",
                code="tier_name_conflict",
            )

    new_prefix = patch.get("prefix")
    if new_prefix is not None:
        clash = await cat_repo.get_tier_by_prefix(db, str(new_prefix))
        if clash is not None and clash.id != cat.id:
            raise ConflictError(
                f"Prefix '{new_prefix}' is already in use",
                code="tier_prefix_conflict",
            )

    before = cat_repo.tier_to_audit_snapshot(cat)
    updated = await cat_repo.apply_tier_patch(
        db, tier=cat, patch=patch, updated_by_user_id=current.id
    )
    after = cat_repo.tier_to_audit_snapshot(updated)
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="app.item_tiers",
        subject_id=updated.id,
        subject_label=updated.name,
        before=before,
        after=after,
        context={"reason": reason},
        signature_id=evidence_uuid,
    )
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="tier.update",
        target_table="app.item_tiers",
        target_id=updated.id,
    )
    counts = await cat_repo.tier_item_counts(db, [updated.id])
    result = _tier_to_read(updated, counts.get(updated.id, 0))
    await db.commit()
    return result


@tiers_router.delete(
    "/{tier_id}",
    response_model=TierRead,
    summary="Delete an item tier (e-signed). Blocked if seeded or in use.",
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def delete_tier(
    db: DBSession,
    current: CurrentDbUserDep,
    tier_id: Annotated[uuid.UUID, Path()],
    payload: TierDelete,
) -> TierRead:
    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")
    cat = await cat_repo.get_tier(db, tier_id)
    if cat is None:
        raise NotFoundError(f"Tier {tier_id} not found")
    if cat.is_seeded:
        raise ConflictError(
            "Seeded tiers cannot be deleted", code="tier_seeded"
        )
    counts = await cat_repo.tier_item_counts(db, [cat.id])
    if counts.get(cat.id, 0) > 0:
        raise ConflictError(
            "Tier is in use — reassign its items first", code="tier_in_use"
        )

    before = cat_repo.tier_to_audit_snapshot(cat)
    updated = await cat_repo.soft_delete_tier(
        db, tier=cat, deleted_by_user_id=current.id
    )
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="deleted",
        subject_table="app.item_tiers",
        subject_id=updated.id,
        subject_label=updated.name,
        before=before,
        after=cat_repo.tier_to_audit_snapshot(updated),
        context={"reason": payload.reason},
        signature_id=evidence_uuid,
    )
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="tier.delete",
        target_table="app.item_tiers",
        target_id=updated.id,
    )
    result = _tier_to_read(updated, 0)
    await db.commit()
    return result


# ── BOM ────────────────────────────────────────────────────────────────


@bom_router.get(
    "/items/{item_id}/bom",
    response_model=ItemBomResponse,
    summary="List an item's direct BOM lines + buildable count",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_item_bom(
    db: DBSession,
    item_id: Annotated[uuid.UUID, Path()],
    nested: Annotated[
        bool,
        Query(
            description=(
                "When true, each built child's own BOM lines are embedded in "
                "``children`` so the whole structure tree arrives in one call."
            )
        ),
    ] = False,
) -> ItemBomResponse:
    item = await inv_repo.get_item(db, item_id)
    if item is None:
        raise NotFoundError(f"Item {item_id} not found")
    if nested:
        reads = await _build_bom_subtree(db, item_id, frozenset({item_id}), 0)
        return ItemBomResponse(item_id=str(item_id), lines=reads)
    lines = await cat_repo.list_bom_lines(db, item_id)
    have_bom = await inv_repo.items_with_bom(db, [ln.child_item_id for ln in lines])
    return ItemBomResponse(
        item_id=str(item_id),
        lines=[
            _bom_line_to_read(ln, child_has_bom=ln.child_item_id in have_bom)
            for ln in lines
        ],
    )


@bom_router.post(
    "/items/{item_id}/bom",
    response_model=BomLineRead,
    status_code=status.HTTP_201_CREATED,
    summary="Add a BOM line to an item (e-signed)",
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def add_bom_line(
    db: DBSession,
    current: CurrentDbUserDep,
    item_id: Annotated[uuid.UUID, Path()],
    payload: BomLineCreate,
) -> BomLineRead:
    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")
    child_uuid = _parse_uuid_or_422(payload.child_item_id, field="child_item_id")

    parent = await inv_repo.get_item(db, item_id)
    if parent is None:
        raise NotFoundError(f"Item {item_id} not found")
    if parent.tier is None or parent.tier.type not in BUILT_TIER_TYPES:
        raise ConflictError(
            "Only sub-assembly and finished-good items can have a bill of "
            "materials",
            code="parent_not_built",
        )
    child = await inv_repo.get_item(db, child_uuid)
    if child is None:
        raise NotFoundError(f"Item {payload.child_item_id} not found")
    # Transaction Spec §1.1 lists every legal combination — CR+CR→AY, AY+AY→AY,
    # CR+CR→FG, CR+AY→FG. A finished good never appears as a component: it is
    # terminal and leaves via the customer shipment (REQ-2026-07-01-TRX-005).
    if child.tier is None or child.tier.type == "finished_good":
        raise ConflictError(
            "A finished good can't be a component of another item. BOM "
            "components must be raw materials or sub-assemblies.",
            code="child_finished_good",
        )
    # Transaction Spec §4.3: "Consumables are not tracked directly against an
    # FG or AY BOM." They are issued blindly to a location and follow a separate
    # calculation path from one-for-one product items (REQ-2026-07-09-PLN-005),
    # so a consumable in a BOM would corrupt the planning maths.
    if child.is_consumable:
        raise ConflictError(
            "Consumables can't be part of a bill of materials — they're "
            "issued directly to a location and reconciled by back-flush.",
            code="child_consumable",
        )
    if await cat_repo.get_bom_line_by_pair(db, item_id, child_uuid) is not None:
        raise ConflictError(
            "This item is already a BOM line", code="bom_line_conflict"
        )
    if await cat_repo.would_create_cycle(
        db, parent_item_id=item_id, child_item_id=child_uuid
    ):
        raise ConflictError(
            "Adding this item would create a circular reference (A→B→A)",
            code="bom_cycle",
        )

    line = await cat_repo.create_bom_line(
        db,
        parent_item_id=item_id,
        child_item_id=child_uuid,
        qty_per_unit=payload.qty_per_unit,
        created_by_user_id=current.id,
    )
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="created",
        subject_table="app.bom_lines",
        subject_id=line.id,
        subject_label=f"{parent.item_number} → {child.item_number}",
        before=None,
        after=cat_repo.bom_line_to_audit_snapshot(line),
        context={"reason": payload.reason},
        signature_id=evidence_uuid,
    )
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="bom.create",
        target_table="app.bom_lines",
        target_id=line.id,
    )
    result = await _line_read(db, line)
    await db.commit()
    return result


@bom_router.patch(
    "/bom-lines/{line_id}",
    response_model=BomLineRead,
    summary="Update a BOM line's quantity (e-signed)",
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def update_bom_line(
    db: DBSession,
    current: CurrentDbUserDep,
    line_id: Annotated[uuid.UUID, Path()],
    payload: BomLineUpdate,
) -> BomLineRead:
    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")
    line = await cat_repo.get_bom_line(db, line_id)
    if line is None:
        raise NotFoundError(f"BOM line {line_id} not found")

    before = cat_repo.bom_line_to_audit_snapshot(line)
    updated = await cat_repo.apply_bom_line_patch(
        db,
        line=line,
        patch={"qty_per_unit": payload.qty_per_unit},
        updated_by_user_id=current.id,
    )
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="app.bom_lines",
        subject_id=updated.id,
        subject_label=None,
        before=before,
        after=cat_repo.bom_line_to_audit_snapshot(updated),
        context={"reason": payload.reason},
        signature_id=evidence_uuid,
    )
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="bom.update",
        target_table="app.bom_lines",
        target_id=updated.id,
    )
    result = await _line_read(db, updated)
    await db.commit()
    return result


@bom_router.delete(
    "/bom-lines/{line_id}",
    response_model=BomLineRead,
    summary="Delete a BOM line (e-signed)",
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def delete_bom_line(
    db: DBSession,
    current: CurrentDbUserDep,
    line_id: Annotated[uuid.UUID, Path()],
    payload: BomLineDelete,
) -> BomLineRead:
    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")
    line = await cat_repo.get_bom_line(db, line_id)
    if line is None:
        raise NotFoundError(f"BOM line {line_id} not found")

    before = cat_repo.bom_line_to_audit_snapshot(line)
    updated = await cat_repo.soft_delete_bom_line(
        db, line=line, deleted_by_user_id=current.id
    )
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="deleted",
        subject_table="app.bom_lines",
        subject_id=updated.id,
        subject_label=None,
        before=before,
        after=cat_repo.bom_line_to_audit_snapshot(updated),
        context={"reason": payload.reason},
        signature_id=evidence_uuid,
    )
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="bom.delete",
        target_table="app.bom_lines",
        target_id=updated.id,
    )
    result = await _line_read(db, updated)
    await db.commit()
    return result


@bom_router.get(
    "/items/{item_id}/where-used",
    response_model=list[WhereUsedRead],
    summary="List items whose BOM consumes this item",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_where_used(
    db: DBSession, item_id: Annotated[uuid.UUID, Path()]
) -> list[WhereUsedRead]:
    if (await inv_repo.get_item(db, item_id)) is None:
        raise NotFoundError(f"Item {item_id} not found")
    lines = await cat_repo.where_used(db, item_id)
    out: list[WhereUsedRead] = []
    for ln in lines:
        parent = ln.parent_item
        if parent is None or parent.deleted_at is not None:
            continue
        out.append(
            WhereUsedRead(
                parent_item_id=str(parent.id),
                parent_item_number=parent.item_number,
                parent_description=parent.description,
                parent_tier_name=parent.tier.name if parent.tier else "",
                qty_per_unit=ln.qty_per_unit,
            )
        )
    return out
