> Status: Approved by Dvir 2026-11-23 10:03 IST (via Gavriel)

# CR-110 — Daily market run in GitHub Actions
| Field | Value |
|---|---|
| CR id | CR-110 |
| Series | S6 of S1–S8 (fully stateless, no database) |
| From | DOM Architect (Grok Bot), on behalf of Dvir (via Gavriel) |
| Date | 2026-11-23 10:09 IST |
| Approved by Dvir | 2026-11-23 10:03 IST, relayed by Gavriel: go fully stateless, no database. The heavy daily run goes wherever it fits; GitHub Actions if 512 MB is too small. |
| Priority | P0 (needed for a daily shortlist without a database) |
| Depends on | CR-105 (kills file and packs path). Can start now with fixtures. |
| Max Claude Code rounds | 2 |
| Spend | $0 (GitHub Free minutes; log the estimate) |

## 1. Business need
Dvir approved fully stateless on 2026-11-23 10:03 IST (via Gavriel). $0 spend. The Neon project stays idle and is never deleted. At most 2 Claude Code rounds. Tests are the contract. This CR is one of the S1–S8 series (CR-105..CR-112) that replaces the slim-DB restore plan. Claude Code only; no CloudAgents. No money actions and no settings activation.

The daily GoDaddy / Dynadot / NameBio pull does not fit Render Free (512 MB). On 2026-11-22 the GoDaddy closeout zips alone were five files, 219 MB zipped, about 1.03 million rows. The daily market run must run in GitHub Actions, filter in memory, and write only that day's output pack. It must never invent backfill, and must never do a full Dynadot redo.


## 2. Rules
- **R-1 (where it runs): a scheduled GitHub Actions job on `ubuntu-latest` (private-repo runner: 2 CPU, 8 GB RAM, 6-hour job limit; GitHub docs). It does not run on the Render Free web service.**
- **R-2 (what it does): stream the GoDaddy inventory zips, plus Dynadot and NameBio pulls the current datasave already does, filter in memory, read `state/kills.jsonl` (and the list files) from the data repo, and write `packs/YYYY-MM-DD/{shortlist.json,kills.jsonl,manifest.json,GAP.md}` to `DvirBaumel8/domain-trading-data`. Only this job writes `packs/`.**
- **R-3 (gaps, no invention): a missing or failed source is recorded in `GAP.md`. Other sources still complete. No invented rows, no invented backfill, no full Dynadot redo.**
- **R-4 (idempotent pack): a second run on the same date produces the same pack sha256, or an explicit no-op if nothing changed.**
- **R-5 (preflight): `GET /auctions/preflight` PF-04..PF-06 (CR-104) read this pack (kills, manifest coverage, freshness), not a database.**
- **R-6 (minutes): the job logs a monthly minutes estimate. Target is well under GitHub Free's included minutes (currently 2,000/month on GitHub Free, shared with CI). No paid runners and no spend.**
- **R-7 (datasave.yml): the current workflow that POSTs `/jobs/run datasave` to the API must stop being the heavy market pull once this job exists. The light owned-state jobs stay on the API (CR-111).**

## 3. Acceptance criteria
- **AC-1 (DR-1): a 1.1-million-row fixture completes with peak RSS under 2 GB and wall time under 20 minutes.**
- **AC-2 (DR-2): a second run on the same fixture date produces an identical pack sha256.**
- **AC-3 (DR-3): with one source stubbed as down, `GAP.md` is written, the other sources complete, and no invented rows appear in the pack.**
- **AC-4 (DR-4): PF-04..PF-06 against the fixture pack pass; a stale or missing pack fails PF-06 or PF-05 as in CR-104.**
- **AC-5 (DR-5): the job log includes a monthly minutes estimate, and it is under 600 (estimate; fail the test if the single-run projection exceeds that).**

## 4. Open questions for DOM
- Q1: keep the 15:20 UTC schedule (CR-094) for the Actions job? Recommended yes, so it still starts after GoDaddy publishes.

<!-- DOM writes below this line -->
