# CR-009: v2.2.0, v2.3.0 and v2.4.0 acceptance findings, and the word-split fix for v11

- **From:** Gavriel (acceptance tester), on Dvir's behalf.
- **Status:** DOM: accepted (2026-10-07); released v2.6.0 (`docs/releases/v2.6.0.md`); the T9-8 rescore is running. APPROVED by Dvir 2026-10-07 15:50 IDT, in chat, verbatim: "Don't switch the rule on yet. Send the bug list (CR-009) to DOM with the word-split fix, and switch on after it's fixed."
- **Dvir's decision on the word split (replaces the "Accept" recorded in CR-008 §17.5):** DOM's 93% split is **not** accepted for v11, because with it the sold side falls to about 69.75%, under the 70% bar (N-8). `v11` stays a draft and is **not** activated until the split fix in N-8 passes T9-8. Gavriel will not use the two approval lines in CR-008 §17.5 now; Gavriel gets fresh lines from Dvir directly when the fix is live. BUY-HOLD stays on.
- **Tested:** live API v2.2.0, 2026-10-07 14:04 to 14:07 IDT, docs at 04f54c2. 17 checks: 13 pass, 3 pass with a note, 0 fail, 1 pending (first scheduled daily run tonight 03:05 IDT). All five CR-006 findings are closed and all six answers are in the contract. Full report: `qa/acceptance-v2.2.0.md`.
- **Also tested (added 2026-10-07 15:45 IDT):** live v2.3.0 (15:18 to 15:22 IDT: 9 checks, 7 pass, 1 fail N-3, 1 not testable) and live v2.4.0 (15:25 to 15:45 IDT: AC-1 to AC-8 of CR-008; all pass except AC-6 below its bar and AC-8's after-approval half pending). Reports: `qa/acceptance-v2.3.0.md`, `qa/acceptance-v2.4.0.md`. Docs at `e886da0`.
- **Kind of change:** mostly wording fixes so the docs match what clients see (N-1, N-2, N-4 to N-7). N-3 is a failure to fix. N-8 is a required change for v11. DOM chooses whether each fix is in the service or in the contract, and how it is built.

## 1. Findings
### N-1. README says no client sees a Connection header, but HTTP/1.1 clients see "Connection: keep-alive"
- **Contract:** README.md §Errors, Platform responses: "HTTP/2 drops connection headers at the edge, so a client sees no `Connection` header."
- **Expected:** The sentence is true for every client.
- **Actual:** Over HTTP/2 there is no Connection header (matches). Over HTTP/1.1 (curl `--http1.1`, Python `http.client`) the same 400 for `/portfolio/%C3%28`, and every other response, carries `Connection: keep-alive`.
- **Reproduce:** `curl -si --http1.1 https://domain-trading-api.onrender.com/portfolio/%C3%28 | grep -i connection` (2026-10-07 14:04 IDT).

### N-2. The job preview does not show rows a due delist would cancel, or rows that would fail
- **Contract:**
  - jobs.md (late rows): a due delist delists the name and "every other open row is cancelled"; a row that fails the price rules becomes `failed`; "`POST /jobs/preview` for a later day assumes the same: it shows what the next run on that day would do with every row due by then."
  - CR-006 Q-3 answer: "The preview for a later day shows exactly this."
  - endpoints.md §POST /jobs/preview: the arrays are `applied`, `superseded`, `held`, `delisted` and `dropped`. There is no `cancelled` and no `failed`, although the `priceJob` summary has both (jobs.md, summary objects).
- **Expected:** A preview for a day with a due delist shows which rows would be cancelled, and a preview where a row would fail shows it. Or the docs say plainly that the preview leaves these two out.
- **Actual:** `POST /jobs/preview {"today":"2027-09-27"}` gives `would_delist: ["promptinjectionaudit.com"]`, `would_apply: []`, `would_supersede: []`. Rows 1 (drop1_m6) and 3 (final_push), which the real run would cancel, appear nowhere.
- **Also (optional):** `would_supersede` holds bare row ids (`[1]`), while `would_apply` holds objects with the domain and `would_delist` holds domain names. With more than one name, a row id alone does not say which name it belongs to. Please document the item shape of each array, and consider adding the domain and event to superseded (and cancelled) items.
- **Reproduce:** `POST /jobs/preview {"today":"2027-09-27"}` with the WRITE token (2026-10-07 14:06 IDT).

### N-3. Automatic Web Risk answers UNKNOWN SOURCE_ERROR for known-clean names (v2.3.0, G-6) (FAIL)
- **Contract:** selection.md, `web_risk` row; releases/v2.3.0.md: with the server's key, no match → PASS with `fields.source: "web_risk_api"`; a quota refusal → UNKNOWN `QUOTA`; any other error → UNKNOWN `SOURCE_ERROR`.
- **Expected:** `google.com`, `wikipedia.com` and `example.com` → PASS.
- **Actual:** all three → UNKNOWN `SOURCE_ERROR`:
  - `fields` are `{source: web_risk_api, lookup_name, threat_types: [], checked_at}`;
  - `upstream_calls` is 1, in about 190 ms, with no evidence row;
  - the reason says "Web Risk could not be read".
  
  Runs: `run_90edada6-fa75-4490-96e3-3b472465541e` (15:19 IDT) and `run_8fda3d12-4157-4e42-86f8-baaf87fa093f` (15:21 IDT). SURBL in the same run: PASS. So the key is set and Google answers with an error that is not a quota refusal. Fail-closed works, but Web Risk is still effectively manual.
- **Please:**
  1. Find the cause. Dvir is checking the Google Cloud side now (Web Risk API enabled on the key's project, billing linked, key restriction). It may be there (API not enabled on the key's project, billing, or a key restriction); if so, say exactly what Dvir must change.
  2. Add the upstream HTTP status and Google's error reason to `fields` for an UNKNOWN (never the key), so a bot can tell a setup problem from an outage.
  3. Say whether the Web Risk part of the blocklist check also failed in your 14:33 IDT `daily` run. Its `portfolioCheck` shows blocklist `ok`. If Web Risk failed inside it, the contract says the result should have been `unknown`.
- **Reproduce:** `POST /screening/runs {"mode":"full","checks":["web_risk"],"names":[{"domain":"google.com","lane":"S3"}]}`.

### N-4. A READ token refused on /jobs/run (401) carries RateLimit headers and uses up a manual-run slot (v2.3.0) (low)
- **Contract:** README, Rate-limit headers: "`GET /health/ping` and refused (401) requests carry none."
- **Actual:**
  - `POST /jobs/run {"job":"daily"}` with the READ token → 401 `UNAUTHORIZED` with `RateLimit-Limit: 4`, `RateLimit-Remaining: 3` and `RateLimit-Reset: 3600` (15:18:50 IDT).
  - The WRITE token's own counter was not affected.
- **Please:** count and label a refused call as README says, or change README.

### N-5. Bad-body calls count toward the 4 manual runs per hour (v2.3.0) (docs)
- **Actual:** two `{"job":"x"}` calls (422) each used one of the 4 slots. The 5th call → 429, `Retry-After` 3559.
- **Please:** say in jobs.md that every authenticated call to the route counts, a 422 included (or count only accepted calls).

### N-6. Audit scope of a run started with the WRITE token (v2.3.0) (docs)
- **Contract:**
  - jobs.md: "one `audit_log` row with scope `job`";
  - endpoints.md `GET /audit`: "Job runs appear with scope `job`".
- **Actual:** a WRITE-started run's row has scope `write` (path `/jobs/run`, summary `daily: ok`).
- **Please:** document that a bot-started run is audited under the bot token's scope.

### N-7. A run whose `checks` filter leaves no gating check reports `would_buy` (v2.4.0) (low)
- **Actual:** `run_2d1ff501-dd3a-48fa-aed8-030260cb2c69` (full, v11, `checks: ["census"]`) ended with census UNKNOWN `CENSUS_METHOD_NOT_APPROVED` and `final_status: would_buy`.
- **Problem:** "everything passed" is empty when nothing gating ran, yet the name is listed in `ranking`. It is never a buy card (the hold is on and it's a backtest), but the label misleads a reader.
- **Please:** give such a name a status that says it wasn't screened (for example `not_screened`) and keep it out of `ranking`, or document the case.

### N-8. AC-6: DOM's word split changes v11 decisions enough to matter (v2.4.0) (decision input)
- **Contract:** CR-008 §7 (at least 95% agreement, else Dvir decides); releases/v2.4.0.md AC-6 (1,767 / 1,900 = 93.0%; DOM recommends accepting it as a known limit); CR-008 §17.5 records Dvir's "Accept".
- **What the 133 differences are:**
  - 40: an 's' moved onto the first word (`actives|tack`, `balls|tart`, `makes|hots`, `apps|hipping`);
  - 29: other wrong cuts (`thew|all|guy`, `rely|realest|ate`, `just|dr|ea|ml|lc`);
  - 12: real words the dictionary lacks, broken into pieces (British spellings: colour, defence, theatre, harbour, aluminium, travelling, maths; also arcade, forex, linkedin, costa rica);
  - 40: compounds or place names kept whole (defensible);
  - 12: toss-ups.
  
  The same pattern shows outside the vectors: `theeventhouse.com` → `thee|vent|house`.
- **Measured effect:** Gavriel rebuilt the `bt1@v1` siblings with DOM's split for the 54 TEST15 names affected; DOM's `?domain=` lists match. Registration was read on 2026-10-07 from Verisign RDAP.
  - 18 v11 decisions change; 9 sold names go from accept to reject.
  - Estimated TEST15 with DOM's split: sold accepted **279 / 400 = 69.75%** (bar 70%); dropped rejected 380 / 494 = 76.9%.
  - Under DOM's split, v11's evidence no longer clears the sold bar. This is Gavriel's estimate.
- **Required (Dvir, 15:50 IDT): fix the split for v11. DOM chooses how.** The outcome that counts:
  - the census for a name gets its siblings from a word split that agrees with the research split on **at least 95%** of the 1,900 `bt1_vectors.csv` names (or the differences that remain are shown not to change any TEST15 decision); and
  - a replay of the 894 TEST15 fixtures in which DOM builds the siblings itself from each domain name (not from stored shares) gives **sold accepted ≥ 70% and dropped rejected ≥ 75%** under `v11`, using registration as DOM reads it at run time.
- **Ways that would meet it (examples, not instructions):** (a) a split that prefers common words, as a new method version (for example `bt1@v2`) re-measured on the 1,900 vectors; (b) a screening item may carry a word split for the census (for example `census_tokens`), with a defined source that is not a bot's free choice per name; (c) on its own, a flag for doubtful splits is **not enough**, because it keeps the split as hand work for every name, which is what CR-007 removes. It may be added on top.
- **If (a) creates a new method version,** Dvir will approve that version by name (as D-2), and `v11` may need to point at it. Please say so in the reply.
- **Please also:** if no split reaches the bar, say so plainly, with the best rates you can reach, so Dvir can decide.

## 2. Acceptance tests
- **T9-1:** README.md §Errors says what HTTP/1.1 and HTTP/2 clients each see for the Connection header, or the service and edge make the sentence true for both.
- **T9-2:** `POST /jobs/preview {"today":"2027-09-27"}` shows rows 1 and 3 as would-be cancelled (for example `would_cancel`), and a row that would fail shows as would-be failed; or jobs.md and endpoints.md say the preview does not list cancelled or failed rows.
- **T9-3 (optional):** endpoints.md gives the item shape of each preview array.
- **T9-4:** a web_risk check on `google.com` with the key answers PASS (`fields.source: web_risk_api`). An UNKNOWN carries the upstream status and reason, never the key.
- **T9-5:** README and jobs.md describe what a refused or bad-body call to `/jobs/run` does to the RateLimit headers and the 4-per-hour count. The service matches.
- **T9-6:** the audit scope of a bot-started run is documented.
- **T9-7:** a run with no gating check in its plan never shows `would_buy` (or the case is documented).
- **T9-8:** the split agreement on the 1,900 vectors is reported and is at least 95% (or the remaining differences change no TEST15 decision); the replay of the 894 TEST15 fixtures with DOM-built siblings gives sold accepted ≥ 70% and dropped rejected ≥ 75% under `v11`; `theeventhouse.com` splits as `the|event|house` and `ballstart.com` does not split as `balls|tart`. Gavriel reruns the replay through the API.

<!-- DOM writes below this line -->
## DOM response (2026-10-07)
**Verdict: accepted, all eight.**
- **Release:** v2.6.0, before CR-007's drop list and forward test (those move to v2.7.0).
- **N-8:** met by a new sibling method version, **`bt1@v2`**. It is Appendix B's recipe on a frozen, frequency-aware word split. Dvir approves it by name (D-9-1), and `v11` needs no change.

### N-8: the word split
- **Method:** the split picks the reading with the lowest total cost.
  - **Word cost:** each word costs by how common it is: its SCOWL size level, the same source and licence as DOM's dictionary (35 most common, then 40, 50, 60).
  - **Piece cost:** each extra piece costs a little.
  - **Special terms:** DOM's term lists (tech, trade, legal, generic heads, regimes, states) count as common.
  - **Place names:** a city-only piece is expensive.
- **What's frozen:** the levels, the term lists and the four costs are part of `bt1@v2` (a data file with its sha256), so later list edits never change a sibling list. `bt1@v1` stays exactly as it is.
- **Measured on the 1,900 vectors:**
  - **1,810 agree (95.3%).** DOM's v2.4.0 split gave 1,767 (93.0%).
  - **The costs were chosen on half the names,** and the other half then scores 95.0% and 95.2%, so the result is not tuned to these names.
  - **The two required names:** `theeventhouse.com` → `the event house`, `ballstart.com` → `ball start`.
  - **The 90 that still differ** will be listed in the release note. Most are compounds and names that are hard to split either way (`catskills`, `wellspring`, `copilot`), or tokens no list holds (`llc`, `uae`, `cbd`).
- **The replay with DOM-built siblings (second half of T9-8):** v2.6.0 lets a `rescore` test set take `sibling_method` and `features_as_of: "now"`, which reads registration today, as the research did.
  - **No approval needed:** a rescore is diagnostic only (it registers nothing), so it may use a method Dvir has not approved yet. Live screening and `new` sets still need the approval.
  - **After deploy:** DOM starts `rescore` of `R15-TEST15-USED` on `v11` with `bt1@v2` and `features_as_of: "now"`, and reports the rates in this file (about 6 hours of paced lookups).
  - **If the sold side lands under 70%,** DOM says so plainly with the rates, as you asked.

### The other findings
| # | Fix |
|---|---|
| N-1 | Contract. Over HTTP/1.1 the edge answers `Connection: keep-alive` on every response; over HTTP/2 there is no Connection header. The service's own `close` never reaches a client |
| N-2 | Service. `POST /jobs/preview` adds `would_cancel` and `would_fail`, as objects `{row_id, domain, event}` (`would_fail` adds `reason`). The contract gives each array's item shape. `would_supersede` stays a list of row ids (unchanged, documented) |
| N-3 | Service. An UNKNOWN Web Risk result adds `fields.http_status` and Google's error `status` / `reason` (never the key). The weekly blocklist check is `unknown`, not `ok`, when any source failed and none listed the name: your point 3 was right, the 14:33 run would have hidden it. Cause: a 190 ms refusal is Google rejecting the request, most likely the API not enabled on the key's project or a key restriction. With the new fields, DOM reads the exact reason after deploy and writes here what Dvir must change |
| N-4 | Service. A refused (401) call to `/jobs/run` carries no RateLimit headers and uses no manual-run slot. Only calls with a WRITE token count |
| N-5 | Contract. Every WRITE call to `/jobs/run` counts toward the 4 per hour, a 422 included |
| N-6 | Contract. A run started with the WRITE token is audited under scope `write`; scheduled and job-token runs under `job` |
| N-7 | Service. A name whose plan had no gating check is `not_screened` (new final status) and is left out of `ranking` |

### For Dvir (DVIR)
- **D-9-1 (once the rescore shows ≥ 70% / ≥ 75%):** one line: **"sibling method bt1@v2 approved"**.
- **D-9-2:** a fresh activation line for `v11`, as CR-009 says.
- **No `bt1@v1` approval is needed** any more.

## Gavriel note (2026-10-07 16:30 IDT): N-3 cause found and fixed on our side
- **Cause:** the Google Cloud project that holds the Web Risk key (`robots-508113`) had **no billing account linked**. The Web Risk API was enabled, and the key was restricted to the Web Risk API only, with no application restriction. Google refuses Web Risk calls from a project without billing, even inside the free tier.
- **Fix:** Dvir linked a billing account at about 16:00 IDT. Nothing for DOM to change in the Google setup, and nothing more for Dvir to change.
- **Recheck (T9-4):** `POST /screening/runs {"mode":"full","checks":["web_risk"],"names":[{"domain":"google.com","lane":"S3"}]}`, run `run_b8fdc77c-f6ca-490c-94ac-5ce5f7ac3eef` (16:03 IDT): **PASS**, `fields.source: web_risk_api`, `threat_types: []`, 1 upstream call, 399 ms.
- **Still wanted from your N-3 row:** the added `fields.http_status` and Google's error `status` / `reason` on an UNKNOWN, and the weekly blocklist check showing `unknown` when a source failed. Those keep the next setup problem visible. You no longer need to write what Dvir must change.
- **Approved by Dvir** (16:28 IDT: "Yes, push the Web Risk note to DOM now").
