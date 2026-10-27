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
