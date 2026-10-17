# Engine data dictionary (as of 2026-10-14)
"As-of" = the moment the value describes. **PIT** = point-in-time safe: it uses only information that existed before the sale (for sold rows) or before the observation date (for unsold rows). Anything not PIT is marked LATE and must not be used for training without the PIT twin.

## data/sold.csv (12,474 rows; one row per (domain, sale date))
| Field | Meaning | Source | As-of |
|---|---|---|---|
| domain | Sold domain, lower case | UnreportedSales weekly lists on X (r9 `us_weekly_sales_old.csv`, r15 `us_sales_oct5.csv`); DNW/DNJ-derived (`raw/sold_base.csv`, `iter/sold_new.csv`) | sale date |
| price_usd | Reported price in USD (non-USD × 1.1 in DNW parse; UnreportedSales already in USD) | same | sale date |
| sale_date | Day of sale. UnreportedSales gives m/d plus the chart week; the year is taken from the week (a December sale in a January chart = previous year) | same | — |
| venue | Marketplace (Sedo, Afternic, Atom, …) | same | sale date |
| source | Feed and the original poster | same | — |
| week | Chart week label | UnreportedSales | — |
| rdap_created | .com creation date from Verisign RDAP. For a name re-registered after a drop, this is the **latest** creation, not the first | rdap.verisign.com, fetched 2026-10-07 to 10-14 | LATE (fetched today), but the date itself is historical |
| acq | handreg_le36m = created ≤ 36 months before the sale; aftermarket_or_old = > 36 months; created_after_sale(re-reg) = dropped and re-registered after the sale; unknown | derived | PIT (compares two historical dates) |
| label | sold | — | — |

## data/unsold.csv (19,940 rows)
| Field | Meaning | Source | As-of |
|---|---|---|---|
| domain | .com name | — | — |
| neg_type | dropped_after_held = on a deleted/pending-delete list after a registered term; registered_unsold_sibling = registered one-word-swap sibling of a scout name, never reported sold | SnapNames/ExpiredDomains deleted lists (join-by 2026-10-06 to 10-09); r15 sibling DNS census | obs_date |
| obs_date | Date of observation (drop list day) | list | **All 2026-10-06..09: unsold rows cannot be time-split** |
| caught_by_catcher | 1 = re-registered by a catcher right after the drop (excluded from training) | RDAP 2026-10-07 | 2026-10-07 |

## features/features.csv (.com only; one row per sold or unsold row)
| Field | Meaning | Source | As-of |
|---|---|---|---|
| len, n_words, has_digit, has_hyphen, vowel_share, plural_end | String shape | the string | timeless |
| tokens, all_known, known_share, seg_cost_per_char, one_word | Word split (dynamic programming over the wordfreq top 60k English words). Known flaw: acronyms are mis-split (haiec → "ha iec") | wordfreq 3.x | wordfreq snapshot (~2021–2024 corpora); close to timeless |
| zipf_min/mean/max | Word frequency on the Zipf scale (0–8) | wordfreq | as above |
| trend, cat_* | Static keyword lists (AI, crypto, …; industries) | hand-written 2026-10-14 | **LATE**: built with 2026 hindsight. Replaced by trend_pit_* |
| ext_net/org/io/co (DNS run) | **Invalid**: the box's resolver answers NoAnswer for names that don't exist. File renamed `dns_ext.INVALID_box_resolver.jsonl`; do not use | — | — |

## Computed in models (models/r_time.py)
| Field | Meaning | As-of |
|---|---|---|
| trend_pit_max/min | For each word: the share of .com sales in the 365 days **before** the as-of date that contain the word; max/min over the name's words | PIT (sold: sale date; unsold: 2026-10-06) |
| net_pit | 1 = the .net was registered (RDAP creation date) **before** the as-of date; 0 = not registered now; NaN = unknown | PIT for 1. For 0, "not registered today" is assumed to mean not registered then (a small error: a .net that existed then and has since dropped counts as 0) |

## Raw lookups (features/)
| File | Content | Fetched |
|---|---|---|
| rdap_net.jsonl | .net exists (Verisign RDAP 200/404) | 2026-10-14 02:15–02:40 |
| net_created.jsonl | .net creation date for registered ones | 2026-10-14 ~02:30 |
| rdap_sold.jsonl | .com creation date for sold names missing one | 2026-10-14 (running) |
| alt_{net,co,org,io}.jsonl | Registered + creation date on other endings (registry RDAP: Verisign, registry.co, PIR, Identity Digital) | 2026-10-14 (running) |
| buyers/dnw_enduser.csv | 3,004 DNW end-user sales with buyer notes (WordPress API, 8 requests) | 2026-10-14 |
| buyers/cdx.jsonl | Wayback CDX captures of a sample of bought names | 2026-10-14 (running) |

## Comparability warning (item 4 from Dvir)
- Unsold rows are measured as of 2026-10; sold rows as of their sale date (2024–2026). For net_pit, sold 2024 = 23.4%, 2025 = 23.0%, 2026 = 19.3%, vs dropped (2026-10) = 1.7%. The fair comparison is **2026 sold vs 2026 dropped: 19.3% vs 1.7%**.
- Until DOM stores dated drop lists (CR-055 addendum), every sold-vs-unsold metric mixes periods. Treat AUC as optimistic.
