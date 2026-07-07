"""``/v1/items``, ``/v1/stock`` and ``/v1/transactions`` routes.

Week-1 reset (2026-07-06). Three routers, all mounted under the v1 prefix:

* ``items_router`` — item catalogue (create / edit / list / detail).
* ``stock_router`` — flat inventory_stock balances.
* ``transactions_router`` — Receipt / Transfer history + posting. Each POST
  runs in a single DB transaction and drives the stock upsert.

Writes are NOT e-signed. Reads require ``inventory:view`` (items / stock) or
``transactions:view``; posting requires ``transactions:create``.
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, status

from app.api.deps import CurrentDbUserDep, DBSession
from app.core.exceptions import ConflictError, NotFoundError, ValidationError
from app.inventory import repository as inv_repo
from app.inventory.schemas import (
    ItemCreate,
    ItemDetailRead,
    ItemLedgerEntry,
    ItemListRead,
    ItemStockRow,
    ItemUpdate,
    ReceiptCreate,
    StockRead,
    TransactionDetailRead,
    TransactionLineRead,
    TransactionListRead,
    TransferCreate,
)
from app.locations import repository as loc_repo
from app.models.identity import User
from app.models.inventory import (
    InventoryTransaction,
    InventoryTransactionLine,
    Item,
)
from app.security.permissions import RequirePermission

items_router = APIRouter(prefix="/items", tags=["items"])
stock_router = APIRouter(prefix="/stock", tags=["stock"])
transactions_router = APIRouter(prefix="/transactions", tags=["transactions"])


def _parse_uuid(value: str, *, field: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError as exc:
        raise ValidationError(
            f"{field} is not a valid UUID", code=f"invalid_{field}"
        ) from exc


def _full_name(user: User | None) -> str | None:
    if user is None:
        return None
    return f"{user.first_name} {user.last_name}".strip() or None


def _name_from_parts(first: str | None, last: str | None) -> str | None:
    if first is None and last is None:
        return None
    return f"{first or ''} {last or ''}".strip() or None


# ── Item serialisers ──────────────────────────────────────────────────────


def _item_to_list_read(
    item: Item, on_hand: Decimal, location_count: int
) -> ItemListRead:
    return ItemListRead(
        id=str(item.id),
        item_code=item.item_code,
        item_name=item.item_name,
        description=item.description,
        tier=item.tier,
        is_consumable=item.is_consumable,
        unit_of_measure=item.unit_of_measure,
        default_location_id=(
            str(item.default_location_id) if item.default_location_id else None
        ),
        track_expiry=item.track_expiry,
        is_active=item.is_active,
        on_hand=Decimal(on_hand),
        location_count=int(location_count),
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


# ── Items ──────────────────────────────────────────────────────────────────


@items_router.get(
    "",
    response_model=list[ItemListRead],
    summary="List items",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_items(
    db: DBSession,
    tier: Annotated[str | None, Query()] = None,
    active: Annotated[bool | None, Query()] = None,
    search: Annotated[str | None, Query()] = None,
) -> list[ItemListRead]:
    rows = await inv_repo.list_items(db, tier=tier, active=active, search=search)
    return [_item_to_list_read(item, on_hand, count) for item, on_hand, count in rows]


@items_router.get(
    "/{item_id}",
    response_model=ItemDetailRead,
    summary="Get one item with its stock rows",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def get_item(
    db: DBSession,
    item_id: Annotated[uuid.UUID, Path()],
) -> ItemDetailRead:
    agg = await inv_repo.get_item_with_aggregates(db, item_id)
    if agg is None:
        raise NotFoundError(f"Item {item_id} not found")
    item, on_hand, count = agg
    stock_rows = await inv_repo.get_item_stock_rows(db, item_id)
    base = _item_to_list_read(item, on_hand, count)
    return ItemDetailRead(
        **base.model_dump(),
        stock=[
            ItemStockRow(
                location_id=str(stock.location_id),
                location_name=location_name,
                lot_number=stock.lot_number,
                expiry_date=stock.expiry_date,
                quantity_available=stock.quantity_available,
                unit_of_measure=stock.unit_of_measure,
            )
            for stock, location_name in stock_rows
        ],
    )


@items_router.get(
    "/{item_id}/transactions",
    response_model=list[ItemLedgerEntry],
    summary="Recent transactions that touched this item (item-scoped ledger)",
    dependencies=[Depends(RequirePermission("transactions", "view"))],
)
async def item_transactions(
    db: DBSession,
    item_id: Annotated[uuid.UUID, Path()],
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
) -> list[ItemLedgerEntry]:
    txn_ids = await inv_repo.item_transaction_ids(db, item_id, limit=limit)
    if not txn_ids:
        return []
    rows = await inv_repo.item_ledger_lines(db, item_id, txn_ids)

    # Collapse this item's lines per transaction: sum qty, gather lots, keep
    # the (single) from/to direction. A transfer may span multiple lots.
    entries: dict[uuid.UUID, dict] = {}
    order: list[uuid.UUID] = []
    for line, txn, from_name, to_name, first, last in rows:
        entry = entries.get(txn.id)
        if entry is None:
            entry = {
                "transaction_id": str(txn.id),
                "transaction_no": txn.transaction_no,
                "transaction_type": txn.transaction_type,
                "transaction_date": txn.transaction_date,
                "created_by_name": _name_from_parts(first, last),
                "quantity": Decimal(0),
                "unit_of_measure": line.unit_of_measure,
                "from_location_name": from_name,
                "to_location_name": to_name,
                "lot_numbers": [],
                "reference_no": txn.reference_no,
                "notes": txn.notes,
            }
            entries[txn.id] = entry
            order.append(txn.id)
        entry["quantity"] += line.quantity
        if entry["from_location_name"] is None and from_name:
            entry["from_location_name"] = from_name
        if entry["to_location_name"] is None and to_name:
            entry["to_location_name"] = to_name
        if line.lot_number and line.lot_number not in entry["lot_numbers"]:
            entry["lot_numbers"].append(line.lot_number)

    return [ItemLedgerEntry(**entries[tid]) for tid in order]


@items_router.post(
    "",
    response_model=ItemDetailRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create an item",
    dependencies=[Depends(RequirePermission("inventory", "create"))],
)
async def create_item(
    db: DBSession,
    payload: ItemCreate,
) -> ItemDetailRead:
    if await inv_repo.get_item_by_code(db, payload.item_code) is not None:
        raise ConflictError(
            f"An item with code '{payload.item_code}' already exists",
            code="item_code_conflict",
        )
    default_location_id: uuid.UUID | None = None
    if payload.default_location_id is not None:
        default_location_id = _parse_uuid(
            payload.default_location_id, field="default_location_id"
        )
        if await loc_repo.get_location(db, default_location_id) is None:
            raise NotFoundError(
                f"Location {payload.default_location_id} not found"
            )

    item = await inv_repo.create_item(
        db,
        item_code=payload.item_code,
        item_name=payload.item_name,
        description=payload.description,
        tier=payload.tier,
        is_consumable=payload.is_consumable,
        unit_of_measure=payload.unit_of_measure,
        default_location_id=default_location_id,
        track_expiry=payload.track_expiry,
    )
    await db.refresh(item)
    response = ItemDetailRead(
        **_item_to_list_read(item, Decimal(0), 0).model_dump(),
        stock=[],
    )
    await db.commit()
    return response


@items_router.patch(
    "/{item_id}",
    response_model=ItemDetailRead,
    summary="Update an item (item_code + tier are immutable)",
    dependencies=[Depends(RequirePermission("inventory", "edit"))],
)
async def update_item(
    db: DBSession,
    item_id: Annotated[uuid.UUID, Path()],
    payload: ItemUpdate,
) -> ItemDetailRead:
    item = await inv_repo.get_item(db, item_id)
    if item is None:
        raise NotFoundError(f"Item {item_id} not found")

    data = payload.model_dump(exclude_unset=True)
    if "default_location_id" in data:
        raw = data["default_location_id"]
        if raw is None:
            item.default_location_id = None
        else:
            loc_uuid = _parse_uuid(raw, field="default_location_id")
            if await loc_repo.get_location(db, loc_uuid) is None:
                raise NotFoundError(f"Location {raw} not found")
            item.default_location_id = loc_uuid
    if data.get("item_name") is not None:
        item.item_name = data["item_name"]
    if "description" in data:
        item.description = data["description"]
    if data.get("unit_of_measure") is not None:
        item.unit_of_measure = data["unit_of_measure"]
    if data.get("is_consumable") is not None:
        item.is_consumable = data["is_consumable"]
    if data.get("track_expiry") is not None:
        item.track_expiry = data["track_expiry"]
    if data.get("is_active") is not None:
        item.is_active = data["is_active"]

    await db.flush()
    agg = await inv_repo.get_item_with_aggregates(db, item_id)
    assert agg is not None  # just updated it
    fresh, on_hand, count = agg
    stock_rows = await inv_repo.get_item_stock_rows(db, item_id)
    response = ItemDetailRead(
        **_item_to_list_read(fresh, on_hand, count).model_dump(),
        stock=[
            ItemStockRow(
                location_id=str(stock.location_id),
                location_name=location_name,
                lot_number=stock.lot_number,
                expiry_date=stock.expiry_date,
                quantity_available=stock.quantity_available,
                unit_of_measure=stock.unit_of_measure,
            )
            for stock, location_name in stock_rows
        ],
    )
    await db.commit()
    return response


@items_router.delete(
    "/{item_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Deactivate an item (soft delete — history is preserved)",
    dependencies=[Depends(RequirePermission("inventory", "delete"))],
)
async def delete_item(
    db: DBSession,
    item_id: Annotated[uuid.UUID, Path()],
) -> None:
    """Soft delete: flips ``is_active`` to False so the item drops out of the
    default list but its stock balances and transaction history stay intact
    (the stock/line FKs are ``ON DELETE RESTRICT`` — a hard delete would be
    blocked once an item has any movement)."""
    item = await inv_repo.get_item(db, item_id)
    if item is None:
        raise NotFoundError(f"Item {item_id} not found")
    item.is_active = False
    await db.flush()
    await db.commit()


# ── Stock ──────────────────────────────────────────────────────────────────


@stock_router.get(
    "",
    response_model=list[StockRead],
    summary="Flat inventory stock balances",
    dependencies=[Depends(RequirePermission("inventory", "view"))],
)
async def list_stock(
    db: DBSession,
    item_id: Annotated[uuid.UUID | None, Query()] = None,
    location_id: Annotated[uuid.UUID | None, Query()] = None,
) -> list[StockRead]:
    rows = await inv_repo.list_stock(db, item_id=item_id, location_id=location_id)
    return [
        StockRead(
            id=str(stock.id),
            item_id=str(stock.item_id),
            item_code=item_code,
            item_name=item_name,
            location_id=str(stock.location_id),
            location_name=location_name,
            lot_number=stock.lot_number,
            expiry_date=stock.expiry_date,
            quantity_available=stock.quantity_available,
            unit_of_measure=stock.unit_of_measure,
        )
        for stock, item_code, item_name, location_name in rows
    ]


# ── Transactions ────────────────────────────────────────────────────────────


def _line_to_read(line: InventoryTransactionLine) -> TransactionLineRead:
    return TransactionLineRead(
        id=str(line.id),
        item_id=str(line.item_id),
        item_code=line.item.item_code if line.item else None,
        item_name=line.item.item_name if line.item else None,
        from_location_id=(
            str(line.from_location_id) if line.from_location_id else None
        ),
        from_location_name=(
            line.from_location.location_name if line.from_location else None
        ),
        to_location_id=str(line.to_location_id) if line.to_location_id else None,
        to_location_name=(
            line.to_location.location_name if line.to_location else None
        ),
        lot_number=line.lot_number,
        expiry_date=line.expiry_date,
        quantity=line.quantity,
        unit_of_measure=line.unit_of_measure,
    )


def _txn_to_detail(txn: InventoryTransaction) -> TransactionDetailRead:
    return TransactionDetailRead(
        id=str(txn.id),
        transaction_no=txn.transaction_no,
        transaction_type=txn.transaction_type,
        transaction_date=txn.transaction_date,
        reference_no=txn.reference_no,
        notes=txn.notes,
        created_by=str(txn.created_by),
        created_by_name=_full_name(txn.created_by_user),
        created_at=txn.created_at,
        lines=[_line_to_read(line) for line in txn.lines],
    )


@transactions_router.get(
    "",
    response_model=list[TransactionListRead],
    summary="Transaction history (newest first)",
    dependencies=[Depends(RequirePermission("transactions", "view"))],
)
async def list_transactions(
    db: DBSession,
    type: Annotated[str | None, Query()] = None,
    item_id: Annotated[uuid.UUID | None, Query()] = None,
    location_id: Annotated[uuid.UUID | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[TransactionListRead]:
    rows = await inv_repo.list_transactions(
        db,
        transaction_type=type,
        item_id=item_id,
        location_id=location_id,
        limit=limit,
        offset=offset,
    )
    return [
        TransactionListRead(
            id=str(txn.id),
            transaction_no=txn.transaction_no,
            transaction_type=txn.transaction_type,
            transaction_date=txn.transaction_date,
            reference_no=txn.reference_no,
            notes=txn.notes,
            created_by=str(txn.created_by),
            created_by_name=_name_from_parts(first, last),
            line_count=int(line_count),
            created_at=txn.created_at,
        )
        for txn, line_count, first, last in rows
    ]


@transactions_router.get(
    "/{transaction_id}",
    response_model=TransactionDetailRead,
    summary="Transaction header + lines",
    dependencies=[Depends(RequirePermission("transactions", "view"))],
)
async def get_transaction(
    db: DBSession,
    transaction_id: Annotated[uuid.UUID, Path()],
) -> TransactionDetailRead:
    txn = await inv_repo.get_transaction(db, transaction_id)
    if txn is None:
        raise NotFoundError(f"Transaction {transaction_id} not found")
    return _txn_to_detail(txn)


async def _require_item(db: DBSession, raw_item_id: str) -> Item:
    item_uuid = _parse_uuid(raw_item_id, field="item_id")
    item = await inv_repo.get_item(db, item_uuid)
    if item is None:
        raise NotFoundError(f"Item {raw_item_id} not found")
    return item


async def _require_location(db: DBSession, raw_location_id: str, *, field: str):
    loc_uuid = _parse_uuid(raw_location_id, field=field)
    if await loc_repo.get_location(db, loc_uuid) is None:
        raise NotFoundError(f"Location {raw_location_id} not found")
    return loc_uuid


@transactions_router.post(
    "/receipt",
    response_model=TransactionDetailRead,
    status_code=status.HTTP_201_CREATED,
    summary="Post a Receipt (stock in) — creates a transaction + upserts stock",
    dependencies=[Depends(RequirePermission("transactions", "create"))],
)
async def create_receipt(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: ReceiptCreate,
) -> TransactionDetailRead:
    when = await inv_repo.db_now(db)
    transaction_no = await inv_repo.next_transaction_no(db, when)
    txn = await inv_repo.create_transaction(
        db,
        transaction_no=transaction_no,
        transaction_type="RECEIPT",
        transaction_date=when,
        created_by=current.id,
        reference_no=payload.reference_no,
        notes=payload.notes,
    )
    for line in payload.lines:
        item = await _require_item(db, line.item_id)
        to_location_id = await _require_location(
            db, line.to_location_id, field="to_location_id"
        )
        await inv_repo.add_transaction_line(
            db,
            transaction_id=txn.id,
            item_id=item.id,
            from_location_id=None,
            to_location_id=to_location_id,
            lot_number=line.lot_number,
            expiry_date=line.expiry_date,
            quantity=line.quantity,
            unit_of_measure=item.unit_of_measure,
        )
        await inv_repo.add_stock(
            db,
            item_id=item.id,
            location_id=to_location_id,
            lot_number=line.lot_number,
            expiry_date=line.expiry_date,
            quantity=line.quantity,
            unit_of_measure=item.unit_of_measure,
        )

    created = await inv_repo.get_transaction(db, txn.id)
    assert created is not None  # just created it
    response = _txn_to_detail(created)
    await db.commit()
    return response


@transactions_router.post(
    "/transfer",
    response_model=TransactionDetailRead,
    status_code=status.HTTP_201_CREATED,
    summary="Post a Transfer — moves stock between locations",
    dependencies=[Depends(RequirePermission("transactions", "create"))],
)
async def create_transfer(
    db: DBSession,
    current: CurrentDbUserDep,
    payload: TransferCreate,
) -> TransactionDetailRead:
    when = await inv_repo.db_now(db)
    transaction_no = await inv_repo.next_transaction_no(db, when)
    txn = await inv_repo.create_transaction(
        db,
        transaction_no=transaction_no,
        transaction_type="TRANSFER",
        transaction_date=when,
        created_by=current.id,
        reference_no=payload.reference_no,
        notes=payload.notes,
    )
    for line in payload.lines:
        item = await _require_item(db, line.item_id)
        from_location_id = await _require_location(
            db, line.from_location_id, field="from_location_id"
        )
        to_location_id = await _require_location(
            db, line.to_location_id, field="to_location_id"
        )
        if from_location_id == to_location_id:
            raise ValidationError(
                "Transfer source and destination locations must differ",
                code="transfer_same_location",
            )
        # Draw down the source location FIFO across its lots (soonest-expiry
        # first). The user doesn't pick a lot; each lot moved keeps its lot #
        # and expiry at the destination. If a lot IS given (multi-line dialog),
        # the drawdown is restricted to it.
        buckets = await inv_repo.location_item_buckets(
            db,
            item_id=item.id,
            location_id=from_location_id,
            lot_number=line.lot_number,
        )
        available = sum((b.quantity_available for b in buckets), Decimal(0))
        if available < line.quantity:
            raise ValidationError(
                f"Insufficient stock of item {item.item_code} at the source "
                f"location — {available} available, {line.quantity} requested",
                code="insufficient_stock",
                details={
                    "item_id": str(item.id),
                    "from_location_id": str(from_location_id),
                    "available": str(available),
                    "quantity": str(line.quantity),
                },
            )

        remaining = line.quantity
        for bucket in buckets:
            if remaining <= 0:
                break
            take = min(bucket.quantity_available, remaining)
            bucket.quantity_available = bucket.quantity_available - take
            remaining -= take
            await inv_repo.add_stock(
                db,
                item_id=item.id,
                location_id=to_location_id,
                lot_number=bucket.lot_number,
                expiry_date=bucket.expiry_date,
                quantity=take,
                unit_of_measure=item.unit_of_measure,
            )
            await inv_repo.add_transaction_line(
                db,
                transaction_id=txn.id,
                item_id=item.id,
                from_location_id=from_location_id,
                to_location_id=to_location_id,
                lot_number=bucket.lot_number,
                expiry_date=bucket.expiry_date,
                quantity=take,
                unit_of_measure=item.unit_of_measure,
            )
        await db.flush()

    created = await inv_repo.get_transaction(db, txn.id)
    assert created is not None  # just created it
    response = _txn_to_detail(created)
    await db.commit()
    return response
