> Status: Approved by Dvir 2026-10-07 23:45 IDT

# CR-014: acceptance findings on v2.13.0 (domain records, unknowns, approval lines)
| Field | Value |
|---|---|
| CR id | CR-014 |
| From | Gavriel (acceptance tester), on behalf of Dvir |
| Date | 2026-10-07 23:50 IDT |
| Approved by Dvir | 2026-10-07 23:45 IDT, in chat, verbatim: "Push the 4 new 2.13.0 findings (N-1 to N-4) to DOM" |
| Priority | P1 for N-1 (a trademark record without evidence can let a name pass for 30 days); P2 for N-2 to N-4 |
| Based on | Gavriel's acceptance run of live v2.13.0, 2026-10-07 23:38 to 23:46 IDT, API only. Tally: 20 pass, 2 fail, 3 not testable |

**Kind of change:** contract issues found in acceptance, each with the behavior we expect and pass/fail tests. How to fix each is DOM's choice. Route and field names are suggestions.

## Context: v2.13.0 results that need no change
- **The `-D` rescore passes.** Gavriel reran it with the identical body as `R15-T15-V3-NOW-E`: sold accepted 314/400 = 78.5%, dropped rejected 374/494 = 75.7%, 2.26 minutes. The result matches `-D` exactly.
- **The rest works as documented:** the gap rescore (`R15-T15-GAPS-C`, gaps 11 → 3), the buy-hold `steps`, and record reuse in live runs (`fields.domain_record_id`).
- **Dvir's lines, recorded by Gavriel at 2026-10-07 23:46 IDT:**
  - `POST /selection/sibling-methods/bt1@v3/approve`, with Dvir's line "I approve the word-splitting method bt1@v3";
  - `POST /selection/settings/v11/activate`, with "I approve activating selection settings v11; the buy hold stays on".
  - The buy hold stays on.

## 1. Findings, expected behavior and acceptance tests

### N-1 (medium): a domain trademark record is accepted without evidence
- **Seen:**
  - `POST /candidates/qarecordtestzulu.com/records` with `kind: tm_us`, no `evidence_url`, and `phrases_queried: ["X"]` returned 201 (record id 3, a PASS).
  - The manual route `POST /screening/runs/{id}/manual` requires `evidence_url` for `tm_us`.
  - A domain record is reused by every live run of the domain for 30 days, so an unsupported PASS on a real candidate would carry through the daily list.
  - Gavriel neutralized the test record with a newer FAIL record (id 4) on that test name.
- **Expected:**
  - **R-1:** a `tm_us` domain record needs `evidence_url` (https), as the manual route does. Without one: 422 `VALIDATION_ERROR`.
  - **R-2 (suggested):** `phrases_queried` must contain the domain's exact phrase (the SLD, compared uppercase without punctuation, the same way `PRIOR_NAME_NOT_QUERIED` compares phrases). Otherwise: 422 with the missing phrase.
- **Tests:**
  - **T14-1:** a `tm_us` record without `evidence_url` → 422.
  - **T14-2:** a `tm_us` record whose phrases don't include the domain's phrase → 422 (if R-2 is built).
  - **T14-3:** a valid record → 201, reused by a live run as today.

### N-2 (low): record freshness counts from the POST time, not from when the search was done
- **Seen:** the records route takes no `checked_at`. `checked_at` and `fresh_until` are the POST time, plus 30 days for `tm_us` and 180 days for `history`. A search done a day before it is recorded looks a day fresher than it is.
- **Expected:**
  - **R-3:** the route accepts an optional `checked_at` (ISO with offset; not in the future; inside the record kind's freshness window), as `POST /screening/runs/{id}/manual` does.
  - `fresh_until` is counted from it, and an older `checked_at` → 422 `CHECKED_AT_INVALID`.
- **Tests:**
  - **T14-4:** a record with `checked_at` 2 days ago shows `fresh_until` = `checked_at` + 30 days.
  - **T14-5:** a `checked_at` 31 days ago for `tm_us` → 422.
  - **T14-6:** a record that turns stale counts as missing, so a live run shows `tm_us` MANUAL_REQUIRED (testable once T14-4 exists).

### N-3 (low): `unknowns` leaves out an undecided name, and shows no pieces
- **Seen (a):**
  - `-D` (and `-E`) has 1 undecided **sold** name, but all 3 `unknowns` entries (`cryvonlabs`, `spotifyheadstart`, `uberfrance`) are dropped names. The gap set `R15-T15-GAPS-C` reports sold n 0, dropped n 11.
  - So the undecided sold name is not explained anywhere. CR-012 T12-2 asks for every name "that is undecided or has unknown features".
  - DOM's CR-012 answer also described the 11 as "the 9 undecided dropped names, plus 1 sold and 1 more", which the gap set contradicts.
- **Seen (b):** `CENSUS_LIST_SIZE` entries show `detail: {tokens: [], size: 0}`, so the pieces that had no reading are not visible.
- **Expected:**
  - **R-4:** `unknowns` (or a sibling field such as `undecided`) lists every undecided name with the reason it is undecided, even when no feature is unknown.
  - **R-5:** a `CENSUS_LIST_SIZE` entry shows the unread part of the name, for example `unread: "cryvon"`, or the best partial split.
  - DOM also corrects the CR-012 note about which names the 11 were.
- **Tests:**
  - **T14-7:** `GET /selection/test-sets/R15-T15-V3-NOW-D` names the undecided sold name and its reason.
  - **T14-8:** the `cryvonlabs` entry shows a non-empty unread part.

### N-4 (process): DOM wrote ready-made approval lines in quotes
- **Seen:** DOM's CR-009 and CR-012 notes of 2026-10-07 22:46 IDT give Dvir lines in quotes to approve with ("sibling method bt1@v3 approved"; "selection settings v11 approved for activation; buy hold stays on").
- **The rule:** CR-012 §1, accepted by DOM, says: "DOM never writes approval text in Dvir's name, and never offers a pre-filled approval line; an approval is valid only as Dvir's own words".
- **This time:** Dvir wrote his own lines (quoted above), so nothing went wrong.
- **Expected (R-6):** DOM's notes state **what a line must name** (for example: the method `bt1@v3` and the word "approve"; the label `v11`; "clears hold" and the suite id), and never a sentence to copy.
- **Test (T14-9):** the next DOM note that asks for a Dvir decision states the required elements, with no quoted ready-made line.

## 2. Open questions for DOM
1. For N-1, will DOM also check the domain's exact phrase (R-2)?
2. For N-3, which name is the undecided sold name in `-D`, and why is it undecided?
3. Which tests in §1 does DOM expect to meet, and does it push back on any, with the reason?

<!-- DOM writes below this line -->
