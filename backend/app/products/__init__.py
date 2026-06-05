"""Product module — products, their bill of materials, and customers.

A **product** is a sellable/buildable finished good (a name + a BOM). The
BOM (``app.product_materials``) lists the inventory ``items`` consumed per
production run, carrying each item's live stock for the Available / Stock
Status columns. **Customers** (``app.customers``) link to products
many-to-many via ``app.customer_products``.

Routes live in ``routes.py`` and are mounted by ``app.api.v1.router``.
Persistence goes through ``repository.py`` (same caller-commits convention
as ``app.inventory.repository``); audit rows are written via
``app.audit.record_entity_change``.
"""

from __future__ import annotations
