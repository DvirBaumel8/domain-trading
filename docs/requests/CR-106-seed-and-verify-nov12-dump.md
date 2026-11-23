> Status: Approved by Dvir 2026-11-23 10:20 IST (via Gavriel); unblocked (no Mac needed)

# CR-106 — Seed owned-state files from repo records
| Field | Value |
|---|---|
| CR id | CR-106 |
| Series | S2 of S1–S8 (fully stateless, no database) |
| From | DOM Architect (Grok Bot), on behalf of Dvir (via Gavriel) |
| Date | 2026-11-23 10:20 IST |
| Approved by Dvir | 2026-11-23 10:03 IST, relayed by Gavriel: go fully stateless, no database. 10:20 IST (via Gavriel): no backup or dump restore at all; seed from the repo records already on hand; cross-check against registrar account lists, not a dump. |
| Priority | P0 (blocks the live seed; unblocked — no Mac, no dump, no decrypt) |
| Depends on | CR-105 (file map). No longer blocked on a dump copy. |
| Max Claude Code rounds | 2 |
| Spend | $0 |

## 1. Business need
Dvir approved fully stateless on 2026-11-23 10:03 IST (via Gavriel). On 2026-11-23 10:20 IST he dropped the dump restore entirely: no backup or dump is used, and nothing is decrypted. $0 spend. The Neon project stays idle and is never deleted. At most 2 Claude Code rounds. Tests are the contract. This CR is one of the S1–S8 series (CR-105..CR-112) that replaces the slim-DB restore plan. Claude Code only; no CloudAgents. No money actions and no settings activation.

Seed the owned-state files in `DvirBaumel8/domain-trading-data` from the company-repo records we already have, with zero loss: every source row appears in the seeded files, row counts and money-cent totals are equal, each file's sha256 is written in `manifest.json`, and a rerun is byte-identical. Cross-check owned domains against the GoDaddy and Porkbun account lists (read-only API), not against a dump. Any registrar mismatch is listed for Dvir and is never auto-fixed.

This CR is **unblocked**. It does not need the Mac, a passphrase, or a vault entry.

The encrypted Nov 12 dump that already sits on the box at `/workspace/domain-trading-keep/dump/domain-trading-20261111T233005Z.dump.enc` (and the Mac original in `~/domain-trading-backups-keep/`) stays untouched and is **not decrypted**. Do not open, copy, move, or delete it in this CR. Do not open the secrets file `/workspace/secrets/prod.env.mac-2026-11-23`.


## 2. Rules
- **R-1 (no dump, no decrypt): do not read, decrypt, restore, or parse the Nov 12 dump, on the box or on the Mac. Do not use `BACKUP_PASSPHRASE` or `openssl`. Do not restore into Neon or any other database. Neon stays idle and is never deleted.**
- **R-2 (seed sources): read only the existing repo records below. Primary source is the company tree `/workspace/domain-trading` (the same files live in the company repo). Also read the same relative paths if they already exist in `DvirBaumel8/domain-trading-data`; if a path differs between the two trees, list the diff for Dvir and do not auto-merge.**
  - `ledger/ledger.csv` (6 data rows)
  - `ledger/portfolio.csv` (D-001..D-005)
  - `ledger/forward-costs.csv`
  - `ledger/approvals-log.csv`
  - `sales/sale-rate-weekly.csv`
  - `sales/outreach-log.csv`
  - `sales/offers.md` (and any other current, non-backup files under `sales/` that hold offers, listings or sale records; ignore `*.bak-*` and test folders)
  - `company/decisions-log.md`
- **R-3 (what to write): write the owned-state files defined in CR-105 from those sources only (domains, ledger / purchases / receipts, sales / offers / listings, decisions, audit and outreach logs, and a prior-kill file only if a source for it already exists in one of the two repos). Do not invent rows, do not backfill from the dump, and do not seed `api_tokens` into git. Write `manifest.json` with, per seeded file: source path, `source_rows`, `file_rows`, money-cent totals where they apply, and sha256.**
- **R-4 (row and money equality): every source row appears in the corresponding seeded file. `file_rows` equals `source_rows` for each source. Money-cent totals in the seeded files equal the source totals for ledger amounts, forward-cost planned amounts, portfolio cost / bin / floor / walkaway / renewal prices, and any sale or offer amounts present in the sources. Zero unexplained money diffs. A missing source file fails the seed (exit 1, no data-repo commit).**
- **R-5 (registrar cross-check, read-only): after the files are written, compare `portfolio.csv` D-001..D-005 against the current GoDaddy and Porkbun account domain lists, using a read-only registrar API only (no buys, no changes, no deletes). Every owned domain on those lists must match a D-001..D-005 row, and every D-001..D-005 row must appear on the lists. Any mismatch (extra, missing, or registrar disagreement) is listed for Dvir and is never auto-fixed. If a registrar API is unreachable, the seed files may still be committed, but the report must say the cross-check is incomplete and name the registrar.**
- **R-6 (redaction): grep the seeded files for tokens, keys, client IPs and billing addresses; any hit fails the seed.**
- **R-7 (idempotent rerun): a second run on the same sources produces byte-identical seeded files (same sha256 per file, including the per-file sums recorded in `manifest.json`).**

## 3. Acceptance criteria
- **AC-1 (SV-1): every source row in the R-2 files appears in the seeded files, and `file_rows` equals `source_rows` for each source, else the tool exits 1 and no data-repo commit is made.**
- **AC-2 (SV-2): money-cent totals in the seeded files equal the source totals for ledger, forward-costs, portfolio money fields, and any sale or offer amounts in the sources. Zero unexplained money diffs.**
- **AC-3 (SV-3): `manifest.json` lists sha256 for every seeded file, plus `source_rows`, `file_rows` and money-cent totals where they apply.**
- **AC-4 (SV-4): every domain on the read-only GoDaddy and Porkbun account lists matches one of D-001..D-005, and every D-001..D-005 row appears on those lists. Any mismatch is listed for Dvir and is not auto-fixed.**
- **AC-5 (SV-5): a second run on the same sources produces byte-identical files (same sha256 per file, including the sums recorded in `manifest.json`).**
- **AC-6 (SV-6): a grep of the seeded files finds no token, key, client IP or billing address.**
- **AC-7 (SV-7): the tool never opens, decrypts, or writes the Nov 12 dump or `/workspace/secrets/prod.env.mac-2026-11-23`. Starting it does not require the Mac, a passphrase, or a vault env.**

## 4. Open questions for DOM
- Q1: none on the dump (dropped 2026-11-23 10:20 IST). If a source path is missing or a column map onto the CR-105 file layout is ambiguous, stop and list the gap as **DVIR**; do not invent rows or guess money figures.

<!-- DOM writes below this line -->
