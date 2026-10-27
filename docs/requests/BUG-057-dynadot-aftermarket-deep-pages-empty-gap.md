---
id: BUG-057
kind: BUG
status: approved
owner_bot: dom-architect
approval: "none-needed (datasave Dynadot aftermarket read/seal; no money; blocks CR-080 3-day server-primary window)"
priority: P1
depends_on: [CR-080]
supersedes: []
max_rounds: 2
repro_test: "Given live Dynadot REST v2 aftermarket with total_listings ~473k, When datasave dynadotAftermarket runs with key configured, Then step seals with rows_n > 0 (or documented partial with real rows), never status=gap reason=deep_pages_empty with rows_n=0 after hundreds of successful page calls."
---
> Status: Approved — BUILD NOW (maintenance; blocks CR-080 day-1)

# BUG-057: dynadotAftermarket GAP deep_pages_empty with 0 rows after 474 calls

| Field | Value |
|---|---|
| From | DOM Architect (Grok Bot) |
| Date | 2026-10-27 ~17:45 IDT |
| Type | Bug / maintenance (allowed under freeze) |
| Build | Fix server Dynadot aftermarket pull/seal so a normal day seals rows. No money. |

## Call made / expected / got
- **Call:** datasave step `dynadotAftermarket` on Mac live **5.67.0**, keys in process (CR-080). Manual run `run_f1861b6e-e803-476d-90de-2cbdbd9686e5` (16:24–17:29 IDT).
- **Expected:** seal aftermarket for `data_date` 2026-10-27 with `origin: server`, `rows_n` matching listings pulled (dual-runner day-1 toward 3-day ok window).
- **Got:** step done `ok=true`, summary `status: gap`, `sealed: false`, `rows_n: 0`, `pages_n: 1`, `calls_n: 474`, `gap.reason: deep_pages_empty`, `total_listings: 473798`, no error string. ~49 min. Logs showed many listings pages HTTP 200 earlier in the run.

## Why (working hypothesis — confirm in DOM response)
R-8 / R-8v2 GAP fired (`deep_pages_empty`) even though total_listings is large and many pages returned 200. Possible: wrong page/empty-body handling, page_size vs total mismatch, or seal path discarding all rows before GAP. Same run's `dynadotCloseouts` sealed **partial** (53878 rows; pages 55–57 HTTP 500) — closeouts path still unset / bot-primary per Gavriel.

## Rules
- R-1 A healthy aftermarket day with ~470k listings must **seal** with `rows_n > 0` (or honest `partial` with non-zero rows + `pages_failed`), not `gap` + 0 rows after hundreds of OK calls.
- R-2 Keep GAP for true collapse (total 0 / under 1/10 baseline / no rows over floor) — do not invent rows.
- R-3 No money / no registrar buy / no settings activation beyond documenting the fix.
- R-4 Report when a post-fix datasave `dynadotAftermarket` seals; Architect stamps CR-080 day-1 then.

## Acceptance tests
- AT-1 **Live or fixture:** aftermarket run with large `total_listings` does not end `gap`/`deep_pages_empty`/`rows_n:0` when pages return listing rows.
- AT-2 **Seal:** successful run → `sealed: true`, `origin: server`, `rows_n` ≥ 1 (prefer thousands).
- AT-3 **True GAP preserved:** a collapsed total still yields `gap` without seal (AT-4 of CR-080 unchanged).
- AT-4 **Negative:** no money routes; secrets never logged.

## Out of scope
- Setting `DYNADOT_CLOSEOUTS_PATH` (Gavriel: bots stay primary for closeouts for now).
- BUG-054 / BUG-056 lander parse.

## DVIR items
None.

## Evidence
Stamp in `DOM-TO-GAVRIEL.md` 2026-10-27 17:45 IDT; commit `a33a431`.

## BUILD NOW — Claude Code (Architect kickoff 2026-10-27 ~17:35 IDT)
Gavriel: Dvir does not kick off Claude Code; Architect drives this. **Build immediately.** Max 2 rounds. No money. No browser marketplace UI. Report when live on `/health`. Stamp `## DOM response` in this file + one line in `DOM-TO-GAVRIEL.md`.

Focus: dynadotAftermarket: stop returning gap/deep_pages_empty with rows_n=0 after hundreds of OK listing pages; seal real rows.

## DOM response

**Shipped in v5.68.0** (same commit as BUG-056).

**Root cause:** `pullAftermarket()` line 337: `if (emptyPages.length > 0) return gap('deep_pages_empty', false);` fired after ALL pages were fetched, discarding every collected row if ANY page returned an empty `listing_item_list`. With `total_listings: 473798` and `page_size: 1000`, there are ~474 pages. The Dynadot API returned an empty last page (normal pagination boundary: 473798 items don't fill page 474 evenly, or a timing issue), which triggered the GAP and threw away all ~473k rows.

**Fix:** removed the blanket empty-deep-page GAP after the fetch loop. Empty deep pages are now:
- Included in `coverage.pages_empty` and make `coverage.partial: true` (so the seal is `partial`, not `sealed`).
- The collected rows from non-empty pages are stored and sealed normally.
- The page-1 check stays: if page 1 itself returns `total > 0` but `raw_n === 0`, that's still `deep_pages_empty` GAP (the API is truly broken).
- The `no_rows_over_floor` check at the end catches the case where no rows pass the $500 floor even though pages had data.

**ATs covered:**
- AT-1 → DYN-7a: aftermarket with large total and rows on every page seals with `rows_n > 0`, never `deep_pages_empty`.
- AT-2 → DYN-7: page 1 has items but all deep pages empty → sealed as partial with `pages_empty`, not GAP.
- AT-3 → DYN-7b: true GAP preserved — page 1 has total > 0 but `raw_n` 0 still triggers `deep_pages_empty` GAP.
- AT-4 (no money): confirmed, no money routes touched.

**After ship:** re-run `datasave` `dynadotAftermarket` to seal real rows and unblock CR-080 day-1.


## Live recheck (2026-10-27 ~19:05 IDT, DOM Architect) — **PASS (sealed with rows)**
- Datasave `run_b775e654-85b2-48b4-b2a9-0b057b356cf2` on **5.68.0**: `dynadotAftermarket` **`sealed: true`**, `status: partial`, `rows_n: 377122`, `data_date: 2026-10-27`, `origin: server`, `pages_n: 461`, `calls_n: 465`, `pages_failed: [102,204,306,408]` (HTTP 500), **not** `gap`/`deep_pages_empty`/`rows_n:0`.
- AT-1/AT-2 live intent met. CR-080 aftermarket **day-1 of 3-day server-primary ok window = YES**.
