> Status: DOM: G-1/2/3/6/8/9/10 in v3.7.0; G-4/5 later; G-7 DVIR. Sent by Gavriel. No money, no cap or founder-rule change, no paid service. G-7 needs **DVIR** (it touches guarantee 9).

# CR-033: findings from the first live end-to-end buy (ukcbamcompliance.com, aievalsconsulting.com)
| Field | Value |
|---|---|
| CR id | CR-033 |
| From | Gavriel (customer), on behalf of Dvir |
| Date | 2026-10-09 15:10 IDT |
| Priority | G-1, G-2, G-8: **P1** (they affect the two names in the next 24 h). Others: P2 |
| Based on | Live API v3.6.0: two real small buys (15:00:47, 15:01:03 IDT), `/portfolio/{d}`, `/report`, `/ledger`, `/audit`, `/deals/D-002`, `/deals/D-003`, `/tranches`, a manual `tick` (run_1bc285b2), `GET /export/afternic.csv` (exp_04ef46ad-2e8b-48c7-b574-45e6972d19d9, not uploaded yet), `/list` dry runs. Outside DOM: Verisign RDAP, Porkbun RDAP, Google DNS, HTTPS to each name. No src/ or tests/ read. |

Dvir asked that this first run be treated critically. The buys themselves worked: both 201, the right price, privacy on, Afternic NS set and visible in public DNS within a minute, the ledger and audit correct, and the buy hold untouched. These are the gaps.

## G-1 New names stay `NS_UNVERIFIED` until the next night (P1)
- At 15:01 IDT Google DNS already returned ns1/ns2.afternic.com for both names. `/report` still shows `NS_UNVERIFIED` for both, and `ns_verified: false`. A manual `tick` at 15:03 skipped `nsVerifier`: "already ran today (IDT)". The once-per-24-h limit is global, so a name bought after 03:05 waits up to 24 h.
- **Ask:** `nsVerifier` always checks a name that has never been verified (or whose lander changed since its last check), whatever the daily limit. Better still, `/buy` and `/list` mark `ns_verified` when their own public-DNS check (`ns_public: match`) already matches.
- **Acceptance:** a manual `tick` right after a buy whose NS are public clears `NS_UNVERIFIED` for that name.

## G-2 `/buy` can't set the display name, so the Afternic file shows lowercase names (P1)
- The export has `ukcbamcompliance.com` and `aievalsconsulting.com`, while D-001 shows `PromptInjectionAudit.com`. Capitalisation matters on a for-sale page. Today it takes an extra `POST /list` after the buy (the dry runs with `UKCBAMCompliance.com` / `AIEvalsConsulting.com` are valid).
- **Ask:** an optional `display_name` in `/buy` (stored with the listing). When it's missing, a default built from the intake `words` the scout sent (each word capitalised, an acronym word kept upper case when the scout marks it so), shown in the dry run.
- **Acceptance:** a dry-run `/buy` with `display_name` shows it in `proposed_listing`, and the next export uses it.

## G-3 Small-buy usage can't be read (P2)
- After the buys there is no read of the weekly cap: `/report` has no section (declined in CR-030), and a dry run of an owned name stops at `ALREADY_OWNED_OR_PENDING` without `small_buy`. We had to compute $22.16 of $50 by hand.
- **Ask:** one read-only field, for example `small_buy: {cap_cents, spent_7d_cents, remaining_cents, next_freed_at, purchases: [domain]}` in `GET /selection/buy-hold` (or `/health`).
- **Acceptance:** it shows 2216 spent and 2784 remaining after these two buys, and frees on 2026-10-16 15:00 IDT.

## G-4 The tranche doesn't show what was really bought (P2)
- `/tranches` shows `committed $22.16` both before the buys (estimates) and after them (actual purchases), with no way to tell the two apart. Members have no purchase id or state.
- **Ask:** per member `purchase: {id, state, cost_cents} | null`, and tranche totals `spent_cents` (succeeded) next to `committed_cents` (estimates of members not yet bought, plus open purchases).

## G-5 Lane and strategy are lost at the buy (P2)
- `/deals/D-002` and `/deals/D-003` have `strategy: null`. `per_domain` has only `category` (`regulation`, `trend`). The tranche knows the lanes (S6, S3), but the domain doesn't. Reports by lane (S3 vs S6) can't be built from the portfolio. This overlaps CR-029 QC-2.
- **Ask:** store `lane` on the domain and `strategy` on the deal at `/buy`, from the tranche member (or the latest screening run), and show them in `per_domain`, `/portfolio/{d}` and `/deals/{id}`.

## G-6 Privacy and auto-renew rest only on the buy's own answer (P2)
- `post_buy` says `privacy: on`, `auto_renew: off`. Privacy can be checked from outside (Porkbun RDAP shows "Private by Design, LLC"), but auto-renew can't: bots hold no registrar keys, by design. A later change in the Porkbun dashboard (auto-renew switched on, NS changed) would go unnoticed until a surprise charge.
- **Ask:** the daily `registrarCheck` re-reads, per Porkbun name, `auto_renew`, `privacy` and the NS from the registrar API (read-only). Store `registrar_state: {auto_renew, privacy, ns, checked_at}` in `/portfolio/{d}`, and raise a `/report` error `AUTO_RENEW_ON` (or a warning `REGISTRAR_DRIFT` for privacy or NS) when it differs from the plan.
- **Acceptance:** after the next daily run, both names show `auto_renew: off, privacy: on, ns: [afternic pair]` with a `checked_at`.

## G-7 The prepaid balance can't be reconciled (P2, **DVIR**)
- Dvir added $26 today. Both names cost $11.08, so the balance should be about $3.84, but nobody can confirm it: DOM never returns a balance (guarantee 9), and bots have no Porkbun login. The next small buy fails at the registrar with `REGISTRAR_FUNDS` only when it's tried.
- **Ask (needs Dvir's OK, since it touches guarantee 9):** no amount, only a level: `/health` `registrar_funds: {porkbun: "ok"|"low"|"unknown"}` with "low" below a setting (default $11.08, one .com), plus a `/report` warning `REGISTRAR_FUNDS_LOW`. Alternatively Dvir sends a screenshot after each top-up.

## G-8 The daily web check will flag the new names as down before they are listed at Afternic (P1)
- HTTPS to both names fails with TLS "unrecognized name": Afternic serves no page for a name that isn't in an Afternic account yet. D-001 answers 200 with its `/lander` redirect. The 03:05 `portfolioCheck` will raise `LANDER_DOWN` for both, and an **error** from the second day, although nothing is broken in DOM. The real cause is the pending Afternic upload (CR-032).
- **Ask:** while a name's Afternic export was never confirmed (`export.afternic.last_confirmed_upload_at` null), report `LANDER_AWAITING_MARKETPLACE` (info) instead of `LANDER_DOWN`, and start the `LANDER_DOWN` clock at the first confirmed upload.
- **Acceptance:** tonight's `/report` shows the info code for both names, and no `LANDER_DOWN` until 24 h after the upload is confirmed.

## G-9 The drop policy isn't stated on the buy card (P2, question)
- D-001 drops at first expiry (Dvir's choice). The two new names got `drop_date` 2028-10-09 (one renewal planned), so `committed_forward` rose to $22.16. That is the documented default, but neither the dry run nor the 201 says it in words, and Dvir approved "a small buy at up to $11.08" without seeing the renewal part.
- **Ask:** add `drop_policy: "after_one_renewal" | "at_first_expiry"` and the committed renewal cost to the dry-run and 201 bodies (and to `sell_plan_line`), so the buy card shows it, plus an optional `/buy` field to choose `at_first_expiry` at buy time.

## G-10 Comps (docs) (P2)
- Both buys went through with `pricing_evidence.comps: []`, and no `POST_BUY_INCOMPLETE` was raised. `endpoints.md` still says 2–3 comps are required "in v1.0.0" (the count comes from the current pricing settings). Please state the current required count, and whether an empty list is intended under pricing v3.

## For the CR-032 run (not an ask here)
- Export to upload: **exp_04ef46ad-2e8b-48c7-b574-45e6972d19d9** (3 rows: aievalsconsulting.com, PromptInjectionAudit.com, ukcbamcompliance.com). If G-2's display names are set first, generate a fresh export and upload that one instead. Confirm only the export that was really uploaded.

## DOM response (2026-10-09)
Thanks for the critical run.
- **G-1 (v3.7.0):** `nsVerifier` always checks names never verified (or whose lander changed), even after the day's run.
- **G-2 (v3.7.0):** optional `display_name` on `/buy`. Without it, the default comes from the scout's `words`, each capitalised. For the two names already bought, set the display name now with `POST /list` (your valid dry runs), then make a fresh export.
- **G-3 (v3.7.0):** `GET /selection/buy-hold` adds `small_buy {cap_cents, spent_7d_cents, remaining_cents, next_freed_at, purchases}`.
- **G-4, G-5: later.** They help reporting, not today's buy or sell decisions. Lane on the domain comes with the reporting cleanup (with CR-029 QC-2).
- **G-6 (v3.7.0):** the daily `registrarCheck` reads auto-renew, privacy and NS from Porkbun (read-only). `/portfolio/{d}` shows `registrar_state`; `/report` raises the error `AUTO_RENEW_ON` and the warning `REGISTRAR_DRIFT`.
- **G-7: DVIR.** Guarantee 9 says DOM never returns a balance. DOM's recommendation is a level only (`ok` / `low` / `unknown`, low below one .com), never an amount, as you propose. It's Dvir's call; until then, a screenshot after each top-up.
- **G-8 (v3.7.0):** `LANDER_AWAITING_MARKETPLACE` (info) until the first confirmed Afternic upload; the `LANDER_DOWN` clock starts there.
- **G-9 (v3.7.0):** the dry run and 201 show `drop_policy` and `renewal_committed_cents`, and `/buy` takes an optional `drop_policy: "at_first_expiry"`.
- **G-10 (docs):** under `pricing_settings` v3, `comps_min` is 0. An empty comps list is intended and comps are optional (since 7 Oct). The contract text gets fixed in v3.7.0.
