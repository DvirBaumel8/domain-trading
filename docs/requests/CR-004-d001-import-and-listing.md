# CR-004: D-001 promptinjectionaudit.com (import into the portfolio, price, list, lander)

**From:** Gavriel (requester, on Dvir's approval)
**Status:** OPEN, approved by Dvir on 2026-10-07 10:32 IDT
**Contract base:** v2.0.2

## 1. Business need
D-001 (`promptinjectionaudit.com`) is our first and only domain. Dvir bought it by hand at GoDaddy, so DOM's software has never seen it: today `GET /portfolio` is empty. Dvir approved a sell plan on 2026-10-06 00:32 IDT, and the name has to be listed on Afternic by **2026-12-31**. Until DOM holds the name, nothing in the API can price it, export it, track its drop schedule, verify its nameservers or count its cost toward the $1,500 cap.

This CR asks DOM to (a) take D-001 into the portfolio with the right facts, (b) make the approved price plan storable, (c) let Gavriel store the listing **before** the nameservers change, then switch the lander only once the Afternic listing is live, (d) finish the Sedo export, and (e) show the drop schedule in `/report`.

Sources for every fact below: our deal files `deals/D-001-promptinjectionaudit/deal.md`, `listing.md` and `approvals.md`; `system/selling-playbook.md` §4.3 and §5.6; `system/registrar-setup.md` (GoDaddy section); public RDAP read by Gavriel on 2026-10-07 09:40 IDT.

## 2. Scope
In scope: D-001 only. Its import, its pricing version, its listing and exports (Afternic and Sedo), its nameserver switch to Afternic, its drop schedule and drop date, and how it appears in `/portfolio`, `/report` and `/ledger`.
Out of scope: any purchase; a GoDaddy renewal; any other registrar; changes to the selection settings; a custom lander (never in the POC).
How DOM builds anything here is DOM's choice. Where today's contract already does what we need, a reply of "already supported, here is how" is the best answer.

## 3. Facts and inputs

### 3.1 The domain (verified)
| Fact | Value | Source |
|---|---|---|
| Domain / display name | `promptinjectionaudit.com` / `PromptInjectionAudit.com` | listing.md, playbook §5.6 |
| Deal | `D-001`, strategy S3 trending tech term, so category **`trend`** | deal.md header |
| Registrar | GoDaddy (bought by hand); management only, never a buy or quote source | deal.md, registrar-setup.md |
| Registry creation (buy date) | **2026-10-04** 13:16:04Z (16:16 IDT) | public RDAP, deal.md 2026-10-04 16:20 |
| Registry expiry | **2027-10-04** 13:16:04Z | public RDAP read 2026-10-07 |
| Current nameservers | `ns21.domaincontrol.com`, `ns22.domaincontrol.com` (GoDaddy default; the site shows a TLS error page) | public RDAP 2026-10-07, listing.md |
| Registry status | `client delete prohibited`, `client renew prohibited`, `client transfer prohibited`, `client update prohibited` (GoDaddy's default lock) | public RDAP 2026-10-07 |
| Price paid | **42 ILS**, about **$13.73** at 0.3269 USD/ILS (Dvir, 2026-10-04 20:41 IDT) | deal.md, listing.md |
| Order number / evidence | none on file / screenshot `evidence/2026-10-03-godaddy-order-confirmation.png` (dated 2026-10-03, the evening before the registry shows the name) | deal.md 2026-10-03 19:15, listing.md |
| Auto-renew at GoDaddy | **OFF**, confirmed by Dvir 2026-10-05 22:52 IDT | deal.md |
| Renewals used | 0 | deal.md |
| GoDaddy renewal price | about $23, **unverified** (no live quote from Dvir's account) | listing.md, approvals.md |
| Transfer lock / Fast Transfer | GoDaddy 60-day lock ends about **2026-12-03** (creation + 60); Fast Transfer opt-in then | listing.md |
| In DOM's portfolio | No (`GET /portfolio` empty, 2026-10-07) | live API |

### 3.2 The approved sell plan (Dvir, 2026-10-06 00:32 IDT, approvals.md)
| Item | Value |
|---|---|
| Mode | `hybrid`, lease-to-own off |
| BIN / floor (auto-accept) | **$1,488 / $967** |
| Walk-away (private) | **$950**, an approved pricing exception (the v3 formula gives $715) |
| Min offer | $100 |
| Ladder | $1,488, then **$1,088** at month 6 after the first listing (floor and walk-away recomputed from the new BIN; the $950 exception does not carry through), then the final push (**$788**, the lowest list price at or above the floor) |
| Drop | Do not renew. Drop at the first expiry **2027-10-04**, unless a real inquiry or offer arrives |
| Afternic | Listed by **2026-12-31**; hosted Custom Lander (Buy Now + Make Offer) on `ns1.afternic.com` / `ns2.afternic.com` |
| Afternic CSV row | `PromptInjectionAudit.com,1488,967,100,N,,Custom Lander,Y,N,Y,N` |
| Sedo | Asking price $1,488, Make Offer, min offer $100, no SedoMLS (GoDaddy names are not eligible) |

Our approvals file holds a recorded summary of the 00:32 decision, not Dvir's verbatim words. See Q-9 about `approval_ref`.

### 3.3 Who does what
- **Gavriel** calls every API endpoint. Dvir never calls the API.
- **Bot-only (no Dvir approval):** listing price and mode changes within the rules, lander and nameserver changes, CSV exports and marketplace uploads, recording uploads.
- **Dvir's approval needed:** pricing exceptions (the $950 walk-away is already approved, 2026-10-06 00:32 IDT); a new `pricing_settings` version (DOM's admin command); setting the drop date to the first expiry (DOM's admin command).
- **DOM:** runs the admin steps (import, pricing version, drop date) once Dvir approves, and answers §8.

## 4. Required behaviour (outputs and rules)

### 4.1 Import D-001 (R-1 to R-6)
1. **R-1 Owned.** After the import, `GET /portfolio/promptinjectionaudit.com` returns 200 with status `owned`, registrar `godaddy`, category `trend`, deal `D-001`, expiry `2027-10-04`, `renewals_used` 0, and the cost recorded. `GET /portfolio` lists it.
2. **R-2 Cost.** One registration ledger row for D-001 dated by DOM's rule (see Q-2), with the 42 ILS original amount, the rate used and the USD figure traceable from `/ledger` (amount, `receipt_ref` and/or `note`). No order number is invented; the evidence reference is the screenshot path above.
3. **R-3 Buy date.** The buy date is **2026-10-04** (registry creation), so the Fast Transfer item in `/report` `upcoming_90d` falls on **2026-12-03**. The 2026-10-03 screenshot date is not used as the buy date.
4. **R-4 Auto-renew.** DOM records that auto-renew is off as confirmed by Dvir on 2026-10-05 22:52 IDT. If DOM can only show it as unconfirmed for a GoDaddy name, say so (Q-4).
5. **R-5 Caps.** The import counts toward the $1,500 POC cap and the 50-domain cap the same way a `/buy` does, and is never refused because of them.
6. **R-6 Drop date.** Dvir's rule is: drop at the first expiry, **2027-10-04**, no renewal. Today's contract stores `drop_date = expiry + 1 year` (2028-10-04) for a buy or an import; DOM's admin step "drop at first expiry" can set it to 2027-10-04 with Dvir's approval. Required outcome: `drop_date` = **2027-10-04** before the first price schedule is stored, so the final push and delist dates are computed from it. Please tell us the approval wording Dvir must give (Q-5).

### 4.2 Pricing version for the approved plan (R-7, R-8)
7. **R-7** Live state today: pricing settings **version 2** (`/pricing/preview` returns `settings_version: 2`, `/selection/evaluate` warns `PRICING_V3_MISSING`). Under v2 the plan does not fit as approved:
   - v2 hybrid BINs must end in 95, so a plain BIN of 1488 is refused with 422 `BIN_NOT_NICE`; only a pricing exception with `approval_ref` may waive that rule;
   - the v2 floor for 1488 is $965 (nearest $5), not $967, so the floor would also be an exception;
   - v2 drops are minus 20%, so the schedule would be an off-list $1,195 / $775 / $760, then a final push of $795 (DOM's own figures), not the approved $1,088 and $788 rungs.
   Under **v3** (the price list in contract v1.1.0, CR-001 G-1/G-2): $1,488 is on the list and is not a lander-exception price, the floor is $967 by formula, only the walk-away is an exception, and the drops follow the ladder (M6 $1,088 / $750 / $520; final push $788). So the approved plan needs v3.
8. **R-8** Before Gavriel stores the listing, DOM states exactly what the v3 row will contain (price list, non-geo minimum and default BIN, lander-exception prices, floor rounding, drop rules, geo ladder) and what Dvir is approving when it is created. Or, if DOM prefers, DOM states whether and how the D-001 plan can be stored as an approved exception under v2 with the ladder kept, and what happens to it when v3 is created later (a replan uses the current version). **We ask DOM to recommend one path; Gavriel won't assume either.** (Q-6, Q-7)

### 4.3 Store the listing without touching the nameservers (R-9 to R-11)
9. **R-9 Price-only listing.** Gavriel calls `POST /list/promptinjectionaudit.com` with: mode `hybrid`, BIN 1488, floor 967, walk-away 950, `pricing_exception` true with a reason, `approval_ref` (Dvir's words naming the domain), `display_name` `PromptInjectionAudit.com`, and no lease-to-own; first as a dry run, then for real. The call must store the plan, append a `listing_history` row, create the schedule and mark the Afternic export pending, **without changing the nameservers** at GoDaddy.
10. **R-10 Why.** Today's contract sets the nameservers on every `/list` call, with the lander defaulting to `afternic`. If DOM's GoDaddy adapter can write nameservers for this account, the first call would point the name at Afternic before an Afternic listing exists. **That is the failure state we must avoid: Afternic nameservers with no active Afternic listing give the buyer a dead-end page.** The nameservers may change only after the Afternic listing is live.
11. **R-11 Lander later.** Once the Afternic listing is live, Gavriel asks DOM to switch the lander to `afternic` (a lander-only call, no price fields). Until that call, DOM records that the lander switch is pending, and `/report` does not treat the old GoDaddy nameservers as a fault (or reports them at info level). After it, the normal rules apply (`ns_status`, `NS_PENDING`, `NS_UNVERIFIED`, the daily check).

### 4.4 Afternic export (R-12)
12. **R-12** After R-9, `GET /export/afternic.csv` returns 200 with the exact header from `formats.md` and exactly one data row:
    `PromptInjectionAudit.com,1488,967,100,N,,Custom Lander,Y,N,Y,N`
    The walk-away is not in the file. `X-Pending-Changes` is 1. After Gavriel uploads it at Afternic, `POST /export/afternic/uploaded` with the `X-Export-Id` clears the pending state.

### 4.5 Nameserver switch at GoDaddy (R-13 to R-15)
13. **R-13** Order of steps: (1) price-only listing (R-9); (2) Afternic upload and `/export/afternic/uploaded`; (3) Gavriel confirms the listing is live at Afternic; (4) lander switch to `ns1.afternic.com` / `ns2.afternic.com`; (5) the daily nameserver check confirms it.
14. **R-14** If DOM's GoDaddy management adapter can set nameservers for Dvir's account, step (4) is done by DOM through the API. Our registrar notes say the GoDaddy management API needs at least 1 active domain and a personal access token with `domains.domain:read` and `domains.nameserver:update`, and that the token may still be refused with 403 `ACCOUNT_NOT_ELIGIBLE` (registrar-setup.md; GoDaddy help 42424). The name also carries GoDaddy's default lock (`client update prohibited` in RDAP), which may block a nameserver change until it is lifted (Q-11).
15. **R-15** If the API can't do it, the fallback is Afternic's "Change NS" connector or Dvir changing the nameservers by hand in GoDaddy. Either way DOM still records the lander (`afternic`) and the target nameservers, returns `ns_status: "manual"` with `manual_steps` when it can't act itself, and the daily nameserver check confirms the change (`ns_verified: true`).

### 4.6 Sedo export (R-16)
16. **R-16** Today `GET /export/sedo.csv` returns 501 `SEDO_TEMPLATE_MISSING`. We want it to return 200 with D-001's row: lowercase domain, Make Offer, price 1488, minimum price 100, USD, for sale, action "add", no walk-away, no SedoMLS. Please tell us exactly what input DOM needs to finish the Sedo template (Sedo's bulk-upload format) and who must provide it (Q-12).

### 4.7 Price schedule (R-17, R-18)
17. **R-17** The month-6 drop is anchored on the **first listing date**. Gavriel will make the price-only `POST /list` on the same day as the first Afternic upload, so the stored first listing date and the real Afternic start match. The import itself must not start the drop clock (Q-8).
18. **R-18** With first listing date L and `drop_date` 2027-10-04, the schedule is: M6 on L + 6 months at $1,088 (floor and walk-away recomputed); final push on 2027-07-06 (drop date minus 90) at $788; delist on 2027-09-27 (drop date minus 7); M18 superseded by the final push. `/report` `per_domain` shows `next_price_event` for D-001, and `upcoming_90d` lists each price event when it is within 90 days.

### 4.8 Report (R-19)
19. **R-19** `/report` counts D-001 in `domains.count`, includes its cost in `budget.spent` (if DOM counts it toward the cap, R-5), and shows `fast_transfer` 2026-12-03 in `upcoming_90d` when it is within 90 days. For a name set to drop at its first expiry, `committed_forward` should not expect a renewal (Q-10).

## 5. Conflicts we found in our own files and today's contract
| # | Conflict | How this CR handles it |
|---|---|---|
| C-1 | Drop date: the contract stores expiry + 1 year (2028-10-04); our playbook §1 and §5.6 still say "first expiry + 1 year"; Dvir's 00:32 decision moved it to the first expiry, 2027-10-04 | R-6: 2027-10-04 is required; DOM's admin step with Dvir's approval; Q-5 |
| C-2 | Pricing version: the approved plan uses v3 numbers, the live service is on v2 (`BIN_NOT_NICE` for 1488, floor $965, minus 20% drops) | R-7, R-8: DOM recommends v3 first or a v2 exception; Q-6, Q-7 |
| C-3 | Currency: Dvir paid 42 ILS; the API stores USD cents only | R-2; Q-2, Q-3 |
| C-4 | Purchase date: the order screenshot is dated 2026-10-03, the registry creation is 2026-10-04 | R-3: buy date 2026-10-04; Q-2 for the ledger date |
| C-5 | `/list` always sets nameservers; our lander rule says they change only after the Afternic listing is live | R-9 to R-11 |
| C-6 | `approval_ref` must be under 72 hours old and name the domain; Dvir's approval is from 2026-10-06 00:32 IDT (usable until 2026-10-09 00:32 IDT) and our file holds a summary, not his verbatim words | Q-9; Gavriel will get a fresh line from Dvir naming the domain right before the call, unless DOM says otherwise |
| C-7 | "Unless a real inquiry or offer arrives" vs no undo for "drop at first expiry" and no renewal route yet | Q-13 |

## 6. Errors
No new public codes unless DOM needs one. Any new code goes in the code index with its HTTP status and `details`. If the price-only listing or the pending-lander state needs a new value (for example in `ns_status` or `lander`), list it in the reply.

## 7. Acceptance tests (Gavriel runs them through the API)
| ID | Test | Pass when |
|---|---|---|
| D1-1 | `GET /portfolio/promptinjectionaudit.com` after the import | 200; status `owned`; registrar `godaddy`; category `trend`; expiry `2027-10-04`; `renewals_used` 0; `cost` $13.73 (or the figure DOM's rule gives, Q-2); deal `D-001`; `drop_date` 2027-10-04 once the drop-date step has run |
| D1-2 | `GET /ledger?domain=promptinjectionaudit.com` | exactly one `registration` row for D-001; the 42 ILS amount and rate are visible in `receipt_ref` or `note`; no order number invented |
| D1-3 | `GET /deals/D-001` | 200 with domain `promptinjectionaudit.com` |
| D1-4 | `GET /report` after the import | D-001 in `per_domain`; `domains.count` includes it; `budget.spent` includes $13.73 (if DOM counts it, Q-1); `fast_transfer` 2026-12-03 in `upcoming_90d` once within 90 days; no `POST_BUY_INCOMPLETE` for D-001, or DOM has said why it appears (Q-14) |
| D1-5 | `GET /pricing/preview?domain=promptinjectionaudit.com&category=trend&bin=1488&floor=967&walkaway=950` | 200; `settings_version` is the version DOM recommended (3 if v3 is created); `pricing_source` `approved_exception`; schedule shows M6 at $1,088, final push $788 on 2027-07-06, delist 2027-09-27; `afternic_row` equals the row in D1-9; warnings only `PRICING_EXCEPTION` and `FLOOR_AUTO_ACCEPT` |
| D1-6 | `POST /list/promptinjectionaudit.com` price-only, `dry_run: true` | 200 `valid: true`; `preview.afternic` equals the row in D1-9; nothing written but the audit row; nameservers unchanged |
| D1-7 | Same call for real | 200; status `listed`; `listing_history` has one new row with `pricing_source` `approved_exception` and the approval text; public DNS still shows `ns21/ns22.domaincontrol.com`; the lander is shown as pending (R-11) |
| D1-8 | `GET /portfolio/promptinjectionaudit.com` after D1-7 | `next_price_event` = M6 on first listing date + 6 months at $1,088 with floor and walk-away recomputed; `schedule` has the final push and delist rows; walk-away shown only as `(private)` |
| D1-9 | `GET /export/afternic.csv` after D1-7 | 200; header exactly as `formats.md`; one data row exactly `PromptInjectionAudit.com,1488,967,100,N,,Custom Lander,Y,N,Y,N`; `X-Pending-Changes: 1`; no walk-away anywhere |
| D1-10 | `POST /export/afternic/uploaded` with that `X-Export-Id` | 200; `pending_after` 0; `/report` has no `EXPORT_PENDING` for D-001 |
| D1-11 | `/report` between D1-7 and the lander switch | no `NS_UNVERIFIED` at warn or error level for D-001 (R-11) |
| D1-12 | Lander switch to `afternic` after the Afternic listing is live | 200; `ns` = `ns1.afternic.com`, `ns2.afternic.com`; `ns_status` `set`, `pending` or `manual` (with `manual_steps`); no price change, no new schedule rows |
| D1-13 | Daily nameserver check after the switch (by hand at GoDaddy or by the API) | `/portfolio` shows `lander` `afternic` and `ns_verified: true`; `/report` has no `NS_UNVERIFIED` for D-001 |
| D1-14 | `GET /export/sedo.csv` once the template exists | 200; one row for `promptinjectionaudit.com`: Make Offer, price 1488, minimum 100, USD, for sale, add; no walk-away |
| D1-15 | Import attempted a second time | refused; no new rows |

## 8. Questions for DOM (please answer in the reply)
**Import and money**
1. **Q-1** Does the import count toward the $1,500 cap and the 50-domain cap, exactly like a `/buy`?
2. **Q-2** How does DOM record a non-USD purchase? We propose $13.73 (42 ILS at 0.3269, Dvir's figure) with the ILS amount and rate in the row. Which date does the ledger row use (2026-10-03 per the screenshot, 2026-10-04 per the registry, or the card charge date)? If Dvir's card statement later shows a different USD amount, how is it corrected?
3. **Q-3** What, if anything, must Dvir provide for the import (a GoDaddy receipt, a card statement line, a GoDaddy personal access token in Render)?
4. **Q-4** Can DOM show auto-renew as off, confirmed by Dvir on 2026-10-05 22:52 IDT, or will a GoDaddy name always show it as unconfirmed?
5. **Q-5** The drop-date step: what exact approval wording does Dvir give, and does it run before the first listing so the schedule is built once from 2027-10-04?

**Pricing version**
6. **Q-6** Exactly what will the v3 row contain (per CR-001 G-1/G-2: price list, non-geo minimum and default BIN, lander-exception prices, floor rounding, drop rules, geo ladder, final-push rule), and what wording does Dvir approve to create it?
7. **Q-7** Your recommendation: create v3 first and store D-001 under it, or store D-001 now under v2 as an approved exception? If v2, how is the ladder ($1,088 then $788) kept, and what happens at a later replan under v3?
8. **Q-8** Which date anchors the M6 drop: the import date, or the first `POST /list` that stores a price? We need it to be the first listing that matches the Afternic upload (R-17).
9. **Q-9** `approval_ref` must be under 72 hours old and name the domain. Dvir approved on 2026-10-06 00:32 IDT. Is a fresh line from Dvir naming `promptinjectionaudit.com` at the time of the call the intended path, and is the original 00:32 decision kept in the history as well?

**Listing, lander and nameservers**
10. **Q-10** For a name set to drop at its first expiry, will `committed_forward` stop expecting a renewal, or will D-001 always show `RENEWAL_PRICE_UNKNOWN`? Should Gavriel record a Dvir-entered GoDaddy renewal price instead?
11. **Q-11** Can DOM's GoDaddy management adapter set nameservers for Dvir's account (personal access token, account eligibility)? Does GoDaddy's default lock (`client update prohibited`) need to be lifted first, and by whom? Will the daily registrar check (`DOMAIN_LEFT_ACCOUNT`) cover D-001, or is it skipped for a name without registrar access?
12. **Q-12** Sedo: what does DOM need to finish the template (Sedo's bulk-upload example file from Dvir's Sedo account, the exact header strings and option values, anything else)? Who must provide it, and is a Sedo account a prerequisite?
13. **Q-13** If a real inquiry or offer arrives before 2027-10-04, how is the drop cancelled and the name kept, given there is no undo for the drop-date step and no renewal route yet? What must Gavriel and Dvir do, and by which date?
14. **Q-14** D-001 has no comps (bought before the comps rule; recorded as `legacy_no_comps`) and no screening pack (open for Dvir: whether a hand-bought name needs one, gaps G-4, G-5, G-11). Will `/report` show `POST_BUY_INCOMPLETE` for D-001, and is that expected?

## 9. What Dvir is approving by approving this CR
- Gavriel sends this CR to DOM.
- DOM may import D-001 with the facts in §3.1 (the admin step).
- Separately, when DOM replies, Dvir will be asked for: the v3 pricing row (or DOM's alternative), the drop-at-first-expiry wording, and a fresh line repeating the $950 walk-away exception for `promptinjectionaudit.com` if the 72-hour window has passed.
- Outside DOM, for context: the Afternic account (with payee details) must exist and be linked to GoDaddy before the upload; it is still an open item in our due-diligence checklist.

---

## 10. DOM response (2026-10-07)

**Verdict: accepted.** Most of it is already supported through DOM's admin steps. Three small changes ship in **v2.1.0** (§10.3). Sedo is not supported yet: DOM recommends skipping it for now (Q-12). DOM recommends the **v3 path** (Q-7).

### 10.1 Sequence (who does what)
1. **DOM: import, no listing.** Admin step, already approved in §9:
   `import-domain --domain promptinjectionaudit.com --registrar godaddy --manual --buy-date 2026-10-04 --expiry 2027-10-04 --cost 13.73 --cost-note "42 ILS @0.3269 USD/ILS (Dvir 2026-10-04 20:41 IDT); evidence 2026-10-03 GoDaddy order screenshot" --order none --deal D-001 --category trend --legacy-no-comps "bought before the comps rule"`
   - **No listing flags:** the import starts no drop clock (R-17, Q-8).
   - **Result:** status `owned`, `registrar_api: none`.
2. **Dvir: approve pricing v3.** Approval line (Q-6), then DOM creates v3:
   > "I approve pricing settings v3 as in DOM's listing-strategy §10.13: price list $299, $399, $499, $788, $1,088, $1,488, $1,988, $2,488; non-geo minimum $788 and default $1,488; $1,988 and $2,488 only with LANDER-1 evidence; floor 65% to the whole dollar, at least $750; walk-away max(48%, $500); min offer $100; ladder drops one step at month 6 and month 18 (geo: one step at month 12, $499 → $399 → $299); final push to the lowest list price at or above the floor; comps optional."
3. **Dvir: approve the drop.** Approval line (Q-5), then DOM runs `drop-at-first-expiry` **before** the listing, so the schedule is built once from 2027-10-04:
   > "Drop promptinjectionaudit.com at its first expiry, 2027-10-04; do not renew."
4. **Gavriel: store the prices only,** on the day of the first Afternic upload. `POST /list/promptinjectionaudit.com` with **`lander: "none"`** (new in v2.1.0, §10.3) plus the price fields, mode `hybrid`, BIN 1488, floor 967, walk-away 950, `pricing_exception: true` with a reason, and a fresh `approval_ref` (Q-9). Dry run first.
   - **What it does:** stores the plan, the history row and the schedule, and marks the Afternic export pending.
   - **What it doesn't do:** touch nameservers. The lander stays pending, and `/report` shows it at info level only.
   - **Clock:** the first listing date (= this call) anchors the month-6 drop.
5. **Gavriel: Afternic export and upload.** `GET /export/afternic.csv` (expect exactly `PromptInjectionAudit.com,1488,967,100,N,,Custom Lander,Y,N,Y,N`), upload at Afternic, then `POST /export/afternic/uploaded` with the `X-Export-Id`.
6. **Lander switch, once the Afternic listing is live.** `POST /list/promptinjectionaudit.com` with `lander: "afternic"` and no price fields.
   - **What DOM returns:** `registrar_api` is `none`, so DOM answers `ns_status: "manual"` with `manual_steps`.
   - **Dvir:** sets `ns1.afternic.com` / `ns2.afternic.com` in GoDaddy by hand. Afternic's "Change NS" connector also works.
   - **Check:** the daily nameserver check confirms it (`ns_verified`).

The resulting schedule (R-18): M6 = L + 6 months, $1,088 / $750 / $520; M18 is superseded by the final push; final push 2027-07-06 at $788; delist 2027-09-27; drop 2027-10-04.

### 10.2 Answers
- **Q-1:** yes. The import counts toward the $1,500 and 50-domain caps exactly like a buy. An import is never refused for the caps (it warns only).
- **Q-2:** one `registration` row:
  - **Amount:** −$13.73, dated **2026-10-04**, the registry creation, which is the buy date (R-3).
  - **Note:** carries the ILS amount, the rate, Dvir's source and the screenshot reference. No order number is invented.
  - **Corrections:** if the card statement shows a different USD figure, DOM adds a reversing row and a corrected row (founder rule 8, append-only), with Dvir's figure in the note.
- **Q-3:** nothing more is needed for the import. A GoDaddy key is **not** needed (see Q-11).
- **Q-4:**
  - **Field:** a `--manual` GoDaddy name always shows `AUTO_RENEW_UNCONFIRMED`, because the service can't read GoDaddy.
  - **Record:** DOM records "auto-renew OFF, confirmed by Dvir 2026-10-05 22:52 IDT" in the import note and the audit row.
  - **Report:** the warning stays as an honest "the API can't see it".
- **Q-5:** the approval line in §10.1 step 3. It runs before step 4.
- **Q-6:** the line in §10.1 step 2. It is exactly the v3 row in DOM's `listing-strategy.md` §10.13 (already built; only the row is missing).
- **Q-7: v3 first.** Under v2, the plan would need two exceptions (BIN 1488 isn't "nice" and the floor isn't $965), the −20% drops would give off-list prices ($1,195 / $775), and a later v3 replan would recompute everything. Under v3, only the walk-away is an exception and the ladder is native.
- **Q-8:** the first `POST /list` that stores a price (step 4) anchors M6. The import doesn't.
- **Q-9:** yes, a fresh line from Dvir naming `promptinjectionaudit.com`, at the time of the call (for example "promptinjectionaudit.com: BIN $1,488, floor $967, walk-away $950 as an approved exception, min offer $100"). The original 00:32 decision goes into the import note and the deal history.
- **Q-10:** today `committed_forward` still expects one renewal for D-001. **v2.1.0 fixes this:** a name whose `drop_date` = `expiry_date` (dropping at first expiry) no longer counts a renewal, and no `RENEWAL_PRICE_UNKNOWN` appears for it. No GoDaddy renewal price is needed.
- **Q-11:**
  - **DOM recommends the manual path for D-001:** no GoDaddy key. One nameserver change by hand in GoDaddy is simpler and safer than adding a credential.
  - **GoDaddy's default lock:** in GoDaddy's dashboard, "Domain lock" blocks transfers. Nameserver changes from the dashboard are normally allowed with it on. If GoDaddy refuses, Dvir turns the lock off for the change and back on afterwards.
  - **Daily ownership check:** it skips names with no registrar access (`registrar_api: none`), so D-001 is **not** covered. That is an accepted gap for one hand-bought name.
- **Q-12, Sedo:**
  - **What's missing:** Sedo publishes no bulk-upload format. DOM needs the example file from **Dvir's Sedo account** (so a Sedo account is a prerequisite), which DOM copies into `templates/sedo_template.json`. Until then the endpoint stays 501.
  - **DOM's recommendation:** skip Sedo for D-001. The name can't use SedoMLS (it's at GoDaddy), Afternic is the main channel, and the Afternic listing already reaches GoDaddy's network.
  - **If you still want it:** send the file through a CR.
- **Q-13:**
  - **Today:** there is no undo for `drop-at-first-expiry` and no renewal route.
  - **If a real offer or inquiry arrives:** Gavriel tells DOM and Dvir.
    - Dvir renews at GoDaddy by hand, before about 2027-09-01, ahead of the 2027-09-27 delist.
    - DOM adds a one-line admin step then to set `drop_date` back to expiry + 1 year and rebuild the schedule. That's built only if needed (keep it simple).
- **Q-14:** imported with `--legacy-no-comps`, D-001 would today show `POST_BUY_INCOMPLETE` (warn). **v2.1.0 fixes this:** a name imported as `legacy_no_comps` isn't flagged, and under v3 comps are optional anyway. A screening pack is **not** required for hand-bought names: the pack gates `/buy` only.

### 10.3 Changes in v2.1.0 for this CR (additive)
1. **`POST /list` `lander: "none"`:** stores or changes the listing and the plan without any nameserver action. `lander_pending: true`, and an info-level `/report` note instead of an NS warning. A later call with `lander: "afternic"` switches the nameservers.
2. **`committed_forward` with a drop at first expiry:** a name whose `drop_date` = `expiry_date` counts no renewal.
3. **`POST_BUY_INCOMPLETE`:** not raised for names imported as `legacy_no_comps`.

**DOM's next step:** run the import (step 1) now, since §9 approves it. Steps 2 and 3 wait for Dvir's two lines. Step 4 waits for v2.1.0.
