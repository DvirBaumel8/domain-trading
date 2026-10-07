> Status: Approved by Dvir 2026-10-07 23:51 IDT

# CR-015: acceptance findings on v2.14.0 (scout intake and the daily candidate list)
| Field | Value |
|---|---|
| CR id | CR-015 |
| From | Gavriel (acceptance tester), on behalf of Dvir |
| Date | 2026-10-07 23:55 IDT |
| Approved by Dvir | 2026-10-07 23:51 IDT, in chat, verbatim: "Yes, push the 6 findings (I-1 to I-6) to DOM" |
| Priority | P1 for I-1 (personal data stored from scout notes); P2 for I-2, I-3; questions I-4 to I-6 decide how the first real daily list reaches Dvir |
| Based on | Gavriel's acceptance run of live v2.14.0, 2026-10-07 23:47 to 23:55 IDT, API only. Tally: 17 pass, 1 fail, 9 waiting for the first nightly build, 2 not testable |

**Kind of change:** contract issues found in acceptance (I-1 to I-3), each with the behavior we expect and pass/fail tests, plus three questions (I-4 to I-6). How to fix each is DOM's choice. Route and field names are suggestions.

## Context: v2.14.0 results that need no change
- **`GET /candidates/daily` before a build:** 200, `entries: []`, `summary.not_built: true`, `record_freshness_days`. `limit` 1–25 (0 and 26 give 400). `date` must be a real YYYY-MM-DD.
- **`POST /candidates/intake`:**
  - schema errors give 422 with the path;
  - the documented removal reasons work: `DUPLICATE_IN_UPLOAD` (also case variants), `HAS_DIGIT`, `HAS_HYPHEN`, `NOT_COM`, `OWNED`, `TOO_MANY_WORDS`, `DOMAIN_INVALID`;
  - a replay with the same key returns the same answer (`replayed:ok`);
  - a resend from another source is a `duplicate` with `first_intake_id`;
  - a READ token gives 403, and a missing key gives 400.
- **Test intakes on record:** ids 4, 5 and 16 are accepted acceptance-test names (`mossystonepath.com`, `qaintakezulu.com`, `qaintakenotepii.com`). The other ids are removed and duplicate rows from the same tests. None of these names is a real candidate.

## 1. Findings, expected behavior and acceptance tests

### I-1 (medium): intake `note` and `source` accept personal data
- **Seen:**
  - `POST /candidates/intake` accepted `qaintakenotepii.com` (intake 16) with a `note` holding a made-up email address and a 10-digit phone number, and stored it.
  - The `GET /audit` row keeps the same text verbatim in `request`.
  - Other routes refuse an `@` in a note with 422 `NO_PII` (for example `/offers`, `/sold`, `/export/{venue}/uploaded`). Scout notes are a likely place for a seller's or registrant's contact details.
- **Expected:**
  - **R-1:** `note` and `source` on intake go through the same personal-data rule as `/offers` (an `@`, an email, a phone-shaped run of 9+ digits). A hit gives 422 `NO_PII`, with the index and field in `details`, and nothing in the upload is stored.
  - **R-2:** DOM states whether the already-stored note of intake 16 is cleaned. It holds made-up test data only.
- **Tests:**
  - **T15-1:** an intake whose `note` has an email gives 422 `NO_PII`, and no row is added.
  - **T15-2:** the same for a phone-shaped `note`, and for an `@` in `source`.
  - **T15-3:** a clean note is accepted as today.

### I-2 (low): the intake audit row shows a token id, not the token's name
- **Seen:** the contract says "The audit row names the token" (endpoints.md §`POST /candidates/intake`; CR-012 T12-18 "the audit row shows which scout sent each batch"). `GET /audit` rows for intake have `token_id` (4) and `scope` (`write`), but no name. The daily list does show `sources[].token_name`.
- **Expected (R-3):** `GET /audit` rows carry `token_name` (the admin-command name, never the secret). Alternatively, the contract says the row identifies the token by id and documents where the id-to-name mapping can be read.
- **Test (T15-4):** an intake by an intake-scope token named for a scout shows that name on its audit row.

### I-3 (low): wrong code wording for a bad comp count
- **Seen:**
  - The contract says intake `comps?` is "2–3, the `/buy` comps shape; a bad one is 422 `COMPS_INVALID`".
  - One comp gives 422 `VALIDATION_ERROR` (`names.0.comps`: too small).
  - A comp sold in the future gives 422 `COMPS_INVALID`.
- **Expected (R-4):** the contract names both codes: a count outside 2–3 gives `VALIDATION_ERROR`, and a bad comp gives `COMPS_INVALID`. Alternatively, the count becomes `COMPS_INVALID` too.
- **Test (T15-5):** the documented code matches the live answer for 1 comp, 4 comps and one future comp.

## 2. Questions for DOM

### I-4: getting an "almost ready" name onto the same day's list
- **Background:**
  - A domain record takes effect when a live run reads it ("a live screening run of the domain uses its newest fresh record").
  - `buildDailyList` runs once in the nightly `daily` job.
  - Gavriel records trademark and history results in the morning, for the names in `sections.almost_ready`.
- **Questions:**
  1. Does `buildDailyList` judge records at build time from `domain_records`, or only through what the screening run saw?
  2. After records are added, how does a name move from `almost_ready` to `entries` the same day? Today the only way we see is:
     - a new live run of each name (`POST /screening/runs`), then
     - a whole manual `POST /jobs/run {"job":"daily"}`.

     That reruns every daily step.
  3. Will DOM offer a narrower route, for example a WRITE `POST /candidates/daily/rebuild`, or a `tick` step that rescreens names whose records were just added and then rebuilds the day's list (keeping the first order and marking changes, as documented)?
- **Why it matters:** otherwise a name recorded in the morning reaches Dvir only on the next build, and a drop name may be gone by then.
- **Test we'd run (T15-6):** add both records for an `almost_ready` name, use the documented path, and the name appears in `entries` the same day with `changed_since_first`.

### I-5: issuing scout tokens
- **Background:** intake-scope tokens are made only by DOM's admin command, and no API route issues one (README §Who may call).
- **Questions:**
  1. How does DOM hand a new token's value to Gavriel without it appearing in the repo, a request file or chat? For example, a Render environment variable that Gavriel's tooling reads, or another secret channel DOM proposes.
  2. Will DOM create one token per scout on request (names: one per lane S2, S3, S4, S6, S7, plus one for the daily drop-list upload)? Will each carry an expiry announced in `DOM-TO-GAVRIEL.md`?
  3. Until then, is Gavriel's WRITE token the intended way to feed intake? In that case the scout is identified only by `source`.
- **Test we'd run (T15-7):** with an intake token, `POST /candidates/intake` and `POST /selection/drop-lists` work. Every other route, GETs included, gives 403 `SCOPE_FORBIDDEN`. The audit row names the scout.

### I-6: drop-list names in the nightly screening
- **Background:**
  - `intakeScreening` adds drop-list names due within 7 days after the intake names.
  - Tonight's run will include names from `sn-20261006-accept` (62 kept names, all expected to drop 2026-10-08).
- **Questions:**
  1. Which lane, and which lane plan, does a drop-list name get?
  2. Does the `upcoming` section need fresh `tm_us` and `history` records, or does it list names that passed every automatic check, with what is still missing?
  3. For a `pending_delete` name, is `availability` expected to be FAIL or UNKNOWN? Can such a name still reach `upcoming`?
  4. Of the names over the 30-a-day cap, a drop name that drops before its turn: is it dropped from the queue, and is it counted in the run summary?
- **Test we'd run (T15-8):** the first nightly build shows drop names in `upcoming` with their lane and what is missing, and `steps.intakeScreening` counts the names left waiting.

## 3. Open questions for DOM
1. Which tests in §1 does DOM expect to meet, and does it push back on any, with the reason?
2. Answers to I-4, I-5 and I-6.

<!-- DOM writes below this line -->
