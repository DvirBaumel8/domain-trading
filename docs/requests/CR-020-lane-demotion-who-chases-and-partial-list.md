> Status: Sent by Gavriel under Dvir's standing rule of 2026-10-08 16:42 IDT (customer may send DOM fix and feature requests without asking Dvir each time; buying, selling, spending, and rule changes still go to Dvir). The lane change itself was approved by Dvir on 2026-10-08 17:45 IDT (below).

# CR-020: demote drop-list names, add a "who chases this" field, fix the daily list that stays "partial"
| Field | Value |
|---|---|
| CR id | CR-020 |
| From | Gavriel (acceptance tester / customer), on behalf of Dvir |
| Date | 2026-10-08 ~18:00 IDT |
| Dvir's decision | 2026-10-08 17:45 IDT, in chat, verbatim: **"Yes, apply the keep/narrow/drop changes, demote expiring names, and add the 'who chases this' line"**. Guiding principle behind it (Dvir, 17:43 IDT): we can't beat professional, well-funded systems, so we compete only where they chose not to or can't. |
| Authority to send | Dvir's standing rule, 2026-10-08 16:42 IDT. |
| Priority | P1 for A (drop-list names crowd out scout names in the 30-a-day budget) and C (the list's `partial` flag is wrong after a rebuild). P2 for B (new optional field). P2 for D (make the main-lane set a setting; no value change without Dvir). |
| Based on | Live API 2026-10-08 and contract docs only (`jobs.md` daily row, `endpoints.md` §Intake, §`GET /candidates/daily`, §Tranches; `selection.md`). No src/ or tests/ read. |
| Relation to CR-019 | **Amends CR-019 C-4 ("leftovers first").** Leftovers still come first among drop-list names, but a drop-list name now enters screening only if it fits a kept lane (A below). C-1 to C-3 stay as asked. Part B (backorders) stays on hold. |

**Kind of change:** behavior we expect, with pass/fail tests. How to build it is DOM's choice. Field and key names are suggestions.

## Our new lane rules, for context (no DOM change needed for this part)
| Lane | Verdict |
|---|---|
| S2 geo city + trade | Narrow: 2-word city + trade only |
| S3 trending tech terms | Narrow: "term + B2B service" names, never a trend's bare head term |
| S4 new tech meets an old industry | Keep |
| S5 next-buzzword prediction | Watchlist only (no intake) |
| S6 new regulations | Keep |
| S7 dropped leftovers | **Demoted:** no longer the main lane; a dropped name counts only if it fits S2, S4 or S6 |

## A (P1): drop-list names enter screening only when they fit S2, S4 or S6, and after scout names
- **Seen (2026-10-08):** the daily `intakeScreening` filled its 30-name budget with drop-list names. 27 were already re-registered, 1 failed form, 2 timed out. No scout names were in the run. Today's list had 0 candidates.
- **Expected:**
  - **R-A1:** a drop-list name is admitted to `intakeScreening` only if its `form` result fits a kept lane. Our suggested mapping, using the `form` token types DOM already returns:
    - S2: a `city` token plus a `trade` token, and G-FORM-1 passes (2 tokens, SLD ≤16);
    - S4: a `tech` token plus a `trade` or sector word;
    - S6: a `regime` token.
    DOM may refine the mapping; please document it. Names that fit none are kept on the drop list (for our idea mining) but not screened, with a reason such as `NO_KEPT_LANE`.
  - **R-A2:** an admitted drop-list name is screened under the matched lane (S2, S4 or S6), not as plain S7, and keeps `source: drop_list` so we can see where it came from.
  - **R-A3:** in the 30-a-day budget, **scout intake names go first** (oldest first, as now), and drop-list names only fill what is left. Optionally a settings key caps their share (for example `intake.drop_list_max_share`, default 0.3). A new settings key goes into a draft only; activation is Dvir's.
  - **R-A4:** the daily list `summary` shows how many drop-list names were skipped for `NO_KEPT_LANE`, so an empty list can say so (ties into CR-018 B).
- **Tests:**
  - **T20-1:** upload a drop list with `phoenixroofing.com`-shaped (city + trade), `restaurantvoiceagent.com`-shaped (tech + sector), `cbamdeclarants.com`-shaped (regime) and three generic names. After the next daily run only the first three are screened, each with its matched lane; the generic three show `NO_KEPT_LANE` on `GET /selection/drop-lists/{name}`.
  - **T20-2:** with 30 scout names waiting and 30 eligible drop-list names, the run screens the 30 scout names (or, with the share key set to 0.3, 21 scout + 9 drop-list).
  - **T20-3:** `summary` on `GET /candidates/daily` reports the `NO_KEPT_LANE` count.

## B (P2): optional `who_chases` text on intake, shown on the daily list
- **Why:** Dvir's new rule says every candidate carries one line: who already chases this kind of name at scale, and why they won't take this one. Today we have to squeeze it into `note`.
- **Expected:**
  - **R-B1:** `POST /candidates/intake` accepts an optional `who_chases` string per name (≤300 characters, same `NO_PII` rule as `note`). Missing is allowed.
  - **R-B2:** it is stored with the intake row and shown on the daily list entry (for example `entry.who_chases`, from the newest intake of that name), and on `almost_ready` / `upcoming` rows.
  - **R-B3:** it never affects scoring or gates. It is information for Dvir's daily message.
- **Tests:**
  - **T20-4:** intake with `who_chases: "Bulk investors chase AI + word brandables; nobody researches restaurant voice-agent vendors for an $11 name."` is accepted and appears on that name's daily list entry after it passes.
  - **T20-5:** `who_chases` with an email address → 422 `NO_PII`, nothing stored. 301 characters → 422 `VALIDATION_ERROR`.
  - **T20-6:** intake without `who_chases` still works exactly as today.

## C (P1): the daily list says `partial: true` even after a rebuild
- **Seen (2026-10-08):**
  - The day's screening run was finished at 09:13:11 IDT; the list was built at 09:13:12 with `partial: true`.
  - `POST /candidates/daily/rebuild` at 16:46 IDT gave list `version: 2`, `built_at 2026-10-08T16:46:02+03:00`, still `summary.partial: true`, with `screened_today: 30`, `candidates_n: 0`, `failed_by_check: {form: 1, availability: 27}`, `unknown_by_reason: {TIMEOUT: 2}`.
  - The contract says `partial` means "the day's screening run was still running after 20 minutes". At 16:46 nothing was still running, so the flag looks wrong. It may be carrying the run's own `partial` status (deadline reached with 2 `TIMEOUT` names) under the same word.
- **Expected:**
  - **R-C1:** a rebuild re-reads the run's state. If no screening run is still running, the list's `partial` is `false`.
  - **R-C2:** if the run itself ended `partial` (time budget reached, `TIMEOUT` names), say that with a separate, plainly named field, for example `summary.screening_ended_partial: true` with the count of names left `TIMEOUT`. Please don't reuse `partial` for two meanings.
  - **R-C3:** the contract text for `summary.partial` matches the behavior.
- **Tests:**
  - **T20-7:** after a run that finished within 20 minutes and a rebuild, `summary.partial` is `false`.
  - **T20-8:** after a run that hit its deadline with N names `TIMEOUT`, the list shows the new field as true with N, and `partial` follows R-C1.
  - **T20-9:** today's list (2026-10-08), after a rebuild on the fixed version, no longer shows `partial: true` (or DOM explains why it should).

## D (P2): let settings say which lanes count as "main lane" (no value change without Dvir)
- **Seen:** active settings `v11` have `tranche.min_main_lane: 10` of `size: 15`, and the contract counts a member as main lane only when it is S7 with a clean history or S3 passing DEMAND-2. Under the new lanes, S4 and S6 names (both kept) never count, so a full tranche of them could not close (409 `MAIN_LANE_QUOTA`, no waiver).
- **Expected:**
  - **R-D1:** add a settings key, for example `tranche.main_lanes` (a list of lane ids, each with its condition), whose **default reproduces today's behavior exactly** (S7 clean history, S3 DEMAND-2). The active settings must not change as a side effect of this release.
  - **R-D2:** a draft may set `tranche.main_lanes` and/or `tranche.min_main_lane` (0 allowed). Activating such a draft follows the normal rule: Dvir's own line naming the draft.
- **Tests:**
  - **T20-10:** after deploy, `GET /selection/settings` shows `v11` still active with identical values, plus the new key at its default; the tranche tests for 9 vs 10 main-lane members behave as before.
  - **T20-11:** a draft with `tranche.min_main_lane: 0` can be created and replayed; creating it activates nothing.

## What we need back
1. Answers on A (the lane mapping you will use, and whether you add the share key), C (what `partial` was measuring today) and D (key shape).
2. Which of R-A1 to R-D2 you expect to meet, and any you push back on, with the reason.
3. The release version and its caller-visible change list, as before.
