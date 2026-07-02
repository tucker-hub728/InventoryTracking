"""Catalogue module — item categories and multi-level bills of materials.

Adds the two pieces that turn flat ``items`` into a unified catalogue
(requirements v2 §6):

* **Item categories** — user-managed, each with a ``kind`` (purchased / built).
* **BOM lines** — a self-referencing parent→child list over ``items`` enabling
  multi-level / nested bills of materials.

Both category and BOM writes are electronically signed (21 CFR Part 11), like
lot edits elsewhere in the app.
"""
