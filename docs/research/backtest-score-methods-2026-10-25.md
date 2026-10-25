# Backtest: score methods on the CR-002 set (DOM, 25 Oct 2026)

Data: `docs/requests/CR-002-reference/features.csv`, 767 sold and 988 dropped .com names (sold = reported sales, mostly DNW lists; dropped = names that expired unsold). Measure: AUC, the chance that a random sold name scores above a random dropped one (0.5 = coin toss, 1.0 = perfect). The lift method is 5-fold cross-validated, so every name is scored by a model that never saw it.

| Method | AUC | Names scored |
|---|---|---|
| Shorter name | 0.68 | 1,664 |
| Fewer words | 0.73 | 1,427 |
| Another ending registered before the .com | 0.60 | 1,427 |
| Share of the other endings registered (any date) | 0.77 | 1,547 |
| Had a past website | 0.68 | 1,169 |
| v1 Form part (length + words, approximated) | 0.74 | 1,427 |
| v2 proposal, Shape + Registered elsewhere only | 0.79 | 1,427 |
| Lift (naive Bayes): length + words | 0.73 | 1,755 |
| Lift: + endings before .com | 0.77 | 1,755 |
| Lift: + endings before .com + registered share | 0.78 | 1,755 |
| **Lift: + past website** | **0.80** | 1,755 |
| Reference: CR-002 engine model (gradient boosting) | 0.85 | (CR-002 report) |

## What this shows
- Measured signals already beat the old score. The parts with evidence against them (D, and the bots' opinion parts B, C, E) can't be backtested here, and earlier tests found them at or below a coin toss.
- **The share of other endings registered is the strongest single signal** (0.77), stronger than "an ending registered before the .com" (0.60). That one is very selective but rare: it fires on only 22% of sold names.
- **The lift method (Dvir's idea) reaches 0.80** with four simple patterns. It needs no hand weights, and it scores names with missing data too. The learned engine reached 0.85 on the same kind of data. So lift is a strong, explainable first version, and the engine is the target once its data grows.

## Caveats
- One dataset of 1,755 names. The sold side is reported sales, which skew to higher prices. Both sides are mostly hand registrations, not our S8 auctions, so the results are indirect for our case.
- "Had a past website" may partly reflect how the two sides were collected. Treat its share of the gain with care until it is checked on the daily GoDaddy feed (v5.41.0).
- Next run: the same methods on the engine feed's rows once a few thousand have arrived.
