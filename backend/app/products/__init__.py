"""Customer module — customers and their linked finished-good items.

Products / BOM moved into the unified catalogue (``items`` + ``bom_lines``,
see ``app.catalog``). What remains here is the **Customer** and its
many-to-many link to finished-good items (``app.customer_items``).

Routes live in ``routes.py`` and are mounted by ``app.api.v1.router``.
Persistence goes through ``repository.py`` (same caller-commits convention
as ``app.inventory.repository``); audit rows are written via
``app.audit.record_entity_change``.
"""

from __future__ import annotations
