# CR-010: make registration-heavy test runs fast (target: under 15 minutes)

- **From:** Gavriel (acceptance tester), on Dvir's behalf.
- **Status:** DOM: accepted with changes (2026-10-07); release v2.7.0. APPROVED by Dvir 2026-10-07 16:37 IDT, in chat, verbatim: "ask DOM to make it shorter and suggest him the 3 items you raised."
- **Does not block CR-009.** Please start the `bt1@v2` rescore of `R15-TEST15-USED` as planned. This request is for every run after it.
- **Kind of change:** a business need with input/output targets. The three ideas in §3 are suggestions; how to get there is DOM's choice.

## 1. Business need
CR-009 says the `bt1@v2` rescore of the 894 TEST15 fixtures takes about 6 hours of paced lookups. That is 894 names times about 20 siblings, so about 18,000 single registration questions to the .com registry, sent slowly so the registry does not block DOM.

This is not a one-time cost. The same kind of run comes back:
- every time a selection setting or a sibling method changes (a new rule version, a new method version, a new test set);
- in the weekly forward test (CR-007);
- whenever Gavriel reruns a replay through the API to accept a release (T9-8 and similar).

Six hours per run slows every rule change to one try a day. Dvir wants the loop to be fast, so each improvement can be tested and accepted the same hour.

## 2. Required outcome (acceptance tests)
- **T10-1 (rerun):** a second `rescore` of `R15-TEST15-USED` on `v11` with `bt1@v2` and `features_as_of: "now"`, started within 7 days of the first, finishes in **under 15 minutes** from start to `done`, with the same decisions as the first run except names whose registration really changed.
- **T10-2 (changed method):** a rescore with a method version that changes the split of at most 10% of names finishes in **under 15 minutes**. Only the siblings that are new should need fresh answers.
- **T10-3 (first run on a new set):** DOM states in its reply the fastest time it can reach for a set of about 900 names with no prior answers, and what (if anything) Dvir must provide to reach under 15 minutes. Dvir decides.
- **T10-4 (honest data):** every registration answer used in a run shows where it came from and when it was read (for example `source` and `checked_at`), and the run reports how many answers were fresh and how many were reused. A run can be told the oldest answer it may reuse (for example a maximum age in days), and the default is documented.
- **T10-5 (correct dates):** reusing answers never breaks `features_as_of`. A run that asks for registration as of a past date never uses an answer read for a later date as if it were older, and the reverse.
- **T10-6 (live screening unchanged):** screening one real name still gives a census answer in seconds, and its answers may feed the same store.
- **T10-7 (registry safety):** no run gets DOM rate-limited or blocked by a registry. If a source refuses, the run says so (as UNKNOWN with a reason) instead of slowing silently.

## 3. Three suggestions (DOM chooses)
1. **Reuse answers.** Keep every registration lookup with its date and reuse it for a set time (for example 7 days). Most of the 18,000 siblings in the `bt1@v2` rescore will already have been asked once by tonight, and only about 5% of splits changed from `bt1@v1`, so a rerun would be mostly reused answers.
2. **Ask in parallel.** Send several lookups at once, up to what each registry allows, instead of one at a time. Several sources may also be used side by side (for example Verisign RDAP plus a second source), if their terms allow it.
3. **Use the full .com list.** Verisign publishes a daily file of every registered .com name through ICANN's Centralized Zone Data Service (CZDS), free with an approved account. With a local copy, 18,000 checks take seconds and send no questions. DOM dropped CZDS in CR-007; please say whether it is still the right answer here, whether its terms allow this use, and exactly what Dvir would need to do (account, approval time). Past-date answers would need the daily files kept from the day collection starts, so this does not help replays of older dates by itself.

## 4. Please answer
- Which of the three (or something else) DOM picks, and which tests in §2 it expects to meet.
- The time DOM expects for T10-1, T10-2 and T10-3.
- Whether Dvir needs to do anything (for example open a CZDS account).

<!-- DOM writes below this line -->
## DOM response (2026-10-07)
**Verdict: accepted with changes.**
- **Picked:** suggestion 1 (reuse answers), which already half exists, completed and made visible, and a careful version of suggestion 2 (parallel lookups with automatic slow-down).
- **Not picked:** suggestion 3 (CZDS), for the reason below.
- **Release:** v2.7.0, before CR-007's drop list and forward test (those move to v2.8.0).
- **The `bt1@v2` rescore** of `R15-TEST15-USED` was started at 16:4x IDT (`R15-T15-V2-NOW`, run `run_823a67a9…`). DOM polls it and reports in CR-009.

### What exists today
- **Every registry answer is stored** (`rdap_lookups`: the answer, the facts, `checked_at`, an evidence row).
- **Reuse:** the census and `ext_dates` reuse an answer for `freshness_hours.census` (720 hours in the active v1, 168 in `v11`).
- **Cost of a rerun:** only the time to read the stored answers.
- **Shared store:** the stored answers already feed live screening too (T10-6).
- **Why the first run is slow:** the 18,000 sibling lookups are new, and they are paced at 1 per second (`run.rdap_concurrency` 1, `run.rdap_min_ms_between` 1000), about 5 hours.

### v2.7.0
1. **Provenance (T10-4).**
   - **Per sibling:** each census sibling and each extension in `ext_dates` shows `checked_at` and `reused: true|false`.
   - **Per run:** the test set's `GET` reports `lookups: {fresh, reused, unknown}`.
   - **Age limit:** a test set takes `max_answer_age_days` (default **7**; 0 = always ask again).
2. **Date safety (T10-5).**
   - **Rule:** an answer may be reused for a name's `as_of` only if it was read **on or after** that `as_of` and within the age limit.
   - **Why this direction is safe:** a newer answer is safe for an older date, because the creation date shows whether the sibling already existed. An answer read before the date could miss a sibling registered in between, so it is never reused.
   - **For `features_as_of: "now"`:** this means "within the age limit".
3. **Faster fresh lookups (T10-7).**
   - **Concurrency:** test-set runs ask Verisign RDAP **4 at a time**, at least 250 ms apart: about 4 per second instead of 1.
   - **Automatic slow-down:** on a 429 or a refusal, the run halves its rate, honours `Retry-After`, and records it (`lookups.rate_limited`).
   - **Never a silent answer:** a lookup that still fails is UNKNOWN `RATE_LIMITED` / `SOURCE_ERROR`, never "not registered".
   - **Unchanged:** live screening keeps its own pacing.
   - **Why not faster:** Verisign publishes no rate for RDAP, so DOM stays well under anything that looks like abuse.
4. **Timing in the report:** each test set's `GET` shows `started_at`, `finished_at` and the minutes taken, so T10-1 and T10-2 can be read directly.

### Expected times (to be measured and written in the v2.7.0 release note)
| Test | Expected |
|---|---|
| **T10-1** (rerun within 7 days) | **A few minutes.** Every sibling is already stored, so there are no registry calls, only database reads. **Meets < 15 min.** |
| **T10-2** (≤ 10% of splits changed) | About 10% of 18,000 = ≤ 1,800 new siblings at about 4 per second ≈ **8 minutes** plus the reads. **Meets < 15 min.** |
| **T10-3** (about 900 new names, nothing stored) | About 18,000 lookups at about 4 per second ≈ **75 minutes** (5 hours today). **Under 15 minutes is not reachable safely through RDAP.** |

### Suggestion 3 (CZDS): still not the right answer, for the census
- **It measures a different thing.** The zone file lists names **published in DNS**, not names **registered**. A registered name on hold, or with no nameservers, is registered but not in the zone. RDAP, which the research and v11's cut-off used, counts it as registered. Using the zone would quietly lower every share, and the 0.55 cut-off was never tested on that measure.
- **It has no dates.** It can't answer `features_as_of: "row"` (creation dates), as you note.
- **What Dvir would need, if wanted later:**
  - an account at czds.icann.org and a request for `.com`, which Verisign approves, typically in days to weeks;
  - two Render secrets (`CZDS_USERNAME`, `CZDS_PASSWORD`).
- **Cost and terms:** streaming the file daily could fit $0. DOM would review the terms before building.
- **Possible later use:** it may fit the drop list (CR-007 G-2 source B) better than the census.
- **DVIR:** nothing needed now. T10-3 stays at about 75 minutes unless Dvir accepts the zone's different measure, which DOM does not recommend.
