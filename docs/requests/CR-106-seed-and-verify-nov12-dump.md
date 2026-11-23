> Status: Approved by Dvir 2026-11-23 10:03 IST (via Gavriel); blocked on dump copy

# CR-106 — Seed and verify owned-state files from the Nov 12 dump
| Field | Value |
|---|---|
| CR id | CR-106 |
| Series | S2 of S1–S8 (fully stateless, no database) |
| From | DOM Architect (Grok Bot), on behalf of Dvir (via Gavriel) |
| Date | 2026-11-23 10:09 IST |
| Approved by Dvir | 2026-11-23 10:03 IST, relayed by Gavriel: go fully stateless, no database. 10:09 IST: the Mac will be turned on later; this CR waits for the dump copy. |
| Priority | P0 (blocks the live seed; do not start until the dump is on the box) |
| Depends on | CR-105 (file map). Blocked on dump copy. |
| Max Claude Code rounds | 2 |
| Spend | $0 |

## 1. Business need
Dvir approved fully stateless on 2026-11-23 10:03 IST (via Gavriel). $0 spend. The Neon project stays idle and is never deleted. At most 2 Claude Code rounds. Tests are the contract. This CR is one of the S1–S8 series (CR-105..CR-112) that replaces the slim-DB restore plan. Claude Code only; no CloudAgents. No money actions and no settings activation.

Seed the owned-state files in `DvirBaumel8/domain-trading-data` from the Nov 12 Neon dump, with zero loss on money records: file row counts must match the dump per table, verified with sha256, and cross-checked against `ledger/` and `sales/` in the company repo.

**Blocked on dump copy.** Do not start this CR until Architect (this bot) reports that the encrypted dump is on the box and Gavriel has named the vault env for the passphrase. S1 and S3–S8 can start now against fixtures.


## 2. Rules
- **R-1 (who copies the dump): the encrypted dump lives only on the Mac at `~/domain-trading-backups-keep/domain-trading-20261111T233005Z.dump.enc` (65.6 MB). Architect or another bot copies it to the box when the Mac is on. Claude Code must never read Mac secrets, never open `prod.env`, and never fetch the dump itself. The passphrase comes from the vault (Gavriel will name the env once it is saved); it is passed only as an environment variable, never on the command line or in logs.**
- **R-2 (no database needed to seed): decrypt with `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:<VAULT_ENV>` into a pipe, then `pg_restore --data-only -f` (COPY text). Do not restore into Neon or any other database. Neon stays idle and is never deleted.**
- **R-3 (what to seed): the 27 owned-state tables, the config files, and the kill-memory files listed in CR-105 R-6. Do not seed `api_tokens` into git (hashes stay in the Render dashboard). Do not seed old `idempotency_keys`. Write `seed-report.json` with, per table: `dump_rows`, `file_rows`, sha256, and money-cent sums.**
- **R-4 (repo cross-check): compare against the company repo paths `ledger/ledger.csv` (6 rows), `ledger/portfolio.csv` (D-001..D-005), `ledger/forward-costs.csv`, `ledger/approvals-log.csv`, `sales/outreach-log.csv` and `sales/offers.md`. Every repo row is either matched in the seed or listed as a diff. Zero unexplained money diffs.**
- **R-5 (post-dump delta): rows written after the dump (from 2026-11-12 01:30 UTC to now) are listed from the repo ledger/sales files as a delta for Dvir's OK. They are never auto-merged.**
- **R-6 (redaction): grep the seeded files for tokens, keys, client IPs and billing addresses; any hit fails the seed.**
- **R-7 (fail closed): if the dump file or the vault env is missing when this CR is started, exit 1 and write nothing to the data repo.**

## 3. Acceptance criteria
- **AC-1 (SV-1): `file_rows` equals `dump_rows` for every seeded table, else the tool exits 1 and no data-repo commit is made.**
- **AC-2 (SV-2): money-cent sums in the files equal the dump for ledger_entries, purchases (charged and expected), receipts, sales, offers and bid_plans.**
- **AC-3 (SV-3): every row in the company-repo files listed in R-4 is matched or listed as a diff; 0 unexplained money diffs.**
- **AC-4 (SV-4): a grep of the seeded files finds no token, key, client IP or billing address.**
- **AC-5 (SV-5): a second run on the same dump produces byte-identical files (same sha256 per file, including `seed-report.json` sums).**
- **AC-6 (SV-6): the post-dump delta is a list only; running the tool does not merge those rows.**
- **AC-7: starting the tool without the dump file or the vault env exits 1 and does not write to the data repo.**

## 4. Open questions for DOM
- Q1: none until the dump is on the box and Gavriel names the vault env. If the tool needs a different openssl flag than the runbook line, stop and say so; do not guess the passphrase.

<!-- DOM writes below this line -->
