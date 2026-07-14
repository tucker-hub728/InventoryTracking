"""Forecast module — planned production runs (product × customer × month).

A **forecast entry** records how many production *runs* are planned for a
product (optionally tied to a customer) in a given year + month — the SOT
workbook "MFG Schedule and Forecast by Customer and Product (Runs)".

Reads need ``inventory:view``; the batch **save** is a single e-signed,
audit-logged action (``inventory:sign``) — the same CFR-21-Part-11 reauth
flow as a stock movement (``app.auth.reauth.consume_reauth_evidence`` +
``app.audit.record_entity_change``). Cells are high-churn, so rows are
hard-deleted (no soft-delete) — clearing a cell sends ``runs = 0``.

Routes live in ``routes.py`` (mounted by ``app.api.v1.router``); persistence
goes through ``repository.py`` (caller-commits, like ``app.products``).
"""

from __future__ import annotations
