
**Reading the profit tables:**
- **Out-of-sample data only:**
  - v10 everywhere (it was never fitted on these slices).
  - E1–E3 on the TEST slice and against aged drops.
  - The pick-slice rows for E1–E3 are in-sample and look better than they are.
- **The sign of the profit depends on the base rate:**
  - At 1%, retail v10 is the only clearly positive result (+$1,424). In the expired lane, results range from −$523 (v10 pick) to +$506 (E3 test).
  - At 2%, almost everything is positive: +$396 to +$2,372 in the expired lane.
- **Break-even:** a rule needs q ≈ 2.0–2.6%/yr per accepted name at the expired-lane E[price] of $900–1,200. At 1% base, that needs a lift of about 2.5×, which no rule reliably reaches in the expired lane.
- **The price term is fragile.** In the test slice, E[price] ($1.4–1.6k) rests on 5–6 sales above $2.5k. The pick slice gives $870–990, and the bulk of accepted sales are under $1k at a $295–$347 median. With the pick-slice prices, every expired-lane rule is negative at 1%.

## 3. Goal 3: harder controls (aged drops)

- **Source:**
  - 900 random unused 2–3-word, non-geo .com names from today's SnapNames public deleting list (`raw/sn_target_like.csv`, seed 1111).
  - Verisign RDAP creation date for each; 68 (7.6%) were created **before 2016** (median 2011).
  - Each got a bt1 census (1,360 sibling RDAP checks), alt-extension DNS + RDAP, and, where history could change a decision, a Wayback lookup (24 names, `to` = today, since a buyer sees the full history at drop time).
- **NameJet public lists** were not used: the SnapNames list already gave enough names. No undocumented endpoints were touched.

**What they look like:**
- Median bt1 share 0.05; 16/68 have share ≥ .5; 23/68 are 2-word.
- All 24 with archive lookups have history: median span **16 yrs**, first capture 2010.
- So the history and span signals look like those of *sold* names. Only the neighbor share separates them.

| Rule | Aged drops rejected (n = 68) |
|---|---|
| v10 | 50/68 = **74%** |
| E1 | 46/68 = 68% |
| E2 | 44/68 = 65% |
| E3 | 50–52/68 = **74–76%** (2 undecided) |

- **Plain words:** archive age and span help against *young* drops (2021–25), but not against the *old* drops that make up our real pick pool. The rule that adds span (E3) does no better than v10 against them. E1 and E2 do worse, because their "old archive" paths accept old drops.
- **Combined with the test sold names (61% / 74%), v10 still fails 70% / 75% on both sides.**

## 4. Goal 4: three-word names (pre-registered, `r11/preregistered.md`)

**Pattern bt3** (frozen before scoring): for a 3-word name a+b+c, take the 20 siblings of the 2-word head core (b+c) from the same bt1 builder, with RDAP registered share. Candidates:
- T1(k): bt1 share cut for 3-word names, k = .10–.30.
- T2(k): bt3 core share ≥ k, k = .5–.7.
- Mechanical Youden pick on the pick-slice 3-word rows (36 sold / 38 dropped).

