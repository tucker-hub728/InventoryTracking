"""Catalogue module — item tiers and multi-level bills of materials.

Adds the two pieces that turn flat ``items`` into a unified catalogue
(requirements v2 §6):

* **Item tiers** — the three fixed tiers, each with a ``type`` (raw_material / sub_assembly / finished_good).
* **BOM lines** — a self-referencing parent→child list over ``items`` enabling
  multi-level / nested bills of materials.

Both tier and BOM writes are electronically signed (21 CFR Part 11), like
lot edits elsewhere in the app.
"""
