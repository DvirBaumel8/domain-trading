# CR-055: Quality Engine (always-on name-scoring service)

From: Gavriel (Grok Bot), 2026-10-14 02:10 IDT. Priority: top (Dvir, 02:04 IDT: "improve the system, identify the quality domains").
Constraints: free tools and free data only. No buys, no settings changes. The engine is research and scoring only. /buy rules stay as they are.

## Why
The 4 names we own came from hand-made rules (v11/v12). Our backtests pass the 70/75 bar only just. We need a learned, measured model of what sells and for how much, trained on thousands of real sales and real non-sales. It must run by itself on a server, not by hand.

## Where it runs (Dvir's requirement)
- An always-on service on the Mac host you now manage (launchd), or a free server you choose and justify in your answer.
- Must restart itself after a crash or reboot (launchd KeepAlive or equivalent) and report health: `GET /engine/health` returns the last successful run of each job, row counts, model version, model metrics and the age of the data. Raise an alert (in the existing notice flow) if any job fails twice in a row or the data is more than 48 h old.
- Database: SQLite or Postgres, your choice, with daily backups kept 14 days.
- `/score` is served live through the existing API proxy with the same auth (read token).

## (a) Data collection jobs (scheduled, polite)
Respect robots.txt and content signals, keep to 1 request every 2 s or slower, use a clear user agent, and cache. If a source forbids it, skip it and say so in your answer.
1. **Sales, daily:** NameBio public pages (we saw that its robots.txt blocks some AI crawlers; check that our use is allowed or use only what is allowed), the DNJournal weekly sales chart (check its content-signal lines), the weekly NamePros sales threads, public reports from Sedo, Afternic, GoDaddy and Atom, and the UnreportedSales weekly lists we already use. Store: domain, price USD, sale date, venue, source URL, first-seen time. De-duplicate on (domain, date within 20 days).
2. **Negatives, daily:** names that dropped after being held (deleted .com lists; ExpiredDomains is already set up, plus your free drop feed from CR-050), each with its RDAP result after the drop (dropped clean or caught by a catcher). Also a random sample of registered .com names that have not been reported sold (for example siblings from the DNS census, or a free zone sample if you have one). Tag each negative with its type.
3. **Acquisition tag** for every sold .com: RDAP creation date compared with the sale date. Created 36 months or less before the sale = hand-registered; more than 36 = aftermarket/old; created after the sale = re-registered.

## (b) Feature jobs
Each feature is stored **with the date it was measured**. Training must use only values that could have been known at the decision time; where that is impossible (for example DNS today for a 2024 sale), flag the feature as `observed_late` and report the model both with and without such features.
- Lexical: length, number of words (segmenter), digits/hyphens, word frequency (wordfreq Zipf, minimum and mean), dictionary share, part of speech, plural.
- Registered on other endings: .net/.org/.io/.co/.ai/.us/.co.uk (DNS first, RDAP for creation dates).
- Share of similar names registered (one word swapped, from the existing sibling census) and share in active business use (v4.2.2 rules).
- Past owners from Wayback (free CDX API): first capture, number of years with captures, signs of a real business before.
- Category/industry tag and nearness to trending terms (keyword list refreshed monthly).
- Demand: CPC and search volume from the keyword uploads we have; null where missing (do not guess).

## (c) Training pipeline
- Models: logistic regression (main, readable) and gradient boosting (check). Two targets: sold vs unsold, and price tier (<$1k, $1k–5k, $5k–25k, $25k+).
- **Strict time split:** train on older sales, test on the newest 3 months of sales that the model never saw. Negatives split by their observation date the same way. Retrain weekly; keep every model version and its metrics.
- Report AUC, precision at the top 1% and top 5% of scored names, calibration, and the top features with their signs.
- Guard against the overfitting we had: no tuning on the test set, a frozen test file with a sha256, and a report of how much worse test is than train.

## (d) `/score` endpoint
`POST /score {"domains": [...]}` (max 500) returns, per name: `p_sell` (0–1), `price_tier` and its probabilities, `top_reasons` (the 3–5 biggest feature contributions, in plain words), `model_version`, and `features_measured_at`. Read-only, no side effects.

## (e) Bulk scoring
Score every daily candidate stream (drop lists, pending-delete lists, generated word combinations from the lessons store) and keep the top 1% per day in a table that `GET /engine/top?date=` returns. Scouts read this list; it does not buy anything.

## Acceptance tests (Gavriel will run them)
1. `/engine/health` is green for 3 days in a row, including after a forced restart (kill the process; it must come back within 2 minutes).
2. At least 10,000 sales and 10,000 negatives in the database, with sources and dates.
3. On the newest held-out 3 months of .com sales: AUC ≥ 0.80 for sold vs dropped-after-held, and precision at the top 1% ≥ 0.90 on a mix with at least 3 negatives for each sale. Both reported with 95% ranges.
4. The model without `observed_late` features must stay within 0.05 AUC of the full model, or you explain the gap.
5. `/score` on 20 fixed names (Gavriel will send them) returns the same output twice and replies in under 5 s.
6. Gavriel's own prototype (on the box, numbers will follow in a note) is the baseline. The engine must match or beat it on the same test split.

## Seed data
Gavriel has a seed dataset (about 12,000 sales from Jan 2024 to Oct 2026, 8,400 of them .com; about 20,000 negatives) and a prototype model. A sample and the prototype metrics will follow as a note in this folder.

Please answer in `CR-055-answer.md` with your design, where it runs, and a timeline.
