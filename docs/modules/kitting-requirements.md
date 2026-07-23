# Kitting (Back-Flush & Reconciliation) — Consolidated Requirements

**Module:** Kitting · Back-Flush · Reconciliation
**Scope:** Every requirement across the SRS documents and the Transaction Specification that touches kitting, close-out, back-flush, reconciliation, the kitting history/audit trail, and the production areas a kit is staged into. Requirements belonging to other areas (receiving, planning, roles, consumables/Kanban, customers) appear only where they are the final step of a kit.
**Prepared:** 2026-07-23
**Basis:** Status reflects what is actually built in the current system. Notes are written for a general (non-technical) reader.

---

## 1. Source documents & lineage

| # | Document | Date | Role in the kitting story |
|---|----------|------|---------------------------|
| D1 | CellReady SRS | 2026-07-01 | **Base document.** First defines the "Kit Material" transaction and the Back-Flush & Reconciliation section. |
| D2 | CellReady Transaction Specification | 2026-07-01 | The step-by-step spec for how kitting works: building a kit, issuing material, adding more, close-out, and returning leftovers. **This spec governs the kitting flow.** |
| D3 | SRS Update — Amendment 3 | 2026-07-09 | Reworks how kitting behaves: material shows as consumed at the moment it's issued, is never locked to a production lot, and leftovers are returned as a clearly labelled "back-flush". **Adds to, does not replace, the base.** |
| D4 | SRS Update — Amendment 4 | 2026-07-15 | Mostly locations/prefixes; for kitting, only sets the build order (kitting comes after sub-assembly and finished goods). |
| D5 | SRS Update — Amendment 5 | 2026-07-22 | Confirms the **live** kitting behaviour seen in the demo: the close-out set (KIT-001…008), the kitting history log, and the seeded production areas. |

> **Change-control note (REQ-2026-07-09-PRC-001):** Each amendment is an **explicit set of changes**, not a fresh replacement. Earlier in July, a full document was mistaken for a from-scratch rewrite, which caused finished work to be removed. Since then every update states plainly what it changes. This document follows the same rule: superseded requirements are kept and marked, never deleted.

### Status legend

| Status | Meaning |
|--------|---------|
| ✅ Implemented | Built and working in the current system. |
| 🔧 Implemented (amended) | Built, but a later document changed the original wording; the system follows the newer intent. |
| ⤴️ Superseded | Replaced by a newer requirement (the replacement is named in the note). |
| ⏳ Pending | Part of the kitting story, but not built yet. |
| ⛔ Out of module | A real requirement, but handled in another area (consumables/Kanban, SOP paperwork, customers) — listed only so nothing is lost. |

---

## 2. Core kitting & close-out requirements (2026-07-22)

These are the confirmed, up-to-date descriptions of how the flow works today. They are the requirements to test against.

| Requirement ID | Requirement | Status | Note |
|----------------|-------------|--------|------|
| REQ-2026-07-22-KIT-001 | Creating a kit captures a kit identifier, the target item, a target quantity, and an expected destination (e.g. Clean Room One) to match the paper traveler. | ✅ Implemented | Working. A kit can only be started for a sub-assembly or finished good that has a recipe, and its destination must be a real production/lab area. |
| REQ-2026-07-22-KIT-002 | On opening a kit, show available quantities per lot/shelf for each required component and default the issue quantity to the needed amount. | ✅ Implemented | Working. Each component shows where it's stocked and how much is on hand, and the amount to issue is pre-filled from the recipe. |
| REQ-2026-07-22-KIT-003 | When a selected lot cannot fully satisfy the need, issue the available quantity and use an "add next" action to draw the remainder from another lot (oldest first). | ✅ Implemented | Working. If one lot isn't enough, the operator adds another; the system suggests oldest-stock-first, and for freezer boxes the exact vials can be picked. |
| REQ-2026-07-22-KIT-004 | For a kit in production, the operator can issue additional quantity of a component; additions are recorded in the kit's history. | ✅ Implemented | Working. "Issue more" adds material to a kit that's already in production, and it shows up in the kit's history. |
| REQ-2026-07-22-KIT-005 | At close-out, enter quantity made good, optionally scrap; expiration is optional; the operator selects where the finished output is stored (warehouse, freezer, LN2 tank position, etc.). | ✅ Implemented | Working, including placing output into a specific freezer/LN2 box position. **Added 2026-07-23:** if a single box can't hold the whole batch, the output can be split across more than one location while staying a single lot. |
| REQ-2026-07-22-KIT-006 | Close-out back-flushes the difference between issued and used, prompting for each leftover's return location, defaulting to the source and remaining editable. | ✅ Implemented | Working. At close-out the system returns whatever wasn't used; the return location defaults to where the material came from and the operator can change it. |
| REQ-2026-07-22-KIT-007 | Kitting imposes no forced automation or gating: a kit may be built and reconciled after the physical work, supporting both campaign (issue up front) and serialized (assign at point of use) production. | 🔧 Implemented (amended) | Working. The system no longer forces the numbers to match a recipe — it records what actually happened. It only prevents physically impossible entries (issuing or returning more than exists). Operators can also make a batch at a time and keep the kit open, then close it at the end. This reversed several earlier "must match" rules (see §8). |
| REQ-2026-07-22-KIT-008 | The draft-state defect (a kit remaining in draft after issuing material) is corrected and the full issue-and-close path verified. | ✅ Implemented | Fixed and verified. Issuing material now moves the kit into production in one step; the full create → issue → produce → close path is tested. |

---

## 3. Back-Flush & Reconciliation (2026-07-01) — as amended

| Requirement ID | Requirement | Status | Note |
|----------------|-------------|--------|------|
| REQ-2026-07-01-BFL-001 | Provide a back-flush/reconciliation function so actual consumed quantities can be corrected against recipe-expected quantities (recipe expected 10, actually used 13 → remove an additional 3). | 🔧 Implemented (amended) | Working. The operator enters how much was actually used, and the leftover is returned automatically. **Changed by KIT-007:** the system no longer forces the used amount to equal the recipe — it just can't be less than the amount needed to make the batch, or more than what's physically on the floor. |
| REQ-2026-07-01-BFL-002 | Reconciliation occurs at the point of transacting finished goods into their inventory location (not at shipment). | ✅ Implemented | Working. Reconciliation happens at close-out, when the finished output is put into storage — never at the point of shipping to a customer. |
| REQ-2026-07-01-BFL-003 | At reconciliation, a screen presents the recipe with expected consumption and lets the operator enter actual consumed quantities per line. | ✅ Implemented | Working. The Close-Out screen shows each component with what's needed, what's on the floor, what was used, what's left, and where leftovers go. Expected amounts are shown as guidance, not enforced. |
| REQ-2026-07-01-BFL-004 | Capture scrap/yield data (quantity consumed to produce N good units) per batch and per finished-good item, for downstream cost/yield analysis. Price association optional. | ✅ Implemented (price deferred) | Working. Good and scrap counts are tracked, and each batch gets its own lot with its own expiry, so yield is traceable per batch. Attaching cost/price is optional and not built yet. |
| REQ-2026-07-01-BFL-005 | Detailed lot-level traceability reconciliation stays on paper batch records; the software does not attempt full lot-to-finished-good traceability. | ✅ Honored | The kit history records quantities and movements only. It supports the paper traveler; it does not try to trace a finished good back to its component lots. |

---

## 4. Kitting transactions (2026-07-01 → amended 2026-07-09)

The 2026-07-01 transaction set was reworked by the 2026-07-09 amendment. Both are shown so the change is clear.

| Requirement ID | Requirement | Status | Note |
|----------------|-------------|--------|------|
| REQ-2026-07-01-TRX-002 | A "Kit Material" transaction forces selected raw materials to manufacturing **at zero remaining**, immediately and permanently removing them (no traceability). | ⤴️ Superseded | Replaced. The "force everything to zero" idea is replaced by **REQ-2026-07-09-TRX-001** (material shows as consumed when issued, and the issued amount is chosen manually) and **REQ-2026-07-22-KIT-007** (no forced rules). Kitting is only final for consumables; for products, the final step is shipping to a customer. |
| REQ-2026-07-01-TRX-004 | Non-consumable raw materials support a one-for-one transaction into a kit/sub-assembly/finished good. | ✅ Implemented | Working. Product components are issued into a kit and consumed at close-out, and can be drawn across several lots when needed. |
| REQ-2026-07-01-TRX-008 | Provide an admin/manual transaction to return excess items back into inventory (15 pulled, 3 returned) **without** assigning them to a lot number, so returned stock is never stranded. | ✅ Implemented | Working. Extra material can be returned to inventory mid-production. It comes back on its own original lot, so it keeps its expiry and can never get "stuck" against a production lot. |
| REQ-2026-07-09-TRX-001 | Kitted product items are visible as consumed from source inventory **at issue time**: 50 on hand, 25 kitted → 25 on hand. Kitting is final only for consumables; for products, the final transaction is customer shipment. | ✅ Implemented | Working. The moment material is issued to a kit, on-hand inventory drops accordingly, while the material still physically sits in the production area as work-in-progress. **Replaces** REQ-2026-07-01-TRX-002. |
| REQ-2026-07-09-TRX-002 | Material is **never** assigned to a production lot at kitting time; assignment happens only at actual use. Prevents the stranded-kit failure. | ✅ Implemented | Working. Nothing is locked to a production lot when it's issued, so a cancelled kit simply returns everything — no stranded material. |
| REQ-2026-07-09-TRX-003 | Returned leftover posts as an explicit "back-flush" transaction (not a plain receive): issued 15, used 12, back-flushed 3; the item balance increases. | ✅ Implemented | Working. Returns are labelled by reason so the history reads clearly: normal close-out reconciliation, extra material handed back mid-production, and a cancelled-kit return are each shown distinctly. |
| REQ-2026-07-09-TRX-004 | Back-flush is understood as kitting and de-kitting: one transaction subtracts, the counterpart adds. Applies to product items only; consumables are never quantity-adjusted after issue. | ✅ Implemented | Working. Issuing subtracts from inventory; returning/back-flushing adds it back. This applies to product components on a kit. |
| REQ-2026-07-09-TRX-005 | A customer list exists; the final finished-goods transaction ships to a named customer (incl. CellReady itself), capturing the shipping/transaction number. | ⏳ Pending | Not built yet. This is the final step after a kit is closed. There is no customers feature in the system yet — re-confirmed as still-to-build by REQ-2026-07-22-CUST-001. |

---

## 5. Kitting history / audit log & system boundary (2026-07-22)

| Requirement ID | Requirement | Status | Note |
|----------------|-------------|--------|------|
| REQ-2026-07-22-AUD-001 | All kitting and reconciliation events are recorded in an audit log, including back-flush returns shown as reconciliation entries, viewable per item and per kit. | ✅ Implemented | Working. Every kit action (create, edit, issue, issue-more, return, produce, close, cancel) is captured in the kit's history, and the amount of material each batch consumed is recorded too. Viewable per kit. |
| REQ-2026-07-22-AUD-002 | The system remains an inventory/quantity engine only: it does not disposition or track against a production job/traveler; the audit log complements but does not replace the paper traveler. | ✅ Honored | The system tracks quantities and locations only. The kit history supports the paper traveler; it does not replace it. |

---

## 6. Production areas kitting stages into (2026-07-22)

| Requirement ID | Requirement | Status | Note |
|----------------|-------------|--------|------|
| REQ-2026-07-22-LOC-001 | Production is a location group with seeded sub-areas (initially Clean Room One/Two, Manufacturing Floor, PD Lab One/Two), renameable to the client's actual area names. | ✅ Implemented | Working. Production areas are pre-loaded and can be renamed to your real area names. A kit's destination must be one of these areas. |
| REQ-2026-07-22-LOC-002 | Kitting transfers material to a production sub-area so staff can see what is being built/staged in each area. | ✅ Implemented | Working. Issued material moves to the production area, and a Production view shows what's being built and staged in each area. |
| REQ-2026-07-22-LOC-003 | Production areas are seeded to cover existing spaces (client indicated six clean rooms) rather than dynamic add; new areas added by admin on request. | ✅ Implemented | Working. Areas are pre-loaded. If a new area is ever needed, a Super Admin can add it on request. |
| REQ-2026-07-22-LOC-004 | LN2 cascade levels (tank, quadrant, rack, box/position grid) are renameable and re-cascadeable by the client; creation stays role-controlled. | 🔧 Partial | Freezer/LN2 box positions can be used as a kit's output/return destination. Renaming and rearranging the LN2 levels themselves is part of the Locations area, not kitting. |

---

## 7. Requirements changed / overwritten across documents

An explicit record of where a later document changed or replaced an earlier kitting requirement (the "note if overwritten" you asked for).

| Later doc | Changes / replaces | What changed, in plain terms |
|-----------|--------------------|------------------------------|
| 2026-07-09 · TRX-001 | **Replaces** 2026-07-01 · TRX-002 | "Force everything to zero" gave way to: material shows as consumed when issued, and the amount issued is chosen by the operator. Kitting is only final for consumables. |
| 2026-07-09 · TRX-002 | **Clarifies** 2026-07-01 · TRX-002 | Material is never locked to a production lot when issued — this removes the risk of material getting stranded on a cancelled kit. |
| 2026-07-09 · TRX-003 | **Refines** the 2026-07-01 back-flush | Leftovers must be returned as a clearly labelled "back-flush", not a plain receive. |
| 2026-07-22 (demo confirmation) | **Confirms the live behaviour of** 2026-07-09 · TRX-003 | At close-out the operator enters the good quantity; the system returns issued-minus-used, labels it as reconciliation in the history, and asks where leftovers go (defaults to the source, editable; nothing moves on its own). |
| 2026-07-22 · KIT-007 | **Relaxes** 2026-07-01 · BFL-001 & BFL-003 | Dropped the rules that forced consumption to match the recipe; kept back-flush and manual entry of what was actually used. Supports both up-front (campaign) and as-you-go (serialized) production. |
| Transaction Spec §2 (2026-07-01) | **Governs** the kitting flow | Issuing a kit moves the material to the production area (its location updates from storage to production). An earlier "no work-in-progress area" assumption was withdrawn as unfounded. |

---

## 8. How the build refined the requirements (2026-07-21 → 07-23)

The documents capture *what* the client wants; the build settled *how* KIT-005/006/007 and BFL-001 actually work, in a few dated decisions. None of these are new client requirements — they are how the confirmed requirements were delivered.

| Date | Decision (plain terms) | Requirements affected |
|------|------------------------|-----------------------|
| 2026-07-21 | Issuing a kit moves the material into the production area as work-in-progress; cancelling a kit returns everything; a kit's destination must be a genuine production/lab area. | TRX-001, TRX-002, KIT-008 |
| 2026-07-23 | No forced rules — the system records what actually happened and only blocks physically impossible entries. | KIT-007, BFL-001/003 |
| 2026-07-23 | Make a batch at a time and keep the kit open ("Produce"), then close it at the end. Good/scrap/used add up across batches. | KIT-007 |
| 2026-07-23 | The operator enters how much of each component was used; it must be at least enough to make the batch and no more than what's on the floor. | BFL-001/003, KIT-006 |
| 2026-07-23 | Each produced batch gets its own lot with its own expiry — this fixed a display bug where every batch row showed the same expiry date. | BFL-004, KIT-005 |
| 2026-07-23 | If one box can't hold the whole batch, the output can be split across several boxes/freezers/shelves while staying one lot. | KIT-005 |
| (recent) | Cancelling a kit now requires an electronic signature, alongside producing a batch and closing out. | KIT-007, AUD-001 |

---

## 9. Related requirements handled in another area

Real, in-force requirements that touch the edges of a kit but belong to a different area. Listed for completeness; **not** kitting deliverables.

| Requirement ID | Requirement | Status | Where it lives |
|----------------|-------------|--------|----------------|
| REQ-2026-07-01-TRX-003 | Consumables moved to manufacturing without per-lot tracking; only expiration tracked. | ⛔ Out of module | Consumables / Kanban flow. Kitting handles product components only. |
| REQ-2026-07-09-TRX-006 | Consumable expiration flags clearable with an acknowledgment showing where/when issued. | ⛔ Out of module | Consumables / Kanban expiry. |
| REQ-2026-07-01 Spec §4.3 | Consumables reconciliation/back-flush handled by a **separate** function (not tracked against a recipe). | ⛔ Out of module | Distinct from kit close-out back-flush. |
| REQ-2026-07-22-CUST-001 / REQ-2026-07-09-TRX-005 | A customer feature connected to finished goods; shipping a finished good to a named customer is the final transaction. | ⏳ Pending | Customers area — **not built yet**. This follows a closed kit. |
| REQ-2026-07-01-DLV-003 | A kitting SOP (wash/clean/decontaminate) documented and tied to the kitting transaction. | ⛔ Out of module | SOP paperwork, not software. |
| REQ-2026-07-15-SEQ-002 | Build order: kitting and back-flush built after sub-assembly and finished goods. | ✅ Done | Delivery schedule — kitting is built. |
| REQ-2026-07-01-TRC-005 | The system stays flexible so full traceability can be added later without a redesign. | ✅ Honored | The running record of every movement keeps that door open. |

---

## 10. Transaction Specification — kitting workflow coverage (2026-07-01)

The Transaction Spec is written as prose, but it is the governing workflow for kitting. Each step is mapped to its status.

| Spec step | Requirement | Status | Note |
|-----------|-------------|--------|------|
| §1.1 Item hierarchy | Two raw materials combine into a sub-assembly; sub-assemblies and raw materials combine into finished goods. | ✅ Implemented | A kit can only be started for an item that has a recipe of at least two components. |
| §2 Kitting for inventory | Needed amount comes from the recipe; issued amount is entered by hand; **material moves from storage to the production area**. | ✅ Implemented | Working as described. |
| §2.1 Process notes | Issued amount is deducted from the source location; more material can be issued during production. | ✅ Implemented | Working, including "issue more". |
| §3 Kit close-out | Reconcile issued vs used; return leftovers to a chosen location, added back to available stock. | ✅ Implemented | Working. |
| §3.1 Production output | The quantity made is added to a storage location and the material used is subtracted; a sub-assembly can then be kitted again; a finished good later ships to a customer. | ✅ Implemented (customer step pending) | Making and storing output works; the finished-good-to-customer step waits on the Customers area (CUST-001). |
| §4 / §4.3 Consumables | Consumables move to a Kanban location and are considered consumed on issue; their reconciliation is a **separate** function. | ⛔ Out of module | Separate from kit close-out; see §9. |

---

### Testing anchor (beta verification, 2026-07-22)

Beta verification is recorded test scripts showing the features work, an independent security sign-off, and a cover page — explicitly **not** a formal 21 CFR Part 11 validation (that comes in the later traveler-grade phase). Kitting and Production are exercised with a "still being refined" note. The requirements in §2–§6 above are the click-paths to script.
