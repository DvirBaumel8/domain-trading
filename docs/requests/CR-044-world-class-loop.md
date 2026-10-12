# CR-044: Learning loop and listing reach (Dvir approved 2026-10-13 00:57 IDT)

Order of work:
1. Listing reach (first): list every owned name with Buy Now on every free venue we can: Afternic (with Fast Transfer), Sedo (after the CR-040 verification), Dan.com and similar free venues. Add a daily status check per venue with an alert when a page 404s or is missing (roofingvoiceagent is 404 now). If a page scrape isn't possible, check the venue API or my-account export.
2. Life-cycle tracking: each owned name keeps one record from idea to outcome: lane, card scores at buy time, views, inquiries, offers, sale or drop, days held. Expose GET /portfolio/outcomes, plus a monthly report comparing what got interest with what didn't, by card feature.
3. Demand data: integrate Google Ads Keyword Planner (free with an Ads account; Dvir can create one if needed) as the search-volume source for CR-043 item 4. Name what you need from us.
4. Sales-pattern scan: a weekly job pulling recent $1k-5k .com end-user sales (NameBio or another allowed source), clustering their patterns (word count, topic, structure) and writing docs/requests/patterns/<date>.md for the scouts.
5. Grow slowly: no settings change; buys stay small-buy only with a per-name line from Dvir.
6. Holdout test: record 20 passed and 20 failed candidates per month (not bought) and, after 6 months, compare signals (lookalike registrations, searches, sales of similar names). Part of the outcomes report.
DOM may decline items it can't do legally or technically; say which and why. Build once the API is reachable (CR-041).

## DOM response (2026-10-13)
**Verdict: build 2, 6 and a narrower 1 and 4. Item 3 needs Dvir to set up Google accounts first. Two parts of 1 are declined.** Built after CR-043 (3.10.0); everything deploys to the Mac host.

1. **Listing reach.**
   - **Afternic (Buy Now with Fast Transfer):** already the default lander and listing. A name 404s on Afternic while Afternic hasn't finished its own ownership check; DOM looks at roofingvoiceagent.com in Dvir's Chrome on the next listing run (`afternic-listing` skill).
   - **Sedo:** after CR-040. It stays **Make Offer**: `formats.md` keeps Afternic as the only binding price, so a price drop can't leave a stale Buy Now price on Sedo, which is updated by hand. Changing that is Dvir's call (**DVIR**).
   - **Dan.com: declined.** It was retired on 27 Jun 2025. **Other venues: declined for now.** Each one is another place to re-price by hand at every scheduled drop. Name a venue with a seller API or a bulk file and DOM looks at it.
   - **The daily status check, built differently:** a page check on Afternic's or Sedo's site is marketplace scraping (ruled out in CLAUDE.md). Instead, a daily `lander_check` per owned name fetches **our own domain** (`http://<name>/`) and checks that the for-sale lander answers. New `/report` warning `LANDER_DOWN` (name, status, since). That catches a dead lander, the case that costs buyers.
2. **Life-cycle record: build.** `GET /portfolio/outcomes` (READ), one row per owned name: lane, the screening-pack scores at buy, listing history, offers (already logged), sale or drop, days held. Views and inquiries come from no API, so Gavriel may add them with `POST /portfolio/{domain}/stats` (WRITE, `{views, inquiries, as_of, source}`, append-only). Plus `GET /portfolio/outcomes/monthly`: names with any interest versus none, by card feature (lane, word count, length band, tier, lookalike count).
3. **Search demand (Keyword Planner): needs Dvir.** The Google Ads API needs a Google Ads account, a developer token (Google approves Basic access, which can take days), an OAuth client and a refresh token. Without ad spend, Google gives ranges ("1K–10K"), not exact numbers. **DVIR:** create the Ads account and apply for the token; the keys go into the host env file by Dvir, never the repo. DOM then builds `demand.search_volume_band` as a FLAG input (never a reject).
4. **Sales-pattern scan, narrower.** DOM has no source it may fetch: NameBio blocks bots (G-29), and the weekly sales reports have no terms that allow automated pulls. So the input comes from you: `POST /patterns/sales` (WRITE) takes a CSV of recent sales (`domain, price_usd, date, venue`), and `GET /patterns/latest` returns clusters by word count, structure, length band and topic tokens (bt1@v3 split), with $1k–5k .com end-user sales as the default filter. The service never writes into this repo, so you write `docs/requests/patterns/<date>.md` from that answer.
5. **Grow slowly:** nothing to build. Small buys stay one name per Dvir line.
6. **Holdout:** a monthly step stores 20 passed and 20 failed screened names (not bought, seeded random pick) in a `holdout` table. At 6 months it re-runs the lookalike check (CR-043) and records the change; searches and similar-name sales join once 3 and 4 have data. Part of the monthly outcomes report.

## Gavriel follow-up (2026-10-13 01:05 IDT)
Accepted as answered: build 1 (lander_check + `LANDER_DOWN`), 2, 4 (CSV upload) and 6 after CR-043, deploying to the Mac host. Dan.com and venue scraping declined: agreed.
- **Item 3 fallback (please build either way):** Dvir already exports a Keyword Planner report by hand on the 1st of each month. Add `POST /demand/keywords` (WRITE) that takes that export CSV (keyword, avg monthly searches band, competition, top-of-page bid low/high) and feeds `demand.search_volume_band` as the same FLAG input. If Dvir later sets up the Ads API, it replaces the upload; no other change.
- **Sedo Buy Now vs Make Offer** and **the Ads account/token**: put to Dvir; I record his lines here when he answers. Until then Sedo stays Make Offer.
