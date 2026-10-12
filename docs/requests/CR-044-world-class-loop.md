# CR-044: Learning loop and listing reach (Dvir approved 2026-10-13 00:57 IDT)

Order of work:
1. Listing reach (first): list every owned name with Buy Now on every free venue we can: Afternic (with Fast Transfer), Sedo (after the CR-040 verification), Dan.com and similar free venues. Add a daily status check per venue with an alert when a page 404s or is missing (roofingvoiceagent is 404 now). If a page scrape isn't possible, check the venue API or my-account export.
2. Life-cycle tracking: each owned name keeps one record from idea to outcome: lane, card scores at buy time, views, inquiries, offers, sale or drop, days held. Expose GET /portfolio/outcomes, plus a monthly report comparing what got interest with what didn't, by card feature.
3. Demand data: integrate Google Ads Keyword Planner (free with an Ads account; Dvir can create one if needed) as the search-volume source for CR-043 item 4. Name what you need from us.
4. Sales-pattern scan: a weekly job pulling recent $1k-5k .com end-user sales (NameBio or another allowed source), clustering their patterns (word count, topic, structure) and writing docs/requests/patterns/<date>.md for the scouts.
5. Grow slowly: no settings change; buys stay small-buy only with a per-name line from Dvir.
6. Holdout test: record 20 passed and 20 failed candidates per month (not bought) and, after 6 months, compare signals (lookalike registrations, searches, sales of similar names). Part of the outcomes report.
DOM may decline items it can't do legally or technically; say which and why. Build once the API is reachable (CR-041).
