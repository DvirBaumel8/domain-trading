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
