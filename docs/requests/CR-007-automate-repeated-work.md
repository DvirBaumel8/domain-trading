# CR-007: Move Gavriel's repeated work into DOM

**From:** Gavriel (requester, on Dvir's behalf)
**Status:** APPROVED by Dvir 2026-10-07 13:43 IDT (see §18). Sent to DOM.
**Date:** 2026-10-07 13:35 IDT
**Contract base:** v2.1.0 (docs at commit `911f564`)
**Priority:** mixed, per item (§5). P1 = needed now for the production plan. P2 = later.

## 0. Words used in this CR
- **RDAP:** the official registry lookup for a domain (registered or not, creation and expiry dates, registrar, status such as "pending delete"). For `.com` it is Verisign's public service.
- **Dropped name:** a `.com` whose owner let it expire, that went through deletion and became free to register again at the normal price (about $11). "Pending delete" is the last 5 days before that.
- **CZDS:** ICANN's Centralized Zone Data Service. With an approved account it gives the official daily file of every `.com` name in the registry (the "zone file"). A name that disappears from the file is on its way to deletion.
- **Sibling list (census list):** 20 names built the same way as a candidate (for `achievehire.com`: `flowhire.com`, `innerhire.com` ...). The share of siblings already registered is the main demand signal in the picking rule (DEMAND-2).
- **Picking rule:** the selection settings (tiers and thresholds) that decide which names we would buy.
- **Sealed test set:** a set of names with known outcomes (sold vs dropped) that is frozen before a rule is scored on it, and scored once. It shows whether a rule works on names it has never seen.
- **As-of date:** the date a decision would have been made. Only data dated strictly before it may be used.
- **Wilson interval:** a standard range around a percentage that shows how sure we can be of it with a small sample.
- **Lander / for-sale page:** the page a visitor sees at the domain, which offers it for sale (today: the Afternic hosted page at `forsale.godaddy.com`).
- **SURBL / Web Risk:** a spam-and-abuse blocklist (SURBL), and Google's list of malware and phishing sites (Web Risk).
- **TSDR:** the USPTO's Trademark Status and Document Retrieval service, which the USPTO API key opens.

## 1. Business need
On 2026-10-07 Dvir set a standing rule:

> "Let me just remind you we have software and we shouldn't repeat things you do manual. Everything you do with code it by hand manually multiple times we need to consider to use the software or to develop it as a new feature."

He called moving that work into DOM "super important! and let's do it as soon as we can."

Today Gavriel and the bots repeat several jobs by hand or with Gavriel's own scripts: tracking what happens to names after they drop, building and scoring test sets for the picking rule (15 rounds in the last two days; round 15 alone made about 12,000 registry lookups and 57,000 homepage fetches), writing sibling lists, checking the for-sale page, and keeping finance alerts. Doing these by hand:
- costs time and bot tokens on every repeat;
- gives inconsistent results (a script changed between rounds, a check skipped when someone forgets);
- leaves gaps nobody sees (for example, the daily ownership check skips names bought by hand, CR-004 §10.2 Q-11);
- puts the seal on the picking-rule test sets in the hands of the same person who tunes the rule. A seal held by DOM is more trustworthy.

§4 lists every repeated task we found, who does it, how often, and whether DOM already covers it. §5 lists the gaps with a priority and the business reason. §6 to §13 are the contracts. §14 is about tokens and starting the daily run by hand.

## 2. Scope
- **In scope:** the gaps in §5 and the token items in §14.
- **Out of scope:** any purchase or change to caps, approval rules or founder rules; any action at a registrar or marketplace (guarantee 7 stays: DOM never calls a marketplace, never changes DNS on its own in this CR); CR-006 items; the Sedo template (CR-004 Q-12).
- **What stays with Gavriel and the bots** is listed in §4 with the reason. In short: judgment (inventing names, card writing, FLAG verdicts, drafts), anything that needs Dvir's own logins, the Internet Archive history check (manual by Dvir's decision, CR-002 Amendment B1), and acceptance testing.
- Where today's contract already does what we need, "already supported, here is how" is the best answer. DOM may split this CR.

## 3. Ground rules (as in CR-001 §1 and CR-005 §3)
1. **What, not how.** Inputs, outputs, business rules, errors and tests only. Language, storage, routes and field names are DOM's choice; names below are suggestions.
2. **Reference scripts are non-binding.** Appendix A lists Gavriel's scripts for each item. They contain shortcuts and mistakes. They are not a specification.
3. **Free data only, $0 hosting.** If an item can't be met at $0, mark it **DVIR** and say what it would cost.
4. **Source terms.** Official or documented sources only, polite rates, honest identification. Never bypass bot protection, logins or CAPTCHAs. Never automate the Internet Archive, ExpiredDomains or the NameBio download URL.
5. **Read-only toward the outside world.** Nothing here buys, registers, backorders, lists, sends or changes DNS.
6. **Fail closed.** A failed lookup is UNKNOWN, never "free", "clean", "not registered" or zero (CR-001 §3.1).
7. **Append-only and audited**, like every other record.
8. **Secrets** (keys, tokens) never appear in the repo, in chat, in responses or in logs.

## 4. Inventory of repeated work
Who: G = Gavriel (and its research executors), D = Dvir, bots by name.

| # | Task | Who now | How often | DOM today | Result |
|---|---|---|---|---|---|
| 1 | Forward test: sample names about to drop, score them before the drop, check the drop outcome, check re-registration at 30/60/90 days (`selection-v10.md` §6a) | G (Sunday routine, scripts) | Weekly cohort plus 4 follow-up checks per cohort, for 4 to 8 weeks | Requested as CAP-25, P2, not built (CR-002 Amendment A4) | **Gap G-1 (P1)** |
| 2 | Drop-outcome check of the round-13 forward set (120 names, `check_drop.py`) | G | Once on 2026-10-08, then 30/60/90 days | Not covered | G-1. Tomorrow's run stays by hand, once |
| 3 | List of names about to drop, each confirmed by RDAP | G, Tzofeh-Drops | Every forward-test week and every S7 batch | Not covered | **Gap G-2 (P1)** |
| 4 | Sibling lists for the census | G writes them by script (3,878 so far); D approves each list before it can be used live | Every live candidate and every test name | DOM stores and freezes lists only (`selection.md` §Lists; freezing needs Dvir's approval per list) | **Gap G-3 (P1)** |
| 5 | Picking-rule rounds: build the sold and dropped sets from public lists, filter, remove names used before, split, seal | G | 15 rounds so far | Name registry and frozen suites exist (`endpoints.md` §labelled-names, §holdout-suites), but the sets are built by hand and suites are fixed to BT10-1/9/11; none is frozen yet (`GET /selection/holdout-suites` = empty, 2026-10-07 13:30 IDT) | **Gap G-4 (P1)** |
| 6 | Features for the test sets (sibling share, other extensions, as-of dates) | G scripts | Every round | Computed only in live screening; replays take uploaded features (CR-002 §5.1 P-3; CAP-21b is P2) | **G-4 (P1)** |
| 7 | Score a rule on a frozen set, with the profit report | G scripts | Every round | Supported: `POST /selection/replays` (holdout, profit) | Covered once the sets live in DOM (G-4) |
| 8 | "Look-alike names in use" signal (round 15) | G scripts | Every round that uses it | `same_name` exists but is not a tier feature; census `in_use_share` not built (`selection.md` §census) | **Gap G-7 (P2)**, only if Dvir adopts it |
| 9 | Go-live watch: Sedo minimum offer, nameserver switch, for-sale page check | G routine, every 2 h this week | Each new listing | Nameservers for a hand-bought name: `manual_steps` from `POST /list` (CR-004 §10.1 step 6). Sedo: not tracked (CR-004 Q-12). Page: nothing | Sedo and the GoDaddy nameserver change stay manual (marketplace and registrar screens). Page check: **G-5** |
| 10 | Weekly portfolio re-check: RDAP, nameservers, for-sale page shows the right price, blocklists (`follow-ups.md` §5) | G | Weekly (Monday) | `nsVerifier` daily; `registrarCheck` daily but it skips hand-bought names (CR-004 Q-11) | **Gap G-5 (P1)** |
| 11 | For-sale page checks after listing (+24 h, +48 h; GoDaddy search on day 2, 4, 7) | G | Each new listing | Not covered | G-5 |
| 12 | Marketplace listing state (Afternic "Listed", Sedo verified, minimum offer, offers button) | G, D | Each listing and each change | Only the export upload confirmation (`POST /export/{venue}/uploaded`) | **Gap G-8 (P2)** |
| 13 | Web Risk lookups | G by hand, then a manual record | Every screened name | MANUAL_REQUIRED until a key exists (README §Known limits; CR-001 §11.2 Q5) | **Gap G-6 (P1)**, key being created by D |
| 14 | US trademark searches | G, Shomer by hand | Every screened name, plus monthly for owned names | MANUAL_REQUIRED; DOM prepares the phrases (`selection.md` `tm_us`) | **G-6**: depends on what the USPTO key allows (Q-8) |
| 15 | History lookups (Internet Archive) | G by hand | Every screened name | Manual by Dvir's decision; DOM already gives `lookup_name` and `archive_url` per run | **Stays manual.** A cross-run to-do list is G-6b (P2) |
| 16 | Afternic file upload and confirmation | D uploads, G confirms | After each price change | Export, pending flags and `EXPORT_PENDING` covered | Stays (no Afternic seller API) |
| 17 | Price-event heads-ups, renewal alerts | G from `/report` | Daily digest | Covered (`/report` `upcoming_90d`) | Nothing to do |
| 18 | Daily digest | G | Sun to Thu | Data covered (`/report?format=md`) | Stays (writing and judgment) |
| 19 | Offer logging from emails | G | Each offer | `POST /offers` covered | Stays (DOM never reads email) |
| 20 | Finance: budget alerts at 80% and 100%, tool and AI caps, KPIs (sell-through, days to sale, cost per name, inquiry rate) | Gizbar | Weekly, monthly | Budget, committed renewals, ROI, offers in `/report`; no budget-level warnings, no tool/AI caps, no those KPIs | **Gap G-9 (P2)** |
| 21 | Ledger CSV upkeep | Gizbar | Each money event | Superseded: DOM's ledger is the record (`cfo-ledger.md` header) | Stop the CSV (our side, not a CR item) |
| 22 | Reconciling with registrar and marketplace statements | Gizbar, D | Monthly | Needs D's logins | Stays |
| 23 | Monthly trend re-check of owned names | Tzofeh | Monthly | Not covered | Stays for now (one name; the renewal decision is a year away; mixed judgment) |
| 24 | Monthly Keyword Planner reminder | G reminds D | Monthly | n/a | Stays (D's Google Ads login) |
| 25 | Inventing names, buy cards, Shomer's judgment, Sochen's drafts | Scouts, Shomer, Sochen | Each batch | Mechanical checks already in screening runs (CR-001 §2) | Stays (judgment) |
| 26 | Starting the daily run on demand | G cannot today | After a real buy, and when testing | Job token only (`jobs.md`) | **§14** |
| 27 | Acceptance tests of each release | G | Each release | n/a | Stays with G on purpose (independent tester). Its recurring part, "did the daily run happen", is covered by `JOB_OVERDUE` and `GET /jobs/runs` |
| 28 | Quarterly pricing review | Gizbar | Quarterly | `GET /report/pricing-review` covered | Nothing to do |

## 5. Gaps, priority and business reason

| Gap | What | Priority | Business reason |
|---|---|---|---|
| **G-1** | Track how names actually did after they dropped (forward test) | **P1** | Our main buying lane is dropped names at the normal price. This is the only way to see whether the picking rule works on names we can actually buy. By hand it means 5 checks per weekly cohort for weeks |
| **G-2** | Daily list of names about to drop | **P1** (CZDS part starts when Dvir's access is approved) | Feeds G-1 and the drops scout. Without it, someone builds the list by hand every week |
| **G-3** | Sibling lists made by a frozen method DOM owns | **P1** | Every live candidate needs a list, and today each one needs a written list plus Dvir's approval. A 15-name batch means 15 approvals. Blocks automated screening and G-4 |
| **G-4** | Sealed test sets built, sealed and given features by DOM, and new suites | **P1** | Buying stays paused until a round passes. Rounds by hand are heavy, and a seal held by DOM can't be bent by the person tuning the rule |
| **G-5** | Daily portfolio health check, with `/report` warnings | **P1** | We have a live listing now. A broken page, a nameserver that reverted, or a name that left the account loses buyers silently until someone checks |
| **G-6** | Web Risk (and US trademark, as far as the key allows) run automatically once the keys exist | **P1** | Removes a hand lookup for every screened name. Dvir is creating the keys now |
| **G-6b** | One to-do list of every manual check still open across runs | P2 | Saves compiling it by hand for each batch |
| **G-7** | Look-alike-in-use features | P2 | Only if round 15 shows it helps and Dvir adopts a rule that uses it |
| **G-8** | Marketplace listing state per venue | P2 | Today it lives in chat and notes. Needed once there are several names |
| **G-9** | Finance warnings and KPIs | P2 | Gizbar computes them by hand each week; small portfolio today |

---

## 6. G-1: Drop outcome tracking (forward test), P1
Builds on CAP-25 (CR-002 Amendment A4, P2). This asks for a narrower version now: decisions, drop outcome and re-registration. The marketplace-listing follow-up stays P2 (G-8, Q-13).

- **Need:** for each weekly group ("cohort") of names about to drop, record what each picking rule decides **before** the drop, then record what happened after: did the name drop to open registration, was it caught at the drop, and did someone register it within 30, 60 and 90 days. Re-registration is a demand signal: someone judged the name worth about $11.
- **Today:** Gavriel's research executor does it with scripts and a CSV (`research/forward-test/log.csv`, `r13/check_drop.py`).
- **Inputs:**
  - a cohort: 1 to 200 `.com` names, each with an expected drop date and a source (an uploaded list now; the G-2 feed later), or "sample N names from the G-2 feed for drop dates in this window" with a logged random seed;
  - the settings labels to score: the active version plus up to 2 other versions (frozen comparison rules).
- **Outputs, per name:**
  - per settings label: decision `accept` / `reject` / `undecided`, the tier and the first failing check, the date decided;
  - drop outcome: `available_after_drop` (free to register), `caught_at_drop` (new registration on the drop day), `restored` (the owner renewed), `still_pending`, `unknown`, with the time checked;
  - at 30, 60 and 90 days after the drop: `re_registered` yes / no / unknown, creation date and registrar when registered.
- **Outputs, per cohort and across cohorts:** for each settings label, on `available_after_drop` names: counts and the re-registered rate for accepted vs rejected names, with Wilson 95% intervals, at 30, 60 and 90 days. `caught_at_drop` names reported separately. Undecided and unknown counts always shown. A pass line per label: accepted rate at least **2×** the rejected rate with at least **50** names per class (FWD-1; both numbers as settings).
- **Rules:**
  - R-1 Decisions are frozen before the expected drop date. A decision made on or after it is refused for that name (or kept and labelled late and excluded from the rates; DOM's choice, documented).
  - R-2 Nothing observed after the drop enters a decision. DOM may reuse its screening run for the decisions; checks it can't run for the name (history is manual, CR-002 B1) leave features unknown, and the three-valued tier logic decides or leaves the name undecided, as today.
  - R-3 The outcome checks run inside the daily run (no new timer). A failed lookup is retried on the next daily runs, up to a setting, then stays `unknown`. Unknown is never counted as re-registered or free.
  - R-4 Official sources only (Verisign RDAP). Never registers, backorders or bids.
  - R-5 Append-only. A cohort can't be edited after its first decision is frozen.
- **Errors (suggested):** 422 `VALIDATION_ERROR` (size, a drop date in the past); per-name `INPUT_INVALID` as in screening runs; 404 `SETTINGS_NOT_FOUND`; 409 when a name is already in an open cohort.
- **Tests:** AC-1 to AC-5.

## 7. G-2: Daily list of names about to drop, P1
- **Need:** a daily list of `.com` names that will become free to register, with the expected date. It feeds G-1 cohorts and the drops scout's batches.
- **Today:** Gavriel takes a public "deleting" list and confirms each name with a script that asks RDAP.
- **Inputs:**
  - **Source A (now):** a list Gavriel uploads (domain, list name, list date), or a public list DOM fetches itself if its terms allow (Q-6).
  - **Source B (when Dvir's CZDS access is approved):** the daily `.com` zone file. DOM states the secret's name and how Dvir stores the CZDS credential (see §14 for the delivery pattern).
- **Outputs:** per day: names newly gone from the zone (source B) or uploaded (source A), each with RDAP status (`redemption`, `pending delete`, other), the expected drop date (pending-delete start + 5 days, and the source of that date), and the name-form fields DOM already computes (letters only, word count). Filtered by settings: no digits or hyphens, at most 3 words (the same rules as live screening). A name caught at the drop leaves the list.
- **Rules:** R-6 CZDS terms honoured; DOM checks them before building (as DOM said in CR-002 A4). R-7 Keep only what the feature needs (for example the daily difference, not full zone copies), within the free database. R-8 Polite RDAP pacing. R-9 If the feed is more than 2 days old, `/report` warns (suggested `DROP_FEED_STALE`, warn). R-10 No credential: the step is skipped with a reason, nothing fails.
- **Tests:** AC-6 to AC-8.

## 8. G-3: Sibling lists by a frozen method, P1 (DVIR)
- **Need:** every candidate needs a list of 20 siblings so the census can measure the registered share. Today Gavriel writes each list (by script), and freezing each list needs Dvir's approval naming it (`selection.md` §Approvals). That rule exists so bots can't pick convenient siblings (CR-001 §2, SEL8-1). A deterministic method that DOM owns meets the same goal: the same name always gets the same siblings, and nobody chooses them by hand.
- **Inputs:** a sibling-method version: the word pools and the building rules (for example: replace the first word with 10 words from pool A and the last word with 10 words from pool B, order fixed by the name itself), stored as a versioned setting or list. A new method version needs Dvir's approval naming it, once.
- **Outputs:** for any name: its 20 siblings, the method version, and a census list the census check accepts without a per-name approval (for example `gen1:<sld>`). Readable through the API like any list.
- **Rules:** R-11 Deterministic and reproducible from the name and the method version. R-12 The method never looks at whether a sibling is registered or in use when choosing it. R-13 A name that can't get 20 siblings: the census answers UNKNOWN (`CENSUS_LIST_SIZE`), never a share. R-14 Per-name lists (`bt1_<sld>`) keep working. R-15 Geo names follow a setting (excluded by default, as in our research).
- **DVIR:** this replaces "Gavriel writes, Dvir approves each list" with "Dvir approves the method once". It changes CR-001 §2.
- **Tests:** AC-9 to AC-11.

## 9. G-4: Sealed test sets, features and suites, P1 (DVIR on two points)
DOM already has the name registry, frozen suites, holdout and diagnostic replays and the profit report. What is missing is everything before the replay, plus two rule questions that today make the hold impossible to clear through DOM.

- **G-4a, build and seal a test set.**
  - **Inputs:** source rows uploaded by Gavriel (sold: domain, price, sale date, venue, source URL; dropped: domain, list, date) or fetched by DOM where terms allow (Q-6); the set's filters (name form, price floor, date window, word count, geo or not); the split share and a seed; a set name.
  - **Outputs:** the rows DOM kept and why the others were removed; every kept row registered in the name registry as `dev` or `test`; the test membership frozen with a count and a hash, exactly as suites are frozen today.
  - **Rules:** R-16 A name already in the registry (any role, any earlier set) is never used again. R-17 The split is random with the logged seed. R-18 Test rows' labels and features are never shown or scored outside a holdout replay (as today). R-19 Building a set needs no approval; freezing a suite from it does (as today).
- **G-4b, features computed by DOM.** For every registered row, DOM computes, as of the row's as-of date, the features it already computes in live screening: name form, census registered share (using G-3 lists), other extensions registered before the as-of date, and records each input's date so the leakage check works. Features it can't date (history, sites in use today) stay unknown or are labelled approximate. Gavriel no longer uploads these.
- **G-4c, new suites.** Today holdout replays accept only `BT10-1`, `BT10-9` and `BT10-11`, fixed in a locked setting. Each new round has its own sealed test set. **Need:** Dvir can approve a new suite (name, definition) and which suites must pass to clear the hold, without a code change for each round. **DVIR:** the list of suites that clears the hold stays Dvir's decision.
- **G-4d, gates that are manual by rule.** A holdout row needs TM-1, TN-1, HIST-2 and the prior-business guard results. History is manual by Dvir's decision and trademark is manual today, so a 400-name test set can't be filled, and the hold can never clear through DOM. **Need:** DOM proposes a rule (for example: a suite definition states which gates were not assessed, the report shows accept and reject before those gates and the share undecided, and Dvir approves that definition). **DVIR.**
- **Errors:** as today's registry and suite errors, plus suggested 422 `SOURCE_ROWS_INVALID` (per-row reasons) and 409 when a set name exists.
- **Tests:** AC-12 to AC-15.

## 10. G-5: Daily portfolio health check, P1
- **Need:** every owned or listed name is checked every day, with a `/report` warning when something breaks. Today only the nameservers are checked daily, and the ownership check skips hand-bought names such as `promptinjectionaudit.com` (CR-004 Q-11).
- **What DOM checks, per name, in the daily run:**
  1. **Registry (RDAP):** still registered, same registrar as on record, expiry date matches, no hold or deletion status. This also closes the gap for hand-bought names. Suggested warning `REGISTRY_MISMATCH` (error), with details.
  2. **Web answer:** a plain public request to `http://<domain>/` returns the marketplace page, not a registrar parking page, an error or no answer. Signatures as a versioned list, like the parking lists. Today the Afternic nameservers answer with a short page that sends the browser to `/lander` (114 bytes, checked 2026-10-07 13:30 IDT). Suggested warning `LANDER_DOWN` (warn after 1 day, error after a setting, default 2 days running).
  3. **Blocklist:** the existing SURBL check, weekly per owned name. Web Risk too once the key exists (G-6). Suggested warning `OWNED_NAME_BLOCKLISTED` (error).
  4. **The price on the page:** DOM likely can't read it. `forsale.godaddy.com` answers 403 to plain requests and the domain itself serves a script-only page (checked 2026-10-07 13:30 IDT), and DOM must not get around that. So: a record route where Gavriel stores each look (checked at, price shown, offer button shown yes/no, evidence reference). `/report` warns `LANDER_CHECK_DUE` (info) when a listed name has no record in 7 days, and `LANDER_PRICE_MISMATCH` (warn) when the price shown differs from the BIN in force. This removes the bookkeeping and the "remember to check", not the look itself.
- **Rules:** R-20 Read-only. Never changes nameservers or listings. R-21 A failed check is UNKNOWN and named in the step summary, never "ok". R-22 Runs inside the daily run. R-23 Warnings clear by themselves when the next check passes.
- **Tests:** AC-16 to AC-19.

## 11. G-6: Web Risk and US trademark once the keys exist, P1
- **Need:** CR-001 §11.2 (Q3, Q5) said DOM would use the official APIs once Dvir provides keys. Dvir is creating the Google Web Risk key and the USPTO key now.
- **Web Risk:**
  - **Input:** Dvir's Google key. **Already stored:** Dvir added it on 2026-10-07 13:43 IDT as the environment variable `GOOGLE_WEB_RISK_API_KEY` on the Render service `domain-trading-api` (key limited to the Web Risk API, $1 budget alert). Please read it from there; if you need a different name, say so in the reply and Dvir will rename it.
  - **Output and rules:** the `web_risk` check runs automatically: no match → PASS; any match → FAIL `UNSAFE` with the threat types; an error or quota refusal → UNKNOWN, never PASS (CR-001 CAP-06, "with an API key"). The manual record stays as the fallback. A quota cap keeps use inside Google's free tier. Whether the "clean history first" condition (`web_risk.requires_clean_history`) still applies with a key is a settings change Gavriel drafts and Dvir approves.
  - **Cost guard (Dvir must stay at $0):** use only the Lookup API (`uris.search`), which Google prices free up to 100,000 calls a month. Never call the Update API (`threatLists.computeDiff`): per Google's pricing page (read 2026-10-07), calling it switches lookups to `hashes.search` pricing, $50 per 1,000 calls. Suggested test: the contract and the evidence map show no Update API call.
  - Also used weekly for owned names (G-5 point 3).
- **US trademark:** what we found (USPTO "Trademark bulk data" page and the TSDR API user guide, read 2026-10-07): the USPTO key opens case status and documents **by serial number** and bulk downloads. We found no official wordmark search API. **Need:** DOM says which part of TM-1 the key can automate (for example: the monthly re-check of owned names, by re-reading the status of marks found in earlier records; or a search over the official bulk data if that fits $0). If none, TM-1 stays manual and the contract says so.
- **G-6b (P2):** one read that lists every manual check still open across open runs (history, `web_risk`, `tm_us`, `tm_eu`), with the lookup links and phrases DOM already prepares and the date each record must be made by (freshness window).
- **Tests:** AC-20 to AC-22.

## 12. G-7: Look-alike names in use, P2
Only if round 15 shows the signal helps and Dvir approves a rule that uses it.
- **Need:** features that say whether names like ours are in real use: the exact name on other extensions (in use and created before the as-of date), the hyphenated and plural/singular `.com`, and the share of siblings in use.
- **Today:** `same_name` reads other extensions but is not a tier feature; census `in_use_share` is not built.
- **Rules:** "in use" means the existing `same_name` / C19 definition. "In use today" can't be dated, so in replays it is labelled approximate. Usable in tier clauses and replays like the other features.

## 13. G-8 and G-9, P2
- **G-8, listing state per venue.** Record, per name and venue (Afternic, Sedo, GoDaddy search, DomainAgents): state (listed, pending, verified, removed), mode, price shown, minimum offer, offers button shown, checked at, evidence reference. Gavriel or Dvir records it. `/report` warns when a listed name has no confirmed venue state, when a state is older than 30 days, or when a scheduled price change was not reconfirmed on that venue. Also say whether the forward test's 30/60/90-day "listed for sale" check can read public marketplace pages within their terms (Q-13).
- **G-9, finance.** `/report` warnings at 80% and 100% of the $1,500 cap; monthly tool and AI caps as settings Dvir sets, with warnings; KPIs: yearly sell-through, average days to sale, cost per name ever bought, offers per listed name per month (`cfo-ledger.md` §7 definitions).

## 14. Tokens and manual runs
- **T-1, Gavriel's READ token (`gavriel-read`).** DOM created it (DOM-TO-GAVRIEL.md, 2026-10-07). **Need:** deliver it to Gavriel without going through chat. Dvir suggests DOM stores it as a secret on the Render service, and Dvir gives Gavriel read access there. **Please state:** the exact secret name, where it lives (service environment, environment group or secret file), and exactly how Gavriel reads it (which Render screen or API call, with which access Dvir must grant). Gavriel's current Render connection has no way to read a secret's value, so name the method you expect. The token must never appear in the repo, chat, logs or responses.
- **T-2, starting the daily run on demand.** **Need:** Gavriel starts the daily run when testing (to check the scheduled jobs without waiting for 03:05 IDT) and right after a real buy (to settle a purchase whose state is unknown, which otherwise waits up to 24 hours: CR-005 §12.2). **Please offer the simplest safe way**, either:
  - (a) deliver the job token the same way as T-1; or
  - (b) a documented way for the WRITE token to start only the fixed jobs (`daily`, `tick`): the same overlap lock, audited with the token and a `manual` trigger, its own rate limit, unable to do anything else.
  Either way, nothing here can register, renew or top up.
- **T-3, the new WRITE token.** DOM said the WRITE token will be replaced. **Need:** deliver the new one the same way as T-1, and announce it in `DOM-TO-GAVRIEL.md` with the exact switch-over time and whether the old token keeps working for a short overlap, so no call fails in between.
- **Tests:** AC-23 to AC-25.

## 15. Acceptance tests (Gavriel runs them through the API)
Live sources drift. As in CR-001 P-7, DOM may test against recorded answers, and drift explained by evidence is accepted.

**G-1**
- **AC-1** A cohort of the 120 round-13 forward-test names (join-by 2026-10-06, sources in `r13/fwd13.csv`) gets a drop outcome per name. On the same day, each matches Gavriel's own RDAP check, or the difference is explained by the evidence.
- **AC-2** A decision for a name whose expected drop date has passed is refused (or labelled late and left out of the rates, as documented).
- **AC-3** An RDAP error for a name gives `unknown`; it is retried on the next daily run and never counted as re-registered or free.
- **AC-4** The cohort report's counts add up: accepted + rejected + undecided = names scored, per label; the rates and Wilson intervals match a hand calculation on 3 sample cohorts.
- **AC-5** Over a week, DOM's outbound requests for G-1 go only to documented sources (0 to ExpiredDomains, the NameBio download URL or the Internet Archive), shown by DOM's sources list and test evidence.

**G-2**
- **AC-6** Source A: an uploaded list of 50 names returns each with its RDAP status and expected drop date; a name with a digit or hyphen, or more than 3 words, is filtered out with the reason.
- **AC-7** Source B (once access exists): day D lists names present in day D-1's zone and absent from day D's, each with RDAP status.
- **AC-8** With no CZDS credential the step is skipped with a reason and the daily run is still `ok`; a feed more than 2 days old shows the stale warning.

**G-3**
- **AC-9** The same name asked twice gives the same 20 siblings and method version.
- **AC-10** The census accepts a generated list with no per-name approval; a new method version can't be used before Dvir's approval naming it.
- **AC-11** Changing the registration state of a sibling (recorded answers) does not change which siblings are chosen.

**G-4**
- **AC-12** Building a set from uploaded rows removes every name already in the registry and reports why each removed row was removed; the split reproduces from the seed.
- **AC-13** DOM computes the share and extension features for registered rows with their input dates; the leakage check reports 0 leaking rows for a set whose as-of dates are after the inputs.
- **AC-14** A new suite approved by Dvir (approval text naming it) can be scored in holdout mode; one without approval can't.
- **AC-15** The answer to G-4d is in the contract, and a holdout replay follows it.

**G-5**
- **AC-16** For `promptinjectionaudit.com`, the daily run reports registry state, web answer and blocklist state with times (`GET /jobs/runs` step summary).
- **AC-17** A recorded registry answer with a different registrar or expiry gives `REGISTRY_MISMATCH`; a parking-page answer for 2 days running gives `LANDER_DOWN`; both clear after a passing check.
- **AC-18** No lander record for 7 days on a listed name gives `LANDER_CHECK_DUE`; a record with price $1,288 while the BIN is $1,488 gives `LANDER_PRICE_MISMATCH`.
- **AC-19** None of the checks changes nameservers, listings or anything at a registrar or marketplace (audit and test evidence).

**G-6**
- **AC-20** With the Web Risk key set, a screened name gets `web_risk` automatically: Google's documented test URL or a recorded match gives FAIL `UNSAFE`; a recorded no-match gives PASS; a quota refusal gives UNKNOWN.
- **AC-21** Without the key, `web_risk` is MANUAL_REQUIRED exactly as today.
- **AC-22** The contract says what the USPTO key automates, and the live service matches it.

**§14**
- **AC-23** Gavriel reads the READ token by the method DOM documents; `GET /health` with it answers 200, and a POST with it answers 403 `SCOPE_FORBIDDEN`.
- **AC-24** Gavriel starts a `daily` run by the method DOM chose; `GET /jobs/runs` lists it with trigger `manual`; any job name other than `daily` or `tick` is refused; nothing else is reachable with that ability.
- **AC-25** After the WRITE token switch announced in `DOM-TO-GAVRIEL.md`, the new token works and the old one answers 401 after the stated time.

## 16. Questions for DOM (please answer in the reply)
- **Q-1** For each P1 item, what is already supported today, and how?
- **Q-2** CZDS: do its terms allow this use and storage? Can the daily `.com` zone (several GB compressed) be processed at $0 on the current hosting? If not, what would it cost (**DVIR**), and is Source A enough until then?
- **Q-3** Can the census accept generated lists without a per-name approval, and what exactly would Dvir approve per method version?
- **Q-4** G-4d: how should a holdout suite treat gates that are manual by rule (history) or manual today (trademark) so the hold can ever clear through DOM?
- **Q-5** G-4c: what is the simplest way for Dvir to approve new suites and the list of suites that clears the hold?
- **Q-6** May DOM fetch the public sales reports and the public deleting lists we use (UnreportedSales weekly reports, the SnapNames deleting list) under their terms, or should Gavriel keep uploading them?
- **Q-7** G-5: which public answers can DOM read for the web check within each site's terms, and is the price check really out of reach?
- **Q-8** What can the USPTO TSDR key automate for TM-1, if anything?
- **Q-9** Web Risk: does the free tier need a billing account, and what quota cap will DOM set so it stays at $0?
- **Q-10** T-1: the exact secret name, location and read method.
- **Q-11** T-2: option (a) or (b), and why.
- **Q-12** T-3: switch-over time and overlap.
- **Q-13** G-8: can the 30/60/90-day "listed for sale" check read public marketplace pages within their terms?
- **Q-14** Database space: what do G-1, G-2 and G-4 add, and does it fit the free database alongside screening evidence?

## 17. What Dvir is approving by approving this CR
- Sending these requests to DOM, with P1 and P2 as listed.
- In principle (final wording after DOM's reply): a sibling method approved once instead of each list (G-3); new suites and a rule for manual gates in holdout suites (G-4c, G-4d).
- Using his CZDS access, Google Web Risk key and USPTO key in DOM once he has them, stored as secrets DOM names, never in chat.
- Letting DOM store Gavriel's tokens as Render secrets and giving Gavriel read access to them (§14).
- Nothing here spends money. Anything that would cost money comes back as **DVIR**.

---

## Appendix A: reference scripts (NON-BINDING)
Gavriel's scripts for each item, for reference only. They contain shortcuts and known mistakes and are not a specification. Copied to `docs/requests/CR-007-reference/` (no personal data, no sealed test labels).

| Item | Script (Gavriel's workspace, `research/backtest-sold/` unless noted) | What it does |
|---|---|---|
| G-1 | `r13/check_drop.py`; `r13/fwd13_score.py`; `research/forward-test/log.csv` (columns) | Drop outcome by RDAP; scores frozen before the drop; the forward-test log format |
| G-2 | `r15/pool15.py`, `r15/rdap15.py`, `scripts/sn_filter.py` | Drop list filtering and RDAP confirmation |
| G-3 | `scripts/census_build.py` (method `bt1`), `census/*@v1.csv` | Deterministic sibling lists from word pools |
| G-4 | `r15/split15.py`, `r15/feat15.py`, `r15/test15.py`, `r15/profit15.py`, `r15/preregistered.md`, `iterations/name-log.md` | Set building, split and seal, features, one-time test, profit |
| G-5 | `system/lander-examples/capture.sh` (workspace root) | Browser capture of a for-sale page |
| G-7 | `r15/site15.py`, `scripts/census_run_lib.py` | Homepage "in use" test |

---

## 18. Dvir's approval (2026-10-07 13:43 IDT, in chat, verbatim)
> "Yes, send CR-007 to DOM, including approving the look-alike method once instead of each list"

This includes G-3: a sibling (look-alike) method version that Dvir approves once replaces his approval of each list. That changes CR-001 §2. The other DVIR points (G-4c suites that clear the hold, G-4d the rule for manual gates) still come back to Dvir after DOM's reply.

Web Risk key: already stored by Dvir as `GOOGLE_WEB_RISK_API_KEY` on the Render service `domain-trading-api` (§11).
USPTO key: Dvir is getting it now from the USPTO Open Data Portal and will store it as `USPTO_API_KEY` on the same Render service. Gavriel will note in this file when it is there.

