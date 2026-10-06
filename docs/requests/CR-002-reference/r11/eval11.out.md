
### Expired lane, rule-picking slice (103 sold / 75 dropped; E1–E3 were chosen here, so in-sample)

| Rule | Sold acc. | Dropped rej. | E[price] (bands: n, median) | q/yr @1% | Profit @1% | q/yr @2% | Profit @2% |
|---|---|---|---|---|---|---|---|
| v10 | 70/103 = 68% | 42/75 = 56% | $986 (1-2.5k: 13, $2,195; <1k: 51, $295; >2.5k: 6, $4,245) | 1.5% | **-$523** | 3.1% | **+$396** |
| E1 | 70/103 = 68% | 55/75 = 73% | $950 (1-2.5k: 13, $2,000; <1k: 51, $295; >2.5k: 6, $4,245) | 2.5% | **+$14** | 4.9% | **+$1,394** |
| E2 | 72/103 = 70% | 55/75 = 73% | $932 (1-2.5k: 13, $2,000; <1k: 53, $295; >2.5k: 6, $4,245) | 2.6% | **+$26** | 5.1% | **+$1,413** |
| E3 | 64/103 = 62% | 56/75 = 75% | $872 (1-2.5k: 12, $2,042; <1k: 47, $295; >2.5k: 5, $3,495) | 2.4% | **-$154** | 4.8% | **+$1,076** |

### Expired lane, TEST slice (fresh names; n = 36 sold / 40 dropped)

| Rule | Sold acc. | Dropped rej. | E[price] (bands: n, median) | q/yr @1% | Profit @1% | q/yr @2% | Profit @2% |
|---|---|---|---|---|---|---|---|
| v10 | 22/36 = 61% | 27/40 = 68% | $1,362 (1-2.5k: 4, $1,656; <1k: 13, $299; >2.5k: 5, $3,888) | 1.9% | **+$105** | 3.7% | **+$1,609** |
| E1 | 20/36 = 56% | 26/40 = 65% | $1,468 (1-2.5k: 4, $1,656; <1k: 11, $299; >2.5k: 5, $3,888) | 1.6% | **-$31** | 3.1% | **+$1,358** |
| E2 | 22/36 = 61% | 26/40 = 65% | $1,565 (1-2.5k: 4, $1,656; <1k: 12, $347; >2.5k: 6, $3,942) | 1.7% | **+$213** | 3.4% | **+$1,826** |
| E3 | 19/36 = 53% | 30/40 = 75% | $1,529 (1-2.5k: 4, $1,656; <1k: 10, $299; >2.5k: 5, $3,888) | 2.1% | **+$506** | 4.1% | **+$2,372** |

### Retail, all lanes, rounds 4–8 pooled (v10 only, decidable rows; E rules need archive span, which was only built for the expired lane)

| Rule | Sold acc. | Dropped rej. | E[price] (bands: n, median) | q/yr @1% | Profit @1% | q/yr @2% | Profit @2% |
|---|---|---|---|---|---|---|---|
| v10 | 150/211 = 71% | 144/195 = 74% | $1,761 (1-2.5k: 38, $1,999; <1k: 72, $295; >2.5k: 40, $4,174) | 2.7% | **+$1,424** | 5.3% | **+$4,088** |

### Geo, pick slice (proxy rule: geo census share ≥ .50; no archive-history check available)

| Rule | Sold acc. | Dropped rej. | E[price] (bands: n, median) | q/yr @1% | Profit @1% | q/yr @2% | Profit @2% |
|---|---|---|---|---|---|---|---|
| geo-same-evidence (proxy) | 19/39 = 49% | 58/81 = 72% | $706 (1-2.5k: 5, $1,988; <1k: 14, $248) | 1.7% | **-$714** | 3.4% | **+$18** |

### Geo, test slice (proxy rule: geo census share ≥ .50; no archive-history check available)

| Rule | Sold acc. | Dropped rej. | E[price] (bands: n, median) | q/yr @1% | Profit @1% | q/yr @2% | Profit @2% |
|---|---|---|---|---|---|---|---|
| geo-same-evidence (proxy) | 17/36 = 47% | 57/81 = 70% | $665 (1-2.5k: 2, $1,298; <1k: 14, $265; >2.5k: 1, $4,999) | 1.6% | **-$807** | 3.2% | **-$160** |

### Aged drops (created before 2016, on today's SnapNames deleting list): 68 found, 68 with census+alt, 24 with archive history looked up

Decided = the rule's answer is known: either the archive row exists, or no archive result could change the answer.

| Rule | Aged dropped rejected | Undecided |
|---|---|---|
| v10 | 50/68 decided; bounds 50/68 = 74% (all undecided accepted) to 50/68 = 74% | 0 |
| E1 | 46/68 decided; bounds 46/68 = 68% (all undecided accepted) to 46/68 = 68% | 0 |
| E2 | 44/68 decided; bounds 44/68 = 65% (all undecided accepted) to 44/68 = 65% | 0 |
| E3 | 50/66 decided; bounds 50/68 = 74% (all undecided accepted) to 52/68 = 76% | 2 |

Aged drops: median bt1 share 0.05; share ≥.5: 16/68; alt-before ≥1: 2; 2-word: 23/68; creation years median 2011.0
Aged drops with archive rows (n=24): prior history 24/24; median span 16.0 yrs; median first capture 2010.0

### Expired TEST sold + AGED drops as the dropped class (decided rows only)

| Rule | Sold acc. (test) | Aged dropped rej. (lower bound) | E[price] | q/yr @1% | Profit @1% | q/yr @2% | Profit @2% |
|---|---|---|---|---|---|---|---|
| v10 | 22/36 = 61% | 50/68 = 74% | $1,362 | 2.3% | **+$451** | 4.5% | **+$2,251** |
| E1 | 20/36 = 56% | 46/68 = 68% | $1,468 | 1.7% | **+$83** | 3.4% | **+$1,575** |
| E2 | 22/36 = 61% | 44/68 = 65% | $1,565 | 1.7% | **+$199** | 3.4% | **+$1,800** |
| E3 | 19/36 = 53% | 50/68 = 74% | $1,529 | 2.0% | **+$400** | 3.9% | **+$2,174** |

### Expired lane, v10 on pick + test pooled (both out-of-sample for v10; E rules excluded because they were chosen on pick)

| Rule | Sold acc. | Dropped rej. | E[price] (bands: n, median) | q/yr @1% | Profit @1% | q/yr @2% | Profit @2% |
|---|---|---|---|---|---|---|---|
| v10 | 92/139 = 66% | 69/115 = 60% | $1,019 (1-2.5k: 17, $1,888; <1k: 64, $295; >2.5k: 11, $3,888) | 1.6% | **-$425** | 3.3% | **+$586** |

### Batch of 26 = 23 non-geo (rule on expired TEST numbers) + 3 geo (geo proposal, geo TEST numbers)

| Non-geo rule | All 26 non-geo @1% | 23+3 geo @1% | All 26 non-geo @2% | 23+3 geo @2% |
|---|---|---|---|---|
| v10 | +$105 | +$0 | +$1,609 | +$1,405 |
| E1 | -$31 | -$121 | +$1,358 | +$1,183 |
| E2 | +$213 | +$95 | +$1,826 | +$1,597 |
| E3 | +$506 | +$355 | +$2,372 | +$2,080 |

### Break-even yearly sale probability per accepted name (3-year hold, $57 max cost, 20% commission)

| E[price] | Break-even q/yr |
|---|---|
| $300 | 7.8% |
| $500 | 4.7% |
| $900 | 2.6% |
| $1,200 | 2.0% |
| $1,800 | 1.3% |

### Bootstrap, expired TEST slice (2,000 resamples): batch profit 10th / 50th / 90th percentile, and share of resamples with profit > 0

| Rule | @1%: p10 / p50 / p90 | P(>0) @1% | @2%: p10 / p50 / p90 | P(>0) @2% |
|---|---|---|---|---|
| v10 | -$443 / +$194 / +$1,158 | 64% | +$558 / +$1,773 / +$3,617 | 98% |
| E1 | -$567 / +$41 / +$931 | 52% | +$320 / +$1,493 / +$3,202 | 96% |
| E2 | -$361 / +$261 / +$1,168 | 69% | +$716 / +$1,916 / +$3,659 | 99% |
| E3 | -$256 / +$554 / +$2,078 | 79% | +$915 / +$2,467 / +$5,297 | 99% |
