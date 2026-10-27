---
id: CR-086
kind: CR
status: building
owner_bot: dom-architect
approval: "Dvir §10 D YES 2026-10-27 ~02:44 IDT via Gavriel: archive ~267 bak + stale scout docs; no delete; inventory then move under archive/."
priority: P2
depends_on: []
supersedes: []
max_rounds: 2
---
# CR-086: archive bak + stale scout docs (no delete)

**Approval:** Dvir §10 D FINAL 2026-10-27 ~02:44 IDT via Gavriel. **No delete.** Inventory → move under `archive/`. Mostly **company-box** work by DOM Architect / Gavriel; Claude Code only if any path is referenced by DOM jobs (fix and leave stubs or update docs — do not break datasave).

## Why
267 `.bak*` / cloned CSVs and pre-reorg scout docs create false dual stores and confuse Claude Code / bots (JOINT-OPS waste).

## Rules
- R-1 **Inventory first.** Write `docs/requests/BAK-ARCHIVE-INVENTORY-2026-10-27.md` (counts by tree, sample paths). Update this CR Changes with totals.
- R-2 **Move, never delete.** Targets go under `/workspace/domain-trading/archive/` (dated subfolder OK). Preserve paths in a manifest.
- R-3 **Stale scout language.** Docs that still name day-to-day Tzofeh-* scouts as live roles get moved to archive **or** stamped “superseded by org-v2” at top if they must stay for history in place — prefer archive for `.bak*`; prefer banner for still-linked handoffs.
- R-4 **Don’t break readers.** Before move, `rg` for path references in active routines/SOPs/DOM docs; update pointers or skip that file and list it under **Blocked**.
- R-5 **No DOM money / no settings.** No API money routes. If a DOM job hard-codes a bak path (unlikely), fix pointer only.

## Acceptance tests
- AT-1 Inventory file exists with count ≥ documented bak set.
- AT-2 After pass, `find company-tree -name '*.bak*'` outside `archive/` is **0** or only **Blocked** exceptions listed in inventory.
- AT-3 Manifest lists old path → new path for every moved file.
- AT-4 Negative: no `rm` of bak content (archive only); git history / box copy retained under archive/.
- AT-5 Active discovery v2 / org-v2 paths still resolve (spot-check shortlist SOP + org-v2).

## Out of scope
Deleting files; renaming live portfolio.csv; Sedo; token changes.

## Questions (≤3)
1. If a bak is the only copy of a unique decision note, still archive (not delete) — **default yes**.
2. DOM repo `docs/` bak files (if any) — include in same pass? Default yes under `docs/archive/` or leave and list.

## DVIR items
None (already yes).

## Changes
- 2026-10-27 ~02:46 IDT (DOM Architect): filed; inventory + first move pass start same day on company box.
- 2026-10-27 ~02:48 IDT: inventory `BAK-ARCHIVE-INVENTORY-2026-10-27.md`; **moved 266** `.bak*` → `archive/bak-2026-10-27/` (MANIFEST.txt); **0** left outside archive. Stale scout **banner** pass still open (non-bak docs).
- 2026-10-27 ~03:48 IDT (DOM Architect): Dvir t981u — queue **#5** stale scout banners (bak half done); Architect owns banner pass on company box.
- 2026-10-27 ~16:25 IDT (Gavriel): AT-2 re-verified (0 bak outside archive; 267 under archive/bak-2026-10-27). Stale-scout **banner pass done** on company box (13 files); see NOTE-2026-10-27-cr086-banner-pass-gavriel.md. Status still building until Architect stamps done.
