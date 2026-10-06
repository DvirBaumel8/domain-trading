# BT10-1 holdout retest: v10 rule I (2026-10-06, ~02:53 IDT)

**Data not used to fit v10:**
- Sold: descriptive non-geo .com sales registered **37–60 months** before the sale. The fit set (T1) used only ≤36 months. First 25 of `sold_holdout.csv`.
- Dropped: a **fresh SnapNames deleting-list slice**, excluding `raw/sn_sample.csv`, created 2021–2025. First 25 of `drop_holdout.csv`.

**Why 25 + 25, not 55 + 55:** the 25-minute limit. The first pipeline ran too slowly, so it was cut to 25 + 25.

**Method:** same features as the backtest:
- 20 frozen siblings `census/bt1_<sld>@v1.csv` checked today. This is **not** as-of-date, the same limitation as the fit set.
- Wayback captures before the .com's creation date give `prior_history`.
- Alt-extension RDAP creation before the .com creation gives `alt_tld_before_n`.

**Rule I** = (registered_share ≥0.50 AND prior_history) OR alt_tld_before ≥1. The script is `score.py`; per-name output is in `scored.csv`.

| Class | n | Accepted | Rejected | UNKNOWN | Rate | Target | Result |
|---|---|---|---|---|---|---|---|
| Sold | 25 | 20 | 5 | 0 | **80% accepted** | ≥70% | meets |
| Dropped | 25 | 6 | 19 | 0 | **76% rejected** | ≥75% | meets, by 1 name |
| Tier A only (no alt clause) | | sold 19/25 = 76% | dropped 20/25 = 80% rejected | | | | meets |

**Verdict: provisional pass, not conclusive.**
- n = 25 per class is below the n ≥ 50 minimum in CR-002 CAP-21.
- The dropped margin is one name: one more false accept would give 72%, a fail.
- 95% CIs at n = 25 are roughly ±16 pts.
- 21 of 44 alt-extension RDAP lookups errored. Those were counted as "not before", so `alt_tld_before` may be undercounted for both classes.

**Recommendation:** keep BUY-HOLD until the remaining 30 + 30 are scored (same pipeline, about 10 minutes). Lift the hold only if both targets still hold at n ≥ 50.

**Errors:**
- Sold rejected:
  - sportcertified.com and infinitypanel.com: high share, no prior history.
  - drinkhappythoughts.com, bigislandhoney.com, linkitsystems.com: low share.
- Dropped accepted:
  - bakingarea, antinvesting, exposureculture, podfranchise, fillstyle: share ≥0.75 with prior parked/for-sale/content history.
  - thecanvascafe: alt extension registered before the .com.
- Possible v10.1 tweak, **not tested**: require `pre_cls` ≠ forsale for tier A.
