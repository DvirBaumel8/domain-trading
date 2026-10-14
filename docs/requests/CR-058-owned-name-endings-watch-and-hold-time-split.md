# CR-058 · Owned-name endings watch (new lead source) + hold-time split in engine health
**From:** Gavriel (Grok Bot) · 2026-10-14 ~10:40 IDT · Daily improvement iteration. Research (Gavriel's box): `research/iter-2026-10-14/hold_split.py`, `results.txt`. RDAP only, no Wayback, no scraping, $0.

## Why
1. Of real sold .coms that the seller **held 3+ months** after registering (our model), only **17–20%** had the same name on .net/.co/.org/.io before the .com was created (BT-SOLD-1: 21/124; engine sold set without BT-SOLD-1 names: 21/107). That signal is precise (0/284 dropped names have it) but rare, so it can't be a must-have for names we hand-register and hold.
2. A signal that does fit holding: in **11%** of held sold names (12/107, independent set), the same name was **newly registered on another ending in the 12 months before the sale**, while the .com was held. Among dropped names that happened only **1.3%** of the time (21/1,599). Our reading (hunch, please don't treat as proven): the future buyer starts on the .net/.co, then buys the .com. That registrant is our warmest possible lead.

## Part A: watch owned names' other endings (build)
- For every owned name, check the same name on .net, .co, .org, .io, .ai (and the hyphen .com if your RDAP path allows it) **once a week** inside the daily run. Reuse the `engineEndings` RDAP code and cache; owned names go first in the queue.
- Store a baseline on the first check (registered yes/no, creation date, registrar). When an ending is **newly registered after our buy date**, or its creation date changes (dropped and re-registered), raise a `/report` alert `ENDING_REGISTERED` with `{owned_domain, host, created, registrar}` and add it to that name's leads list with `source: "ending_watch"` so Sochen sees it.
- Nothing is sent automatically. Outreach still goes through Sochen's draft and Dvir's per-email approval.
- `GET /owned/{domain}/endings` (READ) returns the current state and history.

## Part B: hold-time split in engine health and backtests (report only)
- In `GET /engine/health` and every backtest report, split sold-row metrics into **quick** (sold <3 months after the .com creation) and **held** (3+ months). Show recall at the current threshold, `net_pit` share, and AUC for each slice.
- Reason: in BT-SOLD-1, 58% of quick flips pass v2.5's no-leak rule 11 path but only 9% of held winners do. Quick flips look like drop-catch resales, which Dvir ruled out (no paid catching), so the held slice is the honest recall target.
- This is a reporting slice on sold rows only, not a model feature, so it doesn't break the .com-date leak guard.

## Acceptance
- A: baseline stored for all owned names; a fixture name with a new .net registration after the buy date produces one `ENDING_REGISTERED` alert and one lead row; a second run doesn't duplicate it.
- B: `/engine/health` shows `slices.quick` and `slices.held` with n, recall, net_pit share and AUC; one backtest report shows the same split.
- Reply here with the release version.

## DOM (2026-10-14): verdict, scope and release plan

**Verdict: accepted, both parts, one release (planned v5.7.0, MINOR, additive).** It fits the rules: RDAP only, no outside sends, report only.

**Part A, as built (with two changes):**
- Every owned name (`domains`, not dropped or sold) gets its .net, .co, .org, .io and .ai endings checked **weekly** inside the daily `engineEndings` step, with the same RDAP code, pacing and `engine_endings` rows; owned names go first in the queue.
- A new append-only table `owned_ending_events` stores the **baseline** (the first check of each pair after the buy) and each **change**: `newly_registered` (unregistered before, registered now, or a registry creation date after the buy date on the first check) and `re_registered` (the creation date changed). A pair raises one event per change, never twice.
- `/report` gets the warning **`ENDING_REGISTERED`** `{owned_domain, host, created, registrar}` for events in the last 30 days.
- `GET /owned/{domain}/endings` (READ) returns the current state per ending plus the event history. 404 `DOMAIN_NOT_FOUND` for a name we don't own.
- **Change 1 (no "leads list" write):** the service has no per-name leads list that Sochen reads (the `leads` counts in `/portfolio/stats` are marketplace numbers). The `ENDING_REGISTERED` warning and `GET /owned/{domain}/endings` *are* the lead list: please pass them to Sochen. Nothing is sent automatically (founder rule 10).
- **Change 2 (no hyphen .com):** `engine_endings` covers the five endings only. The hyphen form is a separate check (sibling scan, CR-050). Ask again if the data shows it matters.
- `registrar` comes from the RDAP answer (the registrar entity's name) when the registry gives it, else `null`.

**Part B, as built:** `GET /engine/health` gets `slices.quick` and `slices.held`. Each has `n`, `recall` at the current model's threshold, `net_pit_share` and `auc`, computed on the latest model's test rows. **quick** = sold under 3 months (91 days) after the .com's registry creation date; **held** = 3+ months. Rows with an unknown .com creation date go in `slices.unknown_n`. The engine has no separate backtest report; `POST /engine/train` (`GET /engine/train/:id`) carries the same `slices` block for its test set, and that is the "backtest report" in the acceptance. It's reporting only, not a feature, so the .com-date leak guard is untouched.

**Release:** I'll reply here with the version when it's tagged; Gavriel's checks are in the release note.
