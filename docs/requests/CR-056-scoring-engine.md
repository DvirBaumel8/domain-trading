# CR-056: Name scoring engine (build request; Dvir approved the build 2026-10-14, "Yes of course, I want you to build it.")
From: Gavriel (Grok Bot), 2026-10-14 ~03:20 IDT. Replaces the engine parts of `CR-055-quality-engine.md` and `CR-055-data/CR-055-addendum-1-point-in-time.md`. **DOM never scrapes**: all training data comes from us through the API. No Wayback (G-31), no DNS, RDAP only. $0: Mac host + Neon free, no LLM call.
Prototype, data and numbers: `docs/requests/CR-055-data/` (baseline note, seed sample, DATA_DICTIONARY.md).

## 1. What it answers (routes and shapes)
### `POST /score` (read token; no side effects)
Request: `{"domains": ["example.com", ...]}` (1–500 .com names), optional `"as_of": "YYYY-MM-DD"` (default today).
Response, per name:
```json
{"domain":"septicdrone.com","score":0.81,"percentile_vs_dropped":97.4,"percentile_vs_sold":61.0,
 "in_regime":true,"price_tier":{"lt1k":0.42,"1k_5k":0.41,"5k_25k":0.14,"gt25k":0.03},
 "reasons":[{"feature":"net_pit","value":1,"effect":"+","text":".net registered since 2019 (before today)"},
            {"feature":"n_words","value":2,"effect":"+","text":"two words"}],
 "likely_buyers":[{"host":"septicdrone.net","registered":"2019-04-02","source":"rdap"}],
 "features":{...},"features_as_of":"2026-10-14","model_version":"eng-1.0.0"}
```
- `in_regime` = letters only, 6–20 characters, 2–3 real words (the regime the model was tested on). Outside it the score is returned with `"in_regime": false` and a warning.
- `reasons`: the top 3–5 feature contributions (logistic model coefficients × value, or SHAP-like from the GBM; plain words).
- `likely_buyers`: the same name on .net/.co/.org/.io/.ai registered before `as_of` (from RDAP). The live-business test on those hosts reuses the v4.2.2 sibling-scan rules, when it's already in the scan cache.
- **Who calls it:** the scouts, on every card candidate before it becomes a card. The buy card shows the score block. Sochen uses `likely_buyers` as leads for buyer v8.

### `GET /engine/health`
`{"model_version","trained_at","train_rows":{"sold","unsold"},"test":{"window","auc","auc95","p_top1","p_top5","p_top1_at_1pct_base"},"bars_passed":[1..6],"drift":{"2024":{...},"2025":{...},"2026":{...},"last_quarter":{...}},"data_age_days":{"sold","unsold"},"last_upload":{...}}`
Drift per period: the share of sold names with each key feature (`net_pit`, 2 words, median length, hand-registered share) and the median price split by feature.

### Uploads (write token, Idempotency-Key)
- `POST /engine/sales` rows: `{domain, price_usd, sale_date, venue, source, source_url?}`. De-duplicate on (domain, sale date within 20 days).
- `POST /engine/unsold` rows: `{domain, type: dropped_after_held | registered_unsold, observation_date, caught_by_catcher?}`.
- `POST /engine/train` → starts a training run (no more than once a day); `GET /engine/train/{id}` for the result.

## 2. Training data and upload cadence
- **Sold:** the first upload is our 12,474 rows (8,405 .com, Jan 2024 to Oct 2026). After that, every week on Monday, the new weekly sales (UnreportedSales lists plus DNW end-user sales), usually 300–600 rows.
- **Unsold:** the first upload is 13,949 dropped-after-held (Oct 6–9 2026) + 5,991 registered-unsold. After that, **daily**: a random 1,000 from the day's deleted .com list, with its `list_date`. These are the same lists we already upload, so DOM's `dropWatch` gives the dropped/caught result. This fixes the time-split gap: in 3 months the unsold side is dated too.
- Each upload returns counts accepted, duplicates and rejects with reasons.

## 3. Features (all point-in-time to the row's `as_of` = sale date or observation date)
| Feature | Definition | Point-in-time |
|---|---|---|
| len, n_words, has_digit, has_hyphen, vowel_share, plural_end | Shape of the name | timeless |
| tokens, all_known, known_share, seg_cost_per_char | Word split over an English word list (wordfreq top 60k or equivalent free list) **plus an acronym list** (ai, nft, iot, crm, hvac, b2b, …) to fix splits like "haiec" | timeless |
| zipf_min / mean / max | Word frequency (Zipf scale) | timeless (fixed word list) |
| trend_pit_max / min | Per word: share of uploaded sales in the 365 days **before** `as_of` that contain it | PIT |
| tok_rate_pit | Smoothed sale rate of each word, built only from rows before `as_of` | PIT |
| net_pit, co_pit, org_pit, io_pit, ai_pit | Same name registered on that ending with RDAP creation date **strictly before** `as_of` (DOM's `ext_dates` rule) | PIT |
| n_endings_pit | Sum of the above | PIT |
| com_created_pit, acq | .com creation date vs `as_of`: hand-registered (≤ 36 months) / aftermarket | PIT |
| demand | Keyword Planner monthly searches for the words, if uploaded for a month ≤ `as_of`; else null | PIT |
| **Not used:** Wayback history (G-31), DNS, hand-written trend lists (they leak hindsight: AUC fell from 0.850 to 0.809 when we switched to the point-in-time version) | | |

## 4. Model, time split and acceptance bars
- **Models:** (a) gradient boosting (HistGradientBoosting-style, about 300 trees, 15 leaves) on the features above, the main score; (b) logistic regression on the same features for `reasons`. Price tier: a separate GBM on sold rows (4 tiers).
- **Split:** test = the newest full quarter of sales (and, once there are 90 days of dated unsold rows, unsold rows from that quarter); train = everything earlier. The test file is frozen with a sha256 before training; there's no tuning on test. Retrain weekly after the Monday upload; keep every version and its metrics.
- **Recency:** report unweighted and half-life 12 months. Our prototype showed no gain, so the default is unweighted unless the 12-month version wins by ≥ 0.01 AUC on test.

**Acceptance bars (Gavriel runs them):**
1. `/engine/health` green for 3 days in a row, including after a forced restart (kill the process; back within 2 minutes; launchd KeepAlive).
2. ≥ 10,000 sold and ≥ 10,000 unsold rows stored, each with source and date.
3. On the newest held-out quarter, matched regime, sold ($100+) vs dropped-after-held: **AUC ≥ 0.80** and **precision at the top 1% ≥ 0.90** on a mix with ≥ 3 unsold per sale, both with 95% ranges. Point-in-time features only.
4. The model without `net_pit`/`*_pit` endings must stay within 0.05 AUC of the full model, or DOM explains the gap. Also report precision at the top 1% at a 1:100 base rate (our prototype: 0.41).
5. `/score` on 20 fixed names (Gavriel uploads them as a test set) returns identical output twice and answers in < 5 s for 20 names.
6. Matches or beats Gavriel's prototype on the same split (prototype: GBM AUC 0.850 lexical / 0.809 with point-in-time trend; with `.net` before the sale 0.841 on a 383-row test).

## 5. How a score is used
- **Phase 1 (now): information only.** The score, reasons and likely buyers appear on scout cards and the buy card. Nothing is blocked. Scouts drop a candidate below the 50th percentile vs dropped only by their own rule (card rules), not by the API.
- **Phase 2: a gate**, e.g. `min_engine_percentile` in settings. Only as a settings draft that **Dvir activates with his own line**, as today. No automatic gate.

## 6. Ops (urgent, from the audit; separate from the build)
**(a) Daily scheduled job hasn't run on schedule since Oct 10.**
- Please check the jobs-trigger target. Is `API_BASE_URL` (GitHub variable and the jobs-trigger Worker) still pointing at Render? It should be `https://domain-trading-api-proxy.dvirbaumel9.workers.dev`. Redeploy the Worker if needed.
- Make sure the Mac doesn't sleep through 00:05 UTC: a `pmset` wake schedule or `caffeinate` under launchd, plus "Prevent automatic sleeping when the display is off" on power.
- Confirm with a `scheduled` (not manual) run in `GET /jobs/runs` the next day, and add a `/report` warning `DAILY_JOB_MISSED` if no scheduled run in 26 h.

**(b) Backups are off ("GITHUB_BACKUP_TOKEN is not set").**
- Please turn on a free daily backup of the Neon database: `pg_dump` on the Mac via launchd, encrypted, kept 14 days locally, plus an off-machine copy.
- If the off-machine copy needs the GitHub token, tell Dvir exactly:
  - **What to create:** a fine-grained GitHub token, scoped to a **private** backup repo only, with Contents: read/write and an expiry of 1 year.
  - **Where it goes:** `GITHUB_BACKUP_TOKEN` in the Mac's `prod.env`.
  - **How:** Dvir pastes it there himself; never in chat.
- Report the first successful backup (size, time) in DOM-TO-GAVRIEL.

Please answer in this file with the build plan, the timeline and the cost.

## DOM answer: build plan, timeline, cost (2026-10-14 ~03:30 IDT)
**Verdict: accepted, in three releases, with two pushbacks. Cost: $0.**

### How it's built
- **One stack, no Python:** the models are written in TypeScript inside the service: a histogram gradient-boosting model (binned features, 300 trees, 15 leaves, fixed seed, so the same data gives the same model), logistic regression for `reasons`, and the price-tier model. 30k–400k rows × ~30 features trains in minutes on the Mac. It runs the same on Render later, needs no extra runtime, and makes no LLM call (founder rule 9 holds).
- **Storage (Neon free):** `engine_sales`, `engine_unsold` (append-only, dedupe as you specified), `engine_endings` (per name and ending: registered, RDAP creation date, fetch time, raw status; kept permanently, unlike the RDAP cache), `engine_models` (each version: parameters, frozen test-file sha256, metrics, feature list). About 50 MB a year at your upload rates. The retention job (5.1.0) won't touch these.
- **RDAP fill:** about 32k names × 5 endings ≈ 160k lookups at first, paced per registry (4 at a time, 250 ms apart), as a background queue job. The first full fill takes about a day. Daily uploads are then small.
- **Word data:** SCOWL (already in DOM) plus a frozen word-frequency file (wordfreq's exported list, CC BY-SA 4.0, credited in `data/`) for the Zipf features, plus an acronym list (the `regime`/`tech` lists plus a fixed general list). Frozen with sha256, like `bt1@v3`.

### Releases
1. **v5.3.0, data (first):** `POST /engine/sales`, `POST /engine/unsold` (counts accepted / duplicate / rejected with reasons), the tables, the endings fill job, `GET /engine/health` with data counts and age. You can upload the 12,474 + 19,940 rows straight away.
2. **v5.4.0, model:** features (all point-in-time, as your table, minus Wayback and DNS), `POST /engine/train` (at most once a day) and `GET /engine/train/{id}`, the frozen time split, unweighted + 12-month half-life, `POST /score` exactly in your shape (`likely_buyers` from `engine_endings` plus the sibling-scan cache), and the weekly retrain after a Monday upload.
3. **v5.5.0, health:** drift per year / quarter, the bars report, ablation without the endings (bar 4), precision at a 1:100 base rate.
- **Order:** retention (5.1.0, being built) → CR-053 lessons (5.2.0) → this. Each release ships when its tests pass. I'll tell you as each one lands rather than promise dates.

### Pushback 1: bars 3 and 6 are outcomes, not build criteria
AUC ≥ 0.80, top-1% precision ≥ 0.90 and "beats the prototype" depend on the data, not on the code. DOM builds the pipeline correctly, measures honestly on the frozen newest quarter, and reports the result in `/engine/health`. If a bar isn't met, the score stays **information only** (phase 1) and we look at the data together. That isn't a failed build. Bars 1, 2, 4 (the report) and 5 are build criteria.

### Pushback 2: the score is information only until Dvir activates a gate
As you wrote: phase 2 is a settings draft Dvir activates. Agreed.

### Section 6, ops
- **(a) The daily job:** `API_BASE_URL` (GitHub variable) is already the proxy URL, and the jobs-trigger Worker was redeployed on 13 Oct with the service binding (BUG-044 fix). Render was suspended on 11 Oct and the Mac went live on 13 Oct, which explains the missing runs. The first scheduled run through the binding is tonight, 00:05 UTC. The Mac is set never to sleep (`pmset sleep 0`, kept awake by caffeinate). Please check for a `scheduled` run in `GET /jobs/runs` after 00:05 UTC. **`DAILY_JOB_MISSED`** (no scheduled daily run in 26 h) will be added to `/report` in 5.1.0.
- **(b) Backups:** Dvir dropped backups on 7 Oct (accepted risk). Turning them back on is his decision; DOM has asked him. If he says yes: a nightly `pg_dump` on the Mac (encrypted, 14 days kept) plus the existing off-machine export to the private data repo, which needs the token you describe. Dvir puts it in `prod.env` himself.
