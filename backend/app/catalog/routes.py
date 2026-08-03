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
    BomBatchResult,
    BomBatchSave,
    BomLineCreate,
    BomLineDelete,
    BomLineRead,
    BomLineUpdate,
    ItemBomResponse,
    PrefixCreate,
    PrefixDelete,
    PrefixRead,
    PrefixUpdate,
    TierCreate,
    TierDelete,
    TierRead,
    TierUpdate,
    WhereUsedRead,
)
from app.core.exceptions import ConflictError, NotFoundError, ValidationError
from app.inventory import repository as inv_repo
from app.models.inventory import BUILT_TIER_TYPES, BomLine, ItemPrefix, ItemTier
from app.security.permissions import ADMIN_ROLES, RequirePermission, RequireRole

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


# A stored BOM never holds exactly one line: a bill of materials describes a
# combination, and Transaction Spec §1.1 states every legal build as a pair of
# components (CR+CR→AY, AY+AY→AY, CR+CR→FG, CR+AY→FG). So a BOM is either empty
# (not yet defined) or has at least two lines — client rule, confirmed
# 2026-07-28. It is enforced on the batch save, which is the only path that can
# compose a whole bill in one go.
BOM_MIN_LINES = 2

#: Reauth action for the batch save — one signature covering every staged
#: add / re-quantify / remove on one item's BOM.
BOM_SAVE_ACTION = "bom.save"


async def _require_built_parent(db: DBSession, item_id: uuid.UUID):
    """The BOM owner must exist and be a built item (AY or FG)."""
    parent = await inv_repo.get_item(db, item_id)
    if parent is None:
        raise NotFoundError(f"Item {item_id} not found")
    if parent.tier is None or parent.tier.type not in BUILT_TIER_TYPES:
        raise ConflictError(
            "Only sub-assembly and finished-good items can have a bill of "
            "materials",
            code="parent_not_built",
        )
    return parent


async def _require_eligible_child(db: DBSession, child_uuid: uuid.UUID, *, raw: str):
    """Resolve a candidate component and reject the two tiers that can't be one.

    Shared by the single-line add and the batch save so both enforce exactly the
    same rules.
    """
    child = await inv_repo.get_item(db, child_uuid)
    if child is None:
        raise NotFoundError(f"Item {raw} not found")
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
    return child


def _prefix_to_read(prefix: ItemPrefix, item_count: int = 0) -> PrefixRead:
    # A prefix has no colour of its own — it inherits the owning tier's tone.
    tone = prefix.tier.tone if prefix.tier else "neutral"
    return PrefixRead(
        id=str(prefix.id),
        tier_id=str(prefix.tier_id),
        code=prefix.code,
        label=prefix.label,
        is_default=prefix.is_default,
        is_seeded=prefix.is_seeded,
        tone=tone,
        item_count=item_count,
        created_at=prefix.created_at,
        updated_at=prefix.updated_at,
    )


def _tier_to_read(
    cat: ItemTier,
    item_count: int,
    prefixes: list[ItemPrefix] | None = None,
    prefix_counts: dict[uuid.UUID, int] | None = None,
) -> TierRead:
    # The eager ``ItemTier.prefixes`` relationship already returns live rows
    # seeded-first then A-Z; fall back to it when the caller didn't pass a list.
    rows = prefixes if prefixes is not None else list(cat.prefixes)
    counts = prefix_counts or {}
    return TierRead(
        id=str(cat.id),
        name=cat.name,
        type=cat.type,  # type: ignore[arg-type]
        tone=cat.tone,
        is_seeded=cat.is_seeded,
        item_count=item_count,
        prefixes=[_prefix_to_read(p, counts.get(p.id, 0)) for p in rows],
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
    # Per-prefix item counts (the tier count is the sum of its prefixes').
    all_prefix_ids = [p.id for c in cats for p in c.prefixes]
    prefix_counts = await cat_repo.prefix_item_counts(db, all_prefix_ids)
    return [
        _tier_to_read(c, counts.get(c.id, 0), prefix_counts=prefix_counts)
        for c in cats
    ]


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
    prefix_counts = await cat_repo.prefix_item_counts(db, [p.id for p in cat.prefixes])
    return _tier_to_read(cat, counts.get(cat.id, 0), prefix_counts=prefix_counts)


@tiers_router.post(
    "",
    response_model=TierRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create an item tier (e-signed)",
    dependencies=[
        Depends(RequirePermission("inventory", "sign")),
        Depends(RequireRole(*ADMIN_ROLES, what="item tiers and prefixes")),
    ],
)
async def create_tier(
    db: DBSession, current: CurrentDbUserDep, payload: TierCreate
) -> TierRead:
    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")
    if (await cat_repo.get_tier_by_name(db, payload.name)) is not None:
        raise ConflictError(
            f"Tier '{payload.name}' already exists", code="tier_name_conflict"
        )
    try:
        cat = await cat_repo.create_tier(
            db,
            name=payload.name,
            tier_type=payload.type,
            tone=payload.tone,
            created_by_user_id=current.id,
        )
    except IntegrityError as exc:
        await db.rollback()
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
        # NO subject binding, deliberately (VR-006). A tier is a top-level
        # record: nothing exists to point at when the operator signs, and
        # there is no parent to stand in for it (contrast prefix.create,
        # which binds to its tier, and bom.create, which binds to its item).
        # Action-only is the honest answer rather than inventing an id.
        expected_action="tier.create",
        target_table="app.item_tiers",
        target_id=cat.id,
    )
    result = _tier_to_read(cat, 0, prefixes=[])
    await db.commit()
    return result


@tiers_router.patch(
    "/{tier_id}",
    response_model=TierRead,
    summary="Update an item tier (e-signed). Kind is immutable.",
    dependencies=[
        Depends(RequirePermission("inventory", "sign")),
        Depends(RequireRole(*ADMIN_ROLES, what="item tiers and prefixes")),
    ],
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
        # Subject == target here: the record already existed when the
        # operator signed, so the signature binds directly to it.
        record_table="app.item_tiers",
        record_id=updated.id,
    )
    counts = await cat_repo.tier_item_counts(db, [updated.id])
    result = _tier_to_read(updated, counts.get(updated.id, 0))
    await db.commit()
    return result


@tiers_router.delete(
    "/{tier_id}",
    response_model=TierRead,
    summary="Delete an item tier (e-signed). Blocked if seeded or in use.",
    dependencies=[
        Depends(RequirePermission("inventory", "sign")),
        Depends(RequireRole(*ADMIN_ROLES, what="item tiers and prefixes")),
    ],
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
        # Subject == target here: the record already existed when the
        # operator signed, so the signature binds directly to it.
        record_table="app.item_tiers",
        record_id=updated.id,
    )
    result = _tier_to_read(updated, 0, prefixes=[])
    await db.commit()
    return result


# ── Prefixes (nested under a tier) ─────────────────────────────────────


async def _get_tier_or_404(db: DBSession, tier_id: uuid.UUID) -> ItemTier:
    tier = await cat_repo.get_tier(db, tier_id)
    if tier is None:
        raise NotFoundError(f"Tier {tier_id} not found")
    return tier


async def _prefix_read_with_count(db: DBSession, prefix: ItemPrefix) -> PrefixRead:
    counts = await cat_repo.prefix_item_counts(db, [prefix.id])
    return _prefix_to_read(prefix, counts.get(prefix.id, 0))


@tiers_router.get(
    "/{tier_id}/prefixes",
    response_model=list[PrefixRead],
    summary="List a tier's prefixes",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_prefixes(
    db: DBSession, tier_id: Annotated[uuid.UUID, Path()]
) -> list[PrefixRead]:
    await _get_tier_or_404(db, tier_id)
    prefixes = await cat_repo.list_prefixes(db, tier_id)
    counts = await cat_repo.prefix_item_counts(db, [p.id for p in prefixes])
    return [_prefix_to_read(p, counts.get(p.id, 0)) for p in prefixes]


@tiers_router.post(
    "/{tier_id}/prefixes",
    response_model=PrefixRead,
    status_code=status.HTTP_201_CREATED,
    summary="Add a prefix to a tier (e-signed)",
    dependencies=[
        Depends(RequirePermission("inventory", "sign")),
        Depends(RequireRole(*ADMIN_ROLES, what="item tiers and prefixes")),
    ],
)
async def create_prefix(
    db: DBSession,
    current: CurrentDbUserDep,
    tier_id: Annotated[uuid.UUID, Path()],
    payload: PrefixCreate,
) -> PrefixRead:
    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")
    await _get_tier_or_404(db, tier_id)
    if (await cat_repo.get_prefix_by_code(db, payload.code)) is not None:
        raise ConflictError(
            f"Prefix '{payload.code}' is already in use",
            code="prefix_code_conflict",
        )
    # Promoting this one to default first clears the tier's previous default, so
    # the partial-unique index never sees two defaults.
    if payload.is_default:
        await cat_repo.clear_tier_default_prefix(
            db, tier_id=tier_id, except_prefix_id=None
        )
    try:
        prefix = await cat_repo.create_prefix(
            db,
            tier_id=tier_id,
            code=payload.code,
            label=payload.label,
            is_default=payload.is_default,
            created_by_user_id=current.id,
        )
    except IntegrityError as exc:
        await db.rollback()
        raise ConflictError(
            f"Prefix '{payload.code}' is already in use",
            code="prefix_code_conflict",
        ) from exc

    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="created",
        subject_table="app.item_prefixes",
        subject_id=prefix.id,
        subject_label=prefix.code,
        before=None,
        after=cat_repo.prefix_to_audit_snapshot(prefix),
        context={"reason": payload.reason},
        signature_id=evidence_uuid,
    )
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="prefix.create",
        target_table="app.item_prefixes",
        target_id=prefix.id,
        # The prefix does not exist yet; the tier it is being added to does.
        record_table="app.item_tiers",
        record_id=tier_id,
    )
    result = _prefix_to_read(prefix, 0)
    await db.commit()
    return result


@tiers_router.patch(
    "/{tier_id}/prefixes/{prefix_id}",
    response_model=PrefixRead,
    summary="Update a prefix (e-signed). The owning tier is immutable.",
    dependencies=[
        Depends(RequirePermission("inventory", "sign")),
        Depends(RequireRole(*ADMIN_ROLES, what="item tiers and prefixes")),
    ],
)
async def update_prefix(
    db: DBSession,
    current: CurrentDbUserDep,
    tier_id: Annotated[uuid.UUID, Path()],
    prefix_id: Annotated[uuid.UUID, Path()],
    payload: PrefixUpdate,
) -> PrefixRead:
    patch = payload.model_dump(exclude_unset=True)
    evidence_uuid = _parse_uuid_or_422(
        str(patch.pop("evidence_id")), field="evidence_id"
    )
    reason = patch.pop("reason", "")
    if not patch:
        raise ValidationError("No fields to update", code="empty_patch")

    prefix = await cat_repo.get_prefix(db, prefix_id)
    if prefix is None or prefix.tier_id != tier_id:
        raise NotFoundError(f"Prefix {prefix_id} not found")

    new_code = patch.get("code")
    if new_code is not None:
        clash = await cat_repo.get_prefix_by_code(db, str(new_code))
        if clash is not None and clash.id != prefix.id:
            raise ConflictError(
                f"Prefix '{new_code}' is already in use",
                code="prefix_code_conflict",
            )

    # Turning a prefix into the default clears the tier's previous default.
    # Un-defaulting the tier's only default is rejected — the create form always
    # needs one prefix to pre-fill.
    if "is_default" in patch:
        if patch["is_default"]:
            await cat_repo.clear_tier_default_prefix(
                db, tier_id=tier_id, except_prefix_id=prefix.id
            )
        elif prefix.is_default:
            raise ConflictError(
                "A tier must keep one default prefix — set another prefix as "
                "the default instead of clearing this one.",
                code="prefix_default_required",
            )

    before = cat_repo.prefix_to_audit_snapshot(prefix)
    updated = await cat_repo.apply_prefix_patch(
        db, prefix=prefix, patch=patch, updated_by_user_id=current.id
    )
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="updated",
        subject_table="app.item_prefixes",
        subject_id=updated.id,
        subject_label=updated.code,
        before=before,
        after=cat_repo.prefix_to_audit_snapshot(updated),
        context={"reason": reason},
        signature_id=evidence_uuid,
    )
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="prefix.update",
        target_table="app.item_prefixes",
        target_id=updated.id,
        # Subject == target here: the record already existed when the
        # operator signed, so the signature binds directly to it.
        record_table="app.item_prefixes",
        record_id=updated.id,
    )
    result = await _prefix_read_with_count(db, updated)
    await db.commit()
    return result


@tiers_router.delete(
    "/{tier_id}/prefixes/{prefix_id}",
    response_model=PrefixRead,
    summary="Delete a prefix (e-signed). Blocked if seeded or in use.",
    dependencies=[
        Depends(RequirePermission("inventory", "sign")),
        Depends(RequireRole(*ADMIN_ROLES, what="item tiers and prefixes")),
    ],
)
async def delete_prefix(
    db: DBSession,
    current: CurrentDbUserDep,
    tier_id: Annotated[uuid.UUID, Path()],
    prefix_id: Annotated[uuid.UUID, Path()],
    payload: PrefixDelete,
) -> PrefixRead:
    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")
    prefix = await cat_repo.get_prefix(db, prefix_id)
    if prefix is None or prefix.tier_id != tier_id:
        raise NotFoundError(f"Prefix {prefix_id} not found")
    if prefix.is_seeded:
        raise ConflictError(
            "Seeded prefixes cannot be deleted", code="prefix_seeded"
        )
    counts = await cat_repo.prefix_item_counts(db, [prefix.id])
    if counts.get(prefix.id, 0) > 0:
        raise ConflictError(
            "Prefix is in use — reassign its items first", code="prefix_in_use"
        )
    if prefix.is_default:
        raise ConflictError(
            "This is the tier's default prefix — set another prefix as the "
            "default before deleting it.",
            code="prefix_default_required",
        )

    before = cat_repo.prefix_to_audit_snapshot(prefix)
    updated = await cat_repo.soft_delete_prefix(
        db, prefix=prefix, deleted_by_user_id=current.id
    )
    await record_entity_change(
        db,
        actor_user_id=current.id,
        action="deleted",
        subject_table="app.item_prefixes",
        subject_id=updated.id,
        subject_label=updated.code,
        before=before,
        after=cat_repo.prefix_to_audit_snapshot(updated),
        context={"reason": payload.reason},
        signature_id=evidence_uuid,
    )
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action="prefix.delete",
        target_table="app.item_prefixes",
        target_id=updated.id,
        # Subject == target here: the record already existed when the
        # operator signed, so the signature binds directly to it.
        record_table="app.item_prefixes",
        record_id=updated.id,
    )
    result = _prefix_to_read(updated, 0)
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

    parent = await _require_built_parent(db, item_id)
    child = await _require_eligible_child(
        db, child_uuid, raw=payload.child_item_id
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
        # The BOM line does not exist yet; the parent item whose BOM is open does.
        record_table="app.items",
        record_id=item_id,
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
        # Subject == target here: the record already existed when the
        # operator signed, so the signature binds directly to it.
        record_table="app.bom_lines",
        record_id=updated.id,
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
        # Subject == target here: the record already existed when the
        # operator signed, so the signature binds directly to it.
        record_table="app.bom_lines",
        record_id=updated.id,
    )
    result = await _line_read(db, updated)
    await db.commit()
    return result


@bom_router.post(
    "/items/{item_id}/bom/batch",
    response_model=BomBatchResult,
    summary="Save every staged BOM change under one signature (e-signed)",
    dependencies=[Depends(RequirePermission("inventory", "sign"))],
)
async def save_item_bom(
    db: DBSession,
    current: CurrentDbUserDep,
    item_id: Annotated[uuid.UUID, Path()],
    payload: BomBatchSave,
) -> BomBatchResult:
    """Apply adds, re-quantifications and removals to one item's BOM at once.

    The operator composes the whole bill in the UI and signs **once**. Everything
    is validated up front and applied in a single transaction, so a bad line
    leaves the stored BOM exactly as it was — no half-saved bill. Each line still
    gets its own audit row (identical in shape to the single-line endpoints), all
    carrying the same signature.
    """
    evidence_uuid = _parse_uuid_or_422(payload.evidence_id, field="evidence_id")
    parent = await _require_built_parent(db, item_id)

    if not payload.adds and not payload.updates and not payload.deletes:
        raise ValidationError(
            "Nothing to save — no BOM changes were staged", code="no_changes"
        )

    existing = await cat_repo.list_bom_lines(db, item_id)
    by_id = {ln.id: ln for ln in existing}

    # ── Resolve + validate the staged removals ─────────────────────────
    delete_uuids: list[uuid.UUID] = []
    for raw_id in payload.deletes:
        line_uuid = _parse_uuid_or_422(raw_id, field="line_id")
        if line_uuid in delete_uuids:
            raise ValidationError(
                "The same BOM line was removed twice in one save",
                code="duplicate_line_change",
            )
        if line_uuid not in by_id:
            raise NotFoundError(
                f"BOM line {raw_id} is not a line of this item",
                code="bom_line_not_found",
            )
        delete_uuids.append(line_uuid)
    delete_set = set(delete_uuids)

    # ── Resolve + validate the staged re-quantifications ───────────────
    update_pairs: list[tuple[uuid.UUID, Decimal]] = []
    seen_updates: set[uuid.UUID] = set()
    for upd in payload.updates:
        line_uuid = _parse_uuid_or_422(upd.line_id, field="line_id")
        if line_uuid in seen_updates:
            raise ValidationError(
                "The same BOM line was changed twice in one save",
                code="duplicate_line_change",
            )
        if line_uuid not in by_id:
            raise NotFoundError(
                f"BOM line {upd.line_id} is not a line of this item",
                code="bom_line_not_found",
            )
        # A line that is on its way out can't also be re-quantified — the UI
        # collapses that to a plain removal.
        if line_uuid in delete_set:
            raise ValidationError(
                "A BOM line can't be both changed and removed in one save",
                code="duplicate_line_change",
            )
        seen_updates.add(line_uuid)
        update_pairs.append((line_uuid, upd.qty_per_unit))

    # ── Resolve + validate the staged additions ───────────────────────
    # Components that will still be on the bill once the removals land — a
    # child freed by a removal in this same batch may be re-added below it.
    remaining_children = {
        ln.child_item_id for ln in existing if ln.id not in delete_set
    }
    add_pairs: list[tuple[uuid.UUID, Decimal]] = []
    for add in payload.adds:
        child_uuid = _parse_uuid_or_422(add.child_item_id, field="child_item_id")
        if child_uuid == item_id:
            raise ConflictError(
                "An item can't be a component of itself", code="bom_cycle"
            )
        await _require_eligible_child(db, child_uuid, raw=add.child_item_id)
        if child_uuid in remaining_children:
            raise ConflictError(
                "This item is already a BOM line", code="bom_line_conflict"
            )
        remaining_children.add(child_uuid)
        add_pairs.append((child_uuid, add.qty_per_unit))

    # ── The two-line floor ────────────────────────────────────────────
    final_count = len(existing) - len(delete_uuids) + len(add_pairs)
    if final_count == 1:
        raise ValidationError(
            "A bill of materials needs at least two components. Add another "
            "line, or remove them all to clear the BOM.",
            code="bom_min_lines",
        )

    # ── Apply: removals, then re-quantifications, then additions ──────
    # Removals go first so a child freed here can be re-added below, and so the
    # cycle check each addition runs sees the bill as it will actually stand.
    for line_uuid in delete_uuids:
        line = by_id[line_uuid]
        before = cat_repo.bom_line_to_audit_snapshot(line)
        removed = await cat_repo.soft_delete_bom_line(
            db, line=line, deleted_by_user_id=current.id
        )
        await record_entity_change(
            db,
            actor_user_id=current.id,
            action="deleted",
            subject_table="app.bom_lines",
            subject_id=removed.id,
            subject_label=None,
            before=before,
            after=cat_repo.bom_line_to_audit_snapshot(removed),
            context={"reason": payload.reason},
            signature_id=evidence_uuid,
        )

    for line_uuid, qty in update_pairs:
        line = by_id[line_uuid]
        before = cat_repo.bom_line_to_audit_snapshot(line)
        updated = await cat_repo.apply_bom_line_patch(
            db,
            line=line,
            patch={"qty_per_unit": qty},
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

    for child_uuid, qty in add_pairs:
        # Checked per addition rather than once up front: each insert is flushed,
        # so a batch that would close a loop between two of its own new lines
        # (A→B and B→A) is caught on the second one.
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
            qty_per_unit=qty,
            created_by_user_id=current.id,
        )
        child_number = line.child_item.item_number if line.child_item else ""
        await record_entity_change(
            db,
            actor_user_id=current.id,
            action="created",
            subject_table="app.bom_lines",
            subject_id=line.id,
            subject_label=f"{parent.item_number} → {child_number}",
            before=None,
            after=cat_repo.bom_line_to_audit_snapshot(line),
            context={"reason": payload.reason},
            signature_id=evidence_uuid,
        )

    # One signature covers the whole batch, so it is bound to a synthetic batch
    # id rather than any single line (same pattern as the forecast batch save).
    batch_id = uuid.uuid4()
    await consume_reauth_evidence(
        db,
        evidence_id=evidence_uuid,
        user_id=current.id,
        expected_action=BOM_SAVE_ACTION,
        target_table="app.bom_lines",
        target_id=batch_id,
        # Batch BOM save: batch_id is generated here, the parent item is the subject.
        record_table="app.items",
        record_id=item_id,
    )

    lines = await cat_repo.list_bom_lines(db, item_id)
    have_bom = await inv_repo.items_with_bom(db, [ln.child_item_id for ln in lines])
    result = BomBatchResult(
        item_id=str(item_id),
        lines=[
            _bom_line_to_read(ln, child_has_bom=ln.child_item_id in have_bom)
            for ln in lines
        ],
        added=len(add_pairs),
        updated=len(update_pairs),
        deleted=len(delete_uuids),
    )
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
