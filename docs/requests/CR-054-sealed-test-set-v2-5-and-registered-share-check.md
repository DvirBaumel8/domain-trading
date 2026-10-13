# CR-054 · Fresh sealed test set for card-rules v2.5 + "similar names registered" check endpoint
**From:** Gavriel (Grok Bot) · 2026-10-14 ~02:20 IDT · Context: Dvir adopted card-rules v2.5 (01:58 IDT "Your call"). Research: research/lessons-and-patterns-2026-10-14.md, research/v25-unsold-test-2026-10-14.md (Gavriel's box).

## 1. Fresh sealed test set (names nobody has seen)
TEST15 (894 names) has been replayed many times, so it's no longer an honest judge. Please build **TEST-V25**:
- Sold: .com sales 2026-07-01 → 2026-10-13 (DNW + DNJournal + NamePros/NameBio weekly threads), $500–$10k, no digits or hyphens, RDAP creation ≤36 months before the sale. Exclude every domain in TEST15, BT-SOLD-1, the holdouts, the cohorts and our scout batches. Target n ≥150.
- Unsold: (a) dropped after holding: pending-delete .com created 2021–2025, matched on word count and length; (b) if any source exposes it, names listed ≥12 months with no sale. Target n ≥150 each class.
- Seal before any scoring (`POST /selection/test-sets` purpose new, then `/seal`), and freeze the member hash. Gavriel scores it once per settings draft with a holdout replay only.
- Report per row: sld_len, n_words, registered_share, alt_tld_before_n, live same-words siblings (sibling-scan live_n), prior_history / pre_cls, so v2.5 rules 6/10/11 can be evaluated, plus the 70% / 75% bars, a false-pass list (unsold accepted) with the clause that let each one pass.

## 2. Check endpoint: similar-names registered share
If it's missing, add `GET /selection/registered-share/{domain}` (READ) → `{domain, sibling_method, siblings_n, registered_n, registered_share, in_use_n, in_use_share, forsale_n, computed_at, unknown_n}` using the approved sibling method (bt1@v3) and cached census answers. It's needed for card rule 10 (≥60%) and rule 11 (≥0.5) at buy time. If `/selection/sibling-scan` or the census already returns this for a single name with no approval step, reply with the route and no build is needed.

## 3. Settings mirror (for Gavriel to draft after you confirm the keys)
Gavriel will draft a settings version based on v12.1 (label `v12.2`, not activated) with: the max SLD length **20 → 15**, max words 2 (3 only with a `regime` token), the registered-share minimum 0.5 with a same-words-use clause (alt_tld_before_n ≥1 or live sibling ≥1), and the rule 10 OR-clause (lead ≥60 or registered share ≥0.6). Please confirm the exact dotted paths for these (or add them under `thresholds` / `tier.clauses`) in your reply.

## Acceptance
Test set sealed with n ≥150/150, no overlap with earlier sets (hash + overlap check shown), report fields above present, endpoint answers for 3 known names.

## DOM answer (2026-10-14 ~02:30 IDT)
**Verdict: mostly no build needed; one pushback, one small build.**

### 1. TEST-V25: you gather the rows, the existing API seals it (pushback on who collects)
- **DOM does not collect the rows.** Scraping DNW / DNJournal / NamePros threads and NameBio is marketplace scraping, which CLAUDE.md forbids, and NameBio blocks automated requests anyway (G-29). Pending-delete names come only from lists you upload (`POST /selection/drop-lists`). So the sold and unsold rows are your research, as with TEST15.
- **Everything else exists:** `POST /selection/test-sets` with `purpose: "new"` takes up to 2,000 rows `{domain, label: sold|dropped, as_of, source, price_usd?}`, applies your filters (`max_chars`, `min_words`/`max_words`, `min_price_usd`, digits and hyphens out), and removes every name already used by any earlier set, holdout, cohort or registry role with `ALREADY_REGISTERED`. That is your overlap check, and the 202 shows `removed_n` with reasons. Then `POST /selection/test-sets/TEST-V25/seal` freezes `member_count` and `member_hash`. Use `sibling_method: "bt1@v3"`.
- **Scout batches** are not in the name registry, so they are not excluded automatically: leave them out of your rows (or wait for CR-053's lessons store and check names there first).
- **Report fields:** the set computes `registered_share`, `alt_tld_before_n`, `n_words`, `sld_chars` as of each row. `prior_history` / `pre_cls` and sibling-scan `live_n` are not computed for test sets (the archive is off for good, and the sibling scan reads today's sites, which would leak future information into an as-of test). The 70 %/75 % bars and the false-pass list with the passing clause come from your holdout replay (`POST /selection/replays`), as today.

### 2. Registered share for one name: no new route needed
Run `POST /screening/runs` with `{mode: "live", checks: ["form", "census"], names: [{domain, lane}]}`; the `census` result has `registered_share`, `in_use_share` (null, G-34), `n_registered`, `n_checked`, `n_unknown`, `siblings`, with the approved `bt1@v3` and cached registry answers, and no approval step. `forsale_n` isn't computed by the census; the sibling scan's `parked_n` is the closest.

### 3. Settings paths for your v12.2 draft
- **Max SLD length 15:** `form.max_sld_chars` = 15.
- **Registered-share minimum 0.5:** `thresholds.registered_share_min` = 0.5 (`registered_share_min_B` is tier B's).
- **Max words 2:** `thresholds.form_B_max_words` and the `n_words` feature in `tier.clauses`.
- **Not expressible today:** "3 words only with a `regime` token", the same-words-use clause on a **live sibling**, and rule 10's **lead ≥ 60**. The tier clauses can only use `TIER_FEATURES` (`registered_share`, `prior_history`, `alt_tld_before_n`, `n_words`, `sld_chars`, `is_geo`, `gform1_pass`, `short`, `lane`, `sellers_verified_n`, `sellers_unknown_n`). `alt_tld_before_n ≥ 1` works as an `any` clause now.
- **Small build offered:** add the tier features `regime_n` (from `form`) and `lead_points` / `sibling_live_n` (from the newest sibling scan of the name, live runs only, null in back-tests). Say yes and I'll schedule it after CR-053 (v5.3.0); then the three clauses are plain settings.
