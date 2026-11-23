> Status: Approved by Dvir 2026-11-23 10:03 IST (via Gavriel)

# CR-105 — Stateless FileStore (GitHub git-data API)
| Field | Value |
|---|---|
| CR id | CR-105 |
| Series | S1 of S1–S8 (fully stateless, no database) |
| From | DOM Architect (Grok Bot), on behalf of Dvir (via Gavriel) |
| Date | 2026-11-23 10:09 IST |
| Approved by Dvir | 2026-11-23 10:03 IST, relayed by Gavriel: go fully stateless, no database. 10:09 IST answers folded into CR-111 and CR-112. |
| Priority | P0 (blocks the cutover; start now) |
| Depends on | — |
| Unblocks | CR-107, CR-108, CR-109, CR-110, CR-111, CR-112. CR-106 is blocked on the dump copy. |
| Max Claude Code rounds | 2 |
| Spend | $0 |

## 1. Business need
Dvir approved fully stateless on 2026-11-23 10:03 IST (via Gavriel). $0 spend. The Neon project stays idle and is never deleted. At most 2 Claude Code rounds. Tests are the contract. This CR is one of the S1–S8 series (CR-105..CR-112) that replaces the slim-DB restore plan. Claude Code only; no CloudAgents. No money actions and no settings activation.

DOM must keep owned state as versioned files in the private repo `DvirBaumel8/domain-trading-data`, written through the GitHub git-data API, with git as history. There is no database. Money records must have zero loss under concurrent writes and retries.


## 2. Rules
- **R-1 (single writer): only the Render API writes `state/` and `config/`. GitHub Actions (CR-110) writes only `packs/`. Render Free runs one instance; an in-process per-domain mutex serialises money writes on that instance.**
- **R-2 (compare-and-swap): one git commit per money action, via blobs + tree + commit, then a ref update with `force: false`. On 422/409 non-fast-forward: re-read, re-validate, retry at most 5 times with jitter; then fail closed with 503 and write nothing. Do not use the per-file contents API for money writes (GitHub documents that parallel contents calls conflict).**
- **R-3 (append-only money): existing rows in ledger, purchases, receipts, sales, offers, bids, audit and outreach are never updated or deleted. A correction is a new row. Every money row carries `idempotency_key` and `approval_id`. The money row, the audit row (Dvir's approval text kept, client IPs dropped) and the idempotency row land in the same commit.**
- **R-4 (repo guard): every write run reads the data-repo metadata and refuses unless the repo is private. The code repo must never be the write target (founder rule 11 / `docs/internal/backup.md`).**
- **R-5 (integrity): each commit updates `manifest.json` with a sha256 per file. Branch protection on the state branch must block force-push and branch deletion.**
- **R-6 (file map — owned state, branch `state`): `state/domains.csv` ← domains, deals (D-001..D-005), portfolio_stats, owned_ending_events; `state/purchases.jsonl` ← purchases, the quote each buy used, pricing_evidence, tranche refs; `state/receipts.jsonl` ← receipts (billing identity already redacted); `state/ledger.csv` ← ledger_entries (append-only); `state/forward-costs.jsonl` ← forward_cost_plans + forward_cost_lines; `state/listings.jsonl` ← listing_history, price_schedule, venue_listings, export_runs, export_uploads; `state/offers.jsonl` and `state/sales.jsonl`; `state/bids.jsonl` ← bid_plans, bid_plan_events, referenced prebid_checks; `state/decisions.jsonl`; `state/audit.jsonl`; `state/outreach.jsonl`; `state/kills.jsonl` plus `lists/tm.txt` and `lists/bigco.txt` ← auction_kills, tm_kills, bigco_names, scout_lessons; `config/*.json` ← settings, selection_settings (active and approved), selection_lists, pricing_settings, company_documents, forbidden_terms and retirements, sibling_method_approvals; `state/idempotency.jsonl` ← new idempotency_keys only (do not seed old keys; CR-106); api_tokens stay as hashes in the Render dashboard, not in git; tranches / tranche_members are frozen FK parents only, embedded in purchases. The table grouping (27 owned, 9 config, 4 kill-memory, 26 daily-pack, 12 ops, 64 gone) is the Architect's estimate from the 142 CREATE TABLE names in `migrations/` at f7454adc; DROPs in those files are down-migrations.**
- **R-7 (secrets): no token, key, passphrase, client IP or billing address is written to the data repo. Never print secrets.**

## 3. Acceptance criteria
- **AC-1 (FS-1): two concurrent writers on one money file → both rows present, one retried, 0 lost.**
- **AC-2 (FS-2): the same Idempotency-Key twice → identical response, one row.**
- **AC-3 (FS-3): any update or delete of an existing ledger, purchase or sale row → refused 409 `APPEND_ONLY`, file unchanged.**
- **AC-4 (FS-4): every ref update uses `force: false`. A mocked public repo, or a write aimed at the code repo, is refused and nothing is written.**
- **AC-5 (FS-5): after 100 random writes, every sha256 in `manifest.json` equals a recomputed hash of that file.**
- **AC-6 (FS-6): a mocked GitHub 5xx mid-commit → 503, no partial commit (no new ref). A later retry succeeds once.**

## 4. Open questions for DOM
- Q1: reuse `GITHUB_BACKUP_TOKEN` / `GITHUB_BACKUP_REPO` (Contents read/write on the data repo only), or a new token and env name? Prefer reuse if the scopes already fit.
- Q2: confirm branch name `state` (the old `data-backup` branch was the nightly DB export, which this series retires).

<!-- DOM writes below this line -->

## DOM response (2026-11-23)
**Replaced, not built.** Dvir told DOM in chat today, after this was filed: stateless, no database, and only the money spent and the domains owned are kept, in this repo. Built as 7.0.0 (`docs/releases/v7.0.0.md`).
