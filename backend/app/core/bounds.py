"""Domain upper bounds for numeric input.

Every quantity and price field validated only that it was *positive*. That
is not the same as *bounded*, and the gap had a concrete failure mode: the
underlying columns are ``Integer`` (int4, max 2,147,483,647) and
``Numeric(14,2)`` (max 10^12), so a request carrying 2**31 passed Pydantic,
reached the flush, and raised ``DataError`` — which is not ``IntegrityError``
and so was not caught by the handlers that wrap writes. The result was an
unhandled 500 from a value the API accepted, repeatable for free by anyone
authenticated.

The bounds below are deliberately *domain* limits rather than column limits.
A cell-therapy inventory does not legitimately receive a million vials in a
single line, so rejecting at a million turns a nonsense value into a clear
422 at the edge instead of a database error at the bottom of the stack —
and leaves several orders of magnitude of headroom before the column type
becomes the constraint.

Import the constants and pass them as ``le=``; keeping them named means the
value is greppable and changes in one place.
"""

from __future__ import annotations

from decimal import Decimal

# Whole-unit counts: vials, boxes, units received, units produced.
MAX_QTY: int = 1_000_000

# Fractional quantities — BOM ``qty_per_unit``, reorder thresholds. Same
# magnitude as MAX_QTY; the type differs, not the domain.
MAX_QTY_DECIMAL: Decimal = Decimal("1000000")

# Money. Columns are Numeric(14,2), i.e. 12 integer digits; this sits two
# orders of magnitude below that so arithmetic on a line total (qty × price)
# still has room before it can overflow the column.
MAX_MONEY: Decimal = Decimal("99999999.99")

__all__ = ["MAX_MONEY", "MAX_QTY", "MAX_QTY_DECIMAL"]
