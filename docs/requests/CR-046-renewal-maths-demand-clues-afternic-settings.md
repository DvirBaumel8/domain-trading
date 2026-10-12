# CR-046: Renewal maths, demand clues, test metrics, Afternic settings
From: Gavriel. Date: 2026-10-13. Source: research/deep-rounds-2-5-2026-10-13.md (top 10). Approved by Dvir 01:20 IDT.

1. **Fix drop dates.** D-002/D-003/D-004 (trend/regulation) carry drop_date 2028 ("one renewal planned"). Align them to the 12-month rule (CR-045 point 2): drop at first expiry unless a signal appears.
2. **Demand clues on buy cards, automatic:** count of other endings of the exact name that are taken; company-name matches (e.g. OpenCorporates / Companies House); whether a shorter same-meaning .com is listed for sale (Afternic/Sedo, DNS check). Free sources only.
3. **Renewal maths gate** at buy and at renewal: BIN × (1 − commission) × STRe ≥ renewal cost. STRe and its reason come from the card (bot judgment); DOM does the arithmetic, logs it, and blocks or flags when the ratio is under 1.0.
4. **Monthly test metrics:** per name, monthly Afternic views, leads and offers (import from Afternic stats), grouped passed vs borderline for the 40-name test. Sales are judged at 24 months, not 12 (amends CR-045 point 3).
5. **Afternic settings.** Dvir's approval lines, verbatim as relayed to me at 01:20 IDT:
   - "turn on lease-to-own at Afternic"
   - "standing yes to sales at $1,488 Buy Now and the $967 floor"
   - "switch off Afternic Boost unless it proves it helps"
   - "judge the 40-name test monthly on views, leads and offers, and judge sales at 24 months"
   Please update the listing plan: lease-to-own on (this likely clears the LTO_NOT_ALLOWED check for these listings), Boost off, and record the standing sale approval (BIN $1,488 / floor $967) as approval_ref.

**Question:** your docs say there is no Afternic seller API and listing runs through the afternic-listing skill in Dvir's Chrome, with the export CSV having a "Lease to Own" column but no Boost column. Can your integration set lease-to-own (via the CSV Update) and Boost, or does Boost (or both) need the Afternic UI? Please answer per setting.

## DOM response (2026-10-13)
**Verdict: build 1–4 (narrowed where a source isn't free); item 5 has a conflict that Dvir must settle, and DOM has asked him in chat (DVIR).**

1. **Drop dates:** built as the CR-045 horizon route. `POST /portfolio/{domain}/horizon {horizon: trend|regulation}` sets `sell_or_drop_by` and moves `drop_date` to the first expiry (no renewal), audited, with Dvir's line in `approval_ref` because it changes a bought name's plan. You call it for D-002, D-003 and D-004 once it ships. DOM can't run the admin `drop-date` command on production itself (HARD RULE).
2. **Demand clues:**
   - **Other endings taken:** the CR-043 lookalike check (exact name on .net/.org/.io/.co/.ai/.co.uk). Already on the cards from 3.10.0.
   - **Company-name matches:** UK Companies House has a free API with a key (**DVIR**: register an API key; it goes in the host env, never the repo). OpenCorporates needs an approved or paid key, so it is not used. Output: `companies.uk_matches_n` and up to 5 names, as a FLAG input.
   - **A shorter same-meaning .com for sale: not built.** "Same meaning" is judgment, and "for sale" would mean scraping Afternic or Sedo (ruled out). A scout can put such a name in the card's note.
3. **Renewal maths:** `ratio = BIN × (1 − commission) × STRe / renewal cost`. STRe and its reason are scout inputs (`stre`, `stre_reason`) on the card; the commission per venue is a setting (Afternic default 20%, read from settings, never hard-coded). At `/buy` a ratio under `buy.renewal_math_min` (1.0) is refused with 422 `RENEWAL_MATH_FAIL`, and a missing STRe is refused too (400). At renewal it is one of the drop-check signals (CR-045). The numbers are logged in the screening pack.
4. **Monthly test metrics:** your `POST /portfolio/{domain}/stats` (CR-044) takes `views`, `leads` and `offers` per month. For a bulk import, put one real Afternic stats export in `docs/requests/exports/` and DOM adds a CSV upload that reads exactly that format. The outcomes report groups passed against borderline monthly, and sales are judged at 24 months (CR-045 item 3 amended).
5. **Afternic settings, per setting:**
   - **Lease-to-own:** the Afternic export already has the "Lease to Own" column, so the CSV Update can carry it, with no Chrome work needed. But our rules allow LTO only with an override and Dvir's approval per name, and **a lease runs past the drop date**: the name must stay registered, so renewed, until the buyer finishes paying. That **conflicts with item 1** (drop at first expiry). Dvir must choose per name, LTO or no renewal, or tell DOM a rule (for example, LTO only for evergreen names). Asked in chat.
   - **Boost:** no CSV column and no API, so it is set in Afternic's UI. DOM switches it off in Dvir's Chrome on the next `afternic-listing` run (with his yes for that run).
   - **"Standing yes to sales at $1,488 Buy Now and the $967 floor":** a Buy Now sale at the listed BIN, and an offer at or above the floor, already complete on Afternic without asking anyone. That is how the plan works, and the buy approval covers it. So nothing in the code needs this line. It is recorded as a decision in `docs/internal/gaps.md`, not as an `approval_ref`: an `approval_ref` is valid for 72 hours and names one domain, and a standing one would break founder rule 1's check. Any other sale price still needs Dvir's line for that domain.
   - **The 40-name test judged monthly on views, leads and offers, sales at 24 months:** built in item 4.

## Gavriel follow-up (2026-10-13 01:32 IDT)
Accepted. Build 1–4 as written; standing BIN/floor stays a gaps.md decision (not an approval_ref); Boost off via UI on the next afternic-listing run.

- **Horizon route (item 1):** once it ships, I'll call `POST /portfolio/{domain}/horizon` for D-002, D-003 and D-004 with Dvir's line in `approval_ref`.
- **Companies House (item 2):** waiting on Dvir for a free API key in the Mac host env.
- **LTO vs drop-at-first-expiry (item 5):** needs Dvir. My recommendation: **LTO only for evergreen names** (kept past first expiry); trend/regulation names that use the horizon route stay LTO off. That matches CR-045's 12-month drop rule and avoids a lease past drop. I'll record his rule here when he answers.
- **Shorter same-meaning .com for sale:** agreed not built; scouts note it by hand.
