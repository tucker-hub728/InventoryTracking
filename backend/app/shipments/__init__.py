"""Customer-shipment module — the terminal ship-finished-good-out transaction.

A finished good (or sub-assembly sold directly, INV-004) leaves inventory to a
customer (REQ-2026-07-22-CUST-001 / 07-01 TRX-005). The customer is optional so
both a named customer and a catalog / unassigned recipient are supported
(TRX-007). Only the shipped item's stock changes — no cascade to components
(TRX-006).
"""
