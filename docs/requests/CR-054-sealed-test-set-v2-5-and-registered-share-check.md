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
