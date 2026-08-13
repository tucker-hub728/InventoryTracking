"""Material-issue module — the debit-and-gone transaction.

REQ-2026-08-04-TRX-001/002: transacting material to certain destinations "removes
it from inventory entirely, in the same manner as a customer shipment" — the
client names PD/R&D and the QC labs.

The distinction this module exists to preserve (client, 2026-08-13):

    Transfer → QC 1 › Freezer 1     the material is still inventory, elsewhere
    Issue    → QC 1                 the material has left controlled inventory

Same physical area, two different transactions. Which happened is the operator's
explicit choice, so they are separate actions with separate endpoints, and a
single quantity is never both. That last part is structural rather than
validated: a transfer's destination must be a storage node
(``box``/``sub_location``/``shelf``) and an issue's must be a scrap LOCATION
(``storage_category`` with ``is_scrap``). The two sets are disjoint, so no
request can express "issue it and store it in the QC freezer".

Nothing is created at the destination — no allocation, no register row. The
``material_issue`` ledger entry carries the destination purely as the record of
where the material went; reading it as a balance would be a mistake.

Sibling of ``app.consumables``, which issues a *consumable* to a *Kanban* and
keeps an expiration flag afterwards. This one issues *any item* to a *location*
and keeps nothing — the material is gone.
"""
