"""Subject-binding tests for the e-signature (VR-006).

A reauth ticket used to say only "this person may do a lot.update" — not
*which* lot. Inside its 120-second life it satisfied that action against any
row of that type, and the resulting audit row looked entirely legitimate:
right name, right timestamp, right attestation, wrong record.

These tests drive ``consume_reauth_evidence`` directly. Going through HTTP
would need a live password and a full domain fixture, and the thing under
test is the comparison, not the transport.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from app.auth.reauth import ReauthEvidenceInvalid, consume_reauth_evidence
from app.auth.schemas import ReauthRequest
from app.core.config import get_settings
from app.models.audit import ReauthEvent
from app.models.identity import User
from pydantic import ValidationError as PydanticValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

LOT_TABLE = "app.lots"


@pytest_asyncio.fixture
async def sm():
    engine = create_async_engine(str(get_settings().database_url), poolclass=NullPool)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


async def _mint(session, *, user_id, action, record_table=None, record_id=None):
    """Insert a successful, unexpired evidence row bound as specified."""
    evt = ReauthEvent(
        user_id=user_id,
        action=action,
        meaning="I attest this change",
        comment=None,
        success=True,
        failure_reason=None,
        ip_address=None,
        user_agent=None,
        expires_at=datetime.now(UTC) + timedelta(seconds=120),
        record_table=record_table,
        record_id=record_id,
    )
    session.add(evt)
    await session.flush()
    return evt


@pytest_asyncio.fixture
async def user_id(sm):
    async with sm() as s:
        uid = (await s.execute(select(User.id).limit(1))).scalar_one_or_none()
    if uid is None:
        pytest.skip("dev database has no user to sign as")
    return uid


async def test_signature_bound_to_a_record_works_on_that_record(sm, user_id) -> None:
    lot = uuid.uuid4()
    async with sm() as s:
        evt = await _mint(
            s, user_id=user_id, action="lot.update", record_table=LOT_TABLE, record_id=lot
        )
        await consume_reauth_evidence(
            s,
            evidence_id=evt.id,
            user_id=user_id,
            expected_action="lot.update",
            target_table="app.stock_movements",
            target_id=uuid.uuid4(),
            record_table=LOT_TABLE,
            record_id=lot,
        )
        await s.rollback()


async def test_signature_for_one_record_is_refused_on_another(sm, user_id) -> None:
    """The whole point of VR-006.

    Signed while looking at lot A; spent on lot B. Before the fix this
    succeeded and the audit trail recorded the operator's attestation against
    a record they never opened.
    """
    lot_a, lot_b = uuid.uuid4(), uuid.uuid4()
    async with sm() as s:
        evt = await _mint(
            s, user_id=user_id, action="lot.update", record_table=LOT_TABLE, record_id=lot_a
        )
        with pytest.raises(ReauthEvidenceInvalid) as excinfo:
            await consume_reauth_evidence(
                s,
                evidence_id=evt.id,
                user_id=user_id,
                expected_action="lot.update",
                target_table="app.stock_movements",
                target_id=uuid.uuid4(),
                record_table=LOT_TABLE,
                record_id=lot_b,
            )
        assert excinfo.value.code == "reauth_evidence_record_mismatch"
        await s.rollback()


async def test_same_id_different_table_is_refused(sm, user_id) -> None:
    """Both halves are compared — an id that collides across tables must not
    slip through on the id alone."""
    shared = uuid.uuid4()
    async with sm() as s:
        evt = await _mint(
            s, user_id=user_id, action="lot.update", record_table=LOT_TABLE, record_id=shared
        )
        with pytest.raises(ReauthEvidenceInvalid) as excinfo:
            await consume_reauth_evidence(
                s,
                evidence_id=evt.id,
                user_id=user_id,
                expected_action="lot.update",
                target_table="app.stock_movements",
                target_id=uuid.uuid4(),
                record_table="app.kits",
                record_id=shared,
            )
        assert excinfo.value.code == "reauth_evidence_record_mismatch"
        await s.rollback()


async def test_bound_evidence_cannot_be_spent_unbound(sm, user_id) -> None:
    """A caller must not shed the binding by simply omitting the subject.

    Otherwise the check is opt-out: any endpoint that forgot to pass a subject
    would silently accept a ticket minted for a specific record.
    """
    lot = uuid.uuid4()
    async with sm() as s:
        evt = await _mint(
            s, user_id=user_id, action="lot.update", record_table=LOT_TABLE, record_id=lot
        )
        with pytest.raises(ReauthEvidenceInvalid) as excinfo:
            await consume_reauth_evidence(
                s,
                evidence_id=evt.id,
                user_id=user_id,
                expected_action="lot.update",
                target_table="app.stock_movements",
                target_id=uuid.uuid4(),
            )
        assert excinfo.value.code == "reauth_evidence_record_mismatch"
        await s.rollback()


async def test_unbound_evidence_still_works(sm, user_id) -> None:
    """Create flows (and any row written before esignbind01) have no subject
    and must keep working on the action check alone."""
    async with sm() as s:
        evt = await _mint(s, user_id=user_id, action="item_tier.create")
        await consume_reauth_evidence(
            s,
            evidence_id=evt.id,
            user_id=user_id,
            expected_action="item_tier.create",
            target_table="app.item_tiers",
            target_id=uuid.uuid4(),
        )
        await s.rollback()


async def test_action_check_still_applies_alongside_subject(sm, user_id) -> None:
    """Binding must not have replaced the action check."""
    lot = uuid.uuid4()
    async with sm() as s:
        evt = await _mint(
            s, user_id=user_id, action="lot.update", record_table=LOT_TABLE, record_id=lot
        )
        with pytest.raises(ReauthEvidenceInvalid) as excinfo:
            await consume_reauth_evidence(
                s,
                evidence_id=evt.id,
                user_id=user_id,
                expected_action="lot.delete",
                target_table="app.lots",
                target_id=lot,
                record_table=LOT_TABLE,
                record_id=lot,
            )
        assert excinfo.value.code == "reauth_evidence_action_mismatch"
        await s.rollback()


def test_schema_rejects_half_a_subject() -> None:
    """``record_table`` without ``record_id`` would bind nothing while
    looking like it bound something."""
    with pytest.raises(PydanticValidationError):
        ReauthRequest(action="lot.update", password="x", record_table=LOT_TABLE)
    with pytest.raises(PydanticValidationError):
        ReauthRequest(action="lot.update", password="x", record_id=str(uuid.uuid4()))
    # Both, or neither, are fine.
    ReauthRequest(action="lot.update", password="x")
    ReauthRequest(
        action="lot.update",
        password="x",
        record_table=LOT_TABLE,
        record_id=str(uuid.uuid4()),
    )

# NOTE: no cleanup fixture. Every test rolls back, and it could not clean up
# anyway — audit.reauth_events and audit.reauth_consumptions are append-only,
# enforced by database triggers that reject DELETE outright. Confirming that
# guarantee still holds was an unplanned bonus of writing these.
