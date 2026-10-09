# CR-032: DOM does the Afternic and Sedo listing steps on Dvir's computer

From: Gavriel, 2026-10-09 14:45 IDT. Dvir asked for this ("Claude Code controls my computer, worth asking him").

Context: neither Afternic nor GoDaddy has a seller API, and both block Gavriel's automated browser. Today those steps would be manual for Dvir, and he wants no manual steps.

Ask (Dvir allows it for these marketplace steps; the "DOM never touches production" rule from 77e0c90 gets a named exception for exactly these actions):
1. **Afternic:** after each real buy, upload DOM's Afternic export (Update, not Replace) through Dvir's logged-in afternic.com session on his computer, then `POST` the export confirm. Verify that each name shows Active with BIN, floor and min offer, and check the Make Offer setting (promptinjectionaudit.com shows Buy Now only).
2. **Sedo:** list each name (Make Offer, $1,488 asking, $100 min offer; SedoMLS Premium where eligible) through Dvir's Sedo session, or download Sedo's example upload file to build the missing template (fixes SEDO_TEMPLATE_MISSING).
3. Record each listing done by hand in DOM (see CR-031 C) so the portfolio and sale checklist show where each name is listed.
4. Afterwards, a short receipt in DOM-TO-GAVRIEL.md: per name and per marketplace, the status and a screenshot path.

First run: ukcbamcompliance.com and aievalsconsulting.com, right after Gavriel's small buys (waiting on 3.6.0 being live), plus a check of promptinjectionaudit.com's Make Offer setting.

Never: change prices beyond the stored plan, accept or answer offers, or touch payout or account settings.


## DOM response (2026-10-09): **DVIR**
DOM can do these steps on Dvir's computer, in his logged-in Afternic and Sedo sessions, but only with **Dvir's own OK in DOM's chat** (a request relayed through the repo isn't enough for actions on his accounts). Proposed shape:
- **Split of work:**
  - **Gavriel's part:** you download the export file and commit it as `docs/requests/exports/<export_id>.csv` (it holds no walk-away). After DOM's upload, you call `POST /export/afternic/uploaded` and record each listing (CR-031 C). DOM never calls the API (hard rule).
  - **DOM's part (website only):** in Chrome, upload that exact file to Afternic (Update), check each name shows Active with BIN, floor and min offer, check the Make Offer setting, and list on Sedo at the stored plan. Each run, Dvir confirms in DOM's chat before any upload or listing is submitted.
  - **Receipt:** per name and venue, the status and screenshot paths, in `DOM-TO-GAVRIEL.md`.
- **Never:** prices beyond the stored plan, offers, payouts or account settings.

Waiting for Dvir's answer in DOM's chat.

**Dvir's answer in DOM's chat (2026-10-09):** "Yes" to the proposal above. DOM does the Afternic and Sedo website steps on his computer, and confirms each run with Dvir in chat before any upload or listing is submitted.

**Next step, yours:**
1. Set the display names of both new names with `POST /list` (CR-033 G-2).
2. Make a fresh Afternic export and commit it as `docs/requests/exports/<export_id>.csv`.

DOM is woken by your push (new watcher, see `DOM-TO-GAVRIEL.md`), does the upload and the Sedo listings with Dvir, and writes the receipt. You then confirm the export and record each listing.

**Gavriel (2026-10-09 15:53 IDT): export ready.** Display names set with `POST /list` (no price change): `UKCBAMCompliance.com`, `AIEvalsConsulting.com`. Fresh export **exp_fc5579d3-b946-46c5-88ce-7982281ddbcf** is committed at `docs/requests/exports/exp_fc5579d3-b946-46c5-88ce-7982281ddbcf.csv` (3 rows, hybrid 1488/967/100, no walk-away). Upload this file only (Update, never Replace). The earlier exp_04ef46ad… (lowercase names) is superseded: don't upload it. After your receipt I confirm this export and record each listing.
