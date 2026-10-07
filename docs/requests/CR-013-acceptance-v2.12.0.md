> Status: Approved by Dvir 2026-10-07 23:37 IDT

# CR-013: acceptance findings on v2.8.0 to v2.12.0 (review packet, block list, retries, posting docs)
| Field | Value |
|---|---|
| CR id | CR-013 |
| From | Gavriel (acceptance tester), on behalf of Dvir |
| Date | 2026-10-07 23:40 IDT |
| Approved by Dvir | 2026-10-07 23:37 IDT, in chat, verbatim: "Yes, push the 11 findings to DOM" |
| Priority | P1 for F-1, F-2, F-3 (the daily outside review must reach Google with the company document, and the bot names must be blockable before the first X post); P2 for the rest |
| Based on | Gavriel's acceptance run of live v2.12.0, 2026-10-07 22:05 to 22:35 IDT, API only. Tally: 43 pass, 5 fail, 3 partial, 5 not testable yet (they need a real post or a later date), 1 blocked (paid tier needs Dvir), 4 observations |

**Kind of change:** contract issues found in acceptance, each with the behavior we expect and pass/fail tests. How to fix each is DOM's choice. Route and field names below are suggestions.

## 1. Business need
- **The daily outside review must see the company document.** Today one failed Google call can leave every review for a week without it (F-1). Google's free tier often answers 503 "high demand", and DOM doesn't retry that (F-3).
- **Bot names must never reach the reviewer or X.** Today the name "Gavriel" can't go on the block list: DOM's own packet contains it, so every review would be refused (F-2).
- **The rest are smaller gaps between the contract and the live API.** They make tests and bots unreliable (F-4 to F-11).

## 2. Findings, expected behavior and acceptance tests

### F-1 (high): a failed review uses up the weekly or first packet
- **Seen:**
  - Manual run 1 (`POST /reviews/run`, 22:09 IDT) built packet `rvp_8e21df9fbee0`: `kind: weekly`, document v1 with its full text. Google answered HTTP 503, and DOM stored `unknown` feedback.
  - Manual run 2 (22:12) built `rvp_a25faf283e56`: `kind: daily`, `document.text: null`, and no diff (the document hadn't changed).
  - So from then until the next weekly packet, every review reaches Google without the company document. The first one is tonight's 03:05 IDT run.
- **Contract text:**
  - endpoints.md says the packet carries the document "in full on a weekly packet or the first one, else null". It also says `kind` is `weekly` "when no weekly packet exists from the last 7 days".
  - jobs.md says "`weekly` on Sunday or when no weekly review is 7 or more days old".
  - The two rules differ.
- **Expected:**
  - **R-1:** a packet whose feedback is `unknown`, or that has no feedback, never counts as the weekly packet or as "the first one". The next review sends the full document again, until a review with `status: ok` has received it.
  - **R-2:** one rule decides weekly vs daily, and endpoints.md and jobs.md state the same rule.
- **Tests:**
  - **T13-1:** with a weekly packet whose feedback is `unknown`, the next `POST /reviews/packet {preview: true}` is `weekly` (or carries `document.text` in full).
  - **T13-2:** after a review with `status: ok` on a weekly packet, the next packet that day is `daily` with `text: null`.
  - **T13-3:** both docs state the same weekly rule.

### F-2 (high): DOM's packet contains a bot name, so that name can't be blocked
- **Seen:**
  - The packet's `numbers` include a tranche with `"opened_by": "gavriel"`.
  - Forbidden-term matching is case-insensitive and whole-word (measured, F-8). Adding the term "Gavriel" would therefore refuse every packet (`TEXT_BLOCKED`), and the daily review would stop.
  - There is no route to remove or retire a term, so a term that breaks the review can't be undone.
  - We added the other 9 bot names, but not "Gavriel". So today "Gavriel" passes the block list on `POST /posts`.
- **Expected:** after the fix, Gavriel can add the term "Gavriel", and the review still runs. Either of these two (or both) is acceptable:
  - **R-3 (preferred):** packets and anything else DOM writes on its own leave out actor and token ids (`opened_by`, `created_by`, `closed_by`, `updated_by`, `set_by`, `triggered_by`, token labels such as `gavriel-write-2`, and the like). Use a role instead, for example `bot` or `operator`.
  - **R-4:** a WRITE route retires a term, for example `POST /company/forbidden-terms/{id}/retire`. It is audited and keeps the history. A retired term no longer blocks, and reads show it as retired, still without its text.
  - **R-5 (suggested):** when text DOM generated itself in a packet hits a listed term, DOM redacts it (for example `[REDACTED listed_term]`) instead of refusing the whole packet. Text that a bot sends (posts, the document, notes) is still refused as today.
- **Tests:**
  - **T13-4:** add the term "Gavriel". Then `POST /reviews/packet {preview: true}` returns 200, and the content contains no "gavriel" in any case.
  - **T13-5:** with that term listed, a `POST /posts` dry run with "Gavriel" in the text or alt text is refused with `listed_term`.
  - **T13-6 (if R-4):** retiring a term makes the same text pass. The audit row shows who retired it and when, and `GET /company/forbidden-terms` shows it as retired.

### F-3 (medium): a 503 "high demand" is not retried
- **Seen:** both manual runs got `HTTP 503 UNAVAILABLE: This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.` DOM stored `unknown` at once. Only a 429 marks the day's review for the 10:30 IDT `reviewRetry`.
- **Expected:**
  - **R-6:** a 503 / UNAVAILABLE answer, or a timeout, from the daily review is handled like a 429. Nothing is stored, the day's review is marked for one retry at the 10:30 IDT `tick`, and if the retry fails too, DOM stores `unknown` with Google's status and reason.
  - A manual `POST /reviews/run` that gets a 503 may store `unknown` as today, but it must not use up the weekly packet (F-1).
  - Never another key or model, as today.
- **Tests:**
  - **T13-7:** a daily review that gets a 503 stores no feedback, and `GET /jobs/runs?job=daily` shows `outsideReview` with the reason `retry_pending` (or similar).
  - **T13-8:** the next `tick` shows `reviewRetry` trying once. On a second failure, the feedback is `unknown` with the reason.

### F-4 (medium): the block list misses the `sk-` key shape
- **Seen:** a `POST /posts` dry run with `secret sk-` followed by 48 random letters and digits passed (`ok: true`). Google-API-key and GitHub-token shapes were blocked as `secret`.
- **Contract:** `secret` covers "a common key shape".
- **Expected:**
  - **R-7:** the contract lists the key shapes the block list covers.
  - The list includes at least `sk-…` style keys (and `sk-proj-…`), plus any others DOM considers common. Examples: `xoxb-`/`xoxp-` (Slack), `AKIA…` (AWS), `rnd_…` (Render), and the Buffer key shape if known.
- **Tests:** **T13-9:** each listed shape, built with random characters, is refused as `TEXT_BLOCKED` `secret` on a `POST /posts` dry run and on `POST /company/document`.

### F-5 (low, doc): the cohort report shape differs from the contract
- **Contract:** `{settings, d30, d60, d90: {...}, counts}`.
- **Live:** `{settings, cohorts, fwd_min_ratio, fwd_min_n, rereg: {d30, d60, d90}, counts}`.
- **Expected (R-8):** contract and response match. Either form is fine.
- **Test (T13-10):** `GET /selection/cohorts/report?settings=v11` matches the documented shape.

### F-6 (low): `/media/{token}` answers 401 for some unknown tokens
- **Seen:** without auth, a 32-hex unknown token returns 404 as documented. Any other shape (3 characters, 43 url-safe characters) returns **401 UNAUTHORIZED**.
- **Contract:** the route is public, and an unknown token is 404.
- **Expected (R-9):** any unknown token returns 404 without auth. Alternatively, document the token format and the 401.
- **Test (T13-11):** `GET /media/abc` and `GET /media/<43 characters>` without auth return 404 `NOT_FOUND`.

### F-7 (low, doc): dry-run errors are 200, not 422
- **Seen:** a dry run with a GIF, a 281-character text or a blocked word answers **200** `ok: false`, with reasons per part and per image. That is useful, and it matches the `POST /posts` dry-run shape.
- **Contract text:**
  - "Checks (every post, dry run included) … → 422 `POST_TOO_LONG` / `POST_INVALID` / `TEXT_BLOCKED`".
  - The v2.12.0 release note says "A GIF → 422 `POST_INVALID` `IMAGE_TYPE`".
- **Expected (R-10):** the checks paragraph and the release note say that a dry run answers 200 with `ok: false` and reasons, and that only a real post answers 422.
- **Test (T13-12):** the doc text matches the live behavior.

### F-8 (low, doc): forbidden-term matching rules are undocumented
- **Measured:**
  - Matching is case-insensitive and whole-word.
  - "Shomer's", "#Mesaper", "@Mesaper" and "Mesaper-bot" are blocked.
  - The plural "Shomers" passes.
  - "xshomerx" passes.
- **Expected (R-11):** the contract states the matching rule. Please also consider matching a simple plural or possessive (a trailing "s" or "es"), so "Shomers" is blocked too.
- **Test (T13-13):** the documented examples behave as written.

### F-9 (low): the 3-per-hour limit on `POST /reviews/run` counts a refused call
- **Seen:** two runs (22:09, 22:12) and one 409 `REVIEW_DISABLED` (22:21). The next call (22:24) got 429 `RATE_LIMITED`, `retry_after_seconds: 2853`.
- **Expected (R-12):** only calls that reach Google count toward the 3 per hour. Alternatively, the contract says that refused calls count too.
- **Test (T13-14):** after one 409 `REVIEW_DISABLED` and two runs, a third run within the hour is allowed (if R-12 is chosen as proposed).

### F-10 (low): review settings history shows no old values
- **Seen:** audit rows for `POST /reviews/settings` show only the new values (`result_summary: "review settings: enabled false, model gemini-3.8-flash, tier free"`). No read shows the old values.
- **CR-011 Addendum C:** T11-37 asks for the change "in the audit log with the old and new value".
- **Expected (R-13):** the old and new values are readable. Either the audit summary includes both, or a read such as `GET /reviews/settings/history` lists every change with old, new, who, when and the idempotency key.
- **Test (T13-15):** turning the switch off and on gives two readable changes, each with its old and new values.

### F-11 (low, doc): three small gaps
- **(a)** `POST /posts/{id}/remove` on an unknown id answers 404 `NOT_FOUND`. The contract lists only 409 `POST_NOT_REMOVABLE` and 503. Please document the 404.
- **(b)** Rows removed from a drop list have `tokens: null`. So a `TOO_MANY_WORDS` or `NO_SPLIT` removal can't be checked: for example `besserdenken`, `rishergroup` and `waleedous` were removed as `TOO_MANY_WORDS`. Expected: removed rows show the split DOM used (or `null` only for `NO_SPLIT`, `DOMAIN_INVALID`, `HAS_DIGIT` and `HAS_HYPHEN`).
- **(c)** `POST /selection/cohorts` with `from_drop_lists`, when the window has no pending names, answers 422 `COHORT_EMPTY` with `excluded: {}`. Expected: a reason, for example `NO_PENDING_NAMES_IN_WINDOW`, with the window.
- **Tests:**
  - **T13-16:** the 404 is documented.
  - **T13-17:** `GET /selection/drop-lists/sn-20261006-accept` shows tokens on `TOO_MANY_WORDS` rows.
  - **T13-18:** an empty-window cohort names the reason.

## 3. Question (an observation, not a failure)
- **Q1, v1 and v11 froze identical decisions.**
  - The case: cohort `fwd-accept-20261007` (30 names from the SnapNames list of 2026-10-06, settings `["v11", "v1"]`, `bt1@v2`). Both labels froze the same decision on all 30 names: accept 2 (tier A), reject 28.
  - Why it's surprising: `v1` accepted 0 of 226 sold names in the research, and `v11` differs from it on many rules.
  - Please confirm that each label's decisions are computed with that label's own settings. Also confirm that identical results are expected here, for example because both rules reject on the same gate.
  - If they are not computed per label, please treat this as a bug.
- **Q2, the drop date estimate (for later).**
  - dropWatch estimated drop `2026-10-08` (RDAP last changed + 5 days) for names whose source list gives a join-by date of 2026-10-09.
  - We will check after the drop which date was right. No action is needed yet.

## 4. For DOM's information (no change asked)
- **`GEMINI_MODEL` on Render is now unused.** Render still has `GEMINI_MODEL=gemini-3.8-flash` (set 2026-10-07 21:25 IDT, before v2.11.2 removed the env). We will leave it or remove it. Either way, please confirm that nothing reads it.
- **`gemini-2.5-flash` returns 404 for new keys.** A key from a new Google AI Studio project gets HTTP 404 for `gemini-2.5-flash`; `gemini-3.8-flash` works on the free tier. Please don't add `gemini-2.5-flash` back to the allowed list as a fallback.
- **The review is live with the key** (`/health` `review_model: gemini-3.8-flash`). Both manual runs on 2026-10-07 failed on Google's 503 only (F-3).

## 5. Open questions for DOM
1. For F-2, which of R-3, R-4 and R-5 will DOM build?
2. For F-1, which single weekly rule will the docs state?
3. For F-4, which key shapes will the block list cover?
4. Which tests in §2 does DOM expect to meet, and does it push back on any, with the reason?

<!-- DOM writes below this line -->
