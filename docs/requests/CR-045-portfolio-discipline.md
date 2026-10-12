# CR-045: Portfolio discipline (drop check, 12-month flag, 20-name cap, venues, email cap)
From: Gavriel. Date: 2026-10-13. Approved by Dvir (adopted 5 research changes).

Please build:
1. **Renewal-time drop check.** N days (default 30) before each renewal, flag a name "drop" unless it had an inquiry, offer, or growing lookalike use (or measured search demand). Report renewal cost vs sales per quarter.
2. **12-month trend/regulation flag.** A per-name field (trend | regulation | evergreen). Trend/regulation names get a 12-month sell-or-drop date; alert when due.
3. **Portfolio cap 20 + test tracking.** Block /buy (dry_run too, with a clear error) when held names >= 20. Track the 40-name test: tag each name "passed" or "borderline", record inquiries per name at 6 and 12 months, show group comparison.
4. **Evaluate Spaceship and Atom listing APIs.** Short written answer: is there an API to list/price/delist, auth needs, fees, and what you'd build. No build yet.
5. **10-email-per-name cap.** Outreach log refuses an 11th email for one name; report replies and sales per 100 emails.

Bots keep judgment (CR-043); these are mechanical checks only.

## DOM response (2026-10-13)
**Verdict: build 1, 2, 3 and 5 as mechanical checks; item 4 answered below. The cap change in 3 is a founder rule (caps change only by migration, with Dvir's approval), so DOM has asked Dvir directly in chat and builds it once he confirms (DVIR).** Order: after CR-043 (3.10.0) and with CR-044.

1. **Renewal-time drop check:** built together with the renewal path itself (gaps G-85: `record-renewal`, a `renewal` ledger row, `renewals_used` = 1, which nothing does today).
   - **The flag:** `renewal.drop_check_days` (default 30) before expiry, a `/report` warning `RENEWAL_DROP_SUGGESTED` unless the name had any of:
     - an offer (logged);
     - an inquiry (CR-044 `stats`);
     - a rise in lookalikes in use since buy (CR-043 check re-run then);
     - a search band above "unmeasured" (CR-044 upload).
   - **The quarterly report:** renewal cost against sales, in `GET /portfolio/outcomes/quarterly`.
2. **Horizon flag:** a per-name `horizon` (`trend` | `regulation` | `evergreen`, default `evergreen`), set at `/buy` (optional field) or later with `POST /portfolio/{domain}/horizon` (WRITE, audited). `trend` and `regulation` names get `sell_or_drop_by` = buy date + 12 months, and a `/report` warning `HORIZON_DUE` 30 days before. Such a name should usually be bought with `drop_policy: at_first_expiry` (no renewal); `/buy` warns when the two disagree.
3. **Cap 20 and test tracking.**
   - **The cap (after Dvir confirms):** a migration lowers the domain cap from 50 to 20. `/buy` refuses with the existing domain-cap code, and a dry run reports it as `would_be_blocked`, as dry runs do for every gate.
   - **The test:** each bought name stores its screening group, `passed` or `borderline` (from the verdict at buy). Inquiries at 6 and 12 months come from the `stats` rows, and the group comparison is in the outcomes report.
4. **Spaceship and Atom (research, no build; sources in `docs/research/marketplaces.md`):**
   - **Spaceship SellerHub: worth building later.** A documented REST API: create with `binPrice` and `minPrice`, `PATCH` to re-price, `DELETE` to delist, and a sold report. Key and secret with `sellerhub` scopes. The name may stay at Porkbun; ownership is shown by a TXT record, so no nameserver change is needed. No listing fee found; the commission is 10% (since Feb 2026). Because the API can re-price, Buy Now there would follow every scheduled drop automatically, through a listing-sync step (the price job itself stays marketplace-free by rule). **DVIR:** a Spaceship account and API key, which Dvir puts in the host env.
   - **Atom: skip.** Its seller API is a closed beta for accounts with 500+ listings, and the token goes in the URL. Premium listings are exclusive and need Atom's nameservers (that breaks the Afternic lander). Standard costs 7.5%.
5. **Email cap (as amended in `CR-045-followup-email-cap.md`; the service still never sends email, founder rule 10):** an outreach log Gavriel writes to: `POST /outreach/emails` (WRITE): `{domain, recipient_domain, sent_at, reply?, outcome?}`. The recipient is stored as the company's **domain only**, never a person's address (no personal data). The **6th** email for one name is refused with 409 `EMAIL_CAP` (`outreach.max_emails_per_name` 5). The "10 sends and no reply" stop rule can never trigger under a cap of 5, so it is not built; if the cap is raised later, it comes back as `outreach.stop_after_no_reply` 10. `GET /outreach/emails/summary`: replies and sales per 100 emails.

## Gavriel follow-up (2026-10-13 01:14 IDT)
Accepted as answered: 1, 2, 3 (cap after Dvir's own confirmation to DOM), 4 (Atom skip agreed) and 5 (company domain only, cap 5, no stop rule while the cap is 5).
- **Spaceship:** yes, please plan the SellerHub listing-sync. I've asked Dvir for the account and API key; build it once the key is in the host env.
- **Outreach log:** I'll `POST /outreach/emails` for every send once it's live, including the earlier promptinjectionaudit.com sends if any went out by then.
