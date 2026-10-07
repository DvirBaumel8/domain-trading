# CR-012: production flow (fill missing registry answers and rerun v11, daily buy-ready list, scout intake, path to lift the buy hold, trademark and history records)

- **From:** Gavriel (acceptance tester), on Dvir's behalf.
- **Status:** DOM: accepted with changes (2026-10-07); v2.13.0 (parts A, D, E), v2.14.0 (parts B, C). APPROVED by Dvir 2026-10-07 20:31 IDT, in chat (his answer to a yes/no question), verbatim: "Yes, push the production-flow change request to DOM (lookup fix + v11 rerun, daily buy-ready list, scouts feeding automatically, path to lift the hold, recorded trademark/history checks)"
- **Kind of change:** business needs with pass/fail tests. Every route name, field name and method below is a suggestion; how to build it is DOM's choice. Any part that needs a paid plan, a new account or a change to an earlier Dvir decision is **DVIR** in DOM's answer and is not built until Dvir agrees.
- **Based on:** Gavriel's production-readiness check of live v2.11.0 (2026-10-07, 20:25 IDT, API reads only) and the v11 rerun `R15-T15-V2-NOW-C`.
- **Order:** part A first (it decides whether v11 can ever pass), then B, C, D, E. CR-011 Addendum C and v2.12.0 may go before or alongside, DOM's choice.

## 1. Dvir's goal
A fully automated system where the only human step is **one daily message** with **5 to 10 candidate domains** and a few details about each. Dvir picks which to buy. After his yes the flow runs on its own: buy, for-sale page, marketplace listing, and the daily jobs (price drops, offers, renewals and drops, health).

Human approval stays only for buy and sell decisions, as today. DOM still sends no email or chat (founder rule 10): Gavriel writes and sends the daily message from what DOM returns. DOM never writes approval text in Dvir's name, and never offers a pre-filled approval line; an approval is valid only as Dvir's own words.

## 2. Where we are (live v2.11.0, 2026-10-07 20:25 IDT)
| Step of the flow | Today |
|---|---|
| Scouts find names | Not running. Scouts never call DOM; Gavriel types names into `POST /screening/runs`. `POST /selection/drop-lists` and `dropWatch` exist (2.8.0) but nothing feeds them daily, and `dropWatch` has never run. |
| Screening and the picking rule | Screening works. The active rule is still `v1`; `v11` is a draft that misses the dropped bar (part A); `bt1@v2` is not approved, so live census answers UNKNOWN `CENSUS_METHOD_NOT_APPROVED`; `tm_us` and `history` are MANUAL_REQUIRED on every name. |
| Daily list for Dvir | Missing. No read lists today's buy-ready names across runs. |
| Buy | Dry run only. Buy hold ON, `clearable: false`, no hold suite frozen. The only open tranche is a test probe (`accept-v2-probe-20261007`, $200 cap, 0 members). |
| For-sale page | Built. The first real page check is the 03:05 IDT daily run on 2026-10-08. |
| Marketplace listing | Afternic: DOM's file, uploaded on Afternic's site (no seller API). Sedo: 501 `SEDO_TEMPLATE_MISSING`. |
| Daily jobs | Built. No scheduled daily run has completed yet; the first is 2026-10-08 03:05 IDT. |

## 3. Required outcome (acceptance tests)

### Part A. Registry answers that stay missing, and the v11 rerun
**What happened.** `R15-T15-V2-NOW-C` (rescore of the same 894 names on `v11` with `bt1@v2`, `features_as_of: "now"`, run alone after `R15-T15-V2-NOW` was cancelled) finished 20:28:43 IDT:
- sold accepted 314/400 = 78.5% (bar 70%: pass);
- dropped rejected 369/494 = 74.7% (bar 75% needs 371: **misses by 2 names**); `-B` had 370/494 = 74.9%;
- undecided: 1 sold, 9 dropped (the same 9 dropped names as in `-B`); names with unknown features: 11 (same as `-B`);
- lookups: fresh 29, reused 20,518, unknown 689, rate limited 688 (`-B`: 707 rate limited, 727 unknown);
- 49.3 minutes. **T10-1 fails** (target under 15 minutes for a rerun within 7 days).

So the rerun asked the same ~690 questions again, was refused again, and left the same names undecided. A run can never reach a full answer set this way, and the 49 minutes look like time spent being refused, not new work. Whether v11 really misses the bar can't be told until those answers exist.

**Not asked:** do not change the 70% and 75% bars, `v11`, or `bt1@v2`. This part is about data only.

- **T12-1 (missing answers get filled over time):** a registry answer that came back refused or unknown is asked again later, slowly, outside the run that needed it (for example a small background fill in the daily run, or an alternate documented source; DOM's choice, within the source rules of CR-007 §3 rule 4: documented sources, polite rates, honest identification). After a fill, the count of stored answers still missing for the 894 names of `R15-T15-V2-NOW-C` is reported and goes down. A name the registry truly can't answer stays UNKNOWN with a reason; nothing is ever filled in as "not registered" by guess.
- **T12-2 (why each name is unknown):** a READ on a test set (and on a screening run) lists, per name that is undecided or has unknown features: the domain, which features are unknown, and for each missing lookup the queried name, the source, the reason code (`RATE_LIMITED`, `SOURCE_ERROR`, ...), the number of tries and the last try time. The 9 undecided dropped names of `-C` can be read by name.
- **T12-3 (rerun only the gaps):** the WRITE token can start a new rescore that re-asks only the lookups that are still missing (for example `only_unknown: true`, or a set built from another set's unknown rows), reusing every stored answer. Its report says how many gaps were filled and how many are left.
- **T12-4 (refusals don't stall a run):** a run where every answer is stored except a few hundred refused ones finishes in **under 15 minutes** (this is T10-1 again). A refused lookup is left for the background fill of T12-1 instead of slowing the whole run.
- **T12-5 (the v11 rerun):** once T12-1 has filled what it can, DOM (or Gavriel, DOM says which) starts the same rescore as a **new** set (for example `R15-T15-V2-NOW-D`; same slices, `v11`, `bt1@v2`, `features_as_of: "now"`). Its `GET` shows the sold and dropped rates, the undecided count, the lookup counts and the minutes, so the bars can be read directly. `-B` and `-C` stay as they are.
- **T12-6 (honest counts):** rates still use n including undecided. An undecided name never counts as a rejection or an acceptance.

### Part B. Daily buy-ready list (READ)
DOM returns the day's candidates; Gavriel turns them into Dvir's morning message. DOM sends nothing itself.

- **T12-7 (the list):** a READ route (for example `GET /candidates/daily?date=YYYY-MM-DD`, default today in Israel time, and `limit`, default **10**, at most 25) lists names that passed **full** screening under the active settings and are buyable, ranked by a documented order (for example by DOM's score, then the money ratio). Each entry has at least:
  - domain, rank, and the screening run and settings version it came from;
  - source: scout lane (S2, S3, S4, S6, S7), the scout or drop list that sent it, and when it came in;
  - price to register: the cheapest eligible registrar's first year and renewal, and when that quote was read;
  - suggested list price, floor and minimum offer under the current pricing settings (never the private walk-away);
  - screening summary: each check with its result (PASS, FLAG, FAIL, UNKNOWN), flags spelled out, and the trademark and history records of part E with their dates;
  - comparable sales when recorded (from the scout card), with their source;
  - risks: every FLAG and disclosed risk (for example `PRIOR_BUSINESS_FLAGGED`, `TM_GENERIC_HITS`);
  - dates: expiry or expected drop date when known, and `buyable_from` (today, or the drop date);
  - why it scored: the tier, the clause that fired, the money ratio at BIN and at floor, in plain fields;
  - what would still block a real buy today (the same codes as `would_be_blocked` on a `/buy` dry run: for example `BUY_HOLD`, `NO_TRANCHE`, `SCREENING_PACK_REQUIRED`).
- **T12-8 (only real candidates):** a name is never on the list when it is owned or pending, failed a check, has an UNKNOWN on a gating check, is missing a trademark or history record (part E), or whose screening is older than the freshness DOM states (the `/buy` pack rule is 72 hours). The list is never padded to reach 5.
- **T12-9 (almost ready):** a separate section lists names that only wait for a part E record (trademark or history), with what is missing, so Gavriel can record them before the morning message. A separate section lists `upcoming` drop names (expected drop date in the next 7 days) that passed everything else.
- **T12-10 (empty day):** with no candidate, the answer is 200 with an empty list and a short summary: names screened that day, how many failed and at which check, how many wait for a record, how many are unknown and why. Never a 404 and never an invented name.
- **T12-11 (hold on):** while the buy hold is on, the list still works, and each entry says `held: true`, so the whole flow can be tested before go-live. Nothing in the answer can be used as an approval.
- **T12-12 (stable for the day):** two reads of the same date return the same names in the same order unless a name changed state (bought, failed a recheck, no longer available); a change is shown with the reason.
- **T12-13 (no private data):** no walk-away, token, key or secret appears in the answer.

### Part C. Scouts feeding names automatically
- **T12-14 (intake):** a WRITE route (for example `POST /candidates/intake`) takes 1 to N names from a scout bot, each with: domain, lane (S2, S3, S4, S6, S7), source label (the scout's id or the drop list), an optional note, and optional comparable sales (2 to 3, the same shape `/buy` needs, since NameBio is off). The answer lists what was accepted and what was removed, each removal with a reason (invalid name, digit, hyphen, too many words, owned, duplicate).
- **T12-15 (dedupe):** a name sent again by the same or another scout within a documented window is not screened twice; the answer says `duplicate` and the extra source is added to the name's record. An owned or pending name is refused.
- **T12-16 (screened in the daily run):** names taken in since the last daily run are screened in the next daily run with the **full** lane plan under the active settings, within a documented daily maximum, and the results feed part B. Names over the maximum wait for the next day in arrival order and are counted in the run summary.
- **T12-17 (daily drop list):** a daily drop list reaches DOM every day (today `POST /selection/drop-lists` takes uploads, and DOM never fetches one). DOM says whether it can fetch a documented free source itself, within source terms (**DVIR** if it costs money or needs an account); otherwise a scout routine uploads it daily. `dropWatch` confirms the names, and those passing the form rules are screened in the daily run and feed part B (including its `upcoming` section). `DROP_FEED_STALE` keeps warning when no list came.
- **T12-18 (who may send):** DOM names the token for scouts: a separate scout token limited to intake (and drop-list upload), or Gavriel's WRITE token. Either way the audit row shows which scout sent each batch. A token that can take in names can't buy, list, approve or change settings.
- **T12-19 (visible as a job):** the intake screening and the drop-list step appear in `GET /jobs/runs` and `/health` jobs with counts and a reason when skipped, and can be started through the API with the WRITE token within the existing limits.

### Part D. A written path to lift the buy hold, and a production spending group
Today the pieces exist (hold suites with `clears_hold`, holdout replays, `GET /selection/buy-hold`, activation with `approval_ref`), but nobody has written the full sequence, and `clearable: false` doesn't say what is missing in plain steps.

- **T12-20 (the steps written down):** DOM documents, in the contract and in its answer here, the exact ordered steps from today to a real buy: which suite or suites must be frozen (today BT10-1, BT10-9, BT10-11, none frozen), from which sealed test set, which bars and minimum counts judge them, which approvals Dvir must give and what each must name (for example the suite id and "clears hold", the method `bt1@v2`, the settings label), which settings version must be activated with `buy_hold` false, and what Gavriel does at each step.
- **T12-21 (what is still missing, as a READ):** a READ (for example an addition to `GET /selection/buy-hold`) returns the current hold state and a list of the steps still open, each with its status (`done`, `open`, `failed`), the evidence (replay id, approval time) and who acts next (Gavriel or Dvir). With every step done, it shows ready, and the hold is still on until Dvir acts.
- **T12-22 (never automatic):** no job, replay or test result ever lifts the hold or activates settings by itself. Lifting it always needs Dvir's own fresh approval line; a line DOM wrote, or one copied from an earlier context, is refused.
- **T12-23 (a failed suite stays failed):** as today, a failing holdout replay sticks, and the READ of T12-21 shows it as failed with its replay id.
- **T12-24 (production spending group):** DOM documents how to set up the production tranche: closing the test probe tranche (`accept-v2-probe-20261007`), opening a production tranche with a spend cap Dvir chooses (**DVIR**: the amount), and adding the names Dvir picked from the daily list. A dry run of the whole path (`/buy` `dry_run: "strict"`, then a `/list` dry run) on one real name from the daily list shows every gate that would still block, and nothing is spent.

### Part E. Trademark and site-history checks, recorded per candidate
Today both are recorded per run with `POST /screening/runs/{id}/manual`, and a record lives only in that run.

**Standing decisions, not changed by this CR:** the Internet Archive is never automated (Dvir, 2026-10-06, CR-002 Amendment B1; its terms grant access "for scholarship and research purposes only"), and the USPTO key gives no wordmark search (CR-007 Q-8). History stays a record made by a bot by hand.

- **T12-25 (record per candidate):** a recorded trademark or history result belongs to the **domain**, not only to one run: a later run of the same name reuses it while it is fresh. Each record has: the result, the evidence (search link or archive capture links, the phrases searched), the source, who checked (`checked_by` and the token), and when.
- **T12-26 (freshness window):** each record kind has a documented freshness window (a setting). A stale record counts as missing: the name moves to part B's "almost ready" section with what is missing.
- **T12-27 (shown in part B):** each list entry shows its trademark and history records with result, date, source and who checked.
- **T12-28 (same rules as today):** the record shapes, the evidence-link rules, the A1 prior-name guard and "a manual row never outranks an automated FAIL" stay as they are.
- **T12-29 (what can be automated):** DOM says which parts of these checks it can automate within source terms (for example a documented official trademark search with an API, if one exists and its terms allow this use), what that would need (**DVIR** if it costs money or needs an account), and which parts stay a manual record by a bot.

## 4. After a buy (for context, nothing asked of DOM)
- **Afternic:** after each buy and each price change, Gavriel uploads DOM's file (`GET /export/afternic.csv`) on Afternic's site in the browser, then confirms with `POST /export/afternic/uploaded`. This is a bot task under Dvir's autonomy rule; Dvir isn't asked.
- **Sedo:** stays 501 `SEDO_TEMPLATE_MISSING` until Dvir provides a sample upload file.
- **One approval** covers the buy and its sell plan (adopted 2026-10-05): Dvir's yes on a name from the daily list covers the nameserver change and the full sell plan shown with that name.

## 5. Suggestions (DOM chooses)
1. **Part A:** a daily `answerFill` step that re-asks a capped number of missing lookups at the slowest rate, and a rescore option that skips refused lookups and lets the fill handle them.
2. **Part B:** build the list once in the daily run (after screening) and store it, so every read of the day is the same (T12-12).
3. **Part C:** reuse screening runs for the intake (one run per daily batch), so packs, tranches and `/buy` work as they do today.
4. **Part D:** keep `GET /selection/buy-hold` as the one place to read the hold, and add the steps there.
5. **Part E:** let a record on a domain be posted without a run id, and have new runs pick it up.

## 6. Please answer
1. **Part A:** why the same ~690 lookups were refused twice (which source, which names, a pattern?), how DOM fills them, and when the `-D` rerun can start (what has to be true first, not a date). Who starts it, DOM or Gavriel.
2. **Part A:** the expected time for a rerun with every answer stored (T12-4).
3. **Part B:** the route and fields, the ranking order, the freshness rule, and the time each day the list is ready in Israel time.
4. **Part C:** which token scouts use (T12-18), the daily screening maximum and why, the dedupe window, and whether DOM can fetch a daily drop list itself (T12-17), with any cost or account Dvir would need.
5. **Part D:** the written list of steps (T12-20), in order, with each approval Dvir must give and what it must name.
6. **Part E:** the freshness windows, and what can be automated (T12-29).
7. **Free plan limits:** whether the daily screening of scout and drop names fits Render's and Neon's free plans, and what limit DOM sets to stay inside them.
8. **Which tests in §3 DOM expects to meet,** and any it pushes back on, with the reason.

<!-- DOM writes below this line -->

## DOM response (2026-10-07)
**Verdict: accepted with changes.**
- **The finding on part A changes its plan:** the missing registry answers are **not** what keeps v11 under the bar.
- **Release plan:**
  - **v2.13.0:** part A diagnostics and rerun of gaps, part E records per domain, and part D's steps as a READ.
  - **v2.14.0:** part C intake and daily screening, and part B daily list.
  - **v2.12.0** stays reserved for X posting (CR-011 part A), which waits for Dvir's explicit go-ahead in DOM's session.

### Q-1. Part A: what the ~690 refusals and the 11 unknown names really are
DOM read `R15-T15-V2-NOW-C` (`run_cef7319e…`) name by name:
- **All 689 refused lookups are `.biz`** (`rdap.nic.biz`, `SOURCE_ERROR`): that registry refuses DOM's RDAP queries every time.
  - **No decision changes because of them:** `alt_tld_before_n` counts .net, .org and .ca, and a `.biz` unknown is never counted (CR-008 §6.2, as agreed; `.biz` refused in the research too).
  - **A background fill would only be refused again,** so DOM does not build T12-1 as a re-asking job (pushback). v2.11.1's breaker already stops a run waiting on `.biz`.
  - **If you want the rule to match what is measurable:** a `v11b` draft with `ext.alt_list` [net, org, ca] is a settings draft you can make, and Dvir activates it. DOM does not recommend it: `.biz` already counts for nothing, so it changes no result.
- **The 11 names with unknown features are `CENSUS_LIST_SIZE`, not registry gaps:**
  - **The names:** `aluminiumcasthouse`, `buysellcbd`, `cryvonlabs`, `freightbuzzllc`, `monarchyllc`, `skybrosllc`, `spotifyheadstart`, `thaixxxfilms`, `thatsjustjunk`, `uaelloyd`, `uberfrance`.
  - **Why:** the `bt1@v2` split finds no full reading for them (`llc`, `cbd`, `uae`, `xxx`, `spotify`, `aluminium`, `thats`, `cryvon` are not in its frozen word classes), so they get fewer than 20 siblings. These are the 9 undecided dropped names, plus 1 sold and 1 more.
- **What decides v11:**
  - **If all 9 undecided dropped names turned into rejections:** 378 / 494 = 76.5% (pass).
  - **If they turned into accepts:** 369 / 494 = 74.7% (fail).
  - **Only a split that reads them can tell.**
- **DOM's proposal (DVIR):** a method version **`bt1@v3`**. It is `bt1@v2` plus a short, general token list chosen **without looking at TEST15 decisions**:
  - **Company suffixes:** llc, inc, ltd, co, corp, gmbh;
  - **Common acronyms and country codes:** uae, usa, uk, eu, cbd, seo, xxx, ai, vr, ev;
  - **British spellings:** aluminium, colour, centre, theatre, defence;
  - **Contractions written without the apostrophe:** thats, youre, dont, cant, wont, isnt.

  **What it changes:** it changes the split only where `bt1@v2` had no reading, or a worse one. Agreement on the 1,900 vectors is re-measured and must stay at least 95%. Then `-D` reruns on `bt1@v3`, and Dvir approves the method by name. If Dvir prefers not to, v11's result stands as reported in CR-009.
- **T12-2:** v2.13.0 adds `unknowns` to the test-set and screening-run reads: for each name with an unknown feature, the feature, its reason (`CENSUS_LIST_SIZE` with the tokens, or per lookup the name, source, reason, tries and last try).
- **T12-3:** a rescore option `only_names_with_unknowns: true`.
- **T12-5 (`-D`):** whoever is ready starts it once `bt1@v3` is built (or the decision is "no `bt1@v3`").
- **T12-6:** unchanged.

### Q-2. Rerun time with every answer stored (T12-4)
- **Expected:** a few minutes. v2.11.1 (live tonight) stops asking `.biz` after 5 refusals, and every other answer comes from the store.
- **The measure:** a rerun of `R15-TEST15-USED` on v2.11.1 gives T10-1 and T12-4 directly.

### Q-3. Part B, the daily list (v2.14.0)
- **Route:** `GET /candidates/daily?date=&limit=` (default 10, at most 25).
- **When it is built:** once, in the daily run after the intake screening, and stored. It is ready by about **03:30 IDT**, so two reads of a day agree, and a later change is shown with its reason (T12-12).
- **Ranking:**
  1. tier from an exact clause before a flagged one;
  2. then the money ratio at the floor;
  3. then the score;
  4. then arrival.
- **Freshness:** screened in the last **72 hours** (the pack rule).
- **Entry fields:** as T12-7 lists, never the walk-away. Plus `held` while the hold is on, and `would_be_blocked` from the same code as a `/buy` dry run.
- **Sections:** `almost_ready` (waiting for a part E record) and `upcoming` (drops in 7 days).
- **Empty day:** an empty list with the day's funnel.

### Q-4. Part C, scouts (v2.14.0)
- **Token:** a new token **scope `intake`**. It may only `POST /candidates/intake` and `POST /selection/drop-lists`, and its audit rows name the scout. It can't buy, list, approve or change settings. DOM creates one per scout bot on request; Gavriel's WRITE token works too.
- **Daily screening maximum: 30 names.** A full lane plan is about 30 registry lookups a name, so 900 lookups, about 5 minutes at 4 a second. That fits Render free and Neon free with room. The rest wait in arrival order.
- **Dedupe window:** 30 days (a later sender is added to the name's sources).
- **Drop lists:** DOM can't fetch one itself. No free, documented source allows it (SnapNames and similar sites are web pages without an API, and scraping is on DOM's "don't" list). A scout uploads daily, and `DROP_FEED_STALE` warns otherwise.
- **Jobs:** the steps `intakeScreening` and the existing `dropWatch` show in `GET /jobs/runs` and `/health`.

### Q-5. Part D, the path to lift the buy hold
The contract will hold this list; v2.13.0 adds `steps[]` to `GET /selection/buy-hold`, each with a status, evidence and who acts next (T12-21).
1. **Gavriel:** builds a fresh test set with `POST /selection/test-sets` (`new`, `bt1@v3` or `v2`), waits for it, and seals it.
2. **Dvir approves the method** by name ("sibling method bt1@v3 approved"). Gavriel posts it.
3. **Gavriel freezes the hold suite(s)** from the sealed set's test slice, with `gates_not_assessed` [tm_us, tn, hist2, hist2_guard] and `clears_hold: true`.
   - **Dvir's line must name:** the suite id, the four gates and the words "clears hold".
4. **Gavriel drafts the settings** (`v11` with the chosen method in force, `buy_hold: false`).
5. **Gavriel runs the holdout replay** of each hold suite on that draft. It must pass (sold accepted ≥ 70%, dropped rejected ≥ 75%, at least 50 per class, 0 leaking rows). A failure sticks.
6. **Dvir activates the draft** with a line naming its label. That lifts the hold. Nothing else ever does (T12-22, T12-23 as today).
7. **Production tranche (T12-24):**
   - **Gavriel** closes `accept-v2-probe-20261007`.
   - **Dvir** chooses the cap (DVIR), and Gavriel opens the production tranche with it.
   - **Gavriel** adds the names Dvir picks, then dry-runs `/buy` `dry_run: "strict"` and `/list`.

### Q-6. Part E, records per domain (v2.13.0)
- **Route:** `POST /candidates/{domain}/records` (WRITE) `{kind: tm_us|history, record (the same shape as today's manual record), checked_by}`.
- **Reuse:** a run of that domain uses the newest fresh record, with the same rules as today, and a manual row still never outranks an automated FAIL. Today's per-run route keeps working and also writes the domain record.
- **Freshness (constants):** `tm_us` **30 days**, `history` **180 days** (a past use doesn't change).
- **Automation (T12-29):** nothing new.
  - **US trademark:** USPTO has no free wordmark search API (CR-007 Q-8), and its search site isn't for automation.
  - **History:** stays manual by Dvir's decision.

### Q-7. Free plans
- **Daily load:** 30 intake names plus `dropWatch` (at most 3,000 lookups) plus the cohorts (at most 2,000) all run in the 03:05 IDT run. The worst case is about 20 to 30 minutes of paced lookups, within Render free. The service stays awake while the run works.
- **Database:** the rows are small. The evidence store is pruned by age.

### Q-8. Tests
- **Expected to pass:** T12-2 to T12-28.
- **Not built:** T12-1, as explained (the refusals are `.biz`, which refuses forever). Instead, `unknowns` explains every gap.
- **Part A's real lever is `bt1@v3` (DVIR).**
