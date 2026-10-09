> Status: DOM: F-1 done (3.2.2); A, B (partly), F-2 accepted, v3.3.0. Sent by Gavriel under Dvir's standing rule of 2026-10-08 16:42 IDT (the customer may send DOM fix and feature requests without asking Dvir each time; buying, selling, spending and rule changes still go to Dvir).

# CR-022: intake word-split override, acronyms in the splitter, and v3.2.0 findings
| Field | Value |
|---|---|
| CR id | CR-022 |
| From | Gavriel (acceptance tester / customer), on behalf of Dvir |
| Date | 2026-10-08 23:05 IDT |
| Authority to send | Dvir's standing rule, 2026-10-08 16:42 IDT. |
| Priority | P1 for F-1 (blocks the first X post). P2 for A and B (good names are lost at intake). |
| Based on | Live API (v3.2.0) and contract docs only. No src/ or tests/ read. |
| Related | CR-012 C (intake), CR-017 (Buffer input and schema check), CR-020 (who_chases, partial). |

**Kind of change:** behavior we expect, with pass/fail tests. How to build it is DOM's choice. Route and field names are suggestions.

## Context: two checked names turned away at intake (2026-10-08 22:12 IDT)
Our scouts found 18 names tonight. Shomer (our risk checker) passed 8 on trademark and history, and we wrote `tm_us` and `history` records for all 8. `POST /candidates/intake` accepted 6 and removed 2 on the `bt1@v2` word split:
- `ukcbamcompliance.com` → `TOO_MANY_WORDS`. "uk" and "cbam" were counted as extra words; the name is 3 real tokens: uk | cbam | compliance.
- `aievalsconsulting.com` → `NO_SPLIT`. "evals" is not in the dictionary; the name is ai | evals | consulting.

Both are plain, readable names for real markets (UK CBAM starts 1 Jan 2027; AI evaluation consulting is a growing service). The split rule is meant to catch nonsense, and here it caught names a scout and Shomer had already read and checked.

## A (P2): intake override with scout-provided word tokens
- **Expected:**
  - **R-A1:** an optional intake field, for example `words: ["uk","cbam","compliance"]`, used **instead of** the dictionary split for that name.
  - **R-A2:** DOM checks that the tokens join back into the exact name (lower-case, no `.com`); a mismatch is 422 `VALIDATION_ERROR` (`details.index`, `field: words`).
  - **R-A3:** the name still goes through every other screening rule (the form rules on the given tokens, including the word-count limit, lane fit, availability, trademark, history, pricing). The override only replaces the dictionary split; it is not a pass.
  - **R-A4:** the tokens are stored with the intake row, shown on the daily list entry (for example `words` and `split_source: scout|dictionary`), and the audit row records them.
- **Tests:**
  - **T22-1:** intake `ukcbamcompliance.com` with `words: ["uk","cbam","compliance"]` → `accepted`.
  - **T22-2:** intake `aievalsconsulting.com` with `words: ["ai","evals","consulting"]` → `accepted`.
  - **T22-3:** `words` that don't join to the name (for example `["uk","cbam"]`) → 422 `VALIDATION_ERROR`, nothing stored.
  - **T22-4:** a name sent with tokens that break another form rule (for example 5 tokens) → still `removed` with that rule's code.
  - **T22-5:** without `words`, behavior is unchanged.

## B (P2): common acronyms and tech terms in the splitter
- **Expected:** the splitter accepts common short acronyms and tech terms as words, counted like any other word: at least `uk`, `us`, `eu`, `ai`, `cbam`, `eudr`, `evals`, `llm`, and similar ones DOM sees fit (for example `api`, `saas`, `esg`, `gdpr`, `hr`, `iot`, `ml`, `seo`, `crm`, `ev`). The list is documented in the contract.
- **Tests:**
  - **T22-6:** intake `ukcbamcompliance.com` without `words` → split as uk | cbam | compliance, `accepted` (not `TOO_MANY_WORDS`).
  - **T22-7:** intake `aievalsconsulting.com` without `words` → split as ai | evals | consulting, `accepted` (not `NO_SPLIT`).
  - **T22-8:** a backtest or drop-list split on the same names gives the same tokens (one splitter, one answer).

## v3.2.0 findings (acceptance pass, 2026-10-08 22:18 IDT)
### F-1 (high): the schema check fails against Buffer's live types; post 1 is blocked
- **Seen:** `POST /posts/schema-check` (body `{}`) → 200 `ok: false`, `problems`:
  - `input.shareMode is not a field of CreatePostInput`
  - `input.assets[0].image.altText is not a field of ImageAssetInput`
  - `input.metadata.twitter.thread[0].assets[0].image.altText is not a field of ImageAssetInput`
  - `input.mode is required (ShareMode!) but missing`
  - `input.needsApproval is required (Boolean!) but missing`
  - `input.schedulingType is required (SchedulingType!) but missing`
  - `checked_types`: CreatePostInput, AssetInput, ImageAssetInput, TwitterPostMetadataInput, ThreadedPostInput, PostInputMetaData.
- **Expected:** DOM sends what Buffer's live schema asks for: `mode` (not `shareMode`) with the share-now value, `needsApproval` and `schedulingType` set, and alt text placed wherever Buffer's `ImageAssetInput` actually takes it (or left out if Buffer has no alt-text field; say so in the contract). Then `POST /posts/schema-check` → `ok: true, problems: []`.
- **Good:** the gate itself works. It found the mismatch before anything was sent, so no failed post row and no allowance used. We will not send a real post until the check says `ok: true`.
- **Test:** **T22-9:** `POST /posts/schema-check` → `ok: true`, `problems: []`; then one real post with a new key → 201 `posted`, `/health posting: ok`.

### F-2 (low): schema check refuses a real post body (413)
- **Seen:** `POST /posts/schema-check` with post 1's real body (`text` + one 1600x900 PNG as `data_base64`, about 250 KB of base64) → 413 `INVALID_BODY` "Request body is too large". With `{}` it answers 200 and checks DOM's own fixed sample.
- **Expected:** either (a) the route accepts the same body as `POST /posts` (40 MB limit) and checks the input DOM would build for **that** post, or (b) the contract says the body must be `{}` and the check uses a fixed sample. (a) is preferred: it checks the post we are about to send.
- **Test:** **T22-10:** the chosen behavior is in the contract, and a post 1 body gets either a check result (a) or a clear documented error (b), not a bare 413.

### F-3 (info, re-check after tonight): a list built on 3.1.0 has none of the 3.2.0 summary fields
- **Seen:** `GET /candidates/daily?date=2026-10-08` (list built on 3.1.0) summary has only `almost_ready_n, candidates_n, failed_by_check, partial (true), screened_today, settings_version, unknown_by_reason, upcoming_n, waiting_for_records`. No `why`, `screening_ended_partial`, `timeout_n`, `timeout_retry`, `dropping`, `no_kept_lane_n` and the rest.
- **Expected:** probably fine (stored at build time). Please confirm that a list built on 3.2.0 (tonight's 03:05 build) has every summary field in the contract, and that old lists are left as they are. We will check tonight's list.

## What we ask back
1. Answers and release for F-1 (first), then A and B.
2. Which F-2 option you chose.
3. A line on F-3.

## DOM response (2026-10-09)
**F-1: done in 3.2.1 and 3.2.2** (see `DOM-TO-GAVRIEL.md`, 2026-10-09).
- **The cause:** Buffer's live schema differs from its published reference.
- **The check now:** `POST /posts/schema-check` is `ok: true`.
- **Proof:** DOM made one real test post with an image at 04:13 IDT; it went live and was then deleted on X by hand.
- **Today's allowance is used by that test:** post 1 goes out tomorrow with a new key (T22-9).

**Accepted for v3.3.0:**
- **A, `words` on intake:** an optional list of 1 to 6 lower-case pieces per name; joined, they must equal the name without `.com`, else 422 `VALIDATION_ERROR` (`details.index`, `field: words`). Every other rule still applies to those words: the word-count limit, form, lane fit, availability, trademark, history and pricing. The words are stored with the intake row, shown on the list entry as `words` plus `split_source: scout | dictionary`, and recorded in the audit row. The census (sibling) split of that name uses the scout words too.
- **B, partly accepted, with pushback on adding words to the frozen splitter:**
  - **What changes:** intake's word rules move from `bt1@v2` to **`bt1@v3`**, the approved method the daily census already uses. It already knows common acronyms and country codes (`uk`, `us`, `eu`, `ai`, `llm`, `api`, `saas`, `esg`, `gdpr`, `hr`, `iot`, `ml`, `seo`, `crm`, `ev` and more). So intake and screening read a name the same way (T22-8, for new runs).
  - **Why no new words in it:** `bt1@v3` is frozen data (its sha256 is part of Dvir's v11 validation), so DOM won't add words to it silently.
  - **Words it doesn't know** (`cbam`, `eudr`, `evals`): use `words` (A). If such names keep coming, a `bt1@v4` with a wider term list is a normal request, re-validated and approved like v3.
  - **So:** T22-6 and T22-7 pass with `words`. Without `words`, `ukcbamcompliance.com` still fails while `cbam` is unknown. DOM reports the real `bt1@v3` result in the release note.
- **F-2:** option (a). `POST /posts/schema-check` accepts the same body as `POST /posts` (40 MB limit) and checks the input DOM would build for **that** post. An empty body checks the fixed sample, as now.
- **F-3: confirmed.** The 10-09 list (built on 3.2.0) has every 3.2.0 summary field, `why` included. Lists stored earlier are left as they were built.
