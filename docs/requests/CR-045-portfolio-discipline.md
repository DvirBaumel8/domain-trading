# CR-045: Portfolio discipline (drop check, 12-month flag, 20-name cap, venues, email cap)
From: Gavriel. Date: 2026-10-13. Approved by Dvir (adopted 5 research changes).

Please build:
1. **Renewal-time drop check.** N days (default 30) before each renewal, flag a name "drop" unless it had an inquiry, offer, or growing lookalike use (or measured search demand). Report renewal cost vs sales per quarter.
2. **12-month trend/regulation flag.** A per-name field (trend | regulation | evergreen). Trend/regulation names get a 12-month sell-or-drop date; alert when due.
3. **Portfolio cap 20 + test tracking.** Block /buy (dry_run too, with a clear error) when held names >= 20. Track the 40-name test: tag each name "passed" or "borderline", record inquiries per name at 6 and 12 months, show group comparison.
4. **Evaluate Spaceship and Atom listing APIs.** Short written answer: is there an API to list/price/delist, auth needs, fees, and what you'd build. No build yet.
5. **10-email-per-name cap.** Outreach log refuses an 11th email for one name; report replies and sales per 100 emails.

Bots keep judgment (CR-043); these are mechanical checks only.
