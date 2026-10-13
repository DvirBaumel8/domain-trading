# CR-055 addendum 1: point-in-time features and daily dated snapshots
From: Gavriel (Grok Bot), 2026-10-14 ~02:45 IDT. Reason: Dvir (02:23 IDT) flagged that a 2024 sale and a 2026 sale were treated the same, with features computed as of today.

## Requirements (add to CR-055)
1. **Every feature value carries an `as_of` date.** Training rows use only values with `as_of` ≤ the row's decision date (sale date for sold rows; list date for unsold rows). Store history; never overwrite.
2. **Other endings are point-in-time:** `.net/.co/.org/.io/.ai` count as registered only if their RDAP creation date is **before** the sale date. Keep the registry's creation date, the fetch time, and the raw status.
3. **Trend words are point-in-time:** for each word, the share of sales in the 365 days before the decision date that contain it. No hand-written trend lists in training.
4. **Daily dated snapshots:** every day, store the drop/pending-delete lists, the RDAP state of other endings for tracked names, and the sales feed, each tagged with its date. This is what lets unsold rows be split by time (today every unsold row is from Oct 6–9 2026).
5. **Recency:** report the model with no weighting and with half-lives of 6, 12 and 24 months, tested on the newest quarter. Our prototype showed no gain (AUC 0.850 for all of them), so keep it simple unless DOM's data shows otherwise.
6. **Drift report:** in `/engine/health` or a weekly file, show each key feature's share among sold names, and the median price by feature, per year and per quarter.
7. **Data dictionary:** keep one, with every field, its source and its as-of date (ours: `engine/data/DATA_DICTIONARY.md`, attached here as `DATA_DICTIONARY.md`).

## Prototype numbers (newest quarter test; the box)
- .net registered before the sale: sold 2024 = 23.4% (median price $4,125 vs $1,988 without), 2025 = 23.0% ($3,675 vs $1,969), 2026 = 19.3% ($2,329 vs $499). Dropped (Oct 2026) = 1.7%.
- The median sold price in our feed fell from $2,500 (2024) to $995 (2026), and the hand-registered share rose from 16% to 31%. That's partly a change in which sales the feed reports, so price models must be time-aware.
- Point-in-time trend features **lowered** the test AUC (0.850 → 0.809). The static list was leaking 2026 hindsight; 0.81 is the more honest figure.
- Acceptance test 3 in CR-055 now applies to the point-in-time model only.
