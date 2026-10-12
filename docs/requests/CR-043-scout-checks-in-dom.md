# CR-043: Move scout mechanical checks into DOM

From: Gavriel, 2026-10-13 00:46 IDT. Dvir approved the split: bots keep judgment, and DOM does repeatable checks and lookups.
Rules: card-rules-v2 (summary below). Method: buyer-method-v6.

DOM should add to intake/screening, per candidate:
1. Availability and price (existing), plus a hard reject over 20 letters before .com.
2. Lookalikes: the same words on other endings (.io .co .net .ai .co.uk etc.), hyphenated and get-/try- versions. For each one: registered? live site? Use RDAP/WHOIS, not system DNS. Output a count of in-use lookalikes; more in-use lookalikes is a plus.
3. Closest past sale: the nearest similar sold name with price and source (NameBio or other), or "none found".
4. Search demand: volume when a source exists, else "unmeasured". Never estimated.
5. Trademark lookup (existing same_name logic is fine).
6. A shared topic list: reject or flag a topic already used by any lane in the last 30 days.
7. Rule gate: auto-reject if fewer than 3 small-firm links are provided by the scout (field `small_firms[]`), no past-sale line, over 20 letters, or lane S2 buy card.
8. A score per name, returned by API so I can test it. One CSV/JSON report per batch.
Bots keep: trend spotting, name ideas, finding and judging small-firm buyers, the "who chases" line.
Also add a 404 check on our sale pages (Afternic/Sedo) with an alert.
Build when the API is reachable again (CR-041). Receipt in DOM-TO-GAVRIEL.md.

## DOM response (2026-10-13)
**Verdict: accept part of it, simplified; most of the inputs already exist. Push back on 4 and the sale-page 404 check. The auto-reject gate is a selection-rule change, so it needs Dvir's activation line (DVIR).**

Already built (use these, nothing new):
- **1 availability and price**, **5 trademark** (`same_name`), **8 score**: `ev`, `ratio` and the tier fields are in every screening result (`GET /screening/runs/{id}`), and the daily list ranks by them.
- **The small firms** are the scout's `sellers[]` at intake (DOM fetches each page and verifies it, CR-028); **the past-sale line** is `comps[]` at intake. `who_chases` is stored too.

Build (one MINOR release, tested locally now, deployed once the Mac host is up, CR-041):
- **1 length:** `form.max_sld_chars` (default 20) in the selection settings, a FAIL `SLD_TOO_LONG` at intake and in screening. Because it changes verdicts, it ships in a settings draft (see the gate below).
- **2 lookalikes:** the same SLD on .net .org .io .co .ai .co.uk, plus `<sld>` hyphenated and `get<sld>.com` / `try<sld>.com` (this is G-70). Each by RDAP: registered or not; for registered ones, a live check of the home page through the existing safe fetch (status, parked or not). Output: `lookalikes.registered_n`, `lookalikes.in_use_n` and the list. It is a FLAG-level input (a plus), never a reject. Some endings have no public RDAP (.co.uk via Nominet does; .io and .ai may not): those show `unknown`, never guessed. System DNS is not used.
- **6 topic reuse:** a shared topic per name = the scout's new optional `topic` field (free text, lower-cased), or the lane plus the first two content words if absent. A topic seen in any intake row of the last 30 days is a FLAG `TOPIC_REUSED` (not a reject; a reject needs the gate below).
- **7 the gate:** a settings draft `v12` with `intake.require_sellers_min` 3 (verified, not just listed), `intake.require_comps` true, `form.max_sld_chars` 20, and S2 kept out of buy cards (S2 already has `GFORM1_*`; DOM checks whether "S2 buy card" means `buy_candidate` false for S2, and asks you in this file if not). Gavriel drafts it with `POST /selection/settings` and Dvir activates it (`POST /selection/settings/{label}/activate`) with his `approval_ref` (CR-001 P-8). Until then, the new checks report but don't reject.
- **8 report per batch:** `GET /screening/runs/{id}/report.csv` (READ): one row per name with the verdict, score, lookalike counts, topic flag, sellers verified, comps count and reasons. JSON is the existing run route.

Not built:
- **3 closest past sale by lookup:** there is no source DOM may call. NameBio blocks automated requests (G-29), and other sale databases are paid or need scraping. The scout's `comps[]` stays the source; the report shows "none found" when it is empty.
- **4 search demand:** no free source with terms that allow it, so it would always read `unmeasured`. Not worth a field. Reopen with a named source.
- **404 check on our Afternic and Sedo pages:** Afternic blocks bots, and CLAUDE.md rules out marketplace scraping. DOM checks the pages in Dvir's Chrome during listing runs (the skills) instead; ask in `DOM-TO-GAVRIEL.md` when a page looks wrong.

Receipt and release note follow in `DOM-TO-GAVRIEL.md`.

## Gavriel reply (2026-10-13 00:55 IDT)
**S2 buy card:** yes — treat it as `buy_candidate: false` for lane S2. S2 is outreach/sell only (city + trade); those names must not land on the daily buy list or as buy cards. `GFORM1_*` stays as the form check; the gate just keeps S2 out of buy.

**v12 / build:** understood. I will draft settings `v12` with `POST /selection/settings` once the Mac host URL is in `DOM-TO-GAVRIEL.md` and `/health` answers. Dvir activate line comes after that; no activation without his line. Closest-sale lookup and search-demand stay scout-side / unmeasured as you said. Sale-page 404 stays with the listing skills, not a bot scrape.
