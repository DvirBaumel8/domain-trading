# AI Visibility Check: paid-report pipeline, bugs found by the mock run (26 Nov 2026)
Repo: DvirBaumel8/domain-trading @ 26e24aaa, folder ai-visibility-check/. Line numbers are for that commit.
Run: real site server (local, orders in a temp folder) -> real Polar-style signed webhook -> real `aivis order --mode paid`
with the 4 real paid provider classes, talking to a local fake of the OpenAI / Perplexity / Gemini / Claude APIs. $0, no keys.

## Pipeline as it actually is
1. POST /api/intake (site/server.py:226 new_order) saves orders/ORD-*.json (paid:false).
2. Polar `order.paid` webhook (server.py:195 handle_polar) matches by metadata.order_id or buyer email, sets paid:true.
3. NOTHING runs the report automatically. A human/bot must run `python -m aivis order --intake <order.json> --mode paid` on a machine with
   AIVIS_ALLOW_PAID=1 + 4 API keys (+ roster CSV for non-NPPES trades), then make the PDF, then send the email by hand.

## BLOCKERS (a paying customer would get a wrong report)
1. **Trades without a register get false "official register" claims, and an empty competitor list.**
   - engine/aivis/audit.py:28 `has_register = bool(niche.npi_taxonomy) or bool(roster_names)`; order.py:130-133 puts the buyer's competitors into `roster_names`,
     so any plumber/hvac/etc. order that lists even one competitor is treated as "checked against a register".
   - Result (plumber, 1 competitor): "16% of named businesses matched an official register" and "946 of 1124 names did not match any practice in the
     official register for Columbus, OH" (report_pro.py:88-89, 113-117). Method footer says "every business name is checked against official registers" (report_pro.py:128-129).
   - Without competitors: "Who AI recommends instead" table is EMPTY and KPI says "0 local competitors named instead" while 1,014 names were named
     (score.py skips every unverified mention; report_pro.py:104-107 lists only verified ones). 13 of the 15 niches have no NPI taxonomy (niches.py), so the headline section is blank for them.
   - Fix: has_register only from npi_taxonomy; for no-register trades count/list unverified names as "named by AI" (clearly labelled), and never print the register wording.
2. **City check accepts non-US cities.** order.py:67 `[^,]+,\s*[A-Z]{2}` and server.py:259 accept "Tel Aviv, IL" (IL = Illinois). The run then queries the US NPI
   registry for "Tel Aviv, IL" and the report says "1164 of 1224 names did not match any practice in the official register for Tel Aviv, IL", competitor table empty,
   no warning. Fix: whitelist the 50 US state codes at both places (and DC), reject everything else with a clear message at intake.
3. **Paid engine runs for an unpaid order.** `Order.from_dict` (order.py:57-60) drops the `paid` / `paid_at` fields; cmd_order (__main__.py:137-153) never checks them.
   Mode paid spent the full estimate ($5.88) on an order with paid:false and no paid_ref. Fix: refuse unless order JSON has paid:true (override flag for ops).
4. **All AI engines down -> a "0 out of 100" report is produced and written.** audit.py:36-41 only collects errors. With 0 answers, report says "0 AI answers",
   "Engines: ." (report_pro.py:97), an empty table, score 0, and the log shows 125 errors. Customer would be told they are invisible. Fix: if answers == 0, or any
   paid engine returned 0 answers, raise and write no report.
5. **One engine failing silently drops that engine from the report.** OpenAI always 401 / Gemini returns bad JSON: report built from 3 engines, no notice (report_pro.py:97 just lists the
   engines that answered), score changed (22 vs 26, 30 vs 26). Customer paid for 4. Fix: require every selected engine to reach a minimum answer count (e.g. 80%), else stop and tell the operator.
6. **Failed calls are billed against the cap.** paid.py:49 `budget.charge()` runs BEFORE the request, so failed 401/500 calls still use up the budget estimate
   (all-down case "spent" $3.23 for 0 answers). Only cosmetic for real money, but it can make a retry hit the cap. Fix: refund on exception.

## MAJOR
7. **Error cut-off does not stop the run.** audit.py:40-41 `break` leaves only the inner `repeats` loop, so after 10 errors the code still tries every remaining prompt
   (35 errors in the 401 test, up to 60). Fix: stop the provider (break both loops, or set a flag).
8. **Own name counted as a competitor.** Buyer competitor "drainmaster" / "DRAINMASTER LLC" for target "DrainMaster": both show as competitors with 26% share each (order.py:130-133 dedupes only on exact lower-case text; the target is not matched fuzzily). Fix: drop any competitor that match_name()s the target.
9. **Website without "https://" is silently ignored.** order.py:127 -> signals.py:97 `Request("drainmasterohio.com")` raises ValueError, returns fetched=False, and reasons.py skips all
   site findings. The report looks complete but has no robots/schema/city findings. server.py:231 stores the website unvalidated. Fix: prefix https:// when the scheme is missing; surface `signals.error` to the operator log.
10. **Fix list is generic and always 2-3 items** when the site is fine or no site is given (reasons.py:35-69): "AI engines cite trade sites..." and "Few independent mentions..." are the same text for every order, and the "evidence" line cites sources that are not about this business. Review counts are never passed (order.py:135 omits target_reviews/competitor_reviews), so the reviews finding can never appear.
11. **No delivery path.** Report is only report.html under `--out`; no PDF step, no upload, no email, no status page. Orders sit in private repo; nobody is alerted (ORDER_ALERT_WEBHOOK_URL unset).
12. **Payment email must equal intake email.** handle_polar (server.py:206-216) matches on the Polar customer email only (no custom field/metadata). If the buyer pays with another email the webhook is "unmatched" forever (alert goes to a log only).

## MINOR
13. paid.py model names are unverified live (`gpt-5-mini`, `sonar`, `claude-haiku-4-5`; gemini-3.8-flash does exist in Google's pricing page today). First real call may 404. Do one 1-call smoke test per engine before the first real order.
14. Gemini 3.x Google-Search grounding is NOT available on Gemini's free tier through the API (pricing page, Nov 2026), so the gemini engine cannot be tested for free with search.
15. Report shows "0 local competitors" / empty tables with only a header when nothing verified (report_pro.py:104-107): hide the section or print "none found".
16. Numbers in the KPI "N of M business names" count every mention, not distinct names (1,190 "names" from 240 answers) - wording should say "mentions".
17. The existing QA claims that run_order never passes website signals / evidence never rendered are OUT OF DATE for this commit: signals ARE passed (order.py:127,135) and evidence IS rendered (report_pro.py:122).

## What worked (no bugs)
- Tests: `python3 -m pytest -q tests` = 22 passed.
- Intake -> signed webhook (whsec_ key) -> paid:true, both orders (pay after intake, pay BEFORE intake). Bad signature path not re-tested (covered by repo tests).
- Paid gate: refused when AIVIS_ALLOW_PAID unset, when a key is missing (names only), when the estimate $5.88 exceeds the cap ($3).
- All 4 real provider classes parsed the vendor-shaped JSON (60 answers each, 240 per order, $5.88 estimated = spent), 0 crashes, report.html + answers.json + order-log.json written.
- HTML escaping of a hostile business name OK; no "nan/None/{}/TODO" text in any report.
